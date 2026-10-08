---
"@a11ign/toolchain": patch
---

The repository holds the package at its root: `src/`, `rslib.config.ts`, `tsconfig.base.json` and the one README no longer sit under `packages/toolchain/`, and the workspace file and the second README are gone. The published package is unchanged: every `exports` key, the `layout-check` bin and `tsconfig.base.json` keep their names. The manifest drops `repository.directory`, and CI runs the published `layout-check` on the repository's own tree.
