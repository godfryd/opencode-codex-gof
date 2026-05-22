# opencode-codex

An OpenCode plugin that adds clean, native multi-account support to OpenCode's
built-in Codex (ChatGPT Plus/Pro OAuth) provider.

This is a from-scratch redesign of
[`oc-codex-multi-auth`](https://github.com/ndycode/oc-codex-multi-auth) that
sticks to OpenCode's native UX surfaces — no custom CLI prompts, no toast
spam, no 21 bespoke commands.

## What it does

- Adds, switches between, and removes multiple Codex accounts.
- Routes Codex traffic through the active account, with optional rotation.
- Shows the active account + 5h/1w quota in the prompt area.
- Shows aggregate pool capacity in the sidebar.
- Surfaces account management through the standard OpenCode flows:
  - `opencode auth login` to add accounts (browser, device code, or paste callback URL).
  - `opencode auth logout` to remove the active account.
  - `/accounts`, `/accounts-remove`, `/accounts-rotation`, `/accounts-refresh` inside the TUI.

## Install

This plugin is a regular OpenCode plugin loaded by config. It can be used as a
local file plugin during development or installed from npm once published.

### Local (development)

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-codex"]
}
```

Then build the plugin:

```sh
cd /absolute/path/to/opencode-codex
bun install
bun run build
```

OpenCode will load `dist/server.js` (auth/provider) and `dist/tui.js`
(slots + slash commands) automatically.

### npm (once published)

```jsonc
{
  "plugin": ["opencode-codex"]
}
```

## Adding accounts

Run `opencode auth login`, pick **openai**, then choose one of:

- **ChatGPT Pro/Plus (browser)** — opens a browser, listens on `localhost:1455`.
- **ChatGPT Pro/Plus (device code)** — get a short code to enter on another machine.
- **ChatGPT Pro/Plus (paste callback URL)** — for headless setups; paste the redirect URL back.
- **Manually enter API Key** — falls back to OpenAI's standard API.

Each successful OAuth login appends a new account to the local store and sets
it as active. You can do this multiple times to add multiple accounts.

## Switching accounts

Inside the OpenCode TUI:

- `/accounts` — pick an account to make active.
- `/accounts-remove` — remove an account from the store.
- `/accounts-rotation` — pick a rotation strategy.
- `/accounts-refresh` — re-fetch usage data for all accounts.

The bottom-right of the prompt area shows the active account and its 5h/1w
quota windows. The sidebar shows aggregate pool capacity.

## Rotation modes

| Mode | Behavior |
| --- | --- |
| `off` (default) | Always send to the selected active account. Safest. |
| `on-rate-limit` | Stick to active; rotate only when the account hits a 429/402. |
| `round-robin` | Rotate through eligible accounts on every request. ToS risk — use with care. |

The default is `off` because aggressive rotation can violate OpenAI's
acceptable-use policy. The option exists for users who knowingly accept that
risk.

## Standard `opencode auth` integration

- `opencode auth list` shows the active account as `openai (oauth)`.
- `opencode auth logout` removes the active credential. The plugin notices on
  the next idle session event and drops the removed account from the store; if
  another account exists in the store it becomes the new active one.
- You can still manage individual accounts from inside the TUI via `/accounts`.

## Storage

| Path | Purpose |
| --- | --- |
| `$XDG_DATA_HOME/opencode/auth.json` | OpenCode's own credential file; we mirror the active Codex account here. |
| `$XDG_DATA_HOME/opencode/codex/accounts.json` | The multi-account store maintained by this plugin. |

Both files are written with `0600` permissions.

## What's intentionally not here

- **No health-score / circuit-breaker subsystem.** OpenCode already retries
  failed requests; we just mark accounts as rate-limited until their
  `Retry-After` deadline.
- **No custom CLI tools** (`codex-list`, `codex-switch`, etc.). Use
  `opencode auth ...` and the TUI slash commands.
- **No background account-recovery flows.** If the underlying refresh token
  expires you re-add the account via `opencode auth login`.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run build       # tsc
bun run watch       # tsc --watch
```

## License

MIT.
