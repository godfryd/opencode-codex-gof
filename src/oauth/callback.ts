import { createServer, type Server } from 'node:http';
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_URI } from '../config.js';
import type { PkceCodes } from './pkce';
import { exchange } from './tokens';
import type { TokenResponse } from './types';

const SUCCESS_HTML = `<!doctype html><html><head><title>OpenCode Codex - Success</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.c{text-align:center;padding:2rem}h1{margin-bottom:1rem}p{color:#b7b1b1}</style>
</head><body><div class="c"><h1>Authorization successful</h1><p>You can close this window and return to OpenCode.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const errorHtml = (
  msg: string,
) => `<!doctype html><html><head><title>OpenCode Codex - Failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.c{text-align:center;padding:2rem}h1{color:#fc533a;margin-bottom:1rem}.err{color:#ff917b;font-family:monospace;margin-top:1rem;padding:1rem;background:#3c140d;border-radius:.5rem}</style>
</head><body><div class="c"><h1>Authorization failed</h1><div class="err">${msg.replace(/</g, '&lt;')}</div></div></body></html>`;

interface Pending {
  pkce: PkceCodes;
  state: string;
  resolve: (tokens: TokenResponse) => void;
  reject: (err: Error) => void;
}

let server: Server | undefined;
let pending: Pending | undefined;

export async function start(): Promise<{ redirectUri: string }> {
  if (server) return { redirectUri: OAUTH_CALLBACK_URI };

  server = createServer((req, res) => {
    const url = new URL(
      req.url || '/',
      `http://localhost:${OAUTH_CALLBACK_PORT}`,
    );
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err =
      url.searchParams.get('error_description') ||
      url.searchParams.get('error');

    if (err) return fail(err, res);
    if (!code) return fail('Missing authorization code', res);
    if (!pending || state !== pending.state)
      return fail('Invalid state - potential CSRF', res);

    const current = pending;
    pending = undefined;
    exchange(code, OAUTH_CALLBACK_URI, current.pkce)
      .then((t) => current.resolve(t))
      .catch((e) => current.reject(e));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(SUCCESS_HTML);
  });

  await new Promise<void>((resolve, reject) => {
    server!.listen(OAUTH_CALLBACK_PORT, resolve);
    server!.once('error', reject);
  });
  return { redirectUri: OAUTH_CALLBACK_URI };
}

function fail(message: string, res: import('node:http').ServerResponse): void {
  pending?.reject(new Error(message));
  pending = undefined;
  res.writeHead(400, { 'Content-Type': 'text/html' });
  res.end(errorHtml(message));
}

export function stop(): void {
  if (server) {
    server.close();
    server = undefined;
  }
}

export function waitForCode(
  codes: PkceCodes,
  state: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending) {
        pending = undefined;
        reject(new Error('Authorization timed out'));
      }
    }, timeoutMs);
    pending = {
      pkce: codes,
      state,
      resolve: (t) => {
        clearTimeout(timer);
        resolve(t);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
  });
}
