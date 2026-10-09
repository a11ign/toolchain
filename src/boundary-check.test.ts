/**
 * THE BOUNDARY CHECK'S OWN CASES (a11ign/a11ign#4432; epic #4425, phase 2). The three kinds are run on a tree holding ONE crossing of each and
 * the assertion is the exact set of `kind file:line -> to` it lists, so a check that lists nothing, or one that lists a neighbour's shape, is
 * red. The negative control is the same tree with the crossings removed (and a decoy beside each kind), which must list none.
 *
 * Every tree is a JSON fixture in `boundary-check.fixtures/` and not a string in this file: a crossing written here would be a crossing in
 * the toolchain's own tree, which one case below proves lists none. The emptiness of that case is paired with its positive control: the
 * same walk, run over the crossing fixture on disk, lists three.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundary, checkBoundaryTree, main, parseBaseline, readBoundaryTree, type BoundaryTree } from "./boundary-check.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./boundary-check.fixtures/", import.meta.url));

const fixture = <T = BoundaryTree>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as T;
/** What a check listed, as `kind file:line -> to` lines: the whole answer, so an extra or a missing one fails. */
const listed = (tree: BoundaryTree): string[] => checkBoundaryTree(tree).crossings.map(({ kind, file, line, to }) => `${kind} ${file}:${line} -> ${to}`);

/** The tool directory's variable, split so that this file does not itself hold the shape the check lists (`$NAME/src/…` in a string is read as a reach). */
const TOOL_VARIABLE = `$AGENT_ORG_${"TOOL"}`;
/** In the order the check lists them: by file, then line. */
const CROSSINGS = [
  "laid-source layers.json:3 -> packages/lab",
  `tool-path scripts/load.mjs:2 -> ${TOOL_VARIABLE}/src/gate.ts`,
  "cross-repo-import src/a.ts:1 -> ../other-repo/src/other.ts",
];

/** A tree written to a directory, which is read with the `walk` reader (no `.git`); removed afterwards. */
function onDisk<T>(tree: BoundaryTree, use: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "boundary-check-"));
  try {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const capture = () => {
  const out = { log: [] as string[], error: [] as string[] };
  return { out, sink: { log: (line: string) => out.log.push(line), error: (line: string) => out.error.push(line) } };
};

test("a tree with one crossing of each kind lists exactly those three, each with its file, line and reached path", () => {
  assert.deepEqual(listed(fixture("crossings")), CROSSINGS);
});

test("CONTROL: the same tree with the crossings removed lists none, decoys and all", () => {
  const clean = fixture("clean");
  assert.ok(Object.keys(clean).length >= Object.keys(fixture("crossings")).length, "positive control: the clean tree is a tree, not an empty one");
  assert.deepEqual(listed(clean), []);
  assert.match(clean["scripts/load.mjs"], /AGENT_ORG_TOOL/, "the decoy comment that names the tool path is in the tree, so its absence from the listing is the comment being skipped");
});

test("each kind is found alone, so one cannot be standing in for another", () => {
  const crossings = fixture("crossings");
  const without = (...paths: string[]): BoundaryTree => Object.fromEntries(Object.entries(crossings).filter(([path]) => !paths.includes(path)));
  assert.deepEqual(listed(without("src/a.ts")), [CROSSINGS[0], CROSSINGS[1]]);
  assert.deepEqual(listed(without("scripts/load.mjs")), [CROSSINGS[0], CROSSINGS[2]]);
  assert.deepEqual(listed(without("layers.json")), [CROSSINGS[1], CROSSINGS[2]]);
});

test("every spelling of a tool path is listed, in a source file and in a workflow, and a template's own variable is not", () => {
  const shapes = fixture("tool-shapes");
  const tool = (where: string, to: string): string => `tool-path ${where} -> ${to}`;
  assert.deepEqual(listed(shapes), [
    tool(".github/workflows/w.yml:4", `${TOOL_VARIABLE}/src/gate.ts`),
    tool(".github/workflows/w.yml:5", `${TOOL_VARIABLE}/src/run.ts`),
    tool("scripts/shapes.mjs:1", `${TOOL_VARIABLE}/src/template.ts`),
    tool("scripts/shapes.mjs:2", `${TOOL_VARIABLE}/src/joined.ts`),
    tool("scripts/shapes.mjs:3", `${TOOL_VARIABLE}/src/bracket.ts`),
    tool("scripts/shapes.mjs:4", "<tool dir>/src/called.ts"),
    tool("scripts/shapes.mjs:5", `${TOOL_VARIABLE}/src/shell-in-js.ts`),
  ]);
});

test("an import into a package the importer's manifest does not declare is a crossing, and a declared one is not", () => {
  const clean = fixture("clean");
  assert.deepEqual(listed(clean), [], "positive control: packages/a imports packages/b and declares it");
  const undeclared = { ...clean, "packages/a/package.json": JSON.stringify({ name: "@x/a" }) };
  assert.deepEqual(listed(undeclared), ["cross-repo-import packages/a/src/a.ts:1 -> packages/b/src/y.ts"]);
  assert.match(checkBoundaryTree(undeclared).crossings[0].message, /the package @x\/b, which packages\/a\/package\.json does not declare/);
});

test("a laid directory is found from a .gitignore entry plus a script that copies into it, and only then", () => {
  const laid = fixture("laid-by-script");
  assert.deepEqual(listed(laid), ["laid-source .gitignore:2 -> vendored-lab"]);
  assert.match(checkBoundaryTree(laid).crossings[0].message, /scripts\/install\.sh:3 copies/);
  const noWriter = { ...laid, "scripts/install.sh": "#!/bin/sh\necho nothing is copied here\n" };
  assert.deepEqual(listed(noWriter), [], "an ignored directory nothing copies into is not a laid layer");
});

test("a crossing named in the baseline is ACCEPTED and a baseline line matching nothing is STALE", () => {
  const baseline = parseBaseline(JSON.stringify(fixture("baseline")));
  const result = checkBoundaryTree(fixture("crossings"), baseline);
  assert.deepEqual(result.crossings.map(({ file, status }) => `${file} ${status}`), ["layers.json found", "scripts/load.mjs found", "src/a.ts accepted"]);
  assert.deepEqual(result.stale, [{ from: "src/gone.ts", to: "../nowhere/src/gone.ts" }]);
  assert.match(result.message, /^ACCEPTED \[cross-repo-import\] src\/a\.ts:1 /m);
  assert.match(result.message, /^STALE baseline src\/gone\.ts -> /m);
});

test("CONTROL: with no baseline nothing is accepted or stale, and an accepted baseline against a clean tree is all stale", () => {
  const plain = checkBoundaryTree(fixture("crossings"));
  assert.ok(plain.crossings.every(({ status }) => status === "found") && plain.stale.length === 0);
  const baseline = parseBaseline(JSON.stringify(fixture("baseline")));
  assert.equal(checkBoundaryTree(fixture("clean"), baseline).stale.length, baseline.length);
});

test("a baseline is an array or { accepted }, and anything else is refused", () => {
  const entries = fixture<unknown[]>("baseline");
  assert.deepEqual(parseBaseline(JSON.stringify({ accepted: entries })), parseBaseline(JSON.stringify(entries)));
  assert.throws(() => parseBaseline(JSON.stringify({ accepted: "no" })), /array of \{ from, to \}/);
  assert.throws(() => parseBaseline(JSON.stringify([{ from: "a" }])), /string `from` and a string `to`/);
});

test("the toolchain's own tree lists no crossing", () => {
  const own = checkBoundary({ root: PACKAGE });
  assert.ok(own.fileCount > 20 && existsSync(join(PACKAGE, "src", "boundary-check.ts")), "positive control: the walk read this repository, this file's neighbours included");
  assert.deepEqual(own.crossings.map(({ kind, file, line, to }) => `${kind} ${file}:${line} -> ${to}`), []);
  const onDisked = onDisk(fixture("crossings"), (root) => checkBoundary({ root }).crossings.length);
  assert.equal(onDisked, CROSSINGS.length, "positive control: the same reader, run over a directory holding the crossings, lists them");
});

test("reading a directory gives the same listing as the tree it holds", () => {
  const tree = fixture("crossings");
  onDisk(tree, (root) => {
    assert.deepEqual(readBoundaryTree(root), tree);
    assert.deepEqual(checkBoundary({ root }).crossings.map(({ file, line, to }) => `${file}:${line} -> ${to}`), CROSSINGS.map((line) => line.split(" ").slice(1).join(" ")));
  });
});

test("the command exits 0 for a tree WITH crossings, 2 for an empty one, and 2 for an unreadable baseline or a bad argument", () => {
  const { out, sink } = capture();
  onDisk(fixture("crossings"), (root) => assert.equal(main([`--root=${root}`], sink), 0));
  assert.match(out.log.join("\n"), /boundary-check: CROSSING \[tool-path\] scripts\/load\.mjs:2 -> /);
  assert.match(out.log.join("\n"), /3 crossing\(s\), 0 accepted/);
  onDisk(fixture("clean"), (root) => assert.equal(main([root], sink), 0));
  assert.match(out.log.join("\n"), /no crossings, 0 stale baseline line\(s\)/);
  onDisk({}, (root) => assert.equal(main([`--root=${root}`], sink), 2));
  assert.match(out.error.join("\n"), /holds no file/);
  assert.equal(main([`--root=${join(tmpdir(), "boundary-check-no-such-directory")}`], sink), 2);
  onDisk(fixture("crossings"), (root) => assert.equal(main([`--root=${root}`, `--baseline=${join(root, "missing.json")}`], sink), 2));
  assert.equal(main(["--nope"], sink), 2);
  assert.match(out.error.join("\n"), /unknown argument --nope/);
});

test("--baseline and --out: the accepted line is printed, and the JSON report is written as well", () => {
  const { out, sink } = capture();
  onDisk({ ...fixture("crossings"), "baseline.json": JSON.stringify(fixture("baseline")) }, (root) => {
    const report = join(root, "report.json");
    assert.equal(main([`--root=${root}`, `--baseline=${join(root, "baseline.json")}`, `--out=${report}`], sink), 0);
    const written = JSON.parse(readFileSync(report, "utf8")) as { crossings: { file: string; status: string }[]; stale: unknown[]; root: string };
    assert.equal(written.crossings.filter(({ status }) => status === "accepted").length, 1);
    assert.equal(written.stale.length, 1);
    assert.equal(written.root, root);
  });
  assert.match(out.log.join("\n"), /ACCEPTED \[cross-repo-import\] src\/a\.ts:1/);
  assert.match(out.log.join("\n"), /STALE baseline src\/gone\.ts/);
});

test("the built bin runs as `boundary-check --root=<dir>` and exits 0 with crossings, 2 with none read", () => {
  const bin = join(PACKAGE, "dist", "boundary-check.mjs");
  assert.ok(existsSync(bin), "dist/boundary-check.mjs is built (pnpm test builds first); a missing bin is the failure, not a skip");
  onDisk(fixture("crossings"), (root) => {
    const run = spawnSync("node", [bin, `--root=${root}`], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /CROSSING \[laid-source\] layers\.json:3 -> packages\/lab/);
  });
  onDisk({}, (root) => assert.equal(spawnSync("node", [bin, `--root=${root}`], { encoding: "utf8" }).status, 2));
});
