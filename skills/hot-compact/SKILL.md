---
name: hot-compact
description: |
  Compact an oversized `wiki-meta/hot.md` back to its cache contract (≤ 500 words / 6 KiB, compaction target ≤ 350 words / 4 KiB): verified full backup → thin state-first rewrite → traceability line in `journal.md`. Zero data loss by construction — the backup is byte-identical and kept in the vault. Invoked on demand, or when the hot-cache guard blocks a turn with "hot.md HORS LIMITE / OVER LIMIT".

  EN triggers: "compact the hot", "hot.md is over limit", "shrink the hot cache", "the hot cache is too big", "run hot-compact on vault X".
  FR triggers : "compacte le hot", "le hot est hors limite", "dégraisse le hot.md", "le cache hot est trop gros", "lance hot-compact sur le vault X".

  Example / Exemple:
    EN: "the guard says the tradingview hot is over limit — compact it"
    FR: "compacte le hot du vault tradingview"
---

# hot-compact

Compaction procédurale et transactionnelle du cache `wiki-meta/hot.md` d'un vault. Le hot est un **cache d'état** (« < 500 mots, écrasé à chaque mise à jour — c'est un cache, pas un journal ») ; quand il dérive en journal, ce skill le ramène au contrat **sans jamais rien perdre**.

Les seuils font autorité dans `src/helpers/hot-size.mjs` (partagés avec `hot-cache-load` et le guard) : déclenchement > 500 mots OU > 6 Kio ; cible après compaction ≤ 350 mots ET ≤ 4 Kio ; override par vault via le frontmatter du hot (`hot-limit-words` / `hot-limit-bytes`, plafonnés 1000 mots / 12 Kio).

## Argument parsing from $ARGUMENTS

- vide → vault courant (cwd-is-vault, lock, ou `OBSIDIAN_ROUTER_DEFAULT_VAULT`)
- nom de vault → cible explicite
- `--dry-run` → étapes 1-4 seulement (montrer la proposition, ne rien écrire)

## Procédure (ordre STRICT — le backup précède toujours l'écrasement)

1. **Mesurer sans polluer le contexte.** Si `get_file` sur `wiki-meta/hot.md` risque de dépasser le plafond de contexte (fichier > ~20 Kio), NE PAS le charger en entier dans la conversation : passer par un script (Bash/python) qui appelle l'API **Local REST du vault lui-même** (GET/PUT — c'est la même API que le router utilise ; jamais d'écriture filesystem directe) et ne remonte que taille + structure (titres, dates des entrées, N premiers blocs).
2. **Backup vérifié** : copier byte-à-byte vers `wiki-meta/hot.full-backup-<YYYY-MM-DD-HHMM>.md` (horodatage à la minute — évite les collisions du jour). VÉRIFIER : relire la taille du backup et exiger l'égalité avec l'original. Échec de vérification → **STOP**, ne rien écraser.
3. **Sélectionner le contenu du hot mince** : les 3-6 faits les PLUS RÉCENTS (l'ordre du fichier se détecte par les dates — ne pas supposer), les chantiers actifs, et **obligatoirement** tout bloc épinglé (marqueur `📌`). Ce qui sort du cache reste retrouvable : backup + `journal.md` + `Sessions/` + notes liées.
4. **Rédiger** le hot mince ≤ cible (350 mots / 4 Kio) sur le gabarit : frontmatter d'origine (+ `updated:`) · rappel du contrat en tête · `## Last Updated` · `## Key Recent Facts` (entrées `> 🆕 **sujet** (date) — … · [[lien]]`) · `## Recent Changes` (≤ 5 lignes) · `## Active Threads`.
5. **Validation humaine** — OBLIGATOIRE si (a) première compaction du vault ET fichier > 5× la limite, (b) fichier sans dates exploitables, ou (c) doute sur des blocs épinglés qui ne tiennent pas dans la cible. Sinon : autonome (le backup vérifié rend l'opération réversible).
6. **Contrôle de concurrence** : juste avant d'écrire, re-mesurer l'original ; s'il a changé depuis l'étape 1 (autre session), **abandonner et recommencer** — ne jamais écraser une version non lue.
7. **Écrire** le hot mince (via `write_file` du router quand la taille le permet — laisse la trace MCP que le guard sait voir).
8. **Tracer** : entrée mince dans `wiki-meta/journal.md` (`## <date> — hot.md compacté · [[hot.full-backup-<date>]]` + 1 phrase FR + 1 phrase EN, tailles avant/après).

## Gardes-fous

- **Jamais de compaction sans backup vérifié** (étapes 2 avant 7, toujours).
- Les backups `hot.full-backup-*` sont EXCLUS du chargement au démarrage (ils ne sont pas `hot.md`) — ne pas les convertir en notes, ne pas les lier depuis l'index.
- Ne JAMAIS recopier l'intégralité d'un gros hot dans la conversation : travailler par blocs/scripts.
- Après compaction, le guard passe tout seul (la taille est re-mesurée sur disque — aucun « reçu » à poser).
