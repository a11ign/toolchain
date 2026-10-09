# @a11ign/toolchain

## 0.1.7

### Patch Changes

- c6c55fb: The release packs a built `dist` again. Flattening the package to the repository root dropped its `prepack`, so 0.1.6 was published with 4 files and every `exports` target and the `layout-check` bin pointed at a directory it did not hold. `package.json` has `"prepack": "rslib build"` back, and CI's `checks` job runs `pnpm run pack-check`, which refuses a tarball missing any `exports` target or `bin` path, read from `npm pack --dry-run --json` after removing `dist`. The layout check in CI runs the build of the tree rather than the registry's `latest`. Use 0.1.5 or 0.1.7 and later; 0.1.6 is unusable.

## 0.1.6

### Patch Changes

- 376254e: The repository holds the package at its root: `src/`, `rslib.config.ts`, `tsconfig.base.json` and the one README no longer sit under `packages/toolchain/`, and the workspace file and the second README are gone. The published package is unchanged: every `exports` key, the `layout-check` bin and `tsconfig.base.json` keep their names. The manifest drops `repository.directory`, and CI runs the published `layout-check` on the repository's own tree.

## 0.1.0

### Minor Changes

- 8412968: First release from its own repository, `a11ign/toolchain` (ADR 0043). The one test and build toolchain every a11ign repository shares: the rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`. Licensed `Apache-2.0`.
