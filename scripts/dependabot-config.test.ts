import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkDependabotConfig } from "../src/dependabot-config.ts";

// THIS REPOSITORY'S OWN `.github/dependabot.yml` IS THE TEMPLATE'S OUTPUT (A11-253). Every other repository runs this same check from the toolchain it
// installs; this one runs it from source, so a change to the template that is not regenerated here is red before it is released.
test(".github/dependabot.yml is exactly what `dependabot-config --write` produces", () => {
  const result = checkDependabotConfig({ root: fileURLToPath(new URL("..", import.meta.url)) });
  assert.ok(result.ok, result.message);
});
