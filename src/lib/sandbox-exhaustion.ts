// @ts-check
/**
 * #2158: A TEST SANDBOX THAT COULD NOT BE BUILT SAYS SO, ON THE LINE THE RUNNER PRINTS AS THE VERDICT.
 *
 * 104 test suites in this repository build their sandboxes with `mkdtempSync(join(tmpdir(), …))`, under a
 * 16G tmpfs `/tmp` that every session on the agents host SHARES. When it fills, the suite does not report a
 * disk problem: it reports a list of named tests that failed, in the same shape and the same place as a real
 * regression. Measured 2026-09-23 by `worker-capture` mid-build of #2031 -- `row-claim.test.ts` reported 15
 * failures that were entirely `Disk quota exceeded`, and clearing the leftover `/tmp/row-claim-*`
 * directories took it straight back to 138/138.
 *
 * WHAT NODE ACTUALLY GIVES YOU, measured against the same helper shape before this was written:
 *
 *     $ node -e 'require("node:fs").mkdtempSync("<unwritable>/row-claim-worktree-")'
 *     EACCES: permission denied, mkdtemp '<unwritable>/row-claim-worktree-XXXXXX'
 *
 * A bare errno and a path. Nothing in it says *the sandbox root is the problem, not your change*, and the
 * `EDQUOT` and `ENOSPC` forms read identically. This file adds the three facts that turn that into an
 * orientation: the sandbox ROOT, that root's filesystem FREE SPACE at the moment of failure, and -- loudest
 * -- that the HOST is the cause rather than the code under test.
 *
 * IT IS STILL RED, DELIBERATELY. An exhausted disk is a real failure of that run and must stay a failure;
 * a suite that goes quiet under a full disk is strictly worse than one that lies about why. This changes
 * only what the red SAYS.
 *
 * ONE LINE, AND THAT IS THE WHOLE POINT. `worker-capture`'s quota lines DID exist -- above the summary,
 * where a reader grepping for the verdict never reached them. Every message this file produces is a single
 * line with no newline in it, so whichever reporter prints it, it survives a `grep` and arrives beside the
 * failing test's name rather than a screen earlier.
 *
 * NO NETWORK AND NO HOST CALL. The free-space reading is `statfsSync`, a syscall against the sandbox root's
 * own filesystem -- not a `df` subprocess, not ssh, not the control plane. It works unchanged on a CI runner
 * with no special access, which is the only reason it may sit in the failure path of 104 suites.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The phrase a reader greps for. Loud on purpose: it is competing with a list of test names. */
export const EXHAUSTION_MARKER = "SANDBOX EXHAUSTED -- THE HOST, NOT THE CODE UNDER TEST";

/**
 * The three errno codes #2158 names, each with what it means for the person reading the failure.
 * @type {Readonly<Record<string, string>>}
 */
export const EXHAUSTION_CODES: Readonly<Record<string, string>> = Object.freeze({
  ENOSPC: "the filesystem holding the sandbox root is full",
  EDQUOT: "this user's disk quota on that filesystem is exhausted",
  EACCES: "the sandbox root could not be written to",
});

/**
 * The strerror phrases worth reading out of a CHILD's output, where Node sets no `code` on the error at all
 * -- a `git init` or `git worktree add` inside a sandbox dies of a full disk as a non-zero exit, not as an
 * `ErrnoException`. Only the two CAPACITY phrases are here. `EACCES`'s own strerror, "Permission denied", is
 * deliberately NOT: it is the one of the three that is routinely about something other than the host (a
 * hook, a mode, a file the test itself made unreadable), and mislabelling those as "the host, not your
 * change" would reproduce this row pointing the other way. EACCES is still caught in full whenever Node
 * sets `error.code`, which is the shape #2158 actually measured.
 * @type {Readonly<Record<string, string>>}
 */
const CAPACITY_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  ENOSPC: "No space left on device",
  EDQUOT: "Disk quota exceeded",
});

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const BYTES_PER_GIB = BYTES_PER_MIB * BYTES_PER_KIB;

/**
 * Which of the three #2158 codes this error is, or `null` for every other failure -- an assertion, a
 * timeout, a real regression. Read from `error.code` first, because that is what a direct `mkdtempSync`,
 * `mkdirSync` or `writeFileSync` sets; then from the error's own text and a captured child's `stderr`,
 * because a spawned `git` that died of a full disk carries the fact only there.
 * @param {unknown} error what a `catch` around the sandbox setup received
 * @returns {string | null} the errno name, or null
 */
export function exhaustionCause(error: unknown): string | null {
  const failure = ((error ?? {}) as { code?: unknown, message?: unknown, stderr?: unknown });
  const code = typeof failure.code === "string" ? failure.code : "";
  if (code in EXHAUSTION_CODES) return code;
  const text = `${asText(failure.message)}\n${asText(failure.stderr)}`;
  for (const name of Object.keys(CAPACITY_PHRASES)) {
    if (text.includes(name) || text.includes(CAPACITY_PHRASES[name])) return name;
  }
  return null;
}

/**
 * The one line #2158 asks for: the marker, the errno and what it means, the sandbox ROOT, that root's
 * filesystem FREE SPACE read at this moment, and the original error so nothing is hidden.
 *
 * `statfs` is a seam for this module's own guard, which needs the free-space reading to FAIL on purpose --
 * a `statfsSync` that throws here must still leave the orientation intact, because this runs in the failure
 * path of the suites it is meant to explain and a guard that breaks there takes the explanation with it.
 *
 * @param {unknown} error
 * @param {{ root: string, cause: string, statfs?: (path: string) => { bsize: number, blocks: number, bavail: number } }} where
 * @returns {string}
 */
export function describeSandboxExhaustion(error: unknown, { root, cause, statfs = statfsSync }: { root: string; cause: string; statfs?: (path: string) => { bsize: number; blocks: number; bavail: number; }; }): string {
  const meaning = EXHAUSTION_CODES[cause] ?? `${cause} while building the sandbox`;
  const original = firstLine(asText(((error ?? {}) as { message?: unknown }).message))
    ?? "the setup threw with no message";
  return `${EXHAUSTION_MARKER}: ${cause} building the test sandbox ${root} -- ${meaning}. ${freeSpace(root, statfs)}. `
    + `Free space on that filesystem and re-run; this run proved nothing about the code under test. `
    + `The original error was: ${original}`;
}

/**
 * The error to throw in place of a bare errno, or `null` when this failure is not one of #2158's three and
 * must be rethrown exactly as it arrived.
 * @param {unknown} error
 * @param {string} root the sandbox root the setup was building
 * @returns {Error | null}
 */
export function sandboxExhaustionError(error: unknown, root: string): Error | null {
  const cause = exhaustionCause(error);
  if (cause === null) return null;
  const described = new Error(describeSandboxExhaustion(error, { root, cause }), { cause: error });
  described.name = "SandboxExhaustionError";
  return described;
}

/**
 * A test sandbox: a fresh `mkdtemp` directory, `body` run inside it, and the directory removed afterwards --
 * with every `ENOSPC`, `EDQUOT` or `EACCES` raised on the way, by the `mkdtemp` ITSELF or by anything `body`
 * does, replaced by the line above. Anything else `body` throws is rethrown untouched, so an assertion
 * failure inside a sandbox still reads as an assertion failure.
 *
 * `base` exists so this module's own guard can point a sandbox at a directory it has made unwritable and
 * provoke a REAL `EACCES` from a REAL `mkdtempSync`, rather than asserting against a hand-built error object
 * that carries none of the fields Node's does. Callers in the suite omit it and get `tmpdir()`.
 *
 * @template T
 * @param {{ prefix: string, base?: string }} options the `mkdtemp` prefix, and where to put it
 * @param {(root: string) => T} body
 * @returns {T}
 */
export function withSandbox<T>({ prefix, base = tmpdir() }: { prefix: string; base?: string; }, body: (root: string) => T): T {
  const intended = join(base, prefix);
  let root = "";
  try {
    root = realpathSync(mkdtempSync(intended));
    return body(root);
  } catch (error) {
    throw sandboxExhaustionError(error, root === "" ? intended : root) ?? error;
  } finally {
    // The sandbox goes even when the body threw; `force` covers the case where `mkdtemp` never made one.
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A sandbox that OUTLIVES this call: `mkdtemp`, `populate` run inside it, and the directory handed back for
 * the caller to remove -- the shape of a fixture built once at module load and removed in `after()`, which
 * `withSandbox` (body-then-remove) cannot express. #2154: `trunk-revert-guard.test.ts` clones the whole
 * repository into `/tmp` once per file, and that `git clone` is the line a full tmpfs killed.
 *
 * The same classification as `withSandbox`, for the same reason. A `populate` that throws removes the
 * half-built directory first -- a failed clone must not leave the bytes that filled the disk behind -- and
 * then throws the exhaustion line for `ENOSPC`/`EDQUOT`/`EACCES` (an `execFileSync` child that died of a
 * full disk carries the phrase in its message and `stderr`, which `exhaustionCause` reads) or the original
 * error untouched for anything else.
 *
 * @param {{ prefix: string, base?: string }} options the `mkdtemp` prefix, and where to put it
 * @param {(root: string) => void} populate
 * @returns {string} the real path of the populated sandbox; the caller removes it
 */
export function buildSandbox({ prefix, base = tmpdir() }: { prefix: string; base?: string; }, populate: (root: string) => void): string {
  const intended = join(base, prefix);
  let root = "";
  try {
    root = realpathSync(mkdtempSync(intended));
    populate(root);
    return root;
  } catch (error) {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    throw sandboxExhaustionError(error, root === "" ? intended : root) ?? error;
  }
}

/**
 * How much room the sandbox root's filesystem had at the moment of failure, named against the deepest path
 * that actually EXISTS -- when `mkdtemp` is what failed there is no root to stat, and its parent is the
 * filesystem the caller needs to hear about.
 *
 * A reading that cannot be taken SAYS SO. It must never fall back to a zero, which would read as "the disk
 * is full" -- the one conclusion this whole file exists to make reliable.
 *
 * @param {string} root
 * @param {(path: string) => { bsize: number, blocks: number, bavail: number }} statfs
 * @returns {string}
 */
function freeSpace(root: string, statfs: (path: string) => { bsize: number; blocks: number; bavail: number; }): string {
  const measured = existingAncestor(root);
  try {
    const { bsize, blocks, bavail } = statfs(measured);
    return `${humanBytes(bavail * bsize)} free of ${humanBytes(blocks * bsize)} on the filesystem holding ${measured}`;
  } catch (error) {
    return `its filesystem free space could not be read at ${measured} (${firstLine(asText(
      ((error ?? {}) as { message?: unknown }).message)) ?? "no message"})`;
  }
}

/**
 * The deepest ancestor of `path` (itself included) that exists. When nothing on the path does, the walk
 * bottoms out at `/` or `.` and returns it -- and `freeSpace`'s own catch covers whatever that then does,
 * rather than this returning a null nothing on a real filesystem could ever produce.
 * @param {string} path
 * @returns {string}
 */
function existingAncestor(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** @param {number} bytes @returns {string} */
function humanBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GIB) return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
  if (bytes >= BYTES_PER_MIB) return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`;
  return `${bytes} B`;
}

/** Whatever a field held, as text -- `stderr` is a Buffer on a piped spawn and a string on an inherited one. */
/** @param {unknown} value @returns {string} */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** The argv line of a spawn failure, or the whole of a one-line errno message -- never the child's stderr again. */
/** @param {string} text @returns {string | null} */
function firstLine(text: string): string | null {
  const line = text.split("\n")[0].trim();
  return line === "" ? null : line;
}
