/**
 * THE APPROVAL WORKFLOW'S OWN CASES (A11-254, under A11-251). Every job is the one `generateDependabotAuto()` writes, parsed from its YAML, with its
 * `if:` evaluated and each `run:` step run by bash against a recorded `gh` (`dependabot-auto.fixtures/harness.ts`), so a case shows what the
 * committed workflow does and not what a copy of it would. `jq`, `awk`, `sed` and `bash` are the real ones; the fake `gh` records the
 * arguments and the token each call was made with, so a case can tell the approving identity from the queueing one.
 *
 * A case that says "not approved" asserts that NO review was submitted and NO dispatch was made, with a positive control beside it (the same
 * pull request, made eligible, IS approved), so an always-skipping job cannot pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  APPROVE_POLICY_FILE, AUTO_ARM_FILE, DEPENDABOT_ACTOR_ID, DEPENDABOT_AUTO_FILE, GUARD_POLICY_FILE, autoProblems, findOtherApprovers, generateDependabotAuto,
  readAutoFiles, verifyPolicies, type AutoFiles,
} from "./dependabot-auto.ts";
import { APPROVAL_MARKER, LOG_PATTERNS } from "./dependabot-auto-scripts.ts";
import { jobOf, withJob, type Call, type Context, type JobRun, type Route } from "./dependabot-auto.fixtures/harness.ts";

const FIXTURES = fileURLToPath(new URL("./dependabot-auto.fixtures/", import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, "utf8");

const REPO = "a11ign/toolchain";
const HEAD = "a".repeat(40);
const json = (value: unknown): string => JSON.stringify(value);

// ---- the pull request a case runs on -----------------------------------------------------------------------------------------------------

type Commit = { author: string | null; committer: string | null; verified: boolean };
const commit = ({ author, committer, verified }: Commit) => ({ author: author === null ? null : { login: author }, committer: committer === null ? null : { login: committer }, commit: { verification: { verified } } });
const DEPENDABOTS_COMMIT: Commit = { author: "dependabot[bot]", committer: "web-flow", verified: true };
const A_PERSONS_COMMIT: Commit = { author: "octocat", committer: "web-flow", verified: true };

type Pull = { actor?: string; author?: string; base?: string; fork?: boolean; action?: string };
function pullRequest({ actor = "dependabot[bot]", author = "dependabot[bot]", base = "main", fork = false, action = "opened" }: Pull = {}): Context {
  return {
    github: {
      event_name: "pull_request_target", actor, repository: REPO, token: "TOKEN-github",
      event: { action, pull_request: { number: 5, user: { login: author }, base: { ref: base }, head: { sha: HEAD, repo: { full_name: fork ? "octocat/toolchain" : REPO } } } },
    },
  };
}

const PULL = `repos\\/${REPO}\\/pulls\\/5`;
type Approval = { commits?: Commit[][]; reviews?: unknown[]; head?: string; dispatch?: Route };
/** The answers `approve` needs: the commits (one list per read, the last repeating), the reviews on the pull request, and what the dispatch says. */
function approvalRoutes({ commits = [[DEPENDABOTS_COMMIT]], reviews = [], head = HEAD, dispatch = { match: /^workflow run auto-arm\.yml /, stdout: "" } }: Approval = {}): Route[] {
  return [
    { match: new RegExp(`^api --paginate ${PULL}\\/commits$`), stdoutSequence: commits.map((list) => json(list.map(commit))) },
    { match: new RegExp(`^api --paginate ${PULL}\\/reviews$`), stdout: json(reviews) },
    { match: new RegExp(`^api ${PULL}$`), stdout: json({ head: { sha: head } }) },
    { match: new RegExp(`^api -X POST ${PULL}\\/reviews `), stdout: json({ id: 77 }) },
    { match: new RegExp(`^api -X PUT ${PULL}\\/reviews\\/\\d+\\/dismissals `), stdout: "{}" },
    dispatch,
  ];
}

const reviewsSubmitted = (calls: Call[]): Call[] => calls.filter(({ line }) => / -f event=APPROVE /.test(line));
const dispatches = (calls: Call[]): Call[] => calls.filter(({ line }) => line.startsWith("workflow run auto-arm.yml"));
const dismissals = (calls: Call[]): Call[] => calls.filter(({ line }) => / -X PUT .*\/dismissals /.test(line));

function approve(metadata: Record<string, string>, pull: Pull = {}, routes: Approval = {}): JobRun {
  return withJob("approve", { context: pullRequest(pull), metadata, routes: approvalRoutes(routes) }, (run) => run);
}

const PATCH = { "update-type": "version-update:semver-patch", "package-ecosystem": "npm_and_yarn" };
const MINOR = { "update-type": "version-update:semver-minor", "package-ecosystem": "npm_and_yarn" };

function assertApprovedAndQueued(run: JobRun, kind: string): void {
  assert.equal(run.code, 0, run.stderr);
  const [review] = reviewsSubmitted(run.calls);
  assert.ok(review, "a review was submitted");
  assert.equal(review.token, "TOKEN-dependabot-approve", "the review is made with the approving identity, and with nothing else");
  assert.match(review.line, new RegExp(`^api -X POST ${PULL}/reviews -f event=APPROVE -f commit_id=${HEAD} -f body=`));
  assert.ok(review.argv.some((arg) => arg.startsWith(`body=${APPROVAL_MARKER}`) && arg.includes(`a ${kind} update`)), "the body carries the marker and names the update type it read");
  const [queued] = dispatches(run.calls);
  assert.ok(queued, "the pull request was handed to auto-arm");
  assert.equal(queued.line, `workflow run auto-arm.yml --repo ${REPO} --ref main -f pr=5`);
  assert.equal(queued.token, "TOKEN-dependabot-guard", "the dispatch is made with the guard identity, which cannot review");
  assert.deepEqual(run.minted, ["dependabot-approve", "dependabot-guard"]);
}

// ---- patch and minor are approved and queued ----------------------------------------------------------------------------------------------

test("a Dependabot semver-patch is approved with the approving token and handed to arm-approved", () => {
  assertApprovedAndQueued(approve(PATCH), "patch");
});

test("a Dependabot semver-minor is approved and queued; so is a grouped pull request, which fetch-metadata reports at its highest type", () => {
  assertApprovedAndQueued(approve(MINOR), "minor");
  assertApprovedAndQueued(approve({ ...MINOR, "dependency-group": "npm-minor-and-patch" }), "minor");
});

test("a GitHub Actions update that moves a SHA (no update type) or a minor is approved and queued", () => {
  assertApprovedAndQueued(approve({ "update-type": "", "package-ecosystem": "github_actions" }), "actions");
  assertApprovedAndQueued(approve({ "update-type": "version-update:semver-minor", "package-ecosystem": "github_actions" }), "minor");
  assertApprovedAndQueued(approve({ "update-type": "version-update:semver-patch", "package-ecosystem": "github_actions" }), "patch");
});

// ---- a major is never approved ---------------------------------------------------------------------------------------------------------

function assertNotApproved(run: JobRun, why: RegExp): void {
  assert.equal(run.code, 0, `skipping is not a failure: ${run.stderr}`);
  assert.deepEqual(reviewsSubmitted(run.calls), [], "no review was submitted");
  assert.deepEqual(dispatches(run.calls), [], "nothing was handed to auto-arm");
  assert.ok(!run.minted.includes("dependabot-approve"), "the approving token was not even minted");
  assert.match(run.stdout, why, "the skip says why");
}

test("a major is not approved, npm or Actions, and says why; the same pull request as a minor is (positive control)", () => {
  assertNotApproved(approve({ "update-type": "version-update:semver-major", "package-ecosystem": "npm_and_yarn" }), /::notice::dependabot-auto: not approving #5: it is a major update \(npm_and_yarn\)/);
  assertNotApproved(approve({ "update-type": "version-update:semver-major", "package-ecosystem": "github_actions" }), /it is a major update \(github_actions\)/);
  assertApprovedAndQueued(approve(MINOR), "minor");
});

test("an update with no type outside Actions, or a type that is neither patch nor minor, is not approved", () => {
  assertNotApproved(approve({ "update-type": "", "package-ecosystem": "npm_and_yarn" }), /names no update type for a npm_and_yarn update/);
  assertNotApproved(approve({ "update-type": "version-update:semver-prerelease", "package-ecosystem": "npm_and_yarn" }), /neither a patch nor a minor/);
  assertNotApproved(approve({ "update-type": "", "package-ecosystem": "npm\nyarn" }), /names no update type for a unknown update/);
});

// ---- a pull request that is not Dependabot's is not approved -----------------------------------------------------------------------------

test("another author, another actor, a fork, another base and another event never start the job", () => {
  const refused: Pull[] = [{ author: "octocat" }, { actor: "octocat" }, { fork: true }, { base: "release" }, { actor: "dependabot[bot]", author: "octocat" }];
  for (const pull of refused) {
    const run = approve(PATCH, pull);
    assert.equal(run.ran, false, JSON.stringify(pull));
    assert.deepEqual(run.calls, []);
  }
  const otherEvent = pullRequest();
  (otherEvent.github as { event_name: string }).event_name = "workflow_run";
  assert.equal(withJob("approve", { context: otherEvent, metadata: PATCH, routes: approvalRoutes() }, (run) => run.ran), false);
  assert.equal(approve(PATCH).ran, true, "positive control: the same pull request from Dependabot starts it");
});

test("a pull request Dependabot opened is not approved when any commit on it is not Dependabot's: another author, an unverified commit, another committer, no commit", () => {
  const strangers: Commit[][] = [
    [DEPENDABOTS_COMMIT, A_PERSONS_COMMIT],
    [A_PERSONS_COMMIT],
    [{ ...DEPENDABOTS_COMMIT, verified: false }],
    [{ ...DEPENDABOTS_COMMIT, committer: "octocat" }],
    [{ author: null, committer: "web-flow", verified: true }],
    [{ author: "dependabot[bot]", committer: null, verified: true }],
    [],
  ];
  for (const commits of strangers) assertNotApproved(approve(PATCH, {}, { commits: [commits] }), /a commit on it is not Dependabot's/);
  assertApprovedAndQueued(approve(PATCH, {}, { commits: [[DEPENDABOTS_COMMIT, { ...DEPENDABOTS_COMMIT, committer: "dependabot[bot]" }]] }), "patch");
});

test("a commit that arrives while the approval is being made takes the approval back, and nothing is queued", () => {
  const run = approve(PATCH, {}, { commits: [[DEPENDABOTS_COMMIT], [DEPENDABOTS_COMMIT], [DEPENDABOTS_COMMIT, A_PERSONS_COMMIT]] });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(reviewsSubmitted(run.calls).length, 1, "the approval was made");
  assert.equal(dismissals(run.calls).length, 1, "and taken back");
  assert.match(dismissals(run.calls)[0].line, /reviews\/77\/dismissals/);
  assert.deepEqual(dispatches(run.calls), []);
  assert.deepEqual(run.minted, ["dependabot-approve"]);
});

test("a head that moved on from the commit the run read is left to the run for the new head", () => {
  const run = approve(PATCH, {}, { head: "b".repeat(40) });
  assert.deepEqual(reviewsSubmitted(run.calls), []);
  assert.match(run.stdout, /its head moved on/);
});

test("a pull request this workflow already approved at this commit is not approved twice, but is still handed to auto-arm", () => {
  const ours = { id: 41, user: { login: "octo-sts[bot]" }, state: "APPROVED", commit_id: HEAD, body: `${APPROVAL_MARKER}\nApproved` };
  const run = approve(PATCH, {}, { reviews: [ours] });
  assert.deepEqual(reviewsSubmitted(run.calls), []);
  assert.equal(dispatches(run.calls).length, 1);
  const aPersons = { ...ours, id: 42, user: { login: "octocat" }, commit_id: "c".repeat(40) };
  assert.equal(reviewsSubmitted(approve(PATCH, {}, { reviews: [aPersons, { ...ours, commit_id: "c".repeat(40) }] }).calls).length, 1, "an approval at another commit, or by another reviewer, does not count");
});

test("auto-arm that declares no pr input is a notice; any other dispatch failure is red", () => {
  const unexpected = { match: /^workflow run auto-arm\.yml /, stderr: "HTTP 422: Unexpected inputs provided: [\"pr\"]", code: 1 };
  const old = approve(PATCH, {}, { dispatch: unexpected });
  assert.equal(old.code, 0);
  assert.match(old.stdout, /declares no pr input/);
  const refused = approve(PATCH, {}, { dispatch: { match: /^workflow run auto-arm\.yml /, stderr: "HTTP 403: Resource not accessible", code: 1 } });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Resource not accessible/);
});

// ---- withdraw ------------------------------------------------------------------------------------------------------------------------

const OURS = { id: 1, user: { login: "octo-sts[bot]" }, state: "APPROVED", commit_id: HEAD, body: `${APPROVAL_MARKER}\nApproved` };
const REVIEWS_ON_THE_PULL_REQUEST = [
  OURS,
  { ...OURS, id: 2, user: { login: "octocat" } },
  { ...OURS, id: 3, body: "Looks good" },
  { ...OURS, id: 4, state: "DISMISSED" },
  { ...OURS, id: 5, state: "CHANGES_REQUESTED" },
];

const withdraw = (pull: Pull, commits: Commit[]): JobRun =>
  withJob("withdraw", { context: pullRequest(pull), routes: approvalRoutes({ commits: [commits], reviews: REVIEWS_ON_THE_PULL_REQUEST }) }, (run) => run);

test("a push by someone else to a Dependabot branch dismisses this workflow's approvals, and only those", () => {
  const run = withdraw({ actor: "octocat", action: "synchronize" }, [DEPENDABOTS_COMMIT, A_PERSONS_COMMIT]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.minted, ["dependabot-guard"], "withdrawing needs no approving identity");
  assert.deepEqual(dismissals(run.calls).map(({ line }) => /reviews\/(\d+)\/dismissals/.exec(line)?.[1]), ["1"], "only the review by octo-sts[bot] that carries the marker and still approves");
  assert.equal(dismissals(run.calls)[0].token, "TOKEN-dependabot-guard");
  assert.deepEqual(reviewsSubmitted(run.calls), [], "withdrawing never submits a review");
});

test("withdraw leaves the approval when every commit is Dependabot's, and does not start for Dependabot's own push, another author's pull request or another action", () => {
  assert.deepEqual(dismissals(withdraw({ actor: "octocat", action: "synchronize" }, [DEPENDABOTS_COMMIT]).calls), []);
  for (const pull of [{ actor: "dependabot[bot]", action: "synchronize" }, { actor: "octocat", action: "opened" }, { actor: "octocat", action: "synchronize", author: "octocat" }, { actor: "octocat", action: "synchronize", fork: true }]) {
    assert.equal(withdraw(pull, [A_PERSONS_COMMIT]).ran, false, JSON.stringify(pull));
  }
  assert.equal(withdraw({ actor: "octocat", action: "synchronize" }, [A_PERSONS_COMMIT]).ran, true, "positive control");
});

// ---- red -----------------------------------------------------------------------------------------------------------------------------

const RUN_ID = 900;
const ts = "2026-10-25T05:30:01.0000000Z";
const ESC = String.fromCharCode(27);
const REAL_FAILURE_LOG = [
  `${ts} ##[group]Run pnpm test`,
  `${ts} ${ESC}[31mFAIL${ESC}[0m src/a.test.ts > adds`,
  `${ts} AssertionError: expected 3 to equal 4 \`\`\`injected\`\`\``,
  `${ts} WARN deprecated foo: error prone`,
  `${ts} ##[error]Process completed with exit code 1.`,
].join("\n");
const LOST_RUNNER_LOG = [`${ts} The runner has received a shutdown signal. This can happen when the runner service is stopped.`, `${ts} ##[error]The operation was canceled.`].join("\n");
const NETWORK_LOG = [`${ts} npm error code ENOTFOUND`, `${ts} getaddrinfo ENOTFOUND registry.npmjs.org`].join("\n");
const LOST_RUNNER_BESIDE_AN_ASSERTION = [LOST_RUNNER_LOG, `${ts} FAIL src/b.test.ts > lost`].join("\n");

type Red = { event?: string; branch?: string; attempt?: number; conclusion?: string; pulls?: number[]; sha?: string };
function failedRun({ event = "pull_request", branch = "dependabot/npm_and_yarn/npm-minor-and-patch-1", attempt = 1, conclusion = "failure", pulls = [5], sha = HEAD }: Red = {}): Context {
  return {
    github: {
      event_name: "workflow_run", repository: REPO, token: "TOKEN-github",
      event: { workflow_run: { id: RUN_ID, run_attempt: attempt, conclusion, event, head_branch: branch, head_sha: sha, html_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}`, head_repository: { full_name: REPO }, pull_requests: pulls.map((number) => ({ number })) } },
    },
  };
}

const DEPENDABOTS_PULL = { user: { login: "dependabot[bot]" }, state: "open", base: { ref: "main" }, head: { sha: HEAD, repo: { full_name: REPO } } };
type Failure = { jobs?: { id: number; name: string }[]; logs?: Record<number, string>; comments?: unknown[]; pull?: unknown };
function redRoutes({ jobs = [{ id: 11, name: "checks" }], logs = {}, comments = [], pull = DEPENDABOTS_PULL }: Failure = {}): Route[] {
  const failed = jobs.map(({ id, name }) => ({ id, name, conclusion: "failure", html_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${id}` }));
  return [
    { match: new RegExp(`^api repos\\/${REPO}\\/pulls\\/5$`), stdout: json(pull) },
    { match: new RegExp(`^api --paginate repos\\/${REPO}\\/issues\\/5\\/comments$`), stdout: json(comments) },
    { match: new RegExp(`^api --paginate repos\\/${REPO}\\/actions\\/runs\\/${RUN_ID}\\/attempts\\/\\d\\/jobs$`), stdout: json({ jobs: [{ id: 1, name: "changeset", conclusion: "success" }, ...failed] }) },
    ...jobs.map(({ id }) => ({ match: new RegExp(`^api repos\\/${REPO}\\/actions\\/jobs\\/${id}\\/logs$`), stdout: logs[id] ?? REAL_FAILURE_LOG })),
    { match: /^run rerun /, stdout: "" },
    { match: /^pr comment /, stdout: "" },
  ];
}

type Done = JobRun & { body: string };
const readBody = (run: JobRun): string => (run.outputs.read?.body === undefined ? "" : readFileSync(run.outputs.read.body, "utf8"));
const red = (run: Red, failure: Failure = {}): Done => withJob("red", { context: failedRun(run), routes: redRoutes(failure) }, (done) => ({ ...done, body: readBody(done) }));
const bodyOf = (run: Done): string => run.body;
const reruns = (run: JobRun): Call[] => run.calls.filter(({ line }) => line.startsWith("run rerun"));
const comments = (run: JobRun): Call[] => run.calls.filter(({ line }) => line.startsWith("pr comment"));

test("a real failure is commented on the pull request once, with the failing job's error lines quoted as data", () => {
  const run = red({});
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(reruns(run), []);
  const [comment] = comments(run);
  assert.equal(comment.token, "TOKEN-dependabot-guard");
  assert.match(comment.line, new RegExp(`^pr comment 5 --repo ${REPO} --body-file `));
  const body = bodyOf(run);
  assert.ok(body.startsWith(`<!-- dependabot-auto:red ${HEAD} ${RUN_ID}/1 -->\n`), "the marker stops the same run being commented twice");
  assert.match(body, /### `checks`: \[the log\]\(https:\/\/github\.com\/a11ign\/toolchain\/actions\/runs\/900\/job\/11\)/);
  assert.match(body, /^FAIL src\/a\.test\.ts > adds$/m, "colour codes and the runner's timestamp are gone");
  assert.match(body, /^AssertionError: expected 3 to equal 4 /m);
  assert.doesNotMatch(body, /WARN deprecated|Process completed with exit code|##\[group\]|\d{4}-\d\d-\d\dT/, "the log's noise is not quoted");
  assert.ok(!body.includes(ESC), "nor are its colour codes");
  assert.match(body, /This is a real failure/);
});

test("the quoted lines cannot close their fence: a backtick in the log is not one in the comment", () => {
  const body = bodyOf(red({}));
  const fence = body.split("\n").filter((line) => /^`+(text)?$/.test(line));
  assert.deepEqual(fence, ["````text", "````"], "one fenced block, opened and closed by four backticks");
  assert.ok(!body.slice(body.indexOf("````text") + 8, body.lastIndexOf("````")).includes("`"), "no backtick inside it");
});

test("the same run is not commented twice: its marker on the pull request ends the job quietly", () => {
  const marked = [{ body: `<!-- dependabot-auto:red ${HEAD} ${RUN_ID}/1 -->\nearlier` }];
  const again = red({}, { comments: marked });
  assert.deepEqual(comments(again), []);
  assert.deepEqual(reruns(again), []);
  assert.match(again.stdout, /already carries the comment/);
  assert.equal(comments(red({}, { comments: [{ body: `<!-- dependabot-auto:red ${HEAD} ${RUN_ID}/2 -->` }] })).length, 1, "another attempt's marker is not this run's");
});

test("an infrastructure failure on attempt 1 is rerun once and not commented", () => {
  for (const log of [LOST_RUNNER_LOG, NETWORK_LOG]) {
    const run = red({}, { logs: { 11: log } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(reruns(run).length, 1);
    assert.equal(reruns(run)[0].line, `run rerun ${RUN_ID} --repo ${REPO} --failed`);
    assert.equal(reruns(run)[0].token, "TOKEN-dependabot-guard");
    assert.deepEqual(comments(run), []);
  }
});

test("an infrastructure failure on attempt 2 is commented, not rerun again", () => {
  const run = red({ attempt: 2 }, { logs: { 11: LOST_RUNNER_LOG } });
  assert.deepEqual(reruns(run), []);
  assert.equal(comments(run).length, 1);
  assert.match(bodyOf(run), /reads as infrastructure, but this was attempt 2/);
  assert.ok(bodyOf(run).startsWith(`<!-- dependabot-auto:red ${HEAD} ${RUN_ID}/2 -->`));
});

test("a lost-runner line beside a failing assertion is a real failure, and one real job among infrastructure ones makes the run real", () => {
  const run = red({}, { logs: { 11: LOST_RUNNER_BESIDE_AN_ASSERTION } });
  assert.deepEqual(reruns(run), []);
  assert.equal(comments(run).length, 1);
  const mixed = red({}, { jobs: [{ id: 11, name: "checks" }, { id: 12, name: "release-dry-run" }], logs: { 11: LOST_RUNNER_LOG, 12: REAL_FAILURE_LOG } });
  assert.deepEqual(reruns(mixed), []);
  assert.match(bodyOf(mixed), /### `checks`[\s\S]*### `release-dry-run`/, "every failed job is named");
});

test("gate is the roll-up of the other jobs, so it is named only when nothing else failed", () => {
  const rolledUp = red({}, { jobs: [{ id: 11, name: "checks" }, { id: 13, name: "gate" }] });
  assert.doesNotMatch(bodyOf(rolledUp), /### `gate`/);
  assert.match(bodyOf(rolledUp), /### `checks`/);
  assert.match(bodyOf(red({}, { jobs: [{ id: 13, name: "gate" }] })), /### `gate`/);
});

test("a failed run whose log has no line that names the failure says so and links the log", () => {
  const run = red({}, { logs: { 11: `${ts} all fine here\n${ts} then it stopped` } });
  assert.match(bodyOf(run), /_No line of the log names the failure; read it at the link\._/);
  assert.equal(comments(run).length, 1, "a red gate is never left silent");
});

test("at most the last 30 error lines of a job are quoted, and only the first five failed jobs are named", () => {
  const long = Array.from({ length: 50 }, (_, index) => `${ts} error number ${index}`).join("\n");
  const body = bodyOf(red({}, { logs: { 11: long } }));
  assert.match(body, /^error number 49$/m);
  assert.match(body, /^error number 20$/m);
  assert.doesNotMatch(body, /^error number 19$/m);
  const jobs = Array.from({ length: 7 }, (_, index) => ({ id: 20 + index, name: `job-${index}` }));
  const many = bodyOf(red({}, { jobs }));
  assert.match(many, /### `job-4`/);
  assert.doesNotMatch(many, /### `job-5`/);
  assert.match(many, /2 more failed job\(s\) are not quoted/);
});

test("a merge-queue entry that fails is commented on the pull request its branch names, and is not rerun", () => {
  const queue = { event: "merge_group", branch: `gh-readonly-queue/main/pr-5-${"d".repeat(40)}`, pulls: [], sha: "d".repeat(40) };
  const run = red(queue, { logs: { 11: LOST_RUNNER_LOG } });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(reruns(run), [], "the queue ejected the entry; there is no run to rerun into it");
  assert.equal(comments(run).length, 1);
  assert.ok(bodyOf(run).startsWith(`<!-- dependabot-auto:red ${"d".repeat(40)} ${RUN_ID}/1 -->`));
});

test("only a failed run for a Dependabot pull request starts the job, and only a pull request Dependabot authored is handled", () => {
  assert.equal(red({ conclusion: "success" }).ran, false);
  assert.equal(red({ branch: "feature/x" }).ran, false);
  assert.equal(red({ event: "push" }).ran, false);
  assert.equal(red({ event: "merge_group", branch: "gh-readonly-queue/main/pr-5-x", pulls: [] }).ran, true);
  for (const [name, pull] of Object.entries({ "another author": { ...DEPENDABOTS_PULL, user: { login: "octocat" } }, closed: { ...DEPENDABOTS_PULL, state: "closed" }, "another base": { ...DEPENDABOTS_PULL, base: { ref: "release" } }, fork: { ...DEPENDABOTS_PULL, head: { sha: HEAD, repo: { full_name: "octocat/toolchain" } } } })) {
    const run = red({}, { pull });
    assert.deepEqual([...reruns(run), ...comments(run)], [], name);
    assert.deepEqual(run.minted, [], `${name}: no token was minted`);
  }
  const stale = red({ sha: "e".repeat(40) });
  assert.deepEqual(comments(stale), [], "a run for a commit the pull request has moved on from is not commented");
  assert.equal(comments(red({})).length, 1, "positive control");
});

test("the log patterns are agent-org's: an error is kept, a warning, a command echo and the exit-code line are not", () => {
  const error = new RegExp(LOG_PATTERNS.ERROR_LINE, "i");
  const not = new RegExp(LOG_PATTERNS.NOT_THE_FAILURE, "i");
  for (const kept of ["AssertionError: x", "TypeError: y", "not ok 1 - z", "npm error code ELIFECYCLE", "✖ failed", "Rate limit exceeded", "timed out", "exception thrown", "cancelled"]) assert.ok(error.test(kept) && !not.test(kept), kept);
  for (const dropped of ["WARN deprecated x: error", "warning: failing soft", "##[group]error group", "##[command]npm run fail", "##[error]Process completed with exit code 1."]) assert.ok(!error.test(dropped) || not.test(dropped), dropped);
  assert.ok(new RegExp(LOG_PATTERNS.READS_OUTSIDE, "i").test("getaddrinfo EAI_AGAIN registry.npmjs.org"));
  assert.ok(new RegExp(LOG_PATTERNS.RATE_LIMIT_OR_RUNNER_LOST, "i").test("The hosted runner: Foo lost communication with the server"));
});

// ---- the workflow's own shape ---------------------------------------------------------------------------------------------------------

type Workflow = { on: Record<string, unknown>; permissions: unknown; concurrency: { group: string; "cancel-in-progress": string }; jobs: Record<string, { permissions: Record<string, string>; steps: { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }[] }> };
const workflow = parse(generateDependabotAuto()) as Workflow;
const allSteps = Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps.map((step) => ({ job, ...step })));

test("the workflow runs `main`'s copy on pull_request_target and workflow_run, never on pull_request, and holds no token by default", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request_target", "workflow_run"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["approve", "withdraw", "red"]);
});

/** A `${{ … }}` expression of the workflow evaluated over a `github` context; the two the concurrency block uses are plain JavaScript. */
function evaluate(template: string, github: unknown): unknown {
  const expression = /^\$\{\{ (.*) \}\}$/.exec(template)?.[1] ?? assert.fail(`not an expression: ${template}`);
  return new Function("github", `return ${expression.replace(/\./g, "?.")};`)(github);
}
const groupOf = (github: unknown): string => workflow.concurrency.group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression: string) => String(evaluate(`\${{ ${expression} }}`, github)));
const prEvent = (number: number) => ({ event_name: "pull_request_target", event: { pull_request: { number } } });
const ciCompleted = (id: number) => ({ event_name: "workflow_run", event: { workflow_run: { id } } });

test("pull-request events of one pull request share a group that a newer event cancels; another pull request and every ci completion do not", () => {
  const cancels = (github: unknown): unknown => evaluate(workflow.concurrency["cancel-in-progress"], github);
  assert.equal(groupOf(prEvent(5)), groupOf(prEvent(5)));
  assert.notEqual(groupOf(prEvent(5)), groupOf(prEvent(6)), "another pull request is its own group");
  assert.equal(cancels(prEvent(5)), true, "a newer pull-request event cancels the older run");
  assert.equal(cancels(ciCompleted(900)), false, "a ci completion never cancels, and nothing cancels it: its group is its run id");
  assert.notEqual(groupOf(ciCompleted(900)), groupOf(ciCompleted(901)));
  assert.notEqual(groupOf(ciCompleted(5)), groupOf(prEvent(5)), "a ci run whose id equals a pull request number is not that pull request's group");
  assert.equal(groupOf(prEvent(5)), "dependabot-auto-pull_request_target-5");
});

test("no job checks anything out, so no byte of a pull request is on the runner with a write token in hand", () => {
  assert.ok(allSteps.length >= 10, "positive control: the steps were read");
  assert.deepEqual(allSteps.filter((step) => /actions\/checkout/.test(step.uses ?? "")), []);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(!Object.values(job.permissions).includes("write") || Object.entries(job.permissions).every(([scope, level]) => level !== "write" || scope === "id-token"), `${name} writes nothing with GITHUB_TOKEN`);
  }
});

test("no script has a GitHub expression spliced into it: a pull request's text reaches bash through env, never through the script", () => {
  for (const step of allSteps.filter((candidate) => candidate.run !== undefined)) assert.doesNotMatch(step.run!, /\$\{\{/, step.job);
});

test("actions are pinned by SHA", () => {
  for (const step of allSteps.filter((candidate) => candidate.uses !== undefined)) assert.match(step.uses ?? "", /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, step.uses ?? "");
});

test("only the approve job's approval step holds the approving token, and nothing that holds the guard token can submit a review", () => {
  const holders = allSteps.filter((step) => Object.values(step.env ?? {}).some((value) => /approve-token/.test(value)));
  assert.deepEqual(holders.map((step) => step.job), ["approve"]);
  for (const step of allSteps.filter((candidate) => Object.values(candidate.env ?? {}).some((value) => /guard-token/.test(value)))) assert.doesNotMatch(step.run ?? "", /\bAPPROVE\b|--approve/, step.job);
  const mints = allSteps.filter((step) => /octo-sts\/action/.test(step.uses ?? "")).map((step) => `${step.job}:${step.with?.identity}`);
  assert.deepEqual(mints, ["approve:dependabot-approve", "approve:dependabot-guard", "withdraw:dependabot-guard", "red:dependabot-guard"]);
});

test("the workflow names the Dependabot actor only by its login and never an id of its own", () => {
  assert.match(jobOf("approve").if ?? "", /github\.actor == 'dependabot\[bot\]'/);
  assert.match(jobOf("approve").if ?? "", /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
});

// ---- the policies, and no other approver ----------------------------------------------------------------------------------------------

const GOOD: AutoFiles = {
  [APPROVE_POLICY_FILE]: fixture("approve.sts.yaml"), [GUARD_POLICY_FILE]: fixture("guard.sts.yaml"), [AUTO_ARM_FILE]: fixture("auto-arm.yml"),
  [DEPENDABOT_AUTO_FILE]: generateDependabotAuto(),
};
const withoutFile = (file: string): AutoFiles => Object.fromEntries(Object.entries(GOOD).filter(([path]) => path !== file));
const messages = (files: AutoFiles): string[] => autoProblems(files).map(({ file, message }) => `${file}: ${message}`);
const edit = (file: string, from: string | RegExp, to: string): AutoFiles => {
  const before = GOOD[file];
  const after = before.replace(from, to);
  assert.notEqual(after, before, `the fixture holds ${String(from)}`);
  return { ...GOOD, [file]: after };
};

test("the policies this repository writes bind what they must (positive control for every refusal below)", () => {
  assert.deepEqual(messages(GOOD), []);
  assert.equal(DEPENDABOT_ACTOR_ID, "49699333");
});

test("the approving policy is refused, naming the field, unless it pins dependabot[bot]'s id, main's copy of this workflow and one write", () => {
  const refused: [AutoFiles, RegExp][] = [
    [edit(APPROVE_POLICY_FILE, / {2}actor_id: "49699333"\n/, ""), /claim_pattern\.actor_id is missing/],
    [edit(APPROVE_POLICY_FILE, "49699333", "1"), /claim_pattern\.actor_id is "1", expected "49699333"/],
    [edit(APPROVE_POLICY_FILE, / {2}actor: .*\n/, ""), /claim_pattern\.actor is missing/],
    [edit(APPROVE_POLICY_FILE, / {2}pull_requests: write\n/, "  pull_requests: write\n  contents: write\n"), /permissions are .*contents.*expected exactly {"pull_requests":"write"}/],
    [edit(APPROVE_POLICY_FILE, / {2}pull_requests: write\n/, "  pull_requests: read\n"), /permissions are/],
    [edit(APPROVE_POLICY_FILE, "refs/heads/main", "refs/heads/dependabot-auto"), /job_workflow_ref is .*expected "a11ign\/lab\/\\\\.github\/workflows\/dependabot-auto\\\\.yml@refs\/heads\/main"/],
    [edit(APPROVE_POLICY_FILE, "dependabot-auto", "auto-arm"), /job_workflow_ref/],
    [edit(APPROVE_POLICY_FILE, "a11ign/lab/", "a11ign/other/"), /job_workflow_ref/],
    [edit(APPROVE_POLICY_FILE, "event_name: pull_request_target", "event_name: pull_request_target|pull_request"), /event_name is "pull_request_target\|pull_request", expected "pull_request_target"/],
    [edit(APPROVE_POLICY_FILE, "subject: repo:a11ign@320310787/lab@777:pull_request", "subject_pattern: repo:a11ign@320310787/lab@777:.*"), /has subject_pattern, expected subject/],
    [edit(APPROVE_POLICY_FILE, "@320310787", "@1"), /subject owner id is "1"/],
    [edit(APPROVE_POLICY_FILE, "lab@777", "lab"), /subject is "repo:a11ign@320310787\/lab:pull_request", expected repo:a11ign@320310787\/<repo>@<repository id>/],
    [edit(APPROVE_POLICY_FILE, "issuer: https://token.actions.githubusercontent.com", "issuer: https://example.com"), /issuer is "https:\/\/example\.com"/],
    [edit(APPROVE_POLICY_FILE, /permissions:/, "audience: x\npermissions:"), /has the key audience/],
    [edit(APPROVE_POLICY_FILE, / {2}actor: /, "  ref: .*\n  actor: "), /claim_pattern has the claim ref/],
    [edit(APPROVE_POLICY_FILE, / {2}actor: .*\n/, "  actor: .*\n"), /claim_pattern\.actor is ".\*", expected "dependabot\\\\\[bot\\\\\]"/],
  ];
  for (const [files, message] of refused) {
    const found = messages(files).filter((line) => line.startsWith(APPROVE_POLICY_FILE));
    assert.ok(found.some((line) => message.test(line)), `${String(message)} in ${JSON.stringify(found)}`);
  }
});

test("the guard policy is refused unless it is main's copy of this workflow with exactly the pull-request and actions writes", () => {
  const refused: [AutoFiles, RegExp][] = [
    [edit(GUARD_POLICY_FILE, / {2}actions: write\n/, ""), /permissions are/],
    [edit(GUARD_POLICY_FILE, / {2}actions: write\n/, "  actions: write\n  contents: write\n"), /permissions are/],
    [edit(GUARD_POLICY_FILE, "ref:refs/heads/main)", "ref:refs/heads/x)"), /subject_pattern tail/],
    [edit(GUARD_POLICY_FILE, "@refs/heads/main", "@refs/heads/x"), /job_workflow_ref/],
    [edit(GUARD_POLICY_FILE, "pull_request_target|workflow_run", "workflow_dispatch"), /event_name is "workflow_dispatch"/],
    [edit(GUARD_POLICY_FILE, "subject_pattern:", "subject:"), /has subject, expected subject_pattern/],
  ];
  for (const [files, message] of refused) {
    const found = messages(files).filter((line) => line.startsWith(GUARD_POLICY_FILE));
    assert.ok(found.some((line) => message.test(line)), `${String(message)} in ${JSON.stringify(found)}`);
  }
});

test("a missing policy is named and says how to write it; two policies for two repositories are refused", () => {
  const without = withoutFile(APPROVE_POLICY_FILE);
  assert.match(messages(without).join("\n"), /dependabot-approve\.sts\.yaml: does not exist\. Write it with the repository's id/);
  const guardOther = edit(GUARD_POLICY_FILE, /lab/g, "other");
  assert.match(messages(guardOther).join("\n"), /dependabot-guard\.sts\.yaml: names the repository other, but .*dependabot-approve\.sts\.yaml names lab/);
  assert.match(messages({ ...GOOD, [APPROVE_POLICY_FILE]: "issuer: x\n  nested: list\n" }).join("\n"), /line 2 is indented under a key that has no map/);
});

test("a policy is read as YAML reads it: a comment after a quoted value, CRLF line ends and a directory named like a workflow are not defects", () => {
  assert.deepEqual(messages(edit(APPROVE_POLICY_FILE, '"49699333"', '"49699333" # dependabot[bot]')), []);
  assert.deepEqual(messages({ ...GOOD, [APPROVE_POLICY_FILE]: GOOD[APPROVE_POLICY_FILE].replaceAll("\n", "\r\n") }), []);
  const root = mkdtempSync(join(tmpdir(), "dependabot-auto-read-"));
  try {
    mkdirSync(join(root, ".github/workflows/not-a-file.yml"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/real.yml"), "name: real\n");
    assert.deepEqual(Object.keys(readAutoFiles(root)), [".github/workflows/real.yml"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("any other workflow that submits an approval, or mints the approving identity, is named; a comment or a read of the decision is not", () => {
  for (const name of ["approves-with-the-cli.yml", "approves-with-the-api.yml", "mints-the-approving-identity.yml"]) {
    const files = { ...GOOD, [`.github/workflows/${name}`]: fixture(name) };
    const found = findOtherApprovers(files);
    assert.deepEqual(found.map(({ file }) => file), [`.github/workflows/${name}`], name);
    assert.match(autoProblems(files).map(({ message }) => message).join("\n"), /Only \.github\/workflows\/dependabot-auto\.yml's approve job may/);
  }
  assert.deepEqual(findOtherApprovers({ ...GOOD, ".github/workflows/reads.yml": fixture("reads-the-decision-and-mentions-approval.yml") }), []);
  assert.deepEqual(findOtherApprovers(GOOD), [], "dependabot-auto.yml itself is the one that may");
});

test("auto-arm.yml without arm-approved, or missing, is named: an approval would have nothing to queue it", () => {
  assert.match(messages({ ...GOOD, [AUTO_ARM_FILE]: "jobs:\n  arm:\n    runs-on: x\n" }).join("\n"), /auto-arm\.yml: has no arm-approved job/);
  const without = withoutFile(AUTO_ARM_FILE);
  assert.match(messages(without).join("\n"), /auto-arm\.yml: does not exist/);
  assert.equal(verifyPolicies(GOOD).length, 0);
});
