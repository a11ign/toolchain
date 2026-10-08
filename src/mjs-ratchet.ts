/**
 * THE COUNT OF `.js`/`.mjs`/`.cjs` SOURCE FILES IN A REPOSITORY MAY ONLY GO DOWN (ADR 0043; a11ign/a11ign#4243).
 *
 * The standard is TypeScript source everywhere, and `.mjs` only as build output. The standard once read "converted when touched or
 * moved" and nothing checked it: 46 new `.mjs` files landed in three days. This is the check. A repository adopts it with one test its
 * existing `test` command already runs, so no workflow file is touched:
 *
 *   const result = checkMjsRatchet({ from: fileURLToPath(import.meta.url) });
 *   assert.ok(result.ok, result.message);
 *
 * THE BASELINE IS A LIST OF BASENAMES, NOT PATHS (`mjs-ratchet.baseline.json`, `files`). A layout flatten moves a file with `git mv` and
 * must not edit the baseline, so what is recorded is the multiset of names: a basename absent from the list, or present more often than
 * listed, fails and names the file. A DROP PASSES and says the baseline can be lowered, because a check that also failed on a shrink would
 * turn two honest conversions merged together red. `writeLoweredBaseline` is the lowering, and it refuses to write a baseline that is
 * higher than the one on disk, so it cannot launder a new file.
 *
 * THE END STATE IS ZERO WITH NO STANDING ALLOWANCE: an empty `files` list fails on ANY file of these kinds. The one measured exception
 * is a file whose tool reads only that name (`.pnpmfile.cjs`: pnpm looks for nothing else). It is listed in `exceptions` as
 * `{ path, why }`; an entry without a `why` fails, and so does an entry naming a path the tree no longer holds, so a deleted exception
 * cannot be silently re-added later under the same name.
 *
 * WHERE THE FILES COME FROM. In a git working tree: `git ls-files` (tracked, plus untracked-and-not-ignored, so a new file is caught
 * before `git add`). With no `.git` (agent-org's gate lays a copy under a project): a walk of the directory with the same exclusions.
 * A tree with no file in it, bar the baseline, is RED and never a pass: a walk that read nothing would otherwise report "zero".
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const BASELINE_FILE = "mjs-ratchet.baseline.json";
/** A path with one of these as a DIRECTORY segment is build output. Exact names: `dist-src` and `builds` are source. */
export const BUILD_OUTPUT_SEGMENTS = ["dist", "build", "node_modules", "generated"] as const;
export const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

/** The rule, as one constant: the check prints it whenever it fails, so a reader sees it where it bites. */
export const BUILD_OUTPUT_DEFINITION =
  `A tracked file ending ${SOURCE_EXTENSIONS.join(", ")} is SOURCE unless one of its directory segments is exactly ` +
  `${BUILD_OUTPUT_SEGMENTS.join(", ")}. Tests count (a .test.mjs is source); a .d.ts is not a .js. The baseline (${BASELINE_FILE}) lists ` +
  "file BASENAMES, so a move does not edit it: a basename absent from it, or present more often than listed, fails. A drop passes. " +
  "Write new source as .ts.";

export type RatchetException = { path: string; why: string };
export type Baseline = { files: string[]; exceptions: RatchetException[] };
export type RatchetResult = {
  ok: boolean;
  /** The sentence to hand an assertion: on failure it names each problem and ends with `BUILD_OUTPUT_DEFINITION`. */
  message: string;
  root: string;
  /** Counted source files now (exceptions excluded), and the number the baseline allows. */
  count: number;
  baselineCount: number;
};

/** Only DIRECTORY segments decide (a path's last segment is the file, and `dist.mjs` is not `dist/`). */
export function isBuildOutput(path: string): boolean {
  const directories = path.split("/").slice(0, -1);
  return directories.some((segment) => (BUILD_OUTPUT_SEGMENTS as readonly string[]).includes(segment));
}

export function isScriptSource(path: string): boolean {
  return !isBuildOutput(path) && SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The baseline's directory: the nearest ancestor of `from` (a file or a directory) holding the baseline file. Throws when there is none. */
export function findBaselineRoot(from: string): string {
  const start = resolve(from);
  for (let dir = statSync(start).isDirectory() ? start : dirname(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, BASELINE_FILE))) return dir;
    // A repository that has no baseline stops the climb: the parent's baseline is not this repository's.
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) {
      throw new Error(`mjs-ratchet: no ${BASELINE_FILE} from ${start} up to ${dir}; commit one at the repository root (writeLoweredBaseline writes it)`);
    }
  }
}

const GIT_LOCATORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

/** `git ls-files` run in `root`, with the variables a git hook exports removed: they would point it at another repository. */
function listWithGit(root: string): string[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_LOCATORS.includes(key)));
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    env, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"],
  });
  const listed = out.split("\0").filter(Boolean);
  // A tracked file deleted from disk and not yet staged is still in `--cached`; a gitlink (submodule) is a directory.
  return listed.filter((path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() === false);
}

/** The files under `dir` (posix, relative to `root`), not descending into build output or `.git`. */
function walk(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (!entry.isDirectory()) return [path];
    const skipped = entry.name === ".git" || (BUILD_OUTPUT_SEGMENTS as readonly string[]).includes(entry.name);
    return skipped ? [] : walk(root, path);
  });
}

/** Every file of the tree outside build output, posix-relative to `root`. */
function treeFiles(root: string): string[] {
  const all = existsSync(join(root, ".git")) ? listWithGit(root) : walk(root, "");
  return all.map((path) => path.split("\\").join("/")).filter((path) => !isBuildOutput(path));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function filesProblems(files: unknown): string[] {
  if (!Array.isArray(files) || files.some((entry) => typeof entry !== "string")) return ["`files` must be a list of basenames"];
  return files.filter((entry: string) => entry === "" || /[\\/]/.test(entry))
    .map((entry) => `\`files\` holds "${entry}": it lists BASENAMES, never paths, so that a move does not edit it`);
}

function exceptionProblem(entry: unknown): string | undefined {
  if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === "") return "an `exceptions` entry has no `path`";
  if (typeof entry.why !== "string" || entry.why.trim() === "") return `exception \`${entry.path}\` has no \`why\`: an exception is a named, reasoned allowance, or it is nothing`;
  return undefined;
}

function exceptionsProblems(exceptions: unknown): string[] {
  if (!Array.isArray(exceptions)) return ["`exceptions` must be a list of { path, why }"];
  return exceptions.map(exceptionProblem).filter((problem): problem is string => problem !== undefined);
}

/** The baseline in `text`, with what is wrong with it. A malformed one reads as an empty baseline, which only ever makes the check stricter. */
export function parseBaseline(text: string): { baseline: Baseline; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { baseline: { files: [], exceptions: [] }, problems: [`${BASELINE_FILE} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  if (!isRecord(raw)) return { baseline: { files: [], exceptions: [] }, problems: [`${BASELINE_FILE} must be an object with \`files\` (and \`exceptions\`)`] };
  const problems = [...filesProblems(raw.files), ...(raw.exceptions === undefined ? [] : exceptionsProblems(raw.exceptions))];
  const usable = problems.length === 0;
  return {
    baseline: { files: usable ? (raw.files as string[]) : [], exceptions: usable ? ((raw.exceptions ?? []) as RatchetException[]) : [] },
    problems,
  };
}

function tally(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

type Reading = { root: string; baseline: Baseline; malformed: string[]; empty: boolean; current: string[]; stale: string[] };

function readRatchet(root: string): Reading {
  const { baseline, problems } = parseBaseline(readFileSync(join(root, BASELINE_FILE), "utf8"));
  const files = treeFiles(root).filter((path) => path !== BASELINE_FILE);
  const sources = files.filter(isScriptSource);
  const exempt = new Set(baseline.exceptions.map((entry) => entry.path));
  return {
    root, baseline, malformed: problems, empty: files.length === 0,
    current: sources.filter((path) => !exempt.has(path)),
    stale: [...exempt].filter((path) => !sources.includes(path)),
  };
}

/** One sentence per basename the tree holds more often than the baseline lists it, naming the paths that carry it. */
function growthProblems({ current, baseline }: Reading): string[] {
  const allowed = tally(baseline.files);
  return [...tally(current.map((path) => basename(path)))]
    .filter(([name, seen]) => seen > (allowed.get(name) ?? 0))
    .map(([name, seen]) => {
      const paths = current.filter((path) => basename(path) === name).join(", ");
      const listed = allowed.get(name) ?? 0;
      return listed === 0
        ? `a new \`${name}\` file is not in the baseline: ${paths}`
        : `\`${name}\` is in the baseline ${listed} time${listed === 1 ? "" : "s"} and the tree holds ${seen}: ${paths}`;
    });
}

function problemsOf(reading: Reading): string[] {
  return [
    ...(reading.empty ? [`the tree under ${reading.root} holds no file besides ${BASELINE_FILE}: the read found nothing, which is not a count of zero`] : []),
    ...reading.malformed,
    ...growthProblems(reading),
    ...reading.stale.map((path) => `exception \`${path}\` names a file the tree no longer holds: remove the entry (writeLoweredBaseline does), or the path stays allowed for whoever adds it back`),
  ];
}

function passMessage({ current, baseline }: Reading): string {
  const exceptions = baseline.exceptions.length === 0 ? "" : ` (plus ${baseline.exceptions.length} reasoned exception${baseline.exceptions.length === 1 ? "" : "s"})`;
  const base = `mjs-ratchet: ${current.length} ${SOURCE_EXTENSIONS.join("/")} source files${exceptions} against a baseline of ${baseline.files.length}`;
  return current.length < baseline.files.length
    ? `${base}: the baseline can be lowered to ${current.length} (writeLoweredBaseline)`
    : `${base}, equal to the baseline`;
}

/** Judge the tree that holds the baseline `from` finds. Never throws on a bad tree: only on a missing baseline, which is a setup error. */
export function checkMjsRatchet({ from }: { from: string }): RatchetResult {
  const reading = readRatchet(findBaselineRoot(from));
  const problems = problemsOf(reading);
  const shared = { root: reading.root, count: reading.current.length, baselineCount: reading.baseline.files.length };
  if (problems.length === 0) return { ok: true, message: passMessage(reading), ...shared };
  const lines = problems.map((problem) => `  - ${problem}`).join("\n");
  return { ok: false, message: `mjs-ratchet: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n${lines}\n${BUILD_OUTPUT_DEFINITION}`, ...shared };
}

/**
 * Rewrite the baseline to what the tree holds now: the basenames of today's counted files, sorted, and the exceptions that still name a file.
 * REFUSES (throws) when the tree holds more than the baseline lists, or the baseline is malformed or the tree is empty: lowering is for a
 * drop, and a raise is a hand edit a reviewer sees. Returns how many basenames the baseline held before and holds now.
 */
export function writeLoweredBaseline({ from }: { from: string }): { path: string; before: number; after: number } {
  const reading = readRatchet(findBaselineRoot(from));
  const refusals = [...(reading.empty ? problemsOf(reading).slice(0, 1) : []), ...reading.malformed, ...growthProblems(reading)];
  if (refusals.length > 0) throw new Error(`mjs-ratchet: not lowering, the tree does not sit below the baseline:\n${refusals.map((line) => `  - ${line}`).join("\n")}`);
  const stale = new Set(reading.stale);
  const lowered: Baseline = {
    files: reading.current.map((path) => basename(path)).sort(),
    exceptions: reading.baseline.exceptions.filter((entry) => !stale.has(entry.path)),
  };
  const path = join(reading.root, BASELINE_FILE);
  writeFileSync(path, `${JSON.stringify(lowered, null, 2)}\n`);
  return { path, before: reading.baseline.files.length, after: lowered.files.length };
}
