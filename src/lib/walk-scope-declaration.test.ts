/**
 * `walk-scope-declaration.ts` (#929): a guard's `WALK_SCOPE` declaration, read statically from its SOURCE TEXT.
 *
 * Three things have to hold or the CI selector silently stops running a guard, or crashes on every pull request:
 *   1. `null` AND `[]` ARE DIFFERENT ANSWERS. `null` is "this guard has not said" (keep running it); `[]` is "it reads nothing outside its imports".
 *   2. ONLY A DECLARATION COUNTS. The word inside a comment, a string, a template literal or a regex-ish assertion message is not a declaration and
 *      must not be refused (the selector parses every always-run guard); but a name BOUND by const/let/var that is not in the one parseable form is
 *      REFUSED, because a scope guessed wrong is a guard that stops running.
 *   3. `inScope` covers an entry and everything UNDER it, on a path-segment boundary (`packages/a` does not cover `packages/ab`).
 *
 * THE POSITIVE CONTROLS: every "declares nothing" fixture has a sibling that differs only by being a real declaration, and the empty-scope test
 * sits beside non-empty ones, so `[]` is not what the parser returns for everything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inScope, parseWalkScope } from "./walk-scope-declaration.ts";

test("a file with no WALK_SCOPE declares nothing (null), which is not an empty scope", () => {
  assert.equal(parseWalkScope("import { test } from 'node:test';\ntest('x', () => {});\n"), null);
  assert.equal(parseWalkScope(""), null);
  assert.deepEqual(parseWalkScope("export const WALK_SCOPE = [];"), []);
});

test("entries are read in order, with either quote, whitespace tolerated and trailing slashes stripped", () => {
  assert.deepEqual(parseWalkScope(`export const WALK_SCOPE = ["docs/adr/", 'scripts/git-hooks', "a///" ];`), ["docs/adr", "scripts/git-hooks", "a"]);
});

test("the typed and `as const` forms, and a multi-line list with comments, are declarations", () => {
  assert.deepEqual(parseWalkScope(`export const WALK_SCOPE: string[] = ["x"];`), ["x"]);
  assert.deepEqual(parseWalkScope(`export const WALK_SCOPE = ["y"] as const;`), ["y"]);
  const multiline = [
    "export const WALK_SCOPE = [",
    "  \"one\", // the first, http://example.com is a comment",
    "  /* block */ \"two\",",
    "];",
  ].join("\n");
  assert.deepEqual(parseWalkScope(multiline), ["one", "two"]);
});

test("a `//` inside an earlier string (a URL) does not blank the declaration that follows", () => {
  const source = `import x from "file:///tmp/a.mjs";\nconst u = "https://example.com/a";\nexport const WALK_SCOPE = ["z"];\n`;
  assert.deepEqual(parseWalkScope(source), ["z"]);
});

test("the name in a comment, a string, a template or an escaped-quote string is not a declaration", () => {
  const mentions = [
    "// const WALK_SCOPE = [\"a\"];",
    "/* export const WALK_SCOPE = [\"a\"]; */",
    "assert.match(msg, /WALK_SCOPE is named/);",
    "const text = 'const WALK_SCOPE = [1]';",
    "const text = \"declares \\\" const WALK_SCOPE = [1]\";",
    "const fixture = `\nexport const WALK_SCOPE = [\"inside-a-template\"];\n`;",
  ];
  for (const source of mentions) assert.equal(parseWalkScope(source), null, source);
});

test("OBSERVED LIMIT: a regex literal that quotes `const WALK_SCOPE` is refused, because the scanner blanks strings and not regex literals", () => {
  // The header says a regex-literal mention must not be refused; it holds only while the literal lacks the `const ` / `let ` / `var ` prefix. Pinned as
  // observed so a fix to the scanner shows up here as a deliberate change rather than a surprise.
  assert.equal(parseWalkScope("assert.match(msg, /WALK_SCOPE/);"), null);
  assert.throws(() => parseWalkScope("assert.match(msg, /export const WALK_SCOPE/);"), /named but not declared/);
});

test("a declaration outside a template is read even when a template fixture holds the same shape", () => {
  const source = "const fixture = `\nexport const WALK_SCOPE = [\"fixture\"];\n`;\nexport const WALK_SCOPE = [\"real\"];\n";
  assert.deepEqual(parseWalkScope(source), ["real"]);
});

test("a bound WALK_SCOPE that is not in the parseable form is refused, naming the form", () => {
  const malformed = [
    "const WALK_SCOPE = [\"a\"];",
    "export let WALK_SCOPE = [\"a\"];",
    "var WALK_SCOPE = [\"a\"];",
    "export const WALK_SCOPE = computeScope();",
    "export const WALK_SCOPE = [\"a\"]",
  ];
  for (const source of malformed) {
    assert.throws(() => parseWalkScope(source), /walk-scope: `WALK_SCOPE` is named but not declared as `export const WALK_SCOPE = \[/, source);
  }
});

test("an entry that is not a quoted string literal is refused by name", () => {
  assert.throws(() => parseWalkScope(`export const WALK_SCOPE = ["a", someVariable];`), /WALK_SCOPE entry someVariable is not a string literal/);
  assert.throws(() => parseWalkScope("export const WALK_SCOPE = [`tpl`];"), /entry `\s+` is not a string literal/);
  assert.throws(() => parseWalkScope(`export const WALK_SCOPE = ["a" "b"];`), /is not a string literal/);
});

test("inScope: an entry covers itself and everything beneath it", () => {
  assert.equal(inScope("docs/adr", ["docs/adr"]), true);
  assert.equal(inScope("docs/adr/0021.md", ["docs/adr"]), true);
  assert.equal(inScope("docs/adr/deep/er/file.md", ["scripts", "docs/adr"]), true);
});

test("inScope: a sibling sharing a prefix, a parent, an unrelated path and an empty scope are outside", () => {
  assert.equal(inScope("docs/adrs/x.md", ["docs/adr"]), false);
  assert.equal(inScope("docs", ["docs/adr"]), false);
  assert.equal(inScope("scripts/x.mjs", ["docs/adr"]), false);
  assert.equal(inScope("docs/adr/x.md", []), false);
});
