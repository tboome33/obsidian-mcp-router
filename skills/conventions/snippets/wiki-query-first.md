## Wiki-query-first reflex — check the vault BEFORE answering

Cette règle dit à Claude que **dans une session où le workspace est un vault Obsidian** (présence de `wiki/index.md`), il doit **chercher dans le wiki avant de composer sa réponse** à toute question substantielle. L'historique de discussions, décisions, références, sessions est dans le vault — répondre sans le consulter gaspille ce capital et risque de contredire/dupliquer ce qui existe déjà.

This rule tells Claude that **in a session where the workspace IS an Obsidian vault** (presence of `wiki/index.md`), it must **search the wiki before composing its answer** to any substantive question. The history of discussions, decisions, references, sessions lives in the vault — answering without consulting it wastes that capital and risks contradicting/duplicating what already exists.

### Trigger

Toute question substantielle de l'user dans une session vault-bound. Une question est "substantielle" si elle dépasse le suivi trivial (oui/non/ok/merci/continue/lettre seule), n'est pas une slash command (`/...`), et n'est pas un fix typo / control reply.

### Procédure obligatoire — pre-answer flow

1. **Catalog scan** : lire `wiki/index.md` pour voir le catalogue des pages organisées par projet/dossier. Identifier les sections potentiellement liées au prompt.
2. **Direct read** : si une page semble pertinente, la lire directement via `mcp__obsidian-router__get_file`.
3. **Semantic search** : pour des sujets fit-by-meaning (pas par exact keyword match), lancer `mcp__obsidian-router__search_smart` avec les keywords du prompt (omit `vault:` pour utiliser le default vault).
4. **Cite + enrich** : référencer les notes trouvées dans la réponse en utilisant le format click-to-open (`[label](http://127.0.0.1:<insecurePort>/open/<URL-encoded-path>)` — voir la convention `Obsidian vault links` du CLAUDE.md global). Bâtir la réponse au-dessus du contexte existant plutôt que from scratch.

### Skip-conditions (légitimes — pas besoin de wiki-query)

- Prompt trivial (oui / non / merci / continue / single letter answer à une AskUserQuestion / typo fix)
- Slash command (`/save`, `/wiki-query`, etc. — la skill gère elle-même son scope)
- Workspace n'est PAS un vault (présence de `wiki/index.md` absente)
- L'user explicitement dit *"sans chercher dans le vault, réponds-moi directement à X"* ou équivalent

### Anti-patterns

- ❌ Répondre à *"comment fait-on X"* en pure inference sans vérifier `wiki/Refs/X-howto.md` qui pourrait avoir la procédure verbatim
- ❌ Composer une recommandation architecturale sans lire `wiki/Decisions/` qui contient peut-être déjà cette décision et ses trade-offs
- ❌ Démarrer une nouvelle session sur un projet sans relire `wiki/hot.md` (déjà chargé par `hot-cache-load` hook si activé) ET `wiki/Sessions/` récentes
- ❌ Skip la check parce que "ça prend du temps" — typiquement un `get_file` + un `search_smart` coûte ~3 secondes vs des minutes de rework si on rate du contexte existant

### Mécanisme technique

Le hook `wiki-query-first-nudge.mjs` (UserPromptSubmit, v0.11.5+) injecte automatiquement un rappel dans le contexte de Claude au moment où l'user submit son prompt, SI le workspace est un vault ET le prompt est substantiel. Defense-in-depth contre l'oubli — la règle est dans le contexte (via cette convention installable + le `~/.claude/CLAUDE.md` global), mais le hook garantit que le trigger fire au bon moment, hors LLM attention loop.

Opt-out per-session : `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`.

### Exemple concret (audit trail)

Roland 2026-05-23 a observé : dans une session sur le vault DEDIBOX, il a demandé *"je veux créer une connexion RDP depuis mon pc maison vers mon pc cabinet via WireGuard"*. Claude a lu `roadmap_dedibox.md` mais a manqué `wiki/Refs/dedibox-rdp-pc-cabinet.md` qui contenait EXACTEMENT la procédure pour ce scénario (peer WG 10.8.0.20, RDP via Dedibox comme bastion, install steps). Roland a dû le pointer manuellement : *"tu es allé consulter ceci `obsidian://open?vault=DEDIBOX&file=wiki%2FRefs%2Fdedibox-rdp-pc-cabinet`?"*. Le wiki-query-first reflex aurait catch ce cas — un `search_smart` sur "RDP cabinet WireGuard" aurait surfacé la note immédiatement.

### Notes opérationnelles

- **Coût** : un cycle de pre-answer investigation = ~1-3 tool calls (`get_file` `wiki/index.md` souvent déjà chargé par `hot-cache-load` → `search_smart` 1 fois → `get_file` 0-1 fois sur la note candidate). Latence ajoutée ~2-5s avant la première réponse de Claude. Acceptable vs le coût d'une réponse qui rate du contexte.
- **Granularité** : la procédure ne dit PAS de re-search à chaque follow-up du même thread (Claude garde le contexte cross-turn dans son context window). C'est uniquement au DÉBUT d'une nouvelle thématique qu'on cherche.
- **Defense-in-depth** : cette convention vit en 3 endroits — (a) cette installation per-vault via `/obsidian-router:conventions install wiki-query-first`, (b) la section globale dans `~/.claude/CLAUDE.md`, (c) le hook `wiki-query-first-nudge` v0.11.5+. Couches redondantes intentionnellement.

### Historique

Ajoutée 2026-05-23 (router v0.11.5) après l'observation Roland citée ci-dessus. Pattern reconnu : c'est le 3e cas de "Claude oublie une règle de contexte au moment de l'application" (après vault-link-linter v0.11.3 pour les liens cliquables et doc-propagation-checker v0.11.4 pour les docs post-commit). Le pattern de fix est maintenant codifié : (1) convention installable, (2) section globale CLAUDE.md, (3) hook déterministe sur l'event approprié (Stop / PostToolUse / UserPromptSubmit selon le moment du trigger).
