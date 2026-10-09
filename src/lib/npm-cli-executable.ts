// @ts-check
// #492: NEVER SPAWN `npx`/`npm` AT ALL -- resolve npm's OWN CLI SCRIPT and run it through `process.execPath`.
//
// The first version of this file named `npx.cmd`/`npm.cmd` explicitly, on the documented premise that
// Node's `child_process` auto-detects a `.bat`/`.cmd` suffix on Windows and safely routes that one call
// through `cmd.exe`. **That premise stopped being true in April 2024.** CVE-2024-27980 ("BatBadBut")
// permanently made `spawn`/`spawnSync`/`execFileSync` REFUSE (`EINVAL`) to launch a `.bat`/`.cmd` file
// directly when `shell` is unset, on every Node release after 18.20.2/20.12.2/21.7.3 -- a deliberate
// security hardening, not a bug that gets un-fixed. `windows-2022`'s Node 22.23.2 is well past the patch,
// so the `.cmd`-suffix fix from #492's first pass turned an `ENOENT` into an `EINVAL` on the very platform
// it was written for. Found live by #494's consumer gate (a real `windows-2022` run), run `34265163648`.
//
// `ceo`'s ruling: no `shell: true`, anywhere. That option's quoting class is the same one that dispatched
// four capture shards at `--worker=http://:8765` for 29 minutes, and proving it safe would mean auditing
// every one of the 23 call sites this file's own discovery guard found. **Never spawn `.cmd` at all --
// spawn `process.execPath` with npm's own CLI script as `argv[1]`, so argv stays argv on every platform.**
//
// TWO LAYOUTS, TRIED IN ORDER, because npm's `bin/` sits in a different place relative to `node` depending
// on platform. Measured directly, not assumed from one machine:
//
//   Windows:  <node install root>/node_modules/npm/bin/<script>     -- node.exe sits at the install root
//   POSIX:    <node install root>/../lib/node_modules/npm/bin/<script>  -- node sits in bin/, npm in lib/
//
// A first draft of this ruling named only the Windows layout -- correct there, and it does not exist on
// POSIX (`require.resolve("npm/bin/...")` also fails on both: npm ships BESIDE `node`, never as a
// dependency any project's own module graph can resolve). Both are tried, in this order, because trying
// the Windows layout first costs nothing on POSIX (a single failed `existsSync`) and getting the order
// backwards costs nothing either -- but naming only one layout silently breaks whichever platform is not
// named, which is this row's own defect with the platforms swapped.
//
// THE DIVISION OF WHAT IS PROVEN, stated so a reader does not credit either check with the other's job:
// the unit test beside this file pins the RESOLVED ARGV SHAPE (which script, which arguments, in which
// order) -- it cannot prove the spawn itself succeeds, since that needs a real Node install with npm
// actually present beside it, which is exactly what a `process.platform` override would fake past. #494's
// consumer gate, on a real `windows-2022` runner, is what proves the spawn runs. A source-text walk
// structurally cannot catch an `EINVAL`; a unit guard pins the call shape, the consumer gate proves it runs.
import { existsSync, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";

/**
 * @param {"npx" | "npm"} name
 * @returns {string}
 */
function cliScriptName(name: "npx" | "npm"): string {
  return name === "npx" ? "npx-cli.js" : "npm-cli.js";
}

/**
 * The two candidate paths for npm's own CLI script, Windows layout first. Exported (not just used
 * internally) so the unit test can assert the exact candidates without duplicating the path-join logic.
 * @param {"npx" | "npm"} name
 * @returns {string[]}
 */
export function npmCliScriptCandidates(name: "npx" | "npm"): string[] {
  const script = cliScriptName(name);
  const nodeDir = dirname(process.execPath);
  const fixed = [
    join(nodeDir, "node_modules", "npm", "bin", script),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", script),
  ];
  const fromPath = pathDerivedCandidate(name, script);
  return fromPath === null ? fixed : [...fixed, fromPath];
}

/**
 * #1268: THE THIRD LAYOUT. Debian and Ubuntu package npm at `/usr/share/nodejs/npm/bin/`, nowhere near
 * `node`, and put `/usr/bin/npm` and `/usr/bin/npx` on PATH as symlinks straight to the CLI scripts. So
 * the executable on PATH, symlinks resolved, IS the script (Debian) or sits in the script's directory
 * (the upstream tarball's `bin/npx` wrapper). Tried LAST so the two fixed layouts keep their order on
 * the platforms they were measured on; `null` when nothing named `name` is on PATH, so the candidate
 * list never carries a path that cannot exist. Found by the first `npm ci` on the agents host.
 * @param {"npx" | "npm"} name
 * @param {string} script
 * @returns {string | null}
 */
function pathDerivedCandidate(name: "npx" | "npm", script: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const executable = join(dir, name);
    if (!existsSync(executable)) continue;
    const real = realpathSync(executable);
    return real.endsWith(script) ? real : join(dirname(real), script);
  }
  return null;
}

/**
 * Resolves npm's own CLI script to a real, existing path. Throws NAMING EVERY CANDIDATE TRIED -- "npm's
 * CLI was not found" sends nobody anywhere; this repo's own rule is that a guard which stops a job and
 * explains nothing gets bypassed.
 * @param {"npx" | "npm"} name
 * @returns {string}
 */
export function resolveNpmCliScript(name: "npx" | "npm"): string {
  const candidates = npmCliScriptCandidates(name);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`could not find npm's own ${cliScriptName(name)} beside this Node install -- tried:\n`
      + candidates.map((path) => `  ${path}`).join("\n"));
  }
  return found;
}

/**
 * The full `execFileSync`/`spawnSync`/`spawn` argv for running `npx <args>`/`npm <args>` WITHOUT spawning
 * either binary at all: `process.execPath` as the command, npm's own resolved CLI script as the first
 * argument, then the caller's original arguments unchanged -- exactly what the `npx`/`npm` executables do
 * internally, one layer removed. There is no `.cmd`, no `.bat`, no shell, and therefore nothing for
 * CVE-2024-27980 to refuse, on any platform.
 * @param {"npx" | "npm"} name
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function npmCliInvocation(name: "npx" | "npm", args: string[]): { command: string; args: string[]; } {
  return { command: process.execPath, args: [resolveNpmCliScript(name), ...args] };
}

/**
 * #2301: `pnpm <args>` WITHOUT SPAWNING A `.cmd`, for the same reason `npmCliInvocation` exists, and with the
 * added problem that pnpm is not always ON `PATH` at all: this host and the Windows workers run it as
 * `corepack pnpm` (`packageManager` in the root manifest pins the version), while a CI runner has the
 * shim `pnpm/action-setup` puts there. Three ways to reach it, tried in this order, each ending in an argv
 * that `execFileSync` can run with no shell:
 *
 *   1. `npm_execpath`, when this process was itself started BY pnpm (`pnpm run ...`, `pnpm exec ...`): pnpm
 *      says which script it is, so nothing is searched for and no other pnpm can be picked up by mistake.
 *   2. a `pnpm` on `PATH`: the executable itself on POSIX; on Windows the shim is `pnpm.cmd`, so the
 *      `pnpm.cjs` beside it is run through `process.execPath` instead.
 *   3. `corepack` on `PATH`, the same way: `corepack pnpm` on POSIX, `corepack.js` beside `node.exe`
 *      through `process.execPath` on Windows.
 *
 * Throws NAMING WHAT WAS TRIED, for the reason `resolveNpmCliScript` does.
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function pnpmCliInvocation(args: string[]): { command: string; args: string[]; } {
  const fromParent = process.env.npm_execpath ?? "";
  if (/pnpm\.c?js$/.test(fromParent) && existsSync(fromParent)) {
    return { command: process.execPath, args: [fromParent, ...args] };
  }
  const shim = onPath("pnpm");
  if (shim !== null) return shimInvocation(shim, join("node_modules", "pnpm", "bin", "pnpm.cjs"), args);
  const corepack = onPath("corepack");
  if (corepack !== null) {
    return shimInvocation(corepack, join("node_modules", "corepack", "dist", "corepack.js"), ["pnpm", ...args]);
  }
  throw new Error("could not find pnpm: `npm_execpath` is not a pnpm script, and neither `pnpm` nor `corepack` "
    + "is on PATH. `packageManager` in the root package.json names the version -- `corepack enable` or "
    + "`pnpm/action-setup` provides it.");
}

/**
 * The first executable called `name` on PATH, or `null`. On Windows the executable is `name.cmd`, which
 * `existsSync` finds only when the extension is tried, so both spellings are.
 * @param {string} name
 * @returns {string | null}
 */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of [join(dir, name), join(dir, `${name}.cmd`)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * A POSIX shim is spawned as it is; a `.cmd` shim is never spawned (CVE-2024-27980, see the header), so the
 * package script it wraps is run through `process.execPath`, found beside the shim (the layout `pnpm add -g`
 * and `pnpm/action-setup` share) or beside `node` (corepack's).
 * @param {string} shim
 * @param {string} script the wrapped script, relative to the shim's directory or to `node`'s
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
function shimInvocation(shim: string, script: string, args: string[]): { command: string; args: string[]; } {
  if (!shim.endsWith(".cmd")) return { command: shim, args };
  const found = [join(dirname(shim), script), join(dirname(process.execPath), script)].find((path) => existsSync(path));
  if (found === undefined) throw new Error(`${shim} is a .cmd shim and its script ${script} is not beside it or beside node`);
  return { command: process.execPath, args: [found, ...args] };
}
