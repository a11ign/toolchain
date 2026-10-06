---
"@a11ign/toolchain": patch
---

`libraryPreset` builds into `dist` without emptying it first (`output.cleanDistPath: false`). Rslib's default empties `dist` before every build, so a reader of `dist` in another process found a built file missing for the length of one build: 2.4% of reads on a package's `dist` (measured 2026-10-06, a11ign/a11ign#3580), 0 with it off. A package that set `cleanDistPath: false` itself can delete that override. A removed entry's old file is left behind locally; a publish builds from a clean checkout.
