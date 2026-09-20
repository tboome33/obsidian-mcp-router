# Écrire dans un vault depuis un script

Ce document répond à une seule question : **par où passe une écriture, et laquelle protège vraiment contre l'écrasement.**

Il existe parce que la réponse est contre-intuitive, et qu'une session l'a apprise en cassant la règle qu'elle connaissait par cœur.

## La règle en une phrase

Une écriture dans un vault passe par `writeFileIfMatch` de `src/rest-client.mjs`, ou par un outil du routeur. Jamais par un `fetch` écrit à la main.

## Pourquoi `If-Match` ne suffit pas

Le réflexe naturel est celui-ci :

```js
// NE FAIT RIEN. L'en-tête est ignoré.
await fetch(`${base}/vault/${p}`, {
  method: 'PUT',
  headers: { ...auth, 'If-Match': `"${sha}"` },
  body: content,
});
```

Cette écriture part **sans aucune protection**, et le serveur ne le signale pas.

La raison : le plugin Local REST API n'implémente pas `If-Match` sur `PUT /vault/`. Son seul code `if-match` se trouve dans la bibliothèque `send` qu'il embarque, et cette bibliothèque sert les GET de fichiers statiques. Vérifié dans le code du plugin, pas supposé.

Deuxième piège, indépendant du premier : le JSON que renvoie la route note (`Accept: application/vnd.olrapi.note+json`) porte un champ `stat` qui contient `ctime`, `mtime` et `size` — **et pas de `contentSha256`**. Ce champ appartient au routeur, qui le calcule lui-même. Un script qui le lit là obtient `undefined`, et un code de la forme `sha ? { 'If-Match': … } : {}` n'envoie alors même plus l'en-tête.

Les deux pièges se cumulent, et aucun des deux ne produit d'erreur.

## La route qui protège

La vraie précondition est `If-Match-Content-Sha256`, sur `PUT /vault-cas/<chemin>`. Cette route est servie par le plugin bridge, qui fait lire-comparer-écrire sous un verrou, à l'intérieur du process Obsidian.

`writeFileIfMatch` s'en sert, avec un repli si le bridge est absent :

| Palier | Ce qui se passe | Ce que ça garantit |
|---|---|---|
| `atomic` | `PUT /vault-cas/` accepté par le bridge | la vérification et l'écriture sont indivisibles **entre écrivains CAS** |
| `fallback` | bridge absent → relecture, comparaison, puis `PUT /vault/` | la fenêtre est réduite à un aller-retour, pas fermée |

**Ce que ça ne garantit pas, dans les deux cas** : rien ne protège contre l'éditeur Obsidian ouvert sur le fichier, ni contre une application Sync ou LiveSync. Ces écrivains-là ne participent pas au protocole. La fonction le dit dans son propre contrat ; un appelant honnête rapporte `casMode` au lieu de laisser croire à une garantie unique.

## L'outil à utiliser

```bash
node scripts/vault-edit.mjs \
  --vault "<nom du vault>" \
  --path "wiki-meta/hot.md" \
  --spec mon-edit.json \
  --dry-run
```

Le fichier de spec contient les modifications. Deux formes :

```json
{ "edits": [
  { "kind": "unique", "from": "<texte exact>", "to": "<remplacement>" },
  { "kind": "line",   "startsWith": "<début de ligne>", "to": "<ligne entière>" }
] }
```

ou un remplacement complet du fichier :

```json
{ "contentFile": "mon-nouveau-contenu.md" }
```

Le texte vit dans un fichier JSON, jamais sur la ligne de commande : un shell mange les antislashs et les accents graves en silence.

La forme `line` existe pour un cas précis. Une apostrophe droite `'` et une apostrophe typographique `’` sont indiscernables dans un terminal ; viser une ligne par son début évite d'avoir à deviner laquelle est dans le fichier.

### Ce que l'outil refuse

- **Zéro correspondance** — le repère est périmé, la représentation que vous avez du fichier est fausse.
- **Deux correspondances ou plus** — le repère ne désigne pas ce que vous croyez.
- **Une modification qui en masque une autre** — l'original est reconstruit depuis le résultat et comparé octet pour octet ; si ça ne retombe pas juste, rien n'est écrit.
- **Un fichier absent** — une empreinte de contenu ne peut pas garder ce qui n'existe pas. Créez-le avec `write_file` et `ifNew: true`, puis éditez-le ici.

Dans tous ces cas, le fichier reste intact et le code de sortie vaut 1.

## Le garde

`tests/vault-write-door.test.mjs` lit tout le code de `src/`, `scripts/`, `hooks/` et `bin/`, et fait échouer la suite si un fichier :

- nomme une route `/vault/` avec un verbe d'écriture (`PUT`, `POST`, `PATCH`, `DELETE`), hors de `src/rest-client.mjs` ;
- appelle `fetch()` hors d'une allowlist de quatre fichiers, chacun accompagné de sa raison.

Deux précisions sur sa construction, parce qu'elles expliquent pourquoi il ne se contente pas d'un `grep` :

**Il cherche la chose interdite, pas la chose requise.** Un garde qui vérifie qu'un fichier *mentionne* le bon helper passe sur un fichier où l'appel réel a été supprimé — c'est arrivé ici, et la leçon est écrite dans `tests/security-invariants.test.mjs`.

**Il est joué contre de vrais fautifs.** Un motif qui ne correspond à rien rapporterait un dépôt propre pour toujours. Les contrôles couvrent le `PUT` écrit à la main, un `fetch` nu, le même code placé dans un commentaire (qui ne doit **pas** être signalé — ce document et le script citent tous deux le défaut), et un `//` à l'intérieur d'une chaîne qu'un analyseur naïf avalerait.

### Ce que le garde ne peut pas faire

Il ne voit que le dépôt. Un script écrit dans un dossier temporaire lui échappe, et rien dans ce dépôt ne peut l'atteindre. C'est précisément pour ça que `scripts/vault-edit.mjs` existe : la bonne porte doit être plus courte à emprunter que la mauvaise.

## Ajouter une entrée à l'allowlist

C'est un acte délibéré, et c'est le but. L'entrée porte un nom de fichier **et** une raison, et le garde vérifie que le fichier existe encore. Une allowlist qui survit à ses fichiers cesse d'être une liste de décisions pour devenir une liste de noms, et le lecteur suivant l'élargit par habitude.
