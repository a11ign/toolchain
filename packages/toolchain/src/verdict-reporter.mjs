// @ts-check

/**
 * #2541: THE LAST LINE OF AN AGENT SESSION'S RSTEST REPORT, NAMING WHAT RAN AND REFUSING ZERO.
 *
 * rstest's markdown report over a run that matched no test says `"status": "pass"` with `"tests": 0`, exactly as it says
 * it over a run of five thousand (measured 2026-09-25, rstest 0.11.12). `assert-glob-not-empty.mjs` refuses an empty
 * glob before the runner starts, but the direct form every Acceptance and every hand run uses,
 * `npx rstest run --config scripts/rstest/rstest.config.mjs --include <file>`, never goes through it. A session that
 * reads "pass" over zero tests writes "the mutant survived" (#2165), so the line lives in the report itself.
 *
 * "RAN" IS PASSED PLUS FAILED. A skipped or todo test executed nothing, so a run of nothing but skips is refused too,
 * and says how many it skipped. The verdict is DERIVED FROM THE RESULTS rstest hands every reporter, never parsed out of
 * another reporter's text, so it does not depend on which console report precedes it.
 *
 * It says nothing about the exit code and does not change it: rstest already exits 1 for a run with no test file, and
 * whether a run of only skips should also exit 1 is not this file's decision.
 */

/** The variable that gives an agent session rstest's full markdown report again. Named in the verdict line it trims for. */
export const FULL_REPORT_FLAG = "A11Y_RSTEST_FULL_REPORT";

/** @param {number} count @param {string} noun */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * @typedef {{ status: string }} Outcome
 * @param {{ results: Outcome[], testResults: Outcome[], unhandledErrors?: unknown[] }} run rstest's `onTestRunEnd` arguments
 * @returns {string} one line, starting `VERDICT`, without the hint
 */
export function verdictLine({ results, testResults, unhandledErrors = [] }) {
  /** @param {string} status */
  const count = (status) => testResults.filter((test) => test.status === status).length;
  const failed = count("fail");
  const ran = failed + count("pass");
  const failedFiles = results.filter((file) => file.status === "fail").length;
  const skipped = count("skip") + count("todo");
  const files = plural(results.length, "file");
  if (failed > 0 || failedFiles > 0 || unhandledErrors.length > 0) {
    // A file that fails with no failing test in it (it would not load) is the one a count of tests cannot show.
    const also = [failed === 0 && failedFiles > 0 && `${plural(failedFiles, "file")} failed`,
      unhandledErrors.length > 0 && plural(unhandledErrors.length, "unhandled error")].filter(Boolean);
    return `VERDICT fail: ${failed} of ${plural(ran, "test")} failed in ${files}${also.map((part) => `, ${part}`).join("")}`;
  }
  if (ran === 0) return `VERDICT REFUSED: 0 tests run${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
  return `VERDICT pass: ${plural(ran, "test")} in ${files}${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
}

/**
 * A reporter that prints the verdict line and nothing else. It must be the LAST reporter in the list: rstest awaits
 * each reporter's `onTestRunEnd` in order, so the line lands after the report and after the json reporter's
 * "JSON report written to" line.
 * @param {{ hint?: string, write?: (text: string) => void }} [options] `hint` is appended to the line, for a report that was trimmed
 * @returns {{ onTestRunEnd: (run: { results: Outcome[], testResults: Outcome[], unhandledErrors?: unknown[] }) => void }}
 */
export function createVerdictReporter({ hint, write = (text) => process.stdout.write(text) } = {}) {
  return {
    onTestRunEnd(run) {
      write(`${verdictLine(run)}${hint ? ` -- ${hint}` : ""}\n`);
    },
  };
}
