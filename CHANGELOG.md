# @a11ign/toolchain

## 0.1.6

### Patch Changes

- 376254e: The repository holds the package at its root: `src/`, `rslib.config.ts`, `tsconfig.base.json` and the one README no longer sit under `packages/toolchain/`, and the workspace file and the second README are gone. The published package is unchanged: every `exports` key, the `layout-check` bin and `tsconfig.base.json` keep their names. The manifest drops `repository.directory`, and CI runs the published `layout-check` on the repository's own tree.

## 0.1.0

### Minor Changes

- 8412968: First release from its own repository, `a11ign/toolchain` (ADR 0043). The one test and build toolchain every a11ign repository shares: the rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`. Licensed `Apache-2.0`.
