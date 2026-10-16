/**
 * Safe retries, one rule for every client (the SDK, the CLI, the MCP
 * server; docs/architecture.md "Idempotency"): a WRITE gets one
 * Idempotency-Key per logical call, and every automatic retry of that
 * call sends the same key, so the API runs it once however many times
 * it is sent. Without a key a timed-out create that actually ran would
 * run again on retry; with a fresh key per attempt it would too.
 *
 * Retried: a network failure, 408, 429, 500, 502, 503, 504, and 409
 * `idempotency_in_progress` (the first attempt is still running). Waits
 * the response's Retry-After when it gives one, else a jittered backoff
 * (0.5s, 1s, … capped at 8s); a Retry-After longer than MAX_WAIT_MS is
 * handed back to the caller rather than slept through. A request whose
 * own signal aborted (a caller's timeout) is never retried: the caller
 * decided.
 */

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_WAIT_MS = 20_000;
/** The longest key a caller may pass where a client derives keys from it. */
export const MAX_BASE_KEY = 200;

type Fetch = (request: Request) => Promise<Response>;

export type RetryOptions = {
  /** Retries after the first attempt (default 2; 0 = never retry). */
  maxRetries?: number;
  /** The key for a write that has none (default: a random UUID). */
  key?: (method: string, path: string) => string | Promise<string>;
  /** Waits (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base * (0.75 + Math.random() * 0.25);
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function retryable(response: Response): Promise<boolean> {
  if (RETRY_STATUSES.has(response.status)) return true;
  if (response.status !== 409) return false;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: string };
    };
    return body.error?.code === "idempotency_in_progress";
  } catch {
    return false;
  }
}

/** `fetch` with the rule above. Each request is one logical call. */
export function withRetries(fetch: Fetch, options: RetryOptions = {}): Fetch {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? wait;
  return async (request) => {
    if (WRITES.has(request.method) && !request.headers.has("idempotency-key")) {
      const url = new URL(request.url);
      const key = options.key
        ? await options.key(request.method, url.pathname)
        : crypto.randomUUID();
      const headers = new Headers(request.headers);
      headers.set("idempotency-key", key);
      request = new Request(request, { headers });
    }
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxRetries;
      // Send a copy while a retry may follow: a body is read once.
      const sending = last ? request : request.clone();
      let response: Response;
      try {
        response = await fetch(sending);
      } catch (error) {
        if (last || request.signal.aborted) throw error;
        await sleep(backoff(attempt));
        continue;
      }
      if (last || !(await retryable(response))) return response;
      const delay = retryAfter(response) ?? backoff(attempt);
      if (delay > MAX_WAIT_MS) return response;
      await response.body?.cancel();
      await sleep(delay);
    }
  };
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Keys for a command or tool call that may make several writes, from
 * one key its caller chose (`--idempotency-key`, an MCP tool's
 * `idempotencyKey`): each write gets `<key>:<16 hex>`, a digest of its
 * method, path and how many times the call wrote there before — so the
 * same call run again sends the same keys, write for write, and a write
 * it skips the second time shifts no other write's key. Without a key,
 * a fresh UUID per write.
 */
export function keysFrom(base: string | undefined) {
  if (base !== undefined && (base.length === 0 || base.length > MAX_BASE_KEY)) {
    throw new Error(`the idempotency key must be 1–${MAX_BASE_KEY} characters`);
  }
  if (base !== undefined && !/^[\x21-\x7e]+$/.test(base)) {
    throw new Error(
      "the idempotency key must be printable ASCII with no spaces",
    );
  }
  const seen = new Map<string, number>();
  return async (method: string, path: string): Promise<string> => {
    if (base === undefined) return crypto.randomUUID();
    const target = `${method} ${path}`;
    const n = (seen.get(target) ?? 0) + 1;
    seen.set(target, n);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${target}#${n}`),
    );
    return `${base}:${hex(digest).slice(0, 16)}`;
  };
}
