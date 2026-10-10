Closes a11ign/a11ign#4873

Acceptance:

```bash
pnpm run build && pnpm exec rstest run src/lib/walk-scope.test.ts
```

Prints `VERDICT pass: 8 tests in 1 file` on this head (Node v24.21.0), the 4 that were there plus the 4 this adds. The row's own form, `cd /home/agent/repos/toolchain && npx rstest run src/lib/walk-scope.test.ts`, names the primary checkout, which holds no `node_modules` and sits behind `origin/main`; the command above is the same one from the worktree, with `build` first because `rstest.config.ts` imports `dist`.

**What it does.** `REPO_ROOT` in `src/lib/walk-scope.ts` is the directory `A11IGN_PROJECT_ROOT` names when the variable is set, resolved to its real path as before, and the package-relative root exactly as before when it is unset. A set value that is not an absolute path to an existing directory throws at import, naming the value.

**The four new cases**, each run in its own child process because `REPO_ROOT` is fixed at import:
- variable set to a temp project: a read inside it is recorded (`docs/notes.md`), a read of the toolchain's own `package.json` is not, and `REPO_ROOT` is the project (the positive control);
- variable unset: `REPO_ROOT` is the toolchain's root and the observed read is the toolchain's `package.json`, not the temp project's file (the negative control, the opposite file to the one above);
- variable set to a symlink to the project: `REPO_ROOT` is the real directory;
- variable set to a missing directory, a file, a relative path and the empty string: each throws at import and the message carries `A11IGN_PROJECT_ROOT="<value>"` and which of the four it is; the same child pointed at a real directory imports cleanly, so the refusals are the value's and not the harness's.

**Interpretation, named.** The row says "set and absolute" uses the value, and "a set value that is not an existing directory throws". A set value that is relative or empty is read as the second: it is set, it names no usable directory, and the alternative is answering "could not tell" with the toolchain's own tree, which is the defect. A consumer that sets the variable to the empty string to mean "unset" will now see the throw and the fix is to unset it.

**Host note.** The child imports `src/lib/walk-scope.ts` when the running Node strips types (`process.versions.amaro`), and `dist/lib/walk-scope.mjs` otherwise (the agent host's 22.22.1 has none; `pnpm test` builds first). Measured here on Node v24.21.0 with the condition forced false: the same 8 tests pass against `dist`.

Mutation: measured on this host (Node v24.21.0), `src/lib/walk-scope.ts` restored from a copy and `diff`ed byte-identical after each -- (A) the variable ignored (`if (true)` for the unset branch) fails the set-variable case, the symlink case and the refusal case, and leaves the unset case green; (B) the unset branch removed (the variable consulted always) fails the whole file at import, because the test process itself runs with it unset; (C) the `isDirectory` check removed fails the refusal case alone; (D) the `isAbsolute` check removed fails the refusal case alone; (E) a missing directory falling back to the package-relative root fails the refusal case alone.

Also green on this head: `pnpm exec rstest run` (`VERDICT pass: 396 tests in 34 files`), `pnpm run lint`, `pnpm run typecheck`.
