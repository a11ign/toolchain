/**
 * #2181: a worktree whose `@a11ign/*` resolve somewhere else measures THAT checkout, and one command says so.
 *
 * Measured 2026-09-23: 42 of 56 worktrees on the agent host read the PRIMARY's `packages/`, so
 * `npm run test:all` gave 7,253 passed at a head CI was failing. **The symlink was a cost-saving choice and
 * is being retired by pnpm (#57, #2300); what was missing was any line saying the tree under test is not the
 * tree under test, and the trees not yet converted still need it.**
 *
 * CONSTRUCTED TREES, real symlinks: the classifier's whole content is what `realpath` returns, so a
 * fake filesystem would test the string handling and leave the resolution untouched.
 *
 * FOUR TESTS STAYED IN a11ign/a11ign (#4585): the two `#3447` ones call `memberScopeLister`, `#2218 THE CALLER` runs a copy of
 * `assert-glob-not-empty.ts`, and `#2181 THE CALLER` spawns the `agent-org` CLI (on the agent host's PATH, not in CI), so they test the CALLER
 * and not this leaf. They move with the caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESOLUTION, OVERRIDE_ENV, worktreeResolution, resolutionLine, classifyResolvedPath, suiteStartVerdict,
} from "./worktree-resolution.ts";

const PACKAGE = "agent-org";

/** A scratch directory holding the trees a test builds, removed afterwards. */
function withScratch(body: (base: string) => void) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "resolution-")));
  try { body(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

/** A checkout with its own `packages/<PACKAGE>` directory. */
function checkout(base: string, name: string) {
  const root = join(base, name);
  mkdirSync(join(root, "packages", PACKAGE), { recursive: true });
  return root;
}

/** Make `tree/node_modules/@a11ign/agent-org` a symlink to `target`. */
function linkScope(tree: string, target: string) {
  mkdirSync(join(tree, "node_modules", "@a11ign"), { recursive: true });
  symlinkSync(target, join(tree, "node_modules", "@a11ign", PACKAGE));
}

test("#2181 OWN PACKAGES: a tree linked to its own packages/ reads SAFE, and says a run measures this branch", () => {
  withScratch((base) => {
    const tree = checkout(base, "wt-own");
    linkScope(tree, join(tree, "packages", PACKAGE));
    const result = worktreeResolution(tree);
    assert.equal(result.kind, RESOLUTION.OWN_PACKAGES);
    assert.match(resolutionLine(tree, result), /measures this branch/);
  });
});

test("#2300 PNPM: an own-install tree links @a11ign/* by RELATIVE path into its own packages/ and reads SAFE", () => {
  // The layout `pnpm install --frozen-lockfile` writes (read off a real install: `evidence -> ../../packages/evidence`),
  // not the absolute link the other tests build. Paired with the same relative shape aimed OUTSIDE, because a
  // classifier that called every relative link safe would pass the first half and be the defect this file exists for.
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const own = checkout(base, "wt-pnpm");
    mkdirSync(join(own, "node_modules", "@a11ign"), { recursive: true });
    symlinkSync(`../../packages/${PACKAGE}`, join(own, "node_modules", "@a11ign", PACKAGE));
    assert.equal(worktreeResolution(own).kind, RESOLUTION.OWN_PACKAGES);
    assert.deepEqual(suiteStartVerdict(own, { env: {} }), { action: "proceed", line: null });

    const symlinked = checkout(base, "wt-symlinked");
    mkdirSync(join(symlinked, "node_modules", "@a11ign"), { recursive: true });
    symlinkSync(`../../../primary/packages/${PACKAGE}`, join(symlinked, "node_modules", "@a11ign", PACKAGE));
    const control = worktreeResolution(symlinked);
    assert.equal(control.kind, RESOLUTION.OTHER_CHECKOUT, "control: a link into another checkout is still reported");
    assert.deepEqual(control.checkouts, [primary]);
    assert.equal(suiteStartVerdict(symlinked, { env: {} }).action, "refuse");
  });
});

test("#2300: the remedy a refused tree is handed is the pnpm install, not a symlink or an npm install", () => {
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const tree = checkout(base, "wt-remedy");
    linkScope(tree, join(primary, "packages", PACKAGE));
    const said = resolutionLine(tree, worktreeResolution(tree));
    assert.match(said, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(said, /(^|[^p])npm install|ln -s/, // "pnpm install" contains "npm install"
       "the advice must not lead into the refusal `.pnpmfile.cjs` gives a symlink");
    const bare = checkout(base, "wt-bare");
    assert.match(resolutionLine(bare, worktreeResolution(bare)), /pnpm install --frozen-lockfile/);
  });
});

test("#2181 OTHER CHECKOUT: a tree linked to another checkout's packages/ names that checkout", () => {
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const tree = checkout(base, "wt-outside");
    linkScope(tree, join(primary, "packages", PACKAGE));
    const result = worktreeResolution(tree);
    assert.equal(result.kind, RESOLUTION.OTHER_CHECKOUT);
    assert.deepEqual(result.checkouts, [primary]);
    const said = resolutionLine(tree, result);
    assert.ok(said.includes(primary), "the line must NAME the checkout being read -- that ends the investigation");
    assert.match(said, /measures that checkout and not this branch/);
  });
});

test("#2181 STALE COPY: a copy under the tree's own node_modules/ is NOT safe -- the wt-1315 shape", () => {
  withScratch((base) => {
    const tree = checkout(base, "wt-copy");
    const copy = join(tree, "node_modules", "@a11ign", PACKAGE);
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "index.mjs"), "// frozen at install time\n");
    const result = worktreeResolution(tree);
    assert.equal(result.kind, RESOLUTION.STALE_COPY);
    assert.notEqual(result.kind, RESOLUTION.OWN_PACKAGES,
      "INSIDE the worktree is not the worktree's source: a containment-only classifier calls this SAFE, and "
      + "the population the row was written for is then smaller than it looks");
    assert.match(resolutionLine(tree, result), /COPY under this tree's own node_modules/);
  });
});

test("#2181: node_modules is asked BEFORE containment -- the order is the content of classifyResolvedPath", () => {
  // Both paths are under the worktree; only the `node_modules` question tells them apart.
  assert.equal(classifyResolvedPath("/w", "/w/node_modules/@a11ign/x").kind, RESOLUTION.STALE_COPY);
  assert.equal(classifyResolvedPath("/w", "/w/packages/x").kind, RESOLUTION.OWN_PACKAGES);
  // A sibling that shares the prefix is not inside it. The decoy sits AT the segment boundary, because a
  // bare startsWith is only fooled by `/w/packages-old`, not by a different worktree's longer name.
  assert.equal(classifyResolvedPath("/w", "/w/packages-old/x").kind, RESOLUTION.OTHER_CHECKOUT);
  assert.equal(classifyResolvedPath("/w", "/w/node_modules-old/x").kind, RESOLUTION.OTHER_CHECKOUT);
});

test("#2181: the MOST SEVERE kind wins, and a tree with no links is NOT called safe", () => {
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const tree = checkout(base, "wt-mixed");
    linkScope(tree, join(tree, "packages", PACKAGE));
    symlinkSync(join(primary, "packages", PACKAGE), join(tree, "node_modules", "@a11ign", "other"));
    assert.equal(worktreeResolution(tree).kind, RESOLUTION.OTHER_CHECKOUT,
      "one lying package answers 'may I trust a suite run here'");

    const bare = checkout(base, "wt-bare");
    const nothing = worktreeResolution(bare);
    assert.equal(nothing.kind, RESOLUTION.NOTHING_LINKED);
    assert.match(resolutionLine(bare, nothing), /Not "safe"/);
  });
});

test("#2181: a DANGLING link is reported as nothing-linked rather than throwing", () => {
  withScratch((base) => {
    const tree = checkout(base, "wt-dangling");
    linkScope(tree, join(base, "deleted", PACKAGE));
    assert.equal(worktreeResolution(tree).kind, RESOLUTION.NOTHING_LINKED);
  });
});

test("#2218 THE GREEN DIRECTION: a tree wired to another checkout REFUSES, and a correctly wired one is SILENT", () => {
  // The pair is the control: `refuse` on the broken tree is only worth believing beside a `proceed` on the
  // right one, and a host where all 44 trees are mis-wired would otherwise be indistinguishable from a
  // check that fires on everything.
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const broken = checkout(base, "wt-broken");
    linkScope(broken, join(primary, "packages", PACKAGE));
    const right = checkout(base, "wt-right");
    linkScope(right, join(right, "packages", PACKAGE));

    const refused = suiteStartVerdict(broken, { env: {} });
    assert.equal(refused.action, "refuse");
    assert.ok(refused.line?.includes(primary), "the refusal names the checkout being read");
    assert.ok(refused.line?.includes(OVERRIDE_ENV), "and names the one way past it");
    assert.deepEqual(suiteStartVerdict(right, { env: {} }), { action: "proceed", line: null });
  });
});

test("#2218: a stale COPY refuses too -- inside the tree is not the tree's source", () => {
  withScratch((base) => {
    const tree = checkout(base, "wt-copy");
    mkdirSync(join(tree, "node_modules", "@a11ign", PACKAGE), { recursive: true });
    assert.equal(suiteStartVerdict(tree, { env: {} }).action, "refuse");
  });
});

test("#2218: an override still PRINTS -- it is `warn`, never silence -- and only the exact value 1 counts", () => {
  withScratch((base) => {
    const primary = checkout(base, "primary");
    const tree = checkout(base, "wt-override");
    linkScope(tree, join(primary, "packages", PACKAGE));
    const warned = suiteStartVerdict(tree, { env: { [OVERRIDE_ENV]: "1" } });
    assert.equal(warned.action, "warn");
    assert.ok(warned.line?.includes(primary), "the override does not stop the line naming what is being read");
    for (const value of ["", "0", "true", "yes"]) {
      assert.equal(suiteStartVerdict(tree, { env: { [OVERRIDE_ENV]: value } }).action, "refuse", `"${value}"`);
    }
  });
});

test("#2218: a tree with NOTHING linked proceeds -- the runner cannot start there and says so itself", () => {
  withScratch((base) => {
    assert.equal(suiteStartVerdict(checkout(base, "wt-fresh"), { env: {} }).action, "proceed");
  });
});
