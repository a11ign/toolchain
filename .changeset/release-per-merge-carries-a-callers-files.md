---
"@a11ign/toolchain": minor
---

`release-per-merge.yml` takes two optional inputs, `release-files` and `after-version`, so a caller can carry files into its release. `release-files` names an artifact the caller uploaded earlier in the same run: the `version` job downloads it, and the `tag` job downloads it and attaches its `assets/` files to the lone package's Release, in the one `gh release create` call, so the Release never exists without them. `after-version` is a shell command run in the `version` job, in the repository root, with `RELEASE_FILES` set to the downloaded artifact, after `changeset version` and before the release commit, only when a releasable package moved: what it writes is in the commit that is tagged and published, and a non-zero exit fails the job before any commit. Both default to empty, and a caller that sets neither releases exactly as before.
