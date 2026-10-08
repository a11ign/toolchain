/**
 * THE ENTRIES OF A PACKAGE'S BUILD, DERIVED FROM ITS OWN `exports` MAP (ADR 0043, Decision 4).
 *
 * A subpath added to `exports` and forgotten in the build config is a published `exports` key that points at a file
 * the build never made; an entry added to the build and forgotten in `exports` is a built file nobody can import. Both are
 * invisible until a consumer installs the package, which is the one moment nobody is watching. So the entries are not
 * written down twice: `entriesFromExports` makes them from the map, and `entryProblems` is the test a package runs to prove
 * that a hand-written (or edited) entry map still agrees with it, in BOTH directions.
 *
 * ONLY A TARGET UNDER `outDir` IS BUILT. `./package.json` and `./tsconfig.base.json` are files the package ships as they
 * are, so they have no entry and are not a problem.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** A conditional or plain `exports` target: the shapes a package of ours writes. */
export type ExportTarget = string | { types?: string; import?: string; default?: string };
export type PackageExports = { exports?: Record<string, ExportTarget> };
export type EntryOptions = {
  /** The package directory: where `sourceDir` is looked up on disk. */
  dir: string;
  sourceDir?: string;
  outDir?: string;
  /** The extensions a source may have, in the order they are tried. */
  sourceExtensions?: readonly string[];
};

const BUILT_EXTENSION = /\.(?:mjs|js|cjs)$/;
const DEFAULT_SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs"] as const;

/** The built file a subpath resolves to, as the one a `import` takes: `default`, then `import`. Undefined for a target with neither. */
function builtTarget(target: ExportTarget): string | undefined {
  return typeof target === "string" ? target : (target.default ?? target.import);
}

/** The entry name a built target comes from (`./dist/verify.mjs` is `verify`), or undefined when it is not a built file. */
function entryNameOf(target: string | undefined, outDir: string): string | undefined {
  const prefix = `${outDir.replace(/\/$/, "")}/`;
  if (target === undefined || !target.startsWith(prefix) || !BUILT_EXTENSION.test(target)) return undefined;
  return target.slice(prefix.length).replace(BUILT_EXTENSION, "");
}

/** Every `exports` subpath that is built, with the entry name its target names. */
function builtSubpaths({ exports = {} }: PackageExports, outDir: string): Map<string, string> {
  const named = Object.entries(exports).map(([subpath, target]) => [subpath, entryNameOf(builtTarget(target), outDir)] as const);
  return new Map(named.filter((pair): pair is readonly [string, string] => pair[1] !== undefined));
}

/**
 * The source file of an entry, relative to the package: the first extension that exists. A package may keep a file as `.mjs`
 * (ADR 0043, Decision 1) beside the `.ts` ones, so the helper asks the disk rather than assuming one. Throws when there is none:
 * an `exports` key with no source is the defect, and it is better refused here than built as nothing.
 */
function sourceOf(name: string, { dir, sourceDir = "./src", sourceExtensions = DEFAULT_SOURCE_EXTENSIONS }: EntryOptions): string {
  const base = `${sourceDir.replace(/\/$/, "")}/${name}`;
  const found = sourceExtensions.map((extension) => `${base}${extension}`).find((path) => existsSync(join(dir, path)));
  if (found === undefined) throw new Error(`entriesFromExports: no source for entry "${name}" under ${join(dir, sourceDir)} (tried ${sourceExtensions.join(", ")})`);
  return found;
}

/** The entries to hand a bundler: one per built `exports` subpath, `[entry name]: source file`. */
export function entriesFromExports(pkg: PackageExports, options: EntryOptions): Record<string, string> {
  const names = [...builtSubpaths(pkg, options.outDir ?? "./dist").values()];
  return Object.fromEntries(names.map((name) => [name, sourceOf(name, options)]));
}

/**
 * What is wrong between an `exports` map and an entry map: each subpath with no entry, and each entry with no subpath. An empty
 * list is agreement. `entries` is keyed by entry name, as `entriesFromExports` returns it.
 */
export function entryProblems(
  pkg: PackageExports, entries: Record<string, string>, { outDir = "./dist" }: Pick<EntryOptions, "outDir"> = {},
): string[] {
  const subpaths = builtSubpaths(pkg, outDir);
  const named = new Set(subpaths.values());
  const withoutEntry = [...subpaths].filter(([, name]) => !(name in entries))
    .map(([subpath, name]) => `exports "${subpath}" builds "${name}", which has no entry`);
  const withoutSubpath = Object.keys(entries).filter((name) => !named.has(name))
    .map((name) => `entry "${name}" is built but no exports subpath points at it`);
  return [...withoutEntry, ...withoutSubpath];
}
