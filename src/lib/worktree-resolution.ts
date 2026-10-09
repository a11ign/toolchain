// @ts-check
// #2181: WHERE DO THIS TREE'S `@a11ign/*` ACTUALLY RESOLVE? The question a green suite cannot answer.
//
// Measured on the agent host 2026-09-23: 42 of 56 linked worktrees resolve `@a11ign/agent-org` to
// `/home/agent/repos/a11y-witness/packages/agent-org` -- the PRIMARY checkout -- because their whole
// `node_modules` is a symlink to the primary's. A test in such a tree that imports `@a11ign/agent-org`
// reads `main`, while the file the branch changed sits untouched beside it. `worker-judge` reproduced
// both directions on `wt-1561`: with the symlink, `npm run test:all` gave 7,253 passed / 0 failed at a
// head CI was failing, and deleting `windowSize` from a fixture left the mutant ALIVE (14 pass / 0 fail);
// with a hybrid `node_modules` plus `npm run build`, the same deletion gave 9 pass / 5 fail, matching CI.
//
// THE SYMLINK WAS A COST-SAVING CHOICE, AND IT IS NOT THE DEFECT EITHER WAY. It kept 42 trees from each
// carrying a real `node_modules` (#57 measured the third-party share at 2.9G). #57's pnpm migration makes
// it obsolete rather than deliberate: the first publish ran on 2026-09-19, and a `pnpm install` gives a tree
// its OWN `node_modules/@a11ign/*` as links to its own `packages/` (`../../packages/x`, which this file
// classifies `OWN_PACKAGES`) from a shared store, in seconds. Trees that predate it still carry the
// symlink, so the classifier stays: it is how a tree says which population it belongs to. The defect is that
// NOTHING SAYS the tree you are testing in is not the tree you are testing. This file says it, and since
// #2218 `suiteStartVerdict` REFUSES a suite start in a tree that reads another checkout or a frozen copy
// (callers: `assert-glob-not-empty.ts`, `worktree-owner.mjs`), with `OVERRIDE_ENV` as the one loud way past.
// It is not retired by the pnpm migration: retiring the symlink removes the cause, and the refusal is what
// catches the trees not yet converted, which is a separate decision from converting them.
//
// THREE ANSWERS, AND THE THIRD IS THE ONE THAT MATTERS. A classifier that asks only "inside or outside
// this worktree" gets the first two right and calls the third SAFE. `wt-1315` on this host resolves
// `@a11ign/agent-org` to its own `node_modules/@a11ign/agent-org` -- a real directory inside the tree,
// neither the primary's source nor the branch's, a copy frozen at whenever it was installed. Inside the
// worktree, and every bit as false as the primary's. So the `node_modules/` test is asked BEFORE the
// containment test, never after.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** The scope in which a package specifier can lie about which checkout it reads. */
const SCOPE = "@a11ign";

/**
 * What a worktree's `@a11ign/*` resolve to. Four answers, and only the first is safe.
 *
 * `NOTHING_LINKED` is not a fourth-wheel case: a tree `row-claim ... claim` has just created has no
 * `node_modules` at all, which is the commonest state of a brand-new tree and must not be folded into
 * `OWN_PACKAGES`. "Nothing resolves" and "everything resolves to your own source" are different facts
 * and the second is the one that licenses a suite run.
 */
export const RESOLUTION = Object.freeze({
  OWN_PACKAGES: "own-packages",
  OTHER_CHECKOUT: "other-checkout",
  STALE_COPY: "stale-copy",
  NOTHING_LINKED: "nothing-linked",
});

/**
 * Worst first. A tree showing more than one kind is reported by the most severe it shows, because the
 * reader's question is "may I trust a suite run here", and one lying package answers it.
 *
 * `OTHER_CHECKOUT` outranks `STALE_COPY` for one reason and it is not that it is more wrong: it NAMES
 * the checkout it is reading, so the reader can act on it in one line. Both falsify a run.
 */
const SEVERITY = [RESOLUTION.OTHER_CHECKOUT, RESOLUTION.STALE_COPY, RESOLUTION.OWN_PACKAGES];

/**
 * The real path of `path`, or null when it does not resolve.
 *
 * A DANGLING LINK IS NOT AN ERROR HERE. A hybrid `node_modules` built for a package this branch has since
 * deleted leaves exactly that, and throwing would make the report unavailable in the one tree most likely
 * to need it.
 *
 * @param {string} path @param {{ realpath?: typeof realpathSync }} [deps] @returns {string | null}
 */
function realOrNull(path: string, { realpath = realpathSync }: { realpath?: typeof realpathSync; } = {}): string | null {
  try {
    return realpath(path);
  } catch {
    // An absence, not a swallowed failure: the caller turns null into a named `nothing-linked` entry.
    return null;
  }
}

/**
 * True when `path` is `prefix` itself or sits under it -- never a bare `startsWith`, which matches
 * `packages-old` from `packages`.
 *
 * @param {string} path @param {string} prefix @returns {boolean}
 */
function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The checkout a resolved package belongs to, for naming it back to the reader.
 *
 * @param {string} resolved @returns {string}
 */
function checkoutOf(resolved: string): string {
  for (const marker of ["/packages/", "/node_modules/"]) {
    const at = resolved.indexOf(marker);
    if (at !== -1) return resolved.slice(0, at);
  }
  return resolved;
}

/**
 * Which of `RESOLUTION`'s answers a single resolved path is, given the tree it was read from.
 *
 * ORDER IS THE WHOLE CONTENT OF THIS FUNCTION. `node_modules` is asked before containment, because a copy
 * under the tree's own `node_modules` is INSIDE the tree and is not the tree's source.
 *
 * @param {string} realWorktree the worktree's own real path @param {string} resolved
 * @returns {{ kind: string, checkout: string | null }}
 */
export function classifyResolvedPath(realWorktree: string, resolved: string): { kind: string; checkout: string | null; } {
  if (isUnder(resolved, join(realWorktree, "node_modules"))) return { kind: RESOLUTION.STALE_COPY, checkout: null };
  if (isUnder(resolved, join(realWorktree, "packages"))) return { kind: RESOLUTION.OWN_PACKAGES, checkout: null };
  return { kind: RESOLUTION.OTHER_CHECKOUT, checkout: checkoutOf(resolved) };
}

/**
 * Every `@a11ign/*` link in `worktree`, classified, with what it resolved to.
 *
 * @param {string} worktree
 * @param {{ exists?: typeof existsSync, list?: typeof readdirSync, realpath?: typeof realpathSync }} [deps]
 * @returns {Array<{ name: string, kind: string, resolved: string | null, checkout: string | null }>}
 */
export function resolvedScopeEntries(worktree: string, { exists = existsSync, list = readdirSync, realpath = realpathSync }: { exists?: typeof existsSync; list?: typeof readdirSync; realpath?: typeof realpathSync; } = {}): Array<{ name: string; kind: string; resolved: string | null; checkout: string | null; }> {
  const scopeDir = join(worktree, "node_modules", SCOPE);
  if (!exists(scopeDir)) return [];
  const realWorktree = realOrNull(worktree, { realpath }) ?? worktree;
  return list(scopeDir).sort().map((name) => {
    const resolved = realOrNull(join(scopeDir, name), { realpath });
    if (resolved === null) return { name, kind: RESOLUTION.NOTHING_LINKED, resolved: null, checkout: null };
    return { name, resolved, ...classifyResolvedPath(realWorktree, resolved) };
  });
}

/**
 * The worktree's own answer: the most severe kind any of its `@a11ign/*` shows, and the entries behind it.
 *
 * @param {string} worktree
 * @param {{ exists?: typeof existsSync, list?: typeof readdirSync, realpath?: typeof realpathSync }} [deps]
 * @returns {{ kind: string, entries: ReturnType<typeof resolvedScopeEntries>, checkouts: string[] }}
 */
export function worktreeResolution(worktree: string, deps: { exists?: typeof existsSync; list?: typeof readdirSync; realpath?: typeof realpathSync; } = {}): { kind: string; entries: ReturnType<typeof resolvedScopeEntries>; checkouts: string[]; } {
  const entries = resolvedScopeEntries(worktree, deps);
  const kinds = new Set(entries.map((e) => e.kind));
  const kind = SEVERITY.find((k) => kinds.has(k)) ?? RESOLUTION.NOTHING_LINKED;
  const checkouts = [...new Set(entries.map((e) => e.checkout).filter((c) => c !== null))].sort();
  return { kind, entries, checkouts };
}

/**
 * How many of `entries` carry `kind`.
 *
 * @param {Array<{ kind: string }>} entries @param {string} kind @returns {number}
 */
function countOf(entries: Array<{ kind: string; }>, kind: string): number {
  return entries.filter((e) => e.kind === kind).length;
}

/**
 * What the reader is told. One line per worktree, naming the kind, the count and -- for the outside case
 * -- the checkout actually being read, because that is the fact that ends the reader's investigation.
 *
 * @param {string} worktree @param {ReturnType<typeof worktreeResolution>} result @returns {string}
 */
export function resolutionLine(worktree: string, { kind, entries, checkouts }: ReturnType<typeof worktreeResolution>): string {
  const total = entries.length;
  if (kind === RESOLUTION.NOTHING_LINKED) {
    return `${worktree}: no @a11ign/* resolve here -- node_modules is absent or empty of them. Not "safe": `
      + "nothing has been measured. `pnpm install --frozen-lockfile` gives this tree its own (`corepack pnpm "
      + "install --frozen-lockfile` if pnpm is not on PATH); a symlink to the primary's node_modules would make "
      + "it read the PRIMARY's packages instead, and pnpm refuses to install through one.";
  }
  if (kind === RESOLUTION.OWN_PACKAGES) {
    return `${worktree}: all ${total} @a11ign/* resolve to this worktree's own packages/ -- a suite run here `
      + "measures this branch. Cross-package imports still read `dist/`, so `npm run build` after a source edit.";
  }
  if (kind === RESOLUTION.STALE_COPY) {
    return `${worktree}: ${countOf(entries, RESOLUTION.STALE_COPY)} of ${total} @a11ign/* resolve to a COPY under `
      + "this tree's own node_modules/, not to its packages/. Inside the worktree and still not its source: a "
      + "run here measures whenever that copy was installed. Remove node_modules and run "
      + "`pnpm install --frozen-lockfile`, which links @a11ign/* to this tree's packages/.";
  }
  return `${worktree}: ${countOf(entries, RESOLUTION.OTHER_CHECKOUT)} of ${total} @a11ign/* resolve OUTSIDE this `
    + `worktree, to ${checkouts.join(", ")} -- a suite run here measures that checkout and not this branch. `
    + "That is how 7,253 passed at a head CI was failing (#2181). If node_modules is itself a symlink, "
    + "`rm node_modules` (the link: no trailing slash, no -r) and run `pnpm install --frozen-lockfile`, which "
    + "links @a11ign/* to this tree's packages/.";
}

/** The one named way past `suiteStartVerdict`'s refusal, so a deliberate run against another checkout is possible and LOUD. */
export const OVERRIDE_ENV = "A11Y_ALLOW_FOREIGN_RESOLUTION";

/** The kinds a suite must not start under: both READ a source that is not this branch's. */
/** @type {string[]} */
const REFUSED_KINDS: string[] = [RESOLUTION.OTHER_CHECKOUT, RESOLUTION.STALE_COPY];

/**
 * #2218: WHAT A SUITE ABOUT TO START IN `worktree` SHOULD DO. #2181 made the answer available and only to a
 * session that asked `worktree:whose`; nobody asks it before `npm run test:all`, which is exactly when a wrong
 * answer costs: 7,253 passed / 0 failed at a head CI was failing. The refusal belongs where the measurement
 * starts, because a green run in the wrong tree is the direction that ships.
 *
 * THREE ACTIONS. `refuse` for a tree that reads another checkout or a frozen copy; `warn` when the same tree
 * carries `OVERRIDE_ENV=1` (the run proceeds and the line still prints, so an override is never silent);
 * `proceed` for a tree reading its own packages -- and for one with nothing linked, which is not this guard's
 * to judge: no `node_modules` means the runner cannot start and says so itself, and refusing on top would
 * bury that message under a wrong diagnosis.
 *
 * @param {string} worktree
 * @param {{ env?: Record<string, string | undefined>, exists?: typeof existsSync, list?: typeof readdirSync, realpath?: typeof realpathSync }} [options]
 * @returns {{ action: "refuse" | "warn" | "proceed", line: string | null }}
 */
export function suiteStartVerdict(worktree: string, { env = process.env, ...deps }: { env?: Record<string, string | undefined>; exists?: typeof existsSync; list?: typeof readdirSync; realpath?: typeof realpathSync; } = {}): { action: "refuse" | "warn" | "proceed"; line: string | null; } {
  const result = worktreeResolution(worktree, deps);
  if (!REFUSED_KINDS.includes(result.kind)) return { action: "proceed", line: null };
  const line = resolutionLine(worktree, result);
  if (env[OVERRIDE_ENV] === "1") return { action: "warn", line: `${line} (${OVERRIDE_ENV}=1: running anyway)` };
  return { action: "refuse", line: `${line} Set ${OVERRIDE_ENV}=1 to run here anyway, knowing what it measures.` };
}
