// @ts-check
// git EXPORTS `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` into every hook environment, and any process that
// then spawns `git` with an inherited `env` and only a `cwd` operates on whatever `GIT_DIR` names, not on
// `cwd` -- proven in isolation: `GIT_DIR=<real>/.git git init && git commit` lands the commit in `<real>`
// regardless of `cwd`. This bit for real on 2026-09-06: the pre-push hook runs `npm test`, a test spawned
// git with `cwd` set to a throwaway repo and an inherited `env`, and `GIT_DIR` (pointing at THIS
// checkout) won -- 15 commits across all refs, six of them real work already on `origin/main`, ended up
// authored by the string that test's own `git config user.name` call had written into the REAL repo.
//
// This is the ONE PLACE that fact is stated. Every caller -- test helper (`test-support/git-sandbox.ts`)
// and production git-spawning code alike -- strips through this function rather than re-deriving the
// list, because a copy of a defensive filter is exactly the shape this repo's CLAUDE.md calls out as
// "a fact stated twice, and the copies drifted": one copy missing one variable is silent until the day
// that variable is the one set.
//
// `@a11ign/screenreader-fleet` publishes `check-worker-code.mjs`/`deploy-worker.mjs` as `bin` entries, so
// its own git-spawning files (`code-drift.mjs` among them) cannot import anything outside their own
// package -- a published tarball does not carry this repo's top-level `scripts/`. `packages/worker-fleet/
// src/git-safe-env.mjs` is therefore a DELIBERATE, disclosed duplicate of this file for that one package,
// pinned equal to it by `packages/worker-fleet/src/git-safe-env.test.ts`. Every other caller (this repo's
// own top-level scripts, and `packages/lab`/`packages/control`, both `"private": true` and never
// published) imports this file directly.

/**
 * Every `GIT_*` variable is stripped regardless of this list -- the prefix match is what makes the
 * defence not depend on completeness. Named here only to document WHY each one matters:
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are the three git exports into a hook environment and the
 * three that redirected a real commit in the incident above; the rest are named as "worth considering"
 * by the review that found it, without anyone claiming the set is complete.
 * @type {readonly string[]}
 */
export const KNOWN_GIT_REDIRECT_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

/**
 * `process.env` with every `GIT_*` key removed, `extra` applied on top. A prefix strip, never a list
 * lookup, so a git version, CI shim, or wrapper introducing a new `GIT_*` variable tomorrow is still
 * caught without this file needing to know its name.
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function sandboxGitEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  /** @type {Record<string, string | undefined>} */
  const scrubbed: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) scrubbed[key] = value;
  }
  return { ...scrubbed, ...extra };
}
