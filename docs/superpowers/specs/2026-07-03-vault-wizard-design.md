# Design — Wizard guidé de création de vault (moteur 3 couches)

**Date** : 2026-07-03 · **Statut** : approuvé par Roland (brainstorming complet, 3 sections validées) · **Session d'origine** : brainstorming Fable 5, analyse préalable par workflow 4 agents (digests dans le scratchpad de session, synthèse reproduite ici).

## 1. But

Quand on crée un nouveau vault Obsidian local (typiquement lié à un nouveau workspace de code), l'utilisateur doit être **guidé** : nom du vault, emplacement, source de template (`.template` local, copie d'un vault existant, skeleton GitHub, vierge), thème, sélection de plugins, mode de wiki, conventions, installation des slash commands dans le workspace — avec des **défauts intelligents** pour que le chemin heureux tienne en une seule interaction. Le wizard doit fonctionner **quel que soit le harnais LLM** (Claude Code, Codex, Hermes, Deepseek…).

## 2. Décisions actées (brainstorming 2026-07-03)

| # | Question | Décision |
|---|---|---|
| Q1 | Où vit l'interactivité ? | **Moteur 3 couches** : CLI à flags (couche 0) + outils MCP `plan_vault`/`provision_vault` (couche 1, universelle) + frontends fins (couche 2 : skill Claude Code + playbook markdown) |
| Q2 | Sources de template | **Les 4, séquencées** : (a) référence `.template` locale [défaut] · (b) copie config d'un vault existant · (c) skeleton GitHub frais · (d) vierge minimal. Livraison : (b) d'abord, (c) ensuite. Pas de système de templates nommés multiples tant qu'il n'y a pas 2+ vrais templates |
| Q3 | Copie depuis un vault existant | **Config seule** (plugins, thèmes, snippets, appearance, `.smart-env`, `CLAUDE.md`) — le but est de garder la **structure**, pas de cloner le vault. Scaffolds `wiki-meta/` **neufs et vides** (logs, index vierges). Jamais de contenu `wiki/` (pas même en opt-in dans cette itération). Option fine `--with-folder-tree` : recréer l'arborescence de dossiers de `wiki/` à vide |
| Q4 | Thème | **Picker parmi les thèmes réellement installés dans la source** + « défaut Obsidian », pré-sélection = thème de la source. Accent color en option avancée. Dépend du chantier Lot 2 (`cloneThemes()` + écriture `cssTheme`) en cours dans une autre session |
| Q5 | Slash commands dans le workspace | **Question opt-in pré-cochée** mentionnant le coût (~10k tokens de contexte/session). Si oui : vérifier `extraKnownMarketplaces` global + merge idempotent de `enabledPlugins` dans le `.claude/settings.json` du workspace |
| Q6 | Fin de flux | **Ouverture programmée d'Obsidian** (`Start-Process obsidian://…`) + **probe automatique** post-« Trust author » (poll REST + sonde `/open/*`, mécanique `meta-audit-bridge-readiness`) → verdict ✅/🔴 avec fix suggéré → rappel « redémarre Claude Code » |
| Q7 | Plugins optionnels | **3 profils** : Recommandé (set complet de la source) / Minimal (REQUIRED seuls) / Custom (multiselect) |
| Q8 | Symétrie avec le wizard cloud Kiviri | **Deux wizards indépendants.** Pas de spec commune : le wizard local est conçu pour lui-même ; le cloud fera son propre design (le local sert de retour d'expérience UX, rien de plus) |

## 3. Architecture

```
┌─ Couche 2 · Frontends ────────────────────────────────────┐
│  Skill meta-attach-vault v2 (Claude Code, defaults-first) │
│  Playbook docs/vault-wizard.md (harnais sans skills)      │
├─ Couche 1 · MCP (universel : tout client MCP) ────────────┤
│  plan_vault      → questionnaire structuré + défauts       │
│  provision_vault → applique les réponses en 1 appel        │
├─ Couche 0 · Moteur ───────────────────────────────────────┤
│  setup-vault.mjs enrichi (flags §5) — scriptable, testé   │
└────────────────────────────────────────────────────────────┘
```

Principe clé : `plan_vault` ne pose aucune question — il **renvoie les données du questionnaire** (options détectées, défauts calculés, descriptions). C'est le LLM du harnais, quel qu'il soit, qui conduit la conversation dans sa propre UI puis appelle `provision_vault`. Le wizard vit dans les données, pas dans le harnais.

## 4. Expérience utilisateur

### 4.1 Pattern « défauts d'abord » (defaults-first)

Le wizard calcule un plan complet par défaut et l'affiche d'emblée :

> **Plan proposé** : vault « MonProjet » → `C:\VAULTS\MonProjet` · source : `.template` · plugins : profil Recommandé (12) · thème : Blue Topaz · mode wiki : code · conventions : les 4 recommandées · slash commands workspace : oui (~10k tokens/session)
> **OK tel quel, ou tu veux ajuster quelque chose ?**

Happy path = **1 interaction**. Chaque point est ajustable individuellement (question ciblée avec options).

### 4.2 Étape « mode wiki » — exigence explicite

Le mode calculé s'affiche dans le plan avec sa justification (ex. « `code` — déduit car vault lié à un repo de dev »). **En cas d'ajustement, les 5 modes sont TOUS présentés, chacun avec sa brève explication** :

- 🧠 `personal` — second cerveau : personnes, concepts, décisions, références, projets perso
- 🔬 `research` — étude d'un sujet : papers, concepts, hypothèses, méthodologie
- 💼 `business` — activité : concurrents, clients, décisions, parties prenantes
- 💻 `code` — lié à un repo : codebases, décisions d'architecture (ADR), runbooks
- 🎯 `domain` — sur mesure : l'utilisateur décrit le domaine en une phrase, les sections d'index sont générées pour lui

Défauts : `code` si flux workspace-first, `personal` si standalone. `plan_vault` renvoie les 5 entrées `{id, label, description, isDefault}` pour que tout harnais affiche les mêmes explications. Divergence assumée avec le skill `wiki` actuel (qui recommande de ne proposer que 2-3 modes) : le flux « création guidée » énumère tout, le flux « scaffolding rapide » reste sélectif.

### 4.3 Fin de flux

1. Provisioning en un appel moteur (le pre-flight montre le `--dry-run` réel)
2. Ouverture programmée d'Obsidian (`--open`)
3. Geste incompressible utilisateur : clic « Trust author and enable plugins »
4. Probe automatique (`--probe`) : poll du port REST + sonde `/open/*` → verdict ✅/🔴 + fix suggéré
5. Dernière ligne : « redémarre Claude Code pour voir le vault »

## 5. Couche 0 — nouveaux flags du moteur (`scripts/setup-vault.mjs`)

| Flag | Comportement |
|---|---|
| `--name "<Nom>"` | Nom d'affichage ; slug dérivé (lowercase) ; écrit `vaultNames` en config.json si nom ≠ basename du chemin ; collision de slug (registre/`vaultNames`) → erreur explicite + suggestion |
| `--from-vault <slug\|path>` | Source = vault existant, **config seule** : `.obsidian/` (plugins, thèmes, snippets, appearance) + `.smart-env` + `CLAUDE.md`. **Exclusions dures** : `workspace.json` (état UI privé), `data.json` des plugins à secrets (gardes `CREDENTIAL_LEAK_PLUGINS` réappliquées — port + clé API **toujours** régénérés). Scaffolds `wiki-meta/` neufs et vides (comportement `scaffoldWikiMeta()` inchangé). Option `--with-folder-tree` : recrée l'arborescence de dossiers de `wiki/` à vide, sans aucune note |
| `--from-skeleton` | Source = `templates/reference-vault-skeleton/` du repo + téléchargement du bridge depuis GitHub releases (réutilise la mécanique `--bootstrap-reference`) |
| `--bare` | Vault vierge minimal : les 2 REQUIRED seuls (`obsidian-local-rest-api`, `mcp-router-bridge`) |
| `--plugins recommended\|minimal\|custom:a,b,c` | Profils Q7. `recommended` = le set complet de la source (dérivé, cf §6.2) ; `minimal` = REQUIRED ; `custom` = liste explicite (REQUIRED toujours inclus) |
| `--theme "<nom>"\|obsidian-default` | Écrit `cssTheme` dans `appearance.json`. **Dépend du Lot 2** (chantier `cloneThemes()` d'une autre session — consommer, ne pas réimplémenter) |
| `--wiki-mode personal\|research\|business\|code` | Seed d'`index.md`/`overview.md` par mode (paramétrisation des templates `templates/wiki-meta/`) |
| `--wiki-sections "A,B,C"` | Pour le mode `domain` : le frontal (LLM) traduit la description utilisateur en sections et les passe en liste plate — le moteur reste 100 % déterministe, sans IA |
| `--claude-workspace` | Écrit le `.claude/settings.json` du **workspace** (merge idempotent de `enabledPlugins`) + vérifie/écrit `extraKnownMarketplaces` global. Comble la lacune n°1 du flux actuel (le vault reçoit ses slash commands via `cloneRootDocs`, le workspace jamais) |
| `--open` | `Start-Process obsidian://open?vault=…` post-provisioning |
| `--probe [--probe-timeout N]` | Poll du port REST + sonde `/open/*` (réutilise la mécanique de `scripts/meta-audit-bridge-readiness.mjs`) → verdict + rapport JSON, code de sortie non-zéro si rouge |
| `--dry-run` | Plan complet sans mutation (JSON avec `--json`) — consommé par le pre-flight de la skill ET par `plan_vault` |
| `--json` | Sortie machine pour toutes les opérations wizard |
| *(option avancée)* `--git-init` | `git init` + commit initial du vault post-scaffold. **Non par défaut** (vaults souvent sous Google Drive/iCloud) |

Invariants préservés : mode adoption (port/clé existants), `scaffoldWikiMeta` no-clobber, un seul appel = un seul permission prompt, `maybeAutoInstallHooks` inchangé.

## 6. Phase W0 — corrections préalables (avant toute feature)

1. **Bug root docs** : `cloneRootDocs()` attend `README.md` + PDFs quick-reference à la racine du `.template` ; ils ont été déplacés dans `Documentation/` → le clone ne trouve plus rien. Corriger la liste/le chemin.
2. **Drift plugins → refactor « dérivé de la source »** : 6 plugins du skeleton WIP (realclaudian, image-converter, icon-folder, recent-files, rich-text-editor, style-settings) sont activés dans `community-plugins.json` mais absents d'`OPTIONAL_PLUGINS` → « activés mais jamais clonés ». Fix structurel : **la liste de clonage dérive du `community-plugins.json` de la source** ; la constante ne sert plus qu'à vérifier les 2 REQUIRED. Résout le drift définitivement (tout plugin ajouté au template est automatiquement propagé).
3. **Coordination Lot 2 (thème)** : une autre session travaille (non committé au 2026-07-03) sur le skeleton Blue Topaz + `cloneThemes()` + écriture `cssTheme`. Le `--theme` du wizard **consomme** ce chantier. À son atterrissage : réaligner le `.template` (aujourd'hui thème Prism) sur Blue Topaz. **Vérifier l'état de ce chantier avant de commencer W1** (il touche `scripts/setup-vault.mjs` et `templates/reference-vault-skeleton/` — risque de conflit, staging sélectif obligatoire).

## 7. Couche 1 — outils MCP

### 7.1 `plan_vault` *(lecture seule, zéro mutation)*

- **Entrée** : `{ workspace?: string, vaultPath?: string, name?: string }` — tout optionnel, le tool détecte le contexte (flux workspace-first si `.git/` sans binding, standalone sinon).
- **Sortie** :
  - `context` : flux détecté, git présent, binding existant éventuel (rebind warning), racines de vaults connues.
  - `defaults` : nom, slug, chemin, source, profil plugins, thème, mode wiki, conventions pré-cochées, claudeWorkspace.
  - `questions[]` : chaque question avec `{ id, label, description, options: [{id, label, description, isDefault}] }` — inclut les 5 modes wiki avec explications, les thèmes réellement installés dans la source, les vaults copiables du registre, les profils de plugins avec le détail des plugins de la source.
  - `warnings[]` : collisions de slug, port, chemin existant non-vide, etc.
- **Implémentation** : introspection + moteur en `--dry-run --json`.

### 7.2 `provision_vault`

- **Entrée** : les réponses — `{ name, path, source: {kind: 'reference'|'from-vault'|'skeleton'|'bare', fromVault?}, plugins: {profile, custom?}, theme?, wikiMode: {mode, sections?}, conventions: [], claudeWorkspace: bool, open: bool, gitInit?: bool }`.
- **Sortie** : rapport étape par étape (statut par étape), `port`, `insecurePort`, `openUri`, `probeResult`.
- Compose l'appel moteur ; mêmes gardes que `setupVault()`.

### 7.3 Gates de sécurité (non négociables)

- Ces outils écrivent sur le filesystem local → **exposés uniquement sur un router local non-gated**. Si `OBSIDIAN_ROUTER_USER_ID` est défini (déploiement gated : MCPHub/Tribu), les deux outils sont **absents de la liste des tools** (même pattern que la gate `MD_ALLOWED_PATHS`).
- `provision_vault` refuse tout chemin hors des racines de vaults connues (config `vaultsRoot` + racines du `portRegistry`) sauf opt-in explicite — pas de mkdir/écriture arbitraire pilotable à distance.
- La copie `--from-vault` réapplique les exclusions de secrets quelle que soit la couche appelante.

## 8. Couche 2 — frontends

- **Skill `meta-attach-vault` v2** : frontal mince — appelle `plan_vault` (ou moteur `--dry-run`), présente le plan « défauts d'abord », collecte les ajustements, compose UN `provision_vault`. Conserve le didactique existant (pédagogie git, pre-flight explicatif, picker de conventions inchangé, `.gitignore` du workspace).
- **Playbook `docs/vault-wizard.md`** : documente la même séquence pour les harnais sans système de skills (l'agent lit le playbook, appelle les outils MCP).

## 9. Phasage

| Phase | Contenu | Effort | Dépendances |
|---|---|---|---|
| **W0** | Fix root docs + refactor plugins-dérivés-de-la-source | S | vérifier l'état du Lot 2 (conflits potentiels) |
| **W1** | Flags moteur (`--name`, `--from-vault`, `--bare`, `--plugins`, `--wiki-mode`/`--wiki-sections`, `--claude-workspace`, `--open`, `--probe`, `--dry-run`/`--json`) + tests | M/L | `--theme` attend le Lot 2 ; `--from-skeleton` réutilise `--bootstrap-reference` |
| **W2** | `plan_vault` + `provision_vault` + gates sécurité + tests | M | W1 |
| **W3** | Skill v2 defaults-first + playbook + doc README | M | W2 |

Chaque phase = une release complète (tests, CHANGELOG, bump via `npm run bump`, `/review+` sur les grosses).

## 10. Impact roadmaps (vault `opsidian-mcp-router et bridge`)

1. Nouvelle page roadmap `wiki/obsidian-mcp-router/vault-wizard-roadmap.md` (phases W0-W3 en checkboxes).
2. `saas-web-app-roadmap` Phase 2 : un item léger « wizard de création de vault guidé dans l'app web — design propre au cloud (décision Q8 : wizards indépendants), le wizard local sert de retour d'expérience UX ».
3. Scaffolds : entrée d'index, ligne de log, hot.

## 11. Hors périmètre (non-goals explicites)

- Pas de spec commune local/cloud (Q8) — le wizard Kiviri fera son propre design.
- Pas de système de templates nommés multiples (attendre 2+ vrais templates).
- Pas de copie du contenu `wiki/` dans `--from-vault` (structure/config seulement).
- Pas de `git init` du vault par défaut (option avancée opt-in).
- `.wikiignore` : rien à faire (aucun mécanisme wizard requis).
- Le mode interactif TTY du CLI : non retenu (les agents shell sont non-interactifs ; l'interactivité vit dans les couches 1-2).

## 12. Critères de succès

- Créer un vault complet depuis un nouveau workspace en **1 interaction** (plan par défaut accepté) + les 2 gestes incompressibles (Trust author, restart Claude Code), avec verdict de santé automatique à la fin.
- `--from-vault` produit un vault avec la même config visuelle/plugins que la source, **zéro secret copié** (clé API différente, port différent), scaffolds vierges.
- Un agent NON-Claude (test : Codex ou appel MCP brut) peut dérouler le wizard complet via `plan_vault`/`provision_vault` sans lire le code.
- Suite de tests verte, aucun changement de comportement pour les invocations existantes de `setup-vault.mjs` (rétrocompatibilité totale des flags actuels).

## 13. Fichiers touchés (prévision)

```
scripts/setup-vault.mjs                    (flags W1, refactor W0)
src/tools/plan-vault.mjs                   (nouveau, W2)
src/tools/provision-vault.mjs              (nouveau, W2)
src/index.mjs                              (enregistrement gated des 2 tools, W2)
skills/meta-attach-vault/SKILL.md          (v2, W3)
docs/vault-wizard.md                       (playbook, W3)
templates/wiki-meta/*.md                   (paramétrisation par mode, W1)
tests/setup-vault-*.test.mjs, tests/plan-vault.test.mjs, tests/provision-vault.test.mjs
```
