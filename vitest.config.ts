import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Each run's own temporary folder, removed after (packages/config/vitest/
// temp-dir.js). Only in the monorepo: this config also ships in the
// package's public mirror, which has no packages/config.
const tempDir = fileURLToPath(
  new URL("../../packages/config/vitest/temp-dir.js", import.meta.url),
);

export default defineConfig({
  test: {
    globalSetup: existsSync(tempDir) ? [tempDir] : [],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
