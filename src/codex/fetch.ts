import * as accounts from '../accounts/index.js';
import type { Account } from '../accounts/types.js';
import { CODEX_ENDPOINT } from '../config.js';
import { refresh as refreshTokens } from '../oauth/index.js';

const REFRESH_SKEW_MS = 60_000;

const inflightRefresh = new Map<string, Promise<Account>>();

async function ensureFreshTokens(
  account: Account,
  now = Date.now(),
): Promise<Account> {
  if (account.access && account.expires - REFRESH_SKEW_MS > now) return account;
  const existing = inflightRefresh.get(account.id);
  if (existing) return existing;
  const promise = (async () => {
    const tokens = await refreshTokens(account.refresh);
    const expires = now + (tokens.expires_in ?? 3600) * 1000;
    await accounts.updateTokens(account.id, {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    });
    return {
      ...account,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    };
  })().finally(() => inflightRefresh.delete(account.id));
  inflightRefresh.set(account.id, promise);
  return promise;
}

function isCodexRoute(url: URL): boolean {
  return (
    url.pathname.includes('/v1/responses') ||
    url.pathname.includes('/chat/completions')
  );
}

function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs > 0) return now + secs * 1000;
  const ts = Date.parse(value);
  if (Number.isFinite(ts) && ts > now) return ts;
  return undefined;
}

function buildHeaders(
  init: RequestInit | undefined,
  account: Account,
): Headers {
  const headers = new Headers();
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value));
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value));
      }
    }
  }
  headers.delete('authorization');
  headers.set('authorization', `Bearer ${account.access}`);
  headers.set('ChatGPT-Account-Id', account.id);
  return headers;
}

export { ensureFreshTokens };

/**
 * Build a fetch implementation that proxies requests through the picked
 * Codex account. The returned function has the standard `fetch` signature.
 */
export function create(): typeof fetch {
  return async function codexFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const account = accounts.pick();
    if (!account) {
      return new Response(
        JSON.stringify({ error: { message: 'No Codex account configured' } }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    const fresh = await ensureFreshTokens(account);
    const parsed =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    const target = isCodexRoute(parsed) ? new URL(CODEX_ENDPOINT) : parsed;

    const response = await fetch(target, {
      ...init,
      headers: buildHeaders(init, fresh),
    });

    if (response.status === 429 || response.status === 402) {
      const now = Date.now();
      const until =
        parseRetryAfter(response.headers.get('retry-after'), now) ??
        now + 5 * 60_000;
      void accounts.rateLimit(fresh.id, until);
    } else if (response.ok) {
      void accounts.touch(fresh.id);
      if (fresh.rateLimitUntilMs) void accounts.clearRateLimit(fresh.id);
    }
    return response;
  };
}
