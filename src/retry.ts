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
 *
 * A `503 moving` (a subject handed over between Limitry's servers, a few
 * seconds) or `503 busy` (too many checks inside one of them at once) is
 * retried for up to MOVING_MS whatever `maxRetries` says: nothing was
 * charged, and the same key gets the answer once it lands. Each wait is
 * the Retry-After (at least a second) plus full jitter on a capped
 * exponential backoff (`retryWaitMs`), so clients turned away together
 * don't come back together. A caller that keeps its own time budget (the
 * guard and reserve helpers) sends `MOVING_HEADER: return` and gets
 * either answer back at once.
 */

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_WAIT_MS = 20_000;
/**
 * How long a `moving` or `busy` answer is retried, all told: a handover's
 * freeze lasts at most 30 s.
 */
export const MOVING_MS = 30_000;
/** Sent by a caller that retries `moving` and `busy` itself (never reaches the API). */
export const MOVING_HEADER = "x-limitry-moving";
/** The backoff added to a `moving` or `busy` wait: full jitter under base × 2^n, capped. */
export const JITTER_BASE_MS = 250;
export const JITTER_CAP_MS = 4_000;
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
  /** 0 ≤ x < 1 for the jitter (tests pass a fixed one). */
  random?: () => number;
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

/**
 * The wait before retrying a `moving` or `busy` answer, the `attempt`th
 * in a row (0 first): the server's Retry-After, at least a second (a 0,
 * or a date past, must not spin), plus full jitter — anywhere from 0 to
 * min(JITTER_CAP_MS, JITTER_BASE_MS × 2^attempt).
 */
export function retryWaitMs(
  retryAfterMs: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): number {
  const floor = Math.max(1_000, retryAfterMs ?? 1_000);
  const ceiling = Math.min(JITTER_CAP_MS, JITTER_BASE_MS * 2 ** attempt);
  return floor + random() * ceiling;
}

/** A `503` that says retry later with the same key: `moving` or `busy` (else null). */
export async function retryLater(
  response: Response,
): Promise<"moving" | "busy" | null> {
  if (response.status !== 503) return null;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: string };
    };
    const code = body.error?.code;
    return code === "moving" || code === "busy" ? code : null;
  } catch {
    return null;
  }
}

/** A `503` whose error code is `moving`. */
export async function isMoving(response: Response): Promise<boolean> {
  return (await retryLater(response)) === "moving";
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

/**
 * `fetch` that only drops MOVING_HEADER (a client with retries off): the
 * header is between the SDK's own parts, never sent to the API.
 */
export function withoutMovingHeader(fetch: Fetch): Fetch {
  return (request) => {
    if (!request.headers.has(MOVING_HEADER)) return fetch(request);
    const headers = new Headers(request.headers);
    headers.delete(MOVING_HEADER);
    return fetch(new Request(request, { headers }));
  };
}

/** `fetch` with the rule above. Each request is one logical call. */
export function withRetries(fetch: Fetch, options: RetryOptions = {}): Fetch {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? wait;
  const random = options.random ?? Math.random;
  return async (request) => {
    const returnMoving = request.headers.get(MOVING_HEADER) === "return";
    if (request.headers.has(MOVING_HEADER)) {
      const headers = new Headers(request.headers);
      headers.delete(MOVING_HEADER);
      request = new Request(request, { headers });
    }
    if (WRITES.has(request.method) && !request.headers.has("idempotency-key")) {
      const url = new URL(request.url);
      const key = options.key
        ? await options.key(request.method, url.pathname)
        : crypto.randomUUID();
      const headers = new Headers(request.headers);
      headers.set("idempotency-key", key);
      request = new Request(request, { headers });
    }
    let movingWaited = 0;
    let movingTries = 0;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxRetries;
      // Send a copy while a retry may follow: a body is read once.
      const sending = request.clone();
      let response: Response;
      try {
        response = await fetch(sending);
      } catch (error) {
        if (last || request.signal.aborted) throw error;
        await sleep(backoff(attempt));
        continue;
      }
      const later = await retryLater(response);
      if (later && returnMoving) return response;
      if (later) {
        // Retried apart from maxRetries, for up to MOVING_MS.
        const delay = retryWaitMs(retryAfter(response), movingTries++, random);
        if (movingWaited + delay > MOVING_MS) return response;
        movingWaited += delay;
        await response.body?.cancel();
        await sleep(delay);
        attempt--;
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
