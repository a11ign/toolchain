Closes a11ign/a11ign#4851

Acceptance:

```bash
pnpm run build && pnpm exec rstest run src/lib/walk-scope
```

Prints `VERDICT pass: 28 tests in 3 files` on this head (Node v24.21.0), the 24 that were there plus the 4 this adds in `src/lib/walk-scope.test.ts`.

**What it does.** `src/lib/walk-scope.test.ts` enumerates the host's own `fs`, `fs.promises`, `child_process`, `node:test`, `node:module`, `process` and `worker_threads`, and fails on every function that `isObserved` does not report and the matching `NOT_WRAPPED` table does not name, printing `label.name` for each. It lists no Node export: the surfaces are read from the process running the test, so it holds on Node 22 (no `expectFailure`) and Node 24 alike. The six modules beyond `node:test` were as cheap as `node:test` (the same loop), so all seven are covered.

**Positive controls** (so the empty list is not what it returns for everything), each measuring only the names its own change adds, so a real gap on a host cannot turn a control red:
- dropping any one name from any `NOT_WRAPPED` table makes the enumeration report exactly the functions that name covers (for `fs`, both `x` and `xSync`), and each surface must have at least one such function;
- a function added to a copy of any surface is reported;
- `node:test`'s `run` is accounted for by `isObserved` and is on no table, so the wrapped arm of the filter is exercised.

**Fails before, passes after (measured on this host, Node v24.21.0).** With `src/lib/walk-scope.ts` as at `ab60ac6` (before #4847), the enumeration test fails with `['test.expectFailure', 'test.getTestContext']` and the other three pass; with `main`, which carries the two names, all four pass.

**Mutation, both directions (measured; each file restored from a copy and `diff` confirmed byte-identical).**

| Mutation | Result |
|---|---|
| drop `expectFailure` from `NOT_WRAPPED.test` | the enumeration test alone fails, naming `test.expectFailure`; the controls stay green |
| `isObserved` always `false` | the enumeration test fails (every wrapped function reported) and the `run` test fails |
| `isObserved` always `true` for functions | the enumeration test PASSES, as a vacuous one would; the drop-one control fails ("no function is accounted for by NOT_WRAPPED alone") and so does the growth control |
| the test's "is named" check always true | the drop-one and growth controls fail; the enumeration test passes, which is what the controls are for |
| the test's "is named" check never true | the enumeration test fails on every named function, and the drop-one control fails |

**Not done, named.** The reverse drift (a name on `NOT_WRAPPED` for a function that is now wrapped) is checked by lab's `declared-walk-scope.test.ts` as `listedYetWrapped` and is not added here: the row asks for the unaccounted direction. A name on `NOT_WRAPPED` that this host does not export (`expectFailure` on Node 22) is legitimate and is not asserted either way.

Also green on this head: `pnpm exec rstest run` (`VERDICT pass: 392 tests in 34 files`), `pnpm run lint`, `pnpm run typecheck`.
