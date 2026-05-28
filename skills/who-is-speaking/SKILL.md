---
name: who-is-speaking
description: |
  Identify the family member speaking in a shared family vault (e.g., `vault_tribu`), then lock the router to that vault + set auto-enrich mode to `Hybrid` so subsequent auto-saves route to `wiki/People/<member>/`. Companion skill for the `tribu-routing` convention.

  Trigger this skill at the start of any session on a shared family/multi-user vault when the speaker's identity hasn't been established yet. Read the vault's `CLAUDE.md` to get the canonical list of members + their aliases — never invent a member that's not in the table.

  EN triggers: "who is speaking", "I'm <name>", "this is <name>", "it's <name> talking", "set me as <name>", "identify me", "log me in as <name>", "I'm <alias>", "/who-is-speaking".
  FR triggers : "qui parle", "c'est <prénom>", "je suis <prénom>", "moi c'est <prénom>", "identifie-moi", "log-moi en <prénom>", "je m'appelle <prénom>", "/qui-parle".

  Examples / Exemples:
    EN: "I'm Karine, let's go" → identify as Karine, lock to vault_tribu, set Hybrid mode
    FR: "c'est Roland, on enchaîne" → identifie comme Roland, lock vault_tribu, mode Hybrid
    EN: "who's speaking today?" → ask the user (don't guess), then identify
---

# who-is-speaking

Identify the family member for the current session on a shared family vault, then lock + set mode.

## Pre-conditions

This skill only makes sense when the **current default vault** is a shared family/multi-user vault that has the `tribu-routing` convention installed in its `CLAUDE.md`. Detect this by:

1. Reading the vault's `CLAUDE.md` and looking for an H2 heading matching `Family-member auto-routing` (case-insensitive)
2. OR by recognizing the structure `wiki/People/<N>/` with multiple member subfolders

If neither, this skill doesn't apply — push back with: *"This skill is for shared family vaults using the `tribu-routing` convention. The current default vault (`<name>`) doesn't appear to use this pattern. If you want to install it, run `/obsidian-router:conventions install tribu-routing`."*

## Argument parsing from $ARGUMENTS

- bare member name or alias (Roland, roro, papa, karine, max, nico, …) → match against the vault `CLAUDE.md` table
- empty / "qui parle?" / "who is speaking?" → ASK the user explicitly: *"Qui parle dans cette session ? (membres reconnus : Roland, Karine, Maxence, Nicolas, Amelie + leurs alias)"*. Wait for the answer before proceeding.

## Always

1. **Read** the vault's `CLAUDE.md` to get the canonical members + alias table. Never hardcode the list — it's per-vault.
2. **Match** the user's input (case-insensitive) against the table. Both canonical names and aliases are valid. If match found, store the canonical name (e.g., `roro` → `Roland`).
3. **No match** → DON'T guess. Tell the user the list of recognized members and ask them to clarify. Refuse to proceed.
4. **After successful match**, in sequence:
   - Call `mcp__obsidian-router__lock_vault({ vault: '<vault-name>' })` (use the slug of the current default family vault, typically `tribu`)
   - Call `mcp__obsidian-router__set_auto_enrich_mode({ mode: 'Hybrid' })`
   - Confirm to the user: *"Identifié comme **<Canonical Name>**. Vault verrouillé sur `<vault-slug>`, mode auto-enrich Hybrid. Les saves auto routent vers `wiki/People/<Canonical Name>/`."* (or EN equivalent if user is speaking EN)
5. **For the rest of the session**, treat the identified member as the active speaker. When auto-enrichment proposes saves (triggers 1/2/3 of the auto-enrichment consigne), prefix paths with `wiki/People/<member>/`. Items that are explicitly collective → `wiki/Family/`.

## Re-identification mid-session

If the user later says *"c'est <autre>"* / *"this is <other> speaking now"* / *"switch to <other>"*, re-trigger the skill with the new name. Don't keep the previous identity. **Don't unlock the vault** unless the user explicitly asks — just switch the active member.

## Push back if

- The named member isn't in the vault's CLAUDE.md table → push back with the canonical list + offer to add the new member (via editing CLAUDE.md + creating `wiki/People/<Name>/README.md`).
- The current default vault doesn't have the `tribu-routing` convention → push back with the installation hint.
- The user tries to lock to a different vault simultaneously → ask which vault is the family vault first. The lock target is the FAMILY vault, not whatever else they have open.

## Anti-patterns

- ❌ Guessing the member based on chat history clues (greeting style, topic) instead of asking
- ❌ Defaulting to "Roland" when uncertain
- ❌ Failing silently when no match (must surface the canonical list + refuse to save)
- ❌ Re-asking identity on every turn — once identified, it's stable for the session
- ❌ Routing all saves to `wiki/People/<member>/` blindly — collective items go to `wiki/Family/`, judgment call
