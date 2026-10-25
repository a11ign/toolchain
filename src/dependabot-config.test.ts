/**
 * THE DEPENDABOT CONFIGURATION'S OWN CASES (A11-253, under A11-251). Each rule of the template is run on a tree that exercises it, and the
 * assertion is on the PARSED file, not on a substring, so a key in the wrong place is red. The trees in `dependabot-config.fixtures/` are
 * tree listings of `a11ign`, `agent-org`, `lab` and `a11ign.github.io` as `origin/main` stood on 2026-10-25 (the paths the generator reads and
 * the manifests' names, not the code), each with the extras file its consumer pull request adds. A repository with no root manifest is written
 * by hand below, because the one that has none (`announcement-emulator`, whose package is `/middleware`) is not on `main` yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DEPENDABOT_COMMIT_PREFIX, DEPENDABOT_COOLDOWN_DAYS, DEPENDABOT_EXTRA_FILE, DEPENDABOT_FILE, DEPENDABOT_GROUP_SUFFIX, DEPENDABOT_PULL_REQUEST_LIMIT,
  DEPENDABOT_SCHEDULE, checkDependabotConfig, dependabotGroupName, generateDependabotConfig, lineDiff, main, parseExtras, writeDependabotConfig,
  type DependabotEcosystem,
} from "./dependabot-config.ts";
import { FROZEN } from "./dependabot-frozen.ts";
import type { LayoutTree } from "./layout-check.ts";
import { APPROVE_POLICY_FILE, AUTO_ARM_FILE, DEPENDABOT_AUTO_FILE, GUARD_POLICY_FILE, generateDependabotAuto } from "./dependabot-auto.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./dependabot-config.fixtures/", import.meta.url));
const fixture = (name: string): LayoutTree => (JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as { tree: LayoutTree }).tree;

type Ignore = { "dependency-name": string };
type Update = {
  "package-ecosystem": DependabotEcosystem;
  directory?: string;
  directories?: string[];
  schedule: Record<string, string>;
  groups: Record<string, { patterns: string[]; "update-types": string[] }>;
  "commit-message": { prefix: string };
  cooldown: { "default-days": number };
  "open-pull-requests-limit": number;
  "versioning-strategy"?: string;
  ignore?: Ignore[];
  labels?: unknown;
};
const updatesOf = (tree: LayoutTree): Update[] => (parse(generateDependabotConfig(tree)) as { updates: Update[] }).updates;
const entryFor = (tree: LayoutTree, ecosystem: DependabotEcosystem): Update => {
  const found = updatesOf(tree).find((update) => update["package-ecosystem"] === ecosystem);
  assert.ok(found, `the tree has a ${ecosystem} entry`);
  return found;
};
const ignoredIn = (update: Update): string[] => (update.ignore ?? []).map((ignore) => ignore["dependency-name"]);

const FIXTURE_NAMES = ["a11ign", "agent-org", "lab", "a11ign-github-io"] as const;
const manifest = (fields: Record<string, unknown>): string => JSON.stringify(fields);
const MIDDLEWARE_ONLY: LayoutTree = {
  "README.md": "",
  "middleware/package.json": manifest({ name: "announcement-middleware" }),
  ".github/workflows/ci.yml": "",
  ".github/dependabot-extra.json": manifest({ npm: { directories: ["/middleware"] } }),
};

// ---- the standard entry -------------------------------------------------------------------------------------------------------------------

test("every ecosystem of every repository is weekly at the one fixed time", () => {
  for (const name of FIXTURE_NAMES) {
    const updates = updatesOf(fixture(name));
    assert.ok(updates.length >= 1, `positive control: ${name} has an entry`);
    for (const update of updates) assert.deepEqual(update.schedule, { interval: "weekly", day: "monday", time: "05:23", timezone: "Etc/UTC" }, `${name} ${update["package-ecosystem"]}`);
  }
  assert.deepEqual({ ...DEPENDABOT_SCHEDULE }, { interval: "weekly", day: "monday", time: "05:23", timezone: "Etc/UTC" });
});

test("patch and minor are ONE group per ecosystem, and a major matches no group", () => {
  for (const name of FIXTURE_NAMES) {
    for (const update of updatesOf(fixture(name))) {
      const ecosystem = update["package-ecosystem"];
      assert.deepEqual(update.groups, { [`${ecosystem}-minor-and-patch`]: { patterns: ["*"], "update-types": ["minor", "patch"] } }, `${name} ${ecosystem}`);
    }
  }
});

test("the conventions A11-254 and A11-255 read are constants, and the file is written from them", () => {
  assert.equal(DEPENDABOT_GROUP_SUFFIX, "-minor-and-patch");
  assert.equal(DEPENDABOT_COMMIT_PREFIX, "deps");
  assert.equal(dependabotGroupName("npm"), "npm-minor-and-patch");
  assert.equal(dependabotGroupName("github-actions"), "github-actions-minor-and-patch");
  const npm = entryFor(fixture("lab"), "npm");
  assert.deepEqual(Object.keys(npm.groups), [dependabotGroupName("npm")]);
  assert.deepEqual(npm["commit-message"], { prefix: DEPENDABOT_COMMIT_PREFIX });
  assert.deepEqual(npm.cooldown, { "default-days": DEPENDABOT_COOLDOWN_DAYS });
  assert.equal(npm["open-pull-requests-limit"], DEPENDABOT_PULL_REQUEST_LIMIT);
});

test("no entry sets `labels`, so Dependabot's own `dependencies` and ecosystem labels apply", () => {
  for (const name of FIXTURE_NAMES) for (const update of updatesOf(fixture(name))) assert.equal(update.labels, undefined);
  assert.doesNotMatch(generateDependabotConfig(fixture("a11ign")), /labels/);
});

test("the file says it is generated, names the way to change it, and carries no toolchain version", () => {
  const text = generateDependabotConfig(fixture("lab"));
  assert.match(text.split("\n")[0], /^# GENERATED by `dependabot-config --write`.*DO NOT EDIT BY HAND/);
  assert.match(text, /dependabot-extra\.json/);
  assert.doesNotMatch(text, /@a11ign\/toolchain@|\d+\.\d+\.\d+/, "a toolchain release must not change the file, or every toolchain bump would fail the check");
});

// ---- the ecosystems are read from the tree ------------------------------------------------------------------------------------------------

test("npm is at the root when a root manifest exists, github-actions when workflows exist, pip for each requirements or pyproject directory", () => {
  assert.deepEqual(updatesOf(fixture("lab")).map((update) => update["package-ecosystem"]), ["npm", "github-actions"]);
  assert.deepEqual(updatesOf(fixture("a11ign")).map((update) => update["package-ecosystem"]), ["npm", "pip", "github-actions"]);
  const withPyproject: LayoutTree = { "package.json": manifest({ name: "x" }), "tools/pyproject.toml": "", "tools/requirements-dev.txt": "", "notes.txt": "" };
  const pip = entryFor(withPyproject, "pip");
  assert.equal(pip.directory, "/tools");
  assert.equal(pip.directories, undefined, "one directory is written as `directory`");
  assert.equal(updatesOf(withPyproject).some((update) => update["package-ecosystem"] === "github-actions"), false, "no workflows, no github-actions entry");
});

test("a11ign's two Python directories are ONE pip entry, so one group pull request moves both requirements files together", () => {
  const pip = entryFor(fixture("a11ign"), "pip");
  assert.deepEqual(pip.directories, ["/", "/packages/scorer"]);
  assert.equal(pip.directory, undefined);
  assert.deepEqual(Object.keys(pip.groups), ["pip-minor-and-patch"]);
  assert.equal(pip.ignore, undefined, "no frozen or workspace name is a pip package");
});

test("Python files in test data and virtual environments are not a project", () => {
  const tree: LayoutTree = { "package.json": manifest({ name: "x" }), "src/fixtures/a/requirements.txt": "", "src/case.fixtures/requirements.txt": "", ".venv/pyproject.toml": "" };
  assert.equal(updatesOf(tree).some((update) => update["package-ecosystem"] === "pip"), false);
});

test("only a workflow YAML file means github-actions: a README under .github/workflows does not", () => {
  const readmeOnly: LayoutTree = { "package.json": manifest({ name: "x" }), ".github/workflows/README.md": "" };
  assert.equal(updatesOf(readmeOnly).some((update) => update["package-ecosystem"] === "github-actions"), false);
  assert.ok(updatesOf({ ...readmeOnly, ".github/workflows/ci.yaml": "" }).some((update) => update["package-ecosystem"] === "github-actions"), "negative control: a .yaml workflow counts");
});

test("a Python directory YAML could misread is refused, not written", () => {
  assert.throws(() => generateDependabotConfig({ "package.json": manifest({ name: "x" }), "docs #1/requirements.txt": "" }), /Python project in \/docs #1 has a name the generator will not write/);
  assert.throws(() => generateDependabotConfig({ "package.json": manifest({ name: "x" }), "a: b/pyproject.toml": "" }), /will not write/);
});

test("a repository whose package is not at the root says so, and gets no root npm entry", () => {
  const updates = updatesOf(MIDDLEWARE_ONLY);
  assert.deepEqual(updates.map((update) => [update["package-ecosystem"], update.directory]), [["npm", "/middleware"], ["github-actions", "/"]]);
});

test("several npm directories are ONE entry with `directories`, so one group pull request covers them", () => {
  const npm = entryFor(fixture("agent-org"), "npm");
  assert.deepEqual(npm.directories, ["/", "/ui"]);
  assert.equal(npm.directory, undefined);
  assert.equal(updatesOf(fixture("agent-org")).filter((update) => update["package-ecosystem"] === "npm").length, 1);
});

test("a tree with nothing to update, or no file, is refused rather than written as an empty config", () => {
  assert.throws(() => generateDependabotConfig({}), /holds no file/);
  assert.throws(() => generateDependabotConfig({ "README.md": "" }), /nothing to update/);
});

// ---- the ignore list ----------------------------------------------------------------------------------------------------------------------

test("every FROZEN name is in the npm ignore of every repository that has npm, and the list has the four the policy names", () => {
  assert.deepEqual(FROZEN.map(({ name }) => name), ["@a11ign/screenreader-worker", "@a11ign/screenreader-fleet", "@guidepup/guidepup", "@guidepup/setup"]);
  for (const name of FIXTURE_NAMES) {
    const ignored = ignoredIn(entryFor(fixture(name), "npm"));
    for (const { name: frozen } of FROZEN) assert.ok(ignored.includes(frozen), `${name} ignores ${frozen}`);
  }
  assert.ok(ignoredIn(entryFor(MIDDLEWARE_ONLY, "npm")).includes("@guidepup/guidepup"));
});

test("a frozen name is not an Actions or pip ignore: they are npm packages", () => {
  assert.equal(entryFor(fixture("lab"), "github-actions").ignore, undefined);
  assert.equal(entryFor(fixture("a11ign"), "pip").ignore, undefined);
});

test("each ignore is written with its reason on the line above, and the frozen ones say FROZEN", () => {
  const lines = generateDependabotConfig(fixture("lab")).split("\n");
  for (const { name, reason } of FROZEN) {
    const at = lines.findIndex((line) => line.endsWith(`- dependency-name: ${JSON.stringify(name)}`));
    assert.ok(at > 0, `${name} is written`);
    assert.equal(lines[at - 1].trim(), `# FROZEN: ${reason}`);
  }
  const control = lines.findIndex((line) => line.includes('"@a11ign/control"'));
  assert.match(lines[control - 1], /# not on the registry/);
});

test("the workspace's own packages are ignored: the members of pnpm-workspace.yaml and the root, from their manifests", () => {
  const ignored = ignoredIn(entryFor(fixture("a11ign"), "npm"));
  for (const name of ["a11ign-monorepo", "a11ign", "@a11ign/evidence", "@a11ign/guards", "@a11ign/judge", "@a11ign/scorer"]) {
    assert.ok(ignored.includes(name), `${name} is a workspace package`);
  }
  assert.ok(!ignored.includes("fixture-root"), "a manifest the workspace globs do not reach is not a member");
  const synthetic: LayoutTree = {
    "package.json": manifest({ name: "root-pkg", private: true }), "pnpm-workspace.yaml": 'packages:\n  - "libs/*"\n',
    "libs/a/package.json": manifest({ name: "@x/a" }), "elsewhere/b/package.json": manifest({ name: "@x/not-a-member" }),
  };
  assert.deepEqual(ignoredIn(entryFor(synthetic, "npm")).filter((name) => name.startsWith("@x/") || name === "root-pkg"), ["@x/a", "root-pkg"]);
});

test("a name that is frozen AND a workspace package AND in the extras is written once, with the first reason", () => {
  const tree: LayoutTree = {
    "package.json": manifest({ name: "@guidepup/guidepup" }),
    [DEPENDABOT_EXTRA_FILE]: manifest({ npm: { ignore: [{ name: "@guidepup/guidepup", reason: "again" }, { name: "serve", reason: "owned here" }] } }),
  };
  const ignored = ignoredIn(entryFor(tree, "npm"));
  assert.equal(ignored.filter((name) => name === "@guidepup/guidepup").length, 1);
  assert.ok(ignored.includes("serve"));
  assert.doesNotMatch(generateDependabotConfig(tree), /again/);
});

test("a repository's extras add an ignore, a versioning strategy and directories, and nothing else moves", () => {
  const tree: LayoutTree = {
    "package.json": manifest({ name: "x" }), ".github/workflows/ci.yml": "",
    [DEPENDABOT_EXTRA_FILE]: manifest({ npm: { "versioning-strategy": "increase" }, "github-actions": { ignore: [{ name: "a11ign/a11ign", reason: "generated pin" }] } }),
  };
  assert.equal(entryFor(tree, "npm")["versioning-strategy"], "increase");
  assert.equal(entryFor(tree, "github-actions")["versioning-strategy"], undefined);
  assert.deepEqual(ignoredIn(entryFor(tree, "github-actions")), ["a11ign/a11ign"]);
  assert.deepEqual(entryFor(tree, "npm").schedule, entryFor(fixture("lab"), "npm").schedule);
});

// ---- the extras schema --------------------------------------------------------------------------------------------------------------------

test("the extras schema refuses every key that would opt a repository out of the template, naming the file and the key", () => {
  const refused: [unknown, RegExp][] = [
    [{ npm: { schedule: { interval: "daily" } } }, /npm has the key "schedule", which is not accepted/],
    [{ npm: { groups: {} } }, /npm has the key "groups"/],
    [{ npm: { labels: ["x"] } }, /npm has the key "labels"/],
    [{ npm: { "commit-message": { prefix: "chore" } } }, /npm has the key "commit-message"/],
    [{ "github-actions": { directories: ["/"] } }, /github-actions has the key "directories"/],
    [{ pip: { "versioning-strategy": "increase" } }, /pip has the key "versioning-strategy"/],
    [{ ruby: {} }, /has the key "ruby", which is not an ecosystem/],
    [{ npm: { ignore: [{ name: "x" }] } }, /npm\.ignore\[0\] \(x\) needs a one-line reason/],
    [{ npm: { ignore: [{ name: "x", reason: "  " }] } }, /needs a one-line reason/],
    [{ npm: { ignore: [{ name: "x", reason: "a\nb" }] } }, /needs a one-line reason/],
    [{ npm: { ignore: [{ name: "x", reason: "r", versions: ["1"] }] } }, /has the key "versions", which is not accepted/],
    [{ npm: { ignore: "x" } }, /npm\.ignore must be an array/],
    [{ npm: { directories: [] } }, /npm\.directories must be a non-empty array/],
    [{ npm: { directories: ["ui"] } }, /npm\.directories must be a non-empty array of absolute directories/],
    [{ npm: { directories: ["/../x"] } }, /npm\.directories must be a non-empty array/],
    [{ npm: { directories: ["//"] } }, /npm\.directories must be a non-empty array/],
    [{ npm: { directories: ["/a/"] } }, /npm\.directories must be a non-empty array/],
    [{ npm: { "versioning-strategy": "yolo" } }, /versioning-strategy must be one of/],
    [[], /must be an object keyed by ecosystem/],
  ];
  for (const [extras, message] of refused) {
    assert.throws(() => parseExtras(JSON.stringify(extras)), (error: Error) => message.test(error.message) && error.message.includes(DEPENDABOT_EXTRA_FILE), JSON.stringify(extras));
  }
  assert.throws(() => parseExtras("{ not json"), /dependabot-extra\.json is not JSON/);
  assert.deepEqual(parseExtras("{}"), {}, "negative control: an empty extras file is accepted");
});

test("an extras file the schema refuses stops generation", () => {
  const tree: LayoutTree = { "package.json": manifest({ name: "x" }), [DEPENDABOT_EXTRA_FILE]: manifest({ npm: { schedule: {} } }) };
  assert.throws(() => generateDependabotConfig(tree), /npm has the key "schedule"/);
});

// ---- the drift check ----------------------------------------------------------------------------------------------------------------------

type Disk = { root: string; run: (...argv: string[]) => { code: number; log: string[]; error: string[] } };
function onDisk(tree: LayoutTree, body: (disk: Disk) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dependabot-config-"));
  try {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    body({
      root,
      run: (...argv) => {
        const log: string[] = [];
        const error: string[] = [];
        return { code: main(argv, { log: (line) => log.push(line), error: (line) => error.push(line) }), log, error };
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/** What `--check` also reads (A11-254): the two policies, which a repository hand-writes, and the `auto-arm.yml` whose `arm-approved` queues an approval. */
const WITH_APPROVAL = (tree: LayoutTree): LayoutTree => ({
  ...tree,
  [APPROVE_POLICY_FILE]: readFileSync(`${FIXTURES.replace("dependabot-config.fixtures", "dependabot-auto.fixtures")}approve.sts.yaml`, "utf8"),
  [GUARD_POLICY_FILE]: readFileSync(`${FIXTURES.replace("dependabot-config.fixtures", "dependabot-auto.fixtures")}guard.sts.yaml`, "utf8"),
  [AUTO_ARM_FILE]: readFileSync(`${FIXTURES.replace("dependabot-config.fixtures", "dependabot-auto.fixtures")}auto-arm.yml`, "utf8"),
});
const LAB_ON_DISK = (): LayoutTree => WITH_APPROVAL({ ...fixture("lab"), "package.json": manifest({ name: "@a11ign/lab" }) });

test("--check passes on what --write made, and fails with the diff and the fix when the file is edited by hand", () => {
  onDisk(LAB_ON_DISK(), ({ root, run }) => {
    assert.equal(run("--write", "--root", root).code, 0);
    assert.ok(existsSync(join(root, DEPENDABOT_FILE)));
    const clean = run("--check", "--root", root);
    assert.equal(clean.code, 0);
    assert.match(clean.log.join(), /dependabot-config: ok/);

    const path = join(root, DEPENDABOT_FILE);
    writeFileSync(path, readFileSync(path, "utf8").replace("interval: weekly", "interval: daily"));
    const drifted = run("--check", "--root", root);
    assert.equal(drifted.code, 1);
    const message = drifted.error.join("\n");
    assert.match(message, /^dependabot-config: FAIL \.github\/dependabot\.yml drifted from the template/);
    assert.match(message, /^- {7}interval: daily$/m);
    assert.match(message, /^\+ {7}interval: weekly$/m);
    assert.match(message, /dependabot-config --write --root /);
  });
});

test("--check fails when the file is missing, and when a frozen ignore is deleted from it", () => {
  onDisk(LAB_ON_DISK(), ({ root, run }) => {
    const missing = run("--check", "--root", root);
    assert.equal(missing.code, 1);
    assert.match(missing.error.join("\n"), /does not exist; it should be:/);
    run("--write", "--root", root);
    const path = join(root, DEPENDABOT_FILE);
    const without = readFileSync(path, "utf8").split("\n").filter((line) => !line.includes('"@guidepup/guidepup"')).join("\n");
    writeFileSync(path, without);
    const result = checkDependabotConfig({ root });
    assert.equal(result.ok, false);
    assert.match(result.message, /^\+ .*dependency-name: "@guidepup\/guidepup"$/m);
  });
});

test("--write also writes dependabot-auto.yml, and --check fails with its diff when that file is edited by hand or missing (A11-254)", () => {
  onDisk(LAB_ON_DISK(), ({ root, run }) => {
    const wrote = run("--write", "--root", root);
    assert.match(wrote.log.join(), /dependabot-auto\.yml/);
    const path = join(root, DEPENDABOT_AUTO_FILE);
    assert.equal(readFileSync(path, "utf8"), generateDependabotAuto());
    assert.equal(run("--check", "--root", root).code, 0);

    writeFileSync(path, readFileSync(path, "utf8").replace("[opened, reopened, synchronize]", "[opened, reopened, synchronize, labeled]"));
    const drifted = run("--check", "--root", root);
    assert.equal(drifted.code, 1);
    assert.match(drifted.error.join("\n"), /^dependabot-config: FAIL \.github\/workflows\/dependabot-auto\.yml drifted from the template/);
    assert.match(drifted.error.join("\n"), /^\+ {5}types: \[opened, reopened, synchronize\]$/m);

    rmSync(path);
    assert.match(run("--check", "--root", root).error.join("\n"), /dependabot-auto\.yml does not exist; it should be:/);
  });
});

test("--check fails, naming the file and the field, when the approving policy loses its actor pin or is missing, and when another workflow approves (A11-254)", () => {
  onDisk(LAB_ON_DISK(), ({ root, run }) => {
    run("--write", "--root", root);
    assert.equal(run("--check", "--root", root).code, 0, "positive control: the policies and workflows as written pass");
    const policy = join(root, APPROVE_POLICY_FILE);
    const good = readFileSync(policy, "utf8");

    writeFileSync(policy, good.replace(/ {2}actor_id: .*\n/, ""));
    const unpinned = run("--check", "--root", root);
    assert.equal(unpinned.code, 1);
    assert.match(unpinned.error.join("\n"), /^dependabot-config: FAIL \.github\/chainguard\/dependabot-approve\.sts\.yaml: claim_pattern\.actor_id is missing, expected "49699333"$/m);

    rmSync(policy);
    assert.match(run("--check", "--root", root).error.join("\n"), /dependabot-approve\.sts\.yaml: does not exist/);
    writeFileSync(policy, good);
    assert.equal(run("--check", "--root", root).code, 0);

    writeFileSync(join(root, ".github/workflows/review-bot.yml"), "jobs:\n  r:\n    steps:\n      - run: gh pr review 1 --approve\n");
    const approver = run("--check", "--root", root);
    assert.equal(approver.code, 1);
    assert.match(approver.error.join("\n"), /FAIL \.github\/workflows\/review-bot\.yml: submits an approving review/);
  });
});

test("a repository with no workflow of its own is written WITH a github-actions entry, because --write gives it dependabot-auto.yml, and --check then passes (A11-254)", () => {
  onDisk(WITH_APPROVAL({ "package.json": manifest({ name: "x" }) }), ({ root, run }) => {
    rmSync(join(root, AUTO_ARM_FILE));
    assert.equal(existsSync(join(root, ".github/workflows/dependabot-auto.yml")), false, "positive control: the repository has no workflow yet");
    assert.equal(run("--write", "--root", root).code, 0);
    assert.match(readFileSync(join(root, DEPENDABOT_FILE), "utf8"), /package-ecosystem: github-actions/);
    assert.doesNotMatch(run("--check", "--root", root).error.join("\n"), /dependabot\.yml drifted/, "the config written is the config checked");
  });
});

test("--check fails when the workspace gains a package and the file was not regenerated", () => {
  onDisk(WITH_APPROVAL({ "package.json": manifest({ name: "root", private: true }), "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n', "packages/a/package.json": manifest({ name: "@x/a" }) }), ({ root, run }) => {
    run("--write", "--root", root);
    assert.equal(run("--check", "--root", root).code, 0);
    mkdirSync(join(root, "packages/b"), { recursive: true });
    writeFileSync(join(root, "packages/b/package.json"), manifest({ name: "@x/b" }));
    const drifted = run("--check", "--root", root);
    assert.equal(drifted.code, 1);
    assert.match(drifted.error.join("\n"), /^\+ .*dependency-name: "@x\/b"$/m);
  });
});

test("the command refuses an unknown flag, no mode, no root value and an unreadable tree with exit 2", () => {
  onDisk({}, ({ root, run }) => {
    assert.equal(run("--write", "--root", root).code, 2, "an empty directory is not a repository");
    assert.match(run("--check", "--root", root).error.join(), /holds no file/);
  });
  const sink = (...argv: string[]) => {
    const error: string[] = [];
    return { code: main(argv, { log: () => undefined, error: (line) => error.push(line) }), error: error.join() };
  };
  assert.match(sink("--check", "--force").error, /unknown argument --force/);
  assert.match(sink().error, /say --write or --check/);
  assert.match(sink("--check", "--root").error, /--root needs a directory/);
  assert.equal(sink("--check", "--root", join(tmpdir(), "dependabot-config-no-such-directory")).code, 2);
});

test("--root=<dir> is the same as --root <dir>, and writeDependabotConfig makes .github when it is absent", () => {
  onDisk(WITH_APPROVAL({ "package.json": manifest({ name: "x" }) }), ({ root, run }) => {
    assert.equal(run("--write", `--root=${root}`).code, 0);
    assert.equal(writeDependabotConfig({ root }), join(root, DEPENDABOT_FILE));
    assert.equal(run("--check", `--root=${root}`).code, 0);
  });
});

test("lineDiff shows only what changed, in order", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nx\nc\n"), ["  a", "- b", "+ x", "  c", "  "]);
  assert.deepEqual(lineDiff("a", "a"), ["  a"]);
});

// ---- the built bin ------------------------------------------------------------------------------------------------------------------------

test("the built bin writes and checks a directory, as `pnpm exec dependabot-config` does", () => {
  const bin = join(PACKAGE, "dist", "dependabot-config.mjs");
  assert.ok(existsSync(bin), "dist/dependabot-config.mjs is built (pnpm test builds first); a missing bin is the failure, not a skip");
  onDisk(WITH_APPROVAL({ "package.json": manifest({ name: "x" }) }), ({ root }) => {
    assert.equal(spawnSync("node", [bin, "--check", "--root", root], { encoding: "utf8" }).status, 1, "no file yet is drift");
    assert.equal(spawnSync("node", [bin, "--write", "--root", root], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("node", [bin, "--check", "--root", root], { encoding: "utf8" }).status, 0);
  });
});
