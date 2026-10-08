/**
 * THIS REPOSITORY ADOPTS ITS OWN RATCHET FIRST (a11ign/a11ign#4243). It is the call every consumer's test makes: the baseline is found by walking up from
 * THIS FILE, so moving the test (the layout flatten, #4213) edits nothing. The cases for the check itself are in `mjs-ratchet.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkMjsRatchet } from "./mjs-ratchet.ts";

test("the repository's own .mjs/.js/.cjs source does not exceed its committed baseline", () => {
  const result = checkMjsRatchet({ from: fileURLToPath(import.meta.url) });
  assert.equal(result.ok, true, result.message);
  // The positive control: the read found this repository's own scripts, so 'ok' is not 'the walk read nothing'.
  assert.ok(result.count > 0, `the ratchet counted ${result.count} files in ${result.root}`);
});
