#!/usr/bin/env node
// @ts-check
// THE LOCAL-IMPORT CLOSURE WALK, SHARED -- #621. Lifted out of `packaging/gh-token-jobs.test.ts`'s own
// `localImports`, whose header already states why this exists: "the obvious test would have found
// nothing," because reaching `gh` -- or, per #621, `runs/`, or a shallow-checkout check -- is TRANSITIVE
// through local imports rather than a string the entry file names directly.
//
// `pre-install-import-graph.test.ts` walks a DIFFERENT closure for a DIFFERENT question and deliberately
// keeps its own walk rather than sharing this one: it also needs bare PACKAGE specifiers (to refuse
// them), which a local-only closure has no concept of, and its own header already argues at length for
// deriving rather than listing an entry population -- a second, independently-drifting copy of THAT
// walk would be the identical mistake this file exists to stop one layer up. Two walks of the *identical*
// shape (find local imports, one hop) is this repo's most-recorded drift; two walks of genuinely
// different shape is not the same defect and is not merged here.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `text` with every `//` line comment and every slash-star block comment blanked to whitespace of the
 * IDENTICAL length -- never removed, so a caller computing a line/column against the result still
 * describes the real file. Naive (a `//` inside a string literal is blanked too, the same tradeoff this
 * repo's own indentation-based YAML slicing already accepts elsewhere) but load-bearing: THIS MODULE'S OWN
 * DOCSTRING once demonstrated `import { collect } from "../../agent-org/src/board-data.mjs"` as a worked example, and
 * without this, `localImports` read its own JSDoc as a real import -- a self-reference one level deeper
 * than the mention-versus-use trap `acceptance-commands.mjs`'s own header already names: not "a comment
 * MENTIONING an operation," but "a comment CONTAINING syntactically valid code that performs one."
 *
 * NOT `@a11ign/evidence/source-text`'s own `stripComments`, deliberately -- checked, not assumed. That one
 * is a real tokenizer (it correctly skips `//` inside a string literal, which this one does not) but it
 * REMOVES a block comment's interior newlines rather than blanking them, so its output is SHORTER than its
 * input whenever one spans multiple lines -- exactly the property `closureRequirementMessage` needs never
 * to hold, since `lineNumberOf` reads an offset into the STRIPPED text as a line number in the REAL file.
 * Different downstream questions ("does a quoted path string exist anywhere", `select-changed-tests.mjs`'s
 * use, vs. "which real line performed this operation") tolerate different tradeoffs; sharing the wrong one
 * would trade a visible self-reference bug for an invisible off-by-several-lines one.
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text: string): string {
  // ONE ALTERNATION, NOT TWO PASSES -- #1019. Whichever comment form starts FIRST in the text wins, which
  // is what a tokenizer would do, and no pass can see inside what another already consumed.
  //
  // With the block pass first, a `//` comment CONTAINING `/*` -- a glob in prose, `--branches='agent/*'`,
  // `@a11ign/*` -- opened a block-comment match that closed at the next `*/` ANYWHERE LATER IN THE FILE,
  // blanking every line between, real code included. Measured across the tree the night this was found:
  // 10 of 89 `scripts/*.mjs` with relative imports derived NONE, `packages/agent-org/src/row-claim.mjs` among them --
  // twelve real imports, zero visible -- and with them `select-changed-tests.mjs` and `ci-changed.ts`,
  // which decide what CI runs.
  //
  // IT NEEDED BOTH HALVES, which is why it survived a test written for exactly this class (#725): the
  // `//`-embedded `/*` AND a later block comment to close against. #725's fixture had the opener and no
  // closer, so the regex never matched and the case passed.
  //
  // SEQUENTIAL PASSES FAIL IN BOTH DIRECTIONS, and swapping the order only moves which one. The mirror,
  // found by worker-judge reviewing this: a BLOCK comment containing `//` whose closer is on the SAME LINE
  // -- `/${"*"} see http://example.com ${"*"}/` above an import -- has its closer eaten by a line-first
  // pass, leaving the opener to match forward to the next closer anywhere later. Same under-charging
  // direction, same silence, and a URL in a one-line block comment is the most ordinary comment there is.
  //
  // The alternation closes both. Measured across all 871 tracked files: it agrees with the line-first
  // version on every one, 0 differing, and preserves the offset property identically -- same length, same
  // line count -- which is the property `closureRequirementMessage` needs and the reason this module does
  // not use `@a11ign/evidence/source-text`'s tokenizer. `pre-install-import-graph.test.ts:82-89` already
  // names this file and ships this exact line as the fix.
  //
  // BLANKED PER RUN OF NON-NEWLINES, NOT PER CHARACTER (#2546). `m.replace(/[^\n]/g, " ")` called the engine once for every
  // character of every comment; the whole-suite closure walk strips the same ~700 files' comments once per entry, and
  // this was 80s of its 156s. `/[^\n]+/` blanks the same characters and keeps every newline, so the output is
  // byte-identical (measured over 3,000 sampled sources, 3,000 equal) at a sixth of the cost.
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]+/g, (run) => " ".repeat(run.length)));
}

/**
 * Every local (relative) import/dynamic-import a module names, resolved to absolute file paths that
 * exist on disk. Bare specifiers (package imports) are out of scope -- they are not part of a repo-local
 * closure walk, and `.mjs`/`.ts`/`.js`/`index.ts` are tried in that order for an extensionless specifier.
 * Comments are stripped before scanning -- see `stripComments`'s own header for why that is load-bearing
 * here, not merely tidy.
 * @param {string} file
 * @returns {string[]}
 */
export function localImports(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const out = /** @type {string[]} */ ([]);
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const raw = resolve(dirname(file), m[1]);
    for (const cand of [raw, `${raw}.ts`, `${raw}.mjs`, `${raw}.js`, join(raw, "index.ts")]) {
      if (existsSync(cand) && !cand.endsWith("/")) { out.push(cand); break; }
    }
  }
  return out;
}

/**
 * The bound name(s) an import CLAUSE (the text between `import` and `from`) introduces -- pulled out of
 * `importedNamesFor` to keep that function's own nesting shallow.
 * @param {string} clause
 * @returns {string[]}
 */
function namesFromClause(clause: string): string[] {
  const names = /** @type {string[]} */ ([]);
  const braceMatch = /\{([^}]*)\}/.exec(clause);
  for (const part of (braceMatch ? braceMatch[1].split(",") : [])) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const asMatch = /\bas\s+(\S+)/.exec(trimmed);
    names.push(asMatch ? asMatch[1] : trimmed.split(/\s+/)[0]);
  }
  const beforeBrace = clause.split("{")[0].replace(/,\s*$/, "").trim();
  if (beforeBrace) {
    const nsMatch = /^\*\s+as\s+(\S+)/.exec(beforeBrace);
    names.push(nsMatch ? nsMatch[1] : beforeBrace);
  }
  return names;
}

/**
 * The LOCAL NAMES `file` binds to an import whose specifier resolves to `target` -- `["collect"]` for
 * `import { collect } from "../../agent-org/src/board-data.mjs"`, `[]` for a side-effect `import "./x.mjs"` (nothing is
 * bound, so nothing can be named). Handles named (`{ a, b as c }`), default and namespace (`* as ns`)
 * clauses; a mixed `import Default, { a } from "..."` yields both. Used only for a human-facing message --
 * #621's own stated point is naming the HOP a reader would grep for, not just a file path they would have
 * to open blind to find it.
 * @param {string} file
 * @param {string} target absolute path, as returned by `localImports`
 * @returns {string[]}
 */
export function importedNamesFor(file: string, target: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const names = /** @type {string[]} */ ([]);
  // `[^;]*?` -- NEVER `[\s\S]*?` -- for the clause: a bare-specifier statement earlier in the file
  // (`import { test } from "node:test";`) fails the later `.startsWith(".")` check below, and an
  // unbounded `[\s\S]*?` clause then backtracks PAST that statement's own `;` looking for a `from` that
  // satisfies the whole match, silently absorbing every import between the two into one clause -- which
  // is how this returned `"test"` instead of `"collect"` on `board-style.test.ts`'s first real run. Each
  // import statement here ends in `;`, so bounding the clause to it keeps one match to one statement.
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!m[2].startsWith(".")) continue;
    const raw = resolve(dirname(file), m[2]);
    const resolved = [raw, `${raw}.ts`, `${raw}.mjs`, `${raw}.js`, join(raw, "index.ts")]
      .find((cand) => existsSync(cand) && !cand.endsWith("/"));
    if (resolved !== target) continue;
    names.push(...namesFromClause(m[1]));
  }
  return names;
}
