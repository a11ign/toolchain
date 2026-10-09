/**
 * `walk-scope-discovery.ts` (#3573): "which SOURCE files does this one file reach, by relative import or workspace-package specifier, transitively".
 * `walk-scope.ts` asks it what a declaring guard's WALK_SCOPE may read, so a miss here is a guard that reads a file its scope never named.
 *
 * What is pinned, against a fixture repository built in a temp directory (never this checkout):
 *   1. `packageIndex` reads each `packages/<dir>/package.json` into name -> { dir, exportsMap }, with `{}` for a manifest that has no `exports`.
 *   2. RELATIVE SPECIFIERS resolve to SOURCE: a `.js`/`.mjs`/`.cjs` specifier from a `.ts` file reaches the `.ts` that produces it, and an extensionless one
 *      tries `.ts`, `.mjs` and `/index.ts`. Static, bare side-effect and DYNAMIC `import("...")` forms are all followed (#1527); `node:` builtins are not.
 *   3. WORKSPACE SPECIFIERS resolve to SOURCE, not the `dist/*` an `exports` field names: a string target, a `{ types, default }` target, `.` and `./sub`,
 *      scoped and unscoped names. A npm dependency, an unknown subpath and a target absent from disk resolve to nothing.
 *   4. IT TERMINATES on a cycle, includes the entry, and answers an empty set for an entry that does not exist.
 *
 * THE POSITIVE CONTROLS: every "is not reached" assertion is made on a closure that reaches the other files of the same fixture, so emptiness is not what
 * the walker returns for everything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageIndex, sourceClosure } from "./walk-scope-discovery.ts";

type Files = Record<string, string | object>;

/** Build `files` (path -> text, or an object written as JSON) under a fresh root and hand it to `body`; the root is removed afterwards. */
function withRepo(files: Files, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "walk-scope-discovery-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const relativeTo = (root: string, closure: Set<string>) => [...closure].map((file) => file.slice(root.length + 1)).sort();

const WORKSPACE: Files = {
  "packages/tools/package.json": { name: "@a11ign/tools", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./sub": { default: "./dist/sub.js" }, "./raw": "./src/raw.mjs", "./typesOnly": { types: "./dist/t.d.ts" } } },
  "packages/tools/src/index.ts": "export const a = 1;\n",
  "packages/tools/src/sub.ts": "export const sub = 1;\n",
  "packages/tools/src/raw.mjs": "export const raw = 1;\n",
  "packages/plain/package.json": { name: "plain" },
  "packages/plain/src/x.mjs": "",
};
const index = (root: string) => packageIndex(root, ["tools", "plain"]);

test("packageIndex maps each manifest's name to its directory and exports, defaulting to {}", () => {
  withRepo(WORKSPACE, (root) => {
    const packages = index(root);
    assert.deepEqual([...packages.keys()], ["@a11ign/tools", "plain"]);
    assert.equal(packages.get("@a11ign/tools")?.dir, "tools");
    assert.deepEqual(Object.keys(packages.get("@a11ign/tools")?.exportsMap ?? {}), [".", "./sub", "./raw", "./typesOnly"]);
    assert.deepEqual(packages.get("plain"), { dir: "plain", exportsMap: {} });
  });
});

test("packageIndex on an empty list is empty, and on a directory with no manifest it throws", () => {
  withRepo(WORKSPACE, (root) => {
    assert.equal(packageIndex(root, []).size, 0);
    assert.throws(() => packageIndex(root, ["missing"]), /ENOENT/);
  });
});

test("a .js specifier from a .ts file reaches the .ts that produces it, and the entry is in its own closure", () => {
  withRepo({
    "src/entry.ts": "import { b } from './b.js';\nimport type { C } from './c.mjs';\n",
    "src/b.ts": "export const b = 1;\n",
    "src/c.mjs": "export {};\n",
    "src/unrelated.ts": "export {};\n",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.ts"), root, new Map());
    assert.deepEqual(relativeTo(root, closure), ["src/b.ts", "src/c.mjs", "src/entry.ts"]);
  });
});

test("an extensionless specifier tries the exact path, then .ts, then .mjs", () => {
  withRepo({
    "src/entry.ts": "import './exact.json';\nimport './plainTs';\nimport './plainMjs';\n",
    "src/exact.json": "{}",
    "src/plainTs.ts": "",
    "src/plainMjs.mjs": "",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.ts"), root, new Map());
    assert.deepEqual(relativeTo(root, closure), ["src/entry.ts", "src/exact.json", "src/plainMjs.mjs", "src/plainTs.ts"]);
  });
});

test("OBSERVED LIMIT: an extensionless specifier naming a DIRECTORY resolves to the directory itself and the walk throws EISDIR", () => {
  // `base` is tried first and a directory exists, so the `/index.ts` candidate is never reached. Pinned as observed so a fix is a deliberate change.
  withRepo({ "src/entry.ts": "import './dir';\n", "src/dir/index.ts": "" }, (root) => {
    assert.throws(() => sourceClosure(join(root, "src/entry.ts"), root, new Map()), /EISDIR/);
  });
});

test("a .js specifier also falls back to .tsx, and one that matches nothing adds nothing", () => {
  withRepo({
    "src/entry.ts": "import './view.js';\nimport './ghost.js';\n",
    "src/view.tsx": "",
  }, (root) => {
    assert.deepEqual(relativeTo(root, sourceClosure(join(root, "src/entry.ts"), root, new Map())), ["src/entry.ts", "src/view.tsx"]);
  });
});

test("dynamic import(), side-effect imports, and multi-line forms are followed; node: builtins are not", () => {
  withRepo({
    "src/entry.mjs": [
      "import { a,",
      "  b } from './multi.mjs';",
      "const lazy = await import('./lazy.mjs');",
      "const spaced = await import( \"./spaced.mjs\" );",
      "import fs from 'node:fs';",
      "import { x } from 'node:path';",
      "",
    ].join("\n"),
    "src/multi.mjs": "",
    "src/lazy.mjs": "",
    "src/spaced.mjs": "",
  }, (root) => {
    assert.deepEqual(relativeTo(root, sourceClosure(join(root, "src/entry.mjs"), root, new Map())),
      ["src/entry.mjs", "src/lazy.mjs", "src/multi.mjs", "src/spaced.mjs"]);
  });
});

test("the closure is transitive and terminates on a cycle", () => {
  withRepo({
    "src/a.ts": "import './b.js';\n",
    "src/b.ts": "import './c.js';\n",
    "src/c.ts": "import './a.js';\nimport './d.js';\n",
    "src/d.ts": "",
  }, (root) => {
    assert.deepEqual(relativeTo(root, sourceClosure(join(root, "src/a.ts"), root, new Map())), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });
});

test("an entry that does not exist has an empty closure, while an existing one has itself", () => {
  withRepo({ "src/real.ts": "" }, (root) => {
    assert.equal(sourceClosure(join(root, "src/nowhere.ts"), root, new Map()).size, 0);
    assert.equal(sourceClosure(join(root, "src/real.ts"), root, new Map()).size, 1);
  });
});

test("a workspace specifier resolves to the SOURCE its dist export was built from", () => {
  withRepo({
    ...WORKSPACE,
    "src/entry.ts": "import { a } from '@a11ign/tools';\nimport { sub } from '@a11ign/tools/sub';\nimport { raw } from '@a11ign/tools/raw';\n",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.ts"), root, index(root));
    assert.deepEqual(relativeTo(root, closure), ["packages/tools/src/index.ts", "packages/tools/src/raw.mjs", "packages/tools/src/sub.ts", "src/entry.ts"]);
  });
});

test("an unscoped workspace name resolves too, and the walk continues through the source it reaches", () => {
  withRepo({
    "packages/plain/package.json": { name: "plain", exports: { "./x": "./src/x.mjs" } },
    "packages/plain/src/x.mjs": "import './deep.mjs';\n",
    "packages/plain/src/deep.mjs": "",
    "src/entry.mjs": "import 'plain/x';\n",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.mjs"), root, packageIndex(root, ["plain"]));
    assert.deepEqual(relativeTo(root, closure), ["packages/plain/src/deep.mjs", "packages/plain/src/x.mjs", "src/entry.mjs"]);
  });
});

test("an npm dependency, an unexported subpath, a types-only export and a target missing from disk resolve to nothing", () => {
  withRepo({
    ...WORKSPACE,
    "packages/tools/src/also.ts": "",
    "src/entry.ts": [
      "import 'zod';",
      "import '@scope/not-in-workspace';",
      "import '@a11ign/tools/not-exported';",
      "import '@a11ign/tools/typesOnly';",
      "import './local.js';",
    ].join("\n"),
    "src/local.ts": "",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.ts"), root, index(root));
    assert.deepEqual(relativeTo(root, closure), ["src/entry.ts", "src/local.ts"]);
    const withMissingTarget = packageIndex(root, ["tools"]);
    withMissingTarget.get("@a11ign/tools")!.exportsMap["./gone"] = { default: "./dist/gone.js" };
    writeFileSync(join(root, "src/gone.ts"), "import '@a11ign/tools/gone';\n");
    assert.deepEqual(relativeTo(root, sourceClosure(join(root, "src/gone.ts"), root, withMissingTarget)), ["src/gone.ts"]);
  });
});

test("every dist spelling maps back to a source candidate: .js, .mjs and .d.ts targets", () => {
  withRepo({
    "packages/multi/package.json": { name: "@a11ign/multi", exports: {
      "./js": { default: "./dist/one.js" }, "./mjs": { default: "./dist/two.mjs" }, "./dts": "./dist/three.d.ts", "./view": { default: "./dist/view.js" },
    } },
    "packages/multi/src/one.ts": "",
    "packages/multi/src/two.mjs": "",
    "packages/multi/src/three.ts": "",
    "packages/multi/src/view.tsx": "",
    "src/entry.ts": "import '@a11ign/multi/js'; import '@a11ign/multi/mjs'; import '@a11ign/multi/dts'; import '@a11ign/multi/view';\n",
  }, (root) => {
    const closure = sourceClosure(join(root, "src/entry.ts"), root, packageIndex(root, ["multi"]));
    assert.deepEqual(relativeTo(root, closure), [
      "packages/multi/src/one.ts", "packages/multi/src/three.ts", "packages/multi/src/two.mjs", "packages/multi/src/view.tsx", "src/entry.ts",
    ]);
  });
});
