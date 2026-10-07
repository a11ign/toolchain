import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildRelease } from "./release-per-merge.mjs";

// PARITY WITH agent-org's OWN RELEASE (a11ign/a11ign#3964, the parity table on #3958). agent-org's `release.yml` is the model, so the shared
// `release-per-merge.yml` must lose none of what it guarantees before agent-org calls it. G1 to G5 below are the five lines that table marked
// ADD FIRST, and each test name starts `parity Gn:` because the row's Acceptance reads this file for exactly those words.
//
// RUN, NOT READ. The workflow is parsed as YAML only to find a step's `run:` text; that text is then RUN in the shell GitHub starts for it, over
// scratch git repositories, a bare remote and a stand-in `gh` and `pnpm`. A regex over `exit 1` passes on a script that never reaches it, and
// a check that was never seen to fail is not a check, so every guard in G5 is also run on a MUTATED copy of its step and must be seen to fail.
//
// WHAT IS NOT RUN, SO NOBODY READS MORE INTO A GREEN THAN IS THERE: `pnpm/action-setup` and `actions/setup-node` are actions, not shell. Their
// `with:` values are evaluated and judged against what each action documents (`cache: pnpm` fails without a lockfile; `version` beside a
// different `packageManager` is refused), but the actions themselves are not started here. `pnpm dlx` is a stand-in that runs this repository's
// own `changeset`; the real `pnpm dlx @changesets/cli@3.0.1 version` over a no-lockfile tree was run by hand on the row, not by this file.

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(HERE, "..", ".github", "workflows", "release-per-merge.yml");
const RELEASE_SCRIPT = join(HERE, "release-per-merge.mjs");
const CHANGESET_BIN = require.resolve("@changesets/cli/bin.js");
const CHANGELOG_PRESET = require.resolve("@changesets/cli/changelog");

type Step = { id?: string; name?: string; run?: string; uses?: string; shell?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { steps?: Step[] };
type Workflow = { on: { workflow_call: { inputs: Record<string, { default?: string }> } }; jobs: Record<string, Job> };
type Context = { inputs: Record<string, string>; steps: Record<string, Record<string, string>>; needs: Record<string, Record<string, string>> };
type Result = { status: number | null; stdout: string; stderr: string; outputs: Record<string, string> };

const real = (): Workflow => parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
const jobSteps = (job: string): Step[] => real().jobs[job]?.steps ?? [];

function stepNamed(job: string, name: RegExp): Step {
  const step = jobSteps(job).find((candidate) => name.test(candidate.name ?? ""));
  if (!step?.run) throw new Error(`no ${job} step with a script matches ${name}`);
  return step;
}

const scratch = <T>(prefix: string, use: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...GIT_ENV } });
const commit = (cwd: string, message: string): void => void git(cwd, "commit", "-q", "--allow-empty", "-am", message);

// ---- running a step the way the runner would ---------------------------------------------------------------------------------------

/** `${{ inputs.x }}`, `${{ steps.id.outputs.x }}`, `${{ needs.job.outputs.x }}` and `${{ github.token }}`: the only forms the steps run here use. Anything else throws. */
function evaluate(text: string, context: Context): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_whole, expression: string) => {
    const ref = /^(inputs|steps|needs)\.([\w-]+)(?:\.outputs\.([\w-]+))?$/.exec(expression);
    if (expression === "github.token") return "token";
    if (!ref) throw new Error(`the expression \${{ ${expression} }} is not one this harness evaluates`);
    const [, scope, key, output] = ref;
    if (scope === "inputs") return context.inputs[key] ?? "";
    return (scope === "steps" ? context.steps : context.needs)[key]?.[output] ?? "";
  });
}

/** An `if:` of the form `steps.x.outputs.y != 'v'` or `== 'v'`: the only ones the steps run here carry. */
function holds(condition: string | undefined, context: Context): boolean {
  if (condition === undefined) return true;
  const form = /^steps\.([\w-]+)\.outputs\.([\w-]+) (==|!=) '(.*)'$/.exec(condition);
  if (!form) throw new Error(`the condition ${condition} is not one this harness evaluates`);
  const [, id, output, operator, value] = form;
  return ((context.steps[id]?.[output] ?? "") === value) === (operator === "==");
}

/** The shell GitHub starts: `bash -e {0}` for a step that names none, and `bash -eo pipefail {0}` for `shell: bash`. */
const shellArgv = (step: Step): string[] => (step.shell === "bash" ? ["bash", "--noprofile", "--norc", "-eo", "pipefail"] : ["bash", "-e"]);

function runStep(step: Step, where: { cwd: string; context: Context; env: Record<string, string> }): Result {
  return scratch("parity-step-", (dir) => {
    const output = join(dir, "output");
    writeFileSync(output, "");
    write(join(dir, "step.sh"), step.run ?? "");
    const own = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, evaluate(String(value), where.context)]));
    const env = { PATH: process.env.PATH ?? "", HOME: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, "summary"), ...GIT_ENV, ...own, ...where.env };
    const [file, ...args] = shellArgv(step);
    const ran = spawnSync(file, [...args, join(dir, "step.sh")], { cwd: where.cwd, env, encoding: "utf8", timeout: 60_000 });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, outputs };
  });
}

// ---- G1, G2: the version job, run over a repository -------------------------------------------------------------------------------

type Shape = { name?: string; private?: boolean; lockfile?: boolean; packageManager?: string };

/** A repository as it stands after its last release (tag `v1.0.0` on a release commit) with one changeset merged since. Nothing is installed in it. */
function repositoryAfterRelease(root: string, shape: Shape): void {
  const name = shape.name ?? "agent-org";
  git(root, "init", "-q", "-b", "main");
  // A dependency, because pnpm's frozen install of a package with none succeeds without a lockfile and so would hide the defect.
  const manifest = { name, version: "1.0.0", devDependencies: { yaml: "2.9.1" }, ...(shape.private ? { private: true } : {}), ...(shape.packageManager ? { packageManager: shape.packageManager } : {}) };
  write(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (shape.lockfile) write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(join(root, ".changeset", "config.json"), JSON.stringify({ changelog: CHANGELOG_PRESET, commit: false, baseBranch: "main", access: "restricted", privatePackages: { version: true, tag: false } }));
  git(root, "add", "-A");
  commit(root, "the last release");
  git(root, "tag", "v1.0.0");
  write(join(root, ".changeset", "fix.md"), `---\n"${name}": patch\n---\n\nsays what changed\n`);
  git(root, "add", "-A");
  commit(root, "merge a changeset");
  mkdirSync(join(root, ".release-tool", "scripts"), { recursive: true });
  copyFileSync(RELEASE_SCRIPT, join(root, ".release-tool", "scripts", "release-per-merge.mjs"));
}

/** A `pnpm` that logs every call. `install` is the REAL pnpm when there is no lockfile (so ERR_PNPM_NO_LOCKFILE is the real one) and a no-op otherwise; `dlx`/`exec changeset` run this repository's own. */
function pnpmStandIn(dir: string): { bin: string; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "pnpm.log");
  const realPnpm = execFileSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();
  write(join(bin, "pnpm"), [
    "#!/bin/bash",
    `echo "$*" >> "${log}"`,
    'case "$1" in',
    `  dlx) shift 2; exec node "${CHANGESET_BIN}" "$@" ;;`,
    `  exec) if [ "$2" = changeset ]; then shift 2; exec node "${CHANGESET_BIN}" "$@"; fi ;;`,
    `  install) if [ ! -f pnpm-lock.yaml ]; then HOME="${process.env.HOME}" exec "${realPnpm}" "$@"; fi; exit 0 ;;`,
    "esac",
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "pnpm"), 0o755);
  return { bin, log };
}

type VersionJob = { failed?: { step: string; stderr: string } /* stdout too: pnpm writes its errors there */; outputs: Record<string, string>; actions: Record<string, Record<string, string>>; pnpmCalls: string[]; installedModules: boolean; tags: string[] };

const notTheTipFetch = (step: Step): boolean => !step.name?.startsWith("The tip of the default branch");

/** Every `run` step of the `version` job up to and including the release step, in order, stopping at the first that fails as the runner does; the actions' `with:` are evaluated, not started. */
function runVersionJob(shape: Shape, inputs: Record<string, string>): VersionJob {
  return scratch("parity-version-", (dir) => {
    const root = join(dir, "repo");
    mkdirSync(root);
    repositoryAfterRelease(root, shape);
    const { bin, log } = pnpmStandIn(dir);
    const workflow = real();
    const defaults = Object.fromEntries(Object.entries(workflow.on.workflow_call.inputs).map(([key, input]) => [key, input.default ?? ""]));
    const context: Context = { inputs: { ...defaults, kind: "tag", ...inputs }, steps: {}, needs: {} };
    const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: git(root, "rev-parse", "HEAD").trim(), RUNNER_TEMP: join(dir, "tmp") };
    mkdirSync(env.RUNNER_TEMP);
    // There is no network and no origin here, so the step that fetches the tip is not run; the tip is the merge itself, whose workflows the release commit already has (release-per-merge.test.ts runs the graft).
    git(root, "update-ref", "refs/remotes/tip/main", "HEAD");
    const job: VersionJob = { outputs: {}, actions: {}, pnpmCalls: [], installedModules: false, tags: [] };
    for (const step of (workflow.jobs.version.steps ?? []).filter(notTheTipFetch)) {
      if (!holds(step.if, context)) continue;
      if (step.uses && /^(pnpm\/action-setup|actions\/setup-node)@/.test(step.uses)) job.actions[step.uses.replace(/@.*/, "")] = Object.fromEntries(Object.entries(step.with ?? {}).map(([key, value]) => [key, evaluate(String(value), context)]));
      if (!step.run) continue;
      const result = runStep(step, { cwd: root, context, env });
      if (step.id) context.steps[step.id] = result.outputs;
      if (result.status !== 0) {
        job.failed = { step: step.name ?? "", stderr: `${result.stdout}\n${result.stderr}` };
        break;
      }
      if (step.id === "release") break;
    }
    job.outputs = context.steps.release ?? {};
    job.pnpmCalls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    // The manifest lives in the scratch directory, which is gone when this returns.
    job.tags = job.outputs.manifest ? (JSON.parse(readFileSync(job.outputs.manifest, "utf8")) as { packages: { tag: string }[] }).packages.map(({ tag }) => tag) : [];
    job.installedModules = existsSync(join(root, "node_modules"));
    return job;
  });
}

const why = (job: VersionJob): string => (job.failed ? `the step "${job.failed.step}" failed: ${job.failed.stderr.trim().split("\n").slice(-3).join(" | ")}` : "");

test("parity G1: a repository with no lockfile, no packageManager and no changeset dependency versions through pnpm dlx and installs nothing", () => {
  const job = runVersionJob({}, { "pnpm-version": "10.34.5" });
  assert.equal(job.failed, undefined, why(job));
  assert.equal(job.outputs.released, "true", "positive control: the release was made, so the checks below read a real run");
  const pinned = real().on.workflow_call.inputs["changesets-version"]?.default;
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "the changeset CLI version is an input with a default that is a version");
  assert.ok(job.pnpmCalls.includes(`dlx @changesets/cli@${pinned} version`), `pnpm calls: ${JSON.stringify(job.pnpmCalls)}`);
  assert.equal(job.pnpmCalls.some((call) => call.startsWith("install")), false, "nothing is installed where there is no lockfile");
  assert.equal(job.installedModules, false, "no node_modules was written");
});

test("parity G1: the changeset CLI version is the caller's to name", () => {
  const job = runVersionJob({}, { "pnpm-version": "10.34.5", "changesets-version": "3.0.1" });
  assert.equal(job.failed, undefined, why(job));
  assert.ok(job.pnpmCalls.includes("dlx @changesets/cli@3.0.1 version"), `pnpm calls: ${JSON.stringify(job.pnpmCalls)}`);
});

test("parity G1: pnpm/action-setup and setup-node are given what such a repository has: the pnpm-version input, and no cache to key on a lockfile that is not there", () => {
  const job = runVersionJob({}, { "pnpm-version": "10.34.5" });
  assert.equal(job.actions["pnpm/action-setup"]?.version, "10.34.5");
  assert.equal(job.actions["actions/setup-node"]?.cache, "", "`cache: pnpm` makes setup-node fail on a missing lockfile");
});

test("parity G1: a packageManager is read by the action, and the input does not argue with it", () => {
  const job = runVersionJob({ packageManager: "pnpm@10.34.5" }, { "pnpm-version": "9.0.0" });
  assert.equal(job.failed, undefined, why(job));
  assert.equal(job.actions["pnpm/action-setup"]?.version, "", "an empty version makes the action read packageManager, and two versions are refused");
});

test("parity G1: neither a packageManager nor a pnpm-version is refused, naming the input, before anything is installed", () => {
  const job = runVersionJob({}, {});
  assert.match(job.failed?.stderr ?? "", /pnpm-version/);
  assert.equal(job.pnpmCalls.length, 0);
});

test("parity G1: a repository WITH a lockfile is unchanged: frozen install, the repository's own changeset, cache keyed on the lockfile", () => {
  const job = runVersionJob({ lockfile: true, packageManager: "pnpm@10.34.5" }, {});
  assert.equal(job.failed, undefined, why(job));
  assert.deepEqual(job.pnpmCalls, ["install --frozen-lockfile", "exec changeset version", "install --lockfile-only"]);
  assert.equal(job.actions["actions/setup-node"]?.cache, "pnpm");
  assert.equal(job.outputs.released, "true");
});

// ---- G2: a private root package under kind: tag -------------------------------------------------------------------------------------

const version = (cwd: string): void => void execFileSync(process.execPath, [CHANGESET_BIN, "version"], { cwd, stdio: "pipe" });

function workspace(shape: { rootPrivate: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "parity-g2-"));
  repositoryAfterRelease(root, { name: "root", private: shape.rootPrivate });
  return root;
}

function detached(root: string): string {
  git(root, "checkout", "-q", "--detach");
  return git(root, "rev-parse", "HEAD").trim();
}

test("parity G2: kind tag tags a private root package, as v<version>", () => {
  const root = workspace({ rootPrivate: true });
  try {
    detached(root);
    const result = buildRelease({ cwd: root, changesetVersion: version, kind: "tag" });
    assert.ok(result.released, "a private root package under kind tag is released");
    assert.deepEqual(result.released && result.packages.map(({ tag }) => tag), ["v1.0.1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parity G2: kind npm still never releases a private package, and a public root is tagged under either kind", () => {
  const root = workspace({ rootPrivate: true });
  try {
    const head = detached(root);
    const result = buildRelease({ cwd: root, changesetVersion: version, kind: "npm" });
    assert.equal(result.released, false);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head, "no release commit was made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const kind of ["npm", "tag"] as const) {
    const open = workspace({ rootPrivate: false });
    try {
      detached(open);
      const result = buildRelease({ cwd: open, changesetVersion: version, kind });
      assert.deepEqual(result.released && result.packages.map(({ tag }) => tag), ["v1.0.1"], `a public root under kind ${kind}`);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  }
});

test("parity G2: kind tag releases the private ROOT only: a private package below it is still not tagged", () => {
  const root = workspace({ rootPrivate: true });
  try {
    write(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    write(join(root, "packages", "p", "package.json"), `${JSON.stringify({ name: "p", version: "1.0.0", private: true })}\n`);
    write(join(root, ".changeset", "p.md"), '---\n"p": minor\n---\n\nsays what changed\n');
    write(join(root, ".changeset", "fix.md"), "---\n---\n");
    git(root, "add", "-A");
    commit(root, "a changeset for the private package alone");
    const head = detached(root);
    const result = buildRelease({ cwd: root, changesetVersion: version, kind: "tag" });
    assert.equal(result.released, false, "positive control: p's version DID move, and still nothing is released");
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parity G2: the workflow hands the kind to the script, so a private root is tagged by the job that runs it, under kind tag only", () => {
  const tagged = runVersionJob({ private: true }, { kind: "tag", "pnpm-version": "10.34.5" });
  assert.equal(tagged.failed, undefined, why(tagged));
  assert.deepEqual(tagged.tags, ["v1.0.1"]);
  const npm = runVersionJob({ private: true }, { kind: "npm", "pnpm-version": "10.34.5" });
  assert.equal(npm.failed, undefined, why(npm));
  assert.equal(npm.outputs.released, "false", "positive control: the same repository under kind npm releases nothing");
});

// ---- G3 and G4: refused before a tag exists ----------------------------------------------------------------------------------------

/** What `changeset version` leaves, as a test chooses it: a version, and a changelog (or none). */
const stubVersion = (to: string, changelog: string | null) => (cwd: string): void => {
  write(join(cwd, "package.json"), `${JSON.stringify({ name: "agent-org", version: to }, null, 2)}\n`);
  if (changelog !== null) write(join(cwd, "CHANGELOG.md"), changelog);
};

function refusedBeforeAnyCommit(changesetVersion: (cwd: string) => void): { error: string; moved: boolean } {
  return scratch("parity-g34-", (root) => {
    repositoryAfterRelease(root, {});
    const head = detached(root);
    let error = "";
    try {
      buildRelease({ cwd: root, changesetVersion, kind: "tag" });
    } catch (thrown) {
      error = (thrown as Error).message;
    }
    return { error, moved: git(root, "rev-parse", "HEAD").trim() !== head };
  });
}

test("parity G3: a version with no changelog entry is refused in the version job, before any release commit or tag", () => {
  const empty = refusedBeforeAnyCommit(stubVersion("1.0.1", "# agent-org\n\n## 1.0.0\n\n- old\n"));
  assert.match(empty.error, /agent-org.*no entry for 1\.0\.1/, "the refusal names the package and the version");
  assert.equal(empty.moved, false, "no release commit was made, so there is nothing to bundle or tag");
  const missing = refusedBeforeAnyCommit(stubVersion("1.0.1", null));
  assert.match(missing.error, /agent-org.*CHANGELOG\.md/);
  assert.equal(missing.moved, false);
  const written = refusedBeforeAnyCommit(stubVersion("1.0.1", "# agent-org\n\n## 1.0.1\n\n- new\n"));
  assert.deepEqual(written, { error: "", moved: true }, "positive control: the same stub with an entry is released");
});

test("parity G4: a version that is not MAJOR.MINOR.PATCH is refused, naming the package, before any release commit or tag", () => {
  for (const bad of ["1.0.1-rc.1", "1.0", "v1.0.1", "1.0.1+build"]) {
    const refused = refusedBeforeAnyCommit(stubVersion(bad, `# agent-org\n\n## ${bad}\n\n- new\n`));
    assert.match(refused.error, new RegExp(`agent-org.*${bad.replace(/[.+]/g, "\\$&")}.*MAJOR\\.MINOR\\.PATCH`), `version ${bad}`);
    assert.equal(refused.moved, false, `version ${bad} wrote a release commit`);
  }
});

// ---- G5: the gate step, run against a stand-in gh -----------------------------------------------------------------------------------

const GATE = /gate check must have succeeded/;
const checkRun = (conclusion: string | null, slug = "github-actions") => ({ check_runs: [{ conclusion, status: conclusion ? "completed" : "in_progress", app: { slug } }] });
const NONE = { check_runs: [] };

/** A `gh` that answers `gh api … --jq FILTER` by running FILTER over the next canned response, as the real one does, and records the arguments it was asked with. */
function ghAnswering(dir: string, responses: unknown[]): string {
  const bin = join(dir, "bin");
  responses.forEach((response, i) => write(join(dir, `r${i}.json`), JSON.stringify(response)));
  write(join(dir, "calls"), "0");
  write(join(bin, "gh"), [
    "#!/bin/bash",
    `calls=$(cat "${dir}/calls"); echo $((calls + 1)) > "${dir}/calls"; echo "$*" >> "${dir}/asked"`,
    `[ "$calls" -gt ${responses.length - 1} ] && calls=${responses.length - 1}`,
    'filter=$(printf \'%s\\n\' "$@" | sed -n \'/^--jq$/{n;p}\')',
    `jq -r "$filter" "${dir}/r$calls.json"`,
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function gateRun(script: string, responses: unknown[]): { status: number | null; asked: number; query: string } {
  return scratch("parity-gate-", (dir) => {
    const bin = ghAnswering(dir, responses);
    const step = { ...stepNamed("gate", GATE), run: script };
    const context: Context = { inputs: { "gate-check": "ci-gate" }, steps: {}, needs: {} };
    const result = runStep(step, { cwd: dir, context, env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc", WAIT_SECONDS: "2", POLL_SECONDS: "1" } });
    const asked = existsSync(join(dir, "asked")) ? readFileSync(join(dir, "asked"), "utf8") : "";
    return { status: result.status, asked: Number(readFileSync(join(dir, "calls"), "utf8")), query: asked.split("\n")[0] ?? "" };
  });
}

const strangers = Array.from({ length: 5 }, () => checkRun("success", "someone-else"));

/** What the gate step does wrong, as a list. Empty means it behaves as the row says. */
function gateProblems(script: string): string[] {
  const outcomes: [string, ReturnType<typeof gateRun>, number, number | undefined][] = [
    ["success at once", gateRun(script, [checkRun("success")]), 0, 1],
    ["absent twice, then success", gateRun(script, [NONE, NONE, checkRun("success")]), 0, 3],
    ["running, then success", gateRun(script, [checkRun(null), checkRun("success")]), 0, 2],
    ["running, then failure", gateRun(script, [checkRun(null), checkRun("failure")]), 1, 2],
    ["failure at once", gateRun(script, [checkRun("failure")]), 1, 1],
    ["cancelled", gateRun(script, [checkRun("cancelled")]), 1, 1],
    ["skipped", gateRun(script, [checkRun("skipped")]), 1, 1],
    ["success from an app that is not github-actions", gateRun(script, strangers), 1, undefined],
    ["never appears", gateRun(script, [NONE]), 1, undefined],
  ];
  const problems = outcomes.flatMap(([label, got, want, asked]) => [
    ...(got.status === want ? [] : [`${label}: exit ${got.status}, wanted ${want}`]),
    ...(asked === undefined || got.asked === asked ? [] : [`${label}: asked ${got.asked} times, wanted ${asked}`]),
  ]);
  if (!gateRun(script, [checkRun("success")]).query.includes("check_name=ci-gate")) problems.push("the check asked for is not the one the caller named");
  return problems;
}

const mutated = (script: string, from: string | RegExp, to: string): string => {
  const changed = script.replace(from, to);
  assert.notEqual(changed, script, `the mutation ${from} found nothing to change`);
  return changed;
};

test("parity G5: the gate waits for an absent or running check, passes on success alone, refuses any other conclusion, gives up, and reads no other app's success", () => {
  assert.deepEqual(gateProblems(stepNamed("gate", GATE).run ?? ""), []);
});

test("parity G5: the gate check is seen to FAIL on a step that accepts failure, never waits, never gives up, reads a stranger's success, or asks for another check", () => {
  const script = stepNamed("gate", GATE).run ?? "";
  assert.match(gateProblems(mutated(script, "success) exit 0 ;;", "success|failure) exit 0 ;;")).join("\n"), /failure at once: exit 0/);
  assert.match(gateProblems(mutated(script, "none|pending) ;;", "none|pending) exit 1 ;;")).join("\n"), /absent twice, then success: exit 1/);
  assert.match(gateProblems(mutated(script, /if \[ "\$waited" -ge "\$WAIT_SECONDS" \]; then/, "if false; then")).join("\n"), /never appears: exit null/);
  assert.match(gateProblems(mutated(script, 'map(select(.app.slug == "github-actions")) | ', "")).join("\n"), /not github-actions: exit 0/);
  assert.match(gateProblems(mutated(script, "check_name=$CHECK", "check_name=gate")).join("\n"), /not the one the caller named/);
});

// ---- G5: the tag step, run over a bare remote ---------------------------------------------------------------------------------------

const PUSH = /Push the tags/;
const RELEASES = /A GitHub Release per tag/;
const PACKAGES = [{ name: "a", dir: "packages/a", version: "1.1.0", tag: "a@1.1.0" }, { name: "b", dir: "packages/b", version: "2.0.0", tag: "b@2.0.0" }];

type Tagging = { status: number | null; remoteTags: Record<string, string>; releaseCalls: string[]; main: string; release: string };

/** The tag job's state when it reaches the push: a release commit checked out on a detached HEAD over the merge, the bundle's manifest, the release tool, and a remote. */
function tagJobRun(pushRun: string, remote: { tagAppeared?: boolean; unreadable?: boolean }): Tagging {
  return scratch("parity-tag-", (root) => {
    const bare = join(root, "remote.git");
    git(root, "init", "-q", "--bare", bare);
    const work = join(root, "work");
    git(root, "clone", "-q", bare, work);
    write(join(work, "README.md"), "merge\n");
    git(work, "add", "-A");
    commit(work, "the merge");
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    const main = git(work, "rev-parse", "HEAD").trim();
    for (const { dir, version: v } of PACKAGES) write(join(work, dir, "CHANGELOG.md"), `# p\n\n## ${v}\n\n- the note for ${v}\n`);
    git(work, "add", "-A");
    commit(work, "the release");
    const release = git(work, "rev-parse", "HEAD").trim();
    if (remote.tagAppeared) git(work, "push", "-q", "origin", `${main}:refs/tags/b@2.0.0`);
    const carry = join(root, "tmp", "carry");
    write(join(carry, "release.json"), JSON.stringify({ packages: PACKAGES }));
    mkdirSync(join(work, ".release-tool", "scripts"), { recursive: true });
    copyFileSync(RELEASE_SCRIPT, join(work, ".release-tool", "scripts", "release-per-merge.mjs"));
    const calls = join(root, "gh.log");
    write(join(root, "bin", "gh"), `#!/bin/bash\necho "$*" >> "${calls}"\n`);
    chmodSync(join(root, "bin", "gh"), 0o755);
    if (remote.unreadable) git(work, "remote", "set-url", "origin", join(root, "nowhere.git"));
    const context: Context = { inputs: { "dist-tag": "latest" }, steps: {}, needs: { version: { sha: release } } };
    const env = { PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: join(root, "tmp"), GITHUB_SHA: main };
    // The runner stops a job at its first failed step, so the Release step only runs after a push that succeeded.
    const status = [{ ...stepNamed("tag", PUSH), run: pushRun }, stepNamed("tag", RELEASES)].reduce<number | null>((last, step) => (last === 0 ? runStep(step, { cwd: work, context, env }).status : last), 0);
    const remoteTags = Object.fromEntries(git(bare, "for-each-ref", "refs/tags", "--format=%(refname:short) %(objectname)").split("\n").filter(Boolean).map((line) => line.split(" ")));
    return { status, remoteTags, releaseCalls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [], main, release };
  });
}

/** What the tag step does wrong, as a list. Empty means it behaves as the row says. */
function tagProblems(pushRun: string): string[] {
  const problems: string[] = [];
  const fresh = tagJobRun(pushRun, {});
  if (fresh.status !== 0) problems.push(`two new tags: exit ${fresh.status}`);
  if (fresh.remoteTags["a@1.1.0"] !== fresh.release || fresh.remoteTags["b@2.0.0"] !== fresh.release) problems.push("two new tags: they are not both on the release commit");
  if (fresh.releaseCalls.filter((call) => /^release create (a@1\.1\.0|b@2\.0\.0) --verify-tag /.test(call)).length !== 2) problems.push(`two new tags: no Release per tag, got ${JSON.stringify(fresh.releaseCalls)}`);
  const raced = tagJobRun(pushRun, { tagAppeared: true });
  if (raced.status === 0) problems.push("a tag that appeared since the version job: the step succeeded");
  if (raced.remoteTags["b@2.0.0"] !== raced.main) problems.push("a tag that appeared since the version job: it was MOVED");
  if ("a@1.1.0" in raced.remoteTags) problems.push("a tag that appeared since the version job: the other tag landed, so the push was not atomic");
  if (raced.releaseCalls.length > 0) problems.push(`a tag that appeared since the version job: a Release was cut (${raced.releaseCalls.join("; ")})`);
  const lost = tagJobRun(pushRun, { unreadable: true });
  if (lost.status === 0) problems.push("an unreadable remote: the step succeeded, reading it as free");
  if (lost.releaseCalls.length > 0) problems.push("an unreadable remote: a Release was cut");
  return problems;
}

test("parity G5: the tag step pushes every tag atomically and never forced, moves no tag that appeared, cuts no Release for it, and does not read an unreadable remote as free", () => {
  assert.deepEqual(tagProblems(stepNamed("tag", PUSH).run ?? ""), []);
});

test("parity G5: no step after the push runs when it failed, so a refused push cuts no Release", () => {
  const steps = jobSteps("tag");
  const from = steps.findIndex((step) => PUSH.test(step.name ?? ""));
  assert.ok(from > 0, "positive control: the push step was found");
  const afterwards = steps.slice(from + 1);
  assert.ok(afterwards.length > 0, "positive control: there are steps after it");
  assert.deepEqual(afterwards.filter((step) => /\b(always|failure|cancelled)\(\)/.test(step.if ?? "")), []);
});

test("parity G5: the tag check is seen to FAIL on a push that is not atomic, one that is forced, and one that swallows an unreadable remote", () => {
  const script = stepNamed("tag", PUSH).run ?? "";
  assert.match(tagProblems(mutated(script, "--atomic", "")).join("\n"), /the other tag landed/);
  assert.match(tagProblems(mutated(script, "--atomic", "--atomic --force")).join("\n"), /it was MOVED/);
  const swallowed = mutated(mutated(script, /(git push --atomic .*)/, "$1 || true"), 'if [ "$cut" != "$SHA" ]; then', "if false; then");
  assert.match(tagProblems(swallowed).join("\n"), /an unreadable remote: the step succeeded/);
});
