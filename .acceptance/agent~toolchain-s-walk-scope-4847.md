Closes a11ign/a11ign#4847

Acceptance:

```bash
pnpm run build && pnpm exec rstest run src/lib/walk-scope && node --input-type=module -e 'import { createRequire } from "node:module"; const w = await import("./dist/lib/walk-scope.mjs"); const t = createRequire(process.cwd() + "/x.js")("node:test"); const u = Object.entries(t).filter(([k, v]) => typeof v === "function" && !w.isObserved(v) && !(k in w.NOT_WRAPPED.test)).map(([k]) => k); console.log(JSON.stringify(u)); process.exit(u.length ? 1 : 0);'
```

The second half is the consumer's enumeration test in miniature: every function `node:test` exports on this host that the module neither observes nor names in `NOT_WRAPPED.test`. It must print `[]` and exit 0.

**What it does.** `NOT_WRAPPED.test` in `src/lib/walk-scope.ts` names `expectFailure` and `getTestContext`, the two functions Node 24 added to `node:test`, each with the reason it reads no path, and a patch changeset names them and a11ign/a11ign#4843. The reasons were read from Node v24.21.0's own source (`require("node:test").expectFailure.toString()`): `expectFailure` is built by the same factory as `skip` and `todo` (it passes `{ [keyword]: true }` to `run`), and `getTestContext` returns the running test's context, or `undefined` outside a test or inside the reporter sentinel. No name was added that the enumeration does not report.

**Mutation (measured on this host, Node v24.21.0).** With `src/lib/walk-scope.ts` as on `origin/main`, the enumeration prints `["expectFailure","getTestContext"]` and exits 1; with this change it prints `[]` and exits 0. The file was restored from a copy and `diff` confirmed it byte-identical.

**What the toolchain's own tests do NOT show.** `rstest run src/lib/walk-scope` passes 24 tests in 2 files both before and after: the toolchain has no test enumerating `node:test`'s exports, so the red this fixes appears only in a consumer that lays the module. That gap is a separate row, not in this Region.

Also green on this head: `pnpm exec rstest run` (`VERDICT pass: 388 tests in 33 files`), `pnpm run lint`, `pnpm run typecheck`.

**Not in the diff:** the `node_modules` symlink that `agent/walk-scope-test-names-4843` committed (to `/home/agent/repos/wt-4587-toolchain/node_modules`); this branch was built from `origin/main` plus that branch's `src/lib/walk-scope.ts` and changeset only.
