import { describe, expect, it, vi } from "vitest";

import { createClient } from "../index.ts";
import { createLimits, LimitReached, Unavailable } from "./limits.ts";

type Handler = (path: string, body: unknown) => Response | Promise<Response>;

const slept: number[] = [];
function limitsWith(handler: Handler, options = {}, random = () => 0) {
  const calls: {
    path: string;
    body: unknown;
    key: string | null;
    finishOnly: string | null;
  }[] = [];
  const client = createClient({
    token: "sk_test",
    api: "https://api.example.test",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace(/^\/v1/, "");
      const text = await request.text();
      const body = text ? JSON.parse(text) : undefined;
      calls.push({
        path,
        body,
        key: request.headers.get("idempotency-key"),
        finishOnly: request.headers.get("limitry-finish-only"),
      });
      return handler(path, body);
    },
  });
  return {
    limits: createLimits(
      client,
      { timeoutMs: 100, ...options },
      { sleep: async (ms) => void slept.push(ms), random },
    ),
    calls,
  };
}

const moving = () =>
  Response.json(
    { error: { code: "moving", message: "moving" } },
    { status: 503, headers: { "retry-after": "1" } },
  );

const decision = (
  allowed: boolean,
  failMode: "open" | "closed" = "open",
  extra = {},
) =>
  Response.json({
    id: "chk_1",
    allowed,
    reason: allowed
      ? null
      : { code: "limit_reached", limitId: "lmt_a", message: "Refused by A." },
    limits: [
      {
        limitId: "lmt_a",
        name: "A",
        unit: "units",
        window: "day",
        rolling: false,
        failMode,
        remaining: allowed ? 5 : 0,
        resetsAt: null,
      },
    ],
    retryAfterSeconds: allowed ? null : 42,
    ...extra,
  });
const subject = { kind: "user", id: "u1" };

describe("a subject being handed over (`moving`)", () => {
  it("asks again with the same key while the wait fits in timeoutMs, and counts the work", async () => {
    let n = 0;
    const work = vi.fn(async () => "done");
    const { limits, calls } = limitsWith(
      (path) => (path === "/checks" && n++ < 3 ? moving() : decision(true)),
      { timeoutMs: 10_000 },
    );
    expect(await limits.guard({ subject, action: "run" }, work)).toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
    const checks = calls.filter((c) => c.path === "/checks");
    expect(checks).toHaveLength(4);
    expect(new Set(checks.map((c) => c.key)).size).toBe(1);
  });

  it("is unreachable once the next wait won't fit in timeoutMs: then the fail mode decides", async () => {
    const work = vi.fn(async () => "ran");
    const open = limitsWith(() => moving(), { timeoutMs: 1500 });
    slept.length = 0;
    expect(await open.limits.guard({ subject, action: "run" }, work)).toBe(
      "ran",
    );
    // Asked, a second's wait (fits in 1.5 s), asked again; the next
    // second won't fit.
    expect(open.calls.length).toBe(2);
    expect(slept).toEqual([1000]);
    const closed = limitsWith(() => moving(), {
      timeoutMs: 1500,
      failMode: "closed",
    });
    await expect(
      closed.limits.guard({ subject, action: "run" }, work),
    ).rejects.toBeInstanceOf(Unavailable);
  });

  it("keeps a commit going through a handover, with the same key", async () => {
    let commits = 0;
    const { limits, calls } = limitsWith(
      (path) => {
        if (path === "/checks")
          return decision(true, "open", {
            reservation: {
              id: "rsv_1",
              expiresAt: "2026-10-21T00:00:00.000Z",
            },
          });
        if (path.endsWith("/commit") && commits++ < 2) return moving();
        return Response.json({ id: "rsv_1", status: "committed" });
      },
      { timeoutMs: 10_000 },
    );
    await limits.reserve({ subject, action: "run", cost: 2 }, async () => {});
    const sent = calls.filter((c) => c.path.endsWith("/commit"));
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((c) => c.key)).size).toBe(1);
  });
});

const busy = (seconds = "2") =>
  Response.json(
    { error: { code: "busy", message: "busy" } },
    { status: 503, headers: { "retry-after": seconds } },
  );

describe("an overloaded limiter (`busy`)", () => {
  it("asks again with the same key after Retry-After plus jitter, and counts the work", async () => {
    let n = 0;
    const work = vi.fn(async () => "done");
    const { limits, calls } = limitsWith(
      (path) => (path === "/checks" && n++ < 3 ? busy() : decision(true)),
      { timeoutMs: 30_000 },
      () => 0.5,
    );
    slept.length = 0;
    expect(await limits.guard({ subject, action: "run" }, work)).toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
    const checks = calls.filter((c) => c.path === "/checks");
    expect(checks).toHaveLength(4);
    expect(new Set(checks.map((c) => c.key)).size).toBe(1);
    // Retry-After 2 s, plus half of the backoff: 250, 500, 1000 ms.
    expect(slept).toEqual([2125, 2250, 2500]);
  });

  it("shares moving's budget: unreachable once the next wait won't fit, then the fail mode decides", async () => {
    const work = vi.fn(async () => "ran");
    let n = 0;
    const open = limitsWith(() => (n++ % 2 ? busy("1") : moving()), {
      timeoutMs: 1500,
    });
    slept.length = 0;
    expect(await open.limits.guard({ subject, action: "run" }, work)).toBe(
      "ran",
    );
    expect(open.calls.length).toBe(2);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThan(1500);
    const closed = limitsWith(() => busy(), { failMode: "closed" });
    await expect(
      closed.limits.guard({ subject, action: "run" }, work),
    ).rejects.toBeInstanceOf(Unavailable);
  });

  it("waits longer, with jitter, the more often it is turned away — inside its bounds", async () => {
    const { limits } = limitsWith(
      () => busy("1"),
      { timeoutMs: 30_000 },
      Math.random,
    );
    slept.length = 0;
    await limits.guard({ subject, action: "run" }, async () => "ran");
    expect(slept.length).toBeGreaterThan(5);
    slept.forEach((ms, n) => {
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThan(1_000 + Math.min(4_000, 250 * 2 ** n));
    });
  });

  it("keeps a commit going while busy, with the same key", async () => {
    let commits = 0;
    const { limits, calls } = limitsWith(
      (path) => {
        if (path === "/checks")
          return decision(true, "open", {
            reservation: {
              id: "rsv_1",
              expiresAt: "2026-10-21T00:00:00.000Z",
            },
          });
        if (path.endsWith("/commit") && commits++ < 2) return busy();
        return Response.json({ id: "rsv_1", status: "committed" });
      },
      { timeoutMs: 10_000 },
    );
    await limits.reserve({ subject, action: "run", cost: 2 }, async () => {});
    const sent = calls.filter((c) => c.path.endsWith("/commit"));
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((c) => c.key)).size).toBe(1);
  });

  it("gives up a commit that stays busy within timeoutMs, and still returns the work's result", async () => {
    const { limits, calls } = limitsWith(
      (path) =>
        path === "/checks"
          ? decision(true, "open", {
              reservation: {
                id: "rsv_1",
                expiresAt: "2026-10-21T00:00:00.000Z",
              },
            })
          : busy("1"),
      { timeoutMs: 1500 },
    );
    slept.length = 0;
    expect(
      await limits.reserve({ subject, action: "run" }, async () => "answer"),
    ).toBe("answer");
    expect(calls.filter((c) => c.path.endsWith("/commit"))).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });
});

describe("guard after a check that timed out", () => {
  it("sends it once more with the same key, in the background, to finish it", async () => {
    let n = 0;
    const { limits, calls } = limitsWith(async () => {
      if (n++ === 0) await new Promise((r) => setTimeout(r, 300));
      return decision(true);
    });
    await limits.guard({ subject, action: "run" }, async () => "ran");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path === "/checks")).toHaveLength(2),
    );
    const [first, second] = calls.filter((c) => c.path === "/checks");
    expect(second.key).toBe(first.key);
    expect(second.finishOnly).toBe("1");
    expect(first.finishOnly).toBeNull();
  });

  it("never resends when the limit fails closed (the work didn't run)", async () => {
    let n = 0;
    const { limits, calls } = limitsWith(
      async () => {
        if (n++ === 0) await new Promise((r) => setTimeout(r, 300));
        return decision(true);
      },
      { failMode: "closed" },
    );
    await expect(
      limits.guard({ subject, action: "run" }, async () => "ran"),
    ).rejects.toBeInstanceOf(Unavailable);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.filter((c) => c.path === "/checks")).toHaveLength(1);
  });
});

describe("guard", () => {
  it("runs the work only when allowed", async () => {
    const work = vi.fn(async () => "done");
    const { limits, calls } = limitsWith(() => decision(true));
    expect(await limits.guard({ subject, action: "run", cost: 3 }, work)).toBe(
      "done",
    );
    expect(calls[0]).toMatchObject({
      path: "/checks",
      body: { subject, action: "run", cost: 3 },
    });

    const refused = limitsWith(() => decision(false)).limits;
    const error = await refused
      .guard({ subject, action: "run" }, work)
      .catch((e) => e);
    expect(error).toBeInstanceOf(LimitReached);
    expect(error).not.toBeInstanceOf(Unavailable);
    expect(error).toMatchObject({
      name: "LimitReached",
      reason: "limit_reached",
      limitId: "lmt_a",
      retryAfterSeconds: 42,
    });
    // The API's sentence, as it is (one wording in every client).
    expect(error.message).toBe("Refused by A.");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("follows the remembered fail mode when Limitry is unreachable", async () => {
    let down = false;
    const { limits } = limitsWith(() =>
      down
        ? new Response("bad gateway", { status: 502 })
        : decision(true, "closed"),
    );
    const work = vi.fn(async () => "ok");
    // Never seen a decision: open.
    const fresh = limitsWith(() => new Response("", { status: 503 })).limits;
    expect(await fresh.guard({ subject, action: "run" }, work)).toBe("ok");
    // Seen one whose limit fails closed: refuse while down.
    await limits.guard({ subject, action: "run" }, work);
    down = true;
    await expect(
      limits.guard({ subject, action: "run" }, work),
    ).rejects.toBeInstanceOf(Unavailable);
  });

  // Every way Limitry may not answer: the limit's fail mode decides —
  // Unavailable when it fails closed, the work runs when it fails open;
  // never LimitReached, which only a decision raises.
  const unreachable: [string, () => Response | Promise<Response>][] = [
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["no answer in time", () => new Promise<Response>(() => {})],
    ["a 500", () => new Response("oops", { status: 500 })],
    [
      "a 402 plan_limit_reached",
      () =>
        Response.json(
          { error: { code: "plan_limit_reached", message: "past the plan" } },
          { status: 402 },
        ),
    ],
    [
      "a 429 from the edge's flood guard",
      () =>
        Response.json(
          { error: { code: "rate_limited", message: "slow down" } },
          { status: 429, headers: { "retry-after": "1" } },
        ),
    ],
  ];
  for (const [what, failure] of unreachable) {
    it(`treats ${what} as unavailable: closed throws Unavailable, open runs`, async () => {
      for (const failMode of ["closed", "open"] as const) {
        let down = false;
        const { limits } = limitsWith(
          () => (down ? failure() : decision(true, failMode)),
          { timeoutMs: 50 },
        );
        await limits.guard({ subject, action: "run" }, async () => 1);
        down = true;
        const work = vi.fn(async () => "ran");
        const outcome = await limits
          .guard({ subject, action: "run" }, work)
          .catch((e: unknown) => e);
        if (failMode === "closed") {
          expect(outcome).toBeInstanceOf(Unavailable);
          expect(outcome).not.toBeInstanceOf(LimitReached);
          expect(work).not.toHaveBeenCalled();
        } else {
          expect(outcome).toBe("ran");
        }
      }
    });
  }

  it("follows the fail mode when the workspace is past its plan", async () => {
    let over = false;
    const { limits } = limitsWith(() =>
      over
        ? Response.json(
            { error: { code: "plan_limit_reached", message: "past the plan" } },
            { status: 402 },
          )
        : decision(true, "closed"),
    );
    await limits.guard({ subject, action: "run" }, async () => 1);
    over = true;
    await expect(
      limits.guard({ subject, action: "run" }, async () => 1),
    ).rejects.toBeInstanceOf(Unavailable);
    // Never seen a closed limit: open, the work runs.
    const fresh = limitsWith(() =>
      Response.json({ error: { code: "plan_limit_reached" } }, { status: 402 }),
    ).limits;
    expect(
      await fresh.guard({ subject, action: "run" }, async () => "ran"),
    ).toBe("ran");
  });

  it("sends one idempotency key per check", async () => {
    const { limits, calls } = limitsWith(() => decision(true));
    await limits.guard({ subject, action: "run" }, async () => "ran");
    await limits.guard({ subject, action: "run" }, async () => "ran");
    expect(calls[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].key).not.toBe(calls[0].key);
  });

  it("treats no answer in time as unreachable", async () => {
    const { limits } = limitsWith(() => new Promise<Response>(() => {}), {
      timeoutMs: 20,
    });
    expect(
      await limits.guard({ subject, action: "run" }, async () => "ran"),
    ).toBe("ran");
  });

  it("reports a caller's mistake instead of hiding it", async () => {
    const { limits } = limitsWith(() =>
      Response.json(
        { error: { code: "invalid_request", message: "bad" } },
        { status: 400 },
      ),
    );
    await expect(
      limits.guard({ subject, action: "" }, async () => 1),
    ).rejects.toThrow(/refused the check \(400\)/);
  });
});

describe("reserve", () => {
  const reserved = () =>
    decision(true, "open", {
      reservation: { id: "rsv_1", expiresAt: "2026-10-05T00:05:00Z" },
    });

  it("commits what the work reported — or the reserved cost", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "committed" }),
    );
    const out = await limits.reserve(
      { subject, action: "chat", cost: 4000 },
      async (reservation) => {
        reservation.cost(1310);
        return "answer";
      },
    );
    expect(out).toBe("answer");
    expect(calls[0].body).toMatchObject({ mode: "reserve", cost: 4000 });
    expect(calls[1]).toMatchObject({
      path: "/reservations/rsv_1/commit",
      body: { cost: 1310 },
    });
    await limits.reserve(
      { subject, action: "chat", cost: 50 },
      async () => "x",
    );
    expect(calls[3]).toMatchObject({
      path: "/reservations/rsv_1/commit",
      body: { cost: 50 },
    });
  });

  it("releases the reservation when the work fails, and rethrows", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "released" }),
    );
    await expect(
      limits.reserve({ subject, action: "chat" }, async () => {
        throw new Error("model down");
      }),
    ).rejects.toThrow("model down");
    expect(calls.map((c) => c.path)).toEqual([
      "/checks",
      "/reservations/rsv_1/release",
    ]);
  });

  it("releases a reservation made by a check that timed out, once the work is done", async () => {
    let checks = 0;
    const { limits, calls } = limitsWith(
      (path) => {
        if (path !== "/checks") return Response.json({});
        // The first answer comes too late; the replay says what it was.
        return ++checks === 1
          ? new Promise<Response>(() => {})
          : decision(true, "open", {
              reservation: {
                id: "rsv_late",
                expiresAt: "2026-10-15T10:00:00Z",
              },
            });
      },
      { timeoutMs: 20 },
    );
    const ran = await limits.reserve(
      { subject, action: "run", cost: 2 },
      async () => "ran unmetered",
    );
    expect(ran).toBe("ran unmetered");
    const asked = calls.filter((c) => c.path === "/checks");
    expect(asked).toHaveLength(2);
    expect(asked[1].key).toBe(asked[0].key);
    expect(asked[1].body).toEqual(asked[0].body);
    expect(calls.at(-1)?.path).toBe("/reservations/rsv_late/release");
  });

  it("extends a reservation for long work", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "held" }),
    );
    await limits.reserve({ subject, action: "export" }, async (reservation) => {
      await reservation.extend(900);
    });
    expect(calls[1]).toMatchObject({
      path: "/reservations/rsv_1/extend",
      body: { ttlSeconds: 900 },
    });
  });

  it("throws the API's error when an extend is refused", async () => {
    const { limits } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json(
            {
              error: {
                code: "invalid_request",
                message: "This reservation has expired",
              },
            },
            { status: 400 },
          ),
    );
    const error = await limits
      .reserve({ subject, action: "export" }, async (reservation) => {
        await reservation.extend(900);
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 400,
      message: "This reservation has expired",
    });
  });

  it("refuses a cost the API would not commit, in the caller's code", async () => {
    for (const bad of [2.5, -1, Number.NaN, 1_000_000_001]) {
      const { limits, calls } = limitsWith((path) =>
        path === "/checks" ? reserved() : Response.json({ id: "rsv_1" }),
      );
      await expect(
        limits.reserve({ subject, action: "chat" }, async (reservation) => {
          reservation.cost(bad);
        }),
      ).rejects.toThrow(RangeError);
      // Never a commit the API would refuse: the reservation is released.
      expect(calls.map((c) => c.path)).toEqual([
        "/checks",
        "/reservations/rsv_1/release",
      ]);
    }
  });
});

describe("standing", () => {
  function limitsAnswering(response: () => Response) {
    const urls: URL[] = [];
    const client = createClient({
      token: "sk_test",
      api: "https://api.example.test",
      fetch: async (request: Request) => {
        urls.push(new URL(request.url));
        return response();
      },
    });
    return { limits: createLimits(client), urls };
  }
  const answer = {
    subject,
    environment: "live",
    limits: [
      {
        limitId: "lmt_a",
        name: "A",
        subject,
        shared: false,
        action: "run",
        unit: "units",
        window: "day",
        rolling: false,
        amount: 10,
        used: 4,
        remaining: 6,
        resetsAt: null,
      },
    ],
  };

  it("asks for one subject and its shared subjects, as kind:id pairs", async () => {
    const { limits, urls } = limitsAnswering(() => Response.json(answer));
    expect(
      await limits.standing({
        subject,
        shared: [
          { kind: "tenant", id: "acme" },
          { kind: "team", id: "t1" },
        ],
      }),
    ).toEqual(answer);
    expect(urls[0].pathname).toBe("/v1/usage/standing");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      subject: "user:u1",
      shared: "tenant:acme,team:t1",
    });
  });

  it("throws on an error answer", async () => {
    const { limits } = limitsAnswering(() =>
      Response.json(
        { error: { code: "not_found", message: "No limit applies" } },
        { status: 404 },
      ),
    );
    await expect(limits.standing({ subject })).rejects.toThrow(/404/);
  });
});

describe("limitry.guard and limitry.reserve", () => {
  it("sit on the client itself", async () => {
    const limitry = createClient({
      token: "sk_test",
      api: "https://api.example.test",
      fetch: async () => decision(true),
    });
    expect(
      await limitry.guard({ subject, action: "run" }, async () => "done"),
    ).toBe("done");
    expect(typeof limitry.reserve).toBe("function");
    expect(typeof limitry.limits.list).toBe("function");
  });
});
