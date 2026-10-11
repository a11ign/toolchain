/**
 * a11ign/a11ign#4587 (epic #4425, phase 3, row 3): THE LAST TWO HELPERS THIS PACKAGE PUBLISHES AS `./lib/<stem>`, `isolation-gate` AND `ci-changed`.
 * `ci-changed` imports `changed-files`, `changed-packages` (row 2, `lib-tier-2.test.ts`), `cli-flags`, `git-env` (row 1, `lib-tier-1.test.ts`)
 * and `isolation-gate`; `isolation-gate` imports `git-env`, `cli-flags` and `npm-cli-executable`. Each names a sibling under `src/lib/`, so
 * importing it from source is already a proof the import resolves INSIDE this package. This file is the list of the two and that proof plus the
 * manifest entry; that each exported subpath is also BUILT is `entries.test.ts`'s, in both directions, and that no source under `src/lib/` goes
 * unexported is `lib-tier-2.test.ts`'s, over every tier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PackageExports } from "./entries.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const LIB = fileURLToPath(new URL("./lib/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${PACKAGE}package.json`, "utf8")) as PackageExports;

const TIER_3 = ["ci-changed", "isolation-gate"] as const;

test("the list is the two, and each has a source under src/lib/ alongside the earlier tiers", () => {
  const sources = new Set(readdirSync(LIB).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.replace(/\.ts$/, "")));
  assert.equal(TIER_3.length, 2, "positive control: the row names two");
  assert.ok(sources.size > TIER_3.length, "positive control: the earlier tiers are in the population too");
  assert.deepEqual(TIER_3.filter((stem) => !sources.has(stem)), []);
});

for (const stem of TIER_3) {
  test(`./lib/${stem} is importable from its source and exported by package.json as a built subpath`, async () => {
    const loaded = await import(`./lib/${stem}.ts`);
    assert.ok(Object.keys(loaded).length > 0, `src/lib/${stem}.ts exports nothing, so there is nothing to publish`);
    assert.deepEqual(manifest.exports?.[`./lib/${stem}`], { types: `./dist/lib/${stem}.d.ts`, default: `./dist/lib/${stem}.mjs` });
  });
}

// The core's CI read an `ansible` output until the category was removed from the classifier (#4932): a consumer that still reads one gets an
// absent key, so the removal is pinned on the OUTPUT BLOCK `ci.yml` reads, not on the type.
test("the output block names no `ansible` key, and still names the categories that stay", () => {
  const cli = fileURLToPath(new URL("./lib/ci-changed.ts", import.meta.url));
  const printed = execFileSync(process.execPath, [cli, "--event=merge_group", "--base=HEAD~1", `--repo=${PACKAGE}`], { cwd: PACKAGE, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  const keys = printed.split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("=")));
  assert.ok(keys.includes("python"), `positive control: a category that stays is printed, got ${JSON.stringify(keys)}`);
  assert.ok(keys.includes("ts"), "positive control: ts is printed too");
  assert.deepEqual(keys.filter((key) => /ansible/i.test(key)), []);
});
