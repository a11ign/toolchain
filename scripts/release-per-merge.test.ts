import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertWorkflowsHeld, buildRelease, changelogEntry, loneDirOf, namesARelease, parseReleaseTag, unreleasedChangesets, workflowsTree } from "./release-per-merge.ts";

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

const dependencyOf = (root: string, rev: string, pin: { dir: string; field: string; name: string }): string => JSON.parse(git(root, "show", `${rev}:packages/${pin.dir}/package.json`))[pin.field][pin.name];

test("an exact pin on a package that moved to its tag moves with it, so the lockfile refresh never asks the registry for the version main still reads (a11ign/a11ign#4023)", () => {
  inScratch((root) => {
    write(root, "packages/b/package.json", manifest("b", { dependencies: { a: "1.0.0" }, devDependencies: { p: "1.0.0" }, peerDependencies: { a: "^1.0.0" } }));
    commit(root, "b pins a exactly, as main does");
    changeset(root, "one", { a: "minor" });
    const first = cut(root).result;
    changeset(root, "three", { b: "patch" });
    const { result } = cut(root);
    assert.ok(first.released && result.released, "positive control: both releases were made, so the second runs over a main whose a is behind its tag");
    assert.equal(versionOf(root, result.sha, "a"), "1.1.0", "positive control: a is at its tag, which is what leaves main's pin behind");
    assert.equal(dependencyOf(root, result.sha, { dir: "b", field: "dependencies", name: "a" }), "1.1.0", "the exact pin follows a to its tag");
    assert.equal(dependencyOf(root, result.sha, { dir: "b", field: "peerDependencies", name: "a" }), "^1.0.0", "a range is the merge's own and is left");
    assert.equal(dependencyOf(root, result.sha, { dir: "b", field: "devDependencies", name: "p" }), "1.0.0", "a package that did not move keeps its pin");
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

// a11ign/a11ign#4121: a11ign/screenreader-worker's root package was once a workspace package (`@a11ign/screenreader-worker@0.2.0`) and is now the lone root one
// (`v0.3.0`). The named lookup found the older tag and never reached the newer `v` tag, so the next minor was 0.3.0 again, a tag that exists.
test("root package tagged under two forms: the base is the highest of them, so the next release is a new version", () => {
  const root = mkdtempSync(join(tmpdir(), "release-per-merge-"));
  try {
    git(root, "init", "-q", "-b", "main");
    write(root, "package.json", manifest("@x/y", { version: "0.2.0" }));
    write(root, ".changeset/config.json", JSON.stringify({ changelog: require.resolve("@changesets/cli/changelog"), commit: false, baseBranch: "main" }));
    commit(root, "baseline");
    commit(root, "released");
    git(root, "tag", "@x/y@0.2.0");
    git(root, "tag", "v0.3.0");
    changeset(root, "feature", { "@x/y": "minor" });
    git(root, "checkout", "-q", "--detach");
    const result = buildRelease({ cwd: root, changesetVersion, kind: "npm" });
    // Not `cut`: it tags what was computed, and the unfixed 0.3.0 would fail on git's refusal instead of on this assertion.
    assert.ok(result.released, "positive control: the release happened, so the assertions below read a tag and not an empty list");
    assert.deepEqual(result.packages.map(({ tag }) => tag), ["v0.4.0"]);
    assert.equal(JSON.parse(git(root, "show", `${result.sha}:package.json`)).version, "0.4.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// a11ign/a11ign#4332: @a11ign/toolchain was flattened out of a workspace (toolchain#20), so the repository holds `@a11ign/toolchain@0.1.1` to `@0.1.5` AND the lone `v0.1.6`.
// The release pinned before the #4121 fix counted a patch from 0.1.5 and re-cut the 0.1.6 that exists. Each shape the two tag forms can take, with the tags the repository holds.
const tagShapes: { shape: string; tags: string[]; next: string }[] = [
  { shape: "the lone v tag is newer than every named one (the real toolchain tags)", tags: ["@a11ign/toolchain@0.1.4", "@a11ign/toolchain@0.1.5", "v0.1.6"], next: "0.1.7" },
  { shape: "a named tag is newer than the lone v tag", tags: ["v0.1.2", "@a11ign/toolchain@0.1.3", "@a11ign/toolchain@0.1.5"], next: "0.1.6" },
  { shape: "only named tags", tags: ["@a11ign/toolchain@0.1.4", "@a11ign/toolchain@0.1.5"], next: "0.1.6" },
  { shape: "only a lone v tag", tags: ["v0.1.5", "v0.1.6"], next: "0.1.7" },
];
for (const { shape, tags, next } of tagShapes) {
  test(`a patch changeset on a root package releases ${next} when ${shape}`, () => {
    const root = mkdtempSync(join(tmpdir(), "release-per-merge-"));
    try {
      git(root, "init", "-q", "-b", "main");
      write(root, "package.json", manifest("@a11ign/toolchain", { version: "0.1.0" }));
      write(root, ".changeset/config.json", JSON.stringify({ changelog: require.resolve("@changesets/cli/changelog"), commit: false, baseBranch: "main" }));
      commit(root, "baseline");
      commit(root, "released");
      for (const tag of tags) git(root, "tag", tag);
      changeset(root, "fix", { "@a11ign/toolchain": "patch" });
      git(root, "checkout", "-q", "--detach");
      const result = buildRelease({ cwd: root, changesetVersion, kind: "npm" });
      assert.ok(result.released, "positive control: the release happened, so the assertion below reads a tag and not an empty list");
      assert.deepEqual(result.packages.map(({ version }) => version), [next]);
      assert.ok(!tags.some((tag) => tag.endsWith(`@${next}`) || tag === `v${next}`), "the expected version is not already one of the tags");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---- the lone package below the root (a11ign/a11ign#3966) ---------------------------------------------------------------------------

/** a11ign/lab's shape: one private package at `packages/lab`, a `lerna.json` and no pnpm workspace, last released as `v1.0.0`. */
function lerna(): string {
  const root = mkdtempSync(join(tmpdir(), "release-per-merge-"));
  git(root, "init", "-q", "-b", "main");
  write(root, "lerna.json", JSON.stringify({ packages: ["packages/*"], version: "independent" }));
  // `changeset version` reads a lerna layout only with a root `package.json`, which carries no version of its own.
  write(root, "package.json", `${JSON.stringify({ name: "lab-root", private: true }, null, 2)}\n`);
  write(root, "packages/lab/package.json", manifest("@a11ign/lab", { private: true }));
  write(root, ".changeset/README.md", "# Changesets\n");
  write(root, ".changeset/config.json", JSON.stringify({ changelog: require.resolve("@changesets/cli/changelog"), commit: false, baseBranch: "main", privatePackages: { version: true, tag: false } }));
  commit(root, "baseline");
  commit(root, "the release of the baseline");
  git(root, "tag", "v1.0.0");
  return root;
}

type Cut = { kind?: "npm" | "tag"; lonePackageDir?: string };
function cutLerna(root: string, { kind = "tag", lonePackageDir }: Cut = {}) {
  git(root, "checkout", "-q", "--detach");
  try {
    const result = buildRelease({ cwd: root, changesetVersion, kind, lonePackageDir });
    if (result.released) for (const { tag } of result.packages) git(root, "tag", tag);
    return result;
  } finally {
    git(root, "checkout", "-q", "-f", "main");
  }
}

function inLerna(body: (root: string) => void): void {
  const root = lerna();
  try {
    changeset(root, "fix", { "@a11ign/lab": "patch" });
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a private package at a subdirectory is tagged v<version> when the caller names it, and its Release is the latest one", () => {
  inLerna((root) => {
    const result = cutLerna(root, { lonePackageDir: "packages/lab" });
    assert.ok(result.released, "positive control: the release happened, so the assertions below read a tag and not an empty list");
    assert.deepEqual(result.packages.map(({ tag, dir, lone }) => ({ tag, dir, lone })), [{ tag: "v1.0.1", dir: "packages/lab", lone: true }]);
    assert.deepEqual(tags(root), ["v1.0.0", "v1.0.1"]);
    assert.match(git(root, "show", `${result.sha}:packages/lab/CHANGELOG.md`), /## 1\.0\.1/);
  });
});

test("CONTROL: the same repository with the input unset releases nothing and writes no commit", () => {
  inLerna((root) => {
    const head = git(root, "rev-parse", "HEAD").trim();
    const result = cutLerna(root);
    assert.deepEqual(result, { released: false, reason: "the changesets move no releasable package's version" });
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
    assert.deepEqual(tags(root), ["v1.0.0"]);
  });
});

test("kind npm still never releases a private package, named or not", () => {
  inLerna((root) => {
    assert.equal(cutLerna(root, { kind: "npm", lonePackageDir: "packages/lab" }).released, false);
  });
});

test("the next release is versioned from the v-tag the last one cut, and the consumed changeset is not released twice", () => {
  inLerna((root) => {
    assert.ok(cutLerna(root, { lonePackageDir: "packages/lab" }).released);
    commit(root, "docs only");
    assert.equal(cutLerna(root, { lonePackageDir: "packages/lab" }).released, false, "a merge with no new changeset makes no tag");
    changeset(root, "feature", { "@a11ign/lab": "minor" });
    const second = cutLerna(root, { lonePackageDir: "packages/lab" });
    assert.ok(second.released);
    assert.deepEqual(second.packages.map(({ tag }) => tag), ["v1.1.0"]);
    const changelog = git(root, "show", `${second.sha}:packages/lab/CHANGELOG.md`);
    assert.match(changelog, /## 1\.1\.0[\s\S]*## 1\.0\.1/, "the changelog accumulates from the last tag's");
  });
});

test("a directory that holds no package is refused by name, not read as 'nothing to release'", () => {
  inLerna((root) => {
    assert.throws(() => cutLerna(root, { lonePackageDir: "packages/lib" }), /lone-package-dir is 'packages\/lib'.*no package\.json is tracked there/);
    assert.deepEqual(tags(root), ["v1.0.0"]);
  });
});

test("naming a directory makes the root an ordinary package: its manifest is not given the lone package's version, and it is not tagged v<version>", () => {
  inLerna((root) => {
    const rootManifest = readFileSync(join(root, "package.json"), "utf8");
    const result = cutLerna(root, { lonePackageDir: "packages/lab" });
    assert.ok(result.released);
    assert.equal(git(root, "show", `${result.sha}:package.json`), rootManifest, "the release commit leaves the root's package.json as the merge had it");
    assert.deepEqual(result.packages.map(({ tag }) => tag), ["v1.0.1"]);
  });
});

test("the input is read as a directory inside the repository", () => {
  assert.equal(loneDirOf(undefined), null);
  assert.equal(loneDirOf(""), null);
  assert.equal(loneDirOf("  "), null);
  assert.equal(loneDirOf("packages/lab"), "packages/lab");
  assert.equal(loneDirOf("./packages/lab/"), "packages/lab");
  assert.equal(loneDirOf("."), ".");
  for (const outside of ["..", "../x", "/etc", "packages/../.."]) assert.throws(() => loneDirOf(outside), /a directory inside the repository/, outside);
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

// ---- the tip's workflows, so GitHub reads no workflow change in the pushed commit (a11ign/a11ign#4010) -----------------------------------

const WORKFLOW_FILE = ".github/workflows/ci.yml";

/** The merge being released has `ci.yml` as `before`; `main` then moves on by one more merge (the tip) that rewrites it as `after`, or removes the directory. */
function releasedBehindATip(root: string, tip: { after: string } | "removed" | "unchanged"): string {
  write(root, WORKFLOW_FILE, "name: before\n");
  changeset(root, "one", { a: "minor" });
  git(root, "branch", "tip");
  git(root, "switch", "-q", "tip");
  if (tip === "removed") git(root, "rm", "-q", WORKFLOW_FILE);
  else if (tip !== "unchanged") write(root, WORKFLOW_FILE, tip.after);
  commit(root, "a merge that touched the workflows after the one being released");
  git(root, "switch", "-q", "main");
  return "tip";
}

/** `cut`, with the tip named, and the release commit it made. */
function cutWithTip(root: string, tip: string) {
  git(root, "checkout", "-q", "--detach");
  try {
    const result = buildRelease({ cwd: root, changesetVersion, kind: "npm", tip });
    assert.ok(result.released, "positive control: a release was made, so the reads below are of a release commit and not of nothing");
    return result.sha;
  } finally {
    git(root, "checkout", "-q", "-f", "main");
  }
}

test("a release commit takes the tip's workflows, so GitHub reads no workflow change, while its parent stays the merge released", () => {
  inScratch((root) => {
    const tip = releasedBehindATip(root, { after: "name: after\n" });
    const released = git(root, "rev-parse", "main").trim();
    const sha = cutWithTip(root, tip);
    assert.equal(git(root, "show", `${sha}:${WORKFLOW_FILE}`), "name: after\n", "the tip's workflow file, not the merge released's");
    assert.equal(workflowsTree(root, sha), workflowsTree(root, tip), "the same directory object, which is what GitHub compares");
    assert.equal(git(root, "rev-parse", `${sha}^`).trim(), released, "the parent is still the merge released");
    assert.equal(versionOf(root, sha, "a"), "1.1.0", "the versions are still written");
    assert.deepEqual(git(root, "diff", "--name-only", "--diff-filter=D", `${sha}^`, sha, "--", ".changeset").split("\n").filter(Boolean), [".changeset/one.md"], "what the release consumed is still read off its deletions");
  });
});

test("without a tip the release commit keeps the workflows of the merge released, and a tip that agrees changes nothing", () => {
  inScratch((root) => {
    releasedBehindATip(root, { after: "name: after\n" });
    const { result } = cut(root);
    assert.ok(result.released, "positive control");
    assert.equal(git(root, "show", `${result.sha}:${WORKFLOW_FILE}`), "name: before\n", "no tip, no graft");
  });
  inScratch((root) => {
    const tip = releasedBehindATip(root, "unchanged");
    const sha = cutWithTip(root, tip);
    assert.equal(git(root, "show", `${sha}:${WORKFLOW_FILE}`), "name: before\n");
    assert.equal(git(root, "rev-list", "--count", `${sha}^..${sha}`).trim(), "1", "one commit, amended in place or not at all");
  });
});

test("a tip with no workflows directory removes it from the release commit", () => {
  inScratch((root) => {
    const tip = releasedBehindATip(root, "removed");
    assert.equal(workflowsTree(root, tip), "", "positive control: the tip really has none");
    const sha = cutWithTip(root, tip);
    assert.equal(workflowsTree(root, sha), "");
  });
});

test("the tag job's check refuses, in words, a release commit whose workflows the tip has moved, and passes one whose they are", () => {
  inScratch((root) => {
    const tip = releasedBehindATip(root, { after: "name: after\n" });
    const grafted = cutWithTip(root, tip);
    assert.doesNotThrow(() => assertWorkflowsHeld({ cwd: root, commit: grafted, tip }));
    git(root, "switch", "-q", "tip");
    write(root, WORKFLOW_FILE, "name: moved again\n");
    commit(root, "the workflows move while the release runs");
    assert.throws(() => assertWorkflowsHeld({ cwd: root, commit: grafted, tip }), /moved on the default branch after this release commit was built.*no tag is pushed/);
  });
});

test("the workflow reads the tip after the caller's code has run, hands it to the version step, and checks it before the tags are pushed", () => {
  const { jobs } = real();
  const versionSteps = jobs.version.steps ?? [];
  const index = (steps: Step[], pattern: RegExp): number => steps.findIndex((step) => pattern.test(step.run ?? ""));
  const install = index(versionSteps, /pnpm install/);
  const fetchTip = index(versionSteps, /git fetch .*refs\/heads\/main:refs\/remotes\/tip\/main/);
  const release = index(versionSteps, /release-per-merge\.mjs version/);
  assert.ok(install >= 0 && fetchTip >= 0 && release >= 0, "positive control: the three steps were found");
  assert.ok(install < fetchTip && fetchTip < release, "the tip is read after the install (which runs the caller's code) and before the release commit");
  assert.equal((versionSteps[release] as { env?: Record<string, string> }).env?.TIP, "refs/remotes/tip/main", "the version step is told where the tip is");
  assert.equal(versionSteps[install].run?.includes("TOKEN"), false, "the step that runs the caller's code holds no token");
  const tagSteps = jobs.tag.steps ?? [];
  const check = index(tagSteps, /release-per-merge\.mjs check-workflows/);
  const push = index(tagSteps, /\bgit push\b/);
  assert.ok(check >= 0 && push >= 0 && check < push, "the tag job checks the tip's workflows before it pushes");
});
