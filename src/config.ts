export const PROVIDER_ID = 'openai';

export const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OAUTH_ISSUER = 'https://auth.openai.com';
export const OAUTH_SCOPE = 'openid profile email offline_access';
export const OAUTH_CALLBACK_PORT = 1455;
export const OAUTH_CALLBACK_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`;
export const OAUTH_DEVICE_POLLING_MARGIN_MS = 3000;

export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage';

// Allowed model IDs for the Codex backend. Any other gpt-* with a version
// above 5.4 is also passed through (see provider.models filter).
export const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
]);
