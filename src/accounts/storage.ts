import { promises as fs } from 'node:fs';
import { accountsFile, dataDir } from '../paths.js';
import type { Store } from './types.js';

const EMPTY: Store = { version: 1, accounts: [] };

export function empty(): Store {
  return structuredClone(EMPTY);
}

export function file(): string {
  return accountsFile();
}

export async function read(): Promise<Store> {
  const target = file();
  try {
    const raw = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return empty();
    }
    return { version: 1, active: parsed.active, accounts: parsed.accounts };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      try {
        await fs.rename(target, `${target}.bak`);
      } catch {}
    }
    return empty();
  }
}

export async function write(store: Store): Promise<number | undefined> {
  await fs.mkdir(dataDir(), { recursive: true });
  const target = file();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
  try {
    return (await fs.stat(target)).mtimeMs;
  } catch {
    return undefined;
  }
}
