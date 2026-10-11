## What

`.github/workflows/ci.yml` gains a `release-dry-run` job, and `gate` needs it and reads `needs.release-dry-run.result`. The job runs only when a pull request touches `package.json`, `pnpm-lock.yaml`, `.npmrc` or `.github/workflows/`, in a scratch clone with `contents: read` and no push: `pnpm install --frozen-lockfile`, `pnpm exec changeset version`, `pnpm install --lockfile-only`, the three commands `release-per-merge.yml`'s `version` job runs for a repository with a lockfile. The toolchain values are this repository's release: pnpm from `packageManager`, Node `22` (`release.yml` sets none, so the called workflow's default).

Measured (2026-10-11, scratch clone of this head): the three commands exit 0; with the `@changesets/cli` importer entry removed from `pnpm-lock.yaml`, `pnpm install --frozen-lockfile` exits 1 with `specifiers in the lockfile don't match specifiers in package.json`.

Acceptance: grep -q "release-dry-run:" .github/workflows/ci.yml && grep -q "needs.release-dry-run.result" .github/workflows/ci.yml
