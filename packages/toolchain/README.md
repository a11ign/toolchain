# `@a11ign/toolchain`

The one test and build toolchain every a11ign repository shares ([ADR 0043](https://github.com/a11ign/a11ign/blob/main/docs/adr/0043-one-toolchain-for-every-repository.md)):
the rstest config as a function of what differs per repository, the `node:test` shim that lets an existing suite run on rstest unedited, the run
record and verdict line, the Rslib presets, and the TypeScript base. It is a package and not a template because the config is eight recorded
decisions (the header of `src/rstest-config.ts`), and five copies would drift.

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

**The preset leaves `new URL("./x", import.meta.url)` as written** (a11ign/a11ign#3735): Rslib's default parser builds that form into an asset and rewrites the URL to `./static/assets/…`, so a package that reads its own directory would get the wrong answer from its build. The preset sets `parser: { url: false }` for `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` sources, so a package does NOT set it in its own `rslib.config`. A package that hand-wrote this rule (`screenreader-worker` did) can delete its copy on upgrading.

**The preset builds into `dist` without emptying it** (a11ign/a11ign#3580): `output.cleanDistPath: false`. Rslib's default empties `dist` before every build, and a `prepack` runs one whenever anything packs a package, so another process reading `dist` (a test file in the same suite) found a built file missing for the length of the build: 5,735 of 239,434 reads (2.4%) in one build of a package, 0 of about 700,000 with it off (measured 2026-10-06). A package does NOT set it in its own `rslib.config`. A build overwrites in place, so a removed entry's old file stays behind locally; a publish builds from a clean checkout.

## The TypeScript base

```json
{ "extends": "@a11ign/toolchain/tsconfig.base.json" }
```

`strict`, NodeNext, `declaration`; `declarationMap` and `sourceMap` off for a published package; no `composite`, `outDir` or `rootDir`.

## Building and checking this package

Everything runs from the repository root (`pnpm install` first):

| command | what it does |
|---|---|
| `pnpm run build` | `rslib build`: one `.mjs` and one `.d.ts` per `exports` key into `packages/toolchain/dist`. Its config imports `./src/rslib-presets.ts` by relative path and never its own `dist`, so it builds from a fresh clone. |
| `pnpm run typecheck` | `tsc --noEmit` over every `.ts` in the repository, tests included (builds first: the repository's own `rstest.config.ts` imports the built package). |
| `pnpm run lint` | ESLint, the Clean Code limits. |
| `pnpm test` | `rstest run` on this repository's own config, which is `defineToolchainConfig` from the BUILT package. |
| `pnpm run consumer-check` | packs the tarball, installs it into an empty project, imports every `exports` specifier, runs a consumer `tsc` with `skipLibCheck` false, and runs `rstest run` on a one-test project, which must print `VERDICT pass`. `pnpm exec tsx scripts/clean-consumer.ts @a11ign/toolchain@<version>` does the same against a published version. |

CI's one required job, `gate`, runs all five. A release is a changeset (`pnpm exec changeset`), the **Version packages** pull request `release.yml` opens
for it, and that pull request's merge, which publishes with npm trusted publishing (OIDC) and provenance: no token is stored anywhere.

## Licence

`Apache-2.0`. A test and build config that every repository imports must not pass copyleft terms to its importers.
