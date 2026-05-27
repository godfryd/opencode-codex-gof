import type { Account, Store } from './types.js';

export function list(store: Store): Account[] {
  return store.accounts;
}

export function find(store: Store, id: string): Account | undefined {
  return store.accounts.find((account) => account.id === id);
}

export function active(store: Store): Account | undefined {
  if (store.active) {
    const found = find(store, store.active);
    if (found) return found;
  }
  return store.accounts[0];
}

export interface PickOptions {
  now?: number;
  exclude?: ReadonlySet<string>;
}

export function pick(
  store: Store,
  options: PickOptions | number = {},
): Account | undefined {
  const now = typeof options === 'number' ? options : options.now ?? Date.now();
  const exclude = typeof options === 'number' ? undefined : options.exclude;
  const isEligible = (account: Account) =>
    (!exclude?.has(account.id) &&
      (!account.rateLimitUntilMs || account.rateLimitUntilMs <= now));
  const head = active(store);
  if (head && isEligible(head)) return head;
  const fallback = store.accounts.find(isEligible);
  if (fallback) return fallback;
  if (head && !exclude?.has(head.id)) return head;
  return store.accounts.find((account) => !exclude?.has(account.id)) ?? head;
}
