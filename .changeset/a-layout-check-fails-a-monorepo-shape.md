---
"@a11ign/toolchain": patch
---

New export `@a11ign/toolchain/layout-check` and bin `layout-check`: a repository's CI runs `npx --yes --package @a11ign/toolchain layout-check` and it fails, naming which check and the path, on a workspace of one package (`workspace-of-one`), a package directory not named for its package (`directory-name`), a second README for one package (`second-readme`), and a leftover `lerna.json` or private `*-workspace` root (`leftover`). A flat single-package repository and a repository publishing two packages each in a directory named for it both pass; an empty tree exits `2`, never `0`.
