# Announcement drafts — copy-paste ready

3 channels, 3 different tones. Each is standalone — pick one, paste, post.

---

## Channel 1 — Obsidian Forum (`forum.obsidian.md` → Share & showcase → Plugins)

**Title** : `obsidian-mcp-router — single MCP entry for multi-vault Claude Code/Desktop usage`

**Body** :

I just shipped a project that's been a real productivity win for my own multi-vault Obsidian workflow, and I'm sharing it in case it helps anyone in the same boat.

**The problem** : if you keep more than one Obsidian vault — a personal wiki, a research vault, a vault on a NAS, etc. — and you use Claude Code / Claude Desktop with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin, you end up registering one MCP entry per vault (one process, one port, one API key). It works, but switching context between vaults gets clumsy fast.

**[obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router)** is a single MCP server that knows about every vault you've configured. Each tool call takes a `vault` parameter (or uses your default), and the router fans out the HTTPS request to the right Obsidian instance. Cross-vault search/fan-out works via `vault: "*"`.

What you get:

- One MCP entry in `~/.claude.json` → all vaults visible from any Claude Desktop / Code session
- Local + remote vaults treated identically (URL + API key in config = done)
- Cross-vault search: `vault: "*"` fans out to all vaults in parallel
- Lock mode (single-vault session isolation, useful for sensitive work or shared installs)
- 30 slash commands packaged as a Claude Code plugin, organized in 5 categories (`discover` / `read` / `write` / `manage` / `template` for the 14 wrappers, plus state-management (`lock` / `unlock` / `auto-mode`), conversational helpers (`meta-setup` / `meta-add-vault` / `meta-status`), and a 10-command Karpathy-style LLM-wiki workflow on top)
- Auto-enrichment Phase 1 (4-mode dial) — Claude proactively suggests wiki saves at three natural conversation beats (validation pin, result-obtained digest, topic-switch checkpoint)

It's a multi-vault router, not a workflow tool — domain-agnostic. The Karpathy-style LLM-wiki workflow ships as an optional layer on top, but the router itself works for any vault content (personal notes, research, business docs, whatever).

The companion plugin **[obsidian-mcp-router-bridge](https://github.com/tboome33/obsidian-mcp-router-bridge)** adds two REST routes to Local REST API for semantic search (Smart Connections) and Templater execution. PR submitted to the community plugins marketplace ([#12599](https://github.com/obsidianmd/obsidian-releases/pull/12599)) — manual install until it lands.

Apache 2.0, no telemetry, no native binary, CI matrix on Linux + Windows × Node 20 + 22 (88/88 tests green). Bilingual docs (EN + FR).

Feedback / PRs / use-case reports very welcome. Especially curious to hear if anyone tries the auto-enrichment in non-dev contexts (research, journaling, family planning) — I've designed it to be domain-neutral but real-world testing on diverse use cases is the only way to know.

---

## Channel 2 — Anthropic Discord (`#claude-code` channel)

**Title** : *(no title — Discord post)*

**Body** :

Sharing an MCP server I built for multi-vault Obsidian → Claude Code workflows : **[obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router)**.

If you've got more than one Obsidian vault and you find yourself adding one MCP entry per vault, this collapses everything into a single MCP that routes per-vault via a `vault` parameter. Local + remote vaults, cross-vault fan-out, lock mode for session isolation, and a Karpathy-style LLM-wiki layer on top (optional).

Comes with a Claude Code plugin marketplace (30 slash commands under `/obsidian-router:*`) and bilingual docs (EN + FR). Designed project-scope by default — you enable the plugin per-workspace via `.claude/settings.json`, not globally, so you don't pay 10k context tokens for slash commands you're not using on unrelated repos.

Newest feature is wiki auto-enrichment Phase 1 — Claude proactively suggests saves at three natural conversation beats (validation pin, result digest, topic switch). 4 modes from `ClaudeAsk` (always confirm) to `FullAuto` (auto-save with safety nets). Written to be domain-agnostic — works for code, personal life, research, family planning.

Apache 2.0, CI green on Linux + Windows × Node 20 + 22, no telemetry. PRs and feedback welcome.

Repos:
- https://github.com/tboome33/obsidian-mcp-router (npm package + Claude Code plugin)
- https://github.com/tboome33/obsidian-mcp-router-bridge (Obsidian companion plugin)

---

## Channel 3 — Reddit `r/ObsidianMD` and/or `r/ClaudeAI`

**Title** (one of these) :

- *I built a single-MCP router for managing multiple Obsidian vaults from Claude Code/Desktop*
- *obsidian-mcp-router : one MCP entry, every vault, cross-vault search included*

**Body** :

Cross-posting since the audience overlaps. If you use Obsidian + Claude Code or Claude Desktop with multiple vaults, you've probably hit the friction of registering one MCP server per vault. I built a router that collapses that to a single MCP entry.

**[obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router)** — Apache 2.0, no telemetry, CI matrix green on Linux + Windows × Node 20 + 22.

**Highlights**

- One MCP entry in `~/.claude.json` → all your vaults visible from any session
- `vault: "*"` for cross-vault fan-out (search, semantic-search, etc.)
- Local + remote vaults treated identically (URL + API key in config)
- Lock mode for single-vault session isolation
- 30 slash commands as a Claude Code plugin (`/obsidian-router:*` namespace), bilingual auto-trigger on EN + FR natural language
- Auto-enrichment Phase 1 (just shipped) — 4-mode dial that lets Claude proactively suggest wiki saves at natural conversation beats. Configurable per-vault.
- Bilingual docs + 5-page printable PDF reference

**Companion plugin** : [obsidian-mcp-router-bridge](https://github.com/tboome33/obsidian-mcp-router-bridge) adds `/search/smart` (Smart Connections) and `/templates/execute` (Templater) REST routes — submitted to the Obsidian community plugins marketplace, manual install meanwhile.

**Why this isn't just another wrapper**

Project-scope by default. The plugin enables per-workspace via `.claude/settings.json`, not globally. Your Claude Code session in a non-Obsidian repo doesn't pay 10k context tokens for slash commands you're not going to use. Vaults you're actually working with get the full surface; everything else stays clean.

Feedback / PRs / use-case stories welcome. Particularly curious to hear if the auto-enrichment system survives non-dev contexts (research, journaling, family planning) — I designed it domain-neutral but real-world testing on diverse use cases is the only validation that matters.

---

## Posting strategy (suggested)

| Channel | When | Why |
|---|---|---|
| **Obsidian Forum** | First — most aligned audience | Forum signals respectability, marketplace reviewers may peek |
| **Anthropic Discord** | Same day or next | Community is highly engaged with MCP tooling, fast feedback loop |
| **Reddit r/ObsidianMD** | 1-2 days later | Once you have a few stars / forum responses to point at |
| **Reddit r/ClaudeAI** | Same as r/ObsidianMD | Different audience, same content |

Wait until the marketplace PR is **accepted** before going to Hacker News / Twitter. Marketplace acceptance is the social proof that opens those channels.
