import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Entry } from './types';

export function authJsonPath(): string {
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'opencode', 'auth.json');
}

let queue: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<Record<string, Entry>> {
  try {
    const raw = await fs.readFile(authJsonPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function persist(data: Record<string, Entry>): Promise<void> {
  const file = authJsonPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function read(): Promise<Record<string, Entry>> {
  return readAll();
}

export async function get(key: string): Promise<Entry | undefined> {
  return (await readAll())[key];
}

export async function set(key: string, entry: Entry): Promise<void> {
  await (queue = queue.then(async () => {
    const data = await readAll();
    data[key] = entry;
    await persist(data);
  }));
}

export async function remove(key: string): Promise<void> {
  await (queue = queue.then(async () => {
    const data = await readAll();
    if (!(key in data)) return;
    delete data[key];
    await persist(data);
  }));
}

/**
 * Apply a batch of writes/deletes atomically. Unrelated entries are
 * preserved.
 */
export async function bulk(input: {
  writes?: Record<string, Entry>;
  removes?: string[];
}): Promise<void> {
  await (queue = queue.then(async () => {
    const data = await readAll();
    for (const k of input.removes ?? []) delete data[k];
    for (const [k, v] of Object.entries(input.writes ?? {})) data[k] = v;
    await persist(data);
  }));
}
