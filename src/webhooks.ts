/**
 * Verifying a webhook delivery (decided 2026-10-11): `client.webhooks.verify`
 * checks that a request came from us and is recent, then gives you the
 * event. Deliveries are signed Svix-compatibly (packages/jobs/src/webhooks.ts):
 * HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>` with the
 * endpoint's secret (`whsec_<base64 key>`), sent as `webhook-signature:
 * v1,<base64>` (several, space-separated, while a secret rotates). No
 * dependency: Web Crypto, so it runs in Node, Workers, Deno and browsers.
 */

/** The event a delivery carries. */
export type WebhookEvent = {
  /** The event's id (`evt_…`), the same in every delivery of it: dedupe on it. */
  id: string;
  /** What happened, such as `member.joined`. */
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
  [field: string]: unknown;
};

/** A delivery that failed verification: not from us, altered, or too old. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export type VerifyOptions = {
  /** How old a delivery may be, in seconds (default 300). Refuses replays. */
  toleranceSeconds?: number;
  /** The time to check against (tests); default now. */
  now?: Date;
};

type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (Symbol.iterator in (headers as object) && !Array.isArray(headers)) {
    for (const [key, value] of headers as Iterable<[string, string]>) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Equal in constant time (for equal lengths). */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Checks a delivery and returns its event. `body` is the request body
 * exactly as received (the raw text, before any JSON parsing); `headers`
 * the request's headers; `secret` the endpoint's signing secret. Throws
 * WebhookVerificationError when the signature doesn't match or the
 * delivery is older than `toleranceSeconds`.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: HeaderSource,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError(
      "Missing webhook-id, webhook-timestamp or webhook-signature header",
    );
  }
  const sentAt = Number(timestamp);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    !Number.isInteger(sentAt) ||
    Math.abs(now - sentAt) > (options.toleranceSeconds ?? 300)
  ) {
    throw new WebhookVerificationError(
      "The delivery is too old (or its timestamp is invalid)",
    );
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${text}`),
    ),
  );
  const matches = signatures.split(" ").some((part) => {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) return false;
    try {
      return same(fromBase64(value), expected);
    } catch {
      return false;
    }
  });
  if (!matches) {
    throw new WebhookVerificationError("The signature doesn't match");
  }
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("The body isn't JSON");
  }
}
