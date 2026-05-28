## Family-member auto-routing — identify the speaker, route saves to wiki/People/<member>/

Cette convention s'applique aux **vaults famille / multi-utilisateur partagés** dans lesquels les notes auto-enrichies doivent atterrir dans un sous-dossier spécifique au membre qui parle dans la session courante.

This convention applies to **shared family / multi-user vaults** where auto-enriched notes need to land in a sub-folder specific to the member speaking in the current session.

### Structure du vault · Vault structure

Le vault expose une arborescence `wiki/People/<member>/` avec un dossier par membre famille. La liste exacte des membres + leurs alias (surnoms, formes variantes) est définie dans le `CLAUDE.md` du vault sous la section **Membres famille reconnus / Recognized family members**.

The vault exposes a `wiki/People/<member>/` tree with one folder per family member. The exact list of members + their aliases (nicknames, variant spellings) is defined in the vault's `CLAUDE.md` under the **Recognized family members** section.

### Procédure obligatoire au session start · Mandatory session-start procedure

1. **Si l'identité du membre qui parle n'est PAS encore établie dans la session courante**, AVANT toute opération vault-related (save, write_file, append_to_file, set_frontmatter, lock_vault, set_auto_enrich_mode), invoquer la skill `who-is-speaking` (slash command `/obsidian-router:who-is-speaking`) ou demander directement en langage naturel : *"qui parle ?"* / *"who is speaking?"*. Accepter la réponse + matcher contre la liste membres + alias du vault `CLAUDE.md`. En cas de match, stocker le membre identifié pour la session.

2. **Si l'identité EST établie** :
   - `lock_vault({ vault: '<vault-name>' })` (verrou single-vault session pour éviter les saves cross-vault accidentels)
   - `set_auto_enrich_mode({ mode: 'Hybrid' })` (mode confortable famille — auto-save items type-safe, demande pour high-stakes)
   - Pour chaque save / write proactif auto-enrich-driven, le path doit être préfixé `wiki/People/<member>/` (jamais en racine `wiki/`, sauf si l'item concerne explicitement la famille collective → `wiki/Family/`)

3. **Si aucun match** : refus de save sans confirmation user explicite. Message du type *"je n'ai pas identifié de membre famille connu (membres : [list]) — veux-tu (a) m'identifier, (b) sauvegarder en `wiki/Family/<topic>.md`, (c) skipper l'auto-save ?"*

### Sensitivity — `vault/Family/` vs `vault/People/<member>/`

- `wiki/People/<member>/` = **sous-espace privé du membre identifié**. Auto-routing par défaut quand un membre parle de lui / ses sujets perso.
- `wiki/Family/` = **espace partagé collectif**. Auto-routing seulement quand l'item concerne explicitement plusieurs membres ou la famille en tant qu'entité (calendrier commun, projets, décisions famille).

Le LLM doit utiliser son jugement contextuel pour distinguer : *"j'ai mal dormi"* → `Roland/sante/` (perso), vs *"on part en vacances en Italie en août"* → `Family/calendrier/` (collectif).

### Anti-patterns

- ❌ Sauter l'identification et router tout en `wiki/People/Roland/` par défaut → casse l'usage famille
- ❌ Demander l'identité à chaque turn (l'identité de session est stable — demander UNE FOIS au début, puis re-confirmer seulement si l'user le dit explicitement *"c'est <autre membre> qui parle maintenant"*)
- ❌ Inventer un membre qui n'est pas dans la liste du `CLAUDE.md` du vault
- ❌ Auto-save dans `wiki/Family/` un item qui est clairement personnel à un membre (sport perso, finance perso, projet solo)
- ❌ Router des données médicales sensibles auto-enrich (santé, médicaments, diagnostics) sans confirmation user — sensitivity filter prioritaire

### Pourquoi (audit trail)

Ajoutée 2026-05-27 lors du Step C de [[mcphub-hybrid-bypass-roadmap]] (vault_tribu cobaye pour le déploiement du router sur MCPHub avec une structure famille). La même convention pourra être réutilisée par tout client SaaS qui veut un vault partagé multi-utilisateur (entreprise, équipe, famille).

Skill associée : `who-is-speaking` (couche UX qui invoque la convention, demande l'identité, locke le vault + set le mode auto-enrich). Tools MCP appelés en chaîne : `list_vaults` (vérifier que le vault courant a cette convention installée) → `lock_vault` → `set_auto_enrich_mode`.
