import { USAGE_API_ENDPOINT } from "./constants.js"
import { ensureFreshTokens } from "./codex.js"
import * as Store from "./store.js"
import type { Account, AccountUsage, UsageWindow } from "./types.js"

interface RawUsageWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
  reset_after_seconds?: number
}

interface RawUsagePayload {
  plan_type?: string
  rate_limit?: {
    primary_window?: RawUsageWindow | null
    secondary_window?: RawUsageWindow | null
  } | null
}

function parseWindow(raw: RawUsageWindow | null | undefined, now: number): UsageWindow | undefined {
  if (!raw) return undefined
  const usedPercent = typeof raw.used_percent === "number" ? raw.used_percent : undefined
  const seconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : undefined
  let resetAtMs: number | undefined
  if (typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) && raw.reset_at > 0) {
    resetAtMs = raw.reset_at > 1e12 ? raw.reset_at : raw.reset_at * 1000
  } else if (typeof raw.reset_after_seconds === "number" && raw.reset_after_seconds > 0) {
    resetAtMs = now + raw.reset_after_seconds * 1000
  }
  if (usedPercent == null || seconds == null || resetAtMs == null) return undefined
  return {
    usedPercent,
    windowMinutes: Math.round(seconds / 60),
    resetAtMs,
  }
}

export function parseUsage(payload: unknown): AccountUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const data = payload as RawUsagePayload
  const now = Date.now()
  const windows: UsageWindow[] = []
  const primary = parseWindow(data.rate_limit?.primary_window, now)
  const secondary = parseWindow(data.rate_limit?.secondary_window, now)
  if (primary) windows.push(primary)
  if (secondary) windows.push(secondary)
  if (windows.length === 0) return undefined
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes)
  return {
    fetchedAt: now,
    planType: data.plan_type,
    windows,
  }
}

const inflight = new Map<string, Promise<AccountUsage | undefined>>()

export async function fetchUsage(account: Account): Promise<AccountUsage | undefined> {
  const existing = inflight.get(account.id)
  if (existing) return existing
  const promise = (async () => {
    const fresh = await ensureFreshTokens(account)
    const response = await fetch(USAGE_API_ENDPOINT, {
      headers: {
        authorization: `Bearer ${fresh.access}`,
        "ChatGPT-Account-Id": fresh.id,
        "User-Agent": "opencode-codex/0.1",
        accept: "application/json",
      },
    })
    if (!response.ok) return undefined
    const usage = parseUsage(await response.json())
    if (!usage) return undefined
    await Store.update((s) => {
      const acc = s.accounts.find((a) => a.id === account.id)
      if (acc) acc.usage = usage
    })
    return usage
  })().finally(() => inflight.delete(account.id))
  inflight.set(account.id, promise)
  return promise
}

export function formatWindowLabel(minutes: number): string {
  if (minutes <= 60 * 12) return `${Math.round(minutes / 60)}h`
  return "weekly"
}

export function leftPercent(usedPercent: number | undefined): number | undefined {
  if (typeof usedPercent !== "number") return undefined
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

export function formatResetCountdown(resetAtMs: number, now = Date.now()): string {
  const diffMs = resetAtMs - now
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "reset"
  const minutes = Math.floor(diffMs / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  return `${mins}m`
}

export function splitBar(percentRemaining: number, width: number): { filled: string; empty: string } {
  const p = Math.max(0, Math.min(100, Math.round(percentRemaining)))
  const filled = Math.round((p / 100) * width)
  return { filled: "━".repeat(filled), empty: "━".repeat(width - filled) }
}

