import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

export function authJsonPath(): string {
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(xdg, "opencode", "auth.json")
}

export interface OauthEntry {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export interface ApiEntry {
  type: "api"
  key: string
  metadata?: Record<string, string>
}

export type AuthEntry = OauthEntry | ApiEntry | { type: string; [k: string]: unknown }

let writeQueue: Promise<unknown> = Promise.resolve()

async function readAll(): Promise<Record<string, AuthEntry>> {
  try {
    const raw = await fs.readFile(authJsonPath(), "utf8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed ? parsed : {}
  } catch {
    return {}
  }
}

async function persist(data: Record<string, AuthEntry>): Promise<void> {
  const file = authJsonPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

export function read(): Promise<Record<string, AuthEntry>> {
  return readAll()
}

export async function get(id: string): Promise<AuthEntry | undefined> {
  return (await readAll())[id]
}

export async function set(id: string, entry: AuthEntry): Promise<void> {
  await (writeQueue = writeQueue.then(async () => {
    const data = await readAll()
    data[id] = entry
    await persist(data)
  }))
}

export async function remove(id: string): Promise<void> {
  await (writeQueue = writeQueue.then(async () => {
    const data = await readAll()
    if (!(id in data)) return
    delete data[id]
    await persist(data)
  }))
}

export async function exists(id: string): Promise<boolean> {
  return id in (await readAll())
}

/**
 * Apply a batch of writes/deletes atomically against the auth.json file.
 * `writes` keys map to new entries; `removes` keys are deleted. Unrelated
 * provider entries are preserved.
 */
export async function bulk(input: { writes?: Record<string, AuthEntry>; removes?: string[] }): Promise<void> {
  await (writeQueue = writeQueue.then(async () => {
    const data = await readAll()
    for (const key of input.removes ?? []) {
      delete data[key]
    }
    for (const [key, value] of Object.entries(input.writes ?? {})) {
      data[key] = value
    }
    await persist(data)
  }))
}
