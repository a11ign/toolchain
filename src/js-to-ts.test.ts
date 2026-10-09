/**
 * THE CONVERSION SCRIPT'S TESTS (a11ign/a11ign#4248). Each case that asserts an outcome has its control beside it: the same input
 * without the thing under test, so a script that does nothing, or everything, is red here. The fixtures are real directories because the
 * headline claim is about `tsc --noEmit` on what was written, and a map of strings cannot typecheck.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convert, main, planConversion, readTree, type Tree } from "./js-to-ts.ts";

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowJs: true, rewriteRelativeImportExtensions: true, skipLibCheck: true, types: [] },
  include: ["**/*.ts", "**/*.mjs"],
});

const A = `// @ts-check
import { length } from "./b.mjs";
/**
 * Adds.
 * @param {number} x the x
 * @param {string} [label]
 * @returns {number}
 */
export function add(x, label) { return x + length(label ?? ""); }
export const one = add(1);
`;
const B = `/** @param {string} s @returns {number} */\nexport function length(s) { return s.length; }\n`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "js-to-ts-"));
  made.push(root);
  for (const [path, text] of Object.entries({ "package.json": '{"name":"fx","type":"module","private":true}\n', "tsconfig.json": TSCONFIG, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const quiet = () => { const lines: string[] = []; return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) }; };
const ownTsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const tscStatus = (root: string): number | null => spawnSync(process.execPath, [ownTsc, "--noEmit", "--pretty", "false", "-p", join(root, "tsconfig.json")], { cwd: root, encoding: "utf8" }).status;

test("a fixture file in comes out as typescript that typechecks", () => {
  const root = fixture({ "src/a.mjs": A, "src/b.mjs": B });
  const before = readTree(root);
  assert.ok("src/a.mjs" in before && !("src/a.ts" in before), "control: the fixture starts as .mjs with no .ts");
  assert.ok(!/\(x: number/.test(before["src/a.mjs"]), "control: the source carries no annotation, only JSDoc");
  const output = quiet();
  assert.equal(main([root], output), 0, output.lines.join("\n"));
  const after = readTree(root);
  assert.ok("src/a.ts" in after && "src/b.ts" in after && !("src/a.mjs" in after) && !("src/b.mjs" in after), "both files are renamed");
  assert.match(after["src/a.ts"], /export function add\(x: number, label\?: string\): number/, "JSDoc became annotations, the optional parameter stayed optional");
  assert.match(after["src/a.ts"], /from "\.\/b\.ts"/, "the relative specifier names the renamed file");
  assert.equal(tscStatus(root), 0, "an independent tsc --noEmit over the written tree is clean");
});

test("an optional JSDoc parameter does not come out required (`one = add(1)` would otherwise be TS2554)", () => {
  const plan = planConversion({ "tsconfig.json": TSCONFIG, "src/a.mjs": A, "src/b.mjs": B });
  assert.doesNotMatch(plan.written["src/a.ts"], /label: string\)/, "no required `label: string` survives; `one = add(1)` would be TS2554");
});

test("a file whose JSDoc cannot convert lands in the residue with its error code, and the run does not claim it", () => {
  const typedef = `/** @typedef {{ n: number }} Pair */\n/** @param {Pair} p */\nexport function use(p) { return p.n; }\n`;
  const root = fixture({ "src/b.mjs": B, "src/pair.mjs": typedef });
  const report = convert({ root });
  const pair = report.residue.find(({ path }) => path === "src/pair.ts");
  assert.ok(pair, JSON.stringify(report.residue));
  assert.ok("TS2304" in pair.codes, `the unresolved typedef is TS2304, got ${JSON.stringify(pair.codes)}`);
  assert.ok(!report.converted.includes("src/pair.ts"), "a residue file is not counted as converted");
  assert.ok(report.converted.includes("src/b.ts"), "control: the file that converted clean IS counted");
  assert.equal(main([root], quiet()), 1, "residue is exit 1");
});

test("a file that does not parse is not renamed, and is residue with its syntax code", () => {
  const plan = planConversion({ "tsconfig.json": TSCONFIG, "src/bad.mjs": "export function (\n", "src/b.mjs": B });
  assert.deepEqual(Object.keys(plan.renames), ["src/b.mjs"], "only the parseable file is renamed");
  assert.equal(plan.notConverted.length, 1);
  assert.equal(plan.notConverted[0].path, "src/bad.mjs");
  assert.ok(Object.keys(plan.notConverted[0].codes).every((code) => /^TS\d+$/.test(code)));
});

test("an importer OUTSIDE the set is rewritten and printed; one that imports a file left alone is not", () => {
  const tree: Tree = {
    "src/b.mjs": B,
    "main.ts": `import { length } from "./src/b.mjs";\nimport { other } from "./other.mjs";\nexport const n = length("x") + other;\n`,
    "other.mjs": "export const other = 1;\n",
  };
  const plan = planConversion(tree, { exclude: ["other.mjs"] });
  assert.match(plan.written["main.ts"], /from "\.\/src\/b\.ts"/);
  assert.match(plan.written["main.ts"], /from "\.\/other\.mjs"/, "control: the excluded file's specifier is untouched");
  assert.deepEqual(plan.outside, ["main.ts"], "the outside edit is listed for the Outside-Region lines");
});

test("a specifier inside a string or template is left alone, and one inside a JSDoc import type is rewritten", () => {
  const tree: Tree = {
    "src/b.mjs": B,
    "src/t.ts": "export const fixture = `import { length } from \"./b.mjs\"`;\n/** @type {import(\"./b.mjs\").length} */\nexport const f = null;\n",
  };
  const written = planConversion(tree).written["src/t.ts"];
  assert.match(written, /`import \{ length \} from "\.\/b\.mjs"`/, "the template literal is data, not an import");
  assert.match(written, /import\("\.\/b\.ts"\)/, "the JSDoc import type names the renamed file");
});

test("references that are not imports: a path that resolves is rewritten, a bare name that may be another file is printed, a CHANGELOG is history", () => {
  const tree: Tree = {
    "scripts/run.mjs": "export {};\n",
    "package.json": '{"scripts":{"go":"node scripts/run.mjs"}}\n',
    "docs/guide.md": "Run `run.mjs` first, then `scripts/run.mjs`.\n",
    "CHANGELOG.md": "- added scripts/run.mjs\n",
  };
  const plan = planConversion(tree);
  assert.match(plan.written["package.json"], /node scripts\/run\.ts/);
  assert.match(plan.written["docs/guide.md"], /`run\.mjs` first, then `scripts\/run\.ts`/, "the bare name stays, the full path moves");
  assert.ok(!("CHANGELOG.md" in plan.written), "history is not rewritten");
  const listed = plan.unrewritten.map(({ path, text }) => `${path}:${text}`);
  assert.ok(listed.includes("docs/guide.md:run.mjs") && listed.includes("CHANGELOG.md:scripts/run.mjs"), listed.join(", "));
  assert.ok(!listed.some((entry) => entry.startsWith("package.json")), "control: a rewritten reference is not also listed");
});

test("an --exclude'd file is untouched and listed as skipped, and so is a whole directory", () => {
  const root = fixture({ "src/a.mjs": A, "src/b.mjs": B, "units/tick.mjs": "export const tick = 1;\n" });
  const bytes = readFileSync(join(root, "units/tick.mjs"), "utf8");
  const report = convert({ root, exclude: ["units"] });
  assert.equal(readFileSync(join(root, "units/tick.mjs"), "utf8"), bytes, "the excluded file is byte-identical");
  assert.deepEqual(report.skipped.map(({ path }) => path), ["units/tick.mjs"]);
  assert.ok(report.renamed.includes("src/a.mjs"), "control: the rest is converted");
  const none = convert({ root: fixture({ "units/tick.mjs": "export const tick = 1;\n" }) });
  assert.equal(none.skipped.length, 0, "control: without --exclude nothing is skipped");
});

test("--dry-run leaves the tree byte-identical, and the same run without it does not", () => {
  const root = fixture({ "src/a.mjs": A, "src/b.mjs": B });
  const before = readTree(root);
  const output = quiet();
  assert.equal(main([root, "--dry-run"], output), 0, output.lines.join("\n"));
  assert.deepEqual(readTree(root), before, "nothing was written");
  assert.ok(output.lines.some((line) => /would rename src\/a\.mjs/.test(line)) && output.lines.some((line) => /NOT RUN \(dry run/.test(line)), "it says what it would do and that it did not typecheck");
  main([root], quiet());
  assert.notDeepEqual(readTree(root), before, "control: without --dry-run the tree changes");
});

test("a second run changes nothing and reports the same residue", () => {
  const typedef = `/** @typedef {{ n: number }} Pair */\n/** @param {Pair} p */\nexport function use(p) { return p.n; }\n`;
  const root = fixture({ "src/b.mjs": B, "src/pair.mjs": typedef });
  const first = convert({ root });
  const written = readTree(root);
  const second = convert({ root });
  assert.deepEqual(readTree(root), written, "the tree is byte-identical after the second run");
  assert.deepEqual(second.residue, first.residue, "the residue is the same");
  assert.ok(first.residue.length > 0 && first.renamed.length > 0, "control: the first run did work and had residue, so 'same' is not 'both empty'");
  assert.equal(second.renamed.length, 0);
});

test("an empty input is red, and a misspelt flag is refused rather than run as the default", () => {
  const empty = mkdtempSync(join(tmpdir(), "js-to-ts-empty-"));
  made.push(empty);
  const output = quiet();
  assert.equal(main([empty], output), 2);
  assert.match(output.lines.join("\n"), /holds no text file/);
  assert.equal(main([fixture({ "src/b.mjs": B }), "--dryrun"], quiet()), 2, "an unknown flag is exit 2");
  assert.equal(main([fixture({ "src/b.mjs": B })], quiet()), 0, "control: the same tree without the bad flag converts");
});

test("a project with no tsconfig says the typecheck did not run, never that it is clean", () => {
  const root = fixture({ "src/b.mjs": B });
  rmSync(join(root, "tsconfig.json"));
  const report = convert({ root });
  assert.equal(report.typecheck.ran, false);
  assert.match(report.typecheck.reason, /no tsconfig\.json/);
});

test("in a git repository the rename is a git mv, so history follows", () => {
  const root = fixture({ "src/a.mjs": A, "src/b.mjs": B });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  assert.equal(main([root], quiet()), 0);
  const renames = git("diff", "--cached", "--name-status", "-M").split("\n").filter((line) => line.startsWith("R"));
  assert.equal(renames.length, 2, `git sees two renames: ${renames.join(" | ")}`);
});

// THE ONE LINE ON A COLD CACHE (a11ign/a11ign#4348). `npx --package @a11ign/toolchain js-to-ts` puts the package alone in `_npx/<hash>/node_modules`,
// and `typescript` is an OPTIONAL peer that npx does not install, so a static `import ts from "typescript"` exited ERR_MODULE_NOT_FOUND. The registry
// run is the row's hand-run; this is the same shape offline: the PACKED tarball unpacked under a temp directory with no `typescript` on any path
// above it, run as its bin against a repository that has (or has not) its own `typescript`.

/** The packed tarball of this package, unpacked to `<scratch>/node_modules/@a11ign/toolchain`, and the bin inside it. Built once: `pnpm test` builds `dist` first. */
let installedBin: string | undefined;
function packedBin(): string {
  if (installedBin !== undefined) return installedBin;
  const scratch = mkdtempSync(join(tmpdir(), "js-to-ts-pack-"));
  made.push(scratch);
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: packageDir, encoding: "utf8" })) as { filename: string }[];
  const installed = join(scratch, "node_modules", "@a11ign", "toolchain");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", join(scratch, packed.filename), "--strip-components=1", "-C", installed]);
  installedBin = join(installed, "dist", "js-to-ts.mjs");
  return installedBin;
}

const ownTypescript = dirname(dirname(ownTsc));

/** Runs the packed bin on a flat fixture repository, with no path to `typescript` except what the repository itself holds. */
function runPackedBin(args: string[], { repositoryHasTypescript }: { repositoryHasTypescript: boolean }) {
  const root = fixture({ "src/a.mjs": A, "src/b.mjs": B });
  if (repositoryHasTypescript) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(ownTypescript, join(root, "node_modules", "typescript"), "dir");
  }
  const env = { ...process.env, NODE_PATH: "" };
  const run = spawnSync(process.execPath, [packedBin(), ...args, root], { cwd: root, encoding: "utf8", env });
  return { root, status: run.status, output: `${run.stdout}${run.stderr}` };
}

test("the packed bin, with no typescript beside the package, converts a repository that has its own", () => {
  const { root, status, output } = runPackedBin([], { repositoryHasTypescript: true });
  assert.equal(status, 0, output);
  assert.match(output, /renamed 2 file\(s\) under TypeScript 6\./);
  assert.equal(output.includes("ERR_MODULE_NOT_FOUND"), false, output);
  assert.equal(tscStatus(root), 0, "the converted fixture typechecks");
});

test("the packed bin, with typescript nowhere, refuses with the command that installs it and exits 2", () => {
  const { status, output } = runPackedBin(["--dry-run"], { repositoryHasTypescript: false });
  assert.equal(status, 2, output);
  assert.match(output, /needs the `typescript` package \(6\.x\)/);
  assert.match(output, /npm install --save-dev typescript@\^6\.0\.3/);
  assert.equal(output.includes("ERR_MODULE_NOT_FOUND"), false, "a refusal that names the install, not a stack trace");
});
