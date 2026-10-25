Refs A11-254

Step 1 of 2 (toolchain): `dependabot-config` also writes and checks `.github/workflows/dependabot-auto.yml`, the workflow that approves a Dependabot patch, minor or non-major GitHub Actions update as the Octo STS App (only when every commit on the pull request is Dependabot's), hands it to `auto-arm.yml`'s `arm-approved`, and so lets it merge when `gate` is green. A major is never approved. A push by anyone else to the branch dismisses the workflow's own approvals. A red `gate` on a Dependabot pull request is rerun once when it reads as infrastructure and otherwise commented with the failing jobs' error lines. `--check` also reads the two hand-written Octo STS policies, fails unless the approving one is pinned to dependabot[bot]'s id and `main`'s copy of the workflow with `pull_requests: write` alone, and fails when any other workflow submits an approving review. This repository's own workflow and policies are in the tree; step 2 adopts them in the eight other repositories with a ruleset.

Acceptance:

```bash
# the workflow's jobs run against a recorded gh: patch, minor and Actions approved and queued; major, another author, another commit author, a fork not approved; a push by someone else withdraws; a red gate is commented once, an infrastructure failure rerun once; the policies and the other-approver scan
pnpm exec rstest run src/dependabot-auto.test.ts src/dependabot-config.test.ts scripts/dependabot-config.test.ts
# this repository's own workflow and policies are what --write and --check require (exit 0), and a hand edit of the workflow, or of the approving policy's actor pin, is refused (exit 1)
pnpm run build
node dist/dependabot-config.mjs --check
keep="$(mktemp -d)"
cp .github/workflows/dependabot-auto.yml .github/chainguard/dependabot-approve.sts.yaml "$keep/"
sed -i 's/types: \[opened, reopened, synchronize\]/types: [opened, reopened, synchronize, labeled]/' .github/workflows/dependabot-auto.yml
if node dist/dependabot-config.mjs --check; then echo "workflow drift not caught"; exit 1; fi
cp "$keep/dependabot-auto.yml" .github/workflows/dependabot-auto.yml
sed -i '/actor_id:/d' .github/chainguard/dependabot-approve.sts.yaml
if node dist/dependabot-config.mjs --check; then echo "an unpinned approving policy was not caught"; exit 1; fi
cp "$keep/dependabot-approve.sts.yaml" .github/chainguard/dependabot-approve.sts.yaml
rm -r "${keep:?}"
node dist/dependabot-config.mjs --check
# the approving identity is pinned to dependabot[bot], main's copy of dependabot-auto.yml and one write
grep -q '^  actor_id: "49699333"$' .github/chainguard/dependabot-approve.sts.yaml
grep -q '^  pull_requests: write$' .github/chainguard/dependabot-approve.sts.yaml
! grep -q 'contents:' .github/chainguard/dependabot-approve.sts.yaml
# no workflow but dependabot-auto.yml submits an approval
! grep -lE -- '--approve|\bAPPROVE\b' .github/workflows/*.yml | grep -v dependabot-auto.yml
# nothing outside the plan's paths and the helper module the scripts needed
git diff --name-only origin/main...HEAD | awk '$0 !~ /^(\.acceptance\/|\.changeset\/|README\.md$|\.github\/workflows\/dependabot-auto\.yml$|\.github\/chainguard\/dependabot-(approve|guard)\.sts\.yaml$|src\/dependabot-|scripts\/dependabot-config\.test\.ts$)/ { bad = 1; print } END { exit bad }'
# the live proof is step 2's (a real Dependabot patch pull request merging with no person); this reads it once it exists
# gh pr view <N> --repo a11ign/<repo> --json reviews,reviewDecision,autoMergeRequest,mergedBy,state
```
