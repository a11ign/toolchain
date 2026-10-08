/**
 * a11ign/a11ign#3735: THE PRESET LEAVES `new URL("./", import.meta.url)` AS WRITTEN. Rslib's default parser builds that form into an
 * asset, so a package whose source reads its own directory got `new URL("./static/assets/index.ts", import.meta.url)` from its build
 * (found by #3552). The only test that sees it is a REAL BUILD, so this one builds a fixture package with the real `rslib` and reads
 * what came out; asserting on the preset's object would pass while Rslib ignored the key (the global parser option did exactly that).
 *
 * THE CONTROL IS THE SAME BUILD WITH THE RULE REMOVED, and it must show the defect: a test that passed on both would prove nothing
 * about the rule. Each fixture lives under `node_modules/.cache`, which is already ignored and lets `rslib` and `typescript` resolve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { libraryPreset } from "./rslib-presets.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const PRESET_SOURCE = fileURLToPath(new URL("./rslib-presets.ts", import.meta.url));
const FIXTURES = join(REPOSITORY, "node_modules", ".cache", "rslib-preset-fixtures");
const BUILD_TIMEOUT_MS = 120_000;

type Built = { status: number | null; log: string; dir: string };

/** Source for the fixture's one entry, written with the TWO forms of the defect: a `./` directory and a sibling file. */
const FIXTURE_SOURCE = [
  'import { fileURLToPath } from "node:url";',
  'export const here = fileURLToPath(new URL("./", import.meta.url));',
  'export const sibling = new URL("./data.json", import.meta.url).href;',
  "",
].join("\n");

/** The fixture's `rslib.config.ts`: the REAL preset, with `tools` dropped when the control asks for the rule removed. */
function configSource({ keepRule }: { keepRule: boolean }): string {
  const lib = keepRule ? "preset.lib[0]" : "{ ...preset.lib[0], tools: undefined }";
  return [
    `import { libraryPreset } from ${JSON.stringify(PRESET_SOURCE)};`,
    'import pkg from "./package.json" with { type: "json" };',
    "const preset = libraryPreset(pkg, { dir: import.meta.dirname });",
    `export default { lib: [${lib}] };`,
    "",
  ].join("\n");
}

/** Builds the fixture package with the real `rslib` and returns where it built, so the caller reads the output. */
function buildFixture({ keepRule }: { keepRule: boolean }): Built {
  mkdirSync(FIXTURES, { recursive: true });
  const dir = mkdtempSync(join(FIXTURES, "fx-"));
  mkdirSync(join(dir, "src"));
  const exports = { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", exports }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(REPOSITORY, "tsconfig.base.json"), include: ["src"], compilerOptions: { rootDir: "./src" } }));
  writeFileSync(join(dir, "src", "index.ts"), FIXTURE_SOURCE);
  writeFileSync(join(dir, "src", "data.json"), "{}");
  writeFileSync(join(dir, "rslib.config.ts"), configSource({ keepRule }));
  const run = spawnSync(join(REPOSITORY, "node_modules", ".bin", "rslib"), ["build"], { cwd: dir, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
  return { status: run.status, log: `${run.stdout}${run.stderr}`, dir };
}

function output(built: Built): string {
  return readFileSync(join(built.dir, "dist", "index.mjs"), "utf8");
}

test("a fixture built WITH the preset keeps new URL(\"./\", import.meta.url) as written and emits no asset", () => {
  const built = buildFixture({ keepRule: true });
  try {
    assert.equal(built.status, 0, built.log);
    const js = output(built);
    assert.match(js, /new URL\("\.\/", import\.meta\.url\)/, `the directory form was rewritten:\n${js}`);
    assert.match(js, /new URL\("\.\/data\.json", import\.meta\.url\)/, `the sibling form was rewritten:\n${js}`);
    assert.equal(existsSync(join(built.dir, "dist", "static")), false, "the build emitted an asset directory");
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test("CONTROL: the same build with the rule removed rewrites the URL to an asset, so the test above can fail", () => {
  const built = buildFixture({ keepRule: false });
  try {
    assert.equal(built.status, 0, built.log);
    assert.match(output(built), /static\/assets\//, "the defect did not reproduce: this Rslib no longer builds the URL as an asset, so the rule may now be dead weight");
    assert.equal(existsSync(join(built.dir, "dist", "static")), true);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test("the preset carries the rule for TypeScript and JavaScript sources, and no `@rslib/core` type", () => {
  const [rule] = libraryPreset({ exports: {} }, { dir: REPOSITORY }).lib[0].tools.rspack.module.rules;
  assert.deepEqual(rule.parser, { url: false });
  for (const name of ["a.ts", "a.mts", "a.cts", "a.js", "a.mjs", "a.cjs"]) assert.ok(rule.test.test(name), `${name} is not matched`);
  assert.equal(rule.test.test("a.json"), false);
});
