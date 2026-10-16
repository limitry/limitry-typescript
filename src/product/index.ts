/**
 * PRODUCT-OWNED: Limitry's SDK helpers (fork-owned seam — docs/conventions.md
 * "Fork-owned seams"): re-exported by the SDK entry and published with
 * it. `guard` / `hold` (docs/product/roadmap.md slice 6) sit on the client
 * (`limitry.guard(…)`, the SDK's `productMethods` seam); `createLimits(client,
 * options)` gives them with your own timeout or fail mode.
 */
import type { BaseClient } from "../index.ts";
import { createLimits } from "./limits.ts";

export {
  createLimits,
  LimitExceeded,
  type GuardRequest,
  type Held,
  type HoldRequest,
  type Limits,
  type LimitsOptions,
} from "./limits.ts";

/** Limitry's methods on the client: `limitry.guard(…)`, `limitry.hold(…)`, `limitry.standing(…)`. */
export const productMethods = (client: BaseClient) => {
  const limits = createLimits(client);
  return { guard: limits.guard, hold: limits.hold, standing: limits.standing };
};
