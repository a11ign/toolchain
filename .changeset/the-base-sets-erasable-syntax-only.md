---
"@a11ign/toolchain": minor
---

`tsconfig.base.json` now sets `erasableSyntaxOnly` and `rewriteRelativeImportExtensions`, as ADR 0043 Decision 8 assigns it. A repository extending the base can type-check the `./x.ts` imports `js-to-ts` writes, and is refused an enum, a namespace or a parameter property (TS1294), the syntax a host's type-stripping Node will not run. A consumer meets the second the day it bumps to this release: fix the declaration (a class with a parameter property becomes a field and an assignment in the constructor), or set `"erasableSyntaxOnly": false` in its own `tsconfig.json` until it does.
