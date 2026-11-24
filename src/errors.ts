import { brand } from "./brand.ts";

/**
 * The SDK's errors, one tree (owner, 2026-11-22: as OpenAI's and
 * Anthropic's SDKs; the Python SDK has the same one):
 *
 *   <Product>Error                   the base (PlatformError, LimitryError, …)
 *   ├── APIConnectionError           no answer: the network failed (`cause`)
 *   │   └── APITimeoutError          an attempt timed out, and every retry
 *   ├── APIError                     the API answered with an error
 *   │   ├── BadRequestError          400
 *   │   ├── AuthenticationError      401
 *   │   ├── PlanLimitError           402
 *   │   ├── PermissionDeniedError    403
 *   │   ├── NotFoundError            404
 *   │   ├── ConflictError            409
 *   │   ├── UnprocessableEntityError 422
 *   │   ├── RateLimitError           429
 *   │   └── InternalServerError      500 and above
 *   └── WebhookVerificationError     (./webhooks.ts)
 *
 * Any other status is an APIError itself. The base is exported under
 * the product's own name (./errors.gen.ts, from brand.json), and a
 * product's helpers subclass it for their own errors
 * (`LimitReachedError`): import it from "../errors.ts" as `SdkError`,
 * not from the entry, which imports ./product back. A caller's own
 * abort (their `signal`) is not an SDK error: it throws the signal's
 * reason, unchanged.
 */

/** The product's name for the base class: `platform` → `PlatformError`. */
export const BASE_ERROR_NAME = `${brand.name
  .split(/[-_]/)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join("")}Error`;

/** Every error the SDK throws (exported as `<Product>Error`). */
export class SdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target === SdkError ? BASE_ERROR_NAME : new.target.name;
  }
}

/** No answer from the API: the network failed. The failure is `cause`. */
export class APIConnectionError extends SdkError {
  constructor(options: { message?: string; cause?: unknown } = {}) {
    super(options.message ?? "Could not connect to the API", {
      cause: options.cause,
    });
  }
}

/** An attempt timed out, and so did every retry. */
export class APITimeoutError extends APIConnectionError {
  constructor(options: { cause?: unknown } = {}) {
    super({ message: "The request timed out", cause: options.cause });
  }
}

/** One problem with one field of the request (the envelope's `details`). */
export type ErrorDetail = { path: string; message: string };

export type APIErrorInit = {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  headers?: Headers;
  details?: ErrorDetail[];
  docs?: string;
};

/** The API answered with an error: a non-2xx response and its envelope. */
export class APIError extends SdkError {
  /** The HTTP status code. */
  readonly status: number;
  /** The error's code, to branch on (`not_found`, `rate_limited`, …). */
  readonly code: string;
  /** The request's id: quote it to support. */
  readonly requestId: string | undefined;
  /**
   * The response's headers (Retry-After, Server-Timing, the rate-limit
   * ones): empty when the error was not built from a response.
   */
  readonly headers: Headers;
  /** What is wrong with each field, when the API refused the input. */
  readonly details: ErrorDetail[] | undefined;
  /** A link to the error's entry in the docs. */
  readonly docs: string | undefined;

  constructor(init: APIErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.headers = init.headers ?? new Headers();
    this.details = init.details;
    this.docs = init.docs;
  }
}

/** 400: the request is malformed or a field is invalid (see `details`). */
export class BadRequestError extends APIError {}
/** 401: the credential is missing, wrong, expired or revoked. */
export class AuthenticationError extends APIError {}
/** 402: the plan's limit is reached. */
export class PlanLimitError extends APIError {}
/** 403: the credential may not do this, or its workspace is suspended (`code` is `workspace_suspended`). */
export class PermissionDeniedError extends APIError {}
/** 404: nothing is at this path, or nothing you can see. */
export class NotFoundError extends APIError {}
/** 409: the request conflicts with the current state. */
export class ConflictError extends APIError {}
/** 422: the request is well formed but can't be done. */
export class UnprocessableEntityError extends APIError {}
/** 429: too many requests; `headers` has Retry-After. */
export class RateLimitError extends APIError {}
/** 500 and above: the API failed. */
export class InternalServerError extends APIError {}

const BY_STATUS: Record<number, typeof APIError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: PlanLimitError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

/** The APIError class for a status (any status without one is APIError). */
export function errorClassFor(status: number): typeof APIError {
  return BY_STATUS[status] ?? (status >= 500 ? InternalServerError : APIError);
}

type Envelope = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: ErrorDetail[];
    docs?: string;
  };
};

/**
 * The error for a failed response: from its envelope (`error`, the
 * parsed body, if any), else from the HTTP status alone.
 */
export function apiErrorFrom(error: unknown, response: Response): APIError {
  const envelope =
    error !== null && typeof error === "object" ? (error as Envelope) : {};
  const body = envelope.error ?? {};
  const ErrorClass = errorClassFor(response.status);
  return new ErrorClass({
    status: response.status,
    code: body.code ?? "http_error",
    message: body.message ?? `HTTP ${response.status}`,
    requestId:
      body.requestId ?? response.headers.get("x-request-id") ?? undefined,
    headers: response.headers,
    ...(Array.isArray(body.details) ? { details: body.details } : {}),
    ...(typeof body.docs === "string" ? { docs: body.docs } : {}),
  });
}

/**
 * What a failed `fetch` becomes for the caller: the caller's own abort
 * as it is (the signal's reason), an SDK error as it is, a timed-out
 * attempt APITimeoutError, and anything else APIConnectionError.
 */
export function connectionErrorFrom(
  error: unknown,
  signal: AbortSignal | null | undefined,
): unknown {
  if (signal?.aborted) return signal.reason;
  if (error instanceof SdkError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new APITimeoutError({ cause: error });
  }
  return new APIConnectionError({ cause: error });
}

type Fetch = (request: Request) => Promise<Response>;

/** `fetch` whose failures are the SDK's errors (connectionErrorFrom). */
export function withConnectionErrors(fetch: Fetch): Fetch {
  return async (request) => {
    try {
      return await fetch(request);
    } catch (error) {
      throw connectionErrorFrom(error, request.signal);
    }
  };
}
