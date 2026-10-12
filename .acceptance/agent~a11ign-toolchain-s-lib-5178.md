Closes a11ign/a11ign#5178

Acceptance:

```bash
cd /home/agent/repos/wt-5178-toolchain && bash -c '! git grep -q "layers.json" -- src/lib/isolation-gate.ts && test ! -e src/lib/isolation-gate-layers.test.ts'
```

The row's Acceptance names the primary checkout `/home/agent/repos/toolchain`, which is on `main` and still holds the `layers.json` read, so it cannot pass there. It runs from this branch's worktree, as the 4587 row's did.

**What it does.** `isolation-gate` stops reading `layers.json`: `layerCheckoutDirs`, `isLayerCheckout`, `leftOutLayerCheckouts` and the CLI's "leaving out" line go, and `allPackages` and `countPrivatePackages` no longer skip layer checkouts. `isolation-gate-layers.test.ts` goes with them: every case in it was about that skip. The README's two sentences that named the layers test and `layers.json` are corrected. A changeset (minor) releases it.

**Left for the core row:** the core's stub `leftOutLayerCheckouts()` and the empty `layers.json` in the bootstrap fixture stay until the core pins this release.
