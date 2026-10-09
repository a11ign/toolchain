---
"@a11ign/toolchain": patch
---

The repository's own `.mjs` are TypeScript, converted by its own `js-to-ts`: `eslint.config.ts` (ESLint 10 reads it through `jiti`, now a dev dependency), `scripts/changeset-required.ts` and `scripts/release-per-merge.ts`, which the workflows run with the runner's Node (type stripping, no install). The published package is unchanged. The ratchet baseline is empty, so any new `.js`/`.mjs`/`.cjs` fails `mjs-ratchet`, and `mjs-ratchet.repo.test.ts` pins that end state instead of a count above zero.
