---
"@a11ign/toolchain": patch
---

The release packs a built `dist` again. Flattening the package to the repository root dropped its `prepack`, so 0.1.6 was published with 4 files and every `exports` target and the `layout-check` bin pointed at a directory it did not hold. `package.json` has `"prepack": "rslib build"` back, and CI's `checks` job runs `pnpm run pack-check`, which refuses a tarball missing any `exports` target or `bin` path, read from `npm pack --dry-run --json` after removing `dist`. The layout check in CI runs the build of the tree rather than the registry's `latest`. Use 0.1.5 or 0.1.7 and later; 0.1.6 is unusable.
