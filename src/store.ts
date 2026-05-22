import { promises as fs } from "node:fs"
import path from "node:path"
import { accountsFile, dataDir } from "./paths.js"
import type { Account, Store } from "./types.js"

const EMPTY: Store = { version: 1, accounts: [] }

let cached: Store | undefined
let writeQueue: Promise<void> = Promise.resolve()
const listeners = new Set<(store: Store) => void>()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function readFromDisk(): Promise<Store> {
  try {
    const raw = await fs.readFile(accountsFile(), "utf8")
    const parsed = JSON.parse(raw) as Partial<Store>
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) return clone(EMPTY)
    return {
      version: 1,
      active: parsed.active,
      accounts: parsed.accounts,
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      try {
        await fs.rename(accountsFile(), accountsFile() + ".bak")
      } catch {}
    }
    return clone(EMPTY)
  }
}

export async function load(): Promise<Store> {
  if (!cached) cached = await readFromDisk()
  return cached
}

export function snapshot(): Store {
  return cached ? clone(cached) : clone(EMPTY)
}

async function persist(store: Store): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const tmp = accountsFile() + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(tmp, accountsFile())
}

export async function update(mutator: (s: Store) => void | Store): Promise<Store> {
  const current = await load()
  const next = clone(current)
  const result = mutator(next)
  const final = result ?? next
  cached = final
  writeQueue = writeQueue.then(() => persist(final)).catch(() => undefined)
  await writeQueue
  for (const listener of listeners) {
    try {
      listener(clone(final))
    } catch {}
  }
  return final
}

export function subscribe(listener: (store: Store) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function findAccount(store: Store, id: string): Account | undefined {
  return store.accounts.find((a) => a.id === id)
}

export function pickActive(store: Store): Account | undefined {
  if (store.active) {
    const found = findAccount(store, store.active)
    if (found) return found
  }
  return store.accounts[0]
}

function isEligible(account: Account, now: number): boolean {
  return !account.rateLimitUntilMs || account.rateLimitUntilMs <= now
}

export function pickRequestAccount(store: Store, now = Date.now()): Account | undefined {
  const active = pickActive(store)
  if (active && isEligible(active, now)) return active
  const fallback = store.accounts.find((a) => isEligible(a, now))
  if (fallback) return fallback
  // Everyone is rate-limited; return active anyway so the caller surfaces the
  // real error response instead of a phantom "no account" message.
  return active
}

export async function upsertAccount(account: Account, options: { activate?: boolean } = {}): Promise<Store> {
  return update((s) => {
    const idx = s.accounts.findIndex((a) => a.id === account.id)
    if (idx >= 0) {
      const existing = s.accounts[idx]!
      s.accounts[idx] = {
        ...existing,
        ...account,
        label: account.label ?? existing.label,
        email: account.email ?? existing.email,
        addedAt: existing.addedAt,
        usage: existing.usage,
      }
    } else {
      s.accounts.push(account)
    }
    if (options.activate || !s.active) s.active = account.id
  })
}

export async function removeAccount(id: string): Promise<Store> {
  return update((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id)
    if (s.active === id) s.active = s.accounts[0]?.id
  })
}

export async function setActive(id: string): Promise<Store> {
  return update((s) => {
    if (s.accounts.some((a) => a.id === id)) s.active = id
  })
}

export async function markRateLimited(id: string, untilMs: number): Promise<Store> {
  return update((s) => {
    const account = findAccount(s, id)
    if (account) account.rateLimitUntilMs = untilMs
  })
}

export async function clearRateLimit(id: string): Promise<Store> {
  return update((s) => {
    const account = findAccount(s, id)
    if (account) account.rateLimitUntilMs = undefined
  })
}

export async function updateTokens(
  id: string,
  tokens: { access: string; refresh: string; expires: number },
): Promise<Store> {
  return update((s) => {
    const account = findAccount(s, id)
    if (account) {
      account.access = tokens.access
      account.refresh = tokens.refresh
      account.expires = tokens.expires
    }
  })
}

export async function recordUse(id: string, now = Date.now()): Promise<void> {
  await update((s) => {
    const account = findAccount(s, id)
    if (account) account.lastUsedAt = now
  })
}

export function dataDirPath(): string {
  return path.join(dataDir())
}
