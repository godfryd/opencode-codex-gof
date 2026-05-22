#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

execSync('tsc', { stdio: 'inherit' });

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsx')) renameSync(p, p.replace(/\.jsx$/, '.tsx'));
  }
}
walk('dist');
