/**
 * a11ign/a11ign#4586 (epic #4425, phase 3, row 2): THE SEVEN HELPERS THIS PACKAGE PUBLISHES AS `./lib/<stem>` THAT IMPORT THE TEN OF ROW 1
 * (`lib-tier-1.test.ts`). Each names a sibling under `src/lib/` (`./git-env.ts`, `./cli-flags.ts`, `./npm-cli-executable.ts`,
 * `./walk-scope-declaration.ts`) where the core's original reached for `../../../scripts/`, so importing it from source is already a proof
 * the import resolves INSIDE this package. This file is the list of the seven and that proof plus the manifest entry; that each exported
 * subpath is also BUILT is `entries.test.ts`'s, in both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PackageExports } from "./entries.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const LIB = fileURLToPath(new URL("./lib/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${PACKAGE}package.json`, "utf8")) as PackageExports;

const TIER_2 = [
  "changed-files", "changed-packages", "git-sandbox", "local-import-closure", "test-memory-cap", "tree-wide-guard", "walk-scope",
] as const;

test("the list is the seven, each has a source, and the sources under src/lib/ are exactly the subpaths the manifest exports -- both tiers, so a file added there and never exported is published by nobody's decision", () => {
  const sources = readdirSync(LIB).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.replace(/\.ts$/, ""));
  const exported = Object.keys(manifest.exports ?? {}).filter((subpath) => subpath.startsWith("./lib/")).map((subpath) => subpath.slice("./lib/".length));
  assert.equal(TIER_2.length, 7, "positive control: the row names seven");
  assert.ok(TIER_2.every((stem) => sources.includes(stem)), "every one of the seven has a source");
  assert.ok(sources.length > TIER_2.length, "positive control: the tier-1 sources are in the population too");
  assert.deepEqual([...sources].sort(), [...exported].sort());
});

for (const stem of TIER_2) {
  test(`./lib/${stem} is importable from its source and exported by package.json as a built subpath`, async () => {
    const loaded = await import(`./lib/${stem}.ts`);
    assert.ok(Object.keys(loaded).length > 0, `src/lib/${stem}.ts exports nothing, so there is nothing to publish`);
    assert.deepEqual(manifest.exports?.[`./lib/${stem}`], { types: `./dist/lib/${stem}.d.ts`, default: `./dist/lib/${stem}.mjs` });
  });
}
