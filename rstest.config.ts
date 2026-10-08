/**
 * THIS REPOSITORY RUNS ITS OWN TESTS ON ITS OWN CONFIG, the way every consumer does (ADR 0043, Decision 3), so the config is exercised by
 * the thing it configures. It imports the BUILT package, `dist`, and never `src/`: a worker is started with
 * `--import <path to the alias hook>`, the hook is a sibling `.mjs` of the config's own entry, and Node cannot strip types from a `.ts`
 * hook on every host this runs on (`process.versions.amaro` is undefined on the agent host's 22.22.1). `pnpm test` builds first (`pretest`).
 */
import { fileURLToPath } from "node:url";
import { defineToolchainConfig } from "./dist/rstest-config.mjs";

export default defineToolchainConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
});
