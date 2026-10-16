import { describe, expect, it } from "vitest";

import { keysFrom, MAX_WAIT_MS, withRetries } from "./retry.ts";

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
