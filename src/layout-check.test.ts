/**
 * THE LAYOUT CHECK'S OWN CASES (a11ign/a11ign#4210; ADR 0043, Decision 7). Each of the four defects is run on a tree that has THAT defect and no
 * other, and the assertion is the exact set of `check@path` it reports, so a check that fails them all with one message, or one that fires on a
 * neighbour's defect, is red. Each has its negative control beside it: the precise shape the standard allows, which must stay clean.
 *
 * Two populations are not synthetic. `layout-check.fixtures/*.json` are the TREE LISTINGS of `documents`, `screenreader-fleet`, `lab`, `control`,
 * `toolchain` and `screenreader-worker` as they stood on 2026-10-08 (the listing and the manifests' names, not the code), and `agent-org`, the
 * flat model, which must pass. Their emptiness is asserted below, and the empty-tree case is the positive control for every "no problems".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLayout, checkLayoutTree, main, readLayoutTree, workspacePatternsOf, type LayoutTree } from "./layout-check.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./layout-check.fixtures/", import.meta.url));
const HERMETIC_GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const manifest = (fields: Record<string, unknown>): string => JSON.stringify(fields);
const pnpm = (...patterns: string[]): string => `packages:\n${patterns.map((p) => `  - "${p}"`).join("\n")}\n`;
/** What a check reported, as `check path` lines, sorted: the whole answer, so an extra or a missing one fails. */
const reported = (tree: LayoutTree): string[] => checkLayoutTree(tree).problems.map(({ check, path }) => `${check} ${path}`).sort();

type Fixture = { repository: string; commit: string; tree: LayoutTree };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as Fixture;

// ---- the four defects, each alone ---------------------------------------------------------------------------------------------------------

const published = (name: string) => manifest({ name, version: "1.0.0" });
const privateRoot = manifest({ name: "x-root", private: true });

test("a workspace of one package fails, naming workspace-of-one and the workspace file", () => {
  const viaPnpm = { "package.json": privateRoot, "pnpm-workspace.yaml": pnpm("packages/*"), "packages/foo/package.json": published("@a11ign/foo") };
  assert.deepEqual(reported(viaPnpm), ["workspace-of-one pnpm-workspace.yaml"]);
  const viaField = { "package.json": manifest({ name: "x-root", private: true, workspaces: ["packages/*"] }), "packages/foo/package.json": published("@a11ign/foo") };
  assert.deepEqual(reported(viaField), ["workspace-of-one package.json"]);
  const viaObjectField = { ...viaField, "package.json": manifest({ name: "x-root", private: true, workspaces: { packages: ["packages/*"] } }) };
  assert.deepEqual(reported(viaObjectField), ["workspace-of-one package.json"]);
});

test("a workspace of one package fails when the file names the root: the root is counted", () => {
  const rootAndOne = { "package.json": published("@a11ign/foo"), "pnpm-workspace.yaml": pnpm(".", "packages/*"), "packages/foo-extra/package.json": published("@a11ign/foo-extra") };
  assert.deepEqual(reported(rootAndOne), [], "positive control: the root and one published member are TWO packages, which is multi-package");
  const onlyRoot = { "package.json": published("@a11ign/foo"), "pnpm-workspace.yaml": pnpm(".") };
  assert.deepEqual(reported(onlyRoot), ["workspace-of-one pnpm-workspace.yaml"]);
});

test("a workspace of one package fails when the other members publish nothing (ADR 0043: a private member does not count)", () => {
  const withPrivate = {
    "package.json": published("@a11ign/foo"), "pnpm-workspace.yaml": pnpm(".", "packages/*"),
    "packages/speech/package.json": manifest({ name: "@a11ign/speech", private: true }),
  };
  assert.deepEqual(reported(withPrivate), ["workspace-of-one pnpm-workspace.yaml"]);
  assert.match(checkLayoutTree(withPrivate).message, /publishes one package, @a11ign\/foo, beside members that publish nothing/);
});

test("CONTROL: a workspace of two published packages is multi-package and passes, with or without a private shell root", () => {
  const members = { "packages/a/package.json": published("@a11ign/a"), "packages/b/package.json": published("@a11ign/b") };
  assert.deepEqual(reported({ "package.json": privateRoot, "pnpm-workspace.yaml": pnpm("packages/*"), ...members }), []);
  assert.deepEqual(reported({ "package.json": manifest({ name: "x-workspace", private: true }), "pnpm-workspace.yaml": pnpm("packages/*"), ...members }), []);
});

test("a package directory not named for its package fails, naming directory-name and the directory", () => {
  const tree = {
    "package.json": privateRoot, "pnpm-workspace.yaml": pnpm("packages/*"),
    "packages/pdf/package.json": published("@a11ign/documents"), "packages/other/package.json": published("@a11ign/other"),
  };
  assert.deepEqual(reported(tree), ["directory-name packages/pdf"]);
  assert.match(checkLayoutTree(tree).message, /packages\/pdf holds @a11ign\/documents, so its directory should be named "documents"/);
});

test("CONTROL: directories named for their packages pass, scoped or not; a directory with no workspace around it is not a package directory", () => {
  const tree = {
    "package.json": privateRoot, "pnpm-workspace.yaml": pnpm("packages/*"),
    "packages/documents/package.json": published("@a11ign/documents"), "packages/plain/package.json": published("plain"),
    "docs/examples/odd-name/package.json": published("@a11ign/unrelated"),
  };
  assert.deepEqual(reported(tree), []);
});

test("a second README for one package fails, naming second-readme and the package's README", () => {
  const tree = {
    "package.json": published("@a11ign/foo"), "README.md": "# foo", "pnpm-workspace.yaml": pnpm("packages/*"),
    "packages/foo/package.json": published("@a11ign/foo"), "packages/foo/README.md": "# foo", "packages/bar/package.json": published("@a11ign/bar"),
  };
  assert.deepEqual(reported(tree), ["second-readme packages/foo/README.md"]);
});

test("CONTROL: a README inside a SUBDIRECTORY documents a part and is not a second README", () => {
  const flat = { "package.json": published("@a11ign/foo"), "README.md": "# foo", "src/provisioning/README.md": "# a part", ".changeset/README.md": "# changesets" };
  assert.deepEqual(reported(flat), []);
  const nested = {
    "package.json": published("@a11ign/foo"), "README.md": "# foo", "pnpm-workspace.yaml": pnpm("packages/*"),
    "packages/foo/package.json": published("@a11ign/foo"), "packages/foo/src/provisioning/README.md": "# a part", "packages/bar/package.json": published("@a11ign/bar"),
  };
  assert.deepEqual(reported(nested), []);
});

test("CONTROL: a root README beside a README for a DIFFERENT package passes (each package of a multi-package repository has its own)", () => {
  const tree = {
    "package.json": manifest({ name: "x-workspace", private: true }), "README.md": "# the repository", "pnpm-workspace.yaml": pnpm("packages/*"),
    "packages/a/package.json": published("@a11ign/a"), "packages/a/README.md": "# a",
    "packages/b/package.json": published("@a11ign/b"), "packages/b/README.md": "# b",
  };
  assert.deepEqual(reported(tree), []);
});

test("a leftover lerna.json fails, naming leftover and the file", () => {
  const tree = { "package.json": published("@a11ign/foo"), "lerna.json": '{ "packages": ["packages/*"] }' };
  assert.deepEqual(reported(tree), ["leftover lerna.json"]);
});

test("a private -workspace root that only holds a workspace fails, naming leftover and the manifest", () => {
  const tree = { "package.json": manifest({ name: "foo-workspace", private: true }), "packages/foo/package.json": published("@a11ign/foo") };
  assert.deepEqual(reported(tree), ["leftover package.json"]);
  assert.match(checkLayoutTree(tree).message, /foo-workspace is a private -workspace root/);
});

test("CONTROL: a root that is merely named -workspace but is published, or is not private, is a package and not a shell", () => {
  assert.deepEqual(reported({ "package.json": manifest({ name: "@a11ign/foo-workspace", version: "1.0.0" }) }), []);
  assert.deepEqual(reported({ "package.json": manifest({ name: "tooling", private: true }) }), []);
});

// ---- the glob and the yaml -----------------------------------------------------------------------------------------------------------------

test("the workspace patterns are read from block and flow lists, comments and quotes, and an unreadable file throws", () => {
  assert.deepEqual(workspacePatternsOf("packages:\n  - 'packages/*'  # the lot\n  - \"apps/**\"\n  - .\ncatalog:\n  x: 1\n"), ["packages/*", "apps/**", "."]);
  assert.deepEqual(workspacePatternsOf('onlyBuiltDependencies:\n  - esbuild\npackages: ["a/*", \'b\']\n'), ["a/*", "b"]);
  assert.throws(() => workspacePatternsOf("catalog:\n  x: 1\n"), /no top-level `packages:` list/);
  assert.throws(() => workspacePatternsOf("packages:\ncatalog:\n  x: 1\n"), /holds no readable pattern/);
});

test("a glob member needs a manifest, `**` crosses directories, `!` excludes, and node_modules is never a member", () => {
  const two = { "packages/a/package.json": published("@a11ign/a"), "tools/deep/b/package.json": published("@a11ign/b") };
  const base = { "package.json": privateRoot, ...two, "packages/empty/README.md": "", "packages/node_modules/c/package.json": published("@a11ign/c") };
  assert.deepEqual(reported({ ...base, "pnpm-workspace.yaml": pnpm("packages/*", "tools/**") }), [], "a, b: two published; the empty dir and node_modules are not members");
  assert.deepEqual(reported({ ...base, "pnpm-workspace.yaml": pnpm("packages/*", "tools/**", "!tools/deep/*") }), ["workspace-of-one pnpm-workspace.yaml"]);
  assert.throws(() => reported({ "package.json": privateRoot, "pnpm-workspace.yaml": pnpm("packages/*"), "packages/a/package.json": "{" }), /packages\/a\/package.json is not a JSON object/);
});

// ---- the repositories, as they are today ---------------------------------------------------------------------------------------------------

const DEFECTS_TODAY: Record<string, string[]> = {
  documents: ["directory-name packages/pdf", "leftover package.json", "second-readme packages/pdf/README.md", "workspace-of-one pnpm-workspace.yaml"],
  "screenreader-fleet": ["directory-name packages/worker-fleet", "leftover package.json", "second-readme packages/worker-fleet/README.md", "workspace-of-one pnpm-workspace.yaml"],
  lab: ["leftover lerna.json", "leftover package.json"],
  control: ["leftover package.json", "second-readme packages/control/README.md", "workspace-of-one pnpm-workspace.yaml"],
  toolchain: ["leftover package.json", "second-readme packages/toolchain/README.md", "workspace-of-one pnpm-workspace.yaml"],
  "screenreader-worker": ["workspace-of-one pnpm-workspace.yaml"],
};

test("the fixture population is not empty: six defective repositories and the flat model, each a real tree listing", () => {
  const present = readdirSync(FIXTURES).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort();
  assert.deepEqual(present, [...Object.keys(DEFECTS_TODAY), "agent-org"].sort());
  for (const name of present) {
    const { tree, commit } = fixture(name);
    assert.match(commit, /^[0-9a-f]{40}$/, name);
    assert.ok(Object.keys(tree).length >= 20 && "package.json" in tree && "README.md" in tree, `${name}: a tree listing with a root manifest and README`);
  }
});

for (const [name, expected] of Object.entries(DEFECTS_TODAY)) {
  test(`the real defects of ${name}, as they are today, fail for exactly the reasons the standard names`, () => {
    assert.deepEqual(reported(fixture(name).tree), expected);
  });
}

test("agent-org's flat shape passes, with its .changeset/README.md and the package.json it carries under src/packaging/fixtures/", () => {
  const { tree } = fixture("agent-org");
  assert.ok(Object.keys(tree).some((path) => path.startsWith("src/packaging/fixtures/") && path.endsWith("/package.json")), "the nested fixture manifest is in the listing");
  assert.ok(".changeset/README.md" in tree && "LICENSE" in tree && "CHANGELOG.md" in tree && !("pnpm-workspace.yaml" in tree));
  const result = checkLayoutTree(tree);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("every defect of the six is reported as one line naming the check and the path, never one message for all", () => {
  const lines = checkLayoutTree(fixture("documents").tree).message.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines.some((l) => l.startsWith("[directory-name] packages/pdf: ")) && lines.some((l) => l.startsWith("[second-readme] packages/pdf/README.md: ")));
  assert.ok(lines.some((l) => l.startsWith("[workspace-of-one] pnpm-workspace.yaml: ")) && lines.some((l) => l.startsWith("[leftover] package.json: ")));
});

// ---- the empty tree, the disk, and the command ---------------------------------------------------------------------------------------------

test("a check that returned success for an empty tree is red: an empty tree is not ok and says nothing was read", () => {
  const result = checkLayoutTree({});
  assert.equal(result.ok, false);
  assert.equal(result.fileCount, 0);
  assert.match(result.message, /holds no file/);
});

type Reader = "git" | "walk";

/** Lay `tree` on disk, read as `reader`; run `body` on its root; remove it. */
function onDisk(tree: LayoutTree, reader: Reader, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "layout-check-"));
  try {
    for (const [path, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    if (reader === "git") {
      execFileSync("git", ["-C", root, "init", "-q"], { env: HERMETIC_GIT });
      execFileSync("git", ["-C", root, "add", "-A", "-f"], { env: HERMETIC_GIT });
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DEFECTIVE = { "package.json": manifest({ name: "foo-workspace", private: true }), "README.md": "#", "pnpm-workspace.yaml": pnpm("packages/*"), "packages/pdf/package.json": published("@a11ign/foo"), "packages/pdf/README.md": "#" };
const CLEAN = { "package.json": published("@a11ign/foo"), "README.md": "#", "LICENSE": "x", "node_modules/dep/package.json": published("dep"), "src/index.ts": "" };

for (const reader of ["git", "walk"] as Reader[]) {
  test(`read from a ${reader === "git" ? "git working tree" : "bare directory"}, a defective tree fails and a flat one passes, node_modules ignored`, () => {
    onDisk(DEFECTIVE, reader, (root) => {
      assert.deepEqual(checkLayout({ root }).problems.map(({ check }) => check).sort(), ["directory-name", "leftover", "second-readme", "workspace-of-one"]);
    });
    onDisk(CLEAN, reader, (root) => {
      const result = checkLayout({ root });
      assert.deepEqual(result.problems, []);
      assert.ok(result.fileCount > 0 && !Object.keys(readLayoutTree(root)).some((path) => path.includes("node_modules")));
    });
  });
}

test("the command exits 0 when clean, 1 and prints which check and the path when not, 2 when nothing was read", () => {
  const out = { log: [] as string[], error: [] as string[] };
  const sink = { log: (line: string) => out.log.push(line), error: (line: string) => out.error.push(line) };
  onDisk(CLEAN, "walk", (root) => assert.equal(main([root], sink), 0));
  assert.match(out.log.join(), /^layout-check: ok \(\d+ files read under /);
  onDisk(DEFECTIVE, "walk", (root) => assert.equal(main([root], sink), 1));
  assert.match(out.error.join("\n"), /layout-check: FAIL \[directory-name\] packages\/pdf: /);
  assert.match(out.error.join("\n"), /layout-check: FAIL \[workspace-of-one\] pnpm-workspace\.yaml: /);
  out.error.length = 0;
  onDisk({}, "walk", (root) => assert.equal(main([root], sink), 2));
  assert.match(out.error.join(), /holds no file/);
  assert.equal(main([join(tmpdir(), "layout-check-no-such-directory")], sink), 2);
});

test("the built bin runs as `layout-check <dir>` and exits with the same codes", () => {
  const bin = join(PACKAGE, "dist", "layout-check.mjs");
  assert.ok(existsSync(bin), "dist/layout-check.mjs is built (pnpm test builds first); a missing bin is the failure, not a skip");
  onDisk(CLEAN, "walk", (root) => assert.equal(spawnSync("node", [bin, root], { encoding: "utf8" }).status, 0));
  onDisk(DEFECTIVE, "walk", (root) => {
    const run = spawnSync("node", [bin, root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /\[second-readme\] packages\/pdf\/README\.md/);
  });
});
