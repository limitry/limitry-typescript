import { apiErrorFrom } from "../errors.ts";
import type { BaseClient, Schemas } from "../index.ts";
import { PRODUCT_RETRY_HEADER } from "../retry.ts";
import { retryWaitMs } from "./moving.ts";

/**
 * Limitry's helpers (docs/product/roadmap.md slice 6): the two shapes a
 * product's code takes around a costly call, so adding Limitry is one
 * wrapper — and an agent adding it writes the same thing every time.
 *
 *   const limitry = createClient(); // reads LIMITRY_API_KEY
 *
 *   // Known cost: check, then do the work only if allowed.
 *   const response = await limitry.guard(
 *     { subject: { kind: "apikey", id: key.id }, action: "api-request" },
 *     () => handle(request),
 *   );
 *
 *   // Cost known afterwards (an AI reply's cents), or "at most N at
 *   // once": reserve what it will probably cost, do the work, commit
 *   // what it used — released on failure.
 *   const answer = await limitry.reserve(
 *     { subject: { kind: "user", id: user.id }, action: "ai-call", cost: 5 },
 *     async (reservation) => {
 *       const res = await callModel(prompt);
 *       reservation.cost(priceCents(res.usage));
 *       return res;
 *     },
 *   );
 *
 * A refusal throws `LimitReached` (with `limitId` and
 * `retryAfterSeconds`). When Limitry cannot be reached — an error, a 5xx,
 * no answer within `timeoutMs`, the workspace past its plan's allowance
 * (402 `plan_limit_reached`) or the edge's flood guard (429) — each
 * limit's fail mode decides: the last decision's `failMode` for this
 * subject and action is remembered in memory, and `closed` throws
 * `Unavailable` while `open` — the default, and the answer before any
 * decision was seen — lets the work run unmetered.
 *
 * A subject being handed over between Limitry's servers (a split, a few
 * seconds) answers `503 moving`, and a limiter with too many checks
 * inside at once `503 busy`: Limitry was reached and charged nothing.
 * The check (or commit, or release) is sent again with the same key only
 * while the wait still fits in `timeoutMs`, every try and wait included
 * — the wait is the answer's Retry-After (at least a second) plus full
 * jitter on a growing backoff — and then the fail mode applies. These
 * helpers sit in front of a user (a request, a page), so they answer
 * within `timeoutMs` whatever Limitry says; and a refused check that
 * comes back once, not for half a minute, doesn't keep an overloaded
 * limiter full (lab, 2026-10-27: PR #307). Plain API calls keep the
 * longer wait (./moving.ts).
 *
 * Retries are safe (docs/product idempotency): each guard or reserve
 * sends one Idempotency-Key, which the client's own retries reuse, so a
 * check counts once however often it is sent. A reservation whose check
 * timed out may have been made all the same: once the work is done,
 * `reserve` sends the check again with the same key — a replay, nothing
 * counted twice — and releases the reservation it finds, rather than
 * leave it taken until it expires. Commits and releases retry too
 * (committing or releasing twice answers the same).
 */

type Decision = Schemas["CheckDecision"];
type Subject = { kind: string; id: string };

export type LimitsOptions = {
  /** How long to wait for a decision before the fail mode applies. Default 1500 ms. */
  timeoutMs?: number;
  /** The fail mode before any decision was seen, or to force one. Default: remembered, else `open`. */
  failMode?: "open" | "closed";
};

export type GuardRequest = {
  subject: Subject;
  action: string;
  /** Units it uses. Default 1. */
  cost?: number;
  /** Pools it also draws from (a team's, an org's). */
  shared?: Subject[];
};

export type ReserveRequest = {
  subject: Subject;
  action: string;
  /** What it will probably use — reserved until you commit the actual cost. Default 1. */
  cost?: number;
  shared?: Subject[];
  /** How long the reservation lasts if never committed or released (default 300, at most 3600). */
  ttlSeconds?: number;
};

export type Reservation = {
  /**
   * The cost actually used — committed when the work returns. Default: the
   * reserved cost. A whole number from 0 to 1,000,000,000, as the API
   * commits: anything else throws a RangeError here, in your code, rather
   * than a commit the API refuses after the work (whose usage would go
   * uncounted).
   */
  cost(units: number): void;
  /**
   * Keep the reservation for longer work: it expires `ttlSeconds` from now
   * (default 300, 1 to 3600). Throws the API's error, such as for a
   * reservation that already expired.
   */
  extend(ttlSeconds?: number): Promise<void>;
};

/** The largest cost a commit takes. */
const MAX_COST = 1_000_000_000;

function checkedCost(units: number): number {
  if (!Number.isInteger(units) || units < 0 || units > MAX_COST) {
    throw new RangeError(
      `reservation.cost(${units}): the cost must be a whole number from 0 to ${MAX_COST}`,
    );
  }
  return units;
}

/** Refused: a limit is reached, or the subject holds too many open reservations. */
export class LimitReached extends Error {
  readonly reason: "limit_reached" | "too_many_reservations";
  /** The limit that refused; null for too many open reservations. */
  readonly limitId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly decision: Decision;

  constructor(decision: Decision) {
    // The API's own sentence (reason.message), one wording everywhere.
    super(decision.reason?.message ?? "Refused");
    this.name = "LimitReached";
    this.reason = decision.reason?.code ?? "limit_reached";
    this.limitId = decision.reason?.limitId ?? null;
    this.retryAfterSeconds = decision.retryAfterSeconds ?? null;
    this.decision = decision;
  }
}

/**
 * Limitry could not be reached (an error, a 5xx, a timeout, the plan's
 * allowance used up, or the flood guard's 429) and a limit on this
 * subject and action fails closed. With `open`, the work runs instead.
 */
export class Unavailable extends Error {
  constructor() {
    super("Limitry could not be reached and a limit refuses when unreachable");
    this.name = "Unavailable";
  }
}

const UNREACHABLE = Symbol("unreachable");
/** No answer in time: unlike an error, the check may have been decided. */
const TIMED_OUT = Symbol("timed out");
/** How long the background finish of a guard's timed-out check may take, retries included. */
const FINISH_TIMEOUT_MS = 5000;

export type LimitsInternals = {
  /** Waits (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** 0 ≤ x < 1 for the jitter (tests pass a fixed one). */
  random?: () => number;
};

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Seconds of a `Retry-After`, as ms (none: undefined; `retryWaitMs` floors it at a second). */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  const seconds = value === null ? NaN : Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function createLimits(
  client: BaseClient,
  options: LimitsOptions = {},
  internals: LimitsInternals = {},
) {
  const timeoutMs = options.timeoutMs ?? 1500;
  const sleep = internals.sleep ?? wait;
  const random = internals.random ?? Math.random;
  /** The last fail mode seen per subject + action (closed if any limit is). */
  const remembered = new Map<string, "open" | "closed">();
  const key = (s: Subject, action: string) =>
    `${s.kind}\u0000${s.id}\u0000${action}`;
  const failMode = (s: Subject, action: string) =>
    options.failMode ?? remembered.get(key(s, action)) ?? "open";
  const remember = (s: Subject, action: string, decision: Decision) => {
    if (options.failMode) return;
    const closed = decision.limits.some((r) => r.failMode === "closed");
    remembered.set(key(s, action), closed ? "closed" : "open");
    if (remembered.size > 10_000) {
      remembered.delete(remembered.keys().next().value!);
    }
  };

  /**
   * What is left of `budgetMs`: the time since the start, or the waits
   * slept, whichever is more (a test's fake sleep takes no time).
   */
  function budget(budgetMs: number) {
    const started = Date.now();
    let slept = 0;
    return {
      // Whole ms: AbortSignal.timeout refuses a fraction (jitter makes them).
      left: () => Math.ceil(budgetMs - Math.max(Date.now() - started, slept)),
      async sleep(ms: number) {
        slept += ms;
        await sleep(ms);
      },
    };
  }

  /**
   * The decision — or UNREACHABLE (network error, 5xx, past the plan, the
   * flood guard's 429, or `moving` / `busy` until the next wait won't
   * fit), or TIMED_OUT (no answer in time). A `moving` or `busy` answer
   * is asked again, with the same key, while the wait fits in `budgetMs`.
   */
  async function check(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    budgetMs = timeoutMs,
    finishOnly = false,
  ): Promise<Decision | typeof UNREACHABLE | typeof TIMED_OUT> {
    const time = budget(budgetMs);
    for (let tries = 0; ; tries++) {
      const answer = await checkOnce(
        body,
        idempotencyKey,
        Math.max(1, time.left()),
        finishOnly,
      );
      if (answer.kind !== "later") return answer.value;
      const pause = retryWaitMs(answer.retryAfterMs, tries, random);
      if (pause >= time.left()) return UNREACHABLE;
      await time.sleep(pause);
    }
  }

  async function checkOnce(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    wait: number,
    finishOnly: boolean,
  ): Promise<
    | {
        kind: "answer";
        value: Decision | typeof UNREACHABLE | typeof TIMED_OUT;
      }
    | { kind: "later"; retryAfterMs: number | undefined }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced as well as aborted: a custom fetch (a service binding, a
    // test) may ignore the signal.
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), wait);
    });
    const asked = (async () => {
      try {
        const { data, error, response } = await client.POST("/checks", {
          body,
          headers: {
            "idempotency-key": idempotencyKey,
            // `moving` and `busy` come back here at once: this loop
            // retries them.
            [PRODUCT_RETRY_HEADER]: "return",
            ...(finishOnly ? { "limitry-finish-only": "1" } : {}),
          },
          signal: AbortSignal.timeout(wait),
        });
        if (data) return data;
        if (isRetryLater(response, error))
          return { later: retryAfterMs(response) };
        // Past the plan's allowance (402 plan_limit_reached), or stopped by
        // the edge's flood guard (429): no decision — each limit's fail
        // mode applies, as if Limitry were unreachable.
        if (response.status === 402 || response.status === 429) {
          return UNREACHABLE;
        }
        // A 4xx is the caller's mistake (bad request, bad key): say so.
        if (response.status < 500 && error) {
          return new Error(
            `Limitry refused the check (${response.status}): ${JSON.stringify(error)}`,
          );
        }
        return UNREACHABLE;
      } catch (error) {
        return (error as Error)?.name === "TimeoutError"
          ? TIMED_OUT
          : UNREACHABLE;
      }
    })();
    try {
      const answer = await Promise.race([asked, late]);
      if (answer instanceof Error) throw answer;
      if (typeof answer === "object" && "later" in answer)
        return { kind: "later", retryAfterMs: answer.later };
      return { kind: "answer", value: answer };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Committing or releasing never fails the caller's work: the client
   * retries it (the same commit answers the same), and one lost all the
   * same expires by itself.
   */
  async function settle(
    id: string,
    action: "commit" | "release",
    cost?: number,
  ) {
    // A commit lost leaves the work uncounted (an expired reservation is
    // not charged), but it runs before the caller's result comes back:
    // `moving` or `busy` is asked again, with the same key, only while
    // the wait fits in `timeoutMs`.
    const idempotencyKey = crypto.randomUUID();
    const time = budget(timeoutMs);
    for (let tries = 0; ; tries++) {
      let retryMs: number | null = null;
      try {
        const headers = {
          "idempotency-key": idempotencyKey,
          [PRODUCT_RETRY_HEADER]: "return",
        };
        const { error, response } =
          action === "commit"
            ? await client.POST("/reservations/{reservationId}/commit", {
                params: { path: { reservationId: id } },
                body: { cost: cost ?? 0 },
                headers,
                signal: AbortSignal.timeout(Math.max(1, time.left())),
              })
            : await client.POST("/reservations/{reservationId}/release", {
                params: { path: { reservationId: id } },
                headers,
                signal: AbortSignal.timeout(Math.max(1, time.left())),
              });
        if (isRetryLater(response, error))
          retryMs = retryWaitMs(retryAfterMs(response), tries, random);
      } catch {
        // The reservation expires on its own.
      }
      if (retryMs === null || retryMs >= time.left()) return;
      await time.sleep(retryMs);
    }
  }

  /**
   * After a reservation's check timed out: ask again with the same key (a
   * replay if Limitry decided it) and release any reservation it made.
   */
  async function releaseUnheard(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
  ) {
    const replay = await check(body, idempotencyKey);
    if (typeof replay === "object" && replay.reservation) {
      await settle(replay.reservation.id, "release");
    }
  }

  return {
    /**
     * Where a subject stands on every limit on it (and on `shared`
     * subjects): used, remaining, resetsAt — for showing an end user. Call
     * it from your server; a key never belongs in a browser. Not a check:
     * nothing is counted; a subject with no limit gets an empty `limits`.
     * Throws on an error answer.
     */
    async standing(request: {
      subject: Subject;
      shared?: Subject[];
    }): Promise<Schemas["UsageStanding"]> {
      const { data, error, response } = await client.GET("/usage/standing", {
        params: {
          query: {
            subject: `${request.subject.kind}:${request.subject.id}`,
            ...(request.shared?.length
              ? {
                  shared: request.shared
                    .map((s) => `${s.kind}:${s.id}`)
                    .join(","),
                }
              : {}),
          },
        },
      });
      if (data) return data;
      throw new Error(
        `Limitry refused usage.standing (${response.status}): ${JSON.stringify(error)}`,
      );
    },

    /** Checks `cost`, runs `fn` only if allowed, and returns its result. */
    async guard<T>(request: GuardRequest, fn: () => Promise<T>): Promise<T> {
      const body = {
        subject: request.subject,
        shared: request.shared,
        action: request.action,
        cost: request.cost ?? 1,
      };
      const idempotencyKey = crypto.randomUUID();
      const decision = await check(body, idempotencyKey);
      if (decision === UNREACHABLE || decision === TIMED_OUT) {
        if (failMode(request.subject, request.action) === "closed") {
          throw new Unavailable();
        }
        if (decision === TIMED_OUT) {
          // No answer in time, and the work runs (fail open): the check may
          // be part way (held on some of Limitry's servers, across
          // subjects). Sent once more with the same key, in the background,
          // ONLY TO FINISH it — Limitry never decides it afresh then, so a
          // check that never arrived charges nothing.
          void check(body, idempotencyKey, FINISH_TIMEOUT_MS, true).catch(
            () => {},
          );
        }
        return fn();
      }
      remember(request.subject, request.action, decision);
      if (!decision.allowed) throw new LimitReached(decision);
      return fn();
    },

    /**
     * Reserves `cost`, runs `fn`, then commits the cost it reported
     * (`reservation.cost(n)`, default the reserved cost) — or releases the
     * reservation if `fn` throws, and rethrows. A concurrent limit's slot
     * is taken for exactly as long as `fn` runs.
     */
    async reserve<T>(
      request: ReserveRequest,
      fn: (reservation: Reservation) => Promise<T>,
    ): Promise<T> {
      const reserved = request.cost ?? 1;
      const body: Schemas["CheckRequest"] = {
        subject: request.subject,
        shared: request.shared,
        action: request.action,
        cost: reserved,
        mode: "reserve",
        ttlSeconds: request.ttlSeconds,
      };
      const idempotencyKey = crypto.randomUUID();
      const decision = await check(body, idempotencyKey);
      const unmetered: Reservation = {
        // Checked even unmetered: the mistake shows whether or not
        // Limitry answered.
        cost: (units) => void checkedCost(units),
        extend: async () => {},
      };
      if (decision === UNREACHABLE || decision === TIMED_OUT) {
        const unheard = () =>
          decision === TIMED_OUT
            ? releaseUnheard(body, idempotencyKey)
            : Promise.resolve();
        if (failMode(request.subject, request.action) === "closed") {
          await unheard();
          throw new Unavailable();
        }
        try {
          return await fn(unmetered);
        } finally {
          await unheard();
        }
      }
      remember(request.subject, request.action, decision);
      if (!decision.allowed || !decision.reservation) {
        throw new LimitReached(decision);
      }
      const id = decision.reservation.id;
      let used = reserved;
      const reservation: Reservation = {
        cost(units) {
          used = checkedCost(units);
        },
        async extend(ttlSeconds) {
          // Passed as given: the API refuses a bad one (0, past 3600).
          const { error, response } = await client.POST(
            "/reservations/{reservationId}/extend",
            {
              params: { path: { reservationId: id } },
              body: ttlSeconds === undefined ? {} : { ttlSeconds },
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
          if (error !== undefined) throw apiErrorFrom(error, response);
        },
      };
      let result: T;
      try {
        result = await fn(reservation);
      } catch (error) {
        await settle(id, "release");
        throw error;
      }
      await settle(id, "commit", used);
      return result;
    },
  };
}

export type Limits = ReturnType<typeof createLimits>;

/** `503 moving` or `503 busy`: nothing was charged — retry with the same key. */
function isRetryLater(response: Response, error: unknown): boolean {
  const code = (error as { error?: { code?: string } } | undefined)?.error
    ?.code;
  return response.status === 503 && (code === "moving" || code === "busy");
}
