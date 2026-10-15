/**
 * #5333: A RELEASE GATE'S REFUSAL NAMES AN OPEN OWNING ROW. A `REFUSED ... #<n>` line that points at a closed issue fails here, naming the script and the number.
 *
 * Acceptance: `node --test src/refusal-owners-are-open.test.ts`.
 *
 * The reader is driven on fixtures only: `readIssueState` takes a runner here, so nothing spawns `gh` and no live issue is read. The live read is the
 * caller's to run, with its own repository. POSITIVE CONTROLS sit beside the emptiness assertions: every `failures` assertion has its passing twin on the
 * same fixture, and `refusalsInTree` is read over a tree this file writes, whose refusals it must find.
 */
// no-token: gh -- the fixtures spawn nothing: `readIssueState` takes a runner, and every answer below is written in this file
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describe, failures, findings, ownersOf, readIssueState, refusalsInPackageJson, refusalsInTree, refusalsInWorkflow,
  type IssueRef, type StateRead,
} from "./refusal-owners-are-open.ts";

/** The rows of the 2026-10-12 string: the owner it named (closed that day), the change it cites, and the one `package.json` names now. */
const OLD_OWNER = 5179;
const CITED_CHANGE = 5087;
const CURRENT_OWNER = 4425;
/** Two owners of a workflow fixture, and the number a path fragment test expects to survive. */
const WORKFLOW_CLOSED = 222;
const WORKFLOW_OPEN = 333;
const SURVIVOR = 90;
const SHARED_OWNER = 7;

/** `a11ign/lab`'s `gate:core-held` as it reads today: the same class, with a QUALIFIED owner. */
const LAB_CORE_HELD =
  'node -e "console.error(\\"REFUSED: \\" + process.argv.slice(1).join(\\", \\") + \\" are held by a11ign/a11ign (the core) and this repository cannot run them: '
  + "this chain does not claim they passed. Run them from the core checkout; "
  + 'whether a release may proceed without them is a11ign/a11ign#5179.\\"); process.exit(1)"';

/** The string `package.json` carried on 2026-10-12, as the shell command it parses to. */
const LAB_HELD_2026_10_12 =
  'node -e "console.error(\\"REFUSED: \\" + process.argv.slice(1).join(\\", \\") + \\" are held by a11ign/lab since ADR 0045 cut 9 (#5087), '
  + "and this repository cannot run them: this chain does not claim they passed. Run them from the lab checkout; "
  + 'whether a release may proceed without them is #5179.\\"); process.exit(1)"';

const packageJson = (command: string) => JSON.stringify({ scripts: { "gate:lab-held": command, build: "tsc" } });
const stateOf = (states: Record<number, StateRead["code"]>) => ({ number }: IssueRef): StateRead => ({
  code: states[number] ?? "CANNOT_TELL",
  why: `fixture says #${number} is ${states[number] ?? "unknown"}`,
});
const bare = (number: number): IssueRef => ({ repo: null, number });
const read = (command: string, states: Record<number, StateRead["code"]>) =>
  findings(refusalsInPackageJson("package.json", packageJson(command)), stateOf(states));

test("a REFUSED line whose owner is CLOSED fails, naming the script and the number (the 2026-10-12 string)", () => {
  const bad = failures(read(LAB_HELD_2026_10_12, { [CITED_CHANGE]: "CLOSED", [OLD_OWNER]: "CLOSED" }));
  assert.equal(bad.length, 1, "one owner, #5179; the closed #5087 is a citation and is not read");
  assert.equal(bad[0].number, OLD_OWNER);
  const line = describe(bad[0]);
  assert.match(line, /package\.json script "gate:lab-held"/);
  assert.match(line, /#5179 as its owner, and #5179 is CLOSED/);
});

test("the same fixture with the owner OPEN passes (the control for the test above)", () => {
  const all = read(LAB_HELD_2026_10_12, { [CITED_CHANGE]: "CLOSED", [OLD_OWNER]: "OPEN" });
  assert.deepEqual(failures(all), []);
  assert.deepEqual(all.map((finding) => [finding.number, finding.code]), [[OLD_OWNER, "OPEN"]]);
});

test("an owner that could not be read is CANNOT_TELL and fails, never open", () => {
  const bad = failures(read(LAB_HELD_2026_10_12, {}));
  assert.deepEqual(bad.map((finding) => [finding.number, finding.code]), [[OLD_OWNER, "CANNOT_TELL"]]);
  assert.match(describe(bad[0]), /#5179 is CANNOT_TELL \(fixture says #5179 is unknown\)/);
});

test("a (#n) citation is not an owner: an open citation cannot rescue a closed owner, a closed one cannot fail an open owner", () => {
  assert.deepEqual(ownersOf("held since cut 9 (#5087), and (#1, #2) too, (a11ign/a11ign#3). The open row is #4425."), [bare(CURRENT_OWNER)]);
  const closedOwnerOpenCitation = failures(read(LAB_HELD_2026_10_12, { [CITED_CHANGE]: "OPEN", [OLD_OWNER]: "CLOSED" }));
  assert.deepEqual(closedOwnerOpenCitation.map((finding) => finding.number), [OLD_OWNER]);
});

test("an owner reworded into parentheses is a REFUSED string with no owner, which fails", () => {
  const reworded = LAB_HELD_2026_10_12.replace("is #5179.", "is (#5179).");
  const bad = failures(read(reworded, { [CITED_CHANGE]: "OPEN", [OLD_OWNER]: "OPEN" }));
  assert.deepEqual(bad.map((finding) => [finding.number, finding.code]), [[null, "NAMES_NO_OWNER"]]);
  assert.match(describe(bad[0]), /package\.json script "gate:lab-held": the refusal names no row as its owner/);
});

test("`$#`, a word-tail, a hyphenated tag and an HTML entity are not issue numbers", () => {
  assert.deepEqual(ownersOf("[ $# -eq 1 ] abc#34 tag-#56 &#78; #90 and #90"), [bare(SURVIVOR)]);
});

test("a qualified owner is read in ITS repository: the lab's gate:core-held (#5179, closed) fails, and passes with the owner open", () => {
  const refusals = refusalsInPackageJson("package.json", packageJson(LAB_CORE_HELD));
  assert.deepEqual(refusals.flatMap((refusal) => ownersOf(refusal.text)), [{ repo: "a11ign/a11ign", number: OLD_OWNER }]);
  const closed = failures(findings(refusals, stateOf({ [OLD_OWNER]: "CLOSED" })));
  assert.equal(describe(closed[0]), 'package.json script "gate:lab-held": REFUSED names a11ign/a11ign#5179 as its owner, and a11ign/a11ign#5179 is CLOSED');
  assert.deepEqual(failures(findings(refusals, stateOf({ [OLD_OWNER]: "OPEN" }))), []);
});

test("a path#n is read as a qualified reference and is CANNOT_TELL, loudly, never a silent pass", () => {
  assert.deepEqual(ownersOf("see docs/x.md#12"), [{ repo: "docs/x.md", number: 12 }]);
  assert.equal(readIssueState("o/r", () => { throw new Error("gh: HTTP 404"); })({ repo: "docs/x.md", number: 12 }).code, "CANNOT_TELL");
});

test("a script without REFUSED is not a refusal, and one with it is found with its text after the marker", () => {
  const found = refusalsInPackageJson("package.json", packageJson(LAB_HELD_2026_10_12));
  assert.deepEqual(found.map((refusal) => refusal.where), ['script "gate:lab-held"']);
  assert.ok(found[0].text.startsWith(': \\" + process.argv'), "the text is what follows the marker, not the command's head");
});

const WORKFLOW = [
  "jobs:",
  "  release:",
  "    steps:",
  "      # REFUSED: a comment about a refusal, owned by #111, which is prose and is not read",
  '      - run: echo "::error::the hold did not run; the owner is #222. Nothing published."',
  '      - run: echo "REFUSED: no chain runs this; the open row is #333."',
  '      - run: echo "::error::npm is below 11.5.1. Nothing published."',
].join("\n");

test("release.yml: ::error and REFUSED lines are read with their line, comments are not, and an ownerless ::error is no finding", () => {
  const refusals = refusalsInWorkflow(".github/workflows/release.yml", WORKFLOW);
  assert.deepEqual(refusals.map((refusal) => [refusal.where, refusal.kind]),
    [["line 5", "::error"], ["line 6", "REFUSED"], ["line 7", "::error"]]);
  const all = findings(refusals, stateOf({ [WORKFLOW_CLOSED]: "CLOSED", [WORKFLOW_OPEN]: "OPEN" }));
  assert.deepEqual(all.map((finding) => [finding.refusal.where, finding.number, finding.code]),
    [["line 5", WORKFLOW_CLOSED, "CLOSED"], ["line 6", WORKFLOW_OPEN, "OPEN"]]);
  assert.match(describe(failures(all)[0]), /release\.yml line 5: ::error names #222 as its owner, and #222 is CLOSED/);
});

test("an owner two refusals name is asked about once", () => {
  const asked: number[] = [];
  const refusals = refusalsInWorkflow("release.yml", 'echo "REFUSED: a, owner #7"\necho "::error::b, owner #7"');
  findings(refusals, ({ number }) => { asked.push(number); return { code: "OPEN", why: "" }; });
  assert.deepEqual(asked, [SHARED_OWNER]);
});

test("refusalsInTree reads package.json and release.yml under the root it is given, and finds both", () => {
  const root = mkdtempSync(join(tmpdir(), "refusal-owners-tree-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "package.json"), packageJson(LAB_HELD_2026_10_12));
  writeFileSync(join(root, ".github/workflows/release.yml"), WORKFLOW);
  const found = refusalsInTree(root);
  assert.deepEqual(found.map((refusal) => [refusal.file, refusal.where]), [
    ["package.json", 'script "gate:lab-held"'],
    [".github/workflows/release.yml", "line 5"],
    [".github/workflows/release.yml", "line 6"],
    [".github/workflows/release.yml", "line 7"],
  ]);
});

test("the live reader maps what GitHub answers: open, closed, anything else and a failed call", () => {
  const answering = (stdout: string) => readIssueState("o/r", () => stdout)(bare(OLD_OWNER));
  assert.equal(answering("open\n").code, "OPEN");
  assert.equal(answering("closed\n").code, "CLOSED");
  // Neither word: an unexpected body is not a reading in either direction.
  assert.equal(answering("transferred").code, "CANNOT_TELL");
  assert.equal(answering("").code, "CANNOT_TELL");
  const failing = readIssueState("o/r", () => { throw new Error("gh: HTTP 404\nsecond line"); })(bare(OLD_OWNER));
  assert.equal(failing.code, "CANNOT_TELL");
  assert.match(failing.why, /o\/r#5179 could not be read: Error: gh: HTTP 404$/, "the reason is the first line of the failure, with the repository and number");
  // A bare `#n` is asked of the repository the caller passed, and a qualified reference of ITS repository, not that one.
  const asked: string[][] = [];
  const ask = readIssueState("o/r", (args) => { asked.push(args); return "open"; });
  ask(bare(OLD_OWNER));
  ask({ repo: "a11ign/lab", number: OLD_OWNER });
  assert.deepEqual(asked, [
    ["api", "repos/o/r/issues/5179", "--jq", ".state"],
    ["api", "repos/a11ign/lab/issues/5179", "--jq", ".state"],
  ]);
});
