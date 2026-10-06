# @a11ign/toolchain

## 0.1.2

### Patch Changes

- f13b815: `libraryPreset` leaves `new URL("./x", import.meta.url)` as written. Rslib's default parser rewrote it to an asset (`./static/assets/…`) and emitted `dist/static/assets/…`, so a package that reads its own directory got the wrong answer from its build. A package that set `parser: { url: false }` itself can delete that rule.

## 0.1.1

### Patch Changes

- 3a417b5: First publish. `0.1.0` never reached the npm registry (its publish job was cancelled before any step ran), so this is the first version of the package a consumer can install. No source change.

## 0.1.0

### Minor Changes

- 8412968: First release from its own repository, `a11ign/toolchain` (ADR 0043). The one test and build toolchain every a11ign repository shares: the rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`. Licensed `Apache-2.0`.
