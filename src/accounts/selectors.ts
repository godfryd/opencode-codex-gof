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

export function pick(store: Store, now = Date.now()): Account | undefined {
  const isEligible = (account: Account) =>
    !account.rateLimitUntilMs || account.rateLimitUntilMs <= now;
  const head = store.active ? find(store, store.active) : store.accounts[0];
  if (head && isEligible(head)) return head;
  return store.accounts.find(isEligible) ?? head;
}
