import * as selectors from './selectors.js';
import type { Account, Store } from './types.js';

let selectedID: string | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

export function id(): string | undefined {
  return selectedID;
}

export function select(accountID: string): void {
  if (selectedID === accountID) return;
  selectedID = accountID;
  notify();
}

export function active(store: Store): Account | undefined {
  if (selectedID) {
    const found = selectors.find(store, selectedID);
    if (found) return found;
    selectedID = undefined;
  }
  return selectors.active(store);
}

export function pick(
  store: Store,
  options: selectors.PickOptions = {},
): Account | undefined {
  const now = options.now ?? Date.now();
  const exclude = options.exclude;
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

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
