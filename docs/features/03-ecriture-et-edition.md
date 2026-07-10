# 3 · Écriture et édition

Tout ce qui **modifie** le contenu d'un vault : créer des notes, les compléter, les éditer chirurgicalement, gérer leurs métadonnées, les déplacer, les supprimer. Chaque outil d'écriture retourne une URL click-to-open ([fiche 10](10-liens-et-navigation.md)) pour vérifier le résultat dans Obsidian d'un clic.

## `write_file` — créer ou remplacer une note

**Le besoin.** Créer une nouvelle note (compte rendu, fiche de trade, page wiki) ou réécrire entièrement une note existante.

**Ce que ça fait.** Écrit le contenu complet du fichier au chemin donné — création si le fichier n'existe pas, remplacement intégral sinon. Le flag `ifNew: true` transforme l'appel en création stricte : il **refuse** d'écraser un fichier existant, utile quand on veut la garantie de ne rien perdre.

**Comment l'utiliser.**

> « crée une note Trades/2026-05-02 - GLE Long », « enregistre ça comme X.md » — ou `/obsidian-router:write-create-or-replace`

```jsonc
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "content": "---\nstatus: open\nticker: GLE\n---\n\n# GLE Long\n\nEntry: ...",
  "ifNew": true
}
```

**À savoir.** Pour modifier *une partie* d'une note existante, préférez `patch_file` (ci-dessous) : réécrire tout le fichier pour changer trois lignes est le meilleur moyen d'écraser du contenu par accident.

## `append_to_file` — ajouter à la fin

**Le besoin.** Les journaux, logs et captures au fil de l'eau : on veut ajouter une entrée à la fin d'un fichier sans toucher à ce qui précède.

**Ce que ça fait.** Ajoute le contenu à la fin du fichier. Si le fichier n'existe pas encore, il est créé automatiquement — sauf si on passe `requireExisting: true` pour exiger qu'il existe déjà.

**Comment l'utiliser.**

> « ajoute à mon journal du jour : TSLA breakout invalidé, stop touché à 178.40 » — ou `/obsidian-router:write-append`

```jsonc
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "content": "\n## 14:32 — TSLA breakout invalidé\n\nStop touché à 178.40\n"
}
```

## `patch_file` — édition chirurgicale

**Le besoin.** Modifier **une section précise** d'une longue note — insérer une ligne sous un titre, remplacer un bloc, changer une clé de frontmatter — sans réécrire le fichier entier ni risquer d'abîmer le reste.

**Ce que ça fait.** Applique une opération (`append`, `prepend`, `replace`) sur une cible désignée par son type :

- **`heading`** — vise une section par son chemin de titres complet, délimité par `::` (ex. `Session 2026-05-02::Trades du jour`).
- **`block`** — vise un bloc par son identifiant `^block-id`.
- **`frontmatter`** — vise une clé de frontmatter par son nom.

**Comment l'utiliser.**

> « ajoute cette ligne sous la section Trades du jour », « passe le statut de la note X à closed » — ou `/obsidian-router:write-patch`

```jsonc
// Insérer sous un titre :
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "operation": "append",
  "targetType": "heading",
  "target": "Session 2026-05-02::Trades du jour",
  "content": "- TSLA: stopped out -1.2%\n"
}
// Mettre à jour une clé de frontmatter :
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "operation": "replace",
  "targetType": "frontmatter",
  "target": "status",
  "content": "closed"
}
```

**À savoir — le piège classique.** Pour une cible `heading` sous le H1 du document, il faut donner le **chemin complet des titres ancêtres** (`H1::H2::H3`), pas seulement le titre feuille. Un titre feuille seul renvoie `invalid-target` — il ne fonctionne que pour les titres racine.

## `set_frontmatter` et `merge_frontmatter` — gérer les métadonnées

**Le besoin.** Le frontmatter est la colonne vertébrale des workflows Obsidian (statuts, tags, dates, relations) : il faut pouvoir le mettre à jour proprement, sans casser les types ni réécrire la note.

**Ce que ça fait.**

- **`set_frontmatter`** — pose ou remplace **une** propriété. Les types sont préservés : chaîne, nombre, booléen, null, tableau, objet.
- **`merge_frontmatter`** — applique **plusieurs** mises à jour en une passe. Les écritures sont séquentielles, **pas atomiques** : en cas d'échec partiel, le rapport indique quelles clés ont été écrites et lesquelles ont échoué.

**Comment l'utiliser.**

> « passe le statut de X à closed », « tag cette note avec strategy » — ou `/obsidian-router:write-frontmatter-set`
> « sur X, mets status=closed et outcome=tp1 » — ou `/obsidian-router:write-frontmatter-merge`

**À savoir.** Dès qu'il y a deux propriétés ou plus à changer sur le même fichier, `merge_frontmatter` est le bon choix (un appel au lieu de N).

## `move_file` — déplacer ou renommer

**Le besoin.** Réorganiser le vault : renommer une note, la déplacer dans un autre dossier.

**Ce que ça fait.** L'API Local REST n'a pas d'opération « move » native, alors le router la compose : lecture de la source → écriture à destination → suppression de la source. `overwrite: true` autorise le remplacement d'une destination existante.

**Comment l'utiliser.**

> « renomme X en Y », « déplace X dans le dossier Archives » — ou `/obsidian-router:manage-move`

**À savoir.** Si la dernière étape (suppression de la source) échoue, le router **le signale explicitement** au lieu d'échouer en silence : vous savez qu'un doublon temporaire existe et où faire le ménage. Les `[[wikilinks]]` Obsidian se résolvent par nom de fichier, donc déplacer une note d'un dossier à l'autre ne casse pas les liens qui pointent vers elle (le renommage, si).

## `delete_file` — supprimer, avec garde-fou

**Le besoin.** Supprimer une note, mais jamais par accident — une suppression via l'API est définitive, et un modèle de langage peut se tromper de fichier.

**Ce que ça fait.** La suppression exige un `confirm: true` **explicite**. Le flux en deux temps de la slash command montre d'abord un aperçu du fichier visé et refuse d'agir ; il faut confirmer pour que la suppression parte réellement.

**Comment l'utiliser.**

> « supprime _scratch/old.md » → aperçu et demande de confirmation → « oui, confirme » — ou `/obsidian-router:manage-delete`

```jsonc
{ "vault": "tradingview", "path": "_scratch/old.md", "confirm": true }
```

**À savoir.** En mode multi-tenant lecture seule (`OBSIDIAN_ROUTER_READONLY=true`, [fiche 11](11-securite-et-isolation.md)), tous les outils d'écriture de cette fiche — suppression comprise — sont désactivés et refusés même en appel direct.
