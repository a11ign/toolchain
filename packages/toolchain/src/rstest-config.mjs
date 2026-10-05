// @ts-check

/**
 * #1318, STEP 2 OF THE RSTEST ADOPTION (#1317): THE SAME FILES `npm run test:ts` RUNS, WITH NONE OF THEM EDITED. Since #3578 (ADR 0043,
 * Decision 3) this is the ONE shared config every a11ign repository calls through `defineToolchainConfig`, parameterised by what differs
 * per repository; a11ign's own `scripts/rstest/rstest.config.mjs` is a thin call into it.
 *
 * Every setting below was measured on #1315's spike before it was kept, and the ones that were tried and
 * rejected are recorded here so nobody re-adds them:
 *
 * - **`node:test` reaches the shim through a Node resolve hook, not through rstest.** rstest does not bundle
 *   Node built-ins; it leaves them to Node ("Rstest currently preserves Node.js native semantics",
 *   `guide/debug/troubleshooting.mdx`). So `resolve.alias: { "node:test": … }` never saw the import (the real
 *   node:test ran every test and rstest reported "No test suites found"), and neither did an Rspack
 *   `NormalModuleReplacementPlugin` added through `tools.rspack` (the hook ran; the shim never loaded). The
 *   hook in `register-node-test-alias.mjs` is passed to every worker through the documented `pool.execArgv`.
 * - **`forks`, and isolated.** `isolate: false` shares module evaluation and process state across files, and
 *   `threads` has no `process.chdir` and a thread-local `process.exit`. In this suite 92 test files spawn
 *   processes (50 of them git or gh), 24 write `process.env`, and 11 use `process.exit` or signals.
 * - **A build cache in CI only (#1319).** Locally `performance.buildCache` measured 64.0 s cold and 63.9 s warm
 *   against 63.9 s without it, because the build is under 1% of the run (#1315), so it stays off here. The chairman
 *   asked for it in CI, where `reusable-build-test.yml` persists it with `actions/cache`, prints HIT or MISS, and fails
 *   the job when a run leaves it empty. rstest writes it under `node_modules/.cache/rstest-<project-name>`.
 *   `buildCache: false` writes nothing: in @rstest/core 0.11.12, `normalizeBuildCache` returns false for a falsy value
 *   and the adapter maps `false` to `false`. The one local cache seen while building #1319 came from a MUTATION that forced
 *   it on, which wrote into the primary checkout's shared node_modules. So `A11Y_RSTEST_CACHE_DIR`, when set, moves an
 *   enabled cache to that directory (rstest's documented `cacheDirectory`), and a test that runs rstest sets it to a
 *   temporary root. CI does not set it, so CI's cache stays where `reusable-build-test.yml` persists it.
 * - **Workers capped at half the host's cores locally, rstest's default in CI (#1319, ceo's ruling).** The `agents` host
 *   runs eight sessions and two reviewers, and a whole-suite run at one worker per core is a write to a shared resource.
 *   Measured 2026-09-13 22:49Z: a mutation handed rstest an empty include, it ran the whole suite with 92 worker
 *   processes, and the load average reached 64.65. A GitHub runner is not shared, so CI keeps rstest's own default.
 * - **A RUN RECORD ON DISK, ONE FILE PER RUN (#2199).** A whole-suite run printed the failing test's file and name only
 *   into the terminal that ran it, and a first `test:org` reporting `failedTests: 1` followed by four green runs could
 *   not be identified nine hours later. rstest's `json` reporter writes them (`JsonReporterOptions.outputPath`,
 *   `@rstest/core@0.11.12`), and this config adds it to EVERY run, green ones too, because a record written only on
 *   failure cannot tell "green" from "never ran" (#2165's finding, one field over). THE PATH IS DISTINCT PER RUN and that
 *   is the answer to the shared-resource question, not a preference: last-run-wins would have overwritten the very red
 *   run the four green ones followed, which is the incident. The name is `<worktree>-<UTC stamp>-<pid>.json` under
 *   `node_modules/.cache/rstest-run-records`, already ignored (a symlinked `node_modules` is covered too, #1983), so a run
 *   leaves `git status` unchanged and no untracked file reaches `versionBumpPaths` (#2057). The newest
 *   `RUN_RECORDS_KEPT` of THIS worktree's records are kept, so a busy host does not fill its disk; a file is a few MB on
 *   a whole-suite run. `A11Y_RSTEST_RECORD_DIR` moves the directory, for a test that must not write into the shared one.
 *   A run started inside a worker (`RSTEST_WORKER_ID`) records only when that variable names a directory: see `reportersFor`.
 * - **Setting `reporters` SWITCHES OFF rstest's agent default, so this file re-makes that choice (#2199).** rstest sets
 *   `reporters: ["md"]` for an agent session only when the config has none (`initCli`, `9710~0.js`), and `determineAgent`
 *   is not exported. `agentReporterFor` mirrors its variable table, so an agent session keeps the markdown report whose
 *   Summary `rstest-report-is-not-the-verdict.test.ts` pins. THREE of rstest's twelve agents are matched by a regex on
 *   `PATH`, `EDITOR` or `TERM_PROGRAM` (pi, devin, kiro) and are NOT mirrored: a session of those gets the default
 *   reporter, which is a change in what is printed and never in a verdict or the record.
 * - **AN AGENT SESSION'S REPORT ENDS IN A VERDICT LINE AND CARRIES ONLY WHAT FAILED (#2541).** The markdown report says
 *   `"status": "pass"` over a run that matched nothing, and the direct form of the command never passes through
 *   `assert-glob-not-empty.mjs`, so `verdict-reporter.mjs` is the LAST reporter and prints `VERDICT pass: 154 tests in 11
 *   files`, or `VERDICT REFUSED: 0 tests run`. The failure blocks use the `compact` preset and no candidate files (no
 *   code frames, no stack, no list of files the trace touched), which is the trim a session's context pays for; `A11Y_RSTEST_FULL_REPORT=1` gives the whole
 *   report back, and the verdict line names that flag. **CI is not trimmed** (`isCi`): an Acceptance and a PR body quote
 *   the CI log as evidence. The `json` record is written either way. A pass is already 44 lines, so it is not touched.
 * - **No coverage block here.** Coverage is step 4 of the adoption, not this one.
 */
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FULL_REPORT_FLAG, createVerdictReporter } from "./verdict-reporter.mjs";

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ root: string, env: Env, now: Date, pid: number }} RunIdentity
 * @typedef {NonNullable<import("@rstest/core").RstestConfig["reporters"]> & unknown[]} Reporters
 */

/**
 * A SIBLING FILE OF THIS ONE, as a path. The hook is loaded by path (`pool.execArgv`), and the same name is right in the source
 * (`src/`) and in the built package (`dist/`), where each entry is a `.mjs`. Made by string, not `new URL("./x", import.meta.url)`:
 * Rslib reads that shape as an asset and copies the file into `dist/static/assets/` instead of leaving it a sibling.
 * @param {string} name
 * @returns {string}
 */
function siblingPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

/**
 * #1319: whether `CI` names a CI run. GitHub Actions sets `CI=true`. An unset, empty or `false` value is a local run.
 * It decides two settings below: the build cache (on in CI, where #1315 measured no benefit locally) and the worker cap
 * (off in CI, on locally, where the host is shared).
 * @param {Env} env
 * @returns {boolean}
 */
function isCi(env) {
  return env.CI !== undefined && env.CI !== "" && env.CI !== "false";
}

/**
 * #1319: the build cache setting. Off unless CI. When on, `A11Y_RSTEST_CACHE_DIR` moves it out of node_modules.
 * @param {Env} env
 * @returns {false | true | { cacheDirectory: string }}
 */
function buildCacheFor(env) {
  if (!isCi(env)) return false;
  return env.A11Y_RSTEST_CACHE_DIR ? { cacheDirectory: env.A11Y_RSTEST_CACHE_DIR } : true;
}

/** #2199: how many of one worktree's run records survive the next run. */
const RUN_RECORDS_KEPT = 50;

/**
 * #2199: the variables rstest's `determineAgent` reads, less the three it matches by regex. `AI_AGENT` is handled
 * separately because rstest takes its VALUE as the agent's name.
 */
const AGENT_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE", "REPL_ID", "GEMINI_CLI", "CODEX_SANDBOX", "CODEX_THREAD_ID",
  "OPENCODE", "AUGMENT_AGENT", "GOOSE_PROVIDER", "JUNIE_DATA", "JUNIE_SHIM_PATH", "CURSOR_AGENT"];

/**
 * #2199: the console reporter rstest would have picked had this file named none. `RSTEST_NO_AGENT=1` switches the agent
 * report off before anything else is read, exactly as `determineAgent` does.
 * @param {Env} env
 * @returns {"md" | "default"}
 */
function agentReporterFor(env) {
  if (env.RSTEST_NO_AGENT === "1") return "default";
  return env.AI_AGENT || AGENT_VARIABLES.some((name) => env[name]) ? "md" : "default";
}

/**
 * #2199: this run's record file, a name no other run shares, and the pruning that keeps the directory bounded. The
 * stamp sorts as time, so the oldest of a worktree's records are the first names in sort order.
 * @param {RunIdentity} run
 * @returns {string}
 */
function runRecordPathFor({ root, env, now, pid }) {
  const dir = env.A11Y_RSTEST_RECORD_DIR || join(root, "node_modules", ".cache", "rstest-run-records");
  const worktree = basename(root);
  if (existsSync(dir)) {
    const mine = readdirSync(dir).filter((name) => name.startsWith(`${worktree}-`) && name.endsWith(".json")).sort();
    for (const stale of mine.slice(0, Math.max(0, mine.length - (RUN_RECORDS_KEPT - 1)))) rmSync(join(dir, stale));
  }
  return join(dir, `${worktree}-${now.toISOString().replaceAll(/[:.]/g, "-")}-${pid}.json`);
}

/**
 * #2541: whether this run's console report is the TRIMMED one -- an agent session, outside CI, that did not ask for the
 * whole report. CI keeps rstest's own markdown preset because what it prints is quoted as evidence.
 * @param {Env} env
 * @returns {boolean}
 */
function trimsReport(env) {
  return agentReporterFor(env) === "md" && !isCi(env) && !env[FULL_REPORT_FLAG];
}

/**
 * #2199: the reporters of this run, in the order rstest runs them: the console report, then the record, then #2541's
 * verdict line, which has to come last to be the last line. A run started INSIDE an rstest worker -- a test that spawns
 * rstest to measure it, of which the suite has dozens -- writes no record unless it was told where, because it is not a
 * session's run and each one would push a real record out of the bounded directory: one whole-suite run would evict the
 * previous fifty, red one included, which is the incident. rstest sets `RSTEST_WORKER_ID` in every worker it forks.
 * @param {RunIdentity} run
 * @returns {Reporters}
 */
function reportersFor(run) {
  const agent = agentReporterFor(run.env) === "md";
  const trimmed = trimsReport(run.env);
  /** @type {unknown[]} */
  const console = agent ? [["md", trimmed ? { preset: "compact", candidateFiles: false } : { preset: "normal" }]] : ["default"];
  /** @type {unknown[]} */
  const record = run.env.RSTEST_WORKER_ID && !run.env.A11Y_RSTEST_RECORD_DIR ? [] : [["json", { outputPath: runRecordPathFor(run) }]];
  // #3572: `verify` reads the counts of the run it started from here. TOP-LEVEL RUNS ONLY, and under its own name rather than
  // `A11Y_RSTEST_RECORD_DIR`: that variable is the switch that makes a run inside a worker record, and a test that spawns rstest
  // (the suite has dozens) inherited it and left fourteen records beside the one `verify` meant to read.
  const summary = run.env.A11Y_RSTEST_SUMMARY_FILE && !run.env.RSTEST_WORKER_ID ? [["json", { outputPath: run.env.A11Y_RSTEST_SUMMARY_FILE }]] : [];
  const verdict = agent ? [createVerdictReporter({ hint: trimmed ? `full report: ${FULL_REPORT_FLAG}=1` : undefined })] : [];
  return /** @type {Reporters} */ ([...console, ...record, ...summary, ...verdict]);
}

/**
 * #3572: WHAT A `--changed` RUN CANNOT SEE, AND SO MUST RERUN EVERYTHING FOR. `rstest run --changed=<rev>` selects the tests whose
 * module graph reaches a changed file, and nothing else: a file read by PATH, a lockfile, a tsconfig and a preloaded hook are in no
 * graph. Naming `forceRerunTriggers` REPLACES rstest's default (`config.forceRerunTriggers ?? merged.forceRerunTriggers`, `z~0.js`
 * in @rstest/core 0.12.3), so the default's two patterns are repeated here and a change to either still widens the run. The list
 * only applies to a `--changed` run: every other run of this config is unchanged by it.
 *
 * WHAT THIS PACKAGE KNOWS, AND A REPOSITORY ADDS TO: `**\/package.json/**` and `**\/rstest.config.*` are rstest's own two (measured at
 * `040c643ba`: a 17-file diff holding `package.json` and the lockfile named 699 test files), and the lockfile, the workspace file,
 * `.npmrc` and every tsconfig are what no test imports in any repository. WHAT ONLY THE REPOSITORY KNOWS -- the data files its tests
 * read by path, and the files its worker preloads -- it passes as `forceRerunTriggers`.
 */
const SHARED_RERUN_TRIGGERS = ["**/package.json/**", "**/rstest.config.*", "pnpm-lock.yaml", "pnpm-workspace.yaml", "**/.npmrc",
  "**/tsconfig*.json"];

/** #1319: half the host's cores, at least one -- the most a local run may take of a host other sessions share. */
const LOCAL_WORKER_CAP = Math.max(1, Math.floor(availableParallelism() / 2));

/**
 * What differs between repositories; everything else in the config is the same everywhere (ADR 0043, Decision 3).
 * - `root`: the repository root, where the run records are kept and what rstest resolves `include` against.
 * - `include`: the test files, as the glob `npm run test:ts` hands to `node:test`, so "the same number of test files run" is checkable.
 * - `preloads`: extra `--import` paths for every worker, after this package's own hook. Each is a PATH, never a bare specifier.
 * - `forceRerunTriggers`: triggers beyond the shared ones that widen a `--changed` run to the whole suite.
 * - `run`: the process environment and identity of this run, injectable so a test can drive the record path without a real run.
 * @typedef {{ root: string, include: string[], preloads?: string[], forceRerunTriggers?: string[],
 *            run?: { env?: Env, now?: Date, pid?: number } }} ToolchainOptions
 */

/**
 * The one shared rstest config, as a plain object a repository exports.
 * @param {ToolchainOptions} options
 * @returns {import("@rstest/core").RstestConfig}
 */
export function defineToolchainConfig({ root, include, preloads = [], forceRerunTriggers = [], run = {} }) {
  const env = run.env ?? process.env;
  const registerHook = siblingPath("register-node-test-alias.mjs");
  return {
    root,
    include,
    testEnvironment: "node",
    // A repository's own preloads follow the hook. a11ign's `walk-scope.mjs` is the example: it is PRELOADED into every worker, for
    // #1349. It installs its observer on import, and rstest bundles a second copy into each test that imports it. Measured by
    // worker-judge on #1349: named imports such as `readFile` from `node:fs/promises`, `openSync`, `readdir` and `spawnSync`
    // are seen only when a copy loaded before rstest's module graph shares one per-process state with the bundled copies.
    // The shared state is #1349's; the `preloads` option is the half that lives here. Measured across all 550 files at
    // 021563f6, before #1349: the preload changed no result. The only differences were three live GitHub tests
    // refused by an exhausted GraphQL budget during that run.
    pool: { type: "forks", execArgv: ["--import", registerHook, ...preloads.flatMap((path) => ["--import", path])],
      ...(isCi(env) ? {} : { maxWorkers: LOCAL_WORKER_CAP }) },
    // The shim reads rstest's collecting runtime from globalThis rather than importing a second copy of it.
    globals: true,
    // node:test has no default timeout. rstest defaults `testTimeout` to 5_000 and `hookTimeout` to 10_000, and
    // documents `0` as disabling each (`config/test/test-timeout.mdx`, `hook-timeout.mdx`). Under the defaults
    // three tests timed out on the spike's first run.
    testTimeout: 0,
    hookTimeout: 0,
    performance: { buildCache: buildCacheFor(env) },
    reporters: reportersFor({ root, env, now: run.now ?? new Date(), pid: run.pid ?? process.pid }),
    forceRerunTriggers: [...SHARED_RERUN_TRIGGERS, ...forceRerunTriggers],
  };
}
