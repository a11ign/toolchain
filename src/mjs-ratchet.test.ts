/**
 * THE RATCHET'S OWN CASES (a11ign/a11ign#4243). Every case runs the real function over a scratch tree this file makes, in BOTH ways a tree can be
 * read: as a git working tree (`git ls-files`) and as a bare directory (the walk agent-org's gate needs). A guard with two readers is tested
 * on each, because a marker that works on one and misses the other is the vacuity failure pointed the other way.
 *
 * No fixture is committed: a tracked `.mjs` fixture would be counted by the very ratchet it tests, and a committed `dist/` is ignored by this
 * repository's `.gitignore`. The trees are made here, and removed after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASELINE_FILE, BUILD_OUTPUT_DEFINITION, BUILD_OUTPUT_SEGMENTS, checkMjsRatchet, findBaselineRoot, isScriptSource, writeLoweredBaseline,
  type Baseline,
} from "./mjs-ratchet.ts";

type Reader = "git" | "walk";
const READERS: Reader[] = ["git", "walk"];
const HERMETIC_GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** Make a tree of `files` (path to text) plus the baseline, read as `reader`; run `body` on its root; remove it. */
function withTree(reader: Reader, { files, baseline }: { files: Record<string, string>; baseline: Partial<Baseline> | string }, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
  try {
    const text = typeof baseline === "string" ? baseline : JSON.stringify({ files: [], exceptions: [], ...baseline });
    for (const [path, content] of Object.entries({ ...files, [BASELINE_FILE]: text })) {
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

const TREE = { "README.md": "x", "src/a.ts": "x", "scripts/old.mjs": "x" };
const OLD = { files: ["old.mjs"] };

for (const reader of READERS) {
  test(`[${reader}] the control: a tree equal to its baseline passes, over a count that is not zero`, () => {
    withTree(reader, { files: TREE, baseline: OLD }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.count, 1, "positive control: the read FOUND the file, so 'passes' is not 'nothing was read'");
      assert.match(result.message, /equal to the baseline/);
    });
  });

  test(`[${reader}] a new mjs file fails, and the message names it and prints the definition`, () => {
    withTree(reader, { files: { ...TREE, "scripts/added.mjs": "x" }, baseline: OLD }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      assert.match(result.message, /scripts\/added\.mjs/);
      assert.ok(result.message.includes(BUILD_OUTPUT_DEFINITION), "the definition is printed where it bites");
      assert.ok(!result.message.includes("scripts/old.mjs"), "the file the baseline allows is not accused");
    });
  });

  test(`[${reader}] a .js and a .cjs count as well as a .mjs, and a .d.ts and a .ts do not`, () => {
    const files = { "a.js": "x", "b.cjs": "x", "c.mjs": "x", "d.d.ts": "x", "e.ts": "x", "f.mts": "x", "g.json": "x" };
    withTree(reader, { files, baseline: {} }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      for (const name of ["a.js", "b.cjs", "c.mjs"]) assert.match(result.message, new RegExp(name.replace(".", "\\.")));
      for (const name of ["d.d.ts", "e.ts", "f.mts", "g.json"]) assert.ok(!result.message.includes(name), `${name} is not a .js, .mjs or .cjs`);
    });
  });

  test(`[${reader}] a same-named file added in another directory fails: the baseline counts basenames, so one more is one too many`, () => {
    withTree(reader, { files: { ...TREE, "other/old.mjs": "x" }, baseline: OLD }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      assert.match(result.message, /`old\.mjs` is in the baseline 1 time and the tree holds 2: .*other\/old\.mjs/);
    });
  });

  test(`[${reader}] a move passes untouched: the baseline names the file, not where it lives`, () => {
    withTree(reader, { files: { "README.md": "x", "packages/x/src/old.mjs": "x" }, baseline: OLD }, (root) => {
      assert.equal(checkMjsRatchet({ from: root }).ok, true);
    });
  });

  test(`[${reader}] a removed file passes, says the baseline can be lowered, and the lowered baseline is accepted and then ratchets`, () => {
    const files = { "README.md": "x", "scripts/kept.mjs": "x" };
    withTree(reader, { files, baseline: { files: ["kept.mjs", "gone.mjs"] } }, (root) => {
      const dropped = checkMjsRatchet({ from: root });
      assert.equal(dropped.ok, true, dropped.message);
      assert.match(dropped.message, /can be lowered to 1/);

      assert.deepEqual(writeLoweredBaseline({ from: root }), { path: join(root, BASELINE_FILE), before: 2, after: 1 });
      assert.deepEqual(JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8")), { files: ["kept.mjs"], exceptions: [] });
      const rerun = checkMjsRatchet({ from: root });
      assert.equal(rerun.ok, true, rerun.message);
      assert.match(rerun.message, /equal to the baseline/);

      // It ratcheted: the file that the old baseline had room for is no longer allowed.
      writeFileSync(join(root, "gone.mjs"), "x");
      assert.equal(checkMjsRatchet({ from: root }).ok, false, "the lowered baseline refuses what the old one allowed");
    });
  });

  test(`[${reader}] lowering refuses to RAISE: it throws on a new file and leaves the baseline as it was`, () => {
    withTree(reader, { files: { ...TREE, "scripts/added.mjs": "x" }, baseline: OLD }, (root) => {
      const before = readFileSync(join(root, BASELINE_FILE), "utf8");
      assert.throws(() => writeLoweredBaseline({ from: root }), /not lowering.*added\.mjs/s);
      assert.equal(readFileSync(join(root, BASELINE_FILE), "utf8"), before);
    });
  });

  test(`[${reader}] an empty tree is red, never a pass`, () => {
    withTree(reader, { files: {}, baseline: {} }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false, "a read that found nothing is not a count of zero");
      assert.match(result.message, /holds no file besides/);
      assert.throws(() => writeLoweredBaseline({ from: root }), /not lowering/);
    });
  });

  test(`[${reader}] zero is zero: an empty baseline fails on any file of those kinds, and passes a tree with none`, () => {
    withTree(reader, { files: { "README.md": "x", "src/a.ts": "x" }, baseline: {} }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.count, 0);
      writeFileSync(join(root, "src", "late.cjs"), "x");
      if (reader === "git") execFileSync("git", ["-C", root, "add", "-A"], { env: HERMETIC_GIT });
      assert.equal(checkMjsRatchet({ from: root }).ok, false, "no standing allowance at zero");
    });
  });

  for (const segment of BUILD_OUTPUT_SEGMENTS) {
    test(`[${reader}] build output: a file under \`${segment}/\` is not counted, and its near-miss directory is`, () => {
      const files = { "README.md": "x", [`pkg/${segment}/out.mjs`]: "x", [`pkg/${segment}/deep/er/out.cjs`]: "x" };
      withTree(reader, { files, baseline: {} }, (root) => {
        const result = checkMjsRatchet({ from: root });
        assert.equal(result.ok, true, `${segment}/ is build output, so it holds no source: ${result.message}`);
      });
      for (const near of [`${segment}-src`, `${segment}s`, `my${segment}`, `${segment}.d`]) {
        withTree(reader, { files: { "README.md": "x", [`pkg/${near}/out.mjs`]: "x" }, baseline: {} }, (root) => {
          const result = checkMjsRatchet({ from: root });
          assert.equal(result.ok, false, `${near}/ is not ${segment}/ and its .mjs is source`);
          assert.match(result.message, new RegExp(`pkg/${near.replace(".", "\\.")}/out\\.mjs`));
        });
      }
    });
  }

  test(`[${reader}] a file NAMED like a segment is a file, not build output: dist.mjs counts`, () => {
    withTree(reader, { files: { "README.md": "x", "dist.mjs": "x", "build.js": "x" }, baseline: {} }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      assert.match(result.message, /dist\.mjs/);
    });
  });

  test(`[${reader}] an exception with a why is allowed and not counted; one without a why fails`, () => {
    const files = { "README.md": "x", ".pnpmfile.cjs": "x" };
    const reasoned = { exceptions: [{ path: ".pnpmfile.cjs", why: "pnpm reads only this name" }] };
    withTree(reader, { files, baseline: reasoned }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.count, 0, "the exception is not part of the count");
      assert.match(result.message, /1 reasoned exception/);
    });
    for (const unreasoned of [{ path: ".pnpmfile.cjs" }, { path: ".pnpmfile.cjs", why: "   " }, { path: ".pnpmfile.cjs", why: 7 }]) {
      withTree(reader, { files, baseline: { exceptions: [unreasoned] as never } }, (root) => {
        const result = checkMjsRatchet({ from: root });
        assert.equal(result.ok, false, JSON.stringify(unreasoned));
        assert.match(result.message, /exception `\.pnpmfile\.cjs` has no `why`/);
      });
    }
  });

  test(`[${reader}] an exception is for its own path only: the same name elsewhere is counted`, () => {
    const files = { "README.md": "x", ".pnpmfile.cjs": "x", "sub/.pnpmfile.cjs": "x" };
    withTree(reader, { files, baseline: { exceptions: [{ path: ".pnpmfile.cjs", why: "pnpm reads only this name" }] } }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      assert.match(result.message, /sub\/\.pnpmfile\.cjs/);
    });
  });

  test(`[${reader}] an exception whose file is gone fails, and lowering removes the entry`, () => {
    const baseline = { exceptions: [{ path: ".pnpmfile.cjs", why: "pnpm reads only this name" }] };
    withTree(reader, { files: { "README.md": "x" }, baseline }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false);
      assert.match(result.message, /names a file the tree no longer holds/);
      writeLoweredBaseline({ from: root });
      assert.equal(checkMjsRatchet({ from: root }).ok, true, "the lowered baseline carries no exception for a file that is gone");
    });
  });
}

test("a malformed baseline fails, and says what is wrong with it", () => {
  const cases: Array<[string, RegExp]> = [
    ["not json", /is not JSON/],
    ["[]", /must be an object/],
    [JSON.stringify({ exceptions: [] }), /`files` must be a list of basenames/],
    [JSON.stringify({ files: ["scripts/old.mjs"] }), /BASENAMES, never paths/],
    [JSON.stringify({ files: [], exceptions: "x" }), /`exceptions` must be a list/],
  ];
  for (const [baseline, expected] of cases) {
    withTree("walk", { files: TREE, baseline }, (root) => {
      const result = checkMjsRatchet({ from: root });
      assert.equal(result.ok, false, baseline);
      assert.match(result.message, expected);
    });
  }
});

test("findBaselineRoot walks up from a file or a directory to the baseline, and throws where there is none", () => {
  withTree("walk", { files: { "a/b/c/deep.test.ts": "x" }, baseline: {} }, (root) => {
    assert.equal(findBaselineRoot(join(root, "a/b/c/deep.test.ts")), root);
    assert.equal(findBaselineRoot(join(root, "a/b")), root);
    assert.equal(checkMjsRatchet({ from: join(root, "a/b/c/deep.test.ts") }).root, root);
  });
  const bare = mkdtempSync(join(tmpdir(), "mjs-ratchet-bare-"));
  try {
    mkdirSync(join(bare, ".git"));
    assert.throws(() => findBaselineRoot(bare), /no mjs-ratchet\.baseline\.json/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("a repository with a .git and no baseline does not borrow its parent's", () => {
  withTree("walk", { files: {}, baseline: {} }, (outer) => {
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    assert.throws(() => findBaselineRoot(inner), /no mjs-ratchet\.baseline\.json/);
  });
});

test("isScriptSource reads a path, not a name: only directory segments exclude", () => {
  assert.equal(isScriptSource("a/b.mjs"), true);
  assert.equal(isScriptSource("a/dist/b.mjs"), false);
  assert.equal(isScriptSource("dist/b.mjs"), false);
  assert.equal(isScriptSource("dist.mjs"), true);
  assert.equal(isScriptSource("a/b.d.ts"), false);
  assert.equal(isScriptSource("a/b.mjs.map"), false);
});
