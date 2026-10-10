---
"@a11ign/toolchain": patch
---

`walk-scope`'s `NOT_WRAPPED.test` names `expectFailure` and `getTestContext`, the two functions Node 24 added to `node:test`, each with the reason it reads no path. Without them the enumeration test of every repository that lays this module goes red on a Node 24 host (a11ign/a11ign#4843).
