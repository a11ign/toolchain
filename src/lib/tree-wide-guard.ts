#!/usr/bin/env node
// @ts-check
// THE TREE-WIDE-GUARD MARKER -- #716/#704, ceo's ruling 2026-09-09.
//
// `packages/guards/src/tree-wide-guards.ts`'s discovery used to grep comment-stripped source for the literal
// substring "ls-files" -- a real fix for the mention-vs-use trap (a comment describing a tree walk no
// longer counted), but still "a test deriving its expectations from source TEXT", this repo's own
// most-repeated defect shape (CLAUDE.md, "A LIST OF FIELDS TO CHECK", "signal regexes broke whenever...").
// A guard whose own source happens to spell a different tree-walk idiom (`readdirSync` recursion, a
// different git subcommand) would be silently invisible to a text pattern, and a fixture STRING quoting
// the pattern (this file's own sibling test needed fragment concatenation to dodge exactly this) is
// always one draft away from a false positive.
//
// So: a TREE-WIDE GUARD is a test that IMPORTS this module -- a real ES import statement, parsed the same
// way `local-import-closure.ts` (#621, B8) derives a test's requirements from its import closure rather
// than scanning its text. A guard declares its own membership by importing `declareTreeWideGuard` and
// calling it; the population is then a fact the tree computes from the import graph, never a keyword a
// future guard might happen to share or fail to spell the expected way.
//
//   node packages/guards/src/tree-wide-guards.ts     one path per line, for `npm run guards:sweep`
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { createRequire } from "node:module";
import { sandboxGitEnv } from "./git-env.ts";

// LAZY, not top-level -- ceo measured #809's guards costing 8.8s more than main's tip, more than either
// side's own noise (main's spread 6.1s, #809's 1.6s), and named the cause with a check: `node:test`
// isolates every guard into its OWN process (18 distinct PIDs, measured directly), so a module-level
// `import ts from "typescript"` at the TOP of this file is paid by all 18, even the ~9 that only ever call
// `walkTree({kind: "all", ...})` and never touch a `ScriptKind`. Measured directly: `import("typescript")`
// alone costs 170-380ms per process -- in the right range for nine seconds across nine unnecessary loads.
// `createRequire` loads it SYNCHRONOUSLY (so `walkTree` stays sync, no API change) and LAZILY (only the
// first time a `kind !== "all"` call actually needs it, never for a text-only guard).
const require = createRequire(import.meta.url);
/** @type {typeof import("typescript") | null} */
let tsModule: typeof import("typescript") | null = null;
/** @returns {typeof import("typescript")} */
function typescriptModule(): typeof import("typescript") {
  if (tsModule === null) tsModule = require("typescript");
  return (tsModule as typeof import("typescript"));
}

/** Test-only: has this process actually loaded `typescript` yet -- proof the laziness is real, not
 *  merely that the returned value happens to be `undefined`. Only meaningful checked from a FRESH
 *  process that has made no `kind !== "all"` call yet; any test file, single process, sequential tests
 *  contaminates this the moment ANY earlier test needs a ScriptKind. */
export function _typescriptLoadedForTests() {
  return tsModule !== null;
}

/**
 * Call this once, at module scope, in any test whose own population is the whole tracked tree rather than
 * one file. The return value carries no meaning -- `packages/guards/src/tree-wide-guards.ts`'s discovery only checks
 * that the CALL exists (never merely the import), the same "imported is not used" distinction
 * `git-spawn-classification.test.ts`'s own `usesCanonicalHelper` already draws for the identical reason.
 * @returns {true}
 */
export function declareTreeWideGuard(): true {
  return true;
}

// PER-PROCESS CACHE, keyed by the exact argv -- `node:test` runs each *.test.ts file in its OWN child
// process (measured directly, 2026-09-09: 18 distinct PIDs across an 18-file guards:sweep run), so this
// cannot share a spawn ACROSS guards the way one shared module might suggest -- but several guards call
// `walkTree` more than once with the SAME roots within their own file (`control-plane-checkout-is-one-
// fact.test.ts` and `referenced-scripts.test.ts` each ask for the whole tree twice; `walkTree`'s own test
// asks for the same kind+root pair from two different tests), and every one of those repeats is a real,
// avoidable spawn this closes.
/** @type {Map<string, string>} */
const lsFilesCache: Map<string, string> = new Map();
/** A `Map.set` on an EXISTING key does not grow `.size` whether or not the cache actually short-circuited
 *  -- so `.size` alone cannot prove a repeat call skipped the spawn. This counts the spawns themselves. */
let realSpawnCount = 0;
/** @type {(args: string[]) => string} */
const defaultGitLsFiles: (args: string[]) => string = (args): string => {
  const key = JSON.stringify(args);
  const cached = lsFilesCache.get(key);
  if (cached !== undefined) return cached;
  realSpawnCount += 1;
  const out = execFileSync("git", ["ls-files", ...args], { encoding: "utf8", env: sandboxGitEnv() });
  lsFilesCache.set(key, out);
  return out;
};

/** Test-only: how many times this process has ACTUALLY spawned `git ls-files` (never the cache-hit count)
 *  -- a repeated call with the same argv must not increment this, or the cache above guards nothing. */
export function _lsFilesSpawnCountForTests() {
  return realSpawnCount;
}

/**
 * One tracked file `walkTree` found, paired with the `ts.ScriptKind` a correct parse must use --
 * extension-derived, never guessed. #715/#794's own bug was two INDEPENDENT, both-wrong copies of exactly
 * this ternary in `function-size.test.ts`; this is the one place it is computed now.
 *
 * `scriptKind` is `undefined` for a `kind: "all"` walk -- that population isn't ts/mjs, so there is no
 * `ScriptKind` to compute, and computing one anyway is exactly the unconditional `typescript` load #795's
 * CPU follow-up traced nine seconds to.
 */
export type WalkedFile = { path: string, scriptKind: import("typescript").ScriptKind | undefined, isSelf: boolean };

/**
 * #795: THE SHARED TREE WALK, so the SEARCH is asserted once rather than 20-odd times, each written by
 * hand. #794 fixed and mutation-tested the worked example (`function-size.test.ts`'s own walk) and audited
 * the other 20 tree-wide guards: 20 of 21 already carry a `.length >= N` floor on their RESULT. ceo named
 * the gap that leaves: a floor on the result catches a search that ran correctly and then silently
 * shrank its findings -- it does NOT catch a search that never ran the intended query at all (a wrong
 * root, a pathspec that quietly matches the wrong thing, a leaked `GIT_DIR`). Those two failure modes
 * report identically to a `.length >= N` check: fewer files, no distinguishing signal.
 *
 * THE ASSERTION IS A CROSS-CHECK, not a count: git's own pathspec filter (`git ls-files <roots> "*.<ext>"`)
 * and an INDEPENDENT `extname` filter applied in JS to an unfiltered `git ls-files <roots>` must agree on
 * exactly which files match. They are two different mechanisms answering the identical question -- the
 * same shape as `bounded-window-reads.test.ts`'s own doctrine (a lookbehind regex meant to exclude the
 * `--json` field list excluded the reads it meant to include instead, and only a second check caught it).
 * A guard trusting either one alone would never notice the two had drifted apart.
 *
 * `kind: "all"` applies no extension filter -- for a guard whose own population isn't ts/mjs (a `.md`
 * scan, a mixed `.mjs`/`.sh`/`.yml` scan), so it still gets the scrubbed `git ls-files` call and the
 * zero-population floor from one place, even though its own further filtering happens after this returns.
 *
 * `selfPath` (repo-relative, from the calling guard's own `import.meta.url`) marks the guard's OWN file
 * `isSelf: true` when the walk finds it -- named rather than silently included or silently excluded, the
 * same "mention vs use" self-reference trap this tree keeps meeting (`git-spawn-classification.test.ts`'s
 * own fixture regex matching its own describing prose was the same shape, one file over).
 *
 * @param {{ kind: "ts" | "mjs" | "both" | "all", roots?: string[], selfPath?: string }} opts
 * @param {{ gitLsFiles?: typeof defaultGitLsFiles }} [deps]
 * @returns {WalkedFile[]}
 */
export function walkTree({ kind, roots = [], selfPath }: { kind: "ts" | "mjs" | "both" | "all"; roots?: string[]; selfPath?: string; }, { gitLsFiles = defaultGitLsFiles }: { gitLsFiles?: typeof defaultGitLsFiles; } = {}): WalkedFile[] {
  if (!["ts", "mjs", "both", "all"].includes(kind)) {
    throw new Error(`walkTree: unknown kind "${kind}" -- expected "ts", "mjs", "both", or "all"`);
  }
  // Lazy, and only for a kind that means something has a ScriptKind at all -- a `kind: "all"` caller must
  // never pay for loading `typescript`, since it never reads this field.
  /** @type {(path: string) => import("typescript").ScriptKind | undefined} */
  const scriptKindOf: (path: string) => import("typescript").ScriptKind | undefined = kind === "all"
    ? () => undefined
    : (path) => (extname(path) === ".ts" ? typescriptModule().ScriptKind.TS : typescriptModule().ScriptKind.JS);
  const raw = gitLsFiles(roots).split("\n").filter(Boolean);
  if (raw.length === 0) {
    throw new Error(`walkTree(${JSON.stringify(roots)}): git ls-files found zero tracked files -- wrong `
      + "root, wrong cwd, or a leaked GIT_DIR pointed this at the wrong repository.");
  }

  const paths = kind === "all" ? raw : (() => {
    const exts = kind === "both" ? ["ts", "mjs"] : [kind];
    const viaJsFilter = raw.filter((path) => exts.includes(extname(path).slice(1))).sort();
    // ANCHORED, one pathspec per root x extension -- `git ls-files <root> "*.ext"` passed as two SEPARATE
    // pathspecs is an OR (every path under root, UNION every *.ext anywhere in the repo), not an AND, and
    // returned 564 files for a 198-file population the first time this ran. `${root}/*.ext`, concatenated
    // into one pathspec, is what actually scopes the glob to the root -- verified against the same
    // independent JS-filtered count this cross-check exists to agree with.
    const pathspecs = (roots.length > 0 ? roots : [""])
      .flatMap((root) => exts.map((ext) => (root ? `${root}/*.${ext}` : `*.${ext}`)));
    const viaGitPathspec = gitLsFiles(pathspecs).split("\n").filter(Boolean).sort();
    if (viaGitPathspec.length !== viaJsFilter.length
      || viaGitPathspec.some((path, i) => path !== viaJsFilter[i])) {
      throw new Error(`walkTree("${kind}", ${JSON.stringify(roots)}): git's own pathspec filter `
        + `(${viaGitPathspec.length} file(s)) and an independent extname filter over the same unfiltered `
        + `listing (${viaJsFilter.length} file(s)) disagree -- one of the two is wrong, and a guard `
        + "trusting either alone would never notice.");
    }
    return viaJsFilter;
  })();

  return paths.map((path) => ({ path, scriptKind: scriptKindOf(path), isSelf: path === selfPath }));
}
