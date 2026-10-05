/**
 * THE CLEAN-CONSUMER CHECK (ADR 0043, Decision 4; a11ign/a11ign#3578): what a repository that installs this package actually gets.
 *
 * It installs the package into an EMPTY project, outside this repository, and then does the four things a consumer does:
 *   1. lists what the tarball ships (`npm pack --dry-run`): no `src/`, no `.map`;
 *   2. `import()`s every `exports` specifier, and resolves the ones that are files (the tsconfig base, the hooks a worker loads by path);
 *   3. type-checks a consumer that names every export, with NodeNext, `strict` and `skipLibCheck` FALSE, so a declaration that reaches a
 *      type the package does not ship fails here and not in somebody's pull request;
 *   4. runs `rstest run` on a one-test project that calls `defineToolchainConfig`, and requires the VERDICT line it prints.
 *
 * `tsx scripts/clean-consumer.ts` packs THIS tree (build first: `pnpm run consumer-check` does); `tsx scripts/clean-consumer.ts
 * @a11ign/toolchain@0.1.0` installs a PUBLISHED version from the registry instead, which is what a release is accepted against.
 * Imports of the package are by NAME on purpose: a relative import would resolve inside this repository and prove nothing.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@a11ign/toolchain";
const PACKAGE_DIR = fileURLToPath(new URL("../packages/toolchain/", import.meta.url));
/** The peers a consumer installs beside the package; the ranges are the package's own, read below, never retyped. */
const PEERS = ["@rstest/core", "@rstest/coverage-v8", "@rslib/core"];

const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });

type Manifest = { version: string; peerDependencies: Record<string, string>; exports: Record<string, string | { types?: string; default?: string }> };

/** What to install: the spec given on the command line, or a tarball packed from this tree. */
function whatToInstall(scratch: string, spec: string | undefined): string {
  if (spec) return spec;
  const [tarball] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch], PACKAGE_DIR)) as { filename: string }[];
  return join(scratch, tarball.filename);
}

function shippedFiles(): string[] {
  const [pack] = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], PACKAGE_DIR)) as { files: { path: string }[] }[];
  return pack.files.map((file) => file.path);
}

function checkTarballContents(): void {
  const files = shippedFiles();
  assert.ok(files.some((file) => file.startsWith("dist/") && file.endsWith(".mjs")), "positive control: the tarball lists its built .mjs files");
  assert.deepEqual(files.filter((file) => file.startsWith("src/") || file.endsWith(".map")), [], "the tarball ships src/ or a source map");
}

function install(consumer: string, spec: string, manifest: Manifest): void {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "clean-consumer", private: true, type: "module" }));
  const peers = PEERS.map((peer) => `${peer}@${manifest.peerDependencies[peer]}`);
  run("npm", ["install", "--no-audit", "--no-fund", spec, ...peers, "typescript@^6", "@types/node@^26"], consumer);
}

/** Every `exports` specifier imports (the JS ones) or resolves to a file that was shipped (the JSON one). */
function importEverySpecifier(consumer: string, specifiers: string[]): void {
  const probe = specifiers.map((specifier) => `
    ${specifier.endsWith(".json")
      ? `const url = import.meta.resolve(${JSON.stringify(specifier)}); if (!(await import("node:fs")).existsSync(new URL(url))) throw new Error("not shipped: ${specifier}");`
      : `await import(${JSON.stringify(specifier)}).catch((cause) => { throw new Error("does not import: ${specifier}", { cause }); });`}`).join("");
  // The hook registers itself on import (`module.registerHooks`), which is what it is for; here it is harmless, the process ends right after.
  writeFileSync(join(consumer, "imports.mjs"), `${probe}\nconsole.log("imported ${specifiers.length} specifiers");\n`);
  console.log(run(process.execPath, ["imports.mjs"], consumer).trim());
}

function typecheckAsConsumer(consumer: string, specifiers: string[]): void {
  const names = specifiers.filter((specifier) => !specifier.endsWith(".json"));
  writeFileSync(join(consumer, "consumer.ts"), [
    `import { defineToolchainConfig, type ToolchainOptions } from "${PACKAGE_NAME}/rstest-config";`,
    `import { entriesFromExports, entryProblems } from "${PACKAGE_NAME}/entries";`,
    `import { libraryPreset } from "${PACKAGE_NAME}/rslib-presets";`,
    `import { verdictLine } from "${PACKAGE_NAME}/verdict-reporter";`,
    `import { runChildCoverage, type ChildCoverageRun } from "${PACKAGE_NAME}/merge-child-coverage";`,
    `export const used = [defineToolchainConfig, entriesFromExports, entryProblems, libraryPreset, verdictLine, runChildCoverage];`,
    `export type Shapes = [ToolchainOptions, ChildCoverageRun];`,
    `// Every specifier's declarations are read, the two a worker loads by path included (their types are the module's own).`,
    `export type Everything = [${names.map((specifier) => `typeof import("${PACKAGE_NAME}/${specifier.slice(2)}")`).join(", ")}];`,
    "",
  ].join("\n"));
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"] },
    include: ["consumer.ts"],
  }));
  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
  console.log("consumer tsc (skipLibCheck false): 0 errors");
}

/** `rstest run` over one test, through `defineToolchainConfig`: the verdict line must say the test ran. */
function runRstestAsConsumer(consumer: string): string {
  writeFileSync(join(consumer, "rstest.config.mjs"), `import { defineToolchainConfig } from "${PACKAGE_NAME}/rstest-config";
export default defineToolchainConfig({ root: import.meta.dirname, include: ["*.test.mjs"] });
`);
  writeFileSync(join(consumer, "one.test.mjs"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("a consumer's test runs on rstest through the shim", () => { assert.equal(1, 1); });\n`);
  // `AI_AGENT` makes rstest treat the run as an agent's, which is what adds the verdict reporter; CI is cleared so the run is not read as CI.
  const env = { ...process.env, AI_AGENT: "clean-consumer", A11Y_RSTEST_RECORD_DIR: join(consumer, "records"), CI: "" };
  const result = spawnSync("npx", ["rstest", "run"], { cwd: consumer, encoding: "utf8", env });
  const verdict = `${result.stdout}${result.stderr}`.split("\n").filter((line) => line.startsWith("VERDICT")).at(-1);
  assert.equal(result.status, 0, `rstest exited ${result.status}:\n${result.stdout}${result.stderr}`);
  assert.match(verdict ?? "", /^VERDICT pass: 1 test in 1 file/, `no passing VERDICT line:\n${result.stdout}${result.stderr}`);
  assert.ok(readdirSync(join(consumer, "records")).length > 0, "the run record was written");
  return verdict as string;
}

function main(): void {
  const scratch = mkdtempSync(join(tmpdir(), "clean-consumer-"));
  const consumer = join(scratch, "project");
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;
    const spec = whatToInstall(scratch, process.argv[2]);
    console.log(`installing ${spec}`);
    mkdirSync(consumer);
    if (!process.argv[2]) checkTarballContents();
    install(consumer, spec, manifest);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", PACKAGE_NAME, "package.json"), "utf8")) as Manifest;
    console.log(`installed ${PACKAGE_NAME}@${installed.version}`);
    const specifiers = Object.keys(installed.exports).map((subpath) => `${PACKAGE_NAME}/${subpath.slice(2)}`);
    assert.ok(specifiers.length > 0, "positive control: the installed package exports something");
    importEverySpecifier(consumer, specifiers);
    typecheckAsConsumer(consumer, Object.keys(installed.exports));
    console.log(runRstestAsConsumer(consumer));
    assert.ok(existsSync(join(consumer, "node_modules", PACKAGE_NAME, "dist")), "dist is installed");
    console.log("clean consumer: PASS");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
