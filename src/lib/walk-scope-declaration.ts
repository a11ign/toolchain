// @ts-check
// A GUARD'S WALK_SCOPE DECLARATION, READ STATICALLY -- #929.
//
// Split out of `walk-scope.ts` so that reading a declaration does not install the observer. The selector
// parses every always-run guard, and it used to import `walk-scope.ts` to do it -- which wrapped `fs`,
// `child_process`, `process` and `node:test` in the CI selector's own process, for nothing. A declaring guard
// still imports `walk-scope.ts`, which re-exports these.
//
// THE STRING-AWARE `stripComments`, which `select-changed-tests.mjs` already uses. `local-import-closure.ts`
// has its own, a regex that does not know about strings -- so a `//` inside one (any URL) blanks the rest of
// its line. The first version imported that one, and a guard whose first import named a `file://` URL read as
// declaring nothing. Two copies of one function; this uses the right one.
import { stripComments } from "./source-text.ts";

// Read statically, because the selector must not import a test file to learn its scope.
const DECLARATION = /^export\s+const\s+WALK_SCOPE(?:\s*:\s*[^=\n]+)?\s*=\s*\[([^\]]*)\]\s*(?:as\s+const\s*)?;/m;
// AN ATTEMPT at a declaration: the name BOUND by `const`/`let`/`var`. A bare mention -- in a regex literal, a
// property access, an assertion message -- is not one, and must not be refused: the selector parses every
// always-run guard, so a refusal there breaks selection for every pull request. The first version refused
// any mention in code and threw on the very test that pins this parser, whose assertions quote the name
// inside regex literals.
const ATTEMPT = /\b(?:const|let|var)\s+WALK_SCOPE\b/;
const QUOTED = /^(["'])([^"']+)\1$/;

/**
 * The scope a test file declares, or `null` when it declares none.
 *
 * `null` and `[]` are different answers and must stay different: `null` is "this guard has not said", which
 * keeps today's always-run behaviour; `[]` is "this guard reads nothing outside its own imports", which its
 * own run then has to prove.
 *
 * A file that BINDS `WALK_SCOPE` without declaring it in the one parseable form is REFUSED rather than read
 * as undeclared. Guessing there is the silent-loss direction: a malformed declaration read as none
 * keeps the guard running, but one read as `[]` would stop it.
 *
 * @param {string} source
 * @returns {string[] | null}
 */
export function parseWalkScope(source: string): string[] | null {
  const code = stripComments(source);
  // NAMED IN CODE, not in a string. A test that talks about `WALK_SCOPE` in an assertion message or builds a
  // fixture containing the word has not declared anything -- and refusing it would crash the selector on
  // every pull request, since the selector parses every always-run guard.
  if (!ATTEMPT.test(blankLiterals(code, { templatesOnly: false }))) return null;
  // And never matched inside a template literal, where a fixture's text can start a line with exactly the
  // declaration's shape. Quoted strings are kept: the declaration's own entries are quoted strings.
  const match = DECLARATION.exec(blankLiterals(code, { templatesOnly: true }));
  if (!match) {
    throw new Error("walk-scope: `WALK_SCOPE` is named but not declared as `export const WALK_SCOPE = "
      + "[\"<path>\", ...];` -- refusing to guess, because a scope read wrongly is a guard that silently "
      + "stops running.");
  }
  const items = match[1].split(",").map((item) => item.trim()).filter(Boolean);
  return items.map((item) => {
    const quoted = QUOTED.exec(item);
    if (!quoted) throw new Error(`walk-scope: WALK_SCOPE entry ${item} is not a string literal`);
    return quoted[2].replace(/\/+$/, "");
  });
}

/**
 * The source with the CONTENTS of its string literals blanked (quotes kept, so positions and shape survive).
 * A small scanner rather than a regex: an escaped quote, or a quote character inside a different kind of
 * literal, is exactly where a regex silently ends a string early.
 *
 * @param {string} code comment-free source
 * @param {{ templatesOnly: boolean }} options blank only backtick templates, leaving quoted strings intact
 */
function blankLiterals(code: string, { templatesOnly }: { templatesOnly: boolean; }) {
  let out = "";
  /** @type {string | null} */
  let open: string | null = null;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (open === null) {
      if (ch === "`" || (!templatesOnly && (ch === "\"" || ch === "'"))) open = ch;
      out += ch;
      continue;
    }
    if (ch === "\\") { out += "  "; i += 1; continue; }
    if (ch === open) { open = null; out += ch; continue; }
    out += ch === "\n" ? "\n" : " ";
  }
  return out;
}

/**
 * Is this repo-relative path inside the declared scope? A scope entry covers itself and everything under it.
 *
 * @param {string} path
 * @param {readonly string[]} scope
 */
export function inScope(path: string, scope: readonly string[]) {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`));
}
