# 13 · Installation et administration

Tout ce qui installe, crée, attache, diagnostique, synchronise et met à jour — le cycle de vie du router et des vaults. La plupart de ces opérations sont conversationnelles : décrivez ce que vous voulez, la skill correspondante déroule la procédure.

## `/meta-setup` — installer le router sur une machine

**Le besoin.** Le premier quart d'heure : cloner, lier le binaire, enregistrer le MCP, sans se tromper dans les fichiers de config de Claude.

**Ce que ça fait.** Déroule l'installation complète : clone du repo, `npm install` + `npm link`, enregistrement du binaire dans `~/.claude.json` (user scope), et vérifications. Détecte aussi un budget de listing de skills trop petit (symptôme : *« Skill listing will be truncated »* au démarrage) et propose la correction (`skillListingBudgetFraction: 0.05`).

**Comment l'utiliser.**

> « installe le router sur cette machine », « setup obsidian-mcp-router » — ou `/obsidian-router:meta-setup`

**À savoir.** L'installation a deux moitiés : le **serveur MCP** (les ~40 outils) et le **plugin Claude Code** (les slash commands + skills). Le plugin s'active **par workspace**, pas globalement — il coûte ~10k tokens de contexte par session, qu'on ne veut payer que là où on utilise Obsidian. Détail pas à pas : section Install du [README](../../README.md).

## Le vault de référence — le modèle de tous les autres

**Le besoin.** Chaque nouveau vault a besoin du même socle : plugins (Local REST API, bridge, Smart Connections, Templater), snippets CSS, docs racine. Le refaire à la main à chaque vault ne passe pas à l'échelle.

**Ce que ça fait.** Un vault spécial enregistré comme **référence** détient le jeu canonique de plugins et de config ; `setup-vault.mjs` le clone dans chaque nouveau vault. Bootstrap en une commande depuis le squelette livré :

```bash
node scripts/setup-vault.mjs --bootstrap-reference <chemin>
```

(scaffolde le squelette [`templates/reference-vault-skeleton/`](../../templates/reference-vault-skeleton/) et télécharge le plugin bridge). Procédure complète et dépannage : [`docs/reference-vault-setup.md`](../reference-vault-setup.md).

## `/meta-attach-vault` — le wizard de création et d'attachement

**Le besoin.** « Configure Obsidian pour ce projet » recouvre en réalité une dizaine d'étapes : créer ou choisir le vault, provisionner les plugins, scaffolder le wiki, lier le workspace, ajuster le `.gitignore`, choisir les conventions. On veut un guichet unique.

**Ce que ça fait.** Un wizard interactif qui couvre les trois scénarios — attacher un vault à un workspace de code (le cas dominant), bootstrapper un vault autonome, enregistrer un vault distant. Depuis v0.35.0, la création est **defaults-first** : le moteur calcule un plan complet par défaut, l'affiche en une ligne, et vous l'acceptez tel quel (le chemin heureux = une seule interaction) ou ajustez n'importe quel point (nom · emplacement · source du template · plugins · thème · mode wiki).

**Comment l'utiliser.**

> « configure Obsidian pour ce projet », « attache un vault à ce workspace », « connecte mon vault distant » — ou `/obsidian-router:meta-attach-vault`

**À savoir.** Le wizard fonctionne depuis **n'importe quel harness LLM**, pas seulement Claude Code : les deux outils MCP `plan_vault` (lecture seule, calcule le plan) et `provision_vault` (l'applique) sont appelables par tout agent — playbook dans [`docs/vault-wizard.md`](../vault-wizard.md). En direct au CLI : `node scripts/setup-vault.mjs "<chemin>" --dry-run --json` pour prévisualiser, puis sans `--dry-run` pour appliquer. Garde-fous : outils local-only (masqués sur les déploiements gated), chemins hors racines connues refusés, secrets toujours régénérés (jamais copiés d'un vault source).

## `scripts/setup-vault.mjs` — le couteau suisse CLI

Le script qui sous-tend le wizard est utilisable directement, avec des sous-commandes pour l'administration courante :

| Commande | Effet |
|---|---|
| `setup-vault.mjs "<chemin>"` | Bootstrapper/provisionner un vault (plugins clonés depuis la référence, `.env`, wiki, hooks). `--dry-run --json` pour prévisualiser, `--help` pour tous les flags. |
| `--bootstrap-reference <chemin>` | Créer le vault de référence depuis le squelette livré. |
| `--link-workspace <workspace> <vault>` | Associer un repo de code à un vault (écrit `OBSIDIAN_ROUTER_DEFAULT_VAULT` dans le `.env` du workspace — le mode « workspace-bound »). `--unlink-workspace` pour retirer. |
| `--sync-all` | Propager snippets/plugins de la référence vers **tous** les vaults (idempotent ; `--force` re-clone). |
| `--install-hooks` / `--hooks-status` / `--no-hooks` | Gérer les hooks ([fiche 12](12-hooks-et-automatisations.md)). |
| `--status` | État des lieux (aussi : `npm run status`). |
| `--migrate-wiki-meta` | Migrer un vault ancien vers la structure `wiki-meta/` (scaffolds séparés du contenu). |

## `/meta-status` — le diagnostic

**Le besoin.** « Ça ne marche pas » a une dizaine de causes possibles : Obsidian fermé, plugin REST désactivé, clé API manquante, port changé, vault désactivé. Il faut un diagnostic qui **nomme** la cause et le remède.

**Ce que ça fait.** Pingue chaque vault configuré et rapporte en ligne/hors ligne/problème d'auth, avec une suggestion de correction **par type de problème**.

**Comment l'utiliser.**

> « diagnostique le router », « mes vaults sont-ils accessibles ? » — ou `/obsidian-router:meta-status` (aussi : `npm run status`)

## `/meta-sync-template` — propager la référence

**Le besoin.** Vous mettez à jour un plugin ou un snippet CSS dans le vault de référence : les autres vaults doivent en profiter sans re-provisionnement manuel.

**Ce que ça fait.** Un picker interactif liste chaque vault (statut en ligne, présence du plugin REST) et propage plugins/snippets/docs de la référence vers tous ou un sous-ensemble, avec `--force` pour re-cloner l'existant.

**Comment l'utiliser.**

> « synchronise le template vers tous les vaults », « pousse les plugins de référence vers X » — ou `/obsidian-router:meta-sync-template`

## `/conventions` — les règles de travail installables

**Le besoin.** Les règles qui rendent un vault agréable à vivre (bilinguisme, discipline de roadmap, hygiène du log…) doivent être **matérialisées dans le CLAUDE.md du vault** pour s'appliquer à chaque session — et être installables/désinstallables proprement, pas copiées-collées à la main.

**Ce que ça fait.** Installe, retire, liste et propage des conventions prêtes à l'emploi à travers les vaults. Le catalogue livré :

| Convention | Ce qu'elle impose |
|---|---|
| `source-type` | Chaque page déclare l'origine de son contenu (source primaire, inféré…). |
| `bilingual` | Pages substantielles FR + EN. |
| `heading-hierarchy` | Hiérarchie de titres propre (pas de sauts de niveaux). |
| `claim-citations` | Les affirmations citent leurs sources. |
| `roadmap-discipline` | Roadmaps dans le vault, checkboxes cochées au ship, jamais de texte barré sur les items livrés. |
| `log-discipline` | `log.md` = index mince ; le détail va dans `Sessions/`. |
| `wiki-query-first` | Consulter le wiki avant de répondre. |
| `path-disambiguation` | Ne jamais mélanger chemin du workspace et chemin du vault. |
| `default-vault-health-check` | Vérifier que le vault par défaut est joignable en début de session. |
| `auto-enrichment` | La consigne d'auto-enrichissement ([fiche 7](07-wiki-gestion-de-connaissances.md)). |
| `tribu-routing` | Routage par membre dans un vault familial. |

**Comment l'utiliser.**

> « installe la convention source-type sur smile », « quelles conventions sont actives sur ce vault ? », « propage source-type à tous les vaults » — ou `/obsidian-router:conventions`

## Mises à jour — `check-router-update` et `/plugin update`

**Le besoin.** Savoir qu'une nouvelle version existe, et l'installer sans casser son setup.

**Ce que ça fait.** Le hook de vérification quotidienne ([fiche 12](12-hooks-et-automatisations.md)) vous prévient en début de session. La mise à jour elle-même : `/plugin update obsidian-router@obsidian-mcp-router-marketplace` quand l'environnement l'expose ; sinon la procédure manuelle en 5 étapes (recettes bash + PowerShell) est dans [`docs/how-to-update.md`](../how-to-update.md).

## `gen-obsidian-deploy` — générer un déploiement serveur

**Le besoin.** Faire tourner un vault en container sur un serveur (LiveSync + API REST + GUI navigateur) demande un docker-compose, un bloc nginx et une ligne de config router **cohérents entre eux** — l'erreur de copier-coller est vite arrivée.

**Ce que ça fait.** Génère les trois d'un coup :

```bash
node scripts/gen-obsidian-deploy.mjs --name tribu --rest-port 27145 --mode wg --wg-host 10.8.0.1
```

Trois modes de réseau : `wg` (WireGuard uniquement — pour le sensible/médical), `lan`, `public` (HTTPS + bearer ; **refusé** pour un vault `--sensitive`). La ligne `VAULT_*` émise est testée en aller-retour contre le parseur du router — elle ne peut pas dériver. Les secrets sont des placeholders, jamais inventés. Runbook complet (dont onboarding LiveSync) : [`deploy/dedibox-obsidian/`](../../deploy/dedibox-obsidian/).

## Construire ses propres macros

**Le besoin.** Les commandes du plugin sont volontairement **agnostiques** — elles marchent pour n'importe quel vault. Vos rituels à vous (daily note, inbox de capture, rollup hebdo) méritent leurs propres commandes.

**Ce que ça fait.** Le patron pour bâtir des slash commands personnelles dans `~/.claude/commands/` qui chaînent les outils du router avec vos conventions, sans forker le projet. Guide et trois exemples de départ : [`docs/building-commands.md`](../building-commands.md).

## Les PDF de référence rapide

Toute la surface du produit — vue d'ensemble, setup, config, chaque slash command avec ses phrases déclencheuses — condensée en 5 pages imprimables : [français](../quick-reference-fr.pdf) · [anglais](../quick-reference-en.pdf).
