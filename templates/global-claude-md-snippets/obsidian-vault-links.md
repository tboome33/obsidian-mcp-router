## Obsidian vault links (formatage des réponses) — v2 click-to-open

Quand tu mentionnes ou linkes un fichier d'un vault Obsidian accessible via les tools `mcp__obsidian-router__*`, **utilise un markdown link http(s)** qui pointe sur l'endpoint `GET /open/<path>` du plugin `mcp-router-bridge` (v0.2.0+). Claude Code CLI rend les markdown links `[label](http://...)` cliquables, donc un click ouvre directement le fichier dans Obsidian.

**Format à utiliser :**
```
[<nom-affiché>](http://127.0.0.1:<insecurePort>/open/<chemin-URL-encodé>)
```

**Préférence HTTP** : sur les machines avec Bitdefender / ESET / Kaspersky, les connexions HTTPS loopback à cert auto-signé sont interceptées et droppées silencieusement (aucun warning de cert, requête tuée avant Local REST API). Le serveur HTTP non-chiffré de Local REST API contourne le problème, et reste safe parce que la route `/open/*` est loopback-only + navigation-only + no read/write/exec. Préfère TOUJOURS le `http://` + `insecurePort` à `https://` + `port`.

(Markdown link standard, URI http(s) → Claude Code la dispatche au browser → browser hit le bridge → bridge appelle `app.workspace.openLinkText` → Obsidian navigue. Pas de roundtrip `obsidian://` ; pas de copy-paste manuel.)

Règles d'encoding :
- **Port** : ne PAS deviner. Lis `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` du vault cible et utilise le champ `insecurePort` tel quel. Vérifie aussi `enableInsecureServer: true` — sinon le serveur HTTP n'écoute pas. Le default du plugin est `insecurePort: 27123` indépendamment du port HTTPS ; `setup-vault.mjs` provisionne `insecurePort = port + 10` pour éviter les collisions multi-vault.
- **Chemin du fichier** : URL-encode les slashes en `%2F`. Garde l'extension `.md` (le bridge fait `getAbstractFileByPath` qui matche le path complet). Exemple : `wiki/references/router-agents.md` → `wiki%2Freferences%2Frouter-agents.md`.
- **Nom affiché** : généralement le filename sans extension (ex. `router-agents`), ou un titre lisible si le contexte le justifie.

**Exemple concret** pour `Machine Learning Specialization/.../01 - Welcome.md` dans le vault `coursera` (port HTTPS 27133, insecurePort HTTP 27143) :

```
[01 - Welcome](http://127.0.0.1:27143/open/Machine%20Learning%20Specialization%2FCourse%202%20-%20Advanced%20Learning%20Algorithms%2FWeek%201%20-%20Neural%20Networks%2F01%20-%20Welcome.md)
```

**Workflow user** : un click → browser ouvre l'URL → bridge navigue Obsidian → tab browser se ferme tout seul (best-effort). Pas de copy-paste.

### Prérequis (à mentionner si jamais ça ne marche pas)

- **Plugin `mcp-router-bridge` ≥ v0.2.0** installé dans le vault cible. Si pas le bon, GET /open/ renvoie 404 (route inexistante) ou 401 (route auth-protected).
- **Local REST API ≥ v4.x** (la version qui expose `addPublicRoute`). Sinon le bridge log un warning au load et ne registre pas la route `/open/*` → 404 systématique.
- **`enableInsecureServer: true`** dans `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` + reload Obsidian après modification. `setup-vault.mjs --upgrade-insecure-server-all` patch ce champ sur tous les vaults bootstrappés en un coup.
- **⚠️ Bitdefender / ESET / Kaspersky (HTTPS scanning)** : ces AV droppent silencieusement les connexions HTTPS loopback à cert auto-signé. **Fix** : utiliser le serveur HTTP non-chiffré (cf ci-dessus). Safe car la route `/open/*` est loopback-only + navigation-only + no read/write/exec.

### Fallback si l'endpoint /open n'est pas dispo

Si le bridge est trop vieux ou l'endpoint ne répond pas, retombe sur l'ancien format URI Obsidian en inline-code :
```
**router-agents** — `obsidian://open?vault=<vault-name>&file=wiki%2Freferences%2Frouter-agents`
```
(L'user copy-paste dans Win+R. Pas cliquable mais marche partout sans setup.)

### Quand NE PAS utiliser le format http://localhost/open

- **Wikilinks INTERNES** à un fichier markdown qu'on écrit DANS le vault → utilise la syntaxe Obsidian native `[[page-name]]`. Ces wikilinks sont vault-internes et Obsidian les résout nativement (et ils survivent au déplacement de fichier, contrairement aux URIs).
- **Paths dans des code blocks, commandes shell, messages d'erreur, contextes techniques** où le path doit rester copy-pasteable comme un path système classique.
- **Quand on parle d'un fichier qui N'EST PAS dans un vault Obsidian** (genre `package.json`, `src/index.mjs`, un fichier de plan local sous `~/.claude/plans/`). Garde le path brut.
