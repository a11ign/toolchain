/**
 * The shared config's promises, driven through its injectable `run` (env, clock, pid) so no real rstest run is needed. Moved in part from
 * a11ign's `test-verdict-line.test.ts` and `rstest-run-record-on-disk.test.ts` (a11ign/a11ign#3578): what those pin about the CONFIG lives
 * here, and what they pin about a11ign's own wrapper stays there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineToolchainConfig } from "./rstest-config.ts";

const AGENT = { CLAUDECODE: "1" };
const NOW = new Date("2026-10-05T12:00:00.000Z");
const PID = 4242;

/** The kind of each reporter, in order: a name, or `verdict` for the object reporter. */
function reporterKinds(env: Record<string, string | undefined>, recordDir: string): string[] {
  const config = defineToolchainConfig({
    root: "/tmp/probe-root", include: ["**/*.test.ts"], run: { env: { ...env, A11Y_RSTEST_RECORD_DIR: recordDir }, now: NOW, pid: PID },
  });
  return (config.reporters as unknown[]).map((r) => (Array.isArray(r) ? String(r[0]) : typeof r === "string" ? r : "verdict"));
}

test("the verdict reporter is LAST for an agent and absent otherwise; a plain run keeps rstest's default and the record", () => {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-config-"));
  try {
    assert.deepEqual(reporterKinds(AGENT, dir), ["md", "json", "verdict"]);
    assert.deepEqual(reporterKinds({ ...AGENT, RSTEST_WORKER_ID: "1" }, dir).at(-1), "verdict", "a nested run keeps it");
    assert.deepEqual(reporterKinds({}, dir), ["default", "json"], "CONTROL: a plain run has none");
    assert.deepEqual(reporterKinds({ ...AGENT, RSTEST_NO_AGENT: "1" }, dir), ["default", "json"], "RSTEST_NO_AGENT switches the agent report off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the run record is one file per run: its name carries the worktree, the stamp and the pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-config-"));
  try {
    const config = defineToolchainConfig({ root: "/tmp/probe-root", include: [], run: { env: { A11Y_RSTEST_RECORD_DIR: dir }, now: NOW, pid: PID } });
    const [, options] = (config.reporters as unknown[][]).find((r) => Array.isArray(r) && r[0] === "json") as [string, { outputPath: string }];
    assert.equal(options.outputPath, join(dir, `probe-root-2026-10-05T12-00-00-000Z-${PID}.json`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run inside an rstest worker writes no record unless it was told where", () => {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-config-"));
  try {
    const nested = defineToolchainConfig({ root: "/tmp/probe-root", include: [], run: { env: { RSTEST_WORKER_ID: "1" }, now: NOW, pid: PID } });
    assert.ok(!(nested.reporters as unknown[]).some((r) => Array.isArray(r) && r[0] === "json"), "no json reporter");
    assert.ok(reporterKinds({ RSTEST_WORKER_ID: "1" }, dir).includes("json"), "CONTROL: the same run, told where, records");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build cache is on in CI only, and A11Y_RSTEST_CACHE_DIR moves it", () => {
  const cache = (env: Record<string, string>) => defineToolchainConfig({ root: "/r", include: [], run: { env } }).performance?.buildCache;
  assert.equal(cache({}), false);
  assert.equal(cache({ CI: "false" }), false);
  assert.equal(cache({ CI: "true" }), true);
  assert.deepEqual(cache({ CI: "true", A11Y_RSTEST_CACHE_DIR: "/cache" }), { cacheDirectory: "/cache" });
});

test("every worker preloads the alias hook first, then the repository's own preloads, and the rerun triggers are the shared ones plus its own", () => {
  const config = defineToolchainConfig({ root: "/r", include: ["a"], preloads: ["/p/one.mjs"], forceRerunTriggers: ["data/**"], run: { env: {} } });
  const execArgv = (config.pool as { execArgv: string[] }).execArgv;
  assert.equal(execArgv[0], "--import");
  assert.match(execArgv[1], /register-node-test-alias\.mjs$/, "a sibling `.mjs` of the config, because Node cannot strip types under node_modules");
  assert.deepEqual(execArgv.slice(2), ["--import", "/p/one.mjs"]);
  assert.ok(config.forceRerunTriggers?.includes("pnpm-lock.yaml"), "a shared trigger");
  assert.ok(config.forceRerunTriggers?.includes("data/**"), "the repository's own");
  assert.equal(config.testTimeout, 0, "node:test has no default timeout");
  assert.equal(config.globals, true, "the shim reads rstest's runtime from globalThis");
});
