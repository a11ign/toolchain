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
 */
import { entriesFromExports, type EntryOptions, type PackageExports } from "./entries.ts";

export type LibraryConfig = {
  lib: [{
    format: "esm";
    bundle: true;
    dts: true;
    source: { entry: Record<string, string> };
    output: { target: "node"; autoExternal: true; filename: { js: string } };
  }];
};

/** The Rslib config of a library package: `pkg` is its parsed `package.json`, `options.dir` its directory. */
export function libraryPreset(pkg: PackageExports, options: EntryOptions): LibraryConfig {
  return {
    lib: [{
      format: "esm",
      bundle: true,
      dts: true,
      source: { entry: entriesFromExports(pkg, options) },
      output: { target: "node", autoExternal: true, filename: { js: "[name].mjs" } },
    }],
  };
}
