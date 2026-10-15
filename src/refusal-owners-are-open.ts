/**
 * #5333: A RELEASE GATE'S REFUSAL NAMES AN OPEN OWNING ROW, AND THIS READER IS WHAT CHECKS IT.
 *
 * `gate:lab-held` said "whether a release may proceed without them is #5179". #5179 was closed on 2026-10-12 after fixing a DIFFERENT gate, so for six
 * hours the two failed releases had an owner on paper and no open row behind it, and nobody was looking. The class is "a refusal names an owner that
 * has stopped owning it"; `gate:isolation`, `scorer:migration` and every future held stage inherit it.
 *
 * WHAT IS READ. Every `REFUSED` string in `package.json` scripts, and in `.github/workflows/release.yml` every line carrying `REFUSED` or `::error`:
 * the text after the marker to the end of the string (or line) is the refusal. A bare `#<n>` in it is the owner the refusal sends a reader to.
 *
 * A QUALIFIED `owner/repo#<n>` IS AN OWNER IN THAT REPOSITORY: `a11ign/lab`'s `gate:core-held` names `a11ign/a11ign#5179`, and a reader that saw only
 * a bare `#n` would have passed the very string this row was filed for. A `path/to/file.md#12` reads the same way and comes back `CANNOT_TELL`:
 * a loud false red on a path fragment, which is the direction to be wrong in.
 *
 * A `(#<n>)` IS A CITATION, NOT AN OWNER. The refusal above also says "since ADR 0045 cut 9 (#5087)": the row that made the change, closed for good,
 * and a reader is not sent there. The parenthesised form is this repository's idiom for that and the only one exempted. The exemption has its
 * compensating control: a `REFUSED` string with NO bare owner is itself a finding, so rewording an owner into parentheses cannot make it pass.
 *
 * ONE VERDICT PER OWNER, and only `OPEN` passes. An issue that could not be read is `CANNOT_TELL`, never open (absence is not proof): the reader takes
 * the state through `readState`, so a test drives it on fixtures and the live read is `readIssueState`, which the caller runs with its own repository.
 *
 * PUBLISHED from `@a11ign/toolchain` (a11ign/agent-org#1415, decision (a) of #5361), so the core and `a11ign/lab` import it rather than keep copies.
 * A tool names no project (ADR 0045 rule 4): nothing here assumes a repository. The caller passes its own to `readIssueState`, and a bare `#n`
 * in a refusal means that repository.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RefusalKind = "REFUSED" | "::error";
export type Refusal = { file: string; where: string; kind: RefusalKind; text: string };
export type IssueState = "OPEN" | "CLOSED" | "CANNOT_TELL";
export type StateRead = { code: IssueState; why: string };
/** `repo` is `null` for a bare `#n`, which means the repository the reader is asked about. */
export type IssueRef = { repo: string | null; number: number };
export type Finding = {
  refusal: Refusal;
  /** `null` only for a `REFUSED` string that names no owner at all. */
  number: number | null;
  repo: string | null;
  code: IssueState | "NAMES_NO_OWNER";
  why: string;
};

const REFUSED = "REFUSED";
const ERROR_ANNOTATION = "::error";
const QUALIFIER = String.raw`(?:[\w-]+\/[\w.-]+)?`;
const CITATION = new RegExp(String.raw`\(\s*${QUALIFIER}#\d+(?:\s*[,;]\s*${QUALIFIER}#\d+)*\s*\)`, "g");
/** Not a `$#`, a `&#78;`, a `tag-#56` or the tail of a word: those are never an issue number. */
const ISSUE_REFERENCE = new RegExp(String.raw`(?<![\w$&/-])([\w-]+\/[\w.-]+)?#(\d+)\b`, "g");
const WORKFLOW_FILE = ".github/workflows/release.yml";
const PACKAGE_FILE = "package.json";

/** The `scripts` of a `package.json`, one refusal per script whose command holds `REFUSED`. */
export function refusalsInPackageJson(file: string, content: string): Refusal[] {
  const scripts = (JSON.parse(content) as { scripts?: Record<string, string> }).scripts ?? {};
  return Object.entries(scripts)
    .filter(([, command]) => command.includes(REFUSED))
    .map(([name, command]) => ({
      file, where: `script "${name}"`, kind: REFUSED, text: command.slice(command.indexOf(REFUSED) + REFUSED.length),
    }));
}

/** A workflow's `REFUSED` and `::error` lines. A YAML comment that says the word is prose about a refusal, not one. */
export function refusalsInWorkflow(file: string, content: string): Refusal[] {
  return content.split("\n").flatMap((line, index): Refusal[] => {
    if (line.trimStart().startsWith("#")) return [];
    const kind: RefusalKind | null = line.includes(REFUSED) ? REFUSED : line.includes(ERROR_ANNOTATION) ? ERROR_ANNOTATION : null;
    if (kind === null) return [];
    const marker = kind === REFUSED ? REFUSED : ERROR_ANNOTATION;
    return [{ file, where: `line ${index + 1}`, kind, text: line.slice(line.indexOf(marker) + marker.length) }];
  });
}

/** Every refusal of the tree rooted at `root`, from the two places the row names. */
export function refusalsInTree(root: string): Refusal[] {
  return [
    ...refusalsInPackageJson(PACKAGE_FILE, readFileSync(join(root, PACKAGE_FILE), "utf8")),
    ...refusalsInWorkflow(WORKFLOW_FILE, readFileSync(join(root, WORKFLOW_FILE), "utf8")),
  ];
}

/** The issues a refusal's text names as its owner: every `#<n>` or `owner/repo#<n>`, once, with `(#<n>)` citations removed first. */
export function ownersOf(text: string): IssueRef[] {
  const named = new Map<string, IssueRef>();
  for (const match of text.replace(CITATION, " ").matchAll(ISSUE_REFERENCE)) {
    const ref = { repo: match[1] ?? null, number: Number(match[2]) };
    named.set(`${ref.repo ?? ""}#${ref.number}`, ref);
  }
  return [...named.values()];
}

function findingsOf(refusal: Refusal, readState: (ref: IssueRef) => StateRead): Finding[] {
  const owners = ownersOf(refusal.text);
  if (owners.length === 0) {
    // A `::error` line is mostly not a pointer to anybody; a REFUSED string is the one a person acts on, and it must send them somewhere.
    if (refusal.kind === ERROR_ANNOTATION) return [];
    return [{ refusal, number: null, repo: null, code: "NAMES_NO_OWNER", why: "the refusal names no row as its owner (a `(#n)` citation is not one)" }];
  }
  return owners.map((ref) => ({ refusal, ...ref, ...readState(ref) }));
}

/** One finding per owner a refusal names, read through `readState`; a state is asked for once however many refusals name the issue. */
export function findings(refusals: Refusal[], readState: (ref: IssueRef) => StateRead): Finding[] {
  const memo = new Map<string, StateRead>();
  const cached = (ref: IssueRef): StateRead => {
    const key = `${ref.repo ?? ""}#${ref.number}`;
    if (!memo.has(key)) memo.set(key, readState(ref));
    return memo.get(key)!;
  };
  return refusals.flatMap((refusal) => findingsOf(refusal, cached));
}

/** What did not pass: everything but an `OPEN` owner, `CANNOT_TELL` and a refusal naming no owner included. */
export function failures(all: Finding[]): Finding[] {
  return all.filter((finding) => finding.code !== "OPEN");
}

/** One line, naming the file, the script or line, and the number: what the reader of a red job needs in order to act. */
export function describe(finding: Finding): string {
  const at = `${finding.refusal.file} ${finding.refusal.where}`;
  if (finding.number === null) return `${at}: ${finding.why}`;
  const issue = `${finding.repo ?? ""}#${finding.number}`;
  return `${at}: ${finding.refusal.kind} names ${issue} as its owner, and ${issue} is ${finding.code}${finding.code === "CANNOT_TELL" ? ` (${finding.why})` : ""}`;
}

/** `gh` with these arguments, as its stdout. Injectable so a test reads every answer GitHub can give without spawning anything. */
export type GhRunner = (args: string[]) => string;
const runGh: GhRunner = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * The live instrument: GitHub's own issue endpoint (the core pool, which `gh issue view` is not), as the asking token sees it.
 * `repo` is the repository a bare `#n` names, passed by the caller: this package has no default of its own.
 */
export function readIssueState(repo: string, run: GhRunner = runGh) {
  return (ref: IssueRef): StateRead => {
    const { number } = ref;
    const where = ref.repo ?? repo;
    try {
      const state = run(["api", `repos/${where}/issues/${number}`, "--jq", ".state"]).trim();
      if (state === "open") return { code: "OPEN", why: `${where}#${number} is open` };
      if (state === "closed") return { code: "CLOSED", why: `${where}#${number} is closed` };
      return { code: "CANNOT_TELL", why: `${where}#${number} answered state ${JSON.stringify(state)}, which is neither open nor closed` };
    } catch (cause) {
      return { code: "CANNOT_TELL", why: `${where}#${number} could not be read: ${String(cause).split("\n")[0]}` };
    }
  };
}
