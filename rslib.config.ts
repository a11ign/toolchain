import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@rslib/core";
// RELATIVE, never `@a11ign/toolchain/rslib-presets`: this package's build cannot import the package it is about to make (ADR 0043,
// done-when 5), and a11ign's own tree has no `dist` to resolve it to.
import { libraryPreset } from "./src/rslib-presets.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// `tsconfig.json` is the checker and takes in the tests and scripts, so the declarations are read from `tsconfig.build.json`, which leaves them out.
export default defineConfig({
  ...libraryPreset(pkg, { dir: fileURLToPath(new URL(".", import.meta.url)) }),
  source: { tsconfigPath: "./tsconfig.build.json" },
});
