---
description: Draw a NEW allocation base for FUTURE vaults, without touching a single existing port. Presents a plan (previous base, new base, band, "existing ports changed: 0"), applies it only on confirmation, and refuses if the registry moved in between. Never renumbers the fleet, never opens a vault, never rewrites a data.json, never changes installId. (Skill `force-new-port-start` carries the full procedure.)
---

Invoke the `force-new-port-start` skill.

Optional: `--dry-run` (show the proposed base and stop — the default behaviour of the first phase).

The skill handles:
- Reading the current base and every port already claimed, across BOTH protocols and both the registry and the vaults' own `data.json`
- Drawing a candidate base from the band (20000–32000, minus the 27000–27999 the historic fleet lives in), with both members of the pair checked
- Presenting the plan, including the count of existing ports it will change: **0**
- Sealing the plan so the base that gets written is the base that was shown — never redrawn at apply time
- Refusing the apply if a vault was registered, unregistered or renumbered since the plan was shown

What this command is NOT: it does not renumber existing vaults. Every plaintext port already
in use is written into click-to-open links — in notes, between vaults, and in mail and transcripts
that nothing can reach — so moving one is a separate, explicitly-scoped operation, not a flag on
this one.
