/**
 * RUNS A GENERATED WORKFLOW JOB THE WAY GITHUB WOULD, FOR THE PARTS THE TESTS CARE ABOUT (A11-254). The job comes from `generateDependabotAuto()`
 * parsed as YAML, so what runs is the text a repository commits. Its `if:` expressions are evaluated, its `${{ }}` are filled in from a context the
 * test gives, each `run:` step is run by bash with `-eo pipefail` as GitHub runs it, and `GITHUB_OUTPUT` is read back between steps. `uses:` steps
 * are not run: `fetch-metadata` answers with the outputs the test gives, and an Octo STS mint answers with the token `TOKEN-<identity>`, so a test
 * can read which identity made which call. `gh` is a fake that records every call and answers from routes; `jq`, `awk`, `sed` and `bash` are real.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse } from "yaml";
import { generateDependabotAuto } from "../dependabot-auto.ts";

export type Route = { match: RegExp; stdout?: string; stdoutSequence?: string[]; stderr?: string; code?: number };
export type Call = { argv: string[]; line: string; token: string };
type Step = { id?: string; name: string; if?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; run?: string };
type Job = { if?: string; steps: Step[] };
export type Context = { github: Record<string, unknown>; steps?: Record<string, { outputs: Record<string, string> }> };
export type JobRun = {
  /** Whether the job's own `if:` held. When it did not, nothing else happened. */
  ran: boolean;
  /** The names of the steps that ran, `uses:` steps included. */
  stepsRun: string[];
  /** Octo STS identities minted, in order. */
  minted: string[];
  calls: Call[];
  /** The exit code of the first step that failed, else 0. */
  code: number;
  stdout: string;
  stderr: string;
  /** Every step's outputs, by step id. */
  outputs: Record<string, Record<string, string>>;
  /** The scratch directory a job's `RUNNER_TEMP` was. */
  temp: string;
};

const workflow = parse(generateDependabotAuto()) as { jobs: Record<string, Job> };
export const jobOf = (name: string): Job => workflow.jobs[name];

/** A path in the context, `a.b[0].c`; a missing step on the way is undefined, as GitHub reads null. */
function lookup(context: Record<string, unknown>, path: string): unknown {
  return path.split(/\.|\[(\d+)\]/).filter((part) => part !== undefined && part !== "").reduce<unknown>(
    (value, part) => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[part]), context);
}

const CHAIN = /\b(github|steps|runner)((?:\.[\w-]+|\[\d+\])*)/g;

/** A GitHub expression, evaluated: property chains read from the context, `==` and `!=` as JavaScript's strict ones, `startsWith` as GitHub's. */
export function evaluate(expression: string, context: Context): unknown {
  const code = expression.split(/('(?:[^']|'')*')/).map((part, index) => (index % 2 === 1 ? part : part
    .replace(CHAIN, (chain) => `get(${JSON.stringify(chain)})`).replaceAll("==", "===").replaceAll("!=", "!=="))).join("");
  const startsWith = (value: unknown, prefix: string): boolean => typeof value === "string" && value.toLowerCase().startsWith(prefix.toLowerCase());
  return new Function("get", "startsWith", `return (${code});`)((path: string) => lookup({ steps: {}, ...context }, path), startsWith);
}

const interpolate = (text: string, context: Context): string => text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => String(evaluate(expression, context) ?? ""));

const FAKE_GH = (node: string): string => `#!${node}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const line = argv.join(" ");
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ argv, line, token: process.env.GH_TOKEN ?? "" }) + "\\n");
const routes = JSON.parse(fs.readFileSync(process.env.GH_ROUTES, "utf8"));
const state = fs.existsSync(process.env.GH_STATE) ? JSON.parse(fs.readFileSync(process.env.GH_STATE, "utf8")) : {};
for (const [index, route] of routes.entries()) {
  if (!new RegExp(route.match).test(line)) continue;
  const seen = state[index] ?? 0;
  state[index] = seen + 1;
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  const stdout = route.stdoutSequence ? route.stdoutSequence[Math.min(seen, route.stdoutSequence.length - 1)] : route.stdout;
  if (route.stderr) process.stderr.write(route.stderr);
  process.stdout.write(stdout ?? "");
  process.exit(route.code ?? 0);
}
process.stderr.write("fake gh: no route for: " + line + "\\n");
process.exit(99);
`;

type Setup = { dir: string; bin: string; calls: string; routes: string; state: string };
function setUp(routes: Route[]): Setup {
  const dir = mkdtempSync(join(tmpdir(), "dependabot-auto-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH(process.execPath));
  chmodSync(join(bin, "gh"), 0o755);
  const setup = { dir, bin, calls: join(dir, "calls.jsonl"), routes: join(dir, "routes.json"), state: join(dir, "state.json") };
  writeFileSync(setup.calls, "");
  writeFileSync(setup.routes, JSON.stringify(routes.map((route) => ({ ...route, match: route.match.source }))));
  mkdirSync(join(dir, "temp"));
  return setup;
}

const readOutputs = (path: string): Record<string, string> =>
  Object.fromEntries(readFileSync(path, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

type Scenario = { context: Context; metadata?: Record<string, string>; routes: Route[] };

/** Runs a job of the generated workflow through its steps until one fails. The scratch directory is the caller's to remove (`JobRun.temp`'s parent). */
export function runJob(name: string, { context, metadata = {}, routes }: Scenario): JobRun {
  const job = jobOf(name);
  const result: JobRun = { ran: false, stepsRun: [], minted: [], calls: [], code: 0, stdout: "", stderr: "", outputs: {}, temp: "" };
  const live: Context = { ...context, steps: {} };
  if (job.if !== undefined && !evaluate(job.if, live)) return result;
  result.ran = true;
  const setup = setUp(routes);
  result.temp = join(setup.dir, "temp");
  for (const step of job.steps) {
    if (step.if !== undefined && !evaluate(step.if, live)) continue;
    result.stepsRun.push(step.name);
    const outputs = step.uses === undefined ? runStep(step, { setup, live, result }) : usesStep(step, { live, result, metadata });
    if (step.id !== undefined) live.steps![step.id] = { outputs };
    if (result.code !== 0) break;
  }
  result.calls = readFileSync(setup.calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
  result.outputs = Object.fromEntries(Object.entries(live.steps!).map(([id, { outputs }]) => [id, outputs]));
  return result;
}

type StepArgs = { live: Context; result: JobRun };

function usesStep(step: Step, { live, result, metadata }: StepArgs & { metadata: Record<string, string> }): Record<string, string> {
  if (step.uses!.startsWith("octo-sts/action@")) {
    const identity = interpolate(step.with!.identity, live);
    result.minted.push(identity);
    return { token: `TOKEN-${identity}` };
  }
  if (step.uses!.startsWith("dependabot/fetch-metadata@")) return metadata;
  throw new Error(`the harness does not know the action ${step.uses}`);
}

function runStep(step: Step, { setup, live, result }: StepArgs & { setup: Setup }): Record<string, string> {
  const outputFile = join(setup.dir, `output-${result.stepsRun.length}`);
  writeFileSync(outputFile, "");
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, interpolate(String(value), live)]));
  const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
    encoding: "utf8",
    env: {
      PATH: `${setup.bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/local/bin:/usr/bin:/bin`, HOME: setup.dir, LC_ALL: "C.UTF-8",
      GITHUB_OUTPUT: outputFile, RUNNER_TEMP: join(setup.dir, "temp"), GH_CALLS: setup.calls, GH_ROUTES: setup.routes, GH_STATE: setup.state, ...env,
    },
  });
  result.stdout += run.stdout;
  result.stderr += run.stderr;
  if (run.status !== 0) result.code = run.status ?? 1;
  return readOutputs(outputFile);
}

/** Removes the scratch directory a `runJob` made. */
export function cleanUp(run: JobRun): void {
  if (run.temp !== "") rmSync(dirname(run.temp), { recursive: true, force: true });
}

/** Runs `body` on a job's run and removes its scratch directory afterwards, so a test cannot leak one. */
export function withJob<T>(name: string, scenario: Scenario, body: (run: JobRun) => T): T {
  const run = runJob(name, scenario);
  try {
    return body(run);
  } finally {
    cleanUp(run);
  }
}
