---
"@a11ign/toolchain": minor
---

`walk-scope` takes the project's root from `A11IGN_PROJECT_ROOT` when it is set, so a repository can import `@a11ign/toolchain/lib/walk-scope` instead of keeping a declared copy of it. Without it `REPO_ROOT` is the directory two levels above the module, which installed as a dependency is the toolchain's own copy under the consumer's `node_modules`: a guard's `WALK_SCOPE` was then relative to the wrong tree and reads of the project were not observed. The value must be an absolute path to an existing directory (it is resolved to its real path, as the package-relative root is); a value that is not -- missing, a file, relative, or empty -- throws at import and names the value, rather than falling back to the toolchain's own tree. Unset, nothing changes (a11ign/a11ign#4873, following #4718 and agent-org#522).
