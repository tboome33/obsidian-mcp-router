## Log discipline — index mince + détail dans wiki-meta/Sessions/

`wiki-meta/log.md` est un **INDEX**, pas l'archive. Son rôle : une entrée scannable par milestone, chacune liée à un journal détaillé. Le détail (paragraphes, SHA de commits, listes de fichiers, gotchas) vit dans `wiki-meta/Sessions/`, **jamais** empilé dans le log.

Cette règle existe parce que le log dérive vite : des entrées `## date — sujet` de plusieurs paragraphes bilingues s'y accumulent et le rendent illisible (sur le vault router : 277 KB / 118 entrées grasses avant nettoyage le 2026-06-02 → 60 KB d'index + 117 fichiers détail).

### Format d'une entrée de log (append en bas — le plus récent en dernier)

~~~
## YYYY-MM-DD — <sujet court> · [[YYYY-MM-DD-<slug>]]
**FR** — <une phrase de résumé>
**EN** — <one-sentence summary>
~~~

- Le `· [[YYYY-MM-DD-<slug>]]` pointe vers le fichier détaillé dans `wiki-meta/Sessions/`.
- Le résumé bilingue = **une phrase** max par langue. Si tu as besoin de plus, c'est que ça doit aller dans le fichier Sessions/, pas dans le log.
- Mono-langue toléré pour les entrées triviales (bootstrap, fix typo).
- Append en **bas** (le log est append-only, cohérent avec le hook `session-auto-journal` et `/save`). Ne pas prepend en haut.

### Le fichier détaillé (`wiki-meta/Sessions/YYYY-MM-DD-<slug>.md`)

Frontmatter minimal :

~~~yaml
---
type: session-log
date: YYYY-MM-DD
status: captured
source_type: extracted | inferred
tags: [session]
related: ["[[page-a]]", "[[page-b]]"]
---
~~~

Corps : `# YYYY-MM-DD — <sujet>` puis le détail complet (FR/EN, commits, fichiers, décisions, gotchas), terminé par une section `## Voir aussi / See also` listant les wikilinks + `⟵ [[log]]`.

### Ce qui écrit DÉJÀ correctement (ne pas dupliquer)

- **Hook `session-auto-journal`** — append au SessionEnd une ligne mince `- date HH:MM — session — [[<basename>]] — objectif → résultat` ET crée le fichier chronologique brut dans `Sessions/`. C'est le filet automatique, déjà conforme.
- **Skill `/save`** — écrit déjà une entrée d'une ligne + un document poli ailleurs.
- **Seul comportement à corriger** : Claude qui colle du détail multi-paragraphe directement sous un `## H2` du log pendant une session. → le détail va dans `Sessions/`, le log reste mince.

### Anti-patterns

- ❌ Coller 2 paragraphes bilingues sous un `## H2` du log (l'ancien drift)
- ❌ Dupliquer dans le log ce qui est déjà dans le fichier Sessions/ lié
- ❌ Oublier le `· [[lien]]` vers le détail
- ❌ Prepend en haut : le log est append-only, le récent va en bas

### Pourquoi (audit trail)

Ajoutée 2026-06-02 après Roland : *« le fichier log décrit toutes les sessions en détail alors qu'il faudrait juste un petit résumé bilingue, et chaque entrée devrait renvoyer aux sessions bien décrites dans wiki-meta/Sessions »*. Le nettoyage rétroactif a converti 118 entrées grasses (277 KB) en index mince (60 KB) + 117 fichiers détail (backup intégral : `wiki-meta/log.full-backup-2026-06-02.md`).
