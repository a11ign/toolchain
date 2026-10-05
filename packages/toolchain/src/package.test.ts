/**
 * WHAT THE PACKAGE PROMISES A CONSUMER, read from its own manifest and its own build (ADR 0043, Decisions 3 and 4; a11ign/a11ign#3578).
 * `problemsOf` is the rule, and each case below runs it on a manifest that breaks ONE promise, so a rule that never fires is red here.
 * The files a worker loads by path are built entries because Node refuses to strip types under `node_modules`; `pnpm test` builds
 * first (`pretest`), so the `dist` read at the bottom is the build of this tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExportTarget } from "./entries.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
/** `tsconfig` files are JSONC: whole-line `//` comments are dropped before parsing (the base's header is one, and has no `//` inside a string). */
const readJson = (name: string) => JSON.parse(readFileSync(`${PACKAGE}${name}`, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;

type Manifest = { license?: string; files?: string[]; exports?: Record<string, ExportTarget>; repository?: { url?: string }; version?: string };

const WORKER_LOADED = ["register-node-test-alias", "node-test-shim"];

/** Everything wrong with a manifest, as sentences: empty is agreement. */
function problemsOf(manifest: Manifest): string[] {
  const problems: string[] = [];
  if (manifest.license !== "Apache-2.0") problems.push(`license is ${manifest.license}, not Apache-2.0`);
  if (manifest.files?.some((file) => file === "src" || file.startsWith("src/"))) problems.push("`files` ships src/, which a published package must not");
  for (const name of WORKER_LOADED) {
    if (manifest.exports?.[`./${name}`] === undefined) problems.push(`exports has no ./${name}, which a worker loads by path`);
  }
  if (!manifest.repository?.url?.includes("a11ign/toolchain")) problems.push("repository is not a11ign/toolchain, which npm provenance checks against the trusted publisher");
  return problems;
}

const manifest = readJson("package.json") as Manifest;

test("the real manifest keeps every promise", () => {
  assert.ok(Object.keys(manifest.exports ?? {}).length > 0, "positive control: the manifest exports something, so 'no problems' is not 'nothing was read'");
  assert.deepEqual(problemsOf(manifest), []);
});

test("CONTROL: each promise, broken alone, is named", () => {
  assert.match(problemsOf({ ...manifest, license: "AGPL-3.0-or-later" }).join(), /not Apache-2.0/);
  assert.match(problemsOf({ ...manifest, files: ["dist", "src"] }).join(), /ships src\//);
  const withoutShim = Object.fromEntries(Object.entries(manifest.exports ?? {}).filter(([subpath]) => subpath !== "./node-test-shim"));
  assert.match(problemsOf({ ...manifest, exports: withoutShim }).join(), /no \.\/node-test-shim/);
  assert.match(problemsOf({ ...manifest, repository: { url: "git+https://github.com/a11ign/a11ign.git" } }).join(), /not a11ign\/toolchain/);
});

test("the package's LICENSE file is the Apache one the manifest names", () => {
  assert.match(readFileSync(`${PACKAGE}LICENSE`, "utf8"), /Apache License\s+Version 2\.0/);
});

test("the shared tsconfig base turns the maps off and carries nothing only a project-references build needs", () => {
  const { compilerOptions } = readJson("tsconfig.base.json") as { compilerOptions: Record<string, unknown> };
  assert.equal(compilerOptions.declarationMap, false);
  assert.equal(compilerOptions.sourceMap, false);
  for (const key of ["composite", "outDir", "rootDir"]) assert.ok(!(key in compilerOptions), `the base carries ${key}`);
  assert.equal(compilerOptions.strict, true, "positive control: the base is the one that was read");
});

test("every exports target that names a built file exists in dist, the types file included", () => {
  const targets = Object.values(manifest.exports ?? {}).flatMap((target) => (typeof target === "string" ? [target] : Object.values(target)));
  const built = targets.filter((target) => target.startsWith("./dist/"));
  assert.ok(built.length >= WORKER_LOADED.length, "positive control: the targets under dist were found");
  assert.deepEqual(built.filter((target) => !existsSync(`${PACKAGE}${target}`)), []);
});
