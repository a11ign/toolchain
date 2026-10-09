Closes a11ign/a11ign#4585

Acceptance:

```bash
cd /home/agent/repos/wt-4585-toolchain && pnpm exec rstest run src/lib-tier-1.test.ts src/entries.test.ts src/package.test.ts
```

The row's Acceptance names the primary checkout `/home/agent/repos/toolchain`, which has no `node_modules` and cannot hold this branch, so it runs from the branch's worktree (as #31 and #32 did). Run on `1f7e16c`: `VERDICT pass: 22 tests in 3 files`. Also green: `pnpm test` (`VERDICT pass: 360 tests in 29 files`), `pnpm run lint`, `tsc --noEmit`, `pnpm run pack-check` (43 paths, 46 files). The row's second line (`npm view @a11ign/toolchain exports --json | grep -q "./lib/git-env"`) passes only once the release workflow has published this version; it was not run and is not claimed.

**What it does.** The ten leaf helpers move verbatim from a11ign/a11ign to `src/lib/<stem>.ts` and are exported as `./lib/<stem>` (types + default under `dist/lib/`), with a changeset (minor) and a README section. `src/lib-tier-1.test.ts` names the ten, asserts they are exactly the sources under `src/lib/`, imports each, and asserts its manifest entry; `entries.test.ts` already checks exported-and-built in both directions.

**Edits to moved code (all listed):**
- `walk-scope-declaration.ts`: `@a11ign/evidence/source-text` is now `./source-text.ts`. `source-text.test.ts`: `./source-text.js` is now `./source-text.ts`.
- `worktree-resolution.test.ts`: three tests stayed in a11ign/a11ign because they test the core's caller, not the leaf (the two `#3447` tests call `memberScopeLister` from `assert-glob-not-empty.ts`; `#2218 THE CALLER` copies that file and `test-memory-cap.ts` into a constructed tree). Their imports went with them.
- `source-text.test.ts`'s ordinary-file control read core's `evidence/src/verify.ts` (150 leading-`//` lines). This package has no file that dense, so it reads `scripts/release-per-merge.ts` (36 measured) with the floor lowered 100 to 30. That is the one weakening, and it is stated.
- Known, left verbatim: `product-home`'s default `repoRoot` is computed from its own location, so as a published `dist/lib/product-home.mjs` a consumer must pass `repoRoot`; the README says so.

**Mutation (measured):** removing `./lib/git-env` from `exports` fails `lib-tier-1.test.ts` (1 of 17); adding an unlisted `src/lib/stray.ts` fails the list test; removing `src/lib/git-env.ts` fails 2 tests. Restored from a copy and each run clean after (`11 passed`).

Until the core row deletes the originals, two sources exist (the row's stated cost).
