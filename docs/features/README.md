# Les features du router, expliquées

> 🇫🇷 Ce dossier est la version **lisible** de la documentation des fonctionnalités. Le [README](../../README.md) principal liste tout en tables compactes — pratique comme aide-mémoire, mais difficile à lire quand on découvre le projet. Ici, chaque feature est expliquée en prose : **à quel besoin elle répond, ce qu'elle fait concrètement, et comment s'en servir**.

## Comment lire ces fiches

Chaque catégorie a sa propre page. À l'intérieur, chaque feature suit la même structure :

- **Le besoin** — le problème concret que la feature résout, avant de parler technique.
- **Ce que ça fait** — le comportement réel, sans jargon inutile.
- **Comment l'utiliser** — les trois portes d'entrée possibles (voir ci-dessous), avec des exemples.
- **À savoir** — prérequis, pièges connus, limites. Présent seulement quand il y a quelque chose à savoir.

## Les trois façons d'invoquer n'importe quelle feature

Presque tout ce que fait le router est accessible par trois chemins équivalents — choisissez celui qui vous est naturel :

1. **En langage naturel** — vous décrivez ce que vous voulez à Claude (*« liste mes vaults »*, *« ingère cette URL »*, *« verrouille sur tradingview »*). Chaque skill du plugin documente ses phrases déclencheuses en français et en anglais ; c'est la voie recommandée au quotidien.
2. **Par slash command** — tapez `/obsidian-router:` dans Claude Code et l'autocomplétion montre les 40+ commandes. Utile quand vous voulez être explicite et éviter toute ambiguïté.
3. **Par appel d'outil MCP direct** — les ~40 outils (`get_file`, `search_smart`, `write_file`…) sont appelables depuis n'importe quel client MCP, pas seulement Claude Code. Les fiches donnent la forme JSON des arguments quand c'est utile.

## Les catégories

| # | Fiche | Ce qu'elle couvre |
|---|---|---|
| 1 | [Routage multi-vault](01-routage-multi-vault.md) | Le cœur du projet : un seul serveur MCP pour tous vos vaults, le paramètre `vault`, la recherche cross-vault, la résolution du vault par défaut, les vaults distants. |
| 2 | [Lecture et recherche](02-lecture-et-recherche.md) | Explorer et lire les vaults : liste des vaults et fichiers, lecture de notes, recherche plein texte et recherche sémantique. |
| 3 | [Écriture et édition](03-ecriture-et-edition.md) | Créer, compléter, éditer chirurgicalement, déplacer et supprimer des notes ; gérer le frontmatter. |
| 4 | [Templates et contenu Obsidian](04-templates-et-contenu-obsidian.md) | Exécuter des templates Templater, créer des canvas visuels et des bases de données (.base), le markdown « façon Obsidian ». |
| 5 | [Conversion de documents](05-conversion-de-documents.md) | Transformer PDF, Word, Excel, PowerPoint, images, audio… en markdown ; rendre visuellement les pages d'un PDF. |
| 6 | [Ingestion web](06-ingestion-web.md) | Ramener le web dans le vault : pages web, vidéos YouTube, dépôts git, nettoyage du bruit, métadonnées, images. |
| 7 | [Wiki et gestion de connaissances](07-wiki-gestion-de-connaissances.md) | Le wiki auto-entretenu « style Karpathy » : scaffolding, ingestion, interrogation, sauvegarde de conversations, recherche autonome, auto-enrichissement. |
| 8 | [Graphe de connaissances](08-graphe-de-connaissances.md) | Construire et interroger le graphe du wiki : communautés, visites guidées, voisins d'une page, chemin entre deux pages. |
| 9 | [Export et interopérabilité](09-export-et-interoperabilite.md) | Sortir le savoir du vault : export `llms.txt`, bundles OKF (Open Knowledge Format), validation de conformité. |
| 10 | [Liens et navigation](10-liens-et-navigation.md) | Des liens qui ouvrent vraiment Obsidian : click-to-open, ouverture côté serveur, view links et smart links pour les vaults distants. |
| 11 | [Sécurité et isolation](11-securite-et-isolation.md) | Le mode lock mono-vault, le multi-tenant (whitelist, lecture seule, audit), les gardes réseau et les garde-fous anti-accident. |
| 12 | [Hooks et automatisations](12-hooks-et-automatisations.md) | Les 9 hooks Claude Code qui journalisent, rechargent le contexte, vérifient les liens et gardent la doc synchrone — automatiquement. |
| 13 | [Installation et administration](13-installation-et-administration.md) | Installer le router, créer et attacher des vaults (wizard), diagnostiquer, synchroniser le vault de référence, conventions, mises à jour, déploiement serveur. |

## D'où vient l'information

Ces fiches sont dérivées du [README](../../README.md) (EN + FR), du [CHANGELOG](../../CHANGELOG.md) et des skills livrées dans [`skills/`](../../skills/). En cas de divergence, le CHANGELOG fait foi — merci de signaler l'écart. Pour un format ultra-condensé imprimable, voir les PDF de référence rapide : [français](../quick-reference-fr.pdf) · [anglais](../quick-reference-en.pdf).
