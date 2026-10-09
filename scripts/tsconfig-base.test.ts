import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// THE SHARED BASE SETS THE TWO FLAGS ADR 0043 DECISION 8 ASSIGNS IT, ONCE (a11ign/a11ign#4339). `js-to-ts` rewrites `./x.js` to `./x.ts`, which
// only type-checks under `rewriteRelativeImportExtensions`, and the files are written to the subset a stripping Node accepts, which is what
// `erasableSyntaxOnly` refuses an enum, a namespace or a parameter property to leave.
//
// RUN, NOT READ. Reading the two keys proves a line is there, not that it bites, so each flag is also run through `tsc --noEmit` over a scratch
// project extending the REAL base: the base alone must accept the import and refuse the enum, and the same project with the one flag set to
// `false` must do the opposite. Without that second half a test that checks only the green is the vacuity failure: it passes when the flag does nothing.

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, "..", "tsconfig.base.json");
const TSC = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

// TS5097 is the refusal of a `.ts` import path without `allowImportingTsExtensions`; TS1294 is `erasableSyntaxOnly` refusing erasable-incompatible syntax.
const TS_IMPORT_REFUSED = "TS5097";
const NOT_ERASABLE = "TS1294";

const IMPORTS_A_TS_FILE = { "x.ts": "export const x = 1;\n", "main.ts": 'import { x } from "./x.ts";\nexport const y: number = x;\n' };
const DECLARES_AN_ENUM = { "main.ts": "export enum Color { Red, Green }\n" };

type Flag = "erasableSyntaxOnly" | "rewriteRelativeImportExtensions";
type Check = { status: number | null; output: string };

function baseOptions(): Record<string, unknown> {
  const { config, error } = ts.readConfigFile(BASE, ts.sys.readFile);
  if (error) throw new Error(`tsconfig.base.json does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return config.compilerOptions;
}

// `types` is emptied because `@types/node` resolves from the config's own directory and the scratch project sits in the OS temp directory.
function typeCheck(files: Record<string, string>, override: Partial<Record<Flag, false>> = {}): Check {
  const dir = mkdtempSync(join(tmpdir(), "tsconfig-base-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const config = { extends: BASE, compilerOptions: { noEmit: true, types: [], ...override }, include: Object.keys(files) };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config));
    const run = spawnSync(process.execPath, [TSC, "-p", dir], { encoding: "utf8" });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the base sets erasableSyntaxOnly and rewriteRelativeImportExtensions", () => {
  const options = baseOptions();
  assert.equal(options.erasableSyntaxOnly, true);
  assert.equal(options.rewriteRelativeImportExtensions, true);
});

test("the base is read from the file it names: a key the base lacks reads as absent", () => {
  // The positive control for the test above: `baseOptions` returns undefined for a key that is not there, so `true` was the file's own word.
  assert.equal(baseOptions().noSuchOption, undefined);
});

test("a file importing ./x.ts type-checks under the base", () => {
  const { status, output } = typeCheck(IMPORTS_A_TS_FILE);
  assert.equal(status, 0, output);
});

test("the same import is refused with rewriteRelativeImportExtensions removed", () => {
  const { status, output } = typeCheck(IMPORTS_A_TS_FILE, { rewriteRelativeImportExtensions: false });
  assert.notEqual(status, 0, "the import passed without the flag, so the flag proves nothing");
  assert.match(output, new RegExp(TS_IMPORT_REFUSED));
});

test("a file declaring an enum is refused under the base", () => {
  const { status, output } = typeCheck(DECLARES_AN_ENUM);
  assert.notEqual(status, 0, output);
  assert.match(output, new RegExp(NOT_ERASABLE));
});

test("the same enum is accepted with erasableSyntaxOnly removed", () => {
  const { status, output } = typeCheck(DECLARES_AN_ENUM, { erasableSyntaxOnly: false });
  assert.equal(status, 0, output);
});
