---
"@a11ign/toolchain": minor
---

`boundary-check` is a second bin and a `./boundary-check` export beside `layout-check`: it LISTS every cross-repository reach in a repository (`cross-repo-import`, `tool-path`, `laid-source`), with the file, the line and the reached path, and never fails a build for one (exit 0; 2 only when the tree or the `--baseline` file is unreadable or the tree is empty). `--baseline` marks a listed crossing accepted and a line matching nothing stale; `--out` also writes the JSON report. Epic a11ign/a11ign#4425, phase 2.
