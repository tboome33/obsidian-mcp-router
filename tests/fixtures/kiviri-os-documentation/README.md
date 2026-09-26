# Fixture — the `Documentation/` folder Kiviri-OS carried on 2026-09-26

These four files are the reference vault's `Documentation/CLAUDE.md` and its three
`CLAUDE.md.bak-*` backups, exactly as a 2026-09-22 template sync copied them into
every vault of the fleet — Kiviri-OS included, where a diagnosis then read the
backups as that vault's own history and concluded that four conventions had been
lost there. They had never been installed there: the backups are the template's.

They are the real files, with private identifiers replaced and nothing else
changed (`Roland` → `Owner`, a personal drive path → `D:\\Vaults\\Owner`, a user
profile path → `C:\Work\PROJECT`, a VPN address → the documentation range
`192.0.2.20`). The substitutions are identical in all four files, so the relations
the tests depend on survive: the current file carries the four core conventions,
the oldest backup carries eight, and the three backups are distinct versions.

Used by `tests/vault-conventions-reach.test.mjs`, `tests/conventions-audit-cli.test.mjs`,
`tests/root-docs-sync-conventions.test.mjs` and `tests/vault-conventions-e2e.test.mjs`.
