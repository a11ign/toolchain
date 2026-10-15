Closes a11ign/a11ign#5520

Acceptance:

```bash
node --test src/lib/git-sandbox.test.ts
```

**Positive control.** The first test passes `remove: () => {}` and asserts `withGitSandbox` throws `SandboxNotRemovedError` with the sandbox directory's name and the pid in the message, then removes that directory itself. Before the change the same test fails with `Missing expected exception`. With the existence check deleted from `withGitSandbox`, it fails the same way.

**Mutation (measured on this host, Node v24.21.0).** With the existence check deleted, `never-fires` fails only the positive-control test. With the check forced on, `always-fires` fails only the ordinary-removal test. The file was restored from a copy and `cmp` confirmed it byte-identical.
