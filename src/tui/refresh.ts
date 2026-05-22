import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import * as accounts from '../accounts/index.js';
import * as usage from '../codex/usage.js';

const INTERVAL_MS = 5 * 60_000;
const IDLE_DEBOUNCE_MS = 30_000;

async function all(): Promise<void> {
  await Promise.all(
    accounts.list().map((a) => usage.fetch(a).catch(() => undefined)),
  );
}

export async function activeNow(): Promise<void> {
  const a = accounts.active();
  if (a) await usage.fetch(a).catch(() => undefined);
}

export function start(api: TuiPluginApi): void {
  void all();
  const interval = setInterval(() => void all(), INTERVAL_MS);
  let lastIdle = 0;
  const off = api.event.on('session.idle', () => {
    const now = Date.now();
    if (now - lastIdle < IDLE_DEBOUNCE_MS) return;
    lastIdle = now;
    void activeNow();
  });
  api.lifecycle.onDispose(() => {
    clearInterval(interval);
    off();
  });
}
