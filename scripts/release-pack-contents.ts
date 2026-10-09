/**
 * THE PACK-CONTENT CHECK (a11ign/a11ign#4310): a tarball that does not hold every file the manifest points at is refused.
 *
 * `@a11ign/toolchain@0.1.6` was published with 4 files where 0.1.5 had 22. #4213 flattened the package to the repository root and dropped its
 * `prepack`, so the release packed an unbuilt tree: every `exports` target and the `layout-check` bin pointed into a `dist` the tarball did not hold,
 * and the release and its consumer-check were green, because the consumer-check builds first and packs nothing from the registry.
 *
 * The check reads the PACKED LIST (`npm pack --dry-run --json`, which runs `prepack`), never the source tree: the source tree holds a `dist` after
 * `pnpm run build`, and a check that read it would pass on the very tree that published empty. It also removes `dist` first, because CI has built
 * already and a stale `dist` would let a missing `prepack` pass: only `prepack` can put it back.
 *
 * `pnpm run pack-check` runs it; importing the module runs nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));

type Target = string | { [condition: string]: Target };
export type Manifest = { exports?: Record<string, Target>; bin?: string | Record<string, string> };

const leaves = (target: Target): string[] => (typeof target === "string" ? [target] : Object.values(target).flatMap(leaves));
const packed = (path: string): string => path.replace(/^\.\//, "");

/** Every file the manifest promises: each `exports` target (types and default alike) and each `bin` path, as `npm pack` writes a path. */
export function promisedPaths(manifest: Manifest): string[] {
  const fromExports = Object.values(manifest.exports ?? {}).flatMap(leaves);
  const fromBin = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  return [...new Set([...fromExports, ...fromBin].map(packed))];
}

/**
 * The file paths of `npm pack --dry-run --json`'s output, or `undefined` when the output is not a listing. npm 11 lets a `prepack` build print to
 * the stdout the JSON is read from, so a listing that does not parse whole is read from the last line that is a bare `[`, where npm starts it.
 */
export function listedPaths(stdout: string): string[] | undefined {
  const start = stdout.lastIndexOf("\n[\n");
  for (const text of [stdout, start === -1 ? "" : stdout.slice(start + 1)]) {
    try {
      const files = (JSON.parse(text) as { files?: { path?: unknown }[] }[])[0]?.files;
      if (Array.isArray(files) && files.every((file) => typeof file.path === "string")) return files.map((file) => file.path as string);
    } catch {
      // not JSON, or not a listing: the next reading is tried, and `undefined` is the refusal when none parses.
    }
  }
  return undefined;
}

/** The reasons to refuse the tarball; empty means every promised path is in it. An unreadable listing is a refusal, never an acceptance. */
export function packRefusals(stdout: string, manifest: Manifest): string[] {
  const promised = promisedPaths(manifest);
  if (promised.length === 0) return ["the manifest promises no file, so the listing cannot be checked against anything"];
  const listed = listedPaths(stdout);
  if (listed === undefined) return ["the pack listing is unreadable: not the JSON `npm pack --dry-run --json` prints"];
  if (listed.length === 0) return ["the pack listing holds no file"];
  const present = new Set(listed);
  return promised.filter((path) => !present.has(path)).map((path) => `the tarball is missing ${path}, which package.json points at`);
}

function packListing(): string {
  // Only `prepack` may put `dist` back (see the head of this file).
  rmSync(`${PACKAGE_DIR}dist`, { recursive: true, force: true });
  return execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 });
}

function main(): number {
  const manifest = JSON.parse(readFileSync(`${PACKAGE_DIR}package.json`, "utf8")) as Manifest;
  const stdout = packListing();
  const refused = packRefusals(stdout, manifest);
  for (const reason of refused) console.error(`pack-check: REFUSED ${reason}`);
  if (refused.length > 0) return 1;
  console.log(`pack-check: ok, the tarball holds all ${promisedPaths(manifest).length} paths the manifest points at (${listedPaths(stdout)?.length} files packed)`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
