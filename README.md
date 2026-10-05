# `a11ign/toolchain`

The home of [`@a11ign/toolchain`](packages/toolchain/README.md): the one test and build toolchain every a11ign repository shares (the rstest config, the
`node:test` shim, the run record and verdict line, the Rslib presets, the TypeScript base), published to npm from here.

It is the template the other repositories copy: TypeScript source, `tsc --noEmit` required, rstest on its own shared config, an Rslib build to `.mjs` plus
`.d.ts`, `Apache-2.0`, and a `gate` job that `main` requires. The decision is
[ADR 0043](https://github.com/a11ign/a11ign/blob/main/docs/adr/0043-one-toolchain-for-every-repository.md).

```
packages/toolchain/   the package: src/, rslib.config.ts, tsconfig.base.json
scripts/              release-plan.mjs (what a push to main means for the release), clean-consumer.ts (the installed-package check)
rstest.config.ts      this repository's own test config, a call into the built package
```

The package's history begins in `a11ign/a11ign` (`packages/toolchain`, #3578); its earlier life as `scripts/rstest/` stays there.
Issues are off; work is tracked in `a11ign/a11ign`.
