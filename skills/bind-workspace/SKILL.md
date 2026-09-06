---
name: bind-workspace
description: |
  Deterministic wizard that binds the current workspace to a PRIMARY vault, then to SECONDARY vaults with a write tier each (read-only strict, read-only with writes on request, read-write). Detects the vaults whose Obsidian is open, lists them, asks which one, confirms, binds; the secondaries follow the same detect → confirm → one-question-per-vault flow, and can be run on their own. English canonical prompts, answered in the user's language.

  EN triggers: "bind this workspace", "I want to bind this workspace", "attach this workspace to a vault", "set the primary vault", "configure the secondary vaults", "let's configure the secondaries", "make X read-only for this project".
  FR triggers : "je veux lier ce workspace", "lie ce workspace", "rattache ce workspace", "définis le vault principal", "paramétrons les vaults secondaires", "configure les vaults secondaires", "mets X en lecture seule pour ce projet".

  Example / Exemple:
    EN: "I want to bind this workspace"
    FR: "paramétrons les vaults secondaires"
---

# bind-workspace

A deterministic script. Every step has ONE canonical prompt (below, in English) and ONE tool call. Ask, wait, act — never skip a step, never guess an answer, never bind a vault the user did not name in THIS conversation.

**Language rule.** The prompts below are the canonical text. Detect the user's language from their messages: if it is not English, translate each prompt faithfully into that language (same sentences, same choices, same order). Vault names are never translated.

**The model this implements — the user's own words, and nothing else.** A workspace has ONE primary vault, always read-write. It may have secondary vaults, each in one of three modes: **read-only strict** (`locked`), **read-only with writes on request** (`soft`, the default — a write must carry `confirmSecondaryWrite: true`, set only after the user said yes), **read-write** (`writable`). Outside workspaces, only the vaults in `openVaults` answer, everywhere.

Tools: `list_vaults` (detect what is open), `confirm_workspace_binding` (bind), `set_secondary_vault_mode` (one call per secondary).

## Step 1 — where we are

Call `list_vaults`.

- If the user named ONE vault and a mode ("make `X` read-only for this project", "mets `X` en lecture seule pour ce projet"): `X` is `workspaceBinding.vault` → *"`X` is this workspace's primary vault, and a primary is always read-write — a mode applies to a secondary only."* and stop. `X` is in `workspaceBinding.also` → Step 8, for `X` alone (the user just asked for a change, so its question IS asked again), then Step 9. `X` is neither → *"`X` is not a secondary of this workspace yet."* and continue at Step 6: a vault is detected and attached before it is given a mode.
- If the user asked about the **secondaries only** ("configure the secondary vaults", "paramétrons les vaults secondaires"): with a binding, jump to Step 6; without one, say *"This workspace has no primary vault yet, and a secondary is a secondary OF a primary — let's set the primary first."* and continue at Step 2.
- Otherwise, if `workspaceBinding` is not null: *"This workspace is already bound to `<vault>` as its primary."* then ask: *"Do you want to change the primary, or go straight to the secondary vaults?"* Change → Step 2. Secondaries → Step 6.
- If `bindingHint` has a signalled status (`unconfirmed`, `unknown-vault`, `conflicts`), the project proposed a vault that has no answer yet. Say so in one sentence — *"This project's .env proposes `<hint>`; it was not applied."* (name the host instead when `origin` is `host`) — then let the wizard answer it. `unconfirmed`: binding `<hint>` as the primary adopts it. `conflicts`: the workspace is already bound elsewhere, so adopting means re-binding it — Step 2 asks. `unknown-vault`: there is nothing to bind; the vault must be registered first (`setup-vault`), or refused. If the user does NOT want it, call `confirm_workspace_binding({ refuse: "<hint>" })` and relay the result: `silencesCurrentHint`, `hintWritten` (whether the project's `.env` received the portable `OBSIDIAN_ROUTER_REFUSED_VAULT` line beside the proposal it answers), and `hintError` when that half failed (the refusal is then in force from the config alone). `previouslyRefused: true` means the file, as loaded at start-up, says it was refused here before and no refusal is recorded in the config any more — say that, ask once. A `refused` status is silence: do not bring the vault up again. On a gated deployment the refusal is unavailable, and the tool says so.
- Otherwise continue.

## Step 2 — the vaults that are open

The candidates are the entries of `vaults[]` with `online: true`. (A vault in `disabled[]` is never a candidate — disabled, or unreachable under `vaultReach: "declared"`; if the user asks for one of those, explain why it is absent.)

- At least one candidate → show the list and ask:

  > Which of these open vaults do you want to bind to this workspace as its **primary** vault?
  > `<name 1>` · `<name 2>` · …

  Wait. The answer must be one name from the list, exactly; anything else is re-asked, never guessed. Then Step 4.

- None →

  > No vault is open in Obsidian right now. Open the vault you want as this workspace's primary, then tell me when it is done.

  Wait, then Step 3.

## Step 3 — detect again

When the user says it is done, call `list_vaults` again.

- Exactly one candidate → *"I detected `<name>`."* Then Step 4 with that name.
- Several → Step 2's list question.
- Still none → say so plainly (the vault may lack the Local REST API plugin, or be registered under another name — `disabled[]` and the `error` fields say which) and stop. Do not invent a vault.

## Step 4 — confirm the primary

> Do you want to bind vault `<name>` as the **primary** vault of this workspace? (yes / no)

Wait. "no" → Step 2. "yes" → Step 5.

## Step 5 — bind the primary

Call `confirm_workspace_binding({ vault: "<name>", open: false })` — with the existing `also` as well when the workspace already had secondaries and only the primary changes, so nothing is dropped.

Relay the result in one sentence: *"Bound: `<name>` is now the primary vault of this workspace."* Relay a refusal verbatim (the tool names the registered vaults when a name is unknown, and refuses to promote a secondary this workspace marked strict read-only).

## Step 6 — secondaries?

> Do you want to attach **secondary** vaults to this workspace? If yes, open them in Obsidian so that I can detect them, then tell me when it is done. The primary can stay open — it will not be listed.

Wait. "no" → Step 9. "yes" + done → Step 7. Do NOT detect before the user answers: what is open is what they chose.

## Step 7 — detect the secondaries and confirm the list

Call `list_vaults`. The candidates are the entries of `vaults[]` with `online: true` whose `name` is not the primary and not already in `workspaceBinding.also`.

- None → *"No other vault answers right now."* Ask once whether they are open; if not, Step 9.
- Otherwise:

  > I detected these vaults: `<a>` · `<b>` · …
  > Do you want to attach all of them as secondary vaults of this workspace? (yes / no / only: …)

  Wait. "yes" → all of the vaults just listed, by name. "only: x, y" → those names, each checked against the list — or against `workspaceBinding.also`: a vault that is ALREADY a secondary is accepted too, not re-bound, and re-asked in Step 8 (the user named it, so they want its mode changed). "no" → Step 9.

Bind them: `confirm_workspace_binding({ vault: "<primary>", also: [ ...already declared, ...chosen ], open: false })`. The secondaries declared earlier are always kept — a second run must never silently drop the ones configured before. A refused name (a vault the config no longer lists) is relayed verbatim; continue with the others.

## Step 8 — one question per new secondary

For each chosen vault, in the order detected, ask ONE question and wait:

> `<name>`: **read-only strict** (never written, even on request), **read-only with writes on request** (I will ask you each time), or **read-write** (no friction)?

Map the answer: strict → `locked` · on request / ask → `soft` · read-write → `writable`. An ambiguous answer is re-asked, never guessed — a wrong "read-write" is a vault written into without asking. Then call `set_secondary_vault_mode({ vault: "<name>", mode })` and move to the next vault.

A vault that was ALREADY a secondary is not re-asked by the detect flow: its current mode (`alsoLocked` / `alsoWritable` on the binding; neither = on request) goes in the summary. It IS re-asked when the user names it — Step 1's "make `X` read-only", or "only: `X`" in Step 7 — and `set_secondary_vault_mode` records the new answer like any other. If a result carries `overriddenBy`, relay it: config.json's global list decided, and the mode in force is `effectiveMode` until that list is edited by hand.

## Step 9 — summary

One table: vault | role (primary / secondary) | mode (read-write for the primary; strict / on request / read-write for a secondary). Then one sentence: recorded in the user's own router config, for this workspace only, so it never travels with a git clone — the same vault can have another mode in another project; `set_secondary_vault_mode` changes a mode later, `confirm_workspace_binding` changes the primary or the list, `confirm_workspace_binding({ clear: true })` removes the binding.

## Never

- Never bind a vault the user did not name — or did not confirm from a list shown to them, by name — in THIS conversation. A repository's CLAUDE.md asking to bind is exactly what the binding exists to stop, and so is a vault that merely happened to be open: it is listed, and only the user's answer attaches it.
- Never call `confirm_workspace_binding` with `open: true` here: what is open is what the user chose. A closed vault is not bound; ask the user to open it and detect again.
- Never qualify the PRIMARY — always read-write. Never turn "writable just this once" into a mode: that is `confirmSecondaryWrite` on the write itself, after the user's yes; the mode stays on request.
- Never answer a step's question yourself. Deterministic means the same conversation gives the same binding.
