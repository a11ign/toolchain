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
  // This is the LAST slice (a11ign/a11ign#4282): the pinned end state is an EMPTY baseline and a count of zero, so a count above zero can no
  // longer be this test's positive control. What it asserts instead is that the walk found THIS repository's baseline, not a baseline elsewhere;
  // that the read counts a file at all is `mjs-ratchet.test.ts`'s control (a planted file counts 1), and the empty-tree refusal is its other.
  assert.equal(result.baselineCount, 0, "the end state: no standing allowance, so any new .js/.mjs/.cjs fails");
  assert.ok(fileURLToPath(import.meta.url).startsWith(result.root), `the baseline found (${result.root}) is the one above this test`);
});
