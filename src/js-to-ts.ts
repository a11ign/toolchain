/**
 * THE JS-TO-TS CONVERSION SCRIPT: JSDoc SOURCE BECOMES TYPESCRIPT BY A SCRIPT, AND AN AGENT FIXES ONLY THE RESIDUE
 * (ADR 0043, the chairman's third direction of 2026-10-08; a11ign/a11ign#4248).
 *
 * The files are already `// @ts-check` JSDoc, so the step is mechanical and its token cost is a hard constraint. For a repository:
 *
 *   1. RENAME  every `.mjs`/`.cjs`/`.js` source (outside `node_modules`, `dist`, `build`) to `.ts`, with `git mv` so history follows.
 *   2. ANNOTATE each renamed file with TypeScript's combined fix `annotateWithTypeFromJSDoc` (the language service, so `typescript` is a
 *      PEER dependency and the 6.x JavaScript API is required: TypeScript 7 has no JavaScript API, a11ign/a11ign#3729, and the command
 *      refuses with that sentence rather than guessing). An optional parameter (`@param {T} [x]`, `{T=}`) is made `x?: T` afterwards,
 *      because the fix leaves it required and every caller then fails TS2554.
 *   3. REWRITE every path that names a renamed file, in EVERY file of the repository, outside the set too: a relative import specifier
 *      becomes `./x.ts` (the form ADR 0043 Decision 8 chose: `tsx` runs it and `rewriteRelativeImportExtensions` rewrites it on emit), and so
 *      does any other path-shaped token (a `package.json` script, a workflow `run:`, a unit, a document, a `new URL("./x.mjs", ...)`) that
 *      RESOLVES to a renamed file, relative to its own file for `./` and `../`, else to the root. One pass, because an import specifier is a
 *      path-shaped token. The files edited outside the set are PRINTED: they are the pull request's `Outside-Region:` lines. What is NOT
 *      rewritten is printed too: a bare `x.mjs` that resolves to nothing but names a renamed file's basename (it may be another file), a
 *      path inside a template literal (often a fixture that runs from elsewhere), and a `CHANGELOG`, which is history.
 *   4. TYPECHECK with the repository's own `tsc --noEmit` and write the RESIDUE: each file with errors, its error codes and counts.
 *
 * WHICH CONVERTER, MEASURED (2026-10-09, one fixture of three files: typed params, an optional param, a `@typedef`, an untyped param):
 *   the language service fix kept `x: number`, left the `@typedef` use as TS2304 and the untyped param as TS7006: the residue SHOWS what
 *   it could not do. `ts-migrate` 0.1.35 (last published 2022-11, 478 packages / 100 MB installed, eslint 7) wrote `x: any` for every
 *   parameter INCLUDING the JSDoc-typed ones, so the project typechecked with 0 errors and the types were gone: it hides the residue
 *   this script exists to report. It also left `./b.js` specifiers alone and its `-full` form stopped to ask a question.
 *
 * `--exclude <path>` (repeatable) leaves a file or a directory alone and lists it as skipped, for the files a deployed unit or an Ansible
 * task names by path. `--dry-run` writes nothing. A SECOND RUN changes nothing and reports the same residue: with no source left to
 * rename, the residue is whatever `tsc` still says. An empty tree is red (`2`), never a clean answer.
 *
 * Exit codes: 0 converted and the typecheck is clean (or a dry run that found nothing wrong), 1 residue remains, 2 nothing could be read
 * or the command was misused.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** A repository as `{ repository-relative posix path: text }`, text files only. */
export type Tree = Record<string, string>;
export type Skipped = { path: string; reason: string };
export type Reference = { path: string; line: number; text: string };
export type ResidueFile = { path: string; codes: Record<string, number>; reason: "typecheck" | "not-converted" };
export type Plan = {
  /** old path to new path, for each file that is renamed. */
  renames: Record<string, string>;
  skipped: Skipped[];
  /** the new text of every file whose text changed, keyed by its path AFTER the rename. */
  written: Tree;
  /** changed files that are not in the renamed set: the pull request's `Outside-Region:` lines. */
  outside: string[];
  /** places that name a renamed file and were not rewritten. */
  unrewritten: Reference[];
  /** files that could not convert, with the syntax error codes. */
  notConverted: ResidueFile[];
};
export type Typecheck = { ran: boolean; reason: string; diagnostics: { path: string; code: string; line: number; message: string }[] };
export type Report = {
  typescript: string;
  dryRun: boolean;
  renamed: string[];
  converted: string[];
  skipped: Skipped[];
  outside: string[];
  unrewritten: Reference[];
  typecheck: { ran: boolean; reason: string; errors: number };
  residue: ResidueFile[];
};

const SOURCE = /\.(?:mjs|cjs|js)$/;
const NOT_SOURCE_DIR = /(?:^|\/)(?:node_modules|dist|build|\.git)\//;
const CODE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/;
const NEVER_READ = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;
const HISTORY = /(?:^|\/)CHANGELOG[^/]*$/i;
const MAX_TEXT_BYTES = 1 << 20;
/** A path-shaped token ending in a JavaScript source extension, not preceded or followed by anything that would make it part of a longer name. */
const PATH_TOKEN = /(?<![\w@./-])((?:\.{1,2}\/)*(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:mjs|cjs|js))(?![\w-]|\.\w)/g;
const TSC_LINE = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
const EXIT = { ok: 0, residue: 1, unusable: 2 } as const;

const toTs = (path: string): string => path.replace(SOURCE, ".ts");
const isInside = (path: string, excluded: string): boolean => path === excluded || path.startsWith(`${excluded.replace(/\/$/, "")}/`);

function requireLanguageService(): void {
  if (typeof ts.createLanguageService !== "function") {
    throw new Error("js-to-ts needs the TypeScript 6.x JavaScript API; the typescript that resolved has none (TypeScript 7 has no JavaScript API, a11ign/a11ign#3729)");
  }
}

/** The syntax error codes of `text` read as TypeScript, or none. A file that does not even parse is not renamed. */
function syntaxCodes(path: string, text: string): string[] {
  const { diagnostics } = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return (diagnostics ?? []).map(({ code }) => `TS${code}`);
}

type Candidates = { renames: Record<string, string>; skipped: Skipped[]; notConverted: ResidueFile[] };

/** Which sources are renamed: all of them but the excluded, the ones whose `.ts` already exists, and the ones that do not parse. */
function chooseCandidates(tree: Tree, exclude: readonly string[]): Candidates {
  const result: Candidates = { renames: {}, skipped: [], notConverted: [] };
  for (const path of Object.keys(tree).filter((p) => SOURCE.test(p) && !NOT_SOURCE_DIR.test(p) && !/\.d\.[mc]?[jt]s$/.test(p)).sort()) {
    const excluded = exclude.find((entry) => isInside(path, entry));
    const codes = excluded === undefined ? syntaxCodes(toTs(path), tree[path]) : [];
    if (excluded !== undefined) result.skipped.push({ path, reason: `excluded by --exclude ${excluded}` });
    else if (toTs(path) in tree) result.skipped.push({ path, reason: `${toTs(path)} already exists` });
    else if (codes.length > 0) result.notConverted.push({ path, codes: countCodes(codes), reason: "not-converted" });
    else result.renames[path] = toTs(path);
  }
  return result;
}

function countCodes(codes: readonly string[]): Record<string, number> {
  const counted: Record<string, number> = {};
  for (const code of codes) counted[code] = (counted[code] ?? 0) + 1;
  return counted;
}

type Edit = { start: number; end: number; text: string };

function applyEdits(text: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((out, { start, end, text: replacement }) => out.slice(0, start) + replacement + out.slice(end), text);
}

/** The path a token names, resolved against the file it is in (`./`, `../`) or the root. Undefined for a bare name beside a nested file. */
function resolveToken(holder: string, token: string): string | undefined {
  if (token.startsWith(".")) return posix.join(posix.dirname(holder), token);
  return token.includes("/") || !holder.includes("/") ? posix.normalize(token) : undefined;
}

type Mentions = { text: string; unrewritten: Reference[] };
type Range = readonly [start: number, end: number];

/**
 * The template literals of a code file. A template is often a FIXTURE (a test writing `import "./x.mjs"` into a temporary file that runs from
 * somewhere else), so a path inside one is printed and never rewritten; a path in an ordinary string or a comment is.
 */
function templateRanges(path: string, text: string): Range[] {
  const ranges: Range[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) ranges.push([node.getStart(), node.end]);
    else ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true));
  return ranges;
}

/** 3b: rewrite the path-shaped tokens that resolve to a renamed file; list the bare names that match one's basename and resolve to nothing. */
function rewriteMentions(holder: string, text: string, renames: Record<string, string>, templates: readonly Range[]): Mentions {
  const basenames = new Set(Object.keys(renames).map((path) => basename(path)));
  const history = HISTORY.test(holder);
  const unrewritten: Reference[] = [];
  const lineOf = (index: number): number => text.slice(0, index).split("\n").length;
  const edits: Edit[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1];
    const resolved = resolveToken(holder, token);
    const start = match.index ?? 0;
    const names = resolved !== undefined && resolved in renames;
    const inTemplate = templates.some(([from, to]) => start >= from && start < to);
    if (names && !history && !inTemplate) edits.push({ start, end: start + token.length, text: toTs(token) });
    else if (names || basenames.has(basename(token))) unrewritten.push({ path: holder, line: lineOf(start), text: token });
  }
  return { text: applyEdits(text, edits), unrewritten };
}

type Rewritten = { written: Tree; unrewritten: Reference[] };

/** Steps 3 and 3b over every text file (an import specifier is one more path-shaped token): the new text of each that changed, keyed by its path AFTER the rename. */
function rewriteReferences(tree: Tree, renames: Record<string, string>): Rewritten {
  const written: Tree = {};
  const unrewritten: Reference[] = [];
  for (const [path, text] of Object.entries(tree)) {
    const mentions = rewriteMentions(path, text, renames, CODE.test(path) ? templateRanges(path, text) : []);
    unrewritten.push(...mentions.unrewritten);
    if (mentions.text !== text) written[renames[path] ?? path] = mentions.text;
  }
  return { written, unrewritten };
}

/** A parameter documented as optional (`@param {T} [x]`, `{T=}`) and annotated without `?`, which the combined fix leaves required. */
function optionalizeParameters(fileName: string, text: string): string {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && isDocumentedOptional(node)) edits.push({ start: node.name.end, end: node.name.end, text: "?" });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return applyEdits(text, edits);
}

function isDocumentedOptional(parameter: ts.ParameterDeclaration): boolean {
  if (parameter.type === undefined || parameter.questionToken !== undefined || parameter.initializer !== undefined) return false;
  return ts.getJSDocParameterTags(parameter).some((tag) => tag.isBracketed || tag.typeExpression?.type.kind === ts.SyntaxKind.JSDocOptionalType);
}

function annotateHost(root: string, files: Tree, targets: string[]): ts.LanguageServiceHost {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    noEmit: true, allowJs: true, rewriteRelativeImportExtensions: true, skipLibCheck: true,
  };
  const text = (file: string): string | undefined => files[posix.relative(root, file)] ?? (ts.sys.fileExists(file) ? ts.sys.readFile(file) : undefined);
  return {
    getScriptFileNames: () => targets.map((path) => posix.join(root, path)), getScriptVersion: () => "1",
    getScriptSnapshot: (file) => { const content = text(file); return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content); },
    getCurrentDirectory: () => root, getCompilationSettings: () => options, getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => text(file) !== undefined, readFile: text, readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
  };
}

/** The annotated text of every renamed file, keyed by new path. A fix that throws is recorded, never swallowed, and the file keeps its text. */
function annotate(root: string, files: Tree, targets: string[]): { texts: Tree; failures: ResidueFile[] } {
  const service = ts.createLanguageService(annotateHost(root, files, targets));
  const texts: Tree = {};
  const failures: ResidueFile[] = [];
  for (const path of targets) {
    try {
      const fix = service.getCombinedCodeFix({ type: "file", fileName: posix.join(root, path) }, "annotateWithTypeFromJSDoc", ts.getDefaultFormatCodeSettings(), {});
      const edits = fix.changes.flatMap(({ textChanges }) => textChanges.map(({ span, newText }) => ({ start: span.start, end: span.start + span.length, text: newText })));
      texts[path] = optionalizeParameters(path, applyEdits(files[path], edits));
    } catch (cause) {
      texts[path] = files[path];
      failures.push({ path, codes: { [`annotate-failed: ${cause instanceof Error ? cause.message : String(cause)}`]: 1 }, reason: "not-converted" });
    }
  }
  return { texts, failures };
}

/** The whole plan for a tree, without touching a disk: what is renamed, what text changes, what is left alone. */
export function planConversion(tree: Tree, { exclude = [], root = "/repo" }: { exclude?: readonly string[]; root?: string } = {}): Plan {
  requireLanguageService();
  const { renames, skipped, notConverted } = chooseCandidates(tree, exclude);
  const { written, unrewritten } = rewriteReferences(tree, renames);
  const renamedAfter = Object.values(renames);
  const asRenamed: Tree = Object.fromEntries(Object.entries(tree).filter(([path]) => !(path in renames)).map(([path, text]) => [path, written[path] ?? text]));
  for (const path of Object.keys(renames)) asRenamed[renames[path]] = written[renames[path]] ?? tree[path];
  const annotated = annotate(root, asRenamed, renamedAfter);
  Object.assign(written, annotated.texts);
  const changed = Object.fromEntries(Object.entries(written).filter(([path, text]) => text !== (tree[path] ?? undefined) || renamedAfter.includes(path)));
  const outside = Object.keys(changed).filter((path) => !renamedAfter.includes(path)).sort();
  return { renames, skipped, written: changed, outside, unrewritten, notConverted: [...notConverted, ...annotated.failures] };
}

const GIT_LOCATORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_LOCATORS.includes(key)));
}

function listFiles(root: string): string[] {
  if (existsSync(join(root, ".git"))) {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env: gitEnv(), encoding: "utf8", maxBuffer: 1 << 28 });
    return out.split("\0").filter(Boolean);
  }
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (!entry.isDirectory()) return [path];
    return entry.name === ".git" || entry.name === "node_modules" ? [] : walk(path);
  });
  return walk("");
}

/** The repository's text files as a tree: a deleted-but-listed file, a directory (a submodule), a big file and a binary are left out. */
export function readTree(root: string): Tree {
  const tree: Tree = {};
  for (const path of listFiles(root).filter((p) => !NEVER_READ.test(p) && !/(?:^|\/)node_modules\//.test(p) && !/(?:^|\/)(?:dist|build)\//.test(p))) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > MAX_TEXT_BYTES) continue;
    const text = readFileSync(join(root, path), "utf8");
    if (!text.includes("\0")) tree[path] = text;
  }
  return tree;
}

function moveFile(root: string, from: string, to: string): void {
  try {
    execFileSync("git", ["-C", root, "mv", from, to], { env: gitEnv(), stdio: "pipe" });
  } catch (cause) {
    // Not a tracked file (or not a repository): a plain rename still gives the file its new name; say so rather than hide that history is not followed.
    process.stderr.write(`js-to-ts: git mv ${from} failed (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}); renamed without git\n`);
    renameSync(join(root, from), join(root, to));
  }
}

/** Write the plan to disk: the renames first (`git mv`), then every changed file's text. */
export function applyPlan(root: string, plan: Plan): void {
  for (const [from, to] of Object.entries(plan.renames)) moveFile(root, from, to);
  for (const [path, text] of Object.entries(plan.written)) writeFileSync(join(root, path), text);
}

/** The `tsc` of the repository itself when it has one, else this package's own copy of the same major. */
function tscOf(root: string): string {
  try {
    return createRequire(join(root, "noop.js")).resolve("typescript/bin/tsc");
  } catch {
    return createRequire(import.meta.url).resolve("typescript/bin/tsc");
  }
}

/** 4: the repository's own `tsc --noEmit`, read into diagnostics. Not run is said, with the reason, never reported as clean. */
export function typecheck(root: string): Typecheck {
  const project = join(root, "tsconfig.json");
  if (!existsSync(project)) return { ran: false, reason: "no tsconfig.json at the root, so there is no typecheck to run", diagnostics: [] };
  const run = spawnSync(process.execPath, [tscOf(root), "--noEmit", "--pretty", "false", "-p", project], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  const diagnostics = `${run.stdout}${run.stderr}`.split("\n").flatMap((line) => {
    const match = TSC_LINE.exec(line);
    return match === null ? [] : [{ path: posix.relative(root, join(root, match[1])), code: match[3], line: Number(match[2]), message: match[4] }];
  });
  if (run.status !== 0 && diagnostics.length === 0) {
    return { ran: false, reason: `tsc exited ${run.status} and printed no diagnostic: ${`${run.stdout}${run.stderr}`.trim().slice(0, 300)}`, diagnostics };
  }
  return { ran: true, reason: "tsc --noEmit", diagnostics };
}

function residueOf(check: Typecheck, notConverted: ResidueFile[]): ResidueFile[] {
  const byFile = new Map<string, string[]>();
  for (const { path, code } of check.diagnostics) byFile.set(path, [...(byFile.get(path) ?? []), code]);
  const typed = [...byFile].map(([path, codes]) => ({ path, codes: countCodes(codes), reason: "typecheck" as const }));
  return [...notConverted, ...typed].sort((a, b) => a.path.localeCompare(b.path));
}

/** The conversion of the repository at `root`: plans it, writes it unless `dryRun`, typechecks what was written. An empty tree throws. */
export function convert({ root, exclude = [], dryRun = false }: { root: string; exclude?: readonly string[]; dryRun?: boolean }): Report {
  const tree = readTree(root);
  if (Object.keys(tree).length === 0) throw new Error(`the tree under ${root} holds no text file, so it was not read (a clean answer for nothing is not an answer)`);
  const plan = planConversion(tree, { exclude, root: posix.resolve(root) });
  const renamed = Object.keys(plan.renames);
  if (!dryRun) applyPlan(root, plan);
  const check: Typecheck = dryRun ? { ran: false, reason: "dry run: nothing was written, so there is nothing to typecheck", diagnostics: [] } : typecheck(root);
  const residue = residueOf(check, plan.notConverted);
  const dirty = new Set(residue.map(({ path }) => path));
  return {
    typescript: ts.version, dryRun, renamed,
    converted: renamed.map((path) => plan.renames[path]).filter((path) => !dirty.has(path)),
    skipped: plan.skipped, outside: plan.outside, unrewritten: plan.unrewritten,
    typecheck: { ran: check.ran, reason: check.reason, errors: check.diagnostics.length }, residue,
  };
}

export type Output = { log: (line: string) => void; error: (line: string) => void };
type Args = { root: string; exclude: string[]; dryRun: boolean; json: boolean };

function parseArgs(argv: string[]): Args | string {
  const args: Args = { root: process.cwd(), exclude: [], dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--exclude") args.exclude.push(argv[(i += 1)] ?? "");
    else if (arg.startsWith("--exclude=")) args.exclude.push(arg.slice("--exclude=".length));
    else if (arg.startsWith("--")) return `unknown flag ${arg} (it takes --exclude <path>, --dry-run, --json)`;
    else args.root = arg;
  }
  return args.exclude.includes("") ? "--exclude needs a path" : args;
}

function printReport(report: Report, output: Output): void {
  const verb = report.dryRun ? "would rename" : "renamed";
  const outcome = report.dryRun ? `${report.residue.length} cannot parse` : `${report.converted.length} converted clean, ${report.residue.length} in the residue`;
  output.log(`js-to-ts: ${verb} ${report.renamed.length} file(s) under TypeScript ${report.typescript}; ${outcome}`);
  for (const path of report.renamed) output.log(`  ${verb} ${path}`);
  for (const { path, reason } of report.skipped) output.log(`  skipped ${path}: ${reason}`);
  for (const path of report.outside) output.log(`  edited outside the set (an Outside-Region line): ${path}`);
  for (const { path, line, text } of report.unrewritten) output.log(`  NOT REWRITTEN ${path}:${line} names ${text}`);
  output.log(`  typecheck: ${report.typecheck.ran ? `${report.typecheck.errors} error(s)` : `NOT RUN (${report.typecheck.reason})`}`);
  for (const { path, codes } of report.residue) output.log(`  residue ${path}  ${Object.entries(codes).map(([code, count]) => `${code} x${count}`).join(", ")}`);
}

/** The command: `js-to-ts [directory] [--exclude <path>]... [--dry-run] [--json]`. Returns the exit code instead of exiting, so a test can run it. */
export function main(argv: string[], output: Output = console): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    output.error(`js-to-ts: ${args}`);
    return EXIT.unusable;
  }
  let report: Report;
  try {
    report = convert(args);
  } catch (cause) {
    output.error(`js-to-ts: cannot convert ${args.root}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT.unusable;
  }
  if (args.json) output.log(JSON.stringify(report, null, 2));
  else printReport(report, output);
  return report.residue.length === 0 ? EXIT.ok : EXIT.residue;
}

// Run as the `js-to-ts` bin (a symlink in node_modules/.bin, so both sides are resolved); importing the module runs nothing.
const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
