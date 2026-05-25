import * as accounts from '../accounts/index.js';
import type { Account } from '../accounts/types.js';
import { CODEX_ENDPOINT } from '../config.js';
import * as token from './token.js';
import * as trace from './trace.js';

const HEADER_TIMEOUT_MS = 15_000;
const HEADER_FETCH_ATTEMPTS = 2;
const STREAM_PROGRESS_INTERVAL_MS = 10_000;

function isCodexRoute(url: URL): boolean {
  return (
    url.pathname.includes('/v1/responses') ||
    url.pathname.includes('/chat/completions')
  );
}

function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs > 0) return now + secs * 1000;
  const ts = Date.parse(value);
  if (Number.isFinite(ts) && ts > now) return ts;
  return undefined;
}

function buildHeaders(
  init: RequestInit | undefined,
  account: Account,
): Headers {
  const headers = new Headers();
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value));
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value));
      }
    }
  }
  headers.delete('authorization');
  headers.set('authorization', `Bearer ${account.access}`);
  headers.set('ChatGPT-Account-Id', account.id);
  return headers;
}

function methodFor(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return 'GET';
}

function contentLength(headers: Headers): string | undefined {
  return headers.get('content-length') ?? undefined;
}

function timeoutError(ms: number): DOMException {
  return new DOMException(
    `Codex upstream did not return headers within ${ms}ms`,
    'TimeoutError',
  );
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function canRetry(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

function fetchSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  clearTimeout: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(timeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timer),
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function wrapBody(
  response: Response,
  context: trace.Context | undefined,
  cleanup: () => void,
): Response {
  if (!context) return response;
  const body = response.body;
  if (!body) {
    trace.log(context, 'upstream.body.none');
    cleanup();
    return response;
  }

  const reader = body.getReader();
  let chunks = 0;
  let bytes = 0;
  let done = false;
  let lastProgressMs = Date.now();

  const finish = (event: string, fields: Record<string, unknown> = {}) => {
    if (done) return;
    done = true;
    trace.log(context, event, { chunks, bytes, ...fields });
    cleanup();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish('upstream.body.end');
          controller.close();
          return;
        }
        chunks += 1;
        bytes += next.value.byteLength;
        if (chunks === 1) {
          trace.log(context, 'upstream.body.first_chunk', {
            bytes: next.value.byteLength,
          });
        }
        const now = Date.now();
        if (now - lastProgressMs >= STREAM_PROGRESS_INTERVAL_MS) {
          lastProgressMs = now;
          trace.log(context, 'upstream.body.progress', { chunks, bytes });
        }
        controller.enqueue(next.value);
      } catch (err) {
        finish('upstream.body.error', { error: trace.error(err) });
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish('upstream.body.cancel', { reason: trace.error(reason) });
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchHeaders(
  target: URL,
  init: RequestInit | undefined,
  headers: Headers,
  context: trace.Context | undefined,
): Promise<{ response: Response; cleanup: () => void }> {
  const attempts = canRetry(init) ? HEADER_FETCH_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    trace.log(context, 'upstream.fetch.start', {
      attempt,
      attempts,
      headerTimeoutMs: HEADER_TIMEOUT_MS,
      contentLength: contentLength(headers),
      contentType: headers.get('content-type') ?? undefined,
    });

    const upstreamSignal = fetchSignal(init?.signal ?? undefined, HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        ...init,
        signal: upstreamSignal.signal,
        headers,
      });
      upstreamSignal.clearTimeout();
      trace.log(context, 'upstream.headers', {
        attempt,
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
      });
      return { response, cleanup: upstreamSignal.cleanup };
    } catch (err) {
      upstreamSignal.cleanup();
      lastError = err;
      const retry =
        attempt < attempts && isTimeoutError(err) && !init?.signal?.aborted;
      trace.log(context, retry ? 'upstream.fetch.retry' : 'upstream.fetch.error', {
        attempt,
        attempts,
        error: trace.error(err),
      });
      if (retry) continue;
      throw err;
    }
  }

  throw lastError;
}

/**
 * Build a fetch implementation that proxies requests through the picked
 * Codex account. The returned function has the standard `fetch` signature.
 */
export function create(): typeof fetch {
  return async function codexFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const parsed =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    const isCodex = isCodexRoute(parsed);
    const context = isCodex ? trace.create() : undefined;
    const account = accounts.pick();
    if (!account) {
      trace.log(context, 'request.no_account', { sourcePath: parsed.pathname });
      return new Response(
        JSON.stringify({ error: { message: 'No Codex account configured' } }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    const target = isCodexRoute(parsed) ? new URL(CODEX_ENDPOINT) : parsed;
    trace.log(context, 'request.start', {
      method: methodFor(input, init),
      sourcePath: parsed.pathname,
      targetHost: target.host,
      targetPath: target.pathname,
      account: trace.accountId(account.id),
      tokenFresh: token.isFresh(account),
      signalProvided: !!init?.signal,
      aborted: init?.signal?.aborted ?? false,
    });

    const onAbort = () => {
      trace.log(context, 'request.abort', {
        reason: trace.error(init?.signal?.reason),
      });
    };
    init?.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => init?.signal?.removeEventListener('abort', onAbort);

    let fresh: Account;
    try {
      trace.log(context, 'token.ensure.start');
      fresh = await token.ensure(account, init?.signal ?? undefined);
      trace.log(context, 'token.ensure.end', {
        account: trace.accountId(fresh.id),
        refreshed: fresh.access !== account.access || fresh.expires !== account.expires,
      });
    } catch (err) {
      cleanup();
      trace.log(context, 'token.ensure.error', { error: trace.error(err) });
      throw err;
    }

    const headers = buildHeaders(init, fresh);
    let response: Response;
    let upstreamCleanup: () => void;
    try {
      const result = await fetchHeaders(target, init, headers, context);
      response = result.response;
      upstreamCleanup = result.cleanup;
    } catch (err) {
      cleanup();
      throw err;
    }

    if (response.status === 429 || response.status === 402) {
      const now = Date.now();
      const until =
        parseRetryAfter(response.headers.get('retry-after'), now) ??
        now + 5 * 60_000;
      void accounts.rateLimit(fresh.id, until);
    } else if (response.ok) {
      void accounts.touch(fresh.id);
      if (fresh.rateLimitUntilMs) void accounts.clearRateLimit(fresh.id);
    }
    return wrapBody(response, context, () => {
      upstreamCleanup();
      cleanup();
    });
  };
}
