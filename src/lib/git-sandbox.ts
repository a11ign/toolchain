/**
 * A test that spawns `git` inside a disposable directory is one `GIT_DIR` away from operating on the
 * REAL repository instead of the throwaway one it just created — `cwd` loses to `GIT_DIR`, proven in
 * isolation: `GIT_DIR=<real>/.git git init && git commit` lands the commit in `<real>`, wherever `cwd`
 * points. git EXPORTS `GIT_DIR` into every hook environment, and the pre-push hook runs `npm test` — so
 * the moment "nothing installs the git hooks" (docs/backlog.md) was closed, every test here that spawned
 * git with `cwd` alone and an inherited `env` became live surface against the real checkout. It happened:
 * `core.bare` flipped to `true` twice, stray `base`/`init` commits landed on real refs, and
 * `packages/lab/src/packaging/pre-commit-hook.test.ts:42`'s `git config user.name "Pre-Commit Hook Test"`
 * was written into the real repo, byte-identical, and reused as the author on 15 commits across all refs
 * — six of them real work already on `origin/main`.
 *
 * Two independent defences, because nobody claims either is complete on its own:
 *
 * 1. `sandboxGitEnv()` strips every `GIT_*` variable before a caller adds back what it actually wants, so
 *    a leaked `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (or any other `GIT_*` a future git version, a
 *    CI shim, or a wrapper introduces — the prefix strip does not require the list to be exhaustive)
 *    cannot survive into a spawned git call.
 * 2. **`git config user.name`/`user.email` WRITE to whatever repository `GIT_DIR` currently names**, so a
 *    test that calls it would forge identity into the real repo the instant the environment strip above
 *    is ever incomplete. `GitSandbox.commit()` therefore never writes config at all — every commit passes
 *    identity PER COMMAND (`git -c user.name=… -c user.email=… commit`), which cannot write anywhere
 *    regardless of which repository git resolves to.
 *
 * `withGitSandbox` adds a third, load-bearing check: it fingerprints the target repository's HEAD,
 * `user.name`, `user.email` and `core.bare` before and after, and throws if any moved. A helper that
 * could corrupt the repo it lives in must PROVE it did not — the same rule this project applies to every
 * other guard ("a guard must be shown to fail before it is trusted", CLAUDE.md). `root` defaults to this
 * checkout but is a parameter precisely so the helper's own tests can point it at a decoy instead of
 * risking the real one to prove the guard fires.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv, KNOWN_GIT_REDIRECT_VARS } from "./git-env.ts";

// Re-exported rather than redefined: `packages/guards/src/git-env.ts` is the ONE PLACE the GIT_* strip is stated,
// because a copy of a defensive filter is exactly the "fact stated twice" shape this repo's CLAUDE.md
// warns about -- see that file's header for why production git-spawning code needs the identical
// function and cannot simply import THIS module (worker-fleet publishes as `bin`; this file lives
// outside any published package).
export { sandboxGitEnv, KNOWN_GIT_REDIRECT_VARS };

export interface GitSandbox {
  readonly dir: string;
  /** Any git subcommand, GIT_* always scrubbed. Never use this for `config user.name`/`user.email` — see `commit`. */
  run(args: string[], env?: Record<string, string>): string;
  /** The only sanctioned way to attach identity: PER COMMAND, so it cannot write config anywhere. */
  commit(message: string, extraArgs?: string[]): string;
}

function makeSandbox(dir: string): GitSandbox {
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: sandboxGitEnv(env) });
  return {
    dir,
    run,
    commit(message, extraArgs = []) {
      return run([
        "-c", "user.name=Git Sandbox Test",
        "-c", "user.email=git-sandbox-test@example.invalid",
        "commit", "-q", "-m", message, ...extraArgs,
      ]);
    },
  };
}

interface RepoFingerprint {
  head: string;
  userName: string;
  userEmail: string;
  bare: string;
}

/** Reads git's own account of `root`'s identity, with GIT_* scrubbed — never trusts an inherited env either. */
export function repoFingerprint(root: string): RepoFingerprint {
  const read = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", env: sandboxGitEnv() }).trim();
    } catch {
      return "<unreadable>";
    }
  };
  // TWO `git` PROCESSES, NOT FOUR, AND THE ANSWER IS IDENTICAL. `--list` returns every local key in one
  // read, so the three `config` calls were three process spawns fetching values one `git` already had.
  //
  // This runs BEFORE AND AFTER EVERY SANDBOX -- 60 call sites across the suite, so 120 fingerprints and
  // 480 git processes purely to check the real repository has not moved. Measured on this machine: 78.9ms
  // for the four-call form against 38.2ms for this one, which is 4.9s of the suite spent starting
  // processes to read config.
  //
  // THE GUARD IS UNCHANGED, which is the only reason this is worth doing. The cheap way to make this
  // faster would be to fingerprint once per FILE rather than per sandbox, and that would lose WHICH test
  // moved the repository -- the thing `RepoIdentityMovedError` exists to name. Same four values, same
  // comparison, fewer processes.
  const local = read(["config", "--local", "--list"]);
  const value = (key: string) => {
    if (local === "<unreadable>") return "<unreadable>";
    const line = local.split("\n").find((l) => l.startsWith(`${key}=`));
    return line === undefined ? "<unreadable>" : line.slice(key.length + 1);
  };
  return {
    head: read(["rev-parse", "HEAD"]),
    userName: value("user.name"),
    userEmail: value("user.email"),
    bare: value("core.bare"),
  };
}

/** The default target: THIS checkout's repository root, two directories up from this file. */
const REAL_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export class RepoIdentityMovedError extends Error {
  constructor(root: string, before: RepoFingerprint, after: RepoFingerprint) {
    super(
      `withGitSandbox: the repository at ${root} moved during a sandboxed git test -- this is the ` +
      "GIT_DIR-leak defect (docs/backlog.md, 'a closed row created the exposure') happening again, not a " +
      `flaky assertion. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
    );
    this.name = "RepoIdentityMovedError";
  }
}

/**
 * Runs `fn` against a fresh, disposable git repository (never `root` itself) and tears it down
 * afterward. Fingerprints `root` before and after and throws `RepoIdentityMovedError` if HEAD, identity,
 * or bareness moved — regardless of whether `fn` passed. `root` defaults to this checkout; pass a decoy
 * directory to test the guard itself without risking the real one.
 */
export function withGitSandbox<T>(fn: (sandbox: GitSandbox) => T, root: string = REAL_REPO_ROOT): T {
  const before = repoFingerprint(root);
  // REALPATH'd: on macOS `/var` is a symlink to `/private/var`, and `git status` reports paths against
  // the resolved root -- an unresolved dir here made a caller's later path comparison against `git
  // status --porcelain` output silently fail once already (promotion-refuses-dirty.test.ts).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "a11y-git-sandbox-")));
  const sandbox = makeSandbox(dir);
  let result: T;
  try {
    sandbox.run(["init", "--quiet"]);
    result = fn(sandbox);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = repoFingerprint(root);
  if (after.head !== before.head || after.userName !== before.userName ||
      after.userEmail !== before.userEmail || after.bare !== before.bare) {
    throw new RepoIdentityMovedError(root, before, after);
  }
  return result;
}
