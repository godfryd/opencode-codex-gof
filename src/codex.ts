import { CODEX_API_ENDPOINT } from "./constants.js"
import { refreshTokens } from "./oauth.js"
import * as Store from "./store.js"
import type { Account } from "./types.js"

const REFRESH_SKEW_MS = 60_000

const inflightRefresh = new Map<string, Promise<Account>>()

export async function ensureFreshTokens(account: Account, now = Date.now()): Promise<Account> {
  if (account.access && account.expires - REFRESH_SKEW_MS > now) return account
  const existing = inflightRefresh.get(account.id)
  if (existing) return existing
  const promise = (async () => {
    const tokens = await refreshTokens(account.refresh)
    const expires = now + (tokens.expires_in ?? 3600) * 1000
    await Store.updateTokens(account.id, {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    })
    return {
      ...account,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    }
  })().finally(() => inflightRefresh.delete(account.id))
  inflightRefresh.set(account.id, promise)
  return promise
}

function isCodexRoute(url: URL): boolean {
  return url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return
  const secs = Number(value)
  if (Number.isFinite(secs) && secs > 0) return now + secs * 1000
  const ts = Date.parse(value)
  if (Number.isFinite(ts) && ts > now) return ts
  return undefined
}

export function buildHeaders(
  init: RequestInit | undefined,
  account: Account,
): Headers {
  const headers = new Headers()
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value))
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value))
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value))
      }
    }
  }
  headers.delete("authorization")
  headers.set("authorization", `Bearer ${account.access}`)
  headers.set("ChatGPT-Account-Id", account.id)
  return headers
}

export interface CodexFetchOptions {
  pickAccount: () => Promise<Account | undefined>
  onRateLimited?: (account: Account, untilMs: number) => void
  onSuccess?: (account: Account) => void
}

export function createCodexFetch(opts: CodexFetchOptions): typeof fetch {
  return async function codexFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const account = await opts.pickAccount()
    if (!account) {
      return new Response(JSON.stringify({ error: { message: "No Codex account configured" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    const fresh = await ensureFreshTokens(account)
    const parsed = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    const target = isCodexRoute(parsed) ? new URL(CODEX_API_ENDPOINT) : parsed

    const response = await fetch(target, { ...init, headers: buildHeaders(init, fresh) })

    if (response.status === 429 || response.status === 402) {
      const now = Date.now()
      const until = parseRetryAfter(response.headers.get("retry-after"), now) ?? now + 5 * 60_000
      opts.onRateLimited?.(fresh, until)
    } else if (response.ok) {
      opts.onSuccess?.(fresh)
    }
    return response
  }
}
