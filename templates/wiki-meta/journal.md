---
type: log
title: "Wiki Journal"
---

# Wiki Journal

Append-only history of operations. Newest at the bottom. Every entry is a single line:

```
- YYYY-MM-DD HH:MM — <verb> — <target(s)> — <reason>
```

Verbs: `scaffold`, `ingest`, `save`, `lint`, `fold`, `query-filed`, `autoresearch`, `session`, `migrate`.

> Note (v0.12.8+) : les entrées `session` sont auto-générées par le hook `session-auto-journal.mjs` au SessionEnd. Format 2-lignes : ligne 1 = standard (`- date HH:MM — session — [[<session-basename>]] — <objectif>`), ligne 2 = continuation indentée 2 espaces avec le résultat heuristique (`  → <result one-line>`). Le détail complet de la session vit dans `wiki-meta/Sessions/<basename>.md`. Pour upgrader un résumé heuristique en synthèse LLM polish, utilise `/save` sur le fichier Sessions correspondant.

## Entrées milestone curées (`## H2`)

Au-delà du log d'opérations d'une ligne ci-dessus, tu peux ranger un **milestone curé** comme une entrée `## H2` MINCE : un résumé bilingue court qui lie un journal détaillé dans `wiki-meta/Sessions/`. Garde le log mince ; le détail vit dans le fichier lié.

~~~
## YYYY-MM-DD — <sujet> · [[YYYY-MM-DD-<slug>]]
**FR** — <une phrase>   **EN** — <one sentence>
~~~

JAMAIS de détail multi-paragraphe directement sous un `## H2` du log. Le détail (commits, fichiers, gotchas) va dans le fichier `Sessions/` lié. Voir la convention `log-discipline` (`/obsidian-router:conventions install log-discipline`).

---

- {{TIMESTAMP}} — scaffold — catalog.md, journal.md, hot.md, overview.md, CLAUDE.md — initial wiki bootstrap
