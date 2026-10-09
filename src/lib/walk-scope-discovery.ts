// @ts-check
// THE WORKSPACE IMPORT CLOSURE, for `walk-scope.ts` -- #3573.
//
// `sourceClosure` answers "which SOURCE files does this one file reach, by relative import or workspace-package
// specifier, transitively", and `packageIndex` is the table that resolves a bare `@a11ign/*` specifier back to a source
// file rather than the `dist/*.js` its `exports` field points a real resolution at. `walk-scope.ts` asks it what a
// declaring guard's WALK_SCOPE may read. It was written for the hand-built test selector and lives there still:
// #3573 deletes the selector (`rstest --changed` replaced it), and these two have a live importer, so they move here
// rather than going with it. They are the same code in both places only until that deletion.
//
// `node:fs` and `node:path` only: `agent-org` carries a declared copy of this file (`COPIED FROM`), and a copy that
// imported a workspace package would need a second edit there.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `import ... from "<spec>"` specifiers, in source order -- identical regex to
 * `pre-install-import-graph.test.ts`'s `specifiersOf`, which this repo already relies on to find every
 * import a script or test carries, `from` included as optional for a bare `import "./side-effect.mjs"`.
 *
 * #1527: AND `import("<spec>")`, the DYNAMIC form. The static regex needs whitespace after `import`, so
 * `await import("../../scripts/check-real-page-findings.ts")` (`relocated-fixture-key.test.ts`) yielded no
 * specifier, the walk never reached the script, and a change to it never selected that test (#1526).
 * @param {string} source
 * @returns {string[]}
 */
function specifiersOf(source: string): string[] {
  const staticSpecs = [...source.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
  const dynamicSpecs = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  return [...staticSpecs, ...dynamicSpecs];
}

/**
 * Every `@a11ign/*` (and the unscoped `a11ign`) package's own name -> { dir, exportsMap }, so a bare
 * workspace specifier can be resolved back to a SOURCE file rather than the `dist/*.js` its own
 * `exports` field actually points a real Node resolution at -- this walk answers "what does a test
 * import", which for a workspace package means its SOURCE, not its build output.
 * @param {string} repoRoot
 * @param {string[]} packageDirs
 * @returns {Map<string, { dir: string, exportsMap: Record<string, unknown> }>}
 */
export function packageIndex(repoRoot: string, packageDirs: string[]): Map<string, { dir: string; exportsMap: Record<string, unknown>; }> {
  const index = new Map();
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf8"));
    index.set(manifest.name, { dir, exportsMap: manifest.exports ?? {} });
  }
  return index;
}

/**
 * The literal export target string for one subpath -- `exports` values are either a bare string
 * (`nvda-worker`'s no-build-step packages, ADR 0031) or `{types, default}` (every `tsc --build` package),
 * and only `default` is ever a real runtime resolution target.
 * @param {unknown} value
 * @returns {string | null}
 */
function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return null;
}

/**
 * One `dist/*.js` (or `dist/*.d.ts`) export target back to its SOURCE counterpart, mirroring
 * `candidatePackedPaths`'s inverse in `ci-changed.ts`: every `tsc --build` package here uses
 * `rootDir: src`, `outDir: dist`, so `dist/foo.js` is built from `src/foo.ts`. A package shipping `src`
 * RAW (`nvda-worker`) has no `dist/` in its own targets at all, so the swap is a no-op and the literal
 * target -- already a real source file -- is tried as-is.
 * @param {string} target relative to the package root, e.g. "./dist/wcag.js"
 * @returns {string[]} candidate paths, relative to the package root, most-likely first
 */
function sourceCandidatesForExportTarget(target: string): string[] {
  const stripped = target.replace(/^\.\//, "");
  const distMatch = /^dist\/(.*)\.(js|d\.ts|mjs)$/.exec(stripped);
  if (distMatch) return [`src/${distMatch[1]}.ts`, `src/${distMatch[1]}.tsx`, `src/${distMatch[1]}.mjs`];
  return [stripped];
}

/**
 * One RELATIVE specifier, from the file that imported it, to a real file on disk -- same shape as
 * `pre-install-import-graph.test.ts`'s `importGraph`, extended for `.ts` source: this repo's `.ts` files
 * import each other with the COMPILED `.js` extension (NodeNext-style TypeScript), so `./foo.js` from a
 * `.ts` file must resolve to the SOURCE `./foo.ts` that produces it, not a `dist/foo.js` that may not
 * exist yet on an unbuilt tree.
 * @param {string} spec
 * @param {string} fromFile absolute path
 * @returns {string | null} absolute path, or null if nothing on disk matches any candidate
 */
function resolveRelative(spec: string, fromFile: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const jsMatch = /^(.*)\.(js|mjs|cjs)$/.exec(spec);
  const candidates = jsMatch
    ? [base, `${base.slice(0, -jsMatch[2].length - 1)}.ts`, `${base.slice(0, -jsMatch[2].length - 1)}.tsx`]
    : [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * One BARE `@a11ign/*` (or unscoped `a11ign`) specifier, with an optional subpath, to a source file --
 * `.` for the package root, `./x` for `exports["./x"]`. Any other bare specifier (a real npm dependency)
 * is not a workspace file and returns null.
 * @param {string} spec
 * @param {string} repoRoot
 * @param {Map<string, { dir: string, exportsMap: Record<string, unknown> }>} packages
 * @returns {string | null} absolute path
 */
function resolveWorkspacePackage(spec: string, repoRoot: string, packages: Map<string, { dir: string; exportsMap: Record<string, unknown>; }>): string | null {
  const scopedMatch = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(spec);
  const pkgName = scopedMatch ? scopedMatch[1] : /^([^/@][^/]*)(\/.*)?$/.exec(spec)?.[1];
  const subpath = scopedMatch ? scopedMatch[2] : /^([^/@][^/]*)(\/.*)?$/.exec(spec)?.[2];
  const entry = pkgName ? packages.get(pkgName) : undefined;
  if (!entry) return null;
  const { dir, exportsMap } = entry;
  const key = subpath ? `.${subpath}` : ".";
  const target = exportTarget(exportsMap[key]);
  if (!target) return null;
  const pkgRoot = join(repoRoot, "packages", dir);
  for (const candidate of sourceCandidatesForExportTarget(target)) {
    const abs = join(pkgRoot, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Everything reachable from `entryFile` by relative import or workspace-package specifier, transitively
 * -- the reverse of what `ci-changed.ts`'s own header calls the point of ITS second pass: that file asks
 * "who depends on this PACKAGE"; this asks "which SOURCE FILES does this one TEST FILE actually reach",
 * so a change to any of them is a reason to run it.
 *
 * @param {string} entryFile absolute path
 * @param {string} repoRoot
 * @param {Map<string, { dir: string, exportsMap: Record<string, unknown> }>} packages
 * @returns {Set<string>} absolute paths, entry included
 */
export function sourceClosure(entryFile: string, repoRoot: string, packages: Map<string, { dir: string; exportsMap: Record<string, unknown>; }>): Set<string> {
  const seen = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      const resolved = spec.startsWith(".")
        ? resolveRelative(spec, file)
        : resolveWorkspacePackage(spec, repoRoot, packages);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}
