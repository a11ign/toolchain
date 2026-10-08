/**
 * #2541, moved from a11ign (a11ign/a11ign#3578): `verdictLine` reads a run the way rstest's own markdown report does not, and refuses zero.
 * a11ign's `test-verdict-line.test.ts` also drives REAL rstest runs through its shipped config; that half stays with the repository whose
 * config it is, and `rstest-config.test.ts` here pins where the reporter sits in the list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerdictReporter, FULL_REPORT_FLAG, verdictLine } from "./verdict-reporter.ts";

const THREE_TESTS = 3;
const file = (status: string) => ({ status });
const pass = (count: number) => Array.from({ length: count }, () => ({ status: "pass" }));

test("verdictLine reads a run the way the report does not (1)", () => {
  assert.equal(verdictLine({ results: [file("pass"), file("pass")], testResults: pass(THREE_TESTS) }), "VERDICT pass: 3 tests in 2 files");
  assert.equal(verdictLine({ results: [], testResults: [] }), "VERDICT REFUSED: 0 tests run");
  assert.equal(verdictLine({ results: [file("skip")], testResults: [{ status: "skip" }, { status: "todo" }] }),
    "VERDICT REFUSED: 0 tests run (2 skipped)");
  assert.equal(verdictLine({ results: [file("fail")], testResults: [{ status: "fail" }, { status: "pass" }] }),
    "VERDICT fail: 1 of 2 tests failed in 1 file");
  assert.equal(verdictLine({ results: [file("fail")], testResults: [] }), "VERDICT fail: 0 of 0 tests failed in 1 file, 1 file failed",
    "a file that failed to load has no failing test, and is still not a pass and not a refusal for emptiness");
  assert.equal(verdictLine({ results: [file("pass")], testResults: pass(1), unhandledErrors: [new Error("x")] }),
    "VERDICT fail: 0 of 1 test failed in 1 file, 1 unhandled error", "an error outside any test fails the run");
});

test("the reporter writes the verdict line and nothing else, with the hint after the line when one is given", () => {
  const written: string[] = [];
  const run = { results: [file("pass")], testResults: pass(1) };
  createVerdictReporter({ write: (text) => written.push(text) }).onTestRunEnd(run);
  createVerdictReporter({ hint: `full report: ${FULL_REPORT_FLAG}=1`, write: (text) => written.push(text) }).onTestRunEnd(run);
  assert.deepEqual(written, [
    "VERDICT pass: 1 test in 1 file\n",
    `VERDICT pass: 1 test in 1 file -- full report: ${FULL_REPORT_FLAG}=1\n`,
  ]);
});
