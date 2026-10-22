import { brand } from "./brand.ts";
import createOpenApiClient from "openapi-fetch";

import { apiErrorFrom } from "./errors.ts";
import * as product from "./product/index.ts";
import { resources } from "./resources.gen.ts";
import { withoutMovingHeader, withRetries } from "./retry.ts";
import { verifyWebhook } from "./webhooks.ts";
import type { components, paths } from "./v1.gen.ts";

/**
 * The product's API client: openapi-fetch over the types GENERATED from
 * the /v1 routes (./v1.gen.ts — generated, gitignored). Every call is
 * typed by path and method; responses come back as `{ data, error,
 * response }`, or use `unwrap()` to throw an ApiError instead.
 *
 *   const api = createClient({ token: process.env.TOKEN!, workspace: "acme" });
 *   const { data } = await api.GET("/workspace");
 *
 * Without `token`, the key is read from `<NAME>_API_KEY` (API_KEY_ENV)
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
 * pass `api` to point elsewhere.
 *
 * Every write sends an Idempotency-Key (yours, from `{ idempotencyKey }`,
 * else one per call) and a failed attempt — network error, 5xx, 429 —
 * is retried with the same key, twice by default (./retry.ts), so a
 * retried write runs once.
 */
export type { components, paths };
export type Schemas = components["schemas"];
export { ApiError, apiErrorFrom } from "./errors.ts";
export {
  verifyWebhook,
  WebhookVerificationError,
  type VerifyOptions,
  type WebhookEvent,
} from "./webhooks.ts";
export type { Content, RequestOptions } from "./resources.ts";
export { DEFAULT_MAX_RETRIES, keysFrom, withRetries } from "./retry.ts";

/** The variable a missing `token` is read from: <NAME>_API_KEY. */
export const API_KEY_ENV = `${brand.identifier.toUpperCase()}_API_KEY`;

/** The product's API origin (no path): https://api.<domain>. */
export const DEFAULT_API = `https://api.${brand.domain}`;

export type ClientOptions = {
  /**
   * Bearer credential: a Workspace API key or a personal access token.
   * Default: the API_KEY_ENV environment variable, where there is one.
   */
  token?: string;
  /** Workspace slug sent as X-Workspace (personal access tokens only). */
  workspace?: string;
  /** Environment sent as X-Environment (where the product has them; else ignored). */
  environment?: string;
  /** API origin, without /v1 (default: DEFAULT_API). */
  api?: string;
  /** Custom fetch (tests, Workers service bindings). */
  fetch?: (input: Request) => Promise<Response>;
  /**
   * Automatic retries of a failed attempt (network error, 5xx, 429, a
   * write still in progress), each with the call's same Idempotency-Key.
   * Default 2; 0 turns them off.
   */
  maxRetries?: number;
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
  const extend = (
    product as { productMethods?: (client: BaseClient) => object }
  ).productMethods;
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
  const token = options.token ?? keyFromEnvironment();
  if (!token) {
    throw new Error(
      `${brand.productName}: no API key. Pass { token } or set ${API_KEY_ENV}.`,
    );
  }
  const origin = (options.api ?? DEFAULT_API).replace(/\/+$/, "");
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const client = createOpenApiClient<paths>({
    baseUrl: `${origin}/v1`,
    fetch:
      options.maxRetries === 0
        ? withoutMovingHeader(send)
        : withRetries(send, { maxRetries: options.maxRetries }),
  });
  client.use({
    onRequest({ request }) {
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

function keyFromEnvironment(): string | undefined {
  const runtime = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[API_KEY_ENV] || undefined;
}

/** `data` of a successful result; throws ApiError for an error result. */
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
