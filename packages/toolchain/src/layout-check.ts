#!/usr/bin/env node
/**
 * THE LAYOUT CHECK: A MONOREPO SHAPE CANNOT COME BACK BY HABIT (ADR 0043, Decision 7; a11ign/a11ign#4210).
 *
 * The standard: a single-package repository has its package at the ROOT (one README, one package.json, no workspace file); a
 * multi-package repository exists only when it PUBLISHES more than one package, and each directory is named after its package. The split
 * repositories kept the monorepo's shape anyway, so this fails on exactly four things and names which, with the path:
 *
 *   workspace-of-one   a `pnpm-workspace.yaml` / `workspaces` field that publishes one package (or resolves to one non-shell manifest)
 *   directory-name     a package directory not named for the part of its package name after the scope
 *   second-readme      a root README and `<dir>/README.md` for ONE package (a README in a SUBDIRECTORY documents a part: not read)
 *   leftover           a `lerna.json`, or a private `*-workspace` root manifest whose only job is to hold a workspace
 *
 * WHAT COUNTS AS "ONE PACKAGE". A private `*-workspace` root is a SHELL, not a package, so `documents-workspace` + `packages/pdf` is one
 * package. ADR 0043 then adds that a private member does not count toward "multi-package": a published package beside a member that
 * publishes nothing is still failure 1 (`screenreader-worker` with `packages/nvda-speech`). So `workspace-of-one` fires when the
 * non-shell members number one OR the published ones do. A repository publishing two packages passes, shell root and all.
 *
 * THE TREE IS A MAP, NOT A DISK. `checkLayoutTree` takes `{ path: text }` (text only matters for `package.json`, `pnpm-workspace.yaml`
 * and `lerna.json`), so a fixture is a repository's tree listing at a commit and needs no checkout. `checkLayout({ root })` reads a
 * directory into that map (`git ls-files` in a working tree, a walk elsewhere) and an EMPTY tree is red, never a pass: a reader that
 * found nothing would otherwise report a clean layout.
 *
 * ONE LINE FOR A CONSUMER'S `ci.yml`: `npx --yes --package @a11ign/toolchain layout-check` (exit 0 clean, 1 a layout failure, 2 unreadable).
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type LayoutCheckName = "workspace-of-one" | "directory-name" | "second-readme" | "leftover";
export type LayoutProblem = { check: LayoutCheckName; path: string; message: string };
export type LayoutTree = Readonly<Record<string, string>>;
export type LayoutResult = {
  ok: boolean;
  problems: LayoutProblem[];
  /** The sentence to hand an assertion or a log: one line per problem, `[check] path: why`; on an unreadable tree, the reason. */
  message: string;
  fileCount: number;
};

type Manifest = { name?: string; private?: boolean; workspaces?: string[] | { packages?: string[] } };
type Member = { dir: string; path: string; manifest: Manifest };
type Workspace = { source: string; members: Member[] };

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const MANIFEST = "package.json";
const README = /^readme(\.[a-z]+)?$/i;
const SHELL_SUFFIX = "-workspace";

const posix = (path: string): string => path.split("\\").join("/");
const joinPath = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);
const inNodeModules = (path: string): boolean => path.split("/").includes("node_modules");

function parseManifest(tree: LayoutTree, path: string): Manifest {
  try {
    const parsed: unknown = JSON.parse(tree[path]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Manifest;
  } catch (cause) {
    throw new Error(`layout-check: ${path} is not a JSON object`, { cause });
  }
}

const isShell = (manifest: Manifest | undefined): boolean => manifest?.private === true && (manifest.name ?? "").endsWith(SHELL_SUFFIX);
const isPublished = (member: Member): boolean => member.manifest.private !== true;

/** The list under `packages:` of a pnpm-workspace.yaml, in the block form (`- "glob"`) or the flow form (`["a", "b"]`). Throws on neither. */
export function workspacePatternsOf(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (at < 0) throw new Error(`layout-check: ${WORKSPACE_FILE} has no top-level \`packages:\` list`);
  const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const inline = lines[at].replace(/^packages\s*:/, "").replace(/\s+#.*$/, "").trim();
  if (inline.startsWith("[")) return inline.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.*?)\s*(?:\s#.*)?$/.exec(line);
    if (item) items.push(unquote(item[1]));
    else if (/^\S/.test(line)) break;
  }
  if (items.length === 0) throw new Error(`layout-check: ${WORKSPACE_FILE} \`packages:\` holds no readable pattern`);
  return items;
}

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

/** Whether the directory segments match the glob segments: `*` inside one segment, `**` across any number of them. */
function matchesGlob(glob: string[], dir: string[]): boolean {
  if (glob.length === 0) return dir.length === 0;
  const [head, ...rest] = glob;
  if (head === "**") return matchesGlob(rest, dir) || (dir.length > 0 && matchesGlob(glob, dir.slice(1)));
  return dir.length > 0 && segmentPattern(head).test(dir[0]) && matchesGlob(rest, dir.slice(1));
}

const globSegments = (pattern: string): string[] => posix(pattern).replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter((s) => s !== "" && s !== ".");

function resolveMembers(tree: LayoutTree, patterns: string[]): Member[] {
  const dirs = Object.keys(tree).filter((path) => basename(path) === MANIFEST && !inNodeModules(path)).map((path) => (dirname(path) === "." ? "" : dirname(path)));
  const included = patterns.filter((p) => !p.startsWith("!")).map(globSegments);
  const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => globSegments(p.slice(1)));
  const wanted = dirs.filter((dir) => {
    const segments = dir === "" ? [] : dir.split("/");
    return included.some((glob) => matchesGlob(glob, segments)) && !excluded.some((glob) => matchesGlob(glob, segments));
  });
  return wanted.sort().map((dir) => ({ dir, path: joinPath(dir, MANIFEST), manifest: parseManifest(tree, joinPath(dir, MANIFEST)) }));
}

/** The workspace a repository declares, by pnpm's file first and the root manifest's `workspaces` field second; undefined when it declares none. */
function workspaceOf(tree: LayoutTree, root: Manifest | undefined): Workspace | undefined {
  if (WORKSPACE_FILE in tree) return { source: WORKSPACE_FILE, members: resolveMembers(tree, workspacePatternsOf(tree[WORKSPACE_FILE])) };
  const field = root?.workspaces;
  if (field === undefined) return undefined;
  const patterns = Array.isArray(field) ? field : (field.packages ?? []);
  return { source: MANIFEST, members: resolveMembers(tree, patterns) };
}

const nameOf = ({ manifest }: Member): string => manifest.name ?? "(unnamed)";

function workspaceProblems(workspace: Workspace | undefined): LayoutProblem[] {
  if (workspace === undefined) return [];
  const packages = workspace.members.filter(({ manifest }) => !isShell(manifest));
  const published = packages.filter(isPublished);
  const holds = packages.map((member) => `${member.dir || "."} (${nameOf(member)})`).join(", ");
  if (packages.length === 1) {
    return [{ check: "workspace-of-one", path: workspace.source, message: `the workspace resolves to one package, ${holds}: it belongs at the repository root, with no workspace file` }];
  }
  if (published.length === 1) {
    return [{ check: "workspace-of-one", path: workspace.source, message: `the workspace publishes one package, ${nameOf(published[0])}, beside members that publish nothing (${holds}): that is a single-package repository, so fold the private ones into its src/` }];
  }
  return [];
}

/** After the scope: `@a11ign/documents` is `documents`; a name with no scope is itself. */
const unscoped = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

function directoryProblems(workspace: Workspace | undefined): LayoutProblem[] {
  const named = (workspace?.members ?? []).filter(({ dir, manifest }) => dir !== "" && manifest.name !== undefined);
  return named.filter((member) => basename(member.dir) !== unscoped(nameOf(member))).map((member) => ({
    check: "directory-name" as const,
    path: member.dir,
    message: `${member.dir} holds ${nameOf(member)}, so its directory should be named "${unscoped(nameOf(member))}", not "${basename(member.dir)}"`,
  }));
}

const readmeIn = (tree: LayoutTree, dir: string): string | undefined =>
  Object.keys(tree).find((path) => dirname(path) === (dir === "" ? "." : dir) && README.test(basename(path)));

function readmeProblems(tree: LayoutTree, root: Manifest | undefined, workspace: Workspace | undefined): LayoutProblem[] {
  const rootReadme = readmeIn(tree, "");
  if (rootReadme === undefined || root === undefined) return [];
  const nested = (workspace?.members ?? []).filter(({ dir, manifest }) => dir !== "" && !isShell(manifest));
  // One package under a shell root: the root README has no other package to describe, so it describes this one.
  const describesIt = (member: Member): boolean => (root.name !== undefined && root.name === member.manifest.name) || (isShell(root) && nested.length === 1);
  return nested.filter(describesIt).flatMap((member) => {
    const second = readmeIn(tree, member.dir);
    return second === undefined ? [] : [{
      check: "second-readme" as const,
      path: second,
      message: `${second} and ${rootReadme} describe the same package (${nameOf(member)}); the root README is also the npm page, so keep one`,
    }];
  });
}

function leftoverProblems(tree: LayoutTree, root: Manifest | undefined, workspace: Workspace | undefined): LayoutProblem[] {
  const dirs = ["", ...(workspace?.members ?? []).map(({ dir }) => dir)];
  const lerna = [...new Set(dirs)].map((dir) => joinPath(dir, "lerna.json")).filter((path) => path in tree)
    .map((path) => ({ check: "leftover" as const, path, message: `${path} configures a layout that is gone; delete it` }));
  const publishes = (workspace?.members ?? []).filter(isPublished).length;
  const shell = isShell(root) && publishes < 2
    ? [{ check: "leftover" as const, path: MANIFEST, message: `${root?.name} is a private ${SHELL_SUFFIX} root whose only job is to hold a workspace of ${publishes} published package(s); the package belongs at the root` }]
    : [];
  return [...lerna, ...shell];
}

function problemsOf(tree: LayoutTree): LayoutProblem[] {
  const root = MANIFEST in tree ? parseManifest(tree, MANIFEST) : undefined;
  const workspace = workspaceOf(tree, root);
  return [...workspaceProblems(workspace), ...directoryProblems(workspace), ...readmeProblems(tree, root, workspace), ...leftoverProblems(tree, root, workspace)];
}

const describe = ({ check, path, message }: LayoutProblem): string => `[${check}] ${path}: ${message}`;

/** The check over a tree. An empty tree is `ok: false` with no problem: nothing was read, so nothing can be said to be clean. */
export function checkLayoutTree(tree: LayoutTree): LayoutResult {
  const fileCount = Object.keys(tree).length;
  if (fileCount === 0) return { ok: false, problems: [], message: "layout-check: the tree holds no file, so it was not read (a clean answer for nothing is not an answer)", fileCount };
  const problems = problemsOf(tree);
  return { ok: problems.length === 0, problems, message: problems.map(describe).join("\n"), fileCount };
}

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
    const path = joinPath(dir, entry.name);
    if (!entry.isDirectory()) return [path];
    return entry.name === ".git" || entry.name === "node_modules" ? [] : walk(root, path);
  });
}

const READ_AS_TEXT = new Set([MANIFEST, WORKSPACE_FILE, "lerna.json"]);

/** A directory as a `LayoutTree`: every file outside `node_modules`, with the text of the three files the check reads. */
export function readLayoutTree(root: string): LayoutTree {
  const files = (existsSync(join(root, ".git")) ? listWithGit(root) : walk(root, "")).map(posix).filter((path) => !inNodeModules(path));
  return Object.fromEntries(files.map((path) => [path, READ_AS_TEXT.has(basename(path)) ? readFileSync(join(root, path), "utf8") : ""]));
}

/** The check over the repository at `root`. */
export function checkLayout({ root }: { root: string }): LayoutResult {
  return checkLayoutTree(readLayoutTree(root));
}

const EXIT = { ok: 0, layout: 1, unreadable: 2 } as const;
export type Output = { log: (line: string) => void; error: (line: string) => void };

/** The command: `layout-check [directory]`. Returns the exit code instead of exiting, so a test can run it. */
export function main(argv: string[], output: Output = console): number {
  const root = argv[0] ?? process.cwd();
  let result: LayoutResult;
  try {
    result = checkLayout({ root });
  } catch (cause) {
    output.error(`layout-check: cannot read ${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT.unreadable;
  }
  if (result.fileCount === 0) {
    output.error(result.message);
    return EXIT.unreadable;
  }
  if (result.ok) {
    output.log(`layout-check: ok (${result.fileCount} files read under ${root})`);
    return EXIT.ok;
  }
  for (const problem of result.problems) output.error(`layout-check: FAIL ${describe(problem)}`);
  return EXIT.layout;
}

// Run as the `layout-check` bin (a symlink in node_modules/.bin, so both sides are resolved); importing the module runs nothing.
const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
