---
name: decision-consolidate
description: |
  Consolidate a SETTLED decision page (`accepted` / `superseded` / `rejected` — never `proposed`): compress the body to canon (verdict byte-intact, minimal why, alternatives as a table) and move the deliberation chronicle to a verified `archives/` note (`type: decision-archive`) excluded from recall and search. Compress + archive, never erase the why. Contract: meta-vault decision `consolidation-sans-amnesie` (accepted 2026-07-28).

  EN triggers: "consolidate this decision", "compress the decision page", "archive the deliberation", "this decision page is too long for the LLM".
  FR triggers : "consolide cette décision", "compresse la page de décision", "archive la délibération", "cette page de décision pollue le contexte".

  Example / Exemple:
    EN: "consolidate wiki/decisions/old-choice.md"
    FR: "consolide adr-modes-ecriture"
---

# decision-consolidate

Compression transactionnelle d'une page de décision **réglée**. Le contrat vient de la décision `consolidation-sans-amnesie` (acceptée par Roland le 2026-07-28) : **la chronique part, le pourquoi reste**. Ce qui est déplacé : le récit daté du débat, les citations, les revues croisées, les amendements successifs. Ce qui reste sur la page : le verdict (byte-intact), la raison du gagnant et la raison du rejet de chaque perdant (1 ligne chacune), les conséquences courtes.

## Argument parsing from $ARGUMENTS

- un chemin ou basename de page (obligatoire) — la décision à consolider
- un nom de vault (optionnel — défaut : vault courant / lock / `OBSIDIAN_ROUTER_DEFAULT_VAULT`)
- `--dry-run` → étapes 1-2 seulement : montrer le plan (ce qui reste / ce qui part) sans rien écrire

## Éligibilité (vérifier AVANT tout)

- `status` ∈ `accepted` | `superseded` | `rejected`. **REFUS sur `proposed`** (ou statut absent) : la délibération d'une page proposée est son matériau de travail. Le linter le confirme après coup (`consolidated-proposed`).
- Type `decision` / `adr` en cible principale. Une page d'un autre type (`idea`…) au statut réglé est admise : ses bandeaux d'état tiennent lieu de verdict et se préservent verbatim.
- Une page déjà porteuse de `consolidated:` ne se reconsolide pas sans raison nouvelle — signaler et s'arrêter.

## Procédure (ordre STRICT — l'archive précède toujours la réécriture)

1. **Lire la page** (`get_file` du router) et vérifier l'éligibilité ci-dessus.
2. **Délimiter** : verdict + pourquoi minimal + alternatives + conséquences → restent ; chronique (récit daté, citations, revues croisées, historiques d'amendement, versions bilingues longues) → part. En cas de doute sur un bloc, il RESTE (le biais est du côté de la conservation).
3. **Écrire l'ARCHIVE d'abord** : `<dossier-de-la-page>/archives/<slug>-deliberation.md` via `write_file`. Frontmatter : `type: decision-archive`, `source: "[[<slug>]]"`, `archived: <YYYY-MM-DD>`, `title:`. Corps : un bandeau (« Chronique déplacée depuis [[<slug>]] le <date> par consolidation — la page canonique reste la seule source du verdict ») puis les sections déplacées **verbatim**.
4. **Vérifier l'archive** (`get_file`) : les sections déplacées y sont intégralement. Échec ou doute → **STOP**, la page originale n'est pas touchée.
5. **Réécrire la page compacte** (`write_file`) : cible ≈ un écran (~≤ 4 Kio hors frontmatter). Frontmatter d'origine + `consolidated: <YYYY-MM-DD>` + `updated:` rafraîchi. Corps : verdict **byte-intact** (le champ `decision:` et les phrases/bandeaux de verdict se recopient à l'octet près — une consolidation ne reformule JAMAIS un verdict), pourquoi minimal (2-5 lignes), `## Alternatives considérées` en table (1 ligne par option), conséquences courtes, puis `## Historique` d'une ligne : `Chronique complète : [[<slug>-deliberation]] · consolidée le <date>`.
6. **Lint** : repasser la passe décision (skill `wiki-lint` ou le script du repo) — 0 nouvelle erreur, et ni `consolidated-without-history-link` ni `consolidated-invalid`.
7. **Tracer** : entrée mince dans `wiki-meta/journal.md` ; rafraîchir `wiki-meta/hot.md` si le garde le demande. L'index ne change PAS (la consolidation n'est pas un événement de cycle de vie — le statut de la page est inchangé).

## Gardes-fous

- **Jamais d'archive non vérifiée avant l'écrasement** (étapes 3-4 avant 5, toujours).
- **Verdict byte-identique** avant/après — comparer, pas estimer.
- Le lien `## Historique → [[<slug>-deliberation]]` est **obligatoire** : sans pointeur, « compressé » dégénère en « effacé ».
- Les archives sont hors recall (leur `type` n'est pas un type décision) et hors `search_smart` par défaut (segment `archives/`, v0.54.0 — `includeArchives: true` pour les revoir). Ne pas les convertir en notes de contenu, ne pas les lier depuis l'index.
- Les nouvelles décisions s'écrivent compactes d'emblée (chronique dans `wiki-meta/Sessions/` dès le jour 1) — ce skill est le rattrapage des pages qui ont grossi, pas le régime courant.

## On failure

Toute écriture passe par les outils du router. Erreur de connexion (`ECONNREFUSED`, timeout) → demander l'ouverture du vault et ATTENDRE ; erreur de validation → corriger l'appel. **Jamais de fallback filesystem** : il contournerait l'API, perdrait le `clickToOpenUrl` autoritatif et sauterait les garde-fous du router.
