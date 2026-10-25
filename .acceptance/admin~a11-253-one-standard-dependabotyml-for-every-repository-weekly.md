Refs A11-253

Step 1 of 2 (toolchain): `dependabot-config` is the one template for every repository's `.github/dependabot.yml`. `--write` makes the file from the tree it is pointed at; `--check` fails, printing the diff and the `--write` command, when the committed file is not exactly that output. Every ecosystem (npm, pip where a `requirements*.txt` or `pyproject.toml` exists, github-actions) is weekly on Monday at 05:23 UTC with one `<ecosystem>-minor-and-patch` group, so a major is its own pull request. Every npm `ignore` carries `FROZEN` (`@a11ign/screenreader-worker`, `@a11ign/screenreader-fleet`, `@guidepup/guidepup`, `@guidepup/setup`), the workspace's own packages and the repository's extras, each with its reason above it. This repository's own `.github/dependabot.yml` is regenerated, and `scripts/dependabot-config.test.ts` checks it from source. Step 2 regenerates the ten consumer repositories once this release is on the registry.

Acceptance:

```bash
# the generator and its cases (weekly at the fixed time, one group per ecosystem, every FROZEN name ignored, workspace members, extras refused, --check passing and failing, pip detected)
pnpm exec rstest run src/dependabot-config.test.ts scripts/dependabot-config.test.ts src/layout-check.test.ts
# this repository's own file is the template's output (exit 0), and a hand edit is drift (exit 1)
pnpm run build
node dist/dependabot-config.mjs --check
cp .github/dependabot.yml "${TMPDIR:-/tmp}/dependabot.yml.keep"
sed -i 's/interval: weekly/interval: daily/' .github/dependabot.yml
if node dist/dependabot-config.mjs --check; then echo "drift not caught"; exit 1; fi
cp "${TMPDIR:-/tmp}/dependabot.yml.keep" .github/dependabot.yml && rm "${TMPDIR:-/tmp}/dependabot.yml.keep"
node dist/dependabot-config.mjs --check
# the four frozen packages are ignored in the npm entry, none in github-actions
for name in @a11ign/screenreader-worker @a11ign/screenreader-fleet @guidepup/guidepup @guidepup/setup; do grep -qF "dependency-name: \"$name\"" .github/dependabot.yml; done
# nothing outside the plan's paths and the two files the generator needed
git diff --name-only origin/main...HEAD | awk '$0 !~ /^(\.acceptance\/|\.changeset\/|\.github\/dependabot\.yml$|README\.md$|package\.json$|src\/dependabot-|src\/layout-check(\.test)?\.ts$|scripts\/dependabot-config\.test\.ts$)/ { bad = 1; print } END { exit bad }'
```
