---
description: Validate an OKF knowledge bundle (ours or a third-party clone) against the Open Knowledge Format v0.1 conformance rules — one of the ecosystem's first OKF validators. (Skill `wiki-lint` handles the flow via its `--okf` mode.)
---

Invoke the `wiki-lint` skill in `--okf <path>` mode (Check M only — this does not lint the wiki itself).

ARGUMENTS: $ARGUMENTS

Argument (required): `<path>` — either a bundle exported by `/obsidian-router:okf-export` (`wiki-meta/exports/okf/<name>/` inside a vault) or any local directory / cloned git repo containing an OKF bundle. If the user gives a GitHub URL, clone it to the scratchpad first, then validate the clone.

Default behaviour:
- Read-only — never mutates the bundle or the wiki. Never offer to auto-fix a third-party bundle (someone else's artifact).
- Verdict first: `✅ conformant OKF v0.1` (zero errors) or `❌ NOT conformant`, then the severity tables (errors = the spec's three conformance rules; warnings = spec-by-example deviations + Google-tooling compat; info = recommended-practice gaps).
- A bundle with warnings is STILL conformant — state it explicitly; OKF consumers must tolerate those deviations.
- For bundles produced by our own exporter, any error is an exporter bug — report it as such.
