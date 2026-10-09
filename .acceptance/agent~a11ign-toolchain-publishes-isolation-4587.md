Closes a11ign/a11ign#4587

Acceptance:

```bash
cd /home/agent/repos/wt-4587-toolchain && pnpm exec rstest run src/lib-tier-3.test.ts src/entries.test.ts src/package.test.ts
```

The row's Acceptance names the primary checkout `/home/agent/repos/toolchain`, which has no `node_modules` and cannot hold this branch, so it runs from the branch's worktree (as #31 to #34 did). Also green on this head: `pnpm test` (`VERDICT pass: 388 tests in 33 files`), `pnpm run lint`, `tsc --noEmit`, `pnpm run pack-check` (61 paths, 64 files). The row's second line (`npm view @a11ign/toolchain exports --json | grep -q "./lib/ci-changed"`) passes only once the release workflow has published this version; it was not run and is not claimed.

**What it does.** `isolation-gate`, its test `isolation-gate-layers.test.ts`, and `ci-changed` move from a11ign/a11ign to `src/lib/` and are exported as `./lib/isolation-gate` and `./lib/ci-changed`. A changeset (minor), a README paragraph, and `src/lib-tier-3.test.ts`, which names the two, imports each from source and asserts its manifest entry.

**Edits to moved code (all listed):**
- `isolation-gate`: `../../../scripts/cli-flags.ts` and `../../../scripts/npm-cli-executable.ts` are `./cli-flags.ts` and `./npm-cli-executable.ts`. `REPO_ROOT` was `../../../` from `packages/guards/src/`; from `src/lib/` the same meaning is `../../`. `allPackages` and `countPrivatePackages` each computed the `packages/` directory as `../../` from the same place; both are now `join(REPO_ROOT, "packages")`, the same directory, said through the root.
- `ci-changed`: the four `../packages/guards/src/<stem>.ts` imports and `./cli-flags.ts` are `./<stem>.ts` siblings.
- `isolation-gate-layers.test.ts`: the gate and its three imports are copied from `src/lib/` into the fixture at `src/lib/`, so the fixture's `REPO_ROOT` is the fixture. **Its last case is NOT moved**: "the real layers.json declares nvda-worker with a remote" reads the core's `layers.json`, which this package does not have, so it stays in the core's copy of the test (the core row that deletes the original must keep it).
- **Not moved: `ci-changed.test.ts`.** It is not in the row's Region and reads the core's workflows and `yaml`. The core row keeps it, importing `@a11ign/toolchain/lib/ci-changed`.
- **Left for a follow-up, outside this Region:** `src/lib/walk-scope.ts` carries its own `knownPackages` with a comment that it can import `./lib/ci-changed` once that exists. It now exists; replacing the copy is a one-line change to a file this row does not own.
- Known, left verbatim: the CLI block of `isolation-gate` and its usage strings still say `node packages/guards/src/isolation-gate.ts`; a consumer imports the functions.

**Mutation (measured, `lib-tier-3` + `lib-tier-2` + `isolation-gate-layers` + `entries` + `package`, 27 tests):** removing `./lib/ci-changed` from `exports` fails 2; adding an unlisted `src/lib/stray.ts` fails 1; making the layer filter in `allPackages` never fire fails 2 (the layers test); pointing `ci-changed`'s `changed-files` import at a missing file fails 1. Each restored from a copy (`cmp` identical) and the run is `27 passed` after.

Until the core row deletes the originals, two sources exist (the row's stated cost).
