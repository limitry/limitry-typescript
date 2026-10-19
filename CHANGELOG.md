# Changelog

What changed in the Limitry TypeScript SDK (`@limitry/sdk`). Generated from the source on each release; newest first.

## 1.0.0-rc.6 (2026-10-19)

### Changed

- `LimitExceeded` says which limit refused, by name, and when to try
  again: "Refused by AI replies per day: 0 replies left, resets
  2026-10-20T00:00:00.000Z. Try again in 60 s." It used to show only the
  limit's id. `error.limit` (`limit` in Python) is still the id.

## 1.0.0-rc.5 (2026-10-16)

### Changed

- The TypeScript SDK's guide is at `/docs/typescript/`, beside `/docs/python/` and `/docs/cli/`.

## 1.0.0-rc.4 (2026-10-16)

### Added

- Each release comes with a `CHANGELOG.md` listing what changed, newest first.

### Changed

- The package page (README, on GitHub, npm and PyPI) shows what the product does with a first real example, and links the guide, the API reference, the changelog and support.

## 1.0.0-rc.3 (2026-10-16)

No user-facing changes.
