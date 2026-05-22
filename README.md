# opencode-codex

An OpenCode plugin that adds clean, native multi-account support to OpenCode's
built-in Codex (ChatGPT Plus/Pro OAuth) provider.

This is a from-scratch redesign of
[`oc-codex-multi-auth`](https://github.com/ndycode/oc-codex-multi-auth) that
sticks to OpenCode's native UX surfaces — no custom CLI prompts, no toast
spam, no 21 bespoke commands.

## What it does

- Adds, switches between, and removes multiple Codex accounts.
- Routes Codex traffic through the active account; falls back to a non-rate-limited account when the active one hits 429.
- Shows the active account in the prompt area and quota (with progress bars) in the sidebar.
- Surfaces account management through the standard OpenCode flows:
  - `opencode auth login` to add accounts (browser, device code, or paste callback URL).
  - `opencode auth list` / `opencode auth logout` to see and remove individual accounts.
  - `/accounts` inside the TUI to switch the active account.

## Install

### Local (development)

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-codex"],
}
```

```sh
cd /absolute/path/to/opencode-codex
bun install
bun run build
```

OpenCode loads `dist/server.js` (auth/provider) and `dist/tui.tsx`
(slots + slash commands) on next startup.

### npm (once published)

```jsonc
{
  "plugin": ["opencode-codex"],
}
```

## Adding accounts

Run `opencode auth login`, pick **openai**, then choose one of:

- **ChatGPT Pro/Plus (browser)** — opens a browser, listens on `localhost:1455`.
- **ChatGPT Pro/Plus (device code)** — get a short code to enter on another machine.
- **ChatGPT Pro/Plus (paste callback URL)** — for headless setups; paste the redirect URL back.
- **Manually enter API Key** — falls back to OpenAI's standard API.

Each successful OAuth login appends a new account and sets it active. Repeat
for additional accounts.

## Managing accounts

| Action | Where                                                              |
| ------ | ------------------------------------------------------------------ |
| Add    | `opencode auth login` → openai                                     |
| List   | `opencode auth list` (one row per account, plus the active mirror) |
| Remove | `opencode auth logout` → pick the row to remove                    |
| Switch | `/accounts` inside the TUI                                         |

The bottom-right of the prompt area shows the active account.
The sidebar shows that account's 5h / weekly quota progress bars, and if
multiple accounts exist a pool average underneath.

## Storage

| Path                                          | Purpose                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `$XDG_DATA_HOME/opencode/codex/accounts.json` | Multi-account store (source of truth).                                                                 |
| `$XDG_DATA_HOME/opencode/auth.json`           | OpenCode's credential file; one row per account (`openai/<email>`) plus the active mirror at `openai`. |

Both files are written with `0600` permissions through tmp+rename.

## Architecture

The source tree maps one folder per responsibility. Each folder exports a
small namespace; importers use `import * as accounts from "./accounts"` and
call `accounts.save(...)`, `accounts.pick()`, etc.

```
src/
├── config.ts                Constants — OAuth client ID, endpoints, dummy key.
├── paths.ts                 XDG path resolver.
│
├── accounts/                Multi-account store (the source of truth).
│   ├── index.ts                  load, list, find, active, pick, save, remove,
│   │                             activate, rateLimit, touch, updateTokens,
│   │                             updateUsage, subscribe, snapshot
│   └── types.ts                  Account, Store, Usage, UsageWindow
│
├── auth/                    OpenCode auth.json glue.
│   ├── file.ts                   Atomic JSON I/O on auth.json (read, set, remove, bulk)
│   ├── index.ts                  sync, reconcile, bootstrap
│   └── types.ts                  Entry / OauthEntry / ApiEntry
│
├── oauth/                   OAuth flows + token primitives.
│   ├── pkce.ts                   pkce(), state() — RFC 7636 helpers
│   ├── jwt.ts                    identify(tokens) → { id, email }
│   ├── tokens.ts                 authorizeUrl, exchange, refresh
│   ├── callback.ts               local HTTP callback server (used by browser flow)
│   ├── device.ts                 device-code start + poll
│   ├── paste.ts                  manual paste URL exchange
│   ├── index.ts                  methods() → AuthMethod[] for opencode auth login
│   └── types.ts                  TokenResponse
│
├── codex/                   Codex backend client.
│   ├── fetch.ts                  create() → fetch override for OpenCode's loader
│   └── usage.ts                  fetch(account) — `/wham/usage` client + parser
│
├── quota/                   Pure formatting for quota data.
│   └── index.ts                  bar, label, countdown, left, aggregate, plan
│
├── tui/                     TUI plugin pieces.
│   ├── index.tsx                 entry: registers slots + commands + refresh
│   ├── prompt.tsx                session_prompt_right slot
│   ├── sidebar.tsx               sidebar_content slot
│   ├── dialog.tsx                /accounts dialog
│   ├── refresh.ts                background usage poller
│   ├── color.ts                  RGBA mix helper
│   └── store-signal.ts           Solid signal adapter over accounts.subscribe
│
├── server.ts                Plugin server entry — wires the hooks.
└── tui.tsx                  Re-exports ./tui/index for package.json#exports['./tui'].
```

Dependency rule: a module imports only from modules listed _above_ it in
this map, except `auth/index.ts` which calls into `accounts` (downward by
folder) — accounts has no idea auth exists.

### How a chat request flows

1. OpenCode picks the openai provider and asks our `auth.loader` for options.
2. Loader returns `{ apiKey: OAUTH_DUMMY_KEY, fetch: codexFetch }`.
3. For each request, `codexFetch` calls `accounts.pick()` to choose the
   account (active-first; falls back if active is rate-limited).
4. If the access token is near expiry, `oauth.refresh` mints a new pair
   and `accounts.updateTokens` persists it.
5. The URL is rewritten to `chatgpt.com/backend-api/codex/responses` and
   the request goes out with `Authorization: Bearer …` and `ChatGPT-Account-Id`.
6. On 429/402 the account is `accounts.rateLimit`-ed; on success it's
   `accounts.touch`-ed.

### How auth.json stays in sync

`accounts.subscribe` runs `auth.sync()` on every store change. `sync()`
writes a `openai/<email>` entry per account and mirrors the active under
`openai`. Stale per-account keys are removed in the same batch.

On session events (`session.created` / `session.idle`) we run
`auth.reconcile()`: walk auth.json, collect the set of accountIds that
still have an entry, and drop the rest from the store. This is how
external `opencode auth logout` removals propagate.

## Rotation

There's no rotation mode — we use active-first with rate-limit fallback. If
you want strict per-request rotation, add it as a new picker in
`accounts/index.ts:pick()` — that's the only place to touch.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run build       # tsc + rename .jsx to .tsx in dist
bun run watch       # tsc --watch
```

The TUI plugin ships as `.tsx` (JSX preserved) because `@opentui/solid` does
the JSX transform at OpenCode runtime via its Bun plugin. The server plugin
ships as plain `.js`.

## License

MIT.
