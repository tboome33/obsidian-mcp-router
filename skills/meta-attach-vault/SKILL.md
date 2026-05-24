---
name: meta-attach-vault
description: Interactive wizard to attach an Obsidian vault to a code/dev workspace (the dominant case), or bootstrap a standalone local vault, or register a remote vault. Provisions plugins + scaffolds wiki structure + binds the workspace's .env + edits .gitignore + offers a conventions picker. Use whenever the user wants to "set up Obsidian for this project", "attach a vault to this workspace", "add a vault to the router", "register a new obsidian vault", "create a wiki for this repo", "connect my remote vault" — in EN or FR. Replaces the old `meta-add-vault` skill (v0.12.7+).
---

# meta-attach-vault

Walk the user through attaching an Obsidian vault to their current context. The wizard is **didactic by design** — at every step it explains what's about to happen, why, and what will be touched. Built around the assumption that the user is mid-flow and shouldn't have to context-switch to read docs.

## Three flows, one wizard

The wizard detects the right flow from context, but the user can override at any time.

1. **Workspace-first (the common case)** — the user is in a code/dev project (cwd has `.git/` or feels like a workspace) and wants a vault attached to it. The vault lives OUTSIDE the workspace (so it never gets pushed with credentials), and the workspace's `.env` gets a line that binds them. This is what Roland does ~95% of the time.
2. **Standalone vault (rare)** — the user wants a vault that isn't tied to any code project (think personal journal). No workspace binding.
3. **Remote vault** — the vault already runs on another machine (NAS, VPS, behind a tunnel) and just needs to be registered in the router config.

## Style rules (apply throughout the wizard)

1. **Pre-flight every Bash call**: before any `Bash` invocation that mutates state (provisioning, linking, gitignore edit, git init), output 2-3 lines in chat that explain: *what's about to run*, *why*, *what files will be touched*. This is so when the permission prompt appears, the user already has the context — they're not clicking "approve" on a cryptic command label.
2. **Use full-sentence `description` arguments on Bash**: never `"Run setup-vault"`. Always something like `"Provisionner le vault SchoolMouv : installer 3 plugins Obsidian (Local REST API, Smart Connections, mcp-router-bridge), créer la structure wiki/wiki-meta/, enregistrer le vault dans ~/.claude/obsidian-mcp-router/config.json"`. Match the user's language (FR or EN — Roland is bilingual; pick from his prior turns).
3. **Explain technical concepts in plain words** when they come up (git, .env, port allocation, plugins). Don't assume prior knowledge. One short paragraph is enough; don't lecture.
4. **Confirm before destructive or irreversible steps** (git init, file overwrites). Provisioning a new vault into an empty directory is safe — just announce, don't ask permission.

---

## Step 0 — Detect the flow

Look at the cwd and the user's message. Decide which flow:

- **cwd contains `.obsidian/`** → cwd IS a vault → standalone flow (the user wants to register this existing vault).
- **cwd contains `.git/` AND no `OBSIDIAN_ROUTER_DEFAULT_VAULT` line in cwd's `.env`** → workspace-first flow (default).
- **User explicitly says "remote", "QNAP", "VPS", "Cloudflare", URL pattern in their message** → remote flow.
- **User explicitly says "standalone", "no workspace", "personal vault"** → standalone flow.
- **Otherwise (cwd is neither a vault nor a clear workspace)** → ask:

  > Tu veux attacher un vault à un workspace de code (le cas courant), bootstrapper un vault standalone (sans projet associé, type journal perso), ou enregistrer un vault distant qui tourne déjà ailleurs ?

Use AskUserQuestion with 3 options (workspace-first recommended, standalone, remote).

---

## Step 1A — Workspace-first flow

This is the dominant case. The user is in a code repo and wants documentation/notes to live in a sibling Obsidian vault that's bound to this workspace via `.env`.

### 1A.1 — Verify the workspace has git

Check whether `<cwd>/.git/` exists.

**If no `.git/`** — explain in plain words why git matters, then offer to init:

> Ce workspace n'a pas de dépôt git initialisé. Avant d'aller plus loin, deux mots sur pourquoi c'est important :
>
> - **Git versionne ton code** — il garde un historique de tous tes changements, ce qui te laisse revenir en arrière si tu casses quelque chose (un fichier, une feature, une journée entière de travail).
> - **Git protège tes secrets** — combiné au `.gitignore` qu'on va créer dans un instant, il te garantit que ton `.env` (qui contient la clé API du vault) ne sera jamais commité ni poussé sur GitHub.
> - **Git ouvre la porte au partage** — push sur GitHub/GitLab pour collaborer, ou simplement pour avoir une copie de secours hors-machine.
>
> Tu veux que je lance `git init` dans ce workspace maintenant ?

Wait for confirmation. If yes:
- Pre-flight: "Je lance `git init` dans `<cwd>` — ça crée un dossier `.git/` qui suit tes changements. Aucun fichier de ton code ne sera modifié."
- `Bash` with `description: "Initialiser un dépôt git dans le workspace courant (crée .git/, ne touche à aucun fichier existant)"`.

If the user declines: warn that the `.gitignore` step later will still create the file but the protection isn't active until git tracks it. Continue.

### 1A.2 — Choose the vault path

The default proposal is `C:\VAULTS\<basename-cwd-as-is>` (Windows) or `~/VAULTS/<basename-cwd-as-is>` (POSIX). Preserve the basename **exactly as-is** — case, version suffixes, all of it. The user can edit before validation.

Ask:

> Je propose de créer le vault à `<default-path>`. C'est volontairement HORS de ton workspace (`<cwd>`) pour que ton `.env` du vault — qui contient la clé API — ne se retrouve jamais dans le dépôt git de ton code. Tu valides ce chemin ou tu veux changer ?

Wait for confirmation/edit.

### 1A.3 — Run the provisioning script (provisions vault + binds workspace, single call)

Pre-flight (in chat, before the Bash call):

> Je vais lancer le script de provisioning. Voici ce qu'il va faire concrètement, en une seule commande :
>
> 1. **Créer le dossier du vault** à `<vault-path>` (si absent).
> 2. **Installer 5 plugins Obsidian** en clonant depuis le vault de référence : Local REST API (l'API HTTP qu'utilise le router), MCP Router Bridge (le pont qui expose les routes `/open` cliquables), Smart Connections (embeddings pour la recherche sémantique), Templater (templates dynamiques), Quiet Outline (panneau de plan rétractile).
> 3. **Allouer un port HTTPS unique** pour ce vault (et un port HTTP `+10` pour les liens cliquables qui contournent Bitdefender).
> 4. **Générer une clé API fraîche** propre à ce vault et l'écrire dans `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`.
> 5. **Créer la structure wiki** : `wiki/`, `wiki/sessions/`, `wiki-meta/{index,hot,overview,log}.md` (les 4 scaffolds canoniques).
> 6. **Écrire `<vault>/.env`** (chemin + clé API + URL du vault) et `<vault>/.mcp.json` (déclare le router comme MCP server pour Claude Code).
> 7. **Enregistrer le vault** dans `~/.claude/obsidian-mcp-router/config.json` (registre central de tous tes vaults).
> 8. **Lier le workspace au vault** : ajout de `OBSIDIAN_ROUTER_DEFAULT_VAULT="<slug>"` dans `<cwd>/.env` (active le mode workspace-bound — à la prochaine session Claude Code dans ce workspace, le hot-cache du vault sera chargé automatiquement).

Then call (single command — provisioning + linking in one shot via the `--link-workspace` flag, shipped in router v0.12.7):

```bash
node "<router-repo>/scripts/setup-vault.mjs" "<vault-path>" --link-workspace "<cwd>"
```

Bash `description`: `"Provisionner le vault <vault-basename> ET lier le workspace <cwd-basename> : installer les plugins Obsidian, allouer un port, générer une clé API, scaffolder wiki/wiki-meta/, écrire .env + .mcp.json, enregistrer dans ~/.claude/obsidian-mcp-router/config.json, et ajouter OBSIDIAN_ROUTER_DEFAULT_VAULT=<slug> dans <cwd>/.env"`.

(Resolve `<router-repo>` from the plugin install path: `${CLAUDE_PLUGIN_ROOT}` env var, OR `~/.claude/plugins/marketplaces/obsidian-mcp-router-marketplace/` on Windows, OR ask the user where they cloned the router repo.)

Show the user a brief recap of what the script printed (port allocated, slug derived, plugins synced, workspace linked) — NOT the full output.

### 1A.4 — Edit the workspace `.gitignore`

Pre-flight:

> Dernière étape de la configuration : je m'assure que `<cwd>/.gitignore` contient bien `.env` et `.mcp.json`, sinon ces fichiers risqueraient d'être commités (et avec eux, indirectement, le slug du vault — pas critique mais pas idéal). C'est idempotent : si les lignes sont déjà là, je ne touche à rien.

Read `<cwd>/.gitignore` if it exists. Use `Edit` (or `Write` if absent) to append `.env` and `.mcp.json` under a `# obsidian-mcp-router` marker comment, ONLY if those lines aren't already present. Use this format:

```
# obsidian-mcp-router (added by meta-attach-vault)
.env
.mcp.json
```

Idempotency rule: scan existing content for the exact strings `.env` and `.mcp.json` on their own lines BEFORE appending. If both already present, skip silently.

### 1A.5 — Conventions picker

Pre-flight:

> Le vault est provisionné et lié au workspace. Reste à choisir quelles **conventions** tu veux installer dans le `CLAUDE.md` du vault. Une convention, c'est une règle de comportement pour Claude — par exemple "toujours mettre à jour les roadmaps quand on ship du code" ou "vérifier dans le wiki avant de répondre". Elles sont matérialisées dans le `CLAUDE.md` du vault et lues à chaque session.
>
> Je propose les 8 disponibles, avec un set "recommandé" déjà coché. Tu peux tout valider, décocher certaines, ou tout décocher si tu veux configurer plus tard via `/obsidian-router:conventions`.

Use `AskUserQuestion` with `multiSelect: true` and these 8 options:

- **roadmap-discipline** (recommandé) — création et maintenance disciplinée des roadmaps
- **default-vault-health-check** (recommandé) — alerte si le vault par défaut n'est pas joignable au démarrage
- **wiki-query-first** (recommandé) — vérifier le wiki AVANT de répondre à une question substantielle
- **path-disambiguation** (recommandé) — ne jamais confondre le path du workspace et le path du vault
- **source-type** — frontmatter `source_type:` traceability sur les pages wiki
- **bilingual** — convention bilingue (FR + EN, FR primaire)
- **heading-hierarchy** — règles obligatoires de hiérarchie des headings
- **auto-enrichment** — règles d'enrichissement automatique du wiki (4 modes)

The 4 "recommandé" ones echo rules already active in the user's global `~/.claude/CLAUDE.md`, so materializing them locally is mostly free and helps when the user invokes Claude on the vault directly (e.g., from inside Obsidian Smart Composer). The 4 stylistic ones are project-flavored — decision should be the user's.

**Install via the `conventions` skill, not by hand**. For each picked convention, invoke the `/obsidian-router:conventions` skill with `install <id>` (e.g. `/obsidian-router:conventions install roadmap-discipline`). The conventions skill handles: snippet resolution, idempotent H2-heading detection (skips if already installed), safe append to the vault's `CLAUDE.md`. Do NOT bypass it with a raw `mcp__obsidian-router__append_to_file` — that skips the idempotency guard and the consistency with `/obsidian-router:conventions list`/`remove` later.

Show progress: `✓ source-type installed`, `✓ wiki-query-first installed`, … If a convention reports "already installed", surface that to the user (it's a no-op, not an error).

### 1A.6 — Final reminders

Before composing the recap, call `mcp__obsidian-router__list_vaults` once to get `defaultVaultStatus` (or look up the newly-attached vault by slug in the `vaults[]` array). Use its `openUri` field for the clickable Obsidian link — it's pre-encoded for spaces/accents and ships in router v0.10.0+. Do NOT compose the `obsidian://` URI by hand: vault names with spaces or accents (e.g. `opsidian-mcp-router et bridge`) need proper URL-encoding that's easy to get wrong.

End with a short recap (FR or EN matching the user):

> ✅ Vault `<slug>` attaché au workspace `<cwd-basename>`.
>
> **Avant que ça marche, deux gestes manuels** :
>
> 1. **Ouvre le vault dans Obsidian** : `[Lance Obsidian sur <obsidianName>](<openUri-from-list_vaults>)` — sans Obsidian ouvert, le serveur Local REST API ne tourne pas et le router ne peut rien lire ni écrire.
> 2. **Redémarre Claude Code dans ce workspace** pour que le router charge le nouveau vault et que le hot-cache active le mode workspace-bound.
>
> Conventions installées : `<comma-separated-list>` (visibles dans `<vault>/CLAUDE.md`).
>
> Pour vérifier que tout est bien câblé : `/obsidian-router:meta-status` (diagnostic complet) ou `/obsidian-router:discover-list-vaults` (liste rapide).

---

## Step 1B — Standalone vault flow

The rare case: a vault that isn't tied to any workspace (like Roland's personal journal vault).

Same as 1A but:
- **Skip the git step entirely** (no workspace = no git concerns at this layer).
- **Skip the linking step** (no workspace to bind).
- **Skip the workspace `.gitignore` edit**.
- **Still scaffold the wiki structure and offer the conventions picker** — even a personal vault benefits from them.

Ask for the vault path explicitly (no default — there's no cwd to derive from).

---

## Step 1C — Remote vault flow

The vault already runs elsewhere (NAS, VPS, behind Cloudflare Tunnel). Only registration is needed.

Required from the user (ask only what's missing):

1. **`name`** — short identifier used everywhere (e.g. `qnap`, `vps-research`, `tradingview-tunnel`). Lowercase, no spaces.
2. **`baseUrl`** — the HTTPS URL where the remote Obsidian Local REST API is reachable. Examples:
   - `https://192.168.0.11:27125` (LAN)
   - `https://qnap.tailnet.local:27125` (Tailscale)
   - `https://vault.mydomain.com` (Cloudflare Tunnel with custom domain)
3. **`apiKey`** — the Local REST API key from the vault's `data.json` on the remote machine. The user fetches it themselves:
   - Open the remote vault in Obsidian on its host
   - Settings → Community plugins → Local REST API
   - Copy the API Key field

Optional:

4. **`tlsInsecure`** (default `true` for localhost/LAN, `false` otherwise) — only `true` for self-signed certs in trusted networks.
5. **`timeoutMs`** (default `10000`) — bump to 15-20s if the link is slow.
6. **`extraHeaders`** — for vaults behind Cloudflare Access with a service token. Two values needed:
   - `CF-Access-Client-Id`
   - `CF-Access-Client-Secret`
   See [`docs/cloudflare-tunnel.md`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/cloudflare-tunnel.md).

### Edit the config

1. Read `~/.claude/obsidian-mcp-router/config.json`.
2. Parse the JSON.
3. If a `remoteVaults` entry with the same name already exists → ask the user before overwriting.
4. Append (or replace) the entry in the `remoteVaults` array.
5. Write atomically.
6. Confirm:
   - The path edited
   - The vault name added
   - That a Claude Code restart is required to pick up the change

### Optional: live verification

```bash
curl -sk -H "Authorization: Bearer <apiKey>" \
  [-H "CF-Access-Client-Id: ..."] [-H "CF-Access-Client-Secret: ..."] \
  "<baseUrl>/" | head -5
```

Returns server-info JSON → golden. 401 → wrong API key. Timeout → URL unreachable.

---

## Anti-patterns (apply across all flows)

- **Don't run any Bash without a pre-flight explanation** — the user sees the permission prompt and the description; both must make sense without prior context.
- **Don't bury the explanation in long paragraphs** — 2-3 lines per pre-flight, in plain words. Roland is technical but tired; respect his time.
- **Don't write secrets** (API keys, service token secrets) anywhere except `~/.claude/obsidian-mcp-router/config.json` and the vault's own `.env`. No log files, no echo to terminal beyond the immediate confirmation, no clipboard write.
- **Don't auto-restart Claude or Obsidian** — tell the user to do it themselves.
- **Don't add a remote vault entry without a full set of `name`, `baseUrl`, `apiKey`** — refuse and ask for the missing fields.
- **Don't pretend the setup-vault.mjs script exists if it doesn't** — fall back to the manual path with a clear explanation.
- **Don't create the vault INSIDE the workspace** — that defeats the credential-protection goal. Default vault path is `C:\VAULTS\<basename>` (or `~/VAULTS/<basename>`), never `<cwd>/vault/`.
- **Don't skip the conventions picker silently** — even if the user looks impatient, the picker is one AskUserQuestion call with a recommended default. It's the cheapest way to materialize the global rules locally.

---

## Quick test (sanity-check after end-to-end run)

After everything is done, the following should be true. If any of them isn't, surface it:

- [ ] `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` exists
- [ ] `<vault>/.mcp.json` exists and references the router binary
- [ ] `<vault>/wiki-meta/index.md` exists (otherwise `--link-workspace` would have refused)
- [ ] `<cwd>/.env` contains `OBSIDIAN_ROUTER_DEFAULT_VAULT="<slug>"`
- [ ] `<cwd>/.gitignore` contains `.env` and `.mcp.json`
- [ ] `~/.claude/obsidian-mcp-router/config.json` has `<vault-path>` in `portRegistry`
- [ ] `<vault>/CLAUDE.md` contains the H2 headings of the conventions the user picked
