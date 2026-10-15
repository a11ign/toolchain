---
"@a11ign/toolchain": patch
---

New export `@a11ign/toolchain/refusal-owners-are-open`: the reader that checks a release gate's `REFUSED` strings and `::error` lines name an OPEN owning row. `refusalsInPackageJson`, `refusalsInWorkflow`, `refusalsInTree`, `ownersOf`, `findings`, `failures`, `describe` and `readIssueState` are the reader; `readIssueState(repo)` takes the repository a bare `#n` names, so the caller supplies its own. A `CLOSED` or unreadable owner fails, and only `OPEN` passes.
