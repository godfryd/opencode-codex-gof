/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import * as Store from "./store.js"
import {
  fetchUsage,
  formatResetCountdown,
  formatWindowLabel,
  leftPercent,
  splitBar,
} from "./usage.js"
import type { Account, Store as StoreShape, UsageWindow } from "./types.js"

const USAGE_REFRESH_MS = 5 * 60_000
const SESSION_IDLE_DEBOUNCE_MS = 30_000
const SIDEBAR_BAR_WIDTH = 18

function shortLabel(account: Account, max = 24): string {
  const label = account.label || account.email || account.id
  return label.length > max ? label.slice(0, max - 1) + "…" : label
}

function planSuffix(account: Account): string {
  const name = planName(account)
  return name ? ` (${name})` : ""
}

function planName(account: Account): string | undefined {
  const plan = account.usage?.planType
  if (!plan) return undefined
  const lower = plan.toLowerCase()
  if (lower.includes("pro")) return "Pro"
  if (lower.includes("plus")) return "Plus"
  return plan
}

function trackStore(): () => StoreShape {
  const [signal, setSignal] = createSignal<StoreShape>(Store.snapshot())
  void Store.load().then(setSignal)
  const off = Store.subscribe(setSignal)
  onCleanup(off)
  return signal
}

function refreshAll(): void {
  void (async () => {
    const store = await Store.load()
    await Promise.all(store.accounts.map((a) => fetchUsage(a).catch(() => undefined)))
  })()
}

function refreshActive(): void {
  void (async () => {
    const store = await Store.load()
    const active = Store.pickActive(store)
    if (active) await fetchUsage(active).catch(() => undefined)
  })()
}

function startBackgroundRefresh(api: TuiPluginApi): void {
  refreshAll()
  const interval = setInterval(refreshAll, USAGE_REFRESH_MS)
  let lastIdle = 0
  const off = api.event.on("session.idle", () => {
    const now = Date.now()
    if (now - lastIdle < SESSION_IDLE_DEBOUNCE_MS) return
    lastIdle = now
    refreshActive()
  })
  api.lifecycle.onDispose(() => {
    clearInterval(interval)
    off()
  })
}

function PromptStatus(props: { api: TuiPluginApi }) {
  const store = trackStore()
  const active = createMemo(() => Store.pickActive(store()))
  const text = createMemo(() => {
    const a = active()
    if (!a) return "Codex: no account"
    return `${shortLabel(a)}${planSuffix(a)}`
  })
  return (
    <text fg={props.api.theme.current.textMuted} selectable={false} truncate wrapMode="none">
      {text()}
    </text>
  )
}

interface WindowLine {
  label: string
  remaining: number
  reset?: string
}

function activeWindowLines(account: Account | undefined): WindowLine[] {
  if (!account?.usage) return []
  return account.usage.windows.map((window: UsageWindow) => ({
    label: formatWindowLabel(window.windowMinutes),
    remaining: leftPercent(window.usedPercent) ?? 0,
    reset: formatResetCountdown(window.resetAtMs),
  }))
}

function aggregateWindowLines(accounts: Account[]): WindowLine[] {
  const byMinutes = new Map<number, { totalLeft: number; count: number }>()
  for (const account of accounts) {
    for (const window of account.usage?.windows ?? []) {
      const left = leftPercent(window.usedPercent)
      if (left == null) continue
      const entry = byMinutes.get(window.windowMinutes) ?? { totalLeft: 0, count: 0 }
      entry.totalLeft += left
      entry.count += 1
      byMinutes.set(window.windowMinutes, entry)
    }
  }
  const rows: WindowLine[] = []
  for (const [minutes, entry] of [...byMinutes.entries()].sort((a, b) => a[0] - b[0])) {
    rows.push({
      label: formatWindowLabel(minutes),
      remaining: entry.totalLeft / entry.count,
    })
  }
  return rows
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(
    a.r * (1 - t) + b.r * t,
    a.g * (1 - t) + b.g * t,
    a.b * (1 - t) + b.b * t,
    1,
  )
}

function WindowRow(props: { api: TuiPluginApi; line: WindowLine }) {
  const theme = () => props.api.theme.current
  const barFilledFg = () => mix(theme().textMuted, theme().text, 0)
  const bar = () => splitBar(props.line.remaining, SIDEBAR_BAR_WIDTH)
  const tail = () => {
    const pct = Math.round(props.line.remaining)
    return props.line.reset
      ? `  ${props.line.label} · ${pct}% (${props.line.reset})`
      : `  ${props.line.label} · ${pct}%`
  }
  return (
    <text wrapMode="none">
      <span style={{ fg: theme().primary }}>{bar().filled}</span>
      <span style={{ fg: theme().borderSubtle }}>{bar().empty}</span>
      <span style={{ fg: theme().textMuted }}>{tail()}</span>
    </text>
  )
}

function SidebarPanel(props: { api: TuiPluginApi }) {
  const store = trackStore()
  const theme = () => props.api.theme.current
  const accounts = createMemo(() => store().accounts)
  const active = createMemo(() => Store.pickActive(store()))
  const activeLines = createMemo(() => activeWindowLines(active()))
  const poolLines = createMemo(() => aggregateWindowLines(accounts()))

  return (
    <Show
      when={accounts().length > 0}
      fallback={
        <box gap={0}>
          <text fg={theme().text}>
            <b>Codex</b>
          </text>
          <text fg={theme().textMuted}>No accounts. Use /connect → openai to add one.</text>
        </box>
      }
    >
      <box gap={1}>
        <Show when={active()}>
          <box gap={0}>
            <text fg={theme().text}>
              <b>Quota</b>
            </text>
            <For each={activeLines()}>{(line) => <WindowRow api={props.api} line={line} />}</For>
          </box>
        </Show>
        <Show when={accounts().length > 1}>
          <box gap={0}>
            <text fg={theme().text}>
              <b>All Quota</b>
            </text>
            <For each={poolLines()}>{(line) => <WindowRow api={props.api} line={line} />}</For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function showAccountsDialog(api: TuiPluginApi): void {
  const dialog = api.ui.dialog
  void Store.load().then((store) => {
    if (store.accounts.length === 0) {
      dialog.replace(() => (
        <api.ui.DialogAlert
          title="Codex accounts"
          message="No accounts yet. Use /connect → openai to add one."
          onConfirm={() => dialog.clear()}
        />
      ))
      return
    }
    const activeId = store.active
    const now = Date.now()
    dialog.replace(() => (
      <api.ui.DialogSelect
        title="Switch Codex account"
        current={activeId}
        options={store.accounts.map((account) => {
          const status: string[] = []
          if (account.id === activeId) status.push("active")
          if (account.rateLimitUntilMs && account.rateLimitUntilMs > now) status.push("rate-limited")
          const window5h = account.usage?.windows.find((w) => w.windowMinutes <= 600)
          if (window5h) {
            const left = leftPercent(window5h.usedPercent)
            if (left != null) status.push(`5h ${Math.round(left)}%`)
          }
          const plan = planName(account)
          const titleParts = [account.label || account.email || account.id]
          if (plan) titleParts.push(plan)
          return {
            title: titleParts.join(" · "),
            value: account.id,
            description: status.join(" · ") || undefined,
          }
        })}
        onSelect={async (option) => {
          if (typeof option.value !== "string") return
          if (option.value !== activeId) {
            await Store.setActive(option.value)
            refreshActive()
          }
          dialog.clear()
        }}
      />
    ))
  })
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      session_prompt_right: () => (<PromptStatus api={api} />) as unknown as JSX.Element,
      sidebar_content: () => (<SidebarPanel api={api} />) as unknown as JSX.Element,
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "codex.accounts.switch",
        title: "Codex: switch account",
        category: "Codex",
        slashName: "accounts",
        run() {
          showAccountsDialog(api)
        },
      },
    ],
    bindings: [],
  } as Parameters<typeof api.keymap.registerLayer>[0])

  startBackgroundRefresh(api)
}

export { tui }
export default {
  id: "opencode-codex",
  tui,
}
