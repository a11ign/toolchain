#!/usr/bin/env node
/**
 * THE BOUNDARY CHECK: LIST EVERY REACH INTO ANOTHER REPOSITORY, AND FAIL NOTHING (a11ign/a11ign#4432; epic #4425, phase 2).
 *
 * A repository has no way to see its crossings into another repository, so a new one lands unseen. This lists them, in REPORT mode:
 * the exit code is 0 whatever it found (phase 4 of the epic turns a listing into a gate, in a later row). It reports three kinds, each
 * with the file, the line and the path it reaches:
 *
 *   cross-repo-import  a relative import or require that climbs out of the repository root (`../../other-repo/…`), or lands in a package
 *                      directory that the importer's own manifest does not declare as a dependency
 *   tool-path          a string built from an environment-held TOOL directory plus a `/src/` path (`process.env.X + "/src/…"`,
 *                      `${X}/src/…`, `join(process.env.X, "src", …)`), or a call of `toolPath`/`toolModule`/`toolUrl`/`toolRoot`
 *   laid-source        a directory that is untracked because another repository's source is copied there at install: one a tracked
 *                      `layers.json` declares (`layers` / `pinned` entries with a `path`), or a `.gitignore` entry that a script,
 *                      workflow or manifest line copies or clones into
 *
 * WHICH ENVIRONMENT NAMES COUNT AS A TOOL DIRECTORY: those containing `TOOL`, in capitals (`AGENT_ORG_TOOL`). `GITHUB_WORKSPACE/src/` is
 * the repository itself and `$HOME/src/` is nobody's tool, so a looser rule would list this repository's own layout as crossings.
 * A `.gitignore` entry is read as a laid directory only when it is a plain name that does not start with a dot and is not a
 * conventional build output (`dist`, `node_modules`, `coverage`…): `cp .env.example .env` is not a layer.
 *
 * THE TREE IS A MAP, NOT A DISK, as in `layout-check`: `checkBoundaryTree` takes `{ path: text }` (text only for source, workflow, shell
 * and manifest files), so a fixture is a repository's listing and needs no checkout. `checkBoundary({ root })` reads a directory into that
 * map. An EMPTY tree is exit 2, never a clean report: a reader that found nothing would otherwise print "no crossings".
 *
 * A BASELINE (`--baseline=<json>`: `[{ "from": "<file>", "to": "<reached path>" }]`, or `{ "accepted": [...] }`) marks a matching
 * crossing ACCEPTED and lists a baseline line that matches nothing as STALE: the listing is what lets a baseline only shrink.
 *
 * ONE LINE FOR A CONSUMER'S `ci.yml`: `npx --yes --package @a11ign/toolchain boundary-check --root=.` (exit 0 whatever it found, 2 when
 * the tree or the baseline is unreadable or the tree is empty). `--out=<file>` also writes the JSON report.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export type CrossingKind = "cross-repo-import" | "tool-path" | "laid-source";
export type Crossing = { kind: CrossingKind; file: string; line: number; to: string; message: string };
export type CrossingStatus = "found" | "accepted";
export type ReportedCrossing = Crossing & { status: CrossingStatus };
export type BaselineEntry = { from: string; to: string };
export type BoundaryTree = Readonly<Record<string, string>>;
export type BoundaryResult = {
  /** False for an empty tree: nothing was read, so "no crossings" would be a statement about nothing. */
  readable: boolean;
  crossings: ReportedCrossing[];
  /** Baseline lines that match no crossing. */
  stale: BaselineEntry[];
  /** The sentence to hand a log: one line per crossing and per stale line, then the summary. */
  message: string;
  fileCount: number;
};

type Manifest = Partial<Record<"name" | "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies", unknown>>;
type Source = { file: string; lines: string[] };

const MANIFEST = "package.json";
const LAYERS_FILE = "layers.json";
const GITIGNORE = ".gitignore";
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SHELLISH_FILE = /\.(?:ya?ml|sh|bash|service)$/;
const TEXT_NAMES = new Set([MANIFEST, LAYERS_FILE, GITIGNORE]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const LAYER_TABLES = ["layers", "pinned"];
/** Conventional build outputs and caches: ignored because they are made, not because another repository's source was laid there. */
const BUILD_OUTPUTS = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "tmp", "temp", "runs", "logs", "vendor"]);
const COPYING_LINE = /\b(?:cp|rsync|cpSync|copyFileSync|copyFile|cpAsync|git\s+clone|git\s+archive|tar|degit)\b/;
const TOOL_ENV_NAME = /TOOL/;
const TOOL_CALL = /(?<![\w$])(?<!function\s)(?:toolPath|toolModule|toolUrl|toolRoot)\(\s*(?:["'`]([^"'`]*)["'`])?/g;
// Groups 1-4: `process.env.X`, `process.env["X"]`, `${X}` and a bare `$X`. In a SOURCE file `${X}` is a template's interpolation of a variable, not
// the environment, so only a shell-like file (workflow, script, manifest) reads group 3.
const ENV = String.raw`(?:process\.env\.([A-Za-z_]\w*)|process\.env\[\s*["']([A-Za-z_]\w*)["']\s*\]|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*))`;
// A quote of any of the three kinds, so a concatenation, a template and a `join` argument are all read.
const Q = "[\"'`]";
const ENV_THEN_SRC = new RegExp(`${ENV}[\\s)}"'\`+]*\\/src\\/([^\\s"'\`)]*)`, "g");
const ENV_JOINED_SRC = new RegExp(`${ENV}\\s*,\\s*${Q}src${Q}(?:\\s*,\\s*${Q}([^"'\`]+)${Q})?`, "g");
const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];

const posixPath = (path: string): string => path.split("\\").join("/");
const inNodeModules = (path: string): boolean => path.split("/").includes("node_modules");
const readsAsText = (path: string): boolean => CODE_FILE.test(path) || SHELLISH_FILE.test(path) || TEXT_NAMES.has(basename(path));
const isRelative = (specifier: string): boolean => /^\.{1,2}(?:\/|$)/.test(specifier);
const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/\/+$/, "");

function parseJsonObject(file: string, text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`boundary-check: ${file} is not a JSON object`, { cause });
  }
}

/** The lines of a file with comment-only lines and trailing ` // …` / ` # …` comments blanked, so the line numbers stay the file's own. */
function codeLines(file: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (file.endsWith(".json")) return lines;
  if (SHELLISH_FILE.test(file)) return lines.map((line) => (line.trimStart().startsWith("#") ? "" : line.replace(/\s#\s.*$/, "")));
  return lines.map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? "" : line.replace(/\s\/\/\s.*$/, "")));
}

const sourcesOf = (tree: BoundaryTree, accepts: (file: string) => boolean): Source[] =>
  Object.keys(tree).filter(accepts).sort().map((file) => ({ file, lines: codeLines(file, tree[file]) }));

// ---- cross-repo-import --------------------------------------------------------------------------------------------------------------------

/** The directory of the package a file belongs to: the nearest `package.json` at or above it, or undefined when none is in the tree. */
function ownerDir(tree: BoundaryTree, dir: string): string | undefined {
  if (posix.join(dir, MANIFEST) in tree) return dir;
  return dir === "." ? undefined : ownerDir(tree, posix.dirname(dir));
}

const manifestAt = (tree: BoundaryTree, dir: string): Manifest => parseJsonObject(posix.join(dir, MANIFEST), tree[posix.join(dir, MANIFEST)]) as Manifest;

function declares(importer: Manifest, name: unknown): boolean {
  if (typeof name !== "string") return false;
  return DEPENDENCY_FIELDS.some((field) => {
    const table = importer[field];
    return typeof table === "object" && table !== null && name in table;
  });
}

/** What a resolved relative import reaches that it should not, or undefined when it stays inside its own package or reaches a declared one. */
function importProblem(tree: BoundaryTree, file: string, resolved: string): string | undefined {
  if (resolved === ".." || resolved.startsWith("../")) return "climbs out of the repository root";
  const from = ownerDir(tree, posix.dirname(file));
  const into = ownerDir(tree, posix.dirname(resolved));
  if (from === into || into === undefined) return undefined;
  const target = manifestAt(tree, into);
  if (from !== undefined && declares(manifestAt(tree, from), target.name)) return undefined;
  const name = typeof target.name === "string" ? target.name : "unnamed";
  return `reaches ${into}, the package ${name}, which ${from === undefined ? "no manifest" : posix.join(from, MANIFEST)} does not declare`;
}

function importCrossings(tree: BoundaryTree, { file, lines }: Source): Crossing[] {
  return lines.flatMap((text, index) => SPECIFIERS.flatMap((pattern) => [...text.matchAll(pattern)])
    .map((match) => match[1]).filter(isRelative).flatMap((specifier) => {
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      const problem = importProblem(tree, file, resolved);
      return problem === undefined ? [] : [{ kind: "cross-repo-import" as const, file, line: index + 1, to: resolved, message: `${specifier} ${problem}` }];
    }));
}

// ---- tool-path ----------------------------------------------------------------------------------------------------------------------------

const toolCrossing = ({ file, line, to, message }: Omit<Crossing, "kind">): Crossing => ({ kind: "tool-path", file, line, to, message });

function envCrossings(file: string, text: string, line: number): Crossing[] {
  const shellLike = !CODE_FILE.test(file);
  return [ENV_THEN_SRC, ENV_JOINED_SRC].flatMap((pattern) => [...text.matchAll(pattern)]).flatMap((match) => {
    const name = match[1] ?? match[2] ?? (shellLike ? match[3] : undefined) ?? match[4];
    if (name === undefined || !TOOL_ENV_NAME.test(name)) return [];
    const to = `$${name}/src/${match[5] ?? ""}`.replace(/\/$/, "");
    return [toolCrossing({ file, line, to, message: `builds a path into the tool directory held in ${name}` })];
  });
}

function callCrossings(file: string, text: string, line: number): Crossing[] {
  return [...text.matchAll(TOOL_CALL)].map((match) =>
    toolCrossing({ file, line, to: `<tool dir>/${match[1] ?? "(computed)"}`, message: "asks for a path inside the tool directory" }));
}

function toolCrossings({ file, lines }: Source): Crossing[] {
  return lines.flatMap((text, index) => [...envCrossings(file, text, index + 1), ...callCrossings(file, text, index + 1)]);
}

// ---- laid-source --------------------------------------------------------------------------------------------------------------------------

const lineOfKey = (text: string, key: string): number => {
  const at = text.split(/\r?\n/).findIndex((line) => new RegExp(String.raw`"${key.replace(/[.+?^${}()|[\]\\*]/g, "\\$&")}"\s*:`).test(line));
  return at < 0 ? 1 : at + 1;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The layer entries a `layers.json` declares: the objects under `layers` and `pinned`, else the objects at the top level. */
function layerEntries(declaration: Record<string, unknown>): [string, Record<string, unknown>][] {
  const tables = LAYER_TABLES.map((name) => declaration[name]).filter(isRecord);
  const pools = tables.length > 0 ? tables : [declaration];
  return pools.flatMap((pool) => Object.entries(pool).filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]) && typeof pair[1].path === "string"));
}

function declaredCrossings(tree: BoundaryTree): Crossing[] {
  return Object.keys(tree).filter((file) => basename(file) === LAYERS_FILE).sort().flatMap((file) =>
    layerEntries(parseJsonObject(file, tree[file])).map(([key, entry]) => {
      const where = typeof entry.remote === "string" ? ` from ${entry.remote}` : "";
      return {
        kind: "laid-source" as const, file, line: lineOfKey(tree[file], key), to: withoutTrailingSlash(String(entry.path)),
        message: `${key}: ${String(entry.path)} is untracked here because another repository's source is laid there${where}`,
      };
    }));
}

/** A `.gitignore` line as a plain directory name relative to its file, or undefined for a glob, a negation, a dotfile or a build output. */
function ignoredDirectory(entry: string): string | undefined {
  const name = entry.trim().replace(/^\//, "").replace(/\/$/, "");
  if (name === "" || /[*?[!#]/.test(name) || name.startsWith(".") || BUILD_OUTPUTS.has(name)) return undefined;
  return name;
}

const mentions = (text: string, directory: string): boolean =>
  new RegExp(String.raw`(?:^|[\s"'=(/])${directory.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}(?:/|["'\s)]|$)`).test(text);

function writerOf(writers: Source[], directory: string): { file: string; line: number } | undefined {
  for (const { file, lines } of writers) {
    const at = lines.findIndex((text) => COPYING_LINE.test(text) && mentions(text, directory));
    if (at >= 0) return { file, line: at + 1 };
  }
  return undefined;
}

function ignoredCrossings(tree: BoundaryTree, declared: ReadonlySet<string>): Crossing[] {
  const writers = sourcesOf(tree, (file) => file !== LAYERS_FILE && (CODE_FILE.test(file) || SHELLISH_FILE.test(file) || basename(file) === MANIFEST));
  return Object.keys(tree).filter((file) => basename(file) === GITIGNORE).sort().flatMap((file) =>
    tree[file].split(/\r?\n/).flatMap((entry, index) => {
      const name = ignoredDirectory(entry);
      const to = name === undefined ? undefined : posix.join(posix.dirname(file), name);
      const writer = name === undefined ? undefined : writerOf(writers, name);
      if (to === undefined || writer === undefined || declared.has(to)) return [];
      return [{ kind: "laid-source" as const, file, line: index + 1, to, message: `${to} is ignored and ${writer.file}:${writer.line} copies another repository's source into it` }];
    }));
}

function laidCrossings(tree: BoundaryTree): Crossing[] {
  const declared = declaredCrossings(tree);
  return [...declared, ...ignoredCrossings(tree, new Set(declared.map(({ to }) => to)))];
}

// ---- the check ----------------------------------------------------------------------------------------------------------------------------

const byPlace = (a: Crossing, b: Crossing): number =>
  a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to);

/** A baseline: a JSON array of `{ from, to }`, or an object holding that array under `accepted`. Throws on anything else. */
export function parseBaseline(text: string): BaselineEntry[] {
  const parsed: unknown = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.accepted : undefined;
  if (!Array.isArray(entries)) throw new Error("boundary-check: a baseline is an array of { from, to }, or an object with that array under `accepted`");
  return entries.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.from !== "string" || typeof entry.to !== "string") throw new Error("boundary-check: every baseline entry needs a string `from` and a string `to`");
    return { from: entry.from, to: entry.to };
  });
}

const describe = ({ kind, file, line, to, message, status }: ReportedCrossing): string =>
  `${status === "accepted" ? "ACCEPTED" : "CROSSING"} [${kind}] ${file}:${line} -> ${to}: ${message}`;

function summarise(crossings: ReportedCrossing[], stale: BaselineEntry[], fileCount: number): string {
  const lines = [
    ...crossings.map(describe),
    ...stale.map(({ from, to }) => `STALE baseline ${from} -> ${to}: no longer matches anything, so delete the line`),
  ];
  const accepted = crossings.filter(({ status }) => status === "accepted").length;
  const total = crossings.length === 0 ? "no crossings" : `${crossings.length} crossing(s), ${accepted} accepted`;
  return [...lines, `${total}, ${stale.length} stale baseline line(s), ${fileCount} files read`].join("\n");
}

/** The check over a tree, against an optional baseline. An empty tree is `readable: false`. */
export function checkBoundaryTree(tree: BoundaryTree, baseline: readonly BaselineEntry[] = []): BoundaryResult {
  const fileCount = Object.keys(tree).length;
  if (fileCount === 0) {
    return { readable: false, crossings: [], stale: [], fileCount, message: "boundary-check: the tree holds no file, so it was not read (a clean answer for nothing is not an answer)" };
  }
  const code = sourcesOf(tree, (file) => CODE_FILE.test(file));
  const reaches = sourcesOf(tree, (file) => CODE_FILE.test(file) || SHELLISH_FILE.test(file) || basename(file) === MANIFEST);
  const found = [...code.flatMap((source) => importCrossings(tree, source)), ...reaches.flatMap(toolCrossings), ...laidCrossings(tree)].sort(byPlace);
  const matches = (entry: BaselineEntry, crossing: Crossing): boolean => entry.from === crossing.file && entry.to === crossing.to;
  const crossings = found.map((crossing) => ({ ...crossing, status: baseline.some((entry) => matches(entry, crossing)) ? "accepted" as const : "found" as const }));
  const stale = baseline.filter((entry) => !found.some((crossing) => matches(entry, crossing)));
  return { readable: true, crossings, stale: [...stale], fileCount, message: summarise(crossings, [...stale], fileCount) };
}

// ---- the disk -----------------------------------------------------------------------------------------------------------------------------

const GIT_LOCATORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

/** `git ls-files` in `root` with the variables a git hook exports removed: they would point it at another repository. */
function listWithGit(root: string): string[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_LOCATORS.includes(key)));
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    env, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"],
  });
  // A tracked file deleted from disk and not yet staged is still in `--cached`; a gitlink (submodule) is a directory.
  return out.split("\0").filter(Boolean).filter((path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() === false);
}

function walk(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (!entry.isDirectory()) return [path];
    return entry.name === ".git" || entry.name === "node_modules" ? [] : walk(root, path);
  });
}

/** A directory as a `BoundaryTree`: every file outside `node_modules`, with the text of the files the check reads. */
export function readBoundaryTree(root: string): BoundaryTree {
  const files = (existsSync(join(root, ".git")) ? listWithGit(root) : walk(root, "")).map(posixPath).filter((path) => !inNodeModules(path));
  return Object.fromEntries(files.map((path) => [path, readsAsText(path) ? readFileSync(join(root, path), "utf8") : ""]));
}

/** The check over the repository at `root`. */
export function checkBoundary({ root, baseline = [] }: { root: string; baseline?: readonly BaselineEntry[] }): BoundaryResult {
  return checkBoundaryTree(readBoundaryTree(root), baseline);
}

// ---- the command --------------------------------------------------------------------------------------------------------------------------

const EXIT = { reported: 0, unreadable: 2 } as const;
export type Output = { log: (line: string) => void; error: (line: string) => void };
type Options = { root: string; baseline?: string; out?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { root: "." };
  for (const arg of argv) {
    const match = /^--(root|baseline|out)=(.+)$/.exec(arg);
    // A bare directory is `--root=`: `layout-check <dir>` is the shape every bin of this package is run with (layout-check.test.ts runs them all so).
    if (match === null && !arg.startsWith("-")) options.root = arg;
    else if (match === null) throw new Error(`unknown argument ${arg} (usage: boundary-check [--root=<dir>] [--baseline=<json>] [--out=<file>])`);
    else options[match[1] as keyof Options] = match[2];
  }
  return options;
}

/** The command: `boundary-check [--root=<dir> | <dir>] [--baseline=<json>] [--out=<file>]`. Returns the exit code instead of exiting, so a test can run it. */
export function main(argv: string[], output: Output = console): number {
  try {
    const options = parseArgs(argv);
    const baseline = options.baseline === undefined ? [] : parseBaseline(readFileSync(options.baseline, "utf8"));
    const result = checkBoundary({ root: options.root, baseline });
    if (!result.readable) {
      output.error(result.message);
      return EXIT.unreadable;
    }
    for (const line of result.message.split("\n")) output.log(`boundary-check: ${line}`);
    if (options.out !== undefined) writeFileSync(options.out, `${JSON.stringify({ root: options.root, ...result }, null, 2)}\n`);
    return EXIT.reported;
  } catch (cause) {
    output.error(`boundary-check: cannot read: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT.unreadable;
  }
}

// Run as the `boundary-check` bin (a symlink in node_modules/.bin, so both sides are resolved); importing the module runs nothing.
const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
