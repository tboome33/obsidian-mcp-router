## Default vault health check at session start

Cette règle dit à Claude de **vérifier au début de chaque session** si le vault Obsidian par défaut est ouvert et réactif (Local REST API joignable). Si non, surface un **message en langage naturel** avec un **lien cliquable** pour ouvrir Obsidian en un click — au lieu d'attendre qu'un tool call vault-related plante avec une erreur cryptique.

### Pourquoi cette règle existe

Sans elle, le scénario typique est : l'user lance Claude Code, demande *"crée une note dans wiki/X.md"*, Claude appelle `write_file` sans `vault:` → le router résout vers le default vault → le default vault est offline (Obsidian fermé) → erreur `ECONNREFUSED` cryptique. L'user ne sait pas que le problème est "ouvre Obsidian", il croit que Claude est cassé.

Avec la règle : Claude ping le default vault dès qu'il en sait l'identité, et **avant** de tenter le moindre tool call vault-related, surface un warning compréhensible avec une option "ouvre Obsidian maintenant".

### Procédure obligatoire (session start)

1. **Au tout début de la session** (ou la première fois qu'un tool call vault-related est envisagé), call `list_vaults` une fois.
2. **Lire le champ top-level `defaultVaultStatus`** dans la réponse. C'est un objet avec :
   ```
   {
     "name": "roland",                 // slug router (lowercase)
     "obsidianName": "Roland",          // basename exact case → pour URI
     "type": "local",
     "online": false,                   // ← LE flag critique
     "error": "ECONNREFUSED ...",       // null si online
     "missingApiKey": false,
     "openUri": "obsidian://open?vault=Roland",  // ← lien cliquable
     "path": "P:\\Mon Drive\\VAULTS\\Roland"
   }
   ```
   Si `defaultVaultStatus` est `null` → pas de default vault configuré, ignorer cette règle (laisse les tool calls explicites avec `vault:` se débrouiller).

3. **Si `defaultVaultStatus.online === true`** → silence, on continue normalement. Ne PAS spammer l'user avec un message "tout va bien".

4. **Si `defaultVaultStatus.online === false`** → composer un message en langage naturel **AVANT** tout autre tool call vault-related. Template :

   > **⚠️ Le vault Obsidian par défaut (`<obsidianName>`) n'est pas joignable.**
   >
   > Ça veut dire que si je dois lire ou écrire des notes (dans le wiki, journaliser quelque chose, sauvegarder un résumé…), ça va échouer avec une erreur réseau cryptique. Concrètement :
   >
   > - **Obsidian est probablement fermé** sur ta machine, OU
   > - **Le plugin Local REST API est désactivé**, OU
   > - **Le port a changé** (rare, mais possible après un reboot)
   >
   > **Trois options pour avancer** :
   >
   > 1. **Ouvrir Obsidian maintenant** → [clique pour ouvrir `<obsidianName>`](`<openUri>`) *(ça lance Obsidian sur ce vault précis ; le warning disparaîtra au prochain appel)*
   > 2. **Bosser sur un autre vault** → dis-moi lequel (*"on bosse sur smile aujourd'hui"*) et je passerai `vault: smile` à chaque appel
   > 3. **Ignorer** si on ne touche pas aux notes cette session — pas de souci, mais je te repreviendrai si je dois tenter une écriture

   Adapter le ton à la langue de l'user (FR/EN), garder la structure (3 options, lien cliquable en option 1).

5. **Si `defaultVaultStatus.missingApiKey === true`** (vault accessible mais pas de clé API) → variante du message :

   > **⚠️ Le vault `<obsidianName>` est accessible mais sans clé API.**
   >
   > Local REST API est installé mais pas configuré (ou la clé n'a pas été lue par le router). Re-run `node scripts/setup-vault.mjs <path>` du router, ou ouvre Obsidian → Settings → Local REST API → copy l'API key.
   >
   > En attendant : [ouvrir Obsidian](`<openUri>`) pour vérifier le plugin.

6. **NE PAS continuer aux autres tool calls vault-related** tant que l'user n'a pas explicitement acknowledged. Si l'user a dit *"continue quand même"* ou *"travaille en read-only sur smile"*, c'est ok — sinon attendre.

### Format du lien

Utiliser un **markdown link standard** : `[label](obsidian://open?vault=<encoded>)`. Claude Code rend ce link cliquable et le dispatche au browser → l'OS handler ouvre Obsidian. **Ne pas wrapper** en backticks (sinon ça devient du code inline non-cliquable). **Ne pas** essayer de rendre l'URI lui-même cliquable sans markdown link — selon le client Claude, l'URI brut peut ne pas être détecté.

### Re-check après acknowledgment

Si l'user clique le lien et dit *"voilà, c'est ouvert"*, OU si l'user répond *"continue"* après un délai, refaire un `list_vaults` discret pour confirmer `online: true` avant le prochain write tool call. Si toujours offline, re-poser la question (peut-être un autre problème : port changé, plugin crashé).

### Anti-patterns

- ❌ Lancer des `write_file` / `patch_file` directement sans avoir vérifié `defaultVaultStatus.online` → erreur réseau cryptique pour l'user
- ❌ Surfacer le warning en jargon technique (*"ping failed, ECONNREFUSED to 127.0.0.1:27124"*) → l'user ne sait pas que ça veut dire "ouvre Obsidian"
- ❌ Boucler des retries silencieusement quand le vault est offline → délai pour rien, l'user voit "claude réfléchit" pendant 30s
- ❌ Spammer le warning à chaque tool call vault-related — un seul affichage au début + après une tentative ratée explicite suffit
- ❌ Composer le lien `obsidian://` à la main au lieu d'utiliser `defaultVaultStatus.openUri` (le routeur l'a déjà construit + URL-encodé correctement)

### Source

Convention shippée en v0.10.0 du router (2026-05-21) à la demande de Roland : *"il faudrait un moyen d'alerter lors d'une session que le vault par défaut n'est pas ouvert"* + *"tu pourrais donner une explication en un language plus naturel, on ne comprend pas trop ce qui va se passer si le vault par défaut n'est pas ouvert. Ensuite est ce qu'il n'existe pas un moyen de l'ouvrir depuis un lien avec claude ?"*. La même règle vit aussi dans le `~/.claude/CLAUDE.md` global de l'user pour application par défaut sans installation per-vault. Voir aussi `wiki/obsidian-mcp-router/router-ux-improvements-roadmap.md` Phase 1.
