# How to update obsidian-mcp-router

> 🇫🇷 Version française ci-dessous · [🇫🇷 jump to version française](#-version-française)

---

## TL;DR

Three ways to know about an update + three ways to apply it.

| Discovery | Application |
|---|---|
| **Built-in update check** (since v0.10.3) — once per 24h on session start, a notice is surfaced if a newer version is available | **`/plugin update`** — Claude Code slash command, the one-liner path |
| **Watch the GitHub repo** — `Watch → Custom → Releases` for email notifications | **Manual filesystem update** — for environments where `/plugin` is unavailable |
| **Periodic blind check** — run `/plugin update obsidian-router@obsidian-mcp-router-marketplace` every now and then | **Auto-update** (opt-in, since v0.14.0) — `OBSIDIAN_ROUTER_AUTO_UPDATE=true` and the next-session-start hook applies the update for you |

---

## Discovery — how do I know there's a new version?

### Option 1 — Built-in update check (recommended, since v0.10.3)

The router ships a SessionStart hook (`hooks/check-router-update.mjs`) that does the following, **at most once per 24 hours**, **silently failing on any error**:

1. Reads your installed version from the plugin's `package.json`.
2. Fetches the version from `https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json`.
3. If GitHub's version is newer, emits a notice as session context — Claude picks it up and relays it on its first response of the session.
4. Caches the result in `~/.claude/obsidian-mcp-router/.last-version-check.json` so the next 24h of sessions don't re-hit GitHub.

The notice looks like:

```
📦 obsidian-mcp-router v0.11.0 is available (you have v0.10.3).

How to update:
- Try: /plugin update obsidian-router@obsidian-mcp-router-marketplace
- If /plugin is unavailable in your environment, see the manual update guide at
  https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/how-to-update.md

Changelog: https://github.com/tboome33/obsidian-mcp-router/blob/main/CHANGELOG.md

To disable this once-per-day update check: set env var OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true.
```

**Opt-out** — set either of these env vars and the check is skipped:
- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (truthy: `true` / `1` / `yes` / `on`)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (set by multi-tenant deployments — the assumption is the sysadmin manages updates centrally)

**Privacy** — the check is a single GET to GitHub's raw content (`raw.githubusercontent.com`) with the User-Agent `obsidian-mcp-router/check-router-update`. No payload is sent. No telemetry. No collection. Cache is local to your machine. Source: [hooks/check-router-update.mjs](../hooks/check-router-update.mjs).

**Hook wire-up** — the example `hooks.example.json` shipped with the plugin already includes the wire-up under `SessionStart`. If you customized your hooks file, you'll want to add this entry (already present in fresh installs via the `meta-setup` skill):

```json
"SessionStart": [{
  "matcher": "startup|resume",
  "hooks": [
    { "type": "command", "command": "node \"<router-repo>/hooks/hot-cache-load.mjs\"" },
    { "type": "command", "command": "node \"<router-repo>/hooks/check-router-update.mjs\"" }
  ]
}]
```

### Option 2 — Watch the GitHub repo

Go to https://github.com/tboome33/obsidian-mcp-router → click `Watch` (top-right) → `Custom` → check `Releases`. GitHub will email you on every new tag. Zero plumbing in your local setup, fully under your control, works even if you've disabled the SessionStart check.

### Option 3 — Periodic blind check

Just run `/plugin update obsidian-router@obsidian-mcp-router-marketplace` every now and then. If there's nothing to update, Claude Code reports "already up to date". If there is, it applies the update.

---

## Application — how do I actually update?

### Path A — `/plugin update` (when available)

If `/plugin` is available in your Claude Code environment, this is the one-liner:

```
/plugin update obsidian-router@obsidian-mcp-router-marketplace
```

Claude Code will:
1. `git pull` in `~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace/`
2. Clone the new version content into `~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/<new-version>/`
3. Update `~/.claude/plugins/installed_plugins.json` to point at the new version
4. Prompt you to reload Claude Code

After reload, you're on the new version.

### Path B — manual filesystem update (when `/plugin` is unavailable)

Some Claude Code environments don't expose the `/plugin` slash command. The output you'd see in those environments:

```
/plugin update obsidian-router@obsidian-mcp-router-marketplace
<local-command-stdout>/plugin isn't available in this environment.</local-command-stdout>
```

In that case, the update is **5 filesystem steps** that mimic exactly what `/plugin update` does internally:

```bash
# Variables for clarity
MARKETPLACE_DIR=~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace
CACHE_BASE=~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router
NEW_VERSION=0.10.3  # ← replace with the actual new version

# 1) Pull the new version into the marketplace clone
cd "$MARKETPLACE_DIR"
git pull origin main

# 2) Create a fresh cache folder for the new version
mkdir -p "$CACHE_BASE/$NEW_VERSION"

# 3) Copy the marketplace content into the cache (exclude .git and any pre-existing node_modules)
tar --exclude='.git' --exclude='node_modules' -cf - -C "$MARKETPLACE_DIR" . | \
  tar -xf - -C "$CACHE_BASE/$NEW_VERSION"

# 4) Install plugin runtime deps (production only)
cd "$CACHE_BASE/$NEW_VERSION"
npm install --omit=dev

# 5) Update installed_plugins.json — change the entry for
# "obsidian-router@obsidian-mcp-router-marketplace" so that:
#   - installPath ends with /<NEW_VERSION>
#   - version       = "<NEW_VERSION>"
#   - lastUpdated   = today's ISO timestamp
#   - gitCommitSha  = the new commit SHA (git -C $MARKETPLACE_DIR rev-parse HEAD)
```

Then **close and relaunch Claude Code** (not just the conversation — the process). On restart, Claude Code reads `installed_plugins.json`, sees the new `installPath`, and loads from the new cache folder.

### PowerShell equivalent (Windows-native)

```powershell
$marketplace = "$env:USERPROFILE\.claude\plugins\marketplaces\obsidian-mcp-router-marketplace"
$cacheBase   = "$env:USERPROFILE\.claude\plugins\cache\obsidian-mcp-router-marketplace\obsidian-router"
$newVersion  = "0.10.3"  # ← replace with the actual new version

# 1) Pull
git -C $marketplace pull origin main

# 2) Create cache folder
$dst = Join-Path $cacheBase $newVersion
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 3) Copy (excluding .git and node_modules)
robocopy $marketplace $dst /E /XD .git node_modules | Out-Null

# 4) Install deps
Push-Location $dst
npm install --omit=dev
Pop-Location

# 5) Then edit ~/.claude/plugins/installed_plugins.json by hand
# (see fields listed in the bash recipe above)
```

### Path C — Auto-update (opt-in, since v0.14.0)

If you want updates applied automatically the next time you start a Claude Code session, set:

```
OBSIDIAN_ROUTER_AUTO_UPDATE=true
```

in your shell environment (or in the plugin env vars in `~/.claude/settings.json`). The next time the `check-router-update` SessionStart hook detects a newer version on GitHub, it does everything `/plugin update` does internally:

1. `git pull --ff-only` in `~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace/`
2. Copy the new version into `~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/<new-version>/` (excluding `.git` and `node_modules`)
3. `npm install --omit=dev` in the new cache dir
4. Update `installed_plugins.json` (installPath, version, lastUpdated, gitCommitSha) atomically
5. Rewrite any pinned hook paths in `~/.claude/settings.json` from `cache/.../<old-version>/` to `cache/.../<new-version>/`

After it succeeds, the hook emits this notice instead of the manual one:

```
🆙 obsidian-mcp-router auto-updated v0.13.10 → v0.14.0.

New version is already installed (cache + installed_plugins.json + settings.json hook paths refreshed).
To activate it in this session, run:

    /reload-plugins

New sessions will load v0.14.0 automatically — no action needed.
```

`/reload-plugins` is documented Claude Code behavior: a plugin's hooks / MCP / LSP servers stay pinned to the previous version's path mid-session, so you need it once to pick up the new code without a full Claude Code restart.

**Safety guards** — auto-update bails out (and falls back to the manual notice with the reason inline) if:
- You're on a dev install (`npm link` or running from a checked-out repo) — the hook only touches marketplace caches
- The marketplace clone is dirty (uncommitted edits) — we never obliterate local edits
- `git pull --ff-only` would diverge — the marketplace was hand-mutated, refuse to clobber
- The post-pull `package.json` version doesn't match what GitHub raw advertised (race condition / weird state)
- `npm install` fails
- `installed_plugins.json` is missing or doesn't have your plugin's entry

**Opt-out** — unset `OBSIDIAN_ROUTER_AUTO_UPDATE` (or set it to `false` / `0` / `no` / `off`). You'll be back on the manual notice flow.

**Limitation** — there's a one-session lag. The auto-update happens during session N's SessionStart hook, but Claude Code has already loaded the OLD plugin code into memory for that session. You either run `/reload-plugins` mid-session, or just wait until the next session start — the next session loads from the freshly-updated cache.

---

## Why was this previously not fully automatic?

Up to v0.13.x, application required user consent (the `/plugin update` invocation or the manual recipe). This is intentional in Claude Code: plugins can ship hooks, MCP servers, slash commands — auto-installing arbitrary code from a marketplace is a security footgun if it's the default. The notice told you it was there; you chose when to pull.

v0.14.0 adds **opt-in** auto-update: you have to set the env var deliberately, which is your explicit consent to "yes, please run the same `/plugin update` steps for me, silently, every time there's a new version". If/when Claude Code adds a first-class "auto-update plugins" setting, the env var becomes redundant and we'll deprecate it.

---

## Troubleshooting

### "I see the notice every session even though I just updated"

Two things to check:
1. **Did you close Claude Code completely after updating?** The plugin loader reads `installed_plugins.json` once at startup. If you only restarted the conversation but the process is the same, the in-memory plugin path still points at the old folder, and the SessionStart hook runs from the old folder → reads old `package.json` → still sees the gap.
2. **Did you update `installed_plugins.json`?** If you copied the new files into the new cache folder but forgot step 5, Claude Code is still loading the old version. Verify with:

   ```bash
   cat ~/.claude/plugins/installed_plugins.json | grep -A 4 obsidian-router
   ```

   The `installPath` should end in the new version folder name.

### "I want to skip a release"

Just don't update. The notice persists (replayed from cache for 24h, then re-checked) — it doesn't block anything. You can also set `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` for a few days, then unset it later.

### "I'm on a dev install (npm link) and the notice says I'm 'ahead'"

You won't see the notice in that case — the check is `latestFromGitHub > installedLocally`. If you're on `0.10.4-dev` and GitHub is at `0.10.3`, the comparator returns `≤ 0` and no notice is shown.

### "The check is hitting GitHub even when I'm offline"

It's not — the request times out after 3 seconds and the hook exits silently. Worst case: a 3-second delay on session start, once per 24h. If you want to avoid even that, set `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`.

---

# 🇫🇷 Version française

## En bref

Trois façons de savoir + trois façons d'appliquer.

| Découverte | Application |
|---|---|
| **Check d'update intégré** (depuis v0.10.3) — une fois par 24h au démarrage de session, une notice s'affiche si une nouvelle version est dispo | **`/plugin update`** — le slash command Claude Code, le path one-liner |
| **Watch le repo GitHub** — `Watch → Custom → Releases` pour les notifs email | **Update manuel filesystem** — pour les environnements où `/plugin` n'est pas dispo |
| **Check périodique à l'aveugle** — lance `/plugin update obsidian-router@obsidian-mcp-router-marketplace` de temps en temps | **Auto-update** (opt-in, depuis v0.14.0) — `OBSIDIAN_ROUTER_AUTO_UPDATE=true` et le hook SessionStart applique l'update à ta place |

---

## Découverte — comment je sais qu'une nouvelle version existe ?

### Option 1 — Check intégré (recommandé, depuis v0.10.3)

Le router ship un hook SessionStart (`hooks/check-router-update.mjs`) qui fait ce qui suit, **au max une fois par 24h**, **en échouant silencieusement sur toute erreur** :

1. Lit ta version installée depuis le `package.json` du plugin.
2. Fetch la version depuis `https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json`.
3. Si GitHub a une version plus récente, émet une notice comme context de session — Claude la récupère et la relaye sur sa première réponse.
4. Cache le résultat dans `~/.claude/obsidian-mcp-router/.last-version-check.json` pour éviter de re-hit GitHub pendant les 24h suivantes.

La notice ressemble à :

```
📦 obsidian-mcp-router v0.11.0 is available (you have v0.10.3).

How to update:
- Try: /plugin update obsidian-router@obsidian-mcp-router-marketplace
- If /plugin is unavailable in your environment, see the manual update guide at
  https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/how-to-update.md

Changelog: https://github.com/tboome33/obsidian-mcp-router/blob/main/CHANGELOG.md

To disable this once-per-day update check: set env var OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true.
```

**Opt-out** — définis une de ces env vars et le check est skippé :
- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (truthy : `true` / `1` / `yes` / `on`)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (set par les déploiements multi-tenant — l'hypothèse est que le sysadmin gère les updates centralement)

**Privacy** — le check est un seul GET sur le raw content GitHub (`raw.githubusercontent.com`) avec le User-Agent `obsidian-mcp-router/check-router-update`. Aucun payload envoyé. Aucune télémétrie. Aucune collecte. Le cache est local à ta machine. Source : [hooks/check-router-update.mjs](../hooks/check-router-update.mjs).

**Wire-up du hook** — le `hooks.example.json` shippé avec le plugin inclut déjà l'entrée sous `SessionStart`. Si tu as customisé ton fichier hooks, ajoute cette entrée (présente par défaut dans les installs fresh via le skill `meta-setup`) :

```json
"SessionStart": [{
  "matcher": "startup|resume",
  "hooks": [
    { "type": "command", "command": "node \"<router-repo>/hooks/hot-cache-load.mjs\"" },
    { "type": "command", "command": "node \"<router-repo>/hooks/check-router-update.mjs\"" }
  ]
}]
```

### Option 2 — Watch le repo GitHub

Va sur https://github.com/tboome33/obsidian-mcp-router → clique `Watch` (en haut à droite) → `Custom` → coche `Releases`. GitHub t'enverra un email à chaque nouveau tag. Zéro plumbing dans ton setup local, complètement sous ton contrôle, marche même si tu as désactivé le check SessionStart.

### Option 3 — Check périodique à l'aveugle

Lance juste `/plugin update obsidian-router@obsidian-mcp-router-marketplace` de temps en temps. Si y a rien à update, Claude Code dit "already up to date". S'il y a, il applique.

---

## Application — comment je fais l'update en pratique ?

### Path A — `/plugin update` (quand dispo)

Si `/plugin` est dispo dans ton environnement Claude Code, c'est le one-liner :

```
/plugin update obsidian-router@obsidian-mcp-router-marketplace
```

Claude Code va :
1. `git pull` dans `~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace/`
2. Cloner le contenu de la nouvelle version dans `~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/<new-version>/`
3. Update `~/.claude/plugins/installed_plugins.json` pour pointer la nouvelle version
4. Te demander de relancer Claude Code

Après relance, tu es sur la nouvelle version.

### Path B — Update manuel filesystem (quand `/plugin` n'est pas dispo)

Certains environnements Claude Code n'exposent pas le slash command `/plugin`. La sortie que tu verras dans ces environnements :

```
/plugin update obsidian-router@obsidian-mcp-router-marketplace
<local-command-stdout>/plugin isn't available in this environment.</local-command-stdout>
```

Dans ce cas, l'update se résume à **5 étapes filesystem** qui mimic exactement ce que fait `/plugin update` en interne :

```bash
# Variables pour la clarté
MARKETPLACE_DIR=~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace
CACHE_BASE=~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router
NEW_VERSION=0.10.3  # ← remplace par la version effective

# 1) Pull la nouvelle version dans le clone marketplace
cd "$MARKETPLACE_DIR"
git pull origin main

# 2) Crée un dossier cache pour la nouvelle version
mkdir -p "$CACHE_BASE/$NEW_VERSION"

# 3) Copie le contenu marketplace dans le cache (exclure .git et tout node_modules pré-existant)
tar --exclude='.git' --exclude='node_modules' -cf - -C "$MARKETPLACE_DIR" . | \
  tar -xf - -C "$CACHE_BASE/$NEW_VERSION"

# 4) Install les deps runtime du plugin (production only)
cd "$CACHE_BASE/$NEW_VERSION"
npm install --omit=dev

# 5) Update installed_plugins.json — change l'entrée pour
# "obsidian-router@obsidian-mcp-router-marketplace" pour que :
#   - installPath se termine par /<NEW_VERSION>
#   - version       = "<NEW_VERSION>"
#   - lastUpdated   = timestamp ISO du jour
#   - gitCommitSha  = le SHA du nouveau commit (git -C $MARKETPLACE_DIR rev-parse HEAD)
```

Puis **ferme et relance Claude Code complètement** (pas juste la conversation — le process). Au restart, Claude Code lit `installed_plugins.json`, voit le nouveau `installPath`, et charge depuis le nouveau dossier cache.

### Équivalent PowerShell (Windows-native)

```powershell
$marketplace = "$env:USERPROFILE\.claude\plugins\marketplaces\obsidian-mcp-router-marketplace"
$cacheBase   = "$env:USERPROFILE\.claude\plugins\cache\obsidian-mcp-router-marketplace\obsidian-router"
$newVersion  = "0.10.3"  # ← remplace par la version effective

# 1) Pull
git -C $marketplace pull origin main

# 2) Cache folder
$dst = Join-Path $cacheBase $newVersion
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 3) Copie (en excluant .git et node_modules)
robocopy $marketplace $dst /E /XD .git node_modules | Out-Null

# 4) Install deps
Push-Location $dst
npm install --omit=dev
Pop-Location

# 5) Édite ensuite ~/.claude/plugins/installed_plugins.json à la main
# (voir les champs listés dans la recette bash ci-dessus)
```

### Path C — Auto-update (opt-in, depuis v0.14.0)

Si tu veux que les updates soient appliquées automatiquement au prochain démarrage de session Claude Code, set :

```
OBSIDIAN_ROUTER_AUTO_UPDATE=true
```

dans ton env shell (ou dans les env vars du plugin dans `~/.claude/settings.json`). La prochaine fois que le hook SessionStart `check-router-update` détecte une nouvelle version sur GitHub, il fait exactement ce que fait `/plugin update` en interne :

1. `git pull --ff-only` dans `~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace/`
2. Copie la nouvelle version vers `~/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/<new-version>/` (en excluant `.git` et `node_modules`)
3. `npm install --omit=dev` dans le nouveau dossier cache
4. Update `installed_plugins.json` (installPath, version, lastUpdated, gitCommitSha) atomiquement
5. Réécrit les paths de hooks pinned dans `~/.claude/settings.json` de `cache/.../<old-version>/` vers `cache/.../<new-version>/`

Après succès, le hook émet cette notice à la place de la notice manuelle :

```
🆙 obsidian-mcp-router auto-updated v0.13.10 → v0.14.0.

New version is already installed (cache + installed_plugins.json + settings.json hook paths refreshed).
To activate it in this session, run:

    /reload-plugins

New sessions will load v0.14.0 automatically — no action needed.
```

`/reload-plugins` est un comportement documenté de Claude Code : les hooks / MCP / LSP servers d'un plugin restent pinned sur le path de la version précédente en mid-session, donc tu en as besoin une fois pour picker le nouveau code sans relancer entièrement Claude Code.

**Garde-fous** — l'auto-update bail (et tombe sur la notice manuelle avec la raison inline) si :
- Tu es sur un dev install (`npm link` ou repo checked-out) — le hook ne touche QUE les marketplace caches
- Le clone marketplace est dirty (edits non-commitées) — on n'obliterate jamais des edits locaux
- `git pull --ff-only` divergerait — le marketplace a été modifié à la main, refuse de clobber
- Le `package.json` post-pull ne matche pas la version annoncée par GitHub raw (race condition / état bizarre)
- `npm install` échoue
- `installed_plugins.json` est missing ou n'a pas d'entry pour ton plugin

**Opt-out** — unset `OBSIDIAN_ROUTER_AUTO_UPDATE` (ou set à `false` / `0` / `no` / `off`). Tu retombes sur le flow notice manuelle.

**Limitation** — il y a un lag d'une session. L'auto-update se passe pendant le hook SessionStart de la session N, mais Claude Code a déjà chargé l'ANCIEN code du plugin en mémoire pour cette session-là. Soit tu lances `/reload-plugins` mid-session, soit tu attends juste le prochain démarrage — la session suivante charge depuis le cache fraîchement updaté.

---

## Pourquoi ce n'était pas full-auto avant ?

Jusqu'à v0.13.x, l'application requérait toujours le consentement user (l'invocation `/plugin update` ou la recette manuelle). C'était intentionnel côté Claude Code : les plugins peuvent ship des hooks, des serveurs MCP, des slash commands — auto-installer du code arbitraire depuis un marketplace serait un footgun sécurité si c'était le défaut. La notice te disait qu'elle était là ; tu choisissais quand pull.

v0.14.0 ajoute l'auto-update **opt-in** : tu dois set l'env var délibérément, ce qui est ton consentement explicite à "oui, lance les mêmes étapes `/plugin update` à ma place, silencieusement, à chaque nouvelle version". Si/quand Claude Code ajoute un setting first-class "auto-update plugins", l'env var devient redondante et on la déprécirera.

---

## Troubleshooting

### "Je vois la notice à chaque session alors que je viens d'update"

Deux choses à vérifier :
1. **Tu as fermé Claude Code complètement après update ?** Le plugin loader lit `installed_plugins.json` une seule fois au startup. Si tu as juste relancé la conversation mais que le process est le même, le path plugin en mémoire pointe encore sur l'ancien dossier, et le hook SessionStart tourne depuis l'ancien dossier → lit l'ancien `package.json` → voit toujours le gap.
2. **Tu as updaté `installed_plugins.json` ?** Si tu as copié les nouveaux fichiers dans le nouveau dossier cache mais oublié l'étape 5, Claude Code charge toujours l'ancienne version. Vérifie avec :

   ```bash
   cat ~/.claude/plugins/installed_plugins.json | grep -A 4 obsidian-router
   ```

   Le `installPath` doit se terminer par le nom du nouveau dossier de version.

### "Je veux skip une release"

Update juste pas. La notice persiste (rejouée depuis le cache pendant 24h, puis re-check) — elle ne bloque rien. Tu peux aussi set `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` pour quelques jours, puis unset plus tard.

### "Je suis sur un dev install (npm link) et la notice dit que je suis 'en avance'"

Tu ne verras pas la notice dans ce cas — le check est `latestFromGitHub > installedLocally`. Si tu es sur `0.10.4-dev` et GitHub est à `0.10.3`, le comparateur renvoie `≤ 0` et aucune notice n'est affichée.

### "Le check hit GitHub même quand je suis offline"

Non — la requête timeout après 3 secondes et le hook exit silencieusement. Worst case : 3 secondes de délai au démarrage de session, une fois par 24h. Si tu veux éviter même ça, set `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`.
