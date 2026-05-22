import { createSignal, onCleanup } from 'solid-js';
import * as accounts from '../accounts/index.js';
import type { Store } from '../accounts/index.js';

export function useAccountsStore(): () => Store {
  const [store, setStore] = createSignal<Store>(accounts.snapshot());
  void accounts.load().then(setStore);
  const off = accounts.subscribe(setStore);
  onCleanup(off);
  return store;
}
