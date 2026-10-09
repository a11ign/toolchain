import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// THE README'S ONE LINE RESOLVES ON A COLD CACHE (a11ign/a11ign#4346). `npx --yes --package @a11ign/toolchain layout-check` installs the package
// and, because npm 9 also installs an optional peer when another peer's range reaches it, `typescript`: `@rslib/core` declares
// `peerOptional typescript "^5 || ^6 || ^7"`, npm takes the HIGHEST version that range admits (7.x), and a toolchain peer of `^6.0.3` excludes it.
// npm exits 1 with ERESOLVE from 0.2.0 (which added the `typescript` peer) on, so the line failed at `latest` for everyone with a cold `~/.npm/_npx`.
//
// WHAT THIS PINS, offline: a peer the toolchain declares may not name a `typescript` range whose HIGHEST major the toolchain's own `typescript`
// peer excludes, and the README line carries no flag that would hide a conflict (`--legacy-peer-deps`, `--force`). The registry run itself is the
// row's Acceptance command and cannot run in a unit test; this is the arithmetic that command exercises.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONE_LINE = "npx --yes --package @a11ign/toolchain layout-check";
const CONFLICT_HIDING_FLAGS = ["--legacy-peer-deps", "--force", "--strict-peer-deps=false"];

type Manifest = { peerDependencies?: Record<string, string> };

const readJson = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));

/** The highest major a range admits, read off its alternatives (`^5 || ^6 || ^7` is 7): npm resolves an unpinned peer to the newest version it may. */
function highestMajor(range: string): number {
  const majors = range.split("||").map((alternative) => Number(/\d+/.exec(alternative)?.[0]));
  assert.ok(majors.length > 0 && majors.every(Number.isFinite), `cannot read a major from the range "${range}"`);
  return Math.max(...majors);
}

/** True when a range has an alternative that starts at, or contains, that major. */
function admitsMajor(range: string, major: number): boolean {
  return range.split("||").some((alternative) => Number(/\d+/.exec(alternative)?.[0]) === major);
}

/** The `typescript` ranges that the OTHER declared peers (as installed) put on the tree, by peer name. */
function typescriptRangesOfOtherPeers(peers: Record<string, string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of Object.keys(peers).filter((peer) => peer !== "typescript")) {
    const installed = join(ROOT, "node_modules", name, "package.json");
    const range = existsSync(installed) ? readJson(installed).peerDependencies?.typescript : undefined;
    if (range !== undefined) found[name] = range;
  }
  return found;
}

/** Each peer whose `typescript` range reaches a major the toolchain's own `typescript` peer excludes; empty when the line resolves. */
function collisions(toolchainTypescript: string, others: Record<string, string>): string[] {
  return Object.entries(others)
    .filter(([, range]) => !admitsMajor(toolchainTypescript, highestMajor(range)))
    .map(([name, range]) => `${name} peers typescript "${range}" (npm resolves ${highestMajor(range)}.x) but the toolchain peers "${toolchainTypescript}"`);
}

/** The README's `run:` lines that call the layout check, as written. */
function oneLinersIn(readme: string): string[] {
  return readme.split("\n").filter((line) => line.includes("@a11ign/toolchain layout-check") || line.includes("--package @a11ign/toolchain layout-check"));
}

const manifest = readJson(join(ROOT, "package.json"));
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const typescriptPeer = manifest.peerDependencies?.typescript;

test("the typescript peer admits the newest typescript any other declared peer admits", () => {
  assert.ok(typescriptPeer, "the package declares no typescript peer, so there is nothing to collide (and js-to-ts imports typescript)");
  const others = typescriptRangesOfOtherPeers(manifest.peerDependencies ?? {});
  // The positive control for the emptiness below: @rslib/core is a devDependency AND a peer, and it is the peer that caused #4346.
  assert.ok("@rslib/core" in others, "@rslib/core is not installed or no longer peers typescript: the check below would pass on an empty set");
  assert.deepEqual(collisions(typescriptPeer, others), []);
});

test("the collision check bites: the 0.2.0 and 0.3.0 peer is refused, the widened one is not", () => {
  const rslib = { "@rslib/core": "^5 || ^6 || ^7" };
  assert.equal(collisions("^6.0.3", rslib).length, 1);
  assert.deepEqual(collisions("^6.0.3 || ^7.0.0", rslib), []);
});

test("the README carries the one line, exactly once, with no flag that hides a conflict", () => {
  const lines = oneLinersIn(readme).filter((line) => line.includes("- run:"));
  assert.equal(lines.length, 1, `expected one "- run:" line calling layout-check, found ${lines.length}`);
  assert.ok(lines[0]!.includes(ONE_LINE), `the README line is not "${ONE_LINE}": ${lines[0]}`);
  for (const flag of CONFLICT_HIDING_FLAGS) assert.ok(!lines[0]!.includes(flag), `the README line passes ${flag}, which hides the conflict instead of removing it`);
});

test("the README check bites: a flag on the line is found", () => {
  const flagged = `- run: ${ONE_LINE} --legacy-peer-deps`;
  assert.deepEqual(oneLinersIn(flagged).filter((line) => CONFLICT_HIDING_FLAGS.some((flag) => line.includes(flag))), [flagged]);
});
