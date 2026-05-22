import { watchFile } from 'node:fs';
import * as storage from './storage.js';
import type { Store } from './types.js';

const WATCH_INTERVAL_MS = 1000;

let cached: Store | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(store: Store) => void>();
let lastWrittenMtimeMs: number | undefined;
let watcherStarted = false;

function clone(store: Store): Store {
  return structuredClone(store);
}

function notify(store: Store): void {
  for (const listener of listeners) {
    try {
      listener(clone(store));
    } catch {}
  }
}

function startWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  const watcher = watchFile(
    storage.file(),
    { interval: WATCH_INTERVAL_MS },
    (curr) => {
      if (curr.mtimeMs === 0) return;
      if (curr.mtimeMs === lastWrittenMtimeMs) return;
      lastWrittenMtimeMs = curr.mtimeMs;
      void (async () => {
        const fresh = await storage.read();
        cached = fresh;
        notify(fresh);
      })();
    },
  );
  watcher.unref();
}

export async function load(): Promise<Store> {
  if (!cached) cached = await storage.read();
  startWatcher();
  return cached;
}

export function snapshot(): Store {
  return cached ? clone(cached) : storage.empty();
}

export async function mutate(
  fn: (store: Store) => void | Store,
): Promise<Store> {
  const current = await load();
  const next = clone(current);
  const result = fn(next);
  const final = result ?? next;
  cached = final;
  writeQueue = writeQueue
    .then(async () => {
      const mtimeMs = await storage.write(final);
      lastWrittenMtimeMs = mtimeMs ?? lastWrittenMtimeMs;
    })
    .catch(() => undefined);
  await writeQueue;
  notify(final);
  return final;
}

export function subscribe(listener: (store: Store) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
