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

## The `.mjs` ratchet

The count of `.js`/`.mjs`/`.cjs` source files may only go down (ADR 0043: source is `.ts`; `.mjs` is build output). A repository commits `mjs-ratchet.baseline.json` at its root and adds
one test its existing `test` command already runs, so no workflow file is touched:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkMjsRatchet } from "@a11ign/toolchain/mjs-ratchet";

test("the .mjs count only goes down", () => {
  const result = checkMjsRatchet({ from: fileURLToPath(import.meta.url) });
  assert.ok(result.ok, result.message);
});
```

`from` is the test file (or any directory under the root): the baseline is found by walking up to `mjs-ratchet.baseline.json`, so moving the test edits nothing, and a repository with a `.git` and no baseline throws rather than borrowing its parent's.

**Build output** is one constant, `BUILD_OUTPUT_DEFINITION`, printed whenever the check fails: a file ending `.js`, `.mjs` or `.cjs` is SOURCE unless one of its directory segments is exactly `dist`, `build`, `node_modules` or `generated`.
Tests count (a `.test.mjs` is source); a `.d.ts` is not a `.js`. The files come from `git ls-files` (tracked, plus untracked and not ignored) where the root has a `.git`, else from a walk of the directory with the same exclusions, so the
check reads the same in a checkout and in a copy laid under another project. A tree with no file but the baseline is RED, never a count of zero.

```json
{ "files": ["eslint.config.ts", "release.mjs"], "exceptions": [{ "path": ".pnpmfile.cjs", "why": "pnpm reads only this name" }] }
```

- `files` is the multiset of **basenames**, so a layout move does not edit it. A basename absent from it, or present more often than listed, fails and names the file(s). **A drop passes** and says the baseline can be lowered.
- `exceptions` is for a file whose tool reads only that name. An entry without a `why` fails, and so does an entry naming a path the tree no longer holds (so the allowance cannot outlive the file). Exceptions are not counted.
- At zero, `files` is `[]` and **any** such file fails: no standing allowance but the named exceptions.
- `writeLoweredBaseline({ from })` rewrites the baseline to what the tree holds now, and **throws instead of raising** it. A repository adds it as a script, e.g. `"mjs-ratchet:lower": "tsx -e \"import { writeLoweredBaseline } from '@a11ign/toolchain/mjs-ratchet'; console.log(writeLoweredBaseline({ from: process.cwd() }))\""`; this repository's is `pnpm run mjs-ratchet:lower`.

## The layout check

A single-package repository has its package at the ROOT (one README, one `package.json`, no workspace file); a multi-package repository exists only when it **publishes** more than one package, each directory named for its package (ADR 0043, Decision 7). The check fails on exactly four things and prints WHICH, with the path:

| Check | Fails on |
|---|---|
| `workspace-of-one` | a `pnpm-workspace.yaml` (or `workspaces` field) whose members are one package, counting the root when the file names it. A private `*-workspace` root is a shell, not a package, and a private member beside one published package does not make a multi-package repository |
| `directory-name` | a workspace member whose directory is not the part of its package name after the scope (`packages/pdf` holding `@a11ign/documents`) |
| `second-readme` | a root README and `<member>/README.md` for one package (same name, or a shell root over a single member). A README in a SUBDIRECTORY documents a part and is never read |
| `leftover` | a `lerna.json`, or a private `*-workspace` root `package.json` that holds fewer than two published packages |

**The one line a consumer's `ci.yml` runs** (exit `0` clean, `1` a layout failure, `2` nothing could be read; an empty tree is `2`, never a pass):

```yaml
- run: npx --yes --package @a11ign/toolchain layout-check
```

It resolves on a cold npm cache with no flag: `typescript` is an optional peer that admits `^6.0.3 || ^7.0.0`, because `@rslib/core` peers `^5 || ^6 || ^7` and npm takes the newest, so a `^6.0.3` peer made `npx` exit 1 with `ERESOLVE` from 0.2.0 to 0.3.0 (`scripts/npx-one-liner.test.ts` pins the two together). With the package installed, `pnpm exec layout-check [directory]` is the same. The directory defaults to the working directory and is read with `git ls-files` in a working tree, else by a walk, both ignoring `node_modules`. A failure reads:

```
layout-check: FAIL [directory-name] packages/pdf: packages/pdf holds @a11ign/documents, so its directory should be named "documents", not "pdf"
```

From code, `checkLayout({ root })` and `checkLayoutTree({ "path": "text" })` (a tree listing, with text only for `package.json`, `pnpm-workspace.yaml` and `lerna.json`) return `{ ok, problems: [{ check, path, message }], message, fileCount }`.
It does not read `lerna.json`'s own `packages` as a workspace, and it does not yet read a README sentence as the allowance for a stated departure (ADR 0043).

## The JS-to-TS conversion

JSDoc source becomes TypeScript by a script, and an agent fixes only what the script reports as residue (ADR 0043). **The one line** (run it from the repository root; it needs `typescript` 6.x, which the repository already has):

```
npx --yes --package @a11ign/toolchain js-to-ts [directory] [--exclude <path>]... [--dry-run] [--json]
```

It renames every `.mjs`/`.cjs`/`.js` source outside `node_modules`, `dist` and `build` to `.ts` (`git mv`, so history follows), applies TypeScript's `annotateWithTypeFromJSDoc` fix to each (an optional `@param {T} [x]` becomes `x?: T`), rewrites every path that names a renamed file to its new name (an import becomes `./x.ts`), runs the repository's own `tsc --noEmit`, and prints the **residue**: each file still failing, with its error codes and counts. Chosen over `ts-migrate`, which writes `x: any` for every parameter so the project typechecks and the types are gone (measured 2026-10-09 in the source header).

- `--exclude <path>` (repeatable; a file or a directory) leaves it alone and lists it as skipped: use it for a file a deployed unit or an Ansible task names by path.
- `--dry-run` writes nothing and says what it would rename.
- Files edited OUTSIDE the converted set are printed: they are the pull request's `Outside-Region:` lines. A reference it did not rewrite (a bare name that may be another file, a path inside a template literal, a `CHANGELOG`) is printed too.
- A second run changes nothing and reports the same residue. Exit `0` clean, `1` residue remains, `2` nothing could be read or a misspelt flag; an empty tree is `2`, never a pass.
- TypeScript 7 has no JavaScript API (a11ign/a11ign#3729), so under it the command refuses with that sentence. A `@typedef` or an untyped parameter is not converted; it is residue (`TS2304`, `TS7006`).

## The TypeScript base

```json
{ "extends": "@a11ign/toolchain/tsconfig.base.json" }
```

`strict`, NodeNext, `declaration`; `declarationMap` and `sourceMap` off for a published package; no `composite`, `outDir` or `rootDir`.

## Building and checking this package

Everything runs from the repository root (`pnpm install` first). The package IS the repository: one `package.json`, one README (this one, also the npm page), no workspace file.

| command | what it does |
|---|---|
| `pnpm run build` | `rslib build`: one `.mjs` and one `.d.ts` per `exports` key into `dist`. Its config imports `./src/rslib-presets.ts` by relative path and never its own `dist`, so it builds from a fresh clone. |
| `pnpm run typecheck` | `tsc --noEmit` (`tsconfig.json`) over every `.ts` in the repository, tests included; the declarations Rslib emits come from `tsconfig.build.json`, which leaves the tests out (builds first: the repository's own `rstest.config.ts` imports the built package). |
| `pnpm run lint` | ESLint, the Clean Code limits. |
| `pnpm test` | `rstest run` on this repository's own config, which is `defineToolchainConfig` from the BUILT package. |
| `pnpm run consumer-check` | packs the tarball, installs it into an empty project, imports every `exports` specifier, runs a consumer `tsc` with `skipLibCheck` false, and runs `rstest run` on a one-test project, which must print `VERDICT pass`. `pnpm exec tsx scripts/clean-consumer.ts @a11ign/toolchain@<version>` does the same against a published version. |

CI's one required job, `gate`, runs all five and the published `layout-check` on this repository's own tree. A release is a changeset (`pnpm exec changeset`), the **Version packages** pull request `release.yml` opens
for it, and that pull request's merge, which publishes with npm trusted publishing (OIDC) and provenance: no token is stored anywhere.

```
src/                  the package: one module per `exports` key, each beside its test
scripts/              release-per-merge.ts (what a push to main means for the release), clean-consumer.ts (the installed-package check)
rstest.config.ts      this repository's own test config, a call into the built package
```

The package's history begins in `a11ign/a11ign` (#3578); its earlier life as `scripts/rstest/` stays there. Issues are off; work is tracked in `a11ign/a11ign`.

## Licence

`Apache-2.0`. A test and build config that every repository imports must not pass copyleft terms to its importers.
