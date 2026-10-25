---
"@a11ign/toolchain": minor
---

`dependabot-config` writes and checks every repository's `.github/dependabot.yml` from one template (A11-253): weekly at one fixed time, one `<ecosystem>-minor-and-patch` group per ecosystem with majors apart, the `deps` commit prefix, a seven-day cooldown, Dependabot's default labels, and the packages frozen by policy (`FROZEN`, exported as `./dependabot-frozen`) ignored in every npm entry beside the workspace's own packages. `--check` fails, with the diff and the `--write` command, when the committed file is not what `--write` produces. A repository's `.github/dependabot-extra.json` can add only an ignore with its reason, npm directories and a versioning strategy. The conventions A11-254 and A11-255 read are exported as `DEPENDABOT_GROUP_SUFFIX`, `DEPENDABOT_COMMIT_PREFIX` and `dependabotGroupName`. `readLayoutTree` takes the names of further files to read as text, and `workspacePackageNames` is exported from `./layout-check`.
