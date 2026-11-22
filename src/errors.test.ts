import { brand } from "./brand.ts";
import { describe, expect, it } from "vitest";

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  createClient,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  RateLimitError,
  UnprocessableEntityError,
  WebhookVerificationError,
} from "./index.ts";
// The base class by its product-neutral name: the entry exports it as
// `<Product>Error` (SdkError, LimitryError…), so a test that names
// it would fail in every fork.
import { SdkError } from "./errors.ts";

/** The error tree (./errors.ts), the same as the Python SDK's. */
const failing = (status: number, body: unknown = {}, headers = {}) =>
  createClient({
    token: "sk_x",
    maxRetries: 0,
    fetch: async () => Response.json(body, { status, headers }),
  });

describe("errors", () => {
  it("are one subclass per status, under APIError and the product's base", async () => {
    const cases: [number, typeof APIError][] = [
      [400, BadRequestError],
      [401, AuthenticationError],
      [402, PlanLimitError],
      [403, PermissionDeniedError],
      [404, NotFoundError],
      [409, ConflictError],
      [422, UnprocessableEntityError],
      [429, RateLimitError],
      [500, InternalServerError],
      [503, InternalServerError],
      [418, APIError],
    ];
    for (const [status, ErrorClass] of cases) {
      const error = await failing(status)
        .workspace.get()
        .catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(ErrorClass);
      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(SdkError);
      expect((error as APIError).status).toBe(status);
      expect((error as Error).name).toBe(ErrorClass.name);
    }
    expect(new SdkError("x").name).toBe(
      `${brand.name.charAt(0).toUpperCase()}${brand.name.slice(1)}Error`,
    );
    expect(new WebhookVerificationError("x")).toBeInstanceOf(SdkError);
  });

  it("keep the envelope's details and docs, and the request id", async () => {
    const error = (await failing(400, {
      error: {
        code: "invalid_request",
        message: "Invalid input",
        requestId: "req_1",
        docs: "https://example.com/docs/errors/#invalid_request",
        details: [{ path: "url", message: "Invalid URL" }],
      },
    })
      .workspace.get()
      .catch((e: unknown) => e)) as APIError;
    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Invalid input",
      requestId: "req_1",
      docs: "https://example.com/docs/errors/#invalid_request",
      details: [{ path: "url", message: "Invalid URL" }],
    });
    // No envelope: the status alone, and the X-Request-Id header.
    const bare = (await failing(502, null, { "x-request-id": "req_2" })
      .workspace.get()
      .catch((e: unknown) => e)) as APIError;
    expect(bare).toMatchObject({ code: "http_error", requestId: "req_2" });
  });

  it("turn a network failure into APIConnectionError, keeping the cause", async () => {
    const cause = new TypeError("fetch failed");
    const client = createClient({
      token: "sk_x",
      maxRetries: 0,
      fetch: async () => {
        throw cause;
      },
    });
    const error = await client.workspace.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).not.toBeInstanceOf(APITimeoutError);
    expect((error as Error).cause).toBe(cause);
    // The raw methods too.
    expect(
      await client.GET("/workspace").catch((e: unknown) => e),
    ).toBeInstanceOf(APIConnectionError);
  });

  it("turn attempts that all timed out into APITimeoutError", async () => {
    let attempts = 0;
    const client = createClient({
      token: "sk_x",
      maxRetries: 1,
      timeout: 5,
      fetch: (request) => {
        attempts++;
        return new Promise((_, fail) =>
          request.signal.addEventListener("abort", () =>
            fail(request.signal.reason),
          ),
        );
      },
    });
    const error = await client.workspace.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(((error as Error).cause as Error).name).toBe("TimeoutError");
    expect(attempts).toBe(2);
  });

  it("leave the caller's own abort as it is", async () => {
    const client = createClient({
      token: "sk_x",
      // Never answers; fails as fetch does when its signal aborts.
      fetch: (request) =>
        new Promise((_, fail) => {
          if (request.signal.aborted) fail(request.signal.reason);
          request.signal.addEventListener("abort", () =>
            fail(request.signal.reason),
          );
        }),
    });
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = client.workspace
      .get({ signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    const timedOut = await client.workspace
      .get({ signal: AbortSignal.timeout(5) })
      .catch((e: unknown) => e);
    expect(timedOut).not.toBeInstanceOf(SdkError);
    expect((timedOut as Error).name).toBe("TimeoutError");
  });
});
