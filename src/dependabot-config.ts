#!/usr/bin/env node
/**
 * THE ONE DEPENDABOT CONFIGURATION: EVERY REPOSITORY'S `.github/dependabot.yml` IS WRITTEN BY THIS, AND CHECKED AGAINST IT (A11-253, under A11-251).
 *
 * Dependency updates flow like CI: grouped, scheduled, merged when green. That needs every repository to ask Dependabot for the same things,
 * and a hand-written file per repository did not (daily and ungrouped in nine, weekly with three packages in one, none in two). So the file is
 * an OUTPUT. `dependabot-config --write` makes it from the tree it is pointed at, and `dependabot-config --check` fails when the committed file
 * is not exactly that output: a hand edit, a package added to the workspace, a new toolchain template.
 *
 * WHAT EVERY ECOSYSTEM GETS (and a repository cannot change):
 *   - weekly, Monday 05:23 UTC. One fixed time; off the hour, because on the hour is when every scheduled job on GitHub queues.
 *   - one group, `<ecosystem>-minor-and-patch`, matching every package with `update-types` minor and patch. A major matches no group, so
 *     Dependabot opens it as its own pull request.
 *   - `commit-message.prefix: deps`: the handle the org's gate recognises a dependency pull request by.
 *   - `cooldown.default-days: 7`: a release is a week old before it is proposed, which matters now that the merge needs no person.
 *   - `open-pull-requests-limit: 10`, so majors held apart do not starve the group.
 *   - NO `labels:`. Dependabot then applies `dependencies` and the ecosystem's label (`javascript`, `github_actions`, `python`) and creates
 *     them; a custom label that does not exist in a repository is silently dropped.
 *
 * THE ECOSYSTEMS ARE READ FROM THE TREE: `npm` at `/` when a root `package.json` exists, `pip` for each directory holding a
 * `requirements*.txt` or a `pyproject.toml`, `github-actions` at `/` when `.github/workflows/` holds a file.
 *
 * THE npm `ignore` LIST is three things, each written with the reason above it:
 *   1. `FROZEN` (`dependabot-frozen.ts`): the packages whose versions policy freezes. In every repository.
 *   2. the workspace's own packages, and the root's: pnpm links them, and `changeset version` owns their versions.
 *   3. `.github/dependabot-extra.json`, for what a repository owns alone. Its schema refuses every other key, so no repository can opt out of the
 *      schedule, the groups or the freeze.
 *
 * THE FILE CARRIES NO TOOLCHAIN VERSION. It would change with every release of this package, and a toolchain bump is an ordinary grouped update
 * that must pass the check: the file differs only when the TEMPLATE does.
 *
 * THE SAME COMMAND WRITES AND CHECKS `.github/workflows/dependabot-auto.yml` (A11-254, `dependabot-auto.ts`): the workflow that approves a Dependabot patch,
 * minor or Actions update and queues it. `--check` also reads the two Octo STS policies it mints under (`.github/chainguard/dependabot-approve.sts.yaml` and
 * `dependabot-guard.sts.yaml`, hand-written because their subject needs the repository's id) and fails when any other workflow submits an approval.
 *
 * ONE LINE FOR A CONSUMER: `pnpm exec dependabot-config --check` (exit 0 in step, 1 drift or a missing file, 2 unreadable). `--write` makes the file.
 * `--root <dir>` points either at another directory (default: the working directory).
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLayoutTree, workspacePackageNames, type LayoutTree, type Output } from "./layout-check.ts";
import { FROZEN, type FrozenPackage } from "./dependabot-frozen.ts";
import { DEPENDABOT_AUTO_FILE, autoProblems, generateDependabotAuto, readAutoFiles } from "./dependabot-auto.ts";

export type DependabotEcosystem = "npm" | "pip" | "github-actions";

/** The tail of a group's name; A11-254 and A11-255 recognise a grouped pull request by it. */
export const DEPENDABOT_GROUP_SUFFIX = "-minor-and-patch";
/** The start of every dependency pull request's title (`deps: bump ...`); the org's gate recognises one by it. */
export const DEPENDABOT_COMMIT_PREFIX = "deps";
/** The group a repository's patch and minor updates of one ecosystem arrive in, as it appears in the pull request's title and branch. */
export const dependabotGroupName = (ecosystem: DependabotEcosystem): string => `${ecosystem}${DEPENDABOT_GROUP_SUFFIX}`;

export const DEPENDABOT_SCHEDULE = { interval: "weekly", day: "monday", time: "05:23", timezone: "Etc/UTC" } as const;
export const DEPENDABOT_COOLDOWN_DAYS = 7;
export const DEPENDABOT_PULL_REQUEST_LIMIT = 10;

export const DEPENDABOT_FILE = ".github/dependabot.yml";
export const DEPENDABOT_EXTRA_FILE = ".github/dependabot-extra.json";

const VERSIONING_STRATEGIES = ["auto", "increase", "increase-if-necessary", "lockfile-only", "widen"] as const;
export type VersioningStrategy = (typeof VERSIONING_STRATEGIES)[number];

export type ExtraIgnore = { name: string; reason: string };
/** What a repository may say about an ecosystem. Nothing else is accepted. */
export type EcosystemExtras = { ignore?: ExtraIgnore[]; directories?: string[]; "versioning-strategy"?: VersioningStrategy };
export type DependabotExtras = Partial<Record<DependabotEcosystem, EcosystemExtras>>;

/** The keys each ecosystem's extras may hold: `directories` and `versioning-strategy` are npm's, where a repository's layout differs. */
const ALLOWED_KEYS: Record<DependabotEcosystem, readonly string[]> = {
  npm: ["ignore", "directories", "versioning-strategy"],
  pip: ["ignore"],
  "github-actions": ["ignore"],
};
const ECOSYSTEMS = Object.keys(ALLOWED_KEYS) as DependabotEcosystem[];
/** An absolute directory written plainly: no `..`, no empty segment, and nothing YAML would read as a comment or a mapping. */
const DIRECTORY = /^\/(?:[\w.@-]+(?:\/[\w.@-]+)*)?$/;
const isPlainDirectory = (path: string): boolean => DIRECTORY.test(path) && !path.split("/").includes("..");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (message: string): never => {
  throw new Error(`dependabot-config: ${DEPENDABOT_EXTRA_FILE}: ${message}`);
};

function ignoreOf(value: unknown, where: string): ExtraIgnore[] {
  if (!Array.isArray(value)) return refuse(`${where} must be an array of { name, reason }`);
  return value.map((item: unknown, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(item)) return refuse(`${at} must be { name, reason }`);
    const extraKey = Object.keys(item).find((key) => key !== "name" && key !== "reason");
    if (extraKey !== undefined) return refuse(`${at} has the key "${extraKey}", which is not accepted (only name and reason)`);
    const { name, reason } = item;
    if (typeof name !== "string" || name.trim() === "") return refuse(`${at} needs a name`);
    if (typeof reason !== "string" || reason.trim() === "" || /[\r\n]/.test(reason)) return refuse(`${at} (${name}) needs a one-line reason: an ignore is a decision, and the file shows why`);
    return { name, reason: reason.trim() };
  });
}

function directoriesOf(value: unknown, where: string): string[] {
  const paths = Array.isArray(value) ? value : [];
  if (paths.length === 0 || !paths.every((path) => typeof path === "string" && isPlainDirectory(path))) {
    return refuse(`${where} must be a non-empty array of absolute directories such as "/" or "/ui"`);
  }
  return paths as string[];
}

function ecosystemExtras(ecosystem: DependabotEcosystem, value: unknown): EcosystemExtras {
  if (!isRecord(value)) return refuse(`${ecosystem} must be an object`);
  const extraKey = Object.keys(value).find((key) => !ALLOWED_KEYS[ecosystem].includes(key));
  if (extraKey !== undefined) return refuse(`${ecosystem} has the key "${extraKey}", which is not accepted (allowed: ${ALLOWED_KEYS[ecosystem].join(", ")})`);
  const extras: EcosystemExtras = {};
  if ("ignore" in value) extras.ignore = ignoreOf(value.ignore, `${ecosystem}.ignore`);
  if ("directories" in value) extras.directories = directoriesOf(value.directories, `${ecosystem}.directories`);
  if ("versioning-strategy" in value) {
    const strategy = VERSIONING_STRATEGIES.find((candidate) => candidate === value["versioning-strategy"]);
    extras["versioning-strategy"] = strategy ?? refuse(`${ecosystem}.versioning-strategy must be one of ${VERSIONING_STRATEGIES.join(", ")}`);
  }
  return extras;
}

/** The extras file's text as a validated value. Throws, naming the file and the key, on anything the schema does not list. */
export function parseExtras(text: string): DependabotExtras {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`dependabot-config: ${DEPENDABOT_EXTRA_FILE} is not JSON`, { cause });
  }
  if (!isRecord(parsed)) return refuse("must be an object keyed by ecosystem (npm, pip, github-actions)");
  const notAnEcosystem = Object.keys(parsed).find((key) => !ECOSYSTEMS.includes(key as DependabotEcosystem));
  if (notAnEcosystem !== undefined) return refuse(`has the key "${notAnEcosystem}", which is not an ecosystem (npm, pip, github-actions)`);
  return Object.fromEntries(Object.entries(parsed).map(([ecosystem, value]) => [ecosystem, ecosystemExtras(ecosystem as DependabotEcosystem, value)]));
}

type Ignored = { name: string; reason: string };
type Entry = { ecosystem: DependabotEcosystem; directories: string[]; ignore: Ignored[]; versioningStrategy?: VersioningStrategy };

const PIP_MANIFEST = /^(requirements[^/]*\.txt|pyproject\.toml)$/;
/** A directory whose Python files are test data or an environment: Dependabot has nothing to keep current there. */
const NOT_A_PROJECT = /(^|\/)([^/]*\.fixtures?|fixtures?|\.?venv)(\/|$)/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const directoryOf = (path: string): string => (path.includes("/") ? `/${path.slice(0, path.lastIndexOf("/"))}` : "/");

function pipDirectories(tree: LayoutTree): string[] {
  const manifests = Object.keys(tree).filter((path) => PIP_MANIFEST.test(path.slice(path.lastIndexOf("/") + 1)) && !NOT_A_PROJECT.test(path));
  const directories = [...new Set(manifests.map(directoryOf))].sort();
  const odd = directories.find((directory) => !isPlainDirectory(directory));
  if (odd !== undefined) throw new Error(`dependabot-config: the Python project in ${odd} has a name the generator will not write into YAML; rename the directory`);
  return directories;
}

/** The directories an ecosystem is updated in: what the repository says, else what the tree holds; empty when it holds none. */
function directoriesFor(ecosystem: DependabotEcosystem, tree: LayoutTree, extras: DependabotExtras): string[] {
  const said = extras[ecosystem]?.directories;
  if (said !== undefined) return said;
  if (ecosystem === "npm") return "package.json" in tree ? ["/"] : [];
  if (ecosystem === "pip") return pipDirectories(tree);
  return Object.keys(tree).some((path) => WORKFLOW_FILE.test(path)) ? ["/"] : [];
}

/** The first of each name, in order: the first reason a name was given is the one shown. */
function onceEach(ignored: Ignored[]): Ignored[] {
  const seen = new Set<string>();
  return ignored.filter(({ name }) => {
    const first = !seen.has(name);
    seen.add(name);
    return first;
  });
}

/** The ignore list in the order it is written: frozen, then the workspace's own (npm only: they are npm packages), then the repository's extras. */
function ignoresFor(ecosystem: DependabotEcosystem, tree: LayoutTree, extras: DependabotExtras): Ignored[] {
  const frozen: readonly FrozenPackage[] = ecosystem === "npm" ? FROZEN : [];
  const linked = ecosystem === "npm" ? workspacePackageNames(tree).map((name) => ({ name, reason: "a workspace package: pnpm links it and `changeset version` owns its version" })) : [];
  const own = extras[ecosystem]?.ignore ?? [];
  return onceEach([...frozen.map(({ name, reason }) => ({ name, reason: `FROZEN: ${reason}` })), ...linked, ...own]);
}

function entryFor(ecosystem: DependabotEcosystem, tree: LayoutTree, extras: DependabotExtras): Entry {
  return {
    ecosystem,
    directories: directoriesFor(ecosystem, tree, extras),
    ignore: ignoresFor(ecosystem, tree, extras),
    versioningStrategy: extras[ecosystem]?.["versioning-strategy"],
  };
}

const entriesOf = (tree: LayoutTree, extras: DependabotExtras): Entry[] =>
  ECOSYSTEMS.map((ecosystem) => entryFor(ecosystem, tree, extras)).filter(({ directories }) => directories.length > 0);

const HEADER = [
  "# GENERATED by `dependabot-config --write` (@a11ign/toolchain). DO NOT EDIT BY HAND: `dependabot-config --check` fails when this file differs from its output.",
  "# To change what is written, edit `.github/dependabot-extra.json` (an ignore with its reason, the npm directories, the versioning strategy) or the template in a11ign/toolchain.",
  "# Weekly, one grouped pull request per ecosystem for patch and minor updates; a major is its own pull request; the packages frozen by policy are never proposed.",
];

function renderEntry({ ecosystem, directories, ignore, versioningStrategy }: Entry): string[] {
  const where = directories.length === 1 ? [`    directory: ${directories[0]}`] : ["    directories:", ...directories.map((directory) => `      - ${directory}`)];
  const ignored = ignore.flatMap(({ name, reason }) => [`      # ${reason}`, `      - dependency-name: ${JSON.stringify(name)}`]);
  return [
    `  - package-ecosystem: ${ecosystem}`,
    ...where,
    "    schedule:",
    ...Object.entries(DEPENDABOT_SCHEDULE).map(([key, value]) => `      ${key}: ${key === "time" ? JSON.stringify(value) : value}`),
    "    groups:",
    `      ${dependabotGroupName(ecosystem)}:`,
    '        patterns: ["*"]',
    "        update-types: [minor, patch]",
    "    commit-message:",
    `      prefix: ${DEPENDABOT_COMMIT_PREFIX}`,
    "    cooldown:",
    `      default-days: ${DEPENDABOT_COOLDOWN_DAYS}`,
    `    open-pull-requests-limit: ${DEPENDABOT_PULL_REQUEST_LIMIT}`,
    ...(versioningStrategy === undefined ? [] : [`    versioning-strategy: ${versioningStrategy}`]),
    ...(ignored.length === 0 ? [] : ["    ignore:", ...ignored]),
  ];
}

/** The tree's text for `.github/dependabot-extra.json`, validated; no file is no extras. */
function extrasOf(tree: LayoutTree): DependabotExtras {
  return DEPENDABOT_EXTRA_FILE in tree ? parseExtras(tree[DEPENDABOT_EXTRA_FILE]) : {};
}

/**
 * The file a tree's repository should hold. The tree is a map of `{ path: text }` (text of `package.json`, `pnpm-workspace.yaml` and the extras
 * file only), so a case is a listing and needs no checkout. An empty tree throws: a file generated from nothing would read as a repository with
 * no dependencies. So does a tree with no ecosystem at all, for the same reason.
 */
export function generateDependabotConfig(tree: LayoutTree): string {
  if (Object.keys(tree).length === 0) throw new Error("dependabot-config: the tree holds no file, so no configuration was generated");
  const entries = entriesOf(tree, extrasOf(tree));
  if (entries.length === 0) throw new Error("dependabot-config: the tree holds no npm, pip or github-actions project, so there is nothing to update");
  return [...HEADER, "version: 2", "updates:", ...entries.flatMap(renderEntry)].join("\n") + "\n";
}

const readTree = (root: string): LayoutTree => readLayoutTree(root, ["dependabot-extra.json"]);

/** The file `--write` would make for the repository at `root`. */
export const generateFor = (root: string): string => generateDependabotConfig(readTree(root));

function writeGenerated(root: string, file: string, text: string): string {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Writes `<root>/.github/dependabot.yml` and `<root>/.github/workflows/dependabot-auto.yml`; returns the first's path. */
export function writeDependabotConfig({ root }: { root: string }): string {
  // Generated before anything is written: the workflow is a file of the tree, and a tree that was empty is not one once it holds it.
  const config = generateFor(root);
  writeGenerated(root, DEPENDABOT_AUTO_FILE, generateDependabotAuto());
  return writeGenerated(root, DEPENDABOT_FILE, config);
}

/** `common[i][j]`: how many lines the tails `a[i..]` and `b[j..]` have in common, in order. */
function commonTails(a: string[], b: string[]): number[][] {
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  return common;
}

/** A line diff, `-` for what is committed and `+` for what the generator writes; unchanged lines are context. Both sides are short files. */
export function lineDiff(committed: string, generated: string): string[] {
  const a = committed.split("\n");
  const b = generated.split("\n");
  const common = commonTails(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  return out;
}

const writeCommand = (root: string): string => (root === process.cwd() ? "dependabot-config --write" : `dependabot-config --write --root ${root}`);

export type DependabotCheck = { ok: boolean; message: string };

/** The drift of one generated file: `undefined` when the committed text is the generated one, else the diff and the command that fixes it. */
function driftOf({ root, file, generated }: { root: string; file: string; generated: string }): string | undefined {
  const path = join(root, file);
  const committed = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (committed === generated) return undefined;
  const fix = `run \`${writeCommand(root)}\` (\`pnpm exec dependabot-config --write\` in the repository) and commit ${file}`;
  const shown = committed === undefined ? `${file} does not exist; it should be:\n${generated}` : lineDiff(committed, generated).filter((line) => !line.startsWith("  ")).join("\n");
  return `dependabot-config: FAIL ${file} drifted from the template (- committed, + generated):\n${shown}\ndependabot-config: ${fix}`;
}

/** What is wrong with the approval's policies and the other workflows, one line each; they are hand-written, so there is no `--write` for them. */
const approvalFailures = (root: string): string[] =>
  autoProblems(readAutoFiles(root)).map(({ file, message }) => `dependabot-config: FAIL ${file}: ${message}`);

/**
 * Whether the committed files are exactly the generated ones (`dependabot.yml` and `dependabot-auto.yml`; a missing file is drift), and whether the
 * approval's policies bind what they must. `message` is every diff, the command that fixes it, and every policy field that is wrong.
 */
export function checkDependabotConfig({ root }: { root: string }): DependabotCheck {
  const drift = [
    driftOf({ root, file: DEPENDABOT_FILE, generated: generateFor(root) }),
    driftOf({ root, file: DEPENDABOT_AUTO_FILE, generated: generateDependabotAuto() }),
  ].filter((message): message is string => message !== undefined);
  const failures = [...drift, ...approvalFailures(root)];
  if (failures.length === 0) return { ok: true, message: `dependabot-config: ok (${DEPENDABOT_FILE} and ${DEPENDABOT_AUTO_FILE} are what --write produces; the approval's policies bind dependabot[bot])` };
  return { ok: false, message: failures.join("\n") };
}

const EXIT = { ok: 0, drift: 1, unreadable: 2 } as const;
const USAGE = "usage: dependabot-config (--write | --check) [--root <dir>]";
type Options = { mode: "write" | "check"; root: string };

function parseArgs(argv: string[]): Options {
  let mode: Options["mode"] | undefined;
  let root = process.cwd();
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--write" || arg === "--check") mode = arg === "--write" ? "write" : "check";
    else if (arg === "--root") root = rest.shift() ?? "";
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else throw new Error(`unknown argument ${arg} (${USAGE})`);
  }
  if (mode === undefined) throw new Error(`say --write or --check (${USAGE})`);
  if (root === "") throw new Error(`--root needs a directory (${USAGE})`);
  return { mode, root };
}

/** Our own refusals already say `dependabot-config:`; a failure from the disk does not. */
function failureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith("dependabot-config:") ? message : `dependabot-config: ${message}`;
}

/** The command. Returns the exit code instead of exiting, so a test can run it. */
export function main(argv: string[], output: Output = console): number {
  try {
    const { mode, root } = parseArgs(argv);
    if (mode === "write") {
      output.log(`dependabot-config: wrote ${writeDependabotConfig({ root })} and ${join(root, DEPENDABOT_AUTO_FILE)}`);
      return EXIT.ok;
    }
    const result = checkDependabotConfig({ root });
    (result.ok ? output.log : output.error)(result.message);
    return result.ok ? EXIT.ok : EXIT.drift;
  } catch (cause) {
    output.error(failureMessage(cause));
    return EXIT.unreadable;
  }
}

// Run as the `dependabot-config` bin (a symlink in node_modules/.bin, so both sides are resolved); importing the module runs nothing.
const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
