# 4 · Templates et contenu Obsidian

Au-delà du markdown brut, Obsidian a ses propres formats riches : templates Templater, canvas visuels, bases de données `.base`, et un dialecte markdown à lui. Le router sait produire et manipuler tout ça.

## `execute_template` — exécuter un template Templater

**Le besoin.** Vos notes structurées (fiche de trade, daily note, compte rendu) existent déjà sous forme de templates Templater dans le vault. Plutôt que de demander à Claude de réinventer la structure à chaque fois — avec des variations — on veut exécuter **le vrai template**, avec des arguments.

**Ce que ça fait.** Rend un template Templater existant dans le vault, en lui passant des arguments nommés, et au choix : retourne le rendu (prévisualisation) ou l'écrit dans un nouveau fichier (`createFile: true` + `targetPath`). Les arguments sont accessibles **dans** le template.

**Comment l'utiliser.**

> « exécute le template Trade avec ticker=AAPL direction=long », « rends Templates/X.md avec arg1=v1 » — ou `/obsidian-router:template-execute`

```jsonc
{
  "vault": "tradingview",
  "name": "Templates/Trade.md",
  "arguments": { "ticker": "AAPL", "direction": "long", "entry": "175.20", "stop": "172.50" },
  "createFile": true,
  "targetPath": "Trades/2026-05-02 - AAPL Long.md"
}
```

Et côté template, on lit un argument ainsi :

```js
<% tp.mcpTools.prompt("ticker") %>
```

**À savoir — le piège classique.** Les arguments sont exposés via `tp.mcpTools.prompt("clé")` — **directement sous `tp`**, PAS sous `tp.user` comme on pourrait s'y attendre avec Templater. Deux plugins requis dans le vault cible : **Templater** et **obsidian-mcp-router-bridge** (qui expose la route `/templates/execute`).

## Skill `canvas` — la couche visuelle du vault

**Le besoin.** Certains sujets s'organisent mieux **spatialement** qu'en liste : cartographier un projet, poser des pages wiki, des images et des PDF sur un plan de travail, regrouper par zones.

**Ce que ça fait.** Crée ou modifie des fichiers `.canvas` Obsidian : ajout de nœuds (notes du vault, images, PDF, cartes de texte libre), définition de zones étiquetées, et positionnement automatique du contenu pour que le résultat soit lisible sans avoir à donner des coordonnées à la main.

**Comment l'utiliser.**

> « crée un canvas pour le projet X », « ajoute cette note à mon canvas », « visualise ce sujet sur un canvas » — ou `/obsidian-router:canvas`

## Skill `obsidian-bases` — des vues base de données sur vos notes

**Le besoin.** Quand des dizaines de notes partagent le même frontmatter (des trades avec `status`/`ticker`/`outcome`, des tâches avec `due`/`priority`), on veut les voir comme un **tableau filtrable**, pas comme des fichiers éparpillés.

**Ce que ça fait.** Crée ou modifie des fichiers `.base` — le format natif de bases de données d'Obsidian : vues table/carte/liste sur un ensemble de notes, avec filtres et formules calculées à partir du frontmatter.

**Comment l'utiliser.**

> « crée une base pour suivre mes trades ouverts », « une base task tracker sur wiki/Tasks » — ou `/obsidian-router:obsidian-bases`

**À savoir.** `obsidian-bases` est à la fois une skill invocable **et** une référence que les autres skills consultent quand elles doivent générer un `.base` — vous pouvez donc aussi obtenir une base « en passant », au sein d'un workflow plus large.

## Skill `obsidian-markdown` — le dialecte Obsidian, bien écrit

**Le besoin.** Le markdown d'Obsidian n'est pas le markdown standard : wikilinks `[[page]]`, embeds `![[image]]`, callouts `> [!note]`, propriétés… Une note générée qui les utilise mal s'affiche mal.

**Ce que ça fait.** C'est une skill de **référence** (pas de slash command) : elle documente l'Obsidian Flavored Markdown et est consultée automatiquement par les autres skills quand elles écrivent dans le vault, pour que le contenu produit utilise correctement la syntaxe native.

**À savoir.** Rien à invoquer — elle travaille en coulisse. Son existence explique pourquoi les notes générées par les workflows du router utilisent des `[[wikilinks]]` (qui survivent aux déplacements de fichiers) plutôt que des liens markdown fragiles.
