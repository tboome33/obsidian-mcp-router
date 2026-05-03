# Wiki auto-enrichment — placement guide

> *🇬🇧 English — [🇫🇷 version française plus bas](#-version-française)*

Phase 0 of the auto-enrichment system makes Claude proactively suggest wiki saves at three natural moments during a conversation: validation pins, result-obtained digests, and topic-switch checkpoints. The mechanics are documented in the consigne itself ([`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md), `## Auto-enrichment` section).

This file answers a different question: **where do you place the consigne so Claude actually applies it?** Four channels, one per Claude surface, all interoperable.

## TL;DR

| Surface | Channel | Persistence | Best for |
|---|---|---|---|
| Claude Code (workspace IS a vault) | Vault root `CLAUDE.md` | Per-vault, in the vault itself | The default — auto-loaded when you `cd` into the vault |
| Claude Desktop / Claude.ai (Project mode) | Project instructions | Per-project, cloud-synced | A workspace dedicated to a vault (e.g. "Trading Journal" → vault `tradingview`) |
| Claude Desktop / Claude.ai (chat free mode) | Memory | Cloud-synced, regenerated nightly | Identity-based routing ("I'm Roland" → vault `roland`) |
| Any Claude Code session | `~/.claude/CLAUDE.md` (global) | Local to your machine | Power users who want the consigne everywhere |

You can combine multiple channels — they don't conflict. Claude reads ALL the consignes loaded in its context and applies the activation rules.

## Channel 1 — Vault root `CLAUDE.md` (Claude Code, workspace = vault)

**When it applies**: Claude Code launched from a vault directory (e.g. `cd C:\VAULTS\TradingView && claude`).

**How it works**: Claude Code auto-loads the `CLAUDE.md` at the workspace root. The vault's CLAUDE.md is dropped there by `setup-vault.mjs` (or the `wiki` skill on scaffold) and includes the auto-enrichment consigne.

**Setup**: nothing to do — every vault scaffolded with `/obsidian-router:wiki` after v0.8.1 gets it automatically. For existing vaults bootstrapped before v0.8.1, copy the `## Auto-enrichment` section from [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) and paste it at the bottom of your vault's `CLAUDE.md`.

**Verification**: open `<vault>/CLAUDE.md` and look for the `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` section. If present, you're set.

## Channel 2 — Claude Project instructions (Claude Desktop / Claude.ai)

**When it applies**: any conversation started inside a Claude Project. Projects on Claude.ai (also surfaced in Claude Desktop) have their own custom instructions block, persisted server-side and shared by every chat in that project.

**Why this is elegant**: a Project is *already* the natural unit for "a domain that maps to a vault" — your "Trading Journal" project always saves to `tradingview`, your "Family Planning" project always saves to `roland`. Binding the vault at the Project level makes every conversation inside it auto-tracked, no slash command, no explicit opt-in.

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

**Variant — fully self-contained Project**: if you don't want Claude to read the rules from the vault every session (extra MCP call), copy the entire `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` section from [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) directly into the Project instructions. Trade-off: the Project instructions become heavier (~80 lines) but no runtime fetch.

## Channel 3 — Memory (Claude Desktop, identity-based routing)

**When it applies**: free chat in Claude Desktop / Claude.ai (no Project), where the user's identity routes to a vault. Useful for shared installs ("Roland's household shares a Claude account" — Memory asks who's speaking, then proposes tracking).

**How it works**: Claude's Memory feature persists facts across conversations and regenerates a summary nightly. You add an instruction to Memory that says "when user identifies as X, propose tracking in vault `x`".

**Setup**:

1. Open **Settings → Capacités → Mémoire → Afficher et gérer la mémoire** in Claude Desktop.
2. (Optional but recommended) In a regular chat, tell Claude explicitly:

   > *"To remember: at the start of each new conversation, ask which family member is using the account (Roland, Karine, Maxence, Nicolas, Amélie). Once identified, if the user has a vault by their name (e.g., Roland → vault `roland`), propose to enable wiki tracking for the session via the obsidian-router MCP. Apply the auto-enrichment consigne from the vault's CLAUDE.md."*

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
- The current Claude Code session has a vault bound (`VAULT_PATH` in `.env`, OR `OBSIDIAN_ROUTER_DEFAULT_VAULT` set, OR explicit user opt-in)
- The obsidian-mcp-router MCP is available

[paste the full Phase 0 consigne here]
```

**Caveat**: this enables tracking on every machine session. If you have many short / ad-hoc sessions where you don't want wiki proposals, the digest noise can be annoying. Most users prefer Channels 1+2 (per-vault and per-project) over the global option.

## Combining channels

The four channels are additive, not exclusive. A typical "all-in" Roland setup:

- **Vault `roland`'s `CLAUDE.md`** → consigne loaded when working from a Roland-vault workspace in Claude Code
- **Project "Trading Journal"** instructions → bound to vault `tradingview` for Claude Desktop trading conversations
- **Project "Family"** instructions → bound to vault `roland` for personal/family Claude Desktop conversations
- **Memory** → asks "which family member?" and proposes vault matching at chat start, when no Project is active

Each channel handles a different surface; they compose cleanly because the consigne self-gates on "is a vault bound?" — only one channel's binding fires at a time, depending on context.

## Phase 1 preview (not yet shipped)

Phase 0 is fixed at `ClaudeAsk` mode (always confirm). Phase 1 will add:

- A persistent `OBSIDIAN_ROUTER_AUTO_ENRICH={ClaudeAsk | Hybrid | FullAuto | off}` env var, lock-mode-style
- A slash command `/obsidian-router:auto-mode <Mode>` to toggle per-session
- `Hybrid` mode: auto-save type-safe items (facts, URLs), ask on high-stakes (decisions, ADRs)
- `FullAuto` mode with audit log + sensitivity filter + daily digest

Until Phase 1 ships, every save goes through user confirmation.

---

## 🇫🇷 Version française

La Phase 0 du système d'auto-enrichissement fait que Claude propose proactivement de sauver dans le wiki à trois moments naturels d'une conversation : pins de validation, digests post-résultat, et checkpoints au changement de sujet. La mécanique est documentée dans la consigne elle-même ([`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md), section `## Auto-enrichment`).

Ce fichier répond à une autre question : **où placer la consigne pour que Claude l'applique réellement ?** Quatre canaux, un par surface Claude, tous interopérables.

### TL;DR

| Surface | Canal | Persistance | Pour quoi |
|---|---|---|---|
| Claude Code (workspace = vault) | `CLAUDE.md` racine du vault | Per-vault, dans le vault | Le défaut — auto-chargé quand tu `cd` dans le vault |
| Claude Desktop / Claude.ai (mode Project) | Instructions du Project | Per-projet, sync cloud | Un workspace dédié à un vault (ex : "Journal Trading" → vault `tradingview`) |
| Claude Desktop / Claude.ai (chat libre) | Memory | Sync cloud, régénérée chaque nuit | Routing par identité ("c'est Roland" → vault `roland`) |
| N'importe quelle session Claude Code | `~/.claude/CLAUDE.md` (global) | Local à ta machine | Pour ceux qui veulent la consigne partout |

Tu peux combiner plusieurs canaux — ils ne se contredisent pas. Claude lit toutes les consignes chargées dans son contexte et applique les règles d'activation.

### Canal 1 — `CLAUDE.md` racine du vault (Claude Code, workspace = vault)

**Quand ça s'applique** : Claude Code lancé depuis un dossier de vault (par exemple `cd C:\VAULTS\TradingView && claude`).

**Comment ça marche** : Claude Code auto-charge le `CLAUDE.md` à la racine du workspace. Le `CLAUDE.md` du vault y est posé par `setup-vault.mjs` (ou par le skill `wiki` lors du scaffold) et contient la consigne d'auto-enrichissement.

**Setup** : rien à faire — chaque vault scaffold avec `/obsidian-router:wiki` après v0.8.1 l'a automatiquement. Pour les vaults existants bootstrappés avant v0.8.1, copie la section `## Auto-enrichment` depuis [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) et colle-la en bas du `CLAUDE.md` de ton vault.

**Vérification** : ouvre `<vault>/CLAUDE.md` et cherche la section `## Auto-enrichment (Phase 0 — ClaudeAsk mode)`. Si présente, tu es bon.

### Canal 2 — Instructions de Project Claude (Claude Desktop / Claude.ai)

**Quand ça s'applique** : toute conversation démarrée dans un Project Claude. Les Projects sur Claude.ai (et dans Claude Desktop) ont leur propre bloc d'instructions custom, persisté côté serveur et partagé par chaque chat dans ce Project.

**Pourquoi c'est élégant** : un Project EST déjà l'unité naturelle pour "un domaine qui mappe à un vault" — ton Project "Journal Trading" sauve toujours dans `tradingview`, ton Project "Famille" sauve toujours dans `roland`. Binder le vault au niveau du Project rend chaque conversation à l'intérieur auto-trackée, sans slash command, sans opt-in explicite.

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

**Variante — Project fully self-contained** : si tu ne veux pas que Claude lise les règles depuis le vault à chaque session (appel MCP supplémentaire), copie la section `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` complète depuis [`templates/wiki/CLAUDE.md`](../templates/wiki/CLAUDE.md) directement dans les instructions du Project. Trade-off : les instructions du Project deviennent plus lourdes (~80 lignes) mais zéro fetch runtime.

### Canal 3 — Memory (Claude Desktop, routing par identité)

**Quand ça s'applique** : chat libre dans Claude Desktop / Claude.ai (pas de Project), où l'identité de l'utilisateur route vers un vault. Utile pour les installs partagées ("le foyer de Roland partage un compte Claude" — Memory demande qui parle, puis propose le tracking).

**Comment ça marche** : la feature Memory de Claude persiste des faits entre conversations et régénère un résumé chaque nuit. Tu ajoutes une instruction à la Memory qui dit "quand l'utilisateur s'identifie comme X, propose le tracking dans le vault `x`".

**Setup** :

1. Ouvre **Paramètres → Capacités → Mémoire → Afficher et gérer la mémoire** dans Claude Desktop.
2. (Optionnel mais recommandé) Dans un chat normal, dis explicitement à Claude :

   > *"À retenir : au début de chaque nouvelle conversation, demande quel membre de la famille utilise le compte (Roland, Karine, Maxence, Nicolas, Amélie). Une fois identifié, si l'utilisateur a un vault à son nom (ex : Roland → vault `roland`), propose-lui d'activer le tracking wiki pour la session via le MCP obsidian-router. Applique la consigne d'auto-enrichissement depuis le `CLAUDE.md` du vault."*

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
- La session Claude Code courante a un vault bind (`VAULT_PATH` dans `.env`, OU `OBSIDIAN_ROUTER_DEFAULT_VAULT` posé, OU opt-in explicite utilisateur)
- Le MCP obsidian-mcp-router est disponible

[colle ici la consigne Phase 0 complète]
```

**Caveat** : ça active le tracking sur chaque session machine. Si tu as beaucoup de sessions courtes / ad-hoc où tu ne veux pas de propositions wiki, le bruit des digests devient pénible. La plupart préfèrent les Canaux 1+2 (per-vault et per-project) plutôt que le global.

### Combiner les canaux

Les quatre canaux sont additifs, pas exclusifs. Un setup "tout-en-un" type Roland :

- **`CLAUDE.md` du vault `roland`** → consigne chargée quand on bosse depuis un workspace Roland en Claude Code
- **Instructions du Project "Journal Trading"** → bind au vault `tradingview` pour les conversations trading sur Claude Desktop
- **Instructions du Project "Famille"** → bind au vault `roland` pour les conversations perso/famille sur Claude Desktop
- **Memory** → demande "quel membre de la famille ?" et propose le matching de vault au début du chat, quand aucun Project n'est actif

Chaque canal gère une surface différente ; ils se composent proprement parce que la consigne s'auto-gate sur "est-ce qu'un vault est bind ?" — un seul canal de binding fire à la fois, selon le contexte.

### Aperçu Phase 1 (pas encore shipped)

La Phase 0 est figée en mode `ClaudeAsk` (toujours confirmer). La Phase 1 ajoutera :

- Une variable d'env persistante `OBSIDIAN_ROUTER_AUTO_ENRICH={ClaudeAsk | Hybrid | FullAuto | off}`, façon lock-mode
- Une slash command `/obsidian-router:auto-mode <Mode>` pour toggle per-session
- Mode `Hybrid` : auto-save les items type-safe (facts, URLs), ask sur les high-stakes (decisions, ADRs)
- Mode `FullAuto` avec audit log + filtre de sensibilité + digest quotidien

Tant que la Phase 1 n'est pas shipped, chaque save passe par confirmation utilisateur.
