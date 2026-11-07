/** A non-2xx response, carrying the API's error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type Envelope = {
  error?: { code?: string; message?: string; requestId?: string };
};

/** Builds the ApiError for a failed result (its envelope, else the HTTP status). */
export function apiErrorFrom(error: unknown, response: Response): ApiError {
  const envelope = (error ?? {}) as Envelope;
  return new ApiError(
    response.status,
    envelope.error?.code ?? "http_error",
    envelope.error?.message ?? `HTTP ${response.status}`,
    envelope.error?.requestId,
  );
}
