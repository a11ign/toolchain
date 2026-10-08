/**
 * a11ign/a11ign#3580, #3824: THE PRESET BUILDS INTO `dist` WITHOUT EMPTYING IT FIRST. Rslib's default empties `dist` before every build, so a
 * reader of `dist` in another process found a built file missing for the length of the build. The only test that sees it is a REAL BUILD:
 * a marker file is put in `dist`, the fixture is built, and the marker must still be there. Asserting on the preset's object would pass
 * while Rslib ignored the key.
 *
 * THE CONTROL IS THE SAME BUILD WITH `cleanDistPath` REMOVED, and it must delete the marker: a test that passed on both would prove nothing
 * about the key. Each fixture lives under `node_modules/.cache`, which is already ignored and lets `rslib` and `typescript` resolve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { libraryPreset } from "./rslib-presets.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const PRESET_SOURCE = fileURLToPath(new URL("./rslib-presets.ts", import.meta.url));
const FIXTURES = join(REPOSITORY, "node_modules", ".cache", "rslib-clean-dist-fixtures");
const BUILD_TIMEOUT_MS = 120_000;
const MARKER = "marker-from-an-earlier-build.txt";

/** The fixture's `rslib.config.ts`: the REAL preset, with `output.cleanDistPath` dropped when the control asks for Rslib's default. */
function configSource({ keepKey }: { keepKey: boolean }): string {
  const output = keepKey ? "preset.lib[0].output" : "{ ...preset.lib[0].output, cleanDistPath: undefined }";
  return [
    `import { libraryPreset } from ${JSON.stringify(PRESET_SOURCE)};`,
    'import pkg from "./package.json" with { type: "json" };',
    "const preset = libraryPreset(pkg, { dir: import.meta.dirname });",
    `export default { lib: [{ ...preset.lib[0], output: ${output} }] };`,
    "",
  ].join("\n");
}

/** Builds a fixture package with a marker already in its `dist`, and says whether the build exited 0 and whether the marker survived it. */
function buildOverMarker({ keepKey }: { keepKey: boolean }): { log: string; status: number | null; markerSurvived: boolean } {
  mkdirSync(FIXTURES, { recursive: true });
  const dir = mkdtempSync(join(FIXTURES, "fx-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dist"));
    const exports = { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", exports }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(REPOSITORY, "tsconfig.base.json"), include: ["src"], compilerOptions: { rootDir: "./src" } }));
    writeFileSync(join(dir, "src", "index.ts"), "export const one = 1;\n");
    writeFileSync(join(dir, "rslib.config.ts"), configSource({ keepKey }));
    writeFileSync(join(dir, "dist", MARKER), "");
    const run = spawnSync(join(REPOSITORY, "node_modules", ".bin", "rslib"), ["build"], { cwd: dir, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
    return { log: `${run.stdout}${run.stderr}`, status: run.status, markerSurvived: existsSync(join(dir, "dist", MARKER)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the preset says cleanDistPath: false", () => {
  assert.equal(libraryPreset({ exports: {} }, { dir: REPOSITORY }).lib[0].output.cleanDistPath, false);
});

test("a fixture built WITH the preset leaves what was already in dist", () => {
  const built = buildOverMarker({ keepKey: true });
  assert.equal(built.status, 0, built.log);
  assert.equal(built.markerSurvived, true, "the build emptied dist");
});

test("CONTROL: the same build with the key removed empties dist, so the test above can fail", () => {
  const built = buildOverMarker({ keepKey: false });
  assert.equal(built.status, 0, built.log);
  assert.equal(built.markerSurvived, false, "this Rslib no longer empties dist by default, so the key may now be dead weight");
});
