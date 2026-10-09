#!/usr/bin/env node
// @ts-check
// A TREE-WALKING GUARD DECLARES THE SUBTREE IT WALKS, AND ITS OWN RUN PROVES IT -- #929.
//
// `select-changed-tests.mjs`'s `alwaysRunTests` runs every guard whose population is discovered from the tree,
// on every pull request, because *"a file added anywhere can join the population of a guard living anywhere
// else"*. That is right for a guard whose population IS the repository. Measured by running all 131 of them
// under this module's observer: 38 walk the whole repository and 69 read inside a product package -- but 24
// read nothing a product diff can touch, and 6 of those nothing outside their own imports at all. Five of the
// 6 transitively import `agent-org/src/ready-label-audit.mjs`, whose `run("git", ["for-each-ref", ...])` the static
// predicate reads as a walk; the tests never take that path. A first observer that saw only the sync `fs`
// calls and argv `git` counted 17 / 83 / 31: child processes and root listings, which it could not see, are
// the difference.
//
// So a guard may DECLARE its scope -- `export const WALK_SCOPE = ["docs"];` -- and the selector drops it from
// the always-run set on a diff that touches none of it. Undeclared means unbounded: nothing changes for a
// guard that says nothing, because the failure mode of getting this wrong is a guard that silently stops
// running.
//
// THE DECLARATION IS CHECKED BY THE GUARD'S OWN RUN, never trusted. A static check could only have verified
// the 18 walks that pass literal roots to `walkTree`; 70 of the 131 walk with `readdirSync`/`globSync` over
// computed paths. So importing this module starts recording every path the process reads, and
// `declareWalkScope` fails the guard's own test file if anything it read lies outside what it declared. The
// check runs exactly when the guard runs -- selected precisely because its code changed, or because its
// declared scope was touched -- and costs no extra process.
//
// IMPORT THIS FIRST in a declaring guard. ES module bodies evaluate in import order, so a read made by a
// module imported ABOVE this one happens before the observer is installed and is not seen.
// `declared-walk-scope.test.ts` pins the ordering.
import { createRequire, syncBuiltinESMExports } from "node:module";
// ESM, deliberately (#1349): the check registers with the runner that is RUNNING. Under rstest the resolve hook
// redirects an ESM `node:test` to rstest's hooks, and does not redirect `require` -- measured, an `after` from
// `require("node:test")` never fired under rstest, so every declarer passed with its check never run.
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// The declaration's parser lives apart, so the selector can read declarations without installing this.
import { inScope, parseWalkScope } from "./walk-scope-declaration.ts";
import { sandboxGitEnv } from "./git-env.ts";

export { inScope, parseWalkScope };

const require = createRequire(import.meta.url);
// `require`, not `import`, so these are the mutable CommonJS exports objects: `wrap` replaces functions on them
// by NAME, and an ES module namespace cannot be assigned to.
const fs: typeof import("node:fs") = require("node:fs");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const workerThreads: { Worker: typeof import("node:worker_threads").Worker } = require("node:worker_threads");
const nodeTest: typeof import("node:test") = require("node:test");
const moduleApi: typeof import("node:module") = require("node:module");

// REAL, because every comparison below is against a real path: on macOS `/tmp` is a link to `/private/tmp`.
export const REPO_ROOT = fs.realpathSync.native(resolve(fileURLToPath(new URL("../../", import.meta.url))));

/** A read that cannot be bounded to a subtree -- a whole-repository walk. Never inside any declared scope. */
export const WHOLE_REPOSITORY = "(the whole repository)";


// ---------------------------------------------------------------------------------------------------------
// THE OBSERVER -- installed on import, so it sees every read after this module evaluates.
//
// A DECLARATION IS ONLY AS GOOD AS WHAT THIS SEES, and an unseen read is a false pass: the exact defect the
// check exists to catch. So every route to the tree is either recorded or FAILS CLOSED.
//   - `fs`: every function on `fs` and `fs.promises` (the same object as `node:fs/promises`) is wrapped, or
//     is on `NOT_WRAPPED` with the reason it cannot read a path unseen -- and `declared-walk-scope.test.ts`
//     enumerates both objects and fails on any function that is neither, so a route nobody thought of, or
//     one a later Node adds, fails a test instead of passing a guard. The first version listed its wrappers
//     by hand and missed `copyFile` and `openAsBlob` -- the `routeChange` lesson, again.
//   - A PATH THROUGH A LINK is classified by where it leads: `node_modules/@a11ign/judge` is `packages/judge`,
//     and on macOS `/tmp/...` is `/private/tmp/...`. Anything inside the git directories -- `.git`, or in a
//     worktree the directory `.git` names -- is the whole repository.
//   - `git` with an argv: `ls-files`, and `grep` after `--`, are bounded by their pathspecs, but only when
//     every option is one known to bound nothing away and no pathspec uses magic (`:(exclude)docs` is
//     everything EXCEPT docs). `rev-parse`, `config` and `var` read no population. Anything else is the
//     whole repository. A git run from somewhere else reads nothing here -- unless `--git-dir`,
//     `--work-tree`, a `GIT_*` variable or an operand points it back at this checkout.
//   - ANY OTHER CHILD PROCESS or WORKER THREAD -- `node`, `rg`, a shell, `git` inside a shell string, and
//     `node:test`'s `run()`, which starts its files through Node's INTERNAL spawn -- is the whole repository.
//     What it reads is invisible from here, so a guard that starts one cannot be verified, and an
//     unverifiable declaration is the one #929 exists to refuse.
//   - THE REST OF THE ALLOWLISTED SURFACE: `process.loadEnvFile`/`dlopen` and `module.findPackageJSON` read
//     through internal bindings, so they are wrapped as reads; `Module._resolveFilename` records what a
//     `require`/`require.resolve` resolved to; `process.binding`, `execve`, a loader hook, and
//     `getBuiltinModule` of anything outside `DECLARER_BUILTINS` are the whole repository. The exhaustiveness
//     test covers every function on `node:test`, `node:module`, `process` and `worker_threads` too.
//
// Not seen, and refused in every declaring guard's own import closure instead: `import()` of a computed
// path and `import.meta.resolve` (the ESM loader reads off this thread), any ESM binding of an
// `ESM_UNSYNCED` name (import or re-export), a `ReadStream` or `ChildProcess` built by hand, Node's module
// internals called directly, and any builtin outside `DECLARER_BUILTINS` (`node:sqlite` and `node:wasi`
// open paths through no `fs` call). That refusal reads the FIRST-PARTY closure: a third-party dependency is
// not scanned, and is trusted not to do these -- the five declarers' only one is `typescript`.
//
// AND ONE LIMIT OF THE METHOD ITSELF: a read set is verified on the runs where the guard runs, in the
// environment it ran in. A guard whose reads depend on an environment variable, a changed-files list or
// what `runs/` holds is verified only for what it read there.
// ---------------------------------------------------------------------------------------------------------

/**
 * ONE OBSERVER PER PROCESS, not per copy of this module (#1349). Under rstest a test file and its imports are
 * bundled, so the copy `--import` loads BEFORE the bundle and the copy inside the bundle are two instances. Only
 * the preloaded one installs before a test binds a built-in -- measured, a named `openSync`, `readdir`,
 * `spawnSync` or `fs/promises` `readFile` was unseen otherwise, while `readFileSync` was seen. So both copies
 * share this state, only the first installs, and the second reuses the first's UNWRAPPED `fs` functions: its
 * own lookups would otherwise be recorded as the guard's reads.
 */
const STATE: {
  observedReads: Set<string>; installed: boolean;
  originals?: { realpath: typeof fs.realpathSync.native; exists: typeof fs.existsSync; stat: typeof fs.statSync; readFile: typeof fs.readFileSync };
} = (globalThis as unknown as Record<symbol, typeof STATE>)[Symbol.for("a11y-witness.walk-scope")] ??= {
  observedReads: new Set(), installed: false };

/** @param {string} how */
const unbounded = (how: string) => `${WHOLE_REPOSITORY} -- ${how}`;

// Captured BEFORE `install()` wraps them, so the observer's own lookups are never counted as the guard's.
// The first copy captures them; a second copy, loaded after the wrappers exist, takes the first copy's.
STATE.originals ??= { realpath: fs.realpathSync.native, exists: fs.existsSync, stat: fs.statSync, readFile: fs.readFileSync };
const realpathOriginal = STATE.originals.realpath;
const existsOriginal = STATE.originals.exists;
const statOriginal = STATE.originals.stat;
const readFileOriginal = STATE.originals.readFile;

/** @param {string} path @param {string} dir */
const isInside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};

/** The real path of `absolute`, through its longest prefix that exists -- a file not yet created still has one. */
function realOf(/** @type {string} */ absolute: string) {
  const rest = [];
  for (let head = absolute; ; head = dirname(head)) {
    if (existsOriginal(head)) return join(realpathOriginal(head), ...rest.reverse());
    if (dirname(head) === head) return absolute;
    rest.push(basename(head));
  }
}

/**
 * This checkout's git directories: `.git`, and -- in a worktree, where `.git` is a FILE naming its gitdir --
 * that directory and the common one behind it. A worktree's index lives outside the worktree, so a check of
 * "inside REPO_ROOT" alone would call a read of it a read of somewhere else.
 */
function gitDirectoriesOf(/** @type {string} */ root: string) {
  const dotGit = join(root, ".git");
  if (!existsOriginal(dotGit)) return [dotGit]; // an exported tree: there is nothing for git to be pointed at
  const pointer = statOriginal(dotGit).isDirectory() ? null
    : /^gitdir:\s*(.+)$/m.exec(readFileOriginal(dotGit, "utf8"))?.[1]?.trim();
  const gitDir = pointer ? resolve(root, pointer) : dotGit;
  const commonFile = join(gitDir, "commondir");
  const common = existsOriginal(commonFile) ? resolve(gitDir, readFileOriginal(commonFile, "utf8").trim()) : gitDir;
  return [...new Set([dotGit, gitDir, common].map(realOf))];
}
const GIT_DIRECTORIES = gitDirectoriesOf(REPO_ROOT);

/** @param {unknown} target @param {string} base @returns {string | null} an absolute path, or null for a descriptor */
function absoluteOf(target: unknown, base: string): string | null {
  let path = target;
  // #1398: A `node:` SPECIFIER NAMES A BUILTIN MODULE, NEVER A FILE. Under `rstest --coverage`, `@rstest/core`'s
  // bundled source-map support calls `fs.existsSync` on each stack frame's file name, and a Node internal frame's
  // is `node:internal/...`: resolved against the working directory, that string landed inside the repository, and
  // all five WALK_SCOPE consumers failed on four of them. Checked before `fileURLToPath`, which throws on a `node:` URL.
  if ((typeof path === "string" && path.startsWith("node:")) || (path instanceof URL && path.protocol === "node:")) return null;
  if (path instanceof URL || (typeof path === "string" && path.startsWith("file:"))) path = fileURLToPath(path);
  if (typeof path !== "string" && !Buffer.isBuffer(path)) return null; // a file descriptor: its open was seen
  return resolve(base, String(path));
}

/**
 * A read's repo-relative path ("" is the root), a whole-repository marker, or null when it is no read of the
 * tree at all.
 * @param {unknown} target @param {string} base
 */
function repoPath(target: unknown, base: string) {
  let absolute = absoluteOf(target, base);
  if (absolute === null) return null;
  if (!isInside(absolute, REPO_ROOT) || absolute.split(sep).includes("node_modules")) absolute = realOf(absolute);
  if (GIT_DIRECTORIES.some((dir) => isInside(absolute, dir))) return unbounded("read inside the git directory");
  if (!isInside(absolute, REPO_ROOT)) return null;
  const rel = relative(REPO_ROOT, absolute);
  // What third-party `node_modules` holds is decided by `pnpm-lock.yaml`, and a change to that is a BROAD
  // diff (`ROOT_TS_FILES`), which runs every guard before any narrowing -- so no narrowed run can differ in it.
  // `declared-walk-scope.test.ts` pins that fact rather than trusting it. A workspace link is not excluded
  // here: `realOf` above has already turned `node_modules/@a11ign/judge` into `packages/judge`.
  if (rel.split(sep).includes("node_modules")) return null;
  // `runs/` is gitignored, so nothing under it can ever be a changed file -- it cannot select or deselect a
  // guard. Counted, a guard that reads the corpus when one happens to exist would fail its own check on a
  // laptop that has a corpus and pass it in CI, which has none: a verdict that depends on the machine.
  if (rel === "runs" || rel.startsWith(`runs${sep}`)) return null;
  return rel;
}

/** @param {unknown} cwd @returns {string} */
const baseOf = (cwd: unknown): string => resolve(process.cwd(),
  cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === "string" ? cwd : ".");

/** A path the process opened, statted, copied or tested. The root itself is no population. */
function recordRead(/** @type {unknown} */ target: unknown, base = process.cwd()) {
  const path = repoPath(target, base);
  if (path) STATE.observedReads.add(path);
}

/** A directory the process LISTED. Listing the root is walking the whole repository. */
function recordListing(/** @type {unknown} */ target: unknown, base = process.cwd()) {
  const path = repoPath(target, base);
  if (path !== null) STATE.observedReads.add(path === "" ? unbounded("listed the repository root") : path);
}

const GLOB_SYNTAX = /[*?[\]{}()!]/;

/** A glob lists from its static prefix: `packages/{a,b}/src/**` walks `packages`. */
function recordGlob(/** @type {unknown} */ pattern: unknown, /** @type {{ cwd?: unknown } | undefined} */ options: { cwd?: unknown; } | undefined) {
  for (const each of [pattern].flat()) {
    const segments = String(each).split("/");
    const firstGlob = segments.findIndex((segment) => GLOB_SYNTAX.test(segment));
    recordListing(firstGlob === -1 ? String(each) : segments.slice(0, firstGlob).join("/"), baseOf(options?.cwd));
  }
}

// `git`'s own options that take a value in the NEXT argument. Unskipped, `git -c core.quotepath=off ls-files
// scripts` reads its subcommand as `core.quotepath=off` -- unknown, so the whole repository. That fails closed,
// but it fails a declaration that was right; skipping the value is what lets the pathspec bound it.
const GIT_OPTION_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const POPULATION_FREE_GIT = new Set(["rev-parse", "config", "var", "version", "check-ref-format"]);

/**
 * Where `git` runs, what else it was pointed at, and what it was asked -- past its own options, in both
 * their spellings (`--git-dir <path>` and `--git-dir=<path>`).
 * @param {string[]} argv @param {string} base
 */
function gitInvocation(argv: string[], base: string) {
  let where = base;
  /** @type {string[]} */
  const redirects: string[] = [];
  let at = 0;
  for (; at < argv.length && argv[at].startsWith("-"); at += 1) {
    const equals = argv[at].indexOf("=");
    const flag = equals === -1 ? argv[at] : argv[at].slice(0, equals);
    const takesNext = equals === -1 && GIT_OPTION_WITH_VALUE.has(flag);
    const value = equals === -1 ? (takesNext ? argv[at + 1] ?? "" : "") : argv[at].slice(equals + 1);
    if (flag === "-C") where = resolve(where, value);
    if (flag === "--git-dir" || flag === "--work-tree") redirects.push(value);
    if (takesNext) at += 1;
  }
  return { where, redirects, subcommand: argv[at], rest: argv.slice(at + 1) };
}

/** Does `value`, read as a path from `where`, name this checkout or its git directories? */
function pointsHere(/** @type {string} */ value: string, /** @type {string} */ where: string) {
  if (value === "") return false;
  const path = /^file:\/\//.test(value) && URL.canParse(value) ? fileURLToPath(value) : value;
  const absolute = realOf(resolve(where, path));
  return isInside(absolute, REPO_ROOT) || GIT_DIRECTORIES.some((dir) => isInside(absolute, dir));
}

/**
 * A git run from OUTSIDE this checkout that is pointed back at it anyway: by `--git-dir`/`--work-tree`, by a
 * `GIT_*` variable in the environment it runs with -- git exports `GIT_DIR` into every hook, per
 * `packages/guards/src/git-env.ts` -- or by an operand, as a clone source is.
 * @param {{ where: string, redirects: string[], rest: string[] }} git @param {{ env?: unknown } | undefined} options
 */
function pointedBackHere({ where, redirects, rest }: { where: string; redirects: string[]; rest: string[]; }, options: { env?: unknown; } | undefined) {
  const env = /** @type {Record<string, unknown>} */ (options?.env ?? process.env);
  const fromEnv = Object.entries(env)
    .filter(([key, value]) => key.startsWith("GIT_") && typeof value === "string")
    .flatMap(([, value]) => String(value).split(delimiter));
  const operands = rest.filter((arg) => !arg.startsWith("-"));
  return [...redirects, ...fromEnv, ...operands].some((value) => pointsHere(value, where));
}

// The options that change WHICH files `ls-files` or `grep` reads are the ones that take a pattern or a file
// (`-x`, `--exclude-from`, `--with-tree`, `-f`) or reach outside the path (`--exclude-standard` reads the root
// `.gitignore`, `--no-index` the filesystem). Rather than list those -- a list of the dangerous is the list
// that misses one -- this lists what is known to bound nothing away, and anything else is the whole repository.
const BOUNDED_OPTIONS = {
  "ls-files": {
    flags: new Set(["--cached", "--stage", "--full-name", "--deduplicate", "--error-unmatch", "--eol", "--debug",
      "--sparse", "--others", "--modified", "--deleted", "--unmerged", "--killed", "--directory",
      "--no-empty-directory", "--resolve-undo"]),
    short: "zcstvfomduk",
    inline: ["--format=", "--abbrev"],
    valued: new Set<string>(),
  },
  grep: {
    flags: new Set(["--cached", "--name-only", "--files-with-matches", "--files-without-match", "--count",
      "--ignore-case", "--word-regexp", "--invert-match", "--extended-regexp", "--fixed-strings", "--perl-regexp",
      "--basic-regexp", "--quiet", "--null", "--full-name", "--line-number", "--column", "--no-color", "--heading",
      "--break", "--only-matching", "--all-match", "--and", "--or", "--not", "--text"]),
    short: "lLnciwvEFPGqzhHIoa",
    inline: ["--max-count=", "--max-depth=", "--context=", "--after-context=", "--before-context=", "--threads="],
    // Their values are a pattern or a number, never a path.
    valued: new Set(["-e", "-m", "--max-count", "-A", "-B", "-C", "--after-context", "--before-context",
      "--context", "--max-depth", "--threads"]),
  },
};

/** @param {typeof BOUNDED_OPTIONS["grep"]} known @param {string} option */
const boundsNothingAway = (known: typeof BOUNDED_OPTIONS["grep"], option: string) => known.flags.has(option)
  || known.inline.some((prefix) => option.startsWith(prefix))
  || (/^-[A-Za-z]+$/.test(option) && [...option.slice(1)].every((letter) => known.short.includes(letter)));

/**
 * The pathspecs a tree-reading subcommand was bounded to, or null when nothing trustworthy bounds it.
 *
 * `ls-files` takes pathspecs anywhere; `grep`'s first operand is its PATTERN, so only what follows `--` is a
 * path. Recorded by operand position, `git grep scripts` -- the word, searched for everywhere -- read as a
 * walk of `scripts/` and passed a declaration of it.
 * @param {string} subcommand @param {string[]} rest
 * @returns {string[] | null}
 */
function gitPathspecs(subcommand: string, rest: string[]): string[] | null {
  if (subcommand !== "ls-files" && subcommand !== "grep") return null;
  const known = BOUNDED_OPTIONS[subcommand];
  const dashes = rest.indexOf("--");
  const before = dashes === -1 ? rest : rest.slice(0, dashes);
  const operands = [];
  for (let at = 0; at < before.length; at += 1) {
    if (!before[at].startsWith("-")) operands.push(before[at]);
    else if (known.valued.has(before[at])) at += 1;
    else if (!boundsNothingAway(known, before[at])) return null;
  }
  const after = dashes === -1 ? [] : rest.slice(dashes + 1);
  const pathspecs = subcommand === "ls-files" ? [...operands, ...after] : dashes === -1 ? null : after;
  // MAGIC names a set the path does not: `:(exclude)docs` and `:!docs` are everything EXCEPT docs.
  return pathspecs && !pathspecs.some((spec) => spec.startsWith(":")) ? pathspecs : null;
}

/** @param {unknown[]} args @param {{ cwd?: unknown, env?: unknown } | undefined} options */
function recordGit(args: unknown[], options: { cwd?: unknown; env?: unknown; } | undefined) {
  const git = gitInvocation(args.map(String), baseOf(options?.cwd));
  if (repoPath(git.where, git.where) === null) {
    // Run somewhere else -- a fixture repository in a temp directory -- it reads nothing here, unless
    // something points it back.
    if (pointedBackHere(git, options)) STATE.observedReads.add(unbounded(`git ${git.subcommand}, pointed back at this checkout`));
    return;
  }
  if (git.subcommand === undefined || POPULATION_FREE_GIT.has(git.subcommand)) return;
  const pathspecs = gitPathspecs(git.subcommand, git.rest);
  if (pathspecs === null) { STATE.observedReads.add(unbounded(`git ${git.subcommand}`)); return; }
  if (pathspecs.length === 0) recordListing(".", git.where);
  for (const spec of pathspecs) recordGlob(spec, { cwd: git.where });
}

// A command line only a shell can read: `git ls-files | wc -l` is two processes, and which paths the second
// touches is not in the string.
const SHELL_SYNTAX = /[|&;<>()$`\\"'*?[\]{}~!#\n]/;

/** @param {unknown} command @param {{ cwd?: unknown, env?: unknown } | undefined} options */
function recordCommandLine(command: unknown, options: { cwd?: unknown; env?: unknown; } | undefined) {
  const line = String(command).trim();
  if (/^git\s/.test(line) && !SHELL_SYNTAX.test(line)) recordGit(line.split(/\s+/).slice(1), options);
  else STATE.observedReads.add(unbounded(`a shell ran \`${line.slice(0, 60)}\``));
}

/** @param {unknown} file @param {unknown[]} rest the arguments after `file`, in whichever overload was used */
function recordSpawn(file: unknown, rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? rest[0] : [];
  const options = rest.find((r) => r !== null && typeof r === "object" && !Array.isArray(r)) as
    { cwd?: unknown; env?: unknown; shell?: unknown } | undefined;
  if (options?.shell) recordCommandLine([file, ...args].join(" "), options);
  else if (basename(String(file)) === "git") recordGit(args, options);
  else STATE.observedReads.add(unbounded(`a child process, \`${basename(String(file))}\`, whose reads are not visible here`));
}

// REGISTERED, so a wrapper installed by one copy of this module is recognised by the other (#1349).
const OBSERVED = Symbol.for("a11y-witness.walk-scope: this function records before it calls through");

/** Is `fn` one of this module's wrappers? The exhaustiveness test asks this of every function it finds. */
export function isObserved(/** @type {unknown} */ fn: unknown) {
  return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[OBSERVED] === true;
}

/**
 * Replace `owner[name]` with a wrapper that records before it calls through -- or, given `after`, once it has
 * returned or thrown, for the calls whose answer is what was read (`_resolveFilename`, `findPackageJSON`).
 * A throw is recorded and RETHROWN, never swallowed. Own properties are carried across: `realpathSync.native`
 * is called directly, and `exists` keeps a `util.promisify.custom`.
 * @param {object} owner @param {string} name @param {(args: unknown[]) => void} record
 * @param {(args: unknown[], result: unknown) => void} [after] `result` is undefined when the call threw
 */
function wrap(owner: object, name: string, record: (args: unknown[]) => void, after?: (args: unknown[], result: unknown) => void) {
  const members = owner as Record<string, unknown>;
  const original = members[name];
  if (typeof original !== "function") return;
  const observed = function observed(/** @type {unknown[]} */ ...args: unknown[]) {
    record(args);
    if (!after) {
      // @ts-expect-error -- `this` is whatever the caller bound, passed through untouched
      return original.apply(this, args);
    }
    let result;
    try {
      // @ts-expect-error -- as above
      result = original.apply(this, args);
    } catch (error) {
      after(args, undefined);
      throw error;
    }
    after(args, result);
    return result;
  };
  for (const key of Reflect.ownKeys(original)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    Object.defineProperty(observed, key, Object.getOwnPropertyDescriptor(original, key) as PropertyDescriptor);
  }
  Object.defineProperty(observed, OBSERVED, { value: true });
  members[name] = observed;
}

// Each takes the path it reads first; `cp` walks its source, so it LISTS.
const LISTS = ["readdir", "opendir", "cp"];
const READS = ["readFile", "stat", "lstat", "access", "open", "realpath", "readlink", "exists", "statfs",
  "copyFile", "rename", "link", "watch"];

/**
 * Every function on `fs`, `fs.promises` and `child_process` that is NOT wrapped, and why it cannot read a
 * path the observer has not already seen. Keyed by name without `Sync`. `declared-walk-scope.test.ts` fails on
 * any function that is neither wrapped nor here -- which is what makes "every route" a claim a test checks.
 */
export const NOT_WRAPPED = Object.freeze({
  fs: Object.freeze({
    appendFile: "writes", writeFile: "writes", truncate: "writes", mkdir: "creates", unlink: "deletes",
    rm: "deletes", rmdir: "deletes", mkdtemp: "creates a new, empty directory",
    mkdtempDisposable: "creates a new, empty directory", symlink: "stores its target as a string, unread",
    chmod: "changes metadata", lchmod: "changes metadata", chown: "changes metadata", lchown: "changes metadata",
    utimes: "changes metadata", lutimes: "changes metadata",
    close: "a descriptor, whose `open` was recorded", read: "a descriptor, whose `open` was recorded",
    readv: "a descriptor, whose `open` was recorded", write: "a descriptor", writev: "a descriptor",
    fstat: "a descriptor, whose `open` was recorded", fsync: "a descriptor", fdatasync: "a descriptor",
    ftruncate: "a descriptor", fchmod: "a descriptor", fchown: "a descriptor", futimes: "a descriptor",
    unwatchFile: "stops a `watchFile` that was recorded", createWriteStream: "writes", WriteStream: "writes",
    FileWriteStream: "writes", Utf8Stream: "writes", Dir: "the handle `opendir` returns, which was recorded",
    Dirent: "an entry `readdir`/`opendir` returns", Stats: "a result, not a call",
    _toUnixTimestamp: "converts a time", ReadStream: "UNSEEN when constructed directly -- a subclass would "
      + "break `instanceof` for every stream `createReadStream` returns -- so refused in a declarer instead",
    FileReadStream: "the same class as `ReadStream`, under its other name",
  }),
  "child_process": Object.freeze({
    ChildProcess: "UNSEEN when constructed by hand and started with `.spawn()` -- refused in a declarer instead",
    _forkChild: "Node's own IPC setup inside a forked child; no guard calls it",
  }),
  test: Object.freeze(Object.fromEntries(["after", "afterEach", "before", "beforeEach", "describe", "it", "only",
    "skip", "suite", "test", "todo"].map((name) => [name, "registers a test or a hook; reads nothing"]))),
  module: Object.freeze({
    Module: "a module record; loading one resolves through `_resolveFilename` and reads through `fs`, both wrapped",
    SourceMap: "parses a source map it is handed", _debug: "a debug logger",
    _findPath: "Node's internal probe, called by the wrapped `_resolveFilename` -- refused in a declarer's own source",
    _initPaths: "reads `NODE_PATH` from the environment", _load: "resolves through `_resolveFilename`, which is wrapped",
    _nodeModulePaths: "computes a list of directories; reads nothing",
    _resolveLookupPaths: "computes a list of directories; reads nothing", _preloadModules: "startup only",
    runMain: "startup only", createRequire: "the `require` it returns resolves through `_resolveFilename`, which "
      + "is wrapped, and reads through the wrapped `fs`",
    enableCompileCache: "caches compiled code for modules already loaded -- no population",
    flushCompileCache: "caches compiled code for modules already loaded -- no population",
    getCompileCacheDir: "names a directory; reads nothing", findSourceMap: "an in-memory lookup",
    getSourceMapsSupport: "a setting", setSourceMapsSupport: "a setting", isBuiltin: "a name check",
    stripTypeScriptTypes: "transforms a string it is handed", syncBuiltinESMExports: "re-points bindings",
  }),
  process: Object.freeze({
    ...Object.fromEntries(["_debugEnd", "_debugProcess", "_fatalException", "_getActiveHandles",
      "_getActiveRequests", "_kill", "_rawDebug", "_startProfilerIdleNotifier", "_stopProfilerIdleNotifier",
      "_tickCallback", "abort", "assert", "availableMemory", "constrainedMemory", "cpuUsage", "cwd", "emitWarning",
      "exit", "getActiveResourcesInfo", "getegid", "geteuid", "getgid", "getgroups", "getuid",
      "hasUncaughtExceptionCaptureCallback", "hrtime", "initgroups", "kill", "memoryUsage", "nextTick",
      "openStdin", "reallyExit", "ref", "resourceUsage", "setSourceMapsEnabled",
      "setUncaughtExceptionCaptureCallback", "setegid", "seteuid", "setgid", "setgroups", "setuid",
      "threadCpuUsage", "umask", "unref", "uptime"].map((name) => [name, "takes no path"])),
    chdir: "moves where a RELATIVE path resolves from; every read is resolved against the cwd when it is made",
    emit: "an emitter's own `emit`, which a test runner installs on `process`; takes no path",
    // #1349: present only in a process FORKED with an IPC channel -- rstest's `forks` pool runs each test file so.
    ...Object.fromEntries(["send", "_send", "disconnect", "_disconnect"].map((name) => [name,
      "IPC to the parent that forked this process: passes a message, takes no path"])),
  }),
  "worker_threads": Object.freeze({
    ...Object.fromEntries(["BroadcastChannel", "MessageChannel", "MessagePort", "getEnvironmentData",
      "isMarkedAsUntransferable", "markAsUncloneable", "markAsUntransferable", "moveMessagePortToContext",
      "postMessageToThread", "receiveMessageOnPort", "setEnvironmentData"].map((name) => [name,
      "passes messages or data between threads that already exist; reads nothing"])),
  }),
});

/**
 * Wrapped functions whose ESM binding `syncBuiltinESMExports` does NOT re-point, and what covers them instead.
 * Measured, not assumed: `node:test` is outside what it syncs, so `import { run } from "node:test"` keeps the
 * original while `require("node:test").run` is wrapped. `declared-walk-scope.test.ts` checks every other
 * wrapped function's ESM binding IS the wrapper.
 */
export const ESM_UNSYNCED = Object.freeze({
  test: Object.freeze({ run: "every ESM binding that can carry it -- named or namespace import, dynamic "
    + "import, named or `*` re-export -- is refused in a declarer's own source; a default import, `require` "
    + "and `getBuiltinModule` reach the wrapper" }),
});

/**
 * The builtins a declaring guard's import closure may use, each with why. Five have a surface that can read
 * or start something, and the exhaustiveness test checks each of their functions is wrapped or in
 * `NOT_WRAPPED`; the rest take no repository path at all. Anything else -- `node:sqlite` and `node:wasi` open
 * paths through no `fs` call -- is refused by `declared-walk-scope.test.ts`.
 */
export const DECLARER_BUILTINS = Object.freeze({
  fs: "every function checked by the exhaustiveness test", "fs/promises": "the same object as `fs.promises`",
  "child_process": "every function checked by the exhaustiveness test",
  "worker_threads": "every function checked by the exhaustiveness test",
  module: "every function checked by the exhaustiveness test", test: "every function checked by the exhaustiveness test",
  process: "a global; every function checked by the exhaustiveness test",
  assert: "compares values; no path", "assert/strict": "compares values; no path",
  buffer: "bytes in memory; no path", crypto: "hashes and ciphers over bytes it is handed; no path",
  events: "emitters; no path", os: "facts about the machine, not the repository", path: "string arithmetic",
  url: "string arithmetic", util: "formatting and types; no path",
});

/** @param {string} how */
const whole = (how: string) => () => { STATE.observedReads.add(unbounded(how)); };

/** Where `findPackageJSON` walked: from its start up to the manifest it found -- all of that directory. */
function recordPackageLookup(/** @type {unknown} */ found: unknown) {
  if (typeof found === "string") recordRead(dirname(found));
  else STATE.observedReads.add(unbounded("findPackageJSON found no manifest, having walked to the root"));
}

/** What a CommonJS `require`/`require.resolve` resolved to -- or, for a relative request that failed, where it looked. */
function recordResolution(/** @type {unknown[]} */ [request, parent]: unknown[], /** @type {unknown} */ resolved: unknown) {
  if (typeof resolved === "string" && isAbsolute(resolved)) { recordRead(resolved); return; }
  const from = (parent as { filename?: unknown } | undefined)?.filename;
  if (resolved === undefined && /^\.{0,2}\//.test(String(request))) {
    recordRead(String(request), typeof from === "string" ? dirname(from) : process.cwd());
  }
}

/**
 * The allowlisted builtins' surface beyond `fs` and `child_process`: each call that starts something the
 * observer cannot see, or reads a path through an internal binding rather than through `fs`.
 */
function installBeyondFs() {
  wrap(nodeTest, "run", whole("node:test's run(), whose child processes are started by Node's internal spawn"));
  wrap(process, "loadEnvFile", ([path]) => recordRead(path ?? ".env"));
  wrap(process, "dlopen", ([, filename]) => recordRead(filename));
  wrap(process, "execve", whole("process.execve, which replaces this process"));
  for (const name of ["binding", "_linkedBinding"]) wrap(process, name, whole(`process.${name}, Node's raw internals`));
  wrap(process, "getBuiltinModule", ([id]) => {
    const name = String(id).replace(/^node:/, "");
    if (!Object.hasOwn(DECLARER_BUILTINS, name)) STATE.observedReads.add(unbounded(`getBuiltinModule("${name}"), not allowlisted`));
  });
  wrap(moduleApi, "_resolveFilename", () => {}, recordResolution);
  wrap(moduleApi, "findPackageJSON", () => {}, (_args, found) => recordPackageLookup(found));
  for (const name of ["register", "registerHooks"]) wrap(moduleApi, name, whole(`module.${name}, a loader hook`));
}

function install() {
  const read = (/** @type {unknown[]} */ [target]: unknown[]) => recordRead(target);
  const list = (/** @type {unknown[]} */ [target]: unknown[]) => recordListing(target);
  const glob = (/** @type {unknown[]} */ [pattern, options]: unknown[]) => recordGlob(pattern, options as { cwd?: unknown } | undefined);
  for (const owner of [fs, fs.promises]) {
    for (const name of LISTS) { wrap(owner, name, list); wrap(owner, `${name}Sync`, list); }
    for (const name of READS) { wrap(owner, name, read); wrap(owner, `${name}Sync`, read); }
    wrap(owner, "glob", glob);
    wrap(owner, "globSync", glob);
  }
  for (const name of ["createReadStream", "openAsBlob", "watchFile"]) wrap(fs, name, read);
  for (const name of ["execFileSync", "spawnSync", "execFile", "spawn", "fork"]) {
    wrap(childProcess, name, ([file, ...rest]) => (name === "fork" ? recordSpawn(process.execPath, rest) : recordSpawn(file, rest)));
  }
  for (const name of ["exec", "execSync"]) {
    wrap(childProcess, name, ([command, options]) => recordCommandLine(command, options as { cwd?: unknown; env?: unknown } | undefined));
  }
  const { Worker } = workerThreads;
  workerThreads.Worker = class ObservedWorker extends Worker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      STATE.observedReads.add(unbounded("a worker thread, whose reads are not visible here"));
      super(...args);
    }
  };
  Object.defineProperty(workerThreads.Worker, OBSERVED, { value: true });
  installBeyondFs();
  // Named ESM imports of a builtin are a snapshot of its exports; this re-points them at the wrappers -- for
  // `node:fs/promises` too, whose exports are `fs.promises`.
  syncBuiltinESMExports();
}
if (!STATE.installed) {
  STATE.installed = true;
  install();
}

/** Every repo-relative path read since this module was imported. */
export function readsSoFar() {
  return [...STATE.observedReads].sort();
}

/**
 * The paths read while `run` runs, and only those -- how `declared-walk-scope.test.ts` proves each route is
 * seen. Tested against `readsSoFar()` instead, a path something else had already read would pass vacuously.
 * @param {() => unknown} run
 * @returns {Promise<string[]>}
 */
export async function readsDuring(run: () => unknown): Promise<string[]> {
  const outer = STATE.observedReads;
  STATE.observedReads = new Set();
  try {
    await run();
    return [...STATE.observedReads].sort();
  } finally {
    for (const path of STATE.observedReads) outer.add(path);
    STATE.observedReads = outer;
  }
}

/**
 * A read `readsOutsideScope` refuses WHATEVER the scope: the marker is outside every subtree by construction.
 * @param {string} path
 */
const isUnboundedRead = (path: string) => path.startsWith(WHOLE_REPOSITORY);

/**
 * The reads a declaration does not cover: outside the scope and outside the guard's own import closure.
 *
 * The closure is excluded because a change to it already selects the guard PRECISELY, whatever its scope --
 * reading its own imports is not a population, it is the guard's code.
 *
 * @param {readonly string[]} reads repo-relative
 * @param {readonly string[]} scope
 * @param {ReadonlySet<string>} ownFiles repo-relative paths in the guard's import closure
 */
export function readsOutsideScope(reads: readonly string[], scope: readonly string[], ownFiles: ReadonlySet<string>) {
  return reads.filter((path) => isUnboundedRead(path) || (!ownFiles.has(path) && !inScope(path, scope)));
}

/** How many of `outside` the message names before it elides the rest. */
const PATHS_SHOWN = 8;

/**
 * The sample the refusal names.
 *
 * The remedy below turns on whether an unbounded read is present, so the sample that justifies it has to
 * contain one -- and it does without sorting it here: `readsSoFar` returns the reads SORTED, and every
 * marker begins `(`, which orders before any repo-relative path. A reorder here would be machinery no
 * fixture could ever be seen to need.
 *
 * @param {readonly string[]} outside
 */
function namedSample(outside: readonly string[]) {
  return `${outside.slice(0, PATHS_SHOWN).join("; ")}${outside.length > PATHS_SHOWN ? "; ..." : ""}`;
}

/**
 * The remedy this refusal may honestly offer.
 *
 * Widening is a real remedy only for ordinary paths. `readsOutsideScope` refuses the `WHOLE_REPOSITORY`
 * marker whatever the scope, so no value of `WALK_SCOPE` covers one -- and a reader who followed the old
 * unconditional "widen to cover these" against a marker widened to the repository root and was refused
 * again, identically, with no hint the loop was by design (#2007, after #1968 paid that round).
 *
 * THE MIXED CASE IS DECIDED BY THE UNBOUNDED READ, not by branch order: a remedy has to clear EVERY path
 * in the list, and widening leaves the marker refused however far it is widened. So removal is the only
 * remedy that ends the refusal, and the message says what widening WOULD have covered rather than
 * pretending the ordinary paths are not there.
 *
 * Failing closed on a child process stays correct and is not what this softens: undeclared is unbounded,
 * which is the fail-safe direction `declared-walk-scope.test.ts` pins.
 *
 * @param {readonly string[]} outside
 */
function remedyFor(outside: readonly string[]) {
  const narrower = "A declaration narrower than the walk is a guard that stops running on a diff that would fail it";
  const unboundedCount = outside.filter(isUnboundedRead).length;
  if (unboundedCount === 0) return `${narrower} -- widen WALK_SCOPE to cover these, or remove it.`;
  const ordinaryCount = outside.length - unboundedCount;
  const widenWouldCover = ordinaryCount === 0 ? ""
    : ` Widening would cover the other ${ordinaryCount} path(s) and leave the unbounded one(s) refused unchanged.`;
  return `${narrower} -- but the walk left the process for ${unboundedCount} of these, so nothing can bound `
    + `what it read there: NO value of WALK_SCOPE covers ${WHOLE_REPOSITORY}.${widenWouldCover}`
    + " Remove the declaration -- undeclared is unbounded, which is the safe direction.";
}

/**
 * Paths a TEST RUNNER reads on a test file's behalf, which are the runner's and not the guard's population
 * (#1349). rstest looks for `__snapshots__/<file>.snap` beside every test file it runs, so a declarer whose
 * scope does not contain its own directory failed its check on that probe alone.
 * @param {string} testPath absolute
 * @returns {string[]} repo-relative
 */
export function runnerOwnedPaths(testPath: string): string[] {
  return [relative(REPO_ROOT, join(dirname(testPath), "__snapshots__", `${basename(testPath)}.snap`))];
}

/**
 * Every top-level `packages/<name>` directory name the repository tracks. This is `knownPackages` of the core's `scripts/ci-changed.ts`,
 * restated here because that module is not published yet (a11ign/a11ign#4587), and this one must resolve inside the toolchain today.
 * Once `./lib/ci-changed` is published, this can import it instead.
 */
function knownPackages(repoRoot: string): string[] {
  const patterns = JSON.parse(fs.readFileSync(`${repoRoot}/package.json`, "utf8")).workspaces ?? ["packages/*"];
  if (patterns.length !== 1 || patterns[0] !== "packages/*") {
    throw new Error(`walk-scope assumes a single "packages/*" workspace glob; package.json now says ${JSON.stringify(patterns)}`);
  }
  const tracked = childProcess.execFileSync("git", ["ls-files", "packages"], { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" });
  // A file directly under `packages/` has two path segments and is not a package; a real one has a file NESTED under its directory.
  const names = tracked.split("\n").filter((file) => file.split("/").length > 2).map((file) => file.split("/")[1]);
  return [...new Set(names)].sort();
}

/**
 * Register the guard's own check: once every test in the file has run, anything it read outside its
 * declared scope fails the file.
 *
 * The scope is PARSED from the file's own source rather than passed in, so this checks exactly the fact the
 * selector acts on. A value handed in could differ from the literal the selector reads -- two copies of one
 * fact, which is the shape that produced #904's wrong numbers.
 *
 * @param {string} testUrl the declaring guard's `import.meta.url`
 */
export async function declareWalkScope(testUrl: string) {
  const testPath = fileURLToPath(testUrl);
  const scope = parseWalkScope(fs.readFileSync(testPath, "utf8"));
  if (scope === null) {
    throw new Error(`walk-scope: ${relative(REPO_ROOT, testPath)} calls declareWalkScope but declares no WALK_SCOPE`);
  }
  after(async () => {
    // SNAPSHOT FIRST, before this check reads anything itself. `packageIndex` and `sourceClosure` below read
    // every `package.json` and probe extensions for files that do not exist, through the same patched `fs` --
    // and counted as the guard's reads, they would be violations the guard never committed.
    const reads = readsSoFar();
    // Dynamic, not static: the selector's module graph is loaded only when a declaring guard's tests finish,
    // and never ahead of the observer in a declarer's import order.
    const { sourceClosure, packageIndex } = await import("./walk-scope-discovery.ts");
    const packages = packageIndex(REPO_ROOT, knownPackages(REPO_ROOT));
    const own = new Set([...sourceClosure(testPath, REPO_ROOT, packages)]
      .map((absolute) => relative(REPO_ROOT, absolute)));
    for (const path of runnerOwnedPaths(testPath)) own.add(path);
    const outside = readsOutsideScope(reads, scope, own);
    if (outside.length > 0) {
      throw new Error(`${relative(REPO_ROOT, testPath)} declares WALK_SCOPE ${JSON.stringify(scope)} and read `
        + `${outside.length} path(s) outside it: ${namedSample(outside)}. ${remedyFor(outside)}`);
    }
  });
}
