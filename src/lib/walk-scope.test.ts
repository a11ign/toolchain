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
 *   4. WHOSE TREE IS OBSERVED (#4873): `A11IGN_PROJECT_ROOT` names the project, so a consumer can import this module instead of copying it. Each
 *      case runs in its OWN process, because `REPO_ROOT` is fixed when the module is imported and a second import here would measure this process.
 *
 * Nothing here lists Node's exports. The tables are `NOT_WRAPPED`'s own, and the surfaces are read from the process that is running the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// ---------------------------------------------------------------------------------------------------------
// 4. WHOSE TREE IS OBSERVED -- `A11IGN_PROJECT_ROOT`, read once, when the module is imported.

const TOOLCHAIN_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
/** A read of the toolchain's own tree, so the control has something outside the project to read: its `package.json` is repo-relative `package.json`. */
const OWN_FILE = join(TOOLCHAIN_ROOT, "package.json");

/**
 * What the module under test is loaded from. The source when this Node strips types, because that is the code that changed; the built file
 * otherwise (the agent host's 22.22.1 has no `process.versions.amaro`), which `pnpm test` rebuilds first and the config imports regardless.
 */
const CHILD_TARGET = process.versions.amaro !== undefined
  ? { file: fileURLToPath(new URL("./walk-scope.ts", import.meta.url)), flags: ["--experimental-strip-types", "--no-warnings"] }
  : { file: join(TOOLCHAIN_ROOT, "dist", "lib", "walk-scope.mjs"), flags: [] };

/** Runs in the child: import the module, read one file inside the named project and one of the toolchain's own, and say what it saw. */
const OBSERVE = `
import fs from "node:fs";
const { REPO_ROOT, readsSoFar } = await import(process.argv[1]);
for (const path of process.argv.slice(2)) fs.readFileSync(path);
process.stdout.write(JSON.stringify({ root: REPO_ROOT, reads: readsSoFar() }));
`;

interface Observed { status: number | null; stderr: string; root?: string; reads?: string[] }

/** `projectRoot: undefined` leaves the variable unset, which is the ordinary case and the negative control. */
function observeIn(projectRoot: string | undefined, reading: string[]): Observed {
  const env = { ...process.env };
  delete env.A11IGN_PROJECT_ROOT;
  if (projectRoot !== undefined) env.A11IGN_PROJECT_ROOT = projectRoot;
  const run = spawnSync(process.execPath, [...CHILD_TARGET.flags, "--input-type=module", "-e", OBSERVE, pathToFileURL(CHILD_TARGET.file).href, ...reading],
    { cwd: tmpdir(), env, encoding: "utf8" });
  const { status, stderr } = run;
  return status === 0 ? { status, stderr, ...JSON.parse(run.stdout) } : { status, stderr };
}

/** A temporary project: one file the guard under test would read. Removed after, with the directory named by this call alone. */
function withProject<T>(body: (project: string, inside: string) => T): T {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "walk-scope-project-")));
  const inside = join(project, "docs", "notes.md");
  mkdirSync(join(project, "docs"));
  writeFileSync(inside, "a file in the project\n");
  try {
    return body(project, inside);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("with A11IGN_PROJECT_ROOT set, a read inside the project is recorded and a read of the toolchain's own tree is not", () => {
  withProject((project, inside) => {
    const seen = observeIn(project, [inside, OWN_FILE]);
    assert.equal(seen.status, 0, `the child failed to import the module: ${seen.stderr}`);
    assert.equal(seen.root, project, "REPO_ROOT is the project, not the directory above the module");
    assert.deepEqual(seen.reads, ["docs/notes.md"], "the project's file is recorded relative to the project; the toolchain's own package.json is no read of it");
  });
});

test("with it unset, REPO_ROOT is the package-relative root and the project's file is the one that is not observed", () => {
  withProject((_project, inside) => {
    const seen = observeIn(undefined, [inside, OWN_FILE]);
    assert.equal(seen.status, 0, `the child failed to import the module: ${seen.stderr}`);
    assert.equal(seen.root, TOOLCHAIN_ROOT);
    assert.deepEqual(seen.reads, ["package.json"], "the control above is only a control if this arm sees the opposite file");
  });
});

test("a project root that is a link is resolved to the real directory, as the package-relative root is", () => {
  withProject((project, inside) => {
    const link = `${project}-link`;
    symlinkSync(project, link);
    try {
      const seen = observeIn(link, [join(link, "docs", "notes.md")]);
      assert.equal(seen.status, 0, seen.stderr);
      assert.equal(seen.root, project);
      assert.deepEqual(seen.reads, [inside.slice(project.length + 1)]);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

test("a value that names no usable directory throws at import and names the value: it never becomes the toolchain's own tree", () => {
  withProject((project, inside) => {
    const missing = join(project, "no", "such", "directory");
    const cases: Array<{ named: string; why: string }> = [
      { named: missing, why: "does not name an existing directory" },
      { named: inside, why: "names a file, not a directory" },
      { named: "docs", why: "is not an absolute path" },
      { named: "", why: "is not an absolute path" },
    ];
    for (const { named, why } of cases) {
      const seen = observeIn(named, []);
      assert.notEqual(seen.status, 0, `${JSON.stringify(named)} was accepted`);
      assert.match(seen.stderr, new RegExp(`A11IGN_PROJECT_ROOT=${JSON.stringify(named).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")} ${why}`));
    }
    // The positive control: the SAME child, pointed at a real directory, imports cleanly -- so the refusals above are the value's, not the harness's.
    assert.equal(observeIn(project, []).status, 0);
  });
});
