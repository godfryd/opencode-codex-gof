/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { Show, createMemo } from 'solid-js';
import * as selection from '../accounts/selection.js';
import * as quota from '../quota/index.js';
import { useAccountsStore } from './store-signal.js';

const MAX = 24;

function trim(label: string, max = MAX): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

export function PromptStatus(props: { api: TuiPluginApi }) {
  const store = useAccountsStore();
  const active = createMemo(() => selection.active(store()));
  const status = createMemo(() => {
    const a = active();
    if (!a) return;
    const name = a.label || a.email || a.id;
    return { name: trim(name), plan: quota.plan(a) };
  });
  return (
    <text
      fg={props.api.theme.current.textMuted}
      selectable={false}
      truncate
      wrapMode="none"
    >
      <Show when={status()} fallback="no Codex account">
        {(s) => (
          <>
            <span style={{ fg: props.api.theme.current.accent }}>{s().name}</span>
            {s().plan && ` · ${s().plan}`}
          </>
        )}
      </Show>
    </text>
  );
}
