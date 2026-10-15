Closes a11ign/agent-org#1415

Acceptance:

```bash
cd /home/agent/repos/wt-toolchain-1415 && node --test src/refusal-owners-are-open.test.ts && git grep -q "export function ownersOf" -- src/refusal-owners-are-open.ts
```

The row's Acceptance names the primary checkout `/home/agent/repos/toolchain`, which is on `main` and cannot hold this file until this pull request merges. It runs from this branch's worktree, as #31 and #32 did.

**What it does.** The refusal-owner reader moves from the core's `scripts/refusal-owners-are-open.ts` (a11ign/a11ign#5333) to `src/refusal-owners-are-open.ts`, and is exported as `./refusal-owners-are-open` (types + default under `dist/`). `readIssueState` takes the repository a bare `#n` names as a required argument, so nothing in this package names a project (ADR 0045 rule 4). The core's live-tree and `ci.yml` step tests stay in the core: they read that repository's own files and are not part of the reader. The new test reads a tree it writes, so `refusalsInTree` is exercised without the core's files.

**Mutation (measured here, Node v24.21.0).** `failures` in `src/refusal-owners-are-open.ts` was broken two ways, and the file restored from a copy each time, `diff`ed byte-identical:
- (A) `finding.code !== "OPEN"` replaced by `finding.code === "CLOSED"` (a CANNOT_TELL owner passes): 2 tests fail, `an owner that could not be read is CANNOT_TELL and fails, never open` and `an owner reworded into parentheses ... fails`.
- (B) `failures` returns `all` (everything fails): 2 tests fail, `the same fixture with the owner OPEN passes` and `a qualified owner is read in ITS repository`.
Unmutated: `node --test src/refusal-owners-are-open.test.ts` exits 0 with 13 of 13 passing.
(C) The `./refusal-owners-are-open` entry removed from `package.json`: `src/package.test.ts`'s subpath test goes red, because it imports the reader BY ITS PACKAGE NAME from the build. `package.json` restored from a copy, diff-identical.

**Also green on this head:** `pnpm test` (`VERDICT pass: 409 tests in 35 files`, after `pnpm install --frozen-lockfile`), `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, and the subpath import lists the eight exported functions.

**Why the subpath test is in `src/package.test.ts`.** The subpath is what a consumer imports, so it is tested through the `exports` map, not the source file. That needs `dist`, which `pnpm test` builds first; the row's Acceptance runs the reader's own test file with no build, so the subpath test is kept out of that file.

**What the checks do NOT show.** The row's Done-when 1 is a release, which this pull request does not perform: the export is not on npm until toolchain's release run publishes it. The core and `a11ign/lab` copies are not deleted here; those are the two follow-up rows.
