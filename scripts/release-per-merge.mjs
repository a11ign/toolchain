// @ts-check
// command: version a merge's unreleased changesets onto a detached release commit and name the tags it earns
// THE VERSION LOGIC OF `.github/workflows/release-per-merge.yml`, kept in a script so a test can run it over a scratch repository.
//
// A RELEASE IS A COMMIT ON NO BRANCH. It sits on top of the merge that carried the changesets, holds the versions and changelogs
// `changeset version` wrote, and is reachable only from the tags. `main` is never written, so its own versions and changelogs lag
// the last tag and nothing reads them: the base of the next release is the TAG's tree, never `main`'s.
//
// WHAT HAS BEEN RELEASED, WITH SEVERAL PACKAGES AND NO SINGLE LAST TAG. `main` keeps every changeset file for ever, so "pending"
// would be everything. A release commit deletes from its parent every changeset that parent carried, so the files a release commit
// DELETED are the ones it consumed. Every release tag (`name@x.y.z`, or `vx.y.z` for a lone root package) points at a release
// commit; the UNION of what those commits deleted is what has been released, and what is unreleased is the present files minus
// that union. A package that was not released in a merge has its own tag from an earlier one, which is where its base comes from.
// This reads the old version-pull-request regime too: the merge of a "Version packages" pull request deleted what it consumed.
//
// THE LONE PACKAGE NEED NOT BE AT THE ROOT (a11ign/a11ign#3966). A repository that releases as one thing (a tag `vx.y.z` consumers pin) may keep its
// one versioned package in a subdirectory, in a layout with no workspace at the root (a11ign/lab: `packages/lab`, `private: true`). The caller names
// that directory (`lone-package-dir`); the package there is tagged `vx.y.z` exactly as a root package is, and under `kind: tag` is released though
// private. Where the caller names none, nothing here differs from before.
//
// WHAT IS REFUSED BEFORE A TAG EXISTS (parity with agent-org's own release, a11ign/a11ign#3964): a version that is not MAJOR.MINOR.PATCH, and a
// package whose CHANGELOG.md has no entry for the version it moved to. Both throw in `buildRelease`, before the release commit, so the bundle never
// leaves the `version` job: the `tag` job reads the same entry only to write the Release, and a tag with no Release is what this prevents.
//
// THE RELEASE COMMIT CARRIES THE TIP'S `.github/workflows` (a11ign/a11ign#4010). GitHub refuses a push, by `GITHUB_TOKEN`, of a commit whose
// `.github/workflows` differs from the TIP of the default branch ("refusing to allow a GitHub App to create or update workflow ... without
// `workflows` permission"), and it compares against the tip, NOT against the commit's parent. Measured 2026-10-07: a commit changing one
// `.txt` file was refused on an old parent and accepted on the tip's; an old parent with the tip's workflows was accepted; the REST API is
// refused identically. A release commit sits on the merge it releases, so any workflow file merged since made every tag push fail. The
// commit therefore takes its `.github/workflows` from the tip (`graftTipWorkflows`, `TIP`), and the `tag` job checks, before pushing, that
// the tip has not moved them again (`assertWorkflowsHeld`). The parent is still the merge released; only this one directory differs.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_BUMP = /:\s*(major|minor|patch)\s*$/;
const COMMITTER = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} a @param {string} b @returns {number} */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => (SEMVER.exec(version) ?? []).slice(1).map(Number));
  return x.reduce((order, part, i) => order || part - y[i], 0);
}

/**
 * `name@x.y.z` for a package in a workspace, `vx.y.z` for the lone package at the root: changesets' own tag names.
 * @param {string} tag @returns {{ name: string | null, version: string } | null}
 */
export function parseReleaseTag(tag) {
  const at = tag.lastIndexOf("@");
  const [name, version] = at > 0 ? [tag.slice(0, at), tag.slice(at + 1)] : [null, tag.startsWith("v") ? tag.slice(1) : ""];
  return SEMVER.test(version) ? { name, version } : null;
}

/** @param {string} cwd @returns {{ tag: string, name: string | null, version: string }[]} */
function releaseTags(cwd) {
  return git(cwd, ["tag", "--list"])
    .split("\n")
    .flatMap((tag) => {
      const parsed = parseReleaseTag(tag);
      return parsed ? [{ tag, ...parsed }] : [];
    });
}

/**
 * The changesets every release tag's commit consumed: the files it deleted from its first parent.
 * @param {string} cwd @returns {Set<string>}
 */
export function releasedChangesets(cwd) {
  const commits = new Set(releaseTags(cwd).map(({ tag }) => git(cwd, ["rev-parse", `${tag}^{commit}`]).trim()));
  const consumed = new Set();
  for (const commit of commits) {
    // A root commit has no parent to have deleted anything from. `rev-list` says so by printing nothing, where a failed `diff` could be anything.
    if (!git(cwd, ["rev-list", "--parents", "-n1", commit]).trim().includes(" ")) continue;
    const deleted = git(cwd, ["diff", "--name-only", "--diff-filter=D", `${commit}^1`, commit, "--", ".changeset"]);
    for (const path of deleted.split("\n")) if (path) consumed.add(path);
  }
  return consumed;
}

/** An empty changeset (`---` then `---`) names no release; counting it would run a release that versions nothing for ever. @param {string} text */
export function namesARelease(text) {
  const lines = text.split("\n");
  const fences = lines.flatMap((line, i) => (/^---\s*$/.test(line) ? [i] : []));
  return fences.length >= 2 && lines.slice(fences[0] + 1, fences[1]).some((line) => RELEASE_BUMP.test(line));
}

/** @param {string} cwd @returns {string[]} every changeset file in the tree, as repository paths */
function presentChangesets(cwd) {
  return readdirSync(join(cwd, ".changeset"))
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => `.changeset/${file}`)
    .sort();
}

/**
 * @param {{ cwd: string, released?: (cwd: string) => Set<string> }} options `released` is what has been consumed; a test swaps it to show what the subtraction is for
 * @returns {{ present: string[], unreleased: string[] }} `unreleased` holds only those that name a release
 */
export function unreleasedChangesets({ cwd, released = releasedChangesets }) {
  const present = presentChangesets(cwd);
  const consumed = released(cwd);
  const unreleased = present.filter((path) => !consumed.has(path) && namesARelease(readFileSync(join(cwd, path), "utf8")));
  return { present, unreleased };
}

/** @param {string} cwd @returns {{ name: string, dir: string, private: boolean, version: string }[]} */
function manifests(cwd) {
  return git(cwd, ["ls-files", "--", ":(glob)package.json", ":(glob)**/package.json"])
    .split("\n")
    .filter(Boolean)
    .map((path) => {
      const manifest = JSON.parse(readFileSync(join(cwd, path), "utf8"));
      return { name: manifest.name, dir: dirname(path), private: manifest.private === true, version: manifest.version };
    });
}

/** The newest tag of each package. @param {string} cwd @returns {Map<string | null, { tag: string, version: string }>} */
function latestTags(cwd) {
  /** @type {Map<string | null, { tag: string, version: string }>} */
  const latest = new Map();
  for (const { tag, name, version } of releaseTags(cwd)) {
    const best = latest.get(name);
    if (!best || compareVersions(version, best.version) > 0) latest.set(name, { tag, version });
  }
  return latest;
}

/**
 * The caller's `lone-package-dir`, as the repository-relative directory `manifests` reports. Empty is no lone package below the root.
 * @param {string | undefined} input @returns {string | null}
 */
export function loneDirOf(input) {
  const named = (input ?? "").trim();
  if (!named) return null;
  const dir = posix.normalize(named).replace(/\/+$/, "") || ".";
  if (dir.startsWith("/") || dir === ".." || dir.startsWith("../")) throw new Error(`lone-package-dir is '${named}'; it is a directory inside the repository`);
  return dir;
}

/** The root package is the lone one until the caller names another directory, and then it is an ordinary package. @param {string} dir @param {string | null} loneDir */
const isLone = (dir, loneDir) => dir === (loneDir ?? ".");

/** A typo here would otherwise read as "the changesets move no releasable package", and a release that never happens says nothing. @param {string} cwd @param {string | null} loneDir */
function refuseUnknownLoneDir(cwd, loneDir) {
  if (loneDir !== null && !manifests(cwd).some(({ dir }) => dir === loneDir)) throw new Error(`lone-package-dir is '${loneDir}', and no package.json is tracked there`);
}

/** @param {string} cwd @param {string} file @param {(manifest: Record<string, unknown>) => void} edit */
function editManifest(cwd, file, edit) {
  const manifest = JSON.parse(readFileSync(join(cwd, file), "utf8"));
  edit(manifest);
  writeFileSync(join(cwd, file), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Put each tagged package back at its last release: that tag's version and that tag's changelog, so entries accumulate.
 * A package with no tag keeps what the merge has. Only the version is taken: the rest of package.json is this merge's.
 * @param {{ cwd: string, loneDir: string | null }} options @returns {Map<string, string>} each package's version after, by directory
 */
function rebaseOnLastTags({ cwd, loneDir }) {
  const latest = latestTags(cwd);
  const versions = new Map();
  for (const { name, dir, version } of manifests(cwd)) {
    const tagged = latest.get(name) ?? (isLone(dir, loneDir) ? latest.get(null) : undefined);
    const base = tagged?.version ?? version;
    if (tagged) {
      editManifest(cwd, join(dir, "package.json"), (manifest) => void (manifest.version = base));
      const changelog = join(dir, "CHANGELOG.md");
      // `ls-tree` prints nothing for a package whose last release wrote no changelog, which `show` would call an error.
      if (git(cwd, ["ls-tree", "--name-only", tagged.tag, "--", changelog]).trim()) writeFileSync(join(cwd, changelog), git(cwd, ["show", `${tagged.tag}:${changelog.replace(/^\.\//, "")}`]));
    }
    versions.set(dir, base);
  }
  return versions;
}

/** @param {string} cwd @param {string[]} paths */
function removeFiles(cwd, paths) {
  for (const path of paths) rmSync(join(cwd, path), { force: true });
}

/**
 * `kind: npm` never releases a private package. `kind: tag` has no registry to protect one from, so it releases the private lone package, at the root
 * or where the caller named it (and then not at the root): the repository's own version (lab and control are `"private": true`, with `privatePackages: { version: true, tag: false }`).
 * @param {{ private: boolean, dir: string }} manifest @param {{ kind: "npm" | "tag", loneDir: string | null }} options
 */
const releasable = ({ private: isPrivate, dir }, { kind, loneDir }) => !isPrivate || (kind === "tag" && isLone(dir, loneDir));

/**
 * `lone` is what the tag job reads to mark the Release `--latest`: of several packages' Releases no one is "the" latest.
 * @typedef {{ name: string, dir: string, version: string, tag: string, lone: boolean }} ReleasedPackage
 * @param {{ cwd: string, before: Map<string, string>, kind: "npm" | "tag", loneDir: string | null }} versions @returns {ReleasedPackage[]}
 */
function packagesThatMoved({ cwd, before, kind, loneDir }) {
  const after = manifests(cwd).filter(({ dir, version }) => before.get(dir) !== version);
  return after
    .filter((manifest) => releasable(manifest, { kind, loneDir }))
    .map(({ name, dir, version }) => ({ name, dir, version, lone: isLone(dir, loneDir), tag: isLone(dir, loneDir) ? `v${version}` : `${name}@${version}` }));
}

/**
 * Refuses a package that would be tagged without a Release to go with it. The tag is a promise the host acts on (`update-tool` moves to it), so a tag
 * whose notes cannot be written is worse than no release.
 * @param {string} cwd @param {ReleasedPackage} released
 */
function refuseUnreleasable(cwd, { name, dir, version }) {
  if (!SEMVER.test(version)) throw new Error(`${name}: version '${version}' is not MAJOR.MINOR.PATCH, so no tag is cut`);
  const path = join(cwd, dir, "CHANGELOG.md");
  if (!existsSync(path)) throw new Error(`${name}: ${join(dir, "CHANGELOG.md")} does not exist, so ${version} has no release notes`);
  try {
    changelogEntry(readFileSync(path, "utf8"), version);
  } catch (error) {
    throw new Error(`${name}: ${/** @type {Error} */ (error).message}`, { cause: error });
  }
}

/** The tree object of `.github/workflows` at `rev`, or "" where `rev` has none. Two revisions with the same value hold the same workflows. @param {string} cwd @param {string} rev */
export function workflowsTree(cwd, rev) {
  const [, , tree] = git(cwd, ["ls-tree", "-d", rev, "--", ".github/workflows"]).trim().split(/\s+/);
  return tree ?? "";
}

/**
 * Make HEAD's `.github/workflows` the tip's, amending HEAD, so GitHub reads no workflow change when HEAD is pushed (a11ign/a11ign#4010).
 * @param {{ cwd: string, tip: string }} options `tip` is any revision naming the default branch's tip, read as late as the caller can.
 * @returns {boolean} whether HEAD was amended
 */
export function graftTipWorkflows({ cwd, tip }) {
  const wanted = workflowsTree(cwd, tip);
  if (wanted === workflowsTree(cwd, "HEAD")) return false;
  git(cwd, ["rm", "-rq", "--ignore-unmatch", "--", ".github/workflows"]);
  if (wanted) git(cwd, ["checkout", tip, "--", ".github/workflows"]);
  git(cwd, [...COMMITTER, "commit", "-q", "--amend", "--no-edit"]);
  return true;
}

/**
 * The refusal GitHub would make, said first and in words: the tip's workflows are not the commit's, so a push of it is going to be rejected.
 * @param {{ cwd: string, commit: string, tip: string }} options
 */
export function assertWorkflowsHeld({ cwd, commit, tip }) {
  const [held, moved] = [workflowsTree(cwd, commit), workflowsTree(cwd, tip)];
  if (held === moved) return;
  throw new Error(`.github/workflows moved on the default branch after this release commit was built (commit ${held || "none"}, tip ${moved || "none"}); GitHub refuses a push of it, so no tag is pushed. Run the release again from the tip.`);
}

/**
 * @param {{ cwd: string, changesetVersion: (cwd: string) => void, kind: "npm" | "tag", released?: (cwd: string) => Set<string>, lonePackageDir?: string, tip?: string }} options
 *   `changesetVersion` runs `changeset version` (and refreshes the lockfile) in `cwd`. `kind` is the caller's, and decides whether a private lone package is released.
 *   `lonePackageDir` is the caller's `lone-package-dir`: the package there is tagged `vx.y.z` as a root package is.
 *   `tip`, where given, is the revision whose `.github/workflows` the release commit takes (see the head of this file); the workflow reads it as late as it can.
 * @returns {{ released: false, reason: string } | { released: true, sha: string, packages: ReleasedPackage[] }}
 */
export function buildRelease({ cwd, changesetVersion, kind, released, lonePackageDir, tip }) {
  const loneDir = loneDirOf(lonePackageDir);
  refuseUnknownLoneDir(cwd, loneDir);
  if (existsSync(join(cwd, ".changeset", "pre.json"))) throw new Error("pre-release mode (.changeset/pre.json) is not supported: every tag here is a plain x.y.z");
  const { present, unreleased } = unreleasedChangesets({ cwd, released });
  if (unreleased.length === 0) return { released: false, reason: "no changeset that no tag has consumed" };
  const before = rebaseOnLastTags({ cwd, loneDir });
  // The already-released go before `changeset version`, so it consumes the unreleased alone; the commit then holds NONE, which is what the next run reads.
  removeFiles(cwd, present.filter((path) => !unreleased.includes(path)));
  changesetVersion(cwd);
  removeFiles(cwd, presentChangesets(cwd));
  const packages = packagesThatMoved({ cwd, before, kind, loneDir });
  if (packages.length === 0) return { released: false, reason: "the changesets move no releasable package's version" };
  for (const released of packages) refuseUnreleasable(cwd, released);
  git(cwd, ["add", "-A"]);
  git(cwd, [...COMMITTER, "commit", "-q", "-m", `Release ${packages.map(({ tag }) => tag).join(", ")}`]);
  if (tip) graftTipWorkflows({ cwd, tip });
  return { released: true, sha: git(cwd, ["rev-parse", "HEAD"]).trim(), packages };
}

/** The changelog entry `changeset version` wrote for one version. @param {string} changelog @param {string} version */
export function changelogEntry(changelog, version) {
  let keep = false;
  const entry = [];
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ")) keep = line.slice(3).trim() === version;
    else if (keep) entry.push(line);
  }
  const text = entry.join("\n").trim();
  if (!text) throw new Error(`CHANGELOG.md has no entry for ${version}; changeset version wrote none`);
  return `${text}\n`;
}

/**
 * A repository with a lockfile has installed (the workflow ran `pnpm install --frozen-lockfile`) and runs its own `changeset`. One with none (agent-org:
 * no lockfile, no `packageManager`, `@changesets/cli` not a dependency) installed nothing, so the CLI is fetched at the version the caller names.
 * @param {string} cwd
 */
function changesetVersionInCi(cwd) {
  if (!existsSync(join(cwd, "pnpm-lock.yaml"))) {
    const cli = process.env.CHANGESETS_VERSION ?? "";
    if (!SEMVER.test(cli)) throw new Error(`CHANGESETS_VERSION is '${cli}'; a repository with no lockfile runs \`pnpm dlx @changesets/cli@<version>\`, and the version is MAJOR.MINOR.PATCH`);
    return void execFileSync("pnpm", ["dlx", `@changesets/cli@${cli}`, "version"], { cwd, stdio: "inherit" });
  }
  execFileSync("pnpm", ["exec", "changeset", "version"], { cwd, stdio: "inherit" });
  // `changeset version` leaves the lockfile; a frozen install of the release commit needs it to agree with the manifests.
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd, stdio: "inherit" });
}

/**
 * What `pnpm/action-setup` and `actions/setup-node` need to be given. The action refuses a `version` beside a `packageManager` that differs, so it is
 * given the input only where there is no `packageManager`; `cache: pnpm` fails on a missing lockfile, so it is given only where there is one.
 * @param {{ cwd: string, pnpmVersion: string }} options @returns {{ "pnpm-version": string, cache: string }}
 */
export function pnpmSetup({ cwd, pnpmVersion }) {
  const { packageManager } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  if (!packageManager && !pnpmVersion) throw new Error("package.json has no packageManager and the pnpm-version input is empty, so pnpm/action-setup has no version to install");
  return { "pnpm-version": packageManager ? "" : pnpmVersion, cache: existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : "" };
}

/** @param {string | undefined} kind @returns {"npm" | "tag"} */
function kindOf(kind) {
  if (kind !== "npm" && kind !== "tag") throw new Error(`KIND is '${kind}'; it is npm or tag`);
  return kind;
}

/** @param {Record<string, string>} outputs */
function setOutputs(outputs) {
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === "plan") {
    const { unreleased } = unreleasedChangesets({ cwd });
    return setOutputs({ count: String(unreleased.length) });
  }
  if (command === "setup") return setOutputs(pnpmSetup({ cwd, pnpmVersion: process.env.PNPM_VERSION ?? "" }));
  if (command === "version") {
    const result = buildRelease({ cwd, changesetVersion: changesetVersionInCi, kind: kindOf(process.env.KIND), lonePackageDir: process.env.LONE_PACKAGE_DIR, tip: process.env.TIP || undefined });
    if (!result.released) return setOutputs({ released: "false", reason: result.reason });
    const manifest = join(process.env.RUNNER_TEMP ?? tmpdir(), "release.json");
    writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`);
    return setOutputs({ released: "true", sha: result.sha, manifest });
  }
  if (command === "check-workflows") return assertWorkflowsHeld({ cwd, commit: "HEAD", tip: process.env.TIP ?? "" });
  if (command === "notes") return process.stdout.write(changelogEntry(readFileSync(join(cwd, rest[0], "CHANGELOG.md"), "utf8"), rest[1]));
  throw new Error(`unknown command '${command}': plan, setup, version, check-workflows or notes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
