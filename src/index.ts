import { brand } from "./brand.ts";
import createOpenApiClient from "openapi-fetch";

import { apiErrorFrom, withConnectionErrors } from "./errors.ts";
import * as product from "./product/index.ts";
import { resources } from "./resources.gen.ts";
import {
  DEFAULT_TIMEOUT_MS,
  withAttemptTimeout,
  withoutProductRetryHeader,
  withRetries,
} from "./retry.ts";
import { VERSION } from "./version.ts";
import { verifyWebhook } from "./webhooks.ts";
import type { components, paths } from "./v1.gen.ts";

/**
 * The product's API client: openapi-fetch over the types GENERATED from
 * the /v1 routes (./v1.gen.ts — generated, gitignored). Every call is
 * typed by path and method; responses come back as `{ data, error,
 * response }`, or use `unwrap()` to throw an APIError instead.
 *
 *   const api = createClient({ apiKey: process.env.KEY! });
 *   const { data } = await api.GET("/workspace");
 *
 * Two options, one per kind of credential (owner, 2026-11-06, as
 * Anthropic's SDK has `apiKey` and `authToken`): `apiKey` for a Workspace
 * API key, `token` for a personal access token (with `workspace`). Both
 * send the same header, so `token` still takes a key, as it always has.
 * Without either, the credential is read from `<NAME>_API_KEY`
 * (API_KEY_ENV), else `<NAME>_TOKEN` (TOKEN_ENV, the CLI's variable),
 * where `process.env` exists (Node, Bun, Deno); elsewhere — a browser, a
 * Worker, whose secrets arrive on `env` — pass it. Decided 2026-10-11:
 * one line fewer for most customers, as OpenAI's SDK does.
 *
 * Authentication is `Authorization: Bearer <token>` — a Workspace API
 * key, or a personal access token plus `X-Workspace: <slug>` on workspace
 * routes (docs/architecture.md "Public API"). Where the product has
 * environments, `environment` names the one to act in (`X-Environment`;
 * a key bound to one always acts in its own) — without it, the product's
 * default. The default origin is the product's API host per brand.json;
 * pass `baseURL` (or set `<NAME>_BASE_URL`, BASE_URL_ENV) to point
 * elsewhere, and `defaultHeaders` to send more headers on every call.
 * Outside a browser, every request names the SDK in its User-Agent
 * (`<name>-node/<version>`).
 *
 * Every write sends an Idempotency-Key (yours, from `{ idempotencyKey }`,
 * else one per call) and a failed attempt — network error, 5xx, 429 —
 * is retried with the same key, twice by default (./retry.ts), so a
 * retried write runs once. A `timeout` (the client's, or a call's) limits
 * each attempt; a call's `signal` ends the whole call, waits included.
 *
 * Failures are the SDK's errors (./errors.ts): an APIError subclass per
 * status when the API answered, APIConnectionError (APITimeoutError)
 * when it didn't. A list returns a PagePromise (./pagination.ts).
 */
export type { components, paths };
export type Schemas = components["schemas"];
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  RateLimitError,
  UnprocessableEntityError,
  apiErrorFrom,
  connectionErrorFrom,
  errorClassFor,
  withConnectionErrors,
  type APIErrorInit,
  type ErrorDetail,
} from "./errors.ts";
// The base error, under the product's name (PlatformError, LimitryError…).
export * from "./errors.gen.ts";
export { Page, PagePromise, type PageBody } from "./pagination.ts";
export { VERSION } from "./version.ts";
export {
  verifyWebhook,
  WebhookVerificationError,
  type VerifyOptions,
  type WebhookEvent,
} from "./webhooks.ts";
export type { Content, RequestOptions } from "./resources.ts";
export { DEFAULT_MAX_RETRIES, keysFrom, withRetries } from "./retry.ts";

/** The variable read first when neither `apiKey` nor `token` is passed: <NAME>_API_KEY. */
export const API_KEY_ENV = `${brand.identifier.toUpperCase()}_API_KEY`;

/** The variable read next, the CLI's personal access token: <NAME>_TOKEN. */
export const TOKEN_ENV = `${brand.identifier.toUpperCase()}_TOKEN`;

/** The variable read when `baseURL` is not passed: <NAME>_BASE_URL. */
export const BASE_URL_ENV = `${brand.identifier.toUpperCase()}_BASE_URL`;

/** The product's API origin (no path): https://api.<domain>. */
export const DEFAULT_BASE_URL = `https://api.${brand.domain}`;

export type ClientOptions = {
  /**
   * A Workspace API key. Default: the API_KEY_ENV environment variable,
   * else TOKEN_ENV, where there are environment variables.
   */
  apiKey?: string;
  /**
   * A personal access token (name the workspace with `workspace`). It
   * also takes an API key, as it did before `apiKey`. Pass one of the two.
   */
  token?: string;
  /** Workspace slug sent as X-Workspace (personal access tokens only). */
  workspace?: string;
  /** Environment sent as X-Environment (where the product has them; else ignored). */
  environment?: string;
  /**
   * The API's origin, without /v1. Default: the BASE_URL_ENV environment
   * variable where there is one, else DEFAULT_BASE_URL.
   */
  baseURL?: string;
  /** Headers sent with every request (a call's own `headers` win). */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch (tests, Workers service bindings). */
  fetch?: (input: Request) => Promise<Response>;
  /**
   * Automatic retries of a failed attempt (network error, 5xx, 429, a
   * write still in progress), each with the call's same Idempotency-Key.
   * Default 2; 0 turns them off.
   */
  maxRetries?: number;
  /**
   * Each attempt's limit, in milliseconds (default 60 000); a timed-out
   * attempt is retried with the same key. A call's own `timeout` takes
   * its place; to limit a whole call, pass it a `signal`
   * (`AbortSignal.timeout(ms)`).
   */
  timeout?: number;
};

/** The client before a product's own methods: raw calls plus the generated ones. */
export type BaseClient = ReturnType<typeof createBaseClient>;

/**
 * A product's own methods on the client (./product/index.ts may export
 * `productMethods(client: BaseClient)`; decided 2026-10-11): its hero
 * helpers sit beside the generated ones — `limitry.guard(…)`,
 * `reminix.run(…)` — instead of a second object to create.
 */
type ProductMethods = typeof product extends {
  productMethods: (client: never) => infer M;
}
  ? M
  : unknown;

export function createClient(
  options: ClientOptions = {},
): BaseClient & ProductMethods {
  const client = createBaseClient(options);
  // Reflect.get: the seam may not export it, and the bundler would warn.
  const extend = Reflect.get(product, "productMethods") as
    ((client: BaseClient) => object) | undefined;
  if (!extend) return client as BaseClient & ProductMethods;
  const methods = extend(client);
  for (const name of Object.keys(methods)) {
    if (name in client) {
      throw new Error(`productMethods: "${name}" is already a client method`);
    }
  }
  return Object.assign(client, methods) as BaseClient & ProductMethods;
}

function createBaseClient(options: ClientOptions) {
  if (options.apiKey && options.token) {
    throw new Error(`${brand.productName}: pass apiKey or token, not both.`);
  }
  const token = options.apiKey || options.token || credentialFromEnvironment();
  if (!token) {
    throw new Error(
      `${brand.productName}: no API key. Pass { apiKey } or set ${API_KEY_ENV}.`,
    );
  }
  const origin = withoutTrailingSlashes(
    options.baseURL || environment()?.[BASE_URL_ENV] || DEFAULT_BASE_URL,
  );
  const send = withAttemptTimeout(
    options.fetch ?? ((request: Request) => fetch(request)),
    options.timeout ?? DEFAULT_TIMEOUT_MS,
  );
  const sending =
    options.maxRetries === 0
      ? withoutProductRetryHeader(send)
      : withRetries(send, { maxRetries: options.maxRetries });
  const client = createOpenApiClient<paths>({
    baseUrl: `${origin}/v1`,
    fetch: withConnectionErrors(sending),
  });
  client.use({
    onRequest({ request }) {
      for (const [name, value] of Object.entries(
        options.defaultHeaders ?? {},
      )) {
        if (!request.headers.has(name)) request.headers.set(name, value);
      }
      // A browser sends its own User-Agent (and would need CORS for ours).
      if (!("document" in globalThis) && !request.headers.has("user-agent")) {
        request.headers.set("user-agent", USER_AGENT);
      }
      request.headers.set("authorization", `Bearer ${token}`);
      if (options.workspace && !request.headers.has("x-workspace")) {
        request.headers.set("x-workspace", options.workspace);
      }
      if (options.environment && !request.headers.has("x-environment")) {
        request.headers.set("x-environment", options.environment);
      }
      return request;
    },
  });
  // A method per operation, named as the CLI names it (./resources.gen.ts):
  // `limits list` → client.limits.list(). The raw GET/POST/… stay.
  // `webhooks.verify` checks a delivery you received (./webhooks.ts); it
  // calls nothing, so it's also exported on its own as verifyWebhook.
  return Object.assign(client, resources(client), {
    webhooks: { verify: verifyWebhook },
  });
}

export type Client = ReturnType<typeof createClient>;

/** The SDK's User-Agent: `<name>-node/<version>`. */
export const USER_AGENT = `${brand.name}-node/${VERSION}`;

/** `process.env`, where the runtime has one (Node, Bun, Deno). */
function environment(): Record<string, string | undefined> | undefined {
  const runtime = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env;
}

function credentialFromEnvironment(): string | undefined {
  const env = environment();
  return env?.[API_KEY_ENV] || env?.[TOKEN_ENV] || undefined;
}

/** `data` of a successful result; throws an APIError for an error result. */
export function unwrap<
  T extends { data?: unknown; error?: unknown; response: Response },
>(result: T): NonNullable<T["data"]> {
  if (result.error !== undefined || !result.response.ok) {
    throw apiErrorFrom(result.error, result.response);
  }
  return result.data as NonNullable<T["data"]>;
}

// The product's own helpers (fork-owned seam: ./product/).
export * from "./product/index.ts";

/** `url` without trailing slashes — a loop, not a regex (CodeQL js/polynomial-redos). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}
