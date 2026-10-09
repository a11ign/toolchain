/**
 * a11ign/a11ign#4585 (epic #4425, phase 3, row 1): THE TEN LEAF HELPERS THIS PACKAGE PUBLISHES AS `./lib/<stem>`. A leaf is a helper with no
 * local import among the copies a consumer carries today, so a consumer can take it at a declared version instead of copying it. This file
 * is the list of the ten and the proof that each is IMPORTABLE from its source and EXPORTED by the manifest; that each exported subpath is
 * also BUILT (and each built entry exported) is `entries.test.ts`'s, in both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PackageExports } from "./entries.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const LIB = fileURLToPath(new URL("./lib/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${PACKAGE}package.json`, "utf8")) as PackageExports;

const TIER_1 = [
  "cli-flags", "fixture-symbols", "git-env", "npm-cli-executable", "product-home",
  "sandbox-exhaustion", "source-text", "walk-scope-declaration", "walk-scope-discovery", "worktree-resolution",
] as const;

test("the list is the ten, and it is every source under src/lib/ -- a file added there and not listed here is published by nobody's decision", () => {
  const sources = readdirSync(LIB).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.replace(/\.ts$/, ""));
  assert.equal(TIER_1.length, 10, "positive control: the row names ten");
  assert.deepEqual([...sources].sort(), [...TIER_1].sort());
});

for (const stem of TIER_1) {
  test(`./lib/${stem} is importable from its source and exported by package.json as a built subpath`, async () => {
    const loaded = await import(`./lib/${stem}.ts`);
    assert.ok(Object.keys(loaded).length > 0, `src/lib/${stem}.ts exports nothing, so there is nothing to publish`);
    assert.deepEqual(manifest.exports?.[`./lib/${stem}`], { types: `./dist/lib/${stem}.d.ts`, default: `./dist/lib/${stem}.mjs` });
  });
}
