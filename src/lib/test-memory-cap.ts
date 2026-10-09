#!/usr/bin/env node
// @ts-check
// command: run a test runner under a per-process memory cap (systemd-run MemoryMax) and say what the cap did
//
//   node packages/guards/src/test-memory-cap.ts run <name> -- <command> [args...]
//
// WHY (#2507). Three kernel OOM kills on 2026-09-25 (12:01:53Z, 14:13:56 BST, 14:14:52 BST) each took ONE `node`
// process of 25.7 / 27.4 / 26.0 GB, read from `journalctl -k` by `ceo`; the next-largest entry at 12:01Z was about
// 200 MB. That is not seventeen concurrent runs, so a concurrency ceiling would have prevented none of them: this caps
// the PROCESS, so a runaway kills its own scope and not `herdr.service` with every agent in it.
//
// THE CAP IS A SYSTEMD SCOPE, `systemd-run --user --scope -p MemoryMax=<N> -p MemorySwapMax=0 -p OOMPolicy=continue`.
// `MemorySwapMax=0` because a runaway that swaps is a slow death of the whole host instead of a fast one of the scope.
// `OOMPolicy=continue` is NOT decoration: measured 2026-09-25 with a 64M cap, the scope's default (`stop`) SIGTERMs
// every process in it after the kernel kills one, INCLUDING the supervisor below, so the run exited 143 with no word
// about memory. With `continue` the kernel kills the offender and the supervisor survives to say so.
//
// THE SUPERVISOR IS THIS FILE, RUN INSIDE THE SCOPE (`supervise`). A cgroup OOM kill picks the LARGEST process, which
// for `rstest` is a worker rather than the runner, so the runner's own exit is 1 and no exit code says "memory". The
// scope's `memory.events` `oom_kill` count does, and it can only be read while the scope still exists -- it is gone the
// moment the last process leaves. A supervisor that outlives the runner, inside the scope, is the one place to read it.
//
// WHERE THE CAP DOES NOT APPLY, and the caller is told rather than left to assume: no `systemd-run` on PATH (macOS,
// Windows, most CI images) or no user manager answering (a bare container, a runner with no session bus). Both print
// `memory cap: none, <why>` and run the command uncapped with its own exit code. A cap that silently is not there
// looks exactly like one that is.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pnpmCliInvocation } from "./npm-cli-executable.ts";

/**
 * CHOSEN, NOT MEASURED (`ceo`, #2470/#2507): the largest peak of a green full-suite run has not been read yet, so 4G is
 * the figure the row fixed until that reading exists. `memory.peak` includes reclaimable page cache, so a peak near the
 * cap is not by itself a kill: `oom_kill` in the verdict line is the authority. A measured value replaces this constant
 * in a later PR with no other change.
 */
export const DEFAULT_MEMORY_MAX = "4G";

/** The one override, so a fixture can be killed by a 64M cap instead of allocating 4 GB, and a legitimate run can raise it. */
export const MEMORY_MAX_ENV = "A11Y_TEST_MEMORY_MAX";

/** What the kernel's OOM kill reports as an exit (128 + SIGKILL), and so what a cap-killed run exits with. */
export const CAP_KILL_STATUS = 137;

/** systemd's size syntax for a memory property: an integer with an optional K, M, G or T (base 1024). */
const MEMORY_MAX_PATTERN = /^[1-9]\d*[KMGT]?$/;

/** The signals a supervisor passes on, because it is the process a `kill` aimed at the scope reaches first. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** A process killed by signal N exits 128 + N by the shell's convention, which is what `137` is. */
const SIGNAL_EXIT_BASE = 128;
const BYTES_PER_KIB = 1024;
const UNITS = ["B", "K", "M", "G", "T"];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ memoryMax: string } | { refusal: string }}
 */
export function memoryMaxFrom(env: Record<string, string | undefined>): { memoryMax: string; } | { refusal: string; } {
  const given = env[MEMORY_MAX_ENV];
  if (given === undefined || given === "") return { memoryMax: DEFAULT_MEMORY_MAX };
  if (MEMORY_MAX_PATTERN.test(given)) return { memoryMax: given };
  return { refusal: `${MEMORY_MAX_ENV}=${JSON.stringify(given)} is not a size systemd reads (an integer with an optional `
    + "K, M, G or T, such as 4G or 512M) -- refusing to guess a cap." };
}

/** @param {string} memoryMax */
export function systemdRunArgs(memoryMax: string) {
  return ["--user", "--scope", "-q", "-p", `MemoryMax=${memoryMax}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue"];
}

/**
 * Whether a capped scope can be started HERE, asked by starting one: the question is "does this scope start", not
 * "is systemd-run installed", and a runner with the binary and no user manager fails the second half of it.
 * @param {{ memoryMax: string, env?: NodeJS.ProcessEnv, spawner?: typeof spawnSync }} request
 * @returns {{ capped: true, memoryMax: string } | { capped: false, reason: string }}
 */
export function probeCap({ memoryMax, env = process.env, spawner = spawnSync }: { memoryMax: string; env?: NodeJS.ProcessEnv; spawner?: typeof spawnSync; }): { capped: true; memoryMax: string; } | { capped: false; reason: string; } {
  const probe = spawner("systemd-run", [...systemdRunArgs(memoryMax), process.execPath, "-e", ""], { stdio: "ignore", env });
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    return { capped: false, reason: code === "ENOENT" ? "systemd-run absent" : `systemd-run unusable (${code})` };
  }
  if (probe.status !== 0) return { capped: false, reason: "no user manager answered" };
  return { capped: true, memoryMax };
}

/** @param {{ capped: true, memoryMax: string } | { capped: false, reason: string }} plan */
export function capLine(plan: { capped: true; memoryMax: string; } | { capped: false; reason: string; }) {
  return plan.capped ? `memory cap: MemoryMax=${plan.memoryMax} via systemd-run` : `memory cap: none, ${plan.reason}`;
}

/**
 * The command that actually starts: the supervisor inside a scope where capped, the command itself where not.
 * @param {{ plan: { capped: boolean, memoryMax?: string }, name: string, command: string, args: string[] }} request
 */
export function cappedCommand({ plan, name, command, args }: { plan: { capped: boolean; memoryMax?: string; }; name: string; command: string; args: string[]; }) {
  if (!plan.capped) return { command, args };
  return {
    command: "systemd-run",
    args: [...systemdRunArgs(String(plan.memoryMax)), process.execPath, fileURLToPath(import.meta.url),
      "supervise", name, String(plan.memoryMax), "--", command, ...args],
  };
}

/** @param {NodeJS.Signals | null} signal */
function signalStatus(signal: NodeJS.Signals | null) {
  return signal ? SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? 0) : 1;
}

/**
 * THE ENTRY EVERY TEST RUN STARTS THROUGH. Prints which path it took, runs the command, returns the exit status to use.
 * `spawner` is the seam: a test injects one instead of removing `systemd-run` from the machine.
 * @param {{ name: string, command: string, args: string[], env?: NodeJS.ProcessEnv,
 *   spawner?: typeof spawnSync, stderr?: { write: (text: string) => unknown } }} request
 * @returns {number}
 */
export function runUnderCap({ name, command, args, env = process.env, spawner = spawnSync, stderr = process.stderr }: {
        name: string; command: string; args: string[]; env?: NodeJS.ProcessEnv;
        spawner?: typeof spawnSync; stderr?: { write: (text: string) => unknown; };
    }): number {
  const cap = memoryMaxFrom(env);
  if ("refusal" in cap) {
    stderr.write(`REFUSING: ${cap.refusal}\n`);
    return 2;
  }
  const plan = probeCap({ memoryMax: cap.memoryMax, env, spawner });
  stderr.write(`${capLine(plan)}\n`);
  const target = cappedCommand({ plan, name, command, args });
  const result = spawner(target.command, target.args, { stdio: "inherit", env });
  if (result.signal) {
    // Only the SUPERVISOR's own death reaches here as a signal: it reports a runner's death as a status. Saying so is
    // the difference between "the cap's kill" and "something killed the process that watches for the cap's kill".
    stderr.write(`memory cap: ${name} ended by ${result.signal} with no verdict from the supervisor `
      + `(MemoryMax=${plan.capped ? plan.memoryMax : "none"}); nothing here says whether the cap did it.\n`);
    return signalStatus(result.signal);
  }
  return result.status ?? 1;
}

/**
 * @param {string} text the contents of `memory.events`
 * @returns {number | null} the `oom_kill` count, or null when the file does not carry one
 */
export function parseOomKills(text: string): number | null {
  const match = /^oom_kill (\d+)$/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** @param {string} procCgroup the contents of `/proc/self/cgroup` @returns {string | null} */
export function cgroupDirectory(procCgroup: string): string | null {
  const match = /^0::(\/.*)$/m.exec(procCgroup);
  return match ? `/sys/fs/cgroup${match[1]}` : null;
}

/** @param {number} bytes */
export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_KIB && unit < UNITS.length - 1) {
    value /= BYTES_PER_KIB;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${UNITS[unit]}`;
}

/**
 * What the scope's cgroup says happened. `oomKills` null means it could not be read, which is not zero.
 * @param {string | null} directory
 * @returns {{ oomKills: number | null, peakBytes: number | null, unreadable?: string }}
 */
export function readScope(directory: string | null): { oomKills: number | null; peakBytes: number | null; unreadable?: string; } {
  if (directory === null) return { oomKills: null, peakBytes: null, unreadable: "this process is not in a cgroup v2 hierarchy" };
  try {
    const oomKills = parseOomKills(readFileSync(`${directory}/memory.events`, "utf8"));
    const peak = Number(readFileSync(`${directory}/memory.peak`, "utf8"));
    return { oomKills, peakBytes: Number.isFinite(peak) ? peak : null };
  } catch (error) {
    return { oomKills: null, peakBytes: null, unreadable: (error as Error).message };
  }
}

/**
 * The verdict, PURE. A kill is named by the command, the cap's value and the count the kernel kept, and is not mistaken
 * for a test failure; a run that stayed under says so too, so the absence of a kill line is never the only signal.
 * @param {{ name: string, memoryMax: string, scope: ReturnType<typeof readScope>, signal: string | null }} request
 */
export function verdictLine({ name, memoryMax, scope, signal }: { name: string; memoryMax: string; scope: ReturnType<typeof readScope>; signal: string | null; }) {
  const peak = scope.peakBytes === null ? "peak unknown" : `peak ${formatBytes(scope.peakBytes)}`;
  if (scope.oomKills === null) {
    const guess = signal === "SIGKILL" ? `; ${name} died by SIGKILL, which is what the cap does, but that is not proof` : "";
    return `memory cap: could not read the scope (${scope.unreadable ?? "no oom_kill line"})${guess}`;
  }
  if (scope.oomKills > 0) {
    return `memory cap: KILLED -- ${name} hit MemoryMax=${memoryMax} (oom_kill=${scope.oomKills}, ${peak}); `
      + `exit ${CAP_KILL_STATUS} is the cap's, not a test failure. Raise it with ${MEMORY_MAX_ENV} only if the run needs it.`;
  }
  return `memory cap: ${name} stayed under MemoryMax=${memoryMax} (${peak}, oom_kill=0)`;
}

/**
 * Inside the scope: run the command, forward the signals aimed at this process, then read the scope BEFORE leaving it.
 * @param {{ name: string, memoryMax: string, command: string, args: string[], directory?: string | null,
 *   stderr?: { write: (text: string) => unknown } }} request
 * @returns {Promise<number>}
 */
export async function supervise({ name, memoryMax, command, args, directory, stderr = process.stderr }: {
        name: string; memoryMax: string; command: string; args: string[]; directory?: string | null;
        stderr?: { write: (text: string) => unknown; };
    }): Promise<number> {
  const child = spawn(command, args, { stdio: "inherit" });
  const handlers = {} as Record<(typeof FORWARDED_SIGNALS)[number], () => void>;
  for (const signal of FORWARDED_SIGNALS) {
    handlers[signal] = () => child.kill(signal);
    process.on(signal, handlers[signal]);
  }
  const exit: { status: number | null; signal: NodeJS.Signals | null; } = await new Promise((resolve) => {
    child.on("error", (error) => {
      stderr.write(`memory cap: could not start ${name}: ${error.message}\n`);
      resolve({ status: 127, signal: null });
    });
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  for (const signal of FORWARDED_SIGNALS) process.off(signal, handlers[signal]);
  const scope = readScope(directory === undefined ? cgroupDirectory(readFileSync("/proc/self/cgroup", "utf8")) : directory);
  stderr.write(`${verdictLine({ name, memoryMax, scope, signal: exit.signal })}\n`);
  if (scope.oomKills !== null && scope.oomKills > 0) return CAP_KILL_STATUS;
  return exit.signal ? signalStatus(exit.signal) : exit.status ?? 1;
}

/**
 * `<name> -- <command> [args...]`: split argv at the first `--` so a runner's own flags are never read here.
 * @param {string[]} argv everything after the subcommand
 * @returns {{ before: string[], after: string[] }}
 */
export function splitAtDoubleDash(argv: string[]): { before: string[]; after: string[]; } {
  const at = argv.indexOf("--");
  return at === -1 ? { before: argv, after: [] } : { before: argv.slice(0, at), after: argv.slice(at + 1) };
}

/**
 * Every package-manager spelling resolves to `pnpm`, through its own CLI script and never by name: a bare `pnpm` spawn
 * fails on Windows (CVE-2024-27980) and the repo's own guard refuses one. The pre-push hook still names `npx`, so that
 * is `pnpm exec` here and `npm` is `pnpm`: no spelling of the old tool is ever spawned. The name stays `resolveNpmCommand`
 * because it resolves the npm-family spellings, and `pre-push`'s resolve-toward-main check pins exported names.
 * @param {string} command @param {string[]} args
 */
export function resolveNpmCommand(command: string, args: string[]) {
  if (command === "npx") return pnpmCliInvocation(["exec", ...args]);
  return command === "npm" || command === "pnpm" ? pnpmCliInvocation(args) : { command, args };
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { before, after } = splitAtDoubleDash(rest);
  if (after.length === 0 || before.length === 0 || (subcommand !== "run" && subcommand !== "supervise")) {
    process.stderr.write("usage: node packages/guards/src/test-memory-cap.ts run <name> -- <command> [args...]\n");
    process.exitCode = 2;
    return;
  }
  const [command, ...args] = after;
  if (subcommand === "run") {
    const target = resolveNpmCommand(command, args);
    process.exitCode = runUnderCap({ name: before[0], command: target.command, args: target.args });
    return;
  }
  process.exitCode = await supervise({ name: before[0], memoryMax: before[1], command, args });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  await main();
}
