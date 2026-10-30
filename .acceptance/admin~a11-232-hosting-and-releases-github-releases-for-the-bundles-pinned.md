Refs A11-232

Step 1 of 3 of A11-232 (a11ign/announcement-emulator's release): `release-per-merge.yml` takes two optional inputs so a caller can carry files into its release. `release-files` names an artifact from earlier in the run: `version` and `tag` download it, and the lone package's Release is created with the artifact's `assets/` files in the one `gh release create`. `after-version` is a shell command the `version` job runs in the repository root, with `RELEASE_FILES` set, after `changeset version` and before the release commit, only when a releasable package moved; a non-zero exit makes no commit. Both default to empty, and a caller that sets neither releases as before.

Acceptance:

```bash
# the script: after-version's output is in the release commit, a failing one leaves no commit or tag, none is run when nothing releases, none given is the old release; the assets listing
pnpm exec rstest run scripts/release-per-merge.test.ts
# the workflow: both inputs default to empty, the downloads are conditional, only `version` reads after-version, the Release step attaches assets/ for the lone package only
pnpm exec rstest run scripts/release-workflow.test.ts
# the version job run as the runner runs it, with and without an artifact named, and with a failing command
pnpm exec rstest run scripts/release-parity.test.ts
pnpm run lint
pnpm exec tsc --noEmit
```
