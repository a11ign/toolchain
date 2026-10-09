/**
 * Strip JS/TS comments from source text, WITHOUT mangling a string literal that happens to contain `//`.
 *
 * ## Why this exists
 *
 * Several guards across this repo cannot import the thing they check — a Python function, a call site
 * rather than a value, a function with no local harness — so they read the SOURCE FILE and match a regex
 * against it instead. Doing that against raw text is unsound: a comment can contain the exact words the
 * regex is hunting for, so the guard matches its own PROSE rather than the code it is meant to police.
 * Measured three times in one day, on three different guards, each with its own hand-rolled strip:
 *
 *   - `mapping-parity.test.ts` matched `add(..., "conformance")` call sites in `rules.ts`. Every one of
 *     those call sites now sits under a paragraph EXPLAINING why it is `secondary`, and those paragraphs
 *     contain the word "conformance" — so the unstripped source invented call sites that do not exist.
 *   - `probe-results-reach-the-channel.test.ts` sliced `interactionEvidence`'s return body and matched
 *     field names in it. Every field there is commented with why it is conditional, and the comment NAMES
 *     the field — so the guard passed with the real `focusReveal` spread deleted, because the comment
 *     above where it used to be still contained the word.
 *   - A third, caught before it shipped: an extraction anchor matched a SIBLING function's identical
 *     comment, which would have sliced 320 lines across two functions instead of one.
 *
 * Each was found by mutation — deleting the code the guard exists to protect and watching it stay green —
 * never by review, because the guard reads as correct until you ask what it actually saw.
 *
 * ## What this does and does not handle
 *
 * STILL NOT A GENERAL-PURPOSE PARSER, but it now recognises three token kinds rather than two: comments,
 * string literals, and REGEX LITERALS. The regex kind was refused here until #2131 on the stated ground
 * that a comment-shaped sequence inside a regex literal "has not been observed in any guard this function
 * replaces" — a true premise when it was written and a false one now. Measured at `d269bf9d4`
 * (2026-09-23) over the 1050 tracked `.ts` and `.mjs` files under `packages/` and `scripts/` that
 * `strip-comments-scan-sync.test.ts` walks: **100 of them** came out of the unfixed function keeping a
 * comment line the TypeScript parser removes, which can only happen where the scan believed it was inside
 * a string while passing a comment, and **56** came out having LOST a character the parser keeps. Every
 * one of the 100 contains a quote character written inside a regex literal — the construct this fix adds;
 * taking the FIRST such literal in each file, that character is an apostrophe in 29, a double quote in 49
 * and a BACKTICK in 22. (First-literal attribution is a proxy for which literal actually swallowed the
 * file rather than a proof of it, and the population is a reading at a commit: an earlier 40/39/21 split
 * over a 1005-file population came from a census script that was never in the tree and is WITHDRAWN, not
 * reconciled.) See `endOfRegexLiteral` for what is recognised, and `slashBeginsRegex` for the one
 * judgement it has to make.
 *
 * WHY THAT MATTERS IN BOTH DIRECTIONS, and why the false NEGATIVE is the one to fear. A guard reading a
 * desynchronised file sees everything after the phantom opener as string content: the false positive
 * (a guard charging a `~/.cache` written inside a `//` comment) is how this was found, but the false
 * negative — a real violation written anywhere in the swallowed region and silently not flagged — is a
 * guard going quiet, and a quiet guard never announces itself. `stripComments` is the shared reader for
 * roughly twenty of them.
 *
 * The two gaps below are handled for the same reason they always were — each was why one of the
 * hand-rolled versions above existed in the first place:
 *
 *   - `//` and `/* ... *\/` sequences INSIDE a string literal (`'`, `"`, or a template literal) are left
 *     alone. `"https://example.com"` survives whole; a naive `source.replace(/\/\/.*$/gm, "")` would cut
 *     it to `"https:` and corrupt everything the regex reads after it on that line.
 *   - An ESCAPED quote inside a string (`"say \\"hi\\""`) does not end the string early, so a comment
 *     marker appearing later on the same source line, genuinely outside the string, is still stripped.
 *
 * WHAT IS NOT HANDLED, stated rather than left to be discovered by a future mutation: a comment INSIDE an
 * interpolated expression (`` `${/* oops *\/ x}` ``) is not stripped — the interpolation's CONTENT is
 * copied through verbatim, comments included, same as any other string content.
 *
 * AND THE REGEX-VERSUS-DIVISION JUDGEMENT IS A HEURISTIC, not a parse: `slashBeginsRegex` reads the
 * previous significant token, which is what a real lexer does, but it does it without a grammar. Both of
 * its errors are deliberately UNEQUAL. Failing to see a regex leaves this function exactly where it was
 * before #2131, so the worst case of the heuristic is the old behaviour; inventing one where a division
 * was meant would be NEW damage, so that direction is bounded twice over — a `/` is read as division after
 * anything that can END an operand, and a candidate regex that does not close on its own line is abandoned
 * and re-read as an ordinary character.
 *
 * WHAT IS NOW HANDLED, having stopped being hypothetical: a NESTED template literal (or a `'`/`"` string)
 * inside an interpolation (`` `${cond ? `a` : `b`}` ``) used to corrupt the OUTER literal's own end — the
 * scan for its closing backtick stopped at the inner literal's opening one instead, silently swallowing
 * every real line of code after it into what the scanner believed was still string content. Measured for
 * real on `scripts/select-changed-tests.mjs`'s `console.log`, whose interpolation was a ternary between two
 * template literals: the rest of `main()`, including a real `refuseUnknownFlags(` call, vanished from the
 * stripped output, and a census reading it reported an already-guarded file as unguarded. `skipInterpolation`
 * now walks an interpolation's brace depth, honouring any nested string/template it meets, so the outer
 * literal's true end is found regardless of what nested strings its interpolation contains.
 *
 * DELIBERATELY STOPS THERE and does not also go looking for COMMENTS inside an interpolation — see
 * `skipInterpolation`'s own comment for why extending into that territory reproduces the regex-vs-division
 * limitation above in a far more damaging place (measured for real on `calibrate-abstention.mjs`, which
 * corrupted the rest of the file after a `/^https?:\/\//` regex inside an interpolation). This is exactly
 * the shape a guard's own anti-vacuity assertion exists to catch, and it caught it twice on the first real
 * files shaped either way, not by review.
 *
 * Line comments are recognised only where `//` is not inside a string, matching what every guard that used
 * to hand-roll this actually needed — including a `//` that follows real code on the same line, which one
 * of the three hand-rolled versions this replaces did not strip at all.
 */
/** Index just past the end of a `//` line comment starting at `i` — the newline itself, or `source.length`. */
function endOfLineComment(source: string, i: number): number {
  let j = i;
  while (j < source.length && source[j] !== "\n") j += 1;
  return j;
}

/** Index just past the closing star-slash of a block comment starting at `i`. Tolerates an unterminated one. */
function endOfBlockComment(source: string, i: number): number {
  let j = i + 2;
  while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) j += 1;
  return j + 2; // past the closing delimiter; harmless if unterminated and j already reached source.length
}

/**
 * The keywords after which a `/` can only begin a REGEX LITERAL, never a division — because each of them
 * ends where a VALUE is expected. Without this list, `return /a`b`/.test(x)` reads its `return` as an
 * identifier (an operand), calls the slash a division, and the backtick inside the regex opens a phantom
 * template literal that swallows the rest of the file. `in` and `of` are here for `for (const k of /re/…)`
 * shapes; `case` and `throw` for statement positions that take an expression.
 */
const KEYWORDS_EXPECTING_A_VALUE = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield",
  "await", "throw",
]);

/** A token that can END an operand — an identifier, a number, a closing bracket, or a string's closing quote. */
const ENDS_AN_OPERAND = /[A-Za-z0-9_$)\]}'"`]$/;

/**
 * Index just past the comment starting at `i`, or `-1` where no comment starts there.
 *
 * THE COMMENT FORMS ARE TESTED FIRST AND UNCONDITIONALLY, which is what JavaScript itself does: `//` is
 * a line comment in every position (the empty regex is not expressible) and `/*` is a block comment in
 * every position (`*` cannot open a regex body). Neither is ever a regex literal, so neither needs the
 * value-position judgement the slash branch below it makes.
 */
function endOfCommentAt(source: string, i: number): number {
  if (source[i] !== "/") return -1;
  if (source[i + 1] === "/") return endOfLineComment(source, i);
  if (source[i + 1] === "*") return endOfBlockComment(source, i);
  return -1;
}

/**
 * The postfix operators, which END an operand although neither of their characters does — `reviewer`'s
 * blocker at `fbac7004`, reproduced before it was fixed. `a++ / 2 // REAL_COMMENT` left `previousToken`
 * as a bare `+`, which is a BINARY operator and so expects a value next, so the division slash opened a
 * candidate regex, `endOfRegexLiteral` closed it on the first slash of the `//`, and the comment survived
 * — the same shape as the `obj.in / 2` blocker one review earlier, and the same new damage.
 *
 * THEY ARE ONLY AMBIGUOUS IN THE POSTFIX POSITION, WHICH IS WHY THE SET NEEDS NO CONTEXT. A PREFIX `++`
 * is followed by the thing it increments, never by a `/` — `++/re/` is not expressible — so the operand
 * it produces is remembered as that identifier and this set is never consulted. A bare `+` must keep
 * expecting a value, because `1 + /re/.test(s)` is an ordinary expression; that is the whole reason the
 * pair has to be read as ONE token rather than added to `ENDS_AN_OPERAND` character by character.
 */
const POSTFIX_OPERATORS = new Set(["++", "--"]);

/** `"++"` or `"--"` where one starts at `i`, otherwise `""`. The scan consumes the pair as ONE token for
 *  the reason above: its second character alone is a binary operator, and a scan that remembered only
 *  that would read the operand as still unfinished. */
function postfixOperatorAt(source: string, i: number): string {
  const pair = source.slice(i, i + 2);
  return POSTFIX_OPERATORS.has(pair) ? pair : "";
}

/** What the scan remembers where it has just consumed something that IS an operand and has no token of its
 *  own to remember — a completed regex literal, so the `/` in the unlikely `/a/ / 2` reads as the division
 *  it is, and a PROPERTY NAME, so `obj.in / 2` divides rather than opening a regex on the word `in`. A
 *  closing paren, because that is the plainest thing `ENDS_AN_OPERAND` already accepts. */
const AN_OPERAND = ")";

/**
 * Whether a `/` following `previousToken` opens a regex literal rather than dividing by something.
 *
 * THIS IS THE WHOLE JUDGEMENT, and it is the same one every real JS lexer has to make: `a / b` and
 * `/ab/` are the same two characters, and only what came BEFORE tells them apart. A division needs a
 * left-hand operand, so a `/` that follows anything which can end one is division; a `/` that follows an
 * operator, a `(`, a `,`, a `;` or the start of the file cannot be, because there is nothing to divide.
 *
 * A KEYWORD IS ONLY A KEYWORD IN VALUE POSITION, and after a `.` it is a PROPERTY NAME -- `reviewer`'s
 * blocker at `def6aef9`, reproduced before it was fixed. `const x = obj.in / 2 // REAL_COMMENT` left
 * `previousToken === "in"`, so the division slash opened a candidate regex, `endOfRegexLiteral` closed it
 * on the FIRST slash of the `//`, and the second slash plus the comment text were copied through as code.
 * The comment SURVIVED -- the old stripper removed it -- which is new damage of exactly the kind the
 * paragraph below claims to be bounded away from, so it was not bounded at all. The callers therefore
 * remember a word after `.` as `AN_OPERAND` rather than as itself, and this function never sees it. Every
 * name in the set below is a legal property name (`obj.new`, `obj.delete`, `obj.case`), so the fix is at
 * the call site, where the `.` is still visible, rather than in a longer list here.
 *
 * IT IS DELIBERATELY BIASED TOWARD "DIVISION", i.e. toward NOT recognising a regex. Saying "division"
 * where a regex was meant reproduces this file's behaviour before #2131 — a known, bounded cost, already
 * measured. Saying "regex" where a division was meant would invent a literal that swallows real code,
 * which is new damage, so the two unavoidable blind spots are both resolved the safe way: a regex written
 * immediately after `)` (`if (cond) /re/.test(s)`) or after a block's `}` is read as a division and left
 * alone, because those two brackets far more often close an operand than a condition. `!` is NOT in the
 * operand set, because `!/re/.test(x)` is common here and `x! / 2` is not.
 */
function slashBeginsRegex(previousToken: string): boolean {
  if (KEYWORDS_EXPECTING_A_VALUE.has(previousToken)) return true;
  if (POSTFIX_OPERATORS.has(previousToken)) return false;
  return !ENDS_AN_OPERAND.test(previousToken);
}

/**
 * Index just past the regex literal starting at `i` (its opening `/` is `source[i]`), flags included, or
 * `-1` when what starts there is not a regex literal after all.
 *
 * THE `-1` IS THE SECOND HALF OF THE SAFETY ARGUMENT in `slashBeginsRegex`. A regex literal cannot contain
 * an unescaped newline, so a candidate that reaches the end of its line without closing was never one, and
 * the caller re-reads the `/` as an ordinary character rather than consuming to some far-away slash. An
 * empty body is refused for the same reason: `//` is a line comment in every JS position, and the empty
 * regex is not expressible, so a `/` immediately followed by `/` is never this.
 *
 * A `/` inside a CHARACTER CLASS does not close the literal (`/[/]/`), which is why the class depth is
 * tracked; an escaped character is consumed as a pair so `/\//` closes at its third slash, not its second.
 */
function endOfRegexLiteral(source: string, i: number): number {
  if (source[i + 1] === "/" || source[i + 1] === undefined) return -1;
  let j = i + 1;
  let inCharacterClass = false;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\n") return -1; // a regex literal never spans a line: this was a division after all
    if (ch === "\\") { j += 2; continue; }
    if (ch === "[") inCharacterClass = true;
    else if (ch === "]") inCharacterClass = false;
    else if (ch === "/" && !inCharacterClass) break;
    j += 1;
  }
  if (j >= source.length) return -1; // unterminated: not a regex literal
  j += 1; // the closing slash
  while (j < source.length && /[a-z]/.test(source[j])) j += 1; // the flags
  return j;
}

/**
 * What the scan should remember for `word`, given the token before it: `AN_OPERAND` when that token was a
 * `.`, and the word itself otherwise.
 *
 * MEMBER ACCESS IS THE ONE PLACE A KEYWORD IS NOT ONE. `obj.in`, `obj.of`, `obj.new`, `obj.case` are all
 * legal property reads, and every one of them left `slashBeginsRegex` believing a value was expected next
 * -- so the `/` of a following division opened a phantom regex. Optional chaining (`obj?.in`) lands here
 * too, because the token immediately before the word is still the `.`.
 */
function propertyNameOrWord(previousToken: string, word: string): string {
  return previousToken === "." ? AN_OPERAND : word;
}

/** The run of identifier characters starting at `i`, which the scan consumes as ONE token so that a
 * keyword can be recognised whole by `slashBeginsRegex` rather than by its last letter. */
function identifierAt(source: string, i: number): string {
  let j = i;
  while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
  return source.slice(i, j);
}

/**
 * Index just past the matching `}` of a `${` interpolation, given `i` pointing at the `{` itself.
 *
 * WITHOUT THIS, a template literal containing a NESTED template literal in its interpolation —
 * `` `${cond ? `a` : `b`}` `` — corrupts everything scanned afterward. `copyStringLiteral`'s own loop looks
 * for the next literal backtick to end the OUTER string; the first backtick it meets is the INNER
 * literal's opening one, so it closes there instead, and the true outer close is never found. Measured for
 * real on `select-changed-tests.mjs`'s `console.log` call (a ternary of two template literals inside one
 * interpolation): the entire `main()` function body after it — including a real `refuseUnknownFlags(` call
 * — was swallowed into what the scanner believed was still inside the FIRST string, and a census reading
 * the stripped output reported an already-guarded file as unguarded.
 *
 * DELIBERATELY DOES NOT TREAT `//` OR `/* ... *\/` AS COMMENTS HERE, unlike the top-level loop — that is
 * not an oversight, it is what keeps this fix inside its own scope. Nested strings and template literals
 * ARE honoured (recursively, via `copyStringLiteral` itself), because that is the exact bug this function
 * exists to fix. But treating an interpolation's contents as full code to find COMMENTS in it collides
 * with this file's own already-documented, accepted limitation: a regex literal is not distinguished from
 * a division operator. `/^https?:\/\//` — a real, common regex in this codebase for stripping a URL
 * scheme — contains an escaped slash immediately followed by the regex's own closing slash (`\/\/`), which
 * a naive scan misreads as a line-comment START. At the TOP LEVEL that misreading is bounded: it eats one
 * line and the main loop recovers at the next newline, unstripped, which is the documented, accepted cost.
 * INSIDE an interpolation it is not bounded the same way: swallowing to the next newline also swallows the
 * interpolation's own closing `}` (and often the template literal's closing backtick with it), so the
 * OUTER literal never finds its true end and everything after it is corrupted — measured for real on
 * `calibrate-abstention.mjs`, whose `` `${...}` `` interpolation contains exactly this regex shape, and
 * which cascaded into misreading three later, unrelated comments as string content. Depth is counted only
 * where it is genuinely brace syntax OUTSIDE a nested string/template, and nothing here goes looking for a
 * comment that might not be one.
 */
function skipInterpolation(source: string, i: number): number {
  let depth = 1;
  let j = i + 1;
  let previousToken = "{"; // an interpolation opens where a value is expected, so a leading `/` is a regex
  while (j < source.length && depth > 0) {
    const ch = source[j];
    if (ch === "{") { depth += 1; j += 1; previousToken = ch; continue; }
    if (ch === "}") { depth -= 1; j += 1; previousToken = ch; continue; }
    if (ch === "'" || ch === "\"" || ch === "`") { j = copyStringLiteral(source, j).end; previousToken = ch; continue; }
    if (ch === "/" && slashBeginsRegex(previousToken)) {
      const end = endOfRegexLiteral(source, j);
      if (end > 0) { j = end; previousToken = AN_OPERAND; continue; }
    }
    const word = /[A-Za-z_$]/.test(ch) ? identifierAt(source, j) : "";
    if (word) { j += word.length; previousToken = propertyNameOrWord(previousToken, word); continue; }
    const postfix = postfixOperatorAt(source, j);
    if (postfix) { j += 2; previousToken = postfix; continue; }
    j += 1;
    if (!/\s/.test(ch)) previousToken = ch;
  }
  return j;
}

/**
 * The string literal starting at `i` (its opening quote is `source[i]`), copied through VERBATIM including
 * both quotes — comments are never stripped from inside one, which is this whole file's reason to exist.
 * Escaped characters are copied as a pair so an escaped quote (`\"`) can never be misread as the closing one.
 *
 * A TEMPLATE LITERAL'S `${...}` IS SKIPPED AS A UNIT, via `skipInterpolation`, rather than scanned
 * character-by-character like the rest of the string — see that function for the corruption this
 * prevents. What is INSIDE an interpolation is still copied verbatim into `text` (comments included, the
 * documented, unchanged "KNOWN LIMITATION" this file's own tests pin) — only the OUTER template literal's
 * true end is now found correctly regardless of what the interpolation contains.
 */
function copyStringLiteral(source: string, i: number): { text: string; end: number } {
  const quote = source[i];
  let text = quote;
  let j = i + 1;
  while (j < source.length && source[j] !== quote) {
    if (source[j] === "\\" && j + 1 < source.length) {
      text += source[j] + source[j + 1];
      j += 2;
      continue;
    }
    if (quote === "`" && source[j] === "$" && source[j + 1] === "{") {
      const start = j + 1; // the "{" itself
      const end = skipInterpolation(source, start);
      text += source.slice(j, end);
      j = end;
      continue;
    }
    text += source[j];
    j += 1;
  }
  if (j < source.length) { text += source[j]; j += 1; } // the closing quote
  return { text, end: j };
}

export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let previousToken = ""; // the start of a file is a value position, so a leading `/` would be a regex
  while (i < source.length) {
    const ch = source[i];
    const comment = endOfCommentAt(source, i);
    if (comment !== -1) { i = comment; continue; }
    if (ch === "/" && slashBeginsRegex(previousToken)) {
      const end = endOfRegexLiteral(source, i);
      // Copied through VERBATIM, exactly like a string literal: a quote, a backtick or a `//` inside a
      // regex is CONTENT, and reading any of them as a delimiter is what desynchronised 100 files (#2131).
      if (end > 0) { out += source.slice(i, end); i = end; previousToken = AN_OPERAND; continue; }
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      const literal = copyStringLiteral(source, i);
      out += literal.text;
      i = literal.end;
      previousToken = ch;
      continue;
    }
    const word = /[A-Za-z_$]/.test(ch) ? identifierAt(source, i) : "";
    if (word) { out += word; i += word.length; previousToken = propertyNameOrWord(previousToken, word); continue; }
    const postfix = postfixOperatorAt(source, i);
    if (postfix) { out += postfix; i += 2; previousToken = postfix; continue; }
    out += ch;
    i += 1;
    if (!/\s/.test(ch)) previousToken = ch;
  }
  return out;
}
