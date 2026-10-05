/**
 * #1350, rstest adoption F2 (BLOCKER), under #1317: COVERAGE OF SCRIPTS THE SUITE RUNS AS CHILD PROCESSES.
 *
 * WHY THEY READ 0%. `@rstest/coverage-v8` 0.11.12 collects IN-PROCESS: each rstest worker opens a `node:inspector`
 * session and calls `Profiler.startPreciseCoverage` / `takePreciseCoverage` (`dist/index.js`; `NODE_V8_COVERAGE`
 * and `child_process` appear nowhere in the package). A test that runs `node scripts/x.mjs` starts a process with no
 * session, so x.mjs is never seen. c8 sees it because c8 works through `NODE_V8_COVERAGE`, which Node honours in
 * every process that inherits it. Measured on #1315: 7 files c8 covers read 0% under rstest, 3 of them run by their
 * own tests as children.
 *
 * THE FIX, measured on #1350 before it was written:
 * - **`NODE_V8_COVERAGE` set in the environment rstest runs in** reaches every forked worker AND every child a test
 *   spawns (probe: both read it). Each child writes raw V8 coverage when it exits; the workers leave no raw file of
 *   their own, and the rstest process's own file names no repo source the report covers.
 * - **Converted by rstest's OWN converter, never c8's.** `CoverageProvider.resolveRawCoverage` turned a child's raw
 *   coverage of `capture-status.mjs` into 116 statements, 16 functions and 44 branches: exactly rstest's own report
 *   entry for that file. c8's units differ (a median 4.94x per file on #1315), so converting with c8 and merging would
 *   add numbers measured in two units.
 * - **Folded onto rstest's OWN maps by start position, never merged as a second map.** Measured on the whole suite at
 *   `0f48ac1e`: istanbul's map merge DOUBLED the statement maps of 103 of 244 files, because a file the suite also imports
 *   has an in-process entry whose end columns differ from the child's (e.g. `None` against `100`), so each statement
 *   arrived twice and every statement, function and branch denominator grew. By START position, 8,739 of 8,816 child
 *   statements, all 2,041 functions and 3,078 of 3,094 branches sit on a structure rstest already has. Child hits are
 *   added to those; the rest are COUNTED as unmatched and not added, so every denominator stays rstest's own.
 * - **Filtered by the provider's OWN include and exclude, the options that built the report.** `resolveRawCoverage`
 *   drops an entry outside them (measured: a child's coverage of a file outside `include` never reaches the map), so a
 *   child that ran a file outside `.c8rc.json`'s population adds nothing and the threshold's population holds. This
 *   file keeps no second copy of that rule: an earlier filter of its own was redundant with it, and a mutation
 *   removing that filter survived.
 * - **The population comes from `.c8rc.json`, passed on rstest's command line** (`--coverage.include` and
 *   `--coverage.exclude` repeat), so the rstest config is unchanged and the two tools cannot drift apart on it.
 *
 * Since #3578 this is a library, not a command: `runChildCoverage` is the whole run, and a repository calls it from its own
 * coverage script (a11ign's is `scripts/coverage.mjs`). Which flag guard to use and how to start rstest are that repository's,
 * so they are arguments here and not imports.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CoverageProvider } from "@rstest/coverage-v8";

/**
 * The slice of istanbul's `CoverageMap` this file reads, written out here and NOT `ReturnType<CoverageProvider["createCoverageMap"]>`:
 * that type reaches `@rstest/coverage-v8`'s own `.d.ts`, which imports `istanbul-lib-coverage` types the package lists only as a
 * devDependency, so a consumer with `skipLibCheck: false` failed TS7016 inside a package it did not write (measured in a clean
 * consumer, #3578). `CoverageProvider` is still a runtime import; it just no longer shows in the published declarations.
 */
export type CoverageMap = {
  getCoverageSummary(): { toJSON(): Record<"lines" | "statements" | "functions" | "branches", { covered: number; total: number; pct: number }> };
  merge(other: unknown): void;
  toJSON(): unknown;
  files(): string[];
  fileCoverageFor(file: string): { toJSON(): unknown };
};
export type C8Population = { include: string[]; exclude: string[] };
export type ChildEntry = { url: string; filePath: string; functions: unknown[]; scriptId?: string };

/** The options this file hands rstest's coverage provider, by name: the provider's own option type is not published in our declarations. */
export type CoverageOptions = {
  enabled: true;
  provider: "v8";
  include: string[];
  exclude: string[];
  reporters: string[];
  reportsDirectory: string;
  clean: true;
  allowExternal: false;
  reportOnFailure: true;
};

/**
 * rstest's coverage options for `.c8rc.json`'s own population -- read, never retyped. `reportOnFailure`, because the
 * suite has a host-dependent failure (no Chrome) and a coverage report is still the answer to a coverage question.
 */
export function coverageOptionsFromC8rc(c8rc: C8Population, reportsDirectory: string): CoverageOptions {
  return {
    enabled: true, provider: "v8", include: [...c8rc.include], exclude: [...c8rc.exclude],
    reporters: ["json"], reportsDirectory, clean: true, allowExternal: false, reportOnFailure: true,
  };
}

/** The same options as `rstest run` flags. Include and exclude REPEAT, one flag per pattern. */
export function rstestCoverageArgs(options: CoverageOptions): string[] {
  return [
    "--coverage", "--coverage.provider", options.provider,
    ...options.include.flatMap((pattern) => ["--coverage.include", pattern]),
    ...options.exclude.flatMap((pattern) => ["--coverage.exclude", pattern]),
    ...options.reporters.flatMap((reporter) => ["--coverage.reporters", reporter]),
    "--coverage.reportsDirectory", options.reportsDirectory,
    "--coverage.reportOnFailure",
  ];
}

/**
 * `root` itself or a path BENEATH it -- never a sibling that shares the prefix (reviewer on #1403: `/repo-other/x.mjs`
 * starts with `/repo` and is not inside it). The boundary is a path separator.
 */
const isInside = (filePath: string, root: string): boolean => filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Every repo script a child ran, from `NODE_V8_COVERAGE`'s raw files, as the provider's entries. Only `file:` URLs
 * under `root` and outside `node_modules`; a query string (`?fresh-import=...`) is not part of the path.
 */
export function childCoverageEntries(rawDir: string, root: string): ChildEntry[] {
  const entries: ChildEntry[] = [];
  for (const name of readdirSync(rawDir).filter((file) => file.endsWith(".json"))) {
    const { result = [] } = JSON.parse(readFileSync(join(rawDir, name), "utf8"));
    for (const script of result as { url: string; functions: unknown[] }[]) {
      if (!script.url.startsWith("file:")) continue;
      const filePath = fileURLToPath(script.url.split("?")[0]);
      if (!isInside(filePath, root) || filePath.includes(`${sep}node_modules${sep}`)) continue;
      entries.push({ ...script, url: pathToFileURL(filePath).href, filePath });
    }
  }
  return entries;
}

type Located = { start: { line: number; column: number | null } };
/** One file's istanbul coverage data: the statement, function and branch maps and their hit counts. */
export type FileData = {
  statementMap: Record<string, Located>;
  s: Record<string, number>;
  fnMap: Record<string, { decl: Located; loc: Located }>;
  f: Record<string, number>;
  branchMap: Record<string, { loc: Located; locations: unknown[] }>;
  b: Record<string, number[]>;
};

/** A structure's start, as a key. */
const startOf = (located: Located): string => `${located.start.line}:${located.start.column}`;

/** The first id at each start. */
function idsByStart(map: Record<string, Located>): Map<string, string> {
  const byStart = new Map<string, string>();
  for (const [id, located] of Object.entries(map)) if (!byStart.has(startOf(located))) byStart.set(startOf(located), id);
  return byStart;
}

/**
 * ONE FILE: the child's hits added onto rstest's OWN statement, function and branch maps, matched by START position.
 * The base's maps are kept whole, so no denominator moves; a child structure with no base structure at its start
 * (or a branch with a different arm count) is counted in `unmatched`, not added. Pure: neither input is modified.
 * `base` is rstest's entry and `child` the converted child coverage of the same file.
 */
export function foldByStart(base: FileData, child: FileData): { data: FileData; unmatched: Unmatched } {
  const data = structuredClone(base);
  const unmatched = { statements: 0, functions: 0, branches: 0 };
  const statementAt = idsByStart(data.statementMap);
  for (const [id, located] of Object.entries(child.statementMap)) {
    const target = statementAt.get(startOf(located));
    if (target === undefined) unmatched.statements += 1; else data.s[target] += child.s[id];
  }
  const functionAt = idsByStart(Object.fromEntries(Object.entries(data.fnMap).map(([id, fn]) => [id, fn.decl])));
  for (const [id, fn] of Object.entries(child.fnMap)) {
    const target = functionAt.get(startOf(fn.decl));
    if (target === undefined) unmatched.functions += 1; else data.f[target] += child.f[id];
  }
  const branchAt = idsByStart(Object.fromEntries(Object.entries(data.branchMap).map(([id, br]) => [id, br.loc])));
  for (const [id, branch] of Object.entries(child.branchMap)) {
    const target = branchAt.get(startOf(branch.loc));
    if (target === undefined || data.b[target].length !== child.b[id].length) { unmatched.branches += 1; continue; }
    data.b[target] = data.b[target].map((hits, arm) => hits + child.b[id][arm]);
  }
  return { data, unmatched };
}

/** How many child structures found no base structure at their start, by kind. */
export type Unmatched = { statements: number; functions: number; branches: number };

/**
 * THE MERGE: rstest's report, with what children covered converted by rstest's own provider (under the options that
 * built the report) and FOLDED onto each file's existing entry by `foldByStart`. A child file the report does not list
 * has no entry to fold onto and adds nothing, so the report's population and every denominator are unchanged.
 */
export async function mergeChildCoverage(
  { report, entries, options, root }: { report: Record<string, FileData>; entries: ChildEntry[]; options: CoverageOptions; root: string },
): Promise<{ merged: CoverageMap; childFiles: string[]; unmatched: Unmatched }> {
  const provider = new CoverageProvider(options as never, root);
  const children = entries.length > 0 ? await provider.resolveRawCoverage([{ entries, root }]) : null;
  // A CLONE, not a spread: istanbul's `CoverageMap.merge` keeps the object it is given BY REFERENCE and later merges
  // rewrite it in place. Measured on #1350: a second map merged onto the caller's entry changed the caller's own
  // `s` from 4 statements to 8, and a test reading its expectation after the call agreed with the mutated value.
  const folded = structuredClone(report);
  const childFiles: string[] = [];
  const unmatched = { statements: 0, functions: 0, branches: 0 };
  for (const file of children?.files() ?? []) {
    if (!(file in report)) continue;
    const result = foldByStart(folded[file], children!.fileCoverageFor(file).toJSON() as FileData);
    folded[file] = result.data;
    childFiles.push(file);
    for (const kind of ["statements", "functions", "branches"] as const) unmatched[kind] += result.unmatched[kind];
  }
  const merged = provider.createCoverageMap();
  merged.merge(folded as never);
  return { merged, childFiles, unmatched };
}

type Metric = { covered: number; total: number; pct: number };

/** Lines, statements, functions and branches for a map, in rstest's units. */
export function coverageTotals(map: CoverageMap): Record<"lines" | "statements" | "functions" | "branches", Metric> {
  const summary = map.getCoverageSummary().toJSON();
  const pick = ({ covered, total, pct }: Metric): Metric => ({ covered, total, pct });
  return { lines: pick(summary.lines), statements: pick(summary.statements), functions: pick(summary.functions),
    branches: pick(summary.branches) };
}

/**
 * What a repository decides about one coverage run: where it is, which population, and how its rstest is started.
 * `population` is `.c8rc.json`'s parsed `include` and `exclude`; `rstest` is the command and the arguments BEFORE the coverage
 * flags, e.g. `pnpm exec rstest run --config <path>` (#492: a bare "pnpm" spawn is ENOENT on windows-2022, so the repository
 * resolves it).
 */
export type ChildCoverageRun = { root: string; population: C8Population; rstest: { command: string; args: string[] } };

/**
 * The whole run: rstest under coverage with `NODE_V8_COVERAGE` set, the children's coverage folded in, the merged report
 * written beside rstest's own as `coverage-final.merged.json`. Returns rstest's own exit status, or 2 when it wrote no report.
 */
export async function runChildCoverage({ root, population, rstest }: ChildCoverageRun): Promise<number> {
  const reportsDirectory = join(root, "coverage", "rstest");
  const options = coverageOptionsFromC8rc(population, reportsDirectory);
  const rawDir = realpathSync(mkdtempSync(join(tmpdir(), "rstest-child-coverage-")));
  const run = spawnSync(rstest.command, [...rstest.args, ...rstestCoverageArgs(options)],
    { cwd: root, stdio: "inherit", env: { ...process.env, NODE_V8_COVERAGE: rawDir } });
  const reportPath = join(reportsDirectory, "coverage-final.json");
  if (!existsSync(reportPath)) {
    process.stderr.write(`merge-child-coverage: rstest wrote no ${reportPath} (exit ${run.status}) -- nothing to merge.\n`);
    return 2;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const alone = new CoverageProvider(options as never, root).createCoverageMap();
  alone.merge(report);
  const before = coverageTotals(alone);
  const { merged, childFiles, unmatched } = await mergeChildCoverage(
    { report, entries: childCoverageEntries(rawDir, root), options, root });
  writeFileSync(join(reportsDirectory, "coverage-final.merged.json"), JSON.stringify(merged.toJSON()));
  process.stdout.write(`merge-child-coverage: ${childFiles.length} file(s) gained child-process coverage; `
    + `not folded (no base structure at the start): ${JSON.stringify(unmatched)}.\n`
    + `  rstest alone: ${JSON.stringify(before)}\n  merged:       ${JSON.stringify(coverageTotals(merged))}\n`);
  rmSync(rawDir, { recursive: true, force: true });
  return run.status ?? 1;
}
