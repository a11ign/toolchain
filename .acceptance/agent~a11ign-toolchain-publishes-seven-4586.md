Closes a11ign/a11ign#4586

Acceptance:

```bash
cd /home/agent/repos/wt-4586-toolchain && pnpm exec rstest run src/lib-tier-2.test.ts src/entries.test.ts src/package.test.ts
```

The row's Acceptance names the primary checkout `/home/agent/repos/toolchain`, which has no `node_modules` and cannot hold this branch, so it runs from the branch's worktree (as #31, #32 and #33 did). Also green on this head: `pnpm test` (`VERDICT pass: 380 tests in 31 files`), `pnpm run lint`, `tsc --noEmit`, `pnpm run pack-check` (57 paths, 60 files). The row's second line (`npm view @a11ign/toolchain exports --json | grep -q "./lib/walk-scope"`) passes only once the release workflow has published this version; it was not run and is not claimed.

**What it does.** Seven helpers move from a11ign/a11ign to `src/lib/<stem>.ts` and are exported as `./lib/<stem>`: `changed-files`, `changed-packages` (with its test), `git-sandbox`, `local-import-closure`, `test-memory-cap`, `tree-wide-guard`, `walk-scope`. A changeset (minor), a README paragraph, and `src/lib-tier-2.test.ts`, which names the seven, imports each from source and asserts its manifest entry.

**Edits to moved code (all listed):**
- `../../../scripts/cli-flags.ts`, `../../../scripts/npm-cli-executable.ts` and `../../packages/guards/src/git-env.ts` are now `./cli-flags.ts`, `./npm-cli-executable.ts`, `./git-env.ts`.
- `changed-packages` and `walk-scope` computed their repository root as `../../../` from `packages/guards/src/`; from `src/lib/` the same meaning is `../../` (this package's root), so that is what they use. `changed-packages.test.ts` follows: its fixture copies the module and its three imports to `src/lib/` in a throwaway repository.
- **`walk-scope` imported `knownPackages` from the core's `scripts/ci-changed.ts`, which is row 3 (#4587) and not published.** The row's premise (the seven import only the ten) missed this one. The copy now carries its own `knownPackages` (same `git ls-files packages` derivation, same single-glob refusal), with a comment saying it can import `./lib/ci-changed` once that exists. Assumption made without asking: restating 12 lines beat blocking on row 3, which depends on this row's `changed-files`/`changed-packages`.
- **Outside the row's Region:** `src/lib-tier-1.test.ts`. Its list test asserted that the ten are EVERY source under `src/lib/`, which is false the moment any later row lands. It now asserts each of the ten has a source; the converse (every source under `src/lib/` is exactly a manifest `./lib/*` export, both tiers) moved to `lib-tier-2.test.ts`, with a positive control that the population is larger than the seven. Without this edit `pnpm test` is red.
- Known, left verbatim: the copies' default roots still come from their own location, so a built `dist/lib/*.mjs` resolves them under the install; a consumer passes a root where one is accepted.

**Mutation (measured, `lib-tier-1` + `lib-tier-2` + `entries` + `package`, 30 tests):** removing `./lib/walk-scope` from `exports` fails 2; adding an unlisted `src/lib/stray.ts` fails 1 (the sources/exports test); deleting `src/lib/git-sandbox.ts` fails 2. Each restored from a copy (`cmp` identical) and the run is `30 passed` after.

Until the core row (#4590) deletes the originals, two sources exist (the row's stated cost).
