import * as accounts from '../accounts/index.js';
import type { Account, Store } from '../accounts/types.js';
import { PROVIDER_ID } from '../config.js';
import * as file from './file.js';
import type { OauthEntry } from './types.js';

const PER_ACCOUNT_PREFIX = `${PROVIDER_ID}/`;
const LEGACY_PAREN_PREFIX = 'OpenAI ('; // earlier format: "OpenAI (email)"

function keyFor(account: Pick<Account, 'id' | 'email'>): string {
  return `${PER_ACCOUNT_PREFIX}${account.email ?? account.id}`;
}

function isPerAccountKey(key: string): boolean {
  return (
    key.startsWith(PER_ACCOUNT_PREFIX) || key.startsWith(LEGACY_PAREN_PREFIX)
  );
}

function toEntry(account: Account): OauthEntry {
  return {
    type: 'oauth',
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.id,
  };
}

export function fingerprint(store: Store): string {
  return JSON.stringify({
    active: store.active,
    accounts: store.accounts.map((account) => ({
      id: account.id,
      email: account.email,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
    })),
  });
}

/**
 * Mirror the current account store into auth.json:
 * - Write one `openai/<email>` entry per account.
 * - Write the active account under the canonical `openai` key.
 * - Remove any orphaned per-account entries (including legacy formats).
 */
export async function sync(): Promise<void> {
  const store = await accounts.load();
  const all = await file.read();
  const writes: Record<string, OauthEntry> = {};
  const want = new Set<string>();
  for (const account of store.accounts) {
    const k = keyFor(account);
    writes[k] = toEntry(account);
    want.add(k);
  }
  const a = accounts.active(store);
  if (a) writes[PROVIDER_ID] = toEntry(a);
  const removes: string[] = [];
  for (const k of Object.keys(all)) {
    if (k === PROVIDER_ID) continue;
    if (!isPerAccountKey(k)) continue;
    if (!want.has(k)) removes.push(k);
  }
  if (!a && PROVIDER_ID in all) removes.push(PROVIDER_ID);
  await file.bulk({ writes, removes }).catch(() => undefined);
}

/**
 * Detect external `opencode auth logout` removals.
 *
 * Walks every per-account entry currently in auth.json and collects the
 * accountIds present. Anything in our store but not in that set was removed
 * by the user; drop it.
 *
 * If only the canonical `openai` key is missing, leave the per-account
 * entries alone — `sync()` will rewrite the canonical.
 */
export async function reconcile(): Promise<void> {
  const store = await accounts.load();
  if (store.accounts.length === 0) return;
  const all = await file.read();
  const present = new Set<string>();
  for (const [k, entry] of Object.entries(all)) {
    if (k === PROVIDER_ID) continue;
    if (!isPerAccountKey(k)) continue;
    if (entry.type !== 'oauth') continue;
    const id = (entry as OauthEntry).accountId;
    if (id) present.add(id);
  }
  const dropped = store.accounts.filter((a) => !present.has(a.id));
  if (dropped.length === 0) {
    if (!(PROVIDER_ID in all)) await sync();
    return;
  }
  for (const a of dropped) await accounts.remove(a.id);
  await sync();
}

/**
 * On first run after installing this plugin, import any pre-existing
 * `openai` / `openai/<id>` / `OpenAI (...)` OAuth entries into the store so
 * the user doesn't lose access.
 */
export async function bootstrap(): Promise<void> {
  if ((await accounts.load()).accounts.length > 0) return;
  const all = await file.read();
  for (const [k, entry] of Object.entries(all)) {
    if (entry.type !== 'oauth') continue;
    if (k !== PROVIDER_ID && !isPerAccountKey(k)) continue;
    const e = entry as OauthEntry;
    const id =
      e.accountId ??
      `imported-${e.access.slice(-12).replace(/[^a-zA-Z0-9]/g, '')}`;
    if (accounts.find(id)) continue;
    await accounts.save(
      {
        id,
        refresh: e.refresh,
        access: e.access,
        expires: e.expires,
        addedAt: Date.now(),
      },
      { activate: true },
    );
  }
}

export { file };
