---
"@a11ign/toolchain": patch
---

The one-line `npx --yes --package @a11ign/toolchain js-to-ts` runs on a cold npm cache: it loads `typescript` from the repository being converted (as it already did for the `tsc` typecheck), then from beside the package, instead of a static `import ts from "typescript"`. `typescript` is an optional peer that `npx` does not install, so the import exited `ERR_MODULE_NOT_FOUND`. With no `typescript` anywhere the command now exits `2` and names the install command. A test runs the packed tarball's bin with no `typescript` beside it.
