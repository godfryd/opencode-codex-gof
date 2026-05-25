import * as accounts from '../accounts/index.js';
import type { Account } from '../accounts/types.js';
import { refresh as refreshTokens } from '../oauth/index.js';

const REFRESH_SKEW_MS = 60_000;

const inflight = new Map<string, Promise<Account>>();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function isFresh(account: Account, now = Date.now()): boolean {
  return !!account.access && account.expires - REFRESH_SKEW_MS > now;
}

export async function ensure(
  account: Account,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<Account> {
  if (isFresh(account, now)) return account;
  const existing = inflight.get(account.id);
  if (existing) return abortable(existing, signal);

  const refresh = (async () => {
    throwIfAborted(signal);
    const tokens = await refreshTokens(account.refresh, signal);
    const expires = now + (tokens.expires_in ?? 3600) * 1000;
    void accounts
      .updateTokens(account.id, {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires,
      })
      .catch(() => undefined);
    return {
      ...account,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    };
  })().finally(() => inflight.delete(account.id));

  inflight.set(account.id, refresh);
  return abortable(refresh, signal);
}
