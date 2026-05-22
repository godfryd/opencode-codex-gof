export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const USAGE_API_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
export const OAUTH_PORT = 1455
export const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`
export const OAUTH_SCOPE = "openid profile email offline_access"
export const POLLING_SAFETY_MARGIN_MS = 3000

export const PROVIDER_ID = "openai"

export const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
])
