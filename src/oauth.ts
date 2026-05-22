import { createServer, type Server } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import {
  CLIENT_ID,
  ISSUER,
  OAUTH_PORT,
  OAUTH_SCOPE,
  POLLING_SAFETY_MARGIN_MS,
  REDIRECT_URI,
} from "./constants.js"
import type { IdTokenClaims, TokenResponse } from "./types.js"

export interface PkceCodes {
  verifier: string
  challenge: string
}

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => PKCE_CHARS[b % PKCE_CHARS.length]).join("")
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function generatePkce(): Promise<PkceCodes> {
  const verifier = randomString(43)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(hash) }
}

export function generateState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  const fromClaims = (c: IdTokenClaims | undefined) =>
    c?.chatgpt_account_id || c?.["https://api.openai.com/auth"]?.chatgpt_account_id || c?.organizations?.[0]?.id
  if (tokens.id_token) {
    const id = fromClaims(parseJwtClaims(tokens.id_token))
    if (id) return id
  }
  if (tokens.access_token) {
    return fromClaims(parseJwtClaims(tokens.access_token))
  }
  return undefined
}

export function extractAccountEmail(tokens: TokenResponse): string | undefined {
  const fromClaims = (c: IdTokenClaims | undefined) =>
    c?.email || c?.["https://api.openai.com/auth"]?.user_email
  if (tokens.id_token) {
    const email = fromClaims(parseJwtClaims(tokens.id_token))
    if (email) return email
  }
  if (tokens.access_token) {
    return fromClaims(parseJwtClaims(tokens.access_token))
  }
  return undefined
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`)
  return response.json() as Promise<TokenResponse>
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  return response.json() as Promise<TokenResponse>
}

const SUCCESS_HTML = `<!doctype html><html><head><title>OpenCode Codex - Success</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.c{text-align:center;padding:2rem}h1{margin-bottom:1rem}p{color:#b7b1b1}</style>
</head><body><div class="c"><h1>Authorization successful</h1><p>You can close this window and return to OpenCode.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`

const errorHtml = (msg: string) => `<!doctype html><html><head><title>OpenCode Codex - Failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.c{text-align:center;padding:2rem}h1{color:#fc533a;margin-bottom:1rem}.err{color:#ff917b;font-family:monospace;margin-top:1rem;padding:1rem;background:#3c140d;border-radius:.5rem}</style>
</head><body><div class="c"><h1>Authorization failed</h1><div class="err">${msg.replace(/</g, "&lt;")}</div></div></body></html>`

interface Pending {
  pkce: PkceCodes
  state: string
  resolve: (t: TokenResponse) => void
  reject: (e: Error) => void
}

let server: Server | undefined
let pending: Pending | undefined

export async function startCallbackServer(): Promise<{ redirectUri: string }> {
  if (server) return { redirectUri: REDIRECT_URI }

  server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404)
      res.end("Not found")
      return
    }
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const err = url.searchParams.get("error_description") || url.searchParams.get("error")

    if (err) {
      pending?.reject(new Error(err))
      pending = undefined
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(errorHtml(err))
      return
    }
    if (!code) {
      const msg = "Missing authorization code"
      pending?.reject(new Error(msg))
      pending = undefined
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end(errorHtml(msg))
      return
    }
    if (!pending || state !== pending.state) {
      const msg = "Invalid state - potential CSRF"
      pending?.reject(new Error(msg))
      pending = undefined
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end(errorHtml(msg))
      return
    }
    const current = pending
    pending = undefined
    exchangeCode(code, REDIRECT_URI, current.pkce)
      .then((t) => current.resolve(t))
      .catch((e) => current.reject(e))
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(SUCCESS_HTML)
  })

  await new Promise<void>((resolve, reject) => {
    server!.listen(OAUTH_PORT, resolve)
    server!.once("error", reject)
  })
  return { redirectUri: REDIRECT_URI }
}

export function stopCallbackServer(): void {
  if (server) {
    server.close()
    server = undefined
  }
}

export function waitForCallback(pkce: PkceCodes, state: string, timeoutMs = 5 * 60 * 1000): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending) {
        pending = undefined
        reject(new Error("Authorization timed out"))
      }
    }, timeoutMs)
    pending = {
      pkce,
      state,
      resolve: (t) => {
        clearTimeout(timer)
        resolve(t)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    }
  })
}

export interface DeviceCodeChallenge {
  device_auth_id: string
  user_code: string
  interval: number
  verification_url: string
}

export async function startDeviceCode(): Promise<DeviceCodeChallenge> {
  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!response.ok) throw new Error("Failed to initiate device authorization")
  const data = (await response.json()) as { device_auth_id: string; user_code: string; interval?: string | number }
  const interval = Math.max(Number(data.interval) || 5, 1) * 1000
  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    interval,
    verification_url: `${ISSUER}/codex/device`,
  }
}

export async function pollDeviceCode(challenge: DeviceCodeChallenge): Promise<TokenResponse> {
  while (true) {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: challenge.device_auth_id,
        user_code: challenge.user_code,
      }),
    })
    if (response.ok) {
      const data = (await response.json()) as { authorization_code: string; code_verifier: string }
      const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      })
      if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`)
      return tokenRes.json() as Promise<TokenResponse>
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device authorization failed: ${response.status}`)
    }
    await sleep(challenge.interval + POLLING_SAFETY_MARGIN_MS)
  }
}

export async function exchangeManualUrl(callbackUrl: string, pkce: PkceCodes, state: string): Promise<TokenResponse> {
  let parsed: URL
  try {
    parsed = new URL(callbackUrl)
  } catch {
    throw new Error("Invalid callback URL")
  }
  const code = parsed.searchParams.get("code")
  const cbState = parsed.searchParams.get("state")
  if (!code) throw new Error("Callback URL is missing the ?code= parameter")
  if (cbState !== state) throw new Error("Callback URL state does not match")
  return exchangeCode(code, REDIRECT_URI, pkce)
}
