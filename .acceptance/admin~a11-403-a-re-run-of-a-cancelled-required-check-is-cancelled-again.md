Refs A11-403

Step 2 of 3 of A11-403: `changeset-required.yml` reads the pull request's LIVE body through the API (`gh api repos/$REPOSITORY/pulls/$NUMBER --jq '.body // ""'`) instead of `github.event.pull_request.body`. A rerun replays the event payload, so the payload's body is stale on a rerun: a `no-release:` line added since would not count. An API failure fails the step and is never read as an empty body or a pass; a null body is an empty one. Step 3 (agent-org) takes `edited` out of its `ci.yml` and needs this commit for its pin.

Acceptance:

```bash
# the workflow's script step, run as the runner runs it (bash -eo pipefail, a stand-in gh): the live body decides, a null body is empty, a failed read fails the step
pnpm exec rstest run scripts/changeset-required.test.ts
pnpm run lint
pnpm exec tsc --noEmit
```
