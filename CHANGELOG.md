# @a11ign/toolchain

## 0.3.3

### Patch Changes

- 0084430: The one-line `npx --yes --package @a11ign/toolchain js-to-ts` runs on a cold npm cache: it loads `typescript` from the repository being converted (as it already did for the `tsc` typecheck), then from beside the package, instead of a static `import ts from "typescript"`. `typescript` is an optional peer that `npx` does not install, so the import exited `ERR_MODULE_NOT_FOUND`. With no `typescript` anywhere the command now exits `2` and names the install command. A test runs the packed tarball's bin with no `typescript` beside it.

## 0.3.2

### Patch Changes

- 306490b: The repository's own `.mjs` are TypeScript, converted by its own `js-to-ts`: `eslint.config.ts` (ESLint 10 reads it through `jiti`, now a dev dependency), `scripts/changeset-required.ts` and `scripts/release-per-merge.ts`, which the workflows run with the runner's Node (type stripping, no install). The published package is unchanged. The ratchet baseline is empty, so any new `.js`/`.mjs`/`.cjs` fails `mjs-ratchet`, and `mjs-ratchet.repo.test.ts` pins that end state instead of a count above zero.

## 0.3.1

### Patch Changes

- 3eef0c1: The one-line `npx --yes --package @a11ign/toolchain layout-check` resolves on a cold npm cache again: the optional `typescript` peer is `^6.0.3 || ^7.0.0`, not `^6.0.3`. 0.2.0 and 0.3.0 exited 1 with `ERESOLVE`, because `@rslib/core` peers `typescript` `^5 || ^6 || ^7`, npm takes the newest (7.x), and the toolchain's own peer excluded it. 0.1.8 had no `typescript` peer and ran. A test now pins the README line and the peer against the other declared peers' `typescript` ranges.

## 0.3.0

### Minor Changes

- 3b81a2b: `tsconfig.base.json` now sets `erasableSyntaxOnly` and `rewriteRelativeImportExtensions`, as ADR 0043 Decision 8 assigns it. A repository extending the base can type-check the `./x.ts` imports `js-to-ts` writes, and is refused an enum, a namespace or a parameter property (TS1294), the syntax a host's type-stripping Node will not run. A consumer meets the second the day it bumps to this release: fix the declaration (a class with a parameter property becomes a field and an assignment in the constructor), or set `"erasableSyntaxOnly": false` in its own `tsconfig.json` until it does.

## 0.2.0

### Minor Changes

- 7f47388: New export `@a11ign/toolchain/js-to-ts` and bin `js-to-ts`: `npx --yes --package @a11ign/toolchain js-to-ts` renames a repository's `.mjs`/`.cjs`/`.js` sources to `.ts` (`git mv`), converts their JSDoc to annotations with TypeScript's `annotateWithTypeFromJSDoc` fix, rewrites every path that named a renamed file (imports become `./x.ts`), runs `tsc --noEmit`, and prints the residue by file and error code. `--exclude <path>` (repeatable) skips a file or directory, `--dry-run` writes nothing, a second run changes nothing, and the files edited outside the converted set are printed. `typescript` 6.x is now an optional peer dependency; the command refuses under TypeScript 7, which has no JavaScript API.
  
  The `js-to-ts` bin begins with `#!/usr/bin/env node`, so the one-line `npx --yes --package @a11ign/toolchain js-to-ts` form runs without `node` in front.

## 0.1.8

### Patch Changes

- 0222c1a: The `layout-check` bin begins with `#!/usr/bin/env node` and is executable, so the one-line `npx --yes --package @a11ign/toolchain layout-check` form works: 0.1.5 shipped it without, `sh` read `import { … }` as a command and exited 2 (`import: not found`). A test now runs every `bin` through a symlink with no `node` in front, as npx does.

## 0.1.7

### Patch Changes

- c6c55fb: The release packs a built `dist` again. Flattening the package to the repository root dropped its `prepack`, so 0.1.6 was published with 4 files and every `exports` target and the `layout-check` bin pointed at a directory it did not hold. `package.json` has `"prepack": "rslib build"` back, and CI's `checks` job runs `pnpm run pack-check`, which refuses a tarball missing any `exports` target or `bin` path, read from `npm pack --dry-run --json` after removing `dist`. The layout check in CI runs the build of the tree rather than the registry's `latest`. Use 0.1.5 or 0.1.7 and later; 0.1.6 is unusable.

## 0.1.6

### Patch Changes

- 376254e: The repository holds the package at its root: `src/`, `rslib.config.ts`, `tsconfig.base.json` and the one README no longer sit under `packages/toolchain/`, and the workspace file and the second README are gone. The published package is unchanged: every `exports` key, the `layout-check` bin and `tsconfig.base.json` keep their names. The manifest drops `repository.directory`, and CI runs the published `layout-check` on the repository's own tree.

## 0.1.0

### Minor Changes

- 8412968: First release from its own repository, `a11ign/toolchain` (ADR 0043). The one test and build toolchain every a11ign repository shares: the rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`. Licensed `Apache-2.0`.
