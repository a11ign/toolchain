/**
 * #3603: THE PACKAGE'S OWN TEST. `entryProblems` is "the test a package runs" to prove its hand-written entry map still agrees with
 * its `exports` map (`entries.ts`), and this package had none of its own: its one test lives in
 * `packages/lab/src/packaging/toolchain-package.test.ts`. A diff that touches only this package then reaches no test, and the `ts` job's
 * per-package fallback glob (`packages/toolchain/src/**\/*.test.ts`) matches 0 and refuses the run. This file is that test, under
 * `src/` where `tsconfig.json` already excludes `src/**\/*.test.ts` from the declarations and `files` ships `dist` only.
 *
 * It overlaps the first case of `toolchain-package.test.ts` (the real map is clean) and is kept anyway: that one reads this package
 * from outside, this one pins the package's REAL map from inside it. It imports `./entries.ts` and `node:` modules only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { entriesFromExports, entryProblems, type PackageExports } from "./entries.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(`${PACKAGE}package.json`, "utf8")) as PackageExports;
const entries = entriesFromExports(manifest, { dir: PACKAGE });

test("the package's real exports map and the entries derived from it agree, over a population that is not empty", () => {
  // The positive control for the emptiness below: a map that built nothing would also have no problems.
  assert.ok(Object.keys(entries).length > 0, "the real exports map builds no entry, so 'no problems' would mean 'nothing was asked'");
  assert.deepEqual(entryProblems(manifest, entries), []);
});

test("CONTROL: an exports subpath that no entry builds is reported, naming the subpath", () => {
  const withExtraSubpath: PackageExports = {
    exports: { ...manifest.exports, "./extra": { types: "./dist/extra.d.ts", default: "./dist/extra.mjs" } },
  };
  const problems = entryProblems(withExtraSubpath, entries);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /"\.\/extra" builds "extra", which has no entry/);
});

test("CONTROL: an entry that no exports subpath points at is reported, naming the entry", () => {
  const problems = entryProblems(manifest, { ...entries, orphan: "./src/orphan.ts" });
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /entry "orphan" is built but no exports subpath points at it/);
});

test("the ratchet's subpath is built from src/mjs-ratchet.ts, so the export a consumer's test imports has a source (a11ign/a11ign#4243)", () => {
  assert.equal(entries["mjs-ratchet"], "./src/mjs-ratchet.ts");
});

test("the layout check's subpath is built from src/layout-check.ts, and its bin points at the same built file (a11ign/a11ign#4210)", () => {
  assert.equal(entries["layout-check"], "./src/layout-check.ts");
  const { bin } = manifest as PackageExports & { bin?: Record<string, string> };
  assert.equal(bin?.["layout-check"], "./dist/layout-check.mjs");
});
