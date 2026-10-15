/**
 * #5520: a sandbox whose directory survives its own removal fails the test that made it, at the line that
 * made it, instead of surfacing later in another process's teardown with nothing naming the test.
 *
 * The removal is an injected seam (`remove`), so the test makes removal a no-op and sees the throw. The
 * directory the no-op leaves behind is removed by the test itself, by name, so the positive control leaves
 * nothing in the tmpdir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { withGitSandbox } from "./git-sandbox.ts";

test("#5520 a removal that did not take effect throws naming the directory and the pid", () => {
  let leftBehind = "";
  try {
    assert.throws(
      () => withGitSandbox((sandbox) => {
        leftBehind = sandbox.dir;
        return sandbox.run(["rev-parse", "--is-inside-work-tree"]);
      }, undefined, { remove: () => {} }),
      (error: unknown) => error instanceof Error && error.name === "SandboxNotRemovedError"
        && error.message.includes(leftBehind)
        && error.message.includes(`pid ${process.pid}`),
    );
    assert.equal(existsSync(leftBehind), true, "the no-op removal must have left the directory in place");
  } finally {
    rmSync(leftBehind, { recursive: true, force: true });
  }
});

test("#5520 an ordinary sandbox is removed and returns its value without throwing", () => {
  let seen = "";
  const value = withGitSandbox((sandbox) => {
    seen = sandbox.dir;
    return sandbox.run(["rev-parse", "--is-inside-work-tree"]).trim();
  });
  assert.equal(value, "true");
  assert.equal(existsSync(seen), false, "the default removal must take the directory away");
});
