---
"@a11ign/toolchain": minor
---

The generated `.github/workflows/dependabot-auto.yml` has a `concurrency` block (A11-254): the runs for one pull request share a group, and a newer pull-request event cancels the older run, so a rebase or a burst of pushes leaves one run and a person's push cancels an `approve` still running for the push before it. A `ci` completion is its own group, keyed by its run id, and is never cancelled, so a red `gate` is always commented. The template changed, so a consumer's `dependabot-config --check` goes red on this release until `dependabot-config --write` is run there.
