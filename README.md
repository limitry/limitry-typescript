# @limitry/sdk

The Limitry TypeScript SDK puts a limit around costly work in one call: `guard` checks before your code runs, and `reserve` reserves what the work will probably cost, then charges what it actually cost. Every API operation is a typed method too.

Limitry is the limits, credits and budgets layer for the software you build: give each of your users, teams, tenants, API keys or agents an allowance, and before any costly request one call tells your code whether it may happen.

## Install

```bash
npm install @limitry/sdk
```

Set `LIMITRY_API_KEY` to a key from **Settings → Developers** in the
app. Use a test key (`lim_test_…`) while you build. To pass the key
yourself, use `createClient({ apiKey: key })`.

## Charge what it actually cost

Say each of your users has a $2 AI budget a month, counted in cents.
You only know what a reply cost once it's done. `reserve` holds what it
will probably cost (5 cents here), runs your code, then charges what it
actually cost. If your code throws, `reserve` gives the hold back:

```ts
import { createClient } from "@limitry/sdk";

const limitry = createClient(); // reads LIMITRY_API_KEY

const answer = await limitry.reserve(
  { subject: { kind: "user", id: "usr_123" }, action: "ai-call", cost: 5 },
  async (reservation) => {
    const response = await callModel(prompt);
    reservation.cost(priceCents(response.usage)); // your prices, in cents
    return response;
  },
);
```

Each hold counts until it's charged, so two replies at once can't
overspend.

## Guard work that always costs the same

When every request costs the same, `guard` is simpler. It checks the limit,
then runs your code only if it's allowed. Here it counts one request to
your API against a limit of 60 a minute for each key:

```ts
import { createClient, LimitReached } from "@limitry/sdk";

const limitry = createClient(); // reads LIMITRY_API_KEY

try {
  const response = await limitry.guard(
    { subject: { kind: "apikey", id: "key_42" }, action: "api-request" },
    () => handleRequest(request),
  );
} catch (error) {
  if (error instanceof LimitReached) {
    console.log(`Try again in ${error.retryAfterSeconds} seconds`);
  }
}
```

A refusal throws `LimitReached`. If Limitry can't be reached, each
limit's fail mode decides: `open` lets the work run, `closed` throws
`Unavailable`.

## Everything else

Every API operation is a typed method, named like its CLI command:
`limitry limits create` is `limitry.limits.create()`.

```ts
import { createClient } from "@limitry/sdk";

const limitry = createClient();

// "200 cents per user per month for ai-call"
await limitry.limits.create({
  subject: { kind: "user" },
  action: "ai-call",
  amount: 200,
  unit: "cents",
  window: "month",
});
```

A failure throws an `ApiError` with the error's `code`, `message`,
`status` and `requestId`. Writes are retried safely: each sends an
idempotency key, so a retried request happens once.

## Links

- [Website](https://limitry.com)
- [TypeScript SDK guide](https://limitry.com/docs/typescript/)
- [API reference](https://limitry.com/docs/reference/)
- [Changelog](https://github.com/limitry/limitry-typescript/blob/main/CHANGELOG.md)
- [Discord](https://limitry.com/discord)
- [Report a security issue](https://limitry.com/security/)

## Contributing

This repository is generated from Limitry's source on each
release, so pull requests are ported there and credited (see
[CONTRIBUTING.md](https://github.com/limitry/limitry-typescript/blob/main/CONTRIBUTING.md)).

## License

Licensed under the Apache License 2.0.
