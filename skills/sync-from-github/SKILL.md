---
name: sync-from-github
description: |
  Sync one vault (or the whole fleet) straight from the GitHub skeleton — plugins, themes, snippets, root docs — with the exact same guards as `--sync-plugins` (credential-leak refusal, BRAT anti-downgrade, per-theme clones) plus hardened archive extraction (path-traversal abort, links never materialized, size/entry caps). For machines that have neither the dev repo nor a local `.template`. Lot 3 of the template-distribution roadmap.

  EN triggers: "sync my vault from GitHub", "update the vault template from GitHub", "pull the latest skeleton", "sync the fleet from the repo".
  FR triggers : "synchronise depuis GitHub", "mets à jour le template depuis GitHub", "récupère le dernier skeleton", "synchronise la flotte depuis le repo".

  Example / Exemple:
    EN: "sync all my vaults from the GitHub template"
    FR: "synchronise tous mes vaults depuis GitHub"
---

# sync-from-github

Le troisième canal du tableau de distribution : une machine qui a le router (et donc ses scripts) mais **ni le repo de dev, ni de `.template` local** peut obtenir et maintenir la config de vault idéale en tirant l'archive GitHub. Rien ne se pousse d'une machine à l'autre — chaque machine **tire**.

## Argument parsing from $ARGUMENTS

- un ou plusieurs chemins de vault → cibles explicites
- `--all` / « tous les vaults » → toute la flotte du `portRegistry`
- `--ref <branche|tag>` → version précise du template (défaut : `main`)
- `--force` → re-clone les plugins en préservant chaque `data.json` local
- `--lang <code>` / « le vault est en français » → langue du vault : choisit le modèle d'embedding du `.smart-env` **que la synchro crée** (`en` garde `TaylorAI/bge-micro-v2`, toute autre langue prend le modèle multilingue `onnx-community/embeddinggemma-300m-ONNX`, `zh` le modèle chinois/anglais). Un `.smart-env` existant n'est **jamais** réécrit. Sans `--lang`, le CLI cherche une langue déjà déclarée par le vault (convention `bilingual` dans son CLAUDE.md → `fr`, ou `language` des réglages Smart Connections) ; sinon il garde le modèle de la source et affiche un rappel d'une ligne.
- `--container` / « Obsidian tourne dans un conteneur » → la checklist finale donne la variante conteneur du rechargement (sinon le CLI la déduit d'un vault distant du même nom dans la config, ou affiche les deux variantes)
- `--dry-run` / « montre d'abord ce que ça ferait » → aperçu scellé (voir étape 2)
- vide → **picker** : lister les vaults configurés (`list_vaults` si le router est joignable, sinon le `portRegistry` du config.json) et demander « tous, ou lesquels ? »

## Procédure

1. **Cibles.** Sans cible explicite, présenter la liste des vaults configurés et faire choisir (tous / sous-ensemble). Ne jamais choisir à la place de l'utilisateur.
2. **Lancer le CLI** depuis le repo du router :
   `node scripts/setup-vault.mjs --sync-from-github <vault…>|--all [--ref <ref>] [--force] [--lang <code>] [--container]`
   Avec `--dry-run`, le CLI affiche, **par vault et par plugin**, ce qui sera fait : `copy [code]` ou `copy [settings only — code still to install]` avec la liste des fichiers, `skip — already present`, `skip — target version is newer`, `refused by the network-source vetting`, `deferred — credentialed plugin` ; puis `will enable: …`, `enabled but still without code afterwards: …`, le sort de `.smart-env` (modèle + langue) et les docs racine. Il imprime un `approvedPlanSha256` qui scelle **tout ce détail** (archive, vaults, force, langue, plan par plugin) : repasser la même commande sans `--dry-run` avec `--approved-plan-sha256 <hash>` refuse l'application si un seul de ces éléments a bougé — avant qu'aucun vault ne soit touché.
3. **Lire la sortie par vault** et restituer fidèlement les catégories — **ne jamais dire « installé » pour autre chose que la première** :
   - `Code installed for N plugin(s)` — le code (`main.js` + `manifest.json`) est présent dans le vault après la copie
   - `Settings only for N plugin(s) — code still to install` — seul le `data.json` pré-réglé est arrivé (le skeleton ne livre pas le code de ces plugins)
   - `Enabled without code — N plugin(s)` — listés dans `community-plugins.json` (ou activés par la source) sans `main.js` dans le vault, y compris ceux que le skeleton active sans jamais les fournir. Ces ids restent listés **exprès** : le plugin s'allume dès que son code arrive. Ils ne comptent **pas** comme synchronisés.
   - `Missing marketplace plugin(s)` — à installer à la main (Settings → Community plugins → Browse → Install → Enable) **ou** en une commande : `obsidian-mcp-router --install-plugins "<vault>"`
   - `Installed by BRAT (GitHub-only)` — le bridge : c'est BRAT qui l'installe (étape 4)
   - `Refreshed` — re-clonés sous `--force` (data.json locaux préservés)
   - `Kept … NEWER` — la garde anti-downgrade a protégé une version BRAT plus récente côté vault : **normal, ne pas « corriger »**
   - `Refused first-time copy` — la garde credentials a refusé de copier `obsidian-local-rest-api` dans un vault jamais bootstrappé : indiquer la commande de bootstrap affichée, ne pas contourner
   - `Cloned .smart-env … embedding model …, language …` — le modèle retenu ; un rappel `--lang` s'affiche quand aucune langue n'était connue
4. **Relayer la checklist `Next steps in Obsidian for <vault>`** que le CLI imprime après chaque vault modifié, dans l'ordre : recharger Obsidian (bureau : Ctrl+P → « Reload app without saving » ; conteneur type linuxserver/obsidian : même commande dans l'interface web, ou `docker compose restart <service>`) → désactiver le Restricted mode → vérifier que les plugins qui ont leur code sont activés → lancer BRAT « Check for updates » (commande `obsidian42-brat:checkForUpdatesAndUpdate`) pour qu'il installe le bridge → installer les plugins marketplace manquants (`--install-plugins`) → vérifier avec `obsidian-mcp-router --plugin-health "<vault>"`.
5. **Ne jamais écrire « N plugins synchronisés »** en résumé : reprendre les trois compteurs (code installé / réglages seuls / activés sans code).

## Gardes-fous

- **Jamais de contournement des refus de sécurité** : un `deferredForSafety` se règle par le bootstrap du vault (port + apiKey propres), jamais en copiant un `data.json` à la main.
- **La garde anti-downgrade est une feature** : un plugin gardé « NEWER » signifie que BRAT a déjà fait son travail sur ce vault.
- L'archive vient de `https://codeload.github.com/`, **par défaut sur le repo du router**. Le CLI accepte `--repo <owner/name>` mais exige alors `--trust-repo` : un repo non-défaut peut livrer du code de plugin exécutable. **Ce skill ne passe JAMAIS `--repo` de lui-même** — uniquement sur demande explicite de l'utilisateur, en lui rappelant ce que ça implique. L'extraction rejette toute traversée de chemin (y compris flux NTFS `:` et noms de périphériques Windows) et ne matérialise jamais les liens ; seuls les plugins de l'**allowlist pinnée dans le code** peuvent être copiés depuis le réseau ; `.claude/` n'est jamais cloné depuis une source réseau, et le `README.md` du skeleton (qui décrit le skeleton, pas le vault) n'est jamais copié dans un vault.
- Ne PAS utiliser ce mode pour pousser des changements locaux : il tire ce qui est **publié sur GitHub**. Les changements locaux passent par `meta-sync-template` (source = `.template` vivant).

## On failure

- `Download failed` → vérifier la connectivité et le `--ref` (branche/tag existant). Ne pas retomber sur une copie manuelle de fichiers.
- `no templates/reference-vault-skeleton` → mauvais repo/ref (antérieur au Lot 2) — prendre `main` ou un tag ≥ v0.52.0.
- Erreurs par-vault : listées individuellement, le reste de la flotte continue — restituer le décompte final (`N synced, N skipped, N failed` — ici « synced » compte des **vaults** traités sans erreur, pas des plugins installés).
- `Sealed-preview drift — nothing was synced (no vault touched)` → l'archive, les vaults ou le plan d'un plugin ont changé depuis l'aperçu : relancer `--dry-run`, relire le nouveau détail, puis appliquer le nouveau sceau.
- `Invalid --lang` → passer un code de langue (`fr`, `de`, `pt-BR`…).
