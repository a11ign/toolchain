/**
 * `walk-scope.ts` (#929) wraps every route to the tree it can, and NAMES the rest in `NOT_WRAPPED` with the reason each cannot read a path unseen.
 * "Every route" is only a claim a test checks if the test asks the HOST's own objects, so a function a later Node adds fails a test instead of
 * passing a guard. This toolchain had no such test: it passed 24 tests in 2 files while `node:test` carried two functions `NOT_WRAPPED` did not
 * name (`expectFailure` and `getTestContext`, Node 24), and the first red was in a consumer that lays the module (a11ign/a11ign#4843, #4851).
 *
 * What is pinned:
 *   1. EVERY function on `fs`, `fs.promises`, `child_process`, `node:test`, `node:module`, `process` and `worker_threads`, on whichever Node runs this,
 *      is wrapped (`isObserved`) or named in `NOT_WRAPPED`. The failure prints the names, so the remedy is a table row, not an investigation.
 *   2. THE POSITIVE CONTROLS, so an empty list is not what the enumeration returns for everything: dropping any one name from `NOT_WRAPPED` makes the
 *      enumeration report exactly the functions that name covers, and a function added to a surface is reported.
 *   3. The OTHER arm of the filter is exercised: `node:test`'s `run` is accounted for by being wrapped, and is on no table.
 *
 * Nothing here lists Node's exports. The tables are `NOT_WRAPPED`'s own, and the surfaces are read from the process that is running the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NOT_WRAPPED, isObserved } from "./walk-scope.ts";

// `require`, not `import`: the CommonJS exports objects are the ones `walk-scope.ts` wraps. Under rstest an ESM `node:test` is the runner's shim,
// which is not the object a declarer's `require` reaches, so enumerating it would check the wrong object.
const require = createRequire(import.meta.url);

type Reasons = Readonly<Record<string, string>>;

interface Surface {
  label: string;
  members: Record<string, unknown>;
  reasons: Reasons;
  /** `NOT_WRAPPED.fs` is keyed without `Sync`, so `writeFileSync` is named by `writeFile`. */
  reasonKey: (exported: string) => string;
}

const sameName = (exported: string) => exported;
const withoutSync = (exported: string) => exported.replace(/Sync$/, "");

function hostSurfaces(): Surface[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const asMembers = (value: unknown) => value as Record<string, unknown>;
  return [
    { label: "fs", members: asMembers(fs), reasons: NOT_WRAPPED.fs, reasonKey: withoutSync },
    { label: "fs.promises", members: asMembers(fs.promises), reasons: NOT_WRAPPED.fs, reasonKey: withoutSync },
    { label: "child_process", members: asMembers(require("node:child_process")), reasons: NOT_WRAPPED.child_process, reasonKey: sameName },
    { label: "test", members: asMembers(require("node:test")), reasons: NOT_WRAPPED.test, reasonKey: sameName },
    { label: "module", members: asMembers(require("node:module")), reasons: NOT_WRAPPED.module, reasonKey: sameName },
    { label: "process", members: asMembers(process), reasons: NOT_WRAPPED.process, reasonKey: sameName },
    { label: "worker_threads", members: asMembers(require("node:worker_threads")), reasons: NOT_WRAPPED.worker_threads, reasonKey: sameName },
  ];
}

const functionsOn = ({ members }: Surface) => Object.entries(members).filter(([, value]) => typeof value === "function");

/** `label.name` for every function the surface exports that is neither wrapped nor named: the ones a guard could call and the observer not see. */
function unaccounted(surface: Surface): string[] {
  return functionsOn(surface)
    .filter(([name, value]) => !isObserved(value) && !Object.hasOwn(surface.reasons, surface.reasonKey(name)))
    .map(([name]) => `${surface.label}.${name}`);
}

/** The functions only `NOT_WRAPPED` accounts for on this host: named there, and not wrapped. Dropping one from the table must un-account for it. */
function namedAndUnwrapped(surface: Surface): string[] {
  return functionsOn(surface)
    .filter(([name, value]) => !isObserved(value) && Object.hasOwn(surface.reasons, surface.reasonKey(name)))
    .map(([name]) => name);
}

const without = (reasons: Reasons, key: string): Reasons => Object.fromEntries(Object.entries(reasons).filter(([name]) => name !== key));

/** What `changed` reports that `surface` does not: a control measures its own change, so a real gap on this host cannot turn it red. */
function reportedOnlyBecause(changed: Surface, surface: Surface): string[] {
  const already = new Set(unaccounted(surface));
  return unaccounted(changed).filter((name) => !already.has(name));
}

test("EVERY function on fs, child_process, node:test, node:module, process and worker_threads is wrapped, or named in NOT_WRAPPED", () => {
  const missing = hostSurfaces().flatMap(unaccounted);
  assert.deepEqual(missing, [],
    `${process.version} exports these, and the observer neither wraps them nor names them in NOT_WRAPPED with the reason each cannot read a path unseen: `
    + "wrap one that can read a path, and name one that cannot");
});

test("dropping any one name from NOT_WRAPPED makes the enumeration report it -- the emptiness above is not what it returns for everything", () => {
  for (const surface of hostSurfaces()) {
    const named = namedAndUnwrapped(surface);
    assert.ok(named.length > 0, `${surface.label}: no function is accounted for by NOT_WRAPPED alone, so there is nothing to drop`);
    for (const key of new Set(named.map(surface.reasonKey))) {
      const covered = named.filter((name) => surface.reasonKey(name) === key).map((name) => `${surface.label}.${name}`);
      const dropped = { ...surface, reasons: without(surface.reasons, key) };
      assert.deepEqual(reportedOnlyBecause(dropped, surface), covered, `${surface.label}: NOT_WRAPPED without "${key}"`);
    }
  }
});

test("a function a later Node adds to a surface is reported, on every surface", () => {
  for (const surface of hostSurfaces()) {
    const grown = { ...surface, members: { ...surface.members, aRouteALaterNodeAdds: () => {} } };
    assert.deepEqual(reportedOnlyBecause(grown, surface), [`${surface.label}.aRouteALaterNodeAdds`]);
  }
});

test("a WRAPPED function needs no reason: node:test's run is accounted for by isObserved, and is on no table", () => {
  const nodeTest = require("node:test") as { run: unknown };
  assert.equal(typeof nodeTest.run, "function");
  assert.ok(isObserved(nodeTest.run), "walk-scope.ts no longer wraps node:test's run, so this test no longer exercises the wrapped arm");
  assert.equal(Object.hasOwn(NOT_WRAPPED.test, "run"), false);
  assert.equal(unaccounted({ label: "test", members: nodeTest as Record<string, unknown>, reasons: NOT_WRAPPED.test, reasonKey: sameName }).includes("test.run"), false);
});
