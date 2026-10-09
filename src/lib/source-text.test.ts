import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./source-text.ts";

test("a line comment is removed", () => {
  assert.equal(stripComments("const a = 1; // trailing comment\nconst b = 2;"),
    "const a = 1; \nconst b = 2;");
});

test("a block comment is removed, including one spanning multiple lines", () => {
  assert.equal(stripComments("const a = /* inline */ 1;"), "const a =  1;");
  assert.equal(stripComments("const a = 1;\n/*\n * a paragraph\n */\nconst b = 2;"),
    "const a = 1;\n\nconst b = 2;");
});

// THE RISK NAMED EXPLICITLY BEFORE THIS FUNCTION WAS WRITTEN, so it is a requirement here, not an
// afterthought: a URL in a string literal contains `//` and must survive whole.
test("a URL inside a string literal survives -- this is the reason a naive strip is unsafe", () => {
  const source = 'const url = "https://example.com/path";';
  assert.equal(stripComments(source), source, "nothing here is a comment; the string must be untouched");
});

test("a URL in a single-quoted string and a template literal both survive", () => {
  assert.equal(stripComments("const a = 'https://example.com';"), "const a = 'https://example.com';");
  assert.equal(stripComments("const a = `see https://example.com for more`;"),
    "const a = `see https://example.com for more`;");
});

test("a block-comment-shaped sequence inside a string survives", () => {
  const source = 'const s = "this is /* not a comment */ actually a string";';
  assert.equal(stripComments(source), source);
});

test("an escaped quote inside a string does not end the string early", () => {
  // If the escape were not honoured, the string would appear to end at \" and the // later on the line
  // would be read as inside code rather than inside the (still-open) string -- or vice versa. Either
  // misreading corrupts everything the guard extracts afterward on affected lines.
  const source = 'const s = "say \\"hi // not a comment\\""; // this one IS a comment';
  assert.equal(stripComments(source), 'const s = "say \\"hi // not a comment\\""; ');
});

test("a comment after real code on the same line is still stripped", () => {
  // One of the three hand-rolled strippers this function replaces only matched a `//` that was the ENTIRE
  // line (only whitespace before it), so a trailing same-line comment survived untouched. This function
  // must not repeat that gap.
  assert.equal(stripComments('const x = 1; // trailing'), "const x = 1; ");
});

test("comments inside comments are not double-unwrapped, and nesting-looking text is inert", () => {
  assert.equal(stripComments("/* outer /* not nested */ still code */"), " still code */");
});

// THE THREE REAL INCIDENTS, reproduced as regression fixtures rather than left as prose in a comment.
test("a call site's own explanatory paragraph does not manufacture a match -- the mapping-parity incident", () => {
  const source = "/**\n"
    + " * Downgraded to secondary. The word conformance appears here, in the paragraph explaining why,\n"
    + " * not in a real add(..., \"conformance\") call.\n"
    + " */\n"
    + "add(\"3.3.3 ...\", \"issue\", \"evidence\");\n";
  const stripped = stripComments(source);
  assert.ok(!stripped.includes("conformance"),
    "the word must be gone once the comment naming it is stripped, leaving only the real call site");
});

test("a field's own doc comment naming it does not stand in for the field being present -- the "
  + "probe-results-reach-the-channel incident", () => {
  const withField = "return {\n  // focusReveal: 1.4.13's verdict, forwarded here.\n  ...(focusReveal ? "
    + "{ focusReveal } : {}),\n};";
  const withoutField = "return {\n  // focusReveal: 1.4.13's verdict, forwarded here.\n};";
  const stillMentionsIt = (text: string) => new RegExp("\\bfocusReveal\\b").test(stripComments(text));
  assert.equal(stillMentionsIt(withField), true, "the real spread must still be visible once stripped");
  assert.equal(stillMentionsIt(withoutField), false,
    "with the spread deleted, only the comment named the field -- and the comment must be gone");
});

test("two functions with an identical comment do not bleed into each other once comments are gone", () => {
  // The near miss recorded in this function's own docstring: an extraction anchored on a comment matched a
  // SIBLING function's identical one. Stripping comments first means an anchor must be a real code token,
  // which cannot collide the same way.
  const source = "// Sequenced first, for the reason stated above.\n"
    + "function probeA() { return 1; }\n"
    + "// Sequenced first, for the reason stated above.\n"
    + "function probeB() { return 2; }\n";
  const stripped = stripComments(source);
  assert.equal(stripped.indexOf("Sequenced"), -1);
  assert.equal([...stripped.matchAll(/function (\w+)/g)].map((m) => m[1]).join(","), "probeA,probeB");
});

// KNOWN, DOCUMENTED LIMITATIONS -- stated as passing tests that pin the boundary, not hidden.
test("KNOWN LIMITATION: a comment inside a template literal's ${} interpolation is not stripped", () => {
  const source = "const s = `value: ${/* not stripped */ 1}`;";
  assert.equal(stripComments(source), source,
    "the whole template literal, interpolation included, is treated as string content -- documented in "
      + "this function's own comment, not a silent gap");
});

// FIXED, having stopped being hypothetical -- A2/#453. A nested template literal inside an interpolation
// used to corrupt the OUTER literal's own end, silently swallowing real code after it -- but only when the
// TOTAL backtick count inside the interpolation is ODD. An even count (one simple `` `a` : `b` `` ternary,
// say) happens to resynchronise by luck: each misidentified boundary just shifts which characters read as
// "inside" a string, and with an even number of delimiters the drift cancels out by the true end anyway.
// So the naive regression case is not a regression case at all -- verified before trusting it, by running
// the OLD (unfixed) scanner against it and finding it survived unchanged. The real incident had an ODD
// count, from string CONCATENATION (`` `a` + `b` ``) mixed into the ternary, which does not resynchronise.
test("MUTATION TARGET: the exact shape measured on scripts/select-changed-tests.mjs -- concatenated "
  + "template literals inside a ternary inside one interpolation, ODD backtick count, real code after it", () => {
  const source = "function report(result) {\n"
    + "  console.log(`select-changed-tests: ${result.broad.length > 0\n"
    + "    ? `BROAD -- ${result.broad.length} file(s) outside packages/*/src/ (${result.broad.slice(0, 5)"
    + ".join(\", \")}` + `${result.broad.length > 5 ? \", ...\" : \"\"}), falling back`\n"
    + "    : `${result.selectedTests.length} test file(s) selected precisely` + (result.fallbackPackages"
    + ".length > 0\n"
    + "      ? `, plus the full suite of ${result.fallbackPackages.length} package(s)`\n"
    + "      : \"\")}`);\n"
    + "}\n"
    + "function main() {\n"
    + "  refuseUnknownFlags([], { entry: import.meta.url });\n"
    + "}\n";
  const stripped = stripComments(source);
  assert.ok(stripped.includes("refuseUnknownFlags("),
    "the real call after the corrupting template literal must survive stripping -- this is the exact "
      + "shape that made a guarded file (select-changed-tests.mjs) read as unguarded");
});

test("a comment INSIDE a nested-template interpolation is still not stripped -- the KNOWN LIMITATION "
  + "above is unchanged by the nesting fix, only the outer literal's END is now found correctly", () => {
  const source = "const s = `${cond ? `/* not stripped */a` : `b`}`;";
  assert.equal(stripComments(source), source);
});

// FIXED, having stopped being hypothetical a second time in the same fix -- the FIRST version of
// `skipInterpolation` (walking an interpolation as full code, comments included) reproduced this repo's
// own already-documented, accepted limitation ("a regex literal is not distinguished from a division") in
// a MUCH more damaging place. `/^https?:\/\//` (stripping a URL scheme -- a real, common pattern in this
// codebase) contains an escaped slash immediately followed by the regex's own closing slash, which reads
// as a line-comment start. At the top level that costs one unstripped line; INSIDE an interpolation it
// swallowed the interpolation's own closing `}` (and the outer literal's closing backtick with it),
// corrupting everything scanned afterward -- measured for real on `calibrate-abstention.mjs`, where it
// misread three later, unrelated `//` comments as still being inside the first string.
test("MUTATION TARGET: a regex literal inside an interpolation does not corrupt the outer literal's end", () => {
  const source = "function report(item) {\n"
    + "  process.stdout.write(`    ${item.criterion}  `\n"
    + "    + `${String(item.url).replace(/^https?:\\/\\//, \"\").slice(0, 52)}\\n`);\n"
    + "}\n"
    + "function main() {\n"
    + "  // a real comment that must still be stripped\n"
    + "  refuseUnknownFlags([], { entry: import.meta.url });\n"
    + "}\n";
  const stripped = stripComments(source);
  assert.ok(stripped.includes("refuseUnknownFlags("),
    "the real call after the corrupting regex-in-interpolation must survive stripping");
  assert.ok(!stripped.includes("a real comment"),
    "a genuine top-level comment AFTER the interpolation must still be stripped normally -- proving the "
      + "scanner's state was not left corrupted");
});

// INVERTED, exactly as its own last sentence instructed -- #2131. This test used to assert
// `notEqual(stripped, source)` and said: "if this assertion ever starts failing, the limitation has been
// fixed and this test should be inverted." The fix landed, so it is inverted rather than deleted, because
// the direction is the whole point: the old assertion passed BECAUSE the scan was wrong.
test("a regex literal containing `//` is content, not a comment start -- the limitation this file used "
  + "to pin as accepted", () => {
  const source = "const r = /a\\/\\//;"; // a regex literal containing two escaped slashes
  assert.equal(stripComments(source), source,
    "the escaped slashes are regex syntax; reading them as a comment start truncated the line");
});

// --- #2131: A REGEX LITERAL IS A TOKEN, and the quote characters inside one are CONTENT ---
//
// The docstring above declined to recognise regex literals on the ground that a comment-shaped sequence
// inside one "has not been observed in any guard this function replaces". Measured at d269bf9d4
// (2026-09-23) over the 1050 tracked `.ts`/`.mjs` files under `packages/` and `scripts/` that
// `strip-comments-scan-sync.test.ts` walks: 100 of them came out of the unfixed function keeping a comment
// the TypeScript parser removes, and 56 came out having lost a character it keeps. Every one of the 100
// carries a quote character inside a regex literal; by the first such literal in each file, an apostrophe
// in 29, a double quote in 49, a backtick in 22 -- a proxy for the swallowing literal rather than a proof
// of it. The population is a reading at a commit and it moves with the tree (1042 -> 1050 across four
// merges); `strip-comments-scan-sync.test.ts` holds the tree-wide reading and asserts the only figure that
// does not move -- 0 -- while this file holds the mechanism, isolated.

test("MUTATION TARGET: a BACKTICK inside a regex literal does not open a phantom template literal -- and "
  + "the identical line WITHOUT backticks is the control that proves the pair is about the backticks", () => {
  // The exact opener measured in packages/lab/src/packaging/wake.test.ts:603, which swallowed 54 of that
  // file's 87 comment lines. Three backticks: the first opens template mode, the second closes it, and the
  // THIRD opens it again and scans for a partner hundreds of lines away.
  const isolated = "text.match(/message `([^`]+)`/)?.[1];\n// THIS COMMENT SHOULD VANISH\nconst x = 1;\n";
  const control = "text.match(/message X/)?.[1];\n// THIS COMMENT SHOULD VANISH\nconst x = 1;\n";
  // ONE WITHOUT THE OTHER PINS NOTHING: a stripper that gave up and stripped nothing would pass the first
  // assertion's negation and fail here, and a stripper that stripped everything would fail the third.
  assert.ok(!stripComments(isolated).includes("THIS COMMENT SHOULD VANISH"),
    "the comment after a regex literal containing backticks must be stripped");
  assert.ok(!stripComments(control).includes("THIS COMMENT SHOULD VANISH"),
    "the control, identical but for the backticks, must still strip its comment");
  assert.ok(stripComments(isolated).includes("/message `([^`]+)`/"),
    "and the regex literal itself must survive whole -- its backticks are content, not delimiters");
});

test("an apostrophe and a double quote inside a regex literal are content too -- the other 79 of the "
  + "100 files measured", () => {
  // packages/cli/src/forms/draft.test.ts:126 and packages/lab/src/packaging/board-status-health.test.ts:182,
  // reduced to their opener. Both are far more common than the backtick case and fail the same way.
  const apostrophe = "assert.match(y, /not a finding about your page's grammar/);\n// GONE\nconst x = 1;\n";
  const doubleQuote = "for (const m of src.matchAll(/moveStatus\\(\\s*\"([^\"]+)\"/g)) sent.add(m[1]);\n// GONE\nlet y;\n";
  for (const [name, source] of [["apostrophe", apostrophe], ["double quote", doubleQuote]] as const) {
    assert.ok(!stripComments(source).includes("GONE"),
      `a ${name} inside a regex literal must not open a string: the comment after it is still a comment`);
  }
});

test("a regex literal in a KEYWORD value position is recognised -- `return`, not an identifier", () => {
  // `slashBeginsRegex` reads the previous token, and `return` ends in identifier characters. Without the
  // keyword set it reads as an operand, the slash reads as a division, and the backtick inside opens a
  // phantom template literal that runs to the end of the file.
  const source = "function f(t) {\n  return /message `([^`]+)`/.test(t);\n}\n// GONE\nconst x = 1;\n";
  const stripped = stripComments(source);
  assert.ok(!stripped.includes("GONE"), "a regex after `return` must be recognised as a regex");
  assert.ok(stripped.includes("return /message `([^`]+)`/.test(t);"), "and copied through whole");
});

test("MUTATION TARGET: a regex literal whose body contains a QUOTE, inside an interpolation -- the shape "
  + "in pre-push-armed-pr.test.ts, where the outer template literal's own end was lost", () => {
  // `skipInterpolation` honours nested strings but had no notion of a regex, so `/'/g`'s apostrophe closed
  // nothing and opened everything. This is the interpolation-level twin of the top-level case above.
  const source = "const script =\n"
    + "  `node() { echo '${stubOut.replace(/'/g, \"'\\\\''\")}'; exit ${code}; }\\n`\n"
    + "  + \"run\\n\";\n"
    + "// GONE\n"
    + "runTheHook(script);\n";
  const stripped = stripComments(source);
  assert.ok(!stripped.includes("GONE"),
    "a genuine comment AFTER the interpolation must still be stripped -- proving the scanner's state was "
      + "not left corrupted by the regex inside it");
  assert.ok(stripped.includes("runTheHook(script);"), "and the real call after it must survive");
});

// --- THE OTHER DIRECTION: the fix must not INVENT a regex where a division was meant ---

test("division is still division: a `/` after anything that can END an operand is not a regex opener", () => {
  // Inventing a literal is NEW damage, where failing to see one only reproduces the old behaviour -- so
  // every shape that can precede a division is pinned here rather than left to the tree-wide census.
  const cases: [string, string][] = [
    ["after an identifier", "const mean = total / count; // GONE\nconst x = 1;\n"],
    ["after a number", "const half = 100 / 2; // GONE\nconst x = 1;\n"],
    ["after a closing paren", "const r = (a + b) / 2; // GONE\nconst x = 1;\n"],
    ["after a closing bracket", "const r = xs[0] / 2; // GONE\nconst x = 1;\n"],
    ["two divisions on one line", "const r = a / b / c; // GONE\nconst x = 1;\n"],
    // reviewer's blocker at `def6aef9`, as the positive division control it asked for. A word after `.`
    // is a PROPERTY NAME, and every keyword in KEYWORDS_EXPECTING_A_VALUE is a legal one. Before the fix
    // `obj.in` left `previousToken === "in"`, the division slash opened a candidate regex,
    // `endOfRegexLiteral` closed it on the FIRST slash of the `//`, and the comment was copied as code --
    // NEW damage, since the pre-#2131 stripper removed it.
    ["after a property named `in`", "const n = obj.in / 2 // GONE\nconst x = 1;\n"],
    ["after a property named `of`", "const n = obj.of / 2 // GONE\nconst x = 1;\n"],
    ["after a property named `case`", "const n = obj.case / 2 // GONE\nconst x = 1;\n"],
    ["after an OPTIONALLY chained property", "const n = obj?.in / 2 // GONE\nconst x = 1;\n"],
    ["after a property on a newline", "const n = obj\n  .in / 2 // GONE\nconst x = 1;\n"],
    // reviewer's blocker at `fbac7004`, as the positive division controls for BOTH forms it asked for.
    // A postfix operator ends an operand although neither of its characters does: `a++` left
    // `previousToken` as a bare `+`, which expects a value next, so the division slash opened a
    // candidate regex, `endOfRegexLiteral` closed it on the FIRST slash of the `//`, and the comment
    // survived -- the `obj.in / 2` shape exactly, one operator over, and NEW damage for the same reason.
    ["after a postfix ++", "let a = 1; a++ / 2 // GONE\nconst x = 1;\n"],
    ["after a postfix --", "let a = 1; a-- / 2 // GONE\nconst x = 1;\n"],
    ["after a postfix ++ with no spacing", "let a = 1; a++/2 // GONE\nconst x = 1;\n"],
    // `a+++b` is `a++ + b`: the pair is consumed first and the third `+` is left a binary operator, so
    // this fails if the scan ever matches `++` greedily across a boundary.
    ["after `a+++b`, which is `a++ + b`", "let a = 1, b = 1; a+++b / 2 // GONE\nconst x = 1;\n"],
    ["after `a---b`, which is `a-- - b`", "let a = 1, b = 1; a---b / 2 // GONE\nconst x = 1;\n"],
  ];
  for (const [name, source] of cases) {
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("GONE"), `${name}: the trailing comment must still be stripped`);
    assert.ok(stripped.includes("const x = 1;"), `${name}: the code after it must survive`);
  }
});

test("a keyword is only a keyword in VALUE position -- `of` after `.` is a property, but `of` in a "
  + "`for...of` header still opens a regex", () => {
  // The control that keeps the fix above from being "the keyword list is dead". Both halves matter: the
  // property read must divide, and the genuine value position must still be seen, or the shape the list
  // was added for (`for (const k of /re/…)`) silently regresses to the pre-#2131 behaviour.
  const header = "for (const k of /a`b/.test(s) ? xs : ys) {\n  f(k);\n}\n// GONE\nconst x = 1;\n";
  const stripped = stripComments(header);
  assert.ok(stripped.includes("/a`b/.test(s)"),
    "the backtick inside the regex is CONTENT -- read as a template opener it swallows the rest of the file");
  assert.ok(!stripped.includes("GONE") && stripped.includes("const x = 1;"),
    "and nothing after the regex is corrupted");
  // Same word, member position: the slash after it is a division and the trailing comment is a comment.
  assert.ok(!stripComments("const n = xs.of / 2 // GONE\nconst x = 1;\n").includes("GONE"));
});

test("a postfix operator ends an operand, but a BINARY `+` or `-` still expects a value -- the control "
  + "that keeps the fix from being `+ ends an operand`", () => {
  // The other half of reviewer's `fbac7004` blocker, and the reason the pair is read as ONE token rather
  // than added to ENDS_AN_OPERAND character by character. Widening the character class would have made
  // the division cases above pass while silently losing every regex written after an ordinary `+` or `-`
  // -- a fix whose control is only the cases it was written for is not distinguishable from that.
  for (const [name, source] of [
    ["after a binary +", "const m = 1 + /a`b/.test(s); // GONE\nconst x = 1;\n"],
    ["after a binary -", "const m = 1 - /a`b/.test(s); // GONE\nconst x = 1;\n"],
  ] as const) {
    const stripped = stripComments(source);
    assert.ok(stripped.includes("/a`b/.test(s)"),
      `${name}: the regex must still be recognised -- its backtick is content, and read as a template `
        + "opener it swallows the rest of the file");
    assert.ok(!stripped.includes("GONE") && stripped.includes("const x = 1;"),
      `${name}: and nothing after it is corrupted`);
  }
  // A PREFIX `++` is never the ambiguous case: it is followed by the operand it increments, so the token
  // the scan remembers at the division is that identifier and the postfix set is never consulted.
  assert.ok(!stripComments("let b = 1; let a = ++b / 2; // GONE\nconst x = 1;\n").includes("GONE"),
    "a division after a prefix-incremented operand is still a division");

  // AND THE SAME JUDGEMENT INSIDE AN INTERPOLATION, where getting it wrong is not bounded to one line.
  // `skipInterpolation` tracks brace depth, so a phantom regex opened at `a++ /` runs to the NEXT slash
  // and swallows the interpolation's own closing `}` on the way -- depth never returns to 0, the outer
  // template literal never finds its end, and the rest of the file is copied through as string content.
  // That is why the fix is in BOTH scans.
  //
  // THE SHAPE HAS TO CARRY A LATER SLASH ON THE SAME LINE, which is what makes this a control rather
  // than a decoration: without one the phantom candidate reaches the newline, `endOfRegexLiteral` returns
  // -1, and the scan recovers by itself. The first shape written here had a second interpolation whose
  // own `}` closed the depth by luck, and it passed with this half of the fix removed.
  for (const [name, source] of [
    ["a division later on the line", "const t = `${a++ / 2}`; const q = m / n; // GONE\nconst x = 1;\n"],
    ["a division in the same expression", "const t = `${a++ / 2}` + x / y; // GONE\nconst x = 1;\n"],
  ] as const) {
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("GONE"),
      `${name}: the interpolation's closing brace must survive the division, or everything after the `
        + "template literal is read as string content");
    assert.ok(stripped.includes("const x = 1;"), `${name}: and the code after it too`);
  }
});

test("a candidate regex that does not close on its own line is ABANDONED -- the second half of the "
  + "safety argument, since a regex literal can never span a line", () => {
  // `= / x` looks like a value position, so the slash is a regex CANDIDATE. There is no closing slash
  // before the newline, so it was a division after all and the scan must fall back rather than run on.
  const source = "const r = / 2;\n// GONE\nconst x = 1;\n";
  const stripped = stripComments(source);
  assert.ok(!stripped.includes("GONE"),
    "an unclosed candidate must not swallow the following line's comment");
  assert.ok(stripped.includes("const x = 1;"), "nor the line after that");
});

test("`//` and `/*` are comments in EVERY position, including a value position where a regex could "
  + "otherwise start", () => {
  // The empty regex is not expressible in JavaScript and `*` cannot open a regex body, so these two
  // must be tested before the regex branch, not after it.
  assert.equal(stripComments("const a = 1; // trailing\nconst b = 2;"), "const a = 1; \nconst b = 2;");
  assert.equal(stripComments("const a = /* inline */ 1;"), "const a =  1;");
});

// --- THE POSITIVE CONTROL FOR THE WHOLE FIX: an ordinary file must still strip to nothing ---

/** The floor under `release-per-merge.ts`'s comment density, below the 36 measured (this package's most commented file; core's `verify.ts` read 150), so ordinary edits to that
 *  file do not move this control -- only its stopping to be densely commented at all would. */
const A_DENSELY_COMMENTED_FILE = 30;

test("a file that was ALREADY stripped correctly still strips to zero surviving comment lines -- the "
  + "control a fix that broke ordinary stripping would fail", () => {
  // A file of THIS package, never another repository's source: this read `wake.mjs` out of agent-org by path, which is no interface (#4409).
  // `release-per-merge.ts` reads 36 leading-`//` lines before stripping and 0 after (measured; moved from core's `verify.ts`, #4585). A FLOOR rather than a pin on 36: the file legitimately
  // gains and loses comments, and what this test is for is the `0`.
  const source = readFileSync(join(import.meta.dirname, "../../scripts/release-per-merge.ts"), "utf8");
  const leading = (text: string) => text.split("\n").filter((line) => line.trim().startsWith("//")).length;
  assert.ok(leading(source) >= A_DENSELY_COMMENTED_FILE,
    `release-per-merge.ts has only ${leading(source)} leading-// lines, below the 36 measured -- this control has `
      + "stopped being a control, so pick another densely commented file rather than weakening it");
  assert.equal(leading(stripComments(source)), 0,
    "every one of them is a real comment and must be gone -- a fix that breaks ordinary stripping to "
      + "handle regex literals fails here");
});
