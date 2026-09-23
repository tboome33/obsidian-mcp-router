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

## `pptx_extract_assets` — garder les images d'une présentation

**Le besoin.** `pptx_to_markdown` lit une présentation fidèlement pour le texte — titres, tableaux, notes de l'orateur — mais il ne rend pas les **images**. À leur place, il écrit une référence qui ne pointe vers aucun fichier : `![logo.png](Picture2.jpg)`. Pire, deux images différentes de deux diapositives peuvent recevoir la même cible, parce que ce nom est un numéro de forme dans la diapositive et pas une identité, et l'extension est inventée (un PNG devient `.jpg`). Une présentation ingérée avec ce seul outil laisse donc des liens d'image morts dans le vault.

**Ce que ça fait.** Ouvre le `.pptx` comme ce qu'il est — une archive ZIP — avec le lecteur du router, **sans Python**, et écrit chaque image embarquée dans un dossier, avec la liste des diapositives qui l'affichent. Trois règles font la valeur du résultat :

- **Les numéros de diapositive sont des positions d'affichage**, lues dans l'ordre de la présentation, c'est-à-dire la même numérotation que les commentaires `<!-- Slide number: N -->` que produit `pptx_to_markdown`. Pas le numéro du fichier `slideN.xml`, qui diverge dès qu'on réordonne les diapositives. Si la présentation n'a pas d'ordre lisible, l'outil retombe sur les numéros de fichier **et le dit** (`orderSource: "file-number"`).
- **Une image utilisée sur plusieurs diapositives est écrite une seule fois**, même si l'archive la stocke deux fois : la déduplication se fait sur le contenu (empreinte SHA-256), pas sur le nom. Seule réserve : une partie que l'outil n'a pas lue (signalée dans `skipped`) pouvait être une diapositive de plus pour une image déjà listée.
- **Les noms de fichiers sont construits** (`slide<N>-<i>.<ext>`) et l'extension vient des premiers octets du fichier. Aucun nom venu de l'archive n'atteint le disque ; un contenu non reconnu est écarté avec sa raison, jamais écrit sous une extension devinée.

Le résultat est un manifeste : pour chaque image `name`, `path`, `slides`, `bytes`, `ext`, `sha256`, plus `skipped` (ce qui n'a pas pu être extrait, avec la raison).

**Comment l'utiliser.** Presque toujours à travers l'ingestion, avec `--save-assets` :

> « ingère cette présentation avec ses images » — la skill `wiki-ingest` appelle `pptx_to_markdown` pour le texte, `pptx_extract_assets` pour les images, supprime les références mortes et insère chaque image sous sa diapositive.

**À savoir.**

- **C'est un outil d'écriture.** Sans `outdir`, les images vont dans un dossier temporaire ; mais l'ingestion vise `<vault>/wiki/.assets/<slug>/`, c'est-à-dire **l'intérieur d'un vault**. Il est donc masqué par `OBSIDIAN_ROUTER_READONLY`, et un `outdir` situé dans un vault subit les règles de ce vault, exactement comme `download_page_assets` : un vault inaccessible depuis ce workspace est refusé, un secondaire verrouillé aussi (sans exception), un secondaire « souple » demande `confirmSecondaryWrite`, et un **vault partagé** demande `createOnly: true`. Si des dossiers de vaults sont imbriqués, chacun est consulté.
- **`createOnly: true` n'écrase jamais rien.** Une ré-ingestion retrouve ses propres fichiers : ils reviennent dans le manifeste avec `alreadyPresent: true`, sous le même nom. Un nom occupé par un autre contenu (une image retouchée à la main) est laissé tel quel, et l'image part sous un nom dérivé de son empreinte.
- **Bornes** : 512 Mio par fichier source (un fichier ordinaire uniquement), 200 images et 256 Mio écrits par défaut (`max_assets`, `max_total_bytes`, jamais relevés au-delà), 512 Mio décompressés au plus par appel (toutes lectures comprises), 16 Mio par partie XML, et 2000 diapositives parcourues au plus. Aucune n'est silencieuse, mais elles ne parlent pas toutes au même endroit : un fichier source trop gros ou qui n'est pas un fichier ordinaire **refuse l'appel** ; un ordre de présentation illisible fait repasser aux numéros de fichier avec `orderSource: "file-number"` et sa cause dans `orderFallbackReason` ; tout le reste laisse une entrée dans `skipped`. Ces bornes limitent les octets décompressés, pas la mémoire de pointe du processus.
- **Limite connue** : une image qui n'existe que dans une mise en page ou un masque (un logo répété sur toutes les diapositives) n'est pas une image de diapositive et n'est pas extraite. De même, l'original intact qu'Office garde à côté d'une image retouchée par un effet artistique (relation `hdphoto`) n'est pas extrait — l'image retouchée, celle qui s'affiche, l'est.
- **Où il a le droit d'écrire** : dans un vault enregistré (avec les règles de ce vault, ci-dessus) ou dans le dossier temporaire du système — **nulle part ailleurs**. Un `outdir` hors de tout vault et hors du dossier temporaire est refusé, et le dossier n'est pas créé. Même règle pour `download_page_assets`.
- **Le dossier de sortie est « épinglé » avant la première écriture.** Une première version vérifiait le dossier par son chemin, puis écrivait par ce même chemin : un autre programme qui remplaçait le dossier (ou un parent) par un lien entre les deux pouvait rediriger l'écriture vers un vault verrouillé, ou n'importe où. Maintenant, le router **tient** le dossier avant d'écrire, et vérifie que ce qu'il tient est bien le dossier autorisé :
  - **sous Windows**, il crée dans le dossier une petite « sonde » : un sous-dossier `.router-pin-…`, qu'il garde ouvert **en exclusivité**. Tant qu'elle est tenue, aucun autre programme ne peut l'effacer, ni renommer le dossier ou l'un de ses parents — mais tout le monde peut encore lister le dossier lui-même (Obsidian). Le router demande alors à **Windows lui-même, à partir de la poignée qu'il tient**, où se trouve cette sonde : la réponse doit être `<dossier>\<sonde>`. C'est la seule réponse qu'un programme hostile ne peut pas contrefaire. Deux versions précédentes répondaient à partir de chemins et ont été cassées en revue : l'une posait deux questions (« même objet ? » puis « bon endroit ? ») qu'un échange suivi d'un retour en arrière trompait toutes les deux ; l'autre comptait sur un nom de fichier secret, qu'un programme surveillant le dossier détourné pouvait apprendre et imiter. Cette question posée à la poignée passe par un petit module natif, **koffi** (licence MIT) — sans lui, le router refuse d'écrire sous Windows plutôt que d'épingler sans preuve. La comparaison est exacte, majuscules comprises (un dossier NTFS peut distinguer `out` et `OUT`). Et l'épinglage exige que le disque **se déclare NTFS**, le seul système de fichiers sur lequel ses garanties ont été mesurées : la même poignée dit à Windows sur quel système de fichiers se trouve la sonde, et toute autre réponse est refusée (ReFS, donc les « Dev Drive », compris). C'est un nom, pas un certificat — un pilote tiers peut se déclarer NTFS — : la garantie suppose une pile de pilotes de confiance. Mesuré ici : C:, I:, D: et les vaults sont en NTFS ; le lecteur Google Drive (M:) se déclare FAT32, donc un dossier de sortie qui s'y trouve est refusé sous Windows.
  - **Ce que la garantie couvre** : l'endroit où les **octets** atterrissent — jamais hors du dossier autorisé, jamais écrits à travers un lien. Deux créations **vides** hors du dossier restent possibles et sont décrites ici : une sonde sous une attaque active, un fichier vide au bout d'un lien cassé dans le mode sans liens physiques. Pas l'intégrité des fichiers **dans** ce dossier face à un autre programme qui peut y écrire : celui-là peut déjà y écrire ce qu'il veut, sous n'importe quel nom. La sonde s'efface d'elle-même à la fermeture. Elle n'a besoin d'aucun accès exclusif au dossier lui-même : la racine d'un vault ouverte dans Obsidian, le dossier temporaire ou le dossier de travail d'un programme peuvent être épinglés ;
  - **sous Linux**, toutes les opérations passent par le descripteur du dossier (`/proc/self/fd/…`) : renommer le chemin ensuite ne change pas le dossier visé ;
  - **sous macOS**, Node n'offre aucun moyen de tenir un dossier : il est vérifié une fois, et la course reste ouverte sur ce système.
- **La garde est reposée sur le dossier tenu, avant toute création.** Une fois le plus proche dossier existant épinglé et prouvé, la garde de confinement juge son chemin **tel quel**, sans le résoudre à nouveau (une deuxième résolution, faite sans rien tenir, pouvait être détournée par un échange et approuver un autre dossier que celui épinglé). Sans `outdir`, le dossier temporaire neuf est lui aussi créé à travers l'épinglage.
- **Aucun fichier n'est écrit en ouvrant son nom de destination.** Mesuré sous Windows : une création « exclusive » sur un nom où se trouve un **lien cassé** crée le fichier **là où pointe le lien**. Chaque image est donc d'abord écrite sous un nom temporaire imprévisible, puis mise en place par un lien physique (qui échoue si quoi que ce soit occupe le nom, lien compris, sans rien créer ailleurs) ou par un renommage (qui remplace un lien lui-même, jamais sa cible). Sur un disque qui refuse les liens physiques, la mise en place « sans écraser » crée le fichier directement à son nom, en exclusivité, et vérifie avant d'écrire le moindre octet que c'est bien un fichier ordinaire à ce nom : rien n'est jamais écrasé. Seul reste, sur un disque qui connaît les liens mais pas les liens physiques (ReFS), qu'un lien cassé posé à ce nom peut faire créer un fichier **vide** là où il pointe — détecté, refusé, rien n'y est écrit.
- **Sous une attaque active** qui échangerait un dossier parent pendant la sonde, un sous-dossier `.router-pin-…` vide peut rester là où l'échange pointait ; la sonde est alors refusée et rien d'autre n'est créé.

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
| `MD_ALLOWED_PATHS` | Liste de répertoires (séparés par `:` en POSIX, `;` sous Windows) que les outils de conversion ont le droit de lire — et, pour `pptx_extract_assets` et `download_page_assets`, où ils ont le droit d'écrire (sauf le dossier temporaire neuf que `pptx_extract_assets` crée lui-même quand on ne lui donne pas d'`outdir`). Pour ces deux outils, elle **resserre** une règle qui s'applique de toute façon : écrire seulement dans un vault enregistré ou dans le dossier temporaire du système. Non défini = tout chemin absolu est permis en lecture ; défini = tout chemin hors liste est refusé. Un chemin qui n'existe pas encore est jugé à travers son plus proche parent existant, liens résolus : un dossier à créer sous un lien qui sort de la liste est refusé. Le bac à sable de la famille. |
| `MD_SHARE_DIR` | Alias historique mono-répertoire de `MD_ALLOWED_PATHS` (compatibilité markdownify-mcp). |
| `MARKITDOWN_PATH` / `DOCLING_PATH` / `PDF_IMAGES_PYTHON` | Chemins explicites vers les exécutables quand on n'utilise pas les venvs embarqués. |
| `OBSIDIAN_ROUTER_ENABLE_DOCLING` | `1` avant install = active le backend Docling. |
| `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` | `1` = rend `npm run install-markitdown` inopérant (environnements scriptés) **et** fait taire la proposition d'installation dans `list_vaults` / `meta-status`. Strictement la chaîne `"1"`. |

Les outils orientés **URL** (`webpage_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `git_repo_to_markdown`) appartiennent à la même famille technique mais servent l'ingestion web — ils sont documentés en [fiche 6](06-ingestion-web.md).
