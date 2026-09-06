# Wiki auto-enrichment — placement guide

> *🇬🇧 English — [🇫🇷 version française plus bas](#-version-française)*

Phase 0 of the auto-enrichment system makes Claude proactively suggest wiki saves at three natural moments during a conversation: validation pins, result-obtained digests, and topic-switch checkpoints. The mechanics are documented in the consigne itself ([`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md), `## Auto-enrichment` section).

This file answers a different question: **where do you place the consigne so Claude actually applies it?** Five channels, one per Claude surface, all interoperable — plus, upstream of all of them, the binding that decides WHICH vault the session writes to.

## TL;DR

| Surface | Channel | Persistence | Best for |
|---|---|---|---|
| Claude Code (workspace IS a vault) | Vault root `CLAUDE.md` | Per-vault, in the vault itself | The default — auto-loaded when you `cd` into the vault |
| Claude Code (code repo bound to a vault) | Repo `CLAUDE.md` + `confirm_workspace_binding` | Per-workspace; the binding lives in your own config | The standard shape since v0.90 — the vault sits elsewhere on disk |
| Claude Desktop / Claude.ai (Project mode) | Project instructions | Per-project, cloud-synced | A workspace dedicated to a vault (e.g. "Trading Journal" → vault `tradingview`) |
| Claude Desktop / Claude.ai (chat free mode) | Memory | Cloud-synced, regenerated nightly | Identity-based routing ("I'm Donald" → vault `donald`) |
| Any Claude Code session | `~/.claude/CLAUDE.md` (global) | Local to your machine | Power users who want the consigne everywhere |

You can combine multiple channels — they don't conflict. Claude reads ALL the consignes loaded in its context and applies the activation rules.

## Upstream of every channel — what binds the session to a vault

Every consigne self-gates on one question: *is this session bound to a vault?* Since v0.90 that question has a single authority — the **binding registry in your own config**, written by `confirm_workspace_binding`, never by a file that travels with a cloned repository.

- `confirm_workspace_binding({ vault })` binds this workspace to a vault (`also: [...]` adds secondaries, `clear: true` unbinds). `list_vaults` reports the result as `workspaceBinding` — an object with an empty `also` means one vault, a non-empty `also` several, `null` means no binding at all.
- When the router runs as the Claude Code plugin, its `SessionStart` hook opens each session with a briefing naming the bound vault and the auto-enrichment mode the session starts in.
- A project `.env` can no longer **choose** the vault. `OBSIDIAN_ROUTER_DEFAULT_VAULT` is a *proposal*: `list_vaults` surfaces it as `bindingHint` and the router does not apply it (accepted decision `liaison-workspace-vault-hors-depot`). The one file-borne case still counted as a binding is a workspace whose own `.env` carries a `VAULT_PATH` pointing at the workspace directory itself — the "this folder is a vault" case `setup-vault.mjs` writes.

Read `workspaceBinding`; never infer the binding from an environment variable.

## Channel 1 — Vault root `CLAUDE.md` (Claude Code, workspace = vault)

**When it applies**: Claude Code launched from a vault directory (e.g. `cd C:\VAULTS\TradingView && claude`).

**How it works**: Claude Code auto-loads the `CLAUDE.md` at the workspace root. The vault's CLAUDE.md is dropped there by `setup-vault.mjs` (or the `wiki` skill on scaffold) and includes the auto-enrichment consigne.

**Setup**: nothing to do — every vault scaffolded with `/obsidian-router:wiki` after v0.8.1 gets it automatically. For existing vaults bootstrapped before v0.8.1, copy the `## Auto-enrichment` section from [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) and paste it at the bottom of your vault's `CLAUDE.md`.

**Verification**: open `<vault>/CLAUDE.md` and look for the `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)` section. If present, you're set. (Vaults scaffolded before v0.8.2 carry the older heading `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` — same section, one mode; re-copying from the template gives you the four.)

## Channel 2 — Claude Project instructions (Claude Desktop / Claude.ai)

**When it applies**: any conversation started inside a Claude Project. Projects on Claude.ai (also surfaced in Claude Desktop) have their own custom instructions block, persisted server-side and shared by every chat in that project.

**Why this is elegant**: a Project is *already* the natural unit for "a domain that maps to a vault" — your "Trading Journal" project always saves to `tradingview`, your "Personal" project always saves to `personal`. Binding the vault at the Project level makes every conversation inside it auto-tracked, no slash command, no explicit opt-in.

**Setup**:

1. In Claude.ai (or Claude Desktop), open the Project you want to bind to a vault.
2. Click **Edit instructions** (or "Custom instructions" depending on the UI).
3. Paste the boilerplate below, replacing `<VAULT_NAME>` with the vault name from `list_vaults`:

```markdown
## Auto-enrichment for this project → vault `<VAULT_NAME>`

This Project is bound to the Obsidian vault `<VAULT_NAME>` via the obsidian-mcp-router MCP. All wiki-tracking conversations in this Project route saves to that vault.

Apply the auto-enrichment Phase 0 consigne (3 triggers: validation pins, result digests, topic-switch checkpoints — `ClaudeAsk` mode). Full spec: see the vault's CLAUDE.md (`mcp__obsidian-router__get_file({ vault: "<VAULT_NAME>", path: "CLAUDE.md" })`) — read it once at session start to load the rules.

Activation:
- Treat this Project as a permanent opt-in to wiki tracking — the "vault is bound" condition is satisfied by Project membership alone.
- The user can still opt out per-session by saying "no tracking this time" / "pas de notes".
```

4. Save the Project instructions.

From the next conversation in this Project, Claude reads the rules from the vault's CLAUDE.md (loaded once on first wiki interaction) and applies the consigne. Saves go to `<VAULT_NAME>` automatically.

**Variant — fully self-contained Project**: if you don't want Claude to read the rules from the vault every session (extra MCP call), copy the entire `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)` section from [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) directly into the Project instructions. Trade-off: the Project instructions become heavier (~80 lines) but no runtime fetch.

## Channel 3 — Memory (Claude Desktop, identity-based routing)

**When it applies**: free chat in Claude Desktop / Claude.ai (no Project), where the user's identity routes to a vault. Useful for shared installs (a small team or household sharing one Claude account — Memory asks who's speaking, then proposes tracking).

**How it works**: Claude's Memory feature persists facts across conversations and regenerates a summary nightly. You add an instruction to Memory that says "when user identifies as X, propose tracking in vault `x`".

**Setup**:

1. Open **Settings → Capacités → Mémoire → Afficher et gérer la mémoire** in Claude Desktop.
2. (Optional but recommended) In a regular chat, tell Claude explicitly:

   > *"To remember: at the start of each new conversation, ask which user is on the account (e.g. Donald, Mitch, Bernie, Joe, Mitt). Once identified, if the user has a vault by their name (e.g., Donald → vault `donald`), propose to enable wiki tracking for the session via the obsidian-router MCP. Apply the auto-enrichment consigne from the vault's CLAUDE.md."*

3. Verify a few hours later that this instruction appears in **Afficher et gérer la mémoire** (it's regenerated nightly — give it a day).
4. To prevent drift, re-state the instruction every 2-3 months in any conversation. Claude will keep it pinned in the next regeneration.

**Caveat**: Memory is auto-generated, so the *exact wording* may drift over time. If you want the rule to be 100% deterministic, prefer Channel 2 (Project instructions) for the projects that matter most.

## Channel 4 — Global `~/.claude/CLAUDE.md` (power user, all sessions)

**When it applies**: any Claude Code session on your machine, regardless of workspace.

**How it works**: Claude Code reads `~/.claude/CLAUDE.md` (your personal global Claude instructions) on every session, before any project-specific CLAUDE.md.

**Setup**: paste the auto-enrichment consigne at the bottom of `~/.claude/CLAUDE.md`. Add a guard at the top of the section:

```markdown
## Auto-enrichment (global)

Apply the consigne below ONLY when:
- The current Claude Code session is bound to a vault — `list_vaults` reports a non-null `workspaceBinding`, OR the working directory IS a vault whose own `.env` carries a `VAULT_PATH` pointing at that same directory, OR the user explicitly opted in this session. A bare `OBSIDIAN_ROUTER_DEFAULT_VAULT` is NOT enough: the router reports it as `bindingHint` and does not apply it.
- The obsidian-mcp-router MCP is available

[paste the full `## Auto-enrichment` consigne here]
```

**Caveat**: this enables tracking on every machine session. If you have many short / ad-hoc sessions where you don't want wiki proposals, the digest noise can be annoying. Most users prefer Channels 1+2 (per-vault and per-project) over the global option.

## Channel 5 — Repo `CLAUDE.md` (Claude Code, code workspace bound to a vault)

**When it applies**: Claude Code launched from a code repository that is *bound* to a vault living elsewhere on disk (`confirm_workspace_binding({ vault: "…" })`). Since v0.90 this is the standard shape — the workspace is the project, the vault is its knowledge base.

**Why it needs its own channel**: Claude Code auto-loads the `CLAUDE.md` at the *workspace* root, and here the workspace is the repo, not the vault. The vault's own `CLAUDE.md` is never loaded automatically, so Channel 1 does not cover this case. What the binding gives you at session start is the router's briefing (bound vault + auto-enrichment mode) and the vault's `wiki-meta/hot.md` — the state cache, not the rules.

**Setup** — two options:

1. **Pointer** (light): add a short section to the repo's `CLAUDE.md` telling Claude to load the rules from the vault once per session:

   ```markdown
   ## Auto-enrichment → vault `<VAULT_NAME>`

   This workspace is bound to the vault `<VAULT_NAME>`. At the first auto-enrichment-relevant
   moment, read its rules once — `get_file({ vault: "<VAULT_NAME>", path: "CLAUDE.md" })`,
   section `## Auto-enrichment` — and apply them for the rest of the session.
   ```

2. **Self-contained** (no runtime fetch): copy the `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)` section from [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) into the repo's `CLAUDE.md`. Heavier (~80 lines), but nothing to fetch.

**Tool prefix**: spell the call with the prefix your session actually shows — `mcp__obsidian-router__get_file` when the router is a plain MCP server entry, `mcp__plugin_obsidian-router_router__get_file` when it comes from the Claude Code plugin.

**Verification**: `list_vaults` returns a non-null `workspaceBinding` naming the vault, and the session briefing names the starting mode.

## Combining channels

The five channels are additive, not exclusive. A typical "all-in" multi-vault setup:

- **Vault `personal`'s `CLAUDE.md`** → consigne loaded when working from a personal-vault workspace in Claude Code
- **Repo `my-app/CLAUDE.md`** → bound to vault `my-app-notes` via `confirm_workspace_binding`, so development sessions file into the project's own knowledge base
- **Project "Trading Journal"** instructions → bound to vault `tradingview` for Claude Desktop trading conversations
- **Project "Personal"** instructions → bound to vault `personal` for personal Claude Desktop conversations
- **Memory** → asks "which user?" and proposes vault matching at chat start, when no Project is active (useful when several people share the Claude account)

Each channel handles a different surface; they compose cleanly because the consigne self-gates on "is a vault bound?" — and that gate has one authority, the binding described above.

## The four modes — what fits when

Phase 1 (v0.8.2) ships four modes. Switch with `/obsidian-router:auto-mode <Mode>` (volatile) or with `--persist` to write `OBSIDIAN_ROUTER_AUTO_ENRICH=<Mode>` into the workspace `.env`.

> **One exception since v0.89.0: `FullAuto` does not live in a workspace file.** `--persist` writes `ClaudeAsk`, `Hybrid` and `off` as before, but for `FullAuto` it applies the mode to the session and refuses the write — and a `FullAuto` already sitting in a workspace `.env` is not applied at start-up either, in any of its spellings (`fullauto`, `full`, `full-auto`, `auto`, any casing). The reason is that a workspace is very often a cloned repository whose `.env` came with it, and `FullAuto` is the one mode that turns such a file into standing permission to write into one of your vaults without asking again. The two places it still comes from are the MCP host's server declaration (an `env` entry beside the router's command) and a `set_auto_enrich_mode` call during the session. When a file asked and was refused, the router says so on its stderr and `list_vaults` carries `autoEnrichModeRefused`. This is the accepted option 4 of the decision `liaison-workspace-vault-hors-depot`.

### `ClaudeAsk` (default) — propose, always confirm

**Behavior**: at each trigger (validation / result / topic-switch), Claude lists candidates and waits for your selection ("all", "none", numbers, "skip"). Nothing is saved without your explicit OK.

**Best fit**:
- 🆕 **Discovery / calibration period** — the first 1-2 weeks of using auto-enrichment, before you trust the classifier
- 📚 **Long sessions with mixed-importance content** — some bits are gold, most are noise; you want to be the filter
- 🛡️ **Vaults where false positives would be costly to clean up** — domain wikis with lots of citations to other pages, where deleting a wrong page breaks references
- 🎓 **Learning what Claude considers save-worthy** — you observe the proposals to recalibrate your own sense of "what's worth keeping"

**Trade-off**: friction. Every digest is a question to answer.

### `Hybrid` — auto-save type-safe, ask on high-stakes

**Behavior**: Claude auto-saves the items where false positives are cheap (`fact`, `url`, `preference`) and asks for confirmation on items where false positives are expensive (`decision`, `adr`, `rule`, `technique`, `session`). Digests show both: "✅ auto-saved" + "à confirmer".

**Best fit**:
- ⚡ **Power-user sweet spot after calibration** — once you trust Claude's URL/fact detection, you stop wanting to confirm them every time
- 🌐 **Active research with frequent URL ingestion** — you read 30 articles, you want each one filed without thinking
- 📊 **Citation-heavy work** — `wiki-ingest` calls happen constantly, manual confirmation becomes the bottleneck
- 🛠️ **Active development** — facts (port numbers, version pins, threshold values) pile up, but architectural decisions still warrant a beat of confirmation

**Trade-off**: you still confirm the consequential saves, but you stop confirming the trivia. Best ratio of friction-saved to safety.

### `FullAuto` — auto-save everything (with safety nets)

**Behavior**: Claude auto-saves at every trigger, no questions. Audit log written to `wiki-meta/journal.md` (lines prefixed with `[auto-save]` so you can filter). Sensitivity filter ALWAYS applies (credentials / medical / financial / client names → never auto-saved, downgraded to ask). Hard cap: after 5 auto-saves in one session, behavior degrades to `ClaudeAsk` for the rest of the session (you'd hit it explicitly: *"FullAuto cap reached, asking for confirmation now"*).

**Best fit**:
- 📔 **Personal journal / family chronicle** — you don't want to think about save decisions, you just want a log of what happened
- 🤖 **Long unsupervised flows** — `autoresearch` running for an hour, batch ingestion of 50 sources; you'd never be there to confirm each
- 💭 **Solo brain-dumps where the wiki IS the conversation log** — you're chatting with Claude as a thinking-out-loud partner and want everything captured
- 🏆 **High-trust mode** — after 3+ months of `Hybrid`, you've seen the classifier perform well, you accept the residual noise

**Trade-off**: real noise risk. You WILL save some things you wouldn't have. Mitigation: review `wiki-meta/journal.md` weekly to catch the strays. The hard cap keeps a single session from spiraling, but a year of FullAuto without retrospective curation will produce a noisy wiki.

**⚠️ Don't ship FullAuto on day one.** Calibrate with `ClaudeAsk` for 1 week, `Hybrid` for 1 month, then evaluate.

### `off` — manual `/save` only

**Behavior**: Claude makes NO proactive save proposals. The auto-enrichment consigne is fully ignored. You invoke `/save`, `/wiki-ingest`, `/wiki-fold`, etc. manually when you want them.

**Best fit**:
- 🐛 **Debugging sessions you don't want polluting the wiki** — the lock-mode-equivalent for the auto layer
- 🤐 **Sensitive conversations** — even with sensitivity filter on, you want hard guarantee nothing gets saved
- 🎛️ **Control-freak preference** — you want full conscious agency over what enters your wiki, period
- 🏛️ **Default for legal / medical / financial vaults** — high stakes, low tolerance for accidents
- 💡 **Brainstorm-only sessions** — the content is exploratory, locking save proposals out keeps the flow clean

**Trade-off**: no friction, but also no proactive memory. You're back to v0.8.0 behavior — the wiki only grows when YOU push to it.

## Picking your starting mode

A pragmatic recommendation:

| Where you are | Pick |
|---|---|
| First time using auto-enrichment | `ClaudeAsk` for 1-2 weeks |
| Comfortable with the proposals, want less friction | `Hybrid` for 1-3 months |
| Trust the classifier, want zero friction on the routine | `FullAuto` (with weekly `wiki-meta/journal.md` review) |
| Specific session that shouldn't be tracked | `off` for that session (no `--persist`) |
| Vault contains sensitive material by nature | `off` persisted at the vault level |

You can persist the mode per-workspace (in the workspace's `.env`) so the same vault always boots in the right mode regardless of session.

## Phase 2 preview (not yet shipped)

Phase 1 (v0.8.2) covers the operational core. Phase 2 will add:
- **Daily digest** — at the first interaction of the day, list yesterday's auto-saves so you can review/rollback in a batch
- **Configurable hard cap** — currently fixed at 5 in FullAuto, will become per-vault tunable
- **Sensitivity filter learned from corrections** — when you delete an auto-saved page within X minutes, the classifier remembers the pattern

---

## 🇫🇷 Version française

La Phase 0 du système d'auto-enrichissement fait que Claude propose proactivement de sauver dans le wiki à trois moments naturels d'une conversation : pins de validation, digests post-résultat, et checkpoints au changement de sujet. La mécanique est documentée dans la consigne elle-même ([`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md), section `## Auto-enrichment`).

Ce fichier répond à une autre question : **où placer la consigne pour que Claude l'applique réellement ?** Cinq canaux, un par surface Claude, tous interopérables — plus, en amont de tous, la liaison qui décide DANS QUEL vault la session écrit.

### En bref

| Surface | Canal | Persistance | Pour quoi |
|---|---|---|---|
| Claude Code (workspace = vault) | `CLAUDE.md` racine du vault | Per-vault, dans le vault | Le défaut — auto-chargé quand tu `cd` dans le vault |
| Claude Code (dépôt de code lié à un vault) | `CLAUDE.md` du dépôt + `confirm_workspace_binding` | Per-workspace ; la liaison vit dans ta propre config | Le cas standard depuis la v0.90 — le vault est ailleurs sur le disque |
| Claude Desktop / Claude.ai (mode Project) | Instructions du Project | Per-projet, sync cloud | Un workspace dédié à un vault (ex : "Journal Trading" → vault `tradingview`) |
| Claude Desktop / Claude.ai (chat libre) | Memory | Sync cloud, régénérée chaque nuit | Routing par identité ("c'est Donald" → vault `donald`) |
| N'importe quelle session Claude Code | `~/.claude/CLAUDE.md` (global) | Local à ta machine | Pour ceux qui veulent la consigne partout |

Tu peux combiner plusieurs canaux — ils ne se contredisent pas. Claude lit toutes les consignes chargées dans son contexte et applique les règles d'activation.

### En amont de tous les canaux — ce qui lie la session à un vault

Chaque consigne s'auto-gate sur une seule question : *cette session est-elle liée à un vault ?* Depuis la v0.90, cette question a une autorité unique — le **registre de liaisons dans ta propre config**, écrit par `confirm_workspace_binding`, jamais par un fichier qui voyage avec un dépôt cloné.

- `confirm_workspace_binding({ vault })` lie ce workspace à un vault (`also: [...]` ajoute des secondaires, `clear: true` délie). `list_vaults` rend le résultat dans `workspaceBinding` — un objet avec un `also` vide = UN vault, un `also` non vide = plusieurs, `null` = aucune liaison.
- Quand le router tourne comme plugin Claude Code, son hook `SessionStart` ouvre chaque session par un briefing qui nomme le vault lié et le mode d'auto-enrichissement de départ.
- Un `.env` de projet ne peut plus **choisir** le vault. `OBSIDIAN_ROUTER_DEFAULT_VAULT` est une *proposition* : `list_vaults` la remonte comme `bindingHint` et le router ne l'applique pas (décision acceptée `liaison-workspace-vault-hors-depot`). Le seul cas porté par un fichier qui compte encore comme liaison : un workspace dont le `.env` porte un `VAULT_PATH` pointant sur le dossier du workspace lui-même — le cas « ce dossier EST un vault » qu'écrit `setup-vault.mjs`.

Lis `workspaceBinding` ; ne déduis jamais la liaison d'une variable d'environnement.

### Canal 1 — `CLAUDE.md` racine du vault (Claude Code, workspace = vault)

**Quand ça s'applique** : Claude Code lancé depuis un dossier de vault (par exemple `cd C:\VAULTS\TradingView && claude`).

**Comment ça marche** : Claude Code auto-charge le `CLAUDE.md` à la racine du workspace. Le `CLAUDE.md` du vault y est posé par `setup-vault.mjs` (ou par le skill `wiki` lors du scaffold) et contient la consigne d'auto-enrichissement.

**Setup** : rien à faire — chaque vault scaffold avec `/obsidian-router:wiki` après v0.8.1 l'a automatiquement. Pour les vaults existants bootstrappés avant v0.8.1, copie la section `## Auto-enrichment` depuis [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) et colle-la en bas du `CLAUDE.md` de ton vault.

**Vérification** : ouvre `<vault>/CLAUDE.md` et cherche la section `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)`. Si présente, tu es bon. (Les vaults scaffoldés avant la v0.8.2 portent l'ancien titre `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` — même section, un seul mode ; recopier depuis le template te donne les quatre.)

### Canal 2 — Instructions de Project Claude (Claude Desktop / Claude.ai)

**Quand ça s'applique** : toute conversation démarrée dans un Project Claude. Les Projects sur Claude.ai (et dans Claude Desktop) ont leur propre bloc d'instructions custom, persisté côté serveur et partagé par chaque chat dans ce Project.

**Pourquoi c'est élégant** : un Project EST déjà l'unité naturelle pour "un domaine qui mappe à un vault" — ton Project "Journal Trading" sauve toujours dans `tradingview`, ton Project "Personnel" sauve toujours dans `personal`. Binder le vault au niveau du Project rend chaque conversation à l'intérieur auto-trackée, sans slash command, sans opt-in explicite.

**Setup** :

1. Dans Claude.ai (ou Claude Desktop), ouvre le Project que tu veux binder à un vault.
2. Clique sur **Modifier les instructions** (ou "Custom instructions" selon l'UI).
3. Colle le boilerplate ci-dessous, en remplaçant `<NOM_VAULT>` par le nom du vault depuis `list_vaults` :

```markdown
## Auto-enrichissement pour ce projet → vault `<NOM_VAULT>`

Ce Project est binder au vault Obsidian `<NOM_VAULT>` via le MCP obsidian-mcp-router. Toutes les conversations de tracking wiki dans ce Project routent les saves vers ce vault.

Applique la consigne d'auto-enrichissement Phase 0 (3 triggers : pins de validation, digests de résultats, checkpoints au changement de sujet — mode `ClaudeAsk`). Spec complète : voir le `CLAUDE.md` du vault (`mcp__obsidian-router__get_file({ vault: "<NOM_VAULT>", path: "CLAUDE.md" })`) — lis-le une fois en début de session pour charger les règles.

Activation :
- Traite ce Project comme un opt-in permanent au tracking wiki — la condition "vault est bound" est satisfaite par l'appartenance au Project seule.
- L'utilisateur peut toujours opt-out par session en disant "pas de notes cette fois" / "no tracking".
```

4. Sauve les instructions du Project.

À partir de la prochaine conversation dans ce Project, Claude lit les règles depuis le `CLAUDE.md` du vault (chargé une fois à la première interaction wiki) et applique la consigne. Les saves vont automatiquement dans `<NOM_VAULT>`.

**Variante — Project fully self-contained** : si tu ne veux pas que Claude lise les règles depuis le vault à chaque session (appel MCP supplémentaire), copie la section `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)` complète depuis [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) directement dans les instructions du Project. Trade-off : les instructions du Project deviennent plus lourdes (~80 lignes) mais zéro fetch runtime.

### Canal 3 — Memory (Claude Desktop, routing par identité)

**Quand ça s'applique** : chat libre dans Claude Desktop / Claude.ai (pas de Project), où l'identité de l'utilisateur route vers un vault. Utile pour les installs partagées (une petite équipe ou un foyer partagent un compte Claude — Memory demande qui parle, puis propose le tracking).

**Comment ça marche** : la feature Memory de Claude persiste des faits entre conversations et régénère un résumé chaque nuit. Tu ajoutes une instruction à la Memory qui dit "quand l'utilisateur s'identifie comme X, propose le tracking dans le vault `x`".

**Setup** :

1. Ouvre **Paramètres → Capacités → Mémoire → Afficher et gérer la mémoire** dans Claude Desktop.
2. (Optionnel mais recommandé) Dans un chat normal, dis explicitement à Claude :

   > *"À retenir : au début de chaque nouvelle conversation, demande qui utilise le compte (par exemple Donald, Mitch, Bernie, Joe, Mitt). Une fois identifié, si l'utilisateur a un vault à son nom (ex : Donald → vault `donald`), propose-lui d'activer le tracking wiki pour la session via le MCP obsidian-router. Applique la consigne d'auto-enrichissement depuis le `CLAUDE.md` du vault."*

3. Vérifie quelques heures plus tard que cette instruction apparaît dans **Afficher et gérer la mémoire** (régénérée chaque nuit — laisse-lui une journée).
4. Pour éviter la dérive, re-énonce l'instruction tous les 2-3 mois dans n'importe quelle conversation. Claude la pinera dans la régénération suivante.

**Caveat** : la Memory est auto-générée, donc le *wording exact* peut dériver dans le temps. Si tu veux la règle 100% déterministe, préfère le Canal 2 (instructions de Project) pour les projets qui comptent.

### Canal 4 — `~/.claude/CLAUDE.md` global (power user, toutes sessions)

**Quand ça s'applique** : toute session Claude Code sur ta machine, peu importe le workspace.

**Comment ça marche** : Claude Code lit `~/.claude/CLAUDE.md` (tes instructions Claude globales perso) à chaque session, avant tout `CLAUDE.md` spécifique au projet.

**Setup** : colle la consigne d'auto-enrichissement en bas de `~/.claude/CLAUDE.md`. Ajoute un guard en haut de la section :

```markdown
## Auto-enrichissement (global)

Applique la consigne ci-dessous SEULEMENT quand :
- La session Claude Code courante est liée à un vault — `list_vaults` rend un `workspaceBinding` non nul, OU le répertoire courant EST un vault dont le `.env` porte un `VAULT_PATH` pointant sur ce même répertoire, OU l'utilisateur a explicitement opt-in cette session. Un `OBSIDIAN_ROUTER_DEFAULT_VAULT` nu ne suffit PAS : le router le remonte comme `bindingHint` et ne l'applique pas.
- Le MCP obsidian-mcp-router est disponible

[colle ici la consigne `## Auto-enrichment` complète]
```

**Caveat** : ça active le tracking sur chaque session machine. Si tu as beaucoup de sessions courtes / ad-hoc où tu ne veux pas de propositions wiki, le bruit des digests devient pénible. La plupart préfèrent les Canaux 1+2 (per-vault et per-project) plutôt que le global.

### Canal 5 — `CLAUDE.md` du dépôt (Claude Code, workspace de code lié à un vault)

**Quand ça s'applique** : Claude Code lancé depuis un dépôt de code *lié* à un vault qui vit ailleurs sur le disque (`confirm_workspace_binding({ vault: "…" })`). Depuis la v0.90, c'est la forme standard — le workspace est le projet, le vault est sa base de connaissances.

**Pourquoi il lui faut son propre canal** : Claude Code auto-charge le `CLAUDE.md` à la racine du *workspace*, et ici le workspace est le dépôt, pas le vault. Le `CLAUDE.md` du vault n'est jamais chargé automatiquement — le Canal 1 ne couvre donc pas ce cas. Ce que la liaison te donne au démarrage, c'est le briefing du router (vault lié + mode d'auto-enrichissement) et le `wiki-meta/hot.md` du vault : le cache d'état, pas les règles.

**Setup** — deux options :

1. **Pointeur** (léger) : ajoute une courte section au `CLAUDE.md` du dépôt, qui dit à Claude de charger les règles depuis le vault une fois par session :

   ```markdown
   ## Auto-enrichissement → vault `<NOM_VAULT>`

   Ce workspace est lié au vault `<NOM_VAULT>`. Au premier moment pertinent pour
   l'auto-enrichissement, lis ses règles une fois — `get_file({ vault: "<NOM_VAULT>",
   path: "CLAUDE.md" })`, section `## Auto-enrichment` — et applique-les pour le
   reste de la session.
   ```

2. **Self-contained** (zéro fetch runtime) : copie la section `## Auto-enrichment (4 modes — ClaudeAsk / Hybrid / FullAuto / off)` depuis [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) dans le `CLAUDE.md` du dépôt. Plus lourd (~80 lignes), mais rien à aller chercher.

**Préfixe d'outil** : écris l'appel avec le préfixe que ta session affiche réellement — `mcp__obsidian-router__get_file` quand le router est une entrée de serveur MCP classique, `mcp__plugin_obsidian-router_router__get_file` quand il vient du plugin Claude Code.

**Vérification** : `list_vaults` rend un `workspaceBinding` non nul qui nomme le vault, et le briefing de session nomme le mode de départ.

### Combiner les canaux

Les cinq canaux sont additifs, pas exclusifs. Un setup "tout-en-un" multi-vaults :

- **`CLAUDE.md` du vault `personal`** → consigne chargée quand on bosse depuis un workspace personal-vault en Claude Code
- **`CLAUDE.md` du dépôt `mon-app`** → lié au vault `mon-app-notes` via `confirm_workspace_binding`, pour que les sessions de dev classent dans la base de connaissances du projet
- **Instructions du Project "Journal Trading"** → bind au vault `tradingview` pour les conversations trading sur Claude Desktop
- **Instructions du Project "Personnel"** → bind au vault `personal` pour les conversations perso sur Claude Desktop
- **Memory** → demande "quel utilisateur ?" et propose le matching de vault au début du chat, quand aucun Project n'est actif (utile quand plusieurs personnes partagent le compte Claude)

Chaque canal gère une surface différente ; ils se composent proprement parce que la consigne s'auto-gate sur "est-ce qu'un vault est lié ?" — et ce gate a une seule autorité, la liaison décrite plus haut.

### Les quatre modes — quel mode pour quel usage

La Phase 1 (v0.8.2) ship quatre modes. Switch avec `/obsidian-router:auto-mode <Mode>` (volatile) ou avec `--persist` pour écrire `OBSIDIAN_ROUTER_AUTO_ENRICH=<Mode>` dans le `.env` du workspace.

> **Une exception depuis la v0.89.0 : `FullAuto` n'habite pas dans un fichier de workspace.** `--persist` écrit `ClaudeAsk`, `Hybrid` et `off` comme avant, mais pour `FullAuto` il applique le mode à la session et refuse l'écriture — et un `FullAuto` déjà présent dans un `.env` de workspace n'est pas appliqué au démarrage non plus, quelle que soit son orthographe (`fullauto`, `full`, `full-auto`, `auto`, n'importe quelle casse). La raison : un workspace est très souvent un dépôt cloné dont le `.env` est arrivé avec lui, et `FullAuto` est le seul mode qui transforme un tel fichier en autorisation permanente d'écrire dans un de tes vaults sans redemander. Les deux endroits d'où il vient encore sont la déclaration du serveur dans l'hôte MCP (une entrée `env` à côté de la commande du router) et un appel à `set_auto_enrich_mode` pendant la session. Quand un fichier a demandé et s'est vu refuser, le router le dit sur sa sortie d'erreur et `list_vaults` porte `autoEnrichModeRefused`. C'est l'option n°4, acceptée, de la décision `liaison-workspace-vault-hors-depot`.

#### `ClaudeAsk` (défaut) — propose, confirme toujours

**Comportement** : à chaque trigger (validation / résultat / changement de sujet), Claude liste les candidats et attend ta sélection ("all", "none", numéros, "skip"). Rien n'est sauvé sans ton OK explicite.

**Pour quel usage** :
- 🆕 **Période de découverte / calibration** — les 1-2 premières semaines d'utilisation, avant de faire confiance au classificateur
- 📚 **Sessions longues à importance mixte** — quelques pépites, beaucoup de bruit ; tu veux être le filtre
- 🛡️ **Vaults où les faux positifs coûtent cher à nettoyer** — wikis de domaine avec beaucoup de citations entre pages, où supprimer une page erronée casse les références
- 🎓 **Apprendre ce que Claude considère save-worthy** — tu observes les propositions pour recalibrer ton propre sens de "qu'est-ce qui mérite d'être gardé"

**Trade-off** : friction. Chaque digest est une question à laquelle répondre.

#### `Hybrid` — auto-save les type-safe, ask sur les high-stakes

**Comportement** : Claude auto-save les items où les faux positifs sont peu coûteux (`fact`, `url`, `preference`) et demande confirmation sur les items où les faux positifs coûtent cher (`decision`, `adr`, `rule`, `technique`, `session`). Les digests montrent les deux : "✅ auto-saved" + "à confirmer".

**Pour quel usage** :
- ⚡ **Sweet spot power-user après calibration** — une fois que tu fais confiance à la détection URL/fait de Claude, tu arrêtes de vouloir confirmer chacun
- 🌐 **Recherche active avec ingestion d'URLs fréquente** — tu lis 30 articles, tu veux chacun filé sans réfléchir
- 📊 **Travail à forte densité de citations** — les appels `wiki-ingest` arrivent en continu, la confirmation manuelle devient le bottleneck
- 🛠️ **Dev actif** — les facts (numéros de port, versions épinglées, valeurs de threshold) s'empilent, mais les décisions architecturales méritent toujours un battement de confirmation

**Trade-off** : tu confirmes toujours les saves consequentiels, mais tu arrêtes de confirmer les trivia. Meilleur ratio friction-évitée / sécurité.

#### `FullAuto` — auto-save tout (avec garde-fous)

**Comportement** : Claude auto-save à chaque trigger, pas de question. Audit log écrit dans `wiki-meta/journal.md` (lignes préfixées `[auto-save]` pour filtrer). Le filtre de sensibilité s'applique TOUJOURS (credentials / médical / financier / noms de clients → jamais auto-saved, dégradés en ask). Hard cap : après 5 auto-saves dans une session, le comportement dégrade en `ClaudeAsk` pour le reste de la session (tu seras explicitement informé : *"FullAuto cap atteint, je passe en demande de confirmation"*).

**Pour quel usage** :
- 📔 **Journal perso / chronique familiale** — tu ne veux pas penser aux décisions de save, tu veux juste un log de ce qui s'est passé
- 🤖 **Flows longs non supervisés** — `autoresearch` qui tourne pendant une heure, ingestion en batch de 50 sources ; tu ne serais pas là pour confirmer chacun
- 💭 **Brain-dumps solo où le wiki EST le log de conversation** — tu causes avec Claude comme partenaire de pensée à voix haute et veux tout capturer
- 🏆 **Mode haute confiance** — après 3+ mois en `Hybrid`, tu as vu le classificateur bien performer, tu acceptes le bruit résiduel

**Trade-off** : risque de bruit réel. Tu vas sauver des trucs que tu n'aurais pas sauvé. Mitigation : relire `wiki-meta/journal.md` chaque semaine pour attraper les égarés. Le hard cap empêche une session unique de dégénérer, mais une année de FullAuto sans curation rétrospective produira un wiki bruité.

**⚠️ Ne ship pas FullAuto le premier jour.** Calibre avec `ClaudeAsk` pendant 1 semaine, `Hybrid` pendant 1 mois, puis évalue.

#### `off` — `/save` manuel uniquement

**Comportement** : Claude ne fait AUCUNE proposition de save proactive. La consigne d'auto-enrichissement est totalement ignorée. Tu invoques `/save`, `/wiki-ingest`, `/wiki-fold`, etc. manuellement quand tu les veux.

**Pour quel usage** :
- 🐛 **Sessions de debug que tu ne veux pas polluer dans le wiki** — l'équivalent lock-mode pour la couche auto
- 🤐 **Conversations sensibles** — même avec le filtre de sensibilité activé, tu veux la garantie dure que rien ne soit sauvé
- 🎛️ **Préférence control-freak** — tu veux pleine agence consciente de ce qui entre dans ton wiki, point
- 🏛️ **Défaut pour les vaults légal / médical / financier** — high stakes, faible tolérance aux accidents
- 💡 **Sessions purement brainstorm** — le contenu est exploratoire, locker les propositions de save garde le flux propre

**Trade-off** : pas de friction, mais aussi pas de mémoire proactive. Tu reviens au comportement v0.8.0 — le wiki ne grossit que quand TU le pousses.

### Choisir ton mode de départ

Une recommandation pragmatique :

| Où tu en es | Choisis |
|---|---|
| Première fois avec l'auto-enrichissement | `ClaudeAsk` pendant 1-2 semaines |
| À l'aise avec les propositions, tu veux moins de friction | `Hybrid` pendant 1-3 mois |
| Tu fais confiance au classificateur, zéro friction sur le routine | `FullAuto` (avec relecture hebdomadaire de `wiki-meta/journal.md`) |
| Session spécifique qui ne doit pas être trackée | `off` pour cette session (sans `--persist`) |
| Vault contient du matériel sensible par nature | `off` persisté au niveau du vault |

Tu peux persister le mode per-workspace (dans le `.env` du workspace) pour que le même vault boot toujours dans le bon mode quelle que soit la session.

### Aperçu Phase 2 (pas encore shipped)

La Phase 1 (v0.8.2) couvre le cœur opérationnel. La Phase 2 ajoutera :
- **Digest quotidien** — à la première interaction du jour, liste les auto-saves de la veille pour review/rollback en batch
- **Hard cap configurable** — actuellement figé à 5 en FullAuto, deviendra ajustable per-vault
- **Filtre de sensibilité appris des corrections** — quand tu supprimes une page auto-saved dans les X minutes, le classificateur retient le pattern
