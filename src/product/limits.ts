import { APITimeoutError, apiErrorFrom, SdkError } from "../errors.ts";
import type { BaseClient, Schemas } from "../index.ts";
import { PRODUCT_RETRY_HEADER } from "../retry.ts";
import { retryWaitMs } from "./moving.ts";

/**
 * Limitry's helpers (docs/product/history.md slice 6): the two shapes a
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
 * A refusal throws `LimitReachedError` (with `limitId` and
 * `retryAfterSeconds`). When Limitry cannot be reached — an error, a 5xx,
 * no answer within `timeout`, the workspace past its plan's allowance
 * (402 `plan_limit_reached`) or the edge's flood guard (429) — each
 * limit's fail mode decides: the last decision's `failMode` for this
 * subject and action is remembered in memory, and `closed` throws
 * `UnavailableError` (its `reason` says which) while `open` — the
 * default, and the answer before any decision was seen — lets the work
 * run uncounted. One exception: an `open` concurrent limit is held to its
 * amount in this process (design-fallback.md). `reserve` counts the runs
 * it has going per subject and action, answered or not, and remembers
 * the smallest concurrent limit's `amount` from the last decision; while
 * Limitry can't answer, a reserve that would pass that amount throws
 * `UnavailableError`. The count is this process's only: several servers
 * may together run more, bounded where it was unbounded.
 *
 * `timeout` (ms, default 1500; the client's from `createLimits`, or a
 * call's) is the most a check adds to your request, its tries included:
 * the fail-open promise. It is not the client's per-attempt `timeout`.
 * A call's `signal` ends the check at once, waits included, and throws
 * the signal's reason: the work never runs and no fail mode applies,
 * since cancelling is not Limitry being unreachable (owner, 2026-11-22).
 * A reserve cancelled while its check is out releases any reservation the
 * check made, in the background. Once the work has run, its commit (or
 * release) still goes out within `timeout`, so what it used is counted.
 *
 * A subject being handed over between Limitry's servers (a split, a few
 * seconds) answers `503 moving`, and a limiter with too many checks
 * inside at once `503 busy`: Limitry was reached and charged nothing.
 * The check (or commit, or release) is sent again with the same key only
 * while the wait still fits in `timeout`, every try and wait included
 * — the wait is the answer's Retry-After (at least a second) plus full
 * jitter on a growing backoff — and then the fail mode applies. These
 * helpers sit in front of a user (a request, a page), so they answer
 * within `timeout` whatever Limitry says; and a refused check that
 * comes back once, not for half a minute, doesn't keep an overloaded
 * limiter full (lab, 2026-10-27: PR #307). Plain API calls keep the
 * longer wait (./moving.ts).
 *
 * Retries are safe (docs/product idempotency): each guard or reserve
 * sends one Idempotency-Key (the caller's `idempotencyKey`, else a new
 * one), which the client's own retries reuse, so a check counts once
 * however often it is sent. A reservation whose check timed out may have
 * been made all the same: once the work is done, `reserve` sends the
 * check again with the same key — a replay, nothing counted twice — and
 * releases the reservation it finds, rather than leave it taken until it
 * expires. Commits and releases retry too (committing or releasing twice
 * answers the same).
 */

type Decision = Schemas["CheckDecision"];
type Subject = { kind: string; id: string };
type FailMode = "open" | "closed";

export type LimitsOptions = {
  /**
   * The most a check adds to your request, its tries included, in ms
   * (default 1500); then the fail mode applies.
   */
  timeout?: number;
  /** The fail mode before any decision was seen, or to force one. Default: remembered, else `open`. */
  failMode?: FailMode;
};

/** What every guard or reserve call may also take. */
export type CallOptions = {
  /** This call's `timeout`, in ms, instead of the client's. */
  timeout?: number;
  /** This call's fail mode, instead of the remembered one. */
  failMode?: FailMode;
  /** Ends the check at once, waits included: throws the signal's reason. */
  signal?: AbortSignal;
  /** The check's Idempotency-Key (default: a new one per call). */
  idempotencyKey?: string;
};

export type GuardRequest = CallOptions & {
  subject: Subject;
  action: string;
  /** Units it uses. Default 1. */
  cost?: number;
  /** Pools it also draws from (a team's, an org's). */
  shared?: Subject[];
};

export type ReserveRequest = CallOptions & {
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
export class LimitReachedError extends SdkError {
  readonly reason: "limit_reached" | "too_many_reservations";
  /** The limit that refused; null for too many open reservations. */
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly retryAfterSeconds: number | null;
  readonly decision: Decision;

  constructor(decision: Decision) {
    // The API's own sentence (reason.message), one wording everywhere.
    super(decision.reason?.message ?? "Refused");
    this.name = "LimitReachedError";
    this.reason = decision.reason?.code ?? "limit_reached";
    this.limitId = decision.reason?.limitId ?? null;
    this.limitName = decision.reason?.limitName ?? null;
    this.retryAfterSeconds = decision.retryAfterSeconds ?? null;
    this.decision = decision;
  }
}

/** Why Limitry gave no decision. */
export type UnavailableReason =
  /** No answer within `timeout`. */
  | "timeout"
  /** A network error, a 5xx, or `moving`/`busy` past `timeout`. */
  | "unreachable"
  /** The workspace is past its plan's allowance (402). */
  | "plan_limit_reached"
  /** The edge's flood guard (429). */
  | "rate_limited";

/**
 * Limitry gave no decision (`reason` says why) and a limit on this
 * subject and action fails closed. With `open`, the work runs instead.
 */
export class UnavailableError extends SdkError {
  readonly reason: UnavailableReason;

  constructor(reason: UnavailableReason, options?: { cause?: unknown }) {
    super(
      `Limitry gave no decision (${reason}) and a limit refuses when unreachable`,
      options,
    );
    this.name = "UnavailableError";
    this.reason = reason;
  }
}

/** No decision: why, and what failed (kept as the error's `cause`). */
class NoDecision {
  // Plain fields, not parameter properties: Node's type stripping (the
  // docs build and the Python parity check import this file) refuses them.
  readonly reason: UnavailableReason;
  readonly cause?: unknown;
  constructor(reason: UnavailableReason, cause?: unknown) {
    this.reason = reason;
    this.cause = cause;
  }
  /** No answer in time: unlike an error, the check may have been decided. */
  get timedOut() {
    return this.reason === "timeout";
  }
}

/** How long the background finish of a guard's timed-out check may take, retries included. */
const FINISH_TIMEOUT_MS = 5000;

export type LimitsInternals = {
  /** Waits (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** 0 ≤ x < 1 for the jitter (tests pass a fixed one). */
  random?: () => number;
};

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** `work`, or the signal's reason as soon as it aborts. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

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
  const defaultTimeout = options.timeout ?? 1500;
  const sleep = internals.sleep ?? wait;
  const random = internals.random ?? Math.random;
  /** The last fail mode seen per subject + action (closed if any limit is). */
  const remembered = new Map<string, FailMode>();
  const key = (s: Subject, action: string) =>
    `${s.kind}\u0000${s.id}\u0000${action}`;
  const failMode = (r: CallOptions & { subject: Subject; action: string }) =>
    r.failMode ??
    options.failMode ??
    remembered.get(key(r.subject, r.action)) ??
    "open";
  /**
   * The smallest concurrent limit's amount last seen per subject + action,
   * and the reserves this client has going for each, answered or not
   * (design-fallback.md): an `open` concurrent limit is held to its
   * amount in this process when Limitry can't answer.
   */
  const concurrentAmounts = new Map<string, number>();
  const running = new Map<string, number>();
  const remember = (s: Subject, action: string, decision: Decision) => {
    const amounts = decision.limits
      .filter((r) => r.window === "concurrent" && typeof r.amount === "number")
      .map((r) => r.amount);
    if (amounts.length > 0) {
      concurrentAmounts.set(key(s, action), Math.min(...amounts));
      if (concurrentAmounts.size > 10_000) {
        concurrentAmounts.delete(concurrentAmounts.keys().next().value!);
      }
    } else {
      concurrentAmounts.delete(key(s, action));
    }
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
  function budget(budgetMs: number, signal?: AbortSignal) {
    const started = Date.now();
    let slept = 0;
    return {
      // Whole ms: AbortSignal.timeout refuses a fraction (jitter makes them).
      left: () => Math.ceil(budgetMs - Math.max(Date.now() - started, slept)),
      async sleep(ms: number) {
        slept += ms;
        await abortable(sleep(ms), signal);
      },
    };
  }

  /**
   * The decision — or why there is none (network error, 5xx, past the
   * plan, the flood guard's 429, `moving` / `busy` until the next wait
   * won't fit, or no answer in time). A `moving` or `busy` answer is
   * asked again, with the same key, while the wait fits in `budgetMs`.
   * The caller's `signal` ends it at once, throwing its reason.
   */
  async function check(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    budgetMs: number,
    finishOnly = false,
    signal?: AbortSignal,
  ): Promise<Decision | NoDecision> {
    const time = budget(budgetMs, signal);
    for (let tries = 0; ; tries++) {
      const answer = await checkOnce(
        body,
        idempotencyKey,
        Math.max(1, time.left()),
        finishOnly,
        signal,
      );
      if (answer.kind !== "later") return answer.value;
      const pause = retryWaitMs(answer.retryAfterMs, tries, random);
      if (pause >= time.left()) return new NoDecision("unreachable");
      await time.sleep(pause);
    }
  }

  async function checkOnce(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    wait: number,
    finishOnly: boolean,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "answer"; value: Decision | NoDecision }
    | { kind: "later"; retryAfterMs: number | undefined }
  > {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced as well as aborted: a custom fetch (a service binding, a
    // test) may ignore the signal.
    const late = new Promise<NoDecision>((resolve) => {
      timer = setTimeout(() => resolve(new NoDecision("timeout")), wait);
    });
    const deadline = AbortSignal.timeout(wait);
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
          signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
        });
        if (data) return data;
        if (isRetryLater(response, error))
          return { later: retryAfterMs(response) };
        // Past the plan's allowance (402 plan_limit_reached), or stopped by
        // the edge's flood guard (429): no decision — each limit's fail
        // mode applies, as if Limitry were unreachable.
        if (response.status === 402)
          return new NoDecision(
            "plan_limit_reached",
            apiErrorFrom(error, response),
          );
        if (response.status === 429)
          return new NoDecision("rate_limited", apiErrorFrom(error, response));
        // A 4xx is the caller's mistake (bad request, bad key): say so.
        if (response.status < 500) return apiErrorFrom(error, response);
        return new NoDecision("unreachable", apiErrorFrom(error, response));
      } catch (error) {
        // The caller's own abort is theirs, never a fail mode.
        if (signal?.aborted) throw signal.reason;
        return (error as Error)?.name === "TimeoutError" ||
          error instanceof APITimeoutError
          ? new NoDecision("timeout", error)
          : new NoDecision("unreachable", error);
      }
    })();
    try {
      const answer = await abortable(Promise.race([asked, late]), signal);
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
    timeoutMs: number,
    cost?: number,
  ) {
    // A commit lost leaves the work uncounted (an expired reservation is
    // not charged), but it runs before the caller's result comes back:
    // `moving` or `busy` is asked again, with the same key, only while
    // the wait fits in `timeout`.
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
   * After a reservation's check timed out (or was cancelled): ask again
   * with the same key (a replay if Limitry decided it) and release any
   * reservation it made.
   */
  async function releaseUnheard(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    timeoutMs: number,
  ) {
    const replay = await check(body, idempotencyKey, timeoutMs);
    if (!(replay instanceof NoDecision) && replay.reservation) {
      await settle(replay.reservation.id, "release", timeoutMs);
    }
  }

  return {
    /**
     * Where a subject stands on every limit on it (and on `shared`
     * subjects): used, remaining, resetsAt — for showing an end user. Call
     * it from your server; a key never belongs in a browser. Not a check:
     * nothing is counted; a subject with no limit gets an empty `limits`.
     * Throws the API's error (APIError) on an error answer.
     */
    async standing(request: {
      subject: Subject;
      shared?: Subject[];
      signal?: AbortSignal;
    }): Promise<Schemas["SubjectStanding"]> {
      const { data, error, response } = await client.GET(
        "/subjects/{subjectKind}/{subjectId}/standing",
        {
          params: {
            path: {
              subjectKind: request.subject.kind,
              subjectId: request.subject.id,
            },
            query: {
              ...(request.shared?.length
                ? {
                    shared: request.shared
                      .map((s) => `${s.kind}:${s.id}`)
                      .join(","),
                  }
                : {}),
            },
          },
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      if (data) return data;
      throw apiErrorFrom(error, response);
    },

    /** Checks `cost`, runs `fn` only if allowed, and returns its result. */
    async guard<T>(request: GuardRequest, fn: () => Promise<T>): Promise<T> {
      request.signal?.throwIfAborted();
      const body = {
        subject: request.subject,
        shared: request.shared,
        action: request.action,
        cost: request.cost ?? 1,
      };
      const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();
      const decision = await check(
        body,
        idempotencyKey,
        request.timeout ?? defaultTimeout,
        false,
        request.signal,
      );
      if (decision instanceof NoDecision) {
        if (failMode(request) === "closed") {
          throw new UnavailableError(decision.reason, {
            cause: decision.cause,
          });
        }
        if (decision.timedOut) {
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
      if (!decision.allowed) throw new LimitReachedError(decision);
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
      request.signal?.throwIfAborted();
      const reserved = request.cost ?? 1;
      const body: Schemas["CheckRequest"] = {
        subject: request.subject,
        shared: request.shared,
        action: request.action,
        cost: reserved,
        mode: "reserve",
        ttlSeconds: request.ttlSeconds,
      };
      const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();
      const slot = key(request.subject, request.action);
      // Runs this client already has going for the subject and action.
      const before = running.get(slot) ?? 0;
      running.set(slot, before + 1);
      try {
        return await reserveOnce(request, fn, body, idempotencyKey, before);
      } finally {
        const left = (running.get(slot) ?? 1) - 1;
        if (left > 0) running.set(slot, left);
        else running.delete(slot);
      }
    },
  };

  async function reserveOnce<T>(
    request: ReserveRequest,
    fn: (reservation: Reservation) => Promise<T>,
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    before: number,
  ): Promise<T> {
    const reserved = request.cost ?? 1;
    const timeoutMs = request.timeout ?? defaultTimeout;
    let decision: Decision | NoDecision;
    try {
      decision = await check(
        body,
        idempotencyKey,
        timeoutMs,
        false,
        request.signal,
      );
    } catch (error) {
      // Cancelled while the check was out: it may have reserved all the
      // same. Released in the background, so the cancel stays at once.
      if (request.signal?.aborted)
        void releaseUnheard(body, idempotencyKey, timeoutMs).catch(() => {});
      throw error;
    }
    const uncounted: Reservation = {
      // Checked even uncounted: the mistake shows whether or not
      // Limitry answered.
      cost: (units) => void checkedCost(units),
      extend: async () => {},
    };
    if (decision instanceof NoDecision) {
      const none = decision;
      const unheard = () =>
        none.timedOut
          ? releaseUnheard(body, idempotencyKey, timeoutMs)
          : Promise.resolve();
      const amount = concurrentAmounts.get(
        key(request.subject, request.action),
      );
      if (
        failMode(request) === "closed" ||
        // Open, but never past a concurrent limit's amount here.
        (amount !== undefined && before >= amount)
      ) {
        await unheard();
        throw new UnavailableError(none.reason, { cause: none.cause });
      }
      try {
        return await fn(uncounted);
      } finally {
        await unheard();
      }
    }
    remember(request.subject, request.action, decision);
    if (!decision.allowed || !decision.reservation) {
      throw new LimitReachedError(decision);
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
      await settle(id, "release", timeoutMs);
      throw error;
    }
    await settle(id, "commit", timeoutMs, used);
    return result;
  }
}

export type Limits = ReturnType<typeof createLimits>;

/** `503 moving` or `503 busy`: nothing was charged — retry with the same key. */
function isRetryLater(response: Response, error: unknown): boolean {
  const code = (error as { error?: { code?: string } } | undefined)?.error
    ?.code;
  return response.status === 503 && (code === "moving" || code === "busy");
}
