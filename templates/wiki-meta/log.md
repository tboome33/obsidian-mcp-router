---
type: log
title: "Wiki Log"
---

# Wiki Log

Append-only history of operations. Newest at the bottom. Every entry is a single line:

```
- YYYY-MM-DD HH:MM — <verb> — <target(s)> — <reason>
```

Verbs: `scaffold`, `ingest`, `save`, `lint`, `fold`, `query-filed`, `autoresearch`, `session`, `migrate`.

> Note (v0.12.8+) : les entrées `session` sont auto-générées par le hook `session-auto-journal.mjs` au SessionEnd. Format 2-lignes : ligne 1 = standard (`- date HH:MM — session — [[<session-basename>]] — <objectif>`), ligne 2 = continuation indentée 2 espaces avec le résultat heuristique (`  → <result one-line>`). Le détail complet de la session vit dans `wiki-meta/Sessions/<basename>.md`. Pour upgrader un résumé heuristique en synthèse LLM polish, utilise `/save` sur le fichier Sessions correspondant.

---

- {{TIMESTAMP}} — scaffold — index.md, log.md, hot.md, overview.md, CLAUDE.md — initial wiki bootstrap
