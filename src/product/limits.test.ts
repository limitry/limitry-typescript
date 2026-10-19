import { describe, expect, it, vi } from "vitest";

import { createClient } from "../index.ts";
import { createLimits, LimitExceeded } from "./limits.ts";

type Handler = (path: string, body: unknown) => Response | Promise<Response>;

function limitsWith(handler: Handler, options = {}) {
  const calls: { path: string; body: unknown; key: string | null }[] = [];
  const client = createClient({
    token: "sk_test",
    api: "https://api.example.test",
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace(/^\/v1/, "");
      const text = await request.text();
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ path, body, key: request.headers.get("idempotency-key") });
      return handler(path, body);
    },
  });
  return {
    limits: createLimits(client, { timeoutMs: 100, ...options }),
    calls,
  };
}

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
      : { code: "limit_exceeded", limit: "lim_a", message: "Refused by A." },
    remaining: [
      {
        limit: "lim_a",
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

    const denied = limitsWith(() => decision(false)).limits;
    const error = await denied
      .guard({ subject, action: "run" }, work)
      .catch((e) => e);
    expect(error).toBeInstanceOf(LimitExceeded);
    expect(error).toMatchObject({
      reason: "limit_exceeded",
      limit: "lim_a",
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
    ).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

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
    ).rejects.toMatchObject({ reason: "unavailable" });
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

describe("hold", () => {
  const reserved = () =>
    decision(true, "open", {
      reservation: { id: "rsv_1", expiresAt: "2026-10-05T00:05:00Z" },
    });

  it("commits what the work reported — or the estimate", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "committed" }),
    );
    const out = await limits.hold(
      { subject, action: "chat", estimate: 4000 },
      async (held) => {
        held.cost(1310);
        return "answer";
      },
    );
    expect(out).toBe("answer");
    expect(calls[0].body).toMatchObject({ mode: "reserve", cost: 4000 });
    expect(calls[1]).toMatchObject({
      path: "/reservations/rsv_1/commit",
      body: { cost: 1310 },
    });
    await limits.hold(
      { subject, action: "chat", estimate: 50 },
      async () => "x",
    );
    expect(calls[3]).toMatchObject({
      path: "/reservations/rsv_1/commit",
      body: { cost: 50 },
    });
  });

  it("releases the hold when the work fails, and rethrows", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "released" }),
    );
    await expect(
      limits.hold({ subject, action: "chat" }, async () => {
        throw new Error("model down");
      }),
    ).rejects.toThrow("model down");
    expect(calls.map((c) => c.path)).toEqual([
      "/checks",
      "/reservations/rsv_1/release",
    ]);
  });

  it("releases a hold granted to a check that timed out, once the work is done", async () => {
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
    const ran = await limits.hold(
      { subject, action: "run", estimate: 2 },
      async () => "ran unmetered",
    );
    expect(ran).toBe("ran unmetered");
    const asked = calls.filter((c) => c.path === "/checks");
    expect(asked).toHaveLength(2);
    expect(asked[1].key).toBe(asked[0].key);
    expect(asked[1].body).toEqual(asked[0].body);
    expect(calls.at(-1)?.path).toBe("/reservations/rsv_late/release");
  });

  it("extends a hold for long work", async () => {
    const { limits, calls } = limitsWith((path) =>
      path === "/checks"
        ? reserved()
        : Response.json({ id: "rsv_1", status: "held" }),
    );
    await limits.hold({ subject, action: "export" }, async (held) => {
      await held.extend(900);
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
                message: "This hold has expired",
              },
            },
            { status: 400 },
          ),
    );
    const error = await limits
      .hold({ subject, action: "export" }, async (held) => {
        await held.extend(900);
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 400,
      message: "This hold has expired",
    });
  });

  it("refuses a cost the API would not commit, in the caller's code", async () => {
    for (const bad of [2.5, -1, Number.NaN, 1_000_000_001]) {
      const { limits, calls } = limitsWith((path) =>
        path === "/checks" ? reserved() : Response.json({ id: "rsv_1" }),
      );
      await expect(
        limits.hold({ subject, action: "chat" }, async (held) => {
          held.cost(bad);
        }),
      ).rejects.toThrow(RangeError);
      // Never a commit the API would refuse: the hold is released.
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
        limit: "lim_a",
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
      kind: "user",
      id: "u1",
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

describe("limitry.guard and limitry.hold", () => {
  it("sit on the client itself", async () => {
    const limitry = createClient({
      token: "sk_test",
      api: "https://api.example.test",
      fetch: async () => decision(true),
    });
    expect(
      await limitry.guard({ subject, action: "run" }, async () => "done"),
    ).toBe("done");
    expect(typeof limitry.hold).toBe("function");
    expect(typeof limitry.limits.list).toBe("function");
  });
});
