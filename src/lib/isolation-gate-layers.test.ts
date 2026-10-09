/**
 * `gate:isolation` does not pack a layer's CHECKOUT (#3830).
 *
 * On the lab `/opt/a11y/packages/nvda-worker` is the layer's clone, so it holds a `package.json`, and the gate packed it:
 * its `prepack` runs `pnpm`, which the lab does not have by design (#3141), so stage 5 of `release:gate` failed and the
 * nine stages behind it were never read. A layer publishes from its own repository (ADR 0040), so the core's gate has no
 * business packing it. `layers.json` already says which directories those are; discovery now asks it, and says how many it left out.
 *
 * EVERY CASE RUNS THE REAL GATE: it is copied, with the three files it imports, into a fixture repository that holds its
 * own `packages/` and `layers.json`, and imported from there, so discovery reads the fixture and not this tree.
 *
 * THE POSITIVE CONTROLS ARE IN THIS FILE, by name. An emptiness assertion over "the layer is not packed" passes when
 * discovery finds nothing at all, so:
 *   - an ORDINARY package beside the layer is asserted still packed, and
 *   - the same fixture read with NO layers declared is asserted to pack the layer, which is the defect, so the filter is
 *     what keeps it out and not an accident of the fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This package's root. The core's last case, that its REAL `layers.json` declares `nvda-worker` with a remote, stays in the core: that file is the core's, not this package's.
const REAL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE = "src/lib/isolation-gate.ts";
/** The gate and the relative imports it carries: nothing else of this repository is needed to run discovery. */
const COPIED = [GATE, "src/lib/git-env.ts", "src/lib/cli-flags.ts", "src/lib/npm-cli-executable.ts"];
const LAYERS_JSON = "layers.json";
const LAYER = "packages/some-layer";
const REMOTE = "https://example.invalid/some-layer.git";

type Layers = Record<string, { path: string, remote?: string }>;
interface Gate {
  allPackages(): string[];
  leftOutLayerCheckouts(): string[];
}

function put(repo: string, path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** A repository holding the real gate, `packages/ordinary`, `packages/private-one` and `packages/some-layer`, with `layers` as its `layers.json`. */
function fixtureRepository(layers: Layers): string {
  const repo = mkdtempSync(join(tmpdir(), "a11y-iso-layers-"));
  for (const file of COPIED) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(REAL_ROOT, file), join(repo, file));
  }
  put(repo, "packages/ordinary/package.json", JSON.stringify({ name: "@fixture/ordinary" }));
  put(repo, "packages/private-one/package.json", JSON.stringify({ name: "@fixture/private-one", private: true }));
  put(repo, `${LAYER}/package.json`, JSON.stringify({ name: "@fixture/some-layer", scripts: { prepack: "pnpm run build" } }));
  put(repo, LAYERS_JSON, JSON.stringify({ layers }));
  return repo;
}

/** Runs `check` against the fixture's own copy of the gate, and removes the fixture whatever `check` does. */
async function withGate<T>(layers: Layers, check: (gate: Gate, repo: string) => T): Promise<Awaited<T>> {
  const repo = fixtureRepository(layers);
  try {
    const gate = await import(pathToFileURL(join(repo, GATE)).href) as Gate;
    return await check(gate, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const names = (dirs: string[]) => dirs.map((dir) => basename(dir)).sort();

test("a declared layer's checkout is NOT packed, and an ordinary package beside it still is", async () => {
  await withGate({ "some-layer": { path: LAYER, remote: REMOTE } }, (gate) => {
    assert.deepEqual(names(gate.allPackages()), ["ordinary"]);
  });
});

test("POSITIVE CONTROL: with no layer declared the same fixture packs the layer, so the filter is what keeps it out", async () => {
  await withGate({}, (gate) => assert.deepEqual(names(gate.allPackages()), ["ordinary", "some-layer"]));
  // No `remote`: it lives INSIDE the core's checkout and the core does publish it, so it stays in.
  await withGate({ "some-layer": { path: LAYER } }, (gate) => {
    assert.deepEqual(names(gate.allPackages()), ["ordinary", "some-layer"]);
  });
});

test("the gate says what it left out", async () => {
  await withGate({ "some-layer": { path: LAYER, remote: REMOTE } }, (gate) => {
    assert.deepEqual(gate.leftOutLayerCheckouts(), ["some-layer"]);
  });
  await withGate({}, (gate) => {
    assert.deepEqual(gate.leftOutLayerCheckouts(), [], "nothing declared, nothing left out: the report is not a constant");
  });
});

test("a layer declared but not checked out is left out of nothing, and does not throw", async () => {
  await withGate({ "some-layer": { path: LAYER, remote: REMOTE } }, (gate, repo) => {
    rmSync(join(repo, LAYER), { recursive: true });
    assert.deepEqual(names(gate.allPackages()), ["ordinary"]);
    assert.deepEqual(gate.leftOutLayerCheckouts(), []);
  });
});

test("an unreadable layers.json THROWS naming the file: answering `no layers` would pack them again, silently", async () => {
  await withGate({}, (gate, repo) => {
    rmSync(join(repo, LAYERS_JSON));
    assert.throws(() => gate.allPackages(), /cannot read .*layers\.json/);
  });
});
