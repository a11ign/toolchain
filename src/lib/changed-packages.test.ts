/**
 * `changed-packages.ts`: which `packages/<name>` directories a branch touched against `origin/main`'s MERGE-BASE with HEAD, for the pre-push fast gate and CI.
 *
 * What is pinned:
 *   1. `changedPackages` (pure) names each package once, sorted, from the diff's path lines, and ignores everything not directly under `packages/<name>/`
 *      (root scripts, docs, a file sitting in `packages/` itself, a path that merely CONTAINS `packages/`).
 *   2. EMPTY MEANS "RUN EVERYTHING", NEVER "NOTHING TO VERIFY": a diff touching nothing under `packages/`, and any git failure (no `origin/main`), both give `[]`.
 *   3. THE MERGE-BASE, not `origin/main`: work another branch landed on `origin/main` after this branch forked is NOT reported as changed here.
 *   4. `--no-renames` (#939): moving a file OUT of a package implicates that package too.
 *   5. The CLI prints the names space-separated, takes no flags and refuses one.
 *
 * THE FIXTURE: the module computes its repository root from its OWN location (`../../`), so it is COPIED, with the files it imports, into a throwaway
 * git repository and imported from there. It therefore reads that repository and never this checkout. The positive control for every `[]` is the
 * same fixture with the change present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { sandboxGitEnv } from "./git-sandbox.ts";
import { changedPackages, changedPackagesAgainstOrigin, filesChangedAgainstOrigin } from "./changed-packages.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RENAME_BODY_LINES = 5;
const COPIED = ["src/lib/changed-packages.ts", "src/lib/git-env.ts", "src/lib/changed-files.ts", "src/lib/cli-flags.ts"];

test("changedPackages names each package once, sorted", () => {
  const diff = ["packages/judge/src/a.ts", "packages/cli/src/b.ts", "packages/judge/src/c.ts", "packages/cli/package.json"].join("\n");
  assert.deepEqual(changedPackages(diff), ["cli", "judge"]);
});

test("changedPackages ignores paths not directly under packages/<name>/, and tolerates whitespace, CRLF and blank lines", () => {
  const diff = ["scripts/x.mjs", "docs/packages/y.md", "packages/loose-file.json", "packages/", "", "  packages/evidence/src/z.ts  ", "packages/guards/src/a.mjs\r"].join("\n");
  assert.deepEqual(changedPackages(diff), ["evidence", "guards"]);
});

test("changedPackages of an empty diff is empty (the positive control is the populated diff above)", () => {
  assert.deepEqual(changedPackages(""), []);
  assert.deepEqual(changedPackages("README.md\n.github/workflows/ci.yml\n"), []);
  assert.deepEqual(changedPackages("packages/a/x"), ["a"]);
});

interface Tree { dir: string; git: (...args: string[]) => string; load: () => Promise<typeof import("./changed-packages.ts")>; cli: (args?: string[]) => ReturnType<typeof spawnSync> }

/** A throwaway repository holding copies of the module and what it imports, committed, with `origin/main` at that commit. */
async function withTree(body: (tree: Tree) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "changed-packages-test-")));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Changed Packages Test", "-c", "user.email=changed-packages@example.invalid", ...args],
    { cwd: dir, env: sandboxGitEnv(), encoding: "utf8" });
  try {
    for (const file of COPIED) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(REPO_ROOT, file), join(dir, file));
    }
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const script = join(dir, COPIED[0]);
    await body({
      dir,
      git,
      load: () => import(pathToFileURL(script).href),
      cli: (args = []) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env: sandboxGitEnv() }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitFile(tree: Tree, path: string, text: string): void {
  mkdirSync(dirname(join(tree.dir, path)), { recursive: true });
  writeFileSync(join(tree.dir, path), text);
  tree.git("add", "-A");
  tree.git("commit", "-q", "-m", `touch ${path}`);
}

test("a branch with no commits against origin/main touches nothing: [] files and [] packages", async () => {
  await withTree(async (tree) => {
    const mod = await tree.load();
    assert.deepEqual(mod.filesChangedAgainstOrigin(), []);
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), []);
  });
});

test("the files and the packages a branch changed are reported, the packages deduped and sorted", async () => {
  await withTree(async (tree) => {
    commitFile(tree, "packages/judge/src/a.ts", "a");
    commitFile(tree, "packages/cli/src/b.ts", "b");
    commitFile(tree, "packages/judge/src/c.ts", "c");
    commitFile(tree, "docs/note.md", "d");
    const mod = await tree.load();
    assert.deepEqual(mod.filesChangedAgainstOrigin().sort(), ["docs/note.md", "packages/cli/src/b.ts", "packages/judge/src/a.ts", "packages/judge/src/c.ts"]);
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), ["cli", "judge"]);
  });
});

test("a branch that touched only docs and root files reports files but [] packages (the caller then runs everything)", async () => {
  await withTree(async (tree) => {
    commitFile(tree, "docs/note.md", "d");
    commitFile(tree, "package.json", "{}");
    const mod = await tree.load();
    assert.deepEqual(mod.filesChangedAgainstOrigin().sort(), ["docs/note.md", "package.json"]);
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), []);
  });
});

test("the diff is against the MERGE-BASE: a package that origin/main gained after the fork is not reported", async () => {
  await withTree(async (tree) => {
    tree.git("checkout", "-q", "-b", "feature");
    commitFile(tree, "packages/mine/src/a.ts", "a");
    tree.git("checkout", "-q", "main");
    commitFile(tree, "packages/landed-upstream/src/z.ts", "z");
    tree.git("update-ref", "refs/remotes/origin/main", "HEAD");
    tree.git("checkout", "-q", "feature");
    const mod = await tree.load();
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), ["mine"]);
  });
});

test("a file moved OUT of a package implicates both packages (no rename detection, #939)", async () => {
  await withTree(async (tree) => {
    commitFile(tree, "packages/old/src/moved.ts", "same contents so git would call this a rename\n".repeat(RENAME_BODY_LINES));
    tree.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(tree.dir, "packages/new/src"), { recursive: true });
    renameSync(join(tree.dir, "packages/old/src/moved.ts"), join(tree.dir, "packages/new/src/moved.ts"));
    tree.git("add", "-A");
    tree.git("commit", "-q", "-m", "move");
    const mod = await tree.load();
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), ["new", "old"]);
  });
});

test("with no origin/main (or any git failure) the answer is [] rather than a throw", async () => {
  await withTree(async (tree) => {
    commitFile(tree, "packages/judge/src/a.ts", "a");
    const mod = await tree.load();
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), ["judge"], "positive control: with origin/main it is not empty");
    tree.git("update-ref", "-d", "refs/remotes/origin/main");
    assert.deepEqual(mod.filesChangedAgainstOrigin(), []);
    assert.deepEqual(mod.changedPackagesAgainstOrigin(), []);
  });
});

test("the CLI prints the changed package names space-separated and nothing else", async () => {
  await withTree(async (tree) => {
    const quiet = tree.cli();
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
    commitFile(tree, "packages/judge/src/a.ts", "a");
    commitFile(tree, "packages/cli/src/b.ts", "b");
    const result = tree.cli();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "cli judge");
  });
});

test("the CLI takes no flags and refuses one rather than ignoring it", async () => {
  await withTree(async (tree) => {
    commitFile(tree, "packages/judge/src/a.ts", "a");
    const result = tree.cli(["--bogus"]);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /unknown flag --bogus/);
    assert.equal(result.stdout, "");
  });
});

/** What git itself says this checkout changed against its merge-base with origin/main, asked read-only with GIT_* scrubbed; [] when git cannot say. */
function independentFilesChanged(): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, env: sandboxGitEnv(), encoding: "utf8" });
  try {
    const base = git("merge-base", "HEAD", "origin/main").trim();
    return git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("against THIS checkout (read-only) the module agrees with git's own merge-base diff, whatever it holds", () => {
  const expectedFiles = independentFilesChanged();
  assert.deepEqual(filesChangedAgainstOrigin(), expectedFiles);
  assert.deepEqual(changedPackagesAgainstOrigin(), changedPackages(expectedFiles.join("\n")));
});

test("the real CLI prints exactly those package names, space-separated", () => {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, COPIED[0])], { cwd: tmpdir(), encoding: "utf8", env: sandboxGitEnv() });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, changedPackages(independentFilesChanged().join("\n")).join(" "));
});
