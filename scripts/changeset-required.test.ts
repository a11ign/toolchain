import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { decide, parseReleasablePaths } from "./changeset-required.mjs";

// WHAT THIS PINS (a11ign/a11ign#4127). `changeset-required.mjs` holds the DECISION (files, body and paths in; verdict and reason out), so the
// cases below RUN it, over the real file lists of screenreader-worker#25 and #26. The two workflows are read as YAML and judged on STRUCTURE
// (triggers, permissions, `if`, `needs`), never on words: their comments say why in the very words a text match would find.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "changeset-required.mjs");
const REUSABLE = join(ROOT, ".github", "workflows", "changeset-required.yml");
const CI = join(ROOT, ".github", "workflows", "ci.yml");

type File = { filename: string; status: string; previous_filename?: string };
const added = (...filenames: string[]): File[] => filenames.map((filename) => ({ filename, status: "added" }));
const modified = (...filenames: string[]): File[] => filenames.map((filename) => ({ filename, status: "modified" }));

// screenreader-worker's `dora` entry in a11ign/a11ign `.agent-org/project.json`, joined by a space as the workflow's input is.
const WORKER = "src/ packages/nvda-speech/";
const NUMBER_25 = modified("src/auth-flow.mjs", "src/capture-auth.mjs").concat(added("src/auth-flow-idp.test.ts"));
const NUMBER_26 = modified("src/capture-core.mjs").concat(added("src/capture-auth-diag-mark.test.ts"));

const verdict = (files: File[], { body = "", paths = WORKER }: { body?: string; paths?: string } = {}) =>
  decide({ files, body, releasablePaths: parseReleasablePaths(paths) });

test("a releasable change with no changeset and no no-release line fails", () => {
  for (const files of [NUMBER_25, NUMBER_26]) {
    const { ok, reason } = verdict(files);
    assert.equal(ok, false);
    assert.match(reason, /\.changeset/);
    assert.match(reason, /no-release:/);
  }
});

test("the reason names the releasable files that earned the failure, and not the test files", () => {
  const { reason } = verdict(NUMBER_25);
  assert.match(reason, /src\/auth-flow\.mjs/);
  assert.match(reason, /src\/capture-auth\.mjs/);
  assert.doesNotMatch(reason, /auth-flow-idp\.test/);
});

test("the same change with an ADDED changeset passes", () => {
  assert.equal(verdict([...NUMBER_25, ...added(".changeset/quiet-owls-sing.md")]).ok, true);
});

test("an edited, deleted or renamed-within changeset does not clear it", () => {
  const existing = ".changeset/first-publish.md";
  assert.equal(verdict([...NUMBER_25, ...modified(existing)]).ok, false);
  assert.equal(verdict([...NUMBER_25, { filename: existing, status: "removed" }]).ok, false);
  assert.equal(verdict([...NUMBER_25, { filename: ".changeset/b.md", status: "renamed", previous_filename: ".changeset/a.md" }]).ok, false);
});

test("a file MOVED INTO .changeset/ is new there", () => {
  assert.equal(verdict([...NUMBER_25, { filename: ".changeset/b.md", status: "renamed", previous_filename: "notes/b.md" }]).ok, true);
});

test("only .changeset/README.md, config.json, or something changesets would not read does not clear it", () => {
  for (const name of [".changeset/README.md", ".changeset/config.json", ".changeset/notes.txt", ".changeset/sub/x.md"]) {
    assert.equal(verdict([...NUMBER_25, ...added(name)]).ok, false, name);
  }
});

test("a body line no-release: with a reason passes", () => {
  assert.equal(verdict(NUMBER_26, { body: "Closes x\n\nno-release: a refactor, no behaviour change\n" }).ok, true);
  assert.equal(verdict(NUMBER_26, { body: "text\r\nno-release: CRLF bodies are what GitHub stores\r\n" }).ok, true);
});

test("no-release: with nothing, or the placeholder, fails", () => {
  for (const body of ["no-release:", "no-release:   ", "no-release: <reason>", "no-release: <reason>  ", "see no-release: not at the start of a line"]) {
    assert.equal(verdict(NUMBER_26, { body }).ok, false, JSON.stringify(body));
  }
});

test("a diff touching only a test file under a releasable path passes", () => {
  assert.equal(verdict(modified("src/x.test.ts", "src/deep/y.spec.mjs")).ok, true);
});

test("a diff touching nothing under a releasable path passes", () => {
  assert.equal(verdict(modified("docs/a.md", "scripts/b.mjs", "srcs/c.mjs", "README.md")).ok, true);
});

test("deleting or renaming away a releasable file is a releasable change", () => {
  assert.equal(verdict([{ filename: "src/gone.mjs", status: "removed" }]).ok, false);
  assert.equal(verdict([{ filename: "lib/new.mjs", status: "renamed", previous_filename: "src/old.mjs" }]).ok, false);
});

test("the second releasable path counts, and a path with no trailing slash is a directory", () => {
  assert.equal(verdict(modified("packages/nvda-speech/index.mjs")).ok, false);
  assert.equal(verdict(modified("src/a.mjs"), { paths: "src" }).ok, false);
  assert.equal(verdict(modified("srcs/a.mjs"), { paths: "src" }).ok, true);
});

test("releasable-paths that name nothing is refused, because a check given no paths checks nothing", () => {
  for (const paths of ["", "   ", " , "]) assert.throws(() => parseReleasablePaths(paths), /releasable-paths/);
  assert.deepEqual(parseReleasablePaths("  ./src/   packages/nvda-speech/ "), ["src/", "packages/nvda-speech/"]);
});

test("a file list GitHub truncated is refused, not read as a pass", () => {
  const files = added(...Array.from({ length: 3000 }, (_, i) => `docs/${i}.md`));
  const { ok, reason } = verdict(files);
  assert.equal(ok, false);
  assert.match(reason, /3000/);
});

// THE COMMAND LINE, which is what the workflow runs: the file list as JSON lines (what `gh api --jq '.[] | {...}'` prints), the body and the paths in the environment.
function runCli(files: File[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "changeset-required-"));
  try {
    const list = join(dir, "files.jsonl");
    writeFileSync(list, files.map((file) => JSON.stringify(file)).join("\n"));
    return spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", FILES_JSONL: list, ...env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the command exits non-zero with an ::error:: annotation on a failure, and zero on a pass", () => {
  const failing = runCli(NUMBER_25, { PR_BODY: "", RELEASABLE_PATHS: WORKER });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /^::error title=changeset-required::/m);
  assert.match(failing.stdout, /VERDICT fail/);
  const passing = runCli(NUMBER_25, { PR_BODY: "no-release: docs only", RELEASABLE_PATHS: WORKER });
  assert.equal(passing.status, 0);
  assert.match(passing.stdout, /VERDICT pass/);
});

test("the command refuses an empty file list, which an API that returned nothing would also print", () => {
  const result = runCli([], { PR_BODY: "", RELEASABLE_PATHS: WORKER });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /no files/);
});

// ---- the workflows, read as YAML ----

type Step = { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
};
const load = (path: string): Workflow => parse(readFileSync(path, "utf8")) as Workflow;
const stepsOf = (workflow: Workflow): Step[] => Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

test("the reusable workflow is workflow_call only, with releasable-paths as a required string", () => {
  const { on } = load(REUSABLE);
  assert.deepEqual(Object.keys(on), ["workflow_call"]);
  const input = (on.workflow_call as { inputs: Record<string, { type?: string; required?: boolean; default?: unknown }> }).inputs["releasable-paths"];
  assert.equal(input.type, "string");
  assert.equal(input.required, true);
  assert.equal(input.default, undefined);
});

test("the reusable workflow can read a pull request's files and write nothing", () => {
  const workflow = load(REUSABLE);
  for (const job of Object.values(workflow.jobs)) {
    const permissions = { ...workflow.permissions, ...job.permissions };
    assert.deepEqual(permissions, { contents: "read", "pull-requests": "read" });
  }
});

test("on a merge_group entry the job succeeds without evaluating, and on a pull request every other step runs", () => {
  const steps = stepsOf(load(REUSABLE));
  const evaluating = steps.filter((step) => /changeset-required\.mjs|gh api/.test(step.run ?? ""));
  assert.ok(evaluating.length >= 2, "the file list is gathered and the script is run: two steps at least");
  for (const step of evaluating) assert.match(step.if ?? "", /github\.event_name\s*!=\s*'merge_group'/, step.name ?? "unnamed step");
  const explains = steps.filter((step) => /github\.event_name\s*==\s*'merge_group'/.test(step.if ?? ""));
  assert.equal(explains.length, 1, "one step says why nothing was evaluated, so a green run is not mistaken for a pass");
  const job = Object.values(load(REUSABLE).jobs)[0];
  assert.equal(job.if, undefined, "a skipped job reads as skipped, and a required check that never reports blocks the queue");
});

test("the pull request's body and the paths reach the script through env, never interpolated into a shell line", () => {
  const steps = stepsOf(load(REUSABLE));
  for (const step of steps) assert.doesNotMatch(step.run ?? "", /\$\{\{/, step.name ?? "unnamed step");
  const script = steps.find((step) => /changeset-required\.mjs/.test(step.run ?? ""));
  assert.match(script?.env?.PR_BODY ?? "", /github\.event\.pull_request\.body/);
  assert.match(script?.env?.RELEASABLE_PATHS ?? "", /inputs\.releasable-paths/);
});

test("the script is fetched at the commit the workflow was read from, and the caller's code is never run", () => {
  const checkouts = stepsOf(load(REUSABLE)).filter((step) => (step.uses ?? "").startsWith("actions/checkout"));
  assert.equal(checkouts.length, 1, "one checkout, of the toolchain, not of the caller");
  assert.match(String(checkouts[0].with?.ref), /job\.workflow_sha/);
  assert.match(String(checkouts[0].with?.repository), /job\.workflow_repository/);
  assert.equal(checkouts[0].with?.["persist-credentials"], false);
  assert.equal(stepsOf(load(REUSABLE)).some((step) => /pnpm|npm|npx/.test(step.run ?? "")), false);
});

test("toolchain's own ci.yml re-runs on an edited body, runs on the queue, and calls the check by local path", () => {
  const workflow = load(CI);
  assert.deepEqual((workflow.on.pull_request as { types: string[] }).types, ["opened", "synchronize", "reopened", "edited"]);
  assert.ok("merge_group" in workflow.on);
  const caller = Object.values(workflow.jobs).find((job) => job.uses === "./.github/workflows/changeset-required.yml");
  assert.ok(caller, "a job calls the reusable workflow by local path");
  assert.equal(caller.with?.["releasable-paths"], "packages/toolchain/");
  assert.ok(existsSync(join(ROOT, "packages/toolchain/package.json")), "the releasable path is a real package directory");
});

test("`gate`, the required check, waits for the changeset check and for the tests, and accepts success only", () => {
  const { jobs } = load(CI);
  const callerName = Object.keys(jobs).find((name) => jobs[name].uses === "./.github/workflows/changeset-required.yml") ?? "";
  const gate = jobs.gate;
  const needs = [gate.needs ?? []].flat();
  assert.ok(needs.includes(callerName));
  const testing = Object.keys(jobs).filter((name) => name !== "gate" && name !== callerName);
  assert.ok(testing.length > 0 && testing.every((name) => needs.includes(name)), "every other job");
  assert.match(String(gate.if), /always\(\)/, "a gate that is skipped when a need fails reads as passed");
  const run = (gate.steps ?? []).map((step) => step.run ?? "").join("\n");
  for (const name of needs) assert.match(run, new RegExp(`needs\\.${name}\\.result`), name);
  assert.doesNotMatch(run, /skipped/, "skipped is not success: a changeset check that did not run is a check that did not pass");
  assert.equal(jobs.gate.uses, undefined);
});
