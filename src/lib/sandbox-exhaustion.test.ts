/**
 * `sandbox-exhaustion.ts` (#2158): a test sandbox that could not be built because the HOST is full says so, on one line, instead of a bare errno.
 *
 * What is pinned:
 *   1. WHAT COUNTS AS EXHAUSTION. `error.code` of ENOSPC/EDQUOT/EACCES, or (for a spawned child, which carries no code) the two CAPACITY phrases in the message
 *      or `stderr`. "Permission denied" in text is deliberately NOT exhaustion, and neither is any other errno: mislabelling a hook or a mode as "the host, not
 *      your change" would send a reader away from a real regression.
 *   2. THE MESSAGE IS ONE LINE carrying the marker, the errno, the ROOT, the free space and the original error's first line, and a free-space reading that
 *      cannot be taken SAYS SO rather than reporting zero (which would read as "full").
 *   3. `withSandbox` / `buildSandbox` still FAIL, remove what they made on every path, rethrow an unrelated error untouched (same object), and replace an
 *      exhausted one with a `SandboxExhaustionError` whose `cause` is the original.
 *
 * THE POSITIVE CONTROLS: every "is not exhaustion" case sits beside an otherwise identical one that is; the real-EACCES case provokes a REAL `mkdtempSync` failure
 * in a read-only directory (skipped as root, who can write anywhere) and its sibling with a writable base succeeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXHAUSTION_CODES,
  EXHAUSTION_MARKER,
  buildSandbox,
  describeSandboxExhaustion,
  exhaustionCause,
  sandboxExhaustionError,
  withSandbox,
} from "./sandbox-exhaustion.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const BLOCK = 4096;
const READ_ONLY_DIRECTORY = 0o500;
const WRITABLE_DIRECTORY = 0o700;
const BLOCKS_PER_GIB = GIB / BLOCK;
const TOTAL_GIB = 16;
const FREE_GIB = 1.5;
const asRoot = process.getuid?.() === 0;
const SKIP_AS_ROOT = asRoot && "root can write to a read-only directory";

const fsError = (code: string, message = `${code}: something`) => Object.assign(new Error(message), { code });
const statfsOf = (blocks: number, bavail: number) => () => ({ bsize: BLOCK, blocks, bavail });

test("the three errno codes are exhaustion and each is described", () => {
  assert.deepEqual(Object.keys(EXHAUSTION_CODES), ["ENOSPC", "EDQUOT", "EACCES"]);
  for (const code of Object.keys(EXHAUSTION_CODES)) assert.equal(exhaustionCause(fsError(code)), code);
  assert.throws(() => { (EXHAUSTION_CODES as Record<string, string>).ENOSPC = "changed"; }, TypeError, "the table is frozen");
});

test("any other errno, a non-string code, and a missing error are not exhaustion", () => {
  assert.equal(exhaustionCause(fsError("EEXIST")), null);
  assert.equal(exhaustionCause(fsError("ENOENT", "no such file")), null);
  assert.equal(exhaustionCause(new Error("expected 3 to equal 4")), null);
  assert.equal(exhaustionCause(null), null);
  assert.equal(exhaustionCause(undefined), null);
  assert.equal(exhaustionCause({ code: 28 }), null);
});

test("a child's capacity phrase in the message or stderr is exhaustion, in either spelling", () => {
  assert.equal(exhaustionCause(new Error("fatal: write error: No space left on device")), "ENOSPC");
  assert.equal(exhaustionCause({ message: "git exited 128", stderr: Buffer.from("error: Disk quota exceeded") }), "EDQUOT");
  assert.equal(exhaustionCause({ message: "boom", stderr: "ENOSPC" }), "ENOSPC");
  assert.equal(exhaustionCause({ code: 28, message: "write failed: EDQUOT" }), "EDQUOT");
});

test("'Permission denied' in text is NOT exhaustion, though EACCES as a code is", () => {
  assert.equal(exhaustionCause({ message: "git: Permission denied", stderr: "Permission denied" }), null);
  assert.equal(exhaustionCause({ message: "the hook said EACCES" }), null);
  assert.equal(exhaustionCause(fsError("EACCES", "Permission denied")), "EACCES");
});

test("the description is one line: marker, errno meaning, root, free space and the original's first line", () => {
  const error = new Error("ENOSPC: no space left, mkdtemp '/tmp/x-XXXXXX'\n    at stack line");
  const line = describeSandboxExhaustion(error, { root: tmpdir(), cause: "ENOSPC", statfs: statfsOf(BLOCKS_PER_GIB * TOTAL_GIB, BLOCKS_PER_GIB * FREE_GIB) });
  assert.ok(line.startsWith(`${EXHAUSTION_MARKER}: ENOSPC building the test sandbox ${tmpdir()} -- the filesystem holding the sandbox root is full. `));
  assert.match(line, /1\.5 GiB free of 16\.0 GiB on the filesystem holding /);
  assert.match(line, /Free space on that filesystem and re-run; this run proved nothing about the code under test\. /);
  assert.ok(line.endsWith("The original error was: ENOSPC: no space left, mkdtemp '/tmp/x-XXXXXX'"));
  assert.equal(line.includes("\n"), false);
});

test("free space is named in B, MiB or GiB at the unit boundaries", () => {
  const free = (bytes: number) => describeSandboxExhaustion(new Error("e"), {
    root: tmpdir(), cause: "ENOSPC", statfs: () => ({ bsize: 1, blocks: GIB, bavail: bytes }),
  });
  assert.match(free(MIB - 1), / 1048575 B free of 1\.0 GiB /);
  assert.match(free(MIB), / 1\.0 MiB free of /);
  assert.match(free(GIB - 1), / 1024\.0 MiB free of /);
  assert.match(free(GIB), / 1\.0 GiB free of /);
  assert.match(free(0), / 0 B free of /);
});

test("a free-space reading that throws is reported as unreadable, never as zero", () => {
  const thrower = () => { throw new Error("statfs refused\nsecond line"); };
  const line = describeSandboxExhaustion(new Error("e"), { root: tmpdir(), cause: "EDQUOT", statfs: thrower });
  assert.match(line, /its filesystem free space could not be read at .* \(statfs refused\)\. /);
  assert.doesNotMatch(line, /0 B/);
  const silent = () => { throw null; };
  assert.match(describeSandboxExhaustion(new Error("e"), { root: tmpdir(), cause: "EDQUOT", statfs: silent }), /could not be read at .* \(no message\)/);
});

test("the free space is read at the deepest ancestor that exists", () => {
  const asked: string[] = [];
  const record = (path: string) => { asked.push(path); return { bsize: BLOCK, blocks: 1, bavail: 1 }; };
  describeSandboxExhaustion(new Error("e"), { root: join(tmpdir(), "no-such-dir-3998", "deeper"), cause: "ENOSPC", statfs: record });
  describeSandboxExhaustion(new Error("e"), { root: tmpdir(), cause: "ENOSPC", statfs: record });
  assert.deepEqual(asked, [tmpdir(), tmpdir()]);
});

test("an unknown cause is described by its own name, and an error with no message by a fixed phrase", () => {
  const line = describeSandboxExhaustion({}, { root: tmpdir(), cause: "EWHATEVER", statfs: statfsOf(1, 1) });
  assert.match(line, /EWHATEVER building the test sandbox .* -- EWHATEVER while building the sandbox\. /);
  assert.ok(line.endsWith("The original error was: the setup threw with no message"));
  assert.ok(describeSandboxExhaustion(null, { root: tmpdir(), cause: "ENOSPC", statfs: statfsOf(1, 1) }).endsWith("the setup threw with no message"));
});

test("sandboxExhaustionError returns null for an unrelated failure and a named, caused error for an exhausted one", () => {
  assert.equal(sandboxExhaustionError(new Error("assertion failed"), tmpdir()), null);
  const original = fsError("EDQUOT", "EDQUOT: quota, mkdir '/tmp/q'");
  const wrapped = sandboxExhaustionError(original, tmpdir());
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.name, "SandboxExhaustionError");
  assert.equal(wrapped.cause, original);
  assert.ok(wrapped.message.startsWith(`${EXHAUSTION_MARKER}: EDQUOT building the test sandbox ${tmpdir()} -- `));
});

test("withSandbox hands the body a real directory, returns its value and removes the directory", () => {
  let seen = "";
  const value = withSandbox({ prefix: "sandbox-exhaustion-test-" }, (root) => { seen = root; return existsSync(root) ? "inside" : "missing"; });
  assert.equal(value, "inside");
  assert.match(seen, /sandbox-exhaustion-test-[A-Za-z0-9]{6}$/);
  assert.equal(existsSync(seen), false);
});

test("withSandbox rethrows an unrelated error as the same object, and still removes the directory", () => {
  let seen = "";
  const original = new Error("expected 1 to equal 2");
  assert.throws(() => withSandbox({ prefix: "sandbox-exhaustion-test-" }, (root) => { seen = root; throw original; }), (thrown) => thrown === original);
  assert.equal(existsSync(seen), false);
});

test("withSandbox turns an exhaustion raised by the body into the one-line error, naming the sandbox root", () => {
  let seen = "";
  assert.throws(
    () => withSandbox({ prefix: "sandbox-exhaustion-test-" }, (root) => { seen = root; throw fsError("ENOSPC", "ENOSPC: write"); }),
    (thrown: Error) => thrown.name === "SandboxExhaustionError" && thrown.message.includes(`building the test sandbox ${seen} -- `),
  );
  assert.equal(existsSync(seen), false);
});

test("withSandbox against a base that cannot be written reports a REAL EACCES from mkdtemp, naming the intended path", { skip: SKIP_AS_ROOT }, () => {
  const base = mkdtempSync(join(tmpdir(), "sandbox-exhaustion-base-"));
  try {
    chmodSync(base, READ_ONLY_DIRECTORY);
    assert.throws(
      () => withSandbox({ prefix: "child-", base }, () => "unreached"),
      (thrown: Error) => thrown.name === "SandboxExhaustionError"
        && thrown.message.includes("EACCES building the test sandbox " + join(base, "child-"))
        && thrown.message.includes("the sandbox root could not be written to")
        && /free of/.test(thrown.message),
    );
    chmodSync(base, WRITABLE_DIRECTORY);
    assert.equal(withSandbox({ prefix: "child-", base }, () => "built"), "built", "the same call succeeds once the base is writable");
  } finally {
    chmodSync(base, WRITABLE_DIRECTORY);
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildSandbox hands back a populated directory that outlives the call", () => {
  let populatedAt = "";
  const root = buildSandbox({ prefix: "sandbox-exhaustion-build-" }, (dir) => { populatedAt = dir; });
  try {
    assert.equal(root, populatedAt);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSandbox removes a half-built directory when populate fails, and rethrows an unrelated error untouched", () => {
  let seen = "";
  const original = new Error("fatal: not a git repository");
  assert.throws(() => buildSandbox({ prefix: "sandbox-exhaustion-build-" }, (dir) => { seen = dir; throw original; }), (thrown) => thrown === original);
  assert.notEqual(seen, "");
  assert.equal(existsSync(seen), false);
});

test("buildSandbox converts a spawned child's full-disk failure into the exhaustion line and removes the directory", () => {
  let seen = "";
  const childDied = Object.assign(new Error("Command failed: git clone"), { stderr: "fatal: No space left on device" });
  assert.throws(
    () => buildSandbox({ prefix: "sandbox-exhaustion-build-" }, (dir) => { seen = dir; throw childDied; }),
    (thrown: Error) => thrown.name === "SandboxExhaustionError" && thrown.message.includes(`ENOSPC building the test sandbox ${seen}`) && thrown.cause === childDied,
  );
  assert.equal(existsSync(seen), false);
});

test("buildSandbox against an unwritable base reports a real EACCES for the intended path", { skip: SKIP_AS_ROOT }, () => {
  const base = mkdtempSync(join(tmpdir(), "sandbox-exhaustion-base-"));
  try {
    chmodSync(base, READ_ONLY_DIRECTORY);
    assert.throws(() => buildSandbox({ prefix: "child-", base }, () => undefined),
      (thrown: Error) => thrown.name === "SandboxExhaustionError" && thrown.message.includes(join(base, "child-")));
  } finally {
    chmodSync(base, WRITABLE_DIRECTORY);
    rmSync(base, { recursive: true, force: true });
  }
});
