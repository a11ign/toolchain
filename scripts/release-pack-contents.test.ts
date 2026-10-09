import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { listedPaths, packRefusals, promisedPaths, type Manifest } from "./release-pack-contents.ts";

// WHAT THIS PINS (a11ign/a11ign#4310): `@a11ign/toolchain@0.1.6` was published with the 4 files below, every `exports` target and the bin pointing into
// a `dist` it did not hold. `packRefusals` is the judgment, run here over listings this file writes in the shape `npm pack --dry-run --json` prints;
// `pnpm run pack-check` runs it over the real one, in CI's `checks` job, which the release waits for.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../package.json")) as Manifest & { scripts: Record<string, string> };

const listing = (paths: string[], before = "") => `${before}${JSON.stringify([{ id: "@a11ign/toolchain@0.1.7", files: paths.map((path) => ({ path, size: 1 })) }], null, 2)}\n`;

const SHIPPED_BY_0_1_6 = ["LICENSE", "README.md", "package.json", "tsconfig.base.json"];
const COMPLETE = [...SHIPPED_BY_0_1_6, ...promisedPaths(manifest), "dist/an-internal-chunk.mjs"];

test("the promised paths are read off the manifest, types and bin included", () => {
  const promised = promisedPaths(manifest);
  for (const path of ["dist/rstest-config.mjs", "dist/rstest-config.d.ts", "dist/layout-check.mjs", "dist/layout-check.d.ts", "tsconfig.base.json"]) {
    assert.ok(promised.includes(path), `${path} is promised`);
  }
  // a bin given as a bare string is read too, and a path is written the way npm writes it, without the leading `./`
  assert.deepEqual(promisedPaths({ bin: "./dist/cli.mjs", exports: { ".": "./dist/index.mjs" } }), ["dist/index.mjs", "dist/cli.mjs"]);
});

test("a tarball holding every exports target and the bin is ACCEPTED", () => {
  assert.deepEqual(packRefusals(listing(COMPLETE), manifest), []);
});

test("a tarball missing dist/rstest-config.mjs is REFUSED, and names it", () => {
  const refused = packRefusals(listing(COMPLETE.filter((path) => path !== "dist/rstest-config.mjs")), manifest);
  assert.deepEqual(refused, ["the tarball is missing dist/rstest-config.mjs, which package.json points at"]);
});

test("a tarball with only the 4 files of 0.1.6 is REFUSED, dist/layout-check.mjs among the paths it names", () => {
  const refused = packRefusals(listing(SHIPPED_BY_0_1_6), manifest);
  assert.ok(refused.includes("the tarball is missing dist/layout-check.mjs, which package.json points at"));
  assert.equal(refused.length, promisedPaths(manifest).length - 1, "every promised path but tsconfig.base.json, which 0.1.6 did ship");
});

test("a tarball missing only the bin is REFUSED", () => {
  const bin = manifest.bin as Record<string, string>;
  assert.equal(bin["layout-check"], "./dist/layout-check.mjs", "positive control: the bin is the file the exports also name");
  const refused = packRefusals(listing(COMPLETE.filter((path) => path !== "dist/layout-check.mjs")), { ...manifest, exports: {} });
  assert.deepEqual(refused, ["the tarball is missing dist/layout-check.mjs, which package.json points at"]);
});

test("an unreadable listing is REFUSED, never accepted", () => {
  const unreadable = [
    "",
    "npm error something went wrong",
    "[]",
    "[{}]",
    '[{"files": "dist"}]',
    '[{"files": [{"path": 3}]}]',
    listing(COMPLETE).slice(0, -20),
  ];
  for (const stdout of unreadable) {
    const refused = packRefusals(stdout, manifest);
    assert.equal(refused.length, 1, `refused once: ${JSON.stringify(stdout.slice(0, 40))}`);
    assert.match(refused[0], /unreadable/);
  }
  assert.deepEqual(packRefusals(listing([]), manifest), ["the pack listing holds no file"]);
});

test("a manifest promising nothing is REFUSED, because nothing could be checked against it", () => {
  assert.equal(packRefusals(listing(COMPLETE), {}).length, 1);
});

test("a listing that a prepack build printed before is read, accepted when whole and refused when not", () => {
  const build = "> @a11ign/toolchain@0.1.7 prepack\n> rslib build\n\n  ready   built in 1.20 s\n[note] not a listing\n";
  assert.deepEqual(listedPaths(listing(COMPLETE, build)), COMPLETE);
  assert.deepEqual(packRefusals(listing(COMPLETE, build), manifest), []);
  assert.equal(packRefusals(listing(SHIPPED_BY_0_1_6, build), manifest).length, promisedPaths(manifest).length - 1);
});

test("package.json packs a built dist: a prepack that runs the build", () => {
  assert.equal(manifest.scripts.prepack, manifest.scripts.build, "a pack builds, so a release commit with no dist ships one");
  assert.equal(manifest.scripts["pack-check"], "tsx scripts/release-pack-contents.ts");
});

test("ci.yml runs pack-check in `checks`, and no step there reads the registry's latest", () => {
  const workflow = parse(read("../.github/workflows/ci.yml")) as { jobs: { checks: { steps: { run?: string }[] } } };
  const runs = workflow.jobs.checks.steps.map((step) => step.run ?? "");
  assert.ok(runs.includes("pnpm run pack-check"), "the release waits for `gate`, which waits for this job");
  assert.deepEqual(runs.filter((run) => run.includes("dlx @a11ign/toolchain")), [], "a green PR must not depend on what the registry's latest happens to hold");
});
