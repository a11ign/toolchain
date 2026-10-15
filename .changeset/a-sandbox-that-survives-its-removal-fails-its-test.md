---
"@a11ign/toolchain": patch
---

`withGitSandbox` throws `SandboxNotRemovedError`, naming the directory and the pid, when the sandbox directory is still there after its removal, so a surviving sandbox fails the test that made it instead of surfacing in another process's teardown. Removal is an optional third argument, `{ remove }`, a seam for that test; the default is unchanged. Closes a11ign/a11ign#5520.
