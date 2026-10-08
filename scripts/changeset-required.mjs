// @ts-check
// command: decide whether a pull request that changes a releasable path carries a changeset or a `no-release:` line
// THE DECISION OF `.github/workflows/changeset-required.yml`, kept in a script so a test can run it (a11ign/a11ign#4127), as
// `release-per-merge.mjs` holds the logic of `release-per-merge.yml`. The workflow only gathers the inputs.
//
// THE CLASS: a pull request changes a package's shipped code, carries no changeset, and merges; nothing then releases it (screenreader-worker#25 and
// #26, a11ign/a11ign#4084). It FAILS a pull request when BOTH hold:
//   1. its diff touches a file under a releasable path, test files excluded; and
//   2. it ADDS no changeset, and its body carries no `no-release: <reason>` line.
//
// TEST FILES DO NOT COUNT: a test is not shipped (`files` excludes them in agent-org), so a test-only change releases nothing. The rule is the glob
// `*.test.*` / `*.spec.*`, not `npm pack`, because a shared check cannot know a repository's `files`.
// "NEW" MEANS ADDED IN THE DIFF: editing, deleting or renaming within `.changeset/` leaves the existing changeset where it was, already released or not.
// A CHANGESET IS `.changeset/<name>.md`, directly in the directory and not README.md: changesets reads nothing else, so a `.txt` or a nested file added
// there would clear the check and release nothing.
// A RENAME COUNTS BOTH WAYS for the releasable test (moving code out of `src/` is a change to what ships), and as an addition only when it comes
// from outside `.changeset/`.
//
// FOUR RULES HERE ARE COPIED, NOT SHARED: `TEST_FILE`, the releasable-path prefix test (`shipped`), `NO_RELEASE_LINE` and `PLACEHOLDER`. The copy is `isShipped` and
// `noReleaseReason` in `src/release-behind-main.mjs` of a11ign/agent-org (a11ign/agent-org#402, a11ign/a11ign#4128), which restates them to read a commit on `main` where this reads a pull
// request's diff. A runtime dependency of the gate on a CI script was rejected there, so nothing links the two but a case table on each side: this file's is "the four rules agree with
// agent-org's `release-behind-main`" in `changeset-required.test.ts`. A change to one of the four goes red there, and moves that file's table in agent-org with it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `GET /pulls/{n}/files` stops at 3000 files; a list that long may have been cut, and a pass read off a cut list is a guess. */
export const FILE_LIST_LIMIT = 3000;
const SHOWN = 5;
const TEST_FILE = /\.(test|spec)\.[^/]*$/;
const CHANGESET_FILE = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const NO_RELEASE_LINE = /^[ \t]*no-release:[ \t]*(.*?)[ \t]*$/;
const PLACEHOLDER = "<reason>";

/** @typedef {{ filename: string, status: string, previous_filename?: string }} ChangedFile */

/**
 * The input is ONE string because a reusable workflow's inputs cannot be lists. An entry with no trailing slash is a directory, and a leading `./` is
 * dropped: neither would otherwise match anything, and a check whose paths match nothing passes every pull request.
 * @param {string} paths @returns {string[]}
 */
export function parseReleasablePaths(paths) {
  const entries = paths
    .split(/[\s,]+/)
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter(Boolean)
    .map((entry) => (entry.endsWith("/") ? entry : `${entry}/`));
  if (entries.length === 0) throw new Error("releasable-paths names no path, so the check would pass every pull request: pass the repository's dora releasablePaths, space-separated");
  return entries;
}

/** @param {string} body @returns {string | null} the reason of the first `no-release:` line that has one, else null */
export function noReleaseReason(body) {
  for (const line of body.split(/\r?\n/)) {
    const reason = NO_RELEASE_LINE.exec(line)?.[1];
    if (reason && reason !== PLACEHOLDER) return reason;
  }
  return null;
}

/** @param {string} path @param {string[]} releasablePaths */
const shipped = (path, releasablePaths) => !TEST_FILE.test(path) && releasablePaths.some((entry) => path.startsWith(entry));

/** @param {ChangedFile} file @param {string[]} releasablePaths @returns {string[]} the paths of this file that are releasable */
function releasableNamesOf(file, releasablePaths) {
  return [file.filename, file.previous_filename ?? ""].filter((path) => path && shipped(path, releasablePaths));
}

/** @param {ChangedFile} file */
function addsAChangeset(file) {
  const arrivedFromElsewhere = file.status === "added" || (file.status === "renamed" && !CHANGESET_FILE.test(file.previous_filename ?? ""));
  return arrivedFromElsewhere && CHANGESET_FILE.test(file.filename);
}

/** @param {string[]} names @returns {string} */
function listed(names) {
  const rest = names.length - SHOWN;
  return names.slice(0, SHOWN).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/**
 * @param {{ files: ChangedFile[], body: string, releasablePaths: string[] }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function decide({ files, body, releasablePaths }) {
  if (files.length >= FILE_LIST_LIMIT) return { ok: false, reason: `the pull request lists ${files.length} files, and the API stops at ${FILE_LIST_LIMIT}, so the list may be cut and this cannot be judged: add a changeset or a \`no-release: <reason>\` line` };
  const releasable = [...new Set(files.flatMap((file) => releasableNamesOf(file, releasablePaths)))];
  if (releasable.length === 0) return { ok: true, reason: `no non-test file changed under ${releasablePaths.join(" ")}` };
  if (files.some(addsAChangeset)) return { ok: true, reason: "the pull request adds a changeset" };
  const reason = noReleaseReason(body);
  if (reason) return { ok: true, reason: `the body says no-release: ${reason}` };
  return {
    ok: false,
    reason: `${releasable.length} releasable file(s) changed (${listed(releasable)}) and the pull request adds no .changeset/<name>.md and its body has no \`no-release: <reason>\` line. Nothing would release this: add a changeset (\`pnpm exec changeset\`), or a body line \`no-release: <why nothing should ship>\`.`,
  };
}

/** @param {string} text JSON lines, as `gh api --paginate --jq '.[] | {filename, status, previous_filename}'` prints them @returns {ChangedFile[]} */
export function parseFileList(text) {
  const files = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (files.length === 0) throw new Error("the file list has no files: a pull request that changes nothing is not this check's to pass, and an API that returned nothing must not read as a pass");
  return files;
}

function main() {
  const listPath = process.env.FILES_JSONL;
  if (!listPath) throw new Error("FILES_JSONL is not set: it names the file holding the pull request's changed files, one JSON object per line");
  const verdict = decide({
    files: parseFileList(readFileSync(listPath, "utf8")),
    body: process.env.PR_BODY ?? "",
    releasablePaths: parseReleasablePaths(process.env.RELEASABLE_PATHS ?? ""),
  });
  if (!verdict.ok) console.log(`::error title=changeset-required::${verdict.reason}`);
  console.log(`VERDICT ${verdict.ok ? "pass" : "fail"}: ${verdict.reason}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
