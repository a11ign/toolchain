import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// THE WORKFLOWS RUN `node scripts/<x>.ts` ON GITHUB'S RUNNER, whose Node strips types (22.23.3 on the ubuntu-24.04 image of 2026-09-27, measured
// from the runner-images README; stripping is unflagged from 22.18). The agent host's `/usr/bin/node` is the Ubuntu package and does NOT
// (`process.features.typescript` is false, ADR 0043 Decision 8), so a test that spawns those scripts there needs `tsx` loaded in the child.
// This is the environment to hand `spawn`: empty where Node strips, so the tests run the SAME command line the workflow does wherever they can,
// and an absolute `--import` where they cannot (a tmp-dir cwd has no `node_modules` to resolve `tsx` from).
const NODE_STRIPS_TYPES = Boolean(process.features.typescript);

export const TYPE_STRIPPING_ENV: Record<string, string> = NODE_STRIPS_TYPES
  ? {}
  : { NODE_OPTIONS: `--import ${pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href}` };

// WITHOUT A `package.json` BESIDE IT, tsx reads a `.ts` as CommonJS and the script's own `import` dies with ERR_REQUIRE_CYCLE_MODULE (measured on
// v22.22.1), where Node's stripper detects the module syntax (measured: 22.23.3 runs both scripts from a bare directory, as the sparse checkout
// leaves them). So where Node does not strip, a tool directory the test builds says "module" the way the repository's own `package.json` does.
export function declareModule(toolDir: string): void {
  if (!NODE_STRIPS_TYPES) writeFileSync(join(toolDir, "package.json"), '{ "type": "module" }\n');
}
