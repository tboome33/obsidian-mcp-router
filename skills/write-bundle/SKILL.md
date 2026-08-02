---
name: write-bundle
description: |
  Run several vault writes as ONE logical operation with rollback — the note + the index + the journal + hot.md either all land, or none do. Use whenever a single user-visible action touches 2+ files and a half-written result would be wrong. Also the recovery entry point for bundles a crash left unfinished.

  EN triggers: "write these files together", "all or nothing", "make this atomic", "roll back if any of it fails", "recover the unfinished bundle", "something crashed mid-save".
  FR triggers : "écris ces fichiers ensemble", "tout ou rien", "rends ça atomique", "annule tout si une étape échoue", "récupère le lot inachevé", "ça a planté au milieu de la sauvegarde".

  Example / Exemple:
    EN: "save the note, add it to the index and log it — all three or none"
    FR: "écris la note, ajoute-la à l'index et journalise — les trois ou aucun"
---

# write-bundle

Call the obsidian-router `write_bundle` MCP tool. It runs a list of writes as one journaled operation: every target's content is captured **before** the first write, and if any step fails, every file the bundle touched is put back byte-for-byte.

## When to use

Whenever one user-visible action produces **several** files whose half-written state would be wrong:

- `save` — the note + the journal line + `hot.md`
- `wiki-ingest` — the source page + entity pages + the journal
- `wiki-fold` — the fold page + the log rewrite
- any multi-key frontmatter update that must not land halfway (this is what makes `merge_frontmatter` all-or-nothing — see below)

For a single file, use the ordinary `write-append` / `write-create-or-replace` / `write-patch`. A bundle around one write buys nothing but a journal round-trip.

## Arguments

**Required**: `steps` — an ordered array, at most 25. Each entry is `{ op, path, ...that op's own arguments }`.

| `op` | runs | needs |
|---|---|---|
| `write` | `write_file` | `content` |
| `append` | `append_to_file` | `content` |
| `patch` | `patch_file` | `operation`, `targetType`, `target`, `content` |
| `set_frontmatter` | `set_frontmatter` | `key`, `value` |
| `merge_frontmatter` | `merge_frontmatter` | `values` |
| `delete` | `delete_file` | `confirm: true` |

**Optional**: `vault` (omit for default — a bundle is single-vault, steps may not override it) · `preview: true` (sealed plan, writes nothing) · `approvedPlanSha256` (the seal from a preview) · `recover` (see below) · per-step `ifMatch`.

`move` is deliberately **not** a bundle step: a half-rolled-back move is worse than no rollback. Express it as a `delete` plus a `write`.

## What it guarantees — and what it does not

✅ **No silent in-between.** `outcome` says exactly where you landed (four values, below). Read it; do not assume success.
✅ **Crash survival.** The before-images are written to `wiki-meta/write-journal/<operationId>.json` before the first mutation, so a rollback is still possible after the process dies. A journal is deleted — or, if that fails, stamped terminal — once the operation reaches a *proven* end, so it can never be replayed against a bundle that already succeeded. It stays `pending` (and recoverable) whenever the end was not proven.
✅ **Nothing is destroyed without a copy.** If a rollback has to overwrite content it cannot attribute, the exact bytes it is about to overwrite are saved into the journal **first** — and if that copy cannot be saved, the overwrite does not happen at all.
✅ **Group-wide C1.** Put `ifMatch` on the steps that matter: every precondition is checked up front, so a bundle whose targets moved refuses **entirely**, before writing anything.
✅ **Concurrent writers are detected, not assumed away.** For `write` and `delete` steps the bundle knows the exact result it produced, so a read-back that disagrees is *proof* someone else wrote — that file is then left alone for the rest of the operation, rollback included.

❌ **Not isolation.** A concurrent reader can still see an intermediate state *while* the bundle runs. What disappears is the durable half-applied state, not the transient one.
❌ **Not a lock.** A file that someone else changed is **never** restored over — that would be the exact clobber `ifMatch` exists to prevent. It is left alone, named in `rollback.paths` with `left-modified` / `left-deleted` / `left-created`, and the journal is kept.
❌ **Not byte-level.** Restoration puts back *the content the router read*. The read path strips a leading UTF-8 BOM (the same normalisation C1's hash depends on), so a BOM-prefixed file comes back without its BOM. Everything else — CRLF, accents, emoji, trailing spaces — is exact.

## Reading the result

| `outcome` | what happened | what to say |
|---|---|---|
| `applied` | every step landed | done; `operationId` is the trace. If `skipped` is set, some steps were idempotent no-ops — say so rather than "all applied" |
| `rolled-back` | a step failed; every file is back, provably | report `failedStep` + `error`. **Do not** re-run blindly: fix the cause |
| `rolled-back-unverified` | every file is back, but the undo could **not** be proven | say so. The failing step never confirmed a write, so what was overwritten could not be attributed — it is saved under `salvage` in the retained journal |
| `rolled-back-partial` | some files are **still dirty** | name them from `rollback.paths` with their reason. `journalPath` holds the pre-bundle content. Never summarise this as "it failed but I rolled it back" |

Also worth surfacing:

- `rollback.paths[].attribution` — `ours` (the bundle knew the exact bytes it wrote), `observed` (read back after the step, so a write inside that one round trip would have been adopted as the bundle's own), `unverified`.
- `warnings` — carries concurrent-writer detections *and* journal problems. Both, never one silently replacing the other.
- `journalUnsafe: true` — rare and serious: the operation finished, but its journal could be neither removed nor closed, so it still reads as a live recovery instruction. Delete the file at `journalPath` by hand before running any recovery.

**If a step is refused because the file "was changed by something other than this bundle"**, that is not a transient error: the bundle proved a concurrent writer is working on that file. Re-read it and rebuild on the current content — do not retry the same bundle.

## What a bundle costs

Every target's **full** content is copied into memory and into the journal, so the price is the size of the files you touch, not the size of your edit. Measured on a real vault: a three-step bundle (new page + append to `journal.md` + patch `hot.md`) carried **401 KB** of before-images, almost all of it the journal. That is well inside the 5 MB bound and it is the honest cost of being able to undo — but it is why the bound exists, and why you should not casually add a large file to a bundle that does not need it.

## Steps that must not be inside a bundle

A step whose failure is a *normal branch* of your logic will roll the whole bundle back. The classic case is the backlink dance in `save`: `patch_file` on `## Backlinks`, falling back to `append_to_file` when the heading is absent. Resolve the branch **before** building the bundle (read the target, decide which op to use), or leave that write outside the bundle. Never rely on a step failing.

## Recovery

```
write_bundle({ recover: true })                                            # read-only listing
write_bundle({ recover: "op-<16 hex>", confirm: true })                    # replay one rollback
write_bundle({ recover: "op-<16 hex>", confirm: true, only: ["a.md"] })     # …just these files
```

`recover: true` lists the journals left by bundles that never finished, with a per-file `wouldChange` verdict and a `recoverable` flag (a journal already stamped terminal is listed but refused — replaying it would undo an operation that succeeded).

Run the listing first and **look at those files**. A recovery cannot prove two things: who wrote the content that is there now, *and* how far the crashed bundle actually got — a crash leaves no per-step record. So `wouldChange:true` mixes files the bundle wrote with files **you** may have edited since. That is why the run form demands `confirm: true`, reports every restore as `unverified`, and accepts `only` so you can restore just the files you recognise as the bundle's. A partial recovery keeps the journal so the rest stays recoverable.

A leftover journal is a signal, not garbage: it means a vault may still be carrying half an operation.

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails entirely (not a rolled-back bundle — an actual throw), do NOT redo it with `Read`/`Edit`/`Write` on the vault's real path:
- **Connection error** (`ECONNREFUSED`, timeout) → vault closed; `list_vaults`, then ask the user to open it via the `openUri` link and wait.
- **`kind: "conflict"`** → a step's `ifMatch` is stale. Re-read the files, rebuild the bundle on current content, retry.
- **`kind: "plan_drift"`** → a target moved since your `preview`. Re-preview, review, pass the fresh seal.

Rationale + message template: the `default-vault-health-check` convention (canonical source).
