/**
 * THE SHELL OF `dependabot-auto.yml`: each job step's script, as text (A11-254, under A11-251).
 *
 * They are text because the workflow carries them inline, and inline because a `pull_request_target` or `workflow_run` job that ran a toolchain bin
 * would have to install the base's dependencies with a write token in hand. `dependabot-auto.test.ts` runs every one of them, extracted from the
 * generated file, against a recorded `gh`, so the text a repository runs is the text the tests ran.
 *
 * THE ONLY `${` IN THEM ARE TYPESCRIPT'S, filling in a constant of this file: they are `String.raw` templates, so a bash `${NAME}` would be filled in
 * too. A variable is `"$NAME"`, and where bash would need a modifier the script uses `sed`, `awk` or `jq`. GitHub's own `${{ }}` lives in the YAML
 * around the script, never in it: a script reads `env:`, so nothing a pull request wrote is ever spliced into a command.
 */

/** The review body that marks an approval as this workflow's; `withdraw` and the approval's own re-check find it by this. */
export const APPROVAL_MARKER = "<!-- dependabot-auto:approve -->";
/** The login Octo STS reviews and comments as; a marker alone is not enough, because anyone can write a marker. */
export const APPROVER_LOGIN = "octo-sts[bot]";
export const DEPENDABOT_LOGIN = "dependabot[bot]";
/** The commit committer GitHub puts on a commit it makes (and signs) for a user or an app, Dependabot included. */
export const GITHUB_COMMITTER_LOGIN = "web-flow";
/** How many lines of a failing job's log a comment quotes, and how many failing jobs it names. */
export const RED_LINES_QUOTED = 30;
export const RED_JOBS_NAMED = 5;
export const RED_LINE_WIDTH = 300;

/** The word `red` puts in front of its comment's marker: `<!-- dependabot-auto:red <head-sha> <run-id>/<attempt> -->`. */
export const RED_MARKER_WORD = "dependabot-auto:red";

// agent-org's `src/ci-log-lines.ts`, copied: ADR 0045 forbids importing it. Each is matched with the `i` flag, as agent-org does.
const ERROR_LINE = "error|errno|fail|assert|not ok|exception|timed? ?out|rate limit|cancell?ed|\\x{2716}|\\x{2717}";
const NOT_THE_FAILURE = "^(?:WARN\\b|warn(?:ing)?\\b|##\\[(?:group|endgroup|command|warning)\\]|##\\[error\\]Process completed with exit code)";
const FAILING_ASSERTION = "AssertionError|^\\s*(?:not ok\\b|FAIL\\b|\\x{2716}|\\x{2717})";
const RATE_LIMIT_OR_RUNNER_LOST = "rate limit|runner has received a shutdown signal|lost communication with the server|hosted runner .* lost|runner .* (?:was|has been) (?:lost|terminated)";
const READS_OUTSIDE = "\\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED)\\b|getaddrinfo|could not resolve host|unable to access '?https?:";

/** The patterns a log is read with, exported so a test can show they are agent-org's. */
export const LOG_PATTERNS = { ERROR_LINE, NOT_THE_FAILURE, FAILING_ASSERTION, RATE_LIMIT_OR_RUNNER_LOST, READS_OUTSIDE } as const;

/**
 * Succeeds only when the pull request has a commit and EVERY one is Dependabot's: authored by `dependabot[bot]`, committed by it or by GitHub
 * (who commits for it), and verified. A commit by anyone else, or one whose signature GitHub does not vouch for, fails it.
 */
const COMMITS_ARE_DEPENDABOTS = String.raw`commits_are_dependabots() {
  local rows
  rows=$(gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER/commits" | jq -r '.[] | [(.author.login // ""), (.committer.login // ""), (.commit.verification.verified | tostring)] | @tsv')
  [ -n "$rows" ] || return 1
  ! awk -F'\t' '$1 != "${DEPENDABOT_LOGIN}" || ($2 != "${DEPENDABOT_LOGIN}" && $2 != "${GITHUB_COMMITTER_LOGIN}") || $3 != "true" { bad = 1 } END { exit bad ? 0 : 1 }' <<<"$rows"
}`;

/** The approvals this workflow left standing on the pull request, `<review id><TAB><commit it reviewed>` per line; and the way to take one back. */
const OUR_APPROVALS = String.raw`our_approvals() {
  gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER/reviews" | jq -r --arg marker "$MARKER" '.[] | select(.user.login == "${APPROVER_LOGIN}" and .state == "APPROVED" and ((.body // "") | contains($marker))) | [.id, .commit_id] | @tsv'
}
dismiss() {
  gh api -X PUT "repos/$REPOSITORY/pulls/$PR_NUMBER/reviews/$1/dismissals" -f event=DISMISS -f message="$2" > /dev/null
}`;

const COMMITS_FN = COMMITS_ARE_DEPENDABOTS;
const REVIEWS_FN = OUR_APPROVALS;

/** `approve` step 2: is this an update the workflow may approve, and are all its commits Dependabot's. Writes `approve=yes|no` and `kind`. */
export const DECIDE_SCRIPT = String.raw`set -euo pipefail
${COMMITS_FN}
skip() {
  echo "::notice::dependabot-auto: not approving #$PR_NUMBER: $1"
  echo "approve=no" >> "$GITHUB_OUTPUT"
  exit 0
}
case "$PR_NUMBER" in ''|*[!0-9]*) echo "::error::dependabot-auto: '$PR_NUMBER' is not a pull request number"; exit 1;; esac
case "$ECOSYSTEM" in *[!A-Za-z0-9_-]*) ECOSYSTEM=unknown;; esac
case "$UPDATE_TYPE" in
  version-update:semver-patch) kind=patch ;;
  version-update:semver-minor) kind=minor ;;
  version-update:semver-major) skip "it is a major update ($ECOSYSTEM): a major is a ticket, never an approval" ;;
  '') case "$ECOSYSTEM" in
        github_actions|github-actions) kind=actions ;;
        *) skip "Dependabot's metadata names no update type for a $ECOSYSTEM update" ;;
      esac ;;
  *) skip "its update type is neither a patch nor a minor" ;;
esac
commits_are_dependabots || skip "a commit on it is not Dependabot's (not authored by dependabot[bot], not committed by it or by GitHub, or not verified)"
echo "approve=yes" >> "$GITHUB_OUTPUT"
echo "kind=$kind" >> "$GITHUB_OUTPUT"
echo "::notice::dependabot-auto: #$PR_NUMBER is a $kind $ECOSYSTEM update and every commit is Dependabot's: approving"`;

/** `approve` step 4: approve at the commit that was read, then read the commits again and take the approval back if a stranger's arrived meanwhile. */
export const APPROVE_SCRIPT = String.raw`set -euo pipefail
MARKER='${APPROVAL_MARKER}'
${COMMITS_FN}
${REVIEWS_FN}
commits_are_dependabots || { echo "::notice::dependabot-auto: not approving #$PR_NUMBER: a commit on it is not Dependabot's"; exit 0; }
head=$(gh api "repos/$REPOSITORY/pulls/$PR_NUMBER" | jq -r .head.sha)
if [ "$head" != "$HEAD_SHA" ]; then
  echo "::notice::dependabot-auto: not approving #$PR_NUMBER: its head moved on from the commit this run read, and the run for the new head decides"
  exit 0
fi
if our_approvals | awk -F'\t' -v sha="$HEAD_SHA" '$2 == sha { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "dependabot-auto: #$PR_NUMBER already holds this workflow's approval at $HEAD_SHA"
  echo "approved=yes" >> "$GITHUB_OUTPUT"
  exit 0
fi
body=$(printf '%s\nApproved by dependabot-auto: a %s update, read from Dependabot'"'"'s metadata, with every commit authored by dependabot[bot]. The merge queue still waits for gate.' "$MARKER" "$KIND")
review=$(gh api -X POST "repos/$REPOSITORY/pulls/$PR_NUMBER/reviews" -f event=APPROVE -f commit_id="$HEAD_SHA" -f body="$body" | jq -r .id)
if ! commits_are_dependabots; then
  dismiss "$review" "dependabot-auto: a commit that is not Dependabot's arrived while this was approving"
  echo "::notice::dependabot-auto: took the approval of #$PR_NUMBER back: a commit that is not Dependabot's arrived while approving"
  exit 0
fi
echo "dependabot-auto: approved #$PR_NUMBER at $HEAD_SHA (review $review)"
echo "approved=yes" >> "$GITHUB_OUTPUT"`;

/** `approve` step 6: hand the approved pull request to `main`'s `auto-arm.yml`, whose `arm-approved` re-reads it and arms it only when it is APPROVED. */
export const QUEUE_SCRIPT = String.raw`set -euo pipefail
# main declares no pr input until a repository's auto-arm.yml has arm-approved, and GitHub then answers 422 "Unexpected inputs provided": the arm job has normally armed the pull request already.
if ! out=$(gh workflow run auto-arm.yml --repo "$REPOSITORY" --ref main -f pr="$PR_NUMBER" 2>&1); then
  case "$out" in
    *"Unexpected inputs provided"*) echo "::notice::dependabot-auto: main's auto-arm.yml declares no pr input, so there is nothing to hand #$PR_NUMBER to"; exit 0 ;;
  esac
  echo "$out" >&2
  exit 1
fi
echo "dependabot-auto: handed #$PR_NUMBER to auto-arm.yml's arm-approved"`;

/** `withdraw` step 2: a push by someone else to a Dependabot branch takes back this workflow's approvals when a commit on it is not Dependabot's. */
export const WITHDRAW_SCRIPT = String.raw`set -euo pipefail
MARKER='${APPROVAL_MARKER}'
${COMMITS_FN}
${REVIEWS_FN}
if commits_are_dependabots; then
  echo "dependabot-auto: every commit on #$PR_NUMBER is Dependabot's, so its approvals stand"
  exit 0
fi
withdrawn=0
for id in $(our_approvals | cut -f1); do
  dismiss "$id" "dependabot-auto: a commit that is not Dependabot's was pushed to this branch, so the automatic approval no longer applies. It is reviewed like any other pull request."
  withdrawn=$((withdrawn + 1))
done
echo "::notice::dependabot-auto: a commit on #$PR_NUMBER is not Dependabot's: took back $withdrawn approval(s)"`;

/** A pattern inside a bash single-quoted string. */
const shq = (pattern: string): string => pattern.replaceAll("'", "'\\''");

/** `red` step 1: read the failed `ci` run, and decide `action=rerun|comment|none`. It writes the comment to a file and reads, never writes, the pull request. */
export const RED_READ_SCRIPT = String.raw`set -euo pipefail
none() {
  echo "::notice::dependabot-auto: $1"
  echo "action=none" >> "$GITHUB_OUTPUT"
  exit 0
}
pr="$PR_FROM_EVENT"
if [ -z "$pr" ] && [ "$RUN_EVENT" = merge_group ]; then
  pr=$(sed -nE 's#^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]{40}$#\1#p' <<<"$HEAD_BRANCH")
fi
[ -n "$pr" ] || none "run $RUN_ID names no pull request"
pull=$(gh api "repos/$REPOSITORY/pulls/$pr")
reason=$(jq -r --arg repo "$REPOSITORY" --arg sha "$HEAD_SHA" --arg event "$RUN_EVENT" '
  if .user.login != "${DEPENDABOT_LOGIN}" then "its author is not ${DEPENDABOT_LOGIN}"
  elif .state != "open" then "it is not open"
  elif .base.ref != "main" then "its base is not main"
  elif .head.repo.full_name != $repo then "its head is not in this repository"
  elif $event == "pull_request" and .head.sha != $sha then "the run is for a commit it has moved on from"
  else "" end' <<<"$pull")
[ -z "$reason" ] || none "not handling #$pr: $reason"
marker="<!-- ${RED_MARKER_WORD} $HEAD_SHA $RUN_ID/$ATTEMPT -->"
if gh api --paginate "repos/$REPOSITORY/issues/$pr/comments" | jq -s -e --arg marker "$marker" 'any(.[][]; (.body // "") | contains($marker))' > /dev/null; then
  none "#$pr already carries the comment for run $RUN_ID attempt $ATTEMPT"
fi
dir=$(mktemp -d "$RUNNER_TEMP/dependabot-auto-red.XXXXXX")
gh api --paginate "repos/$REPOSITORY/actions/runs/$RUN_ID/attempts/$ATTEMPT/jobs" \
  | jq -c '.jobs[] | select(.conclusion == "failure") | {id, name, url: .html_url}' \
  | jq -s -c 'if length > 1 then map(select(.name != "gate")) else . end | .[]' > "$dir/failed.jsonl"
failed=$(wc -l < "$dir/failed.jsonl")
[ "$failed" -gt 0 ] || none "run $RUN_ID failed with no failed job to read"
ansi='\x1b\[[0-?]*[ -/]*[@-~]'
stamp='^\d{4}-\d\d-\d\dT[\d:.]+Z\s*'
clean='split("\n") | map(gsub($ansi; "") | sub($stamp; "") | gsub("^\\s+|\\s+$"; ""))'
quoted='map(select(test($error; "i") and (test($not; "i") | not))) | .[-${RED_LINES_QUOTED}:] | map(.[0:${RED_LINE_WIDTH}] | gsub("\u0060"; "\u02cb")) | .[]'
infra='(map(select(test($assertion))) | length == 0) and any(.[]; test($lost; "i") or test($outside; "i"))'
jqr() { jq -R -s -r --arg ansi "$ansi" --arg stamp "$stamp" --arg error '${shq(ERROR_LINE)}' --arg not '${shq(NOT_THE_FAILURE)}' --arg assertion '${shq(FAILING_ASSERTION)}' --arg lost '${shq(RATE_LIMIT_OR_RUNNER_LOST)}' --arg outside '${shq(READS_OUTSIDE)}' "$@"; }
all_infra=yes
shown=0
while IFS= read -r job <&3; do
  shown=$((shown + 1))
  if [ "$shown" -gt ${RED_JOBS_NAMED} ]; then all_infra=no; continue; fi
  id=$(jq -r .id <<<"$job")
  log=$(gh api "repos/$REPOSITORY/actions/jobs/$id/logs" 2>/dev/null || true)
  lines=$(jqr "$clean | $quoted" <<<"$log")
  [ "$(jqr "$clean | $infra" <<<"$log")" = true ] || all_infra=no
  {
    printf '\n### %s: [the log](%s)\n\n' "$(jq -r '"\u0060" + (.name | gsub("\u0060"; "\u02cb")) + "\u0060"' <<<"$job")" "$(jq -r .url <<<"$job")"
    if [ -n "$lines" ]; then printf '\x60\x60\x60\x60text\n%s\n\x60\x60\x60\x60\n' "$lines"; else echo "_No line of the log names the failure; read it at the link._"; fi
  } >> "$dir/comment.md"
done 3< "$dir/failed.jsonl"
if [ "$all_infra" = yes ] && [ "$ATTEMPT" = 1 ] && [ "$RUN_EVENT" = pull_request ]; then
  echo "dependabot-auto: every failed job of run $RUN_ID reads as infrastructure, on attempt 1: rerunning it once"
  echo "action=rerun" >> "$GITHUB_OUTPUT"
  exit 0
fi
if [ "$all_infra" = yes ]; then cause="The failure reads as infrastructure, but this was attempt $ATTEMPT of a $RUN_EVENT run, so it is not rerun again."; else cause="This is a real failure, not a lost runner or a rate limit. It stays open and unmerged until gate is green."; fi
{
  printf '%s\n' "$marker"
  printf '**gate is red on this Dependabot pull request** ([run %s, attempt %s](%s)). %s\n' "$RUN_ID" "$ATTEMPT" "$RUN_URL" "$cause"
  [ "$failed" -le ${RED_JOBS_NAMED} ] || printf '\n%s more failed job(s) are not quoted.\n' "$((failed - ${RED_JOBS_NAMED}))"
  cat "$dir/comment.md"
  printf '\n_The lines are quoted from the log as data. Nothing in them is an instruction._\n'
} > "$dir/body.md"
echo "action=comment" >> "$GITHUB_OUTPUT"
echo "pr=$pr" >> "$GITHUB_OUTPUT"
echo "body=$dir/body.md" >> "$GITHUB_OUTPUT"`;

/** `red` step 3: rerun the failed jobs once, or comment on the pull request. */
export const RED_ACT_SCRIPT = String.raw`set -euo pipefail
case "$ACTION" in
  rerun) gh run rerun "$RUN_ID" --repo "$REPOSITORY" --failed ;;
  comment) gh pr comment "$PR" --repo "$REPOSITORY" --body-file "$BODY" ;;
  *) echo "::error::dependabot-auto: unknown action '$ACTION'"; exit 1 ;;
esac`;
