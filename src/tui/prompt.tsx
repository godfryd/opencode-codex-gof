/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createMemo } from 'solid-js';
import * as accounts from '../accounts/index.js';
import * as quota from '../quota/index.js';
import { useAccountsStore } from './store-signal';

const MAX = 24;

function trim(label: string, max = MAX): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

export function PromptStatus(props: { api: TuiPluginApi }) {
  const store = useAccountsStore();
  const active = createMemo(() => accounts.active(store()));
  const text = createMemo(() => {
    const a = active();
    if (!a) return 'no account';
    const name = a.label || a.email || a.id;
    const plan = quota.plan(a);
    return plan ? `${trim(name)} (${plan})` : trim(name);
  });
  return (
    <text
      fg={props.api.theme.current.textMuted}
      selectable={false}
      truncate
      wrapMode="none"
    >
      {text()}
    </text>
  );
}
