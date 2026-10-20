/**
 * PRODUCT-OWNED: Limitry's SDK helpers (fork-owned seam — docs/conventions.md
 * "Fork-owned seams"): re-exported by the SDK entry and published with
 * it. `guard` / `reserve` (docs/product/roadmap.md slice 6) sit on the client
 * (`limitry.guard(…)`, the SDK's `productMethods` seam); `createLimits(client,
 * options)` gives them with your own timeout or fail mode.
 */
import type { BaseClient } from "../index.ts";
import { createLimits } from "./limits.ts";

export {
  createLimits,
  LimitReached,
  Unavailable,
  type GuardRequest,
  type Limits,
  type LimitsOptions,
  type Reservation,
  type ReserveRequest,
} from "./limits.ts";

/** Limitry's methods on the client: `limitry.guard(…)`, `limitry.reserve(…)`, `limitry.standing(…)`. */
export const productMethods = (client: BaseClient) => {
  const limits = createLimits(client);
  return {
    guard: limits.guard,
    reserve: limits.reserve,
    standing: limits.standing,
  };
};
