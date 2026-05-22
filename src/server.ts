import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import * as AuthJson from "./auth-json.js"
import { ALLOWED_MODELS, PROVIDER_ID, REDIRECT_URI } from "./constants.js"
import { createCodexFetch } from "./codex.js"
import {
  buildAuthorizeUrl,
  exchangeManualUrl,
  extractAccountEmail,
  extractAccountId,
  generatePkce,
  generateState,
  pollDeviceCode,
  startCallbackServer,
  startDeviceCode,
  stopCallbackServer,
  waitForCallback,
} from "./oauth.js"
import * as Store from "./store.js"
import type { Account, TokenResponse } from "./types.js"

const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const PER_ACCOUNT_PREFIX = `${PROVIDER_ID}/`
const LEGACY_OPENAI_PARENS_PREFIX = "OpenAI ("

function perAccountKey(account: Pick<Account, "id" | "email">): string {
  return `${PER_ACCOUNT_PREFIX}${account.email ?? account.id}`
}

function isOurPerAccountKey(key: string): boolean {
  return key.startsWith(PER_ACCOUNT_PREFIX) || key.startsWith(LEGACY_OPENAI_PARENS_PREFIX)
}

function tokensToAccount(tokens: TokenResponse, now = Date.now()): Account {
  const id =
    extractAccountId(tokens) ??
    `unknown-${tokens.access_token.slice(-12).replace(/[^a-zA-Z0-9]/g, "")}`
  return {
    id,
    email: extractAccountEmail(tokens),
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    addedAt: now,
  }
}

function toOauthEntry(account: Account): AuthJson.OauthEntry {
  return {
    type: "oauth",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.id,
  }
}

/**
 * Rewrite auth.json so every account in our store has a per-account oauth
 * entry, and the active account is also mirrored under the canonical
 * `openai` key (needed for OpenCode's provider loader to fire).
 *
 * Removes stale `openai/<id>` keys for accounts no longer in our store.
 */
async function syncAuthJson(): Promise<void> {
  const store = await Store.load()
  const active = Store.pickActive(store)
  const writes: Record<string, AuthJson.AuthEntry> = {}
  const want = new Set<string>()
  for (const account of store.accounts) {
    const key = perAccountKey(account)
    writes[key] = toOauthEntry(account)
    want.add(key)
  }
  if (active) {
    writes[PROVIDER_ID] = toOauthEntry(active)
  }
  const all = await AuthJson.read()
  const removes: string[] = []
  for (const key of Object.keys(all)) {
    if (key === PROVIDER_ID) continue
    if (!isOurPerAccountKey(key)) continue
    if (!want.has(key)) removes.push(key)
  }
  if (!active && PROVIDER_ID in all) {
    removes.push(PROVIDER_ID)
  }
  await AuthJson.bulk({ writes, removes }).catch(() => undefined)
}

/**
 * Detect `opencode auth logout` removals.
 *
 * Walks every per-account auth.json entry (both new `OpenAI (...)` keys and
 * legacy `openai/<id>` keys) and collects the accountId of each that's still
 * present. Anything in our store but not in that set was removed by the user.
 *
 * If only the canonical `openai` key is missing, that's just the active
 * mirror — let syncAuthJson rewrite it.
 */
async function reconcileExternalLogout(): Promise<void> {
  const store = await Store.load()
  if (store.accounts.length === 0) return
  const all = await AuthJson.read()
  const present = new Set<string>()
  for (const [key, entry] of Object.entries(all)) {
    if (key === PROVIDER_ID) continue
    if (!isOurPerAccountKey(key)) continue
    if (entry.type !== "oauth") continue
    const id = (entry as AuthJson.OauthEntry).accountId
    if (id) present.add(id)
  }
  const removed = store.accounts.filter((a) => !present.has(a.id)).map((a) => a.id)
  if (removed.length === 0) {
    if (!(PROVIDER_ID in all)) await syncAuthJson()
    return
  }
  for (const id of removed) {
    await Store.removeAccount(id)
  }
  await syncAuthJson()
}

async function bootstrapFromAuthJson(): Promise<void> {
  const store = await Store.load()
  if (store.accounts.length > 0) return
  const all = await AuthJson.read()
  const candidates: Array<[string, AuthJson.OauthEntry]> = []
  for (const [key, entry] of Object.entries(all)) {
    if (entry.type !== "oauth") continue
    if (key !== PROVIDER_ID && !isOurPerAccountKey(key)) continue
    candidates.push([key, entry as AuthJson.OauthEntry])
  }
  if (candidates.length === 0) return
  for (const [, entry] of candidates) {
    const id = entry.accountId ?? `imported-${entry.access.slice(-12).replace(/[^a-zA-Z0-9]/g, "")}`
    if (await Store.findAccount(await Store.load(), id)) continue
    await Store.upsertAccount(
      {
        id,
        refresh: entry.refresh,
        access: entry.access,
        expires: entry.expires,
        addedAt: Date.now(),
      },
      { activate: true },
    )
  }
}

const CodexMultiAuthPlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  await Store.load()
  await bootstrapFromAuthJson()
  await reconcileExternalLogout()
  await syncAuthJson()

  Store.subscribe(() => {
    void syncAuthJson()
  })

  const pickAccount = async (): Promise<Account | undefined> => {
    const store = await Store.load()
    return Store.pickRequestAccount(store)
  }

  const onRateLimited = (account: Account, untilMs: number) => {
    void Store.markRateLimited(account.id, untilMs)
  }
  const onSuccess = (account: Account) => {
    void Store.recordUse(account.id)
    if (account.rateLimitUntilMs) {
      void Store.clearRateLimit(account.id)
    }
  }

  const codexFetch = createCodexFetch({ pickAccount, onRateLimited, onSuccess })

  const onLoginSuccess = async (tokens: TokenResponse): Promise<Account> => {
    const account = tokensToAccount(tokens)
    await Store.upsertAccount(account, { activate: true })
    return account
  }

  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (ALLOWED_MODELS.has(model.api.id)) return true
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              return match ? parseFloat(match[1]!) > 5.4 : false
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: model.id.includes("gpt-5.5")
                  ? { context: 400_000, input: 272_000, output: 128_000 }
                  : model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: PROVIDER_ID,
      async loader() {
        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: codexFetch,
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startCallbackServer()
            const pkce = await generatePkce()
            const state = generateState()
            const url = buildAuthorizeUrl(redirectUri, pkce, state)
            const callback = waitForCallback(pkce, state)
            return {
              url,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await callback
                  stopCallbackServer()
                  const account = await onLoginSuccess(tokens)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: account.expires,
                    accountId: account.id,
                  }
                } catch {
                  stopCallbackServer()
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (device code)",
          type: "oauth",
          authorize: async () => {
            const challenge = await startDeviceCode()
            return {
              url: challenge.verification_url,
              instructions: `Enter code: ${challenge.user_code}`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await pollDeviceCode(challenge)
                  const account = await onLoginSuccess(tokens)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: account.expires,
                    accountId: account.id,
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (paste callback URL)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePkce()
            const state = generateState()
            const url = buildAuthorizeUrl(REDIRECT_URI, pkce, state)
            return {
              url,
              instructions:
                "Open the URL in any browser, sign in, then paste the full callback URL you are redirected to (it starts with http://localhost:1455/auth/callback).",
              method: "code" as const,
              callback: async (callbackUrl: string) => {
                try {
                  const tokens = await exchangeManualUrl(callbackUrl, pkce, state)
                  const account = await onLoginSuccess(tokens)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: account.expires,
                    accountId: account.id,
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    async event({ event }) {
      const type = (event as { type?: string }).type
      if (type === "session.created" || type === "session.idle") {
        await reconcileExternalLogout()
      }
    },
  }
}

export { CodexMultiAuthPlugin }
export default {
  id: "opencode-codex",
  server: CodexMultiAuthPlugin,
}
