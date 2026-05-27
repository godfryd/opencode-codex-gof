/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { For, Show, createMemo } from 'solid-js';
import * as selection from '../accounts/selection.js';
import type { Store } from '../accounts/types.js';
import * as quota from '../quota/index.js';
import { useAccountsStore } from './store-signal.js';

const BAR_WIDTH = 17;

interface Line {
  label: string;
  remaining: number;
  reset?: string;
}

function activeLines(store: Store): Line[] {
  const a = selection.active(store);
  if (!a?.usage) return [];
  return a.usage.windows.map((w) => ({
    label: quota.label(w.windowMinutes),
    remaining: quota.left(w.usedPercent) ?? 0,
    reset: quota.countdown(w.resetAtMs),
  }));
}

function poolLines(store: Store): Line[] {
  return quota.aggregate(store.accounts).map((row) => ({
    label: quota.label(row.windowMinutes),
    remaining: row.remaining,
  }));
}

function WindowRow(props: { api: TuiPluginApi; line: Line }) {
  const theme = () => props.api.theme.current;
  const parts = createMemo(() => quota.bar(props.line.remaining, BAR_WIDTH));
  const tail = createMemo(() => {
    const pct = Math.round(props.line.remaining);
    return props.line.reset && pct < 100
      ? `  ${props.line.label} · ${pct}% (${props.line.reset})`
      : `  ${props.line.label} · ${pct}%`;
  });
  return (
    <text wrapMode="none">
      <span style={{ fg: theme().accent }}>{parts().filled}</span>
      <span style={{ fg: theme().borderSubtle }}>{parts().empty}</span>
      <span style={{ fg: theme().textMuted }}>{tail()}</span>
    </text>
  );
}

export function Sidebar(props: { api: TuiPluginApi }) {
  const store = useAccountsStore();
  const theme = () => props.api.theme.current;
  const list = createMemo(() => store().accounts);
  const active = createMemo(() => selection.active(store()));
  const showActive = createMemo(() => !!active());
  const showPool = createMemo(() => list().length > 1);
  const activeRows = createMemo(() => activeLines(store()));
  const poolRows = createMemo(() => poolLines(store()));

  return (
    <Show
      when={list().length > 0}
      fallback={
        <box gap={0}>
          <text fg={theme().text}>
            <b>Codex</b>
          </text>
          <text fg={theme().textMuted}>
            No accounts. Use /connect → openai to add one.
          </text>
        </box>
      }
    >
      <box gap={1}>
        <Show when={showActive()}>
          <box gap={0}>
            <text fg={theme().text}>
              <b>Quota</b>
            </text>
            <For each={activeRows()}>
              {(line) => <WindowRow api={props.api} line={line} />}
            </For>
          </box>
        </Show>
        <Show when={showPool()}>
          <box gap={0}>
            <text fg={theme().text}>
              <b>All Quota</b>
            </text>
            <For each={poolRows()}>
              {(line) => <WindowRow api={props.api} line={line} />}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  );
}
