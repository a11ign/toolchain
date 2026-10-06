/**
 * THE RSLIB PRESETS (ADR 0043, Decision 4): what every published package's `rslib.config.ts` is made of, so no package re-types
 * the keys that were measured once. `tsc` stays the checker and never the builder.
 *
 * `libraryPreset` is Rslib's BUNDLE mode, one entry per public `exports` key (`entriesFromExports`), dependencies left
 * external, ESM to `.mjs` plus `.d.ts`. A library is anything consumed by version; the shape is the one measured in a scratch copy
 * of `@a11ign/evidence` (ADR 0043, Decision 4).
 *
 * THE RETURN TYPE IS STRUCTURAL, NOT `RslibConfig`: a `.d.ts` that imported `@rslib/core` would fail a consumer's `tsc` with
 * `skipLibCheck` off whenever the consumer is not building (`@rslib/core` is an optional peer), and the object is accepted by
 * `defineConfig` all the same.
 *
 * `autoExternal` is `output.autoExternal`: `lib.autoExternal` is deprecated in @rslib/core 1.0.3 and warns.
 *
 * `new URL("./x", import.meta.url)` IS LEFT AS WRITTEN (a11ign/a11ign#3735, found by #3552). Rslib's default parser turns that form
 * into an ASSET: measured on a fixture package with @rslib/core 1.0.3, `fileURLToPath(new URL("./", import.meta.url))` came out as
 * `new URL("./static/assets/index.ts", import.meta.url)` and `dist/static/assets/index.ts` appeared, so a package that reads its own
 * directory got the wrong answer from its build and nothing said so. A library resolves a path beside ITS OWN built file at run time,
 * and never wants a bundler's copy of one. The rule is a `module.rules` entry because the global `module.parser.javascript.url` is
 * not honoured by Rslib's lib mode (measured: the asset still came out), and its `test` takes `.ts` too, which the one in
 * `screenreader-worker` (`.mjs` only) did not.
 */
import { entriesFromExports, type EntryOptions, type PackageExports } from "./entries.ts";

export type LibraryConfig = {
  lib: [{
    format: "esm";
    bundle: true;
    dts: true;
    source: { entry: Record<string, string> };
    output: { target: "node"; autoExternal: true; filename: { js: string } };
    tools: { rspack: { module: { rules: [{ test: RegExp; parser: { url: false } }] } } };
  }];
};

const SCRIPT_SOURCE = /\.[cm]?[jt]s$/;

/** The Rslib config of a library package: `pkg` is its parsed `package.json`, `options.dir` its directory. */
export function libraryPreset(pkg: PackageExports, options: EntryOptions): LibraryConfig {
  return {
    lib: [{
      format: "esm",
      bundle: true,
      dts: true,
      source: { entry: entriesFromExports(pkg, options) },
      output: { target: "node", autoExternal: true, filename: { js: "[name].mjs" } },
      tools: { rspack: { module: { rules: [{ test: SCRIPT_SOURCE, parser: { url: false } }] } } },
    }],
  };
}
