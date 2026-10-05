// @ts-check
// Run by `packages/guards/src/isolation-gate.mjs` from a throwaway directory OUTSIDE this repository, against the installed tarball.
// Imports by PACKAGE NAME on purpose: a relative import would resolve inside the repo and prove nothing.
//
// Every declared `exports` subpath must import, and the one thing a worker does with this package must work from `node_modules`:
// the config names the alias hook as a path that exists, and that path is a built `.mjs` (Node will not strip types there).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";
import { entriesFromExports } from "@a11ign/toolchain/entries";
import { verdictLine } from "@a11ign/toolchain/verdict-reporter";

// THESE LOAD. The three that do not are below: they import `@rstest/core` or `@rstest/coverage-v8`, whose native binding is an OPTIONAL
// dependency this gate omits on purpose (`--omit=optional`, see `isolation-gate.mjs`), so loading them here fails inside rstest and says
// nothing about this package. The live clean-consumer run (a real install, `rstest run` printing its VERDICT line) is what loads them.
for (const specifier of ["verdict-reporter", "register-node-test-alias", "entries", "rslib-presets", "rstest-config"]) {
  await import(`@a11ign/toolchain/${specifier}`).catch((cause) => { throw new Error(`@a11ign/toolchain/${specifier} does not import`, { cause }); });
}

// THESE RESOLVE to a file that was shipped: the subpath is in `exports` and its target is in the tarball, which is the part `files` can drop silently.
for (const specifier of ["node-test-shim", "merge-child-coverage", "tsconfig.base.json"]) {
  const resolved = import.meta.resolve(`@a11ign/toolchain/${specifier}`);
  assert.ok(existsSync(fileURLToPath(resolved)), `@a11ign/toolchain/${specifier} resolves to ${resolved}, which was not shipped`);
}

const config = defineToolchainConfig({ root: process.cwd(), include: ["src/**/*.test.ts"], run: { env: { RSTEST_NO_AGENT: "1" } } });
const hook = /** @type {{ execArgv?: string[] } | undefined} */ (config.pool)?.execArgv?.[1];
assert.ok(typeof hook === "string" && hook.endsWith("register-node-test-alias.mjs") && existsSync(hook), `the config's hook is not a shipped .mjs: ${hook}`);
assert.match(verdictLine({ results: [{ status: "pass" }], testResults: [{ status: "pass" }] }), /^VERDICT pass: 1 test in 1 file$/);
assert.equal(typeof entriesFromExports, "function");
console.log("@a11ign/toolchain works when installed: 7 entries import, 3 subpaths resolve to shipped files, the config's hook is a shipped .mjs, the verdict line is formed");
