## Roadmap discipline — création + maintenance dans le vault courant

Cette règle s'applique à toutes les roadmaps de ce vault (`wiki/**/*-roadmap.md`). Elle existe pour éviter le drift entre "ce qui est fait" (commits sur le projet) et "ce que la doc dit" (cases cochées dans la roadmap).

### 1. Quand l'user demande une roadmap

Triggers : *"fais-moi une roadmap pour X"*, *"écris la roadmap de Y"*, *"plan phasé pour Z"*, équivalents EN.

Procédure obligatoire :

1. **Identifier le vault courant** (via `list_vaults` + `defaultVault`, ou `OBSIDIAN_ROUTER_LOCKED`, ou contexte du cwd).
2. **Créer la roadmap DANS ce vault** — jamais dans `~/.claude/plans/`, jamais inline-chat sans persistance, jamais dans un repo de code séparé.
3. **Path conventionnel** : `wiki/<projet>/<projet>-roadmap.md` (vault project-based) OU `wiki/Projects/<projet>-roadmap.md` (vault personal-mode) selon la convention de folders du vault.
4. **Frontmatter minimal** : `type: roadmap`, `project: <slug>`, `status: active`, `created: <YYYY-MM-DD>`, `updated: <YYYY-MM-DD>`, `source_type: inferred` (si la convention `source-type` est installée).
5. **Structure minimale** :
   - H1 avec titre projet
   - Section "Légende" (✅ livré · 🚧 planifié · 🔮 idée)
   - Phases en H2, items en checkbox `- [ ]`
   - Phases déjà livrées préfixées `✅ · livré <date> (v<version>)` au H2
   - Section finale "Ordre d'attaque recommandé" pointant la prochaine étape
6. **Append au `wiki-meta/log.md`** : `## <date> — roadmap <projet> créée`.

### 2. Quand du code/doc est shippé qui ferme un checkbox

À chaque commit/ship qui implémente un item :

1. **Toggle** le `- [ ]` en `- [x]` avec note de fin (commit SHA, test count, fichiers touchés).
2. **Update le header de phase** : ajouter `✅ · livré <YYYY-MM-DD> (v<X.Y.Z>)` au H2 si toute la phase est livrée.
3. **Refresh `updated:`** dans le frontmatter.
4. **Update "Ordre d'attaque recommandé"** si la prochaine étape change.
5. **Append au `wiki-meta/log.md`** une ligne bilingue traçant l'update.

### 2bis. Lisibilité — JAMAIS de strikethrough sur les items livrés

Quand un item est livré, le seul changement visuel autorisé est :
- `- [ ]` → `- [x]` (la case cochée suffit comme signal de complétion)
- Optionnellement une note de fin en italique sur la ligne suivante (date, commit, fichiers)

**INTERDIT** :
- ❌ Wrapper le texte de l'item dans `~~...~~` (strikethrough markdown)
- ❌ Wrapper le H2 d'une phase livrée dans `~~...~~`
- ❌ Wrapper la note de fin dans `~~...~~`
- ❌ Tout autre formatage qui dégrade la lisibilité du texte historique

**Raison** : une roadmap se relit constamment pour comprendre l'historique du projet. Le texte rayé est pénible à lire (surtout en bloc), perd les keywords scannables visuellement, et brise le grep/Ctrl+F côté humain. La checkbox cochée `- [x]` est déjà 100% suffisante pour signaler "fait" — c'est la convention markdown universelle.

**À appliquer aussi rétroactivement** : si tu tombes sur une roadmap existante qui contient du `~~strikethrough~~` sur des items cochés, propose de nettoyer en passant. Ne le fais pas en silence sur une autre tâche — mentionne-le et laisse l'user trancher si le scope du nettoyage est ok pour la session courante.

### 3. Pre-flight check avant d'annoncer "Phase X done"

Avant de répondre au user avec "Phase X terminée" / "shipping complet" :

1. Re-read la roadmap via `get_file`.
2. Vérifier que tous les checkboxes couverts sont `- [x]`.
3. Vérifier que le header de phase porte `✅` + date + version.
4. Si quoi que ce soit reste `- [ ]` → corriger PUIS annoncer.

### Anti-patterns

- ❌ Roadmap inline chat sans persistance vault
- ❌ Roadmap dans `~/.claude/plans/` ou dossier non-vault
- ❌ Ship code sans toucher roadmap (drift silencieux)
- ❌ Update partielle (H2 sans cocher les `- [ ]` détaillés)
- ❌ Oublier `updated:` dans le frontmatter
- ❌ Annoncer "Phase X done" sans pre-flight check
- ❌ Rayer le texte des items livrés avec `~~...~~` (cf. section 2bis — la checkbox cochée suffit, le strikethrough tue la lisibilité historique)

### Source

Convention shippée en v0.9.1 du router (2026-05-21) à la demande explicite de Roland après observation de drift répété entre code shippé et roadmaps non mises à jour. Section 2bis (no-strikethrough) ajoutée en v0.10.1 (2026-05-21) après *"quand dans une roadmap tu marques que section est déjà réalisée, est ce que tu peux seulement faire un check sur la case à cocher mais ne pas rayer tout le texte sans quoi on a du mal à relire"*. La même règle vit aussi dans le `~/.claude/CLAUDE.md` global de l'user pour application par défaut sans installation per-vault.
