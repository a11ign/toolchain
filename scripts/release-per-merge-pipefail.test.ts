import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// A SCRIPT PIPED INTO `tee` READS SUCCESS WHEN THE SCRIPT DIES (a11ign/a11ign#3766). GitHub's default `run` shell is `bash -e {0}`, WITHOUT
// `pipefail`, so a pipeline's status is `tee`'s: `release-per-merge.mjs version | tee -a "$GITHUB_STEP_SUMMARY"` exited 0 when the script threw,
// the step wrote no `released` output, `version.outputs.released` fell to `false`, and a release that could not be cut read as a green run with
// nothing to release. The workflow is read as YAML (structure, never words), and the two steps that matter are also RUN, with the release
// script stubbed to die, in the shell GitHub would start for them.

type Step = { name?: string; run?: string; shell?: string };
type Job = { steps?: Step[]; defaults?: { run?: { shell?: string } } };
type Workflow = { jobs?: Record<string, Job>; defaults?: { run?: { shell?: string } } };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const PIPES_INTO_TEE = /\|&?\s*tee\b/;
const PIPEFAIL_IN_SCRIPT = /^\s*set\s+(-\w*\s+)*-\w*o\s+pipefail\b|^\s*set\s+-o\s+pipefail\b/m;

/** What GitHub starts for a `run` step: the step's `shell`, else the job's default, else the workflow's, else `bash -e {0}` on Linux. */
function shellOf(workflow: Workflow, job: Job, step: Step): string | undefined {
  return step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
}

/** The argv GitHub documents for a named shell; `bash` alone is `bash --noprofile --norc -eo pipefail {0}`, an unnamed shell is `bash -e {0}`. */
function argvFor(shell: string | undefined): string[] {
  if (shell === undefined) return ["bash", "-e"];
  if (shell === "bash") return ["bash", "--noprofile", "--norc", "-eo", "pipefail"];
  return shell.replace("{0}", "").trim().split(/\s+/);
}

function hasPipefail(shell: string | undefined, run: string): boolean {
  return argvFor(shell).join(" ").includes("pipefail") || PIPEFAIL_IN_SCRIPT.test(run);
}

/** Every `run` that pipes into `tee` under a shell with no `pipefail`, named `job: step`. */
export function refusals(text: string): string[] {
  const workflow = parse(text) as Workflow;
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter((step) => PIPES_INTO_TEE.test(step.run ?? "") && !hasPipefail(shellOf(workflow, job, step), step.run ?? ""))
      .map((step) => `${jobName}: ${step.name ?? step.run}`),
  );
}

const called = read("../.github/workflows/release-per-merge.yml");
// The file as it was before this row: the positive control, which must be REFUSED, naming the step.
const before = read("./fixtures/release-per-merge-before-3766.yml");

test("release-per-merge.yml pipes no script into tee under a shell without pipefail", () => {
  assert.deepEqual(refusals(called), []);
});

test("CONTROL: the file as it was is refused, naming both steps that piped into tee", () => {
  assert.deepEqual(refusals(before), [
    "version: Which changesets has no tag consumed yet?",
    "version: The release commit, on top of this merge and on no branch",
    "tag: A GitHub Release per tag, its notes the changelog entry the version wrote",
  ]);
});

test("the marker notices each remedy: `shell: bash`, a job default, a workflow default, `set -o pipefail`", () => {
  const piped = 'node x.mjs | tee -a "$GITHUB_STEP_SUMMARY"';
  const file = (extra: { workflow?: string; job?: string; step?: string; run?: string }) =>
    `${extra.workflow ?? ""}jobs:\n  j:\n${extra.job ?? ""}    steps:\n      - name: s\n${extra.step ?? ""}        run: |\n${extra.run ?? ""}          ${piped}\n`;
  assert.equal(refusals(file({})).length, 1, "positive control: the bare pipe is refused");
  assert.deepEqual(refusals(file({ step: "        shell: bash\n" })), []);
  assert.deepEqual(refusals(file({ job: "    defaults: { run: { shell: bash } }\n" })), []);
  assert.deepEqual(refusals(file({ workflow: "defaults: { run: { shell: bash } }\n" })), []);
  assert.deepEqual(refusals(file({ run: "          set -o pipefail\n" })), []);
  assert.equal(refusals(file({ step: "        shell: sh\n" })).length, 1, "a shell that is not bash and names no pipefail is still refused");
});

// RUN, NOT READ. The real `run` text of a `version` step, in the shell GitHub starts for it, with the release script replaced by a stub that
// dies (or prints the plan's count) and `pnpm` replaced by one that succeeds: a dry run, nothing is installed or published.
function runStep(text: string, stepName: string, script: string): number | null {
  const workflow = parse(text) as Workflow;
  const job = workflow.jobs!.version;
  const step = job.steps!.find((candidate) => candidate.name === stepName);
  assert.ok(step?.run, `positive control: the version job has the step "${stepName}"`);
  const dir = mkdtempSync(join(tmpdir(), "pipefail-3766-"));
  try {
    mkdirSync(join(dir, ".release-tool", "scripts"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, ".release-tool", "scripts", "release-per-merge.mjs"), script);
    writeFileSync(join(dir, "bin", "pnpm"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "pnpm"), 0o755);
    // GitHub writes the step's script to a file and hands it to the shell as its last argument.
    writeFileSync(join(dir, "step.sh"), step.run);
    writeFileSync(join(dir, "summary.md"), "");
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "x");
    const [file, ...args] = argvFor(shellOf(workflow, job, step));
    const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
    return spawnSync(file, [...args, join(dir, "step.sh")], { cwd: dir, env }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLAN = "Which changesets has no tag consumed yet?";
const VERSION = "The release commit, on top of this merge and on no branch";
const DIES = 'console.error("Error: Command failed: pnpm exec changeset version"); process.exit(1);';
const PLAN_OF_NONE = 'console.log("count=0");';

test("a `version` script that exits non-zero turns the release step red", () => {
  assert.notEqual(runStep(called, VERSION, DIES), 0);
});

test("a `plan` script that exits non-zero turns the plan step red", () => {
  assert.notEqual(runStep(called, PLAN, DIES), 0);
});

test("a plan with count 0 still ends green: the no-changeset path does not turn red", () => {
  assert.equal(runStep(called, PLAN, PLAN_OF_NONE), 0);
});

test("a `version` script that succeeds ends green", () => {
  assert.equal(runStep(called, VERSION, 'console.log("released=true");'), 0);
});

test("CONTROL: under the file as it was, the same dying script reads as success", () => {
  assert.equal(runStep(before, VERSION, DIES), 0, "this is the defect: the step is green while the script died");
  assert.equal(runStep(before, PLAN, DIES), 0);
});
