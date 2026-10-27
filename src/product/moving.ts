/**
 * PRODUCT-OWNED: Limitry's own "try again shortly" answers, retried by
 * every client through the platform's `productRetry` seam (../retry.ts).
 *
 * A `503 moving` (a subject handed over between Limitry's servers, a few
 * seconds) or `503 busy` (too many checks inside one of them at once) is
 * retried for up to MOVING_MS whatever `maxRetries` says: nothing was
 * charged, and the same key gets the answer once it lands. Each wait is
 * the Retry-After (at least a second) plus full jitter on a capped
 * exponential backoff (`retryWaitMs`), so clients turned away together
 * don't come back together. A caller that keeps its own time budget (the
 * guard and reserve helpers) sends `PRODUCT_RETRY_HEADER: return` and
 * gets either answer back at once.
 *
 * Imports only TYPES from ../retry.ts: that file reads this one through
 * ./index.ts, so a value imported back would be read before it exists.
 */
import type { ProductRetry } from "../retry.ts";

/**
 * How long a `moving` or `busy` answer is retried, all told: a handover's
 * freeze lasts at most 30 s.
 */
export const MOVING_MS = 30_000;
/** The backoff added to a `moving` or `busy` wait: full jitter under base × 2^n, capped. */
export const JITTER_BASE_MS = 250;
export const JITTER_CAP_MS = 4_000;

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

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** `moving` and `busy` as the platform's ProductRetry (tests pass a fixed `random`). */
export function movingRetry(random: () => number = Math.random): ProductRetry {
  return {
    wait: async (response, tries) =>
      (await retryLater(response))
        ? retryWaitMs(retryAfter(response), tries, random)
        : null,
    budgetMs: MOVING_MS,
  };
}
