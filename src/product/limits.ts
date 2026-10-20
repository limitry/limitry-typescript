import { apiErrorFrom } from "../errors.ts";
import type { BaseClient, Schemas } from "../index.ts";

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
/** How long a settle (or a replay to find a hold) may take, retries included. */
const SETTLE_TIMEOUT_MS = 5000;

export function createLimits(client: BaseClient, options: LimitsOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 1500;
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
   * The decision — or UNREACHABLE (network error, 5xx, past the plan, the
   * flood guard's 429), or TIMED_OUT (no answer within `wait`).
   */
  async function check(
    body: Schemas["CheckRequest"],
    idempotencyKey: string,
    wait = timeoutMs,
  ): Promise<Decision | typeof UNREACHABLE | typeof TIMED_OUT> {
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
          headers: { "idempotency-key": idempotencyKey },
          signal: AbortSignal.timeout(wait),
        });
        if (data) return data;
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
      return answer;
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
    try {
      if (action === "commit") {
        await client.POST("/reservations/{reservationId}/commit", {
          params: { path: { reservationId: id } },
          body: { cost: cost ?? 0 },
          signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
        });
      } else {
        await client.POST("/reservations/{reservationId}/release", {
          params: { path: { reservationId: id } },
          signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
        });
      }
    } catch {
      // The reservation expires on its own.
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
    const replay = await check(body, idempotencyKey, SETTLE_TIMEOUT_MS);
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
      const decision = await check(
        {
          subject: request.subject,
          shared: request.shared,
          action: request.action,
          cost: request.cost ?? 1,
        },
        crypto.randomUUID(),
      );
      if (decision === UNREACHABLE || decision === TIMED_OUT) {
        if (failMode(request.subject, request.action) === "closed") {
          throw new Unavailable();
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
