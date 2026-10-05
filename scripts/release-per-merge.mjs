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
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** @param {string} cwd @param {string} file @param {(manifest: Record<string, unknown>) => void} edit */
function editManifest(cwd, file, edit) {
  const manifest = JSON.parse(readFileSync(join(cwd, file), "utf8"));
  edit(manifest);
  writeFileSync(join(cwd, file), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Put each tagged package back at its last release: that tag's version and that tag's changelog, so entries accumulate.
 * A package with no tag keeps what the merge has. Only the version is taken: the rest of package.json is this merge's.
 * @param {string} cwd @returns {Map<string, string>} each package's version after, by directory
 */
function rebaseOnLastTags(cwd) {
  const latest = latestTags(cwd);
  const versions = new Map();
  for (const { name, dir, version } of manifests(cwd)) {
    const tagged = latest.get(name) ?? (dir === "." ? latest.get(null) : undefined);
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
 * @typedef {{ name: string, dir: string, version: string, tag: string }} ReleasedPackage
 * @param {{ cwd: string, before: Map<string, string> }} versions @returns {ReleasedPackage[]}
 */
function packagesThatMoved({ cwd, before }) {
  const after = manifests(cwd).filter(({ dir, version }) => before.get(dir) !== version);
  return after
    .filter((manifest) => !manifest.private)
    .map(({ name, dir, version }) => ({ name, dir, version, tag: dir === "." ? `v${version}` : `${name}@${version}` }));
}

/**
 * @param {{ cwd: string, changesetVersion: (cwd: string) => void, released?: (cwd: string) => Set<string> }} options
 *   `changesetVersion` runs `changeset version` (and refreshes the lockfile) in `cwd`.
 * @returns {{ released: false, reason: string } | { released: true, sha: string, packages: ReleasedPackage[] }}
 */
export function buildRelease({ cwd, changesetVersion, released }) {
  if (existsSync(join(cwd, ".changeset", "pre.json"))) throw new Error("pre-release mode (.changeset/pre.json) is not supported: every tag here is a plain x.y.z");
  const { present, unreleased } = unreleasedChangesets({ cwd, released });
  if (unreleased.length === 0) return { released: false, reason: "no changeset that no tag has consumed" };
  const before = rebaseOnLastTags(cwd);
  // The already-released go before `changeset version`, so it consumes the unreleased alone; the commit then holds NONE, which is what the next run reads.
  removeFiles(cwd, present.filter((path) => !unreleased.includes(path)));
  changesetVersion(cwd);
  removeFiles(cwd, presentChangesets(cwd));
  const packages = packagesThatMoved({ cwd, before });
  if (packages.length === 0) return { released: false, reason: "the changesets move no public package's version" };
  git(cwd, ["add", "-A"]);
  git(cwd, [...COMMITTER, "commit", "-q", "-m", `Release ${packages.map(({ tag }) => tag).join(", ")}`]);
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

/** @param {string} cwd */
function changesetVersionInCi(cwd) {
  execFileSync("pnpm", ["exec", "changeset", "version"], { cwd, stdio: "inherit" });
  // `changeset version` leaves the lockfile; a frozen install of the release commit needs it to agree with the manifests.
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) execFileSync("pnpm", ["install", "--lockfile-only"], { cwd, stdio: "inherit" });
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
  if (command === "version") {
    const result = buildRelease({ cwd, changesetVersion: changesetVersionInCi });
    if (!result.released) return setOutputs({ released: "false", reason: result.reason });
    const manifest = join(process.env.RUNNER_TEMP ?? tmpdir(), "release.json");
    writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`);
    return setOutputs({ released: "true", sha: result.sha, manifest });
  }
  if (command === "notes") return process.stdout.write(changelogEntry(readFileSync(join(cwd, rest[0], "CHANGELOG.md"), "utf8"), rest[1]));
  throw new Error(`unknown command '${command}': plan, version or notes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
