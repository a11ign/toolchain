---
"@a11ign/toolchain": minor
---

`lib/ci-changed` no longer classifies an `ansible` category: `ClassifyResult` loses the `ansible` field, `jobsFor` never returns `"ansible"`, and the CLI's output block no longer prints `ansible=`. The category was a change to `layers.json`, and each repository now checks its own playbooks. A consumer that read `steps.<id>.outputs.ansible` gets an empty value; the core's `ci.yml` reader is removed by a11ign/a11ign#4920.
