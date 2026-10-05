# `@a11ign/toolchain`

The one test and build toolchain every a11ign repository shares ([ADR 0043](../../docs/adr/0043-one-toolchain-for-every-repository.md)):
the rstest config as a function of what differs per repository, the `node:test` shim that lets an existing suite run on rstest unedited, the run
record and verdict line, the Rslib presets, and the TypeScript base. It is a package and not a template because the config is eight recorded
decisions (the header of `src/rstest-config.mjs`), and five copies would drift.

Install it as a `devDependency` beside its peers: `@rstest/core` (`^0.12.3`), and `@rslib/core` (`^1.0.3`) if the repository builds. `@rstest/coverage-v8`
is an optional peer, for `merge-child-coverage` only.

## The test config

```js
// rstest.config.mjs
import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";

export default defineToolchainConfig({
  root: import.meta.dirname,
  include: ["src/**/*.test.ts"],
});
```

`root` and `include` are the whole of it. `preloads` adds `--import <path>` files for every worker, after this package's own hook, and `forceRerunTriggers`
adds the files that widen a `rstest run --changed` to the whole suite. Everything else (`forks` and isolated, the CI-only build cache, the local worker cap,
the `json` run record, the verdict line) is the same everywhere on purpose.

**The alias hook is loaded by path.** A worker is started with `--import <path to register-node-test-alias.mjs>` from `node_modules`, so each file a worker loads
is a BUILT `.mjs` entry in `exports`: Node refuses to strip types under `node_modules`. The config finds it next to itself.

## The Rslib presets

```ts
// rslib.config.ts
import { defineConfig } from "@rslib/core";
import { libraryPreset } from "@a11ign/toolchain/rslib-presets";
import pkg from "./package.json" with { type: "json" };

export default defineConfig(libraryPreset(pkg, { dir: import.meta.dirname }));
```

One entry per `exports` key, derived from the package's own `exports` map by `entriesFromExports`, so a subpath cannot be added to one and forgotten in the other.
`entryProblems(pkg, entries)` is the test a package runs to prove it, in both directions. A source may be `.ts` or `.mjs`; an `exports` key with no source throws.

## The TypeScript base

```json
{ "extends": "@a11ign/toolchain/tsconfig.base.json" }
```

`strict`, NodeNext, `declaration`; `declarationMap` and `sourceMap` off for a published package; no `composite`, `outDir` or `rootDir`.

## Building this package

`rslib build`, from its own directory. Its config imports `./src/rslib-presets.ts` by relative path and never its own `dist`, so it builds from a fresh clone before
any consumer does.
