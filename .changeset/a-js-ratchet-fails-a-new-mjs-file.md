---
"@a11ign/toolchain": patch
---

New export `@a11ign/toolchain/mjs-ratchet`: the count of `.js`/`.mjs`/`.cjs` source files outside build output (`dist`, `build`, `node_modules`, `generated`) may only go down. A repository commits `mjs-ratchet.baseline.json` (the basenames of its files, so a move does not edit it, plus `exceptions` of `{ path, why }`) and its existing test calls `checkMjsRatchet({ from: fileURLToPath(import.meta.url) })`: a new file fails and is named, a drop passes, and `writeLoweredBaseline({ from })` lowers the baseline. An empty tree is red, and an empty baseline fails on any such file.
