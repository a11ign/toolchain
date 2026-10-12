---
"@a11ign/toolchain": minor
---

`isolation-gate` no longer reads `layers.json`: it packs every `packages/*` directory that is not private, and a layer's checkout is no longer special-cased. The export `leftOutLayerCheckouts` is removed with it, and the gate's CLI no longer prints a "leaving out" line. A consumer that still calls `leftOutLayerCheckouts` must drop the call; a repository that keeps a layer checkout under `packages/` and does not want it packed must keep that checkout out of `packages/` itself.
