#!/usr/bin/env node
// @ts-check
// THE SYMBOLS A TEST DECLARES ABSENT, IN ONE PLACE -- #1038.
//
// A test that asserts a fixture symbol is "guaranteed absent" used to ask `origin/main`, which AT REVIEW
// TIME IS THE BASE and structurally cannot contain the file under review. So the claim was checked against
// the one tree that could not yet disagree with it, and first became false at the merge: main went red at
// 03:52Z on 2026-09-12, on #1023's own merge commit, for ~23 minutes. The search function was correct both
// times. The fixture named itself.
//
// **"GUARANTEED ABSENT" IS A CLAIM ABOUT THE REPOSITORY, NOT ABOUT THE STRING** -- and a claim about the
// repository has to be checked against the repository as it WILL be. The cheapest stand-in is the working
// tree, which does contain the file under review and would have failed on the branch rather than after it.
//
// WHY THE REGISTRY IS DATA IN A PLAIN MODULE, and not a `register()` call inside each test: a guard that
// had to import the declaring TEST FILES to see their symbols would run those suites to read a list. One
// module, imported by the declarers and by the guard, costs nothing and gives the guard a POPULATION
// rather than a regex guess at one.

/**
 * Assembles a fixture symbol from parts so the whole literal never appears contiguously in any tracked
 * file -- including this one.
 *
 * This is the necessary half and not the sufficient one, which #1037 measured the hard way: concatenation
 * stops the literal being in the tree FROM NOW ON, but the assembled string is the same string, so a name
 * already present in the base still matches after reassembly. A symbol that has ever leaked whole must be
 * RENAMED as well as split.
 * @param {...string} parts
 * @returns {string}
 */
export function fixtureSymbol(...parts: string[]): string {
  return parts.join("");
}

/**
 * Every symbol a test asserts is absent from some tree, keyed by where the claim is made.
 *
 * The key is prose for a human reading a failure; the value is the claim. A new absence assertion adds an
 * entry here and reads it back, which is what gives `fixture-absence-guard.test.ts` something to examine
 * -- and what makes "zero violations" distinguishable from "zero declarations".
 * @type {Readonly<Record<string, string>>}
 */
export const ABSENT_FIXTURE_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  "row-reachability.test.ts #719: the carrier fixture's symbol":
    fixtureSymbol("RowReachabilityFixtureSy", "mbol719"),
  "row-reachability.test.ts #772 CONTROL: the symbol no tree holds":
    fixtureSymbol("no-tree-here-holds", "-this-symbol-zzz"),
  "row-reachability.test.ts #1566: the subject-half carrier's symbol":
    fixtureSymbol("rowReachabilitySeam", "Carrier1566"),
});
