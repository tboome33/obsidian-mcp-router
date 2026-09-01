# 5 · Conversion de documents

Le savoir n'arrive pas toujours en markdown : il arrive en PDF, en Word, en Excel, en PowerPoint, en images, en audio. Cette famille d'outils convertit tout ça en markdown propre — l'étape d'entrée de la plupart des workflows d'ingestion ([fiche 6](06-ingestion-web.md) pour les sources web, [fiche 7](07-wiki-gestion-de-connaissances.md) pour le classement dans le wiki).

## La famille `*_to_markdown` — fichiers locaux

**Le besoin.** Vous avez un fichier sur votre disque — un cours en PDF, un rapport Word, un classeur Excel, une présentation, une photo de tableau blanc, un enregistrement audio — et vous voulez son contenu en markdown, lisible par vous et exploitable par Claude.

**Ce que ça fait.** Six outils, un par format d'entrée :

| Outil | Entrée | Particularité |
|---|---|---|
| `pdf_to_markdown` | PDF | Extraction de texte rapide (voie par défaut). |
| `docx_to_markdown` | Word | Structure et titres préservés. |
| `xlsx_to_markdown` | Excel | Feuilles converties en tables markdown. |
| `pptx_to_markdown` | PowerPoint | Une section par diapositive. |
| `image_to_markdown` | Image | OCR — extrait le texte visible. |
| `audio_to_markdown` | Audio | Transcription. |

La conversion est déléguée à `markitdown` (l'outil open source de Microsoft), installé dans un `.venv` local par `npm run install-markitdown` (opt-in depuis la v0.56.0). Chaque outil retourne le **texte markdown seul** — pour le persister dans un vault, on chaîne avec `write_file`, ce que Claude fait naturellement quand on demande « convertis et range dans le vault ».

**Comment l'utiliser.**

> « convertis ce PDF en markdown », « transcris cet audio et range-le dans le vault recherche » — ou `/obsidian-router:pdf-to-markdown`

**À savoir.** Prérequis : **Python 3.10+** sur le `PATH`, puis `npm run install-markitdown` (crée le `.venv` et installe `markitdown[all]` ; s'il manque, le reste du router fonctionne quand même). Voir les variables d'environnement en fin de fiche pour les overrides.

## `pdf_to_markdown_docling` — la voie haute fidélité pour les PDF complexes

**Le besoin.** Sur un PDF à tableaux complexes ou à colonnes multiples, l'extraction rapide perd la structure : les cellules se mélangent, l'ordre de lecture se brouille. Pour ces documents-là, on veut une conversion qui **reconstruit** la mise en page.

**Ce que ça fait.** Utilise [Docling](https://github.com/docling-project/docling) (IBM, MIT) au lieu de MarkItDown : détection de layout + reconnaissance de structure de tableaux (TableFormer). Fidélité nettement supérieure sur les documents complexes, pour un coût CPU environ 10× plus élevé. Les figures deviennent des marqueurs `<!-- image -->` plutôt que du base64 inliné — la sortie reste du texte compact (un PDF illustré qui pèserait ~3 Mo en mode embarqué ressort à ~15 Ko).

**Comment l'utiliser.**

> « convertis ce PDF avec Docling, il a des tableaux complexes » — ou `/obsidian-router:pdf-to-markdown-docling`

**À savoir.** **Opt-in** : Docling tire torch et des poids de modèles (~1,3 Go sur Windows/macOS, ~5,5 Go sur Linux), donc il n'est pas installé par défaut. Activez avec `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` avant `npm install` (ou `npm run install-docling` ensuite). Sans installation, l'outil reste listé et répond par une consigne d'installation claire. PDF uniquement — les formats Office restent sur MarkItDown. Règle simple : `pdf_to_markdown` d'abord ; Docling quand le résultat trahit des tableaux ou colonnes cassés.

## `pdf_to_images` — donner des yeux au modèle

**Le besoin.** Parfois le texte ne suffit pas : un schéma, une figure, une mise en page signifiante. Il faut que le modèle puisse **voir** la page, pas seulement lire son texte.

**Ce que ça fait.** Rend les pages d'un PDF local en images PNG, retournées comme blocs image MCP — Claude les regarde directement. Paramètres : `filepath`, `first_page` (défaut 1), `max_pages` (défaut 8, plafond 30), `scale` (défaut 2.0 ≈ 144 DPI). Moteur : pypdfium2 (le moteur PDF de Chrome, licence BSD) + Pillow.

**Comment l'utiliser.**

> « regarde la page 3 de ce PDF et décris le schéma », « montre-toi les 5 premières pages de ce document »

**À savoir.** Chaque page rendue est une image facturée dans le contexte du modèle : des plafonds durs (nombre de pages, 12 Mo par image, 24 Mo au total) bornent le coût, et un fichier hors limites est refusé **avant** d'être chargé en mémoire. Les dépendances vivent dans le même `.venv-docling` que Docling — si vous avez activé Docling, `pdf_to_images` marche déjà ; sinon l'outil donne la consigne d'installation. Ne modifie aucun vault.

## Dépendances et variables d'environnement

Le résumé des prérequis et des points de réglage de toute la famille :

- **Python 3.10+** requis pour markitdown et Docling. **Rien n'est installé
  automatiquement** : il n'existe aucun script `postinstall` dans le paquet, et
  l'auto-updater ne relance pas l'installation non plus. C'est une décision
  écrite — le router n'impose une installation Python à personne. L'étape est
  explicite : `npm run install-markitdown` / `npm run install-docling`.
- Savoir où on en est **sans attendre le premier échec** : la réponse de
  `list_vaults` porte un champ `conversionToolbox` (`available`, `via`, `path`,
  `verified`, `optedOut`, `toolsAffected`, `toolsDegraded`, `hint`), que la skill
  `meta-status` affiche en une ligne. `verified: false` signale une réponse prise
  **sur parole** et non mesurée — un nom de commande nu que `execFile` résout via le
  `PATH` au moment de l'appel, ou un chemin UNC qu'il serait dangereux de `stat` sur ce
  chemin chaud. À lire « configuré », pas « prêt ». Huit outils cessent de
  fonctionner sans markitdown ; `youtube_to_markdown` se rabat sur ses
  sous-titres yt-dlp, et `git_repo_to_markdown` n'est pas concerné (il passe par
  repomix).
- Ne plus se le faire proposer : `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`.
- Utiliser une installation système plutôt que le venv embarqué : `pipx install "markitdown[all]"` + `MARKITDOWN_PATH=/chemin/vers/markitdown` (idem `DOCLING_PATH`, `PDF_IMAGES_PYTHON`).

| Variable | Rôle |
|---|---|
| `MD_ALLOWED_PATHS` | Liste de répertoires (séparés par `:` en POSIX, `;` sous Windows) que les outils de conversion ont le droit de lire. Non défini = tout chemin absolu est permis ; défini = tout chemin hors liste est refusé. Le bac à sable de la famille. |
| `MD_SHARE_DIR` | Alias historique mono-répertoire de `MD_ALLOWED_PATHS` (compatibilité markdownify-mcp). |
| `MARKITDOWN_PATH` / `DOCLING_PATH` / `PDF_IMAGES_PYTHON` | Chemins explicites vers les exécutables quand on n'utilise pas les venvs embarqués. |
| `OBSIDIAN_ROUTER_ENABLE_DOCLING` | `1` avant install = active le backend Docling. |
| `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` | `1` = rend `npm run install-markitdown` inopérant (environnements scriptés) **et** fait taire la proposition d'installation dans `list_vaults` / `meta-status`. Strictement la chaîne `"1"`. |

Les outils orientés **URL** (`webpage_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `git_repo_to_markdown`) appartiennent à la même famille technique mais servent l'ingestion web — ils sont documentés en [fiche 6](06-ingestion-web.md).
