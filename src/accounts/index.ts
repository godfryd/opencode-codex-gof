import { promises as fs, watchFile } from 'node:fs';
import path from 'node:path';
import { accountsFile, dataDir } from '../paths.js';
import type { Account, Store, Usage } from './types';

const EMPTY: Store = { version: 1, accounts: [] };
const WATCH_INTERVAL_MS = 1000;

let cached: Store | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(store: Store) => void>();
let lastWrittenMtimeMs: number | undefined;
let watcherStarted = false;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function readFromDisk(): Promise<Store> {
  try {
    const raw = await fs.readFile(accountsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts))
      return clone(EMPTY);
    return { version: 1, active: parsed.active, accounts: parsed.accounts };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      try {
        await fs.rename(accountsFile(), accountsFile() + '.bak');
      } catch {}
    }
    return clone(EMPTY);
  }
}

async function persist(store: Store): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = accountsFile() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmp, accountsFile());
  try {
    const stat = await fs.stat(accountsFile());
    lastWrittenMtimeMs = stat.mtimeMs;
  } catch {}
}

function notify(store: Store): void {
  for (const listener of listeners) {
    try {
      listener(clone(store));
    } catch {}
  }
}

function startWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  watchFile(accountsFile(), { interval: WATCH_INTERVAL_MS }, (curr) => {
    if (curr.mtimeMs === 0) return;
    if (curr.mtimeMs === lastWrittenMtimeMs) return;
    lastWrittenMtimeMs = curr.mtimeMs;
    void (async () => {
      const fresh = await readFromDisk();
      cached = fresh;
      notify(fresh);
    })();
  });
}

export async function load(): Promise<Store> {
  if (!cached) cached = await readFromDisk();
  startWatcher();
  return cached;
}

export function snapshot(): Store {
  return cached ? clone(cached) : clone(EMPTY);
}

export function list(store?: Store): Account[] {
  return (store ?? snapshot()).accounts;
}

export function find(id: string, store?: Store): Account | undefined {
  return (store ?? snapshot()).accounts.find((a) => a.id === id);
}

export function active(store?: Store): Account | undefined {
  const s = store ?? snapshot();
  if (s.active) {
    const found = s.accounts.find((a) => a.id === s.active);
    if (found) return found;
  }
  return s.accounts[0];
}

/**
 * Pick the account to send the next request through. Active-first with
 * rate-limit fallback. Returns the active even if it's rate-limited when no
 * other eligible account exists, so the caller surfaces the upstream error
 * rather than a phantom "no account".
 */
export function pick(now = Date.now()): Account | undefined {
  const s = snapshot();
  const isEligible = (a: Account) =>
    !a.rateLimitUntilMs || a.rateLimitUntilMs <= now;
  const fromId = (id: string | undefined) =>
    s.accounts.find((a) => a.id === id);
  const head = fromId(s.active) ?? s.accounts[0];
  if (head && isEligible(head)) return head;
  return s.accounts.find(isEligible) ?? head;
}

async function mutate(fn: (s: Store) => void | Store): Promise<Store> {
  const current = await load();
  const next = clone(current);
  const result = fn(next);
  const final = result ?? next;
  cached = final;
  writeQueue = writeQueue.then(() => persist(final)).catch(() => undefined);
  await writeQueue;
  notify(final);
  return final;
}

export async function save(
  account: Account,
  options: { activate?: boolean } = {},
): Promise<Store> {
  return mutate((s) => {
    const idx = s.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      const existing = s.accounts[idx]!;
      s.accounts[idx] = {
        ...existing,
        ...account,
        label: account.label ?? existing.label,
        email: account.email ?? existing.email,
        addedAt: existing.addedAt,
        usage: existing.usage,
      };
    } else {
      s.accounts.push(account);
    }
    if (options.activate || !s.active) s.active = account.id;
  });
}

export async function remove(id: string): Promise<Store> {
  return mutate((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
    if (s.active === id) s.active = s.accounts[0]?.id;
  });
}

export async function activate(id: string): Promise<Store> {
  return mutate((s) => {
    if (s.accounts.some((a) => a.id === id)) s.active = id;
  });
}

export async function rateLimit(id: string, untilMs: number): Promise<Store> {
  return mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.rateLimitUntilMs = untilMs;
  });
}

export async function clearRateLimit(id: string): Promise<Store> {
  return mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.rateLimitUntilMs = undefined;
  });
}

export async function touch(id: string): Promise<void> {
  await mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.lastUsedAt = Date.now();
  });
}

export async function updateTokens(
  id: string,
  tokens: { access: string; refresh: string; expires: number },
): Promise<Store> {
  return mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) {
      account.access = tokens.access;
      account.refresh = tokens.refresh;
      account.expires = tokens.expires;
    }
  });
}

export async function updateUsage(id: string, usage: Usage): Promise<Store> {
  return mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.usage = usage;
  });
}

export function subscribe(listener: (store: Store) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function file(): string {
  return path.join(dataDir(), 'accounts.json');
}

export type { Account, Store, Usage, UsageWindow } from './types';
