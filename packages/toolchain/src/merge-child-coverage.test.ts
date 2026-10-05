/**
 * MOVED HERE FROM a11ign's `packages/lab/src/packaging/rstest-child-coverage.test.ts` (a11ign/a11ign#3578), the test follows the code.
 *
 * #1350, rstest F2: coverage of a script a test runs as a CHILD `node` process, merged into rstest's own report.
 *
 * `@rstest/coverage-v8` collects through an inspector session inside each rstest worker, so a spawned child is never
 * seen and its script reads 0% (7 files on #1315). The merge takes the child's `NODE_V8_COVERAGE` output, converts it
 * with rstest's own provider, and merges it into files the report already lists. These tests drive that with a real
 * spawned child and a real `CoverageProvider`, over a fixture written to a temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageProvider } from "@rstest/coverage-v8";
import {
  childCoverageEntries, coverageOptionsFromC8rc, coverageTotals, foldByStart, mergeChildCoverage, rstestCoverageArgs,
} from "./merge-child-coverage.ts";
import type { FileData } from "./merge-child-coverage.ts";

const FIXTURE = [
  "export function reached(n) { return n > 0 ? 'positive' : 'not positive'; }",
  "export function neverCalled() { return 'unreachable from the child'; }",
  "if (process.argv[2] === 'run') process.stdout.write(reached(1));",
  "",
].join("\n");

/** A root holding the fixture, a raw-coverage directory, and rstest's own zero entry for the fixture. */
async function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "child-coverage-")));
  const script = join(root, "child.mjs");
  writeFileSync(script, FIXTURE);
  const rawDir = join(root, "raw");
  mkdirSync(rawDir);
  const options = coverageOptionsFromC8rc({ include: ["child.mjs"], exclude: [] }, join(root, "report"));
  // What rstest writes for an included file no test loaded: its OWN untested entry, every count 0.
  const [untested] = await new CoverageProvider(options as never, root)
    .generateCoverageForUntestedFiles({ environmentName: "node", files: [script] });
  return { root, script, rawDir, options, report: { [script]: untested as unknown as FileData } as Record<string, FileData> };
}

/** Spawn the fixture as a child, with or without `NODE_V8_COVERAGE`. */
function runChild(script: string, rawDir: string | null) {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  if (rawDir) env.NODE_V8_COVERAGE = rawDir;
  const run = spawnSync(process.execPath, [script, "run"], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "positive", "the child ran the fixture");
}

const coveredStatements = (data: { s: Record<string, number> }) => Object.values(data.s).filter((n) => n > 0).length;

test("#1350 ACCEPTANCE: a spawned child's lines appear in the merged report; without the merge they read 0", async () => {
  const w = await workspace();
  try {
    runChild(w.script, w.rawDir);
    const untested = w.report[w.script] as unknown as { s: Record<string, number>; fnMap: Record<string, { name: string }> };
    // THE CONTROL, and the defect: rstest's own entry for a file only a child ran reads 0.
    assert.equal(coveredStatements(untested), 0, "rstest alone sees nothing a child covered");
    // CAPTURED BEFORE THE CALL: an expectation read from an object the call can rewrite agrees with whatever it did.
    const statementsBefore = Object.keys(untested.s).length;
    const reportBefore = JSON.stringify(w.report);

    const { merged, childFiles } = await mergeChildCoverage(
      { report: w.report, entries: childCoverageEntries(w.rawDir, w.root), options: w.options, root: w.root });
    assert.deepEqual(childFiles, [w.script], "the child's file gained coverage");
    const after = merged.fileCoverageFor(w.script).toJSON() as typeof untested & { f: Record<string, number> };
    assert.ok(coveredStatements(after) > 0, "after the merge the child's statements are covered");
    assert.equal(Object.keys(after.s).length, statementsBefore,
      "the SAME statements, counted by rstest's own converter -- c8's units would not match");
    assert.equal(JSON.stringify(w.report), reportBefore, "and the report passed in is not modified");
    const hits = Object.fromEntries(Object.entries(after.fnMap).map(([id, fn]) => [fn.name, after.f[id]]));
    assert.ok(hits.reached > 0, "the function the child called is covered");
    assert.equal(hits.neverCalled, 0, "and the one it never called is not -- the merge attributes, it does not paint");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("#1350 CONTROL: a child run WITHOUT NODE_V8_COVERAGE leaves the file at 0 -- the merge invents nothing", async () => {
  const w = await workspace();
  try {
    runChild(w.script, null);
    const entries = childCoverageEntries(w.rawDir, w.root);
    assert.deepEqual(entries, [], "no raw coverage was written, so there is nothing to merge");
    const { merged, childFiles } = await mergeChildCoverage({ report: w.report, entries, options: w.options, root: w.root });
    assert.deepEqual(childFiles, []);
    assert.equal(coveredStatements(merged.fileCoverageFor(w.script).toJSON() as never), 0);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("#1350: a child that ran a file OUTSIDE the report's population adds nothing -- the threshold's population holds", async () => {
  const w = await workspace();
  try {
    const outside = join(w.root, "outside.mjs");
    writeFileSync(outside, FIXTURE);
    runChild(outside, w.rawDir);
    runChild(w.script, w.rawDir);
    const entries = childCoverageEntries(w.rawDir, w.root);
    assert.ok(entries.some((e) => e.filePath === outside), "the outside file WAS covered by a child -- the positive control");
    // The provider is given an include that DOES match the outside file, so its own filter lets it through: the
    // report's population -- the file list rstest wrote -- is what must keep it out, not the provider's include.
    const options = coverageOptionsFromC8rc({ include: ["*.mjs"], exclude: [] }, join(w.root, "report"));
    const { merged } = await mergeChildCoverage({ report: w.report, entries, options, root: w.root });
    assert.deepEqual(merged.files(), [w.script], "but only files the report already lists are in the merged report");
    assert.ok(coverageTotals(merged).statements.covered > 0);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("#1350: childCoverageEntries keeps repo scripts only -- no node: internals, nothing outside root, no query string", async () => {
  const w = await workspace();
  try {
    writeFileSync(join(w.rawDir, "coverage-1.json"), JSON.stringify({ result: [
      { url: "node:internal/main/run_main_module", functions: [] },
      { url: "file:///elsewhere/other.mjs", functions: [] },
      { url: `file://${w.root}/node_modules/dep/index.js`, functions: [] },
      { url: `file://${w.script}?fresh-import=1`, functions: [] },
      // A SIBLING that shares the root's prefix is not inside it (reviewer on #1403): /tmp/x-abc-other vs /tmp/x-abc.
      { url: `file://${w.root}-other/sneaky.mjs`, functions: [] },
    ] }));
    writeFileSync(join(w.rawDir, "not-coverage.txt"), "ignored");
    assert.deepEqual(childCoverageEntries(w.rawDir, w.root).map((e) => e.filePath), [w.script],
      "only the script under root survives -- the positive control -- and the prefix-sharing sibling does not");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("#1350: the population is `.c8rc.json`'s own, passed on rstest's command line, one flag per pattern", () => {
  // A repository's own `.c8rc.json`, parsed, was read here in a11ign; this repository has none, so the shape is written out (several patterns of each kind).
  const c8rc = { include: ["packages/*/src/**/*.ts", "scripts/**/*.mjs"], exclude: ["**/*.test.ts", "**/dist/**", "**/node_modules/**"] };
  const options = coverageOptionsFromC8rc(c8rc, "/tmp/report");
  assert.deepEqual(options.include, c8rc.include, "read, never retyped");
  assert.deepEqual(options.exclude, c8rc.exclude);
  const args = rstestCoverageArgs(options);
  assert.equal(args.filter((a) => a === "--coverage.include").length, c8rc.include.length);
  assert.equal(args.filter((a) => a === "--coverage.exclude").length, c8rc.exclude.length);
  assert.ok(args.includes("--coverage.reportOnFailure"), "a host-dependent test failure must not suppress the report");
  assert.deepEqual(args.slice(0, 3), ["--coverage", "--coverage.provider", "v8"]);
});

/**
 * #1350, measured on the whole suite: a file the suite ALSO imports has an in-process rstest entry whose END columns
 * differ from the child's conversion (rstest wrote `end.column: None` where the child has `100`) and whose ids are its
 * own. Merging the child's map as a second map doubled 103 files' statement maps. This base is the fixture's own entry
 * reshaped that way -- the measured difference, reproduced -- so the fold is driven against the shape that broke it.
 */
/** Ids an in-process entry uses, deliberately disjoint from the fixture's own so a match by id cannot pass. */
const OTHER_IDS = 1000;

function inProcessShaped(entry: FileData): FileData {
  const renumber = <V>(map: Record<string, V>, offset: number): Record<string, V> =>
    Object.fromEntries(Object.entries(map).map(([id, v]) => [String(Number(id) + offset), v]));
  type Spanned = { start: { line: number; column: number | null }; end: { line: number; column: number | null } };
  const noEnd = (located: Spanned): Spanned => ({ ...located, end: { line: located.end.line, column: null } });
  const statementMap = Object.fromEntries(Object.entries(entry.statementMap as Record<string, Spanned>)
    .map(([id, located]) => [id, noEnd(located)]));
  return {
    ...entry,
    statementMap: renumber(statementMap, OTHER_IDS), s: renumber(entry.s, OTHER_IDS),
    fnMap: renumber(entry.fnMap, OTHER_IDS), f: renumber(entry.f, OTHER_IDS),
    branchMap: renumber(entry.branchMap, OTHER_IDS), b: renumber(entry.b, OTHER_IDS),
  };
}

test("#1350: a file rstest covered IN-PROCESS keeps rstest's own maps -- child hits fold on by start, no denominator grows", async () => {
  const w = await workspace();
  try {
    runChild(w.script, w.rawDir);
    const base = inProcessShaped(w.report[w.script]);
    // Every expectation is taken BEFORE the call. istanbul's merge rewrites objects it was handed in place, and on
    // #1350 a doubling mutation survived this test because it compared against the base it had just doubled.
    const counts = { s: Object.keys(base.s).length, f: Object.keys(base.f).length, b: Object.keys(base.b).length };
    const baseBefore = JSON.stringify(base);
    const { merged, unmatched } = await mergeChildCoverage(
      { report: { [w.script]: base }, entries: childCoverageEntries(w.rawDir, w.root), options: w.options, root: w.root });
    const after = merged.fileCoverageFor(w.script).toJSON() as unknown as FileData;
    assert.equal(Object.keys(after.s).length, counts.s, "the statement map is rstest's, not doubled");
    assert.equal(Object.keys(after.f).length, counts.f, "and so is the function map");
    assert.equal(Object.keys(after.b).length, counts.b, "and the branch map");
    assert.equal(JSON.stringify(base), baseBefore, "and rstest's entry that was passed in is untouched");
    assert.ok(Object.values(after.s).some((n) => n > 0), "the child's hits landed on rstest's statements");
    assert.deepEqual(unmatched, { statements: 0, functions: 0, branches: 0 }, "every child structure found its start");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("#1350: foldByStart counts a child structure with no base structure at its start, and adds nothing for it", () => {
  const located = (line: number, column: number) => ({ start: { line, column }, end: { line, column: column + 1 } });
  const base = { statementMap: { 0: located(1, 0) }, s: { 0: 0 }, fnMap: {}, f: {}, branchMap: {}, b: {} };
  const child = { statementMap: { 0: located(1, 0), 1: located(9, 4) }, s: { 0: 2, 1: 5 }, fnMap: {}, f: {},
    branchMap: { 0: { loc: located(1, 0), locations: [located(1, 0), located(1, 2)] } }, b: { 0: [1, 0] } };
  const { data, unmatched } = foldByStart(base as never, child as never);
  assert.deepEqual(data.s, { 0: 2 }, "the matched statement gains the child's hits, the unmatched one is not added");
  assert.deepEqual(unmatched, { statements: 1, functions: 0, branches: 1 }, "both misses are counted, never silent");
  assert.deepEqual(base.s, { 0: 0 }, "the input is not modified");
});

test("#1350: the returned map shares no object with the caller's report -- merging more into it cannot rewrite the report", async () => {
  const w = await workspace();
  try {
    // A second included file that no child runs: its entry passes through the merge unfolded.
    const other = join(w.root, "other.mjs");
    writeFileSync(other, FIXTURE);
    // Both files in the population: the workspace's include names only child.mjs, and the provider honours it when
    // generating an untested entry -- with it, other.mjs came back as NO entry and the merge threw on `undefined`.
    const options = coverageOptionsFromC8rc({ include: ["*.mjs"], exclude: [] }, join(w.root, "report"));
    const [otherEntry] = await new CoverageProvider(options as never, w.root)
      .generateCoverageForUntestedFiles({ environmentName: "node", files: [other] });
    assert.ok(otherEntry, "the second file has an untested entry -- the positive control for this setup");
    const report = { ...w.report, [other]: otherEntry as unknown as FileData };
    runChild(w.script, w.rawDir);
    const reportBefore = JSON.stringify(report);
    const { merged } = await mergeChildCoverage(
      { report, entries: childCoverageEntries(w.rawDir, w.root), options, root: w.root });
    // istanbul rewrites an entry IN PLACE when a later merge lands on it with a different map (end columns shifted
    // here, as the in-process and child conversions differ). If the returned map held the caller's own objects,
    // this would rewrite the caller's report.
    const shifted = structuredClone(otherEntry) as unknown as FileData & { statementMap: Record<string, { end: { column: number } }> };
    for (const located of Object.values(shifted.statementMap)) located.end.column += 1;
    merged.merge({ [other]: shifted } as never);
    assert.equal(JSON.stringify(report), reportBefore, "the caller's report is exactly as it was passed in");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
