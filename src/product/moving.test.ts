import { describe, expect, it } from "vitest";

import { PRODUCT_RETRY_HEADER, withRetries } from "../retry.ts";
import { productRetry } from "./index.ts";
import {
  JITTER_CAP_MS,
  MOVING_MS,
  movingRetry,
  retryWaitMs,
} from "./moving.ts";

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
      product: movingRetry(() => 0),
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
      product: movingRetry(() => 0),
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
      product: movingRetry(() => 0),
    })(post());
    expect(sent).toHaveLength(MOVING_MS / 1000 + 1);
    expect(slept.every((ms) => ms === 1000)).toBe(true);
  });

  it("never sends the header to the API", async () => {
    const seen: (string | null)[] = [];
    const fetch = async (request: Request) => {
      seen.push(request.headers.get(PRODUCT_RETRY_HEADER));
      return json(200, {});
    };
    await withRetries(fetch)(
      post({ headers: { [PRODUCT_RETRY_HEADER]: "return" } }),
    );
    expect(seen).toEqual([null]);
  });

  it("hands `moving` straight back to a caller that keeps its own budget", async () => {
    const { fetch, sent } = scripted([moving(), json(200, {})]);
    const response = await withRetries(fetch, { sleep: noWait })(
      post({ headers: { [PRODUCT_RETRY_HEADER]: "return" } }),
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
      product: movingRetry(() => 0.5),
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
      product: movingRetry(() => 0.99),
    })(post());
    expect(response.status).toBe(503);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MOVING_MS);
    const own = scripted([busy(), json(200, {})]);
    const back = await withRetries(own.fetch, { sleep: noWait })(
      post({ headers: { [PRODUCT_RETRY_HEADER]: "return" } }),
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

describe("productRetry", () => {
  it("is what every client retries: `moving` and `busy`, for up to 30 s", async () => {
    expect(productRetry.budgetMs).toBe(MOVING_MS);
    expect(
      await productRetry.wait(json(503, { error: { code: "busy" } }), 0),
    ).toBeGreaterThanOrEqual(1_000);
    expect(
      await productRetry.wait(json(503, { error: { code: "other" } }), 0),
    ).toBeNull();
    expect(await productRetry.wait(json(500, {}), 0)).toBeNull();
  });
});
