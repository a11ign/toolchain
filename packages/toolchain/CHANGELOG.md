# @a11ign/toolchain

## 0.1.4

### Patch Changes

- b79cd46: New export `@a11ign/toolchain/mjs-ratchet`: the count of `.js`/`.mjs`/`.cjs` source files outside build output (`dist`, `build`, `node_modules`, `generated`) may only go down. A repository commits `mjs-ratchet.baseline.json` (the basenames of its files, so a move does not edit it, plus `exceptions` of `{ path, why }`) and its existing test calls `checkMjsRatchet({ from: fileURLToPath(import.meta.url) })`: a new file fails and is named, a drop passes, and `writeLoweredBaseline({ from })` lowers the baseline. An empty tree is red, and an empty baseline fails on any such file.

## 0.1.3

### Patch Changes

- a9b24d4: `libraryPreset` builds into `dist` without emptying it first (`output.cleanDistPath: false`). Rslib's default empties `dist` before every build, so a reader of `dist` in another process found a built file missing for the length of one build: 2.4% of reads on a package's `dist` (measured 2026-10-06, a11ign/a11ign#3580), 0 with it off. A package that set `cleanDistPath: false` itself can delete that override. A removed entry's old file is left behind locally; a publish builds from a clean checkout.

## 0.1.2

### Patch Changes

- f13b815: `libraryPreset` leaves `new URL("./x", import.meta.url)` as written. Rslib's default parser rewrote it to an asset (`./static/assets/…`) and emitted `dist/static/assets/…`, so a package that reads its own directory got the wrong answer from its build. A package that set `parser: { url: false }` itself can delete that rule.

## 0.1.1

### Patch Changes

- 3a417b5: First publish. `0.1.0` never reached the npm registry (its publish job was cancelled before any step ran), so this is the first version of the package a consumer can install. No source change.

## 0.1.0

### Minor Changes

- 8412968: First release from its own repository, `a11ign/toolchain` (ADR 0043). The one test and build toolchain every a11ign repository shares: the rstest config as a function of `root`, `include`, extra worker preloads and extra rerun triggers; the `node:test` shim and alias hook (each a built entry, loaded by path from `node_modules`); the `json` run record and the verdict reporter; the child-coverage merge; the Rslib library preset and the helper that derives a package's entries from its own `exports`; and the shared `tsconfig.base.json`. Licensed `Apache-2.0`.
