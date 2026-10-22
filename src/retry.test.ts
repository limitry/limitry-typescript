import { describe, expect, it } from "vitest";

import {
  keysFrom,
  MAX_WAIT_MS,
  MOVING_HEADER,
  MOVING_MS,
  JITTER_CAP_MS,
  retryWaitMs,
  withoutMovingHeader,
  withRetries,
} from "./retry.ts";

const noWait = async () => {};

/** A fetch that answers from a script and records what it was sent. */
function scripted(answers: (Response | Error)[]) {
  const sent: { method: string; key: string | null; body: string }[] = [];
  const fetch = async (request: Request) => {
    sent.push({
      method: request.method,
      key: request.headers.get("idempotency-key"),
      body: await request.text(),
    });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, sent };
}

const json = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const post = (init: RequestInit = {}) =>
  new Request("https://api.example.com/v1/things", {
    method: "POST",
    body: JSON.stringify({ name: "x" }),
    ...init,
  });

const moving = () =>
  json(
    503,
    { error: { code: "moving", message: "moving" } },
    { "retry-after": "1" },
  );

describe("withRetries and a subject being handed over (`moving`)", () => {
  it("keeps retrying `moving` with the same key past maxRetries, up to 30 s", async () => {
    const { fetch, sent } = scripted([
      moving(),
      moving(),
      moving(),
      moving(),
      json(200, { allowed: true }),
    ]);
    const slept: number[] = [];
    const response = await withRetries(fetch, {
      maxRetries: 1,
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    })(post());
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(slept).toEqual([1000, 1000, 1000, 1000]);
  });

  it("gives up after 30 s of `moving`", async () => {
    const { fetch, sent } = scripted(Array.from({ length: 40 }, moving));
    const response = await withRetries(fetch, {
      sleep: noWait,
      random: () => 0,
    })(post());
    expect(response.status).toBe(503);
    expect(sent).toHaveLength(MOVING_MS / 1000 + 1);
  });

  it("waits at least a second on `moving`, so a Retry-After of 0 never spins", async () => {
    const zero = () =>
      json(503, { error: { code: "moving" } }, { "retry-after": "0" });
    const { fetch, sent } = scripted(Array.from({ length: 40 }, zero));
    const slept: number[] = [];
    await withRetries(fetch, {
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    })(post());
    expect(sent).toHaveLength(MOVING_MS / 1000 + 1);
    expect(slept.every((ms) => ms === 1000)).toBe(true);
  });

  it("never sends its own header to the API, retries off or on", async () => {
    const seen: (string | null)[] = [];
    const fetch = async (request: Request) => {
      seen.push(request.headers.get(MOVING_HEADER));
      return json(200, {});
    };
    await withoutMovingHeader(fetch)(
      post({ headers: { [MOVING_HEADER]: "return" } }),
    );
    await withRetries(fetch)(post({ headers: { [MOVING_HEADER]: "return" } }));
    expect(seen).toEqual([null, null]);
  });

  it("hands `moving` straight back to a caller that keeps its own budget", async () => {
    const { fetch, sent } = scripted([moving(), json(200, {})]);
    const response = await withRetries(fetch, { sleep: noWait })(
      post({ headers: { [MOVING_HEADER]: "return" } }),
    );
    expect(response.status).toBe(503);
    expect(sent).toHaveLength(1);
  });
});

const busy = (seconds = "2") =>
  json(
    503,
    { error: { code: "busy", message: "busy" } },
    { "retry-after": seconds },
  );

describe("withRetries and an overloaded limiter (`busy`)", () => {
  it("retries `busy` with the same key past maxRetries, waiting Retry-After plus jitter", async () => {
    const { fetch, sent } = scripted([
      busy(),
      busy(),
      busy(),
      json(200, { allowed: true }),
    ]);
    const slept: number[] = [];
    const response = await withRetries(fetch, {
      maxRetries: 0,
      sleep: async (ms) => void slept.push(ms),
      random: () => 0.5,
    })(post());
    expect(response.status).toBe(200);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    // 2 s from Retry-After, plus half of 250, 500, 1000 ms.
    expect(slept).toEqual([2125, 2250, 2500]);
  });

  it("shares the 30 s budget with `moving`, and hands `busy` back to a caller with its own", async () => {
    const mixed = scripted(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? busy("1") : moving())),
    );
    const slept: number[] = [];
    const response = await withRetries(mixed.fetch, {
      sleep: async (ms) => void slept.push(ms),
      random: () => 0.99,
    })(post());
    expect(response.status).toBe(503);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MOVING_MS);
    const own = scripted([busy(), json(200, {})]);
    const back = await withRetries(own.fetch, { sleep: noWait })(
      post({ headers: { [MOVING_HEADER]: "return" } }),
    );
    expect(back.status).toBe(503);
    expect(own.sent).toHaveLength(1);
  });

  it("jitters within [Retry-After, Retry-After + min(cap, 250 × 2^n)), never under a second", () => {
    for (let n = 0; n < 10; n++) {
      const ceiling = Math.min(JITTER_CAP_MS, 250 * 2 ** n);
      expect(retryWaitMs(3_000, n, () => 0)).toBe(3_000);
      expect(retryWaitMs(3_000, n, () => 0.999999)).toBeLessThan(
        3_000 + ceiling,
      );
      expect(retryWaitMs(3_000, n, () => 0.999999)).toBeGreaterThan(
        3_000 + ceiling - 1,
      );
      expect(retryWaitMs(0, n, () => 0)).toBe(1_000);
      expect(retryWaitMs(undefined, n, () => 0)).toBe(1_000);
    }
    // Real randomness stays inside the bounds and spreads out.
    const seen = Array.from({ length: 200 }, () => retryWaitMs(1_000, 3));
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(1_000);
    expect(Math.max(...seen)).toBeLessThan(1_000 + 2_000);
    expect(new Set(seen).size).toBeGreaterThan(100);
  });
});

describe("withRetries", () => {
  it("retries a write with the SAME key, sending the body each time", async () => {
    const { fetch, sent } = scripted([
      json(503, {}),
      new TypeError("fetch failed"),
      json(201, { id: 1 }),
    ]);
    const response = await withRetries(fetch, { sleep: noWait })(post());
    expect(response.status).toBe(201);
    expect(sent).toHaveLength(3);
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(sent.every((s) => s.body === '{"name":"x"}')).toBe(true);
  });

  it("keeps the caller's own key", async () => {
    const { fetch, sent } = scripted([json(500, {}), json(201, {})]);
    await withRetries(fetch, { sleep: noWait })(
      post({ headers: { "idempotency-key": "payment_8231" } }),
    );
    expect(sent.map((s) => s.key)).toEqual(["payment_8231", "payment_8231"]);
  });

  it("waits out a write still in progress, but never a reused key", async () => {
    const busy = json(409, { error: { code: "idempotency_in_progress" } });
    const reused = json(409, { error: { code: "idempotency_key_reused" } });
    const first = scripted([busy, json(201, {})]);
    expect(
      (await withRetries(first.fetch, { sleep: noWait })(post())).status,
    ).toBe(201);
    const second = scripted([reused]);
    expect(
      (await withRetries(second.fetch, { sleep: noWait })(post())).status,
    ).toBe(409);
    expect(second.sent).toHaveLength(1);
  });

  it("follows Retry-After, and hands back one too long to sleep through", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = scripted([json(429, {}, { "retry-after": "3" }), json(200, {})]);
    await withRetries(ok.fetch, { sleep })(post());
    expect(waits).toEqual([3000]);
    const long = scripted([
      json(429, {}, { "retry-after": String(MAX_WAIT_MS / 1000 + 1) }),
    ]);
    expect((await withRetries(long.fetch, { sleep })(post())).status).toBe(429);
  });

  it("stops after maxRetries and gives the last answer", async () => {
    const { fetch, sent } = scripted([
      json(502, {}),
      json(502, {}),
      json(502, {}),
    ]);
    const response = await withRetries(fetch, { sleep: noWait })(post());
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(3);
  });

  it("never retries a request its caller aborted, or a 4xx", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = scripted([new DOMException("aborted", "AbortError")]);
    await expect(
      withRetries(aborted.fetch, { sleep: noWait })(
        post({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(aborted.sent).toHaveLength(1);
    const invalid = scripted([json(400, {})]);
    await withRetries(invalid.fetch, { sleep: noWait })(post());
    expect(invalid.sent).toHaveLength(1);
  });

  it("sends reads without a key, and retries them too", async () => {
    const { fetch, sent } = scripted([json(500, {}), json(200, {})]);
    await withRetries(fetch, { sleep: noWait })(
      new Request("https://api.example.com/v1/things"),
    );
    expect(sent.map((s) => s.key)).toEqual([null, null]);
  });
});

describe("keysFrom", () => {
  it("derives the same keys, write for write, when a call runs again", async () => {
    const run = async () => {
      const key = keysFrom("deploy-42");
      return [
        await key("POST", "/v1/scripts"),
        await key("POST", "/v1/scripts/a/versions"),
        await key("POST", "/v1/scripts/a/versions"),
      ];
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(first[0]).toMatch(/^deploy-42:[0-9a-f]{16}$/);
  });

  it("a skipped write shifts no other write's key", async () => {
    const all = keysFrom("k");
    await all("POST", "/v1/scripts");
    const upload = await all("POST", "/v1/scripts/a/versions");
    const rerun = keysFrom("k");
    expect(await rerun("POST", "/v1/scripts/a/versions")).toBe(upload);
  });

  it("refuses a key that can't be sent, and makes UUIDs without one", async () => {
    expect(() => keysFrom("has space")).toThrow(/printable/);
    expect(() => keysFrom("x".repeat(201))).toThrow(/1–200/);
    const key = keysFrom(undefined);
    expect(await key("POST", "/v1/x")).not.toBe(await key("POST", "/v1/x"));
  });
});
