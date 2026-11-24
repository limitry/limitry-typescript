# Changelog

What changed in the Limitry TypeScript SDK (`@limitry/sdk`). Generated from the source on each release; newest first.

## 1.0.0-rc.21 (2026-11-24)

No user-facing changes.

## 1.0.0-rc.20 (2026-11-24)

### Added

- You can now top up a limit that resets, such as a monthly one. Add credits to it as you would to a balance, and they go to the subject's current period. They end when that period resets, and `periodEnd` on the credit says when. What the subject already used still counts: 4,800 used of 5,000, plus a 5,000 top-up, leaves 5,200. In a subject's standing, the new `credited` field says how much this period was topped up. In the app, a limit's ⋮ menu now offers Credits on limits that reset too.

## 1.0.0-rc.19 (2026-11-22)

No user-facing changes.

## 1.0.0-rc.18 (2026-11-22)

### Added

- Every Python SDK method now takes `timeout=` in seconds, for example
  `client.workspace.get(timeout=5)`. It limits each attempt, and a
  timed-out attempt is retried with the same idempotency key. For several
  calls, `client.with_options(timeout=5, max_retries=0)` gives the same
  client with other settings.

  To limit a whole async call, retries included, wrap it in
  `asyncio.timeout()`. The call stops at once, even while it waits to
  retry.

  An `APIError` now carries the response's `headers`, so you can read
  `Retry-After` and the rate-limit headers when a call fails.

### Changed

- The TypeScript SDK's errors are now a class per kind of failure. When
  the API refuses a call, it throws an `APIError` subclass for the
  status, such as `NotFoundError` or `RateLimitError`. Each one carries
  `details`, what is wrong with each field, and `docs`, a link to the
  error. When the API can't be reached, it throws an
  `APIConnectionError`, or an `APITimeoutError` when every attempt timed
  out. Every error the SDK throws shares one base class, named after the
  product. `ApiError` is now `APIError`.

  A list method can now page for you. `await` it for the first page,
  with `hasNextPage()` and `getNextPage()`. Use `for await` to go through
  every item of every page.

  `createClient` takes `baseURL` instead of `api`, and reads
  `<NAME>_BASE_URL` when you don't pass it. It also takes
  `defaultHeaders`, sent with every request. Outside a browser, requests
  name the SDK in their `User-Agent`.

  When the API asks the SDK to wait before retrying, it now waits up to
  60 seconds, up from 20.
- The API, both SDKs and the CLI now each follow their own language's conventions, so some names and paths changed.

  In the API:

  - `GET /v1/checks` lists recent checks and takes `before`. It replaces `GET /v1/checks/recent`.
  - `GET /v1/subjects/{kind}/{id}/standing` shows where a subject stands. It replaces `GET /v1/usage/standing`.
  - `PATCH /v1/subjects/{kind}/{id}` sets a subject's billing date, name and labels. `DELETE /v1/subjects/{kind}/{id}/names` erases the name and labels, and answers `204`.
  - A check's decision has no `id`. Its limits name themselves in `limitName`, its `reason` is `{ code, limitId, limitName, subject, message }`, and `reservation` is `null` when there is none.
  - A recent check's time is `checkedAt`, and `refusedBy` names the limit and the subject.
  - A subject's billing date is `billingAnchorAt`, and a period's start is `periodStart`, in reports and in the `limit.reached` and `limit.threshold_crossed` webhooks. Those webhooks name the limit in `limitName`.
  - `GET /v1/usage/subjects` takes `top` and answers `subjects`.
  - A sync takes and answers `dryRun` in place of `preview`.
  - Archiving a limit answers `200` with the limit.
  - A clash with a resource's state answers `409` with the code `conflict`, such as a name that is taken or a limit a sync set. A check that Limitry can't answer right now gets `503` with the code `unavailable` and a `Retry-After` header.

  In the TypeScript SDK:

  - `guard` and `reserve` throw `LimitReachedError` when refused, and `UnavailableError` when Limitry gave no answer and a limit fails closed. Its `reason` says why. Both are `LimitryError`s.
  - `createLimits` takes `timeout`, in milliseconds, in place of `timeoutMs`.
  - Each `guard` or `reserve` call also takes `timeout`, `failMode`, `signal` and `idempotencyKey`. A signal stops the check at once, and the work doesn't run.

  In the Python SDK:

  - `guard` and `reserve` raise `LimitReachedError` and `UnavailableError`, under `LimitryError`.
  - They take `timeout=` (in seconds), `fail_mode=`, `idempotency_key=` and `extra_headers=`.
  - You set what the work used with `reservation.cost = 7`.
  - Cancelling an async `guard` or `reserve` stops its check at once.

  In the CLI:

  - `limitry sync --dry-run` replaces `--preview`, and `limitry sync -` reads the file from standard input.
  - A refused `limitry check` exits with code `5`.
  - `limitry subjects standing <kind> <id>` replaces `limitry usage standing`, and `limitry checks list` replaces `limitry checks recent`.
  - `limitry subjects update <kind> <id>` sets a name and labels, and `limitry subjects names delete <kind> <id>` erases them.

  The audit log's Limitry actions are dotted too, such as `subject.billing_date.set` and `limits.copied`. Earlier entries show the new names.
- A TypeScript SDK call's `timeout` now limits each attempt, as in other
  API SDKs, and defaults to 60 seconds. A timed-out attempt is retried
  with the same idempotency key. To limit a whole call, retries included,
  pass `signal: AbortSignal.timeout(ms)`.

## 1.0.0-rc.17 (2026-11-22)

### Added

- Limitry is here: limits, credits and budgets for the software you
  build.

  Before each costly request, your code asks whether this user, team, API
  key or agent may go ahead. Limitry answers yes or no. Two requests at
  once can't overspend.

  Everything happens in your code. Create and change limits, subjects and
  credits through the `/v1` API, the TypeScript and Python SDKs or the
  CLI. A check is one call, `limitry.checks.create()`, and its `allowed`
  is the answer.

  Webhooks let your code react. `limit.reached` arrives when a limit
  first refuses one of your users. `limit.threshold_crossed` arrives when
  one of them passes 80% or 100% of a limit, or when a balance of credits
  runs low.

  The app is where you see it all and try a check. With the MCP server,
  Claude and ChatGPT, or Claude Code and Codex, can work in your
  workspace with the access you give them. Your team also hears about
  refusals in the app, by email or on their phone.
- A refused check now says whose limit refused it. `reason.subject` names
  the check's own subject, or the shared subject whose limit said no, such
  as a team's budget, and `reason.message` names it too. On the Usage
  page, a user's row says when a shared budget refused their checks.
  Busiest now counts every subject a check names, so a busy team or
  organization pool shows there.
- Every TypeScript SDK call now takes a `timeout` in milliseconds and a
  `signal`, for example `client.limits.list({}, { timeout: 2000 })`. The
  timeout limits each attempt, and a timed-out attempt is retried with the
  same idempotency key. Past its last retry, the call throws an
  `APITimeoutError`. To set one for every call, pass `timeout` to
  `createClient`.

  To limit a whole call, retries included, pass a `signal` such as
  `AbortSignal.timeout(5000)`. The call stops at once, even while it waits
  to retry.

  An `APIError` now carries the response's `headers`, so you can read
  `Retry-After` and the rate-limit headers when a call fails.
- Subjects can now have an optional name and labels. Set them with
  `PATCH /v1/subjects/{subjectKind}/{subjectId}` (`limitry subjects
  update`), or name up to 1,000 at once with `POST /v1/subjects/import`.
  `DELETE /v1/subjects/{subjectKind}/{subjectId}/names` erases them. Checks never need them,
  and every limit works with IDs alone.

  `GET /v1/subjects` lists and searches subjects (`limitry subjects
  list`). `GET /v1/subjects/{subjectKind}/{subjectId}` now also returns a subject's
  budgets and the subjects it's checked with, with what was spent within
  each budget. `GET /v1/checks` lists the last 3 days' checks
  (`limitry checks list`).

  In the app, the new **Who** page lists every subject your checks name,
  with filters and search. Each subject has its own page: its budgets,
  the subjects it's checked with and what was spent within each budget,
  and its recent checks. The Usage page lists **Recent checks** from the
  last 3 days. On **Settings → General**, the **Kinds** card names your
  kinds and puts them in order, so a subject's page shows who is above
  and below it.

  `limitry.json` can list your kinds too, in an optional `kinds` block that
  `limitry sync` applies. Subject names stay out of the file.

  What `limitry.json` sets is now locked in the app and the API, and says
  so: its limits, and its kinds when it has them. An owner or admin can
  override one until the next sync, with a reason the audit log keeps.
  The next sync puts the file's values back, `limitry sync --dry-run`
  lists those overrides, and whoever made one gets a notification.

### Changed

- A limit a sync sets now says where it came from. `limits.sync` takes an
  optional `source`, such as `"Billing deploy"`, and the limit's page,
  the 409 and the audit log name it, as in **Set by Billing deploy**.
  `limitry sync` sends the file's name, or the label you pass with
  `--source`. A sync with no source reads **Set by a sync**, where it
  used to say `limitry.json` every time. The **Kinds** card names the
  source the same way.

  `limitry sync` now also sends the file's `kinds`.

## 1.0.0-rc.16 (2026-11-17)

No user-facing changes.

## 1.0.0-rc.15 (2026-11-14)

No user-facing changes.

## 1.0.0-rc.14 (2026-11-09)

No user-facing changes.

## 1.0.0-rc.13 (2026-11-07)

No user-facing changes.

## 1.0.0-rc.12 (2026-11-07)

No user-facing changes.

## 1.0.0-rc.11 (2026-10-27)

No user-facing changes.

## 1.0.0-rc.10 (2026-10-27)

No user-facing changes.

## 1.0.0-rc.9 (2026-10-22)

No user-facing changes.

## 1.0.0-rc.8 (2026-10-21)

No user-facing changes.

## 1.0.0-rc.7 (2026-10-19)

No user-facing changes.

## 1.0.0-rc.6 (2026-10-19)

No user-facing changes.

## 1.0.0-rc.5 (2026-10-16)

No user-facing changes.

## 1.0.0-rc.4 (2026-10-16)

No user-facing changes.

## 1.0.0-rc.3 (2026-10-16)

No user-facing changes.
