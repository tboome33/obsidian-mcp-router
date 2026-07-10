# 6 · Ingestion web

Ramener le web dans le vault : convertir des pages et des vidéos en markdown, nettoyer le bruit avant ingestion, extraire des métadonnées fiables, suivre les liens prometteurs, préserver les images. Ces briques alimentent les workflows de plus haut niveau `wiki-ingest` et `autoresearch` ([fiche 7](07-wiki-gestion-de-connaissances.md)).

## `webpage_to_markdown`, `bing_search_to_markdown`, `youtube_to_markdown` — le web en markdown

**Le besoin.** Un article, une page de documentation, une vidéo YouTube : on veut leur contenu en texte exploitable, sans copier-coller manuel.

**Ce que ça fait.**

- **`webpage_to_markdown`** — convertit une page web en markdown.
- **`bing_search_to_markdown`** — convertit une page de résultats Bing en markdown (utile pour balayer rapidement ce qui existe sur un sujet).
- **`youtube_to_markdown`** — récupère la transcription d'une vidéo YouTube. Si la voie standard échoue, un fallback via `yt-dlp` récupère les sous-titres (langues réglables via `OBSIDIAN_ROUTER_VIDEO_SUBLANGS`, `en.*,en` par défaut).

**Comment l'utiliser.**

> « convertis cette URL en markdown », « récupère la transcription de cette vidéo YouTube »

**À savoir.** Seules les URL `http(s)` publiques sont acceptées : les hôtes privés et loopback sont refusés (garde anti-SSRF — l'outil ne peut pas servir à sonder votre réseau interne). Pour les sites très chargés en JavaScript (SPA), préférez la skill `defuddle` ci-dessous, qui passe par un vrai navigateur headless.

## `git_repo_to_markdown` — un dépôt entier en un document

**Le besoin.** Faire lire une codebase à Claude — pour un audit, une reprise en main, de la documentation — sans lui envoyer les fichiers un par un.

**Ce que ça fait.** Regroupe un dépôt git complet (arborescence + code source) en un seul document markdown, via `repomix`. Accepte une URL complète ou le raccourci `owner/repo`. Le flag `compress: true` applique une compression Tree-sitter (~70 % de réduction) qui garde la structure du code en sacrifiant le détail.

**Comment l'utiliser.**

> « bundle le repo tboome33/obsidian-mcp-router en markdown, compressé »

```jsonc
{ "repo": "tboome33/obsidian-mcp-router", "compress": true }
```

## Skill `defuddle` — nettoyer une page avant de l'ingérer

**Le besoin.** Une page web réelle, c'est 40 à 60 % de bruit : pubs, menus, bannières cookies, widgets « articles liés », commentaires, footers. Ingérer tout ça pollue le wiki et gaspille des tokens.

**Ce que ça fait.** Récupère la page dans un navigateur headless (donc les SPA passent aussi), en extrait la version lisible — le contenu de l'article, rien d'autre — et la retourne en markdown propre. C'est le préprocesseur recommandé avant `wiki-ingest` sur des pages commerciales ou des blogs.

**Comment l'utiliser.**

> « defuddle cette URL », « nettoie cette page et donne-moi la version lisible » — ou `/obsidian-router:defuddle`

## `extract_page_metadata` — des métadonnées qui ne mentent pas

**Le besoin.** Quand on archive une source web, le frontmatter de la note (auteur, date de publication, titre, site) doit venir **de la page elle-même** — pas d'une reconstruction du modèle qui risque d'inventer.

**Ce que ça fait.** Extraction **déterministe** des métadonnées d'une page : JSON-LD, balises OpenGraph, meta tags, titre. Le résultat alimente un frontmatter fiable et vérifiable lors de l'ingestion.

**Comment l'utiliser.** Employé automatiquement par `wiki-ingest` ; appelable directement quand on veut juste les métadonnées d'une URL.

## `propose_linked_sources` — quoi ingérer ensuite ?

**Le besoin.** Un bon article renvoie souvent vers d'autres bonnes sources. Suivre ces pistes à la main est fastidieux ; les suivre toutes aveuglément est du bruit.

**Ce que ça fait.** Analyse les liens `<a href>` d'une page et propose les **meilleurs candidats** à une ingestion récursive : score heuristique, bonus pour le même domaine et les sections apparentées, top-N seulement. Vous choisissez ; rien n'est ingéré sans décision.

**Comment l'utiliser.** Proposé naturellement dans les boucles `wiki-ingest`/`autoresearch` (*« cette page cite 4 sources qui valent le coup, je les ingère ? »*) ; appelable directement sur une URL.

## `download_page_assets` — préserver les images

**Le besoin.** Une conversion en markdown perd les images de la page ; or un schéma ou une figure fait parfois toute la valeur de la source.

**Ce que ça fait.** Télécharge les images d'une page **dans le vault**, pour que la note ingérée puisse les référencer localement — l'archive reste complète même si la page d'origine disparaît.

**Comment l'utiliser.** Utilisé pendant l'ingestion web quand la préservation des images est demandée ; appelable directement sur une URL + un vault cible.
