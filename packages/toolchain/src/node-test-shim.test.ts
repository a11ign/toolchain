/**
 * MOVED HERE FROM a11ign's `packages/lab/src/packaging/node-test-shim-options.test.ts` (a11ign/a11ign#3578), the test follows the code.
 *
 * #1383: the node:test shim (`node-test-shim.ts`, #1318) REFUSES an option it cannot map, by name --
 * never drops it. From worker-judge's review of #1380: `describe(name, options, fn)` discarded its options, and the
 * test adapter mapped only `skip`, `todo` and `timeout` and dropped the rest. Unused in 553 test files today, each was
 * a pass-for-the-wrong-reason waiting for its first use: a dropped `describe("x", { skip: true }, …)` RUNS under
 * rstest what node:test skips.
 *
 * Driven with injected registrars, because the shim's own `test`/`describe` need rstest's runtime ("Rstest API
 * 'test' is not registered yet" outside it). The resolve hook is driven in a child `node --import`, so it is never
 * registered inside this test process, and it is the BUILT hook and shim, `dist/`, that it drives: those are the files a worker loads
 * from `node_modules`, and `pnpm test` builds first (`pretest`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adapt, describeOn, MAPPED_TEST_OPTIONS } from "./node-test-shim.ts";

type Call = { how: "test" | "skip" | "todo"; name: string; timeout?: unknown };

/** A stand-in for rstest's `test`: records every registration, runs nothing. */
function recordingRegister() {
  const calls: Call[] = [];
  const register = Object.assign(
    (name: string, _body: unknown, timeout?: unknown) => { calls.push({ how: "test", name, timeout }); },
    {
      skip: (name: string) => { calls.push({ how: "skip", name }); },
      todo: (name: string) => { calls.push({ how: "todo", name }); },
    },
  );
  return { register, calls };
}

const body = () => {};

for (const option of ["concurrency", "only", "plan"]) {
  test(`#1383: test(name, { ${option} }, fn) is REFUSED by name -- never dropped, never registered`, () => {
    const { register, calls } = recordingRegister();
    assert.throws(() => adapt(register)("a test", { [option]: true }, body),
      new RegExp(`test\\(\\) option "${option}"\` is not mapped onto rstest`), `the refusal names "${option}"`);
    assert.deepEqual(calls, [], "nothing was registered: a refused test does not run as a different one");
  });
}

test("#1383: an option node:test may add later is refused too -- the rule is the mapped list, not a known-bad list", () => {
  const { register, calls } = recordingRegister();
  assert.throws(() => adapt(register)("a test", { skip: false, signal: {}, retries: 2 }, body),
    /test\(\) option "signal", "retries"` is not mapped onto rstest/, "every unmapped key is named, and a mapped one beside them is not");
  assert.deepEqual(calls, []);
  assert.deepEqual([...MAPPED_TEST_OPTIONS], ["skip", "todo", "timeout"], "exactly these three map");
});

test("#1383 CONTROL: the mapped options still map, and no options at all still registers", () => {
  const { register, calls } = recordingRegister();
  const run = adapt(register);
  run("skipped", { skip: true }, body);
  run("todo", { todo: true }, body);
  run("timed", { timeout: 500 }, body);
  run("plain", body);
  run("empty options", {}, body);
  assert.deepEqual(calls, [
    { how: "skip", name: "skipped" },
    { how: "todo", name: "todo" },
    { how: "test", name: "timed", timeout: 500 },
    { how: "test", name: "plain", timeout: undefined },
    { how: "test", name: "empty options", timeout: undefined },
  ]);
});

test("#1383: describe(name, { skip: true }, fn) is REFUSED by name -- node:test skips it, so it must never RUN", () => {
  const described: string[] = [];
  const describe = describeOn({ describe: (name: string) => { described.push(name); } });
  assert.throws(() => describe("a suite", { skip: true }, body), /describe\(\) option "skip"` is not mapped onto rstest/);
  assert.throws(() => describe("a suite", { concurrency: 2, only: true }, body),
    /describe\(\) option "concurrency", "only"` is not mapped onto rstest/);
  assert.deepEqual(described, [], "the suite was never registered, so it cannot run");
});

test("#1383 CONTROL: describe(name, fn) and describe(name, {}, fn) still register the suite with its function", () => {
  const described: Array<[string, unknown]> = [];
  const describe = describeOn({ describe: (name: string, fn: unknown) => { described.push([name, fn]); } });
  describe("plain", body);
  describe("empty options", {}, body);
  assert.deepEqual(described, [["plain", body], ["empty options", body]]);
});

test("#1383: the resolve hook redirects node:test to the shim, and leaves a bare `test` to Node", () => {
  const hook = fileURLToPath(new URL("../dist/register-node-test-alias.mjs", import.meta.url));
  const shim = new URL("../dist/node-test-shim.mjs", import.meta.url).href;
  const resolveUnderHook = (specifier: string) => execFileSync(process.execPath, ["--import", hook, "--input-type=module", "-e",
    `try { process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)})); } catch (e) { process.stdout.write("THREW " + e.code); }`],
  { encoding: "utf8" });
  assert.equal(resolveUnderHook("node:test"), shim, "the positive control: the hook is live and still redirects node:test");
  const bare = resolveUnderHook("test");
  assert.notEqual(bare, shim, "a bare `test` is not captured -- node:test has no unprefixed form");
  assert.equal(bare, "THREW ERR_MODULE_NOT_FOUND", "with no npm package named test installed, Node itself reports it missing");
});
