---
"@a11ign/toolchain": minor
---

`dependabot-config` writes the directory of each local composite action (`.github/actions/<name>/action.yml`) into the repository's `github-actions` entry, beside `/`, as `directories:` of the one entry. Dependabot reads a local action's `uses:` only when its directory is named, so control's `actions/cache` pin inside its `ansible-collections` action, which the hand-written file covered, stays covered after A11-253 (a11ign/control#144). A repository with no local action gets the same file as before; the template changes only for one that has one, so a consumer's drift check goes red on this release only in control.
