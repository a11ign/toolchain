import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildRelease, changelogEntry, namesARelease, parseReleaseTag, unreleasedChangesets } from "./release-per-merge.mjs";

// WHAT THIS PINS, AND HOW IT READS THE WORKFLOW. `release-per-merge.yml` is read as YAML and judged on STRUCTURE (keys, permissions, `needs`,
// `if`), never on words: the file's comments explain WHY in the very words a text match would find. The version logic is not read at all:
// it is RUN, over a scratch git repository whose tags and changesets this file makes, with the real `changeset version`.

const require = createRequire(import.meta.url);
const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release-per-merge.yml");

type Step = { run?: string; uses?: string; with?: Record<string, unknown>; if?: string };
type Job = { needs?: string | string[]; if?: string; environment?: string; permissions?: Record<string, string>; steps?: Step[] };
export type Workflow = { on?: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: unknown }; jobs: Record<string, Job> };

const real = (): Workflow => parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
const needsOf = (job: Job): string[] => [job.needs ?? []].flat();
const runOf = (job: Job): string => (job.steps ?? []).map((step) => step.run ?? "").join("\n");
const permissionsOf = (job: Job, workflow: Workflow): Record<string, string> => job.permissions ?? workflow.permissions ?? {};

/** Every job `name` waits for, directly or not. */
function waitsFor(workflow: Workflow, name: string): Set<string> {
  const seen = new Set<string>();
  const stack = needsOf(workflow.jobs[name] ?? {});
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...needsOf(workflow.jobs[next] ?? {}));
  }
  return seen;
}

/** A `git push` whose every ref is a tag is the release; any other push writes a branch. */
const pushesABranch = (run: string): boolean => run.split("\n").some((line) => /\bgit push\b/.test(line) && !/refs\/tags\//.test(line));
const forcesAPush = (run: string): boolean => run.split("\n").some((line) => /\bgit push\b/.test(line) && /(\s-f\b|--force)/.test(line));
const writesAnything = (job: Job, workflow: Workflow): boolean =>
  Object.values(permissionsOf(job, workflow)).includes("write") || /\bgit push\b|\bgh release\b/.test(runOf(job));

/** The properties the issue names, each as the text a refusal carries. An empty list is the workflow being as the direction says. */
export function violations(workflow: Workflow): string[] {
  const found: string[] = [];
  const jobs = Object.entries(workflow.jobs);
  const triggers = Object.keys(workflow.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== "workflow_call") found.push(`trigger: ${triggers.join(",")} is not workflow_call alone, so something can run it from a branch`);
  for (const [name, job] of jobs) {
    if (permissionsOf(job, workflow)["pull-requests"] === "write") found.push(`version pull request: ${name} holds pull-requests: write`);
    if ((job.steps ?? []).some((step) => /changesets\/action/.test(step.uses ?? ""))) found.push(`version pull request: ${name} uses changesets/action`);
    if (/gh pr create|gh pr edit/.test(runOf(job))) found.push(`version pull request: ${name} opens a pull request`);
    if (pushesABranch(runOf(job))) found.push(`branch push: ${name} pushes something that is not a tag`);
    if (forcesAPush(runOf(job))) found.push(`forced push: ${name} forces a push, and a tag is never moved`);
  }
  found.push(...publishViolations(workflow), ...gateViolations(workflow), ...concurrencyViolations(workflow));
  return found;
}

function publishViolations(workflow: Workflow): string[] {
  const found: string[] = [];
  const holders = Object.entries(workflow.jobs).filter(([, job]) => permissionsOf(job, workflow)["id-token"] === "write");
  if (holders.length !== 1) found.push(`publish permission: ${holders.length} jobs hold id-token: write, expected exactly the publishing one`);
  for (const [name, job] of holders) {
    if (job.environment !== "npm-publish") found.push(`publish permission: ${name} holds id-token: write outside the npm-publish environment`);
    if (!/inputs\.kind == 'npm'/.test(job.if ?? "")) found.push(`publish permission: ${name} holds id-token: write and is not restricted to the npm kind`);
  }
  return found;
}

function gateViolations(workflow: Workflow): string[] {
  const found: string[] = [];
  const gate = workflow.jobs.gate;
  if (!gate) return ["gate wait: there is no gate job"];
  if (writesAnything(gate, workflow)) found.push("gate wait: the gate job itself writes");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "gate" && writesAnything(job, workflow) && !waitsFor(workflow, name).has("gate")) found.push(`gate wait: ${name} writes without waiting for gate`);
  }
  return found;
}

function concurrencyViolations(workflow: Workflow): string[] {
  const { concurrency } = workflow;
  if (!concurrency?.group) return ["concurrency: no group, so two releases can run at once"];
  return concurrency["cancel-in-progress"] === false ? [] : ["concurrency: cancel-in-progress is not false, so a release can be cancelled half way"];
}

const mutate = (change: (workflow: Workflow) => void): Workflow => {
  const workflow = real();
  change(workflow);
  return workflow;
};

test("the workflow is as the direction says: no property violated", () => {
  const workflow = real();
  assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_call"], "positive control: the trigger block was found and read");
  assert.ok(Object.keys(workflow.jobs).length >= 4, "positive control: the jobs were found, so an empty list below is a pass and not an empty read");
  assert.deepEqual(violations(workflow), []);
});

test("the publish job holds the OIDC permission in the environment limited to main, and the other jobs never hold it", () => {
  const workflow = real();
  const holders = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.["id-token"] === "write");
  assert.deepEqual(holders.map(([name]) => name), ["publish"]);
  assert.equal(holders[0][1].environment, "npm-publish");
});

test("every property has a control that is REFUSED, naming the property", () => {
  const controls: [string, Workflow, RegExp][] = [
    ["a trigger that can run from a branch", mutate((w) => void (w.on = { workflow_call: {}, workflow_dispatch: {} })), /^trigger:/],
    ["a branch push", mutate((w) => void w.jobs.tag.steps?.push({ run: "git push origin HEAD:main" })), /^branch push: tag/],
    ["a forced tag push", mutate((w) => void w.jobs.tag.steps?.push({ run: "git push --force origin sha:refs/tags/x" })), /^forced push: tag/],
    ["a version pull request step", mutate((w) => void w.jobs.version.steps?.push({ uses: "changesets/action@v1" })), /^version pull request: version uses changesets\/action/],
    ["a pull request permission", mutate((w) => void (w.jobs.tag.permissions = { contents: "write", "pull-requests": "write" })), /^version pull request: tag holds pull-requests: write/],
    ["the gate wait removed", mutate((w) => void (w.jobs.version.needs = [])), /^gate wait: version writes without waiting for gate|^gate wait: tag writes/],
    ["the gate job removed", mutate((w) => void delete w.jobs.gate), /^gate wait: there is no gate job/],
    ["the publish permission on the tag kind", mutate((w) => void (w.jobs.publish.if = "needs.version.outputs.released == 'true'")), /^publish permission: publish .* not restricted to the npm kind/],
    ["the publish permission on a second job", mutate((w) => void (w.jobs.version.permissions = { contents: "read", "id-token": "write" })), /^publish permission: 2 jobs hold id-token/],
    ["the publish job outside its environment", mutate((w) => void delete w.jobs.publish.environment), /^publish permission: publish holds id-token: write outside the npm-publish environment/],
    ["a release that can be cancelled", mutate((w) => void (w.concurrency = { group: "release", "cancel-in-progress": true })), /^concurrency: cancel-in-progress/],
    ["no concurrency at all", mutate((w) => void delete w.concurrency), /^concurrency: no group/],
  ];
  for (const [what, workflow, property] of controls) {
    const found = violations(workflow);
    assert.ok(found.some((line) => property.test(line)), `${what}: expected a refusal matching ${property}, got ${JSON.stringify(found)}`);
  }
});

// ---- the version logic, run over a scratch repository ------------------------------------------------------------------------------

function sh(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const git = (cwd: string, ...args: string[]): string => sh(cwd, "git", args);

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name, version: "1.0.0", ...extra }, null, 2)}\n`;

/** The real `changeset version`, run from this repository's own install. */
function changesetVersion(cwd: string): void {
  sh(cwd, process.execPath, [require.resolve("@changesets/cli/bin.js"), "version"]);
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message);
}

/** A repository the way a workspace repository stands after its last release: `a` and `b` public, `p` private, all at 1.0.0 and tagged. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "release-per-merge-"));
  git(root, "init", "-q", "-b", "main");
  write(root, "package.json", manifest("workspace", { private: true }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  for (const [dir, extra] of [["a", {}], ["b", {}], ["p", { private: true }]] as const) write(root, `packages/${dir}/package.json`, manifest(dir, extra));
  write(root, ".changeset/README.md", "# Changesets\n");
  write(root, ".changeset/config.json", JSON.stringify({ changelog: require.resolve("@changesets/cli/changelog"), commit: false, access: "public", baseBranch: "main", privatePackages: { version: false, tag: false } }));
  commit(root, "baseline");
  commit(root, "the release of the baseline");
  git(root, "tag", "a@1.0.0");
  git(root, "tag", "b@1.0.0");
  return root;
}

function changeset(root: string, file: string, bumps: Record<string, string>): void {
  const frontmatter = Object.entries(bumps).map(([name, bump]) => `"${name}": ${bump}`).join("\n");
  write(root, `.changeset/${file}.md`, `---\n${frontmatter}\n---\n\n${file} says what changed\n`);
  commit(root, `merge ${file}`);
}

/** What the workflow does around `buildRelease`: on a detached HEAD, tag each package at the release commit, and leave `main` where it was. */
function cut(root: string, released?: (cwd: string) => Set<string>) {
  const main = git(root, "rev-parse", "main").trim();
  git(root, "checkout", "-q", "--detach");
  try {
    const result = buildRelease({ cwd: root, changesetVersion, kind: "npm", released });
    if (result.released) for (const { tag } of result.packages) git(root, "tag", tag);
    return { result, main };
  } finally {
    git(root, "checkout", "-q", "-f", "main");
  }
}

const tags = (root: string): string[] => git(root, "tag", "--list").split("\n").filter(Boolean).sort();
const versionOf = (root: string, rev: string, dir: string): string => JSON.parse(git(root, "show", `${rev}:packages/${dir}/package.json`)).version;

/** The property the control is red on: a release made when nothing new was merged. */
const reReleases = (result: { released: boolean; packages?: { tag: string }[] }): string[] =>
  result.released ? [`re-releases ${result.packages?.map(({ tag }) => tag).join(", ")} for a merge carrying no new changeset`] : [];

function inScratch(body: (root: string) => void): void {
  const root = workspace();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a merge carrying two unreleased changesets makes ONE version, tags only the package they name, and leaves main alone", () => {
  inScratch((root) => {
    changeset(root, "one", { a: "minor" });
    changeset(root, "two", { a: "patch" });
    const { result, main } = cut(root);
    assert.ok(result.released, "positive control: a release was made");
    assert.deepEqual(result.packages.map(({ tag }) => tag), ["a@1.1.0"], "one version for both changesets (minor wins over patch), and b did not move");
    assert.deepEqual(tags(root), ["a@1.0.0", "a@1.1.0", "b@1.0.0"]);
    assert.equal(git(root, "rev-parse", "main").trim(), main, "main was not written");
    assert.equal(git(root, "branch", "--contains", result.sha).trim(), "", "the release commit is on no branch");
    assert.equal(git(root, "rev-parse", `${result.sha}^1`).trim(), main, "it sits on top of the merge");
    assert.equal(versionOf(root, result.sha, "a"), "1.1.0");
    assert.equal(versionOf(root, "main", "a"), "1.0.0", "main's own version lags the tag");
    assert.match(git(root, "show", `${result.sha}:packages/a/CHANGELOG.md`), /## 1\.1\.0/);
    assert.equal(git(root, "ls-tree", "--name-only", result.sha, ".changeset/").split("\n").filter((f) => f.endsWith(".md") && !f.endsWith("README.md")).length, 0, "the release commit holds no changeset: that is what the next run reads");
  });
});

test("a merge after it with no changeset of its own makes NO tag, though main still carries the released ones", () => {
  inScratch((root) => {
    changeset(root, "one", { a: "minor" });
    changeset(root, "two", { a: "patch" });
    cut(root);
    const before = tags(root);
    write(root, "README.md", "a merge with no changeset\n");
    commit(root, "docs only");
    assert.equal(unreleasedChangesets({ cwd: root }).present.length, 2, "positive control: both released changesets are still on main, so only the subtraction keeps them from being pending");
    const { result } = cut(root);
    assert.equal(result.released, false);
    assert.deepEqual(tags(root), before);
    assert.deepEqual(reReleases(result), []);
  });
});

test("CONTROL: the same repository with the 'already consumed' subtraction removed re-releases, and is RED", () => {
  inScratch((root) => {
    changeset(root, "one", { a: "minor" });
    changeset(root, "two", { a: "patch" });
    cut(root);
    write(root, "README.md", "a merge with no changeset\n");
    commit(root, "docs only");
    const { result } = cut(root, () => new Set());
    assert.ok(result.released, "without the subtraction the two released changesets are pending again");
    assert.match(reReleases(result)[0] ?? "", /re-releases a@1\.2\.0 for a merge carrying no new changeset/);
  });
});

test("the next package to release is versioned from its OWN last tag, and a package that did not move keeps its changelog", () => {
  inScratch((root) => {
    changeset(root, "one", { a: "minor" });
    const first = cut(root).result;
    changeset(root, "three", { b: "patch" });
    const { result } = cut(root);
    assert.ok(first.released && result.released);
    assert.deepEqual(result.packages.map(({ tag }) => tag), ["b@1.0.1"], "only b has a pending changeset, so only b is tagged");
    assert.equal(versionOf(root, result.sha, "a"), "1.1.0", "a is at its own last tag in this release commit, not at main's 1.0.0");
    const changelog = git(root, "show", `${result.sha}:packages/a/CHANGELOG.md`);
    assert.equal(changelog.match(/## 1\.1\.0/g)?.length, 1, "a's entry is carried once, not repeated");
    assert.deepEqual(tags(root), ["a@1.0.0", "a@1.1.0", "b@1.0.0", "b@1.0.1"]);
  });
});

test("a changeset naming only a private package releases nothing and writes no commit", () => {
  inScratch((root) => {
    changeset(root, "private", { p: "minor" });
    const head = git(root, "rev-parse", "HEAD").trim();
    const { result } = cut(root);
    assert.equal(result.released, false);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head, "no release commit was made");
    assert.equal(tags(root).some((tag) => tag.startsWith("p@")), false);
  });
});

test("an empty changeset is not unreleased, and the lone package at the root is tagged v<version>", () => {
  const root = mkdtempSync(join(tmpdir(), "release-per-merge-"));
  try {
    git(root, "init", "-q", "-b", "main");
    write(root, "package.json", manifest("solo"));
    write(root, ".changeset/config.json", JSON.stringify({ changelog: require.resolve("@changesets/cli/changelog"), commit: false, baseBranch: "main" }));
    write(root, ".changeset/empty.md", "---\n---\n");
    commit(root, "baseline");
    commit(root, "released");
    git(root, "tag", "v1.0.0");
    assert.deepEqual(unreleasedChangesets({ cwd: root }).unreleased, [], "an empty changeset names no release");
    changeset(root, "fix", { solo: "patch" });
    const { result } = cut(root);
    assert.ok(result.released);
    assert.deepEqual(result.packages.map(({ tag }) => tag), ["v1.0.1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-release mode is refused: every tag is a plain x.y.z", () => {
  inScratch((root) => {
    changeset(root, "one", { a: "minor" });
    write(root, ".changeset/pre.json", "{}");
    commit(root, "pre");
    assert.throws(() => cut(root), /pre-release mode/);
  });
});

test("tag names, empty changesets and changelog entries read as changesets writes them", () => {
  assert.deepEqual(parseReleaseTag("@a11ign/toolchain@0.1.0"), { name: "@a11ign/toolchain", version: "0.1.0" });
  assert.deepEqual(parseReleaseTag("v0.2.0"), { name: null, version: "0.2.0" });
  assert.deepEqual(parseReleaseTag("a@1.0.0"), { name: "a", version: "1.0.0" });
  for (const notATag of ["latest", "v1", "a@1.0.0-beta.1", "release-v1"]) assert.equal(parseReleaseTag(notATag), null, notATag);
  assert.equal(namesARelease('---\n"a": minor\n---\n\ntext\n'), true);
  assert.equal(namesARelease("---\n---\n"), false);
  assert.equal(changelogEntry("# a\n\n## 1.1.0\n\n- new\n\n## 1.0.0\n\n- old\n", "1.1.0"), "- new\n");
  assert.throws(() => changelogEntry("# a\n\n## 1.0.0\n\n- old\n", "1.1.0"), /no entry for 1\.1\.0/);
});
