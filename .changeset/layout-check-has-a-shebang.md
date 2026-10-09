---
"@a11ign/toolchain": patch
---

The `layout-check` bin begins with `#!/usr/bin/env node` and is executable, so the one-line `npx --yes --package @a11ign/toolchain layout-check` form works: 0.1.5 shipped it without, `sh` read `import { … }` as a command and exited 2 (`import: not found`). A test now runs every `bin` through a symlink with no `node` in front, as npx does.
