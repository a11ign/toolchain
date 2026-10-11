## What

`src/lib/ci-changed.ts` loses the `ansible` category end to end; `src/lib-tier-3.test.ts` asserts the CLI's output block names no `ansible` key, with `python` and `ts` as positive controls. A `minor` changeset releases it on merge.

Measured: the Acceptance command prints `VERDICT pass: 15 tests in 3 files` at this head. With `origin/main`'s `ci-changed.ts` restored, the new test fails; restored byte-identical.

Mutation: restored `ansible=${result.ansible}` via `origin/main`'s file -> `the output block names no ansible key` went red; reverted, green.

Acceptance: npx rstest run src/lib-tier-3.test.ts src/entries.test.ts src/package.test.ts
