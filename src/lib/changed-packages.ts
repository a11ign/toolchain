// @ts-check
// command: list which packages/<name> directories a branch touched against origin/main
// Which `packages/<name>` directories a branch actually touched against `origin/main` -- the population
// the pre-push hook's FAST gate (agent/*, lead/* pushes) tests, so a branch that never touched `judge` does
// not pay for `judge`'s suite on every commit. `main` pushes are unaffected: they still run the full suite,
// unchanged, because the fast gate exists to speed up iteration on a branch, not to replace the real gate.
//
// DELIBERATELY BLUNT, not dependency-aware. A change to `packages/evidence` (which several other packages
// import) is scoped to `evidence`'s OWN tests here, not every package that depends on it -- building a
// reliable cross-package dependency graph from package.json files is a real project of its own, and a wrong
// graph is a guard answering about the wrong population, which is the exact class this repo spent the day
// closing (docs/backlog.md, "a check that answers correctly about the wrong population"). The chosen
// tradeoff: the fast gate may legitimately MISS a cross-package regression, and CI is the real, full-suite
// gate that catches it -- by design, not by oversight. A push that breaks another package's test is
// expected to pass the fast gate and fail CI; that is the acceptance test this file exists to make
// possible, not a gap to close here.
//
// CI RUNS ON THE PR, NOT ON THE BRANCH PUSH -- changed 2026-09-06 alongside `.github/workflows/ci.yml`
// (which replaced the widened `lint.yml`). This function is also reused there, by
// `scripts/ci-changed.ts`, for the identical reason it exists here: one place that answers "which
// packages did this diff touch", never a second copy re-deriving it inline in YAML.
//
// A diff touching nothing under `packages/` (docs, top-level scripts, .github/, package.json, tsconfig)
// returns an EMPTY list, and the caller's job is to treat that as "run everything", never as "run nothing" --
// see `scripts/git-hooks/pre-push`'s use of this. An empty result here is not the same claim as "nothing to
// verify".
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { sandboxGitEnv } from "./git-env.ts";
import { changedFiles } from "./changed-files.ts";
// RELATIVE, NOT `@a11ign/screenreader-fleet/cli-flags`, for the reason `ci-changed.ts` already records
// above its own copy of this import: `ci.yml`'s `changed` job runs `checkout` and `setup-node` and NO
// `npm ci`, because its whole job is to decide whether anything else installs or builds at all. This file
// is imported by that script, so a package specifier here dies before the workflow starts —
// `ERR_MODULE_NOT_FOUND: Cannot find package '@a11ign/screenreader-fleet'`, measured on #238's first run.
//
// Guarding this file (#164) is what surfaced it: the census had never walked `scripts/`, so nothing had
// ever asked whether these two could import the guard at all. The answer is yes, by the path that does
// not need `node_modules` — the file is plain JS, so importing straight from `src` costs nothing.
import { refuseUnknownFlags } from "./cli-flags.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/**
 * `packages/<name>` for every changed path, deduped and sorted -- pure, given the diff's own output.
 * @param {string} diffOutput
 */
export function changedPackages(diffOutput: string) {
  const names = new Set();
  for (const line of diffOutput.split("\n")) {
    const match = /^packages\/([^/]+)\//.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * `packages/<name>` changed against `origin/main`'s merge-base with HEAD -- the merge-base, not
 * `origin/main` itself, so a branch that started days ago is compared against where it FORKED, not
 * against everything `main` has gained since. Comparing against `origin/main` directly would report every
 * package another branch already landed as "changed here" too, which is the wrong population in the other
 * direction. Empty on any git failure (no `origin/main`, a shallow clone) -- the caller must treat that as
 * "run everything", the same as a genuinely empty diff.
 */
/**
 * The raw changed-file paths against `origin/main`'s merge-base with HEAD -- the same diff
 * `changedPackagesAgainstOrigin` reduces to package names, exposed separately for a caller that needs the
 * file list itself (the pre-push hook's board-only fast path reuses this rather than re-deriving the
 * merge-base diff a second time). Empty on any git failure, same as its sibling.
 */
export function filesChangedAgainstOrigin() {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"],
      { cwd: REPO, env: sandboxGitEnv(), encoding: "utf8" }).trim();
    // #939: `changedFiles` adds `--no-renames`, so a package a file moved OUT of is implicated too.
    return changedFiles([base, "HEAD"], { repoRoot: REPO });
  } catch {
    return [];
  }
}

export function changedPackagesAgainstOrigin() {
  return changedPackages(filesChangedAgainstOrigin().join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: takes no flags; `--name-only` is passed onward to git.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/guards/src/changed-packages.ts" });
  process.stdout.write(changedPackagesAgainstOrigin().join(" "));
}
