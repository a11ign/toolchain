Closes none -- the core row a11ign/a11ign#4843 closes on the core's pull request; this is its upstream half.

Acceptance:

```bash
pnpm exec rstest run src/lib/walk-scope && node --input-type=module -e 'import { createRequire } from "node:module"; const w = await import("./dist/lib/walk-scope.mjs"); const t = createRequire(process.cwd() + "/x.js")("node:test"); const u = Object.entries(t).filter(([k, v]) => typeof v === "function" && !w.isObserved(v) && !(k in w.NOT_WRAPPED.test)).map(([k]) => k); console.log(JSON.stringify(u)); process.exit(u.length ? 1 : 0);'
```
