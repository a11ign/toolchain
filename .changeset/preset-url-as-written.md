---
"@a11ign/toolchain": patch
---

`libraryPreset` leaves `new URL("./x", import.meta.url)` as written. Rslib's default parser rewrote it to an asset (`./static/assets/…`) and emitted `dist/static/assets/…`, so a package that reads its own directory got the wrong answer from its build. A package that set `parser: { url: false }` itself can delete that rule.
