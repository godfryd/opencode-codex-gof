import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let sequence = 0;
let writeQueue: Promise<void> = Promise.resolve();

export interface Context {
  id: string;
  startMs: number;
}

export function file(): string {
  return path.join(dataDir(), 'fetch.log');
}

export function create(): Context {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return {
    id: `${process.pid}-${Date.now().toString(36)}-${sequence.toString(36)}`,
    startMs: Date.now(),
  };
}

export function accountId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

export function error(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message.slice(0, 300),
    };
  }
  return { message: String(err).slice(0, 300) };
}

export function log(
  context: Context | undefined,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!context || process.env.OPENCODE_CODEX_TRACE === '0') return;
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    request: context.id,
    elapsedMs: Date.now() - context.startMs,
    event,
    ...fields,
  };
  const line = `${JSON.stringify(record)}\n`;
  writeQueue = writeQueue
    .then(async () => {
      const target = file();
      await fs.mkdir(path.dirname(target), { recursive: true });
      await rotate(target);
      await fs.appendFile(target, line, { mode: 0o600 });
    })
    .catch(() => undefined);
}

async function rotate(target: string): Promise<void> {
  try {
    const stat = await fs.stat(target);
    if (stat.size <= MAX_LOG_BYTES) return;
    await fs.rename(target, `${target}.1`).catch(() => undefined);
  } catch {}
}
