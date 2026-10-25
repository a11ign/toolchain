import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkDependabotConfig } from "../src/dependabot-config.ts";
import { APPROVE_POLICY_FILE, GUARD_POLICY_FILE, readAutoFiles, verifyPolicies } from "../src/dependabot-auto.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// THIS REPOSITORY'S OWN `.github/dependabot.yml` AND `.github/workflows/dependabot-auto.yml` ARE THE TEMPLATE'S OUTPUT (A11-253, A11-254). Every other
// repository runs this same check from the toolchain it installs; this one runs it from source, so a change to the template that is not regenerated
// here is red before it is released.
test(".github/dependabot.yml and .github/workflows/dependabot-auto.yml are exactly what `dependabot-config --write` produces", () => {
  const result = checkDependabotConfig({ root: ROOT });
  assert.ok(result.ok, result.message);
});

// THE TWO POLICIES ARE HAND-WRITTEN, because their subject carries this repository's immutable id, so `--check` reads them (A11-254). Asserted here by
// name, beside the whole check, so the pin that makes the approval Dependabot's alone is in this repository's own gate.
test("this repository's approving policy pins dependabot[bot] and main's dependabot-auto.yml, and no other workflow approves", () => {
  const files = readAutoFiles(ROOT);
  assert.ok(APPROVE_POLICY_FILE in files && GUARD_POLICY_FILE in files, "both policies are in the tree");
  assert.deepEqual(verifyPolicies(files), []);
  const approve = files[APPROVE_POLICY_FILE];
  assert.match(approve, /^ {2}actor_id: "49699333"$/m);
  assert.match(approve, /^ {2}job_workflow_ref: a11ign\/toolchain\/\\\.github\/workflows\/dependabot-auto\\\.yml@refs\/heads\/main$/m);
  assert.match(approve, /^subject: repo:a11ign@320310787\/toolchain@1405342348:pull_request$/m);
});
