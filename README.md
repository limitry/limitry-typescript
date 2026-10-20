# @limitry/sdk

The Limitry TypeScript SDK puts a limit around costly work in one call: `guard` checks before your code runs, and `reserve` reserves what the work will probably cost, then charges what it actually cost. Every API operation is a typed method too.

Limitry is the limits, credits and budgets layer for your software: give each of your users, teams, tenants, API keys or agents an allowance, and before any costly action one call tells your code whether it may happen.

## Install

```bash
npm install @limitry/sdk
```

Set `LIMITRY_API_KEY` to a key from **API keys** in the app. Use a test
key (`lim_test_…`) while you build.

## Guard costly work

`guard` checks the limit, then runs your code only if it's allowed. Here
it counts one AI call against a limit such as 100 a day:

```ts
import { createClient, LimitReached } from "@limitry/sdk";

const limitry = createClient(); // reads LIMITRY_API_KEY

try {
  const reply = await limitry.guard(
    { subject: { kind: "user", id: "usr_123" }, action: "ai-call" },
    () => callModel(prompt),
  );
} catch (error) {
  if (error instanceof LimitReached) {
    console.log(`Try again in ${error.retryAfterSeconds} seconds`);
  }
}
```

## Charge what it actually cost

When you only know the cost afterwards, such as an AI reply priced by
the token, `reserve` reserves what it will probably cost (5 cents here),
runs your code and charges what it used. If your code throws, the
reservation is released:

```ts
import { createClient } from "@limitry/sdk";

const limitry = createClient();

const answer = await limitry.reserve(
  { subject: { kind: "user", id: "usr_123" }, action: "ai-call", cost: 5 },
  async (reservation) => {
    const response = await callModel(prompt);
    reservation.cost(priceCents(response.usage)); // your prices, in cents
    return response;
  },
);
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

// "100 units per user per day for ai-call"
await limitry.limits.create({
  subject: { kind: "user" },
  action: "ai-call",
  amount: 100,
  window: "day",
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
