---
"@a11ign/toolchain": patch
---

The one-line `npx --yes --package @a11ign/toolchain layout-check` resolves on a cold npm cache again: the optional `typescript` peer is `^6.0.3 || ^7.0.0`, not `^6.0.3`. 0.2.0 and 0.3.0 exited 1 with `ERESOLVE`, because `@rslib/core` peers `typescript` `^5 || ^6 || ^7`, npm takes the newest (7.x), and the toolchain's own peer excluded it. 0.1.8 had no `typescript` peer and ran. A test now pins the README line and the peer against the other declared peers' `typescript` ranges.
