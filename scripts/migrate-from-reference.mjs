#!/usr/bin/env node
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const REF = path.join(os.homedir(), ".opencode", "oc-codex-multi-auth-accounts.json")
const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
const OUR_DIR = path.join(xdg, "opencode", "codex")
const OUR_FILE = path.join(OUR_DIR, "accounts.json")
const AUTH_FILE = path.join(xdg, "opencode", "auth.json")
const PROVIDER_ID = "openai"

function parseJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function canonicalId(entry) {
  const claims = parseJwt(entry.accessToken)
  const auth = claims?.["https://api.openai.com/auth"]
  return auth?.chatgpt_account_id || claims?.chatgpt_account_id || entry.accountId
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

const raw = await readJson(REF)
if (!raw || !Array.isArray(raw.accounts)) {
  console.error(`No accounts[] in ${REF}`)
  process.exit(1)
}

// Dedupe by email, prefer `token` source entries (matches our extractor).
const byEmail = new Map()
for (const entry of raw.accounts) {
  const email = entry.email || "unknown"
  const existing = byEmail.get(email)
  if (!existing || entry.accountIdSource === "token") {
    byEmail.set(email, entry)
  }
}

const now = Date.now()
const accounts = [...byEmail.values()].map((entry) => ({
  id: canonicalId(entry),
  email: entry.email,
  refresh: entry.refreshToken,
  access: entry.accessToken,
  expires: entry.expiresAt,
  addedAt: entry.addedAt ?? now,
  lastUsedAt: entry.lastUsed,
}))

// Active = whoever is currently in auth.json["openai"] (if present in our set),
// else the most-recently-used.
const currentAuth = (await readJson(AUTH_FILE)) ?? {}
const currentActive = currentAuth[PROVIDER_ID]?.accountId
let active = accounts.find((a) => a.id === currentActive)?.id
if (!active) {
  active = [...accounts].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]?.id
}

// 1) Write our store.
await writeAtomic(OUR_FILE, { version: 1, active, accounts })

// 2) Write per-account auth.json mirrors + canonical active mirror.
//    Preserve any non-openai entries (other providers).
const nextAuth = { ...currentAuth }
// Drop any stale openai-prefixed entries; we'll repopulate.
for (const key of Object.keys(nextAuth)) {
  if (key === PROVIDER_ID || key.startsWith(`${PROVIDER_ID}/`)) delete nextAuth[key]
}
for (const account of accounts) {
  nextAuth[`${PROVIDER_ID}/${account.id}`] = {
    type: "oauth",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.id,
  }
}
const activeAccount = accounts.find((a) => a.id === active)
if (activeAccount) {
  nextAuth[PROVIDER_ID] = {
    type: "oauth",
    refresh: activeAccount.refresh,
    access: activeAccount.access,
    expires: activeAccount.expires,
    accountId: activeAccount.id,
  }
}
await writeAtomic(AUTH_FILE, nextAuth)

console.log(`Migrated ${accounts.length} accounts:`)
console.log(`  store → ${OUR_FILE}`)
console.log(`  auth  → ${AUTH_FILE}`)
for (const a of accounts) {
  console.log(`    ${a.id === active ? "●" : "○"} ${a.email} (${a.id})`)
}
console.log(`  auth.json keys: ${Object.keys(nextAuth).filter((k) => k === PROVIDER_ID || k.startsWith(`${PROVIDER_ID}/`)).join(", ")}`)
