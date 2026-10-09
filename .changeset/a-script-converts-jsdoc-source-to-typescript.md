---
"@a11ign/toolchain": minor
---

New export `@a11ign/toolchain/js-to-ts` and bin `js-to-ts`: `npx --yes --package @a11ign/toolchain js-to-ts` renames a repository's `.mjs`/`.cjs`/`.js` sources to `.ts` (`git mv`), converts their JSDoc to annotations with TypeScript's `annotateWithTypeFromJSDoc` fix, rewrites every path that named a renamed file (imports become `./x.ts`), runs `tsc --noEmit`, and prints the residue by file and error code. `--exclude <path>` (repeatable) skips a file or directory, `--dry-run` writes nothing, a second run changes nothing, and the files edited outside the converted set are printed. `typescript` 6.x is now an optional peer dependency; the command refuses under TypeScript 7, which has no JavaScript API.

The `js-to-ts` bin begins with `#!/usr/bin/env node`, so the one-line `npx --yes --package @a11ign/toolchain js-to-ts` form runs without `node` in front.
