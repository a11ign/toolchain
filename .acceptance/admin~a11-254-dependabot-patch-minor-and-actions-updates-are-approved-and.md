Refs A11-254

Review fix for the step 2 pull requests (a11ign/lab#159 and siblings): the generated `.github/workflows/dependabot-auto.yml` gets a `concurrency` block. The runs for one pull request share a group (`dependabot-auto-<event>-<pull request number>`) and a newer pull-request event cancels the older run; a `ci` completion is its own group, keyed by its run id, and is never cancelled, so a red `gate` is always commented. This repository's own workflow is regenerated.

Acceptance:

```bash
# the group is one per pull request for its events, another per ci completion, and only a pull-request event cancels
pnpm exec rstest run src/dependabot-auto.test.ts src/dependabot-config.test.ts scripts/dependabot-config.test.ts
# this repository's regenerated workflow is what --write and --check require
pnpm run build
node dist/dependabot-config.mjs --check
grep -q '^  group: dependabot-auto-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.workflow_run.id }}$' .github/workflows/dependabot-auto.yml
grep -q "^  cancel-in-progress: \${{ github.event_name == 'pull_request_target' }}$" .github/workflows/dependabot-auto.yml
# a workflow without the block is drift
keep="$(mktemp -d)"
cp .github/workflows/dependabot-auto.yml "$keep/"
sed -i '/^concurrency:$/,/^  cancel-in-progress:/d' .github/workflows/dependabot-auto.yml
if node dist/dependabot-config.mjs --check; then echo "a workflow without the concurrency block was not caught"; exit 1; fi
cp "$keep/dependabot-auto.yml" .github/workflows/dependabot-auto.yml
rm -r "${keep:?}"
node dist/dependabot-config.mjs --check
```
