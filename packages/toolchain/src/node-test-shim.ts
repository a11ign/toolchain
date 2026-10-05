/**
 * #1318: THE SUITE IMPORTS `node:test`; RSTEST HAS ITS OWN API. This module stands between them. It is sent in
 * for `node:test` by `register-node-test-alias.mjs`, in every rstest worker, so no test file is edited.
 *
 * WHAT IT MAPS, each measured on #1315 over the 550 files the config includes:
 *   test / it, and node:test's properties on `test`   -> rstest's `test`, adapting `test(name, options, fn)`
 *     (`test.after` / `.before` / `.beforeEach` / `.afterEach` are used by 4 files)
 *   describe                                          -> describe
 *   before / after, beforeEach / afterEach            -> beforeAll / afterAll, beforeEach / afterEach
 *   t.skip() inside a running test                    -> rstest's own `ctx.skip()` (12 files, 26 calls)
 *   t.diagnostic                                      -> a `# ` line on stdout
 *   mock.fn / mock.method                             -> `rs.fn` / `rs.spyOn` (`mock-functions.mdx`), with
 *     node:test's `mock.callCount()` added to the result -- the suite's only mock accessor, in 1 file
 *
 * WHAT IT REFUSES, by name: every other `mock` property, `run`, `t.todo()`, a `test()` option other than `skip`,
 * `todo` and `timeout`, and any `describe()` option (#1383). Stubbing or dropping them would report those tests as
 * passing for a reason that has nothing to do with the runner: a dropped `{ skip: true }` on a `describe` RUNS the
 * suite node:test would skip. A SYMBOL lookup on a refused name
 * returns `undefined` rather than throwing, so code that enumerates a module is not failed by the shim itself.
 *
 * NO TOP-LEVEL AWAIT, and rstest's collecting runtime is read from `globalThis` (the config sets `globals: true`)
 * with the static import only as a fallback: a second copy of the runtime would collect nothing.
 */
import * as rstestModule from "@rstest/core";

/**
 * node:test's call shapes are loose (`test(name, fn)`, `test(name, options, fn)`, `test(fn)`), so this module
 * handles them as values it inspects rather than as fixed types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shape of a node:test call is the thing being adapted, see above
type Loose = any;

const api: Loose = (globalThis as Loose).test ? globalThis : rstestModule;

/**
 * The `t` node:test hands a test function, reduced to what rstest can honour without pretending.
 * `ctx` is rstest's per-test context.
 */
function contextFor(name: string, ctx: Loose): Loose {
  return {
    name,
    signal: ctx?.signal,
    diagnostic: (message: string) => { process.stdout.write(`# ${message}\n`); },
    skip: (reason?: string) => {
      if (typeof ctx?.skip === "function") return ctx.skip(reason);
      throw new Error(`node-test-shim: t.skip() has no rstest context to call (${name})`);
    },
    todo: () => { throw new Error(`node-test-shim: t.todo() inside a running test is not mapped (${name})`); },
  };
}

/** The `test()` options this shim maps onto rstest. Every other key is refused by name, never dropped (#1383). */
export const MAPPED_TEST_OPTIONS: readonly string[] = Object.freeze(["skip", "todo", "timeout"]);

const refusal = (what: string): Error => new Error(`node-test-shim: node:test's \`${what}\` is not mapped onto rstest`);

/**
 * The keys of an options object this shim does not map, as one refusal naming each -- or nothing to refuse.
 * `call` is `test` or `describe`.
 */
function refuseUnmapped(call: string, options: Record<string, unknown>, mapped: readonly string[]): void {
  const unmapped = Object.keys(options).filter((key) => !mapped.includes(key));
  if (unmapped.length > 0) throw refusal(`${call}() option ${unmapped.map((key) => `"${key}"`).join(", ")}`);
}

/**
 * node:test's `test(name, fn)`, `test(name, options, fn)` and `test(fn)`, registered with rstest.
 * Options mapped: `skip`, `todo`, `timeout`. Any other key -- `concurrency`, `only`, `plan`, or one node:test adds
 * later -- is REFUSED by name at registration, because dropping it silently changes what the test does (#1383).
 * EXPORTED with `register` injected, so the refusal is driven without rstest's runtime. `register` is rstest's `test` (or `test.only`).
 */
export function adapt(register: Loose): (nameOrFn: Loose, optionsOrFn?: Loose, maybeFn?: Loose) => Loose {
  return (nameOrFn, optionsOrFn, maybeFn) => {
    const name = typeof nameOrFn === "string" ? nameOrFn : (nameOrFn?.name || "<anonymous>");
    const fn = [nameOrFn, optionsOrFn, maybeFn].find((part) => typeof part === "function");
    const options = typeof optionsOrFn === "object" && optionsOrFn !== null ? optionsOrFn : {};
    refuseUnmapped("test", options, MAPPED_TEST_OPTIONS);
    const body = fn ? (ctx: Loose) => fn(contextFor(name, ctx)) : () => {};
    if (options.skip) return register.skip(name, body);
    if (options.todo) return register.todo(name, body);
    return register(name, body, options.timeout);
  };
}

const refused = (what: string): Loose => new Proxy(function refusedNodeTestApi() {}, {
  get: (_target, prop) => {
    if (typeof prop === "symbol") return undefined;
    if (prop === "name") return what;
    throw refusal(`${what}.${prop}`);
  },
  apply: () => { throw refusal(what); },
});

/**
 * node:test's `describe(name, fn)` and `describe(name, options, fn)`, registered with rstest's `describe`. NO
 * describe option is mapped, so every key is refused by name (#1383): a dropped `{ skip: true }` ran the whole suite
 * where node:test skips it. An empty options object has nothing to refuse. EXPORTED with the api injected: `registerApi` is the
 * object whose `describe` registers the suite.
 */
export function describeOn(registerApi: Loose): (name: string, optionsOrFn: Loose, maybeFn?: Loose) => Loose {
  return (name, optionsOrFn, maybeFn) => {
    if (typeof optionsOrFn === "object" && optionsOrFn !== null) refuseUnmapped("describe", optionsOrFn, []);
    return registerApi.describe(name, typeof optionsOrFn === "function" ? optionsOrFn : maybeFn);
  };
}

export const describe = describeOn(api);
export const before = (fn: () => unknown): unknown => api.beforeAll(fn);
export const after = (fn: () => unknown): unknown => api.afterAll(fn);
export const beforeEach = (fn: () => unknown): unknown => api.beforeEach(fn);
export const afterEach = (fn: () => unknown): unknown => api.afterEach(fn);

/** rstest's mock utilities, global `rs` (or `rstest`) under `globals: true`. */
const rs = (): Loose => api.rs ?? api.rstest;

/**
 * An rstest spy whose `mock` also answers node:test's `callCount()`.
 *
 * NOT BY ASSIGNMENT. Measured on 0.11.12: `fn.mock` is an own getter, non-configurable with no setter, that
 * returns a NEW state object on every read (`f.mock === f.mock` is false), so a `callCount` set on one read
 * is gone by the next -- which is how the first version of this shim failed `capture-client.test.ts`. The
 * property cannot be redefined either, so the spy is returned behind a Proxy: calls and every other property
 * reach the real spy untouched, and a read of `mock` gets the state with `callCount` counting the spy's own
 * calls at the moment it is asked.
 */
function withNodeTestAccessors(spy: Loose): Loose {
  return new Proxy(spy, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "mock") return value;
      return Object.assign(value, { callCount: () => target.mock.calls.length });
    },
  });
}

const mapped: Record<string, (...args: Loose[]) => Loose> = {
  fn: (impl?: Loose) => withNodeTestAccessors(rs().fn(impl)),
  method: (object: Loose, methodName: string, impl?: Loose) => {
    const spy = rs().spyOn(object, methodName);
    return withNodeTestAccessors(impl ? spy.mockImplementation(impl) : spy);
  },
};

export const mock: Loose = new Proxy(mapped, {
  get: (target, prop) => {
    if (typeof prop === "symbol") return undefined;
    if (prop in target) return target[prop];
    throw refusal(`mock.${prop}`);
  },
});
export const run = refused("run");

const base = adapt(api.test);
export const test: Loose = Object.assign(base, {
  after, afterEach, before, beforeEach, describe, mock, run,
  skip: (name: string, optionsOrFn?: Loose, maybeFn?: Loose) => base(name, { skip: true }, [optionsOrFn, maybeFn].find((f) => typeof f === "function")),
  todo: (name: string, optionsOrFn?: Loose, maybeFn?: Loose) => base(name, { todo: true }, [optionsOrFn, maybeFn].find((f) => typeof f === "function")),
  only: adapt(api.test.only ?? api.test),
});
export const it = test;
export default test;
