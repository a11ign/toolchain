# @a11ign/toolchain

## 0.1.0

### Minor Changes

- 70e6b9a: First release: the one test and build toolchain every a11ign repository shares (ADR 0043). The rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`.
