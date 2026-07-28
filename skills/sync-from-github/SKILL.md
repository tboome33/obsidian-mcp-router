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
- vide → **picker** : lister les vaults configurés (`list_vaults` si le router est joignable, sinon le `portRegistry` du config.json) et demander « tous, ou lesquels ? »

## Procédure

1. **Cibles.** Sans cible explicite, présenter la liste des vaults configurés et faire choisir (tous / sous-ensemble). Ne jamais choisir à la place de l'utilisateur.
2. **Lancer le CLI** depuis le repo du router :
   `node scripts/setup-vault.mjs --sync-from-github <vault…>|--all [--ref <ref>] [--force]`
3. **Lire la sortie par vault** et restituer fidèlement les 4 catégories :
   - `Synced` — plugins nouvellement installés (ajoutés à `community-plugins.json`)
   - `Refreshed` — re-clonés sous `--force` (data.json locaux préservés)
   - `Kept … NEWER` — la garde anti-downgrade a protégé une version BRAT plus récente côté vault : **normal, ne pas « corriger »**
   - `Refused first-time copy` — la garde credentials a refusé de copier `obsidian-local-rest-api` dans un vault jamais bootstrappé : indiquer la commande de bootstrap affichée, ne pas contourner
4. **Rappeler le reload** : les plugins ajoutés ne chargent qu'après un reload d'Obsidian sur les vaults touchés (`app:reload` ou réouverture).

## Gardes-fous

- **Jamais de contournement des refus de sécurité** : un `deferredForSafety` se règle par le bootstrap du vault (port + apiKey propres), jamais en copiant un `data.json` à la main.
- **La garde anti-downgrade est une feature** : un plugin gardé « NEWER » signifie que BRAT a déjà fait son travail sur ce vault.
- L'archive vient de `https://codeload.github.com/`, **par défaut sur le repo du router**. Le CLI accepte `--repo <owner/name>` mais exige alors `--trust-repo` : un repo non-défaut peut livrer du code de plugin exécutable. **Ce skill ne passe JAMAIS `--repo` de lui-même** — uniquement sur demande explicite de l'utilisateur, en lui rappelant ce que ça implique. L'extraction rejette toute traversée de chemin (y compris flux NTFS `:` et noms de périphériques Windows) et ne matérialise jamais les liens ; seuls les plugins de l'**allowlist pinnée dans le code** peuvent être copiés depuis le réseau ; `.claude/` n'est jamais cloné depuis une source réseau.
- Ne PAS utiliser ce mode pour pousser des changements locaux : il tire ce qui est **publié sur GitHub**. Les changements locaux passent par `meta-sync-template` (source = `.template` vivant).

## On failure

- `Download failed` → vérifier la connectivité et le `--ref` (branche/tag existant). Ne pas retomber sur une copie manuelle de fichiers.
- `no templates/reference-vault-skeleton` → mauvais repo/ref (antérieur au Lot 2) — prendre `main` ou un tag ≥ v0.52.0.
- Erreurs par-vault : listées individuellement, le reste de la flotte continue — restituer le décompte final (`N synced, N skipped, N failed`).
