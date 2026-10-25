Refs A11-253

`dependabot-config` now names the directory of each local composite action (`.github/actions/<name>/action.yml`) in the `github-actions` entry, beside `/`, as `directories:` of one entry. The hand-written control config covered `.github/actions/ansible-collections` that way and the generated file dropped it (a11ign/control#144); a repository with no local action gets the same file as before.

Acceptance:

```bash
pnpm install --frozen-lockfile
pnpm exec rstest run src/dependabot-config.test.ts scripts/dependabot-config.test.ts
pnpm run build
node dist/dependabot-config.mjs --check
bash -c 'd=$(mktemp -d) && mkdir -p "$d/.github/workflows" "$d/.github/actions/x" && echo "{\"name\":\"t\"}" > "$d/package.json" && : > "$d/.github/workflows/ci.yml" && : > "$d/.github/actions/x/action.yml" && node dist/dependabot-config.mjs --write --root "$d" && grep -q -- "- /.github/actions/x" "$d/.github/dependabot.yml"; rc=$?; rm -rf "${d:?}"; exit $rc'
```
