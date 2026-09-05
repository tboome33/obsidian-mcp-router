# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

### Vault creation gets easier, and a new tool registers a remote vault from the conversation

Phase 1 of the `portee-ergonomie-refus-roadmap` (decisions `ergonomie-creation-liaison-vaults` §1
and §2, accepted 2026-09-04). Low-risk, additive — no change for anyone not using the new
parameters.

#### Added

- **`vaultsRoot` composes a path from a name alone.** `provision_vault`/`plan_vault` may now omit
  `path` when `name` is given: the target is composed as `<vaultsRoot>/<slug-of-name>`. Refuses
  clearly when `vaultsRoot` isn't configured, and refuses when the composed folder is already
  registered under a *different* name (re-running with the same name still works).
- **`provision_vault` gains `bindToWorkspace`** (default `false`): binds the CURRENT workspace to
  the newly-created vault on success, on explicit request only.
- **`register_remote_vault`** (52nd tool) — register an already-open remote vault (`name`,
  `baseUrl`, `apiKey`) from the conversation, without hand-editing `config.json`. Always writes to
  the router's own config, never a workspace `.env`. Pre-checks
  `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` before writing (refuses rather than writing an entry
  that would later break config reload), refuses a name collision case-insensitively (matching how
  `--attach`/`confirm_workspace_binding` resolve names elsewhere), and is excluded from gated
  deployments — MCPHub's multi-tenant instances share one central `config.json`.

#### Docs

- `docs/remote-vaults.md`: WireGuard documented as a first-class transport alongside Tailscale (not
  only via Tailscale's own mesh), and a new section on `ifMatch` discipline for a vault shared by
  more than one workspace, with the concrete two-writer scenario.

### A vault a workspace never declared stops answering, and a secondary vault opens read-only

Phases 2 and 3 of the `portee-ergonomie-refus-roadmap` (decision `portee-et-mode-ecriture-des-vaults`,
accepted 2026-09-04). Both switches are OFF by default: nothing changes for an installation that
does not set them.

#### Added

- **`vaultReach: "declared"`** (config) — once set, a registered vault answers a session only if
  that workspace's binding names it (`vault` or `also`), or if it is listed in **`openVaults`**,
  the exception list that keeps a personal vault reachable from everywhere (the Desktop chat has
  no workspace, so no binding). Enforced in `resolveVault()`, the one place a name becomes a vault;
  `search`/`search_smart` with `vault: "*"`, the MCP Resources listing and `list_vaults` follow it —
  `list_vaults` keeps SHOWING an unreachable vault in `disabled[]`, with its reason.
- **Three write tiers for a workspace's SECONDARY vaults** (`also`): read-only strict (`locked`,
  refused unconditionally — no parameter lifts it, and a locked secondary cannot be promoted to
  primary from the conversation), read-only with a per-write override (`soft`, the default — the
  write must carry **`confirmSecondaryWrite: true`**, which every write tool now declares and which
  Claude may set only after the user said yes), and read-write (`writable`). The primary is always
  read-write. The router's own writes — the first-contact repair, the audit line, the projections
  refresh — obey the same tier, including a refresh queued before the tier changed.
- **`set_secondary_vault_mode`** (53rd tool) — records one secondary's tier for the CURRENT
  workspace, on its binding in the user's own config: the same vault can be strict in one project
  and read-write in another. The global `alsoLocked`/`alsoWritable` config lists still work.
- **`bind-workspace` skill + `/obsidian-router:bind-workspace` and
  `/obsidian-router:configure-secondary-vaults` commands** — a deterministic wizard: the open
  vaults are detected and listed, the user names the primary (or opens one and says when), confirms,
  then attaches secondaries the same way and answers one question per vault. English canonical
  prompts, answered in the user's language.

#### Changed

- `download_page_assets` — an `outputDir` inside a registered vault's folder is now subject to that
  vault's reachability and write tier, exactly as a REST write would be.
- The `install:agent-rules` index walks the `brief` clip down (80 → 24 chars) before giving up
  descriptions, so a tight host cap no longer flips straight to the degraded index.

#### Fixed

- `lock_vault`, `OBSIDIAN_ROUTER_LOCKED` at start-up and a host lock re-derived on
  `confirm_workspace_binding({ clear })` can no longer leave a session locked to a vault the
  workspace cannot reach (every call would then fail until `unlock_vaults`).
- `build_wiki_graph` with a stringified `dryRun` (`"true"`) is a dry run, never a write.

## [0.90.0] — 2026-09-04 — a project's file stops deciding which vault you are in

Two lots, both about trusting a file less. The first takes AUTHORITY away from the workspace
`.env`; the second stops taking the config's word about a vault's NAME on trust. They were
written separately, reviewed separately, and merged — the four functions they both rewrote are
where "who may choose the vault" meets "what a vault is called".

### The workspace→vault binding leaves the repository

A workspace is very often a cloned repository. Until now, the `OBSIDIAN_ROUTER_DEFAULT_VAULT`
line that repository carried decided which of your vaults the session read, locked and wrote
into — a file you may never have written, choosing where a year of notes go. v0.87.0 closed the
security half of that (such a file can only ever name a vault you already registered, never an
endpoint or a credential); v0.88.0 made the choice visible; v0.89.0 removed the one value that
turned it into standing write permission. This release removes the authority itself.

**BREAKING.** A workspace `.env` no longer chooses the default vault or the lock. Existing
installations are carried over by a one-time import (below), so nothing in the field breaks; a
hint written *after* upgrading is reported and confirmed instead of applied.

#### Added

- **`workspaceBindings` in your own `config.json`**, keyed by the canonical path of the
  workspace. It is the new tier 0 of the resolution cascade and the only tier that cannot arrive
  with a `git clone`: that file is never synchronised between machines, because it holds your
  vault paths and API keys. A binding names one vault, or one plus secondaries (`also`), or —
  when there is none — every registered vault stays available. Three states, and `null` never
  means "no vault".
- **`confirm_workspace_binding`** (51st tool) — the conversational half. Binds the CURRENT
  workspace only (no path parameter: binding a directory you are not in is not something a
  conversation should be able to do by accident), validates every name against the registry, and
  OPENS a bound vault whose Obsidian is not running, because a closed vault does not answer and a
  binding to one would be a promise that does not work. `clear: true` returns to all vaults.
- **A session-start briefing**, shipped with the plugin. A few lines saying what this workspace is
  attached to, what its `.env` proposed and did not get, the enrichment mode and its range, and
  the two calls that change any of it. It is what makes the automatic import below defensible: a
  binding imported wrongly announces itself at the top of every session instead of quietly
  deciding where your notes go. Its opt-out is the one a workspace `.env` cannot set — read
  before the file is loaded AND refused by name in the dotenv policy — because a file able to
  switch off the report about itself is the same hole one level up.
- **`bindingHint`, `workspaceBinding` and `bindingImported` on `list_vaults`.** Separate fields,
  never an origin: a hint that was not applied is not the source of what replaced it.
  `bindingHint.origin` says WHO proposed — telling you your project's `.env` did it when your own
  MCP host did would send you to the wrong file.
- **`setup-vault.mjs --attach <vault> --also <other>`** now records the binding, secondaries
  included. Those secondaries had until now lived only in the workspace's `CLAUDE.md` — prose for
  Claude that the router never read.

#### Changed

- **One gate for three settings.** `OBSIDIAN_ROUTER_DEFAULT_VAULT`, `OBSIDIAN_ROUTER_LOCKED` and
  `VAULT_PATH` are authorities from the HOST (your MCP declaration, a launcher, your shell) and
  proposals from a project file. `VAULT_PATH` keeps one exception, which is the case it was
  written for: from a workspace file it is honoured when it names that same directory — "this
  folder IS a vault", exactly what `setup-vault` writes into each bootstrapped vault's own `.env`.
  Six resolvers go through the gate; a scan refuses a seventh that does not.
- **`lock_vault --persist` means what it says.** `persisted` now means "will survive a restart",
  which is the binding — the `.env` line it also writes is a portable hint, reported separately as
  `hintWritten`. When the config cannot be written, `persisted` is false and the message says the
  lock does NOT survive, rather than promising something that stopped being true.
- **One writer for `config.json`, and it no longer overwrites what it did not change.**
  `saveConfig` and the binding writer take the same inter-process lock and write atomically,
  carrying the target's POSIX permission bits across the rename: this file holds every vault's
  API key, and a `0600` config used to come back `0644`. But the lock is taken at the WRITE, not
  at the read, and `setup-vault` reads the config, clones plugin directories, probes ports, and
  saves seconds later — so a binding a Claude session confirmed in that window was inside the
  snapshot's blind spot and disappeared, and the same ordering lost an API key. It now re-reads
  inside the lock and merges by top-level key: what this process changed wins, everything else
  comes from the disk, a key it read and removed stays removed. The rule is a pure function
  (`src/helpers/config-merge.mjs`) so it is tested without having to reproduce a race.
- **`setup-vault --link-workspace` records the binding, and `--unlink-workspace` removes it.**
  Since the binding registry landed, the `.env` line these commands wrote is a hint the router
  reports and does not apply — so `--link-workspace` linked nothing, while the documentation said
  it "records the binding, which is what decides". `--unlink-workspace` was worse: it removed the
  hint, told you to restart so the hooks would stop loading the old vault, and left the binding in
  place to load it again. Both are commands you typed, which is exactly what a confirmation is.
- **The vault-link linter checks a binding is ACTIVE before obeying it**, like the cascade and
  the two other hook resolvers already did. A stale binding locked to a vault that had been
  disabled or removed made the hook narrow itself to a vault it could not find and exit silently
  — going quiet about every real broken link in the vault the session was actually working in.
  A file nobody has edited in months must not be able to switch a check off.
- **A hook's idea of "registered" honours `OBSIDIAN_ROUTER_ALLOWED_VAULTS`** — for the binding,
  for the host default, for a remote vault, and for a cwd that is itself a vault. The whitelist
  narrows what the server serves; a hook set that ignored it was WIDER than the server's, so a
  vault the server refuses read as available and journaling, autocommit and recall could write
  into a vault the session's own isolation boundary excludes. Being short of the registry is
  deliberate and errs toward a hook doing nothing; being wider errs the other way, and only one of
  those is acceptable. (The first repair reached the binding tier alone — three of the four doors
  stayed open, which is why round 5 exists.)
- **The config is not rewritten when nothing changed.** All three transforms return the object
  they were handed when the result is identical, and the writer skips the file on that identity.
  Without it a workspace that already had a binding rewrote `config.json` — the file holding every
  vault's API key — on EVERY router start, and `lock_vault --persist` rewrote it for byte-identical
  content. A settled workspace now does not even take the inter-process lock, so two sessions
  starting together never queue behind each other.
- **`--link-workspace`, `--unlink-workspace` and `--attach` FAIL when the binding cannot be
  written.** They used to warn and exit 0, printing "Linked workspace" for a command that had
  linked nothing at all: the `.env` line they also write is a hint the router reports and does not
  apply. A user who reads a success message walks away believing the attachment exists.
- **Every reader of `portRegistry` goes through the container check.** `Object.keys(cfg.portRegistry
  || {})` accepts anything truthy, and `Object.keys` on a string yields index keys — so a
  hand-edited `"portRegistry": "AB"` manufactured vault paths `"0"` and `"1"`. That was fixed in
  `src/registry.mjs` during the merge review and nowhere else, which is this repository's signature
  defect: the server saw no vaults while every other surface invented two. **23 raw expressions
  across 11 files** were routed through the accessor — counted from the diff, not estimated — and a
  scan now refuses a raw read outside the helper. The scan is what found them: each round of it
  named sites the previous reading had missed, and its first version was itself too narrow (it
  matched one spelling of `Object.keys(cfg.portRegistry)` and walked past optional chaining,
  bracket access, aliases, destructuring and `for…in` — measured, 6 of 8 shapes).

#### Migration

- **Your existing hints are imported once, and the router says so.** The first start in a
  workspace that already had a hint records it as a binding, labelled `confirmedVia: "migration"`
  so a later session still knows nobody confirmed it. Clearing it sticks — the workspace is
  remembered as considered, so the next start does not re-import and quietly reverse your
  decision.
- **A lock you had persisted comes across too.** `lock_vault --persist` used to write
  `OBSIDIAN_ROUTER_LOCKED` into the workspace file, and the router applied it at start-up.
  Refusing that line without migrating it would have removed an isolation boundary you had
  explicitly set, in silence, with nothing anywhere reporting it — so the import carries it onto
  the binding as `locked: true`, `list_vaults` reports it in `bindingImported.locked`, and the
  session briefing says the lock came from the same file nobody confirmed. Where a file named a
  lock on one vault and a default on another, the LOCK decides: while it was in force every call
  without an explicit vault resolved to the locked one and every other vault was refused, so that
  is where the work was actually going.
- **The window closes**, which is the part that took the work. An import that keeps running is
  the old behaviour with a delay. Two facts bound it: the instant you upgraded, and the dotenv
  file's own modification time. `git clone` writes its files *now*, so a repository cloned after
  the upgrade is always newer and never imported, while a workspace you attached last year is
  always older. That is the discrimination no marker inside a repository could give — and it
  works precisely BECAUSE cloning rewrites mtimes, the property that made in-repo markers
  worthless in the first place.
- **Two limits, stated because the sentence above is an absolute.** Unpacking an ARCHIVE — `tar
  x`, an unzip that restores timestamps, GitHub's source zipball, `rsync -a` — keeps the recorded
  mtime, so a project obtained that way after upgrading can look older than it is and *is*
  imported. And on a router whose very first start ever is on this version there is no "moment
  you upgraded" to compare against, so everything already on disk counts as older. A timestamp is
  the only signal the disk carries and no in-process check can do better; both cases are
  announced by the briefing like any other import, which is what makes them cost one sentence to
  undo. The README says the same in both languages, and a test pins the behaviour so that
  changing it has to be deliberate.

- **Self-hosted install with hooks wired before this version: re-run `--install-hooks`.** The
  import runs inside the router, so it runs for everyone; the briefing that discloses it is a
  hook, activated by the plugin's `hooks.json` or by `node scripts/setup-vault.mjs
  --install-hooks`. A `settings.json` written by an earlier `--install-hooks` does not carry it,
  and until it is re-run the imported binding is in force with nothing announcing it. Re-running
  is idempotent: existing hooks are left alone and the briefing is added.
- **A proposal cannot be declined, only adopted or left standing.** A hint the workspace `.env`
  carries and that you do not want — after clearing an imported binding, or in a repository cloned
  after upgrading — stays `unconfirmed`, so `list_vaults` keeps reporting it and the briefing keeps
  offering it at every session. The two ways to silence it are to adopt it or to remove the line
  from the file. A recorded "declined" state is the obvious next step and is not in this release.

#### Fixed — found in the fourth review, all three in the migration

- **A cleared binding came back.** The window only closed for a workspace something had actually
  been imported INTO. A workspace that already had a binding at the first start of this version —
  from `--attach`, from the tool, from `lock_vault --persist` — came out as "already bound" and
  was never written down as considered; so the day you CLEARED that binding, the next start found
  no binding, found the still-present dotenv hint, and imported it. An automatic decision
  reversing an explicit human one, which is the single failure this whole mechanism exists to
  prevent, and the config even recorded `confirmedVia: "migration"` for the thing you had just
  deliberately removed. The window now closes on both verdicts that are permanent, and
  `confirm_workspace_binding({ clear: true })` closes it itself as well — two independent
  reasons, because this is the one place an automatic decision can overwrite a human one.
- **`lock_vault --persist` onto another vault erased the rest of your binding.** A workspace bound
  to `notes` with `work` also bound, locked onto a third vault, came out bound to that vault
  ALONE: two entries you had recorded, gone, from an operation whose subject is something else —
  while the comment over the line promised that a lock "does not change which other vaults this
  workspace is bound to". The locked vault becomes the primary, and the previous primary and its
  secondaries move into `also`, where they stay bound, and addressable again once the lock is
  lifted (while it holds, no other vault answers). The session default moves with the primary
  too, so `unlock_vaults` no longer hands the session back to whatever the cascade had picked at
  start-up while the config says otherwise.
- **`bindingHint` was never re-classified in a running session.** It is computed once at start-up,
  and no tool that changed the binding touched it — so after `confirm_workspace_binding({ vault })`
  the hint you had just adopted was still reported `unconfirmed`, and the tool's own description
  tells Claude to offer a confirmation whenever it sees that status. Under `--no-watch` the
  assistant would keep proposing what you had already accepted, for the whole session. The mirror
  case, after a `clear`, kept reporting `confirmed`.

#### Fixed — found in the sixth review, all four "the system says one thing and does another"

- **`lock_vault --persist` then `confirm_workspace_binding({ clear: true })` left the session
  locked** while answering "all registered vaults are available again". The persisted lock kept
  a `runtime` source, and the clear releases a lock by asking who imposed it — round 5's own
  repair — so it did not recognise the lock as the binding's. A recorded lock is now credited to
  the binding, and a lock that survives a clear for a legitimate reason (a volatile `lock_vault`
  of this session, or the host's) is named in the answer instead of being contradicted by it.
- **`unlock_vaults --persist` under a HOST lock promised "it will not come back on restart".**
  `OBSIDIAN_ROUTER_LOCKED` in the MCP declaration or the shell is re-imposed at every start and
  nothing the config says can lift it. The response now says so, `persisted` is false in that
  case, and a new `hostReimposes` field carries the fact.
- **The briefing contradicted itself for a locked binding with secondaries** — the exact state
  `lock_vault --persist` produces on a workspace with an `also`: "no other vault answers, with X
  also bound and addressable by name". The guard is the truth: secondaries stay bound and answer
  again once the lock is lifted. The tool's own message and this CHANGELOG said the same wrong
  thing; all three now agree.
- **The `list_vaults` description still told Claude a project `.env` can choose the vault.** Two
  sentences survived the documentation sweep: "what a workspace file may set at all is … a vault
  it must pick from the ones already registered", and an origin `workspace-dotenv` for
  `defaultVaultSource` / `lockSource` that the gate can no longer produce. Read as instructions,
  they lead Claude to advise editing the `.env` to change vaults; the description now says a file
  can only propose those two and points at `confirm_workspace_binding`. The `Ready` line's comment
  made the same claim in the future tense.

#### Verification

- Full suite **5 023 tests, 0 failed, 2 opt-in skips** (4 561 before the two lots — measured at
  the base commit in a worktree, not read from a note). `npm run validate` and `npm run gate`
  green. The sixth review's four repairs each carry a witness test, and each of the five
  mutations that undo a repair was seen red and restored by snapshot with a `sha256` compare.
- **Reviewed adversarially five times**, invariants handed in as input each time and rewritten
  after each round of repairs. Round 1: one BLOCKER — the `.env` was still deciding the default
  while the briefing said it had not been applied — plus eight defects and seven blind tests.
  Round 2: three more BLOCKERs, **two of them introduced by round 1's own repairs**. Round 3, on
  the merge: the migration decided outside the lock it then wrote inside, so a binding recorded
  by `--attach` in between was overwritten — the lost update the lock exists to prevent,
  reappearing inside the function that takes it.
- **Round 4, before the version bump, found three more and all three were about the migration —
  the part every earlier round had signed off.** They are listed under Migration and Fixed above:
  a cleared binding came back on the next start; a lock the user had persisted disappeared on
  upgrade; and an archive-extracted project was imported although the documentation said it could
  not be. The pattern is the one this repository keeps rediscovering: the rounds converge on the
  code that was rewritten most, and the last hole sits in what a repair round *added*.
- **Round 5 reviewed THE REPAIRS, and found ten more.** Three of them were repairs that had
  reached only their first site — the fix that made the migration hand back the binding it read
  inside the lock left the early-return path reading the start-up copy; the whitelist check
  reached the binding tier and not the host default beside it, nor the remote-vault loop; the
  live-registry refresh reached one of two exit paths. Two were new failure modes the repairs
  introduced: a workspace that was already bound rewrote `config.json` on EVERY start, and a lock
  hint naming a temporarily unregistered vault fell back to the default hint and then closed the
  window on that wrong answer for good. The rest: eligibility still validated outside the lock, a
  live lock released by comparing names instead of asking who imposed it, an unknowable file age
  treated as "old enough", `--link-workspace` printing success for a binding it had failed to
  write, and `unlock_vaults` reporting `persisted: true` beside `bindingLifted: false`. The
  pattern held: the rounds converge on the code that was rewritten most, and the last holes sit
  in what the previous round ADDED.
- **Round 6 read the surfaces addressed to the assistant as what they are — instructions** — the
  tool descriptions, the session briefing beside the hot-cache block, the CHANGELOG as a published
  document, and the upgrade path end to end without the code. Four findings, listed under Fixed
  above; two of them sat in round 5's repairs (the lock released by source, and a sentence the
  lock repair added), which is the pattern one more time. Every count in this section was
  re-derived: the tool number, the `portRegistry` sites (24 removed lines, one expression across
  two), the suite before and after.
- **Thirty-five mutations across two passes, each seen red**, each restored by copying a snapshot
  back and comparing `sha256` rather than by `git checkout`. One witness per rule, no shared
  marker. Round 4's sixteen: the migration recording only on import, the lock hint being ignored,
  the previous primary being dropped, the `confirmedVia` marker surviving an explicit lock, the
  session default not moving, the live hint never re-classified, the window not closing on a
  `clear`, a raw config value reaching a message, the config snapshot written without merging,
  `--link-workspace` writing only the hint, the linter obeying an inactive binding, the whitelist
  being ignored, the imported lock flag being dropped, the import walk stopping at re-exports, and
  one swept `portRegistry` read reinstated. Round 5's nineteen add the repairs themselves, plus
  the two shapes a guard is easiest to fool with: a bare dependency planted behind an
  `export … from`, and a `createRequire` planted in the hook graph.
- **Eleven of those mutations survived on a first run, and most killed a test written minutes
  earlier.** In round 4, three of four. A `clear`-closes-the-window test called the production transform
  by hand instead of the tool, so deleting the call from `confirm_workspace_binding` left it
  green. A `saveConfig` test planted the competing write *before* the run that was supposed to
  lose it, so the value was inside the snapshot either way — the rule now lives in a pure
  function (`src/helpers/config-merge.mjs`) tested without a race, because a test that cannot
  reproduce an interleaving reliably is worse than none. And the witness for "the import walk
  follows re-exports" named a module that is *also* reached by an ordinary `import`, so it
  measured a coincidence of today's import list; it is a fixture now. Third lot running, third
  time a guard was theatre until a mutation said so.
- **The `portRegistry` sweep was found BY the scan, not by reading.** The container fix landed in
  `src/registry.mjs` during the merge review and stopped there; the scan added in this round
  named twelve more sites across ten files — the link linter, the drift detector, the hot-cache
  prompt, `--status`, the backfill script, the bridge fleet updater, the readiness audit, the OKF
  projection and rename scripts, the remote-config key writer and four counts in `setup-vault`.
  Every one was routed through the accessor and the denominator was checked before it was
  written, which is the only way this repository has ever got one right.

### The config's word about a vault, checked once

`config.json` maps a vault path to a display name. It is a hand-editable file, so
`"vaultNames": { "C:/VAULTS/Notes": 123 }` is a thing a user can write: valid JSON, wrong type,
and nothing between the text editor and the reader ever checked. Twenty-two readers across nine
files took that value on trust, each having re-derived the same expression by hand —
`(vaultNames[vp] || defaultNameFromPath(vp)).toLowerCase()`.

Nine of them threw a `TypeError` on the number. Three of those sit in
`hooks/_helpers/doc-drift-detector.mjs` and one in `hooks/_helpers/workspace-vault.mjs`, which
is how one mistyped line in a config broke a hook's always-exit-0 promise. The other twelve did
not throw, which is the worse half: they carried the number onward as if it were a vault name.

### Fixed

- **The `vaultNames` value is type-checked ONCE, at the boundary, and all 22 readers go through
  it** — `src/helpers/vault-slug.mjs`. A value that is not a non-empty string is IGNORED and the
  slug falls back to the path, exactly as if the key had never been written. Not a throw (a hook
  exits 0 whatever the config says) and not a `String()` coercion either — coercion would turn a
  typo'd `123` into a real, resolvable vault name that can collide with or shadow a neighbouring
  vault, moving the failure somewhere harder to see instead of removing it. The map's SHAPE is
  checked too: `"vaultNames": "notes"` and `"vaultNames": ["notes"]` are both parseable JSON that
  the old `cfg.vaultNames || {}` accepted and then indexed.
- **Twenty-two guards would have been the wrong repair.** The twenty-third site gets written next
  month and is a guard short, so the sweep is enforced by a TEST rather than by discipline:
  `tests/vault-slug.test.mjs` scans `src/`, `hooks/`, `scripts/` and `bin/` and fails if a direct
  `vaultNames[...]` read reappears anywhere outside the helper. The one legitimate WRITE
  (`setup-vault --name`) is distinguished from a read rather than exempted by filename.
- **`scripts/setup-vault.mjs --link-workspace` wrote the unchecked value into a workspace
  `.env`** — the worst of the twelve silent sites, because the bad slug outlived the session that
  produced it and every later session read it back and resolved no vault at all.
- **`hooks/_helpers/doc-drift-detector.mjs` derived its fallback with the RUNTIME's
  `path.basename`**, so a Windows registry key read as one long filename when the runtime is
  POSIX — a CI matrix runner on Linux loading a Windows-paths config. It now uses the same
  structural detection as everything else.
- **`scripts/meta-audit-bridge-readiness.mjs` labelled a vault with the empty string.** It was the
  one reader of the twenty-two using `??` rather than `||`, so `""` reached the report as a name
  where every other site had already fallen back. The behaviour is now uniform.
- **A string on `Object.prototype` could name one of the user's vaults.** `vaultNames[vp]` walked
  the prototype chain; the lookup is now `Object.hasOwn`-guarded, the same guard and the same
  reason as `MODE_ALIASES` in `helpers/auto-enrich-mode.mjs`. Found by mutation testing, which is
  also how the first version of its test was caught claiming coverage it did not have: the
  obvious prototype members are all FUNCTIONS, so the `typeof` check alone already refused them
  and removing `Object.hasOwn` left the test green.

### Changed

- **`defaultNameFromPath` had SIX copies; there is now one.** In `src/registry.mjs`,
  `scripts/setup-vault.mjs`, `scripts/vault-plan.mjs`, `scripts/gen-remote-config.mjs`,
  `hooks/vault-link-linter.mjs` and `hooks/_helpers/workspace-vault.mjs`. Three carried a TODO
  asking for exactly this module, and the three TODOs disagreed about how many copies existed —
  they said 3, 3 and 4 — which is the usual sign that a count has stopped being checked. A second
  scan assertion now pins the definition count at one, so the disagreement cannot come back.
  The stated reason for duplicating (`setup-vault.mjs` is "a standalone script with no `src/`
  imports") had expired: that file imports eight `src/helpers/` modules today. Behaviour is
  preserved — the six were identical on strings, and the shared one keeps the non-string
  tolerance that two of them already had, so the collapse removed a crash rather than adding one.
- **The four hand-written copies of the slug → path loop collapse into `resolveVaultBySlug`.**
  They differed only in which guards each had bothered to write; the shared one has the union.
  `resolveSlugToVaultPath` and `knownSlugs` stay exported from `scripts/setup-vault.mjs` as thin
  wrappers, because those names are part of that module's surface.
- The helper reaches only `node:path` and `helpers/vault-path-identity.mjs`, which reaches only
  `node:path`. It sits on the start-up path of the binary AND of every hook, and hooks are
  expected to run on a checkout with no `node_modules` — the same contract as
  `helpers/auto-enrich-mode.mjs`, and now pinned by a test that walks the import graph.

### Fixed — the sibling keys

`vaultNames` was the first key of this class to be swept, not the only one. Five more
hand-editable `config.json` values were read under the same assumption, by the same readers.
**Thirty-four read sites across ten files were audited; seven were live defects.** The other
twenty-seven were verified safe rather than assumed so — with a probe, because "it's a path,
it'll be fine" is exactly what this class is made of.

- **`defaultVault` — one live defect of eight readers.** `hooks/_helpers/doc-drift-detector.mjs`
  did `(cfg.defaultVault || '').toLowerCase()`, and a non-string is TRUTHY, so `||` never caught
  it and the `TypeError` came out of a function that `doc-propagation-checker` and
  `vault-doc-startup-check` both call — hooks that must exit 0 whatever the config says.
  The other seven were safe for a structural reason worth writing down: six of them read
  `registry.defaultVault`, which is the RESOLVED name. `resolveDefaultVaultWithSource` only
  honors a configured default that passed `isActive`, so the registry is already a boundary for
  that key and nothing downstream of it was ever exposed. The readers at risk were exactly the
  two that never go through the registry, because they parse `config.json` themselves.
- **`disabledVaults` — three live defects of six readers, and the only SILENT one in the lot.**
  The container is the dangerous part here, not the elements. The likeliest hand-edit is writing
  the single vault you meant as a bare string — `"disabledVaults": "template"` instead of
  `["template"]` — and a string is iterable, so `new Set("template")` is not an error. It is
  `{t, e, m, p, l, a}`, a set of CHARACTERS, and a fleet with a one-character vault slug had that
  vault silently disabled by a line naming a different one. Measured, then pinned end-to-end
  through `loadRegistry`. `scripts/bridge-fleet-update.mjs` and
  `scripts/meta-audit-bridge-readiness.mjs` both built that set directly; the drift detector
  called `.map` on the value, which throws instead. The three that already wrote `Array.isArray`
  by hand were correct — and now share the one guard rather than half the readers having it.
- **Non-string ELEMENTS of `disabledVaults` are dropped rather than coerced.** The drift
  detector's `String(s).toLowerCase()` turned a numeric entry `123` into the name `"123"`, and a
  vault whose folder is called `123` has exactly that slug — so a typo could disable a real
  vault. Behaviour change, in the safe direction, consistent with the module's refusal to coerce.
- **`referenceVault` — three live defects of twelve readers.** `path.join`, `path.resolve` and
  `samePath` all throw a `TypeError` on a non-string; `fs.existsSync` returns `false`. Measured
  with a probe, and the split matters: the two readers guarded by `existsSync` always failed
  closed with their own clear message and were never at risk, while `buildOnDiskPortMap` pushed
  the value straight into `path.join` during ordinary port-collision reporting.
- **`vaultsRoot`, `portStart`, `remoteVaults` — no live defects, and now on the record.**
  `vaultsRoot`'s one reader already sat inside a `try`/`catch`; `portStart` is guarded by
  `isPort` at its only real reader; `remoteVaults` by `Array.isArray`. The first two are routed
  through the accessors anyway — a `catch` around `path.resolve` cannot tell "not configured"
  from "configured wrong", and `knownVaultRoots` gates `provision_vault`'s allowed write roots,
  which is the last place to be relaxed about which of the two it is looking at.

### Changed — the boundary module's remit

- **`src/helpers/vault-slug.mjs` now owns every hand-editable config value that names or locates
  a vault**, and its header says so. The name is from the first question it answered; two of its
  functions (`vaultNamesOf`, `registeredVaultPaths`) were already config accessors rather than
  slug derivations, so the remit had been wider than the filename since it was written. Putting
  the sibling keys in a second module would have recreated, one commit later, the exact split
  whose repair this file is.
- The scan grew a second assertion covering the four sibling keys. Its discriminator is the
  RECEIVER — `cfg.` / `config.` / `conf.` is the config's raw word and must be guarded, while
  `registry.` / `this.` is the resolved value and is a boundary in its own right.

### Verification of the `vaultNames` sweep

The numbers for the release as a whole are in the first Verification section above; what belongs
here is what the sweep's own mutations found.

- **Nineteen mutations, each seen red**, each restored by copying a snapshot back and comparing
  `sha256` rather than by `git checkout`. One witness per rule, no shared marker: dropping the
  type check kills 70 tests across every surface; the `String()` coercion 12; the empty-string
  check 10; reverting a single consumer to its raw read 11 (10 behavioural plus the scan); a
  seventh copy of `defaultNameFromPath` 2; removing the `Array.isArray` container guard 12; the
  `defaultVault` type check 6; the `referenceVault` one 6; the element filter 1; and the path
  guard, the map shape check, the registry shape check, the trim, the blank-slug guard and the
  prototype guard exactly 1 each. Reverting a CLI that has no behavioural test kills **1 — the
  scan alone**, which is the whole reason the scan exists.
- **Four mutations SURVIVED at first, and each cost the test that was supposed to catch it.**
  Removing `Object.hasOwn` left 143/143 green, because the prototype members a test reaches for
  first are functions that `typeof` already refuses; the witness is now a polluted prototype
  carrying a *string*. Removing the blank-slug guard was likewise invisible until a fixture with
  a registry key that actually derives an empty slug was added. And a raw read split across
  lines, with the property access alone on an unpunctuated continuation line, walked straight
  through the scan's prose heuristic — "a line carrying a real property access also carries code
  punctuation; a sentence carries none" — at 211/211 green. The heuristic is gone; the one prose
  line is exempted by its exact content.

## [0.89.0] — 2026-09-03 — `FullAuto` never comes from a project's file

v0.88.0 gave the router a voice: it can say which of the three session settings a workspace
`.env` chose. It still obeyed all three. For two of them — the default vault and the lock —
saying so is arguably enough for now, and the accepted decision
`liaison-workspace-vault-hors-depot` moves that binding out of the repository in a later lot.
For the third, the auto-enrichment mode, one value was never worth arguing about.

**The problem.** `FullAuto` is the mode in which Claude saves into a vault without asking
again. A workspace is very often a cloned repository, and a cloned repository carries whatever
`.env` its author put in it. So a line somebody else wrote could put a user's session into the
one mode that writes to their notes unprompted — and until v0.88.0 it did so in silence. The
other three modes are ordinary per-project preferences and nobody has ever been harmed by one;
this is about the single value that converts a file into standing permission.

Roland accepted the decision's option 4 on 2026-09-03, as a second acceptance beside the one of
2026-09-02, which had deliberately left this point open. This release implements it.

### Changed

- **A value of `OBSIDIAN_ROUTER_AUTO_ENRICH` read from a workspace `.env` that canonicalises to
  `FullAuto` is no longer applied** — `FullAuto`, `fullauto`, `FULLAUTO`, `full`, `full-auto`,
  `auto`, any casing, and any alias the shared table may gain later. The rule is on the VALUE,
  not the key: `OBSIDIAN_ROUTER_AUTO_ENRICH` stays an accepted workspace key and `ClaudeAsk`,
  `Hybrid` and `off` still work from a file exactly as before. It lives in
  `src/helpers/workspace-dotenv.mjs`, the one module that decides what a workspace file may
  set, so the binary and every hook that reads that file — ten of ten, through two loader
  sites — inherit it without knowing about it.
  `FullAuto` still comes from the MCP host's server declaration and from a
  `set_auto_enrich_mode` call during the session.
- **`set_auto_enrich_mode` with `persist: true` refuses to write `FullAuto`** — and returns
  normally rather than throwing, because the mode IS applied to the session and only the file
  write did not happen. The result carries `persistRefused: { mode, variable, reason }`, whose
  reason names both places the mode does survive a restart. `ClaudeAsk`, `Hybrid` and `off`
  persist unchanged. (The pre-existing homedir refusal still throws; it means something else —
  "you are almost certainly in the wrong directory" — and its shape is untouched.)
- **The parent still wins.** A `FullAuto` already in the environment when the router starts is
  the host's, reads as `origin: "host"`, and works. The value rule is evaluated *before* the
  parent-wins rule — which changes nothing about what applies, only about what is SAID: a
  refused line is never applied either way, and running the check first is what lets a dead
  `FullAuto` line be named even when the host set some other mode. It is suppressed in exactly
  one case: the parent chose the *same* refused value, where reporting it would be a false alarm
  about a mode legitimately in force.

### Added

- **`list_vaults` returns `autoEnrichModeRefused`** — `null` in the normal case, otherwise
  `{ value, canonical, origin, variable, reason }` describing what the workspace file asked for
  and did not get. A **separate field, never a tenth `origin`**: `autoEnrichModeSource` keeps
  reporting what actually took effect, because a refused value is not the source of the default
  that replaced it. Validated at the boundary like the three source fields — a half-formed
  refusal becomes `null` rather than reaching Claude as if it were established.
- **`src/helpers/auto-enrich-mode.mjs`** — `VALID_MODES`, the alias table and
  `canonicalizeMode`, moved out of `src/tools/auto-enrich.mjs` (which re-exports them, so no
  import site changed) into a module that imports nothing. `workspace-dotenv.mjs` runs before
  the dependency self-heal and could not reach the old home; a copy of the alias table would
  have drifted the first time a synonym was added to one and not the other, and a rule that
  refused `FullAuto` while letting `auto` through would read as closed and be open.
- **The refusal is visible on both channels.** The operator gets it on the router's stderr,
  through the same single `.env` warning that already names ignored and withheld keys — so the
  hooks stay silent, since a hook's stderr is the message Claude reads when it blocks — plus a
  sentence on the `Ready` line. The warning also carries the migration hint for a line an
  earlier `auto-mode --persist` wrote: remove it, or set the variable host-side. Nothing about
  an existing setup changes without being named. **One report per key per load**, whatever the
  file repeats: a `.env` naming the same refused assignment a thousand times is 37 KB, and the
  first version turned it into a single ~460 KB stderr line at start-up — a cloned repository
  slowing the MCP handshake through a message about itself.

### Fixed

All seven came out of the review of this very lot, over five rounds — the fifth with a different model, which found what four rounds of the same two readers had stopped seeing. Two of them are older than
the lot — the raw start-up warnings date from v0.8.2, the missing identity checks from
v0.88.0 — and are named here because this lot is what surfaced them. The other five are defects
this lot introduced and its own review caught, and two of those five were introduced by an
earlier round's REPAIR rather than by the original work. That pattern is the lot's real lesson:
a class fix that reaches only its first site reads as closed, and the next round finds the
sisters — three times here, on the same class, in three different guises.

- **Three start-up warnings printed an untrusted workspace value raw — 3 of 3 now sanitised.**
  `validateAutoEnrichMode`, `validateLock` and the registry's default-vault warning are built
  from three keys the same workspace `.env` writes, and all three interpolated the value into
  stderr as it came. Reproduced end to end: a value carrying an ANSI clear-screen wipes the
  terminal and draws a convincing fake `Ready.` line under it — and, worse for this release, it
  **erases the refusal the loader printed a moment earlier**, which is the operator's half of the
  whole rule. Predates this lot (v0.8.2). Worth recording how it was found: the first repair
  fixed only `validateAutoEnrichMode`, the one the new code sat next to, and the second review
  round showed that a fix reaching one of three sites was worse than none here, because it read
  as closed. The test now sweeps the class rather than asserting a site.
- **The four accessors of the provenance register that answer ABOUT A KEY now all check which
  environment their record was made against — 4 of 5 accessors, and the fifth is not one.**
  `envKeySourceFile` and `appliedWorkspaceDotenvKeys` answered from the register with no `env`
  at all, the third home of the defect v0.88.1 had to repair on `envKeyOrigin`. No production
  caller today, so it was latent rather than exploitable — but an exported accessor is a caller
  waiting to happen. The fifth, `workspaceDotenvWasConsulted`, stays process-wide **on purpose**,
  and its known cost is now written down and pinned by a test rather than left as folklore:
  `envKeyOrigin` uses that flag as its precondition while checking record identity per object, so
  after a load against one environment object it answers `host` — a positive claim — for a key
  absent from the register, asked about a different object. Not reachable in production (every
  entry point records into `process.env` and asks about `process.env`), and the fix is a
  per-object consultation set, which changes `envKeyOrigin`'s documented v0.88.0 precondition —
  a contract change that belongs to the provenance lot, not to this one.
- **`persist: false` with `FullAuto` advised "use `persist: true`"** — advice that now leads
  straight to a refusal. It points at the host environment instead. The other three modes keep
  the ordinary wording.
- **The `set_auto_enrich_mode` description, its `persist` argument and the `--help` text still
  promised that every mode is written to `<cwd>/.env`.** Both reviewers reached this
  independently: that description is what Claude reads *before* calling, so a caller would have
  met `persisted: false` with no warning and read a normal refusal as an anomaly to retry. All
  three surfaces updated, and the description now carries a guard of its own — the twin of the
  one `list_vaults` has had since v0.88.0, added because the surface it guards is the one that
  got forgotten.
- **`templates/wiki/CLAUDE.md` said the opposite of the new rule**, and that file is copied into
  the user's vault and re-read every session — the documentation surface with the longest reach
  and the only one no update reaches retroactively.
- **The French half of the README kept the old contract for one review round.** The repair that
  updated the two English spots left their French twins saying `--persist` writes every mode: a
  reader of one language would have been told the opposite of what the code does. Same class as
  the first bullet, one round later and introduced by a repair rather than inherited — which is
  why a guard now checks both language halves of the command table and both "four modes"
  callouts in one assertion.
- **A refusal went unreported whenever the parent held any value for the key.** Safe (the mode
  never applied), but it silenced exactly the case the migration hint exists for: host set to
  `Hybrid`, project file still carrying a `FullAuto` line written by an older `--persist`, and
  not one word about the dead line. The refusal is now evaluated before the parent-wins rule and
  suppressed only when the parent chose the *same* refused value — where reporting it would be a
  false alarm about a mode legitimately in force.

### Verification

- Full suite **4 561 tests, 4 560 green, 0 failed, 1 opt-in skip** (4 530 before this lot;
  31 tests added). `npm run validate` and `npm run gate` green on the same tree.
- **Twenty-six mutations, each seen red and each restored by copying a snapshot back and comparing
  the sha256** — no `git checkout`, because another session works on this repository. Nine for
  the rule as first written: comparing the raw value instead of canonicalising (5 tests red),
  moving the value rule ahead of the parent-wins rule (5), recording a refused value as applied
  (1), dropping the refusal from the warning (3), dropping the migration hint (2), making
  `list_vaults` swallow every refusal (1), removing the persist refusal (2), making the refusal
  lookup always answer null (2), deleting the start-up wiring (1). Seven for the first round of
  repairs: widening the parent exemption to any value, removing the per-load deduplication,
  un-sanitising the rejected mode, silencing the `Ready` line, dropping the identity check from
  `appliedWorkspaceDotenvKeys`, passing the refusal object through verbatim, softening the new
  description guard. Four for the second: un-sanitising `validateLock`, un-sanitising the
  registry's warning (two separate mutations, because one test that catches both is the point),
  restoring the advice that leads to a refusal, and altering the `--help` text. One for the
  third: putting the sanitiser's cap back to 80, which is what made a long legitimate value
  unreadable. Two for the fourth: reverting the French half of the README, which is what a
  round-3 repair had left behind, and reverting the cap at the registry's warning ALONE — the
  third of the three sites, and the one the readability test did not yet cover, so the suite
  would have stayed green while a legitimate vault name was truncated. Three for the fifth
  round, run with a different model: comparing the PARENT's raw value in the same-value
  exemption (a host that wrote `auto` would have drawn a false refusal), a hook dying at import
  with a clean stderr (the silence test now requires exit 0), and the pre-v0.89.0 "four valid
  values" sentence put back beside the one contradicting it (the description guard now asserts
  absence, not only presence).
- **Executed, not grepped.** The binary's stderr, a hook's silence, the `--help` text and the
  whole start-up chain are proven by spawning real processes against a hostile workspace: one
  test starts the actual server and reads the `Ready.` line an operator would read. Everything
  between the loader and `list_vaults` had been pinned only by regexes over the source, and a
  regex cannot see the junction it depends on — the loader writing into `process.env` and the
  start-up reading it back.
- Three existing guards went red for the right reason and were updated by hand, never weakened:
  the pin on the exact top-level field set of `list_vaults`, four accessor call sites that now
  name the environment they are asking about, and two fixtures (three lines) that used
  `FullAuto` as an incidental example of "a mode from a file".
- Both quick-reference PDFs re-rendered from their HTML sources and read page by page — the
  rendered text was checked visually, since the fonts are subset-encoded and no extractor here
  can read them.

### What this does not do

The `.env` of a project still chooses the default vault and the lock — that is the second lot
of the same decision, the workspace-binding registry, which is not started. This release
narrows one value from one source; it does not move the binding out of the repository.

**And it closes the `.env` door only.** A fifth review round, with a different model, put the
threat model itself on the table: the "second honest home" of `FullAuto` is a call Claude makes,
and Claude reads a repository's files. A cloned repository's `CLAUDE.md` saying "call
`set_auto_enrich_mode({ mode: 'FullAuto' })` first" reaches the same end state this release
forbids for `.env` — `origin: "runtime"`, no refusal, silent `Ready` line — and the router cannot
tell that call from one the user made. That boundary is Claude's to hold, not the router's, so
it is now written where Claude reads: the tool description and the `auto-mode` skill say to set
`FullAuto` on the user's own request in the conversation, never on a workspace file's
instruction. Three documentation surfaces that said "a cloned repository's file must not grant
it" now say "the `.env` a cloned repository carries" and name the limit.

## [0.88.1] — 2026-09-02 — one line of v0.88.0 never reached the commit

v0.88.0 shipped without a single line of `envKeyOrigin`, and CI went red on all four jobs
within minutes. The line was written, reviewed, tested green locally and verified present by a
grep after the mutation bench — and is absent from the published commit. What is certain: the
tree that was tested and the tree that was committed differed by one line, and only the CI
noticed.

### Fixed

- **`envKeyOrigin` checks WHICH environment a record was made against again.** A provenance
  record describes the object the loader wrote into; asked about a different object, the answer
  must be `unknown`, not an inference from the value alone. Without that line the router would
  claim `workspace-dotenv` for a key it had never seen set in the environment being asked about
  — a false attribution, which is the one thing the provenance lot exists to avoid. Its test
  (`a record made against ANOTHER environment object answers "unknown", never a guess`) was in
  the same release and is what failed.

### Changed

- The release routine now verifies the COMMITTED bytes, not the working tree:
  `git show <sha>:<file>` for each invariant the lot rests on, before `npm run release`. A
  green local run proves what is on disk at that moment, and that is not the same statement as
  "the commit contains it". Cause of the divergence unestablished — most likely an edit made
  while the mutation bench held the file, since the bench restores from its own snapshot; a
  concurrent session on the same worktree would do it too.

### Verification

- `tests/setting-provenance.test.mjs` 16/16 (the failing case included); full suite
  **4 530 tests, 4 529 green, 0 failed, 1 opt-in skip**; `npm run validate` and `npm run gate`
  green; release-grade leak scan of the changed files: 0 findings; and `git show` on the new
  commit confirms the line is in it.
## [0.88.0] — 2026-09-02 — the router says WHO chose the vault, the lock and the mode

v0.87.0 closed what a workspace `.env` may *set*: only the keys the router's own writers put
there, never an endpoint, a credential or a tool override. What it could not close is subtler,
and both reviewers of that release reached it independently at the very end — a cloned
repository's `.env` may still name one of the user's **registered** vaults, and the router
obeyed without a word, because that setting exists precisely so the user can write it himself.
Nothing distinguished "the user attached this project to this vault" from "this binding arrived
with a `git clone`". The accepted decision `liaison-workspace-vault-hors-depot` moves that
binding out of the repository; this release ships the first of its two lots, the one that can
stand alone: **the router can now say where each session setting came from.**

### Added

- **`list_vaults` returns `defaultVaultSource`, `lockSource` and `autoEnrichModeSource`**, each
  `{ origin, variable }`. `origin` is `workspace-dotenv` when this project's own file chose it,
  `host` when the value was already in the environment (the MCP host's server declaration, a
  launcher, a shell), `runtime` when `lock_vault` / `set_auto_enrich_mode` set it in this
  session, `config` when it comes from the router's own `config.json`, `first-healthy` /
  `first-active` when nobody chose and the cascade fell back to a vault, `default` when nothing
  set it, `unset` when there is no value, and `unknown` for a registry built by a path that
  does not record it — a guess is never dressed up as a fact. `variable` names the environment
  variable that carried the value, or is null. The tool's description explains every one of
  those values, and a test fails if the code can emit an origin the description does not name.
- **The boot line names them too.** When a workspace file chose any of the three, the `Ready.`
  line ends with `Chosen by this workspace's .env rather than by the host: …`. The MCP log is
  not where consent belongs — that is why `list_vaults` carries it — but a log that says it is
  better than one that does not.

### Changed

- `src/helpers/workspace-dotenv.mjs` keeps a per-process record of what it applied, so
  `envKeyOrigin(name)` can answer for any variable. It is filled by the loader itself, not by
  its callers, so every entry point that reads a workspace file records it and none can forget.
  A key the **parent** already carried is the host's — the parent always wins, and the
  provenance agrees with that rather than blaming the file for the host's choice; a sandbox key
  that was *withheld* is not recorded, because it never took effect.
- The default-vault cascade gained a sibling that says which of its five tiers answered
  (`resolveDefaultVaultWithSource`). `resolveDefaultVault` keeps its name-only signature — a
  dozen cascade tests call it directly, and the cascade itself is unchanged. A tier that read an
  environment variable reports **that** variable, and an override that was rejected (a typo, a
  vault since removed) is never reported as the source of what replaced it.

### Verification

- `tests/setting-provenance.test.mjs` (16 tests): every origin, every tier, the
  never-consulted precondition, the parent-wins case, the withheld-sandbox case, the
  rejected-value case, a record made against another environment object, a malformed source at
  the boundary, tier 5's verbatim name, and `list_vaults`'s pass-through and fallbacks — plus
  three structural guards: no setting is assigned on the registry without its source beside it
  (start-up **and** config hot-reload, with the literals checked and a commented-out copy
  unable to satisfy them), the runtime tools mark their own changes, and the documented
  vocabulary equals what the producers emit.
- Mutation run, 23 mutations, **23 red**. Sixteen of them come from the two reviewers rather
  than from the author: the loader recording a parent-set key, `envKeyOrigin` ignoring a later
  change or the environment a record was made against, a withheld key recorded as applied, the
  wrong variable reported by a tier, a rejected override credited for its successor, a tier
  renamed, `list_vaults` guessing where it does not know or trusting whatever the registry
  carries, a recorded source dropped, the start-up or reload wiring deleted or ungated, a
  rejected mode credited to its variable, an unlock that keeps its source, a runtime change
  called `host`, tier 5 collapsing a falsy name, the never-consulted precondition removed, and
  three ways of letting the documentation drift from the code. Every file restored by bytes and
  hash-checked.
- Two guards already in the tree fired on the first full run, both correctly. The pin on
  `list_vaults`'s top-level field SET refused three fields it had not been told about — that is
  what it is for, and the contract was updated by hand. The dotenv-writer guard flagged
  `src/index.mjs`, which writes no dotenv file: it asks the coarsest question it can ("does this
  file write a file at all, and does it name a dotenv file?"), a new comment named one in a
  quoted form, and the file counts as a writer through unrelated prose. The comment was
  reworded rather than the guard weakened, and it now says why.
- Full suite **4 530 tests, 4 529 green, 0 failed, 1 opt-in skip**; `npm run validate` and
  `npm run gate` green; release-grade leak scan of the 15 changed files: 0 findings.

### Review

Two independent reviewers, each handed the numbered invariants rather than only the diff.

- **Round 1 (Code Reviewer)** — three blockers, all real. `unknown` was emitted by the code and
  explained in neither the tool description nor the README, and the vocabulary guard could not
  see it (it scanned for `origin: '<literal>'`, and that one was built from an argument) —
  worse, the guard asserted "at least 8" against exactly 8, so it had no margin at all. On a
  config hot-reload, a preserved mode that failed revalidation kept the source of the mode it
  replaced — the exact mirror of the case start-up already handled. And two reload fallbacks
  invented `host` and `default` where nothing was recorded.
- **Round 2 (Codex)** — five more that survived round 1. Absence of a record only means "the
  file did not set it" once a file has been LOOKED FOR: an entry point that never loads one now
  answers `unknown` instead of assuming the host. The refactored cascade was not exactly
  equivalent for a falsy-but-present vault name. `list_vaults` trusted whatever source object
  the registry carried, so a malformed one could leave through a documented field. An explicit
  `ClaudeAsk` with no recorded source was called `default`, when it is also a value a host, a
  file or a tool call can set. And a sentence of mine claimed a workspace file "could only ever
  name a vault", which understates the allow-list — the mode, `VAULT_PATH`, a sandbox narrowing
  and the opt-outs are on it too.
- Found on the way, outside this lot and left as it is: `scripts/serve-http.mjs` starts a served
  instance in this repository's own root, whose dotenv file the child **does** load, while its
  comment promises a neutral directory. The new fields report that truthfully
  (`workspace-dotenv`); the comment now says what actually happens, and a genuinely empty
  directory belongs to the binding-registry lot, being a behaviour change for served
  deployments.
- Recorded for the second lot: distinguishing "named by the file **and confirmed** in the
  registry" from "named and not confirmed" should be a separate field, not a tenth origin.

### Compatibility

- Additive: three new fields on one tool's response, and one clause on the boot line. No
  existing field changed shape, and nothing changed about what a workspace `.env` is *allowed*
  to do — that was v0.87.0's subject, and it stands as it was. What a repository's file can
  still choose is unchanged too; it can now be **named**, which is what the second lot
  (the binding registry outside the repository) will act on.

## [0.87.1] — 2026-09-02 — the environment proof runs on the GitHub runners too

v0.87.0's CI was red on all four legs (node 20.19 / 22 × ubuntu / windows) while the
full suite was green on the developer's Windows machine. Three causes, none in what a
child process receives — two in the test harness, one in the resolver of a configured
executable path.

### Fixed

- **A UNC or a drive path configured on a POSIX host is left alone.**
  `absolutizeExecutableOverride` (`MARKITDOWN_PATH` & co.) and the path-valued variables
  of the allowlist decided "relative" with the HOST's `path.isAbsolute`, so on Linux a
  `\\server\share\markitdown.exe` or a `C:\tools\x` counted as relative, was resolved
  against the cwd — mangled — and, for the UNC form, escaped the readiness probe's
  "never stat a UNC path" rule (the stat that can hang a session start). A path that is
  absolute on EITHER platform is now returned byte-for-byte, everywhere.
- **The Windows leg of `tests/subprocess-env.test.mjs` compared an 8.3 short path with a
  long one.** The GitHub Windows runner's temp root is an 8.3 short path (a `RUNNERADMIN~1`
  segment under its profile); the instrument reports its cwd in the long form, and every
  pin — the CONTROL included —
  failed on that comparison. Paths are canonicalised (`fs.realpathSync.native` on their
  deepest existing ancestor, so a private cwd already removed still compares) before any
  comparison.
- **The POSIX fake was loaded as an ES module.** It is a CommonJS script (`require`,
  `__dirname`); the relative-override pin puts it under the repository, whose
  `package.json` says `"type": "module"`, and Node 20.19/22 loads an extensionless file
  in that scope as ESM — `require is not defined`. A `package.json` pinning `commonjs`
  now sits beside every POSIX fake (harmless under the system temp root, where the other
  pins put theirs and passed). Reproduced and fixed locally on an extensionless script
  under the repository before pushing.

### Verification

- `tests/subprocess-env.test.mjs` + `tests/conversion-readiness.test.mjs` +
  `tests/workspace-dotenv.test.mjs` 116/116 on Windows; the Linux leg is proven by this
  commit's CI run (the local WSL carries Node 18, below the engines floor).

## [0.87.0] — 2026-09-02 — every child process gets a named environment, and stops eating the accents

Nothing the router spawned was ever told what it may see. Not one `execFile` / `spawn` in
the tree passed an `env` option, so markitdown, Docling, repomix, yt-dlp, git, npm and a
`python --version` probe each inherited the router's entire `process.env` — which
`bin/obsidian-mcp-router.mjs` had just filled from the workspace `.env`, and which the MCP
host had filled from the server declaration. Confirmed 2026-09-02 by an adversarial Codex
review of the DonSeTch study (lot W-0, point P3). Sweeping it turned up a second, older
defect in the same pipe: on Windows, every accented character a Python child wrote came
back as `�`.

### Security

- **`src/helpers/subprocess-env.mjs` — the one place a child's environment is built, from a
  per-tool allowlist of NAMES.** `subprocessOptions('markitdown', { cwd, maxBuffer })`
  returns the options object with `env` built from named variables: a platform base
  (`PATH`, the temp and profile roots, the locale family written out, `SystemRoot` /
  `ComSpec` / `PATHEXT` on Windows, `HOME` and the XDG roots on POSIX) plus what the tool
  actually reads — proxies and CA bundles for the networked ones (git included: it fetches
  in `plugin-auto-update`), `HF_HOME` / `TORCH_HOME` / `DOCLING_ARTIFACTS_PATH` for Docling,
  the commit identity, `GIT_CONFIG_GLOBAL` and the SSH/GPG agent sockets for git and
  repomix, `npm_config_cache` and the chatter knobs for npm, the two Electron switches for
  a Node child started under a Claude Desktop host (`ELECTRON_RUN_AS_NODE` — without it
  `process.execPath` launches the application, not the script; it used to arrive by
  inheritance), the graphical session's display and bus variables for the `--open` hand-off
  of the provisioning engine, and the three `OBSIDIAN_ROUTER_*` variables that engine
  reads, each by name. **There is no prefix rule at all** — not `OBSIDIAN_ROUTER_*`
  (shared by the secrets and the configuration), and not `GIT_*` / `SSH_*` / `npm_config_*`
  either: those would have carried `GIT_SSH_COMMAND` (a command), `GIT_CONFIG_VALUE_n`
  (arbitrary config), `GIT_DIR` (another repository), `npm_config__authToken` (a secret)
  and `npm_config_registry` (a supply-chain redirect) — all settable from a workspace
  `.env`, which the router loads at startup. A second fence, the **NEVER list**, refuses
  those shapes from every origin whatever a table says (`NODE_OPTIONS`, `LD_PRELOAD`,
  `PYTHONPATH`, `GIT_SSH_COMMAND`, `GIT_DIR`, `npm_config_registry`, anything matching
  `TOKEN` / `SECRET` / `PASSWORD` / `API_KEY` / `PRIVATE_KEY` / `ASKPASS` / `_COMMAND`…), and
  the module throws at load if an allowlist ever names one. The helper REFUSES an `env`
  option, so a site cannot hand the environment over whole; additions go through
  `extraEnv`, and an `extraEnv` key is accepted ONLY if the tool's allowlist already names
  it — the side door is as narrow as the front one. Fixed values are applied last. An
  unknown tool name throws. Not passed, on purpose: `HF_TOKEN`, `NPM_TOKEN`, `PYTHONPATH` /
  `PYTHONHOME` / `PYTHONSTARTUP`, `NODE_OPTIONS` and `NODE_TLS_REJECT_UNAUTHORIZED`, and
  everything that merely happens to be in the parent — the smart-link secret, the
  view-agent token, any `*_API_KEY` from the workspace `.env`.
- **The sweep: 37 `child_process` spawn sites across `src/`, `scripts/`, `hooks/` and
  `bin/` — 22 now go through the allowlist, 15 inherit by name — plus 1 process started
  through the MCP SDK, counted apart.** Guarded (22): the five markdownify sites the review
  named (markitdown, repomix, Docling, the `pdf_to_images` render script, yt-dlp), the
  `python --version` probe, npm and `taskkill` in `ensure-deps`, git and npm in
  `plugin-auto-update`, the PowerShell / `ps` process scan in `plugin-cache-purge`, the
  provisioning engine as spawned by the MCP server, by `--attach` and by the SessionStart
  sync hook, the six git calls inside `scripts/setup-vault.mjs`, and git in
  `hooks/wiki-autocommit.mjs`. Inheriting, each with a written reason (15): release tooling
  run from the developer's own shell (`build-mcpb`, `bump-version`, `create-release`,
  `export-gate` — git, `gh` and `npm ci` need that shell's credential helpers and proxies,
  and the parent holds no router secret), the two interactive installers (pip's mirrors,
  proxies and CA bundles are open-ended, and the parent IS the user's shell), and the three
  desktop-app launchers (`cmd /c start`, `open`, `xdg-open` — the application must see the
  user's session; when the engine runs under the MCP server they receive its `setup-vault`
  allowlist, which names that session's variables). The one SDK start is
  `scripts/serve-http.mjs`, which starts one ROUTER per HTTP session through
  `StdioClientTransport` with the parent's environment — the child IS the router and needs
  its own configuration and secrets; it is listed as such. The guard in
  `tests/subprocess-env.test.mjs` pins the exemptions by file, by exact count AND by the
  command each spawn runs, pins the three totals exactly (a finder that loses a site is as
  red as a site that loses its guard), judges the OPTIONS argument of a call rather than any
  mention of the helper in its argv, refuses an `env:` next to the helper, and reports a
  file that imports `child_process` in a form it cannot follow instead of skipping it.
- **A workspace `.env` may set only what the router documents for it — the other half of the
  fence.** The per-tool allowlist filters what a CHILD receives, by name; it cannot know where
  a value came from, and the router's own process was still taking ANY absent key from the
  `.env` of the current workspace — which is very often a cloned repository. Through that file
  a stranger could set `GIT_CONFIG_GLOBAL=./x.gitconfig` (git then reads a config that runs a
  command at the next commit the wiki-autocommit hook makes), `HOME` or `XDG_CONFIG_HOME`
  into the repository, `NODE_OPTIONS=--require=./x.js`, `MARKITDOWN_PATH=./tools/x` (run
  directly by the router), `HF_ENDPOINT` or a proxy plus a CA bundle. Found by the Code
  Reviewer in review pass 2 as the gap between what the README promised and what the fence
  held — and in pass 3 it caught the first draft of the fix accepting the whole
  `OBSIDIAN_ROUTER_*` family, which would have let that same file set
  `OBSIDIAN_ROUTER_CONFIG=./evil.json` (every tool call, session journal and auto-commit
  then working against the attacker's vault registry, remote vaults included) or
  `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (a fetch to his host on every write). Now
  `src/helpers/workspace-dotenv.mjs` is the one parser and the one policy the three loaders
  share (`bin/obsidian-mcp-router.mjs`, `hooks/_helpers/workspace-vault.mjs`,
  `hooks/vault-link-linter.mjs`), and the accepted keys are WRITTEN OUT: exactly what the
  router's own writers put in a workspace `.env` — `OBSIDIAN_ROUTER_DEFAULT_VAULT`
  (`--attach`, `--link-workspace`), `OBSIDIAN_ROUTER_LOCKED` (`lock_vault --persist`),
  `OBSIDIAN_ROUTER_AUTO_ENRICH` (`auto-mode --persist`), `VAULT_PATH` (setup-vault),
  `MD_ALLOWED_PATHS` / `MD_SHARE_DIR` — plus the fourteen `OBSIDIAN_ROUTER_NO_*` opt-outs,
  enumerated, each of which switches a convenience off and none a guard; a test pins that
  list against the names the tree actually reads, so a new opt-out is added by hand, never
  accepted by shape. Host-level settings (`OBSIDIAN_ROUTER_CONFIG`, `VIEW_AGENT_*`,
  `SMART_LINK_*`, `USER_ID`, `ALLOWED_VAULTS`, `READONLY`, …) are never taken from a
  workspace file. Every other key is ignored; the router binary names them once on its
  stderr — the MCP log — with where to set them instead, and the two hooks stay silent,
  because a hook's stderr is the block message Claude reads on exit 2 and a line about a
  `.env` in front of the real reason would be read as an instruction. `OBSIDIAN_API_KEY` and
  `OBSIDIAN_BASE_URL`, which setup-vault writes into a bootstrapped vault's `.env` for
  companion tools and the router never reads, are skipped without a word. The parent still
  wins, always. The binary also names, on one stderr line, what it DID take from the file:
  a cloned repository's `.env` can pick which of the user's REGISTERED vaults the session
  reads, locks and enriches (never an unregistered one — every value is checked against the
  registry), and the log should say that choice came from the file rather than from the
  host. A leading byte-order mark (a file re-saved by Notepad) was already dropped — `trim()`
  counts U+FEFF as whitespace — and a test now pins it. Two guards in
  `tests/workspace-dotenv.test.mjs`: the three loaders delegate (the hook ones silent, the
  binary NOT silent, and naming what it applied), and no file under `bin/`, `hooks/`, `src/`
  or `scripts/` writes a computed key into `process.env`, `Object.assign`s onto it, writes
  to it reflectively, aliases it under another name (`const env = process.env;` — the form
  the policy module itself uses, which is why that module is excepted by path, never by
  mention), or imports the `dotenv` package — so a cousin of the old any-key loop cannot
  come back. The opt-out pin counts the names the tree READS (`process.env.OBSIDIAN_ROUTER_NO_*`
  in code, not in comments or strings) and carries a second, host-only list, so a future
  opt-out that must not come from a workspace file is refused by name rather than accepted
  because acceptance was the only green exit. `tests/subprocess-env.test.mjs` adds the
  matching rule for spawns: no `...process.env` spread outside the exempted files.
  Two more fences, from the last two passes. **The conversion sandbox is one setting a
  workspace file may only NARROW**: `MD_ALLOWED_PATHS` and `MD_SHARE_DIR` are two spellings
  of one thing, and the file's value is taken only when the host set neither and the
  instance is not gated (`READONLY`, `ALLOWED_VAULTS`, `USER_ID` — the signals of
  `assertSandboxConsistent`, mirrored in the policy module). Otherwise it is *withheld* and
  named in the same single warning. Both reviewers found the hole from different sides: a
  host that sandboxed through the legacy alias saw a repository's `MD_ALLOWED_PATHS=/`
  (or `MD_ALLOWED_PATHS=`, which the runtime reader took as "set, empty, no sandbox")
  replace its sandbox; a gated instance with NO sandbox — which must refuse to start —
  started on the file's word instead. The runtime reader (`getAllowedPaths`) now treats an
  empty `MD_ALLOWED_PATHS` as unset, as the start-up check always did. **And the hooks
  honour the file's opt-outs**: five of them read their `OBSIDIAN_ROUTER_NO_*` before
  loading the workspace `.env` (or never loaded it), so a `NO_WIKI_AUTOCOMMIT=1` in a
  project's file was a dead letter for the very hook it names. Every hook now loads the
  file before its first opt-out read, and a structural pin holds the order. Two last pins
  keep the loader unique: any file naming the `dotenv` package in any form (import,
  require, dynamic import, `dotenv/config`) and any file naming a `.env` file outside the
  loader, the three writers and two bystanders, listed by path, fails the suite.
- **A relative executable override no longer breaks under the private working directory.**
  `MARKITDOWN_PATH`, `DOCLING_PATH`, `REPOMIX_PATH`, `YTDLP_PATH` and `PDF_IMAGES_PYTHON`
  used to be handed to the spawn verbatim; now that markitdown, repomix and the others run
  in a throwaway directory, a relative value (`./venv/bin/markitdown`) is resolved against
  the router's cwd BEFORE the spawn. A bare name and an absolute path are returned
  byte-for-byte — padding included — so the readiness probe still names the exact path the
  runtime will run.
- **A private, empty working directory for the tools that do not need the router's.**
  Measured: yt-dlp reads `yt-dlp.conf` from its current directory, and the router's cwd is
  the user's WORKSPACE — a repository carrying that file could have appended `--exec …` to
  every caption fetch. repomix reads `repomix.config.json` from cwd the same way. markitdown
  and repomix now run in a throwaway `mkdtemp` directory removed afterwards; Docling, the
  render script and yt-dlp run in the private output directory they already had. A relative
  `filepath` still means what it meant: it is resolved against the router's cwd before the
  child is spawned.

### Fixed

- **Accented characters in every Python-backed conversion on Windows.** Measured on the
  shipped tree, with the full inherited environment: `markitdown -- accents.html` returned
  `�l�ve � caf� na�ve ?? ok` for `Élève — café naïve 日本 ok`, and the quick-reference PDF
  came back with U+FFFD in it. A piped Python stdout uses the ANSI code page unless told
  otherwise, and the router decodes UTF-8. The allowlist sets `PYTHONIOENCODING=utf-8` for
  every Python child as a FIXED value — a source value does not override it, because the
  pipe's decoder is not negotiable. The same document now round-trips intact, and so does
  the PDF. (Docling and the render script write files with an explicit encoding and were
  never affected.)

### Verification — measured, then mutated

- The "needs" list was measured on the real toolchain under the allowlist, not written from
  memory: markitdown on an accented HTML file and on a 29 KB PDF; a full Docling conversion
  (38.5 s, layout and table models loaded from the HF cache, no replacement character); the
  render script producing a page; `yt-dlp --version` and `--list-extractors`; repomix
  `--version`; the PowerShell CIM scan (311 processes — the same count as with the full
  environment — so `PSModulePath` is not passed, and since it is where PowerShell auto-loads
  its modules from, it joined the NEVER list); and `python --version` under
  `PATH` + `SystemRoot` alone. Also measured: libuv resolves a bare command through the
  CHILD's `PATH`, which is why `PATH` is in every allowlist.
- `tests/subprocess-env.test.mjs` (34 tests) proves the property with a REAL executable,
  not a captured options object. On Windows it compiles `tests/fixtures/env-echo/EnvEcho.cs`
  with the `csc.exe` every .NET Framework install carries (≈300 ms); on POSIX it writes a
  shebang script. Copies of it stand in for markitdown, repomix, docling, python, yt-dlp,
  npm, git and the process scanner, and eleven pins drive the PRODUCTION entry points
  (`toMarkdown` — twice, once with a relative override —, `fromRepo`, `toMarkdownDocling`,
  `pdfToImages`, `fetchYoutubeTranscriptViaYtdlp`, `findPythonDetailed`, `runInstall`, the
  auto-update git runner, `findLiveSnapshotVersions`, `runSetupVault`) with sentinels set in
  the router — a plain one, one named like a real secret, and the dangerous names a prefix
  rule would have carried (`GIT_SSH_COMMAND`, `GIT_CONFIG_VALUE_0`, `npm_config__authToken`,
  `SSH_ASKPASS`, `NODE_OPTIONS`) — then read the dump the child wrote. The remaining eleven
  guarded sites (`--attach`, the sync hook, the wiki-autocommit git, the six git calls of
  the engine, `taskkill`, the auto-update npm runner) are covered by the structural guard,
  not by an executable pin. A CONTROL test spawns the same fake WITHOUT the helper and
  requires every sentinel to arrive, so a green pin cannot be the instrument failing to
  look. When `csc.exe` is absent the pins skip on a developer machine, and say why — and
  FAIL under CI, because the Windows leg is where the defect lived.
- Mutation, before shipping (re-run after the review corrections): the allowlist replaced by
  the whole source environment → 18/29 red (all 11 pins and 7 unit tests; the control
  stayed green, as it must); one guarded site stripped of `subprocessOptions` → the guard
  red, naming `hooks/wiki-autocommit.mjs … spawnSync@89`. Both restored by copy and
  confirmed by hash. The pass-4 guards had their own run: 7 mutations (an alias of
  `process.env`, a destructured one, a reflective write, a silent binary, the "applied" line
  renamed, an opt-out read in a form the pin cannot see, the byte-order mark through a
  space-only trim), 7 red, every file restored by bytes. The pass-3/pass-5 guards had theirs:
  12 mutations (the sandbox pair rule removed, the gated signals ignored, a computed-key
  write through an `env` default parameter in a hook, `dotenv/config` imported, a second
  `.env` reader, a hook never loading the file, a hook loading it after its opt-out,
  `PSModulePath` back in an allowlist, `PYTHONWARNINGS` back in the Python group,
  `SSL_CERT_DIR` resolved as one path, the guard back to the last argument, the guard
  accepting an object literal as argv), 12 red — the last two only after the witnesses
  without `env` exposed the argument-count flaw above. Final tree: the two new test files
  47/47, the full suite **4 514 tests, 4 513 green, 0 failed, 1 opt-in skip**;
  `npm run validate` and `npm run gate` green; release-grade leak scan of the 42 changed
  files: 0 findings.
- Path-valued variables keep their meaning under the private working directory: a relative
  `DOCLING_ARTIFACTS_PATH=./artifacts`, `SSL_CERT_FILE=ca.pem`, `NODE_EXTRA_CA_CERTS`,
  `GIT_CONFIG_GLOBAL`, `HF_HOME`, `npm_config_cache` (each group names its path-valued
  members) is made absolute against the router's cwd before the spawn, exactly like a
  relative executable override; absolute and empty values pass byte-for-byte. The readiness
  probe resolves `MARKITDOWN_PATH` through the same function as the runtime, so a relative
  override is reported at the path that will actually run.
- Measured on Windows, exercised on POSIX: the "needs" list above was measured on this
  machine's real toolchain; the CI ubuntu leg runs the same pins through the fake
  instrument, which proves the FILTERING on POSIX but not that markitdown, Docling or yt-dlp
  find every variable they want there. The POSIX names come from the tools' documentation.
  A regression of that kind would show as an ENOENT-shaped error naming the tool, not as a
  silent wrong answer.
- `blankStringsAndComments` moved out of `tests/security-invariants.test.mjs` into
  `tests/_source-scan.mjs` so the new guard could share it instead of copying it.

### Changed

- `runSetupVault` takes a `scriptPath` seam (default: the real engine) so the pin above can
  spawn a printing stand-in through the production function.
- `README.md` says what a spawned tool can and cannot see, under the conversion-tools
  environment table.

### Compatibility

- A tool that needs a variable outside its allowlist no longer gets it — that is the point,
  not a side effect. Three cases are known and deliberate: a gated Hugging Face model for
  Docling (`HF_TOKEN`), a private npm registry (`NPM_TOKEN`, `npm_config_registry`), and an
  operator's `NODE_OPTIONS` (`--max-old-space-size`, a proxy shim) for repomix and the
  provisioning engine — it executes code at start-up and a workspace `.env` can set it, so
  it no longer reaches any child. Adding a variable means adding its name to
  `SUBPROCESS_TOOLS` in `src/helpers/subprocess-env.mjs`, in a change that says which tool
  reads it and why; a name on the NEVER list cannot be added at all.
- `PYTHONIOENCODING=utf-8` is fixed for the five Python children the helper guards. The two
  interactive installers are exempt and keep whatever the user's shell carries.
- A workspace `.env` that carried other variables for the router's benefit — a
  `MARKITDOWN_PATH`, a `HTTPS_PROXY`, a `HF_HOME`, an `OBSIDIAN_ROUTER_CONFIG`, or one of the
  four multi-tenant settings the cheat sheet used to file under the workspace `.env`
  (`OBSIDIAN_ROUTER_ALLOWED_VAULTS`, `OBSIDIAN_ROUTER_READONLY`, `OBSIDIAN_ROUTER_USER_ID`,
  `VAULT_<NAME>`) — no longer sets them: the router names them on its stderr at start-up,
  and they belong in the MCP host's server declaration, in the launcher of a served
  instance, or in the shell. The cheat sheet (`docs/quick-reference-{en,fr}.html`, PDFs
  re-rendered) now keeps the workspace keys and the host keys in two tables.
- `PYTHONWARNINGS` no longer reaches the Python children, and `PSModulePath` no longer
  reaches the process scan: both are on the NEVER list. A warnings filter can name a module
  the interpreter IMPORTS to resolve the category (`-W default::pkg.Cls`), and
  `PSModulePath` is where PowerShell auto-loads its modules from, `CimCmdlets` included —
  the CIM scan was measured to work without it, and the shell rebuilds its default path
  when the variable is absent. An operator who quiets Python warnings through the
  environment loses that for the router's children only.
- `SSL_CERT_DIR` is resolved as the LIST OpenSSL reads (`:` on POSIX, `;` on Windows):
  every relative entry is made absolute on its own, empty entries and the delimiter kept.
  It used to be treated as one path, and `ca-one;ca-two` became a single nonexistent
  directory.
- `LD_LIBRARY_PATH` is on the NEVER list: a Docling install that relied on a system CUDA
  found through it (rather than through the libraries the torch wheels carry) would lose it.
  The wheels ship their own; if a setup needs the system path, that is a named addition to
  discuss, not a silent pass-through to restore.

### Review

- Two adversarial reviewers, two passes each, every pass handed the invariants the change
  claims. Pass 1 — Codex: 16 findings (4 blocking, 10 major, 2 minor); the Code Reviewer
  agent: 5 important, 3 minor, its own mutation run and an independent recount of 37/22/15 —
  24 findings. Folded in: no prefix rule, the NEVER list, `extraEnv` restricted to listed
  names, fixed values applied last, `NODE_OPTIONS` refused, `ELECTRON_RUN_AS_NODE` and the
  session variables named, the SDK-started router counted, the guard judging the options
  argument and pinning exact totals and commands, the CI-fail on a missing instrument,
  relative overrides resolved, and the wording of README and this entry. Refuted on the
  code: the export allowlist already covers `src/**` (`npm run gate` green, release-grade
  scan of the changed files clean). Accepted as residual: eleven of the 22 guarded sites are
  proven by the structural guard rather than by an executable pin.
- Pass 2 — the Code Reviewer agent re-ran the file (29/29), verified the eight corrections
  one by one, and found the gap that mattered: the workspace `.env` loaders. Folded in: the
  `.env` policy above, `GIT_SSL_CAINFO` / `GIT_SSL_CAPATH` for git, `XDG_DATA_DIRS` /
  `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` for the `--open` hand-off, the desktop launchers
  no longer forwarding `ELECTRON_RUN_AS_NODE`, the test's scratch directory moved under a
  git-ignored corner of `tests/`, and two wording fixes.
- Pass 2 — Codex, on the intermediate tree: 10 findings (1 blocking — the same
  `OBSIDIAN_ROUTER_*` family in the `.env` loader, already closed by the explicit list — 2
  major, 7 minor). Folded in: the guard now requires the options argument to be EXACTLY one
  `subprocessOptions(...)` call (no `.env` property access, no `|| opts` after it) naming no
  `env` property in any spelling (`env:`, the `{ env }` shorthand, `'env':`, `['env']:`);
  path-valued variables resolved (above); the credential shapes of the NEVER list match on
  word boundaries, so `TOKENIZERS_PARALLELISM` — a real Hugging Face knob Docling's stack
  reads, now named for it — is not mistaken for a secret; an `extraEnv` KEY is judged before
  its value (a null under a forbidden name still throws); the CONTROL test requires every
  dangerous sentinel to arrive; the `.env` warning shows ignored names through a strict
  alphabet, clipped to 64 characters and capped at 20, so a hostile file cannot drive a
  terminal through it; the provisioning engine's two imposed values are applied AFTER a
  caller's `extraEnv`, so `OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS=1` cannot be overridden by
  a caller either; the readiness probe shares the override resolver; the measures in this
  entry were re-taken on the final tree.
- Pass 3 — the Code Reviewer agent, on the `.env` policy: one blocker (the whole
  `OBSIDIAN_ROUTER_*` family accepted from a workspace file — fixed by the explicit list
  above), two important (the hooks' warning on the stderr Claude reads — the hooks are silent
  now; the loader guard blind to eight forms of the same loop — replaced by the
  "no computed-key write into `process.env` anywhere" rule), and the spread rule for spawns.
  Left as they were, on purpose: the `.env` WRITERS still match `KEY=` lines without an
  `export ` prefix (pre-existing, cosmetic), and `delete launcherEnv.ELECTRON_RUN_AS_NODE`
  is case-sensitive on a plain object (Electron writes the name in upper case).
- Pass 4 — the Code Reviewer agent confirmed the pass-3 blocker closed (no accepted key can
  point the router at an endpoint outside the user's own registry) and found three more, all
  folded in: the cheat sheet filed four host settings under the workspace `.env` (two tables
  now); the loader guard was blind to an alias of `process.env` (two rules added, plus
  reflective writes); the binary discarded what the loader applied (it now names the applied
  keys — a `lockSource` / `autoEnrichModeSource` field on `list_vaults`, so Claude can say
  "FullAuto came from the repository's file", is a follow-up, not in this lot). Minor, also
  done: the opt-out pin counting reads rather than mentions with its host-only list, a
  stale docstring in the hooks' loader, and a test that the binary is not silent. Refuted
  on the code: the byte-order mark was never a problem — `trim()` strips U+FEFF — so that
  one became a pin instead of a fix.
- Pass 3 — Codex, on the final diff: 11 findings (1 blocking, 6 major, 4 minor). Folded
  in: the sandbox from a workspace file (the blocking one, above); the guard judging the
  LAST argument where Node reads a FIXED position — `spawnSync(cmd, argv, { env:
  process.env }, subprocessOptions('git'))` passed as guarded while Node used the third
  argument and ignored the fourth: the guard now refuses more than three arguments, an
  object literal where the argv goes, and an `env` spelling in any argument but the
  options, with that exact call as a red witness — and the witnesses without any `env`
  exposed a second flaw on the way: the argument count was taken on the blanked text,
  where a string-literal command (`'git'`) is all spaces and vanished from the count, so
  arguments are now counted on the raw source at the same offsets; `PYTHONWARNINGS` and `PSModulePath` to
  the NEVER list (a probe showed `-W default::this.X` running the module's side effects);
  `SSL_CERT_DIR` as a list; the five hooks reading an opt-out before loading the file; the
  loader-uniqueness pins; the applied line no longer printing the path; the Electron
  variables removed from the `--open` launcher case-insensitively; the `set_auto_enrich_mode`
  descriptions still saying `off` removes the line (it writes the literal, since v0.13);
  the measures re-taken. Not folded in, on purpose: the observation that a cloned
  repository's `.env` still CHOOSES which of the user's registered vaults a session reads,
  locks and enriches (the binding could live in a per-user store outside the repository,
  or require an approval) — a design decision for the owner, recorded as a proposal, not a
  patch in a security lot.
- Pass 5 — the Code Reviewer agent confirmed the four pass-4 corrections and the
  byte-order-mark refutation on the code, and found the sandbox hole from the alias side
  (fixed above, with `getAllowedPaths` aligned on the start-up reader), the default-parameter
  alias the guard could not see (`({ env = process.env } = {})` is the house style, so the
  guard now stands on the WRITE side: `env[key] = value` through an identifier named `env`
  is refused outside the policy module), the cheat sheets' opt-out line (five of fourteen
  in one language, "by hook" in the other — now the fourteen by name, identically), the
  cheat sheets' header still saying v0.86.0, and the "hooks are silent" pin generalised to
  every direct call under `hooks/`.

## [0.86.0] — 2026-09-01 — three silences: a dormant toolbox, a bench that skipped, a journal that split

Nothing here was broken loudly. A conversion toolbox that was never installed said
nothing until an `ENOENT` mid-task; a security bench skipped its own measurement on a
CI leg that reported green; and a session resumed one minute later opened a second
journal. Each was invisible because the thing that would have reported it was the
thing that was missing.

### Added

- **`list_vaults` now reports whether the conversion toolbox is provisioned.** The
  response carries a `conversionToolbox` block — `available`, `via`
  (`bundled-venv` / `env-override` / `path`), `path`, `verified`, `optedOut`,
  `toolsAffected`, `toolsDegraded`, `hint`. `verified: false` marks an answer taken on
  the user's word rather than measured (a bare command name resolved through `PATH` at
  call time, or a UNC path unsafe to stat on this hot path), so a surface can say
  "configured" instead of overstating it as "ready". Eight tools shell out to the `markitdown` Python CLI, which
  is installed by an explicit opt-in and **never automatically** (there is no npm
  `postinstall` — a written decision: the router imposes a Python install on nobody).
  The cost of that refusal was a silence: nothing told a new installer those tools were
  dormant, so the first signal was an `ENOENT` in the middle of a real task, which reads
  as "these tools are broken" rather than "these tools are not switched on". This rides
  the discovery call `meta-status` already makes, and runs **no subprocess**.
- **`src/helpers/conversion-readiness.mjs`** — the single definition of "is markitdown
  usable here", and of "is there a Python new enough to install it". The Python probe
  used to exist twice (`install-markitdown.mjs`, and a copy in `install-docling.mjs`
  whose comment said *"same logic as install-markitdown.mjs"* — a copy admitting it is
  one); the runtime error path needed it as well, and a third copy is how a rule ends up
  fixed in one place and stale in the others.
- **`meta-setup` asks the question once**, while the user is already provisioning, and
  takes "not now" as a complete answer. `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` silences it
  permanently — the same courtesy the auto-update notice already extended.

### Changed

- **BREAKING (runtime): the required Node floor moves from `20.18.1` to `20.19.0`.** `undici@7` still
  only asks for 20.18.1; the extra patch buys the test suite Node's `--permission` flag, renamed from
  `--experimental-permission` in 20.19.0 (and in 22.13.0 / 23.5.0). `tests/no-vault-disk.test.mjs`
  proves the HTTP-only claim — *with the API key in the config, no tool needs the vault's disk* — by
  running the tool surface with the vault's directory denied at the OS level. On 20.18.1 that flag was
  refused, so the four OS-level suites skipped and the security property this project advertises went
  **unmeasured on a CI leg that reported green**. The low matrix leg is now pinned to `20.19.0`
  exactly: a floor nothing runs at is a claim, not a guarantee. If you are on 20.18.x, update Node;
  nothing else about the runtime changed.
- **The `markitdown` ENOENT message now says WHICH problem the reader has.** It checks
  for a Python interpreter first and distinguishes three answers, because they call for
  three different actions: Python 3.10+ is present (*one command fixes this*, with the
  exact path for **this** install), Python is present but too old (*upgrade, then run…*
  — naming the version found), or the check could not run at all (*this could not be
  determined here*). The previous wording listed three fixes and left the reader to work
  out which one their machine could take; sending someone to an installer that will
  refuse is worse than saying nothing.
- **Nothing claims a fact about the machine it did not measure.** "We could not look" —
  a timeout, a permission error, a broken shim — is never reported as "no Python found".
  Both installers print a distinct third message for it. The `findPython()` convenience
  wrapper that collapsed *too old* and *could not look* into a single `null` was deleted
  rather than kept: leaving a shorter name that models the defect is how the defect
  comes back.
- **`docs/features/05-conversion-de-documents.md` said the opposite of what the router
  does.** It advertised *"Postinstall automatique"* two paragraphs after correctly
  calling the step opt-in since v0.56.0. There has never been a `postinstall` in the
  package. The `README` and the English cheat sheet already had it right; the French
  feature sheet was the only surface carrying the false claim (1/1 corrected).

### Fixed

- **The readiness probe and the runtime can no longer disagree about which `markitdown`
  will run.** The probe trimmed `MARKITDOWN_PATH` while `resolveMarkitdownPath` does
  not, so `MARKITDOWN_PATH=" /opt/bin/markitdown "` was reported ready at the trimmed
  path and then failed at the padded one. The probe now mirrors the runtime's resolution
  exactly, and a test pins the two together for the same inputs.
- **A count that pushed toward a ~150 MB install.** The first version of this work said
  ten tools depend on markitdown. `git_repo_to_markdown` never did (it goes through
  repomix) and `youtube_to_markdown` degrades to its yt-dlp captions instead of dying.
  Eight is the real number — and the messages now also refuse the opposite over-promise,
  since yt-dlp is *itself* an executable the router does not install, so that fallback
  is qualified rather than guaranteed.
- **PATH scanning is bounded in allocation, not just in I/O.** Capping entries after
  `split()` still allocated every substring first; the string is now truncated before
  the split. UNC entries stay skipped, and the remaining hang risk — a disconnected
  mapped drive looks exactly like a local path — is documented as accepted rather than
  described as solved.
- **On POSIX, a file without an execute bit is no longer reported as available** (mode
  0644 gives `EACCES`, not a working tool); on Windows, `.cmd` / `.bat` shims stay
  excluded because `execFile` cannot spawn them since the CVE-2024-27980 fix.
- **No generated command can be broken by its own path.** A `"` is legal in a POSIX
  directory name, and `node "<root>"` around one breaks out of the quoting; both the
  hint and the ENOENT message fall back to the generic wording instead of emitting
  something unpasteable.
- **Command/skill parity.** The rules first landed only in `skills/meta-*/SKILL.md`, so
  a user invoking the documented slash command got the original silence. Both surfaces
  now carry every load-bearing rule, and the test checks each rule separately rather
  than searching for one keyword per file.
- **`MARKITDOWN_PATH` is verified, not merely trusted.** Any non-empty value used to
  report `available: true`, so `meta-status` printed a green tick for
  `MARKITDOWN_PATH=Z:\gone\markitdown.exe` — a claim about the machine that nothing had
  checked. The override still decides *which* path runs (that is trusted, and `path`
  mirrors the runtime byte-for-byte); whether it runs is now measured, and a broken one
  gets a hint that says to fix the variable rather than to install anything, which would
  be advice for a problem the reader does not have.
- **A generated command can no longer be reinterpreted by the shell it is pasted into.**
  Rejecting a literal `"` was not enough: inside double quotes both PowerShell and POSIX
  still expand `$…`, and POSIX runs backticks, so a directory legally named
  `/tmp/router$(id)` produced a "hint" that would execute something else. Any path
  containing `"`, `$`, a backtick or a control character is now declined outright in
  favour of wording that names no path at all.
- **`resolveMarkitdownPath` asks whether it can RUN the bundled venv binary**, not
  merely whether something exists at that path. `existsSync` says yes to a directory and
  to a mode-0644 file — both of which fail to spawn, *while a working `markitdown` sat
  on `PATH` one tier below*. An interrupted `install-markitdown` is exactly how such a
  `.venv` comes to exist. One definition (`isRunnableFile`) now answers that question
  for the PATH tier, the venv tier and the runtime resolver alike.
- **"No Python found" is again a measured fact, in both directions.** The first repair
  overshot: routing every failed probe to "could not determine" fixed the permission-
  error lie by telling a new one to the machine that genuinely has no Python. `ENOENT`
  is the OS answering, not refusing to; only `EACCES`, a timeout or a broken shim leaves
  the question open — and one such candidate now invalidates the whole conclusion, which
  an interim `answered || conclusive` had quietly stopped doing.
- **A bare-command override is no longer reported as broken.** `MARKITDOWN_PATH=markitdown`
  is a working configuration — the runtime hands it to `execFile`, which searches `PATH`.
  Verifying it as a filesystem path resolved it against the CWD and told a healthy install
  that all eight tools would fail; a regression introduced by the verification that fixed
  the false green tick. Bare names and UNC paths are now delegated rather than statted
  (the latter because that stat can block the session-start call), and a new `verified`
  field records which answers were measured and which were taken on the user's word.
- **`.cmd` / `.bat` are rejected in every tier, not just the PATH scan.** `execFile`
  cannot spawn them since the CVE-2024-27980 fix, and the PATH scan never met one because
  it only tries `.exe`/`.com` — but the override and venv tiers took whatever the user
  named, so `MARKITDOWN_PATH=…\markitdown.cmd` was reported ready for a call guaranteed
  to fail with an untranslated spawn error.
- **The loop with no exit is broken, by saying so rather than pretending to fix it.**
  Both installers checked `existsSync` for "already present", so a venv left as a
  directory by an interrupted install produced a dead end: the probe said run the
  installer, the installer said "already present" and did nothing. They now ask the same
  runnable-or-not question — and when the marker exists but cannot run, they say plainly
  that re-running will *not* repair it and **name the directory to remove**, without
  generating any command for it (see below). An earlier version of this entry claimed
  they "rebuild"; they do not, because `python -m venv` cannot replace what already sits
  at the marker, and deleting inside someone's venv is not an installer's call to make
  unasked.
- **The opt-out is honoured on the error path too.** `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`
  silenced the two prose surfaces while every failed conversion call still spawned a
  Python probe and printed install commands at someone who had already answered. The
  error now states what failed and that the opt-out explains it — no probe, no pitch.
- **Windows stops reporting names it certainly cannot spawn.** The `.cmd` / `.bat`
  exclusion was an extension check that ran after a `stat`, so it never applied to the
  two tiers the probe deliberately does not stat — `MARKITDOWN_PATH=markitdown.cmd` came
  back available. It is now a string rule covering every tier, and it also refuses an
  explicit extension that is not an executable image (a `.ps1` is a script for a shell to
  read; `execFile` answers `EFTYPE`). This is a **name** check, not an image check: a
  text file named `markitdown.exe` still passes it and fails at spawn with
  `ERROR_BAD_EXE_FORMAT`. Proving otherwise means reading the PE header, which this hot
  path does not do — the same shape as the POSIX execute bit, which says a bit is set,
  not that *this* process may use it.
- **"Too old" no longer hides an interpreter that could not be inspected**, and an
  interpreter that ran without revealing its version is treated as inconclusive rather
  than as proof of absence — a test had pinned the wrong behaviour there.
- **The installers no longer generate a deletion command at all.** The message telling a
  user how to clear an unusable `.venv` first built `rm -rf "<dir>"` by interpolation,
  skipping the safety check added earlier for the *install* command — in a recursive
  delete, so a project root legally named `/srv/router$(touch X)` turned a diagnostic
  into command execution. Adding that check and `-LiteralPath` was not enough either:
  "can this be interpolated" is a different question from "is this a legitimate deletion
  target", and the guarded version still accepted `/` (→ `rm -rf "/"`), `-rf` (parsed as
  an option, the command having no `--`), `../.venv`, `~`, and a trailing backslash that
  escapes the closing quote in bash. Making it genuinely safe needs target validation an
  installer message has no business doing, so the generator is **gone**: the user is told
  which directory is broken, with control characters escaped so a path cannot impersonate
  an instruction, and removes it however they like. The invariant is now checkable at a
  glance — this code never emits a deletion command — and a test enforces it against
  every hostile input, including `null` and `/`.
- **A bare `MARKITDOWN_PATH=markitdown` works again on Windows.** Closing the `.ps1`
  hole had required the configured *string* to end in `.exe`, which rejected a
  configuration `execFile` resolves perfectly well through `PATH` + `PATHEXT`. An
  extension-less name is now delegated; an explicit `.cmd`/`.bat` is refused in every
  tier including the ones the probe declines to stat; and the rule no longer trims, so a
  padded `" markitdown.exe "` fails here exactly as it does at spawn.
- **A Python version printed on stderr is read — but only when the interpreter is the one
  saying it.** `python --version` writes to stderr on 2.x, so reading stdout alone
  reported "could not determine" for a machine whose interpreter had answered plainly
  that it was 2.7. Reading both streams then introduced its own false positive: an
  unanchored search took `warning: install Python 3.12 for support` from a wrapper as the
  answer, over the real `Python 2.7.18` on the next line. The match is now anchored to the
  start of a line, which is where an interpreter states its own version.
- **An extension-less path works on Windows again.** `execFile('C:\Tools\markitdown')`
  succeeds when `markitdown.exe` is present — CreateProcess appends the extension — but
  the probe statted the bare path, found nothing and called a working install broken.
  (`where` in System32 is the counterexample that proved it.)
- **`meta-setup` checks the opt-out before offering anything**, and `meta-status` has an
  honest rendering for the probe's own unknown state (`via: null`, `hint: null`) instead
  of reporting it as confirmed absence and quoting an empty hint.
- **`%TEMP%` and `!NAME!` join `$` and backticks in the shell-safety refusal** — `cmd.exe`
  expands both inside double quotes, and the reader's shell is not ours to choose.
- **`meta-status` no longer calls a broken override "not installed".** When
  `MARKITDOWN_PATH` points at something unusable it *masks* a working install underneath;
  the diagnosis is to fix or unset one variable, not to install anything. Both surfaces
  also now state that one decline ends the offer for the conversation, and that
  `conversionToolbox` measures the machine rather than the answer the user gave.

- **A session that resumed one minute later opened a second journal — and logged
  itself twice.** The journal filename embeds the `HHMM` at which `SessionStart`
  fired, and that same basename is the dedup key `appendLogMdEntry` greps for. So
  the invariant the code claimed — *same `session_id` resolves to the same filename
  (idempotent on resume)* — only ever held **within one clock minute**. A
  crash-recovery resume whose `SessionStart` landed after the minute rolled over
  minted a second file and appended a second `journal.md` line for one session.
  `SessionStart` now reuses an **open** journal already on disk for the same
  (date, workspace, session-id) triple before minting a new name. A closed journal
  is never resumed: that occurrence is finished, and appending past its recap would
  contradict the `status: closed` its own `SessionEnd` wrote.
- **The test that was meant to prove the dedup was proving the clock.**
  `tests/session-auto-journal.test.mjs` forced its second append by re-running
  `SessionStart`+`SessionEnd`, which re-derived the dedup key from the current
  minute — so when the two starts straddled a boundary the key differed, a
  legitimate second line appeared, and the assertion failed at something other than
  the dedup it names. It now restores the state JSON and re-fires `SessionEnd`: a
  real dual-fired event, same key by construction. The timezone test compared
  against a `new Date()` read *after* its spawns and now checks the window they
  actually spanned. Rare when idle and common under load — concurrent `npm test`
  runs slow every hook spawn — which is what made a clock boundary look like shared
  state racing between test runs.

## [0.85.0] — 2026-09-01 — W-C citations, chunk-level sourcing, and four tool descriptions that were wrong

The last three items of the §1 quick-wins lot: **W-C** (Crawl4AI's markdown-with-
citations variant), **chunk-level citations** (the LightRAG borrowing, skill-only),
and **Docling #5** (documenting the MarkItDown limits) — which turned out to be the
interesting one.

### Added

- **`citations: true` on `webpage_to_markdown`** — inline `[text](https://…)` become
  `text[^N]` with a `## References` list. One footnote per DESTINATION, numbered by
  first appearance, starting above any numeric footnote the page already uses.
  Default false, and the output is then **byte-identical** to before.
- **`src/helpers/markdown-mask.mjs`** — blanks fenced code, indented code, inline
  spans and HTML comments, length- and line-preserving, so a caller runs its regex
  over the mask and cuts the original. Shared with `get_wiki_context_pack`, which
  needed the same question answered for the opposite reason.
- **`wiki-query` and `read-search-smart` SKILLs**: cite the SECTION a chunk's
  `breadcrumbs` names — when the response gives one — and read the `freshness` and
  `folderExclusion` blocks rather than swallowing them.

### Docling #5 — the item's own premise had expired

The roadmap item said to document that MarkItDown "does plain text extraction with
NO table-structure recognition" and to point users at Docling. **That is no longer
true of the installed version.** markitdown 0.1.5 extracts PDF tables into aligned
markdown via **pdfplumber** (0.11.9, installed), falling back to pdfminer.six only
when pdfplumber is missing or throws; DOCX goes through mammoth with tables
preserved; PPTX detects table shapes and converts them explicitly.

A first pass shipped the roadmap's wording verbatim into all four converter
descriptions — false for three of them — **and a shell heredoc had eaten the tool
name, so the PDF description literally read "use  instead"**. Both were caught by
adversarial review, which cited the installed converters' own source. The four
descriptions now state what the installed code does, with the limits that remain
(pdfminer fallback keeps no structure; no path does layout analysis; XLSX gives
cached values, not formulas; PPTX loses reading order across shapes).

### Verification — 12 defects, and one refuted claim of my own

- **The mask was QUADRATIC** and this is a hot path: `get_wiki_context_pack` runs it
  on every page body with no byte cap. Measured on the regex version: 2.3 ms at 2000
  backticks, 35.5 ms at 8000, **582 ms at 32000**. Rewritten as a linear scanner —
  128 000 backticks now cost 5.2 ms — and pinned by a test.
- **The repo's own bracket-bomb guard caught the citation regex** on its first run
  (107 ms), the same class as the v0.71.0 sweep. `[` is excluded from the label
  class; the cost is that `[see [1]](url)` stays inline, which is the safe direction.
- **Three independent masking passes get precedence wrong.** Review produced four
  inputs where a construct inside code opened one outside it — a `<!--` shown in a
  fence, a fence marker inside a comment, a backtick in a comment pairing with prose,
  an inline opener pairing across a block. Block structure is now resolved first and
  everything else is confined by it.
- **`\[not-a-link](url)` was being converted** into `\not-a-link[^1]`; balanced
  parentheses in a URL and angle-bracket destinations were silently missed; a
  `[^99]:` shown inside code pushed our numbering to 100. All fixed and pinned.
- **A claim of mine was refuted by making its own test real.** The test for "citations
  run before the filter" never triggered BM25 (too few blocks, then the over-filter
  guard, then a query term too common to score). Once it did, the ordering fell over:
  the reference block scores nothing against the query, so **the filter dropped it**,
  leaving `[^1]` markers with no definitions. The order is now filter-then-footnote,
  which makes markers and definitions one-to-one — and the reasoning that justified
  the original order was simply wrong.

Suite **4356 → 4395**; `validate` and `gate` clean.

### Deferred

- **The citation formatter is not a CommonMark parser** and says so: a label
  containing `[`, a label across a line break, a destination with nested
  parentheses more than one deep, and reference-style links are all left inline.
  Every gap costs a reference not collected, never a document corrupted.
- **The mask does not model** link reference definitions, HTML blocks, or lists that
  change the indented-code rule. Same asymmetry: a missed mask, never a rewrite of
  real code.

## [0.84.0] — 2026-09-01 — A3 + C4: where a result came from, and what the search left out

Items **A3** (agentic-first guardrails) and **C4** (default folder exclusion) of the
large-codebases borrowings — the rest of the "honesty about the semantic tier" trio
that A1 opened. A1 said whether a result was *current*; these say where it *came
from* and what was *left out*.

### Added — A3

- **`source` on every item of `get_wiki_context_pack`**: `index` (ranked out of
  `wiki-meta/catalog.md`), `graph` (a wikilink from a page that was actually read),
  `semantic` (a Smart Connections chunk). The envelope declares the closed
  vocabulary in `provenance`, naming which half is authoritative.
- **`answer-relies-on-semantic-only`** — raised when the navigational half comes
  back empty and semantic chunks did not. A **placeholder does not count as an
  anchor**: a catalogue entry whose page could not be read names a gap, it carries
  no content, so it cannot silence the guard.
- **`skills/wiki-query/SKILL.md`** now forbids answering out of semantic chunks
  alone, requires opening a page whose freshness is doubtful, and cites at the
  section (`breadcrumbs`) rather than the page.

### Added — C4

- **A default `excludeFolders`** on `search_smart` and `get_wiki_context_pack`:
  `['wiki-meta/Sessions']`. An explicit array replaces it; **`[]` means "exclude
  nothing"** and is deliberately distinct from omitting the argument;
  `OBSIDIAN_ROUTER_DEFAULT_EXCLUDE_FOLDERS` overrides it per host.
- **`folderExclusion`** on every response: the folders, `chosenBy`
  (`caller` | `default`), `excludedHits`, and `shortPage` when the page came back
  under `limit` because of the cut.

### The default was measured, and the roadmap's guess was wrong

The roadmap proposed `.trash` and `Templates`. **Neither exists on any of the 23
vaults** — both would have shipped as decoration. Three other plausible candidates
(`wiki-meta/graph`, `wiki-meta/digests`, `wiki-meta/presence`) hold nothing the index
carries: measured contribution, zero pages on zero vaults. They are not shipped
either, because a default that excludes nothing is worse than no default — it reads
as protection.

What the sweep did find is one folder, and it is large: **`wiki-meta/Sessions` is
1212 of the 2915 indexed pages across the fleet (41.6%)**, and 498 of 803 on the
router's own vault. Raw chronological logs by construction, which no navigational
path visits. Because the cut is that big it is never applied silently.

### Verification — one review round on A3, one on C4, 13 defects

- **A3 (5 defects).** Two were false claims made by *documentation*: the skill told
  the reader to apply the 0.55 cosine threshold to results that may have silently
  fallen back to BM25, and asserted that each hit carries a `clickToOpenUrl` (it
  does not — the URL is in a top-level `clickToOpenLinks` map). Two were real code
  defects: A1's freshness rows were keyed by the *canonical* path while the join
  held the raw one, so a chunk whose path needed normalising lost its annotation;
  and a `[[link]]` inside a fenced block or an HTML comment was emitted as an
  authoritative `graph` neighbour — a long-standing looseness that A3's label
  turned into a false claim.
- **C4 (8 defects).** The worst was structural: a **constant** over-fetch margin
  cannot fill a page when the filter removes 41.6% of the corpus. With `limit: 5`
  and eleven excluded hits at the top, four results came back while eligible
  matches sat just past the window. The margin now scales, and — since no backend
  here takes an offset — a page that is still short **says so** rather than looking
  full. Also: `get_wiki_context_pack` had no over-fetch at all and never applied
  the archive filter, so the two tools answered differently about the same vault;
  a hit shaped `{filename: …}` (a shape the click-to-open walker already
  recognises) slipped past the exclusion entirely; and the code-fence mask
  understood only exactly three backticks, so a four-backtick fence and a
  ``double``-backtick span still leaked example links.

Suite **4311 → 4356**; `validate` and `gate` clean. One pre-existing test that
hard-coded the archive filter's flat `+10` margin was re-anchored to the exported
constant rather than to a number.

### Deferred

- **The over-fetch is a mitigation, not a guarantee.** Refilling a short page needs
  either an offset on the backend or an exclusion-aware bridge; neither exists.
  The response reports the shortfall instead of hiding it.
- **`excludedHits` counts what THIS filter removed** from what the backend returned
  — not the cost of the exclusion overall. A bridge that honoured the forwarded
  hint and dropped the hits itself leaves it at 0, and a hit the archive filter
  would also have removed is still counted here. Named in the field's own docs
  rather than left to be inferred.
- **The two tools still differ on the BM25 fallback.** `search_smart` degrades to
  the local index when the semantic tier cannot serve; `get_wiki_context_pack`
  calls the REST helper directly and does not. Making the pack share the tool's
  tier logic is a real change to its error contract, not a tidy-up.

## [0.83.0] — 2026-09-01 — A1: a semantic hit now says whether its page has moved on

Item **A1** of the large-codebases borrowings (`claude-code-large-codebases-roadmap`,
"warning de staleness", the one its own table ranks highest for ROI). `search_smart`
ranks against vectors Smart Connections computed on its own schedule; a note edited
afterwards still answers with its previous vector, and nothing said so — a stale hit
and a current one arrived looking identical. That is the exact RAG failure mode the
Anthropic article names, and the router was trusting it blindly.

### Added

- **`freshness` on the semantic tier of `search_smart`** — per-page verdicts
  (`fresh` · `changed` · `touched` · `page-missing` · `not-indexed` · `unknown`),
  a summary, and one sentence naming what to do. **Only the semantic tier**: the
  local BM25 tier keeps its own, differently-meant `index.freshness`, and giving
  two tiers one field name for two measurements is how a reader ends up comparing
  incomparable things.
- **`get_wiki_context_pack`**: each `semanticChunks[]` entry carries its page's
  verdict, `semanticFreshness` carries the detail, and a doubtful result raises
  `semantic-results-possibly-stale` with an actionable `suggestedActions[]` entry.
  A hit pointing at a deleted page raises `semantic-hit-page-missing`.
- **`src/helpers/embedding-staleness.mjs`** — the deterministic core, plus
  `parseSourceRecordLine` extracted from `smart-env-embeddings.mjs` so the store
  format is defined in exactly one place rather than copied.

### The measurement chose the design, three times

- **A claim this repo made was false.** `smart-env-embeddings.mjs` stated that
  per-page staleness "cannot be determined from here". True about the *hash*
  (`last_embed.hash` is the plugin's own, not recomputable); false about staleness:
  every record also carries `last_import: {mtime, size}` — **the note's own mtime
  and size as Smart Connections saw them** — which this router *can* compare against
  the file on disk. Found by opening a record rather than reasoning about one. The
  claim is corrected at all five sites that carried it (module doc, the caveat string
  `find_twin_pages` emits, the tool description, `wiki-lint`'s SKILL.md, a test's
  assertion message).
- **The cheap shortcut is refuted.** Statting the store file instead of reading it
  looks equivalent and is not: on 803 files its mtime agrees with the record's own
  `last_embed.at` within a minute for only **329**, median disagreement **12.5 hours**.
  So the records are read — 9.4 ms for the ten files a default page of hits touches.
- **`touched` exists because a quarter of the signal would otherwise be unearned.**
  Fleet-wide, **61 of 244** modified pages have the *same byte size* they had at
  import, clustered on the two Google Drive vaults (21 of 30 on one). That is a sync
  client touching mtime. It is reported as its own verdict rather than folded into
  "edited".
- **Filename lookup is a hint, never proof.** Smart Connections flattens `/`, `.`
  and ` ` to `_`, so `a/b.md`, `a.b.md` and `a b.md` collide. Whatever file the
  derived name opens, the record's own key must equal the path asked about.
  Measured over 19 vaults / 2915 records: 2890 found by the exact name, **25 need a
  case-folded index** of the real listing (21 on one vault, a directory renamed after
  indexing), **0 unresolvable**.

### Verification — three adversarial rounds, and the third paid again

**39 defects** were found and fixed across three review rounds, plus a first
end-to-end run on the real vault. The shape of them is the finding: **round 2 and
round 3 were dominated by defects the previous round's repairs had introduced.**

- **Round 1 (11)** — the worst were this codebase's own recurring class, committed
  again: an unreadable store file reported as `not-indexed` (a claim about the vault
  built from our own failure to look), and a `statSync` failure reported as a deleted
  page. **Two of the tests written for this feature pinned that wrong behaviour.**
  Also: a path from the wire statted outside the vault root, and 50 anchors of one
  note counted as 50 changed pages.
- **Round 2 (14)** — mostly in the round-1 fixes. A traversing *fragment*
  (`safe.md#../../../outside.md`) still reached `statSync`; `canonicalVaultPath`'s
  return value was computed and discarded, so `wiki/a.md` and `wiki//a.md` were two
  pages; and a page whose size went 100 → 999 under an unchanged mtime read **`fresh`**
  — currency asserted against proof to the contrary. Size now outranks the clock.
- **Round 3 (14)** — again mostly in round 2's fixes. A `NaN` mtime passed a
  `typeof === 'number'` test, made every comparison false, and came back `fresh`. A
  single readable record was returned as conclusive while a competing file was
  unreadable. Examining every candidate (round 2's own fix) had made the aggregate
  read unbounded. Two candidates that *agree* were refused as a disagreement.
- **The first real call found what no round could.** Run against the live vault:
  25 ms for 7 pages, correct verdicts, and the case-folded lookup firing on real
  data (`LLM-WIKI-COMPILER`). It also showed an anchored path that failed lookup was
  being statted *with its anchor* and declared `page-missing` — about a file that
  never had to exist.

Suite **4245 → 4311** (+66, 82 in the two new files); `validate` and `gate` both
clean.

### Deferred

- **Local disk only.** A vault this machine has no disk for answers
  `checkable: false` with a reason and no warning — never a false positive, the rule
  the roadmap set. The bridge's `GET /smart-env/sources` *could* serve these records
  remotely (C11 uses it that way) but it ships the whole store — 4.3 MB gzipped on
  the largest vault, against a 240 s budget — which is not a thing to do on a
  search's hot path.
- **The byte cap is a pre-check, not a hard read bound.** A store file that grows
  between the `statSync` and the `readFileSync` is still read in full; `readFileSync`
  offers no limit. Bounded in aggregate per page instead.
- **`libFor` follows the repo convention and inherits its limit**: a Windows-style
  path on a POSIX runtime is manipulated as a Windows string and the native `fs` call
  then fails, reported as `store-missing`. That is the safe direction (a decline, not
  a wrong verdict), and diverging here from `resolve-vault-path.mjs` and
  `smart-env-embeddings.mjs` would be worse than the limit.
- **A UNC path written `//server/share`** is classified POSIX-style, so a
  fold-assisted record match on it is refused rather than accepted — again the safe
  direction, and it costs an `unknown`, never a wrong answer.

## [0.82.0] — 2026-08-31 — `find_twin_pages` stops being a local-disk tool

The last named limit of the HTTP-only workstream, and the one the v0.79.0 notes
called "not in this repo": `find_twin_pages` answered `available: false,
reason: 'remote-vault'` for any vault whose disk this machine did not have.
It now runs on a networked vault and returns the same answer it would on disk.

### Why this needed the bridge, and not a workaround here

The tool compares every page against every other by cosine, using the vectors
Smart Connections keeps in `<vault>/.smart-env/multi/`. The Local REST API does
not serve dot-directories — and that refusal is **structural**, not a setting:
measured on a real vault, Obsidian's own `app.vault.getFiles()` returns **zero**
entries under `.smart-env`, so the core API cannot see them at all. A plugin
can, through `vault.adapter`. So the missing piece was a bridge route, and the
fix is split across two repos.

A BM25 fallback was considered in v0.79.0 and is still **refused**. The whole
contract of this tool is that `available: true` cannot be falsified; answering a
neighbouring question under the same flag would destroy the guarantee it exists
to protect.

### Added

- **`readSmartEnvEmbeddingsViaRest`** — the store, fetched from
  obsidian-mcp-router-bridge **0.9.0+**'s `GET /smart-env/sources`.
- **`getSmartEnvSources` + a per-request timeout override in `rest-client`.**
  The whole store travels in one response, and the vault default (10 s, sized
  for single-note reads) would abort a healthy transfer.
- **A REST page source for `find_twin_pages`** — the wiki walk and the page
  reads go through the ordinary Local REST API, which serves ordinary
  directories perfectly well. Reads are batched four in flight and keep input
  order (measured: 191 pages, 519 ms sequential → 156 ms).

### The design decision worth recording: parity by construction — and how it was false at first

`reconcileSmartEnvStore` was extracted so **both** backends share it. Last-wins,
tombstones, choosing one model, rejecting a minority dimension, rejecting a zero
norm — all of it happens once, for both. The backends decide *where bytes come
from* and nothing else, so they cannot disagree about what the store says.

**That claim was refuted on its first review, and the refutation is the point.**
The parser collapsed repeats into a Map *per chunk of text it was handed* — and
the two backends hand it different chunks: 803 files, or one blob. A page
re-indexed under a second model in a LATER file therefore survived under both
models when read file-by-file and under only the newer one when read as a blob.
Nothing measured here could have caught it: every vault on this fleet carries a
single model. Parity was a slogan, and the measurement that "proved" it was
blind to the only case where it fails.

The repair makes the claim true rather than defending it. The parser now emits
an **ordered list of record events** and never collapses; the reconciler applies
them. The same event sequence arrives whether it came as one blob or eight
hundred files, so where the text was cut cannot change the answer — and that is
now pinned by tests that reconcile the same content both ways and compare the
model, the vectors, `otherModels`, `incompatible`, and every diagnostic count.

The bridge holds up its end by understanding nothing: it keeps the lines
starting with `"smart_sources:` and drops the rest, which is a restatement of
this router's own first parsing step, not a second opinion about the format.
Verified over 1046 store files on four vaults — 0 divergences.

**Measured end to end on this project's own vault, no stubs anywhere:** disk and
remote both answer `available: true` with 4 pairs, 104 pages compared, a derived
threshold identical to the 16th decimal (`0.9325587591708842`), the same model
and dimensions, all six exclusion counts equal (`notOnDisk: 108`,
`generatedNavigation: 37`, `redirect: 29`, `source: 2`, `withoutVector: 19`) and
a byte-identical coverage sentence. The remote run costs 3.5 s against 0.6 s,
which is the 22 MB store crossing the wire (4.3 MB gzipped, negotiated
automatically and inflated transparently by undici).

### Fixed along the way — four defects the two backends were sharing

Reviewing the seam turned up things wrong on **both** sides, i.e. wrong before
this release and still wrong after it if only the new path had been examined:

- **A record was applied per model instead of per record.** Re-indexing a note
  under a new model rewrites its record; the models the new record no longer
  lists have stopped claiming that page. The reader only ever *added*, so the
  page stayed counted under both — inflating the losing model's coverage, and
  able to hand the winner-by-coverage tie to a model the store had abandoned.
- **…but a model whose slot is CORRUPT has not been dropped**, it just cannot be
  read, so it keeps its claim. Retracting on "no usable vector here" turned one
  bad byte into a deliberate-looking removal.
- **`wiki\p.md` and `wiki/p.md` were two different pages.** The store is written
  by a plugin running on Windows and does emit OS-style keys — measured, three
  of them on this vault. A tombstone for one did not retract the other, and the
  backslash record's vector could never be looked up, because every consumer
  asks in forward-slash form. Folded once now, at the parser's boundary.
- **An unreadable page was reported as a deliberate exclusion.** `coverage`
  lumped it in with generated navigation and exempt types, so a run that lost
  pages read exactly like a run that skipped them on purpose. It is named
  separately now, along with `vanishedDuringRun` for a page deleted between the
  walk and the read — ordinary churn during an editing session, and a different
  fact from a failure.

### Changed — the ways this check declines are now ten, not five

`remote-vault` is **gone**, and its absence is the deliverable: being remote is
no longer a reason the check cannot run. Six reasons replace it, kept apart
because they ask different things of the reader:

| reason | what the reader should do |
|---|---|
| `bridge-route-absent` | upgrade the bridge on that machine — **this one is fixable**. The message also says a proxy can produce the same 404, because from here the two are indistinguishable |
| `store-truncated` | only a prefix of the store arrived; a partial corpus is refused, never compared |
| `store-inconsistent` | the response's own header contradicts its body |
| `store-unreachable` | network, auth or timeout — says nothing about twins |
| `wiki-enumeration-incomplete` | the file list did not come back whole, so no exclusion count can be trusted |
| `wiki-read-incomplete` | pages were lost between the walk and the read. A pair needs BOTH halves, so a ranking built from what arrived would hide twins rather than report none |

`store-inconsistent` exists because trusting `truncated: false` is not the same
as checking it. A response claiming 803 files and 1310 records while carrying
twenty would have been reconciled and ranked — a comparison of a fifth of the
vault, reported as a comparison of the vault. The header is now verified against
the body it arrived with, counts and bytes both.

`wiki-enumeration-incomplete` is the lesson `resolve-vault-path.mjs` had to
learn twice: over REST, an enumeration that *failed* and one that *found
nothing* look identical from here, and collapsing them lets a route that never
answered prove an empty vault.

### Changed — `LOCAL_VAULT_ONLY_TOOL_NAMES` is now empty

It was introduced in v0.79.0 for this one tool. The premise was never "remote
vaults are unanswerable" but "nothing serves that dot-directory" — so the
premise, not the tool, is what changed. The Set is **kept, empty**, with its
reasoning intact: the distinction it draws (a deployment gate versus a per-vault
capability) cost a review to get right, and the emptiness is now pinned by a test
so the invariants below it cannot go vacuously green.

### Tests

- **A parity table, disk vs REST, on one fixture vault**: identical pairs,
  threshold, exclusions, coverage and store diagnostics.
- **The REST path cannot touch the filesystem** — proven by running it with an
  `fs` that throws on every property access, and asserting it still produces a
  real ranking. A leak would otherwise be invisible, since the fixture vault is
  real and would simply have been read.
- Each new decline reason gets its own case, including that the truncated-store
  answer quotes what it actually received, and that a header lying about its own
  body is refused rather than reconciled.
- **Chunk-independence**: the same store content reconciled as N texts and as
  one blob must agree on the model, the vectors, `otherModels`, `incompatible`
  and every diagnostic count.

### Method note

Seven adversarial review rounds, each given the previous round's claims as
input. The first refuted the central one. Severity decayed BLOCKER → MAJOR →
MINOR → none, and **every round's repairs seeded the next round's defects** —
the atomic-record fix for round 2's blocker created round 3's, whose fix created
round 4's. The one finding deliberately *not* fixed is written down as a taken
trade-off, not left silent: folding `\` to `/` in store keys could in principle
merge two distinct POSIX filenames, and is done anyway because those keys are
Obsidian vault-relative paths, which Obsidian never exposes with a backslash.

## [0.81.0] — 2026-08-31 — the self-test now proves WHICH vault answered

v0.80.0 gave the operator a one-click way to check the assumption the router
cannot measure: "my readers click from the machine running Obsidian". It used
`/open/` with an empty path, relying on `path traversal refused` — and it had to
admit, in its own output, that this proves *a* bridge is listening, never
*which*. On a fleet with nine measured port collisions (v0.77.0) that gap is not
theoretical: a neighbouring vault's bridge answers the same message and then
opens the wrong vault's notes.

### Changed — the control link targets `/ping?v=<vault>`

The bridge already serves it, loopback-guarded like `/open`: **200 `{"pong":true}`
when the name matches, 404 with an empty body when it does not** (it never echoes
the name). One request, both questions: the bridge answers from this machine,
**and it is this vault's bridge**. The 404 becomes an actionable outcome — "a
bridge answered, but a different vault's" — pointing at `--check-ports`.

`--with-click-to-open` now prints one link per exported vault rather than one per
port, since the check is per-vault.

**The name sent is the vault's FOLDER name, not the router's config name**, and
that was measured before the line was written: the bridge compares against
`app.vault.getName()`, and on this fleet **4 vaults of 23 differ** — one folder
named `RELEVES ET JOURNAL T1` is called `selarl cabinet dentaire galzy r.` in the
config. Sending the config name would have returned 404 for 17% of the fleet and
led the operator to conclude "wrong bridge" about healthy vaults.

### Not done, and recorded rather than forgotten

The remaining gap — the link carries the note's path in clear, so a reader
clicking where something else listens hands it that path — is **deliberately not
closed here**. On this deployment the operator and the reader are the same person
on the same machine, the flag is off by default, and the self-test now closes the
collision case at setup time. An opaque handle would cost readable links every
day (seeing which note a link points at is a feature this fleet uses, and a repo
hook mandates their use), require a bridge route, and leave two link formats
forever, since every link already written stays path-based.

It flips where the reader is *not* the operator — the KIVES edition, whose MCP
server runs on MCPHub. The accepted `deux-serveurs-un-coeur` decision puts
click-to-open explicitly in the core **shared** by both editions, so the
constraint arrives there by inheritance. It is now an item in the Kiviri unified
roadmap, Phase 1, to be settled BEFORE that click-to-open is implemented — the
only moment the choice is free, since the public edition's format is already
frozen into notes.

## [0.80.0] — 2026-08-31 — closing three gaps v0.79.0 had only named

v0.79.0 shipped with three limits written down honestly and left open. Naming a
gap is better than hiding it; it is not better than closing it. Two are now
closed and the third is answered with a different instrument.

### Added — a one-click proof for the assumption the router cannot check

`gen-remote-config.mjs --with-click-to-open` now prints a self-test link per
exported port.

The router cannot know where its reader sits — it observes its own hop to the
REST API, never the browser that will do the clicking — so `insecurePort` is an
operator *assertion*. An assertion nobody can test is the kind that turns out
wrong on the day it matters. But the bridge already carries its own proof of
identity: `/open` checks the source IP first and the path second, so an **empty**
path passes the first guard and dies on the second with `path traversal
refused`. Only the bridge says that, and only to a loopback caller.

So the operator opens `http://127.0.0.1:<port>/open/` once, **on the machine
where they read their chat**, and the assumption becomes a fact. Verified
against the live bridge while building it: HTTP 403, body exactly that string.

### Changed — `build_open_link` verifies a path with no disk at all

v0.79.0 gave a diskless vault a URL nobody had checked and reported it as
`pathVerified: false`. That check never needed a *disk* — it needs to know
whether a file exists, and the REST API answers that.
`resolveVaultPathViaRest` now mirrors the same five verdicts over `listFilesIn`,
so a local vault is still stat-ed (one syscall beats one round trip) and any
other vault is verified over REST. **`pathVerified: false` now means "this vault
did not answer", not "this vault is remote".**

Two things worth knowing:

- **Cost.** The exact-path check is ONE directory listing, and that is the
  overwhelmingly common case. The basename fallback is a bounded REST walk,
  which is *dearer* than the local `readdir` it mirrors — an earlier estimate of
  mine claimed a single search call would do, and that was wrong: the Local REST
  API's search reads note CONTENT, so it would return notes that mention a
  basename rather than the file that bears it. A batch therefore shares ONE
  enumeration: measured, four paths with three misses cost 7 listings, not 16.
- **A vault that does not answer no longer throws.** "The vault answered but
  could not be fully scanned" (`resolution_incomplete`, actionable — pass the
  exact path) is now distinct from "nobody answered" (`unverifiable`, transient).
  Withdrawing a usable link over a closed Obsidian would have been a regression;
  that is exactly the case `pathVerified` exists to carry.

### Added — the HTTP-only claim is now MEASURED, not read

`tests/no-vault-disk.test.mjs` runs the router in a `node --permission` child
with the vault's directory denied, against a stub REST server, with the key in
the config. A denial there is pronounced by Node's C++ binding layer, **below
JavaScript** — blind to how an import was spelled.

This replaces, rather than supplements, the source-text boundary test in
`tests/ingest-state.test.mjs`: three successive reviews walked through three
successive versions of that test (`import * as ns`, an indirect specifier, a
bare side-effect import), each repair naming a form and missing the next. A
regex over source text cannot answer a question about a module graph.

Lot 0 built this rig once, by hand, and threw it away — it survived only as
prose in this file. It is now permanent, and it carries its own calibration:

- **A positive control**: the harness first proves the vault really is out of
  reach (`ERR_ACCESS_DENIED`). Without it, every other assertion could pass
  because the flag was mis-spelled.
- **A negative control**: the same rig, same vault, same stub, with the key
  declared the OLD way (`portRegistry` instead of `remoteVaults`) comes back
  **red** — the vault loads but cannot be used. An instrument that never says no
  is not an instrument.
- **A liveness check**: the tools must also *succeed*. "No denial" alone cannot
  distinguish independence from a handler that swallows `ERR_ACCESS_DENIED` and
  degrades silently. It is a lock, not a journal.

Its limits are written into the file: `--permission` gates neither child
processes nor native addons, so the twelve conversion tools (a different axis —
local machine, not vault disk) are deliberately out of scope; and it exercises a
curated set, not all fifty tools.

### Fixed — what the pre-push review, and probing alongside it, found

The review was run with the numbered claims as input. **Its two blockers were
both about evidence, not code** — the bench certified things it had not measured:

- **The negative control was confounded.** It declared the vault under
  `portRegistry` and asserted the read tools fail. They do — but a *local*
  vault's baseUrl is built `https://`, and this stub speaks plain HTTP, so every
  call died on `ERR_SSL_WRONG_VERSION_NUMBER` whether the key was readable or
  not. Proven by running a third profile (same config, vault **allowed**) which
  failed identically: **the control would have stayed green with the coupling
  removed.** It now asserts `missingApiKey`, the one observable that isolates
  the disk, and that third profile is kept permanently as the arbiter. The three
  differ at exactly one variable.
- **"The tools must also work" was not implemented.** The harness recorded
  success whenever a promise resolved, which a handler catching
  `ERR_ACCESS_DENIED` and returning `{files: []}` satisfies — the denial test
  and the liveness test would both pass over a tool doing nothing. Every case
  now carries an oracle checking the result contains what the stub holds, and
  the writes are asserted against what the stub **received**, which no handler
  can fake from inside. The oracles caught a real defect on their first run: the
  stub returned an empty `frontmatter`, so `get_frontmatter` had been "working"
  while answering nothing.

A third blocker was a claim, not a bug: this entry said the bench "covers ALL
disk coupling" while the file said "a curated set". Both cannot be true, and a
new tool reading vault disk would have shipped green. Every handler must now be
**exercised, exempt with a written reason, or declared REST-only** — adding one
without classifying it fails. And the bench does **not** replace the
import-boundary test: an unused import performs no denied access, so it sails
through this bench while still breaking the module boundary. Two properties, two
tests, both kept.

Also corrected: a non-404 REST error is no longer called "the vault did not
answer" — a `401` **is** an answer, and the reason (`unauthorized`, `timeout`,
`unreachable`, …) now travels into the `verification` message instead of being
paraphrased; a `200` with a malformed body is a failure rather than an empty
directory, which had let `not_found` be fabricated from an unreadable response;
and the "one snapshot per operation" claim is withdrawn — sharing the walk bounds
the cost and stops the fallback contradicting itself, but exact-path checks are
still separate listings, so a batch is not consistent.

Probing the resolver while the review ran found two more, by comparing the two
backends case by case rather than reading either: a bare **non-markdown**
basename answered `not_found` for a file that exists (the fallback leaned on the
markdown-only walker), and a folder with a **trailing slash** answered
`unverifiable`. Both are fixed, and the comparison is now a permanent table in
`tests/resolve-vault-path.test.mjs`.

**A second pass over those corrections found three more, all of the same kind —
a name or a check claiming more than it measured:**

- **One oracle was itself a false witness.** `list_vaults` was checked by looking
  for the vault's NAME, which comes from the config file. Measured with the stub
  killed: that oracle stayed TRUE while every other one failed — a tautology in
  the middle of the machinery added to stop tautologies. It now requires
  `online: true`, which only a real REST ping produces. And a **fourth profile**
  now points the whole harness at a dead port and requires EVERY oracle to fail,
  so the oracles are calibrated the way the denial is.
- **`UNTESTED_BUT_REST_ONLY` asserted a property nothing measured.** Renamed
  `NOT_EXERCISED_HERE`, with the value of the classification stated exactly: it
  forces a new tool to be classified, and says nothing about the 21 in it.
- **The three buckets overlapped.** Exercised tools were also listed as
  unexercised, which made the classification self-contradictory. A disjointness
  test now derives the exercised set from the RUN rather than from a second
  hand-maintained list, and it caught `append_to_file` immediately.

**A third pass found four more**, and one of them was the same defect class
moved one function down:

- **The fallback walker still coerced a malformed `200` into an empty
  directory** — the exact rule the exact-path branch had just learned, and from
  there `not_found` could again be fabricated from a response nobody could read.
  Both halves now reject it, with the reason attached.
- **A walk that never got off the ground was reported as a partial scan.** "Pass
  the exact full path" fixes nothing when the answer was `401`. A walk that read
  zero listings is now `unverifiable` **with the failure's reason**; one that read
  some and stumbled later stays `resolution_incomplete`.
- **The writes' evidence could not name its author.** Four children shared one
  stub; only one could reach it, by accident of the others' TLS mismatch. The
  config-key profile now has its **own stub on its own port** — isolation by
  construction, not by coincidence — and the assertion compares the request
  BODY, since `bytes > 0` is satisfied by sending `"x"`.
- **`reason` reached user-facing text unfiltered.** It comes from a fixed
  vocabulary today, but "no current caller can do that" is the argument that lost
  twice already in this release. Unknown codes are now reported as unknown.

Two claims were also narrowed to what they support: the three bench profiles do
**not** differ at one variable — only the two local ones form a controlled pair,
the remote one being a positive comparator — and backend parity is claimed for
enumerations that **complete**, since the two walks cap on different quantities
(files collected vs entries examined) and the REST side can hit its ceiling
first. That divergence yields the cautious verdict, not a fabricated one.

One review claim was **refuted by measurement**: a bare folder basename was said
to answer `corrected` on disk and `not_found` over REST. Both answer
`not_found` — the disk walk also excludes directories from its matches — so the
REST walker mirrors it deliberately. The case is pinned in the parity table
rather than left to memory.

**A fourth pass found two more, and both correct a conclusion of mine.**

- **A `404` on the ROOT listing was read as an empty vault.** I had measured
  that the disk backend answers `not_found` there too and concluded the verdict
  was proven. That reasoning was wrong: *agreement between two backends is
  agreement, not proof.* On disk a missing root really is an absent vault; over
  REST a `404` on `/vault/` is a route that did not answer — a wrong endpoint, a
  proxy, an API version without that route. It is now `unverifiable`
  (`root-listing-not-found`), and the divergence from the disk is deliberate and
  tested: **the filesystem can prove absence, an unanswered route cannot.** A
  root that *answers* and is empty still yields a proven `not_found`.
- **Malformed listing MEMBERS were still coerced away.** Validating that `files`
  is an array left `{files: [null, {...}]}` to be skipped entry by entry,
  producing an empty enumeration and, from it, a decisive `not_found` — the same
  defect class as the non-array case, one level finer. A junk member now marks
  the listing failed while the valid members are still used.

Also: the oracle-calibration profile no longer opens an ephemeral port and closes
it (a release-and-reuse race in which the calibration could measure a stranger).
It holds the port and destroys every connection, which is deterministic and is
what that profile actually needs — "no usable response", not "nothing listening".

The self-test's own limit is now stated where it is printed: it proves **a**
bridge is listening on that port, not that it is *this vault's* bridge — this
project measured nine port collisions on a 27-vault fleet — and the machine that
matters is the one whose browser dereferences the URL, which a remote desktop or
a phone can separate from the one you are reading on.

### Compatibility

One externally visible change beyond the additions: a reachable vault whose scan
cannot complete (`resolution_incomplete`) now makes single-mode `build_open_link`
**throw**, where v0.79.0 returned a URL with `pathVerified: false`; batch entries
become error entries. An unreachable vault is unaffected — that is the
`unverifiable` case, and it still returns the link.

### Still open

`find_twin_pages` remains unavailable on a diskless vault: its vector store is a
dot-directory the REST API does not serve, and the honest fix is a bridge route,
not a router change. Making it fall back to the BM25 index was considered and
rejected — the whole contract of that tool is that `available: true` cannot be
falsified, and answering a neighbouring question under the same flag would
destroy the guarantee it protects.

The reader's location still cannot be observed from the router. The self-test
above converts it from an untestable assumption into a checkable one; it does
not make the router omniscient.

## [0.79.0] — 2026-08-31 — the click-to-open link survives the loss of the disk

Lot 2 of the "backend interface, HTTP-only profile as proof" workstream. Lot 1
(v0.78.0) removed the one universal disk dependency — credential resolution.
What remained was **decoration that had become unavailable**: 13 tools emit a
`clickToOpenUrl`, and every one of them emitted `null` for a vault whose disk
the router cannot read, because the plaintext port could only ever be read out
of that disk. `open-in-obsidian.mjs` had recorded the reason verbatim: *"that
helper is local-only only because it must read the LOCAL data.json to find the
insecure port"*. This release removes that reason.

### Added — the plaintext port travels with the vault declaration

Every vault descriptor now carries `insecurePort`, resolved per source:

- **local** — `data.json` first (it is what the plugin binds), then
  `portRegistry[path].http`, which v0.77.0 started recording;
- **`remoteVaults` / `VAULT_*`** — a new **optional** `insecurePort` field, which
  `gen-remote-config.mjs` fills from the source vault's `data.json` **only under
  `--with-click-to-open`**. It is not the default, and the flag prints what it
  assumes: the emitted link is `http://127.0.0.1:<port>/…`, so a reader clicking
  it anywhere other than the machine running that vault's Obsidian sends the
  note's **path and heading** to whatever owns that port on their own loopback.
  `/open` never returns file content, so what the note says never leaves — but a
  path can be `Patients/J. Dupont/diagnostic.md`, and that is a disclosure worth
  opting into rather than inheriting.

v0.78.0 declined to export the number at all, on a surface-area argument resting
on a false premise ("it only serves the *local* click-to-open"). The test
asserting that refusal has been inverted, with the reversal recorded next to it.

### Changed — declaring the port IS the opt-in; `baseUrl` decides nothing

The emitted link is always `http://127.0.0.1:<insecurePort>/…` — the vault's own
host is never interpolated. The bridge's `/open` route accepts only loopback
source IPs, and **that request comes from the reader's browser**, not from the
router. So whether a click works depends on one question the router cannot
answer: is the person reading the chat sitting at the machine running that
vault's Obsidian?

A first draft of this release gated emission on `baseUrl` being loopback. That
was wrong in both directions and review caught it: `baseUrl` describes how the
*router* reaches the REST API — a different hop entirely. A WireGuard-reached
vault whose reader is at the Obsidian machine has a perfectly good link (refused
by the gate); a loopback-reached vault whose reader is elsewhere does not (waved
through by it). The gate is gone. `insecurePort` is optional, and declaring it
is the operator's assertion about their own topology.

A side effect worth naming: with no host test, no vault-supplied string is
examined or interpolated at all — so the userinfo class of defect that held
v0.78.0 for an API-key exfiltration has no surface here to begin with.

When the assertion is wrong the cost is bounded: the click reaches the reader's
own loopback and finds nothing, or finds an unrelated local service and hands it
a note *path*. `/open` never returns file content.

### Changed — `data.json` now has three states, not two

"The file says the plaintext server is off" and "I could not open the file" are
different facts, and only the second one licenses falling back to a remembered
port. Collapsing them (which the old `catch` did) is what made the recorded port
unreachable. A readable-and-disabled vault still yields `null`, with no
fallback — there is nothing listening to fall back to.

### Changed — `build_open_link` now says whether it verified anything

Its whole promise was that a wrong path is corrected or refused rather than
returned as a well-formed URL that 404s. That check needs a local disk. Now that
a diskless vault gets a URL, every result carries **`verified`** (always
present, both ways) and, when false, a `verification` sentence explaining that
the path was not checked.

### Fixed — `find_twin_pages`: a claim the code did not apply

It was documented `LOCAL-ONLY` beside its handler while being absent from
`LOCAL_ONLY_TOOL_NAMES`. The obvious repair is wrong: that Set means *"writes to
the host filesystem, so it must be unreachable on a gated deployment"*, and
`find_twin_pages` writes nothing — adding it would delete a working read-only
tool from a gated-but-local router (the profile this fleet runs) to protect
against nothing. What "local-only" means for it is a property of the **target
vault**, decided per call, which it already reports (`available: false`,
`reason: 'remote-vault'`, and no `pairs` key at all). The distinction is now a
declared `LOCAL_VAULT_ONLY_TOOL_NAMES` set with tests holding three invariants
no comment could: the sets stay disjoint, each member declares the constraint in
its own description, and no member is hidden by gating.

### Measured, not built — `ingest-state`, and a boundary made structural

The estimate listed "`ingest-state` on REST" as lot-2 work. The import graph says
there is nothing to port: the state file is touched only by the `wiki-ingest`
skill, which runs on the machine that has the disks, and by tests. Of the 50
tools, exactly three modules import `node:fs` directly — `lock` and
`set_auto_enrich_mode` write the **router's own** dotenv (not a vault), and
`find_twin_pages` reads the vault and declines cleanly.

Proving that claim took three attempts, and the third stopped trying. Two
successive test versions grepped source text for import forms, and two successive
reviews walked through them (`import * as ns`, then a template-literal specifier
and a `?query` suffix) — a regex over source text cannot settle a question about
module boundaries. So the **disk half moved into `src/helpers/ingest-state-fs.mjs`**,
following the convention already used by `okf-projections-fs.mjs` and
`bm25-index-fs.mjs`. `ingest-state.mjs` keeps the pure half (hashing, URL
normalisation, freshness) and deliberately does **not** re-export the disk
functions — that would put `node:fs` back in its import graph. The invariant is
now a substring no router source file may contain, which no import syntax can
hide. Callers: the `wiki-ingest` skill and the tests import from the new path.

### Fixed — three defects this release introduced, caught before it shipped

An adversarial review was run over the change with its own claims as input.
Three of them were false:

- **The generator lost the three-state rule it was written to enforce.** It
  returned `insecurePort: null` for both "the file says the plaintext server is
  off" and "I could not read the file", and fell back to the registry in both
  cases — so a vault that had deliberately turned its plaintext server OFF got
  the remembered port exported to a router with no disk to correct it. That is
  precisely the state the rule exists to prevent, reintroduced one layer up.
- **The port cache made "a stale value can never win" false.** Introduced in
  v0.14.9, it kept every successful read for the life of the process with no
  invalidation, so a user who disabled the plaintext server, or moved it, kept
  getting the old number until restart. The suite could not see it: every cache
  test resets it in a `beforeEach`. **The cache is now gone.** An intermediate
  repair validated the entry against the file's mtime; a second review rejected
  that too, correctly — two writes inside one filesystem timestamp tick share an
  mtime, so the invariant still could not be *stated*, and the test defending
  the cache had to restore an mtime by hand, engraving the collision into the
  contract. Every call now reads the file. That read is a few-KB JSON against a
  tool call already paying a 68–76 ms HTTPS round trip to the vault; buying an
  unstatable invariant with it was a bad trade. `_resetCache` is kept as a
  documented no-op. The old test asserting the pinning behaviour is inverted,
  with the reversal recorded next to it.
- **`build_open_link` explained a URL that did not exist.** With no plaintext
  port, the result carried `clickToOpenUrl: null` and a sentence reading "the
  URL is well-formed but may 404". The field was also renamed `verified` →
  **`pathVerified`**: it answers whether the PATH was checked, and a real file
  in a vault whose plaintext server is off is `pathVerified: true` with a null
  URL. "Always present" is now actually true — the error branches carry it too.

A **second review of the repairs** then found more, which is why the host gate
above is gone rather than merely re-documented, and the cache removed rather
than mtime-validated. It also found:

- **The generator's equal-port check compared two different sources** — the
  plaintext port from `data.json` against the HTTPS port from the *registry*. A
  stale registry entry therefore accused a perfectly healthy vault of binding
  one port twice, and dropped its link; the inverse case slipped through. The
  generator now reads **both** ports from disk, compares like with like, and
  reports a registry-vs-disk disagreement instead of silently using the stale
  number for `baseUrl`.
- **The `ingest-state` boundary test was a blacklist** of the import forms its
  author happened to think of, and `import * as ingest from '…'` walked straight
  through it. It is now a whitelist: every reference from `src/` must be a static
  named import of one of the module's pure functions, so namespace, dynamic,
  default and re-export forms all fail without anyone having had to predict them.
- **The orphan-naming test passed for the wrong reason.** Its fixture produced no
  pairs at all, so "the deleted page is not named" was true because *nothing* was
  named. It now asserts first that live pages ARE named, and that control caught
  the flaw immediately when added.

A **third review** then found the defect the second round had created, and it is
the one worth naming: the docs called `insecurePort` an operator assertion while
the generator **added it automatically** wherever it found an enabled port — so
the operator asserted nothing, and a note path could reach an unrelated loopback
listener without anyone choosing that. Hence `--with-click-to-open`, off by
default. The same review also found that removing the memo made
`build_open_link` resolve the port **twice per entry** (once for the URL, once
for its markdown twin) and could return a single result naming two different
ports, or a bundle split across two; the port is now resolved **once per
operation** and passed down. Measured rather than asserted: a 50-path
`build_open_link` batch performs **1** read of `data.json`, not 50, and emits 50
links all on one port; single mode performs 1 read for the URL and its markdown
twin together, not 2; the response walker, 1 read for 50 paths. And
the generator's repaired equal-port check still mixed sources when `data.json`
had no usable HTTPS port.

A **fourth review** found no blocker and four more real defects, all fixed:
`opts.port` — the escape hatch the previous round had just exported — was
trusted for merely being defined, so a caller could have built
`http://127.0.0.1:80@evil.example/open/<note path>`; it is now range-checked
whatever its source, because "no current caller does that" is not a guard and
this fleet has met that defect class three times. The exclusion rule from round
3 turned out **overbroad**: requiring both ports from disk only matters when a
PAIR is exported, so without `--with-click-to-open` a `data.json` that omits
`port` (plugins commonly persist only non-default settings) falls back to the
registry with a warning instead of losing the vault. The new boundary test used
`new URL(import.meta.url).pathname`, which breaks on any checkout path
containing a space, and scanned only `.mjs`. And the final error said "no
readable key" for a vault whose key was perfectly readable.

The case for exporting the port was also rewritten: not "it is already written
everywhere" (these links live mostly in tool results, not in notes) but that it
is not an authentication credential, opens no socket, and is only useful to
something already on the Obsidian host's loopback — in a file that also carries
the strictly more powerful bearer key.

Also: a vault declaring the same port for HTTPS and plaintext is reported and
skipped by the generator rather than aborting the whole export; and the
`find_twin_pages` exposure argument now states three checkable premises instead
of asserting harmlessness.

### Compatibility

Additive, with three shape changes worth knowing: vault descriptors now carry
`insecurePort` (often `null`); `build_open_link` results carry `pathVerified`;
and a vault declared with an `insecurePort` now returns a non-null, unverified
`clickToOpenUrl` where it previously returned `null`. `buildRemoteVaultEntry`
also now throws on an `insecurePort` equal to the HTTPS port, where the field
was previously ignored. `_resetCache` still exists but does nothing.

One behaviour change with no config involved: a local vault's `data.json` is now
re-read on every call rather than memoised per process, so an Obsidian-side port
or `enableInsecureServer` change takes effect without restarting the router.

### Still not done

No key rotation or revocation. No per-token authorisation. Functional
equivalence of the remote profile is still unproven — a diskless vault's
`build_open_link` no longer loses its link, but it also no longer verifies the
path, and `find_twin_pages` remains unavailable there. The router still cannot
know where its reader is sitting: a link is correct only under the co-location
assumption the operator makes by declaring the port.

Three gaps named rather than closed. With no cache the router keeps no memory of
a previous disk observation, so a vault whose `data.json` said "disabled" and
then became *unreadable* falls back to the declared port — reviving a value the
disk had refuted. Building a negative tombstone to prevent that would reintroduce
the cross-call state just removed, to save a dead click; a test pins the
behaviour so it cannot change by accident. `build_open_link`'s
`resolution_incomplete` branch is covered by inspection, not by a test: reaching
it needs a vault past the 20 000-file scan budget, which would cost seconds of CI
to cover a literal. And the `ingest-state` boundary test catches an *accidental*
re-coupling, not a deliberately concealed one — `'ingest-state-' + 'fs.mjs'` fed
to a dynamic `import()` would evade any substring rule, and settling that needs a
parsed import graph. The test says so rather than implying more.

A **fifth review** closed the last hole in that test: a bare side-effect
`import './ingest-state-fs.mjs';` needs no `from`, so it slipped past all three
of the checks guarding the pure module. Three drafts had each named an import
form and each missed one — enumerating syntaxes is the losing move. The three
regexes are replaced by one rule: strip the comments, and require the *code* to
contain no occurrence of the name. No import form can name a module without
naming it. Proven in the red: adding that exact line makes the test fail.

## [0.78.0] — 2026-08-31 — the router can run without the vaults' disks: the key moves into the config

**What the measurement found first.** All 50 tools were run in isolated
processes against a throwaway vault, with `node --permission` denying vault
disk at the binding layer — below JS, so injected/named/namespace `fs` imports
cannot escape it. Result: **the only universal disk dependency is credential
resolution.** For a *local* vault, `loadRegistry()` reads the API key out of the
vault's own `data.json` before any handler runs — one bootstrap prerequisite,
paid by all 50 tools, not fifty independent dependencies. With the key in the
config instead, **no tool in the tested set requires vault disk**. That makes
moving the keys the change that unblocks the HTTP-only profile, rather than one
item among several.

### Added — `scripts/gen-remote-config.mjs` (+ `npm run gen:remote-config`)

Generates the configuration of a router that has no vault disks: each selected
vault becomes a `remoteVaults` entry (or a `VAULT_<NAME>=<json>` line) with its
key in the config. `portRegistry` is emitted **empty** — an entry there is
precisely what would send the router back to the vault's `data.json`.

- `--vault <slug>` (repeatable) or `--all`; `--host` (default `127.0.0.1`, the
  remote end of the SSH tunnel); `--format json|env`; `--out`;
  `--print-secrets`; `--default-vault`; `--config`.
- Slug selection is case-insensitive (the fleet really does contain `DEDIBOX`),
  and a genuine case-only ambiguity is refused rather than silently resolved.

### Security posture — the defaults assume a hostile reading

A config carrying N keys grants read **and write** access to N vaults to every
process that can read it; on a host that also runs code agents that is a real
privilege escalation. So:

- **Output is redacted by default** — same shape, `<apiKey>` placeholders — so a
  command run out of curiosity leaks nothing, and the structure can be reviewed
  and committed.
- **No implicit whole-fleet export**: the selection is explicit, and `--all`
  announces the number of keys before acting.
- `--out` **creates** the file at mode `0600` (created, not chmod'd after — the
  gap between the two is readable), and **refuses** to write inside the
  repository, inside any vault, or over a file with looser permissions.
- **No key is ever logged, truncated, or quoted in an error message.** Eight
  characters are enough to correlate a key across a transcript.
- Keys are read **from disk**, never through the plugin API: the same
  `data.json` holds the vault's TLS private key, and only the one field leaves.

### Fixed before publication — four defects found by adversarial review

The release was **held** on the first of these. All four are in code written for
this very release, and all four are proven by execution rather than argued.

- **API-key exfiltration through a host-prefix bypass.** The WireGuard guard
  tested `host.startsWith('10.8.0.')`. A value of the form
  `10.8.0.1<at>attacker.example` passes that test — and interpolated into
  `https://<host>:<port>` the `10.8.0.1` becomes **userinfo**, so the host the
  client actually contacts is `attacker.example` and **the API key goes there**.
  Measured: `new URL(...).hostname === 'attacker.example'`. A string prefix is
  not a network-membership test. Now: a bare-host check (no userinfo, no URL
  delimiters, no glued port) refuses such a value **before interpolation**, and
  membership is a real 10.8.0.0/24 test over a parsed literal IPv4. An honest
  but non-WireGuard hostname is still buildable — it hijacks nothing — and is
  flagged by the guard, because refusing it would forbid every legitimate
  non-loopback host.
- **Literal IPv6 produced an invalid URL** (`https://::1:27126`). Now bracketed.
- **Silent environment-key collision**: `a-b` and `a b` both normalise to
  `VAULT_A_B`, so one vault would disappear without a word. `buildEnvLines` now
  refuses and names both offenders. The JSON format is unaffected.
- **Redaction that only held for well-shaped keys**: the regex stopped at the
  first quote, leaving a suffix in the clear for any key containing an escaped
  quote. It now parses, replaces and re-serialises — and a line it cannot parse
  is silenced entirely rather than half-redacted.

### Tests

- `tests/remote-config.test.mjs` (32) — including a **round-trip**: the emitted
  `VAULT_*` lines are fed back through the router's own `parseEnvVaults` with
  zero warnings, and a generated config is loaded by `loadRegistry` yielding a
  `remote`-type vault and **no local vault at all**. That assertion is what
  stops the generator drifting from the contract it targets — the same class of
  defect as the v0.76.0 seal catch-22.
- Refusal cases proven end-to-end: no selection, unknown slug, writing into the
  repo, writing inside a vault, a vault with no readable key (excluded, never
  emitted mute).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [0.77.0] — 2026-08-30 — the allocator was blind to half the ports, and the reaper was faster than a coffee break

Two defects opened on 2026-08-29, shipped together because they share a
release and a test corpus. Both were **experienced**, not theorised.

### Fixed — the port allocator only ever saw half the ports

`portRegistry` recorded ONE port per vault: the HTTPS one. Every vault also
runs a plaintext HTTP server on its `insecurePort` — the port the bridge's
`/open/<path>` route answers on, and therefore the port every click-to-open
link in every note is pinned to. The allocator scanned
`Object.values(portRegistry)` and took the first absent number, so it could
hand a brand-new vault a port **already bound by another vault's plaintext
server**. Measured on a 27-vault fleet: **9 collisions**, one of them leaving a
vault permanently unreachable (a TLS call landing on a plaintext listener
returns `ERR_SSL_WRONG_VERSION_NUMBER`). The usual damage is quieter and far
worse to diagnose — the second vault to start fails to bind and simply looks
*offline*, with no error anywhere.

- **`portRegistry` now holds `{ https, http }` per vault.** The legacy bare
  number is still read everywhere; `setup-vault.mjs --sync-port-registry`
  converts in place after a **timestamped backup** of `config.json`, and a
  provisioning run reconciles a legacy registry on its own — a legacy registry
  is at its most dangerous precisely when the allocator is about to trust it.
- **Allocation reserves a PAIR and checks the union of both spaces.** A free
  HTTPS port whose plaintext partner is taken is skipped. A stale registry
  declaration keeps its port reserved alongside the disk value: one is bound
  right now, the other is what a repair would put back.
- **`provision_vault` renumbers a copy of the reference vault** instead of
  inheriting its ports and API key. Three of the nine collisions were exactly
  this — vaults folder-copied from `.template` and never renumbered, all
  sitting on the factory 27124/27134. The tell is precise (the target's REST
  credentials are byte-identical to the source's), so a genuinely independent
  vault still keeps its own ports.
- **Collision detection is now reported, not rediscovered.** At router startup
  (surfaced on `list_vaults` as `portCollisions`, logged once per process), on
  `--status`, and through a new read-only `--check-ports [--json]` that exits
  `1` on a real collision so a scheduled task can alert on it. Findings name
  the two vaults, the port, and which side may move.
- **Adoption now checks both spaces.** The old conflict check compared an
  existing vault's port against the HTTPS column only, so a clash with a
  plaintext listener sailed through.

### Fixed — defects in the fix itself, found by an adversarial pre-release review

The change above was reviewed against its own invariants before the tag was
published. Ten defects were found and closed. Most are the release's own defect
class reappearing one level down: **a port written, reserved or reported
without consulting both spaces.** They are listed because the review is the
reason the release is trustworthy, not despite it.

Violations of *"an existing `insecurePort` is never renumbered"*:

- **A port clash with the reference vault was misread as "this is a copy".**
  The copy-detection tell was `apiKey OR port` matching the source. The port
  half was wrong: an *independent* vault that merely happens to sit on the
  reference's HTTPS port was classified as a copy, renumbered **and re-keyed** —
  writing a new `insecurePort` over the one it legitimately owns and killing
  every click-to-open link written to it. Measured on a fixture: `27199 →
  27135`. The API key is now the only tell (32 random bytes; no independent
  vault grows the same one), and a port clash *refuses*, naming the other
  holder and warning what `--regenerate` would cost.
- **The reuse branch preferred a stale registry port over the disk.** For an
  already-registered vault it returned the registry's plaintext port, which the
  caller then *wrote* — putting a stale number back over the live one. Disk
  truth now wins; the disagreement is reported as drift instead.
- **A registered copy was never actually renumbered.** Dropping the target from
  the on-disk map was not enough: its registry entry alone sent the allocator
  down the reuse branch and handed back the very source ports it was supposed
  to move off. Now an explicit `forceFresh`.

Ports created or claimed without checking both spaces:

- **A vault with no `insecurePort` at all got a blind `port + 10`** (the
  pre-v0.10.x population). Now allocated against both spaces
  (`allocateInsecurePortFor`). Nothing is renumbered — there is no plaintext
  port to preserve — but the one being *created* is checked.
- **`--upgrade-insecure-server` could emit an out-of-range or colliding port**
  (`65530 → 65540`; the bump loop could also stop *on* a reserved `65535`). It
  now delegates to the same allocator, so the two paths cannot drift apart.

False reports — the category explicitly held to be worse than no report:

- **A readable `data.json` with no `insecurePort` promoted the registry's stale
  number to "actively bound"**, which could accuse two vaults of fighting over
  a port only one of them listens on. "Readable and says nothing binds" is now
  distinguished from "unreadable, so unknown"; the first is drift, not a
  collision. The number stays held out of new allocations either way.
- **Disabled vaults' ports were never read.** `disabledVaults` hides a vault
  from the tool surface; it does not stop Obsidian from binding its sockets.
  The report was reasoning from their stale registry entries — and `.template`,
  disabled on most fleets, is exactly the vault that hands its factory ports to
  copies. Ports are now read for every registered vault, before the filter.
- **The once-per-process warning latch silenced genuinely new collisions.**
  After one collision was reported and repaired, a *different* one appearing on
  a config hot-reload printed nothing. Now fingerprinted.

Honesty of what is claimed:

- **`--sync-port-registry` did not synchronise stale non-null values**, while
  its success message claimed the registry matched every readable `data.json`.
  Disk is now authoritative in the migration (no port on disk moves; the
  timestamped backup keeps it reversible).
- **The migration dropped properties it did not understand** — `{https, http,
  note: "…"}` lost `note`. A lossless rewrite keeps unknown fields.
- **A failed `patchRestApiData` was recorded as if it had succeeded**: with
  `data.json` missing, nothing was written, yet the caller persisted a
  plaintext port into the registry and returned it as provisioning metadata. It
  now reports what actually reached the disk.
- The drift message described behaviour that had changed, and the adoption log
  line still echoed eight characters of the API key. Both corrected.

Class swept: **3 of 3** code paths that write an `insecurePort` now either
check both port spaces or preserve an existing value.

Two rules the implementation keeps throughout: **an existing `insecurePort` is
never renumbered** (those numbers live in links already written in the user's
notes — when a conflict must be resolved, the HTTPS port moves), and **`http`
is never guessed as `https + 10`**. That offset is the convention applied to
newly provisioned vaults, not a property of the fleet: **15 of the 27 vaults
measured on 2026-08-30 escape it**. An unreadable vault records `http: null`,
meaning *unknown*, and is completed later.

### Changed — `serve-http`'s idle timeout defaults to 4 hours (was 30 minutes)

A 30-minute reap threshold is shorter than an ordinary human work pause. On
2026-08-29 a multi-hour remote session lost the router mid-flight — all 49
tools gone, `CONNECT_TIMEOUT` — while the user was running a script on their
own machine. The server was fine throughout (measured from the box: 200 in
0.4 s, 53 tools, correct 404 on the stale session id); Claude Code simply does
not restore an MCP server that dies mid-session, so the tools were gone for the
rest of the sitting.

The threshold stays **finite** — a dropped tunnel is not a `DELETE`, and the
2026-08-28 spike left six zombie children — but its scale was wrong. The two
failure modes are not comparable: too short costs the user their tools for
hours with no in-session recovery; too long costs one dormant child process
until the threshold. `--session-timeout-min` is unchanged and now documented in
the README (EN + FR), along with the deliberate **non**-behaviour: an unknown
session id gets a `404` and never a silently respawned child, because
resurrecting one would reset the per-session state (vault lock, auto-enrich
mode, once-per-session conformance) under an id the client believes is stable.

### Tests

- `tests/port-registry.test.mjs` (39) — the pure helpers: allocation refuses an
  occupied plaintext port, both pair members are checked, an existing pair is
  never renumbered, migration loses nothing and is idempotent, an unreadable
  vault is `null` and never `+10`, and two spellings of one Windows directory
  do not produce a phantom collision (a false positive found by running the
  detector against the real fleet).
- `tests/port-registry-cli.test.mjs` (14) — the same guarantees through the
  CLI, on synthetic temp vaults: a legacy registry hiding a plaintext port, a
  folder-copy of the template, a lossless migration with its timestamped
  backup, `--check-ports` exit codes, `--status` showing both ports.
- `tests/serve-http.test.mjs` (+3) — the default threshold, that the factory
  actually reads it, and that an unknown session id creates no child.

### Also

- `src/helpers/vault-path-identity.mjs` — `isWindowsPath` /
  `normalizePathForCompare` moved out of `src/registry.mjs` (which now imports
  them) so the port helpers can answer "same vault?" without closing an import
  cycle. Same functions, one definition, still re-exported via `_internals`.
- `README.md` gains a "Port bookkeeping" section and a "Served mode" section,
  both mirrored in the French half.

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [0.76.0] — 2026-08-29 — the C3 catch-22: `plan_vault` couldn't preview what `provision_vault` was about to execute

**The bug, found live.** Provisioning a vault at a path outside the known
roots needs `allowOutsideRoots: true`. `plan_vault`'s MCP schema never
declared it (nor `open` / `probe` / `probeTimeout` / `gitInit`) — only
`provision_vault`'s did. A client that forwards only schema-declared
properties (Claude Code's MCP layer does) drops the field before
`planVaultTool` ever sees it, so the preview seals `exec.allowOutsideRoots:
null` while `provision_vault`'s own (correctly declared) schema keeps the
caller's `true`. The security gate itself passes — only the seal comparison
fails — so the result was a **systematic `plan_drift` refusal for the exact
case the sealed flow exists to protect**, with no way to make preview and
apply agree short of skipping the seal.

### Fixed

- `plan_vault`'s `inputSchema` now declares `open`, `probe`, `probeTimeout`,
  `gitInit` and `allowOutsideRoots` — the same 5 exec options
  `provisionExecOptions()` folds into the seal, mirroring `provision_vault`'s
  declarations. They are still not *executed* during the read-only preview;
  they only need to be present so the seal computed at preview time matches
  the one recomputed at apply time.

### Tests

- A schema-symmetry invariant (`tests/provision-vault.test.mjs`): every key
  `provisionExecOptions()` reads must be a declared property on **both**
  tools — guards the class, not just the one flagged field, so a future exec
  option added without updating `plan_vault`'s schema fails here instead of
  resurfacing live.
- An end-to-end regression (`tests/plan-seal-integration.test.mjs`) that
  simulates a client forwarding only schema-declared properties through the
  full `plan_vault` → `provision_vault` flow with `allowOutsideRoots: true`:
  red before the fix (the exact reported `plan_drift`), green after.

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [0.75.0] — 2026-08-28 — the router, served: remote sessions reach the local instance over authenticated streamable HTTP

**The gap this closes.** Remote Claude Code sessions (an SSH-tunneled dev box)
need the router's full feature set, but 11 of the router's `src/` files
legitimately touch the vaults' DISK — porting the router would ship it half
broken. The accepted decision (vault page `http-only-comme-interface-de-backend`)
is to not port it but **serve** it: the router stays home with its disks, and
remote sessions consume it as a streamable-HTTP MCP server through the existing
SSH tunnel. The measured spike behind every design constraint below lives in the
vault roadmap `servir-le-routeur-roadmap`.

### Added — `scripts/serve-http.mjs`

- Serves the local router as a streamable-HTTP MCP endpoint (default
  `127.0.0.1:27300/mcp`), **one child stdio router process per MCP session** —
  the same isolation every stdio session already has, measured rather than
  assumed: a vault lock taken by session A is invisible to session B.
- **The loopback bind is deliberately not configurable**, and bearer auth is
  enforced on POST, GET and DELETE alike — the tunneled port lands on the remote
  box's loopback, where every local process can reach it, so the bearer is the
  actual boundary. Constant-time comparison; the token never appears in argv,
  in logs, or in the child's environment.
- **Finite idle session timeout** (default 30 min, `--session-timeout-min`): a
  tunnel drop is not a DELETE — without reaping, vanished clients leave zombie
  children (six were measured in the spike). An explicit DELETE still terminates
  the session and kills its child immediately.
- Children are spawned as `process.execPath` + entry file, **never through a
  shell** — a shell-spawned child hides behind a `cmd.exe` intermediary and
  survives naive kills.
- The token comes from `OBSIDIAN_ROUTER_HTTP_TOKEN` or
  `~/.claude/obsidian-mcp-router/serve-http.token`; the script refuses to start
  without one — an unauthenticated listener is the one state it must never reach.

### Tests

- `tests/serve-http.test.mjs` (5 tests, wired into `npm test`), each proven
  against real child processes (a stateful stdio fixture, not mocks): auth
  refused on all three verbs; two concurrent sessions isolated (distinct pids,
  no state bleed); DELETE kills the child; the idle reaper kills the child of a
  client that vanished without DELETE; the listener binds `127.0.0.1` only.

## [0.74.0] — 2026-08-09 — vaults keep themselves conformant, in three moments — and one race we did not close

### Added — automatic vault conformance: birth, opening, contact

**The gap this closes.** A router-managed vault carries two *derived* artefacts:
the OKF navigation projections under `wiki/` and the local BM25 search index
`wiki-meta/search-index.json`. Neither had a reliable trigger. The index was an
opt-in nothing ever called — so on a vault without Smart Connections,
`search_smart` had **no tier left** and failed outright instead of degrading.
The projections drift because the debounced middleware only sees writes made *by
the router*; a folder created by hand in Obsidian leaves them stale. Coverage is
now the **union of three moments**, and the docs describe it with its holes
named, not as a promise that every vault is always conformant.

- **Birth (provisioning).** A vault comes out of the scaffolder carrying its OKF
  projections *and* its `wiki-meta/search-index.json`, generated on disk (Obsidian
  is not open yet) with a temp-file-plus-rename write so a crash mid-write cannot
  leave a half-written index. Idempotent by fingerprint: re-scaffolding rewrites
  nothing.
- **Opening (the bridge plugin).** When a vault finishes loading in Obsidian, the
  companion `obsidian-mcp-router-bridge` verifies that the generated navigation
  files are all present and shows a Notice if any are missing. **Detection only —
  the bridge never generates.** Per-vault switch, **default OFF** (the bridge
  auto-updates through BRAT; a Notice appearing by itself in every vault would be
  an unannounced change).
- **Contact (the router).** The first time a session touches a router-managed
  vault, the router refreshes the drifted projections and rebuilds the missing or
  stale index. Once per vault per session, debounced, and all four rebuild paths
  (the post-write flush, first contact, `refresh_okf_projections`,
  `build_search_index`) go through **one per-vault lock**, so two rebuilds of the
  same vault never race inside one process.

### Fixed / hardened

- **An incomplete enumeration is a retryable, *noisy* failure — not a silent
  success.** A transient REST outage on a directory listing makes the cores
  *return* a skip (they fail closed rather than delete an index for a directory
  that merely did not answer). That skip now marks the maintenance pass NOT
  successful, so first contact keeps the vault retryable and spends its bounded
  budget; on exhaustion it logs loudly rather than leaving `search_smart` broken
  in silence.
- **Birth and contact write the same root-index title.** The disk generator was
  defaulting the root `wiki/index.md` heading to the on-disk basename while the
  registry resolves the vault by its lowercased slug, so the very first session
  rewrote the file for a title that only differed in case. Both now stamp the
  canonical slug.

### Reserved-path writes — window **reduction** and **non-destruction** (F3-b)

The refresh/rebuild paths read the vault, plan, then write. Between the read and
the write a foreign file can appear on a reserved path (`wiki/<dir>/index.md`,
`wiki-meta/search-index.json`) — realistically a sync client (Obsidian Sync,
LiveSync, Dropbox, iCloud) materialising it. The old apply overwrote it blind.

The automatic path now **reduces** that window and guarantees **non-destruction**:
foreign content on a reserved path is never lost without a recoverable copy.
Either the write is refused and the foreign file is left as it was (the
cooperative-CAS route via the bridge, and the strict opt-in), or — when the only
available write is unconditional — the foreign bytes are copied to a unique
timestamped sidecar *before* regenerating, and the result names that backup. The
mode actually used is reported (`atomic-cooperative` / `reduced-getcompare` /
`skipped-strict`). Destructive deletes are **never** performed automatically: a
stale generated `index.md` is reported as `pendingDeletes`, not removed.

**Stated as a LIMIT, not a closure.** This does **not** close the race, and
cannot: the check and the write are two operations against a store other writers
touch in between. It is **not** safe against a plain native `PUT /vault` (the
router's own default write), the open Obsidian editor, or an Obsidian Sync /
LiveSync apply — inherent to optimistic concurrency. Two residual data-loss
paths are documented: a file landing strictly inside the read→PUT sub-interval
(the late read could not see it, so it is not backed up), and — for the
*create-if-absent* case — a backend that ignores the `Apply-If-Content-Preexists`
header, where a create in the window becomes an ordinary overwrite. Closing
either would require every writer to cooperate, which is out of the router's
reach.

### Compatibility

- `OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS` now disables only the **projections** half
  of the flush and of first contact; the scheduler keeps maintaining the BM25
  index.
- New: `OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE` (off the contact moment; also off
  under `OBSIDIAN_ROUTER_READONLY`, since repair writes) and
  `OBSIDIAN_ROUTER_STRICT_RESERVED_CAS` (skip a racy reserved-path overwrite on a
  backend without cooperative CAS, instead of the reduced backup path — zero
  foreign overwrite, at the cost of skipped repairs).

## [0.73.0] — 2026-08-08 — the tools were universal, the manual was not

### Added — `AGENTS.md`, a portability audit, and a skills-index installer for four other hosts

**The gap this closes.** Every MCP client can call the router's 50 tools; the
tool schemas travel by themselves. What did not travel is the operating
know-how — how to run an ingestion, which disciplines apply, which traps have
already been paid for — because all 47 pages of it are written in Claude Code's
skill format. An agent arriving through Codex or Gemini had the commands and no
manual.

**`AGENTS.md` at the repository root.** The host-neutral operating contract, in
plain markdown, at the repo-root path Codex reads natively — proven here by a
live pass, not assumed. It carries the repository layout, the three gates, the
contracts, the bridge rule (when a request matches a skill, read its `SKILL.md`
in full before acting; a missing host capability is declared, not imitated),
source precedence (`skills/` is canonical; `mcpb-staging/` and worktree copies
never are), and the house rules that are not obvious from the code: measure
rather than recall, no green without a mutation, never restore with git, tests
never write outside a temp directory, and the one directory nothing may open.

It is treated as code rather than documentation, and that is the whole point.
A stale line in a README costs a reader ten seconds; a stale line here is read
automatically by every agent, on every host, in every session, and acted on
before anyone notices. So `tests/agents-md-contract.test.mjs` resolves every
path it names against the filesystem, every command against `package.json`, and
the node version against `engines`. The check found a defect in the file on its
first run.

**`npm run install:agent-rules` — preview-first, seven targets, five hosts.**
Writes a per-skill index (name, one sentence, path to the `SKILL.md`) into the
rule file each host actually reads — an index of the skills, deliberately not
an installation of them: nothing here makes a foreign host *execute* a
`SKILL.md`, and the docs say so.

| Host | Scope | Target |
|---|---|---|
| AGENTS.md (portable) | project | `AGENTS.md` |
| Codex | user | `$CODEX_HOME`/`~/.codex` + `AGENTS.md` |
| Gemini CLI | user · project | `~/.gemini/GEMINI.md` · `GEMINI.md` |
| Cursor | project | `.cursor/rules/obsidian-mcp-router-skills.mdc` |
| Windsurf | project · user | `.windsurf/rules/…md` · `~/.codeium/windsurf/memories/global_rules.md` |

Preview is the default and writes nothing — every target but one is a file in
the user's home or in a repository this tool did not author, so the run that
writes is the one that had to be asked for. Same HTML-comment markers as
`--install-global-convention` (v0.13.9) and the same refusal: a `BEGIN` with no
matching `END` is reported `ambiguous-state` and left alone, because an
installer that guesses where a half-deleted block ended eats the paragraph
after it — and the refusal covers every unbalanced shape, including a stray
marker after an otherwise complete block. Re-runs are no-ops, `--uninstall`
returns the file to its original bytes when the block is where an install put
it, `--host` / `--scope` / `--skills` narrow the plan, apply re-verifies the
target's bytes and refuses a file that changed since the preview, writes are
atomic (temp file + rename), and a sidecar backup precedes every destructive
mutation. The preview announces that backup and the full chain of directories
an apply will create — the one defect proven in this cycle's verification was
an upgrade preview that under-declared its sidecar, and an under-declaring
preview is the worst defect this tool can have. Uninstall removes the block,
never the file, and says so before you apply.

Host knowledge lives in `contracts/agent-host-targets.json`, not in the
installer, and every target carries the **provenance** of its path — the
preview prints it, so the user can see which location was confirmed and which
is taken on a vendor's word.

**Two behaviours that came from reading the hosts' limits instead of assuming
them.** Windsurf caps global rules at 6,000 characters and the full index does
not fit, so the renderer has a compact mode; a target that cannot fit even the
compact form is **refused** rather than truncated: the skills past the cut
would look like skills that do not exist.

**The file the installer cannot open.** `.codex/config.toml` is gitignored,
holds a live bearer token, and was once shipped inside a released `.mcpb`
because a deny-list build did not know the directory existed. "Be careful
around it" is not a design, so: every target path is constructed by joining a
contract base with a contract `file` (no path comes from user input),
`assertSafeTarget()` re-checks the resolved extension **and** basename against
the contract, and `assertSafeFile()` refuses a target whose final component is
a symlink. The claim is "no code path names a file the contract does not
name", not "the process cannot read" — the wider version would be false, and a
false security claim is worse than none. Proven behaviourally: a fake home
holding a canary token is driven through preview, apply and uninstall, and the
canary is hunted in every byte of output and every written file.

**`npm run audit:skills-portability`.** The Agent Skills spec admits exactly six
frontmatter keys; Claude Code accepts about twenty and ignores the rest, while
the spec distribution paths reject the whole file on the first unknown key — so
an extra key costs nothing right up until it costs everything. Measured:
**42/47 skills carry spec-only frontmatter**, longest description **903/1024**;
the other 5 use `argument-hint`, declared in the contract as an accepted Claude
Code extension with its reason. Undeclared keys are errors, declared ones
warnings, `--strict` collapses the two. The limit is **1024**, quoted from
https://agentskills.io/specification and pinned with its access date — NOT the
1,536 figure in the Claude Code docs, which is where that host truncates its
skill LISTING. Pinning the looser number reported a clean run over 47 skills
while 3 were invalid; those three descriptions were shortened and the displaced
text moved into the skill bodies.

### Verified

The live check is a real `codex exec` pass, not a simulation: `codex-cli
0.146.0` reads `AGENTS.md`, is asked for the contract handshake, and must reply
`AGENTS-OK skills=47` — a number deliberately absent from the file, so the
answer is only reachable by running a measurement. Removing the handshake
section from `AGENTS.md` turns that test red, which is what makes the green
mean anything. It is opt-in (`ROUTER_CODEX_LIVE=1`) and, when the binary or the
opt-in is missing, skips with the reason in the test name rather than passing
quietly. It runs with `--ignore-user-config`, which is both safer and more
reliable: it keeps the check away from the token-bearing `config.toml`
entirely, and measured 4/4 correct at 15–33 s against 3/4 at 63–135 s with the
user config loaded — the one failure in that first sample being the finding,
not the noise: unable to run a shell command, the model web-searched for the
count and answered 39.

The whole feature went through a three-voice cycle: an independent second
design (Codex — reviewer and target host at once), a cross-review of the built
design against it, then an execution-based verification of sixteen stated
guarantees — preview filesystem-diffed to zero writes, announced-equals-done
byte for byte, user text outside markers surviving install/upgrade/uninstall,
a canary-loaded fake `CODEX_HOME` never leaking into any output or file,
ambiguous marker states refusing in four shapes, a poisoned `AGENTS.md`
turning all four export gates red, and the live test proven in its three
states. One defect survived to be proven — the upgrade preview above — and was
fixed and independently re-proven. The cross-review also corrected the audit's
limit from 1536 to the spec's 1024; in the other direction, the Windsurf
provenance note it challenged was confirmed against the vendor's live docs.

Suite **3822 tests, 3821 pass / 1 skipped** (the opt-in codex pass), 0 fail —
**+87** on the 3735 baseline. `npm run validate`, `npm run gate` and the
release-target scan all exit 0.

## [0.72.0] — 2026-08-07 — twin pages: every vault gets its own threshold

### Added — `find_twin_pages`, and the number that says when two pages are too close

**A 50th tool, read-only and deterministic, no LLM in the loop.** Over time a
vault manufactures near-duplicates: two pages on one subject, born in two
different sessions. Links, searches and updates then split between them and
neither is ever complete. `find_twin_pages` compares the per-page vectors Smart
Connections already stores on disk (`<vault>/.smart-env/multi/`), every page
against every other, and reports the suspicious pairs. It is surfaced in
`wiki-lint --deep` as **Check J-bis** — the extension of Check J (Jaccard over
digest concepts) into cosine, not a second mechanism beside it. Severity is
`info`, never higher: two pages that resemble each other are not a broken state.

Measured across the real fleet: **7 usable vaults, 383 comparable pages, 18 512
pairs, 33 pairs reported, 1 354 ms total** (85 ms/vault average). The archetypal
find, on the KIVIRI vault: exactly three pairs, all three roadmaps
(`kiviri-roadmap` / `saas-web-app-roadmap` / `kiviri-app-build-roadmap`) for what
is plausibly one thing.

#### A fixed threshold is not merely crude — it is measurably wrong

At `cos ≥ 0.95` the same number behaves in opposite ways: the router vault yields
**93 pairs / 14 535** (97.8 % precision against a content oracle), SchoolMouv
yields **398 / 13 366** at **12.1 %**. Their medians differ (0.746 vs 0.845)
because one is a heterogeneous project journal and the other a homogeneous course
catalogue. One is a good filter, the other a flood.

The obvious repair fails too, and for a structural reason: a robust z-score on
raw cosine leaves the domain, because cosine is bounded by 1 — **the threshold
exceeds 1.0 from k=4 on four of six vaults**. So the statistic moves to the space
where the variable is unbounded:

```
threshold = 1 − exp( median(ln(1−cos)) − k · 1.4826 · MAD(ln(1−cos)) )
```

Median and MAD rather than mean and standard deviation because **the twins are in
the sample** — a vault holding many of them would inflate a standard deviation
until it hides what you are looking for. `k = 5` is a **declared convention, not
a calibration**: nothing was tuned to it, it is exported, adjustable per call, and
reported in every answer. Thresholds actually derived on the fleet range
**0.8789 → 0.9800**, tracking medians of 0.687 → 0.859. Threshold, vault median
and sample size travel with every response, so the result is auditable and
replayable.

#### The spec's bound is implemented, and is not the default

Restricting comparison to "same folder or shared links" is available
(`restrictTo`) but off by default, on measurement. Of the 33 pairs above
threshold, `folder` alone keeps **9/33 — it discards 72.7 %** (and 23/23, i.e.
100 %, on SchoolMouv, whose twins live in sibling folders); `folder-or-links`
keeps **33/33**, discarding nothing at all. On this fleet the bound is either a
73 % recall cut or a no-op — never a useful middle. And it buys no time: its
prerequisite (reading every page body) cost **11 ms against the 7 ms** of dot
products it would avoid. The loss also lands exactly where it hurts most: two
genuine twins born in two sessions are precisely the pair that shares neither
folder nor link.

Folder and links are therefore shipped as **triage evidence on each row**
(`sameFolder`, `sameBasename`, `sharedLinks`, `linked`) rather than as an upstream
filter, and `removedByRestriction` is always reported. Note that `folders` and
`restrictTo` are deliberately asymmetric: `restrictTo` filters *pairs* after
derivation (same corpus, same threshold), while `folders` filters *pages* before
it — **a scoped run answers a scoped question**, and the same pair may be
reported at one scope and not another.

#### "Unavailable here" is a different answer from "zero pairs"

Structurally, not by convention. Five reasons return `available: false` **with no
`pairs` key at all** (`no-embeddings`, `remote-vault`, `no-wiki`,
`corpus-too-small`, `no-spread`); a sixth is a thrown refusal
(`too-many-pages`). **9 of 16 vaults are unavailable** — none of them reports
zero. A consumer writing `result.pairs?.length ?? 0` would read all six as "no
twins found", which is why the key is absent rather than empty, and why the field
to branch on is **`available`**.

#### The response tells the truth about what it did

`coverage` says it in words — *"104 of 113 eligible page(s) were compared… 180
markdown file(s) exist under wiki/, of which 67 were held out"* — because
`available: true` does not mean the whole vault was analysed. `freshness` states
that the vectors are an **index snapshot** whose per-page staleness is *unknown*.
Every exclusion is counted: **108 of the 279** indexed paths in the router vault
point at pages that no longer exist, and generated projections and `redirect`
stubs are held out (29 stubs alone produced 406 spurious pairs). The accounting
identity `comparedPages + withoutVector + incompatibleVector + heldOut ===
wikiPagesOnDisk` holds, and a vector that exists but cannot be compared (minority
model, minority dimensionality, zero norm) is reported as such rather than as "no
vector".

**A pair proposes a reading, never a merge.** No field names an action, and a
bilingual EN/FR guard extends to the skill's prose.

### Known limits — measured, not glossed

- **Templated series are the dominant false positive.** Vectors are whole-page and
  the model window is 512 tokens, so two pages sharing a boilerplate head score
  very high: measured **cosine 0.9914 for a 5-shingle overlap of 0.064**.
  `sameBasename` rides on every row to make the pattern visible at a glance.
- **Cost at the ceiling.** `MAX_PAGES = 3000` costs **5 777 ms and 737 MB peak
  heap** — unconditionally, even to report 4 pairs, because deriving the threshold
  copies the pair array five times. `MAX_PAGES_CEILING = 5000` is the largest size
  actually executed (17 801 ms, 2 024 MB); nothing beyond that was measured, so
  nothing beyond it is permitted. The check **refuses** rather than silently
  truncating. No real vault comes close: the largest of 16 holds 180 comparable
  pages, 17× under the ceiling.
- **The emitted array is bounded (`limit`, default 10, max 100) but the
  intermediate one is not**: 198 pages / 19 503 pairs materialised 6 435 row
  objects to emit 10.
- **`k = 5` is unvalidated outside this fleet** — seven vaults, all indexed with
  `TaylorAI/bge-micro-v2` (384 dims). The method adapts to any distribution; the
  default constant has only been read on one geometry.
- **The store is a snapshot with no usable freshness hash.** A page edited since
  indexing carries its old vector, and per-page staleness cannot be determined
  from here. Gross drift is visible (`excluded.notOnDisk`); fine drift is not.
- **Block-level embeddings are not used** (`smart_blocks:` exists in the store),
  so "a section of A duplicates a section of B" is out of scope.
- **No lexical tier**: `wiki-meta/digests/` exists in none of the 16 vaults, so the
  digest substrate is unused; Check J already covers that ground where digests do
  exist.
- **The sort tie-break is unfalsifiable.** Deleting `cmp` from `rows.sort` breaks
  no test — the path pre-sort plus stable `Array#sort` (ES2019) make its effect
  unobservable. Kept as insurance and annotated in the code so nobody reads it as
  a tested guarantee.

## [0.71.0] — 2026-08-07 — normalization left the 36 tools for one boundary

### Changed — normalization left the 36 tools for ONE boundary

**Tools now return raw, and a single function normalizes on the way out.** Every
tool used to sanitize its own result: 36 places to remember, and one forgotten
site was enough for a hostile byte to travel. `wrapResult` in `src/index.mjs` now
does it once — and, critically, *after* the dispatcher has consumed the raw
values for the view-link and the audit line.

That ordering is not tidiness, it fixed a functional bug no per-tool approach
could reach: the dispatcher re-read an **already-escaped** path to compose the
view-link, so a perfectly legal POSIX filename produced a link to a note that did
not exist. Sanitizing an **identity** that downstream code still has to use
cannot be made correct by vigilance — only by doing it last.

Three output channels are covered, and it took three review rounds to finish
counting them: tool results (through `wrapResult`), the error channel
(normalized centrally at the dispatcher's `catch`, where `Error: ${err.message}`
used to render any other throw verbatim), and **MCP resources** — a second wire
registered straight onto the SDK that fifteen rounds never touched. The typed MCP
payload is no longer a passthrough: every field is normalized **except `data`**,
excluded **by name** rather than by type, so a future non-string field cannot
inherit the exemption by accident the way `_meta` and `annotations` did.

#### What changes for a caller

- **The bytes returned change on roughly twenty tools.** Normalization is now
  uniform and applied without truncation. A client comparing result strings
  character-by-character may see differences.
- **Some paths that used to be accepted are now refused.** `canonicalVaultPath`
  rejects anything the sanitizer would rewrite, plus the three whitespace
  controls — carriage return, newline **and tab** — plus unpaired surrogates.
  Measured across the real fleet: **0 refusals**, see the table below.
- **OSC handling changed**, and `execute_template` canonicalizes `name`
  unconditionally.

### Changed — BREAKING: one definition of what a vault path is

**`isSafeVaultRelativePath` is gone; `canonicalVaultPath` is the only answer.** The repo carried two predicates for one question and they disagreed: the looser one accepted C1 control characters including U+009B (a one-character ANSI CSI), bare `.` segments, `<result>`-shaped markup, `C:` without a separator, U+2028/U+2029 and mid-string backslashes. Each of those classes is pinned by name in `tests/security-invariants.test.mjs`, against the surviving predicate. *(An earlier draft of this entry quoted a "688 of 3 074 inputs" disagreement rate. The number is removed rather than restated: the loose predicate is deleted, so nothing in the repo can reproduce it, and a figure that reads as evidence but cannot be checked is worse than no figure.)*

`build_wiki_graph.pagesDir` was converted in an earlier round; the last caller — the `get_wiki_context_pack` catalogue drill, which reads wikilinks out of the vault-writable `wiki-meta/catalog.md` — is converted now, and the function is deleted so there is no second answer left to reach for. A poisoned `[[evil<result>]]` used to send `wiki/evil<result>.md` to the REST client.

What changes for a path that used to be accepted, exactly:

| form | before | now |
| --- | --- | --- |
| a backslash — `wiki\sub`, `a\b.md` | treated as ordinary text (one innocent-looking segment) | **REFUSED** — a backslash is not a separator here, so containment cannot be verified |
| a `.` segment — `./wiki`, `wiki/./sub` | passed through, or silently converted | **REFUSED** — only `..` was ever checked for |
| a leading slash — `/wiki/a.md` | refused | **NORMALISED** to `wiki/a.md` |
| a trailing slash — `wiki/a.md/` | normalised | unchanged, still normalised |

Swept over the repo: no production caller of a converted site, and no skill, slash command, doc or example, uses the removed forms. Some **tests** do — deliberately, as negative fixtures — so the earlier claim of "no caller anywhere" was too absolute. (The `okf-bundle-exporter` fixtures that spell `wiki-meta\hot.md` and `./wiki-meta/log.md` feed that exporter's own normaliser, which is a separate path and unchanged.)

And the fleet claim now comes with its measurement — **and with its scope**, which is half the claim. Measured **2026-08-06**:

| corpus | command | files | refused | renormalised |
| --- | --- | --- | --- | --- |
| the 21 **configured** roots, vault content | `node scripts/measure-vault-path-shapes.mjs` | 4 795 (3 937 md) | 0 | 0 |
| the 21 configured roots, plugin trees included | `… --all` | 10 239 | 0 | 0 |
| **the 26 roots that exist on disk**, vault content | `… --root "C:/VAULTS/PitEcho" --root …` (5 strays) | **5 070 (4 187 md)** | **0** | **0** |

Three corrections to what was published, all in the same direction — the entry claimed more scope than it measured and less accuracy than it had:

- The numbers were stale by one file (**4 794 / 3 936 / 10 238** written, **4 795 / 3 937 / 10 239** measured). Re-measured above rather than restated.
- "The fleet" meant the 21 roots `portRegistry` lists. **Five more vaults exist on disk** and were never in the sweep. Passed with `--root` now, and the conclusion holds *better* than published: 5 070 files, still zero refused, still zero renormalised.
- `walk()` swallowed `readdirSync` errors, so an unreadable subtree counted as **zero files** and "0 refused over N" could describe a corpus that was never read. The script now counts and prints `unreadable : N subtree(s) skipped mid-walk`, marks the file count a lower bound when N > 0, and prints the line even at zero — because absence of a line is not evidence. (N = 0 for every corpus above.)

The script is in this release precisely so the next reader can re-run it instead of trusting it.

Refusal is **per link, never global**, at the one site that reads paths out of a vault file: a poisoned wikilink cannot deny the whole context pack. See the `get_wiki_context_pack` entry below for what "dropped" now actually means — in the first draft of this release it did not mean what it said.

### Fixed — the audit journal records what was written, and only once

The journal line has to be four things at once: readable, **unforgeable** (no character of the payload may spell the structure), **distinguishing** (two files, two lines), and bounded. Three successive rounds fixed one of those and broke another, because unforgeability was bought by MUTILATING characters and distinctness by ESCAPING them, in two functions thirty lines apart — and mutilation is many-to-one. This release stops treating them as competing goals.

**And it stops claiming a property that cannot exist.** Three rounds asserted the line is "bounded **and injective**". It cannot be both: each part is capped at ~440 characters and the input is unbounded, so by pigeonhole some pair must collide. The claim is replaced by two that are separately true and separately testable — **below the cap the rendering really is injective** (every escape is reversible, nothing is collapsed), and **above it, collision-resistant**: a sha256 **widened from 64 to 128 bits**, taken over a lossless encoding, alongside the 360-character prefix and the exact original length. Finding a collision now means breaking sha256 rather than finding the pigeonhole. This is a correction to the *specification*, not only to the code: the version of the claim that could not be true was also the version nobody could test.

- **One construction instead of two.** `pickAuditPath` no longer returns a rendered string; it returns the *parts*, and `formatAuditLine` escapes each caller-derived part and then adds the structure — the separators, the parentheses, the words `path(s):`, the `(+N not shown)` notice — as router text on top. A payload cannot spell any of it because everything it contains is already escaped, and nothing is mutilated, so the distinctions that come in survive. Text the router chose (`(unknown)`, the fixed targets) is tagged as such and printed verbatim, so the readable sentinels stay readable instead of becoming `%28unknown%29`.
- **2 047 different writes shared one journal line, byte for byte.** A JS string is UTF-16 code units, so `wiki/a\uD800.md` and `wiki/a\uD801.md` are distinct strings — and nothing in the guard objected, because an unpaired surrogate is neither a control byte nor markup. But the line is **appended over UTF-8**, where an unpaired surrogate has no encoding and becomes U+FFFD. Measured over the 2 048 of them: `distinct JS strings: 2048`, `distinct UTF-8 wire bytes: 1`. Two independent defects, two fixes: the truncation digest hashed `utf8` (lossy over exactly these) and now hashes `utf16le`, which closes the *long*-path case; and `canonicalVaultPath` **refuses unpaired surrogates outright**, which is the only thing that can close the short-path case — a twelve-character path never reaches a digest, and the collapse happens when the finished line is encoded. Cost: zero of the 5 070 files on the real fleet, and none is possible — the REST API addresses notes over UTF-8 JSON, so such a file is unreachable through this router either way. *(Two reviewers disagreed about whether this class existed. It does; the sweep that found none used surrogate **pairs** cut at the truncation boundary, never a lone one.)*
- **`write_bundle` fused four distinct characters into one.** The previous fix collapsed `,`, `(` and `)` to `;` inside every path, which made `wiki/a,b.md`, `wiki/a(b.md`, `wiki/a)b.md` and `wiki/a;b.md` produce one identical line — **569 collisions over 8 972 distinct canonical paths** on that branch, against 0 on `write_file`, which the collapse never touched. Those characters are now percent-escaped like the rest.
- **The 400-character cap bounded nothing.** It was applied *before* escaping, so a 408-character path reached the file at **1 051 characters**. It is applied after escaping now, and the line has a real bound.
- **Above the cap, 5 000 distinct paths produced one line.** The only discriminants surviving truncation were the shared prefix and the original length. The truncation notice now carries a **sha256 digest of the original path**, and the same treatment closes a second hole found by the pin that closed the first: only ten bundle paths are shown, so two twelve-step bundles differing *only in their eleventh and twelfth targets* were byte-identical records. The omission notice now digests the hidden tail.
- **`sanitize`'s own truncation notice reached the journal.** It is bracketed, so it arrived as `…%5Btruncated by sanitize: original was 608 chars%5D` — exactly the defect the bundle notice was parenthesised to avoid, in the module next door. The audit path no longer lets that truncation fire.
- **`execute_template` journalled the raw argument, not the file it wrote.** A call the bridge received as `Sessions/today.md` was journalled `/Sessions//today.md`. The audit path is canonicalised now. *(The comment added last round claimed the handler had already canonicalised this value. It had not — `pickAuditPath` re-reads the original arguments. The comment is corrected too; a false comment about a security property is its own defect.)*
- **Four `write_bundle` calls were journalled as recoveries while writing their real steps.** The dispatcher routes on `normalizeRecoverArg`, which reads `"false"`, `"0"`, `"no"` and `"off"` as an ordinary bundle — the field is a `boolean|operationId` union because a real client was observed sending the string `"true"`. The journal used bare truthiness and disagreed with the handler.
- **A path containing `"`, `[` or `]` was journalled under a different name.** Those three were collapsed to `'`, so two different files could produce the same line — the same divergence that got a tab refused outright. They are now **percent-escaped** (`%22`, `%5B`, `%5D`, with `%` escaped first so the encoding stays reversible): `Notes [draft].md` stays legible as `Notes %5Bdraft%5D.md`, no literal bracket survives to forge a record marker, and the rewrite is injective. Refusing brackets upstream was rejected — they are ordinary in Obsidian filenames.
- **The one write target that skips the canonicaliser could name two directories with one line.** `download_page_assets.outputDir` is an absolute filesystem path, so it is checked with `isAbsolute` + the `MD_ALLOWED_PATHS` sandbox and never canonicalised. That matters because **the line's ability to tell two files apart is a property of the guard, not of `formatAuditLine`**: the renderer's first step is `safeForMessage`, which normalises U+0085/U+2028/U+2029 to a newline and then flattens it to a space — many-to-one by design, and nothing downstream can undo it. Every vault path is safe from that only because the guard refuses those shapes upstream. U+2028 is a legal NTFS filename character, so this was reachable, not theoretical: two calls, **two directories really created on disk**, one journal line —

  ```
  "a b" = U+0061 U+0020 U+0062      audit sha256 = 0f979888362a07e7…
  "a b" = U+0061 U+2028 U+0062      audit sha256 = 0f979888362a07e7…
  BYTE-IDENTICAL: true | distinct inputs: true
  ```

  `isAuditStable` is exported from the guard and applied to `outputDir` right after the sandbox check. Defined by **difference against the real renderer** rather than by a character list, so it cannot drift from it — plus the unpaired-surrogate rule, because a pure difference test inherits the renderer's blind spots and that is one of them. Measured cost: **0 refusals over the 5 070 files** of the real fleet. `provision_vault.path` has the same shape and was checked rather than patched: it is structurally unreachable, because `gated` and `userId` are the same condition and `gated` refuses the tool *before* the handler while the audit fires only *after* success. Recorded as a decision, with the reasoning, instead of a defensive edit nobody could justify later.
- **A record of a write that did not happen.** `execute_template` with `createFile` unset renders a template and writes nothing; the journal fell back to `args.name` **bare**, so a render was indistinguishable from a real write — `execute_template path="wiki/private/salaries.md"` either way, byte for byte, reachable with nothing more than an existing note. `write-targets.mjs` already called this fallback "a display fallback and not a write", and that sentence lived only in a docstring. The line now reads `… path="Templates/t.md (template rendered, nothing written)"`, with the disclaimer added as **router text after escaping**, so a hostile template name cannot spell it — nor dress a real write up as a render.

### Fixed — a write bundle never refreshed the OKF projections

**`write_bundle` scheduled no projection refresh at all.** `pathsTouchedByWrite` read raw arguments and never looked inside `steps[]`, so the tool that writes the most pages at once left the generated indexes stale until something else triggered a rebuild. A functional bug, not an audit one. Two false positives went with it: a render-only `execute_template` refreshed for a file it never wrote, and an *undeclared* `path` appended to `build_search_index` or `record_source` drove a refresh for a page those tools do not touch.

The rule for "which files does this call really write" had been fixed in `pickAuditPath` two rounds earlier and never reached this second reader, because it was a **copy**. Both now import `src/helpers/write-targets.mjs`; there is one definition.

**And the factorisation had left two more copies outside it.** The module's own docstring says "two rounds of *propagate the fix* is exactly how the copies drift, and the second copy is always the one nobody re-reads". There were two, and nobody had re-read them:

- **`src/helpers/hot-staleness.mjs`** — the hot-cache freshness guard re-spelled the `createFile === true` gate inline (the very rule the shared module was extracted to own) and had never heard of `write_bundle`. A bundle writing twelve notes under `wiki/` produced **zero** targets, so the Stop hook let the turn end with `hot.md` describing a vault state that no longer existed.
- **`hooks/session-auto-journal.mjs`** — its `[input.path, input.from, input.to, input.targetPath]` carried **both** bugs the factorisation had fixed elsewhere: `write_bundle` → `[]` (an empty "Files touched" recap for the tool that writes the most files at once, which was not even recognised as a router write) and a render-only `execute_template` reported as touched when nothing was written.

Both import `writeTargets` now, and `write_bundle` is in both tracked-tool lists — plus `ROUTER_WRITE_TOOLS`, the exported PostToolUse matcher, and `hooks/hooks.example.json`, which are pinned equal to each other. What stays local to the freshness guard is only its own policy — *which* tools count as note content — expressed once and reused for bundle steps through a step-op → tool mapping, rather than restated.

Two candidates were examined and **left alone**, with the reason: `noteForWriteResult` and the click-to-open walker answer from the handler's **result**, not from its arguments. That is an authoritative source, not a re-derivation, and converting them would have been motion rather than a fix.

### Fixed — `get_wiki_context_pack` returned incomplete packs without saying so

- **A poisoned catalogue spent the page budget.** The path guard ran *inside* the drill, i.e. after `slice(0, maxPrimaryPages)` had already handed out the slots, so entries that could never be read evicted ones that could — measured: three legitimate pages lost to three poisoned wikilinks, with an envelope that looked full because the placeholders filled it. Whoever can edit `wiki-meta/catalog.md` chose which pages the model was allowed to see. The guard now runs before the budget.
- **A dead wikilink silently deleted a legitimate neighbour.** The neighbour-exclusion set was built from every entry that reached `primaryPages`, and that array carries placeholders — so one perfectly canonical catalogue entry pointing at a page that does not exist removed a real neighbour from the pack, **with an empty `warnings` array**, because a 404 is an ordinary vault fact and emits nothing. Only pages that were really read suppress a neighbour now.
- **N refused links reported as one.** `warnings` is deduplicated at emit time, so a repeated bare token collapsed to a single `unsafe-index-target` and a consumer could not tell one poisoned wikilink from forty. The warning carries the count: `unsafe-index-target (3 links refused)`. The token is still the prefix, so a grep for it keeps working.
- **And "the link is dropped" is now true.** The previous entry said so while the poisoned path survived in `primaryPages[].path`, echoed back verbatim — not an execution vector, nothing dereferences it, but an unannounced re-echo of attacker-controlled text into the model's context. Refused links are really gone from the envelope. The trade is deliberate and it is a real one: the consumer keeps *how many* and loses *which*. The catalogue is a vault file, and `wiki-lint` is the tool for naming them.

### Fixed — the audit middleware could be switched off with the suite green

**Replacing the middleware's own activation condition with `if (false)` left 3 652 / 3 652 tests passing.** The whole audit surface was covered by unit tests on `pickAuditPath` and `formatAuditLine`, plus one test named "middleware wire-up sanity" that reads `src/index.mjs` **as text** and greps it for three substrings — all of which are still present when the branch is unreachable. Sixteen rounds hardened what the line *contains*; nothing checked that the line is ever *written*. The audit journal could have been dead in production and the suite would have said nothing.

`tests/audit-middleware-e2e.test.mjs` drives the real thing: the actual `bin/obsidian-mcp-router.mjs` process, over real stdio JSON-RPC, against a loopback HTTP server playing the Local REST API. It asserts on what that server **received** — the `PUT` of the note, then the `POST` appending the attribution to `wiki-meta/journal.md`, in that order, with the right bearer token and the right line. Nothing in it reads the router's source. Two companion cases keep the claim honest in both directions: with no `OBSIDIAN_ROUTER_USER_ID` the same write appends **nothing** (otherwise "wired" and "always on" are indistinguishable), and a write the containment guard refuses reaches the vault **not at all**. Verified by mutation: `if (false)` reddens exactly this file — and the old grep-based test still passes 17/17 beside it.

### Fixed — three guards that could not fail

- **The dotenv-writer guard was blind to arrow functions.** Its unit finder recognised only `function NAME(…)` declarations — a limit that was documented and therefore felt considered. It was not: rewrite one writer as `const upsertDotenvVar = (key, value) => { … }` in a file that already contains a valid `assertDotenvScalar` call, and the file-level rule is satisfied by the *other* writer while the per-function rule never sees this one. Green, with an unguarded writer shipped. The finder now reads five shapes, and — because there will always be one it does not know — every write primitive in a `.env`-writing file must fall inside a discovered unit, so an unparseable writer fails *loudly* instead of quietly.
- **Two exemption tables were never read.** `NOT_DRIVEN_HERE` and `EXEMPT` were consulted only for their keys, so every justification in them could be emptied with the suite green. The previous round fixed exactly this for `ACCEPTED_BY_DESIGN` and `NOT_DRIVEN_REASONS` and carried it to neither — a rule that reached its first call site only, which is this suite's own recurring failure mode. Same floor as the other two: five words.
- **Both resource-channel error normalisations were untested.** Deleting `normalizeResourceError` from either SDK wrapper's `catch` left the whole suite green — everything the tests drove arrived clean because `readResource` normalises its own refusals, so the wrapper's catch looked redundant. It is not: it is the only thing between the client and a throw from `getRegistry()`, which is a hot-reloaded config load and a real failure path. Now driven, for both wrappers. *(The suspicion that the wrappers themselves survived deletion was checked and is false — deleting either one reddens the pin.)*
- **A security assertion in shipped code that named a test which did not exist.** `src/helpers/write-targets.mjs` stated that its target-field table is "pinned against the schemas in `tests/security-invariants.test.mjs`". No test mentioned the table; the only occurrences under `tests/` were two comments. That is the exact form the repo documents as **worse than no assertion** — it is what a reviewer reads instead of the call sites. It mattered because two of the three consumers cannot check for themselves: `writeTargets` takes an optional schema veto and only the audit consumer passes it (the projections scheduler would close an import cycle; the two hooks have no schema in scope). Measured with a write tool declaring `destination` and no `path`: containment still refuses it, but the audit attribution falls silently to `(unknown)` while the scheduler reads a `path` the **caller appended** — `request.params.arguments` being an open record at runtime. The pin now exists, in the file the sentence always named, and the sentence is corrected.
- **A fifth exemption table whose values were never read**, and two fixtures that proved nothing. `ALLOWED` (the one-definition-of-the-safe-echo guard) was checked for live keys only, so every justification in it could be emptied with the suite green — the same defect fixed for four sibling tables and carried to neither. Same five-word floor now. The `heading-patch target` row of the hostile-content table returned the clean sentinel `'(no refusal)'` on the no-throw path, which the checker waved through: **deleting the call entirely left the row green**. It asserts in-row that it got a refusal, and which one. And the router-text guard's fixture combined `"`, `[` and `]` in one string, so narrowing the class to the quote alone kept it passing — an alternation masked by an OR. Each member is proved separately now, and the class from both ends.
- **`ROUTER_TEXT_SAFE` claimed to remove a trust it did not remove.** Its comment said the check "removes the need to trust every future edit to `FIXED_AUDIT_TARGETS`", while the character class allowed digits, commas, colons and parentheses — every character of `3 path(s): a.md, b.md`. No shipped constant spells that, and the point of the check is that nobody should have to verify it. `,` and `:` are excluded now, which is exactly enough: **every** structural token needs at least one of them (`N path(s):` needs the colon, `, ` the comma, both `sha256:…` notices and the new render-only disclaimer need both). Parentheses and digits stay legal deliberately — three of the six shipped constants need them, and excluding them would turn the fleet's most common journal line into `%28unknown%29`. Pinned from both ends: every shipped constant must print verbatim, every structural token must fail.

## [0.70.2] — 2026-08-04 — the `__proto__` sweep: four review rounds until the reviewers agreed

### Fixed

**A vault-chosen string equal to `__proto__` silently corrupted several responses — and closing that hole took four adversarial rounds, two of which caught regressions in the fixes themselves.** On a plain object, assigning to the key `__proto__` is not an assignment: it goes through `Object.prototype`'s inherited accessor. A string value vanishes; an array or object value **reparents** the object being built. Every accumulator keyed by vault content carried the defect.

The reachable sites, each reproduced before fixing:

- **The shared frontmatter parser** (`llms-txt-exporter.mjs`) — the worst one. `__proto__:` with a YAML **list** value reparented the frontmatter object onto a page-chosen array (`fm.length`, `fm[0]` inherited by every consumer: bm25, boundary score, decision lint, graph builder). The first fix skipped the key **before** the multiline branches consumed its value — so the lines of a discarded `__proto__: |` block were re-read as top-level keys and a page could manufacture sibling metadata out of a value the parser claimed to have dropped. *Worse than the bug; caught by round 2.* Suppression now happens at the assignment, after the value travels the normal parse path.
- **`decision-lint` `stats.byStatus`** — `status: __proto__` decisions vanished from the tally: 4 decisions in, a reported total of 2, and the string `"[object Object]1"` manufactured along the way.
- **`write_bundle` `clickToOpenLinks`** — a step writing to the path `__proto__` (which `canonicalVaultPath` accepts) lost its link. Same fix as the walker's.
- **Digest `parseBodySections`** — two `## __proto__` sections **bypassed the duplicate-H2 refusal** (the failed assignment meant `hasOwnProperty` never became true), the one rule that parser exists to enforce.
- **`build_wiki_graph` `tallyByType` / `download_page_assets` `urlMap`** — same shape, fixed defensively; both are documented as *unreachable today* (builder-fixed node types, URL canonicalization) after review corrected the first version's overstated provenance claims.

**`sanitizeResponse` now sanitises KEYS, not just values.** A C1 escape introducer (U+009B — a one-character ANSI CSI) or an injection-shaped tag in a *key* reached the model verbatim even when the caller asked for `neutralizeInjection`. Keys use the caller's neutralization setting but never the caller's `maxLen` — forwarding it renamed structural fields (`vault`, `path`) into truncation notices, a regression caught in round 3. Collisions follow the `Object.fromEntries` last-wins rule; C10's tally keeps its own summing pass, which is documented as the better merge for counts.

**Unicode line breaks are normalized, not deleted.** The first hardening stripped U+0085/U+2028/U+2029 outright — silently joining words (`alpha⟨sep⟩beta` → `alphabeta`), with a test pinning the destructive result as correct. They are now rewritten to `\n` before the C1 strip (order matters: NEL is C1), which still closes the `JSON.stringify`-doesn't-escape-them hole.

**The space-separated timestamp form accepts horizontal ASCII whitespace only.** The v0.69.x fix had overcorrected from one literal space to `\s+`, which read a multiline `updated: |` block whose lines happened to be date-shaped and time-shaped as a *timestamp*. `[ \t]+` now; a line break or NBSP reads as an annotated date, deterministically.

Explicitly **reclassified, not fixed**: nested mappings under any frontmatter key flatten to top-level keys — a pre-existing, key-uniform limitation of the line-oriented reader, with no privilege boundary (the page author already writes their own top-level frontmatter). Pinned by a test asserting `__proto__:` and `anything:` flatten *identically*, so any future divergence forces the real-nesting decision deliberately.

Also fixed in passing: the sweep that found these sites had itself been blind — `wiki-graph-builder.mjs` contains literal NUL bytes in composite keys, so grep treated it as **binary** and suppressed its matches. And three of the scariest-looking sites (`bm25-index`, the write-bundle journals, `plan-seal`) turned out to be already defended by earlier reviews — the plan-seal comment even documents the seal-bypass scenario.

**Tests:** suite **3533** (+21). Every fix's pin verified by revert: the fix removed → its pin fails. Four Codex rounds: NO-GO → NO-GO → NO-GO (comments only) → GO.

## [0.70.1] — 2026-08-04 — ENOTFOUND: one definition instead of five copies

### Fixed

**An unreachable vault was reported as "your file is missing" by five different call sites.** The rest-client raises a dead host as `kind: 'unreachable'` with a message ending `(ENOTFOUND)` — and a bare `/not.?found/` matches the **NOTFOUND inside ENOTFOUND**. C10 hit this in v0.69.1 and fixed only its own copy; the others were still lying.

- **`get_page_neighbors`, `wiki_path`, `build_wiki_tour`** told the user to run `build_wiki_graph` — i.e. rebuild a graph they already have, against a vault that cannot answer. Reproduced on all three through the real error shape.
- **`get_wiki_context_pack`** was worse, and was found only by review: its citation resolver had the same predicate with `err.kind` **OR'd instead of authoritative** and a message test matching a bare `404` *and* `enotfound` outright. An unreachable vault therefore recorded a live citation as a **confirmed dead link**, with `fetchError: null` and no warning.

The fix is one shared predicate (`helpers/missing-read-guard.mjs`) used by all five, rather than the same patch applied five times — which is what let the copies drift in the first place. Hardened under review beyond the original bug:

- **Inspection can no longer mask the original error.** The predicate runs inside a `catch`; an error object with a throwing `kind`/`status`/`message` getter used to replace the real failure with a meaningless one. Every access is guarded and fails to `false`.
- **A present-but-empty `kind` fails closed.** `if (kind)` let `kind: ''` fall through and be talked into "missing" by its message.
- **The 404 sniff stopped guessing in both directions.** It matched a 404 inside a *filename* (`Error 404.md`) and a *hash* (`code 404-deadbeef`), while missing `404 (Not Found)`, `File not found` and a string-valued `status: '404'`. A 404 must now be introduced by an HTTP-ish word or followed by "not found", and must not be glued to `.`, `-` or another digit.

One deliberate behaviour change: the three older tools threw a bare `Error` for the missing-graph case, so it surfaced as `Category: unknown`. They now carry `kind: 'validation'` like `find_boundary_pages` — the message is byte-for-byte unchanged, and an actionable refusal is no longer reported as an unclassified failure.

**Tests:** suite **3504** (+13, including a pin that every tool rethrows the *same error object* rather than a reconstruction, and the context-pack regression).

## [0.70.0] — 2026-08-04 — closed pages: annotate by default, hide only on request

### Added

**`find_boundary_pages` now sees page lifecycle — and shows it rather than acting on it.** The design was settled by an adversarial review (Claude proposed, Codex counter-argued, the user arbitrated), and the dissent is worth recording because the rejected option looked reasonable.

The problem, measured: three of the router vault's own top-7 frontier pages were `status: superseded` — closed decisions presented as research candidates, one of them literally a reverted decision — and nobody could see it, because result rows carried `type` but not `status`.

- **Every row now carries `status`** (`null` when absent, blank, or non-string). Annotation is the baseline: on the router vault the three closed pages now show up *labelled* at ranks 4/5/7 instead of invisibly polluting them.
- **New `exemptStatuses` parameter** — trimmed, then exact, case-insensitive matching. A page with no usable status is never exempted; `superseded-in-part` is not swept up by `superseded` (partially superseded is partially alive). Type-first precedence: a page matching both filters is counted once, under `byType`, so `exempted.total` always equals `sum(byType) + sum(byStatus)`.
- **Deliberately NO default** — and this is the arbitrated decision, not an omission. The candidate default `['superseded']` was argued as "contract-backed" (the ADR token decision standardises the term), but the counter-argument won: that contract governs *decision pages* only, while the scorer is global — of the three polluting pages, one was a `type: idea`, outside the contract's reach. A global default would also be rhetoric: it looks like lifecycle awareness while handling exactly one metadata spelling. Bonus of no-default: omitted and `[]` mean the same thing, so the replace-not-extend trap documented for `exemptTypes` cannot recur here.
- **New `withoutStatus` count** — ranked pages with no usable status (82 of the router's 140 articles carry none). Absence must read as unknown, never as active.
- **The unsolvable case is pinned by a named test.** The page that raised the whole question — KIVIRI's genesis page, topically closed but `status: active` — passes every metadata filter, by definition. A test asserts it stays visible, so any future "improvement" claiming to solve it has to delete that test first.

The implementation was reviewed by the same reviewer who specified the design — the strictest possible conformance check — and came back conformant on all eight points, with four presentation-level fixes applied before commit (the sharpest: the skill's output template had no Status column, which would have recreated the original failure with the annotation sitting unused in the API).

Recorded for later, not built: a `superseded` page with many inbound links is a *link-hygiene* signal (those links should point at the successor) — a future wiki-lint info check, deliberately not folded into boundary scoring.

**Tests:** suite **3491** (+14).

## [0.69.4] — 2026-08-04 — the second vault: the exemption list is one vault's vocabulary

### Fixed

**Running C10 on a vault other than the one it was built against exposed the thing its own documentation had called the load-bearing part.** The `/wiki-boundary` skill now calibrates before it reports, and gained the argument that made calibration possible.

C10 ships with `redirect` / `source` / `answer` held out by default, and the module says plainly that this policy — not the formula — is what keeps the ranking meaningful. What that note did not say is that those three names are **one vault's vocabulary**.

First run on a second vault (DEDIBOX, 27 articles): the top result scored **2.68**, more than 1.6× anything the router's own vault produces, and a clean outlier rather than a flat top. It was `type: index`, `kind: folder-index`, `status: redirect-summary`, and its body said the real documentation had been migrated to another vault. **A migration stub in all but name** — precisely the species the exemptions exist for — invisible to the default list because that vault calls it `index`. With `index` added, the ranking became sane.

- The skill gained a step **1-bis**: on a vault it has not run against before, inspect the top few results and ask of each whether the page is thin *by neglect* or thin *by job*, then re-run with any stub-shaped `type:` added. It must name which exemptions it applied, and why, in the report.
- **The skill had no way to add one.** It exposed `--all-types` (clear the list entirely) and nothing else, while the tool's `exemptTypes` argument had been there since v0.69.0 — so the only documented response to a mismatch was to turn every exemption off. `--exempt-types a,b,c` is now documented, with the warning that it **replaces** the list rather than extending it.
- Written down rather than fixed by widening the defaults: `index` means "deliberate curated map" in one vault and "leftover pointer" in another. Growing the built-in list to cover every vocabulary is the unfalsifiable creep the deliberately simple word count exists to avoid.

**A second honesty note, from the same run.** After calibration DEDIBOX's top page held 986 words — not thin at all. It rose because ten pages cite it, and it *was* worth opening (a binding `critical: true` gate, untouched 82 days, its completion table still blank) — but for a different reason than the score implied. The skill now says to distinguish the two when presenting a page: heavily linked, or genuinely thin.

**Tests:** suite **3477**, unchanged — this release edits guidance, not code.

## [0.69.3] — 2026-08-03 — the first end-to-end call, and what four review rounds could not see

### Fixed

**Every C10 refusal was reported to the caller as `Category: unknown`.** The tool's whole refusal design — *"rebuild the graph"*, *"this graph is invalid"*, *"asOf is not a date"* — exists to tell the caller what to do. Over the wire, all of it arrived unclassified.

`error-classify.mjs` states the convention outright, and had already been through this once: a router-side refusal that never reached the network carries `kind: 'validation'`, because such errors *"were previously falling through to `unknown` — same retry verdict, but the category told the caller nothing"*. C10's six refusal sites were doing exactly that. They now use the same `refusal()` shape as `local-search.mjs` and `source-ledger.mjs`. An upstream failure keeps its own classification — a test pins that tagging our refusals does not relabel someone else's.

**Why four review rounds missed it.** Every previous check — 3475 tests, two reviewers per round over four rounds — called the tool function **in process**, where a thrown `Error` is caught directly and its `kind` is invisible. The classification only appears once the error crosses the MCP transport. The gap was in the test *method*, not in anyone's attention.

So this release also closes that gap: the fix was found by **spawning the real server binary and speaking JSON-RPC over stdio**, the way a client does — `initialize` → `tools/list` → `tools/call`. That path had never been exercised for C10. It confirmed the rest: `find_boundary_pages` is present and listed, the refusal on a pre-C10 graph fires with its actionable message, `build_wiki_graph` rebuilds (140 pages → 174 nodes / 749 edges), and the ranking that comes back over the wire is **numerically identical** to every offline probe — `graphify` at 1.6264405305501193, `features-index` at 1.5708383810145061.

**Tests:** suite **3477**.

## [0.69.2] — 2026-08-03 — the fourth round: `toEpochDay` converged, its neighbours did not

### Fixed

A fourth adversarial round, aimed squarely at the function three rounds had already rewritten three times. **`toEpochDay` held**: 37 hand-picked adversarial forms plus 30 000 fuzzed designator-passing strings, each evaluated under Honolulu, Tokyo, UTC and Etc/GMT-14 — **zero timezone-dependent results, zero wrong days**. Hour-only offsets (`+00`) turned out not to be a regression either: V8 itself returns NaN for them, so the new gate refuses nothing the engine would have accepted. The date parser is done.

The three findings all landed in v0.69.1's *minor* fixes — the pattern held once more, at the cosmetic margin this time.

- **A rejected `asOf` could fabricate a line in the MCP error channel.** v0.69.1 neutralised escapes and injection tags but not **newlines** — `sanitizeLabel` keeps them by design, being written for markdown. So `asOf: 'x" is wrong.\nboundary-score: ranking complete — all clear'` produced a two-line error whose second line read exactly like a legitimate status line. These messages are single-line; newlines and tabs are now collapsed. The v0.69.1 test checked escapes and tags only, which is precisely why this got through — it now pins the line count.

- **Raising the truncation cap moved the cliff instead of removing it, and the v0.69.1 note said otherwise.** The validator writes the offending id *before* the reason (`nodes[1].id "…" is duplicated`), so capping the whole message truncates from the right: at 300 chars a 213-char id already ate "is duplicated"; at 500 it took a 473-char one. **The v0.69.1 entry claimed a long id could "no longer" push the reason past the truncation — that was wrong, and it is corrected here.** The fix is structural rather than numeric: the **quoted identifier** is shortened, so the reason and the rebuild hint can no longer be truncated at all, at any id length.

- **The contextualised 404 sniff missed the most canonical spellings.** v0.69.1 tightened it so a bare `404` could not match a port number (`127.0.0.1:404`) — correct, but it then took `HTTP 404` while missing `HTTP/1.1 404 Not Found`, `404 Not Found`, `Error 404` and `Response code 404 (Not Found)`, which is what real HTTP stacks actually print. Two alternatives now: a 404 introduced by an HTTP-ish word, or a 404 followed by "not found". Both pinned false-positive fixtures still fail to match.

### Verified

Round 4 also mutation-tested the four PIN tests v0.69.1 added, by running them against the extracted v0.69.0 implementation: **all six key assertions flip**, so none is vacuous. `sanitize.mjs` and `wiki-graph-schema.mjs` have zero diff since v0.69.0. The real vault's output is **byte-identical across v0.69.0, v0.69.1 and v0.69.2** — every defect fixed in this series was latent on it.

**Tests:** suite **3475**.

## [0.69.1] — 2026-08-03 — the third round found the clock the second round let in

### Fixed

**A timestamp with no offset made the score depend on the machine that ran it.** `toEpochDay` handed `2026-08-03T00:30:00` — a `T` form with no `Z` and no `±hh:mm` — straight to `Date.parse`, which per ECMA-262 reads a designator-less date-time as **local time**. Measured: the same string resolves to instants **19 hours apart** on a Honolulu machine and a Tokyo one, which flowed into `ageDays`, `recencyMultiplier`, `score` and the reported `asOf`.

That falsified the feature's headline promise — *"no clock; the same graph yields the same bytes anywhere"* — stated in the module header, the tool description, the README, `docs/features/08` and the skill. An offset is now **mandatory** on the timestamp branch; a value that cannot be placed on the timeline reads as **unknown (×1)**, the conservative direction used everywhere else here. Latent rather than shipped-wrong: every `updated:` in the vault is date-only and the builder always writes `toISOString()`, but tools that write local `YYYY-MM-DDTHH:mm` frontmatter are common, and third-party graphs can carry an offset-less `analyzedAt`.

**`allowAnnotated: false` was not enforced on every path.** v0.69.0 introduced it so a caller's `asOf` would really be the `YYYY-MM-DD` its contract promises. The strict date-only regex rejected the timestamp *shape* — and then execution fell through to the timestamp branch, which was not gated at all, and accepted it anyway. So `asOf: '2026-08-03T12:00:00Z'` passed, and `asOf: '2026-08-03T00:30:00'` passed *and* dragged the timezone bug in with it. The release notes for v0.69.0 claimed that fix removed caller latitude; it removed half of it.

Both defects sit in `toEpochDay` — **the function v0.69.0 had already rewritten twice**. Third time the pattern held: the round's own fixes are where the next round's defects live.

Also corrected, all minor:
- the `asOf` rejection echoed the caller's value **raw**, so a control byte or an injection-shaped tag re-entered the model's context through the MCP error channel;
- the last-resort not-found sniff matched a bare `404` anywhere in a message, so `connect ECONNREFUSED 127.0.0.1:404` — a **port number** — read as "your graph is missing". The 404 must now be contextualised by `http`/`status`;
- the validator-error cap rose from 300 to 500 characters, so a long node id can no longer push the *reason* ("is duplicated") past the truncation while leaving the quoted id;
- a stale `13` in a test comment (the measured figure is 12), and the skill's gloss on `withoutRecency`, which omitted the case where the graph itself carries no reference date.

### Verified clean under attack

The third round probed the one v0.69.0 change with product-wide reach — `sanitizeResponse` switching from an assignment loop to `Object.fromEntries` — against null-prototype objects, getters (invocation counts compared), throwing getters, symbol and non-enumerable keys, Date/RegExp/Map/Set/Buffer/TypedArray, frozen and sealed objects, numeric-string key ordering, circular references and class instances: **byte-identical to the old implementation in every case except the intended `__proto__` fix**, at 1.1× cost on 200k-key inputs. The ranking core, exemption policy, refusals, the dark-test guard (including its new recursive walk, on Windows separators) and the real-vault output all held.

**Tests:** suite **3473**. The real vault's ranking is unchanged.

## [0.69.0] — 2026-08-03 — C10: the frontier-page detector, and what "thin" refuses to mean

### Added

**C10 — boundary scoring.** Some pages are crossroads: everybody links to them and they stay thin. `find_boundary_pages` ranks them from the persisted knowledge graph — read-only, one file read, no LLM — so research can be pointed at reasoned subjects instead of hunches.

```
score = inbound / (1 + words/100) × (1 + min(ageDays, 365)/365)
```

The score reads literally as *inbound links damped by length (`inbound / (1 + words/100)`: full weight on an empty page, halved at 100 words, a tenth at 900)*, nudged ×1 → ×2 by staleness. **The score proposes attention; it does not establish importance.** That is a design commitment, not a politeness formula: a high score says only that many pages point somewhere with little in it.

- **The graph did not carry substance, and §2.17 read as though it did.** A node held `id, type, name, filePath, summary, tags, complexity, knowledgeMeta` — no size measurement anywhere. Inbound links were derivable from the edges and recency sat in the frontmatter, but the third term of the score had to be produced. It is now recorded at build time in `knowledgeMeta.substance`, because the builder is the only place holding the page content — which keeps the query itself exactly what the roadmap promised: one more read of the graph.

- **Not in `complexity`, deliberately.** That field is ironically the natural home for a substance signal, and it is dead — 118 of 118 nodes said `'simple'`, written by the builder. But `wiki-graph-schema.mjs` is a verbatim Understand-Anything mirror claimed as such for interop, `complexity` sits inside `validateGraph`'s enum, and the UA dashboard reads our `knowledge-graph.json`. Redefining `simple|moderate|complex` to mean thin/medium/thick would have changed what a third-party consumer sees, silently. `knowledgeMeta` is the router's own extension bag — nothing validates it, it already carries Obsidian-only keys — so the extension went in the extension bag, and `complexity` stayed dead on purpose. A test pins it.

- **One notion of "inbound link", and the divergence written down rather than papered over.** Two already existed: the graph's edges, and `wiki-lint` Check A, which re-parses every page. C10 uses the graph — the roadmap names it, and the builder's resolver handles path-qualified links, basename collisions, embeds and ambiguity refusal that a regex cannot. Measured on the router's own vault (140 articles): the two agree on 117 pages; on the 23 that differ **the graph always counts fewer**, and the cause is exactly one thing — wikilinks written in **frontmatter** (`related:`, `superseded_by:`), which the builder never sees because it parses bodies only. The graph's set is a strict subset (verified, 0 violations), so a page credited with inbound links here can never be called an orphan by Check A: the two coexist in one lint report without contradicting. Teaching the builder to index frontmatter links would have moved 53 edges and perturbed neighbours, paths, tours and Louvain layers for every consumer — a change that needs its own justification, not a side effect of C10.

- **Wired one storey above autoresearch, not into it.** The roadmap's "instead of picking at random" framing was wrong: `/autoresearch` never picked at random — it reads `## Open Questions` and takes the least-covered one, gauged with `search_smart`. That selector works and was left alone. Boundary scoring answers the upstream question — *which page deserves a programme at all* — as a step 0 that only fires when the user named no topic. In `wiki-lint` it is a new **info**-tier check and can never be raised above it: a thin crossroads is not a defect.

### The honest part — what "thin" is allowed to mean

Substance is a **prose word count**, and that is a genuinely weak proxy: it rewards verbosity, punishes density, cannot tell 89 words of real definition from 89 words of redirect boilerplate, and counts a bilingual FR+EN page as twice as substantial as a monolingual one. It ships as-is, written down, rather than a five-coefficient formula that would look scientific and that nobody could tune. Two things make it workable:

1. **The bias is chosen.** Over-counting substance (code, tables and link lists all count as words) yields false *negatives* — a thin page we fail to mention. Under-counting would yield false *positives* — a healthy page we send someone to rewrite. For a list of suggestions, silence is the cheaper error.
2. **The exemption policy carries more weight than the formula.** Measured: with exemptions off, **12 of the top 20 on the real vault were `type: redirect` migration stubs**, all exactly 89 words of identical boilerplate, thin *by construction*. No word-count refinement separates those from real content — only the declared `type:` does. `redirect`/`source`/`answer` are held out by default (the last two mirroring Check A verbatim) and **the number held out is always reported**, because a silent exemption reads as "I looked at everything".

The three constants — 100 words, 365 days, ×2 ceiling — are conventions, not calibrations; nothing was fitted to any corpus. They are exported, restated in every result, and bounded so that staleness can never more than double a score. A test pins that: a page cannot climb past another on staleness alone across a pressure gap wider than 2×.

Also written down rather than smoothed over: **index and hub pages legitimately surface near the top.** A page whose job is to point elsewhere is thin by design, and the score cannot distinguish that from thin by neglect.

### Refusals, over confident wrong answers

- A graph built before this feature carries no substance measurements. The tool **refuses** instead of treating every page as empty — which would have silently ranked the vault by raw inbound links while looking like it had measured thinness.
- `graphAnalyzedAt` travels with every answer. The graph is a snapshot; the vault's own persisted graph was **a month old with 49 of its 96 article nodes pointing at files that no longer existed**, which is precisely how a stale ranking looks confident.
- A real operational failure (vault offline, timeout) is never reported as "no graph yet" — a test pins the distinction.

### Two review rounds, and the second one found what the first one broke

Two independent reviewers per round, every finding reproduced by a probe before it was acted on. **Round 1: eleven defects. Round 2, run on the corrected code: five more, three of them created by round 1's fixes.** The pattern from C2, C8 and C9 held exactly.

**The one that mattered most was in the CI wiring, not the code.** `npm test` is an explicit list of files and CI runs precisely that script — and both new test files were missing from it. Roughly fifty tests would have shipped dark while the changelog claimed them. Same class as "the C8 gate would never have run in CI" (v0.67.1) and the C9 gate pinned to one matrix leg (v0.68.0), which is why the fix is a **guard rather than an edit**: a test now asserts that every `tests/*.test.mjs` on disk appears in the script. It found a casualty on its first run — `tests/resolve-vault-path.test.mjs`, 8 tests dark since v0.45.0. They pass, and they now run.

Round 1, on the original code:

- **Rounding the scores inverted the ranking.** Four decimals looked like tidiness; two pages one word apart (2000 vs 2001) collapsed to the same value, the path tiebreak ran, and the *thicker* page came out first — the exact inversion this module exists to prevent. It also made the stated ×2 ceiling false in the reported numbers. Scores are now full precision; IEEE-754 and JS number serialisation are both specified, so rounding bought no stability and cost correctness.
- **`localeCompare` is not a total order.** It returns 0 for distinct strings — an accented name in NFC vs NFD (what a vault synced between macOS and Windows produces), a soft hyphen, a zero-width space. When every key tied, the sort fell back to insertion order, reintroducing the very node-order dependence the tiebreak existed to remove. Now compared by UTF-16 code unit.
- **`/not.?found/` matched ENOTFOUND**, so a mistyped or offline remote vault was told to rebuild a graph it already has. Reproduced end-to-end through the real REST client. Structured `err.kind` is now authoritative and the message sniff is a narrow last resort.
- **The substance measure's unit was never checked.** `{words: 0, measure: 'bytes-v1'}` was accepted and scored as an empty page, and a whole graph of them slipped past the "no measurements" refusal — a confident ranking by raw inbound links that looked as though thinness had been measured.
- **Only the container shape was validated.** Duplicate article ids resolved last-wins, so reversing the node array changed which page got scored; an edge from a non-existent node silently cost its target an inbound link. `validateGraph` now runs first.
- **The word count was quadratic.** `'[['.repeat(40000)` took **3.8 seconds**, inside the builder, on every page. Excluding `[` from the link character classes makes the same input 0.1 ms without changing the count for any of the 176 real pages.
- Plus: unanchored date parsing, `minInbound: 0` silently behaving as 1 while echoing 0, prototype-named page types corrupting the audit tally, and the `wiki-lint` sub-agent lacking the new tool in its allowlist.

Round 2, on the corrected code — **the three regressions round 1 introduced**:

- **The new ISO-timestamp branch re-admitted the rollover the fix existed to kill.** `2026-02-29` was refused; `2026-02-29T00:00:00Z` sailed through as 1 March and earned a real staleness score. The calendar date is now validated separately, before the instant is parsed.
- **`sanitizeResponse` undid the `byType` fix in the shipped output.** The scorer's Map produced the right object; the sanitiser then copied it with `out[k] = v`, and for `__proto__` that hits the inherited setter — the key vanished and `total` no longer equalled the sum of `byType`. Fixed in the shared sanitiser with `Object.fromEntries`, which creates own properties: a generic latent bug that C10 was simply the first response to expose, since its keys come from vault content.
- **The new validation-error path bypassed the sanitiser.** `validateGraph` quotes offending node ids, and those are vault paths — so an ANSI escape or an injection-shaped tag reached the reader raw on a path where the success response neutralises both.

Also corrected: `asOf` echoed the raw input rather than the day actually used (they differ when an offset crosses midnight), a caller-supplied `asOf` inherited the annotation tolerance meant for human-written frontmatter, and the dark-test guard was non-recursive.

**One measurement had to be walked back by the vault itself.** The first date fix demanded an exact `YYYY-MM-DD`. Run against the real vault, `withoutRecency` jumped from 1 to 4: three pages carry values like `updated: 2026-05-25 (v0.14.7 — Phase E.2 hardening)`. Those *are* dates with a human note appended, and refusing them traded a false "ancient" for a false "unknown". The rule is now a separator test — a date followed by whitespace is an annotated date and is honoured; a date followed immediately by another character (`2026-08-0399`) is a typo and is refused.

**Tests:** suite **3470**, from 3391 — 66 new C10 tests, 4 builder tests, 1 dark-test guard, and 8 pre-existing tests that had never run.

## [0.68.1] — 2026-08-03 — the gate judged a surface that never ships

### Fixed

**`vendoredPrune` was honoured by the build and ignored by the scan.** v0.68.0's CI was green on both Windows legs and red on both ubuntu ones, with seven `symlink` findings under `node_modules/.bin` — a directory the *build* already prunes, because npm generates it and it is real files on Windows but symlinks on Linux. `npm run gate` therefore passed on the author's machine and failed on every Linux runner, over a directory that is not in any artifact.

One contract entry now has one meaning: `gateDirectory` drops the declared `vendoredPrune` paths before selecting, exactly as `build-mcpb.mjs` does. The regression test builds a real symlink under `node_modules/.bin` and asserts both that it produces no finding and that the package content beside it still ships — so the prune cannot quietly swallow the vendored zone.

Worth recording plainly: **three review rounds and a byte-identical local build did not catch this; the first real CI run did.** The gate step itself behaved exactly as designed — it ran on every matrix leg rather than being skipped behind a red step, which is the v0.67.0 lesson holding, and it failed loudly on a platform difference instead of passing quietly.

## [0.68.0] — 2026-08-03 — C9: one export gate, and the bearer token that was already shipping

### Added

**C9 — the export gate.** Three things built here go somewhere else: the `.mcpb` bundle (MCPHub), OKF knowledge bundles (made to be shared), and GitHub releases. All three now pass through one module, `src/helpers/export-gate.mjs`: whitelist → leak scan → `SHA256SUMS` → manifest → deterministic archive → audit without extraction.

- **The bundle was shipping a live credential.** `scripts/build-mcpb.ps1` selected files with a robocopy deny list, and a deny list is only as complete as the last time somebody remembered it. `obsidian-mcp-router-v0.67.1.mcpb` — the file uploaded to MCPHub — contained `server/.codex/config.toml`, holding a live `Authorization` bearer token, plus 25 internal review documents under `.superpowers/`. `.codex/` is gitignored *precisely because* it holds a credential: git knew to protect it, the bundle did not, because the directory was created after the exclusions were written. Selection now comes from `contracts/export-allowlist.json`, where a file ships because a pattern names it.

- **The same deny list also dropped a file it should have shipped.** `/XD .claude` matched that directory name at any depth, silently removing the git-tracked `templates/reference-vault-skeleton/.claude/settings.json` from the vault skeleton the bundle exists to ship. Before/after on the real artifact: 9695 → 9584 entries, 33 real files removed (including the token), 1 restored, 63 directory-only entries dropped, and **zero files silently lost**.

- **The scan catches five categories** — secrets, personal e-mail addresses, private filesystem paths, symlinks, path traversal — each with a dedicated fixture *and its clean twin*, so a rule that matched everything would fail as loudly as one that matched nothing. Run over this repo it first reported 40 private-path findings, most of them the repo's own documentation examples; the rules became placeholder-aware (a conventional stand-in such as `C:\Users\me` is documentation, a real account name is not), and all 20 survivors were **fixed at the source rather than excepted** — so the gate starts with zero authored-zone exceptions. `gitleaks` in `.githooks/pre-commit` did not and could not cover this: it scans *staged* changes and is fail-open, so it never sees what goes into a bundle or an export.

- **Reproducible, and honest about the edges.** Two full clean builds of the same commit — each with its own `npm ci` — produce a byte-identical archive, verified in CI on every push. The writer normalises entry order, mtimes, path separators, host OS, external attributes and extra fields, and the manifest carries a commit rather than a clock. What is **not** claimed: byte equality across zlib versions (the manifest records `zlibVersion` so a disagreement names its own cause; `--compression store` removes the dependency), across platforms (unmeasured), or of the input file set itself (`npm ci` and git's line-ending translation are upstream). ZIP64 is not implemented — the writer throws rather than emitting a truncated central directory.

- **Audit without extraction.** `node scripts/export-gate.mjs audit <archive>` verifies entry names, CRC-32s, and a checksum chain — each entry against the `SHA256SUMS` inside the archive, and `SHA256SUMS` against the hash pinned in `export-manifest.json` — reading only the bytes, because unpacking is the dangerous half. Rewriting a file forces rewriting the checksums, which breaks the manifest link; a test performs exactly that two-step forgery.

- **Fail-closed, with no quiet bypass.** There is no `--skip-scan`. A finding is silenced by a `scanExceptions` entry that **must** carry a written reason — one without a reason is itself reported, and suppresses nothing. Exceptions are scoped by package, never by a hashed filename that changes on the next upgrade. `build-mcpb.ps1` is now a forwarder: the deny-list build was removed rather than kept as a fallback, because a working way around a gate is a way around it.

### Changed

- **CI runs the gate on every matrix leg, behind `!cancelled()`.** The v0.67.0 lesson applied directly: that release shipped a capability gate pinned to one leg, the tests on that leg went red, and the gate reported `skipped` — advertised in the release notes, never executed. `npm run validate` loses its single-leg pin for the same reason. Every leg, because this gate is about paths, and paths are what differ between a Windows and a Linux runner.
- `actions/checkout` and `actions/setup-node` bumped to v5; every leg was already annotated "being forced to run on Node.js 24".
- `node_modules/.bin` is pruned from the bundle, declared in the contract with a written reason: npm *generates* it, it is real files on Windows and symlinks on Linux, and no zip from either the old or the new builder preserves a unix executable bit. An MCPHub deployment wanting `git_repo_to_markdown` should set `REPOMIX_PATH` or put `repomix` on `PATH`.
- Redacted the developer's account name and dev-drive layout from `CHANGELOG.md`, two hooks, three skills and `src/tools/lock.mjs` — all of it shipped in every bundle and every release.

### Three review rounds, and what each one cost

Two independent reviewers per round, every finding reproduced by an executable probe before it was accepted. **Round 1: 4 blocking + 8 serious + 10 minor, and 15 tests that pinned bad behaviour. Round 2: 4 more blocking, several introduced by the round-1 fixes. Round 3: 2 blocking that both earlier rounds had missed.** The pattern is now three-for-three on this codebase, and this release is the clearest case yet for the third round.

- **Round 1 — the gate could report clean while leaking.** `auditArchive` returned `ok: true` for an archive whose *local* header said `../../evil.mjs` while its central record said `server/abc.mjs`: listing tools read one copy of the metadata, streaming extractors read the other, and a 14-byte patch separated them. The OKF exit was wired in the tests only — its gate inputs defaulted to `null`, so the documented production caller ran with no allowlist and with the one rule that catches a machine-specific vault root switched off. The release gate scanned the worktree while the tag published `HEAD`, and only the allowlist subset while GitHub publishes every tracked file. A single NUL byte exempted a file from every content rule. A `scanExceptions` entry containing nothing but a reason silenced the entire scanner.

- **Round 2 — the fixes had their own holes.** A code comment claimed an EOCD check that was never written, so *appending* an EOCD hid an entry where *editing* one no longer could. The catch-all guard tested the pattern's text, so respelling the glob re-opened the hole round 1 had closed. `swap16` threw a `RangeError` on any odd-length UTF-16BE buffer and took the whole gate down. The honesty counter added in round 1 had no caller at all.

- **Round 3 — the one both earlier rounds missed.** Every check iterated the *central directory*, and nothing verified that the local-header region contained only the declared entries. A complete local record spliced in before the directory — with the EOCD offset bumped by four bytes — was invisible to all of it, and a third-party streaming reader extracted the file. The reader now requires the entries to tile the file contiguously. Round 3 also found that `auditArchive` accepted a `target` and dropped it, that the UTF-16 detector keyed on NUL parity and so missed any note not written in a Latin alphabet, and that byte regions belonging to no entry — the archive comment, local extra fields, the gate's own two files — were read by nothing.

Deliberate limits, stated rather than implied: the generic credential rule does not run over `node_modules` or `tests/` fixtures (shaped formats still do); an exception must name a literal directory, so a narrow but wildcard-only pattern is refused; and `--verify-reproducible` was renamed `--verify-writer-idempotent` because it checked writer idempotence, not reproducibility — CI's two full builds are what prove the actual claim.

New: `npm run gate`, `npm run build:mcpb`, [`docs/export-gate.md`](./docs/export-gate.md). Suite **3390**, +134 tests.

## [0.67.1] — 2026-08-03 — a third review round: the C8 gate would never have run in CI

### Fixed

A third review round on the v0.67.0 work (two independent reviewers per pass, every finding reproduced by an executable probe before it was accepted). Two passes, **14 findings**. The headline one is why this release exists at all.

- **The C8 gate would never have run in CI.** `findLiveSnapshotVersions` accepted a `platform` argument and then dropped it before both `normalizePathKey` calls, so case folding silently followed `process.platform`. On a Linux runner the liveness scan returned `ok: true` with an **empty set** for a snapshot that was in use — the "nothing is running" answer that authorises deleting a served directory — and the test injecting `win32` went red. That reddened both Linux legs of the matrix, and since `npm run validate` is sequenced *after* `npm test` on the ubuntu leg, the capability-contract gate introduced in v0.67.0 would never have been reached. This was a regression introduced by v0.67.0's own second-round fix, the one that had just made `normalizePathKey` platform-aware.

- **Two more ways the purge could reach the wrong directory.** `darwin` is no longer folded to lowercase for seal identity — case-insensitivity is a *volume* property, not a platform one, and an APFS case-sensitive volume would have let one cache's seal authorise a purge of another's. And containment checked only the global cache root, so a link from `cache/<marketplace>/<plugin>` to a **sibling plugin's** directory passed while `rmSync` followed it; the canonical directory must now be exactly the one asked for.

- **The rollback anchor was unreliable.** The CLI anchored N-1 on `PKG_VERSION`, so a stale checkout could purge the true predecessor of the installed release. It now reads `installed_plugins.json` — taking the highest **valid semver** rather than the first array entry (scope order says nothing about which install is active), and ignoring non-semver values (the manifest on the author's machine holds ten `"version": "unknown"` entries, any of which would have become the anchor and silently defeated the fix). The predecessor of *every* manifest-named version is protected, not just the anchor's.

- **Guards that switched themselves off.** The `--force` guard protecting 46 reviewed declarations hung on `existing.ok`, so it was skipped for an unreadable target — exactly the state it claimed to cover; `--write` overwrote everything with exit 0. A *blocked* auto-purge was completely silent, because the `applied` branch short-circuited the `blocked` one and then returned nothing. And `composeCachePurgeLines` could throw on a malformed shape, which would have killed a `SessionStart` hook.

- **The contracts themselves.** `writeMode: "cache"` accepted non-derived write atoms — telling a permission engine that authored notes were safe from a skill holding `write_file`. `decision-consolidate` declared `search_smart` as called (it appears once, in prose, about archives being excluded from that surface) and declared neither path of its step 6, "the `wiki-lint` skill **or** the repo script"; both are now declared, with the delegation closure and `requires.shell` that follow.

- Plus: bootstrap vocabularies imported instead of duplicated, duplicate-key detection extended to `--out` targets, the printed apply command now repeats every non-default planning option (it previously reproduced a *different* plan and failed its own seal), and the seal-drift message no longer says "vault" for a plugin cache.

**Correcting the v0.67.0 entry below**: it says "two rounds of two independent reviewers", which was true when it was written and is no longer — this is the third round, and it found a release-blocking defect the first two missed. The reviewers verified each fix by reverting it in a scratch copy: exactly one test goes red per fix, and only that one.

Tests: **+5**. Suite green: **3256**. `npm run validate` clean.

## [0.67.0] — 2026-08-02 — capability contracts per skill (C8), and a plugin cache that finally shrinks

### Added

Seventh borrowing from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17). The repo ships **46 skills** and nothing declared what any of them reads, writes, or requires — no shell/network/plugin answer a machine could consult before granting one anything, and no check that the documentation, the manifests and the code told the same story. Drift was found by hand, weeks late.

- **`contracts/skill-capabilities.json` (new)** — one declaration per skill: `reads` / `writes` (closed vocabularies of capability atoms), `writeMode` (the roadmap's *create-only / transactional / cache* axis, as a maximum rather than a typical run), `requires` (`shell`, `network`, `python`, `obsidianPlugins`, `binaries`), the router `tools` it calls, the tools its page only *names* (`toolsMentionedNotCalled`), and `delegatesTo` for the skills it invokes. Machine-readable on purpose: this is the raw material for MCPHub/SaaS permissioning, and it ships in the package.

- **`npm run validate` (new, wired into `npm test` and CI)** — fails when the three tellings disagree. **Code**: the router's MCP tool catalog and the sub-agent tool allowlists — the only two things enforced at runtime. **Doc**: every `SKILL.md`, plus the artifact counters published in `README.md` and `docs/architecture.md`. **Manifest**: the declarations and `.claude-plugin/{plugin,marketplace}.json`. It catches an undeclared skill · an orphan declaration · a false doc counter · a declared tool absent from the catalog · a tool a page names that the contract does not account for · an undeclared delegation edge · a sub-agent allowlist granting more than its own skill's contract · and any declaration **gentler than the tools it declares** (naming `delete_file` while claiming `read-only`, or a network tool while claiming `network: false`).

- **The honesty rule, made mechanical.** Every entry carries a `verification` block with exactly two possible states. `verified` demands `evidence` naming real `*.test.mjs` files, realpath-contained inside `tests/`, each naming the skill as a whole identifier — citing the README, a fixture, a path that escapes the repo, or a file that merely contains the letters "save" is refused. `declared` demands a written reason naming the specific residual uncertainty. **All 46 skills are `declared`**, and that is not a backlog item: a skill is markdown interpreted by a model, and no harness executes one deterministically. There is deliberately **no middle tier** — "enforced by the sub-agent allowlist" was considered and rejected, because the allowlist binds only the batch path while the in-process path is bound by nothing. The allowlists are still cross-checked, just never as a badge.

- **`npm run capabilities:bootstrap` (new)** seeds proposals from the code, previewing by default. Every generated entry is stamped `UNREVIEWED-BOOTSTRAP`, **which the validator rejects** — a generated file cannot go green until a human has read the page and replaced the reason. The mechanism earned itself immediately: the first run read the pure-reader `read-get` as `destructive`, `autoresearch` as offline, and `defuddle`'s prose-only `filter_relevant_blocks` mention as a call.

- **`npm run purge:plugin-cache` (new)** — the plugin cache had never been purged. `tryAutoUpdate` copies each new version in beside the old ones and repoints `installed_plugins.json`, so the cache had reached **eight versions and ~1.2 GB**, of which ~900 MB was dead. The purge is planned at the end of every update and returned in its result; it is **not applied** there, because that path is a silent `SessionStart` hook and deleting 800 MB unannounced is what this repo refuses everywhere else (`OBSIDIAN_ROUTER_AUTO_PURGE_CACHE=1` opts in). It never removes the current version, anything a manifest names, the **N-1 rollback** snapshot, or **a snapshot a running process is serving from** — that last one is the real trap and it is not hypothetical: while this was being written, one node process was serving `0.65.0` while the manifest named only `0.66.1`. **Fail-closed**: if liveness cannot be determined, nothing is purged and the reason is stated. Preview-first with a C3 plan seal, so an apply re-derives the plan and aborts on any drift rather than removing something that went live in between.

### Fixed

- **Four published counters had rotted** and are now guarded: `README.md` said 49 slash commands (50) and 45 skills (46), `docs/architecture.md` said 42 MCP tools (48, with a per-category breakdown that no longer added up), and `.claude-plugin/marketplace.json`'s two blocks disagreed with each other about the command count.

Both features went through **two rounds of two independent reviewers**, every finding reproduced by an executable probe before it was accepted. Round 1 produced ~25 real defects, including **six tests that pinned a wrong behaviour** — one of them asserting that a check going silent was *correct* — a `verified` badge obtainable by citing the README, and declarations free to name `delete_file` while claiming `read-only`. Round 2, run on the corrected code, found **three criticalities introduced by round 1's own fixes**: loudest, a wrapper that normalised a missing argument into an empty set and thereby switched the new understatement check straight back off in the only path that runs in production. Two claims were narrowed rather than defended — the purge says what its process scan can and cannot see, and `verified` documents that it proves a citation is a test *about* a skill, not that the test exercises the contract.

Tests: **+133** (`tests/skill-capabilities.test.mjs`, `tests/plugin-cache-purge.test.mjs`). Suite green: **3251**.

## [0.66.1] — 2026-08-02 — `write_bundle recover:true` was unreachable from the MCP wire

### Fixed

- **The recovery listing could not be called.** `recover` was declared as a `oneOf: [boolean, string]` union, and that union does not survive every MCP client's schema normalisation: on the first real call after v0.66.0 shipped, `recover: true` arrived at the handler as the **string** `"true"`, which matched neither the `=== true` listing branch nor the operationId form — so it was refused as a malformed value. The read-only listing is the entry point to the whole crash-recovery story (it is what you run *before* deciding whether to restore anything), so a client-dependent encoding is not an acceptable dependency for it.

  The schema now declares `type: ['boolean', 'string']` instead of a union, and the handler normalises the argument once at the entry point: real booleans and the usual boolean tokens (`"true"` / `"1"` / `"yes"` / `"on"`, and their falsy counterparts) all resolve, an operationId passes through untouched, and anything else still gets the actionable refusal rather than being silently coerced into "list everything".

  Found in production, on the first call — the same way C1's BOM asymmetry and C3's provision-steps gap were.

Tests: **+4** (`normalizeRecoverArg` over every token, and the wire-level equivalence of `recover: true` and `recover: "true"` including that both write nothing). Suite green: **3118**.

## [0.66.0] — 2026-08-02 — the write bundle: all-or-nothing, journaled, with rollback (borrowing C2)

### Added

Sixth borrowing from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17). A single logical operation in this router is almost never a single write: a save writes the note + the journal line + `hot.md`, an ingestion writes the source page + entity pages + the journal, `merge_frontmatter` writes one key per call and documents itself as *"sequential, NOT atomic"*. Until now a failure at step 3 of 5 left the vault in a state nobody designed — a source page nothing links to, a log line for a note that was never written — and nothing detected it.

- **`write_bundle` (new tool)** runs an ordered list of writes as ONE operation. Every target's content is captured **before** the first mutation; if any step fails, every file the bundle touched is put back to the content the bundle read. Four outcomes, no silent in-between: `applied` · `rolled-back` · `rolled-back-unverified` (everything is back, but the undo could not be *proven*) · `rolled-back-partial` (some files are still dirty, named with the reason). A failure mid-bundle **returns** that report with `ok:false`; only refusals *before* the first write throw. Steps run through the existing `write_file` / `append_to_file` / `patch_file` / `set_frontmatter` / `merge_frontmatter` / `delete_file` handlers, so every guard they carry (C1 `ifMatch`, the delete confirmation, the router-side heading engine, the OKF/projection warnings) applies inside a bundle and cannot drift from it. A `delete` step still demands `confirm: true`.

- **Journaled, so rollback survives the process dying.** The before-images are persisted to `wiki-meta/write-journal/<operationId>.json` *before* the first write. Once the operation is decided the journal is deleted — or, if the delete fails, **stamped terminal**, so it can never later be replayed against a bundle that already succeeded. It is **kept** whenever anything is left dirty or unproven. `recover: true` lists journals read-only with a per-file "would this change?" verdict; `recover: "<operationId>"` + `confirm: true` replays the rollback, optionally narrowed with `only: [paths]`. A journal that cannot be written refuses the bundle: an unjournaled bundle is just a loop of writes.

- **Composes with C1 at group level.** Steps may carry `ifMatch`; every precondition is verified against the before-images during pre-flight, so a bundle whose targets moved under it refuses **entirely**, before writing anything (a `preview` *reports* the stale ones instead of throwing — a preview should describe reality). Same for the C3 seal: `preview: true` returns the plan (each step's full arguments fingerprinted, plus the current state of every target) with an `approvedPlanSha256`, and an apply that supplies it is refused on any drift.

- **A partially-applied `merge_frontmatter` now counts as a FAILED step**, which is what finally makes it all-or-nothing: the tool reports per-key failures in its *result* rather than throwing, so a bundle that ignored that would report `applied` over a half-written file. This is the substitution §2.17 asked for. Symmetrically, a `patch` step the target already satisfied is reported as `skipped` rather than counted as a write.

- **Rollback refuses to become the clobber `ifMatch` exists to prevent.** Restoring a backup is itself a write, so the bundle only restores what it can attribute to itself, and grades that evidence honestly: `ours` when the result was **derived** (a `write`'s exact bytes, a `delete`'s absence) — which also means a read-back that disagrees is *proof* of a concurrent writer, and that file is then off limits for the rest of the operation, later steps on it included; `observed` when only a read-back is available (`patch` / `append` / frontmatter ops, whose result Obsidian computes), where a write landing inside that one round trip would be adopted; `unverified` for a step that failed before any post-image existed. Every rollback action is conditional on what was just observed — restores are compare-and-swap, deletes re-assert the content first. Files changed by someone else are named in `rollback.paths` as `left-modified` / `left-deleted` / `left-created`, never touched. Paths touched only by a not-run or no-op step are never touched at all.

- **Nothing is destroyed without a copy.** When a rollback must overwrite content it cannot attribute, the exact bytes are written into the journal **before** the overwrite — and if that copy cannot be persisted, the overwrite does not happen. A journal is only closed on a *proven* end (`applied`, `rolled-back`); a partial or unprovable one stays `pending` so the `recover` its own message advertises actually works, with `lastOutcome` recording what happened. A recovery prunes the entries it resolved, so a second pass cannot restore a file that is already back and has been edited since, and it merges rather than replaces earlier salvage.

- **Wired into the flows that need it**: `save` (page + journal + `hot.md` as one bundle), `wiki-ingest` §6.5 and the `wiki-ingest` sub-agent (source page + entity pages + journal, with the allowlist extended), `wiki-fold` §7.5 (the "write+index+log triplet" the skill already named as a unit), and `write-frontmatter-merge` (whose "⚠️ Not atomic" section now points at the remedy). New `write-bundle` skill + `/obsidian-router:write-bundle` command, including the recovery entry point.

Scope stated rather than implied: **this is recovery, not isolation.** Local REST API has no multi-file transaction, so a concurrent reader can still observe an intermediate state *while* a bundle runs; what disappears is the durable half-applied state. A bundle is not a lock either. Restoration puts back the content the router *read* — the read path strips a leading BOM (the same normalisation C1's hash depends on), so the claim is deliberately not "byte-identical". `move` is not a bundle step: a half-rolled-back move is worse than no rollback; express it as a delete plus a write. Bounds refuse loudly: 25 steps, 5 MB of backups.

### Fixed

- **`ifMatch` was accepted and silently ignored by `append_to_file` and `set_frontmatter`** — every other write tool honours it, these two dropped it on the floor. A guard that does nothing is worse than an absent one, because callers rely on it. Both now check the precondition before mutating (same non-atomic tier as `patch_file`) and both declare `ifMatch` in their MCP schema.

- **The C3 plan seal dropped an own `__proto__` key, so two materially different plans could share one seal.** The canonicaliser accumulated into an ordinary object, where `acc.__proto__ = x` invokes the inherited setter instead of creating an own property — and MCP arguments arrive through `JSON.parse`, which *does* produce own `__proto__` keys. A caller could preview a harmless plan and apply a different one under the approved seal. Affects every C3 surface (`delete_file`, `provision_vault`, `refresh_okf_projections`), not just C2.

- **`kind: 'validation'` errors classified as `unknown`** — router-side refusals that never reach the network (a corrupt source ledger or write journal, a step list failing pre-flight, a bound exceeded) set `kind: 'validation'` explicitly, but the taxonomy in `error-classify.mjs` had no such entry. Same retry verdict, better signal. Pre-existing since v0.64.0 (C6).

### Reviews

**Two rounds of two independent probe-driven passes** (Fable 5 + Codex each time), every finding reproduced by probe before being fixed — 27 real defects.

Round one converged on the two that mattered most: a rollback `delete` with no compare-and-swap, and a foreign write landing inside the post-image window being laundered into "ours". Each reviewer also found something the other missed — two `warnings` keys in one object literal, where the later spread silently discarded the safety-relevant warning and kept the janitorial one; and a *successful* bundle whose journal deletion failed remaining `pending`, so a later `recover` would cheerfully undo it while the result called the journal "inert". Plus: path aliases (`a//b.md`, `/a.md`, `a.md/`) taking separate backups of one file, `..` traversal accepted in step paths **and** in journal backup keys (which a recovery obeys, from a file that lives inside the writable vault), journals not bound to the filename they are filed under, pre-flight accepting argument shapes the delegated tools reject, and zero-based step numbers in prose.

Round two — run against the *fixed* code, which is where this discipline has paid every time — found three more criticals introduced by the fixes themselves: the `foreign` mark was not sticky, so a later step on the same path laundered a **proven** foreign write back into `observed` while the same response still promised the file would not be touched; a **skipped** step still recorded a post-image, so a no-op could adopt a concurrent edit and have it restored over; and recovery ignored the new verified/unverified distinction, claiming a proven undo while deleting the journal that held the only copy of what it had just overwritten. Also: salvage kept in memory until after the overwrite, dropped on a thrown write that may well have committed, and erased by a second partial recovery; backslash spellings bypassing the containment the canonicaliser had just gained; the journal-directory guard not matching the directory itself; boolean options accepted as strings (`requireExisting: "false"` is truthy and reverses the intent); and a derived post-image mismatching its own read-back for content beginning with two BOMs — a false "foreign" that would make a bundle refuse to clean up after itself.

**Four tests had pinned the wrong behaviour**, and that remains the highest-value finding class: one asserted byte-identical restoration of a BOM-prefixed file, which the transport cannot deliver; one carried a comment explaining why the post-image race was "a different scenario entirely", which is precisely how the suite avoided ever exercising it; one entrenched a recovery that destroyed its own salvage; and two jointly pinned a contradiction where the advertised repair path was guaranteed to be refused.

Tests: **+129** (`tests/write-bundle.test.mjs`, `tests/write-bundle-integration.test.mjs`, plus seal and taxonomy coverage). The pure layer covers every branch of the rollback decision table — including the six where it must **skip** rather than write — path canonicalisation and containment, argument-shape and boolean pre-flight, derived post-images through the BOM cases, and journal parsing (version, terminal states, id-vs-filename binding, escaping keys, `__proto__`, salvage preservation, fingerprints re-derived instead of trusted). It also pins the wording rules: a partial rollback may never read like a clean one, and an unproven one may never read like a proven one. The integration layer proves the contract end-to-end on an in-memory vault and **again through the real single-file tools over a real HTTP server**, so "steps run through the ordinary handlers" is verified rather than asserted — including the BOM behaviour, now pinned as what it is rather than what one would prefer. Suite green: **3114**.

## [0.65.0] — 2026-08-02 — `--attach`: bind a workspace to vaults that already exist

### Added

- **`obsidian-mcp-router --attach <slug> [--also <slug>]...`** — the missing verb. Until now the toolbox could *create* a vault and bind it in the same breath, but had no first-class way to say "this repo uses that vault, which already exists". The wizard would have provisioned; the low-level `--link-workspace` wrote one file out of four. The new subcommand does the whole workspace side in one idempotent command, from the workspace directory:

  1. `<ws>/.env` — `OBSIDIAN_ROUTER_DEFAULT_VAULT=<primary slug>`
  2. `<ws>/.claude/settings.json` — enables the router plugin (**without this the `.env` is inert**: no hook runs, so the binding has no observable effect)
  3. `<ws>/CLAUDE.md` — a marked block naming the primary and every secondary, with the addressing rule
  4. `<ws>/.gitignore` — `.env` + `.mcp.json`

  Nothing is provisioned: every slug must already be in `portRegistry`. All slugs are resolved **before** the first write, so a typo in the second vault cannot leave a half-attached workspace. Re-running rewrites the same bytes and reports "already current". Flags: `--workspace <path>` (defaults to the cwd), `--no-plugin` / `--no-claude-md` / `--no-gitignore`.

- **It is exposed on the published binary, deliberately.** This is the one command a user needs *before* the router has any presence in their workspace, so it cannot live where the router already lives. The skill and the MCP tools ship inside the Claude Code plugin, and the plugin is enabled per-workspace by write #2 above — the remedy cannot be gated behind the thing it exists to switch on. `obsidian-mcp-router` is on PATH as soon as the package is installed; the flag is intercepted before argument parsing and before the dependency self-heal, and delegates to `scripts/setup-vault.mjs`.

- **Multi-vault, stated where it is read.** The router binds ONE vault per workspace — `detectVaultContext()` reads a single slug, and that is unchanged here. Vaults passed with `--also` are *not* auto-loaded; they are reached by naming them (`vault: "<slug>"`). The generated `CLAUDE.md` block says so, including the trap: omitting `vault:` raises no error, it silently reads and writes the primary. That block is now generated instead of hand-written.

### Fixed

- **Standalone `--link-workspace` ignored `--claude-workspace`** — the flag was wired only into the bootstrap subcommand, so a standalone re-link wrote a correct `.env` that stayed inert. It is now honored on both paths, and when it is absent the command says outright that the binding is inert and points at `--attach`. Observed in production on 2026-08-02: the missing `.claude/settings.json` had to be written by hand.

### Changed

- **`meta-attach-vault` skill gains a Step 0.0 link-only fast path** — if the named vault is already in `list_vaults`, the skill now stops and runs the one command instead of entering the defaults-first wizard. Three anti-patterns added, including the one that motivated the work: re-deriving the binding mechanism from the router source. That investigation cost ~15 tool calls on 2026-08-02 for what is four file writes.

Tests: **+39** (`tests/attach-workspace.test.mjs`) — pure helpers (slug resolution incl. `vaultNames` overrides, block builder, `CLAUDE.md` in-place replace preserving surrounding user text, `.gitignore` idempotency), the CLI happy path, opt-outs, the binary passthrough, and nine refusals each asserting the workspace is left untouched (unknown primary, unknown secondary → no half-attach, vault without `wiki-meta/catalog.md`, empty registry, bad flags, missing paths). Suite green: **2985**.

## [0.64.1] — 2026-08-02 — heading patches no longer corrupt CRLF files (patched router-side now)

### Fixed

- **`patch_file` targetType `heading` corrupted CRLF files** — reproduced in production on 2026-08-02 against a real roadmap page: an *append* under a `H1::H2::H3` path landed **in the middle of an unrelated line** (splitting a sentence in two), and a *replace* **swallowed the target heading** and spliced the new content into the following paragraph. Root cause, confirmed by reading the bundled plugin code byte-by-byte: Local REST API's PATCH delegates to `markdown-patch`, whose `getDocumentMap` lexes the document with **marked** — and marked's `lex()` first normalizes `\r\n → \n`. The heading positions are then accumulated from `token.raw.length` over that **LF-normalized** text, but `applyPatch` splices those offsets into the **raw CRLF** document. Every CRLF line above the target shifts the true position by one character, so the patch lands short by exactly the number of preceding lines. The `·` and emoji in the failing headings were red herrings.

  The fix takes the plugin's buggy engine out of the loop entirely: **heading patches are now applied router-side** (GET → line-based edit → PUT) by a new pure engine, `src/helpers/heading-patch.mjs`. It never counts character offsets — it resolves the full `::`-joined ancestry path against a line-by-line parse (ATX headings, fenced code blocks excluded, closing-hash form handled, BOM preserved) and splices whole lines. Existing lines keep their exact bytes; **inserted content adopts the file's dominant EOL**, so LF content patched into a CRLF file no longer produces mixed endings either. All documented options are honored: `targetDelimiter`, `createTargetIfMissing` (creates the missing tail of the path, nested, capped at H6 — now reported via `createdTarget: true`), `applyIfContentPreexists` (a skipped idempotent patch now honestly returns `patched: false` + `skippedReason` instead of claiming it patched), and `trimTargetWhitespace`. `block` and `frontmatter` targets still forward to the plugin PATCH unchanged.

- **The known "heading containing a slash gets swallowed" bug (hot.md §2.17) is the same buggy component** — the plugin's markdown-patch engine — reached through a different trigger. Since heading patches never leave the router anymore, that variant is unreachable too; a slash-heading test (`A::C/D`) locks it in. Note: `block` targets still go through the plugin engine, so a block patch on a CRLF file remains exposed to the upstream bug — heading was the corruption vector observed in production; block can be migrated later if it ever bites.

Tests: **+37** — 28 on the pure engine (including a byte-level REPRO fixture of the corrupted roadmap page: CRLF + `·` + emoji headings, asserting nothing splits mid-line, the heading survives a replace, and zero mixed line endings), 8 wire-level (heading → GET+PUT, never PATCH; invalid-target → structured `not_found` with the full-ancestry hint; block/frontmatter forward untouched), plus the ifMatch-guard tests updated for the new wire shape. Suite green (**2946** after merging the concurrent v0.64.0 / C6 work).

## [0.64.0] — 2026-08-02 — the source ledger and the independence rule (borrowing C6)

### Added

Fifth borrowing from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17). The vault's source pages read beautifully, but the vault could not ANSWER questions about them: *which sources are stale? aren't these two articles from the same site? what is this page actually resting on?* Prose is not queryable. C6 is the structured register that is.

- **`record_source` (new tool)** writes one entry per source into `wiki-meta/source-ledger.json`: normalised identity, DECLARED authority tier (`official` / `primary` / `secondary` / `community` / `synthetic`), content fingerprint, refresh horizon, review state, and the pages resting on it. **Forward-fill only** — the ledger is never back-filled by guessing from existing prose, and authority is never inferred from the source itself. Re-recording accumulates page links and is idempotent; re-recording *changed* content invalidates any prior human review and says so. The write is a **compare-and-swap using C1's `ifMatch`**, and creation is guarded too, so parallel sessions cannot clobber a shared ledger.
- **The independence rule.** Every source carries an `independenceKey` — its registrable domain — so `blog.example.com/a`, `www.example.com/b?utm=x` and `EXAMPLE.com:443/b/` collapse into ONE origin. Counting distinct origins rather than distinct URLs is what makes "corroborated by two independent sources" mean something. A per-vault `publisherAliases` map handles what no hostname heuristic can know (`bbc.com` + `bbc.co.uk` are one newsroom).
- **`audit_sources` (new tool, read-only)** reports staleness (with days overdue), review gaps, malformed entries, the authority spread, and how many genuinely independent publishers the ledger represents. `page` gives one page's verdict — corroborated or not, with everything that did *not* count listed and explained.
- **Wired into the flows the spec names**: `wiki-ingest` records every source it files (with a tier-choice table and an explicit "if you cannot tell, say `community`" rule), `wiki-lint` audits the ledger, and both sub-agents' tool allowlists were extended.

Refusals rather than silent defaults throughout: a missing/invalid authority, a schemeless URL (which the normaliser cannot clean, so one article would land twice), a non-http(s) scheme, a credential the normaliser cannot strip (including matrix parameters like `;jsessionid=`), a credential pasted into a free-text field, a corrupt or foreign-version ledger — each is an actionable error, and nothing is overwritten on refusal.

Hardened before commit by a Fable 5 adversarial review **and** an independent Codex pass — both ran the suite and reproduced every finding by probe. **21 real defects fixed**, each with a regression test. The ones worth naming, all in the direction that matters (a FALSE "corroborated"): schemeless URLs became their own countable origins, so two articles from one newsroom corroborated each other; `www.substack.com` counted as a different publisher than `substack.com`; two copies of one local PDF corroborated a page (and an earlier version of the test suite *pinned* that behaviour); `text://host/x` recorded as a URL collided with a `text:` id, merging two different sources; `/~alice` and `/%7Ealice` were two identities for one page. Plus, on the honesty side: a content-less re-record erased the stored fingerprint (destroying provenance and letting a stale review survive the next real change); a re-capture of identical content never advanced the refresh horizon, so a re-verified source stayed "stale" forever; conversely a metadata-only re-record *did* advance it, marking an unfetched source as freshly checked; declared overrides silently reverted to the heuristic on the next ingest while still claiming to be vouched for; malformed entries were treated as fresh (and a null entry crashed the audit); and `required: 0` made a page with zero sources "corroborated".

Also hardened in the shared URL normaliser (which `ingest-state` uses too): secrets in a URL **fragment** (OAuth implicit flow) were persisted verbatim, percent-encoded unreserved characters produced duplicate identities, and a trailing-dot FQDN produced a second entry for one source.

Tests: router **+63**. Suite green (**2909**).

## [0.63.2] — 2026-08-02 — the shared frontmatter reader understands YAML block scalars

### Fixed

- **`parseFrontmatter` now consumes block scalars** (`key: |`, `key: >`, with any combination of explicit indentation digit, chomping indicator in either order, and a trailing comment). The line-oriented reader used to keep the INDICATOR as the value, so a page written with `description: |` carried a literal `"|"` and its real text was silently dropped. That value feeds the **generated OKF projections** (`* [Title](file.md) - |`), the **OKF bundle export**, **llms.txt**, and the **knowledge graph** — a page documented with a multi-paragraph property was mis-rendered in all four. Literal blocks keep their line breaks; folded blocks join lines with spaces and preserve blank lines as paragraph breaks; markdown inside a block (colons, list items, deeper indentation) is no longer leaked back into the key/value loop as bogus keys.

  Blast radius measured before shipping: across **14 real vaults / 1863 pages**, the old and new parsers produce **identical frontmatter** — no page currently uses a block scalar in an indexed field, so no generated projection changes and no fleet-wide `refresh_okf_projections` is needed. The fix is preventive (Obsidian's Properties UI can emit these) and removes a duplication.

- **C4/C5 drops its local copy of that logic.** `bm25-index.mjs` had grown its own block-scalar recovery in v0.63.0/v0.63.1 precisely because the shared reader could not do it; it now relies on the shared parser (one source of truth, per the repo's "import, never copy" discipline) and keeps only a cheap guard so a future regression there degrades the C5 header to `title · section` instead of indexing a stray `|`. The 64 C4/C5 tests now exercise the shared parser and still pass unchanged — equivalence proven rather than assumed.

Reviewed by a Codex pass before commit, which reproduced three YAML-fidelity defects in the first cut — all fixed here: trimming the whole value stripped the leading spaces of the **first line only** under an explicit indent indicator (`|2`), yielding internally inconsistent indentation; folded scalars **folded more-indented lines** instead of keeping them literal (YAML's "more indented" rule) and collapsed runs of blank lines to one; and malformed headers (`|0` — the indicator must be 1–9 — and `|#x` — a comment needs separating whitespace) were accepted, silently swallowing the following lines as block content.

Tests: **+12** on the shared parser (literal/folded, every indicator form, trailing comment, explicit-indent consistency, more-indented folding, blank-run preservation, malformed-header rejection, block termination at a sibling key, markdown-inside-block, quoted pipe not mistaken for a block, CRLF). Suite green (**2846**).

## [0.63.1] — 2026-08-02 — C4/C5 hardening from the post-release double verification

### Fixed

v0.63.0 was re-verified after publication by the same two independent passes that gated it — a Fable 5 re-read of the committed code (24 empirical probes, including the JSON round-trip of the integrity digest and the previously-untested mixed-tier `vault: "*"` fan-out, both clean) and a Codex pass attacking the 14 pre-release fixes with its own probe scripts. Six reproduced defects, all fixed here with regression tests:

- **Short queries reach the semantic tier again.** v0.63.0's tier-independent bounds over-corrected: `search_smart({query: "C1"})` was refused ("no usable term") *before even trying* Smart Connections — a regression vs v0.62.0, and embeddings handle short queries fine. `no-usable-tokens` is a BM25 prerequisite, not a semantic one: it now refuses only when the local tier must answer (`tier: 'local'`, or the auto path actually falling back). Upper bounds (length, token count) stay tier-independent.
- **The integrity digest now covers the metadata too** (`version`, `fingerprint`, `stats`). With only the scored payload digested, a stale index whose `fingerprint` was hand-set to the current corpus value passed as `current` forever, and a fabricated `stats.truncated: false` silenced the mandatory incompleteness warning. `INDEX_VERSION` bumped to 2 (existing v1 indexes report foreign-version → one rebuild). Threat model stated honestly in the code: this is a corruption check, not authentication — an unkeyed hash cannot stop an editor who recomputes it.
- **The chunk-token bound holds against punctuation.** A 500-term comma-separated line (zero whitespace) sailed through the whitespace-level splitter as one 501-token chunk; a third splitting level now cuts on token-run boundaries. And a 10k-character alphanumeric run — unqueryable under the 1000-char query cap — no longer becomes a giant postings key: tokens over 200 chars are dropped from both the index and query vocabularies (`MAX_TOKEN_CHARS`).
- **YAML block-scalar variants `|2-` (digit+chomping) and `>- # comment` are recovered** instead of leaking their indicator into the C5 header as a literal description. An explicit indentation digit now also fixes the block's base indent.
- **The fallback predicate requires the verbal assertion** (`Smart Connections … is not available/installed/enabled`): a 503 crash whose message merely *quoted* a page titled "Smart Connections not available guide" triggered the fallback and hid the crash. Residual limitation documented: this is still prose matching — the durable fix is a structured error code from the bridge (future bridge work).
- **Same-version corruption is named `integrity-failed`**, with a corruption diagnostic, instead of being misreported as `foreign-version` (which pointed the operator at an upgrade that does not exist). The query path carries the machine-readable reason (`index-integrity-failed`) too.

Tests: **+7** (metadata-tamper refusal, comma-monster bound, giant-token drop, block-scalar variants, quoted-title false positive, the "C1" semantic path incl. the honest local refusal, integrity-failed naming end-to-end). Suite green (**2834**).

## [0.63.0] — 2026-08-02 — a local BM25 search tier that works on every vault (borrowings C4 + C5)

### Added

Third and fourth borrowings from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17). The router had two search tiers and a hole between them: `search` (plain substring — dumb but always there) and `search_smart` (semantic — good, but it needs the Smart Connections plugin installed *and* indexed, which most of the fleet does not have). Missing was the search-engine classic: **BM25**, ranking by how much each term discriminates. No model, no plugin, no network, no egress — and the same question always yields the same ranking.

- **`build_search_index` (new tool)** builds a vault's local BM25 index into `wiki-meta/search-index.json`. It walks `wiki/` (excluding the generated OKF projections), chunks every page, and writes an inverted index. **Idempotent**: the index carries a byte-exact content fingerprint of the corpus, so re-running on an unchanged vault skips the write entirely. `check: true` reports absent/stale/current without writing. **Fail-closed**: if any page fails to read, or any directory fails to *list*, or the enumeration is truncated, the build refuses — an index that silently omits content is worse than one that admits it cannot run.
- **C5 — contextual chunk headers.** Every chunk is prefixed with metadata that already exists: page title · frontmatter `description` · heading path (`Parent::Child`). That header is indexed *with* the body, so a query matching only a page's summary still finds it, and every hit can say where it came from. Purely derived — no LLM, no egress. Block-scalar descriptions (`description: |`) are parsed locally, since the shared line-oriented frontmatter parser returns the indicator instead of the text.
- **`search_smart` gains `tier: auto | semantic | local`.** `auto` (default) tries semantic and, **only when that tier cannot serve this vault**, falls back **wholly** to BM25 and labels the response (`tier`, `fallback`). The two rankings are **never blended** — cosine and BM25 scores are incomparable, and interleaving them produces an order that means nothing. `semantic` forbids the fallback; `local` demands the deterministic tier outright.
- **Honest failure everywhere.** An absent, empty, foreign-version, corrupt, or truncated index produces an actionable refusal naming `build_search_index` — never a bare `[]`, which would read as "your vault has nothing on this" when the truth is "nothing has been indexed". Query bounds (length, token count, limit) are enforced **before** tier dispatch, so acceptance never depends on which engine happens to be available.
- New `/obsidian-router:build-search-index` command + skill; `read-search-smart` documents the tiers.

Hardened before commit by a Fable 5 adversarial review **and** an independent Codex pass — both ran the suite and reproduced every finding by probe. **14 real defects found and fixed**, each with a regression test. The ones worth naming: a generic bridge 503 (which wraps *any* Smart Connections crash) was treated as a capability gap, silently demoting a broken semantic tier to a labelled degrade forever; post-filtering a capped page returned **zero** results on archive-heavy corpora while matches sat just past the cap; an empty 0-chunk index answered every query with `[]`; a directory that failed to *list* was indistinguishable from an empty one, so a partial index was written and reported as success; reusing C1's BOM-stripping hash made a BOM-only edit hash as "unchanged" and skip a genuinely needed rebuild; a reordered chunk list with untouched postings returned unrelated pages *permanently* (no corpus fingerprint can see that — the index now carries a self-integrity digest); and C5 silently dropped block-scalar descriptions, which measurably wrecked relevance on the real corpus (a French deletion query ranked an unrelated skill first; it now ranks `manage-delete` first).

Tests: router **+57**. Suite green (**2827**). Validated on a real 45-page corpus: 487 chunks built in ~54 ms, sub-millisecond queries.

Known v1 limitation (deliberate, inherited from `bm25-filter.mjs`): exact-token matching — no stemming or synonyms, so `équations` does not match `équation`. That is the price of zero-dependency determinism.

## [0.62.0] — 2026-08-01 — C3 completed: the sealed preview reaches the CLI two-phase flows

### Added

The remaining C3 sub-scope from §2.17: the sealed-preview mechanism now also guards the two CLI-surface two-phase flows in `scripts/setup-vault.mjs`, reusing the same `plan-seal` primitive. All five families named in the attack order — `delete_file`, `provision_vault`, `refresh_okf_projections`, `sync-from-github --force`, and scaffold migrations — are now sealed. **C3 is complete.**

- **`--migrate-wiki-meta` and `--migrate-sessions-to-wiki-meta` (single vault) gain a sealed preview.** `--dry-run` prints an `approvedPlanSha256` over the migration plan — the scaffolds/sessions moved, the transport mode (git vs fs), the rename-vs-merge strategy, the full rename manifest, the exact CLAUDE.md scaffold-refs to rewrite, and the conflict set. Re-run with `--approved-plan-sha256 <hash>` to apply exactly that plan: it is re-derived from a read-only dry-run and refused, before any move, on drift. The batch forms (`--migrate-all-*`) reject the flag — the seal binds one vault's plan.
- **`--sync-from-github` gains `--dry-run` + `--approved-plan-sha256`.** The dry-run downloads + SHA-256s the archive, resolves the eligible-target set, and seals `{repo, ref, force, archiveSha256, targets}`; an apply echoing the seal refuses — before extracting anything — if the archive drifted (a moving ref like `main` advanced between preview and apply) or the vault set changed. The hardened per-vault `syncPluginsMode` is untouched; the seal wraps the outer orchestration.

Opt-in throughout: a run without the flag behaves exactly as before.

Hardened before commit by a Fable 5 adversarial review (subagent) **and** an independent Codex pass that ran the suite and empirically reproduced each finding — **six real defects found and fixed**, each with a regression test: the batch forms silently swallowing the flag (a malformed seal migrated the fleet, exit 0); sync targets sealed as raw cwd-relative strings (same string + different cwd = wrong vault under a matching seal); the sessions rename-vs-merge strategy and the full non-`.md` rename manifest omitted from the seal; the CLAUDE.md plan sealed as a bare replacement count (a same-count-different-ref swap slipped through); a lexical (non-canonical) vault identity causing Windows case-drift false refusals; and the GitHub apply extracting into a temp dir before verifying (now verifies before any scratch write).

Tests: router **+14** (`plan-seal-cli`: spawn-tested migration dry-run→apply, drift refusals across every sealed dimension — CLAUDE.md refs, rename manifest, merge strategy, plan change — plus batch rejection, malformed-seal fail-fast, and seal-not-mistaken-for-path; sync plan-core determinism/binding units). Suite green (**2770**).

## [0.61.1] — 2026-08-01 — C3 hardening from the independent double verification

### Fixed

v0.61.0 was re-verified by two independent passes before publication — a Fable 5 code re-read + 16 empirical probes on the primitive (all clean), then a Codex pass that ran the suite itself and adversarially reviewed the commit diff. Codex confirmed the normal paths (verify-before-write, opt-in backward-compat) but found one real false negative and one structured-error inconsistency, both fixed here; a third observation is documented as a known limitation.

- **`provision_vault`: the engine's ordered `steps` are now part of the seal.** The step list is state-dependent — "create vault directory X" appears only when the target does not exist — and it was excluded from the sealed plan core, so a preview taken against an absent target followed by someone creating that directory before the apply hashed IDENTICALLY (reproduced by probe). That flipped the engine into adopt semantics (pre-existing `app.json` preserved, existing plugin dirs skipped) under a create-era seal — exactly the executed-behaviour drift C3 exists to refuse. Steps are deterministic for an identical input+environment, so sealing them (order-preserved) adds no false positives.
- **Malformed `approvedPlanSha256` now throws `PlanDriftError`** (kind `plan_drift`) at all three tool layers instead of a plain `Error`, so the refusal classifies as `validation`/non-retryable (and carries `_meta.kind`) instead of `unknown`. Same message text. `error-classify` also gains a message-match safety net covering C1's `Invalid ifMatch` sites, which shared the mislabel.
- **Documented (not fixed, deliberate):** content fingerprints hash the DECODED read representation (`res.text()`), so two distinct BINARY contents whose invalid-UTF-8 bytes decode identically (U+FFFD) fingerprint identically — invisible to the seal and to C1's `ifMatch` alike. Inherited from C1's "hash exactly what get_file returned" contract, which is what keeps router/bridge/caller agreeing; vault operations target markdown, where this is moot. Now stated in `plan-seal.mjs`.

Tests: **+1** (the reproduced target-existence drift now refuses at the tool level; the malformed-seal test additionally pins the `PlanDriftError` classification). Suite **2756** green.

## [0.61.0] — 2026-08-01 — sealed preview (`approvedPlanSha256`, borrowing C3)

### Added

Second borrowing from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17), and the companion to C1: where `ifMatch` pins one file's content across a read→write, C3 pins a whole **two-phase operation's plan** across a preview→apply. Between the two calls the world can move — a file changes, a page is added, a slug collision appears — and applying the plan the caller *approved* when the plan that would *actually run* is now different is the class of silent damage C3 refuses.

- **New primitive `src/helpers/plan-seal.mjs`.** A preview computes `approvedPlanSha256` = SHA-256 over a canonical (recursively sorted-key) serialization of `{domain, op, resolved-vault identity, plan}`, reusing C1's `contentSha256` core over the canonical JSON. The apply re-derives the plan from **current** state, recomputes the seal, and refuses **before any write** if it differs. Bound to the resolved vault — a seal minted for vault A cannot confirm an apply on vault B — and to the operation (a delete seal can never be replayed as a provision). Domain-separated, so a plan seal can never collide with a raw content hash. Opt-in and enforced-when-provided, exactly like `ifMatch`: an apply that omits the seal keeps the prior behaviour, so nothing breaks across the fleet ("généralisation progressive").
- **`delete_file` gains a sealed preview.** `preview:true` returns the delete plan (existence + content fingerprint) sealed as `approvedPlanSha256` and writes nothing; `confirm:true` echoing that seal refuses the delete if the file drifted — changed, vanished, or even *materialized* after a "nothing to delete" preview — since. The `confirm:true` accidental-delete guard is unchanged; the seal is an additional, opt-in layer.
- **`provision_vault` verifies a `plan_vault` seal.** `plan_vault` now returns `approvedPlanSha256`; `provision_vault`, given it, refuses — before the filesystem-mutating run — if the recomputed plan drifted (a slug collision appeared, the source vault changed, a root vanished) **or** if the executable options (`gitInit`, `open`, `probe`, `probeTimeout`, `linkWorkspace`, `claudeWorkspace`, `allowOutsideRoots`) differ from what was previewed. The seal covers exactly what will be executed, not just the dry-run core.
- **`refresh_okf_projections` verifies a `check:true` seal.** `check:true` returns `approvedPlanSha256` over the projection plan — writes (with content fingerprints), deletes, and conflicts — and an apply echoing it is refused if the tree drifted since. Most valuable in conflict mode, where blindly applying a stale plan could touch a projection path a hand-written file has since claimed, or run a delete the fresh plan no longer intends.
- Malformed `approvedPlanSha256` fails loudly at the tool layer, **before any I/O**, never silently treated as "no seal". A drift surfaces as `kind:'plan_drift'` → a non-retryable validation error carrying an actionable "re-run the preview" remedy.

Scope: this first C3 landing generalizes the sealed-preview mechanism to the **in-process two-phase MCP tools** (delete, provision, projections). The CLI-surface two-phase flows named in §2.17 — `sync-from-github --force` and scaffold migrations — reuse the same `plan-seal` primitive and are the remaining C3 sub-scope.

Hardened before commit by a 6-lens adversarial review (determinism/false-negative drift, security/vault-binding, backward-compat, false-positive refusals, test-adequacy, integration-wiring) — the four code-correctness lenses came back clean — plus a Codex pass on the tests that added the provision executable-options binding, a drift-detectable fingerprint for non-string delete content, and a strict before-any-I/O ordering assertion.

Tests: router **+43** (`plan-seal`: canonicalization, op/vault binding, domain separation, `verifyPlanSeal` accept/drift/malformed, `classifyError` mapping; `plan-seal-integration`: the refuses-drift / accepts-identical invariant end-to-end for all three families — incl. reverse existence drift, exec-options drift, the deletes-branch of the projection seal, cross-vault replay, malformed-seal-before-I/O, and opt-in backward-compat). Suite green (**2755**). **Router-only** — no bridge change: the seal is computed and verified entirely router-side (unlike C1's atomic tier, which needed the bridge).

- **`npm run update:bridge-fleet`** (`scripts/bridge-fleet-update.mjs`) — deterministic bridge rollout across the fleet. Every vault already self-updates the bridge via BRAT's `updateAtStartup` (audited: 21/21 vaults tracked + enabled), but that startup check is lazy and silent. The script compares each registered vault's on-disk bridge manifest to the target version (GitHub latest release, or `--target X.Y.Z` — fail-closed, never guesses), and for stale REACHABLE vaults fires BRAT's `checkForUpdatesAndUpdate` through the Local REST API command endpoint — the exact procedure that shipped bridge 0.7.0 to the open fleet on 2026-08-01 (a few minutes of BRAT latency, hot-reload, no Obsidian restart). Closed vaults are reported as such: BRAT covers them at next launch. `--dry-run`, `--wait [min]` (polls manifests until the target lands), `--json`. Loopback-only, API keys never printed, up-to-date and ahead-of-release vaults are never touched.

## [0.60.0] — 2026-08-01 — optimistic-concurrency writes (`ifMatch`, borrowing C1)

### Added

First borrowing from the [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) study (§2.17), and the answer to a real recurring incident: two parallel sessions on the same vault silently clobbering each other's full-file writes (it happened to this vault's own `hot.md`).

- **`get_file` now returns `contentSha256`** — the SHA-256 of the file's raw bytes (computed *before* sanitization, so it matches what is on disk). Replay it as `ifMatch` on a later write to make the change conditional.
- **`write_file` gains compare-and-swap via `ifMatch`.** When the target vault runs `obsidian-mcp-router-bridge >= 0.7.0`, the write goes through the new `PUT /vault-cas/<path>` route, which reads-compares-writes **inside the Obsidian process under a mutex**. Honest scope: that makes the check-and-write indivisible against *other* conditional writes — not against a writer that bypasses it (a plain non-`ifMatch` write, a save in the open Obsidian editor, an Obsidian Sync apply). C1 prevents two cooperating sessions from clobbering each other; it is optimistic, not a lock. The result echoes the new `contentSha256` so edits can be chained without a re-read. `ifNew` and `ifMatch` are mutually exclusive (one requires absence, the other a specific existing content).
- **Graceful fallback.** If the atomic route is unusable — a 404 (older/absent plugin) or a 400/413/415 (route present but it can't service the request shape: an empty body the parser dropped, a size limit, a proxy) — the router degrades to a GET-compare-then-PUT. Correct for the common case, non-atomic (a small window between the read and the write), and strictly better than the unconditional write it replaces. A genuine 409 conflict is never a fallback trigger — that is the guard doing its job. C1 therefore delivers value on every vault today, and hardens once the bridge is deployed.
- **`patch_file`, `merge_frontmatter`, `move_file` (source), and `delete_file` gain `ifMatch`** as a whole-file precondition guard (router-side GET-compare): they refuse to act on content that changed since it was read. Honestly non-atomic — only full-file `write_file` gets the atomic tier in this first landing — but it closes the stale-read case for the surgical operations too. `delete_file` with `ifMatch` won't delete a file another session just edited.
- Malformed `ifMatch` (not 64 hex chars) fails loudly at the tool layer instead of behaving like "no precondition".

Companion bridge change: **`obsidian-mcp-router-bridge` 0.7.0** registers `PUT /vault-cas/*` (authenticated, same trust surface as core `PUT /vault`). The bridge hashes with Web Crypto; the router with `node:crypto`; both over UTF-8 bytes, and both strip a single leading BOM so the two read paths (core `GET /vault` decodes via `res.text()`, which drops a BOM; the bridge's `adapter.read()` keeps it) agree — without that, a BOM-prefixed file would 409 forever on the atomic tier. A shared known vector (including a BOM case) is pinned in both suites so the implementations cannot drift. Deploying the new bridge to each vault is a separate manual step — until then, the fallback tier is used.

This landing was hardened by a 5-lens adversarial review (hash-consistency, concurrency/TOCTOU, feature-detection, security/wire, test-adequacy) before commit; the BOM bug, the too-narrow (404-only) fallback, and an `exists→read` TOCTOU that returned 500 instead of a clean 409 were all found and fixed there, and the bridge handler was refactored into a pure, unit-tested core.

Tests: router **+36** (`content-hash` incl. BOM vectors + end-to-end `if-match-writes` covering the atomic tier, the 404/400/413/415 fallback, non-ASCII paths, empty-content writes, and the guard→operation suppression for patch/delete/move/merge against a live local server). Bridge **+27** (`vault-cas-core`: `decideCasWrite`, `normalizeVaultPath`, `withCasLock` serialization, and `performCasWrite` orchestration incl. the BOM and vanished-file cases). Both suites green (router 2699, bridge 121).

`ifMatch` is opt-in per call: the clobber-prevention holds only when the writers that could collide all pass it. A per-vault "require ifMatch" strict mode is a possible follow-up, not part of this landing.

## [0.59.4] — 2026-07-31 — the catalog becomes a map of maps

Last piece of volet ② of the catalog/journal decision. The central catalog listed **one row per page** and had reached **70 KB / 115 rows** — too large to read in a single tool call, which is exactly the problem OKF's per-directory indexes solve. Now that `wiki/` carries 34 generated indexes, exhaustiveness has a better home; the catalog keeps the part no generator can produce.

### Changed

- **`wiki-meta/catalog.md` is now a map of maps**: one entry per *area* (directory), each linking to that directory's generated `index.md`, plus a short curated "read first" list. The router vault's catalog went **70 001 → 7 256 bytes (−90 %)**, 115 rows → 13 area links + 27 curated pointers, with the originals kept in `catalog.full-backup-2026-07-31.md` (hash-verified byte-identical before overwrite).
- **Indexes are linked with markdown links, never wikilinks** — and the convention says so explicitly, in the template, both skills, and the lint. Every directory index shares the `index` basename; a wikilink resolves by basename and Obsidian would retarget it silently. This is the exact failure the `index`→`catalog` rename (v0.58.0) was performed to prevent, so re-introducing it through the catalog would have undone that lot.

### Fixed — the growth engine, not just the symptom

Converting the catalog without changing what writes to it would have regressed within days: the next `/save` would have appended a row. Four sources were still teaching row-per-page:

- **`templates/wiki-meta/catalog.md`** said *"Add a row for every new page filed under `wiki/`"* — rewritten as a map-of-maps seed.
- **`scripts/setup-vault.mjs`** emitted the same sentence plus `_One row per page._` under every `--wiki-mode` section — both replaced, so new vaults are born with the right contract.
- **`save` step 8** appended a row per page → now: **usually nothing to do**; touch the catalog only when a page creates a **new directory**.
- **`wiki-ingest` step 6** did the same → same rule, with the area-block shape spelled out.
- **`wiki` skill** seeded the offending invariant into fresh vaults → now seeds the map-of-maps contract.

### Fixed — the lint would have failed the new shape

**`wiki-lint` Check C** reported "pages on disk but missing from `catalog.md`". Against a map of maps that is every page in the vault — it would have flagged all 134 and pushed the catalog straight back to a monolith. Check C now checks **areas**, not pages: a directory whose index nothing links to (warning), a link to a nonexistent index or page (error), and an index referenced by wikilink instead of a path link (error). Page-level exhaustiveness belongs to the generated indexes, whose freshness is Check L's job.

Suite 2663/2663 green (the backward-compat scaffold test now asserts the map-of-maps shape, and that the seed does **not** instruct a row per page).

## [0.59.3] — 2026-07-31 — `description` becomes part of the page contract

v0.59.1 stopped the at-rest projections from inventing descriptions, and that exposed the real problem: **0 of the router vault's 134 pages carried a `description`**. Every OKF index entry had been a machine-written body sentence, so removing them left the indexes title-only. The synthesis was hiding a metadata gap rather than filling it. Roland's call: close the gap at the source.

### Changed

- **`description` is now mandatory on every wiki page**, documented in `templates/wiki/CLAUDE.md` next to `source_type`: what it is, why it lives in frontmatter rather than in a body lead, and how to write one — one plain sentence, no markdown, no wikilinks, ~100-180 chars, quoted, and **no backslashes**. That last rule is not cosmetic: the frontmatter reader is a line parser, not a full YAML engine, and does not unescape them — a Windows path in a double-quoted description read back double-escaped.
- **`save` and `wiki-ingest` write it on every page they create.** `wiki-ingest` already emitted `description` for URL sources carrying metadata; it must now also write one for pasted text, local files, and spawned entity/concept pages — exactly the cases that were producing description-less pages.
- **`wiki-lint` Check D reports pages without one**, and explicitly **must not** auto-fill it, even under `--fix`. A lint that quietly synthesized what the projections deliberately refuse to synthesize would reintroduce the machine-written sentences that refusal exists to keep out of the vault. It reports the same set as `refresh_okf_projections`'s `missingDescription`, so the two agree.

### Vault

- **All 134 pages of the router vault backfilled.** Each description was written from the page's own content — the author's lead sentence where one existed, the opening prose otherwise — never composed from a filename. Naive extraction was rejected first: 82 pages open with an `[!info]` callout or a language-switch line rather than a summary, so promoting "the first blockquote" would have published methodology notes and navigation boilerplate as descriptions.
- Coverage was enforced **before** writing: the backfill refuses to run unless the description map matches the page set exactly, in both directions. A silent gap would have left the indexes half title-only — the very bug being fixed.
- Originals backed up under `.description-backfill-backup/2026-07-31-descriptions/`. The vault is under git, but carried 462 unrelated uncommitted changes from concurrent sessions, so `git checkout` was not a clean rollback for this change alone.
- Verified after: **0 conformance errors** across the 169 files of `wiki/`, **0 projection drift**, **0 pages missing a description**. The 103 remaining warnings are all `wikilink-syntax` on content pages — expected at rest, since wikilinks are converted at the export boundary.
## [0.59.2] — 2026-07-30 — projections hardened in review (2 reviewers, convergent)

The `/review+` pass on v0.59.0 — codex + Claude Code Reviewer, run independently — converged on one real fail-open path and surfaced a link-hijack vector. Every fix is pinned by a test. (Numbered 0.59.2 because a concurrent session shipped its own 0.59.1 below; the two lines were merged for this release.)

- **Read failures now fail CLOSED, both directions** (found by both reviewers): a content page that failed to read would have silently dropped its entries from every index and the log; an unreadable file AT a projection path would have been absent from the diff base, so the planner would treat the path as free — and if that unreadable file was an unmarked hand-written page, the write would have destroyed exactly what the conflict rule protects. A transient REST failure now means "no refresh", never "wrong refresh" — same policy as the truncated-enumeration refusal.
- **Hostile titles can no longer hijack generated links**: a frontmatter `title: "Fin](http://evil) - x"` closed the markdown bracket early inside the §6/§7 entries — plausible vector, `wiki-ingest` derives titles from web pages. Square brackets are neutralised to parens in `indexEntryLine` (shared with the export bundle, which had the same latent hole) and in the log entries; multi-line titles collapse to one line.
- The middleware's `requireInitialized` gate no longer conflates a true 404 with an offline/unauthorized vault — only `not_found` reads as "never opted in"; anything else surfaces through the scheduler's error log instead of a perfectly silent skip. Middleware refreshes that actually write also leave a one-line stderr trace (they bypass the tool layer, hence the audit trail).
- The llms.txt exporter's projection exclusion turned out to predate the feature (`index`/`log` basenames never bucketed) — the redundant new filter was removed and the guarantee pinned by test instead.

Suite: **2652/2652** (+52) on this line before the merge with 0.59.1 below.

## [0.59.1] — 2026-07-30 — the projections stop inventing descriptions, and the export ships them

Two corrections to v0.59.0, both against the written brief for volet ②.

### Fixed

- **At-rest projections no longer synthesize `description`.** v0.59.0 derived index entries with `buildOkfFrontmatter`, whose `description` falls back to the body's first sentence. That fallback is right at an **export** boundary — Google's reference implementation refuses documents without a description — but at rest it wrote sentences nobody authored into the vault, where nothing distinguishes them from real ones. `buildOkfFrontmatter` gains an opt-out (`{ synthesizeDescription: false }`, default unchanged so the exporter is untouched); projections pass it, leave the entry in the bare `* [Title](file.md)` form §6 allows, and **report** the gap through a new `missingDescription` array on `buildProjections` / `generateProjectionsOnDisk`. The brief was explicit: *« ne rien inventer : si `description` manque, le signaler en warning plutôt que de fabriquer une phrase »*. Regenerated on the router vault: **32 of 35 projections rewritten**, invented sentences gone.
  - Consequence worth knowing: **0 of that vault's 134 content pages define a frontmatter `description`**, so its indexes are now title-only. The synthesis was hiding a metadata gap rather than filling it — the fix surfaces it where it can be repaired at the source.
  - `missingDescription` is returned **sorted**, not in page order: the whole return value is compared for byte-determinism, so an enumeration-order-dependent array would make the same tree yield different results.

- **`wiki-export --target okf` reuses the vault's projections instead of discarding them.** v0.59.0 filtered marked projections out of the page set and regenerated its own navigation. The bundle now **ships the vault's own bytes** when that is provably correct, so a whole-vault export is the filtered copy the decision aimed at. Two guards, both checked rather than assumed, because wrong reuse ships navigation that lies about the bundle:
  - **every content path must survive slugification unchanged** — a projection's links are at-rest names. Gating on `report.renamed` would NOT catch this: that array records reserved-name and slug *collisions* only, never ordinary slugification, so `Ma Page.md` → `ma-page.md` would have slipped through and shipped an index pointing at files the bundle lacks under those names.
  - **the projections must describe exactly this document set** — bidirectional entry match, not a path-set comparison. Whole-vault projections and a two-page filtered export can produce the *same index paths* while the root index still advertises pages the recipient never receives.
  - When either fails the bundle is still correct, just freshly generated, and `report.projectionReuseSkipped` says why (`report.projectionsReused` carries the verdict).
  - Note: reuse requires case-identical paths, so a vault with capitalised directories (`Divers/`) still regenerates — the exporter lowercases path segments. Reuse fires today only for all-lowercase trees.
  - Projections are still never exported as concept documents: they are split out before path mapping, so §3.1 cannot rename them to `index-page.md` and duplicate the navigation. A **hand-written** page on a reserved basename is still renamed, as before.

- 15 new tests (2641 → **2656**, all green), including the four reuse verdicts, the §3.1 non-regression, and an order-independence test for `missingDescription`.
## [0.59.0] — 2026-07-30 — OKF projections: the wiki carries its own generated navigation (volet ②)

Volet ② of Roland's 2026-07-30 decision (volet ① — the `catalog`/`journal` rename that freed the reserved basenames — shipped in v0.58.0). `wiki/` now carries the three files OKF reserves, as **generated projections** of the tree's frontmatter:

- **`wiki/index.md`** — root index, frontmatter `okf_version` ONLY (§11);
- **`wiki/<dir>/index.md`** — one navigation index per content directory (§6): `* [Title](file.md) - description`, grouped by type, subdirectories listed with document counts;
- **`wiki/log.md`** — newest-first content history (§7), derived from frontmatter dates (undated pages land in a stable trailing section instead of inheriting "today" — same tree, same bytes, any day).

They are **projections**: pure functions of `title`/`description`/`type`/dates, never hand-edited, never wikilinked (internal links keep targeting `[[catalog]]`/`[[journal]]` — the whole point of volet ①), and **conformant by construction**: the §6 index builder IS the export bundle's (`buildDirectoryIndexes`, now exported), the frontmatter derivation IS `buildOkfFrontmatter`, and a round-trip test runs `checkOkfConformance` over generated projections + content and requires **zero errors, zero warnings**. Verified live: the router vault's 169-file `wiki/` lints clean.

### Added

- **`refresh_okf_projections`** (MCP tool #43, write-gated) — regenerate on demand; `check: true` = drift report (wiki-lint's new Check L). Skips identical files, deletes stale generated indexes (their directory emptied), and **never touches an UNMARKED file squatting a reserved path** — that's somebody's content, reported as a conflict. `/obsidian-router:okf-projections` slash command (#48).
- **Kept fed while you write** — a debounced middleware (default 15 s, `OBSIDIAN_ROUTER_PROJECTIONS_DEBOUNCE_MS`) schedules a full refresh after any router write under `wiki/`; a burst of ingest writes coalesces into one. Full-refresh-debounced beats incremental surgery: projections are pure functions of the tree, so a rebuild is ALWAYS correct — no upsert grammar, no drifting counts. Gated three ways: env opt-out (`OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS`), only vaults whose root index exists AND carries the marker (`requireInitialized`), timers `unref()`d so a pending refresh never holds the process open.
- **Marker contract** — every generated file carries `> Generated by obsidian-mcp-router …` (a blockquote: the one §6 body construct the conformance checker tolerates, so marked files still lint clean). The marker is how the toolchain recognises projections: the graph builder and llms.txt exporter exclude them from content, the bundle exporter refuses to export them as documents (they'd collide with its own reserved set — behaviour-pinned against marker drift, since the exporter carries an inlined copy of the string to avoid an import cycle), and `write_file` warns (`projectionWarning`, non-blocking) when a hand write targets one.
- **Born initialised** — `setup-vault.mjs` scaffolding now generates the root projections, so the middleware's gate opens from day one; the `wiki` skill initialises via the tool. **Fleet initialised the same day: 19 vaults, 0 conflicts** (5 vaults have no `wiki/` and are out of scope); `scripts/okf-projections.mjs` is the offline fleet CLI (dry-run default, conflict = exit 1).
- **`wiki-meta/Sessions/` is scaffolded** — the scaffolder had been creating the pre-v0.12.8 `wiki/sessions/` ghost ever since the Sessions move; the hooks write `wiki-meta/Sessions/`. Fixed; the fleet CLI also removes the ghost when (and only when) it is empty — 4 removed, 3 non-empty ones preserved.

### Fixed

- **Era collision on `wiki/index.md`** — the pre-v0.12.0 legacy-layout guard reads `wiki/index.md` + `wiki/log.md` as scaffolds awaiting migration, which is exactly where the projections now live: bootstrapping a wiki made the very NEXT bootstrap refuse with "legacy scaffolds present", and `--migrate-wiki-meta` read the vault as `partial`. Marker-carrying files are now exempt from both checks (caught by the existing idempotence test).

### Changed

- **Skills file by SUBJECT first, type second** (Roland, 2026-07-30: flat type-buckets make human re-reading hard). `wiki-ingest`, `save` and the batch ingest agent now create `wiki/<sujet>/` as soon as 2-3 pages share a subject and regroup strays with `move_file` — safe, since wikilinks resolve by basename — and every directory gets its generated `index.md` landing page for human browsing. Projections and `wiki-meta/` are never moved.
- Counts: **43 MCP tools · 48 commands · 12 write tools**.

Suite at feature freeze: **2647/2647** (+47); the 0.59.1 + 0.59.2 follow-ups above bring it further.


## [0.58.1] — 2026-07-30 — migration backups no longer leak into recall, graph, lint or export

The v0.58.0 fleet pass left a `.okf-rename-backup/<timestamp>/` folder in every migrated vault, holding **verbatim copies** of real pages (that is the point — they make the rename reversible). Obsidian and its REST API ignore dot-folders, but everything in this repo that walks a vault on the filesystem saw them: the `decisions-recall` hook surfaced a backed-up decision page as a **duplicate** of the live one (observed same-day on the KIVIRI vault), and the wiki-ignore defaults let the graph/lint/export enumerate every backed-up `.md` as a duplicate article.

### Fixed

- **`decisions-recall` walker skips every dot-directory generically** (Obsidian semantics, aligned with `resolve-vault-path.mjs`), on top of the named `SKIP_DIRS` set — a nominative list rots; `.okf-rename-backup/` proved it. Regression test: a verbatim decision copy under `.okf-rename-backup/<ts>/` AND under an arbitrary dot-dir is never recalled.
- **`.okf-rename-backup/` added to `DEFAULT_WIKIIGNORE_PATTERNS`** so the graph build, lint and exports stop enumerating backup copies. Covered by a default-patterns test.

Not touched, verified already safe: `resolve-vault-path.mjs` (click-to-open unique-basename resolution) already skips all dot-dirs — no ambiguity/409 risk from backups; the `search`/`search_smart` tools go through Obsidian's REST API, which never sees dot-folders.

Suite: **2583/2583** (+2).

## [0.58.0] — 2026-07-30 — the private scaffolds vacate the basenames OKF reserves: `index`→`catalog`, `log`→`journal`

Roland's 2026-07-30 decision, volet ① of three (vault note `decisions/catalog-journal-et-projections-okf`). OKF **reserves** two basenames — `index.md` (per-directory table of contents) and `log.md` (newest-first content history) — and the next lot adds conformant files under those exact names inside `wiki/`. Our private `wiki-meta/` scaffolds were sitting on both, doing a different job under the same name:

| | ours, in `wiki-meta/` | OKF's, at the bundle root (= our `wiki/`) |
| --- | --- | --- |
| index | curated catalogue: sections, one descriptive line per page, wikilinks | navigation TOC: `* [Title](file.md) - description`, no frontmatter |
| log | append-only operation history, newest at the **bottom** | content history, newest at the **top** |

Obsidian resolves wikilinks by basename, so adding the conformant files while `[[index]]`/`[[log]]` were cited **484 times across 364 files** would have retargeted every one of them, silently, at the generated artefacts. The rename is therefore the technical precondition for volet ② (generated OKF projections), not a cosmetic pass. Executed same-day on the whole fleet: **48 files renamed across 24 vaults, 678 files re-linked, 0 collisions, 0 residual references** — per-vault backups + reversible `manifest.json` under `.okf-rename-backup/<ts>/`. `hot.md` and `overview.md` collide with nothing and keep their names.

### Added

- **`src/helpers/wiki-meta-scaffolds.mjs`** — one place that owns the scaffold names, imported by hooks, the server, the scaffolder and the tools. Exports the current + legacy basenames, `scaffoldCandidates()` (current-first read order), `resolveScaffold()` / `scaffoldWritePath()` (read either, write current), `shouldTryLegacyScaffold()` and `scaffoldMigrationHint()`. Imports nothing — not even a node builtin — so `hooks/_helpers/workspace-vault.mjs` can use it while keeping its pre-`npm install` guarantee.
- **`okf-safe-rename` gains TABLE mode** — `buildRenamePlanFromTable(filePaths, table)` plans from an EXPLICIT list of `oldPath→newPath` pairs, for renames no charset rule can derive (`wiki-meta/index.md` was already perfectly OKF-safe; it just had to move). Same plan shape as charset mode, so the whole downstream machinery — link rewriting, markdown-link rebuild, `.canvas`/`.base` pass, raw-text pass, manifest, verification — is reused verbatim. Two fields are table-specific:
  - `collisions` **blocks the apply**. Charset mode invents a `-2` suffix on conflict; a table must not, because the operator asked for `catalog.md` and silently producing `catalog-2.md` is worse than refusing.
  - `ambiguousStems` is stricter. Charset mode only worries about two *renamed* files sharing an old stem; a table also has to worry about a same-stem file it is **not** renaming. Real case caught in the fleet: the SCI vault has `dev-dashboard/Index.md` and `.../COMPTABILITE/Index.md`, so `[[index]]` there could have meant either. The tool reported both and left basename links untouched (that vault had none, so it migrated clean) instead of guessing.
- **`preserveDisplay: false`** on `buildRewriteContext` — un-aliased wikilinks no longer gain the old target as an alias, so the rendered text follows the target. This is the point of the decision, not a detail: keeping `[[catalog|index]]` next to a real OKF `index.md` would have preserved exactly the ambiguity the rename removes. The display-preserving default (v0.57.0 behaviour) is unchanged for every other migration; a preset declares its own choice, and `--preserve-display` overrides.
- **`RENAME_PRESETS` + `retitleScaffold()`** — the fleet rename ships as a named, tested artifact (`okf-reserved-scaffolds`) rather than an argument typed at a prompt. Its `retitle` step stops the renamed file from announcing itself as `# Index`: whole-word substitution on the **H1 and `title:` only**. `type:` is deliberately untouched — it is a semantic key the lint/graph/context-pack consumers match on, not a name.
- **CLI fleet mode** — `okf-safe-rename-vault.mjs` takes `--preset` / `--table <json>`, `--all-vaults` (the router config's `portRegistry`), a repeatable `--vault` that adds to it, and `--no-alias` / `--preserve-display`. Per-vault section + fleet summary; one bad vault doesn't stop the healthy ones; exit 1 if any vault is blocked or fails verification.

### Changed

- **`wiki-meta/index.md` → `wiki-meta/catalog.md`, `wiki-meta/log.md` → `wiki-meta/journal.md`** everywhere: the 4-scaffold set, `setup-vault.mjs`'s scaffolder and `--link-workspace` precondition, hooks (`session-auto-journal`, `session-reconcile`, `hot-cache-load`, `wiki-query-first-nudge`, `hot-cache-update-prompt`, `wiki-autocommit`, `vault-link-linter`, `doc-drift-detector`), `src/` (audit trail, MCP resources, `build_wiki_graph`, `get_wiki_context_pack`, llms.txt exporter), 20 skills, 8 commands, 2 agents, the scaffold templates, the vault CLAUDE.md templates, the conventions snippets, the feature docs, both READMEs, and the EN+FR quick-reference cheat sheets (HTML + re-rendered PDFs, also pushed to the reference vault's `Documentation/`).
- **The MCP catalogue resource id is `wiki-catalog`** (was `wiki-index`). The old id still resolves — a published URI is a contract.
- **`setup-vault.mjs`'s v0.12.1 migration keeps the v0.12.0 basenames**, split out as `LEGACY_V0120_SCAFFOLDS`: its *input* is a pre-v0.12.0 vault carrying `wiki/index.md`, so it must still look for that. Presence tests use a per-slot list that accepts either naming — counting only one set would have read a fully-migrated vault as `'partial'` and made `--migrate-wiki-meta` refuse a vault with nothing left to migrate.

### Compatibility

**Every read path accepts the legacy name**, unlike the v0.12.0 clean break — the plugin updates independently of the vaults it reads, so a user can be on a new plugin with an un-migrated vault, and a failed scaffold probe silently disables *every* workspace-bound hook. Writes always target the new name. Two details that matter:

- **The fallback only fires on a genuine 404.** `unreachable` / `unauthorized` / `timeout` / `server_error` say something about the vault, not about which name the scaffold has — retrying under the old name cannot succeed and replaces a precise diagnosis with a misleading one. Caught by an existing test: an offline vault was reporting "index not found" instead of "vault offline".
- **The audit trail never creates a second journal.** It tries each name *without* `createTargetIfMissing` and only creates the current one when neither exists — appending with create on the first try would have opened `journal.md` beside an existing `log.md` and split the trail in two. The migrated case still costs exactly one round-trip.

A vault still on the old names keeps working and `scaffoldMigrationHint()` names the fix:

```bash
node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --all-vaults --apply
```

### Hardened in review (`/review+`, 3 passes, 2 reviewers)

Table mode is a new public surface, and the review found real ways to lose a file through it. All reproduced by execution before fixing, and each fix mutation-tested — the guard was deleted to confirm a test actually fails without it.

- **A cross-directory `--table` entry half-applied, and reported `VERIFY ✅`.** *Found independently by both reviewers.* The apply renames by basename inside the entry's own parent — required in charset mode, where ancestors still carry old names — so a `newPath` in another directory landed the file next to the original while links and the manifest recorded the destination. Verification passed because file count was stable and the old path was gone. Now refused at planning time: table entries rename in place or not at all.
- **A chain or swap (`a→b, b→c`) destroyed a file.** Treating a target as free because the table vacates it makes the plan look clean, but renames execute in table order with no topological sort, so `a→b` overwrote `b` before `b→c` could read it — two files in, one file out, caught only afterwards by the file-count check. Refused, like the cross-directory case: freeing a reserved basename never chains.
- **`scaffoldWikiMeta` could hide a user's real catalogue.** On a vault still using the old names it tested only the *current* name, created an empty `catalog.md` from the template beside the real `index.md` — and because every reader tries the current name first, the actual catalogue went silently invisible. It now resolves both names before creating, preserves the legacy file, and prints the migration command.
- **An empty directory squatting a destination** was invisible to a planner that reasons over a file list, and threw EPERM mid-apply. The CLI now pre-flights destinations against the real filesystem.
- **A `..` in a table entry could write outside the vault** (via the retitle step, which was only validated by membership in the plan). Rejected in the planner; retitle paths are confined to the plan's own outputs.
- **A rejected entry still counted as vacating its source**, letting a later entry be planned on top of a file that was in fact still there.
- **The manifest now lands before any mutation** and both outcomes *amend* it rather than writing a fresh one — so a `status` can only ever describe a run that was recorded before it started, and an interrupted apply leaves a `failed` record naming the backup instead of a silent half-migrated vault.
- **The migration hint was exported but never called.** It is now surfaced by the scaffolder and by `wiki-query-first-nudge` — which matters because the nudge is an *instruction* channel: the read-compat layer keeps the code working on an un-migrated vault, but the text was telling Claude to open a path that 404s there. Each scaffold slot is resolved **separately**: the catalog and journal can disagree on a half-migrated vault, and deriving one from the other broke both mixed states (caught by codex on the fix itself).
- Also: `retitleScaffold` no longer lets a `#` comment in the frontmatter consume the first-H1 slot, and preserves CRLF; the fixtures for the session journal moved to the current name (the branch every real SessionEnd now takes had zero coverage) with a dedicated legacy test; a value-taking CLI flag in last position prints usage instead of a stack trace.

Left alone deliberately: the `type:` frontmatter of the two scaffolds (`index` / `wiki-index` depending on which template tree bootstrapped the vault). It is pre-existing, inert — no consumer matches on it, they all address the catalogue by path — and picking one value is a separate call.

Suite: **2600/2600** (+81: 21 for the naming/compat layer, 40 for table mode + no-alias + retitle + the review regressions, 20 end-to-end CLI).

## [0.57.0] — 2026-07-29 — OKF-safe names at rest: fleet migration tooling + ingestion guard

Roland's 2026-07-29 decision (recorded as the `okf-interop` §4 amendment in the router vault): vault file and folder names become **OKF-safe at rest** — exports turn identity-preserving (the name at rest IS the exported name) and new notes are born conformant. The OKF v0.2 spec itself imposes no filename charset; the constraint comes from Google's reference tooling and is adopted deliberately. Executed same-day on the whole fleet with this release's tooling: **333 files + 60 directories renamed across 15 vaults (24 scanned, 9 already conformant), ~4,000 link/path rewrites, zero broken links, zero residual references** — per-vault full backups + reversible `manifest.json` under `.okf-rename-backup/<ts>/`.

### Added

- **`src/helpers/okf-safe-rename.mjs`** — pure planner/rewriter behind the migration: rename plan for files AND directories via the exporter's `slugifyOkfSegment` (single source of truth), deterministic collision suffixes (`-2`, `-3`), ambiguous-stem detection (basename wikilinks whose copies diverge are never guessed — left untouched and reported), wikilink/embed rewriting with **display-preserving aliases** (`[[Vue d'ensemble]]` → `[[vue-d-ensemble|Vue d'ensemble]]`), markdown-link decode/`..`-resolve/relative rebuild, exact-path pass for `.canvas`/`.base` and raw-text mentions (session journals, CLAUDE.md), and `okfSafePathSuggestion()` for the ingestion guard. 22 dedicated tests.
- **`scripts/okf-safe-rename-vault.mjs`** — migration CLI: dry-run by default; `--apply` = full backup + manifest → content rewrite → files-then-deepest-dirs renames → built-in verification (segment conformity, residual old-name scan, file-count stability). Exit 1 on any verification failure.
- **`scripts/okf-safe-rename-textpass.mjs`** — manifest-driven raw-text repair pass (idempotent; exists because plain-text path mentions live outside link syntax).
- **`okfNameWarning`** on `write_file`, `move_file` and `execute_template` results — non-blocking ingestion guard: any `.md` created or moved to a non-OKF-safe path gets a warning carrying the suggested conformant path. Hidden-dir paths and non-md files are exempt.

### Changed

- **skill `save`** — the slug rule is now the explicit OKF-safe pipeline (ASCII-fold accents, lowercase kebab, charset `[a-z0-9._-]`, never spaces) and documents the server warning as a bug-to-fix signal. `wiki-ingest` was already conformant by construction (its `slug()` filter ASCII-folds since v0.13.2).

Suite: **2519/2519** (22 new tests).

## [0.56.2] — 2026-07-29 — post-Lot-5 documentation overhaul + one codex finding

Final review pass on the Lot 5 range (`codex review --base v0.55.1`) plus a ground-truth-driven rewrite of every user-facing document across the three components (Claude Code plugin, MCP server, bridge).

### Fixed

- **Codex P2 — the oversized-hot banner rode on top of the injection budget.** In `hot-cache-load.mjs`, when `hot.md` is over its limit, the byte budget reserved space for the provenance frame but not for the warning banner prepended afterwards — output could exceed `INJECTION_CAP_BYTES` by the banner's size, violating the very ceiling the v0.56.0 change claimed to enforce. The banner is now composed first and its bytes come out of the budget; the test tightened from `budget+1000` to `budget+500` (frame only).

### Documentation

All numbers re-derived from the repo (not from older docs) and cross-verified: **47 slash commands · 44 skills · 42 MCP tools at runtime (43 defined, `get_view_link` gated) · 10 hooks (2 plugin-active, 8 opt-in) · 11 write tools under `OBSIDIAN_ROUTER_READONLY`**.

- **README (EN + FR)** — every stale count fixed (was "45 commands / 42 skills / 8 write tools"); the missing `sync-from-github` and `decision-consolidate` command rows added; hooks blurb rewritten for the v0.56.0 2-active/8-opt-in split; install path reframed plugin-first with `meta-setup` requalified as the dev path; FR-only gaps closed (Modes de déploiement section, wizard callout, conversion-tools note). **New section in both languages: "The three pieces and how they depend on each other" / « Les trois briques et leurs dépendances »** — the canonical chain (Obsidian ← Local REST API ← bridge ← HTTP ← MCP server ← stdio ← plugin), what each piece requires, and what breaks without it.
- **Quick-reference cheat sheets (EN + FR, HTML + regenerated PDFs)** — headers bumped v0.48.0 → v0.56.1; every one of the 47 commands present exactly once with a clear one-sentence description (verified by set-diff against the repo, both languages cover the identical set); new "How the pieces fit" / « Comment les briques s'emboîtent » dependency section; v0.56 facts (plugin ships the server, postinstall removal, opt-out env vars, the three tool-name prefixes). PDFs re-rendered via Chrome headless and pushed to the reference vault's `Documentation/`.
- **Bridge README** (`obsidian-mcp-router-bridge`) — new "Where this sits in the stack" section; install rewritten BRAT-first (manual build = dev fallback); click-to-open documented with the `?h=` / `&reveal=0` params and the v0.5.1 resolution contract (unique-basename fallback, 409 on ambiguity); requirements corrected to Local REST API ≥ 4.0.0; the `/templates/execute` API reference aligned with the actual response shapes.
- `.claude-plugin/plugin.json` + `marketplace.json` descriptions corrected (claimed "31 commands").

## [0.56.1] — 2026-07-29 — the plugin's MCP server declaration was in the one place Claude Code does not read

**v0.56.0 shipped Lot 5 with the server declared in the wrong file, so the plugin carried no MCP server at all.** Everything else in that release worked — skills, commands, hooks, the bootstrapper — but the one thing the lot was for did not land. Update to 0.56.1; there is nothing to undo.

### Fixed

- **The server is declared in a root `.mcp.json`, not inline in `.claude-plugin/plugin.json`.** The plugin reference presents the two locations as equivalent ("`.mcp.json` in plugin root, or inline in plugin.json"). As of Claude Code **2.1.220** they are not. Measured on two minimal plugins differing only in where the server was declared, via `claude --plugin-dir <dir> plugin details <name>`:

  | Declaration | Reported |
  | --- | --- |
  | inline `mcpServers` in `plugin.json` | `MCP servers (0)` |
  | root `.mcp.json` | `MCP servers (1) router` |

  v0.56.0 used the inline form deliberately — to dodge the project-scope leak below — and the failure is silent: nothing errors, the plugin simply contributes no server. The same probe now confirms the real checkout reports `MCP servers (1) router`.
- **The project-scope leak that motivated the inline form is handled directly.** This repo is its own marketplace source, so plugin root = repo root, and the same `.mcp.json` is *also* read as a **project-scope** MCP config by anyone who opens the checkout in Claude Code. `${CLAUDE_PLUGIN_ROOT}` does not expand there: `claude mcp list` shows `router: node ${CLAUDE_PLUGIN_ROOT}/bin/… - ⏸ Pending approval` plus a config warning. The repo's own `.claude/settings.json` now carries `"disabledMcpjsonServers": ["router"]`, which removes the entry entirely — verified before and after — while leaving the plugin channel untouched.

### Tests

+1 case pinning the root `.mcp.json` as the declaration site, +1 pinning the project-scope neutralisation, and the old assertion (which required the inline form and forbade the file) inverted. Full suite **2497**, 0 failures.

## [0.56.0] — 2026-07-29 — Lot 5: the plugin carries the MCP server

> ⚠️ **Superseded by 0.56.1 for the MCP declaration.** The server was declared inline in `plugin.json`, which Claude Code 2.1.220 does not read — this release's plugin contributes no MCP server. Everything else below is accurate and unaffected.

The server had **no distribution channel**. npm publishes nothing, the documented install is `git clone` + `npm link`, and the plugin declared no MCP server at all — so the three copies drifted apart (repo 0.55.1 · GitHub 0.55.1 · installed snapshot 0.50.0 at the start of this work), on the artifact that moves 13× faster than the bridge. Installing the plugin now gets you the server, the skills, the commands and the hooks together; updating it updates all of them.

### Added

- **The plugin declares the MCP server** as `router`, resolved through `${CLAUDE_PLUGIN_ROOT}` at startup so it follows every update. Tools gain the scoped prefix `mcp__plugin_obsidian-router_router__*`. *(The declaration site shipped here was wrong — see 0.56.1.)*
- The server key is `router`, not `obsidian-router`, for a measured reason: the scoped prefix is `mcp__plugin_<plugin>_<server>__`, and `obsidian-router` would put the longest tool (`pdf_to_markdown_docling`) at 68 characters — past the 64-character ceiling many MCP clients enforce. `router` caps the worst case at 59.
- **`src/helpers/ensure-deps.mjs` + a zero-dependency `bin/`** — the entrypoint no longer statically imports the server graph. It probes the three specifiers that are imported statically, installs them once (`npm install --omit=dev --ignore-scripts --no-audit --no-fund`) if they are missing, then loads the server by dynamic import. `--help` and `--version` answer on a tree that has never been installed, diagnostics go to **stderr** (stdout is the MCP framing channel), and a cross-process mkdir lock keeps parallel sessions from installing over each other. Verified cold: 4 s, 180 packages, clean JSON-RPC handshake.
- **`hooks/hooks.json`** — the two hooks the plugin activates for everyone: `hot-cache-load` and `decisions-recall`. Both read-only, both silent no-ops without a vault, both now with an env opt-out.
- **`hooks/_helpers/tool-names.mjs`** — one suffix-based rule recognising the router's write tools under all three registration prefixes (direct, plugin-scoped, MCPHub).

### Changed

- **`postinstall` removed.** It ran `install-markitdown` + `install-docling`, i.e. Python virtualenvs and ~100 MB of wheels. Claude Code appears to `npm install` plugins that carry a `package.json`, and nothing documents whether it passes `--ignore-scripts` — so every third-party plugin install risked building a venv nobody asked for, rebuilt on every update since each version lives in its own directory. Both installers stay available as `npm run install-markitdown` / `install-docling`, which is what the "MarkItDown/Docling remain explicitly opt-in" decision said all along.
- **Hook matchers are prefix-agnostic.** `hooks.example.json` enumerated `mcp__obsidian-router__*` literally; under the plugin those names do not exist, so wiki-autocommit, session-auto-journal and doc-propagation-checker would have stopped firing — silently, since a hook that never fires looks exactly like a hook with nothing to do. `--install-hooks` also **refreshes the frozen matcher** of already-wired blocks (it is idempotent by basename and never revisited them), touching only blocks that contain nothing but router hooks.
- **Double-wiring guard.** Plugin-provided hooks need no settings.json entry; wiring them there too fires them twice per event. `--install-hooks` skips them when the plugin is installed, `--hooks-status` reports them as `✓ plugin` and warns when a hook is both wired and plugin-provided, and the update hook's "new hook available" tip no longer proposes activating hooks that are already running.
- The auto-update's *"hook paths were not rewritten"* warning no longer fires for plugin-hooks users, whose `settings.json` legitimately holds no pinned router path — the advice it gave was to re-run `--install-hooks`, which is precisely what double-wires them.

### Fixed

- **`wiki-autocommit` committed into unrelated repositories.** Its only guards were "cwd is a git repo" and "cwd contains one of `wiki/`, `wiki-meta/`, `.raw/`, `.vault-meta/`" — ordinary directory names — so any repo with a `wiki/` docs folder got silent `wiki: auto-commit …` commits, with `--no-verify` bypassing the user's own pre-commit hooks, and no way to turn it off. It now requires a real vault (`wiki-meta/index.md`, cwd-is-vault only) and honours `OBSIDIAN_ROUTER_NO_WIKI_AUTOCOMMIT`. Reproduced before the fix, verified silent after.
- **`OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=1` did not disable the session journal** — the check compared against the exact string `true`, unlike every other hook's truthy set. That hook writes user prompts verbatim into the vault, so a half-working opt-out is not acceptable.
- The `wiki-query-first` nudge no longer names the repo author at strangers in context injected on every prompt.

### Compatibility

Hand-registering the server in `~/.claude.json` still works and keeps the `mcp__obsidian-router__*` names — nothing breaks. But a hand-registered server and the plugin-provided one are different commands, so Claude Code does **not** dedupe them: you get two processes and two copies of every tool. To move onto the plugin, remove the `obsidian-router` entry from `~/.claude.json`.

### Notes on two documented patterns we deliberately did not follow

- **`NODE_PATH=${CLAUDE_PLUGIN_DATA}/node_modules`**, the documented dependency pattern, cannot work here: `NODE_PATH` is honoured only by the CommonJS resolver, and this package is `"type": "module"` throughout (verified on Node 23.11 — the same package resolves under `require` and throws `ERR_MODULE_NOT_FOUND` under `import`).
- A **`${CLAUDE_PLUGIN_ROOT}/node_modules` junction** into the persistent data directory does work on Windows without elevation, but collides with our own auto-update, which excludes `node_modules` from its cache copy and then installs into the new version directory: the junction is either not recreated (design defeated) or npm writes *through* it and mutates the dependency tree of the still-running previous server process. Per-version `node_modules` in the package root is what both existing provisioning paths already produce.

### Adversarial review before commit (5 reviewers × disjoint axes, every finding sent to a skeptic — 35 raised, 20 refuted, 15 upheld)

Three of the upheld ones were self-inflicted blockers in this very lot, all reproduced on a real machine rather than argued:

- **The double-wiring guard read the wrong manifest.** `pluginProvidedHookBasenames()` read `hooks/hooks.json` from the *checkout*, while `isRouterPluginInstalled()` asked `installed_plugins.json`. Nothing correlated them, and on the normal upgrade path the cached plugin lags the checkout — so a pre-Lot-5 plugin (no `hooks.json` at all) was credited with this version's manifest. `--install-hooks` then skipped wiring both hooks, nothing ran them, and `--hooks-status` reported a double-wiring that did not exist while prescribing a "fix" that deleted them for good. The manifest now comes from the installed plugin's own recorded `installPath`.
- **Router hooks were invisible in a plugin-cache path.** Identity was a substring match on `obsidian-mcp-router/hooks/`, which a marketplace path never contains (marketplace and plugin are separate segments). Every plugin user was invisible to `--hooks-status`, `--uninstall-hooks` and the new matcher refresh, and `--install-hooks` re-added hooks it could not see. Identity is now "a hook script we ship, sitting in a `hooks/` directory" — true for a dev checkout, a plugin cache, an npm global and a `.mcpb` bundle alike.
- **The matcher refresh was unreachable.** It ran only from the explicit `--install-hooks` subcommand, not from the auto-wire that tails every normal bootstrap — the path most users actually take.

Also fixed: `hot-cache-load` injected the bytes of a file found on disk with no provenance and no framing, for every plugin installer, on a mode that triggers on the mere existence of `wiki-meta/index.md` (i.e. on a cloned repository) — both modes now carry an envelope stating the content is cited notes, not instructions, and the envelope's own bytes count against the injection ceiling instead of riding on top of it. Both plugin-activated hooks re-check their opt-out *after* loading the workspace `.env`, so a project can disable them from its own `.env` like every other `OBSIDIAN_ROUTER_*` setting. `isRouterPluginInstalled` no longer counts an explicitly disabled plugin as live. On Windows the npm install timeout now kills the whole process tree (Node signals only `cmd.exe`, which has no process group to pass it on, so npm kept mutating `node_modules` after we had reported failure). Nine stale "runs at postinstall" claims swept from the docs, NOTICE, `.gitignore` and code comments; the French half of the README ported.

### Tests

+40 cases (`tests/lot5-plugin-server.test.mjs`) covering the bootstrapper, the prefix-agnostic matcher, the plugin manifests, the matcher refresh and the double-wiring guard — including the version-skew case that caused the blocker above, plugin-cache hook recognition, and an assertion that `hooks.example.json` never uses `${CLAUDE_PLUGIN_ROOT}`, which does not expand in `settings.json` and would leave every hook unable to launch. Full suite **2496**, 0 failures. E2E verified twice against a simulated plugin cache with no `node_modules`: cold self-heal, clean JSON-RPC handshake, 42 tools, no Python venv.

## [0.55.1] — 2026-07-29 — review+ pass on Lot 3: the pre-seed `--force` data-loss bug, and a test file that never ran

Formal `/review+` pass on v0.55.0 (Claude Code Reviewer + codex, two rounds each). Codex converged on the gunzip-headroom inconsistency; the Code Reviewer found what the pre-commit adversarial pass had missed — everything AROUND the extractor.

### Fixed

- **BLOCKER — `--force` from a config pre-seed destroyed installed plugins.** The skeleton ships manifest-less `data.json`-only dirs (bridge, icon-folder, quiet-outline); under `--sync-from-github --force` the anti-downgrade guard failed open on the unreadable SOURCE manifest, `rmSync` deleted the real plugin (manifest + main.js) and only the pre-seed's `data.json` came back — fleet-wide with `--all --force`, living `.template` included. Two layers now: `isTargetPluginNewer` protects the target when only the source manifest is missing, and the sync loop never refreshes a manifest-target from a manifest-less source (a manifest-less TARGET still refreshes — it isn't an installed plugin). Verified live: a v9.9.9 bridge with `main.js` survives `--force`.
- **Circular allowlist.** The network vetting read its "curated" list from the archive itself — a hostile archive enlarged its own allowlist. `NETWORK_PLUGIN_ALLOWLIST` is now pinned in code; the archive's list only selects within it, and a non-default `--repo` requires an explicit `--trust-repo` acknowledgement (it ships executable plugin code under trusted names).
- **`.claude/` no longer cloned from network sources** — its `settings.json` can carry hooks (shell commands), i.e. network bytes into an executable config while plugins get vetted.
- **Windows smuggling classes in `safeJoin`**: NTFS Alternate Data Streams (`a.txt:evil` lands under a DIFFERENT name than the one validated — proven on this machine) and reserved device names (`CON`, `COM1`…) are rejected.
- **Dead test file resurrected.** `tests/setup-vault-themes.test.mjs` imported `setup-vault.mjs`, whose top-level CLI dispatch printed the help and `process.exit(0)`'d DURING import — its 16 assertions (the whole anti-downgrade suite) were a false green since v0.52.0, counted as one passing test. The dispatch is now wrapped in `cliMain()` behind an entrypoint guard (`samePath(import.meta.url, argv[1])`); the suite gained the 16 real tests.
- Smaller hardening: gunzip headroom derived from `maxEntries` (codex finding — a fixed 16 MB margin rejected valid 20k-entry archives), decompression-bomb errors wrapped readably, old-style `type '0' + trailing slash` directories honored, `quiet` + source-override refused outright, `--repo` documented in the help, SKILL claims aligned (no more « exclusivement » — `--repo` exists, gated, and the skill never passes it unprompted).

### Tests

- +5 targz cases (ADS/devices, wrapped bomb, old-style dirs, 17k-entry structural headroom), +1 anti-downgrade pre-seed case — plus the 16 resurrected ones. Full suite **2456**, 0 failures. E2E re-verified through the wrapped dispatch against the real GitHub tarball.

## [0.55.0] — 2026-07-28 — Lot 3: `/sync-from-github` — a machine with no dev repo pulls the template straight from GitHub

Lot 3 of the template-distribution roadmap, plus the first task the `brat-dans-template-vivant` decision ordered: **BRAT 2.0.8 is now installed and ENABLED in the living `.template` vault** (`data.json` wired to the bridge repo + hot-reload, `updateAtStartup`), so the next `meta-sync-template` hands it to every existing vault and the bridge self-updates from GitHub releases from then on.

### Added

- **`--sync-from-github` mode** in `setup-vault.mjs` — downloads the repo tarball from `codeload.github.com` (size-capped, HTTPS-only redirects, wall-guarded), extracts `templates/reference-vault-skeleton` to a temp dir, and applies it to one vault or `--all` through the exact same pipeline as `--sync-plugins`: `syncPluginsMode` gained a `sourceVault`/`sourceLabel` override, so the credential-leak refusal, the BRAT anti-downgrade guard, per-theme clones, appearance fill-if-absent and root-doc sync all apply unchanged. `--ref <branch|tag>` and `--repo <owner/name>` are validated before any URL is built.
- **`src/helpers/targz-extract.mjs`** — dependency-free hardened extractor: path-traversal aborts the WHOLE extraction (absolute paths, `..` segments, backslash tricks, Windows trailing-dot/space components), links are never materialized (skipped and reported), entry-count and total-byte caps govern the gunzip output too, GNU longnames supported, base-256 numeric fields refused explicitly.
- **`sync-from-github` skill + slash command** — picker over the configured fleet, faithful reporting of the four outcome categories (synced / refreshed / kept-newer / refused-for-safety), and the standing rule that safety refusals are guarantees to respect, never errors to bypass.

### Security — adversarial review before commit (2 agents, 15 verified findings, all addressed or consciously accepted)

- **Network archives are not a trusted plugin store**: under `--sync-from-github`, source plugin dirs are vetted — curated allowlist (skeleton's own `community-plugins.json` ∪ REQUIRED_PLUGINS), strict lowercase name hygiene, manifest-id-matches-folder when a manifest exists, and manifest-less dirs allowed only without executable code (the Lot 2 config-pre-seed pattern).
- **Credential guard normalization**: `CREDENTIAL_LEAK_PLUGINS` was an exact case-sensitive match while Windows resolves paths case-insensitively — `Obsidian-Local-REST-API ` (case + trailing space) dodged the guard yet wrote into the real folder. Lookup now normalizes.
- **Bomb caps actually govern**: every entry's payload (pax/longname/dir metadata included) counts toward `maxTotalBytes`, and the gunzip `maxOutputLength` derives from the caller's limit (a ~575 KB download could previously decompress to half a GB).
- **Parser desyncs closed**: directory entries declaring a payload advance past it; truncated archives fail strictly; a crafted final entry can no longer extract clamped content silently.
- **CLI hardening**: `--ref`/`--repo` refuse flag-like or missing values, unknown flags fail instead of becoming vault paths, `--all` + explicit paths is an error instead of silently syncing the whole fleet, and the `--all` config load happens before any download (no leaked temp dir).
- Consciously accepted (documented): idle-timeout rather than wall-clock download deadline (host is pinned by default), and the pre-existing subcommand-position footgun shared with `--sync-all`.

### Tests

- `tests/targz-extract.test.mjs` — 18 cases: synthesized ustar archives (real checksums) covering happy path, GNU longnames, pax skip, every traversal variant, link smuggling, caps (including metadata payloads), base-256 refusal, dir-desync, truncation, repo/ref validation. E2E verified twice against the real GitHub tarball (2.1 MB → 404 files → 4 curated plugins + Blue Topaz applied to a throwaway vault; hardened flag parsing exercised live). Full suite **2437**, 0 failures.

## [0.54.1] — 2026-07-28 — the linter now reads « Alternatives considérées »

Found by running the pilot consolidation against the real vault, minutes after v0.54.0: the canonical compact form that `decision-consolidate` prescribes writes its table under `## Alternatives considérées` — the natural French for "alternatives considered" — and `ALTERNATIVES_HEADINGS` knew `envisagées` and `écartées` but not `considérées`. Every consolidated page would have shipped with a false `alternatives-missing` warning: the skill's own canon tripping the skill's own linter.

### Fixed

- **`ALTERNATIVES_HEADINGS`** in `src/helpers/decision-lint.mjs` gains `alternatives considerees` / `alternative consideree` (normalized forms — accents are stripped before matching, decorated variants still count via the prefix rule). Full suite **2420**, 0 failures.

## [0.54.0] — 2026-07-28 — decisions can be consolidated: compress + archive, never erase

Roland's ask, verbatim: keep only the final decision and erase the deliberation that "pollutes the context and can mislead an LLM". The accepted contract (meta-vault decision `consolidation-sans-amnesie`, 2026-07-28) keeps the ADR payload intact by splitting the two: **the WHY stays on the page, the CHRONICLE moves out** — into an `archives/` note (`type: decision-archive`) that humans can still browse in Obsidian but that no LLM surface resurfaces by default. Nothing is erased; git keeps every byte anyway.

### Added

- **`decision-consolidate` skill + slash command** — transactional consolidation of a SETTLED decision page (`accepted` / `superseded` / `rejected`, never `proposed` — its deliberation is the working material). Archive written and VERIFIED first (`<page-folder>/archives/<slug>-deliberation.md`), then the page rewritten to canon: verdict **byte-intact**, minimal why, alternatives as a table, `consolidated:` marker, mandatory `## Historique` wikilink to the archive. Piloted on the meta vault's `adr-modes-ecriture` (13.6 KiB of double-banner history compressed, chronicle archived).
- **`search_smart` excludes archived deliberation by default** — hits under an `archives/` folder are dropped by a path-segment test (no extra REST round-trips on the hot path), the response carries `archivesExcluded: N` so the cut is never silent, and the page is overfetched before filtering so exclusion cannot shrink the result set below `limit`. Opt back in with `includeArchives: true`. New helper `src/helpers/archive-filter.mjs`; a folder merely *named* `mes-archives` or a page `archives.md` does not match.
- **Decision lint rule 6 — `consolidated:` coherence** (`src/helpers/decision-lint.mjs`): `consolidated-invalid` (not an ISO date), `consolidated-proposed` (a proposed page must never be consolidated), `consolidated-without-history-link` (no `## Historique` / `## History` section carrying the wikilink to the archive — the one pointer that keeps "compressed" from degrading into "erased"). New exported `findHistorySection()`.
- **Recall exclusion locked by tests** — `type: decision-archive` is deliberately absent from `DECISION_TYPES` on BOTH sides of the contract pair (recall core + lint). New tests pin the three type sets and feed the recall walker an archive note that *mimics* a decision (same tokens, decision-ish fields): the type gate, not luck, is what keeps it out.

### Tests

- `tests/search-archive-filter.test.mjs` (12 cases: segment matching incl. backslashes/anchors/near-miss names, drop+count, overfetch trim, includeArchives pass-through, bridge error shape), rule-6 suite + `findHistorySection` suite in `tests/decision-lint.test.mjs`, archive fixtures in `tests/decisions-recall.test.mjs`. Full suite **2419**, 0 failures.

## [0.53.0] — 2026-07-27 — `npm run release` publishes the backlog, not just the current version

v0.48.0 ended a drift where 40 versions shipped with pushed commits, no tags and no releases. The tooling it introduced worked — for one rhythm: bump, commit, push, repeat. It had a blind spot for the other one, which is the rhythm actually used here: **let several versions accumulate locally, then push the lot**.

Yesterday that blind spot bit. Five commits, five tags, five CHANGELOG entries — `npm run release` pushed the branch, **one** tag, published **one** release, and left four tags local and four holes in the Releases page. Backfilled by hand; the page then showed v0.52.0 as "Latest" because GitHub ranks by creation date and the backfill ran newest-last. Exactly the drift the tooling exists to prevent, arriving through the door it left open.

### Changed

- **`scripts/create-release.mjs` publishes the whole backlog.** It now collects every version that has a CHANGELOG entry **and** a local tag reachable from HEAD **and** no GitHub release, pushes each tag, and publishes them **oldest-first** so the Releases chronology matches the version order.
- **`--latest` lands on the highest version overall**, computed by semver across pending *and* already-published releases — not on whichever release happened to be created last. Backfilling an old version can no longer steal the badge from a newer one.
- **The 108 CHANGELOG entries with no tag are not resurrected.** Requiring a local tag is what excludes them: without a tag there is no commit to release. Requiring *reachable from HEAD* excludes tags belonging to another branch.
- **Guards kept, calibrated per version**: the current version still fails hard on a stub CHANGELOG entry or an uncommitted bump; an older version in the backlog whose notes are a stub is skipped with a warning rather than failing the whole run — its missing notes are not this run's fault, and blocking would strand the versions after it.

### Added

- **Tests** — `parseChangelogVersions`, `selectPendingReleases` (backlog ordering, untagged versions not resurrected, already-published skipped, tag-without-notes skipped, `v` prefix tolerated) and `highestVersion` (semver, not lexicographic: `0.9.0` < `0.52.1`). Full suite **2393**, 0 failures. Replayed against yesterday's exact state, the new selection returns the full `v0.51.0 → v0.52.1` batch with `--latest` on v0.52.1.
## [0.52.1] — 2026-07-27 — a cross-vault successor is not a local page

Found by linting the real vault. A decision retired in favour of one living in **another vault** (`superseded_by: "kiviri:wiki/…"`) was resolved by basename against the local corpus, matched a same-named page there, and was then reported as a broken reciprocity — a requirement that cannot be met across vaults by construction.

### Fixed

- **`isExternalReference()`** in `src/helpers/decision-lint.mjs` — a reference carrying a `slug:` prefix *before any path separator* explicitly names another vault and is left unresolved. A colon inside a note name (`[[Titre: sous-titre]]`) is not one, and `http(s):` is excluded. Full suite **2383**, 0 failures.
## [0.52.0] — 2026-07-26 — template idéal Lot 2: themes propagate, `--theme` applies, BRAT never downgraded

Lot 2 of the template-distribution roadmap (the `template-distribution-roadmap` page in the meta vault). The skeleton already carried Blue Topaz + BRAT + `app.json` defaults (committed `f804151`, reconciled item by item before this work); what was missing was everything that makes those reach vaults: BRAT wasn't even ENABLED in the skeleton's `community-plugins.json`, themes never propagated on bootstrap or sync, the wizard's `--theme` choice was recorded-but-blocked, and a template sync could silently DOWNGRADE a plugin BRAT had auto-updated in a user vault.

### Added

- **`cloneThemes(source, target, force)`** — theme propagation on EVERY path (bootstrap from reference/skeleton/from-vault + `--sync-plugins`/`--sync-all`). Per-theme granularity: an existing theme dir is skipped unless `--force`, and a theme that exists only in the target is NEVER deleted (the old from-vault behavior wiped the whole `themes/` dir on `--force`).
- **`syncAppearanceDefaults(source, target)`** — fresh vaults inherit the template's `appearance.json` (cssTheme / light-dark scheme / accentColor); an existing `appearance.json` is never touched, not even with `--force` — the theme is a per-user preference, not template state.
- **`applyThemeChoice(target, theme)`** — the wizard's `--theme` is now APPLIED: writes `cssTheme` (merge-style, only that key), validates the theme folder exists in the target first, `"obsidian-default"` → `""`. The `plan_vault` planner drops the `theme-blocked` warning and lists an apply step; `provision_vault`'s schema description updated.
- **`isTargetPluginNewer(src, dst)` anti-downgrade guard** — BRAT auto-updates GitHub plugins (bridge, hot-reload) inside user vaults, so sync/`--force` now compares `manifest.json` versions and NEVER replaces a newer installed copy (locked decision 2026-06-19). Fail-open on missing/unparseable manifests. Reported per-vault as `Kept N plugin(s) at the target's NEWER version`.
- **Skeleton completions** — `obsidian42-brat` added to `community-plugins.json` (vendored since `f804151` but never enabled → BRAT never loaded); non-secret `data.json` vendored for `obsidian-quiet-outline` + `obsidian-icon-folder` (per the Lot 2 curation rule: config yes, history/UI-state no — `realclaudian`'s `tabManagerState`, `recent-files`' history and `smart-connections`' install-state are deliberately NOT shipped).
- **NOTICE** — MIT redistribution credits for the two vendored components: Blue Topaz (© 2020 whyt-byte, authors WhyI & Pkmer) and BRAT (© 2024 TfTHacker), with upstream URLs and vendor paths.
- **Tests** — `tests/setup-vault-themes.test.mjs` (16 cases): per-theme skip/force/target-only-preserved, appearance fill-if-absent, `--theme` apply/refuse/default, anti-downgrade newer/equal/older/fail-open. Full suite **2382 tests**, 0 failures.

### Changed

- `setupVault()` prefers the SOURCE vault's `app.json` (skeleton and `--from-vault` carry their own defaults) before falling back to the configured reference vault's.
- Stale comments refreshed: the skeleton-contents doc block (still claimed "no plugin binaries"), `--bootstrap-reference` next-steps (BRAT is in place and auto-updates the bridge at startup).
## [0.51.2] — 2026-07-26 — long frontmatter values were being truncated everywhere

Found by using the thing. Back-filling the reference vault's decision corpus (roadmap Phase 2bis) produced `decision:` one-liners long enough that Obsidian's YAML writer folded them onto continuation lines — the normal representation of a long quoted scalar. The recall block then displayed them **cut mid-sentence and starting with a stray quote**.

The gap was in the minimal frontmatter readers, and it was not confined to the hook: the shared `parseFrontmatter` in `src/helpers/llms-txt-exporter.mjs` had it too, which means **every export built on it** (llms.txt, OKF bundles, page metadata) has been carrying truncated `title:` / `description:` values whenever they were long enough to wrap.

### Fixed

- **Folded quoted scalars are read in full** — in `hooks/_helpers/decisions-recall-core.mjs` and in `src/helpers/llms-txt-exporter.mjs`. Continuation lines are consumed until the quote closes (escape-aware), and parsing resumes cleanly on the next key. Single-line scalars are untouched. Tests pin both readers.
- **A lone `~` is no longer escaped.** Strikethrough needs `~~`, so escaping every tilde only printed backslashes through ordinary values like "~36 tools" — the same over-caution already reverted for `_`. Only the doubled form is neutralized now.

### Changed

- **`decision-input` pages are no longer asked what they ruled out.** The "alternatives considered" rule now applies to verdict types (`decision`, `adr`) only — a decision *input* is material feeding a decision, not a ruling, so demanding its rejected options is a category error. The recall hook already drew that line; the linter now agrees (`VERDICT_TYPES`).

### Reference vault (roadmap Phase 2bis, not shipped code)

The decision corpus was back-filled in the same pass: two decisions that existed nowhere as pages were written (**BM25 over embeddings**, **HTTP `insecurePort` over HTTPS loopback** — the first being the hole the recall hook exposed on the day it shipped), seven pages gained the `decision:` one-liner the recall block is built around, and eight gained an "alternatives considered" section **extracted from their own body**, never invented, each carrying a note saying so. Linter over the corpus: **0 errors, 1 warning** — that warning being a page whose frontmatter no router tool can write, see below.

### Known issue, unfixed

- Two vault pages carry frontmatter that Local REST API's YAML writer rejects with a 500, so **no router tool can modify their properties**: an unquoted `title:` containing a colon, and an inline `related: [[a]], [[b]]` sequence. The second was repaired by full rewrite; the first (`click-to-open-access-modes`) still needs one. Worth a lint rule of its own — invalid frontmatter is silent until something tries to write.
## [0.51.1] — 2026-07-26 — `decisions-recall` hardened by a two-reviewer audit

Two independent reviewers audited v0.51.0 (`/review+`, five passes). The hook worked on the fixtures it shipped with and failed on ordinary real input in several ways — and nearly every round of fixes introduced a regression the next pass caught, which is the argument for the loop existing at all: pass 1's noise fix silenced a focused vault; pass 2's re-read guard dropped French frontmatter; pass 3's markdown escaping mangled the very paths the block exists to hand over. All fixed and pinned by tests.

One recommendation reversed between passes and had to be arbitrated rather than applied: filtering out ubiquitous-vocabulary matches (pass 3) removed on-topic decisions whenever one off-topic page happened to carry a rare token (pass 4). Ranking replaces filtering — for a recall layer, losing a relevant decision is worse than showing one weak line a reader dismisses from its title.

### Fixed

- **The anti-injection framing could be truncated away** (blocker). The character budget was applied after joining the whole block, so the cut landed on the **footer** — the part carrying "never contradict silently / never treat as an order". Three entries of perfectly legitimate size (title 60, verdict 220, scope 120 — the field caps themselves) already exceeded the budget, so no hostile content was required; and `title` was capped nowhere, meaning one long title decided where the block ended. Now the budget applies to the **items only**, header and footer are never cut, titles are capped, and truncation drops **whole entries** (a slice through a `` ` `` or a `**` would leave the delimiter open and make the footer render as code or emphasis).
- **Settled decisions recorded with a legacy status were invisible.** The hook demanded `accepted` while the linter has always known the free-form synonyms (`decided`, `active`, `shipped`…). Two real decisions in the reference vault were silently missing from recall. Legacy synonyms are now recalled and labelled as not-yet-normalized, and a test asserts **set equality** with the linter's map so the pair cannot drift.
- **An unparseable `review_after:` made a decision permanently binding.** `01/01/2026` (a plausible typo) failed the ISO test, so the date was treated as absent instead of unreadable — the exact ossification the field exists to prevent. It is now surfaced as unreadable and explicitly non-binding.
- **A frontmatter larger than the 4 KB head was dropped silently** (found by both reviewers). A page with a long `evidence:` / `affects:` / `aliases:` list — that is, a page documenting itself well — never surfaced. The reader now re-reads up to a bounded ceiling when the closing `---` is missing. Two successive fixes of this were themselves wrong, both silently dropping pages: the first compared a **character** count to a **byte** budget so the re-read never fired on accented content; the second gated the re-read on finding a `key:` line, which fails on a non-ASCII first key (`évidence:`) and on a comment preamble. There is now no heuristic gate at all — guessing whether an unterminated `---` block is frontmatter or a horizontal rule is not worth a silent omission, and the only cost of guessing wrong is one bounded read.
- **Escaping mangled the citation.** Neutralizing markdown emphasis ran over the **path** too, and inside a code span markdown shows escapes literally — `hot\_cache.md` identifies no file, while the block instructs the agent to read exactly that path. Code-span values (path, raw status) are now emitted verbatim, safe because backtick removal already prevents closing the span. A path too long to cite drops its entry rather than emitting a truncated, invalid reference. And `_` is no longer escaped anywhere: CommonMark forbids intraword emphasis with underscores, so `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` cannot open anything — escaping it only degraded every entry in a domain where snake_case is everywhere.
- **A UTF-8 BOM hid the whole frontmatter**, and **an unclosed HTML comment in a page field could swallow the rest of the block**, footer included. Both neutralized.
- **Vault-wide vocabulary drowned the signal.** `router`, in a router repo, matched nearly every decision and spent two of three slots on noise. Ubiquitous tokens are now demoted in peripheral fields (scope, project, tags, filename), and — when any candidate matched on distinctive vocabulary — the merely-ubiquitous matches are dropped rather than spending slots. Two earlier attempts were wrong in opposite directions: demoting everywhere made a focused vault go silent on its own subject (five decisions about embeddings, a question about embeddings, zero results), while demoting only peripheral fields let the noise back in through titles when the project name is a title prefix. A title match stays eligible — it is topical by definition — but it no longer out-competes a real one.
- **Page-controlled markdown could still corrupt the framing.** An unmatched `**` or `_` in a title or verdict opened emphasis that ran on and visually absorbed the footer. Emphasis markers are now escaped (not stripped), along with control and format characters; angle brackets are entity-encoded. And every rendered field — including the **path**, which a deeply nested filename could otherwise use to inject thousands of characters on every matching prompt — is capped, which is what makes a single entry bounded by construction.

### Changed

- **Bounded in wall-clock, not file count.** A vault on a virtual drive (Google Drive File Stream et al.) costs ~30× a local one per file, and a file cap makes recall depend on directory traversal order — thousands of ordinary notes before the decisions folder and nothing surfaces. A deadline degrades in proportion to how slow the storage actually is; the file cap survives only as a runaway backstop. When the scan is cut short the block says so, and `OBSIDIAN_ROUTER_HOOK_DEBUG=true` reports it on stderr along with any swallowed error (the hook still exits 0 in every case).
- **`decision-input` is linted but never recalled** — material feeding a decision is not a verdict.
- **Likely decision directories are walked first** (`decisions/`, `adr/`, `wiki/`). A deadline bounds the walk but does not by itself remove the dependency on traversal order — on slow storage the budget can run out before the decisions folder is ever reached. Visiting the conventional locations up front makes the cut land on the unlikely part of the tree instead.
- Skipped directories match case-insensitively (`.smart-env` and `.claudian` added). README (EN + FR), `docs/features/12` and the hooks' own header comments describe the shipped behaviour rather than the first draft's.
- **Tests: 29 → 66** on this hook (full suite **2374**, 0 failures). The additions are the cases that broke in the wild — BOM, CRLF, oversized frontmatter, legacy status, unreadable review date, single-token noise, focused-vault regression, hostile title, unclosed comment, balanced-delimiter truncation, deadline with partial results returned. Two pre-existing tests were rewritten: one asserted that truncation *existed* using a fixture too small to reach the budget (which is how the blocker slipped through), the other checked the deadline flag with a clock so coarse the walk never started.
## [0.51.0] — 2026-07-26 — `decisions-recall`: the settled decisions come back on their own

The last two releases made the decision layer **complete and checkable**. It was still **passive**: nothing presented a decision to an agent before it acted, so nothing actually stopped the loop the whole practice exists to break — a new session, a different agent, or the same one after a context reset starts blank and re-proposes an approach that was ruled out months ago. Writing the decision down is necessary and insufficient. This release is where the practice starts paying.

Phase 3 of the vault-side ADR roadmap, and the tenth hook in the router: a convention is a nudge, and nudge ≠ enforce — the same lesson that already turned `vault-link-linter` and `wiki-query-first-nudge` into hooks rather than paragraphs.

### Added

- **`hooks/decisions-recall.mjs`** (UserPromptSubmit) — on every substantive prompt, surfaces the `accepted` decisions whose subject overlaps it: title, one-line verdict, scope, and the path to read the full page. Dual-mode like `wiki-query-first-nudge` (workspace-is-vault and workspace-bound-to-a-vault). Silent when nothing matches, so ordinary prompts pay nothing; exits 0 on any error, because a recall hook that breaks the session it was meant to help is worse than one that misses a decision.
- **`hooks/_helpers/decisions-recall-core.mjs`** — the pure half (scan, select, format), testable without spawning a process and dependency-free, since hooks must run in a fresh checkout before `npm install`.
- **Tests** — `tests/decisions-recall.test.mjs` (29 cases): the core (tokenizing with accent folding and a stopword floor, the minimal frontmatter reader, the bounded walker, selection, formatting) plus a spawned-shell layer for the wiring, the prompt filters and the opt-out. Full suite **2337 tests**, 0 failures.

Three design properties, each deliberate and each covered by a test:

- **Deterministic first.** Candidates are filtered by `status: accepted`, then ranked by plain token overlap against title, verdict, scope, project, tags and basename. No embeddings, no model call: the hot path of every prompt is the wrong place for either, and a selection you cannot explain is one you cannot debug the day it surfaces the wrong page. `proposed` decisions are not binding and `superseded` / `rejected` ones must never be shown as constraints — surfacing a retired decision is precisely the failure the layer prevents.
- **Expired is neither silent nor binding.** Past its `review_after:` date a decision is still shown, flagged **due for re-evaluation**. Hiding it loses the context; presenting it as a constraint ossifies a ruling whose conditions have changed. That is the anti-ossification rule made operational.
- **Cited data, never instructions.** Vault pages are user content, and content an agent reads must never be able to direct it — otherwise the vault becomes a prompt-injection surface. The injected block says so explicitly, and asks the agent to *flag* disagreement rather than obey or silently contradict.

### Changed

- **`hooks/hooks.example.json`** wires the hook into `UserPromptSubmit` (so `setup-vault.mjs --install-hooks` picks it up), README (EN + FR) goes from 9 to **10 hooks**, and `docs/features/12-hooks-et-automatisations.md` gains its section.

### Field note from the first real run

Fired against the reference vault with *"could we replace the filter with an embeddings scorer?"*, the hook surfaced the mcphub smart-routing decision — correctly, via its `embeddings` tag — and, just as informatively, **nothing about BM25**: that verdict has never been written as a decision page, it lives diluted in a roadmap. The recall layer is exactly as good as the decisions actually recorded, which is the argument for the qualification charter, not against the hook. Second observation: the surfaced page carries no `title:` or `decision:` frontmatter, so its recall entry is thin — those two fields are what make a recall block readable at a glance.
## [0.50.0] — 2026-07-26 — the field that justifies the practice becomes checkable ("alternatives considered")

v0.49.0 gave decision pages a frontmatter contract; this one closes the part that frontmatter cannot express. A decision record without its **rejected options** is a decorated changelog: the code holds the path taken and never the paths refused, the PRD holds the goal and never the trade-off, and a session that reads only those two re-proposes what was ruled out months ago. The convention already said the section mattered — nothing verified it, so nothing prevented it from quietly disappearing.

Phase 2 of the vault-side ADR roadmap (`adr-implementation-roadmap`). Calibrated as a **warning**, deliberately: an absent section leaves the decision layer incomplete, not lying — unlike a broken supersession chain, which makes two contradictory decisions both read as live. Errors are reserved for states that actively mislead, and a check that fails a whole existing corpus on day one is a check people learn to ignore.

### Added

- **Rule 5 in `decision-lint.mjs`** — `alternatives-missing` when a decision body carries no "what we ruled out" section, and `alternatives-empty` when the heading is there but nothing follows it. The second matters more than it looks: the escape hatch has to be **written**. "No serious alternative" plus the reason (an external constraint, a licence, a third-party limit) is a valid answer; a bare heading satisfies a naive "is the section present?" check while carrying exactly zero of the information the section exists for.
- **`findAlternativesSection(body)`**, exported — returns `{found, empty, heading}` and recognizes both languages of a bilingual vault (`## Alternatives considered`, `## Options écartées`, `## Pourquoi pas autre chose`, `## Alternatives envisagées`, `## Options rejetées`), the decorated bilingual form (`## Alternatives considered · Options écartées`), H2 or H3, and treats a subsection under the heading as content. Heading matching normalizes accents and punctuation, so `## Options écartées :` and `## Options ecartees` both count.
- **Tests** — 14 more cases (52 in the file), covering each heading variant, the written escape hatch, the empty-heading case, the trailing-section case, and the guarantee below. Full suite **2308 tests**, 0 failures.

### Changed

- **Body rules never fire on frontmatter-only input.** `lintDecisions` now tracks whether a page was given as `content` (parseable body) or as pre-parsed `frontmatter`; rule 5 is skipped entirely for the latter. A body rule that reports a missing section against a body it was never handed would make the frontmatter-only calling mode unusable — and that mode is what a caller uses when it already holds the metadata.
- **`heading-hierarchy` convention** — `## Alternatives considered` moves from optional to **required** in the type-minimums table for `decision` / `adr` / `decision-input`, with the rationale, the escape hatch and the accepted French headings spelled out next to it.
- **`wiki-lint` Check N** documents the two new warnings, including the "only checked when you passed `content`" caveat.

### Known state of the reference vault

- A read-only sweep of the vault's seven decision pages found **none** carrying an alternatives section — they predate the contract, and the new rule will flag all seven at the next lint. They were **not** back-filled: inventing options that were never weighed would be fabricating the historical record, which is the one thing a decision log cannot survive. Filling them is a pass to run with the human who made the calls. Related finding: the single page in the vault that *does* document its rejected options (`click-to-open-access-modes`) carries no frontmatter at all, so the decision layer cannot see it — typing it is a one-line fix worth making.
## [0.49.0] — 2026-07-26 — the decision layer gets a contract (normalized statuses + bidirectional `supersedes:`)

A wiki records what is known and what happened; it has never recorded **what is settled** in a machine-checkable way. Decision pages existed (`type: decision` / `adr` / `decision-input`, a `save` flow, heading conventions), but their `status` was free-form — `active`, `decided`, `captured`, a hand-written "(awaiting-validation)" — so nothing could tell a live decision from a retired one, and nothing noticed when a superseding decision left its predecessor still reading as accepted. That is the failure mode the ADR practice exists to prevent: a new session (or a different agent) re-proposes an option that was ruled out months ago, because the ruling was never written in a form anything could query.

This release ships the frontmatter contract and its deterministic checker. It is Phase 1 of the vault-side ADR roadmap (`adr-implementation-roadmap`), whose Phase 0 — the qualification charter that decides *what even deserves* a decision file — was written first, deliberately: normalized statuses don't improve a poorly-fed taxonomy.

### Added

- **`src/helpers/decision-lint.mjs`** — pure-functional linter for the decision layer of a wiki. Validates four rules: (1) `status` present and one of `proposed` | `accepted` | `superseded` | `rejected`, with legacy values (`active`, `decided`, `captured`, `shipped`, `awaiting-validation`, …) reported **together with the normalized value to migrate to**, so a caller can propose a concrete fix instead of a bare rejection; (2) **bidirectional `supersedes:` coherence** — the target must exist, be a decision, and actually carry `status: superseded`, the check that catches two contradictory decisions both reading as live; (3) `affects:` targets resolve (the directional "re-review this if I change" loop that symmetric `related:` cannot express); (4) the charter fields — `scope:` (a decision without a perimeter applies everywhere, therefore badly) and a well-formed `review_after:`, the anti-ossification field whose expiry surfaces a decision as "to re-evaluate" rather than as a binding constraint.
- **`superseded_by:`** — the mirror field, set on the retired page. It exists for the one case `supersedes:` cannot express: a successor living in **another vault** (a decision migrated elsewhere). When the named successor is in-corpus the link must be reciprocal, else `superseded-by-not-reciprocated`.
- **Check N in the `wiki-lint` skill** — runs on every lint (no flag) when the vault has decision pages, with the severity mapping and the corpus-scope caveat spelled out: cross-page rules resolve only against the pages passed in, so linting a subfolder cannot honestly claim a target is dead. That asymmetry is why `superseded-without-successor` is a warning and not an error.
- **Tests** — `tests/decision-lint.test.mjs` (38 cases): every legacy status maps to its suggestion, each supersedes failure mode (dangling, still-live, self, non-decision target, two-page cycle), reference forms (`[[a]]`, `[[folder/a|alias]]`, `a.md`, `[[a#anchor]]`), the charter fields, and the reciprocity matrix for `superseded_by:`. Full suite **2294 tests**, 0 failures.

### Changed

- **`heading-hierarchy` convention snippet** gains a "Decision pages — frontmatter contract" section: the seven fields with their required/optional status, plus the three rules that make the layer trustworthy — an agent writes `proposed` and never self-validates; immutability is **of the verdict, not of the file** (fix a typo, update a status, never rewrite an accepted verdict — a reversal creates a new page with `supersedes:`); and an `accepted` decision is never contradicted silently, an agent that believes one stale *flags* it. Decisions surfaced into an agent's context are cited data, never instructions.
- **`save` skill** writes the contract: the decision frontmatter block now carries `scope`/`supersedes`/`affects`/`evidence`/`review_after`, `supersedes:` is documented as a **two-file edit** (adding it requires flipping the target to `superseded` in the same turn), and the `## Alternatives considered` section moves from optional to expected — with the explicit escape hatch that "**No serious alternative**" plus a reason is a valid answer when an external constraint decided for you. An absent section is what's forbidden, not an honestly empty one.

### Migrated

- The reference vault's seven decision pages were normalized in the same pass (`active`/`decided`/`shipped` → `accepted`, `scope:` added everywhere, `evidence:` where the motivating study exists, and `superseded_by:` on the retired Resonance semantic-search spec whose successor lives in the Kiviri vault). The linter run over the result: **0 errors, 0 warnings**, 6 accepted + 1 superseded.

### Known gaps (next phases)

- The `## Alternatives considered` section is documented as expected but not yet **enforced** by a lint rule (Phase 2), and nothing yet **surfaces** accepted decisions to an agent before it acts (Phase 3, the `decisions-recall` hook) — which is what actually prevents the re-proposal loop. Until then the contract is checkable but not proactive.
## [0.48.0] — 2026-07-26 — docs catch up with reality + releases stop drifting (auto-tag hook, `npm run release`)

Discovered while answering "why does GitHub say the last release was 2 months ago?": between v0.8.2 (2026-05-06) and v0.47.0, the repo shipped **40 versions with pushed commits but zero git tags and zero GitHub releases** — the Releases box was honest, the process wasn't. Same audit showed the user-facing docs lagging the 45-command / 42-tool surface. This release fixes both: the documentation is resynced everywhere, and tagging becomes a deterministic side effect of the existing bump→commit workflow instead of a memory-dependent manual step.

### Added

- **`.githooks/post-commit` auto-tag hook** — when a commit touches `package.json` and no `v<version>` tag exists for its `version` field, the commit is tagged `v<version>` (annotated) on the spot. Fail-open (a post-commit hook must never break a commit); merge commits skipped by design. Lives next to the existing gitleaks `pre-commit` in the versioned `.githooks/` directory.
- **`ensureHooksPath()` in `scripts/bump-version.mjs`** — every real (non-dry-run) bump re-ensures `git config core.hooksPath = .githooks`, so the hook is armed on any clone the moment it bumps; nothing to remember, nothing to drift. The CLI now ends with the 3-step flow (write CHANGELOG → commit auto-tags → `npm run release`).
- **`npm run release`** (`scripts/create-release.mjs`) — pushes the current branch + tag and creates the GitHub release (or idempotently updates it on re-run) with notes extracted from this file's entry for the version. Guards: refuses while the entry still contains the bump `TODO` stub, refuses when the bump isn't committed, self-heals a missing tag on the bump commit, `--dry-run` previews. Requires the `gh` CLI.
- **Tests** — `tests/create-release.test.mjs` (12 cases): `extractChangelogSection` (middle/last entry, subsections, multi-em-dash titles, non-stub headings, literal version matching) + `ensureHooksPath` (unset → set, no-op when wired, rewires foreign paths, fail-open outside a repo). Full suite **2253 tests**, 0 failures.

### Changed

- **README (EN + FR) resynced with the shipped surface** — counts corrected everywhere (40→**45 slash commands**, 35→**42 MCP tools**, ~39→**42 skills**, wrappers 14→**16**, knowledge-management 17→**20**); new `convert/` wrapper section (`pdf-to-markdown`, `pdf-to-markdown-docling`) and `hot-compact` row added; `plan_vault`, `provision_vault`, `pdf_to_images`, `filter_relevant_blocks`, `open_in_obsidian` added to the **Capabilities** and **Tools exposed** tables (both languages).
- **Quick-reference PDFs regenerated after 2 months of drift** — `docs/quick-reference-{en,fr}.html` fully rewritten from the v0.8.11-era content ("31 slash commands") to v0.48.0: 45 commands in 4 category tables, the 42 tools grouped in one page, multi-tenant env vars, `wiki-meta/` layout, wizard-first setup path. PDFs re-rendered via Chrome headless and propagated to the reference vault (`.template/Documentation/`).
- **CONTRIBUTING.md release process** rewritten around the new flow (bump arms the hook → commit auto-tags → `npm run release` publishes); the manual `git tag` step that caused the drift is gone.
## [0.47.0] — 2026-07-17 — `filter_relevant_blocks`: BM25 relevance second-pass over already-acquired markdown (Crawl4AI W-A)

When the router ingests a web page it usually knows *why* — the user asked about a specific topic, or an `autoresearch` loop is chasing a question. But a defuddled article still carries off-topic blocks (lifestyle intro, author bio, newsletter callout, digressions), and today all of it flows into synthesis: tokens wasted, noise in the wiki page. This release borrows Crawl4AI's pattern (`PruningContentFilter` → `BM25ContentFilter` on the same fetched HTML) as **borrowing #1 / workflow W-A**: a **second pass** — a topical-relevance filter — applied to markdown the caller **already holds**, with **no re-fetch, no LLM, no new dependency**, fully deterministic. Our first pass (chrome stripping) is already done by defuddle/MarkItDown; this adds the relevance pass on top. Implemented on Opus 4.8, gated through `/review+` (Claude Code Reviewer + codex) before ship. Design detail: the vault roadmap `bm25-filter-implementation-roadmap` (§4 frozen spec).

### Added

- **`filter_relevant_blocks` MCP tool** (`src/tools/filter-relevant-blocks.mjs`) — `{ markdown, query, threshold?, includeScores? }` → `{ markdown, filtered, stats, scores? }`. Read-only (no vault I/O, no `vault` arg), so it stays exposed under `OBSIDIAN_ROUTER_READONLY`, and it is **not** in `WRITE_TOOL_NAMES`. Usable by any skill on content it already has (defuddle output, pasted text, a file read).
- **Pure helper `src/helpers/bm25-filter.mjs`** — `segmentBlocks()` + `bm25FilterBlocks()`. Standard BM25 (k1=1.2, b=0.75) that **imports** the router's existing `tokenise` + `computeIdf` from `idf-score.mjs` (not a copy); IDF is computed over the document's own scored blocks. Deliberate deviation documented in-code: the repo's smoothed IDF `log(1 + N/(1+df))` is always ≥ 0, unlike textbook BM25 IDF which goes negative for very common terms.
  - **Segmentation**: leading YAML frontmatter kept verbatim; fenced code (``` / ~~~) is one block including internal blank lines; ATX headings are their own block and are **always** kept (a filtered-out section still shows its heading); a code block follows the relevance of the prose that introduces it, and never inherits relevance across a heading boundary.
  - **Guards (never throws — always degrades to a no-op)**: an empty/low-signal `query` → strict no-op (byte-identical output); fewer than 4 scorable blocks → untouched; a filter that would drop >70% of the content (or a query that matches nothing) → returns the **original intact** with `usedFallback: true`. Same `usedFallback` philosophy as `defuddle-extract`.
- **Opt-in `relevanceQuery` (+ `relevanceThreshold`) on `webpage_to_markdown`** — applies the same filter to the converted page in-process, no re-fetch. **Non-regression guaranteed**: without `relevanceQuery` the output is byte-identical to before (the string contract every existing caller depends on); with it, the output stays a markdown string and the filter stats are appended as a single trailing HTML comment.
- **Skill wiring** — `wiki-ingest` gains a step 1.6 that runs the filter after defuddle **only when the ingestion has an explicit theme** (and continues silently on the original if the guard trips); `defuddle` documents the option in its hand-off. The freshness hash stays computed on the pre-filter markdown, so change-detection is unaffected by what a given theme keeps.
- **Tests** — `tests/bm25-filter.test.mjs` + `tests/filter-relevant-blocks.test.mjs` (37 cases): segmentation edge cases, all guard boundaries (exactly-3 → no-op, exactly-70% → filters), byte-identity of every no-op path, a numerically-pinned BM25 score, Unicode/French, determinism, null/undefined-safe input, and the `webpage_to_markdown` string contract via a `_deps.convert` seam. Full suite **2242 tests**, 0 failures.
- **`/review+` gate findings, all resolved before ship**: CRLF input now normalized on the filter path; code-block relevance no longer inherited across headings; `threshold` accepts a numeric string; `bm25FilterBlocks(null)` degrades instead of throwing; guard-boundary and math tests hardened.

## [0.46.0] — 2026-07-14 — hot-cache size limit goes dynamic (single token unit, sober role/threads band)

The hot-cache size discipline (v0.44.0) was a STATIC, two-unit test: block when `words > 500` **OR** `bytes > 6 KiB`, with a separate 1000-word hard cap. Three numbers in two units that aren't directly comparable — Hermès flagged the incoherence (1000 words ≈ 750 tokens, so a token-denominated soft target and a word-denominated hard cap describe contradictory spaces). This release collapses the SEMANTIC size decision onto ONE unit — estimated tokens, what context actually costs — and lets the enforced limit breathe within a NARROW band around the proven ~500-word anchor, driven by only two defensible signals: the vault's role and the number of active threads. Design pressure-tested with three independent voices (Claude + Codex + Hermès); the vault design note `hot-cache-dynamic-limit-design` records the full reasoning, including what was deliberately dropped.

### Added

- **Token-based dynamic budget in `src/helpers/hot-size.mjs`** (additive layer — the historical word/byte functions stay in place and tested):
  - `estimateTokens(text) = ceil(max(chars/4, words×1.3))` — the SINGLE measurement unit. `chars/4` dominates on real (dense) hot content and replaces the old bytes dimension; `words×1.3` is only a conservative floor for char-sparse text; `chars = text.length` (JS code units, NOT UTF-8 bytes) so accented FR isn't over-counted.
  - `computeHotBudget()` / `hotStatus()` — the enforced limit = `clamp(BASE × role + activeThreads×20, floor, ceil)`, an explicit `hot-limit-tokens:` frontmatter override honored up to a fixed absolute cap. Compaction target = 0.7 × limit (hysteresis). No LLM, no I/O — a pure, auditable function of the file text.
  - `parseHotMode()` (vault role from `mode:`/`type:` frontmatter) and `countActiveThreads()` (bullets under `## Active Threads`, capped at 5).

### Changed

- **Calibration to REAL hots.** Measuring live vault hots showed pointer-dense content (markdown + accents + `[[wikilinks]]`/URLs) runs **~1.8 tokens/word**, not the generic 1.3 (398 w → 728 t; 492 w → 889 t). So the proven "500-word" rule, expressed honestly in tokens, is **~900 tokens — NOT 650**: `BASE_LIMIT_TOKENS = 900`, absolute cap `1800` (~1000 words), band `[774, 1224]`. Anchoring at 650 would have false-flagged every healthy hot on disk.
- **The two hooks now decide via `hotStatus`**: `hot-cache-update-prompt.mjs` (Stop guard) blocks only when over the enforced token limit; `hot-cache-load.mjs` (SessionStart injection) bounds by a token-derived byte budget and banners in token language. Guard/loader/`hot-compact` still measure through the ONE shared module, so they can never disagree.
- **Deliberately NOT used** (Hermès's substance): raw edit velocity (measures editorial noise, not the facts worth caching) and a session-frequency term (its sign is disputed — Codex reads it as budget-decreasing, Hermès as budget-increasing). Only vault role + active-thread count drive the modest band.
- `templates/wiki-meta/hot.md` contract line updated to token language. Full suite: **2205 tests** (`tests/hot-size.test.mjs` token battery + band invariant; `tests/hot-cache-load.test.mjs` injection budget).
- **Version resync**: `.claude-plugin/plugin.json` + `marketplace.json` had drifted to v0.44.0; bumped back in sync with `package.json` at v0.46.0.

## [0.45.0] — 2026-07-14 — `build_open_link` verifies the path on disk (no more dead links)

`build_open_link` only URL-encoded whatever path it was handed — garbage in, garbage out. A wrong path (an invented sub-folder, a typo) produced a perfectly-formed URL that 404s at the bridge, indistinguishable from a good one; the chat-link linter/guard exempt well-formed http links, so nothing caught it. Real incident: a link to `wiki/Projects/KIVIRI/SaaS/kiviri-v2-secrets.md` when the file lives at `wiki/Projects/KIVIRI/kiviri-v2-secrets.md`. Diagnosed + design pressure-tested with codex (read-only) on 2026-07-14.

### Changed

- **`build_open_link` now VERIFIES the path against the local vault on disk before emitting a URL** — fail-closed. New helper `src/helpers/resolve-vault-path.mjs::resolveVaultPathOnDisk()` (filesystem-only, mirrors how `click-to-open.mjs` reads `data.json` — no REST call, works offline):
  - exact path exists → normal result;
  - exact miss, **unique** basename match → auto-corrected to the real path (result carries `corrected: true` + `requestedPath`);
  - exact miss, **no** match → single mode THROWS a clear error; batch marks that entry with `error: 'not_found'` + null URL (good entries still resolve);
  - exact miss, **ambiguous** basename (≥2 files) → THROWS / `error: 'ambiguous'` + the candidates — never silently picks one;
  - basename walk truncated on a huge vault → `resolution_incomplete` (never a false not_found/unique);
  - remote vault → `unverifiable`, prior behaviour kept (null URL — remote vaults have no local disk to stat).
- Net guarantee: **no success branch of `build_open_link` reaches the URL builder without a vault-proven path** → the caller can no longer walk away with a dead link. 16 tests (`tests/build-open-link.test.mjs`, `tests/resolve-vault-path.test.mjs`).
- Complements `mcp-router-bridge` v0.5.1, whose `/open` self-heals a wrong-folder path by basename at click time (covers hand-composed / historical links too).
- **Known follow-ups** (codex audit, not fixed here): `move_file` (from===to), `merge_frontmatter` (all-ops-failed), `execute_template` (build from `result.path`) can still emit a URL after a no-op/failure; and the port cache in `click-to-open.mjs` never invalidates on a `data.json` port change.

## [0.44.0] — 2026-07-12 — hot-cache size discipline: bounded injection, guard enforcement, `/hot-compact`

The hot cache (`wiki-meta/hot.md`) finally gets its size ENFORCED. Its own header rule says "< 500 words, overwritten on update — a cache, not a journal", but nothing checked it: the freshness guard (v0.25.0) pushed every wiki-writing session to ADD an entry and nothing ever removed one — an add-only ratchet. The oldest vault's hot silently grew to 129 KB / ~17.8k words (35×), injected into EVERY session start on that vault (~35k tokens burned before any work). Diagnosed 2026-07-12; design pressure-tested with codex the same day; the 129 KB pilot compaction (full backup → 3.3 KB state-first rewrite) was human-approved before this mechanism shipped.

### Added

- **`src/helpers/hot-size.mjs` — the single source of truth for hot sizing.** Words + UTF-8 bytes counting, OR-based over-limit test (> 500 words OR > 6 KiB — words track the semantic promise, bytes catch URL/id-heavy content), compaction targets with hysteresis (≤ 350 words AND ≤ 4 KiB — compacting to 499 would re-trigger immediately), per-vault frontmatter override (`hot-limit-words` / `hot-limit-bytes`, clamped to 1000 words / 12 KiB — an EXPLICIT exception, never implicit growth), block-aware bounded selection (splits prologue vs dated entries, auto-detects newest-first vs append-at-bottom ordering by comparing entry dates, keeps whole blocks from the RECENT side, emits an omission marker — never a mid-line cut), and the bilingual oversize banner. Loader, guard and compaction skill all measure through THIS module so they can never disagree (a disagreement would loop). 26 unit tests (`tests/hot-size.test.mjs`).
- **`/obsidian-router:hot-compact` (skill + command) — the deterministic compaction procedure.** Strict order: measure WITHOUT loading a huge hot into context (script + the vault's own Local REST API) → byte-identical backup `wiki-meta/hot.full-backup-<date-hhmm>.md` VERIFIED by size comparison before any overwrite → thin state-first rewrite (Key Recent Facts · Recent Changes · Active Threads; pinned 📌 blocks always preserved) → concurrency re-check before the final write → traceability line in `log.md`. Human preview required for a vault's FIRST compaction at > 5× the limit; autonomous afterwards (the verified backup makes it reversible).

### Changed

- **`hooks/hot-cache-load.mjs` — bounded injection.** An over-limit hot is no longer injected verbatim: the hook now injects an actionable oversize banner + a bounded excerpt (newest entries first, whole blocks, ≤ the 6 KiB budget; absolute cap 16 KiB whatever the override). Within-limits hots are injected verbatim as before. The hook still never MODIFIES the vault — the rewrite is the session's job. 3 new integration tests.
- **`hooks/hot-cache-update-prompt.mjs` — the guard now enforces SIZE, and its message stops feeding the ratchet.** Two independent violations, both scoped to vaults THIS session touched (a session unrelated to a vault is never blocked for inherited debt): STALE (wiki/ note written, hot not refreshed — as before, but the message now says "REWRITE the current state, don't just stack another entry", the very wording that manufactured the 129 KB file) and OVERSIZED (hot.md on disk exceeds its limits → the block demands `/obsidian-router:hot-compact`). Passing is stateless: a successful compaction brings the file under limits, so the next check clears — no receipt bookkeeping. Fail-open everywhere (unreadable hot → skip, never block).

Full suite: 2171 tests green (2142 + 29 new).

- TODO
## [0.43.0] — 2026-07-10 — `get_page_neighbors` A5: same-folder + shared-tag enrichment

### Added

- **`get_page_neighbors` — two opt-in structural enrichments: `includeSameFolder` and `includeSharedTags`.** The link-based neighbours (`neighbors[]`) only surface pages connected by an actual wikilink — but two pages can be obviously related without ever linking to each other: siblings filed in the same folder, or pages sharing a topical tag. Both signals were already sitting on every article node (`filePath`, `tags`) from the very first knowledge-graph build, so surfacing them costs zero extra graph traversal or network calls. `includeSameFolder: true` adds `sameFolderNeighbors[]` — other pages whose directory prefix matches the resolved page's. `includeSharedTags: true` adds `sharedTagNeighbors[]` — pages sharing at least one REAL tag (the universal `article` tag every page carries is excluded, or every page in the vault would "match" every other page), each entry listing which tags matched via `sharedTags`. Both are **off by default** (existing responses are unchanged), scoped to `article`-type pages regardless of the caller's `nodeTypes`, and capped/flagged the same way as the main neighbour list (`sameFolderTruncated`/`sameFolderTotalFound`, `sharedTagTruncated`/`sharedTagTotalFound`) — no silent truncation. Implements the **A5** appoint of the page-neighbors roadmap, the one item left over from W-A. TDD: 15 new tests (10 helper-level in `tests/graph-neighbors.test.mjs`, 5 tool-level in `tests/get-page-neighbors.test.mjs`); full suite green (2142). Validated end-to-end against the live vault graph (e.g. `Crawl4AI`'s one same-folder sibling, and its 50 tag-sharing pages via the near-universal `bilingual` tag — a useful reminder that shared-tag enrichment is only as discriminating as the vault's own tagging habits).

## [0.42.1] — 2026-07-10 — `docs/features/`: the feature guide, in prose, by category

### Added

- **`docs/features/` — a readable, categorized guide to every feature.** The README documents the whole surface in compact tables — fine as a reference card, hard to read when discovering the project or deciding *whether* a feature fits a need. The new folder reorganizes the same material into 13 category pages (multi-vault routing · read/search · write/edit · templates & Obsidian content · document conversion · web ingestion · wiki/knowledge management · knowledge graph · export/interop (OKF, llms.txt) · links & navigation · security & isolation · hooks · install & administration) plus an index. Every feature follows the same prose structure: **the need it answers → what it actually does → how to use it** (natural-language phrasing, slash command, and raw MCP-call JSON where useful) **→ gotchas** (prerequisites, known traps like the `patch_file` full-heading-ancestry rule or the `tp.mcpTools.prompt` Templater footgun). Written in French (the requesting user's language); an English mirror can follow the quick-reference precedent (`-en`/`-fr`) if needed. Both READMEs (EN + FR) gained a pointer callout next to the quick-reference-PDF one. Docs-only — no server or plugin code changed.

## [0.42.0] — 2026-07-09 — `wiki-neighbors` / `wiki-path` skills — natural-language discovery for the page-neighbors tools

### Added

- **Skills + slash commands for `get_page_neighbors` and `wiki_path`.** The two MCP tools shipped in v0.40.0/v0.41.0 were reachable only by a direct tool call — unlike their closest siblings `build_wiki_graph`/`build_wiki_tour`, which each ship a skill + `/obsidian-router:*` slash command with documented natural-language trigger phrasings. That asymmetry meant a user (or a fresh Claude session) had no discoverable "just ask" entry point into page-neighbourhood/path lookups. This release closes the gap: **`skills/wiki-neighbors/SKILL.md`** + **`commands/wiki-neighbors.md`** (triggers: "what links to X", "show me the backlinks of X" / "quelles pages sont liées à X", "voisins de X") and **`skills/wiki-path/SKILL.md`** + **`commands/wiki-path.md`** (triggers: "how is X connected to Y", "path between X and Y" / "quel rapport entre X et Y", "chemin entre X et Y"), following the exact `wiki-graph`/`wiki-tour` pattern (pre-condition check, ambiguity/not-found/no-path handling, wikilink-formatted output, "when not to use" + anti-patterns + quirks sections). README: two new rows in both the EN and FR "knowledge-management commands" tables (now 17, up from 15). No server code changed — this is a Claude Code plugin-only addition (skills/commands ship with the plugin, not with the `.mcpb` MCP-server bundle), so no MCPHub redeploy is needed for this release.

## [0.41.0] — 2026-07-09 — `wiki_path`: the shortest link chain between two pages

### Added

- **`wiki_path` — "how are page A and page B connected?"** The companion to `get_page_neighbors` (0.40.0): where that tool explores the neighbourhood of one page, this one finds the shortest chain of links **between two** pages and returns the route hop by hop — the "brain GPS" for a wiki. It reuses the exact graph-loading + page-resolution core W-A introduced, so both endpoints resolve the same three ways (exact path / bare name / unique suffix, ambiguity refused with candidates), and it reads the same persisted `wiki-meta/graph/knowledge-graph.json` (run `build_wiki_graph` / `/wiki-graph` first).

  Two semantics matter here and differ from `get_page_neighbors` on purpose. (1) Traversal is **undirected** — a link read either way still connects the two topics, which is the sensible reading of "how are these related?" (whereas neighbours care about link direction). (2) When the two pages are genuinely unconnected, that is **not an error**: the tool returns `found: false` with an explicit `path: null` — two pages can simply be unrelated. `maxDepth` (default 6, ceiling 20) bounds the search; a shortest path longer than it is reported as no path. `from === to` yields the trivial one-page path (length 0). By default the route runs through pages only (`nodeTypes: ["article"]`); widen it to e.g. `["article","entity","topic"]` for "connected via a **shared concept**" paths — often the interesting answer to "what relates A and B?" — with the endpoints always reachable regardless of their own type.

  The traversal (`computePath`, an undirected level-order BFS with parent reconstruction) shipped and was fully tested in 0.40.0's shared helper; this release adds only the thin tool shell (`src/tools/wiki-path.mjs`, same read-validate-delegate-sanitize shape as `get_page_neighbors`) plus its registration. TDD: 11 new tool tests (`tests/wiki-path.test.mjs`); Codex review verdict CLEAN; full suite green (2127). Validated end-to-end against the live vault graph (a real 2-hop route `project-router → Crawl4AI → license-audit`, the trivial self-path, and a `maxDepth: 1` boundary). Completes item W-B of the page-neighbors roadmap (W-C — semantically-enriched neighbours — stays deferred).

## [0.40.0] — 2026-07-09 — `get_page_neighbors`: query one page's neighbourhood in the graph

### Added

- **`get_page_neighbors` — ask the knowledge graph for the neighbours of ONE wiki page.** Until now there was no direct way to answer "which pages are related to X?": `get_wiki_context_pack`'s `graphNeighbors[]` only works off the pages a text query already surfaced (you can't point it at a specific page), and `build_wiki_graph` builds the whole graph but gives you no way to interrogate it locally. The new tool closes that gap — give it a page and it returns the pages that page links to (`forward`), the pages that link to it (`backward`, i.e. backlinks), or both, out to a configurable hop `depth`. It reads the **persisted** `wiki-meta/graph/knowledge-graph.json` that `build_wiki_graph` already wrote — deliberately NOT re-scraping wikilinks from page bodies the way `graphNeighbors[]` does — so it inherits the builder's ambiguity resolution and its backlink bookkeeping for free (run `build_wiki_graph` / `/wiki-graph` first; a missing graph yields an actionable "run it first" message, same as `build_wiki_tour`).

  Three design points earned during a second-pass review of the roadmap, and enforced in code: (1) the graph's `related` edges connect a page not just to other pages but also to the **concepts and claims** it mentions, so the tool filters by **node type** (`nodeTypes`, default `["article"]`) — otherwise "the neighbours of X" would return a mix of pages, concepts and sources; widen it (e.g. `["entity"]`) to instead ask "which concepts does this page mention?". (2) A crossroads page at depth 2 can fan out to hundreds of neighbours, so results are **capped** (`maxNeighbors`, default 50, hard ceiling 200) with a `truncated` flag. (3) An **ambiguous** page name (two `dup.md` in different folders) is **refused with the list of candidate paths** rather than silently resolving to the first — the deliberate difference from the builder's internal resolver, which must pick one to lay down an edge. Output is deterministic (sorted by hop distance then id) and carries `graphAnalyzedAt` so the caller can judge the graph's freshness. Read-only.

  The maths lives in a pure, dependency-injected helper (`src/helpers/graph-neighbors.mjs` — a directed BFS with visited-on-enqueue for minimal hop distances, edge-type + node-type filtering, and the three-step page resolver ported from `wiki-graph-builder.mjs`), with the tool shell (`src/tools/get-page-neighbors.mjs`) mirroring `build_wiki_tour`'s read-validate-delegate-sanitize shape. Because the neighbours query and the upcoming `wiki_path` query (roadmap W-B) share the same graph-loading + page-resolution core, the helper also lands its sibling `computePath` (an UNDIRECTED shortest-path BFS) now — fully tested here, exposed by the `wiki_path` tool in the next release. TDD: 46 new tests (`tests/graph-neighbors.test.mjs`, `tests/get-page-neighbors.test.mjs`); an adversarial Codex correctness pass caught and fixed a `computePath` node-type-filter edge case before ship; full suite green (2116). Implements item W-A of the page-neighbors roadmap.

## [0.39.0] — 2026-07-09 — `pdf_to_images`: render PDF pages for the model to SEE

### Added

- **`pdf_to_images` — render a local PDF's pages to PNG images, returned as MCP image content blocks so the model can visually SEE a page** (not just read its text via `pdf_to_markdown` / `pdf_to_markdown_docling`). Rendering uses **pypdfium2** (Google's PDFium, BSD — the engine behind Chrome's PDF viewer) + Pillow, deliberately NOT poppler (GPL system binary) or MuPDF (AGPL, incompatible with the router's Apache-2.0). Both packages already ship inside the opt-in `.venv-docling`, so a user who enabled Docling gets `pdf_to_images` for free; otherwise the tool returns an actionable install hint. Params: `filepath` (required), `first_page` (default 1), `max_pages` (default 8, hard cap 30), `scale` (default 2.0 ≈ 144 DPI, clamped 0.5–4.0). Because every rendered page is a base64 image billed against the model's context, the tool enforces hard page-count and per-image (12 MB) / total (24 MB) byte caps — refused BEFORE an over-cap file is read into memory (same discipline as Docling's on-disk output cap). **Core plumbing:** `wrapResult` now passes a ready MCP `{content:[…]}` payload through untouched (via the new `isMcpContentPayload`) instead of JSON-stringifying it — `pdf_to_images` is the router's first tool to return non-text (image) content; every existing text/object-returning tool is unaffected. New: `scripts/render-pdf-images.py`, `src/markdownify/pdf-images.mjs`, `pdfToImagesTool` in `src/tools/convert.mjs`, env var `PDF_IMAGES_PYTHON`. TDD: 24 new tests in `tests/pdf-images.test.mjs`; full suite green (2070). Implements the borrowings-roadmap §2.14 idea (pypdfium2, base64 delivery).

## [0.38.0] — 2026-07-09 — `build_wiki_graph`: layers are now Louvain communities

### Added

- **`src/helpers/louvain.mjs` — deterministic Louvain community detection.** A dependency-free, pure implementation of the Louvain modularity-maximisation algorithm (local-moving + aggregation levels) that partitions an undirected weighted graph into communities. It is built to be **byte-stable**: nodes are indexed in code-unit id order (not locale-sensitive `localeCompare`), edges are folded in a canonical `(min-endpoint, max-endpoint, weight)` order so parallel/mixed-orientation edges sum the same regardless of input order, and community-gain ties are broken toward *staying put* then by lowest index — no `Math.random`, no clock. Exposes `detectCommunities(nodeIds, edges, { resolution })` and a `modularity(...)` utility. Correctness (gain formula, the `2m` normalisation, the aggregation self-loop bookkeeping, and every determinism property) was verified across four adversarial Codex review passes. Tests: `tests/louvain.test.mjs` (23 cases, including the canonical two-triangles-with-a-bridge structure, weighted graphs, and order-independence).

### Changed

- **`build_wiki_graph` — `layers[]` now reflects the graph's real community structure, not the `index.md` sections.** Previously each `index.md` heading became one layer. That is a hand-written table of contents, and many nodes (entities, claims, sources, unlisted pages) landed in no layer at all — so it could not drive "colour by community" in the graph viewer, which needs every node assigned to exactly one group. The builder now runs Louvain over the whole graph and emits one layer per detected community, each named after its most-connected member (usually a topic or a hub page) and tagged `method: "louvain"`. **The `index.md` taxonomy is not lost** — it still produces the `topic` nodes and `categorized_under` edges it always did; the two groupings now coexist and complement each other (curated taxonomy vs. discovered clusters). Community detection stays fully deterministic, so the written `knowledge-graph.json` remains byte-stable for a given vault. `src/helpers/wiki-graph-builder.mjs` (new `buildLayers` helper + a `communityResolution` option, default `1`). Roadmap item #1 step 2.5 of the Understand-Anything borrowings.

## [0.37.1] — 2026-07-08 — Docling: placeholder image export (no base64 bloat)

### Changed

- **`pdf_to_markdown_docling` now defaults to `--image-export-mode placeholder`.** Docling's default (`embedded`) inlines every figure as a base64 data-URI: on an illustrated PDF the images dwarf the text and can blow the `MAX_OUTPUT_BYTES` cap for no readable gain — real case: a 4-page SVT course sheet → **3.3 MB output, 99.6% base64, for ~14 KB of actual text**. `buildDoclingArgs` now passes `--image-export-mode placeholder`, so each figure becomes a `<!-- image -->` marker and the same PDF yields **14.6 KB** of vault-friendly text (×228 smaller) — hierarchy, the comparison table (TableFormer), and UTF-8 accents all preserved. Externalizing images as files (`referenced` mode) stays out of scope: it would require persisting the output dir, which the single-file read-back in `readProducedMarkdown` does not do. New regression test in `tests/docling-markdownify.test.mjs`; `src/markdownify/docling.mjs`.

## [0.37.0] — 2026-07-07 — Docling opt-in high-fidelity PDF conversion

### Added

- **`pdf_to_markdown_docling` — opt-in high-fidelity PDF → markdown via Docling.** A new conversion tool (and `/pdf-to-markdown-docling` slash command) that runs [Docling](https://github.com/docling-project/docling)'s standard pipeline (layout detection + TableFormer table-structure recognition) instead of MarkItDown's `pdfminer.six` backend — reconstructing tables and reading order that MarkItDown loses (benchmarks: 88% vs 82% F1), at ~10× the CPU cost. **Opt-in and in-process**, mirroring the MarkItDown pattern: a *separate* `.venv-docling` is created at postinstall ONLY when `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` is set before install (or via `npm run install-docling`); `pip install docling` pulls ~1-2 GB of torch/onnxruntime + models. The tool is always listed — an uninstalled Docling yields an actionable call-time hint, never a startup failure. Scope is **PDF only** (DOCX/PPTX/XLSX/web keep MarkItDown, where Docling shows no advantage). New: `scripts/install-docling.mjs`, `src/markdownify/docling.mjs`, `resolveDoclingPath` in `src/markdownify/utils.mjs`, `pdfToMarkdownDocling` in `src/tools/convert.mjs`, `commands/pdf-to-markdown.md` + `commands/pdf-to-markdown-docling.md`, env vars `OBSIDIAN_ROUTER_ENABLE_DOCLING` / `DOCLING_PATH`. Tests: `tests/docling-markdownify.test.mjs` + `tests/install-docling.test.mjs`. Design spec: `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.

## [0.36.1] — 2026-07-06 — the link linter stops "correcting" valid URLs to another vault's port

A patch release whose CHANGELOG entry was written into `[Unreleased]` and never promoted: the v0.37.0 bump renamed that heading, so this version's work was filed under Docling for a month. Restored here, unchanged, from commits `6ca915c`, `2efc5c5`, `ef5cd40` and `b29f6eb` — all of which landed before the 0.36.1 bump. Suite at the time: **2003/2003**.

### Fixed

- **`vault-link-linter` — wrong-port false positive on multi-vault path collision.** Pass 2 resolved the vault owning a click-to-open URL by **path only** (default vault first, then `portRegistry` insertion order). Scaffold paths (`wiki-meta/index.md`, `wiki-meta/log.md`, …) exist in **every** bootstrapped vault, so a perfectly correct URL was flagged `[wrong-port]` against whichever vault sorted first — with a suggested "fix" pointing at the **wrong vault's** port (incident 2026-07-06: a valid `http://127.0.0.1:27134/open/wiki-meta%2Findex.md` link to vault `RECHERCHES ETUDES SUP` was "corrected" to `27161`, the `.template` reference vault's port). The URL's port is now the primary disambiguation signal: new `findOwningVaults()` returns **all** owner vaults, and the URL is accepted if **any** of them actually serves the actual port for the scheme (`http` → `insecurePort` + `enableInsecureServer`; `https` → `port`). Only when no owner serves the port is the violation raised, with the suggestion built against the **first owner with a readable `data.json`** (not blindly the first owner — a registry-first vault like `.template` may have no Local REST API plugin configured at all). 5 new regression tests (`wrong-port multi-vault collision`), including the still-blocks guards (port matching no vault; port matching a vault whose insecure server is disabled; first owner missing `data.json` entirely). Adversarial multi-agent review of the fix confirmed one accepted tradeoff (documented in the hook's header): when a colliding path's URL port matches a *non-intended* owner vault, the link is now accepted rather than flagged — unavoidable without more context, and strictly better than resurrecting the original false-positive.

### Changed

- **Reference vault skeleton — richer default config (propagates via `meta-sync-template`).** `templates/reference-vault-skeleton/.obsidian/`: set a default theme (Blue Topaz / moonstone base) + reading-mode default (`defaultViewMode: preview`, `livePreview: false`), and enabled 6 UX community plugins in `community-plugins.json` (`realclaudian`, `image-converter`, `obsidian-icon-folder`, `recent-files-obsidian`, `rich-text-editor`, `obsidian-style-settings`). Dev-only plugins (`hot-reload`, `obsidian42-brat`) were deliberately excluded so they don't propagate to end-user/family vaults. New vaults provisioned from the skeleton — and existing vaults synced via `meta-sync-template` — inherit these.

- **Skills `write-*` / `manage-*` — concise "On failure" section (no silent FS fallback).** When a router call fails, the skill mandates remediation instead of a silent fallback to direct-filesystem tools: connection error (`ECONNREFUSED`/timeout) → `list_vaults` + **ask the user to open the vault** via the clickable `openUri` link and wait; validation/API error (HTTP 4xx, e.g. `invalid-target`) → fix the call or use a coarser ROUTER tool (`write_file`, `append_to_file`) — never `Read`/`Edit`/`Write` on the vault's real path. Applied to `write-patch`, `write-append`, `write-create-or-replace`, `write-frontmatter-set`, `write-frontmatter-merge`, `manage-move`, `manage-delete`. Each block is a tight 3-liner (imperative rule + the two failure classes); the full rationale and message template live once in the `default-vault-health-check` convention (canonical source) to avoid maintenance drift across the 7 skills. Requested by Roland 2026-07-05 after an FS-fallback incident in a DEDIBOX session.
- **Convention `default-vault-health-check` — new "Échec en cours de session" section (canonical source for the rule above).** The installable snippet covers mid-session failures with the two-class remediation (connection → open-the-vault prompt; validation → fix the call), the full rationale (FS writes bypass Local REST API, lose the authoritative `clickToOpenUrl`, skip the router guard rails), and a new anti-pattern line banning the silent FS fallback. The per-skill blocks point here.

## [0.36.0] — 2026-07-03 — Vault wizard W3: `meta-attach-vault` v2 (defaults-first) + harness-agnostic playbook

Layer 2 of the guided vault-creation wizard — the frontends. The wizard is now defaults-first end-to-end: compute a complete plan, show it in one line, accept as-is (happy path = 1 interaction) or adjust any single point, provision in one call.

### Changed

- **`meta-attach-vault` skill → v2 (defaults-first).** The workspace-first flow now calls **`plan_vault`** to compute the default plan + questionnaire, presents it as a one-liner ("Plan proposé: … · OK tel quel, ou ajuster ?"), collects only the adjustments the user wants (each point individually, the 5 wiki modes shown with their explanations), then provisions in ONE **`provision_vault`** call with `open: true` + `probe: true`. Preserves the existing didactics — git pedagogy, credential-safety rationale, the conventions picker, the workspace `.gitignore` edit — and adds the automated tail (programmatic Obsidian open + health probe). A `--dry-run`/CLI fallback keeps it working on older or gated routers where the tools are hidden.

### Added

- **`docs/vault-wizard.md`** — the harness-agnostic playbook: the manual an agent WITHOUT a skill system (Codex, Hermes, a raw MCP client…) reads to drive the same `plan_vault` → present → adjust → `provision_vault` flow. Documents the 5 wiki modes, the security gates (LOCAL-ONLY, path-restricted), the tool-input ↔ CLI-flag mapping, and the layer-0 fallback.
- **README** — a "Guided vault-creation wizard" callout in Prerequisites pointing at the skill, the playbook, and the CLI.

### Tests

- Docs/skill phase — no new engine code; full suite stays **1998** green.

## [0.35.0] — 2026-07-03 — Vault wizard W2: `plan_vault` + `provision_vault` MCP tools (harness-agnostic) + security gates

Layer 1 of the guided vault-creation wizard: the wizard becomes usable from ANY MCP client (Claude, Codex, Hermes, a raw MCP call…), not just the CLI. Both tools drive the SAME layer-0 engine (`scripts/setup-vault.mjs`), so there's one source of truth for provisioning.

### Added

- **`plan_vault` (read-only)** — returns the computed defaults + a structured questionnaire (the 5 wiki modes each with an explanation, the themes actually installed in the source vault, the registered vaults you can copy config from, the plugin profiles) + warnings + ordered steps, WITHOUT writing anything. Runs the engine in `--dry-run --json` and shapes the result. New `src/tools/plan-vault.mjs`. The wizard lives in this data — any harness LLM drives the conversation, then calls `provision_vault`.
- **`provision_vault`** — creates a vault in one call from a set of answers; returns a step report + `port`, `insecurePort`, `openUri`, `probeResult`. New `src/tools/provision-vault.mjs`. Shared engine bridge `src/helpers/vault-wizard-engine.mjs` (compose flags → spawn `setup-vault.mjs` → parse the `##PROVISION_RESULT##` marker the engine now emits on a real `--json` run).
- **`scripts/vault-plan.mjs`**: exported `WIKI_MODES` (the 5 modes + descriptions), `availableThemes`, `copyableVaults`; `buildProvisionPlan` now enriches `context` with `copyableVaults` + `availableThemes` for the questionnaire.

### Security (non-negotiable — spec §7.3)

- **Both tools are LOCAL-ONLY**: absent from the tool list AND refused at CallTool when `OBSIDIAN_ROUTER_USER_ID` is set (a gated MCPHub/Tribu deployment) — same pattern as the `MD_ALLOWED_PATHS` sandbox. `provision_vault` writes to the local filesystem, so it must never be reachable from a shared/multi-tenant router. New `LOCAL_ONLY_TOOL_NAMES` gate in `computeExposedTools` + the CallTool guard.
- **`provision_vault` refuses any target path outside the known vault roots** (config `vaultsRoot` + `portRegistry` roots) unless `allowOutsideRoots: true` — no remote-driven arbitrary `mkdir`/write. The gate reuses the engine's own `path-outside-known-roots` computation, so the CLI and the tool agree.
- **`--from-vault` credential exclusions** (`workspace.json` + secret `data.json` never copied, port + API key regenerated) apply regardless of the calling layer. `provision_vault` never wires the user's global `~/.claude/settings.json` hooks (`hooksWired: false`) — an MCP call must not silently mutate global config.

### Tests

- **`tests/plan-vault.test.mjs`** (3) + **`tests/provision-vault.test.mjs`** (6, incl. the path gate refuse+override, the gated-hidden gate, and a `--from-vault` secret-exclusion check). Full suite **1981 → 1990** green.

## [0.34.0] — 2026-07-03 — Vault wizard W1: engine flags (`--dry-run/--json`, `--name`, `--from-vault`, `--plugins`, `--wiki-mode`, `--claude-workspace`, `--open`, `--probe`, `--git-init`)

Layer 0 of the guided vault-creation wizard (spec + plan under `docs/superpowers/`). Every flag is ADDITIVE — a plain `setup-vault.mjs <path>` bootstrap is byte-identical to before (the entire prior test suite stays green).

### Added

- **`--dry-run [--json]`** — build the complete provisioning plan (resolved name/slug/path/source/plugins/theme/wiki-mode + ordered steps + warnings) WITHOUT touching the filesystem. New pure planning module `scripts/vault-plan.mjs` (`buildProvisionPlan`, `resolveSourceVault`, `resolvePluginProfile`, `knownVaultRoots`, `isPathWithinRoots`) — imported by the CLI and (next, W2) by the `plan_vault` MCP tool, so the wizard lives in the plan DATA, not any harness. `--json` emits the machine-readable plan consumed by the `meta-attach-vault` skill's pre-flight.
- **`--name "<Display>"`** — display name → lowercased slug; writes `vaultNames` when it differs from the path basename; the plan flags slug collisions against the registry.
- **`--from-vault <slug|path>` [`--with-folder-tree`]** — clone config ONLY from an existing vault (plugins, snippets, appearance, `.smart-env`, root `CLAUDE.md`). `workspace.json` and credentialed `data.json` are never copied; the REST API port + API key are always regenerated. `--with-folder-tree` recreates the source's `wiki/` folder tree EMPTY — structure without a single note.
- **`--from-skeleton`** — scaffold from the shipped skeleton + download the bridge (delegates to the existing `--bootstrap-reference` flow, whose distinct end-state — a skeleton to finish in Obsidian — is intentional: the skeleton ships no marketplace plugin binaries).
- **`--bare`** — minimal vault: the 2 REQUIRED plugins only.
- **`--plugins recommended|minimal|custom:a,b,c`** — plugin profile (default `recommended` = the source's enabled set, per the W0 derive-from-source refactor).
- **`--wiki-mode personal|research|business|code|domain` [`--wiki-sections "A,B,C"`]** — seed `index.md`/`overview.md` per mode. `domain` lays out the sections the frontend passes explicitly (engine stays 100% deterministic — no AI). No `--wiki-mode` → the generic template, unchanged.
- **`--claude-workspace`** — enable the router plugin in the bound workspace's `.claude/settings.json` (idempotent merge, preserves other keys; needs `--link-workspace`). Verifies the global marketplace registration read-only and guides the user rather than blind-writing global settings.
- **`--open`** — launch Obsidian on the new vault via `obsidian://open`.
- **`--probe [--probe-timeout N]`** — poll the REST port for a health verdict (non-zero exit if red; expected red until the user clicks "Trust author and enable plugins").
- **`--git-init`** — `git init` + initial commit inside the new vault (off by default — vaults often live on Google Drive / iCloud).

### Blocked / deferred

- **`--theme "<name>"`** is parsed and recorded in the plan but NOT applied — the `cssTheme` write lands with the in-flight Lot 2 Blue Topaz chantier. A real run warns rather than silently ignoring the choice.

### Tests

- **`tests/vault-plan.test.mjs`** (15) + **`tests/setup-vault-wizard-flags.test.mjs`** (16) — the latter includes a `--from-vault` security suite (zero secret copied, `workspace.json` excluded, no note content, folder-tree only with the flag) and a backward-compat plain-bootstrap proof. Full suite **1943 → 1974** green.

## [0.33.1] — 2026-07-03 — Vault wizard W0: clone `Documentation/` root docs + derive the plugin list from the source

Prerequisite fixes for the guided vault-creation wizard (spec `docs/superpowers/specs/2026-07-03-vault-wizard-design.md`, plan `docs/superpowers/plans/2026-07-03-vault-wizard.md`), landed as their own release before any wizard feature. No behavior change for existing invocations.

### Fixed

- **`cloneRootDocs` clones the reference's `Documentation/` folder.** The reference vault (`.template`) reorganized its human docs (quick-reference PDFs, `SETUP.md`, the vault-facing `CLAUDE.md`) from the vault root into `Documentation/`, but `ROOT_FILES_TO_CLONE` still listed the individual PDFs at root — so a fresh vault silently cloned only `.claude`. The list is now `['README.md', 'Documentation', '.claude']`: the reference's whole docs folder is cloned (the dir-aware recursive copy was already in place), `README.md` still covers the shipped skeleton (which keeps its README at root and has no `Documentation/`), and non-existent entries are skipped so the list is a safe union across source shapes.

### Changed

- **Plugin clone list is now DERIVED from the source vault's `community-plugins.json`.** New pure helper `scripts/plugin-resolver.mjs` (`resolvePluginsToClone(referenceVault, requiredPlugins)`) reads the reference's own enabled-plugin list and unions it with `REQUIRED_PLUGINS`. This replaces the hardcoded `OPTIONAL_PLUGINS`/`PLUGINS_TO_CLONE` constants, which drifted out of sync with the skeleton's `community-plugins.json` ("activated but never cloned" — plugins added to the skeleton were enabled but absent from the constant). Any plugin the reference enables now propagates automatically; `REQUIRED_PLUGINS` stays the only hard list (a physically-missing required plugin still fails loudly). `--sync-plugins` was already reference-dir-listing-based and is unchanged. The helper is a separate pure module (like `path-helpers.mjs`) so it is unit-testable without triggering `setup-vault.mjs`'s top-level CLI dispatch.

### Tests

- **`tests/setup-vault-plugins-derived.test.mjs`** (6 cases) + **`tests/setup-vault-root-docs.test.mjs`** (2 cases). Full suite **1935 → 1943** green — the entire prior suite stays green, proving zero behavior change for existing `setup-vault.mjs` invocations.

## [0.33.0] — 2026-07-03 — OKF interop: export any wiki subset as an Open Knowledge Format bundle + conformance validator

First brick of the OKF interoperability commitment (see the vault page `okf-interop`): Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (spec v0.1) formalizes the Karpathy LLM-wiki pattern the router has implemented all along. Decision on record: **OKF is the exchange format at the edges** — the vault's internal structure (wikilinks, `wiki-meta/` scaffolds, newest-last log) never changes; everything the standard requires is regenerated at export time. Import (`mount`/`ingest`) and the headless-app integration are the next bricks.

### Added

- **`wiki-export --target okf`** — export a scoped subset of a vault's wiki as a conformant OKF v0.1 knowledge bundle under `wiki-meta/exports/okf/<name>/`, ready to `git init` + push and be consumed by any OKF-aware agent. New pure helper **`src/helpers/okf-bundle-exporter.mjs`** (`buildOkfBundle`, deterministic, injected clock): filename slugification to Google's reference-implementation charset (no spaces/accents — `Cours 2 - Réseaux.md` → `cours-2-reseaux.md`) with full link remapping; `[[wikilink]]`/`![[embed]]` → **relative** markdown links (the spec recommends root-absolute `/x.md`, but Google's own reference agent forbids leading `/` — we side with the implementation); frontmatter mapping emitting the **four keys Google's tooling requires in practice** (`type`, `title`, `description`, `timestamp` — the spec alone requires only `type`), `url`→`resource`, newest known date → `timestamp`, `description` synthesized from the first paragraph when missing, unmapped keys (e.g. `source_type`) preserved as legal OKF extensions; one `index.md` per directory grouped by `type` (`* [Title](file.md) - description`), bundle-root index carrying only `okf_version: '0.1'`; newest-first `log.md`; reserved-name (`index.md`/`log.md` as content pages, §3.1) and slug-collision renames; optional self-installing agent README (`--readme-agent`, the Cole Medin bundle pattern). Dangling links to non-exported pages are kept and reported — legal OKF ("not-yet-written knowledge", §5.3). Heading/block anchors and embeds are lossy conversions and are reported, never silent.
- **`wiki-lint --okf <path>`** — Check M: validate any bundle (our exports or third-party clones) against the spec's **three conformance rules** via the new pure helper **`src/helpers/okf-conformance-checker.mjs`** (`checkOkfConformance`). Google ships no standalone validator — this is one of the ecosystem's first. Severity calibrated to OKF's permissive-consumption philosophy: rule violations are errors; spec-by-example deviations (index heading level, bullet marker, log order) are warnings; reference-implementation compat gaps (filename charset, the 4-key requirement) are warnings/info.
- **Slash commands `/obsidian-router:okf-export` + `/obsidian-router:okf-check`** — thin dedicated entry points for the two flows above (exporting a bundle and validating one are distinct intents with their own arguments); the existing `/wiki-export` and `/wiki-lint` commands cross-reference them. Plugin surface: 38 → **40 commands** (README counts synced EN + FR).

### Tests

- **`tests/okf-bundle-exporter.test.mjs`** + **`tests/okf-conformance-checker.test.mjs`** (61 new cases), including the cross-check that every exporter-produced bundle passes the conformance checker with zero errors. Full suite **1838 → 1899** green.

## [0.32.0] — 2026-06-18 — Hot Reload propagation + `--force` preserves plugin `data.json`

The router half of the bridge v0.5.0 click-to-open foreground work: make pjeby's [Hot Reload](https://github.com/pjeby/hot-reload) propagate to vaults "like the bridge", so `deploy:all` live-reloads the bridge in every open vault with no manual "Reload app" per instance. Plus a `--force` data-loss fix surfaced by that work's `/review+`.

### Added

- **`hot-reload` in `OPTIONAL_PLUGINS`.** `setup-vault.mjs` now clones pjeby's Hot Reload from the reference vault (when present) and enables it in the target's `community-plugins.json`, exactly like the other optional plugins. Combined with the `.hotreload` marker the bridge's `deploy.mjs` drops into its own folder (bridge v0.5.0+), a Hot-Reload-equipped vault auto-reloads the bridge whenever its `main.js` changes on disk — i.e. on every `deploy:all`. Propagation rides the existing recursive plugin copy (`fs.cpSync`), which carries the dotfile marker. *Not* added to the shipped `reference-vault-skeleton/community-plugins.json`: Hot Reload is GitHub-only (not in the marketplace) and the skeleton ships no binaries, so a skeleton entry would just be enabled-but-absent; propagation is via the clone-from-reference path instead.

### Fixed

- **`setupVault` (`--force`) now preserves each plugin's `data.json`.** The full-bootstrap clone loop did a bare `rmSync` + re-clone with no preservation, so re-running `setup-vault.mjs <vault> --force` (a documented repair action) silently reset per-vault plugin settings to the reference's defaults. Now that the bridge's `data.json` holds real user settings (the v0.5.0 `foregroundViaProtocol` toggle, plus the presence heartbeat config), that clobber would lose them. The loop now reads → preserves → writes-back `data.json` on a `--force` re-clone for every non-credential plugin — matching what `syncPluginsMode` already did (the two paths had diverged). The REST API's `data.json` stays exempt (it's intentionally re-derived by the port/apiKey adoption logic). Caught by `/review+`.

## [0.31.3] — 2026-06-17 — doc-drift detector: hardening + a regression test that actually guards

`/review+` follow-up to v0.31.2 (Code Reviewer + codex). codex caught that the v0.31.2 regression test didn't actually test the fix.

### Fixed

- **`doc-drift-detector` gate hardened** — the `wiki/<projectSlug>/` existence check now also requires it to be a directory (`statSync().isDirectory()`, parity with `listCatalogBasenames`), and `detectDocDrift`'s JSDoc documents the early-return precondition.

### Tests

- **The v0.31.2 regression test now actually guards the regression.** Its fixture string accidentally contained the current version token (`v2.0.0`), so the old `index-version` regex matched it and the test passed even *without* the gate — testing nothing. The fixture is now version-token-free; **verified empirically** (gate disabled → test fails with the `index-version` issue; gate restored → green). Full suite 1838 green.

## [0.31.2] — 2026-06-17 — doc-drift detector: scope to vaults that document the project

### Fixed

- **`doc-drift-detector` no longer flags unrelated vaults.** The SessionStart `vault-doc-startup-check` reports the first candidate vault with drift; once the project's own vault was up to date, the loop fell through and the `index-version` check flagged an *unrelated* router-scaffolded vault (e.g. a TradingView vault) for "wiki-meta/index.md doesn't mention vX.Y.Z" — it never does, it has zero router content. The detector now gates on `wiki/<projectSlug>/` existing: a vault that doesn't host the project's wiki folder returns no drift. Checks #1/#3/#4 were already guarded by their project-specific pages existing; #2 (index) was the only leak. +1 regression test (`doc-drift-detector.test.mjs`).

## [0.31.1] — 2026-06-17 — youtube_to_markdown: yt-dlp caption fallback

### Added

- **`youtube_to_markdown` yt-dlp caption fallback** (`src/markdownify/youtube-fallback.mjs`). MarkItDown's YouTube path (page scrape + youtube-transcript-api) returns "fetch failed" on videos that DO have captions; on primary failure the tool now extracts captions via `yt-dlp` (`--skip-download`, native VTT/SRT, parsed in-process — no ffmpeg needed) and assembles a markdown transcript. Contract unchanged — plain markdown string, no vault writes (yt-dlp writes only to a private mkdtemp, cleaned up). New env vars **`YTDLP_PATH`** + **`OBSIDIAN_ROUTER_VIDEO_SUBLANGS`** (default `en.*,en`); the fallback degrades with a clear install hint when yt-dlp is absent.

### Security

- The yt-dlp fallback is bounded to real YouTube **video** URLs: it extracts a canonical 11-char video id and hands yt-dlp a freshly-rebuilt `https://www.youtube.com/watch?v=<id>` — **never the caller's raw URL**. This closes the SSRF surface (open-redirect `youtube.com/redirect?q=…`, query-param smuggling, playlist fan-out) that a host-only check would leave open. Subprocess hardening mirrors the existing converters: `execFile` (never `shell:true`), `--` separator, `maxBuffer`, `AbortSignal.timeout`, plus a 10 MB cap on the caption-file read (yt-dlp writes outside the stdout `maxBuffer`). Surfaced + closed across a 4-pass `/review+` (Code Reviewer + codex review).

### Tests

- **`tests/youtube-fallback.test.mjs`** (new, 23 cases — node:test + dependency-injection seams). Full suite **1814 → 1837** green.

## [0.31.0] — 2026-06-10 — Smart links: durable per-note links with device-side resolution

The multi-device answer to "which open-link do I give?" — local mirror vs streamed GUI. The server can never know which device will click (the same chat is read from a desktop with a synced mirror AND a phone), so the choice moves to click time: the router emits ONE stable https smart link per note; a tiny resolver page (private saas repo) probes the clicking device's OWN loopback for a live mirror (presence heartbeats from the bridge v0.4.0, replicated by LiveSync), falls back to an `obsidian://` deep link, then to the streamed GUI via the view-agent (tunnel mounted lazily at that moment). Full design: vault note `smart-link-resolver`.

### Added

- **`src/helpers/smart-link.mjs`** — HMAC-SHA256 token (`base64url(JSON{v,n,exp}) + '.' + base64url(sig)`, 30-day default TTL, timing-safe verify) + smart-link URL builder + `smartLinkEnabled(env)` gating on **`OBSIDIAN_ROUTER_SMART_LINK_URL`** + **`OBSIDIAN_ROUTER_SMART_LINK_SECRET`**. The token format is contract-pinned cross-repo (the resolver pins the same literal test vector; byte-exact + cross-verify proven at integration).
- **Smart link takes priority over the view-agent everywhere a `viewLink` is produced** (v0.29.0 write auto-injection + `open_in_obsidian` remote path): when configured, the `viewLink` field carries the smart URL with `viewLinkKind: 'smart'` — a pure local HMAC computation, **zero network call on writes** (faster, immune to a dead agent). Without the env vars, behaviour is byte-identical to v0.30.1 (`viewLinkKind: 'agent'` on the agent path). The `viewLink` field name is unchanged — zero breaking change for memory-directive consumers.
- **Boot-time warning when smart links are HALF-configured** (exactly one of the two env vars set — likely a typo): stderr notice instead of a silent fallback.

### Tests

- **`tests/smart-link.test.mjs`** (new) — build/verify round-trip, expiry/tamper rejection, strict canonical token shape (malleability hardening), URL shape, gating, and the pinned cross-implementation vector; plus smart-priority / never-throws / existence-check / env-off-regression coverage across **`tests/view-link.test.mjs`** and **`tests/open-in-obsidian.test.mjs`**. Full suite **1772 → 1814** green.

## [0.30.1] — 2026-06-09 — `open_in_obsidian`: honour the anchor contract on the remote view-link path

`/review+` follow-up to v0.30.0 (Code Reviewer + codex, convergent finding). The remote view-link path of `open_in_obsidian` silently dropped a requested `anchor`, even though the schema/description advertise heading scroll. An Obsidian heading is not deep-linkable through the tunnel (the GUI opens on the note), so the behaviour can't be honoured remotely — but it must not be silent.

### Fixed

- **`open_in_obsidian` no longer silently drops `anchor` on the remote view-link path.** It now echoes the anchor with **`anchorApplied: false`** (remote viewLink) / **`anchorApplied: true`** (local bridge navigate, when honoured) — a symmetric, predictable contract — plus a hint stating the note opens at the top. The tool description states the limitation. A comment documents the deliberate long timeout on the user-initiated view-agent call (allows a cold cloudflared tunnel; the eager write path uses a short timeout + circuit-breaker instead). **No behaviour change for the common no-anchor "show me a note" case.**

### Tests

- **`tests/open-in-obsidian.test.mjs`** — +1 (view-agent + anchor → `viewLink` + `anchorApplied:false`). Full suite **1771 → 1772** green.
## [0.30.0] — 2026-06-09 — `open_in_obsidian` returns a `viewLink` for remote-container vaults

Closes the READ side of the view-link story. The v0.29.0 `viewLink` auto-injection only fires on note WRITES; a pure "show me / open note X" is a read, so it produced no link — and in the field the AI reached for `open_in_obsidian` (browser-less local navigate), which can't work for a remote container vault (the user has no local Obsidian to raise) and gave up instead of falling through to `get_view_link`. Now `open_in_obsidian` itself returns a view-link when a view-agent is configured, so "show me a note" yields the link whichever of the two "open" tools the AI picks.

### Changed

- **`open_in_obsidian` returns a `viewLink` when `OBSIDIAN_ROUTER_VIEW_AGENT_URL` is set.** For a remote-container deployment it asks the view-agent for an ephemeral browser link to the live GUI on the note (the agent also navigates the container's Obsidian there) instead of the bridge `/open` navigate the user couldn't see. **Best-effort + non-breaking**: if the view-agent is unreachable it falls through to the original bridge navigate; with no view-agent configured the behaviour is byte-identical to before (local deployments unaffected). Uses the shared `fetchViewLink` (throwOnError:false). The tool description is updated so the AI knows it yields a link for remote vaults.

### Tests

- **`tests/open-in-obsidian.test.mjs`** — +2 (view-agent configured → `viewLink`, no bridge `/open`; view-agent unreachable → falls through to the bridge) + a `beforeEach` that clears the env so the existing bridge-path tests stay isolated. Full suite **1769 → 1771** green.

### Notes

- The deterministic complement to v0.29.0's write-time injection: writes fabricate the link in their result; "open/show" reads now fabricate it via `open_in_obsidian`. Both "open a note" tools (`get_view_link`, `open_in_obsidian`) now yield a view-link on a remote deployment — the user gets the link regardless of which one the AI reaches for.
## [0.29.0] — 2026-06-09 — deterministic `viewLink` on note writes (Option B) + view-link exposure gating

Makes the ephemeral read-link **deterministic**. Instead of relying on the AI to remember to call `get_view_link` (a prompt nudge that, in the field, the AI skipped — it told Roland "no public link" when `clickToOpenUrl` came back null for a remote vault), the router now **attaches a `viewLink` to the result of every note write**, server-side. The write *fabricates* the link; the AI only has to relay it. Born from Roland 2026-06-09 ("B même si transitoire je veux que ça fonctionne parfaitement"). Same view-agent transport as `get_view_link`; both now share `src/helpers/view-link.mjs`.

### Added

- **Deterministic `viewLink` auto-injection** on the 6 note-write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file` — the `VIEW_LINK_TOOLS` set). A central hook in the CallTool dispatch (next to the audit-log block) calls `viewLinkForWrite({ vaultName: result.vault, note: result.to || result.path })` after a successful write and merges `{ viewLink }` into the result. **Never breaks a write**: gated by `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (silent + zero latency when unset), skips `wiki-meta/` housekeeping (no link, no wasted tunnel), and on a configured-but-failing agent returns a discreet `{ viewLinkError }` instead of throwing. Excludes `delete_file` (note gone) + non-note writes.
- **`src/helpers/view-link.mjs`** — shared transport. `fetchViewLink(...)` (pure, used by `get_view_link` with `throwOnError: true`) + `viewLinkForWrite(...)` (spread-ready `{ viewLink } | { viewLinkError } | {}`, never throws). `get_view_link` refactored onto it (no behaviour change).

### Changed

- **Exposure gating (geste 1 of the "provider model")** — `get_view_link` is now **hidden from ListTools when `OBSIDIAN_ROUTER_VIEW_AGENT_URL` is unset**, via the new pure, testable `computeExposedTools(tools, { readonly, viewAgentConfigured })` (which also subsumes the existing READONLY filter). A published router without the optional view-agent infra carries **zero dead/confusing view-link tool** — the feature is invisible until you bring your own provider. The router is coupled to a `/view` **contract**, not to any specific host.
- **`get_view_link` description broadened** so the AI reaches for it whenever the user asks for a link to read/see/open a note (not only right after a write), and is explicitly told that a null `clickToOpenUrl` (remote vault) means "call get_view_link", not "there is no public link" — the exact failure observed in the field.

### Tests

- **`tests/view-link.test.mjs`** (transport + `viewLinkForWrite` never-throws / gating / skip-wiki-meta) + **`tests/view-link-wiring.test.mjs`** (`VIEW_LINK_TOOLS` membership + `computeExposedTools` gating matrix). Full suite **1741 → 1761** green.

### Notes

- The companion view-agent's idle-timeout was raised (15 → 30 min) so consecutive writes in a conversation reuse a warm tunnel — only the first write of a cold conversation pays the ~15 s `cloudflared` cold-start. Deployment infra (Dedibox), not part of the npm package.
## [0.28.0] — 2026-06-08 — `get_view_link` tool — ephemeral one-click "view link" to a vault's live Obsidian GUI

New MCP tool `get_view_link({ vault?, note? })` that returns an ephemeral, ready-to-click browser link to **view** a vault's live Obsidian GUI, navigated to a specific note, with HTTP basic-auth baked into the URL (the user types nothing). The interim answer — before the headless web app's per-note magic-links — to Roland's "every memory the AI writes should come with a one-click read link" (2026-06-08). The router calls a small **view-agent** service (on the Dedibox, where the GUIs live) over WireGuard; the agent starts an on-demand `cloudflared` quick tunnel to the container's Selkies GUI, navigates Obsidian to the note (Local REST API `/open`), and returns the URL. Tunnels auto-close after an idle timeout, so the GUI is never permanently exposed.

### Added

- **`get_view_link` MCP tool** (`src/tools/get-view-link.mjs`). Read-only wrt vault content (it only spins a tunnel + moves the UI) → **excluded from `WRITE_TOOL_NAMES`** (stays exposed under `OBSIDIAN_ROUTER_READONLY`). Resolves the vault through the registry (honours the default-vault cascade), then issues `GET <agent>/view?vault=&note=`. Optional `note` opens the GUI on that file; omit `vault` for the default vault.
- **Two config env vars** (per router instance): `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (required, e.g. `http://10.8.0.1:27200`) and `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN` (optional shared secret, sent as `X-View-Token`). An unset URL makes the tool throw a clear "not configured" error rather than failing obscurely.

### Tests

- **`tests/get-view-link.test.mjs`** (8 tests, added to the `npm test` list) — happy path (vault/note query, auth-in-URL passthrough, idle-timeout echo), token header, trailing-slash base, and errors (unset config, non-string note, view-agent error status, unreachable agent).

### Notes

- The companion **view-agent** (python stdlib + `cloudflared`) runs on the Dedibox, bound to the WireGuard IP only, with cron `@reboot` + `*/2` crash-recovery. It is deployment infrastructure for the Tribu MCPHub instance, not part of the npm package.
## [0.27.0] — 2026-06-04 — rename `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` → `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` (clearer; old name kept as a deprecated alias)

The v0.26.0 env var `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` was misleading on two counts: **"REQUIRE"** implied the WireGuard tunnel had to be *up* (it's a boot-time config check on the configured baseUrls, not a runtime probe), and the name hid that **loopback also passes** (so it's not "WireGuard-only"). Renamed to `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK`, which says exactly what passes. Born from Roland 2026-06-04 ("le flag REQUIRE_WIREGUARD n'est pas assez explicite, il m'a induit en erreur").

### Changed

- **Renamed `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` → `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK`.** Identical behavior (refuse to start if any *served* vault's `baseUrl` host is neither loopback nor in `10.8.0.0/24`). The boot error message + docstring now state it's a **config check that does not require the tunnel to be up**, and list loopback (`127.0.0.1`/`::1`/`localhost`) explicitly.
- **Backward-compatible alias.** The old `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` is still honored: `loadRegistry` reads `ENFORCE_WG_OR_LOOPBACK ?? REQUIRE_WIREGUARD` (new name wins when both are set). Using the old name logs a **one-time** (once-per-process) deprecation warning to stderr — latched so a `config.json` hot-reload doesn't re-spam it (review+ pass 1). **No existing deployment breaks.**

### Tests

- **`tests/vault-env-config.test.mjs`** — the global-guard tests migrated to the new name + 3 added (deprecated alias still triggers the guard; new name takes precedence over the alias; deprecation warning fires once per process, not on every reload). Full suite **1730 → 1733**.

## [0.26.0] — 2026-06-03 — global WireGuard enforcement (per-vault `wireguard` flag removed)

Replaces the per-vault `wireguard` boolean — wrong granularity (WireGuard is a *deployment-wide* invariant, not a per-vault attribute) and unused in production — with a **global boot-time enforcement**. Born from Roland 2026-06-03 ("on sait que dans MCPHub WireGuard doit être activé, point final"): a per-vault opt-in flag contradicts a uniform invariant. The `VAULT_*` descriptor now reduces to 3 fields (`name`/`baseUrl`/`apiKey`) on an MCPHub deployment — `tlsInsecure`/`https` only apply to the local-HTTPS-loopback case, not the http-over-WG hop.

### Added

- **`OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` env var.** When truthy (`true`/`1`/`yes`/`on`), `loadRegistry` **refuses to start** (throws, naming the offenders — baseUrl shown, never apiKey) if any *served* vault's `baseUrl` host is neither loopback (`127.0.0.1`/`::1`/`localhost`) nor inside the `10.8.0.0/24` WireGuard mesh. Fail-closed; loopback exempt (co-located vault transits no network); runs **after** the `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist (a non-WG vault filtered out doesn't trip it). Opt-in — unset = no enforcement, local mode byte-identical. Helpers `isTruthyEnv` + `hostIsWireguardOrLoopback` (exposed in `_internals`).

### Removed

- **Per-vault `wireguard` flag.** Dropped from the `VAULT_*` / `remoteVaults` descriptor and from `parseEnvVaults` (with its per-vault "host outside 10.8.0.x" warning). A leftover `wireguard` key in a JSON entry is now silently ignored. `scripts/gen-obsidian-deploy.mjs` no longer emits the field (the `wg`-mode `10.8.0.x` host validation stays — it keeps a generated `wg` baseUrl inside the mesh so it passes the global enforce).

### Tests

- **`tests/vault-env-config.test.mjs`** — per-vault-flag tests replaced by "leftover key ignored" + 4 global-enforcement integration tests (refuse on non-WG served vault, pass on WG/loopback, offender filtered by ALLOWED_VAULTS doesn't trip, unset = no-op) + unit tests for `hostIsWireguardOrLoopback` / `isTruthyEnv`. `tests/gen-obsidian-deploy.test.mjs` round-trip assertions updated. Full suite 1722 → **1728**.

## [0.25.0] — 2026-06-03 — hot-cache freshness GUARD (deterministic, default-on for all vaults)

Turns the `hot-cache-update-prompt` Stop hook from a soft *nudge* into a deterministic **guard**: if a session writes a note under a vault's `wiki/` but never refreshes that vault's `wiki-meta/hot.md`, the turn is **blocked (exit 2)** until hot.md is refreshed — so the recent-context cache stays current *by construction*. Same enforcement pattern as `vault-link-linter` / the user-level `chat-link-guard`. Born from Roland 2026-06-03 ("le hot doit toujours être à jour"): the nudge was advisory, so hot.md drifted stale whenever it wasn't acted on. The hook is already wired in the `Stop` event of every vault's `~/.claude/settings.json`, so the new behavior is **live for all vaults with zero re-wiring**.

### Changed

- **`hooks/hot-cache-update-prompt.mjs` rewritten as a blocking guard.** Was: `git diff`/`git log` detection + a stdout nudge (exit 0, never blocked). Now: **transcript-scoped** detection (this session's `tool_use` calls) + **exit 2** when a vault has a `wiki/` write but no `wiki-meta/hot.md` refresh. Transcript-scoped on purpose — git would also flag a *concurrent* session's uncommitted changes or a manual Obsidian edit (neither fixable by this Claude → false blocks), and Roland runs concurrent sessions on the same vaults; it also drops the git dependency. Trigger is `wiki/` **notes only** — pure `wiki-meta/` scaffold edits (index/log/overview) don't trigger, since the hot refresh is the satisfying action. **Per-vault**: each vault is judged independently; a vault whose root can't be resolved is skipped (fail-open). Recursion guard via `stop_hook_active`; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD=true`; fails **open** on any error. Filename + Stop-event wiring unchanged → no `settings.json` churn across the 10 deployed vaults.

### Added

- **`src/helpers/hot-staleness.mjs`** — pure, dependency-free classification logic (`extractWriteToolUses`, `classifyToolUse`, `pathKind`, `findStaleVaults`). All I/O (router config, platform) is injected by the hook, so the decision layer is unit-tested without touching the filesystem or spawning a subprocess.

### Tests

- **`tests/hot-cache-guard.test.mjs`** (29 tests) — pure layer (write-tool detection incl. MCPHub-namespaced names, path kinds, per-vault staleness, built-in `Edit` ↔ MCP cross-matching on the same vault, Windows case-insensitive root matching, unresolvable-vault fail-open) + the hook end-to-end via `spawnSync` (exit 2 on stale, exit 0 on refreshed / scaffold-only / opt-out / recursion-guard / no-transcript). Full suite 1680 → **1709**.

## [0.24.0] — 2026-06-02 — `open_in_obsidian` tool (browser-free "open this note")

A new MCP tool that opens a note in the running Obsidian — and raises its window — **without a browser**. Born from a long click-to-open debugging session: in **Claude Desktop**, every clicked link is routed through a `claude.ai` proxy that opens it in a browser tab, so a click-to-open *link* can never be browser-free there. Calling the bridge server-side sidesteps that entirely.

### Added

- **`open_in_obsidian(vault?, path, anchor?)`** (`src/tools/open-in-obsidian.mjs` + `openInObsidian` in `src/rest-client.mjs`). Calls the bridge plugin's public `/open` route **server-side** (router process → loopback HTTP → bridge), so Obsidian navigates to the file and the bridge raises its window with **zero browser involved**. The browser-free counterpart to a click-to-open *link*: clients that proxy clicked links through a browser (notably Claude Desktop) can't avoid a browser tab on an http link, but this tool never touches it. Works the same in Claude Code CLI and Claude Desktop (both speak MCP). Optional `anchor` scrolls to a heading (same `?h=` mechanism as click-to-open, reusing `encodeVaultPath` + `normalizeAnchor`). **Navigation-only** (no content write) → allowed under `OBSIDIAN_ROUTER_READONLY`. Requires `mcp-router-bridge` ≥ 0.2.0 + Obsidian running for the vault; a missing file / down Obsidian surfaces a categorized tool error. MCP tool count 34 → 35.

### Tests

- **`tests/open-in-obsidian.test.mjs`** (7 tests) — a local HTTP server records the request target; asserts the tool fires `GET /open/<encoded-path>` (+ `?h=<heading>` when an anchor is given, leading `#` stripped, whitespace→none), validates `path` / `anchor`, and propagates an unreachable-Obsidian error.

## [0.23.0] — 2026-06-02 — `log-discipline` convention (thin log index + `Sessions/` detail)

A convention/docs release. Adds an installable convention that codifies the **thin-index** model for `wiki-meta/log.md`: every entry is a short bilingual summary linking to a detailed journal in `wiki-meta/Sessions/`, instead of multi-paragraph detail pasted under a log `## H2`. No `src/` runtime change.

### Added

- **`log-discipline` installable convention** (`skills/conventions/snippets/log-discipline.md`, id `log-discipline`; install per-vault via `/obsidian-router:conventions install log-discipline`). Codifies: a log entry is `## YYYY-MM-DD — <topic> · [[YYYY-MM-DD-<slug>]]` + a one-sentence FR/EN lead; the full detail lives in `wiki-meta/Sessions/<date>-<slug>.md` (frontmatter `type: session-log`, ending in `## Voir aussi / See also`); append-only, **newest at the bottom**. It documents that the `session-auto-journal` hook and `/save` already emit thin entries — the only behaviour it corrects is Claude pasting fat multi-paragraph detail under a log `## H2`. The `skills/conventions/SKILL.md` mapping table grows 10 → 11.
- **Wiki scaffold `templates/wiki-meta/log.md` now documents the curated `## H2` milestone format.** New vaults bootstrap with a note describing the thin-`## H2` + `Sessions/`-link model alongside the one-line operation log, and point at the `log-discipline` convention.

### Fixed

- **`bump-version.mjs` now syncs the README version badge too.** The shields.io badge in `README.md` (EN + FR) drifted repeatedly — stuck at v0.10.3, then v0.19.1, while `package.json` moved on — because `npm run bump` only rewrote the three JSON version files and the badge had to be hand-edited (and was forgotten). The bump script now treats the README badge as a fourth target via a dedicated, idempotent `updateReadmeBadge()` that **throws if the badge is missing** (so a rename surfaces loudly instead of silently no-op'ing). Re-synced the badge to the current 0.22.0. +7 tests in `tests/bump-version.test.mjs`.

## [0.22.0] — 2026-06-02 — click-to-open heading anchors (`build_open_link` `anchor`)

Deep-linking for click-to-open: a generated link can now land on a specific heading inside a note and surface it in the file tree. Pairs with **bridge plugin v0.3.0** (which reads `?h=` and runs the treeview reveal). Router-side this is purely additive — links without an anchor are byte-identical to before.

### Added

- **`build_open_link` — optional `anchor` (single mode).** Pass `anchor: "Installation"` → the tool emits `…/open/<path>?h=Installation`; the bridge (≥ 0.3.0) scrolls to that heading on open and reveals + selects the note in the file-explorer tree. **Read-only** — Obsidian headings are their own anchor, nothing is written into the note. Leading `#` optional; spaces/accents URL-encoded; the anchor travels as a **query param** (a `#fragment` is never sent to the server). Rejected with `paths` (an anchor is per-target). Result echoes the normalized `anchor` and the `clickToOpenUrl`/`markdownLink` carry the `?h=`.
- **`buildClickToOpenUrl(vault, path, { anchor })` + exported `normalizeAnchor()`** (`src/helpers/click-to-open.mjs`). The shared helper (used by every write/get/patch tool's `clickToOpenUrl` field) gained `opts.anchor`; fully backward compatible — no opts → identical URL.

### Fixed

- **`vault-link-linter` tolerates anchored URLs.** The wrong-port pass now splits the `?h=` query before resolving the file — otherwise an anchored URL never resolved to a real file and its port was silently left unchecked — and PRESERVES the anchor in the suggested correction.
- **Markdown-safe URL encoding (`encodeUriMarkdownSafe`).** `encodeURIComponent` leaves `(` / `)` literal, so a heading like `Step 1) Setup` — or a pre-existing file named `foo (draft).md` — produced a `markdownLink` whose `[..](..)` destination terminated early at the `)`. Both parens are now percent-encoded (`%28`/`%29`) in `encodeVaultPath` (fixes the pre-existing path case too) and in the anchor; the linter's `composeSuggestion` mirrors it. Transparent server-side (`decodeURIComponent`), byte-identical for paren-free paths (codex review finding).

### Tests

- +18 across `tests/click-to-open-helper.test.mjs`, `tests/build-open-link.test.mjs`, `tests/vault-link-linter.test.mjs` (anchor encoding, `#`-strip, whitespace→no-query, batch rejection, backward-compat, and wrong-port-with-anchor preservation). Full suite: **1662 green**. The companion bridge v0.3.0 adds its first 13 tests (`parseOpenParams`).

## [0.21.1] — 2026-06-02 — linter catches bare relative vault paths; `--tls-insecure` generator flag

A hooks + tooling release. Headline: a **fix to the `vault-link-linter` Stop hook** so it finally catches the bare-relative-path class of broken vault link — the recurring "you wrote `` `wiki-meta/index.md` `` and it renders as a dead `<cwd>/wiki-meta/index.md` link" bug. Plus the previously-unreleased `--tls-insecure` generator flag. `src/` runtime is untouched.

### Fixed

- **`vault-link-linter` (Stop hook) now catches BARE RELATIVE vault paths** — the exact class of broken link reported repeatedly. The linter previously flagged only markdown-link hrefs (`[x](wiki/y.md)`, the `bare-path` kind) and absolute cwd+vault phantom paths (`cwd-vault-mix`); a **bare relative token** like `wiki-meta/index.md` slipped through twice over: (a) `stripCode()` deleted inline-code spans *before* any detection ran, so the dominant backtick-wrapped form was invisible, and (b) no pass scanned bare relative tokens. Yet the Claude Code renderer clickifies such tokens against the workspace **cwd**, so in workspace-bound mode (cwd ≠ vault) they render as a dead `<cwd>/wiki-meta/index.md` link. New **Pass 4 (`bare-vault-path`)** scans both inline-code spans and bare prose for `wiki/`- and `wiki-meta/`-prefixed relative `.md` paths and blocks (exit 2) when the path resolves to a real file in a vault **other than the cwd**. Three gates keep it zero-false-positive: *resolves-to-a-real-vault-file* + *vault-is-not-the-cwd* + *not-a-real-local-file* — so repo files (`README.md`, `src/x.mjs`), fenced code examples, and cwd-is-vault mode are all left alone. The hook's `build_open_link` companion (and the MCP write/get/patch tools' `clickToOpenUrl` field) give the correct URL to emit.

### Added

- **`gen-obsidian-deploy` — `--tls-insecure` flag.** The generator now emits `tlsInsecure: true` into the `VAULT_*` line on request (default stays `false` = verify). For an `https` baseUrl served behind a self-signed / internal-CA cert the router can't validate — e.g. a self-signed nginx placed in front of the REST API. The router already honored `tlsInsecure` on `VAULT_*` entries (v0.20.0); previously the generator hard-coded `false`, so this exposes the existing capability. Round-trips through `parseEnvVaults` (asserted in tests).

### Tests

- **`tests/vault-link-linter.test.mjs`** — +11 cases for the new `bare-vault-path` pass: backtick-wrapped + bare-prose detection, the wrong-prefix / fenced-code / cwd-is-vault / non-resolving exemptions, no-double-flag-with-Pass-1, dedupe, and the exact 2026-06-01 backtick-wrapped `wiki-meta/` regression. Full suite: **1644 green**.

## [0.21.0] — 2026-06-01 — deploy generator for Obsidian-on-host containers (vault-hosting Phase 1)

A tooling-only release: a generator that turns one vault descriptor into the artifacts needed to run that vault as a `linuxserver/obsidian` (Selkies) container on a host (e.g. the Dedibox) and wire it back to the router via a `VAULT_*` env line. Pure functions, fully tested, **secret-safe**. No runtime/router behavior changes — `src/` is untouched, so this is additive and risk-free for existing deployments. Groundwork for the vault-hosting roadmap (Obsidian-in-browser via Selkies + Sealskin, replacing the old xrdp/Guacamole plan).

### Added

- **`scripts/gen-obsidian-deploy.mjs`** — generates, from one vault descriptor: (1) a docker-compose **service** (`linuxserver/obsidian`, `/config` = plain-markdown vault, `shm_size: 1gb`, optional hardening that disables the in-GUI terminal/sudo); (2) an **nginx GUI reverse-proxy** block (any mode, WebSocket upgrade, per-mode IP ACL, always-present cert directives) for the Selkies web viewer, plus an **nginx REST proxy** in `public` mode; (3) the **`VAULT_<NAME>=<JSON>`** env line for the router. **Network model:** the REST port is published on the interface the router actually uses — `wg`→the WireGuard host, `lan`→the LAN host (both reached directly, no nginx for REST), `public`→loopback (nginx + Let's Encrypt proxies it). The GUI host port is **unique per vault** (`guiPort`, default `restPort+1000`) so vaults don't collide on `:3001`. nginx→container uses a **resolver-variable `proxy_pass`** (self-heals on container IP-shuffle — the 502 class from the 2026-05-29 incident). **Security guard:** a `--sensitive` vault may only be `--mode wg` (refuses `public` AND `lan`). **Secret-safe:** `apiKey`/`password` default to `<token>`/`<password>` placeholders — never invented, never logged into the notes. Pure functions + a CLI.
- **`deploy/dedibox-obsidian/`** — deploy scaffold: a README runbook (network model, deploy steps, LiveSync **Setup URI** onboarding for pushing a local vault → CouchDB, the E2EE↔viewer tradeoff, acceptance test, rollback), `.env.example`, and committed example outputs (`tribu` wg, `coursera` public).

### Tests

- **`tests/gen-obsidian-deploy.test.mjs`** (56 tests) — validation (incl. the sensitive+public AND sensitive+lan refusals, derived-guiPort range check), per-mode baseUrl/bind/nginx/compose coherence, GUI-port uniqueness, YAML magic-scalar quoting, CLI `--no-harden`, `renderPlanText` (no literal `null` block in wg/lan), secret-safety across compose+nginx, and the headline guarantee: **the generated `VAULT_*` line round-trips through the router's real `parseEnvVaults`** (registry.mjs), so the generator can't drift from what the router accepts. Full suite: **1630 green**.

### Notes

- Shaped by an in-repo `review+` pass (Code Reviewer + codex). Fixes applied before first publish: REST baseUrl/bind coherence per mode (a loopback bind with a WG/LAN baseUrl would have been unreachable), always-emit nginx cert directives (so blocks are `nginx -t`-loadable), per-mode GUI ACL, unique GUI host port, the `sensitive`-requires-`wg` guard, and the `--no-harden` CLI flag.

## [0.20.0] — 2026-05-31 — `VAULT_*` dashboard config, structured errors, MCP Resources

Three additive, opt-in steps toward an MCPHub-editable, more MCP-mature router (Phases 1-3 of the `router-saas` roadmap). All backward-compatible: with no `VAULT_*` env var set, the registry behaves byte-identically to 0.19.x — local mode is untouched.

### Added

- **`VAULT_*` env-var vault config — a 3rd config source** (`src/registry.mjs`). One env var per vault, `VAULT_<NAME>=<JSON>`, editable directly from the MCPHub server's Environment Variables UI — no more SSH + `config.json` edit. Required: `name`, `baseUrl`, `apiKey` (the **bare token**; the router adds `Authorization: Bearer ` itself). Optional: `description`, `wireguard`, `tlsInsecure`, `timeoutMs`. Merged after `portRegistry` + `remoteVaults`; a `VAULT_*` entry **overrides** any same-name vault from those sources (the existing portRegistry-vs-remoteVaults order is untouched). Defensive + non-fatal: a malformed entry is skipped with a clear stderr warning naming the faulty key — one bad var can't take down the other vaults. **Security:** on a JSON-parse failure neither the raw value nor the parser's error message is logged (both can echo the `apiKey`); on a missing-field failure the parsed object is redacted via `redactSecrets()`. A `wireguard:true` vault whose `baseUrl` host is outside the `10.8.0.x` WireGuard range raises a warning. `VAULT_PATH` is excluded from the scan (it's the tier-2 default-vault hint, not a vault config).
- **Structured tool errors — `errorCategory` + `isRetryable`** (`src/error-classify.mjs`, wired into `src/index.mjs`; MCP standard #4). Every tool error result now carries a machine-readable classification in `_meta` (and `Category:` / `Retryable:` lines in the readable text): `transient` (unreachable / timeout / 5xx → retryable), `permission` (401 / 403 / Cloudflare Access / read-only / vault lock), `validation` (404 / 409 / unknown vault), or `unknown`. Lets an agent auto-retry a transient WireGuard drop instead of failing the whole call.
- **MCP Resources** (`src/resources.mjs`; MCP standard #6). Declares `capabilities.resources` and adds `ListResources` / `ReadResource` handlers exposing the wiki catalogue **read-only**: per active vault, `wiki-meta/index.md` + `wiki-meta/overview.md`, plus a synthetic router-wide `obsidian-router://_catalog` (vault names + type + baseUrl — **never** apiKeys). URI scheme `obsidian-router://<vault>/<id>`. Read-only by nature → safe on `OBSIDIAN_ROUTER_READONLY=true` instances. Cuts agent discovery cost versus looping `list_files` / `list_vaults`.

### Tests

- `tests/vault-env-config.test.mjs`, `tests/structured-errors.test.mjs`, `tests/mcp-resources.test.mjs` — parse / merge / override / retro-compat, the full `kind` → category taxonomy, and resource URI / list / read logic.

## [0.19.1] — 2026-05-30 — fix: `build_open_link` schema 400'd the Anthropic API (top-level `oneOf`)

`build_open_link` shipped (v0.14.9) a top-level `oneOf` in its `input_schema` to encode the `path` xor `paths` contract. It's valid JSON Schema, but the **Anthropic Messages API rejects `oneOf` / `allOf` / `anyOf` at the top level of any tool's `input_schema`** — even alongside `type: object`. Any client that inlines the full router catalogue into a `tools` request (e.g. **MCPHub**) therefore got a hard `400 tools.<N>.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`, failing the whole request. Direct Claude Code sessions were unaffected — MCP tools are loaded on demand there, so the schema is never inlined.

### Fixed

- **Removed the top-level `oneOf` from `build_open_link`'s `input_schema`** (`src/index.mjs`). The `path` xor `paths` mutual exclusion is unchanged — it was already enforced at runtime (`src/tools/build-open-link.mjs` rejects both/neither with a clear error) and documented in the tool description. Only the redundant, API-incompatible schema-level encoding is gone.

### Added

- **Catalogue-wide regression guard** (`tests/tools-click-to-open-integration.test.mjs`) — replaces the old `build_open_link`-specific `oneOf`-presence assertion with a programmatic check over `_internals.TOOLS` asserting that **no** tool's `input_schema` carries a top-level `oneOf` / `allOf` / `anyOf`. Composition keywords nested inside a property (e.g. `patch_file`'s `content.oneOf`) remain allowed — only the schema root is checked.

## [0.19.0] — 2026-05-29 — self-healing session reconciliation (log.md ↔ Sessions/ no longer depends on SessionEnd)

Fixes a structural desync between the per-session journal (`wiki-meta/Sessions/*.md`) and the chronological `wiki-meta/log.md`: sessions whose **`SessionEnd` hook never fired** (terminal closed abruptly, process killed, crash, OS shutdown — Claude Code does not guarantee `SessionEnd`) were left `status: open` forever with **no log.md line**, while every cleanly-closed session had one. Reported on a real vault with 27 session files: all 16 `closed` had a log entry, all 11 `open` did not. The old `backfill-log-from-sessions` script couldn't repair them either — it skipped any non-`closed` session.

Root cause: the per-session closure (status flip, recap, **log.md append**) lived **only** in the `SessionEnd` handler. The fix stops depending on a single fragile event.

### Added

- **`hooks/_helpers/session-reconcile.mjs`** — shared, self-healing reconciliation routine (`reconcileVaultSessions`), the single source of truth used by both the hook and the backfill script. For each stale, non-live **open** orphan it closes the journal in place (`status: closed` + a `## Recap (reconciled — no SessionEnd)` block + `ended-at` + `closed-by: reconciliation`, best-effort counts from the lingering state JSON, else reconstructed from the file body) **and** backfills its `log.md` line. It also backfills **closed-but-unlogged** sessions (the pre-v0.12.8 case). Idempotent (dedup by `[[basename]]`); already-logged files are fast-skipped without even being read, so a healthy vault adds ~zero startup cost.
- **`session-auto-journal` now self-heals on every `SessionStart`.** After ensuring the current session's journal it reconciles prior orphans for the associated vault. The per-session closure + log line therefore no longer require `SessionEnd` to fire — the *next* session start cleans up whatever the last crash left behind. Applies to all existing and future vaults (they share the one global hook).
- **`backfill-log-from-sessions.mjs --include-open`** — explicit one-shot repair for existing vaults: reconciles orphaned open sessions in addition to the default closed-only log backfill. `--all --include-open` sweeps every configured vault. New `--live-window-minutes N` tunes the liveness guard.
- **`OBSIDIAN_ROUTER_SESSION_LIVE_WINDOW_MIN`** (default `120`) — env override for the liveness window in the hook.

### Fixed

- **Orphaned `open` sessions are now closed + logged** instead of accumulating silently. A **liveness guard** (the session's state-JSON mtime) prevents clobbering a session still running in another terminal: an open session whose state JSON was touched within the live window (default 120 min) is left alone, and the *current* session is additionally protected by path. Truly-dead orphans (stale or no state JSON) are reconciled.

### Notes

- Reconciliation operates only on `type: session` files (the auto-journal output); manual `/save` documents under `Sessions/` carrying other types are never touched. Backfilled log lines are tagged `<!-- backfilled YYYY-MM-DD -->`; auto-reconciled ones via the hook are tagged `<!-- reconciled YYYY-MM-DD (no SessionEnd) -->`.

## [0.18.2] — 2026-05-29 — bootstrap auto-wires hooks (no more dormant guards)

Follow-up to 0.18.1 that removes the *deeper* root cause behind the recurring phantom-link bug: the deterministic guards shipped on disk but stayed **dormant** until someone ran `--install-hooks` by hand — an opt-in, skippable step. A `vault-link-linter` / `wiki-query-first-nudge` that isn't wired catches and prevents nothing.

### Changed

- **`setup-vault.mjs <vault>` now auto-wires all router hooks** into `~/.claude/settings.json` at the end of a *successful* bootstrap (covers the one-shot `<vault> --link-workspace <ws>` attach too). Idempotent (skips already-present hooks → no churn on re-bootstrap), best-effort (a missing `hooks.example.json` or unwritable `settings.json` **warns** but never aborts the completed bootstrap), and only runs on success (an unsafe-target refusal exits earlier, so nothing is wired for a failed run). The standalone `--install-hooks` subcommand stays the explicit path for re-wiring / `--select` subsets; a standalone `--link-workspace` re-link is intentionally NOT covered (its vault was already wired at its own bootstrap).

### Added

- **`--no-hooks` flag** (and `OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS=1` env) to opt out of the auto-wiring.

### Fixed

- **CI green again on Linux + the GitHub Windows runners.** Three test-only portability bugs reddened CI (run [#26660425820](https://github.com/tboome33/obsidian-mcp-router/actions/runs/26660425820): 11 failures on `windows-latest`, 1 on `ubuntu-latest`) while passing on the dev box — `core.autocrlf=input` gives an LF checkout, plus a pre-existing `C:\tmp` directory; the third only manifests on POSIX. `tests/` only — no product behavior change. (Commit `ba1941a`, shipped ahead of the feature above in this same release.)
  - `tests/download-page-assets.test.mjs` — the `html branch end-to-end` and `v0.14.7 defuddle-first` blocks hardcoded `C:\tmp\…` as the download `outputDir`. `downloadAssets` requires the outputDir's *parent* to already exist (it refuses to bootstrap arbitrary trees), and `C:\tmp` is absent on the GitHub Windows runner. Switched both to `path.join(os.tmpdir(), …)`, whose parent is guaranteed to exist on every runner.
  - `tests/tools-click-to-open-integration.test.mjs` — the `build_open_link` schema test's block-boundary regex ended in a bare `\n`, which cannot match `},\r\n` on a CRLF (`autocrlf=true`) Windows checkout, so the tool block was "not found". Normalize CRLF→LF before matching.
  - `tests/vault-link-linter.test.mjs` — the "exact Roland 2026-05-29 path shape" regression hardcoded a `\`-separated path that is only meaningful on Windows; on POSIX a literal `\` is a filename char, so the linter (correctly) didn't flag it and the test wrongly expected exit 2. Build the incident path with the platform's own separators — the real mixed-separator repro on Windows (where the incident happened), the POSIX-native equivalent on Linux.

### Docs

- **meta-setup skill**: corrected the stale "**6 hooks**" → **9 hooks** (added the missing `session-auto-journal`, `vault-doc-startup-check`, `wiki-query-first-nudge` rows + fixed `wiki-autocommit`'s matcher count to 8), and documented the new auto-wire-at-bootstrap default.

## [0.18.1] — 2026-05-29 — fix: `vault-link-linter` catches cwd+vault "phantom" paths

Patch. The `vault-link-linter` Stop hook gains a **third violation kind**, `cwd-vault-mix`, closing the blind spot behind a recurring broken-link bug. In workspace-bound sessions, Claude would emit an absolute path that concatenates the workspace cwd with a vault-internal subpath — e.g. `<repo>\wiki\…\graph-viewer-survey.md` — a phantom that does not exist, because the vault lives at a *different* absolute root (`C:\VAULTS\opsidian-mcp-router et bridge`). The two share near-identical basenames (`obsidian-mcp-router` vs `opsidian-mcp-router et bridge`), which is what made the confusion sticky. (Reminder: the hooks only fire once wired into `~/.claude/settings.json` via `node scripts/setup-vault.mjs --install-hooks` — a dormant linter catches nothing.)

### Fixed

- **`hooks/vault-link-linter.mjs` — new `cwd-vault-mix` detection.** Pre-0.18.1 these paths slipped through twice over: an absolute Windows path's drive letter (`I:`) reads as a URL scheme so the bare-path pass skipped it, and prose tokens outside markdown links were never scanned at all. The new pass re-scans BOTH markdown-link hrefs AND bare prose for absolute paths, gated by four zero-false-positive conditions — (1) resolves under the workspace cwd, (2) first segment below the cwd is `wiki`/`wiki-meta`, (3) does NOT exist on disk, (4) the vault-relative tail DOES resolve to a real file in an active vault — and emits the correct click-to-open URL. Absolute links to genuine non-vault files (`C:\Users\me\notes.md`) and real local files under the cwd are left untouched. The candidate scan runs *before* the "no candidates → exit" guard so it isn't short-circuited by Pass 1/2 finding nothing.
- **+8 tests** — markdown-link + bare-prose phantom blocking, link/bare dedup, the exact incident path shape (mixed separators), and the four negative gates (tail unresolved, non-wiki segment, different root, real local file).

## [0.18.0] — 2026-05-29 — guided tours (`build_wiki_tour` + `/wiki-tour`)

Understand-Anything borrowings, roadmap item #3. Generates a **guided, pedagogical reading tour** through a vault from the knowledge graph's link topology — an ordered walkthrough that takes a newcomer from "what is this?" to "I get how it fits". Same deterministic-core / LLM-narrate split as #1: the step ordering is deterministic; Claude writes the per-step narrative. Backward compatible (purely additive: one new read-only tool + one new skill + one new helper).

### Added

- **`build_wiki_tour` MCP tool** (`src/tools/build-wiki-tour.mjs`) — **read-only** (NOT in `WRITE_TOOL_NAMES`). Reads `wiki-meta/graph/knowledge-graph.json` (from `build_wiki_graph`) and returns a deterministic ordered **tour skeleton**: an overview step (entry points) + one step per `index.md` section (top articles by backlink count) + a trailing step for unindexed hubs. Each step carries node `name` + `summary` so the caller can narrate. `scope` restricts to one section/topic/path; actionable errors when the graph is missing/malformed (point at `/wiki-graph`).
- **`/wiki-tour` skill + slash command** — orchestrates: ensure graph → `build_wiki_tour` skeleton → Claude writes the pedagogical narrative → writes a standalone markdown tour in `wiki-meta/tours/` (nodes linked as `[[wikilinks]]`, readable in Obsidian today) **and** the graph's `tour[]` field (for the future dashboard / native viewer #2b). Whole-vault or scoped (`/wiki-tour Dedibox`). Bilingual FR/EN triggers.
- **`src/helpers/wiki-tour-topology.mjs`** — pure, deterministic topology analyser: fan-in (backlinks) / fan-out over the `related` wikilink web, entry-point scoring (boosted for `index`/`overview`/`MOC`/`sommaire` names), `scope` resolution (layer id/name or path substring), and the ordered step skeleton. Byte-stable for a fixed graph.
- **+17 tests** (topology determinism / fan-in / entry-points / scope / edge-cases + the tool's DI-mocked read/parse/error paths).

## [0.17.0] — 2026-05-29 — knowledge-graph builder (`build_wiki_graph` + `/wiki-graph`) + `.wikiignore`

First slice of the **Understand-Anything** borrowings (Phase 1 #1 deterministic core + #5) — see `understand-anything-roadmap` in the companion vault. Assembles a vault's wiki into a typed **knowledge-graph JSON using the Understand-Anything schema verbatim** (`Lum1104/Understand-Anything`), so it can be visualised directly in that plugin's dashboard. Deterministic — no LLM in this slice (the LLM enrich + Louvain layers are deferred follow-ons). Backward compatible: purely additive (one new read/write tool + one new skill + one new helper trio); no behavior change for existing setups.

### Added

- **`build_wiki_graph` MCP tool** (`src/tools/build-wiki-graph.mjs`) — enumerates `wiki/**` content pages + `wiki-meta/digests/**`, reads an optional `.wikiignore` + `wiki-meta/index.md`, assembles a typed graph, **validates it against the schema** (refuses to write an invalid graph), and writes it to **two** locations: the canonical `wiki-meta/graph/knowledge-graph.json` (source of truth) + a derived `.understand-anything/knowledge-graph.json` (read directly by Understand-Anything's `/understand-dashboard` — zero extra step). `dryRun` previews counts without writing. In `WRITE_TOOL_NAMES` (hidden under `OBSIDIAN_ROUTER_READONLY`).
- **`/wiki-graph` skill + slash command** — natural-language wrapper (FR/EN triggers) around the tool, with the interop instructions for viewing the graph in Understand-Anything's dashboard.
- **`src/helpers/wiki-graph-schema.mjs`** — the UA-compatible vocabulary (21 node types / 35 edge types), canonical ID builders (`article:`/`entity:`/`topic:`/`claim:`/`source:`), `emptyGraph`, and a thorough `validateGraph` (dup-id, dangling-edge, self-edge, weight-bounds, complexity, layer membership).
- **`src/helpers/wiki-graph-builder.mjs`** — the pure, deterministic assembler: pages → `article` nodes; digest concepts/claims → `entity`/`claim` nodes; `[[wikilinks]]` → `related` edges; **referenced sources** (frontmatter `sources:`, `^[file:42-58]` citations, `![[x.pdf]]` binary embeds) → lightweight `source` nodes + `cites` edges; `index.md` sections → `topic` nodes + `categorized_under` edges + `layers[]`. Byte-stable for fixed input (timestamps injected).
- **`.wikiignore` support** (`src/helpers/wiki-ignore.mjs`) — gitignore-syntax exclusion (documented subset, no new dep) of noise (config, trash, derived sidecars, binary attachments) from the graph/lint/export tooling, with built-in defaults + `!`-negation + a commented starter generator.
- **The "source référencée" invariant** — a file a page *references* becomes a `source` node **even if it matches `.wikiignore`**. `.wikiignore` governs *content enumeration* (what becomes an `article` node), NOT *reference resolution* — so you can always trace a page to its PDF/image and click through to it.
- **+118 tests** (4 new suites: schema, ignore, builder, tool) covering determinism, the invariant, schema validity, topics/layers, and the review regressions below.

### Security / hardening (from the pre-ship adversarial review)

- **ReDoS guard in the `.wikiignore` matcher** — a `.wikiignore` is attacker-influenced vault content; a crafted pattern (`a` + 40×`*` + `b`) compiled to N adjacent `.*` groups → ~80s event-loop freeze. Fixed by collapsing consecutive-star runs to a single quantifier + caps (pattern length, `**`-run count, total wildcard count) with fail-safe drop + warnings.
- **Path-traversal guard** — the tool's `pagesDir` argument reuses a shared guard (rejects leading `/`, drive letters, UNC, `..`, control chars) instead of a weaker bespoke check. *(The guard named here at the time was `isSafeVaultRelativePath`; v0.71.0 replaced it with `canonicalVaultPath` and deleted it — see that entry.)*
- **Output sanitisation** — the written graph JSON is run through `sanitizeResponse` (vault content is attacker-influenced and the JSON is consumed by external dashboards/agents); **prototype-pollution keys** (`__proto__`/`constructor`/`prototype`) are stripped from embedded frontmatter.
- **Bounded read concurrency** — page/digest reads are batched (no unbounded `Promise.allSettled` connection storm on large vaults); enumeration bounded by depth/file caps with truncation warnings.

### Fixed (review regressions, now test-guarded)

- `project.analyzedAt` was silently always `""` (the injected timestamp was dropped by a param-name mismatch) — now populated.
- Two claims sharing their first 8 words collapsed to one node — claim IDs now carry a content hash.
- Graph was input-order-dependent on basename collisions — inputs are now sorted by path (order-independent, deterministic).
- Block-list `sources:`/`tags:` YAML (the form Obsidian's Properties UI writes) parsed as empty → no source nodes; `parseFrontmatter` now collects block sequences.
- A citation to an existing content page minted a duplicate `source:` node — now resolves to a `related` article edge.

## [0.16.0] — 2026-05-27 — MCPHub deployment support + family-vault member routing

Ships the tooling and conventions to deploy the router on **MCPHub** in multi-tenant "hybrid bypass" mode (router server-side, vault data client-side reached over WireGuard) and to run a **shared family vault** with per-member auto-routing. Validated end-to-end against a live MCPHub instance on a QNAP NAS: a `write_file` call from Claude Code travelled Claude Code → MCPHub → spawned router container → WireGuard tunnel (~137 ms) → Obsidian REST API on the originating PC → file persisted on disk + audit log written. See `mcphub-hybrid-bypass-roadmap` in the companion vault for the full session record.

### Added

- **`scripts/build-mcpb.ps1`** — PowerShell script that bundles the router into a `.mcpb` archive for MCPHub upload. Cleans a staging dir, robocopies source (excluding `.git`, `node_modules`, `tests`, `.venv`, `.claude`, `worktrees`, `.vault-meta`, `.env*`, `*.mcpb`, `*.log`, **and the gitignored secret config `config.json`/`config.local.json` so local API keys never ship in the bundle**), runs `npm ci --omit=dev --ignore-scripts` (hermetic — skips all lifecycle scripts, so the markitdown Python venv postinstall never runs and the bundle starts cleanly on a Python-less Linux container), writes `manifest.json` with the `server-`-prefixed container path + templated env-var placeholders, and `Compress-Archive`s the result. Re-runnable with `-Clean`.
- **`who-is-speaking` skill + `/obsidian-router:who-is-speaking` slash command** — identifies the family member speaking in a shared vault by matching their name/aliases against the vault's `CLAUDE.md` member table, then locks the router to that vault (`lock_vault`) and sets `Hybrid` auto-enrich mode (`set_auto_enrich_mode`) so subsequent auto-saves route to `wiki/People/<member>/`. Bilingual FR+EN triggers. Refuses to guess on no-match; supports mid-session re-identification without unlocking.
- **`tribu-routing` installable convention** (`skills/conventions/snippets/tribu-routing.md`) — codifies the family-member auto-routing pattern: identify the speaker at session start, route private saves to `wiki/People/<member>/` and collective saves to `wiki/Family/`, with an explicit sensitivity guard against auto-saving medical data. Generic + reusable across any shared/multi-user vault (not hardcoded to a specific family — the member list lives in the consuming vault's `CLAUDE.md`).

### Changed

- **`skills/conventions/SKILL.md`** mapping table refreshed from 8 → 10 documented conventions (added the previously-undocumented `claim-citations` from v0.15.0 + the new `tribu-routing`).
- **`.gitignore`** now excludes `mcpb-staging/` and `*.mcpb` (regenerable build artifacts, ~36 MB).

### Deployment notes (discovered during the live MCPHub validation)

- **`MD_ALLOWED_PATHS` is mandatory in multi-tenant mode.** When any of `OBSIDIAN_ROUTER_READONLY` / `OBSIDIAN_ROUTER_ALLOWED_VAULTS` / `OBSIDIAN_ROUTER_USER_ID` is set, the v0.11.1 `assertSandboxConsistent()` boot guard refuses to start without `MD_ALLOWED_PATHS` (or its legacy alias). Point it at an empty sandbox dir even when the conversion tools are unused.
- **The config env var is `OBSIDIAN_ROUTER_CONFIG`, not `OBSIDIAN_ROUTER_CONFIG_PATH`.** (A doc in the companion vault had the wrong name; the build script now emits the correct placeholder.)
- **Remote vault over WireGuard** is configured via the standard `remoteVaults[]` config entry (`baseUrl: http://<wg-ip>:<insecurePort>`, the vault's `apiKey`). The originating PC must set `bindingHost: 0.0.0.0` in its Local REST API `data.json` so the API listens on the WG interface, not just loopback.

Backward compatible: no runtime behavior change for existing local-only setups. The new skill + convention are opt-in; the build script is a dev tool.
## [0.15.1] — 2026-05-27 — `/review+` hardening on v0.15.0 (4 review passes + 9 fix commits)

Post-v0.15.0 `/review+` produced **9 IMPORTANT findings** in pass 1 (3 SECURITY + 5 logical correctness + 1 perf), then converged through 4 review passes with 9 hardening commits. Both reviewers (Claude `Code Reviewer` subagent + `codex review` CLI) concluded **OK to merge** at pass 5 — codex empirically verified all 25 secret-param patterns are caught (0 missed, 0 false-positives).

### Security fixes (3)

- **YAML injection in `digest-generator.serialiseDigest`** (convergent Reviewer A + B) — `digest.for` was written raw allowing `digest.for = "foo.md\nclaims: [INJECTED]"` to smuggle YAML lines into frontmatter. The `needsQuoting` regex also missed backslashes, control chars, YAML-reserved scalars (`yes`/`no`/`true`/`false`/`null`/`~`), alias/anchor/tag leading chars (`*foo`/`&foo`/`!foo`), and numeric-looking strings. Fix : new `needsYamlQuoting()` policy with 7 explicit rejection categories + `quoteYamlScalar()` + `escapeYamlDoubleQuoted()`. `digest.for` and `generated_at` now quoted ; `pageHash` hex-validated. Care taken to AVOID the `[ -\\]` regex range pitfall — structural chars listed EXPLICITLY. **+8 regression tests** including "ordinary paths stay UNQUOTED" guard.

- **Path traversal in `get_wiki_context_pack`** (Reviewer B) — a poisoned `wiki-meta/index.md` containing `[[../../etc/passwd]]`, `[[/etc/x]]`, `[[C:\Windows\...]]`, or URL-like `[[file://...]]` would have its target shipped verbatim to `getNote()` and on to the Obsidian REST API. Fix : new exported helper `isSafeVaultRelativePath(p)` rejects POSIX absolute / Windows drive-letter / UNC / `..`-as-segment / control chars / URL-like (both `scheme://` and opaque `javascript:`/`data:`/`mailto:` forms). The drill loop calls it BEFORE `getNote()`. **+10 regression tests** including an integration test that proves `getNote` is NEVER called on a `..` path.

- **URL credentials + tokens leak in `normaliseUrl`** (Reviewer B, hardened across passes 1 → 4 → 5) — `normaliseUrl()` was persisting `https://user:pass@host/?token=...&access_token=...` to `wiki-meta/ingest-state.json`. The state file became a credential leak vector. Fix : `parsed.username = '' ; parsed.password = ''` (drops basic auth in userinfo) + new `SECRET_PARAMS` blocklist (25 names : token/access_token/refresh_token/id_token/api_key/apikey/apptoken/key/secret/client_secret/signature/sig/auth/authorization/password/passwd/pwd/code/state/nonce/session/sessionid/sid/jsessionid/phpsessid) + new `TRACKING_PARAM_PREFIXES` for prefix-matched families (`utm_`, `x-amz-`, `x-goog-`, `oly_`, `vero_`). **Pass 4 + 5 hardening** : on parse failure, the previously-raw return now detects basic-auth userinfo OR secret query params via `SECRET_PARAMS_RE` generated dynamically from `SECRET_PARAMS` (single source of truth — Pass 4 caught that a hand-curated regex was missing `refresh_token`/`client_secret`/`authorization`/etc.). Returns `null` sentinel forcing callers to surface the error. **+14 regression tests** (9 in Pass 2 + 5 in Pass 4) covering each previously-leaking param family.

### Logical correctness fixes (6)

- **Check H source resolver** — `wiki-lint` Check H tried `sources/<filename>` but `wiki-ingest` writes to `wiki/sources/<slug>.md`. Check H would never resolve. Fix : `wiki/sources/<filename>` first (canonical), then page-relative, then bare `<filename>` as legacy fallback. Also rejects `..` / absolute paths in cited targets (new `cited-source-unsafe-path` WARNING).

- **Digest path naming consistency** (B IMPORTANT + Pass 3 collision fix) — `wiki-ingest` and `wiki-refresh-digests` derived the digest path differently, producing different filenames for the same page. **Pass 3** : new `digestPathForPage(pageRelPath)` canonical helper used by both skills. **Pass 4** : initial flatten-with-dashes mapping (`/` → `-`) was collision-prone (`wiki/A/B.md` and `wiki/A-B.md` both → `wiki-A-B.md`) — switched to NESTED mapping mirroring the source path. Collision-free by construction. Skills updated for recursive enumeration. **+10 regression tests** including the dash-vs-slash collision lock-in.

- **Silent error swallowing in `get_wiki_context_pack`** (convergent Reviewer A + B) — all `getNote()` errors collapsed to "missing page" placeholder, conflating real failures (timeout/auth/5xx) with legitimate 404s. Fix : capture first non-not-found error per candidate, emit `page-read-failed` warning when non-404 blocks resolution. `Promise.allSettled` rejections get `primary-page-drill-failed` warning. **+2 integration tests** locking in : 503 emits warning, 404 does NOT (preserves dead-wikilink as routine).

- **Sibling-parser drift on bare-anchor wikilinks** (Reviewer A IMPORTANT, Pass 3) — `parseIndexEntries` in `get_wiki_context_pack` accepted `[[#OnlyAnchor]]` and emitted entries with empty label, polluting IDF scoring + triggering wasted REST probes. The sibling `llms-txt-exporter.parseIndex` already skipped this. Fix : aligned both parsers with same early-skip on empty page slug. **+1 regression test**.

- **Wikilink alias drop in `llms-txt-exporter.parseIndex`** (Reviewer B) — regex `[^\]|]+?` silently dropped `[[foo|Alias]]`. `[[Foo#Bar|Section]]` became `Foo#Bar.md`. Fix : accept full `[[target]]` then strip `|alias` / `#section` / `^block-ref` decorations after. **+5 regression tests** for the 4 accepted forms + bare-anchor rejection.

- **Multiple H2 silent overwrite + corrupted-state silent recovery** (Reviewer A) — `parseDigest` silently kept only the last `## Summary` when duplicates appeared (data loss). `loadIngestState` returned `{}` on corruption (would overwrite the broken file with fresh empty state on next save — erasing history invisibly). Fix : `parseDigest` throws on duplicate H2 ; `loadIngestState` backs up corrupted file as `<path>.corrupted-<timestamp>` + writes stderr warning before returning `{}`. **+4 regression tests** (2 duplicate-H2 + 2 backup-on-corruption).

### Performance / consistency (1)

- **`wiki-lint --deep` N² perf documentation** (convergent Reviewer A + B) — the new Checks I/J/K/L do pairwise digest comparison, N² in page count. Documented prominently in skill prose ("typical 100 pages → 5000 comparisons fine ; 1000 pages → 500k may take a few seconds"). No code change ; user expectation calibration.

### NITs addressed inline

- `escapeYamlDoubleQuoted` JSDoc no longer overclaims control-char coverage.
- `normaliseUrl` JSDoc `@returns` synced to `{string|null}` with explanation of the three return modes.
- `skills/wiki-ingest/SKILL.md` file-layout example updated to NESTED structure + recursive-glob note.
- `skills/wiki-refresh-digests/SKILL.md` + `skills/wiki-lint/SKILL.md` `--deep` mode updated to instruct recursive enumeration (NESTED mapping consequence).

### Doc propagation

- `package-lock.json` synced from 0.14.7 → 0.15.0 → 0.15.1 (was lagging).
- `ROADMAP.md` gained a v0.15.0 + v0.15.1 section (was last at v0.12.2).

### `/review+` audit trail

| Pass | Reviewer A | Reviewer B | Convergent | Action |
|---|---|---|---|---|
| 1 | 6 IMP + 9 NIT | 9 IMP + 1 NIT | YAML + error swallowing + N² guard + parser drift | 7 fix commits (`f8cf898`..`9f0ddf4`) |
| 2 | OK to merge + 1 IMP + 3 NIT carry-over | À corriger : 1 IMP collision + 2 PARTIAL + 2 NIT | digest path collision + URL parse-fail leak | 2 fix commits (`60ee772` + `997fb7b`) |
| 3 | — (informal verification) | — | — | (inferred — convergence point) |
| 4 | OK to merge + 1 IMP (skill drift on NESTED) + 1 NIT | À corriger : 1 IMP parse-fail regex too narrow | parse-fail leak alignment | 2 fix commits (`3bad5bd` + `9aa3a77`) |
| 5 | (deemed converged at pass 4) | **OK to merge** (empirical : 25/25 SECRET_PARAMS catch) | — | bump v0.15.1 |

### Tests

- **1387/1387 passing** (was 1331 at v0.15.0, +56 hardening regressions across 4 files).
- New: 8 YAML safety + 10 path traversal + 14 URL credential strip + 10 digest-path/parsers + 2 page-read-failed + 12 misc parser robustness.

### Pages liées

- [[llm-wiki-compiler-roadmap]] — source roadmap of the v0.15.0 features being hardened here
- [[router-changelog#v0.15.0 — 2026-05-27]] — feature catalog of the underlying release

## [0.15.0] — 2026-05-27 — llm-wiki-compiler emprunts (6 features parallèles)

Six features décidées un par un avec Roland après ingestion de la fiche [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler) (un autre CLI implémentant le pattern Karpathy LLM Wiki en standalone). Roadmap source : `wiki/Divers/LLM-WIKI-COMPILER/llm-wiki-compiler-roadmap.md` (vault `opsidian-mcp-router et bridge`). Total : **+166 tests** (1165 → 1331), 6 commits parallélisés (1 agent Backend Architect en background + 4 features foreground), aucun refactor structurel.

### Added

- **Line-level citations** — `^[file.md:42-58]` markers now supported in wiki pages to pinpoint which lines of a source justify a given paragraph. `wiki-ingest` SKILL.md instructs Claude to emit them when sources are long enough to warrant it (papers, transcripts, code, docs >100 lines); `wiki-lint` adds a new Check H (`claim-range-validity`) that validates the cited source exists, end ≥ start, lines > 0, range doesn't overflow the source. All findings are WARNING-level (sources legitimately shorten over time, no need to fail loudly). New convention snippet `skills/conventions/snippets/claim-citations.md` installable via `/obsidian-router:conventions install claim-citations`. Roadmap item #1 from llm-wiki-compiler-roadmap.

- **`wiki-export` skill + `/wiki-export` slash command** — aggregates a vault's wiki into a portable single file conforming to the [llmstxt.org](https://llmstxt.org) standard. Two modes: `llms.txt` (compact index with links + descriptions) and `llms-full.txt` (same structure but with each page body inlined). Use cases: share your wiki with a collaborator who doesn't have Obsidian; paste into external LLMs (Perplexity, ChatGPT, Gemini) for grounded Q&A; backup to a single portable archive; publish at site root for AI search visibility. Pure helper `src/helpers/llms-txt-exporter.mjs` (deterministic, no I/O) + 32 tests. Other targets listed in roadmap (`json`, `json-ld`, `graphml`, `marp`) deferred. Roadmap item #5 from llm-wiki-compiler-roadmap.

- **`get_wiki_context_pack` MCP tool (v1 JSON envelope)** — structured JSON context for a query, instead of the prose returned by `wiki-query` skill. Enables non-Claude agents (Cursor, MCPHub multi-agent workflows, custom scripts) to consume the router's vault knowledge programmatically. Returns a single envelope with `version: "v1"`, `query`, `vault`, `primaryPages[]` (IDF-ranked from `wiki-meta/index.md`, drilled in parallel, summary + source_type + snippet), `semanticChunks[]` (from `search_smart` — degrades gracefully to `[]` + warning when Smart Connections is missing), `graphNeighbors[]` (wikilinks extracted from primary page bodies, deduped, primary basenames excluded), `citations[]` (from each page's `sources:` frontmatter), `warnings[]` (vault-offline / smart-connections-not-available / index-not-found / no-primary-page-matched), and `suggestedActions[]` (empty in v1 — reserved for later). Schema is additive-only: existing fields never change shape in v1. New tool `src/tools/get-wiki-context-pack.mjs` + 55 tests. Roadmap item #6 from llm-wiki-compiler-roadmap.

- **Hash-based incremental ingest** — `wiki-ingest` now computes SHA-256 of source content (post-defuddle for URLs to normalise away ads/timestamps/tracking pixels) and stores it in `wiki-meta/ingest-state.json` per vault. Re-ingesting a source with identical content is a fast no-op (no fetch, no LLM call) — Claude surfaces "already ingested with identical content, skipping" and exits. Re-ingesting a source whose content has evolved upstream triggers a re-ingest with a "source has evolved since `<date>`" flag, suggesting `/wiki-refresh --diff`. URL normalisation strips `utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, etc. (case-insensitive), sorts remaining query params for stable hashing, lowercases host, strips default ports and fragment, normalises trailing slash. Atomic state file writes (tmp + rename) so a crash mid-write can't corrupt the JSON. New helper `src/helpers/ingest-state.mjs` (computeSourceHash, normaliseUrl, getStatePath, loadIngestState, saveIngestState, checkSourceFreshness, recordIngest) + 40 tests. Substrate for the future agent-de-veille (#3) which will scan ingest-state.json to detect upstream-changed sources. Roadmap item #4 from llm-wiki-compiler-roadmap.

- **Digest sidecars + `wiki-lint --deep` mode + `/wiki-refresh-digests` skill** — every wiki page (except sources and meta scaffolds) now gets a compact digest at `wiki-meta/digests/<page-slug>.md` generated at ingest time. The digest contains concepts, claims, keywords, summary, and a page-hash for staleness detection — frontmatter + Summary + Notable sections, all parseable. New `wiki-lint --deep` mode reads all digests in bulk to detect : Check I `digest-stale` (page edited since digest generated → WARNING) or `orphaned-digest` (page deleted → ERROR), Check J `concept-overlap-strong`/`moderate` (Jaccard ≥0.7 / 0.4..0.7 between two pages' concepts → ERROR / WARNING merge candidates), Check K `contradiction-suspected` (conservative regex heuristic on claims arrays → WARNING, documented as best-effort starting point not guarantee), Check L `missing-wikilink` (pages share concepts but don't reference each other → WARNING). Companion skill `wiki-refresh-digests` (`/wiki-refresh-digests`) regenerates stale or missing digests — default mode refreshes only stale + missing, `--all` force-regenerates everything, `--for <path>` refreshes one specific page. New helper `src/helpers/digest-generator.mjs` (computePageHash, generateDigestSkeleton, parseDigest, serialiseDigest, isDigestStale, conceptOverlap, sharedConcepts) + 39 tests. This is the reformulation (Roland's idea) of llmwiki's two-phase compile pattern : instead of refactoring `wiki-ingest` to extract concepts globally upfront (risky, structural refactor), we keep `wiki-ingest` single-pass and add cheap digest sidecars + bulk deep-lint detection. Substrate for the future agent-de-veille (#3) self-review pass. Roadmap item #7' from llm-wiki-compiler-roadmap.

## [0.14.9] — 2026-05-26 — `/review+` hardening on v0.14.8 (4 passes, A+B converged)

Post-v0.14.8 `/review+` produced 5 IMPORTANT + 2 NIT in pass 1, then converged through 4 passes (Code Reviewer subagent + `codex review` CLI, both reviewers OK to merge by pass 4). All findings addressed in this release.

### Adressed — IMPORTANT (5)

- **Negative-cache invalidation** (Reviewer A IMP-1) — `src/helpers/click-to-open.mjs`. The per-vault cache used to store `{ port: null, enabled: false }` on misses, pinning the failure for the lifetime of the process. Onboarding scenario (user starts the router BEFORE flipping `enableInsecureServer: true`) would never produce a URL until session restart. Fix: only cache successful reads (`enabled && port !== null`). Cheap sync re-read on every miss until the bridge is configured, then fast-path cache for the lifetime of the success.
- **Walker MAX_DEPTH 10 → 20** (Reviewer A IMP-2) — `src/helpers/click-to-open-walker.mjs`. Fan-out `search_smart` shape (`{ perVault: [{ vault, chunks: [{ source: { path } }] }] }`) stacks ~8-10 levels and the old budget was silently clipping deep hits. New budget stays stack-safe and zero-cost on small payloads.
- **Path-traversal segment guard** (Reviewer A IMP-3 + Reviewer B P3 convergent, pass-2 + pass-3 refinement) — `src/helpers/click-to-open-walker.mjs`. Initial fix `v.includes('..')` over-rejected legitimate filenames like `wiki/release..notes.md`. Replaced in pass 3 with `/(?:^|[\\/])\.\.(?:[\\/]|$)/` — matches `..` only as a complete path segment (bordered by `/`, `\`, start, or end). Verified against 6 reject + 4 accept cases.
- **UNC + extended-length path rejection** (Reviewer B P2) — `src/helpers/click-to-open-walker.mjs`. Without this, `\\server\share\note.md` was normalised by `encodeVaultPath` (slashes collapsed, leading slashes stripped) into a plausible-looking but wrong URL for `server/share/note.md`. Now rejected at `isLikelyVaultPath` alongside drive-letter and POSIX absolute paths.
- **move_file dual URL on partial failure** (Reviewer A IMP-4 + Reviewer B P3 pass-3) — `src/tools/move-file.mjs`. When `moveFileFromTo` returns `{ moved: true, sourceDeleted: false }` (PUT OK, DELETE source KO), the source FILE is still on disk. New `clickToOpenUrlSource` field emits a SECOND URL pointing at the source so the LLM can surface both — "copied to [foo](dest), cleanup [foo](source)". Pass-3 refinement: gated on BOTH `result.moved === true` AND `sourceDeleted === false` to exclude the same-path no-op `moveFileFromTo(vault, foo, foo)` which returns `{ moved: false, sourceDeleted: false }` (harmless, no warning needed).
- **Schema `oneOf` mutual exclusion for `build_open_link`** (Reviewer B P2) — `src/index.mjs`. The `build_open_link` tool schema now encodes the `path` xor `paths` contract via JSON Schema `oneOf`. MCP clients that validate inputs catch `{}` and `{ path, paths }` before invoking the tool; runtime handler still validates for defence-in-depth + clearer errors.

### Adressed — NIT (2)

- **Markdown label escape** (Reviewer B P3) — `src/helpers/click-to-open.mjs`. `buildClickToOpenMarkdownLink` was producing malformed `[foo]bar](url)` for vault filenames like `foo]bar.md`. New `escapeMarkdownLabel` helper escapes `\`, `[`, `]` per CommonMark spec.
- **Cross-impl drift guard hook ↔ helper** (Reviewer A NIT-5) — `tests/wiki-query-first-nudge.test.mjs`. The hook inlines `readInsecurePort` (zero-deps on `src/`) and the helper has its own `readInsecurePortConfig`. New matrix test exercises 7 patho-cases (happy / disabled / port-string / out-of-range / port-0 / enableInsecureServer-missing / port-missing) and asserts hook and helper agree on every rejection condition. Locks the two implementations together against future drift.

### Tests

- **1165/1165 passing** (was 1144 at v0.14.8, +21 hardening tests).
- New: cache miss-no-cache + missing-data.json-retry semantics (2), markdown escape (4 cases), UNC + extended-length rejection (2), `..` segment-aware accept-cases (1 with 4 sub-paths) + reject-cases (1 with 6 sub-paths), MAX_DEPTH realistic fan-out (1), `oneOf` schema presence (1), `move_file` dual-URL gate (1 covering both conditions), hook↔helper cross-impl matrix (7 cases).

### `/review+` audit trail

| Pass | A findings | B findings | Convergent | Action |
|---|---|---|---|---|
| 1 | 4 IMP + 1 NIT | 2 P2 + 1 P3 | Walker `..`/UNC (IMP-3 ≈ P2) | Fixed all 5 IMP + escape NIT in pass 2 |
| 2 | NIT-1 (`..` over-rejects) + 2 cosmetic NITs | P3 (same as NIT-1) | `..` substring over-rejects | Refined to segment-aware regex in pass 3 |
| 3 | OK to merge | P3 (`move_file` same-path no-op) | — | Gated on `moved:true && sourceDeleted:false` in pass 4 |
| 4 | OK to merge | No regressions | Both converged | Ship |

## [0.14.8] — 2026-05-26 — click-to-open determinism: tool results + helper tool + hardened hook

Closes a recurring bug where the LLM cited vault files as bare paths (`wiki/Divers/foo.md`) in chat replies. The Claude Code renderer auto-clickifies these by prepending the cwd path, producing either `<cwd>/wiki/...` (a non-existent path in workspace-bound mode) or a filesystem link that opens in the OS file viewer instead of Obsidian (in cwd-is-vault mode). Roland flagged this 10+ times — the previous "memory + CLAUDE.md rule + hook nudge" approach failed because the LLM still had to *compose* the URL by hand (port lookup, encoding) and *remember* the rule. This release removes both failure modes with a three-layer fix.

### Layer 1 — every vault-touching tool result carries `clickToOpenUrl`

The LLM never composes a URL by hand. It copies the field verbatim from the tool result it just received.

#### Added

- **`src/helpers/click-to-open.mjs`** (NEW, ~150 LOC) — exports `buildClickToOpenUrl(vault, filePath)`, `buildClickToOpenMarkdownLink(vault, filePath, label?)`, `encodeVaultPath(p)`, and `_resetCache()` (test helper). Reads `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`, extracts `insecurePort`, validates `enableInsecureServer: true`, returns `http://127.0.0.1:<port>/open/<url-encoded-path>` or `null`. Path encoding normalises `\\` to `/`, strips leading slashes, encodes via `encodeURIComponent` (slashes → `%2F`, spaces → `%20`, accents → percent-encoded UTF-8). Per-vault cache keyed by `vault.path` avoids re-reading data.json on every call (notable for `merge_frontmatter` which loops `set_frontmatter`). Returns `null` (never throws) when the bridge isn't ready — remote vault, missing/broken data.json, insecure server disabled, port out of range — so the caller spreads the field conditionally and the tool result still works without a URL.
- **`src/helpers/click-to-open-walker.mjs`** (NEW, ~90 LOC) — exports `collectClickToOpenLinks(vault, payload)` for search-style responses. Recursively walks the payload (bounded depth 10 to handle cycles), collects every string at keys `filename` / `path` / `file`, rejects URLs and absolute filesystem paths, dedupes, and returns `{ clickToOpenLinks: { "<path>": "<url>", ... } }` or `{}` so spreading is a no-op. Sibling-map design (rather than mutating hit objects) preserves upstream shape contracts.

#### Changed (9 tools now emit `clickToOpenUrl`, 2 emit `clickToOpenLinks`)

- **`src/tools/write-file.mjs`**, **`get-file.mjs`**, **`append-to-file.mjs`**, **`patch-file.mjs`**, **`set-frontmatter.mjs`**, **`merge-frontmatter.mjs`**, **`get-frontmatter.mjs`** — append `clickToOpenUrl` to the result object via `...(url && { clickToOpenUrl })` so absent when the bridge is unavailable.
- **`src/tools/move-file.mjs`** — URL targets the **destination** path, not the source (source no longer exists after the move).
- **`src/tools/execute-template.mjs`** — URL emitted only when `createFile: true` AND `targetPath` is set (the render-only path has no file to open).
- **`src/tools/search.mjs`**, **`search-smart.mjs`** — both per-vault and fan-out (`vault: "*"`) modes now include `clickToOpenLinks` at the response top level (or per-vault sub-object). The walker collects paths from both Local REST API's `[{filename, matches: [...]}]` shape and Smart Connections' `{chunks: [{path, score, excerpt}]}` shape uniformly.

### Layer 2 — `build_open_link` MCP tool for files the LLM didn't just touch

When the LLM cites a wikilink target without having fetched it (`[[graphify]]`, `[[project-router]]`), it calls `build_open_link` to get the URL — still no manual composition.

#### Added

- **`src/tools/build-open-link.mjs`** (NEW, ~60 LOC) — `buildOpenLinkTool(registry, { vault?, path? | paths? })`. Single mode returns `{ vault, path, clickToOpenUrl, markdownLink }`. Batch mode (`{ paths: [...] }`) returns `{ vault, links: [{ path, clickToOpenUrl, markdownLink }, ...] }` for citing N notes in one call. Rejects on both `path` and `paths` provided (ambiguous), or neither (no work). Per-slot non-empty-string validation in batch mode (a typo at `paths[3]` becomes a clear "paths[3] must be a non-empty string" error instead of a silent `null` URL).
- **TOOLS schema + TOOL_HANDLERS entry** in `src/index.mjs` — read-only tool (no vault I/O beyond the per-vault data.json port lookup), so excluded from `WRITE_TOOL_NAMES`.

### Layer 3 — hook injects the rule + pre-computed URL prefix

The hook now reads data.json at fire time and embeds the literal URL prefix in the nudge — the LLM sees `http://127.0.0.1:27142/open/` ready to use, no port lookup ever.

#### Changed

- **`hooks/wiki-query-first-nudge.mjs`** — new `chatLinkBlock` injected in BOTH `cwd-is-vault` and `workspace-bound` modes (the bare-path bug exists in both). The block contains:
  - The pre-computed URL prefix `http://127.0.0.1:<insecurePort>/open/` read live from `<vaultPath>/.obsidian/plugins/obsidian-local-rest-api/data.json` at fire time.
  - An explicit `NEVER write the path as bare text like wiki/Divers/foo.md` rule, with mode-aware explanation of WHY (cwd+vault mix → 404 in workspace-bound, OS file viewer → wrong app in cwd-is-vault).
  - Three numbered paths to get a URL without composing: (a) read `clickToOpenUrl` from a tool result you already have, (b) read `clickToOpenLinks` map from search/search_smart results, (c) call `build_open_link` for cross-references.
  - Concrete WRONG/RIGHT chat-reply examples using a REAL path from the current vault.
  - "Roland has flagged this exact bug 10+ times" framing to anchor the rule in user reality.
- **DEGRADED variant** of the block when the bridge isn't reachable (missing data.json, JSON broken, `enableInsecureServer: false`, invalid port): falls back to `obsidian://open?vault=...&file=...` URI inline-code guidance and points at the data.json setup as the fix.

### Tests

- **`tests/click-to-open-helper.test.mjs`** (NEW, 24 tests) — encoding (slashes / spaces / accents / backslash-to-slash / leading-slash strip / preserved punctuation), happy path (URL with configured port), null-return conditions (remote vault, null vault, no path, no filePath, `enableInsecureServer:false`, port missing / out of range / non-integer, missing data.json, corrupt JSON), markdown-link helper (default label = basename without ext, explicit label, null when URL unavailable, backslash-path basename), cache behaviour (subsequent calls hit cache, `_resetCache` forces fresh read).
- **`tests/click-to-open-walker.test.mjs`** (NEW, 15 tests) — Local REST API search shape, smart-connections chunks shape, mixed `filename`/`path` at any depth, dedupe, rejected candidates (URLs, absolute POSIX/Windows paths, empty strings, non-strings), edge cases (empty/null payloads, remote vault, depth-limited cycles).
- **`tests/build-open-link.test.mjs`** (NEW, 8 tests) — single mode happy path, null URL when insecure server disabled (no `markdownLink` in result), batch mode happy path, empty paths array, per-slot validation errors, mutual-exclusion of `path` and `paths`, missing-args error.
- **`tests/tools-click-to-open-integration.test.mjs`** (NEW, ~25 tests) — static wiring check (every vault-touching tool source imports the helper AND emits `clickToOpenUrl`), `build_open_link` registration in `TOOLS` / `TOOL_HANDLERS` / imports, end-to-end smoke (single + batch round-trip through a real tempdir vault with data.json). Static wiring chosen over ESM mocking because ESM exports are frozen — `mock.method` fails with "Cannot redefine property" on imported functions.
- **`tests/wiki-query-first-nudge.test.mjs`** — added 4 tests for the new chat link block: bridge-reachable case (URL prefix injected literally + WRONG/RIGHT examples + `build_open_link` mention + Roland-10+ framing), missing data.json → DEGRADED variant, `enableInsecureServer:false` → DEGRADED, cwd-is-vault uses the "filesystem link → wrong app" WRONG example (different from workspace-bound's "cwd+vault mix → 404").

**Total: 1144/1144 passing** (was 1055 at v0.14.7, +89 tests).

### Why this fix is definitive

| Pre-v0.14.8 failure mode | v0.14.8 mitigation |
|---|---|
| LLM composes URL by hand → encoding errors | Tool result carries `clickToOpenUrl` ready to copy |
| LLM forgets the click-to-open format entirely | Hook injects rule + pre-computed URL prefix every prompt |
| Cross-reference to a file LLM didn't fetch → no URL | `build_open_link` batch tool builds URLs for any path |
| Bare `wiki/...` path in chat → auto-clickified by Claude Code | Hook explicitly forbids with WRONG/RIGHT examples |
| Bridge not reachable → silent failure | DEGRADED hook variant + tool result simply omits the URL field |

The residual gap: Claude Code has no pre-output validation hook that could block a chat message containing a bare path. The fix makes the "right path" (use the URL from the tool result) much easier than the "wrong path" (compose by hand). Combined with the deterministic prompt-submit injection, the bug should disappear in practice.

## [0.14.7] — 2026-05-25 — Phase E.2 · intelligent asset filter + Phase D.2 `/review+` hardening

Two threads land together because Phase D.2's `/review+` hardening was already on the branch when Phase E.2 wrapped up. Both ship in v0.14.7.

### Phase E.2 — intelligent asset filter (defuddle-first + alt/figure + dimensions)

Closes the deferred Phase E.2 from v0.14.2: `download_page_assets` now filters relevant images from page noise **before** any byte hits the network. Three filters stack, all enabled by default and individually overridable:

1. **`defuddleFirst: true`** — runs [kepano/defuddle](https://github.com/obsidianmd/obsidian-clipper)'s article-body extractor on the HTML *before* image scanning. Everything outside `<article>` / `<main>` (nav, header, sidebar, footer, ad rails, share-button bars, related-article widgets) is stripped at zero network cost.
2. **`requireAltOrFigure: true`** — keeps only images with a non-empty `alt` attribute OR wrapped in `<figure>`. Filters decorative icons and social-share glyphs that defuddle let through.
3. **`minWidth: 100, minHeight: 100`** — post-fetch dimension check. Parses PNG / JPEG / GIF / WebP (VP8 / VP8L / VP8X) magic bytes and SVG `width` / `height` / `viewBox` text. Unknown formats (BMP, TIFF, ICO, AVIF) get a free pass ("can't verify → keep") rather than false-positive skip.

Result on a representative page (header logo + nav icon + 2 article images + 1 decorative + 1 ad banner + 1 share button): **7 sources → 2 download candidates**, zero wasted fetches.

#### Added

- **`npm install defuddle@^0.18.1`** — kepano's content extractor, MIT, the same library obsidian-clipper uses. Imported via `defuddle/node` entry which uses linkedom — works in pure Node, no jsdom required.
- **`src/helpers/defuddle-extract.mjs`** (NEW) — thin async wrapper around `defuddle/node`. Single export `extractMainContent(html, opts)` returning `{content, title?, author?, image?, wordCount?, usedFallback}`. Defensive: pathological input, defuddle throws, or empty-content results → `usedFallback: true` and caller falls back to raw HTML.
- **`extractImagesWithMeta(content, baseUrl)` in `src/helpers/asset-downloader.mjs`** (NEW) — single-pass HTML tokenizer that returns `[{url, alt, isFigure}]`. Tracks `<figure>` depth via a counter (O(n), no per-match lastIndexOf scans). Handles nested figures correctly. Markdown `![alt](url)` participates with `isFigure: false`.
- **`extractImageUrls`** (existing) is now a back-compat facade over `extractImagesWithMeta` that maps to URL strings. All pre-v0.14.7 callers stay green.
- **`decodeImageDimensions(buffer, contentType)` in `src/helpers/asset-downloader.mjs`** (NEW) — pure function. Parses magic bytes for PNG / JPEG (SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15) / GIF87a + GIF89a / WebP VP8/VP8L/VP8X. SVG parses `width="…px"` + `height="…px"` from the first 8 KiB, falls back to `viewBox` when the explicit attrs are missing or use em/% units. Returns `null` for unknown formats — callers treat this as "can't verify → keep".
- **`downloadOne` new options `minWidth`, `minHeight`** (default 0 at the helper level — disabled). The dimension decoder runs only when at least one is set, so legacy callers pay zero CPU. New skip reason `'too-small-dimensions'` and skipped entries include `dimensions: {width, height}` for visibility.
- **`download_page_assets` MCP tool new inputs**:
  - `defuddleFirst: boolean` (default `true`)
  - `requireAltOrFigure: boolean` (default `true`)
  - `minWidth: number` (default `100`)
  - `minHeight: number` (default `100`)

  Plus two new fields in the response payload: `defuddled: boolean` (did defuddle run successfully?) and `afterRelevanceFilter: number` (count after the alt/figure filter, before maxAssets cap). The `attempted` field still exists with the same meaning.
- **33 new tests** in `tests/asset-downloader.test.mjs` and `tests/download-page-assets.test.mjs`:
  - 10 for `extractImagesWithMeta` (alt-text presence / absence / single-quoted, figure depth-counter including nested figures, markdown `![]()` integration, dedup-keeps-first-occurrence)
  - 9 for `decodeImageDimensions` (PNG / GIF87a+89a / JPEG SOF0 / WebP VP8X / SVG with width-height / SVG viewBox fallback / unknown BMP / too-short buffer / non-buffer input)
  - 5 for `downloadOne` + `downloadAssets` dimension filter (skip-below-threshold, pass-above-threshold, decoder-not-called-when-disabled, unknown-format-kept, downloadAssets-threads-through)
  - 9 for the MCP tool wrapper (TOOL_DEFINITION schema, defuddleFirst=true default strips outside-article, defuddleFirst=false bypasses, fallback when defuddle empties content, requireAltOrFigure default skips empty alt, figure-wrapped kept, false disables, minWidth/minHeight validation, response shape always includes new fields)

#### Changed

- **`src/tools/download-page-assets.mjs`** — input pipeline restructured to: fetch HTML → (optionally) defuddle → `extractImagesWithMeta` → relevance filter → `maxAssets` cap → `downloadAssets`. The defuddle step is best-effort with raw-HTML fallback. All new behaviors are smart-by-default with individual override flags.
- **`extractImageUrls` is now a 2-line facade** over `extractImagesWithMeta`. Behavior is unchanged from v0.14.2-v0.14.6 (verified by all pre-existing tests passing).
- **TOOL_DEFINITION description** rewritten to lead with the relevance behavior so Claude picks the right defaults without reading the schema.

#### Backward compatibility

- Pre-v0.14.7 callers that set `defuddleFirst: false, requireAltOrFigure: false, minWidth: 0, minHeight: 0` get **identical** behavior to v0.14.2-v0.14.6. The new defaults change BEHAVIOR but not API shape — the response gains two extra fields (`defuddled`, `afterRelevanceFilter`) that pre-existing consumers can safely ignore.
- `extractImageUrls` signature unchanged. Internal refactor is invisible.
- `downloadOne` / `downloadAssets` new options default to 0 (disabled) at the helper level — only the MCP tool turns them on by default at 100×100. Direct helper callers are unaffected.

#### Phase E status update

Phase E is now **complete end-to-end**:
- v0.14.2 — MVP byte-size filtering ✅
- v0.14.3 — `/review+` hardening ✅
- v0.14.7 — Intelligent relevance filters (defuddle + alt/figure + dimensions) ✅

The Phase E.2 deferred work from v0.14.2 (dimension parsing) and the implicit Phase E.3 (defuddle-first relevance) are both shipped.

### Phase D.2 `/review+` hardening (concurrent thread)

`mini-/review+` on commit 74ff782 (Phase D.2 MathML→LaTeX) found ZERO P1, two P2, three P3. The two P2 + two of three P3 are addressed below; P3-2 (duplicated MathML conversion between `webpageToMarkdown` and `extract_page_metadata`) is acknowledged as acceptable double work (≈1 ms per Wikipedia page).

#### Fixed

- **P2-1 — JSDoc fantôme**: the `convertMathmlBlocksInHtml` doc claimed a `<dl><dd><math>` parent-block heuristic for display detection that was never implemented (real code checks only the `display=` attribute). Removed the false claim; clarified that Wikipedia emits `display="block"` explicitly so the attribute check alone is sufficient.
- **P2-2 — UTF-8 round-trip non-idempotent on non-UTF-8 charsets**: `Buffer.from(buf.toString('utf-8'), 'utf-8')` inflates Windows-1252 / Latin-1 / ISO-8859-* bytes to U+FFFD when they're invalid UTF-8 sequences, corrupting accented characters in surrounding prose on a converted page. Mitigation: `markitdown.mjs::toMarkdown` now extracts `contentType` and `charset` from the response headers and passes both through to the `transformContent` hook's `ctx` argument. The `mathPreservingTransform` in `convert.mjs` adds two safety gates: (1) skip the transform unless `contentType` is `text/html` / `application/xhtml+xml` / `application/xml` / unset (PDFs, images, audio, video etc. now skip the UTF-8 round-trip entirely); (2) skip the transform if `charset` is set to anything other than UTF-8 / ASCII. Either gate failing → return `null` → markitdown uses the original buffer untouched. Math conversion is sacrificed in those edge cases in exchange for not corrupting surrounding content.
- **P3-1 — Double regex evaluation on close-tag scan**: `convertMathmlBlocksInHtml` was running `.search()` then `.slice().match()` against the same `/<\/math\s*>/i` regex to extract close-tag index AND length — two passes per block. Switched to a single `.exec()` call that returns `.index` + `[0].length` in one shot. No behavior change, one fewer regex per `<math>` block on math-heavy pages.
- **P3-3 — Test gap**: +2 hardening regression tests in `tests/latex-preserver.test.mjs`:
  - **PDF-like binary input** with accidental `<math` byte sequence (no matching `</math>` close in the bounded forward scan window) → `count=0`, html unchanged, conversions array empty. Locks in the no-corruption guarantee for non-HTML responses flowing through `webpage_to_markdown`.
  - **Display attribute variants**: `display="BLOCK"` (uppercase), `display = "block"` (whitespace around `=`), `display='block'` (single-quoted) — all three correctly detected as block math. Note: unquoted `display=block` (valid HTML5 but invalid XML) is NOT tested because `mathml-to-latex` uses xmldom which rejects unquoted attributes — real-world emitters (Wikipedia, MathJax, KaTeX) always quote.

#### Skipped (acknowledged NIT)

- **P3-2 — Duplicated MathML conversion**: a single `wiki-ingest` pass calls both `webpageToMarkdown` (which converts) and `extract_page_metadata` (which converts AGAIN to populate `mathmlLatex`). Cost bounded to ~1 ms per Wikipedia page. Worth refactoring only if a hotspot emerges; until then, the cleaner data flow (each tool independently consumes raw HTML, no implicit shared state) wins over the small perf gain.

### Test count: **1055/1055 passing** (was 1020 at v0.14.6; +33 Phase E.2 + 2 Phase D.2 hardening).

## [0.14.6] — 2026-05-25 — Phase D.2 · MathML → LaTeX conversion (Wikipedia equations now survive)

Closes the deferred Phase D.2 from v0.13.10: MathML `<math>...</math>` blocks in fetched HTML are now **converted to dollar-delimited LaTeX BEFORE markitdown runs**, so Wikipedia equations, arxiv abstracts with rendered formulas, and any math-heavy page with native MathML now survive the HTML→markdown conversion as inline `$LaTeX$` or block `$$LaTeX$$` strings.

Previous behavior (v0.13.10 detection-only): `has_latex: true` was set in frontmatter, but the actual equations were stripped by markitdown along with the `<math>` tags. The skill had to tell Claude "the original page contains rendered equations" without being able to surface them.

New behavior: the equations are inlined in the markdown body as text. LaTeX-Suite, KaTeX, MathJax, and any standard Obsidian math renderer can pick them up natively. No more "equations vanished during ingestion" — Wikipedia is now first-class.

### Added

- **`npm install mathml-to-latex@^1.5.0`** — pure JavaScript MathML→LaTeX converter, MIT, ~635 KiB unpacked. One transitive dep (`@xmldom/xmldom`). Stable lib (10 releases since 2020), API is a single `MathMLToLaTeX.convert(mathmlString) → string`.
- **`convertMathmlBlocksInHtml(html)` in `src/helpers/latex-preserver.mjs`** — pure helper:
  - Finds every `<math>...</math>` block via non-backtracking open-tag scan + bounded forward search for `</math>` (max 100 KiB span per block — matches the v0.13.11 hardening pattern that took pathological input from 1900 ms → 1.8 ms).
  - For each block, calls `MathMLToLaTeX.convert(mathmlSrc)` and replaces in-place:
    - `display="block"` → `\n\n$$<latex>$$\n\n` (centered equation, blank lines around for markdown safety)
    - default (inline / no display) → `$<latex>$` (inline math)
  - Skips blocks where the lib returns an empty string (malformed MathML, unsupported elements) — leaves the original `<math>` tags untouched rather than emit broken `$$$$`.
  - Returns `{html, count, skipped, conversions: [{mathml, latex, display, converted}]}` for both substitution (use the modified HTML) and audit (inspect what was extracted).
  - Replacement runs in reverse-index order so earlier offsets stay valid during string mutation.
- **`tests/latex-preserver.test.mjs`** — **+9 new tests** for the converter:
  - Simple inline `<math>` → `$x^{2} + y$`
  - `display="block"` `<math>` → `$$\frac{1}{2}$$`
  - Multiple blocks all converted (3 blocks, mixed inline/block)
  - Empty conversion result → original `<math>` left in place
  - No `<math>` in input → HTML returned unchanged (fast path)
  - Empty / null / undefined input safe (no throw)
  - Unclosed `<math>` (page truncated mid-equation) → skipped silently
  - **HARDENING perf test**: 50k unmatched `<math ` tokens finish in < 1000 ms (typically < 200 ms)
  - Wikipedia-style integration test: surrounding prose preserved, equation inlined

### Changed

- **`src/markdownify/markitdown.mjs::toMarkdown`** — new optional `transformContent(buffer, {url, extension}) → Promise<Buffer|string|null>` parameter. When provided, the callback runs on the fetched response body before it lands in the temp file that markitdown converts. Returning `null` means "no change, use original buffer" (the no-op path stays cheap). String returns are coerced to UTF-8 Buffers. The hook is opt-in — existing callers see no behavior change.
- **`src/tools/convert.mjs::webpageToMarkdown`** — now passes a `mathPreservingTransform` callback to `toMarkdown`. The transform decodes the fetched HTML as UTF-8, runs `convertMathmlBlocksInHtml`, and returns the modified HTML when at least one MathML block was successfully converted (else returns `null` for the no-op fast path). Pages without `<math>` blocks pay only a regex scan cost (no behavioral change).
- **`src/tools/extract-page-metadata.mjs`** — handler now exposes `mathmlLatex: [{latex, display}]` in its response when MathML blocks are present. Lets the wiki-ingest skill spot-check the conversion OR surface the extracted equations as a `## Équations` section. When no MathML present, `mathmlLatex: []` (consistent shape, easy to test for).
- **`skills/wiki-ingest/SKILL.md`** — Phase D section updated:
  - Removed instruction "mention that the original page contains rendered equations" (no longer needed — equations are now in the markdown body).
  - Added instruction explaining the new auto-conversion: preserve `$LaTeX$` / `$$LaTeX$$` strings in the body verbatim like any other math.
  - Added pointer to the new `mathmlLatex` audit field for callers that want to verify the conversion.

### Test count: **1020/1020 passing** (was 1011 at v0.14.5; +9 Phase D.2).

### Backward compatibility

- The new dep `mathml-to-latex` is purely additive. No existing API changes shape; `webpageToMarkdown` continues to return the same markdown string (just now with equations preserved).
- The `transformContent` hook is opt-in; existing `toMarkdown` callers without the parameter behave identically to before.
- `extract_page_metadata` adds a new field `mathmlLatex` (always present, defaults to `[]`). Pre-existing fields are unchanged.
- Pages without `<math>` blocks: no behavior change. The transform is a no-op for them (single regex scan, returns null = "use original buffer").
- The skill update is instructional — no fanout to existing source pages required.

### Phase D status update

Phase D is now **complete end-to-end**:
- v0.13.10 — Detection (`has_latex` frontmatter flag) ✅
- v0.14.6 — MathML conversion (equations in body) ✅

Equation image substitution (`<img alt="$..."` patterns from legacy Wikipedia / Pandoc HTML) remains deferred — rare enough in modern content to wait for a concrete trigger.

## [0.14.5] — 2026-05-25 — Phase F · Highlights persistence (obsidian-clipper port)

Phase F of the [[obsidian-clipper]] borrowing roadmap. Adds **dual-format highlight serialization** so the `wiki-ingest` skill can preserve user-selected text spans as BOTH human-readable Obsidian `[!highlight]` callouts AND machine-readable frontmatter YAML array. The two views are kept in sync — frontmatter is the source of truth, callouts are presentation.

This release is the **format layer only**. Manual input flow (the user pastes structured highlights into the ingest prompt) ships now. Automatic extraction (browser-extension overlay → bridge endpoint → re-hydration when opening a source page) stays deferred as Phase G — the format here is schema-compatible with obsidian-clipper so a future bridge round-trip is straightforward.

### Added

- **`src/helpers/highlights-format.mjs`** (NEW) — pure helper module, no deps. Five exported functions plus a frozen color list:
  - `normalizeHighlight(raw)` — canonical-shape converter. Mandatory `text`, optional `color` (default `yellow`) / `note` / `xpath` / `offset_start` / `offset_end`. Stable id: prefers caller-supplied (must match `^[A-Za-z][A-Za-z0-9-]*$`, the Obsidian block-id shape), else generates `h-<sha256(text|xpath)[:8]>`. Same `(text, xpath)` → same id → idempotent re-ingestion.
  - `renderCallout(highlight)` — emits an Obsidian `[!highlight] color=<X>` callout block. Multi-line text gets `> ` prefix per line, blank inner lines become bare `>` (Obsidian-paragraph-break-inside-callout). Trailing `> ^<id>` block anchor lets other notes link to the highlight via `[[<page>#^<id>]]`.
  - `renderFrontmatterArray(highlights)` — emits the YAML `highlights:` array. Conservative YAML scalar quoting: bare unquoted only for the allowlist `[A-Za-z0-9_./- ]+` (no reserved indicators, no whitespace edges); everything else double-quoted with `\` `"` `\n` `\r` `\t` escapes. Round-trip safe.
  - `serializeHighlights(rawArray)` — top-level wrapper. Returns `{normalized, calloutBlocks, frontmatterYaml}`. Empty/null/undefined input is safe (returns empty content + `highlights: []`).
  - `parseHighlights(frontmatterValue)` — read-side. Coerces each entry through `normalizeHighlight` so partial hand-edits get the canonical shape back. Non-array input throws.
  - `RECOGNIZED_COLORS` — frozen list of supported callout colors (`yellow`, `pink`, `blue`, `green`, `orange`, `purple`, `red`). Documentational only — we don't enforce.
- **`tests/highlights-format.test.mjs`** (NEW, 33 tests). Covers: normalization defaults + edge cases (missing text throws, blank text throws, non-object input throws, trimmed text, stable id derivation, explicit id preservation, invalid id replacement, color lowercasing, integer offset coercion); callout rendering (single-line, multi-line with `> ` prefix per line, blank-line handling, note inclusion, color from highlight not hardcoded, id always at end); frontmatter array rendering (empty → `highlights: []`, full fields, multi-line text escape, double-quote + backslash escape, reserved-YAML-char quoting, multiple highlights); top-level serialize wrapper; round-trip parse; RECOGNIZED_COLORS frozenness.

### Changed

- **`skills/wiki-ingest/SKILL.md`** — new "Highlights persistence (Phase F, v0.14.4+)" section (6 instructions) explaining the dual-format flow:
  1. Normalize input via `normalizeHighlight`.
  2. Call `serializeHighlights(normalized)`.
  3. Insert `## Highlights` H2 section before `## Sources` with the `calloutBlocks`.
  4. Add `highlights:` to frontmatter with the YAML array.
  5. Idempotence rule: existing frontmatter is source of truth — `parseHighlights → merge by id → re-serialize fully`. Don't append callouts manually.
  6. Default is highlights-off — don't fabricate / auto-extract (browser-extension auto-extraction stays in [[obsidian-clipper]] section "Extension navigateur router-aware" as deferred Phase G/🔮).

### Test count: **1011/1011 passing** (was 978 at v0.14.4; +33 from Phase F).

### Backward compatibility

- Phase F is opt-in via user-provided highlights. Existing ingestion flows without highlights are unchanged.
- No new MCP tool — `wiki-ingest` consumes the helper directly. No public API surface added.
- No npm dependencies. Pure Node + crypto for sha256.
- Frontmatter schema (`highlights:` array shape) is compatible with obsidian-clipper's own format so a future round-trip (clipper export → router import OR vice-versa) preserves structure.

### Deferred to Phase G (if bridge re-hydration demand surfaces)

- **Bridge endpoint** `GET /highlights/render?vault=X&path=Y` that reads the frontmatter `highlights:` array and returns positioned HTML overlay using the stored `xpath` + `offset_start`/`offset_end`.
- **Obsidian plugin layer** — inject the overlay when a source page opens so the highlights appear in-context, not just as callouts at the bottom.
- **XPath compatibility tests** — validate the stored xpath round-trips across 5+ different source sites (browser DOM normalization varies).
- **Browser-extension auto-extract** (🔮) — capture the user's selection in-browser and POST to the router, eliminating the manual paste flow.

## [0.14.4] — 2026-05-25 — `/review+` micro-hardening on v0.14.3 (P3-a + P3-b polish)

Second-pass mini-/review+ on commit `dfb65be` found ZERO P1/P2 — fixes from v0.14.3 close the issues cleanly per direct execution probes (nested brackets work as documented, ReDoS-free, P2-1 stat guards correctly handle ENOENT/non-dir, etc.). Three P3 nits remained, two worth landing.

### Changed

- **P3-a — `downloadAssets` JSDoc now documents `_statFn`.** `src/helpers/asset-downloader.mjs`. The injection seam was added in v0.14.3 and used in tests, but the `@param` block didn't list it. Future contributors might miss the test-stub pattern. Added: `@param {Function} [opts._statFn]` with explanation of the parent-exists + isDirectory() guards it backs.

### Added

- **P3-b — Shared-fixture lock-step regression test pins extract / rewrite regex parity.** `tests/asset-downloader.test.mjs`. The two markdown `![alt](url)` matchers (one in `extractImageUrls`, one in `rewriteAssetUrls`) MUST accept the same set of inputs — otherwise a future edit to only one would leave stale remote URLs for downloaded assets, or rewrite URLs we never extracted. New test loops 7 fixtures (simple alt, empty alt, multi-word, nested brackets, double-nested alt, with-title, wikilink-style) through extract → build map → rewrite, asserts every extracted URL is gone from the rewritten output. Catches drift in either regex automatically.

### Skipped (acknowledged NIT)

- **P3-c — `Number.isFinite` accepts `Number.MAX_SAFE_INTEGER` for `maxBytes`.** Not exploitable (`safeFetchBinary` enforces its own per-buffer cap regardless), and a hard upper bound would be opinionated. Documented here so the question doesn't get re-asked. Defensible to leave.

### Test count: **978/978 passing** (was 977 at v0.14.3; +1 lock-step regression).

### Backward compatibility

- Documentation-only change in `asset-downloader.mjs` JSDoc.
- New test doesn't touch any code path — purely additive.

## [0.14.3] — 2026-05-25 — `/review+` hardening on Phase E v0.14.2 (asset download)

`mini-/review+` on commit ddc6ecc surfaced 2 P2 correctness/security findings and 3 P3 polish items. All fixed with 9 new regression tests pinning the behaviors.

### Fixed

- **P2-1 — `downloadAssets` could silently write into arbitrary system directories when `MD_ALLOWED_PATHS` is unset.** `src/helpers/asset-downloader.mjs::downloadAssets`. With the env-var sandbox off, `assertPathAllowed` is a no-op, so a hostile MCP caller could pass an `outputDir` like `/etc/cron.d` — `fs.mkdir(..., {recursive: true})` silently succeeded against the existing dir and image writes would clobber unrelated system files. **Fix:** two new guards.
  - Pre-mkdir: stat the PARENT dir and refuse if it doesn't exist (ENOENT). Prevents bootstrapping arbitrary directory trees like `/etc/cron.d/whatever-attacker-wants/`.
  - Post-mkdir: stat the resolved path and assert `isDirectory()`. Catches symlink-to-file races and the `mkdir -p` edge case where a pre-existing symlink resolves to a non-directory target.
  - Both wired through a new `_statFn` injection seam so tests can drive ENOENT / file-not-dir / happy-path branches deterministically.

- **P2-2 — `extractImageUrls` and `rewriteAssetUrls` silently dropped markdown images whose alt text contained nested brackets** (e.g. `![Photo of [Eiffel tower]](url)`). `src/helpers/asset-downloader.mjs:105` + `:405`. The pre-fix regex `\[[^\]]*\]` bailed on the inner `[`, so the whole image reference was invisible: extract didn't queue it for download, and rewrite didn't replace it. Real impact: Wikipedia-style alt with `[citation needed]` markers, blogs with bracketed-attribution patterns. **Fix:** swap to `(?:\[[^\]]*\]|[^\]])*` (one level of nested-bracket balanced matching) in BOTH regexes — extract + rewrite must stay in sync or we'd download images we can't rewrite, leaving stale remote URLs.

### Changed

- **P3-1 — `pickAssetFilename` now strips LEADING dots** from the sanitized URL segment. Pre-fix, `/...png` yielded the literal filename `...png` and `/.png` yielded `.png`, both of which are hidden files on POSIX (`ls` hides them by default — surprising the user). The strip happens BEFORE the pure-dots check, so `/..` → `` → sha256 fallback (which is correct for an unnamed asset). 3-line fix in `pickAssetFilename`.

- **P3-2 — Skill `wiki-ingest` Phase E instructions now explain how to resolve the vault absolute path.** Pre-fix, the skill told Claude to call `download_page_assets({outputDir: "<vault-absolute-path>/.assets/..."})` without saying how to obtain `<vault-absolute-path>`. In workspace-bound mode (code repo associated with a separate vault), concatenating cwd with `wiki/...` produces a non-existent path — the well-known trap codified in the global CLAUDE.md. Added a 1-line resolution recipe at step 1: "Resolve via `list_vaults` and pick the entry's `path` field, then concatenate with `/wiki/.assets/<source-slug>/`."

- **P3-3 — MCP tool `download_page_assets` now validates numeric arguments explicitly.** `src/tools/download-page-assets.mjs`. Pre-fix, passing `maxAssets: 0` silently produced an empty no-op (`extracted: 24, attempted: 0, downloaded: []`) — the caller couldn't tell whether the tool was broken or whether the cap was the cause. New explicit validators reject `maxAssets / concurrency` ≤ 0 or non-integer, and `minBytes / maxBytes` outside their valid ranges, with clear error messages including the offending value.

### Added

- **9 new regression tests** across `tests/asset-downloader.test.mjs` (5) and `tests/download-page-assets.test.mjs` (4):
  - HARDENING P2-1 (file-as-dir guard): parent-missing rejection, file-not-dir rejection.
  - HARDENING P2-2 (nested brackets): extractImageUrls + rewriteAssetUrls both accept `![alt with [nested]](url)`.
  - HARDENING P3-1 (leading-dot trim): `...png`, `.png`, and `..` → safe filename / sha256 fallback.
  - HARDENING P3-3 (numeric validation): `maxAssets: 0`, `maxAssets: -5`, `maxAssets: 1.5`, `concurrency: 0`.

### Test count: **977/977 passing** (was 968 at v0.14.2; +9 hardening).

### Backward compatibility

- All fixes are additive guards on existing code paths. The only call-site change is the `_statFn` injection in `downloadAssets` — defaults to `fs.stat`, so existing callers keep working.
- The numeric validators in the MCP tool are stricter than pre-fix — any client that was relying on `maxAssets: 0` to silently skip downloading will now see a clear error instead. This is a pinning-the-correct-behavior change, not a regression: nobody should be passing those values intentionally.
- The nested-bracket regex fix is purely additive: pre-fix the affected images were INVISIBLE to the tool. Post-fix they're processed. No change for images that were already working.

## [0.14.2] — 2026-05-25 — Phase E · Asset download (obsidian-clipper port)

Phase E of the [[obsidian-clipper]] borrowing roadmap. Adds **opt-in image asset preservation** to the ingestion pipeline so `wiki-ingest --save-assets` can mirror a page's images into the vault (typically `<vault>/wiki/.assets/<source-slug>/`) and rewrite the markdown body to reference local paths. Without this, ingested pages keep remote `![](url)` references that rot over time or become unreachable offline.

**Default-off** — saving assets costs bandwidth + disk + a write-tool exposure surface, so the opt-in flag stays opt-in. Reading flows stay unchanged.

### Added

- **`src/helpers/safe-fetch-binary.mjs`** (NEW) — SSRF-safe binary fetcher, sibling of `safe-fetch-html.mjs`. Same pinned-IP undici dispatcher + manual redirect re-SSRF per hop + body-size cap + timeout, but returns `{buffer, contentType, finalUrl}` instead of `{html, finalUrl}`. Default cap 10 MiB per asset (vs 5 MiB for HTML — images can be larger). Acknowledged duplication with `safe-fetch-html.mjs` documented; a future refactor could extract a private `_safe-fetch-core.mjs`.
- **`src/helpers/asset-downloader.mjs`** (NEW) — pure helper module with 5 exports:
  - `extractImageUrls(content, baseUrl)` — quote-aware HTML `<img src>` + `<source srcset>` (first URL only) + markdown `![alt](url)` extraction. Resolves relative URLs against `baseUrl`. Skips `data:` / `blob:` / `javascript:` URIs. Dedupes.
  - `pickAssetFilename(url, buffer, contentType, usedNames)` — sanitizes URL path segment (`[A-Za-z0-9._-]` only, ≤80 chars), refuses `.`/`..`/`...`, forces extension from Content-Type (overrides `.html`/`.exe` sneaky URL extensions), falls back to `sha256(buffer).slice(0,16) + ext` on empty/collision.
  - `downloadOne(url, outputDir, opts)` — single-asset wrapper with size filtering (`minBytes` default 1024 to skip icons, `maxBytes` default 10 MiB).
  - `downloadAssets(urls, outputDir, opts)` — bulk wrapper with bounded parallelism (`concurrency` default 4). Creates `outputDir` recursively. Returns `{downloaded[], skipped[], errors[], urlMap}`.
  - `rewriteAssetUrls(content, urlMap, opts)` — pure markdown/HTML rewriter. Quote-aware. Preserves markdown title text. Handles protocol-relative `//host/path` references. Leaves un-mapped URLs alone (failed downloads stay remote).
- **`src/tools/download-page-assets.mjs`** (NEW) — MCP tool wrapper. Accepts `{url|html, baseUrl, outputDir, minBytes, maxBytes, concurrency, maxAssets}`. Validates absolute `outputDir`, refuses outside `MD_ALLOWED_PATHS` sandbox, caps URLs at `maxAssets` (default 200) to prevent attacker-page DoS. Returns serialized `urlMap` object (plain object, not Map — JSON transport).
- **`tests/asset-downloader.test.mjs`** (NEW, 33 tests) — extraction (HTML quote variants, srcset, markdown, relative resolution, dedup, data-URI skip, baseUrl-required guard), filename picking (content-type ext override, sha256 fallback, collision avoidance, 80-char cap, double-ext prevention), download flow (happy path, too-small skip, fetch errors, abs-path guard), bulk (dedup across batch, mixed results, concurrency cap respected — verified via in-flight peak counter), rewrite (markdown title preservation, HTML quote-style preservation, un-mapped left alone, protocol-relative remap, trailing-slash trimming).
- **`tests/download-page-assets.test.mjs`** (NEW, 13 tests) — TOOL_DEFINITION shape, input validation (XOR url/html, missing baseUrl, missing/relative outputDir), html-branch end-to-end without network (urlMap serialization to plain object, maxAssets cap respected, baseUrl passthrough), wiring into src/index.mjs (boot-time cross-check, WRITE_TOOL_NAMES inclusion).
- **`src/index.mjs`** — registered `download_page_assets` in TOOLS + TOOL_HANDLERS + WRITE_TOOL_NAMES (8 → 9 write tools). `tests/readonly.test.mjs` bumped count assertion accordingly.

### Changed

- **`skills/wiki-ingest/SKILL.md`** — frontmatter template extended with `assets_count: <N>` (emit only when `--save-assets` was used AND ≥1 asset saved). New "Asset preservation (Phase E, v0.14.x+)" section with 5 instructions:
  1. Call `mcp__obsidian-router__download_page_assets({url, outputDir: "<vault>/.assets/<source-slug>/"})` after metadata + LaTeX extraction.
  2. Use the returned `urlMap` to rewrite `![alt](remoteUrl)` and `<img src="remoteUrl">` references in the body to local paths.
  3. Set `assets_count` frontmatter (omit if zero, consistency with `has_latex`).
  4. Mention non-empty `errors` in `## Summary` (don't fail the ingestion — partial preservation is the point).
  5. Default is `--save-assets=false` — only run when user explicitly asks.

### Test count: **968/968 passing** (was 922 at v0.14.1; +33 asset-downloader + 13 download-page-assets = +46 from Phase E).

### Backward compatibility

- Opt-in flag. `wiki-ingest` without `--save-assets` behaves exactly as v0.14.1 — markdown keeps remote `![](url)` references.
- `download_page_assets` MCP tool is read-only-safe (excluded from listing under `OBSIDIAN_ROUTER_READONLY=true`) via WRITE_TOOL_NAMES.
- No npm dependencies added. Pure Node + the existing `undici` dispatcher pattern from `safe-fetch-html.mjs`.

### Deferred to Phase E.2 (if user demand)

- Image dimension parsing to skip icons by width/height instead of size threshold. Needs format-specific decoders for PNG (bytes 16-24), JPEG (SOF markers), GIF (bytes 6-10), WebP (VP8/VP8L chunks), SVG (XML parse).
- `<picture>` / `srcset` multi-resolution selection (we currently take the first `<source srcset>` entry; the caller can post-filter).
- Non-image asset types (video, audio, animated GIF retained but only as image-type).
- Image format conversion / re-encoding (e.g. WebP→PNG for older Obsidian themes that don't render WebP).

## [0.14.1] — 2026-05-25 — `/review+` hardening pass on the v0.14.0 auto-update path

Six review passes (Claude `Code Reviewer` agent + `codex review` CLI in parallel) on commit 5300e0d surfaced one silent BLOCKER, four IMPORTANT correctness/security findings, and one test-isolation gap. All fixed with regression tests pinning the behaviors.

### Fixed

- **BLOCKER — `installed_plugins.json` v2 array schema silently dropped mutations.** The current Claude Code schema is `plugins["<plugin>@<marketplace>"] = [{ scope, installPath, version, ... }, ...]` (array of scoped install entries, not a single object). The old `findInstalledEntry` returned the array; `entry.installPath = X` then attached non-index properties that `JSON.stringify` drops. Net effect: `tryAutoUpdate` reported success but `installed_plugins.json` stayed unchanged → Claude Code kept loading the old cache version after `/reload-plugins`. Renamed to `findInstalledEntries`, now matches every entry whose `installPath` resolves to the current cache dir (handles multi-scope user+project installs that share the same on-disk cache version) and refuses to guess when the array has multiple unrelated entries.
- **BLOCKER — `npm install` ran `postinstall` from freshly-pulled upstream code.** This repo declares `postinstall: node scripts/install-markitdown.mjs`. Without `--ignore-scripts`, every auto-update silently executed arbitrary upstream lifecycle scripts from a SessionStart hook with the user's privileges — supply-chain footgun on every release. Now passes `--ignore-scripts`; the bundled Python venv that markitdown needs is detected separately (see next item) and surfaced to the user as a remediation tip.
- **IMPORTANT — markitdown breakage detection after `--ignore-scripts`.** Skipping `postinstall` means the new cache dir gets no `.venv/`, and `resolveMarkitdownPath` (`src/markdownify/utils.mjs`) cascades from `<projectRoot>/.venv` to bare `markitdown` on PATH → ENOENT for users on the bundled venv. New helper `detectMarkitdownStatus` distinguishes `ok` / `will-break` / `never-installed` and honors both override flags (`MARKITDOWN_PATH` and `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`, matching what the notice promises). The success notice now includes a one-liner recovery command when `will-break`, instead of silently breaking the conversion tools after `/reload-plugins`.
- **IMPORTANT — copy step skipped against an empty/corrupt cache dir.** Before: `if (!fs.existsSync(newCacheDir))` skipped the entire copy if a previous partial run had left an empty dir; `npm install` then ran against nothing and failed opaquely. Now: re-copies unless `package.json` exists AND already reports `newVersion`; uses `cpSync(..., { force: true })` so the repair actually overwrites stale leftovers.
- **IMPORTANT — `rewriteSettingsHookPaths` ate its own result + missed mixed-separator paths.** Two issues: (a) caller discarded the `{changed}` return, so the user never knew when pinned hook paths weren't updated; (b) the two hardcoded separator variants (`/cache/...` and `\cache\...`) missed real-world mixed paths like `C:\Users\u/.claude/plugins/cache/mp/pl/0.1.0/...`. Now a single separator-agnostic regex (`[\\/]+`) handles all three styles, preserves the existing separator pattern via capture group, and uses a lookahead `(?=[\\/])` so versions that are prefixes of others (`0.1.0` vs `0.1.0-beta.1`) aren't accidentally rewritten. Result shape is now `{changed, settingsExists}`, propagated up to the success notice, which surfaces an honest 2-step remediation (delete stale entries → re-run `--install-hooks`) when the rewrite was skipped — because `--install-hooks` alone only appends missing hooks, it does NOT rewrite existing stale paths.
- **NIT — test regex with no-op escape + unescaped dots.** `new RegExp(newCacheRel.replace(/\//g, '\\/'))` was a no-op (forward slashes don't need escaping in the RegExp constructor) and unescaped dots made the match looser than intended. Replaced with explicit `.includes()` assertions on both the new path AND the absence of the old path.
- **NIT — markitdown integration tests leaked ambient env.** `tryAutoUpdate` hardcodes `process.env`, so a CI/dev machine with `MARKITDOWN_PATH` or `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` set would short-circuit those two tests to `ok`. Now isolated in a nested `describe` with `before`/`after` env save+restore.

### Added (regression tests)

18 new tests covering the fixes: v2-schema mutation persistence (3 cases including multi-scope-same-installPath), `--ignore-scripts` enforcement, partial-run cache-dir repair, mixed-separator paths + prefix-version isolation, `settingsExists` flag propagation, `detectMarkitdownStatus` for all 5 paths (override / new venv / will-break / never-installed / both override flags). Total test count: 904 → 922.

### Deferred (filed for follow-up, not addressed in this pass)

- Defense-in-depth path-traversal check on `parseMarketplaceCachePath` (unreachable in practice — `pluginRoot` always comes from `__dirname` of the hook).
- `dryRun` write-then-restore in `bump-version.mjs` (sem-clean refactor: split helpers so disk writes only happen outside dry-run).
- Synchronous auto-update inside the SessionStart hook can theoretically freeze for `NPM_INSTALL_TIMEOUT_MS` (180 s) on first-time installs of large dep trees — would need a "applying in background, pickup next session" architecture.

## [0.14.0] — 2026-05-25 — Opt-in auto-update + version-sync script

Closes the "skill updates never reach Nicolas's workspace until he runs `/plugin update`" gap. Two related changes:

1. **`scripts/bump-version.mjs`** — new helper that bumps the version in all three files Claude Code's marketplace mechanism reads (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — both `metadata.version` and `plugins[0].version`) in one command, plus inserts a CHANGELOG stub. Idempotent (re-running on same version is a no-op), refuses to downgrade. Fixes the silent-drift bug where `package.json` was at v0.13.x for several releases but `plugin.json` + `marketplace.json` stayed at v0.12.7 — meaning `/plugin update` on downstream installs was a no-op even when a new version had shipped. Run as `npm run bump <new-version>` or `node scripts/bump-version.mjs <new-version>`.

2. **`hooks/check-router-update.mjs` — opt-in auto-update mode** (env var `OBSIDIAN_ROUTER_AUTO_UPDATE=true`). When set + a newer version is detected on GitHub, the SessionStart hook replicates what `/plugin update` does internally: `git pull --ff-only` in the marketplace clone, copy the new version into `~/.claude/plugins/cache/.../<new-version>/`, `npm install --omit=dev`, update `installed_plugins.json` atomically, and rewrite pinned hook paths in `~/.claude/settings.json` (Claude Code does NOT do this rewrite on `/plugin update` — confirmed via docs: "When a plugin updates mid-session, hook commands keep using the previous version's path. Run `/reload-plugins` to switch."). After success, emits a "🆙 Auto-updated v… → v…, run `/reload-plugins` or restart" notice. Fails silently on any error (dev install, dirty marketplace, npm failure, missing `installed_plugins.json`, etc.) and falls back to the standard manual notice with the failure reason inline.

### Added

- **`scripts/bump-version.mjs`** (NEW, exported functions: `bumpAll`, `updateJsonVersion`, `insertChangelogStub`) — version-sync script with `--dry-run` and `--no-changelog` flags. CLI exits 0 on success / 1 on bad args or invalid semver / downgrade refusal.
- **`src/helpers/plugin-auto-update.mjs`** (NEW, exported: `tryAutoUpdate`, `parseMarketplaceCachePath`, `rewriteSettingsHookPaths`) — pure-ish helpers (filesystem + subprocess) extracted from the hook so tests can drive them with fixtures + stubbed `gitRun` / `npmRun` runners.
- **`tests/bump-version.test.mjs`** (NEW, 22 tests) — happy path, idempotency, downgrade refusal, invalid semver, desync handling (the actual production bug this script exists to fix), dry-run, CHANGELOG insertion + idempotency, fallback to `# Changelog` heading when `[Unreleased]` absent, malformed-file errors, CLI exit codes.
- **`tests/plugin-auto-update.test.mjs`** (NEW, 21 tests) — `parseMarketplaceCachePath` matrix, full `tryAutoUpdate` happy path with fake `<HOME>/.claude/plugins/` tree + stubbed git/npm, each bail-out path (dev install, dirty marketplace, missing .git, version mismatch, npm failure, missing/malformed `installed_plugins.json`, nested `plugins:` schema, copy idempotency), `rewriteSettingsHookPaths` for both `/cache/.../<v>/` and `\cache\...\<v>\` variants, defensive array walking.
- **`npm run bump <version>`** — convenience npm script alias for the bump-version CLI.
- **`docs/how-to-update.md`** — new "Path C — Auto-update (opt-in)" section in both EN and FR sections, documenting the env var, the 5-step replication of `/plugin update`, the safety guards (skip on dev install / dirty / divergent / version mismatch / npm failure / missing `installed_plugins.json`), the one-session lag, and the `/reload-plugins` interaction.

### Changed

- **`.claude-plugin/plugin.json`** + **`.claude-plugin/marketplace.json`** — bumped from stale v0.12.7 (silently behind for 7 releases) to v0.14.0 via the new bump-version script. After this release, all 3 files stay in lock-step.
- **`hooks/check-router-update.mjs`** — refactored to import `tryAutoUpdate` from `src/helpers/plugin-auto-update.mjs`. When `OBSIDIAN_ROUTER_AUTO_UPDATE` is set + an update is available, calls the helper before composing the notice; on success, emits the "auto-updated" notice instead of the manual one; on failure, falls back to the manual notice with the failure reason embedded.

### Test count: **867/867 passing** (was 824 at v0.13.9 + ~21 from v0.13.10 LaTeX; +43 from the two new test files).

### Backward compatibility

- Auto-update is **opt-in via env var**. Users who don't set `OBSIDIAN_ROUTER_AUTO_UPDATE` see exactly the v0.13.x behavior (manual notice + `/plugin update`).
- `bump-version.mjs` refuses to downgrade — accidentally typing a lower version errors out with a clear message instead of corrupting state.
- The settings.json hook-path rewrite is best-effort: a failure (read error, parse error, write error) returns `changed: false` silently. The auto-update as a whole still reports success because the rest of `/plugin update`'s work has been done — the consequence of a missed rewrite is just that hooks keep firing from the old version dir until the user re-runs `setup-vault.mjs --install-hooks`.
- Dev installs (npm link, repo checkouts outside `~/.claude/plugins/cache/`) detect themselves via `parseMarketplaceCachePath` and skip auto-update unconditionally. Roland's local dev workflow is unchanged.

## [0.13.10] — 2026-05-25 — Phase D · LaTeX preservation MVP (obsidian-clipper port)

Phase D of the [[obsidian-clipper]] borrowing roadmap. Adds **LaTeX/math detection** to the ingestion pipeline so `wiki-ingest` can set `has_latex: true` in source-page frontmatter and instruct Claude to preserve `$...$` / `$$...$$` blocks verbatim instead of reformatting them to Unicode or stripping them. Without this, Wikipedia pages with MathML, blogs using KaTeX, and arxiv abstracts all lose their math during ingestion.

**MVP scope** — detection-only. This release flags pages that contain math; preservation in the body is enforced by the wiki-ingest skill telling Claude not to touch `$...$`. MathML→LaTeX conversion and equation-image substitution are deferred to Phase D.2 (would need the `mathml-to-latex` npm dep, opt-in based on user demand).

### Added

- **`src/helpers/latex-preserver.mjs`** (NEW) — pure helper module, no deps. Two complementary detectors:
  - `detectLatexInHtml(html)` — runs on raw HTML. Returns `{hasLatex, signals: {mathml, katex, mathjax, dataLatex, dollarInline, dollarBlock}}`. Catches MathML `<math>` tags, KaTeX script/CSS/class hooks, MathJax script/config/class hooks, `data-latex`/`data-tex`/`data-math` attributes (Mathjax-3 SSR, Pandoc HTML), and `$...$` body text (with `<script>`/`<style>` stripping to avoid false positives in stylesheets).
  - `detectLatexInMarkdown(md)` — runs on extracted markdown. Returns `{hasLatex, inlineCount, blockCount}`. Filters out currency (`$5.99`, `$JPY`) by requiring LaTeX-looking content (backslash command, `^`/`_`, Greek letter) inside `$...$`. Skips fenced code blocks (```` ``` ```` and `~~~`) entirely so shell prompts and regex don't pollute.
  - `hasLatex` threshold: any of MathML / KaTeX / MathJax / data-latex signals, OR ≥1 `$$` block, OR ≥2 inline `$...$` pairs (1 isolated pair could be currency mention).
- **`tests/latex-preserver.test.mjs`** (NEW, 29 tests). Covers: currency rejection ($5.99/$JPY), Greek letters / backslash commands / sub-superscripts inside `$...$`, fenced code block skipping (`` ``` `` + `~~~`), MathML tag counting, KaTeX/MathJax detection via script src + class hooks + config, data-latex/data-tex counting, `<script>`/`<style>` text isolation, combined-signals integration (Wikipedia-style MathML + KaTeX-rendered blog).

### Changed

- **`src/tools/extract-page-metadata.mjs`** — handler now calls `detectLatexInHtml` on the fetched HTML and augments the response with `hasLatex: bool` and `latexSignals: {mathml, katex, mathjax, dataLatex, dollarInline, dollarBlock}`. TOOL_DEFINITION description updated to mention math detection. **+2 regression tests** in `tests/extract-page-metadata.test.mjs` verifying the new fields (plain HTML → `false`, MathML → `true`, KaTeX-rendered → `true`).
- **`skills/wiki-ingest/SKILL.md`** — Step 4 frontmatter template extended with `has_latex: <metadata.hasLatex>` (emit only when true to keep frontmatter tight). New section "LaTeX preservation (Phase D, v0.13.10+)" instructing Claude to:
  1. Emit `has_latex: true` in frontmatter when metadata says so (Obsidian/KaTeX MathBlock will render).
  2. Preserve `$...$` and `$$...$$` blocks **verbatim** in the body — never reformat `$x^2$` as `x²`, never strip `$$\sum_n a_n$$`, never paraphrase formulas.
  3. If markitdown stripped MathML, mention in `## Summary` that "the original page contains rendered equations" — never fabricate replacement LaTeX from descriptions.
  4. Use `latexSignals` to decide whether `has_latex: true` is well-founded or a false positive (currency-heavy page that tripped the heuristic).

### Test count: **855/855 passing** (was 824 at v0.13.9; +29 latex-preserver + 2 extract-page-metadata Phase D regressions).

### Backward compatibility

- Detection is purely additive. `extract_page_metadata` continues to return the same payload shape with **two new fields appended** (`hasLatex`, `latexSignals`) — pre-existing callers ignore them.
- `wiki-ingest` skill change is instructional only (markdown procedure). Existing source pages without `has_latex` continue to work; new ingestions augment frontmatter when math is detected.
- No npm dependencies added. The `mathml-to-latex` package mentioned in the original Phase D plan is deferred to Phase D.2 (conversion-mode, opt-in).

### Deferred to Phase D.2 (if user demand surfaces)

- `mathml-to-latex` npm dep + `htmlMathmlToLatex(html)` helper to replace `<math>...</math>` blocks with `$$...LaTeX...$$` before markitdown converts.
- `htmlImageEquationsToLatex(html)` to detect `<img alt="$..."` patterns (Wikipedia legacy renderer, Pandoc) and substitute with the source LaTeX.
- Post-process markdown to re-inject dropped LaTeX from a pre-conversion HTML LaTeX-extraction pass.

## [0.13.9] — 2026-05-25 — Fresh-machine click-to-open: 3 setup gaps closed

Closes the three structural gaps that made a fresh-machine install **fail to produce working click-to-open links out of the box**, even though the bridge plugin, Local REST API, and the convention all existed. Trigger: Roland asking *"pourquoi ce n'est pas configuré d'office sur une nouvelle machine quand j'installe le routeur ?!"* (2026-05-25).

The three gaps and their fixes:

1. **Vaults bootstrapped before v0.10.x stay HTTPS-only** — `patchRestApiData()` writes `insecurePort` + `enableInsecureServer: true` at bootstrap time, but `--sync-plugins --force` deliberately preserves `data.json` for credential safety, so it doesn't backfill those fields. Without them, vaults fall back to HTTPS-only, which Bitdefender / ESET / Kaspersky silently drop. → **New mode `--upgrade-insecure-server[-all]`**: patches ONLY those two fields, preserves apiKey + port + cert + everything else. Idempotent. Respects user-set `insecurePort` even if it collides with another vault (surface, don't mutate). Batch mode iterates `portRegistry` and detects collisions across vaults when allocating fresh.

2. **The global `~/.claude/CLAUDE.md` convention isn't propagated** — the "Obsidian vault links" section that tells Claude to emit `http://127.0.0.1:<insecurePort>/open/<path>` lives in the user's private global CLAUDE.md, which is per-machine. On a fresh machine Claude generates `obsidian://` URIs (filtered by Claude Code CLI on click) or `https://` (dropped by Bitdefender), so the user gets dead links. → **New mode `--install-global-convention <name>`** + companion `--list-global-conventions`. Appends a snippet shipped under `templates/global-claude-md-snippets/` to `~/.claude/CLAUDE.md` with HTML-comment markers (`<!-- BEGIN obsidian-mcp-router:<name> -->` … `<!-- END ... -->`) for idempotency. Re-runs are no-ops; `--force` replaces the marker block while preserving surrounding user edits. Initial snippet shipped: `obsidian-vault-links`.

3. **`meta-setup` skill doesn't discover vaults** — installing the router (`meta-setup`) does `npm link` + Claude Code registration but touches no vault. The user must manually run `setup-vault.mjs <path>` for each pre-existing vault, easy to skip. → **New mode `--discover-vaults [--bootstrap-all]`**: scans well-known per-OS locations (`C:/VAULTS`, `~/Documents/Obsidian`, `~/Obsidian`, iCloud `Mobile Documents/iCloud~md~obsidian/Documents`, Google Drive desktop `<drive>:\Mon Drive\VAULTS` etc.) for directories with `.obsidian/`, classifies each as `reference` | `registered` | `candidate` | `partial`. `--bootstrap-all` then bootstraps every candidate sequentially. `--no-default-scan` + `--scan-dir <path>` (repeatable) let the caller target a custom root.

### Added

- **`scripts/setup-vault.mjs`** (new functions + CLI modes):
  - `upgradeInsecureServer(vaultPath, opts)` — patch `insecurePort` + `enableInsecureServer` surgically. Behavior matrix: sane+true → no-op; sane+false → flip bool; unset → allocate (collision-avoid in batch). Modes: `--upgrade-insecure-server <path>` and `--upgrade-insecure-server-all`, both with `--dry-run`.
  - `installGlobalConvention(name, opts)` + `listGlobalConventions()` — append a shipped snippet to `~/.claude/CLAUDE.md` with HTML-comment markers. Modes: `--install-global-convention <name>` (with `--force` and `--dry-run`), `--list-global-conventions`.
  - `discoverVaults(opts)` + `defaultScanLocations()` + `classifyVault()` — scan well-known + extra dirs, classify each found vault. Modes: `--discover-vaults` (with `--bootstrap-all`, `--dry-run`, `--scan-dir <path>` repeatable, `--no-default-scan`).
- **`templates/global-claude-md-snippets/obsidian-vault-links.md`** (NEW) — the canonical click-to-open formatting convention, shipped as a re-installable snippet for `--install-global-convention`.
- **`tests/upgrade-insecure-server.test.mjs`** (NEW, 12 tests) — single + batch modes, idempotency, dry-run, collision-avoidance, edge cases (missing data.json, corrupt JSON, missing port, self-collision).
- **`tests/install-global-convention.test.mjs`** (NEW, 9 tests) — first-time install, append to existing CLAUDE.md, idempotency, `--force` upgrade preserving surrounding content, dry-run, snippet-not-found, missing-END-marker refusal.
- **`tests/discover-vaults.test.mjs`** (NEW, 10 tests) — detection by `.obsidian/`, classification (candidate/registered/reference/partial), `--scan-dir` extension, `--no-default-scan` isolation, `--bootstrap-all` dry-run, edge cases (no reference vault, 0 candidates).

### Test count: **824/824 passing** (was 793 at v0.13.8; +31 from the 3 new test files).

### Backward compatibility

- All 3 new modes are opt-in; no behavior change for existing `setup-vault.mjs <path>`, `--sync-plugins`, `--sync-all`, or `--bootstrap-reference` paths.
- `--upgrade-insecure-server[-all]` never bumps a sane existing `insecurePort` (even on collision) — surface the collision via report, never mutate.
- `--install-global-convention` never overwrites content outside marker blocks; re-running is always safe.
- `--discover-vaults` is read-only by default; only `--bootstrap-all` writes.

## [0.13.8] — 2026-05-24 — A.1 hardening pass 2 (codex post-commit on 300f161)

Second hardening pass on the A.1 filter library. Originally targeted for v0.13.7 but a concurrent session shipped `vault-doc-startup-check` (f81d9de) under that number first — this work re-tags to v0.13.8.

mini-`/review+` on `300f161` (v0.13.6 A.1 hardening) caught **2 additional P2 findings** that the v0.13.6 round had missed. **Codex pattern continues to pay off** — every post-commit pass on this Phase A→C series has surfaced real bugs:

| commit | codex post-commit findings |
|---|---|
| `ae1986c` v0.13.0 | 5 P2 (sanitize bypass, TZ shift, reserved-name leak, HTML entities, JSON-LD type regex) |
| `caa9463` v0.13.3 | 1 P1 + 4 P2 (wrapResult double-wrap, dedup, entity decode in href, quoted `>` in tag-open) |
| `493adce` v0.13.4 | 1 P1 (Node-20+ `lookup.opts.all` array convention — fetch URL totalement cassé en prod) |
| `599514d` v0.13.5 | codex hit OpenAI quota; Reviewer A found 3 P1/P2 (date_modify month roll, duration token boundary, strip_md unanchored) |
| `300f161` v0.13.6 | **this commit** — 2 P2 (duration whitelist, strip_md indent) |

### Changed

- **`src/helpers/filters/duration.mjs` G (P2)** — letter-whitelist precondition. The v0.13.6 lookbehind/lookahead boundary was insufficient for formats like `'hh:mm'`: `mm` was preceded by `:` (non-letter) and followed by end-of-string (non-letter), so it still matched → result `'hh:01'` instead of preserved `'hh:mm'`. **Fix**: pre-pass over format — if ANY letter is outside the canonical token set `Hms` (case-sensitive), bail out and return format literal. More predictable than the v0.13.6 boundary-only approach.
  - **Trade-off / behavioral change**: a marginal v0.13.6 capability is lost. Pre-v0.13.8 `duration('3600', 'H total')` → `'1 total'` (the lone `H` was tokenized between non-letter delimiters). Post-v0.13.8: `'H total'` literal (because `total` has non-Hms letters → bail). Test updated.
  - **Net benefit**: `'hh:mm'`, `'MM:SS'`, `'H:mm sec'`, etc. all behave predictably now (literal preserved instead of partial replacement).
- **`src/helpers/filters/strip_md.mjs` H (P2)** — table indent tolerance per markdown spec. Pre-v0.13.8 the strict `/^\|...` regex missed valid indented table rows like `  | col1 | col2 |`. Markdown allows 0-3 leading spaces (or a tab) before block-level syntax. **Fix**: `/^[ \t]{0,3}\|.*\|\s*$/gm`. 4+ leading spaces = code block (preserved as-is, not stripped as table).

### Added

- **`tests/filters-wave1-rest.test.mjs`** (+2 regression cases): lowercase `hh:mm` / `MM:SS` formats preserved as literals (whitelist-bail), indented tables (0-3 spaces / 1 tab) stripped, deeply-indented `    |...|` preserved as code block.

### Note on commit `e9d5e82`

The commit title and body reference v0.13.7. That was the intent at commit time — the concurrent v0.13.7 shipping was discovered post-commit. The code in `e9d5e82` is the actual content of v0.13.8 (this entry). No `git revert` / amend needed — the commit history reflects the order of events, this CHANGELOG entry is the canonical version mapping.

### Backward compatibility

- `duration` whitelist change is a behavioral change for formats with non-Hms letters. Only `'H total'` test case was affected and updated to assert the new (stricter, more predictable) behavior.
- `strip_md` indent fix is a pure bug fix — previously valid indented tables were missed.
- Phase D LaTeX cumulatively shifts to **v0.13.9**.

### Test count: **793/793 passing** (was 769 at v0.13.6; +24 includes the 2 v0.13.8 regressions + tests from the concurrent v0.13.7 work).

## [0.13.7] — 2026-05-24

**Doc drift detection promoted from "happens to fire on commit" to "fires at every SessionStart"** — closes the recurring gap where the wiki documentation lagged the repo state across multiple commits because the user (or Claude) didn't see the per-commit nudge in time.

Triggered by Roland on 2026-05-24 after manually catching 8 stale versions in `wiki/obsidian-mcp-router/router-changelog.md` (the wiki was at v0.12.2 while the repo had shipped v0.12.10): *"trouve une solution pour ne plus jamais oublier quelque que soit le workspace associé à un vault de mettre à jour la documentation. […] JE VEUX TOUT A JOUR, JE VEUX QUE CE VAULT SE REMPLISSE AU FUR ET A MESURE. QUE LES INFOS SOIENT CONSOLIDEES"*.

### Added

- **`hooks/_helpers/doc-drift-detector.mjs`** (NEW shared helper, ~330 LOC) — factored detection logic shared by two hooks. Detects 4 drift kinds against any (repo, vault) pair:
  - `changelog-version`: wiki `router-changelog.md` doesn't have a `## v<current>` section.
  - `changelog-cumulative`: the last 5 versions from repo `CHANGELOG.md` aren't all in the wiki — **catches the multi-version gap** (8 versions in one go was the trigger case).
  - `index-version`: `wiki-meta/index.md` doesn't mention the current version.
  - `project-router-version`: `wiki/<project>/project-router.md` frontmatter `current-version` ≠ repo version.
  - `catalog-missing`: artifact basenames under `hooks/scripts/skills/commands/agents/templates/` aren't all referenced in the matching catalog page (`router-hooks.md`, `router-cheatsheet.md`, `router-skills.md`, `router-commands.md`, `router-agents.md`, `router-templates.md`).

- **`orderedVaultCandidates(cwd, cfg)` helper** — fixes the pre-v0.13.7 bug in `doc-propagation-checker` where the vault iteration broke on the first match (usually `.template`) and never reached the actual project vault. New priority order: workspace-bound (via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in `<cwd>/.env`) → `cfg.defaultVault` → cwd-basename heuristic → others → `.template` last.

- **`hooks/vault-doc-startup-check.mjs`** (NEW SessionStart hook) — fires at every Claude Code session start, runs the detector against the most relevant vault, surfaces drift as a `VAULT_DOC_STARTUP_DRIFT:` nudge in the SessionStart context. Independent of commit events — catches drift that accumulated over previous sessions (or got missed by `doc-propagation-checker`'s commit-time nudge). Fingerprint dedup at `<cwd>/.vault-meta/doc-drift-startup-fingerprint` prevents re-firing for the same un-actioned drift state.

- **`tests/doc-drift-detector.test.mjs`** (NEW, 22 tests) — unit tests for the 5 detection kinds, vault selection ordering, catalog basename listing, fingerprint stability.

### Changed

- **`hooks/doc-propagation-checker.mjs`** — refactored to delegate vault-side drift detection to `doc-drift-detector.mjs`. Now reports ALL drift kinds (not just `changelog-version`), uses cumulative window check, iterates up to 2 relevant vaults (capped to avoid spam), uses `orderedVaultCandidates` for sane vault priority. Repo-level CHANGELOG/ROADMAP/Unreleased checks unchanged.

- **`hooks/hooks.example.json`** — adds `vault-doc-startup-check.mjs` to the `SessionStart` event (matcher `startup|resume|clear`, alongside the existing `hot-cache-load`, `check-router-update`, `session-auto-journal`).

- **`tests/doc-propagation-checker.test.mjs`** — assertion strings updated to match the new `VAULT_DOC_DRIFT:` nudge format from the shared detector. Test fixture's `package.json name` changed to `obsidian-mcp-router` so the detector finds the matching wiki project folder.

### Backward compatibility

- Both hooks honor the existing `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true` opt-out env var (one flag for both).
- `vault-doc-startup-check.mjs` additionally supports `OBSIDIAN_ROUTER_NO_DOC_STARTUP_CHECK=true` for selective opt-out (e.g. silence SessionStart while keeping the commit-time check).
- Vaults without `wiki/<project>/router-changelog.md` are silently skipped — the hook never crashes on partial wiki scaffolding.
- Test count: **791/791 passing** (+22 new doc-drift-detector tests, +1 reused assertion in propagation-checker).

### What this closes

The user's exact pain — never again missing the wiki update for a shipped commit, regardless of which workspace+vault pair you're working in. The drift is surfaced **at the start of every session**, not just at commit time, so even if the user re-opens a session 3 days later without committing, they see the accumulated drift report and can consolidate before doing anything else.

## [0.13.6] — 2026-05-24 — A.1 hardening (3 correctness bugs from mini-review+ on 599514d)

Hardening pass on the 12 newly-shipped Wave-1 filters. mini-`/review+` on commit `599514d` (v0.13.5 A.1 completion) caught **3 silent correctness bugs** in the adapted-from-Clipper filters — all reproduced by exec. Fixed before Phase D LaTeX starts (which now shifts to v0.13.7 cumulatively).

Note: codex pass hit its OpenAI usage limit on this review (HTTP 403 quota exceeded), so only Reviewer A's findings are included here. The findings are concrete (proven by exec), high-quality, and all P1/P2 — no need to wait for codex retry.

### Changed

- **`src/helpers/filters/date_modify.mjs` F1 (P1, silent correctness)** — month and year shifts now CLAMP the day to the last valid day of the target month, instead of letting JS `Date.setMonth` roll over. Pre-v0.13.6:
  - `date_modify('2026-01-31', '+1 month')` → `'2026-03-03'` ❌ (Feb 28 + 3, silent overflow)
  - `date_modify('2024-02-29', '+1 year')` → `'2025-03-01'` ❌ (Feb 29 non-existent in non-leap year 2025)
  Post-v0.13.6:
  - `date_modify('2026-01-31', '+1 month')` → `'2026-02-28'` ✅
  - `date_modify('2024-02-29', '+1 year')` → `'2025-02-28'` ✅
  - `date_modify('2024-02-29', '+4 years')` → `'2028-02-29'` ✅ (next leap year preserved)
  Implementation: new private `shiftMonthClamped(date, monthDelta)` helper — sets day to 1 first (always valid), shifts month, then clamps day to last-day-of-new-month.

- **`src/helpers/filters/duration.mjs` F2 (P1, silent correctness)** — token replacement now requires non-letter boundaries on both sides. Pre-v0.13.6 the unbounded `replace(/HH|H|mm|m|ss|s/g, …)` matched mid-word. Reproduced:
  - `duration('3600', 'Hours')` → `'1our0'` ❌ (the `H` of `Hours` matched, replaced by `1`, the `s` matched, replaced by `0`)
  - `duration('3690', 'hh:mm')` → `'hh:01'` ❌ (the `mm` matched even though it sat after `:` after `h` which is a letter)
  Post-v0.13.6:
  - `duration('3600', 'Hours')` → `'Hours'` ✅ (no match — `H` is followed by a letter)
  - `duration('3690', 'hh:mm')` → `'hh:mm'` ✅ (no match — `mm` is preceded by `:` then `h` non-token; the regex correctly rejects)
  Implementation: `/(?<![A-Za-z])(HH|H|mm|m|ss|s)(?![A-Za-z])/g` with lookbehind+lookahead boundaries.

- **`src/helpers/filters/strip_md.mjs` F3 (P2, silent erasure)** — table-stripping regex now anchored to full table lines. Pre-v0.13.6 the unanchored `\|.*\|/g` (port-of-Clipper-bug) matched any line with 2+ pipes:
  - `strip_md('see this | a | b | row')` → `'see this  row'` ❌ (middle erased)
  - Math notation `P(A|B)` would have its middle wiped if it had a 2nd pipe in the same line.
  Post-v0.13.6: anchored `/^\|.*\|\s*$/gm` — only matches lines that start AND end with `|`. Body text with arbitrary pipes is preserved:
  - `strip_md('Conditional P(A|B) is...')` → `'Conditional P(A|B) is...'` ✅
  - `strip_md('run \`ls | grep foo\` to filter')` → preserves the pipe ✅
  - Real table lines (`| col1 | col2 |`) still stripped ✅. We diverge from Clipper here intentionally — their unanchored version is a correctness bug they may want to fix upstream eventually.

### Added

- **`tests/filters-wave1-rest.test.mjs`** (+7 regression cases): Jan31+1month clamp, leap-year +1year clamp, leap-to-leap +4years preservation, mid-month sanity check, literal letters in duration format preserved, canonical duration formats still work, body pipes preserved, real table lines still stripped.

### Backward compatibility

- All 3 fixes are bug fixes — they produce **correct** outputs where pre-v0.13.6 produced silently wrong ones. No client that relied on the buggy behavior is at risk except in the F3 case where a body containing 2+ pipes would no longer be (erroneously) stripped. That's a feature, not a regression.
- Phase D LaTeX cumulatively shifts: original v0.13.3 → v0.13.4 (Phase C insert) → v0.13.5 (Phase C hardening) → v0.13.6 (A.1 complete) → **v0.13.7** (this hardening) → eventually Phase D.

### Test count: **769/769 passing** (was 762 at v0.13.5; +7 regression tests).

## [0.13.5] — 2026-05-24 — A.1 completion (12 remaining Wave-1 filters) + critical Node-20+ fetch fix

Two changes bundled here:

1. **Codex P1 (CRITICAL) — `safe-fetch-html.mjs` lookup callback fixed for Node 20+**. The mini-`/review+` on commit `493adce` (v0.13.4 hardening) caught that the pinned-IP custom `lookup` callback returned `(null, address, family)` scalar — but on Node 20+ where `autoSelectFamily` is on by default, undici calls `lookup(host, opts, cb)` with `opts.all === true` and expects the callback to receive an **array** of `{address, family}` records (happy-eyeballs v2). Returning scalar in that branch made undici fail with `ERR_INVALID_IP_ADDRESS` before connecting, so **every URL-input fetch through `extract_page_metadata` and `propose_linked_sources` was broken in production**. Tests didn't catch it because they used the `html` input branch (no fetch). Fix: handle both calling conventions in the same callback.

2. **A.1 completion** — the remaining 12 Wave-1 filters shipped (the 5 pivots landed in v0.13.0 — see `safe_name`, `slug`, `kebab`, `wikilink`, `date`). The filter library is now complete at 17/17 Wave-1 filters. Wave 2 (33 more filters) stays Phase H backlog.

### Added

- **`src/helpers/filters/decode_uri.mjs`** — `decodeURIComponent` with safe fallback on malformed input. Direct port from Clipper.
- **`src/helpers/filters/length.mjs`** — count chars (string) / items (JSON array) / keys (JSON object). Returns string per Clipper convention. Direct port.
- **`src/helpers/filters/strip_tags.mjs`** — strip HTML tags with optional allow-list. Decodes common entities. Direct port.
- **`src/helpers/filters/strip_md.mjs`** — strip markdown formatting (links, bold, italic, headers, code, lists, blockquotes, tables, wikilinks, etc.). Direct port.
- **`src/helpers/filters/blockquote.mjs`** — prefix each line with `> ` (nested arrays → nested depth). Direct port.
- **`src/helpers/filters/callout.mjs`** — wrap content in Obsidian callout `> [!type] title\n> body` with fold marker. Direct port.
- **`src/helpers/filters/footnote.mjs`** — JSON array → `[^N]: item`, JSON object → `[^kebab-key]: value`. Direct port.
- **`src/helpers/filters/image.mjs`** — URL (or JSON of URLs) → markdown `![alt](url)` syntax. Adapted port (inline `escapeMd` for the 4 syntactic chars, no upstream `escapeMarkdown` dep).
- **`src/helpers/filters/table.mjs`** — JSON object / array of objects / array of arrays / flat array → markdown table. Custom headers via param. Direct port.
- **`src/helpers/filters/date_modify.mjs`** — add/subtract a duration from a date. Adapted port — native `Date` arithmetic instead of `dayjs` dep. Calendar-validated (same strategy as `date.mjs` Fix J).
- **`src/helpers/filters/duration.mjs`** — format ISO 8601 duration or bare seconds as `HH:mm:ss`. Adapted port — native arithmetic, no `dayjs/plugin/duration`.
- **`src/helpers/filters/markdown.mjs`** — **simplified** HTML→markdown converter. Clipper's version delegates to `defuddle/full` which the router doesn't bundle (defuddle is invoked separately via WebFetch in the `defuddle` skill). The ported filter covers the common cases (headings, paragraphs, lists, links, images, bold/italic, code, blockquote, entity decode) — sufficient for use cases that don't need full-fidelity conversion. For high-fidelity webpage→markdown, the wiki-ingest skill calls defuddle directly. Documented in the filter's JSDoc.
- **`src/helpers/filters/index.mjs`** updated: 17/17 filters exported by name + included in `FILTERS` map for programmatic lookup.
- **`tests/filters-wave1-rest.test.mjs`** (~50 cases, 3-5 per filter) — happy paths + edge cases + Clipper-parity behavior for each of the 12 new filters.
- **`package.json`** test script extended with the new test file.

### Changed

- **`src/helpers/safe-fetch-html.mjs`** — `lookup` callback now returns an array `[{address, family}]` when `opts.all === true` (Node 20+ `autoSelectFamily` branch) AND scalar `(null, address, family)` when `opts.all` is falsy (legacy / explicitly-disabled branch). Both conventions covered, so the helper works across all undici versions and Node runtimes.

### Backward compatibility

- All 12 new filters are additive — no existing API touched.
- The `safe-fetch-html` lookup fix is a pure bugfix (no API change) — URL-input fetches that were broken now work.

### Test count: **762/762 passing** (was 710 at v0.13.4; +52 new tests: ~50 filter cases).

## [0.13.4] — 2026-05-24 — Phase C hardening (mini-review+ findings on caa9463)

Hardening pass triggered by `mini-/review+` on the freshly-landed v0.13.3 commit (`caa9463`). Both reviewers (Claude Code Reviewer subagent + codex) flagged 1 P1 SSRF gap + 4 P2 + 4 P3 — same pattern as the v0.13.0 → v0.13.1 cycle (post-commit codex sees integration-level bugs that piecewise pre-commit review misses). All P1 + P2 fixed before Phase D LaTeX starts (which shifts to v0.13.5 again).

**Phase D LaTeX version shift** (cumulative): originally v0.13.3 in initial roadmap → v0.13.4 after Phase C insertion → **v0.13.5** after this hardening. Roadmap follow-up still tracked in vault.

### Changed

#### Security

- **SSRF TOCTOU closed for both extract_page_metadata and propose_linked_sources MCP tools** (codex P1). Pre-v0.13.4 the 2-stage guard (`validateUrl` sync + `assertHostnameNotPrivate` async DNS) had a TOCTOU window between the DNS check and undici's getaddrinfo at connect time. A DNS-rebinding host or one with mixed public/private answers could pass the check and then have undici resolve/connect to a private IP. Now closed via a **pinned-IP undici Dispatcher** (the same pattern `src/markdownify/markitdown.mjs safeFetch` has carried since v0.11.1): `Agent({connect: {lookup: (_h, _o, cb) => cb(null, address, family)}})` ensures the connector cannot re-resolve. Per-hop re-pin in the redirect loop, so chained redirects through hostile DNS still get refused at the final hop.

#### MCP wire-format

- **Handler wrapResult double-wrap fixed for both tools** (codex P2 — CRITICAL). Pre-v0.13.4 both `handleExtractPageMetadata` and `handleProposeLinkedSources` returned a pre-wrapped `{content: [{type:'text', text: JSON.stringify(...)}]}` shape. But the router's `wrapResult` in src/index.mjs re-wraps every handler's return value, so MCP clients saw the actual response text as `{"content":[{"type":"text","text":"<original payload>"}]}` — a nested envelope instead of the documented payload. Tests didn't catch it because they called the handlers directly (bypassing the dispatcher). Fix: handlers return the **raw payload object** now. Tests updated + 2 regression tests added (one per tool) that assert `!('content' in result)`.

#### link-extractor.mjs heuristic bugs

- **Dedup keeps highest-scoring duplicate** (convergent finding: Reviewer A P2 + codex P2). Pre-v0.13.4: same canonical href appearing in body AND in a Related section was dropped first-wins, losing the +3 bonus. Now a `Map<canonical, candidate>` keeps the candidate with the higher score per canonical href.
- **href HTML entities decoded BEFORE URL normalization** (codex P2). Pre-v0.13.4: `<a href="/search?q=a&amp;b=2">` produced canonical URL `https://…/search?q=a&amp;b=2`, so the downstream request would have param `amp;b` instead of `b`. Now `decodeEntities(rawHref)` runs first.
- **Quoted `>` in attribute before href no longer truncates the tag-open slice** (codex P2). Pre-v0.13.4: `<a title="2 > 1" href="/x">` was sliced at the inner `>`, missing the `href` entirely. Fix: use a quote-aware `A_OPEN_RE` sub-match instead of `indexOf('>')`.
- **Social blocklist recognizes `www.*` / `m.*` / `mobile.*` prefixes** (Reviewer A P3). Pre-v0.13.4: `https://www.twitter.com/x` scored 0 instead of -5. Now hostnames are normalized (`.replace(/^(www|m|mobile)\./, '')`) before set lookup.
- **`headingMatchesRelated` is Unicode-NFC-normalized** (Reviewer A P3). A heading like `"À lire aussi"` arriving in NFD form (combining-grave detached) now matches the NFC keyword `"à lire aussi"` in the lookup table.

#### Refactor

- **`src/helpers/safe-fetch-html.mjs`** — extracted shared SSRF-safe fetch helper (DRY-cleanup that had been tracked as TODO since v0.13.2). Both `extract_page_metadata` and `propose_linked_sources` now use it. Returns `{html, finalUrl}` so callers know the post-redirect canonical URL (needed for same-domain scoring in link-extractor).
- **`src/helpers/pkg-version.mjs`** — extracted shared package-version read + `USER_AGENT` string (Reviewer A P3). Eliminates the drift between the per-tool hardcoded UA strings (`0.13.0-dev`, `0.13.1`, `0.13.3` were all in play across releases). `src/index.mjs` now imports `PKG_VERSION` from this helper instead of doing its own JSON.parse inline.

#### Skill / sub-agent depth-1 enforcement

- **`agents/wiki-ingest.md`** — added explicit anti-pattern: "Don't trigger link-following step 4.5 of the wiki-ingest skill. Depth limit is 1 in Phase C: parent triggers step 4.5, children (you) don't recurse." (Reviewer A P3 — pre-v0.13.4 the depth-1 promise was only enforced by the orchestrator skill instruction; sub-agents could technically re-trigger step 4.5. Now explicit in the sub-agent prompt.)

### Added

- **`tests/extract-page-metadata.test.mjs`** (+1 regression case): handler returns raw payload, not pre-wrapped envelope.
- **`tests/propose-linked-sources.test.mjs`** (+1 regression case): same as above for propose tool.
- **`tests/link-extractor.test.mjs`** (+5 regression cases): dedup-max-wins, href entity decode, quoted-`>` in tag-open, www.*/m./mobile.* social blocklist normalization, Unicode-NFC heading match.

### Backward compatibility

- **MCP wire-format change** is technically a "fix to a bug" but it IS a behavioral change for clients that were JSON-parsing the (broken) double-wrapped response. Any client that relied on parsing `JSON.parse(content[0].text)` to get `{"content":[...]}` and digging into the nested text was already broken. Documented in the breaking-change section of the wiki-ingest skill upgrade notes.
- **Sub-agent skip of step 4.5** is additive — sub-agents that ignored step 4.5 (any pre-v0.13.4 sub-agent) continue to work; the explicit instruction just hardens the soft enforcement that was already implicit.

### Test count: **710/710 passing** (was 703 at v0.13.3; +7 hardening regression tests).

## [0.13.3] — 2026-05-24 — obsidian-clipper Phase C (link-following ingestion, Level 1 "Ask mode")

Phase C of the obsidian-clipper feature-borrowing roadmap. Extends URL ingestion to **propose related hyperlinks** from the page body for recursive ingestion, ranked by heuristic score (same-domain +2, "Related"/"See also" section +3, social/boilerplate hostname -5). The user picks which candidates to also ingest — Level 1 "Ask mode" only, no auto-follow. Fan-out via the existing `wiki-ingest` sub-agent. Frontmatter `related_source: [[parent-slug]]` traces the parent-child tree.

**Inserted before LaTeX preservation** per Roland's request 2026-05-24 — link-following adds value to ALL URL ingestions, LaTeX is niche to math pages. Original Phase C (LaTeX) becomes Phase D, and downstream phases shift by one letter.

**Why Level 1 only**: 3 ambition levels were scoped (Ask mode, Auto-follow with cap, Smart LLM selection). Level 1 is the safe foundation — user always validates the candidate list before any extra fetch happens. Levels 2 and 3 are deferred to dedicated phases if usage patterns justify (e.g. "I always pick same-domain links" → graduate to Level 2 auto-follow with same-domain cap).

### Added

- **`src/helpers/link-extractor.mjs`** — `extractLinks(html, baseUrl, opts)` parses `<a href>` from HTML with heuristic scoring. Strips semantic boilerplate (`<nav>`, `<footer>`, `<aside>`, `<header>`) before scan. Quote-aware tag matcher + backreference attribute extractor (cf. Phase A finding E lessons). Hard-skips fragment-only, `mailto:`, `tel:`, `javascript:`, `data:`, `file:`, `ftp:`. Dedup by canonical href (lowercased hostname, no fragment, trailing-slash stripped). HTML entities decoded + agentic-injection markers neutralized on display text (cf. Phase A findings B#C + A#15). Output sorted by score descending, capped at `maxCandidates` (default 30).
- **`src/tools/propose-linked-sources.mjs`** — MCP tool wrapper around the extractor. Accepts `{url}` (fetched via undici with SSRF guards + redirect re-SSRF per hop, max 5 hops) or `{html, baseUrl}` (raw input, no I/O). Returns `{baseUrl, count, candidates}` JSON-stringified in the standard MCP content block.
- **`extract_page_metadata` + `propose_linked_sources`** both registered in `src/index.mjs` TOOL_REGISTRY (TOOLS + TOOL_HANDLERS dispatch). Boot-time cross-check validates the wiring. Both excluded from `WRITE_TOOL_NAMES` (no vault mutation).
- **`skills/wiki-ingest/SKILL.md`** new step 4.5 "Propose linked sources" (between file source step 4 and entity extraction step 5). Full procedure documented: call `propose_linked_sources`, present top 10-15 to user, accept input formats ("1, 3, 5" / "tous" / "aucun"), fan-out via existing `wiki-ingest` sub-agent (1 per retained URL, parallel), set child frontmatter `related_source: [[parent]]`, append parent page's `## Linked sources` section, consolidated log entry. Hard depth limit of 1 (sub-agents MUST NOT trigger step 4.5 themselves).
- **`skills/wiki-ingest/SKILL.md`** frontmatter spec updated with the `related_source: "[[parent-slug]]"` field (optional, only set on children of a link-following parent).
- **`tests/link-extractor.test.mjs`** (42 cases) — Karpathy fixture (Related section + cross-domain), Wikipedia fixture (See also section + External links un-bonus), degraded (no links), TRICKY fixture (nav strip + scheme skips + dedup canonical + single-quoted href + apostrophe-in-text + injection neutralizer post-decode), robustness (empty/null html, invalid baseUrl, maxCandidates cap, image-only anchor skip), scoring (social blocklist, same-domain bonus, cross-domain plain), `_internals` smoke tests for splitByHeadings + resolveAndNormalize + headingMatchesRelated + matchesSocialBlocklist.
- **`tests/propose-linked-sources.test.mjs`** (14 cases) — TOOL_DEFINITION shape, input XOR validation (url + html mutually exclusive, html requires baseUrl), hermetic html branch (full scoring, maxCandidates cap, empty page), URL SSRF refusal (non-http(s), loopback, malformed), wiring boot-time check (TOOLS + TOOL_HANDLERS contain `propose_linked_sources`, not in WRITE_TOOL_NAMES).
- **`package.json`** test script extended with both new test files.

### Anti-patterns documented in skill

- Do NOT auto-follow links without user confirmation (Level 2 deferred).
- Do NOT chain `propose_linked_sources` recursively in sub-agents (depth limit = 1 in Phase C).
- Do NOT skip the `related_source` frontmatter on children (mechanism that traces the tree).
- Do NOT ingest candidates with `score < 0` without explicit user opt-in (blocklist).

### Synergy with the 🔮 router-aware browser extension idea

Phase C lays the conceptual foundations of recursive ingestion that a future browser extension would exploit natively (the extension has DOM access — link extraction is trivial, and the parent-child relation model in frontmatter is what the extension would write). See [[obsidian-clipper#-idée-à-étudier--extension-navigateur-router-aware]] in the vault brainstorming.

### Backward compatibility

- Step 4.5 is additive — existing wiki-ingest invocations (without explicit link-following) skip it silently (no candidates → no UI, no user prompt).
- Frontmatter `related_source` is OPTIONAL — root sources (not children of a link-following parent) omit the field entirely.
- The new MCP tools (`propose_linked_sources`, `extract_page_metadata` from v0.13.2) are read-only and excluded from `WRITE_TOOL_NAMES`, so `OBSIDIAN_ROUTER_READONLY` deployments stay useful.

### Deferred to future phases

- **Level 2 (auto-follow with cap)** — flag opt-in `--follow-links depth=1 max-pages=5 same-domain=true`. Activatable if usage patterns show systematic user choices.
- **Level 3 (smart LLM selection)** — per-link LLM judgment via `extract_page_metadata` light pre-scoring. Probably a v0.14.x candidate.
- **Recursive depth > 1** — Phase C is depth-1 only. Higher depth needs more design (cycle detection, budget enforcement, UX).

### Test count: **703/703 passing** (was 647 at v0.13.2; +56 new tests: 42 link-extractor + 14 propose-linked-sources).

## [0.13.2] — 2026-05-24 — obsidian-clipper Phase B (pipeline upgrade)

Phase B of the obsidian-clipper feature-borrowing roadmap. Wires the v0.13.0 helpers into the actual ingestion pipeline: registers `extract_page_metadata` as a real MCP tool, updates the `defuddle` skill to call it alongside the markdown cleanup, and updates the `wiki-ingest` skill to assemble source-page frontmatter DETERMINISTICALLY from the extracted metadata before Claude touches the body. End of the "fabricated dates / missed author" pain documented in the wiki-ingest skill anti-patterns.

### Added

- **`extract_page_metadata` MCP tool registered** in `src/index.mjs` TOOL_REGISTRY (TOOLS array + TOOL_HANDLERS dispatch). Input schema accepts `url` (fetched via undici with SSRF guards + redirect handling, max 5 hops) OR `html` (raw, no I/O). Output is a JSON-stringified `{title, author, published, image, site, lang, description, wordCount, readingMinutes}` block. Excluded from `WRITE_TOOL_NAMES` since it doesn't touch any vault — `OBSIDIAN_ROUTER_READONLY` keeps it exposed. The boot-time TOOLS/TOOL_HANDLERS cross-check validates the wiring automatically.
- **`tests/extract-page-metadata.test.mjs`** (13 cases): TOOL_DEFINITION shape, handler input validation (mutually-exclusive `url`/`html`, neither required, both forbidden), hermetic `html` input branch (full metadata, no-metadata fallback, body override), URL SSRF refusal (non-http(s) scheme, private IP literal, malformed), boot-time wiring cross-check (TOOLS/TOOL_HANDLERS contain the new entry).
- **`package.json`** test script extended with `tests/extract-page-metadata.test.mjs`.

### Changed

- **`skills/defuddle/SKILL.md`**: new step 2.5 "Extract deterministic metadata" — after defuddle returns clean markdown, the skill ALSO calls `extract_page_metadata` on the same URL. Output of the skill is now `{markdown, metadata}` instead of just `markdown`. Added explicit rationale ("why two calls instead of one combined tool: clean separation of concerns") and anti-pattern ("do NOT infer title/author/published when the meta extractor returned non-null").
- **`skills/wiki-ingest/SKILL.md`** step 1 (acquire): URL inputs now route through `defuddle` (v0.13.2+) which returns the metadata block, or directly call `extract_page_metadata` if the URL is already clean. Local files / pasted text still fall back to Claude inference (no metadata signal available).
- **`skills/wiki-ingest/SKILL.md`** step 4 (file source): frontmatter for URL sources is now assembled DETERMINISTICALLY from the metadata block. New mandatory fields when present: `published`, `lang`, `image`, `site`, `description`, `word_count`, `reading_minutes`. The slug filename uses `slug(title, {maxLen:80})` from the v0.13.0 filter library. Anti-pattern updated: do NOT re-infer fields the metadata block populated.

### Backward compatibility

- The `webpageToMarkdown` MCP tool (`src/tools/convert.mjs`) is **unchanged** — still returns a markdown string for backward compat. Pipeline composition lives in the skills, not in the tool layer. This was a deliberate scope decision vs. the roadmap's initial `{markdown, metadata}` shape proposal: simpler, no breaking change, no `flat: true` legacy flag needed.
- Local file / pasted text inputs to `wiki-ingest` continue to use the pre-v0.13.2 inference path (no metadata block available — no signal to be deterministic about).
- The `extract_page_metadata` tool returns a hermetic JSON-stringified payload; downstream consumers that JSON.parse the `content[0].text` get the structured object.

### Test count: **647/647 passing** (was 634 at v0.13.1; +13 integration tests for the new tool + wiring).

## [0.13.1] — 2026-05-24 — Phase A hardening (post-commit `/review+` findings)

Post-commit hardening pass triggered by `/review+` on the freshly-landed v0.13.0 commit. The 5-pass pre-commit cycle had cleared all P1/P2 it found, but a fresh post-commit review surfaced 5 new findings + 3 NITs that the pre-commit passes had missed (the post-commit codex saw the commit as a unit, not piecewise). All fixed before Phase B starts (which will be v0.13.2 — original roadmap shifted by one patch level).

### Changed

- **`src/tools/extractPageMetadata.mjs` → `src/tools/extract-page-metadata.mjs`** (N2): renamed to align with the kebab-case convention of every other file in `src/tools/`. Tool definition exported name (`extract_page_metadata`) unchanged. Done via `git mv` so history is preserved.
- **`src/tools/extract-page-metadata.mjs:32`** (N1): User-Agent string `0.13.0-dev` → `0.13.1` (now matches the shipped package version). The pre-v0.13.1 dev-suffix was a development leftover.
- **`src/tools/extract-page-metadata.mjs:23-29` JSDoc** (N3): "registration ships with Phase A.4" corrected to "Phase B (v0.13.2, defuddle skill upgrade)". The original JSDoc referenced an intermediate plan that changed; this one matches the actual roadmap now.
- **`src/helpers/meta-extractor.mjs` normalizeDate** (codex O, P2): added ISO-date-prefix calendar validation. Pre-v0.13.1 V8 silently rolled invalid days forward — `article:published_time="2026-02-31"` produced fabricated `2026-03-03` in frontmatter. Now the round-trip check rejects calendar-invalid prefixes; raw input flows through `cleanScalar` (which neutralizes any embedded injection markup).
- **`src/helpers/filters/date.mjs`** (codex P, P2): extended pass-5 calendar-validation from `YYYY-MM-DD` date-only to ALSO cover ISO datetimes with a `T` separator (`YYYY-MM-DDTHH:mm:ss…`). `date('2026-02-31T00:00:00Z')` now returns the input unchanged instead of V8-rolled `'2026-03-03'`.
- **`src/helpers/meta-extractor.mjs:155-165` JSON-LD type regex** (codex Q, P2): relaxed from `type="application/ld+json"` strict to `type\s*=\s*["']application/ld+json[^"']*["']` so the extractor handles spec-legal variations: whitespace around `=` and charset/profile parameters (`type="application/ld+json; charset=utf-8"`). Pages using either valid variation no longer silently bypass JSON-LD extraction.
- **`src/helpers/meta-extractor.mjs` parseMetaTagAttrs** (codex S, P3): attribute-name boundary changed from `\b` to `(?:^|\s)`. The `\b` boundary was satisfied between `-` and `c` in `data-content`, so a tag like `<meta property="og:title" content="Real" data-content="Draft">` had `data-content` shadowing `content` and surfaced `"Draft"` as the title. The leading whitespace/start-of-tag boundary fixes the false-match.

### Added

- **`NOTICE`** (codex R, P2 — license compliance): added MIT attribution section for the obsidian-clipper port (5 filter files + meta-extractor pattern). Mirrors the existing markdownify-mcp / Karpathy LLM-wiki credit sections — same format, full MIT license text, file-by-file mapping with explicit note that `slug.mjs` is homegrown and the SSRF/injection hardenings in meta-extractor are original to this project. Without this section, redistributing the package would have been MIT-noncompliant.
- **`tests/filters-date.test.mjs`** (+2 cases): ISO datetime with invalid day rejected; valid ISO datetime passes through.
- **`tests/meta-extractor.test.mjs`** (+7 cases): normalizeDate calendar-invalid (date-only + ISO datetime), valid ISO normalization, JSON-LD type with charset parameter, JSON-LD type with whitespace around `=`, data-content does not shadow content, data-property does not shadow property.

### Backward compatibility

- File rename `extractPageMetadata.mjs → extract-page-metadata.mjs` is **internal only** — the file is not yet registered in `TOOL_REGISTRY`, no consumers exist outside tests, no external import path changes.
- All previously-correct inputs still produce identical outputs. The behavioral changes ONLY affect inputs that were previously incorrectly accepted (calendar-invalid dates, JSON-LD type variants, data-* attributes).

### Test count: **634/634 passing** (was 625 at v0.13.0; +9 hardening regression tests).

## [0.13.0] — 2026-05-24 — obsidian-clipper Phase A (foundation)

Phase A of the obsidian-clipper feature-borrowing roadmap (see [[obsidian-clipper-roadmap]] in the associated vault). Adds the deterministic helpers that will be consumed by Phase B (`wiki-ingest` skill upgrade) to fix the "fabricated dates / missed author" pain documented in the [[wiki-ingest]] skill anti-patterns. Zero behavioral change in existing skills — these helpers are purely additive.

**Shipped after a 5-pass `/review+` cycle** (Claude Code Reviewer subagent × codex × 5 rounds). Pass log:
- Pass 1: 1 BLOCKER (SSRF), 4 IMPORTANT prouvés (sanitize bypass, TZ-bug, reserved-name leak, HTML entities), 4 IMPORTANT secondaires, 7 NITs.
- Pass 2: codex pass 2 found 3 nouveaux P2 (tier-scoring, quote-delimiter, redirect handling) + 1 P3 (slug truncate trim).
- Pass 3: 4 codex fixes + 1 regression repair (META_TAG_RE quote-aware).
- Pass 4: codex pass 4 found 2 P1 (published bypass sanitize, cleanScalar non-string bypass) + 2 P2 (date calendar-invalid roll-forward, tests not wired in `npm test`).
- Pass 5: 4 codex pass-4 fixes + codex pass 5 found 2 P2 (blank fallback short-circuit, array-wrapped @graph not flattened) — both fixed.
- All P1 + P2 findings resolved. Some NITs deferred to Phase A.4 hardening (see roadmap "Follow-ups").

### Added

#### Filter library (5 of 17 planned Wave 1 filters)

- **`src/helpers/filters/safe_name.mjs`** — port from `obsidian-clipper/src/utils/filters/safe_name.ts` (MIT). Sanitizes a string for cross-OS filename safety. Modes: `windows` / `mac` / `linux` / default (conservative union). Reserved-name re-check post-truncate to catch `'CON '` → `'_CON'` (pre-pass-1 bug surfaced by codex).
- **`src/helpers/filters/kebab.mjs`** — direct port. `fooBar baz_qux` → `foo-bar-baz-qux`.
- **`src/helpers/filters/wikilink.mjs`** — simplified port (Clipper's JSON-input branch dropped — no consumer in the router). `wikilink('foo', 'Bar')` → `[[foo|Bar]]`.
- **`src/helpers/filters/date.mjs`** — port WITHOUT `dayjs` dep, native `Date` only. Compatible format-token subset (YYYY, MM, DD, HH, mm, ss + 1-2 digit variants). Local-calendar construction for date-only `YYYY-MM-DD` inputs to avoid the UTC-midnight TZ shift (pre-pass-1 bug: `date("2026-05-24")` returned `'2026-05-23'` under `TZ=America/New_York`). Calendar-validation against real days-per-month + leap-year rule rejects `'2026-13-01'` and `'2026-02-31'` rather than silently rolling over (pre-pass-5 bug).
- **`src/helpers/filters/slug.mjs`** — NOT a port (Clipper has no slug filter — relies on `safe_name | kebab` chained in templates). Pipeline: NFKD ASCII-fold + Obsidian-markup strip + non-alphanum→`-` + collapse + lowercase + maxLen (default 80). Re-trim `-` post-truncate to honor the no-trailing-hyphen contract (pre-pass-3 bug).
- **`src/helpers/filters/index.mjs`** — re-exports + map `FILTERS` for programmatic lookup.

#### Deterministic metadata extractor

- **`src/helpers/meta-extractor.mjs`** — `extractMetadata(html, body?)` parses Schema.org JSON-LD + OpenGraph + meta tags + `<title>` in priority order (strict article types before generic page-shell). Computes `wordCount` + `readingMinutes` from body or stripped-HTML. Returns `{title, author, published, image, site, lang, description, wordCount, readingMinutes}`. Pure regex parsing (no DOMParser dep, no jsdom/cheerio/linkedom). Hardened over 5 review passes:
  - SSRF-safe via callers — extractor itself is pure (no I/O)
  - HTML entities decoded before sanitize (named: `amp/lt/gt/quot/apos/nbsp` + numeric `&#NNN;` + hex `&#xHH;`)
  - Prompt-injection markers neutralized in scalar fields (subset of `src/helpers/sanitize.mjs` agentic-marker blocklist, inlined dep-free)
  - Non-string JSON-LD values (arrays, objects) stringified BEFORE the sanitize pipeline (not after)
  - `published` field wrapped in `cleanScalar` so malicious `article:published_time` doesn't bypass sanitize
  - `META_TAG_RE` quote-aware: handles `>` inside `content="..."` (e.g. `content="<tool_use>"`)
  - `parseMetaTagAttrs` uses backreference quote-delimiter so apostrophes inside double-quoted values are preserved (`<meta content="Bob's post">` → `"Bob's post"`)
  - `pickArticleNode` tier-scoring: strict ARTICLE_TYPES (Article, NewsArticle, BlogPosting, …) preferred over generic fallbacks (WebPage, CreativeWork)
  - `extractJsonLd` flattens `@graph` wrappers both at top-level AND inside top-level array elements
  - `pickNonBlank` helper for fallback chains so a defined-but-blank higher-priority signal doesn't short-circuit lower-priority tiers

#### MCP tool wrapper

- **`src/tools/extractPageMetadata.mjs`** — wraps `extractMetadata` as MCP tool. Accepts `{url}` (fetched via `undici`) or `{html}` (raw input). **NOT YET registered** in `src/index.mjs` TOOL_REGISTRY — registration is part of Phase B (skill integration). Hardened:
  - SSRF defense via `validateUrl()` + `assertHostnameNotPrivate()` from `src/markdownify/utils.mjs` (re-used existing helpers; no new code surface)
  - Manual redirect loop with re-SSRF at each hop (max 5 hops, matches `curl`/`fetch` defaults). Per-hop re-validation handles `evil.com → http://attacker.com → http://127.0.0.1/...` chains
  - Timeout 10s via AbortController, body size cap 5 MiB
  - Documented residual DNS-rebinding TOCTOU as Phase A.4 hardening (mitigation = custom undici dispatcher pinning the connect target; cf. `safeFetch` pattern in markdownify)

#### Tests

- **`tests/filters-safe-name.test.mjs`** (24 cases incl. 5 pass-1 regressions + 1 pass-5 regression for Windows reserved-name leak)
- **`tests/filters-kebab.test.mjs`** (7 cases)
- **`tests/filters-wikilink.test.mjs`** (9 cases)
- **`tests/filters-date.test.mjs`** (17 cases incl. 1 pass-1 TZ-independence regression + 6 pass-5 calendar-validation regressions)
- **`tests/filters-slug.test.mjs`** (13 cases incl. 1 pass-3 truncate-on-sep regression)
- **`tests/meta-extractor.test.mjs`** (51 cases incl. 5 pass-1 regressions for entity decode + injection neutralize + pickArticleNode strict, 6 pass-3 regressions for tier-scoring + quote-aware + apostrophe + angle-bracket, 3 pass-4 regressions for published bypass + non-string bypass + object stringify, 5 pass-5 regressions for blank fallback + array-wrapped @graph)

### Changed

- **`package.json`**: version `0.12.10` → `0.13.0` (minor bump — additive features, zero break). `test` script extended with the 6 new test files (regression: codex pass 4 flagged that pre-pass-5 the new tests weren't exercised by CI).

### Backward compatibility

- All new files are additive — no existing skill / tool / helper modified.
- `wiki-ingest` and `defuddle` skills are untouched — they'll consume these helpers in Phase B (v0.13.1) per the roadmap.
- `extractPageMetadata` is created but NOT registered in TOOL_REGISTRY — no new MCP tool exposed to clients yet.

### Follow-ups for Phase A.4 hardening (tracked in vault [[obsidian-clipper-roadmap]])

- A#3 slug NFKD codepoints — currently literal in the source, fragile to NFC normalization on save. Fix needs an editor that supports `̀-ͯ` escape rewriting.
- A#4 catastrophic backtracking defense-in-depth — cap `extractTitleTag` regex body.
- A#6 undici `bodyTimeout` / `headersTimeout` natifs in addition to `AbortController.signal`.
- NIT pass-4 `extractHtmlLang` / `extractTitleTag` chain to `cleanScalar` for defense-in-depth.
- NIT pass-5 `cleanScalar` `String(v)` try/catch for exotic objects with throwing toString (negligible risk in JSON.parse pipeline, but harden if helper externalizes).

### Test count: **625/625 passing** (was 528 at v0.12.10; +97 new tests across 6 new test files).

## [0.12.10] — 2026-05-24

`/review+` hardening pass on v0.12.8's session-log auto-append. Two reviewers: Code Reviewer subagent (5 IMPORTANT + 3 NIT) + `codex review --commit 91a0070` (4 additional findings — 3 IMPORTANT + 1 NIT). All 9 actionable findings addressed with 21 regression tests. Test suite: **506/506 passing** (was 485 after v0.12.9; +21 tests: 6 hook sanitize/multiline/tz + 1 migration B1 + 14 backfill).

### Fixed

- **Markdown injection in log.md entries** (`hooks/session-auto-journal.mjs:545-560` + `scripts/backfill-log-from-sessions.mjs:155-170` — Reviewer A A1): v0.12.8 only escaped `|`; a user prompt containing `[[evil]]`, `<!-- hidden`, or starting with `- ` could spawn parasitic wikilinks, hide subsequent log lines under an HTML comment, or break the entry's bullet structure. New `sanitizeForLogEntry()` helper in the hook (and a mirrored inline function in the backfill script) inserts U+200B zero-width space inside `[[` / `]]` / `<!--` / `-->` tokens (invisible in Obsidian rendered + source view) and backslash-escapes a leading markdown structural char. Pipe escape from v0.12.8 preserved.

- **Spam in log.md on re-running `--migrate-sessions-to-wiki-meta` with conflicts** (`scripts/setup-vault.mjs:606` — Reviewer A B1): if a vault had `both-overlap` state with conflict files left in source, every re-run produced a new `migrate` line in log.md (`0 sessions moved, M skipped`). Now the log append is gated by `result.sessionsMoved.length > 0` — empty-action runs stay silent.

- **EXDEV fallback opacity** (`scripts/setup-vault.mjs:534-557` — Reviewer A E2): the cross-device fallback (copy-then-unlink per file) had no rollback if a mid-loop failure left the source partially drained. Error message now lists the files already moved and explicitly invites a re-run to resume (`--migrate-sessions-to-wiki-meta` is idempotent — the second pass hits `both-overlap` cleanly).

- **`git mv` argument fragility with paths containing spaces** (`scripts/setup-vault.mjs:578-583` — Reviewer A E1): the per-file branch of `migrateSessionsToWikiMeta` used `path.join('wiki', 'Sessions', f)` which produces backslash paths on Windows. Git accepts both but forward-slash is unambiguous and matches git's internal textual rename semantics — switched to template literals `wiki/Sessions/${f}` for portability.

- **Multiline Bash hints stretched log entries beyond 2 lines** (`hooks/session-auto-journal.mjs:537-545` — codex P2-1): if the first Bash tool call of a session was a heredoc or multi-line script, its embedded `\n` chars leaked into the `first bash: ...` portion of the result, breaking the parseable 2-line entry contract. Collapse all whitespace runs to single spaces with `.replace(/\s+/g, ' ').trim()` before applying the 60-char truncate.

- **Timezone mix between log date and time near local midnight** (`hooks/session-auto-journal.mjs:566-573` + `scripts/backfill-log-from-sessions.mjs:158-166` — codex P2-2): date came from `endedAt.slice(0, 10)` (UTC) while time came from `t.getHours()` (local). In Europe/Paris at 00:30 local, this produced `2026-05-24 00:30` for a session that actually ran on the 25th, breaking sort order and disagreeing with the journal filename. Now both date and time derive from the same local-tz `Date` instance (matches the filename convention from v0.12.4).

- **`OBSIDIAN_ROUTER_CONFIG` env var ignored by backfill script** (`scripts/backfill-log-from-sessions.mjs:37-49` — codex P2-3): the hardcoded `CONFIG_PATH` bypassed the env override that `setup-vault.mjs` and the hooks honor. Multi-profile or CI users hit the wrong config silently. Now resolved via `resolveConfigPath()` mirroring the setup-vault pattern.

- **`fm.prompt` documented as a backfill fallback but never used** (`scripts/backfill-log-from-sessions.mjs:128-135` — codex P3): the script's header listed `prompt:` as the fallback after `firstUserPrompt:` but the code skipped it, falling through to the chrono scan and then the historical-fallback message. Migrated/manual session notes with only `prompt:` lost their objective. Added the fallback in the right order.

### Added (regression tests)

- **`tests/backfill-log-from-sessions.test.mjs`** (NEW, 15 tests) — covers the entire script that had zero test coverage at v0.12.8: nominal backfill (with wikilink + objective + result), idempotence, `--dry-run` no-write guarantee, open-session skip, recap-absent fallback, no-firstUserPrompt fallback, chrono extraction rescue, 3 markdown-injection sanitize cases (`[[evil]]`, leading `- `, `<!--`), missing `--vault` arg error, unknown-slug error, missing log.md silent skip, `fm.prompt` fallback, `OBSIDIAN_ROUTER_CONFIG` env honored. Added to `npm test` runner.

- **`tests/session-auto-journal.test.mjs`** (+6 tests in new `v0.12.9 review+ pass 1 regressions` describe): `[[wikilink]]` injection neutralized, leading `- ` escaped, `<!--` neutralized, multiline bash hint collapsed (codex P2-1), local-tz date/time consistency (codex P2-2), pipe escape regression (preserves v0.12.8 behavior).

- **`tests/migrate-sessions-to-wiki-meta.test.mjs`** (+1 test): B1 regression — re-running on `both-overlap` with conflicts does not duplicate the log.md `migrate` line.

### Deferred to follow-up (NIT, tracked but out of scope)

- **A2** — validate `--vault <path>` against `portRegistry` in `backfill-log-from-sessions.mjs` (currently accepts any absolute existing dir; safe because `appendFileSync` only targets `wiki-meta/log.md`).
- **A3** — document YAML scalar-only limitation of the backfill script's `parseFrontmatter` (acceptable in practice — hook only writes scalars).
- **D4** — extract a shared `parseFrontmatter` helper under `hooks/_helpers/` (3 ad-hoc implementations exist now: hook, backfill, migrate script).

## [0.12.9] — 2026-05-24

Extends `hooks/vault-link-linter.mjs` to detect **click-to-open URLs with the wrong port** — the original v0.11.3 implementation only caught the "bare-path missing scheme" case and skipped any href that already had an `http(s)://` prefix (assumed correct). That assumption let through URLs like `http://127.0.0.1:27143/open/...` when the target vault's actual `insecurePort` was `27142` — silently broken links that look right but hit nothing.

Motivation: 2026-05-24 incident with Roland on the `opsidian-mcp-router et bridge` vault. Claude generated 4 click-to-open links with port `27143` instead of `27142` (memorized port from a different vault, never re-read the target vault's `data.json`). Convention in `~/.claude/CLAUDE.md` already said "never guess the port" — but conventions rely on attention. This release moves the enforcement OUTSIDE the LLM attention loop into the deterministic Stop hook, in the same spirit as `wiki-autocommit` and `vault-link-linter`'s original purpose.

### Changed

- **`hooks/vault-link-linter.mjs`**: adds a 2nd scan pass `CLICK_TO_OPEN_PATTERN` matching `[label](http(s)://127.0.0.1:<port>/open/<encoded-path>)`. For each match, resolves the owning vault from the path, reads the vault's `.obsidian/plugins/obsidian-local-rest-api/data.json`, and compares the URL's port against `insecurePort` (for `http://`) or `port` (for `https://`). On mismatch, emits a `[wrong-port]` violation with the canonical correction. Also flags `http://` URLs targeting vaults that have `enableInsecureServer: false` (the insecure server isn't listening regardless of port match).
- **Stderr message reworked**: now distinguishes the two violation kinds with `[bare-path]` and `[wrong-port]` tags, splits the preamble into a per-kind breakdown (`N vault link(s) missing format` + `M click-to-open URL(s) with the wrong port`), and adds a dedicated explainer line for wrong-port cases showing `used port X, expected Y for <scheme> (vault Z)`. The "Why" paragraph at the bottom now mentions both failure modes and reiterates the per-vault nature of the port (never reuse from another vault/session).
- **`composeSuggestion(label, decodedHref, info)` helper extracted** in the hook — centralizes the URL-building logic (encoding + http-vs-https branching) so both violation kinds emit consistent fixes.

### Added

- **`tests/vault-link-linter.test.mjs`** (+8 new tests in new `wrong-port detection (v0.12.8)` describe block — header references v0.12.8 because the design started there, but the change lands in v0.12.9): correct-http-port passes, wrong-http-port blocks (with `used 27143, expected 27142` in stderr), correct-https-port passes, wrong-https-port blocks (mixing up `port` vs `insecurePort`), http-with-disabled-insecureServer blocks (suggests HTTPS fallback), mixed bare-path + wrong-port (both kinds listed with tags), wrong-port URL with unresolvable path silently skips, stderr names the vault basename.

### Backward compatibility

- The hook stays opt-out via the existing `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` env var (unchanged from v0.11.3).
- All 33 pre-existing tests for the hook still pass — only one was edited (the "multiple bare-path links" test had matched on the old wording `2 vault file` which was replaced by `2 violation(s)` + per-kind breakdown; the test now asserts both `2 violation(s)` and `2 vault link(s) missing` to verify the count survives the reword).
- URLs that were already correct (matching the vault's actual port) are unaffected — they continue to pass silently. Only port-mismatched URLs newly trigger exit 2.

### Test count: **484/484 passing** (was 476 at v0.12.8; +8 wrong-port tests).

## [0.12.8] — 2026-05-24

Adopts the Karpathy "Indexing and logging" pattern to the v0.12.4 `session-auto-journal.mjs` hook: **`wiki-meta/log.md` now receives a 2-line summary per session at SessionEnd**, with a wikilink back to the detailed journal file. Also relocates `Sessions/` from `wiki/` to `wiki-meta/` (cohérent avec la séparation v0.12.0 scaffolds vs user content). Motivation: 2026-05-24 conversation where Roland linked to [Karpathy's wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and asked for "un résumé de ce qui a été fait dans la session avec l'objectif de départ et le résultat" in log.md, with the detail living in the corresponding session file.

### Changed

- **`hooks/session-auto-journal.mjs`**: writes session journals to `<vault>/wiki-meta/Sessions/<date>-<HHMM>-<workspace>-<sessionid>.md` (was `<vault>/wiki/Sessions/...` in v0.12.4–v0.12.7). The folder move makes the auto-generated journal a scaffold (under `wiki-meta/`), not user content — consistent with the v0.12.0 layout. Hook header documents the version history of the path.
- **`templates/wiki-meta/log.md`**: added `session` and `migrate` to the verbs list + 2-line note documenting the 2-line auto-generated entry format and pointing to `/save` for LLM-polish upgrades.
- **`skills/save/SKILL.md`**: 4 doc edits — bumps the `wiki/Sessions/` references to `wiki-meta/Sessions/` and the version `v0.12.4+ → v0.12.8+`. New optional step 8b: when `/save` is invoked during an active journaled session, propose to suffix the save's log.md entry with ` · session [[<session-basename>]]` for cross-navigation between polished doc and raw chronology.

### Added

- **Auto-append to `wiki-meta/log.md` at SessionEnd** (hook): every session now lands a single 2-line entry in the log, format `- YYYY-MM-DD HH:MM — session — [[<basename>]] — <objectif>\n  → <résultat one-line>`. The objective is the first user prompt of the session (captured at the first `UserPromptSubmit`, truncated to 120 chars); the result is heuristic — counters (writes / bash / mcp writes / files) + first bash highlight + duration. Idempotent via basename grep on log.md (prevents dup on re-trigger). Silent skip when log.md is absent (wiki scaffold's responsibility). 0 API call, 0 dep — the heuristic recap from v0.12.4 already collects all the data needed. Quality-curious users can upgrade specific entries via `/save` (LLM-polish path documented in step 9 of save SKILL.md, planned for v0.12.9).
- **`firstUserPrompt` state capture**: hook now tracks the first non-empty user-prompt's first line at `UserPromptSubmit` (truncated to 120 chars, bounded). Used by `buildLogLineSummary()` to produce the "objectif" half of the log.md entry. Persisted in the per-session state JSON so it survives the cross-event boundary.
- **`scripts/setup-vault.mjs --migrate-sessions-to-wiki-meta <vault>`** + **`--migrate-all-sessions-to-wiki-meta`**: opt-in migration tool for vaults whose `Sessions/` still lives under `wiki/`. Detects 4 states (legacy, fresh, both-overlap, empty). Uses `git mv` when `.git/` is present, falls back to `fs.renameSync` then per-file copy+unlink for cross-device cases. Idempotent. Per-file dedup on overlap (refuses to clobber existing files in target, leaves conflicts in source for manual review). Appends a `migrate` line to `wiki-meta/log.md` documenting the move. Reuses the structural pattern of v0.12.1's `--migrate-wiki-meta` for consistency.
- **`scripts/backfill-log-from-sessions.mjs`** (+ `npm run backfill-log` shortcut): opt-in one-shot script that walks a vault's `wiki-meta/Sessions/*.md` (closed sessions only), reconstructs an objective/résultat pair from each session's frontmatter + auto-recap block, and appends missing log.md entries in chronological order (sorted by `started-at`). Idempotent via basename grep. Marks backfilled entries with an HTML comment `<!-- backfilled YYYY-MM-DD -->` for audit trail. Useful for vaults whose Sessions/ predate v0.12.8.
- **`tests/migrate-sessions-to-wiki-meta.test.mjs`** (7 new tests): plain rename, git mv branch, fresh (already-migrated), both-overlap merge with conflict, empty (skipped), non-existent vault, --dry-run.
- **`tests/session-auto-journal.test.mjs`** (+3 new tests in new `v0.12.8 log.md auto-append` describe block): SessionEnd appends a parseable line with verb/wikilink/objective/result, idempotent dedup, silent-skip when log.md absent.

### Backward compatibility

- Vaults with `wiki/Sessions/` (DEDIBOX as of writing) continue to work — new sessions write to the new `wiki-meta/Sessions/` location (auto-created), while the legacy folder stays as-is until the opt-in `--migrate-sessions-to-wiki-meta` is run. No code reads the legacy path anymore.
- Vaults without the hook installed (or with opt-out `OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true`) are unaffected.
- Vaults without `wiki-meta/log.md` (rare — wiki scaffold not yet run) silently skip the log.md append; the journal file itself is still written normally.

### Test count: **476/476 passing** (was 466 at v0.12.7; +10 tests: 3 hook log.md + 7 migration).

## [0.12.7] — 2026-05-24

UX overhaul of the vault-attach flow. Three main changes: (1) renamed `meta-add-vault` to `meta-attach-vault` because the dominant case is attaching a vault to an existing code/dev workspace, not raw vault registration. (2) `setup-vault.mjs` now scaffolds the `wiki/` + `wiki/sessions/` + `wiki-meta/{index,hot,overview,log}.md` structure inline at provisioning time, so a freshly-bootstrapped vault is immediately ready for workspace-bound mode (the `--link-workspace` flow requires `wiki-meta/index.md` to exist — pre-v0.12.7 this was a separate manual `/obsidian-router:wiki` step). (3) `--link-workspace <ws-path>` is now also a flag of the main bootstrap subcommand, so `setup-vault.mjs <vault-path> --link-workspace <cwd>` does the provisioning + binding in one shot (single permission prompt vs. two separate invocations). The new wizard is **didactic by design**: every Bash call is preceded by a 2-3 line explanation in chat, and Bash `description` arguments are full-sentence intentions in the user's language (not cryptic command labels).

Motivation: 2026-05-24 conversation with Roland. He reported cryptic permission prompts during vault setup ("Check template vault layout vs new vault" / "Provision SchoolMouv vault (install plugins, scaffolds, register in router config)") that didn't explain what was about to happen, noted that scaffolds had to be created in a second step, and that he generally builds workspace-first (vault is created FOR a code project, not standalone). The fix codifies workspace-first as the default flow, bundles the scaffolds + workspace-link into provisioning, and adds a conventions picker step so the new vault inherits the globally-active behavior rules without a separate `/obsidian-router:conventions install` round-trip.

### Added

#### `scaffoldWikiMeta()` in `setup-vault.mjs` (creates wiki structure inline)

- New helper function `scaffoldWikiMeta(vaultPath)` (`scripts/setup-vault.mjs:772`): creates `wiki/`, `wiki/sessions/`, and the 4 `wiki-meta/{index,hot,overview,log}.md` scaffolds from `templates/wiki-meta/`, substituting `{{TIMESTAMP}}` and `{{VAULT_PATH}}` placeholders. Idempotent — existing files are preserved.
- Called from `setupVault()` (right before `writeEnvFile`) so every `setup-vault.mjs <vault-path>` invocation produces a vault that's immediately bind-ready for workspace-bound mode.
- `--force` is intentionally NOT honored — scaffolds become user content (the wiki accretes notes, log gets entries, hot.md tracks recent work). `--force` on existing wiki state would wipe user work. Doc-block on the function explains the deliberate divergence from `cloneRootDocs` / `cloneSmartEnv` / `cloneSnippets` behavior.
- Does NOT touch `CLAUDE.md` — that's owned by the `meta-attach-vault` conventions-picker step (and by the `/obsidian-router:wiki` skill for the wiki block).

#### Inline `--link-workspace <ws-path>` flag on the main bootstrap subcommand

- New helper `linkWorkspaceToVault({ workspacePath, vaultPath, vaultSlug, opts })` (`scripts/setup-vault.mjs:700`): performs the validation + `.env` upsert that was previously inlined in the standalone CLI handler. Hoisted to module scope so it can be called from BOTH the standalone `--link-workspace <ws> <slug>` subcommand AND the inline `--link-workspace <ws>` flag of `setup-vault.mjs <vault-path>`.
- Similarly hoisted `upsertEnvVarSync` and `removeEnvVarSync` to module scope (were nested inside the CLI dispatcher) — same logic, just reusable. Sync (mirrors `src/tools/lock.mjs` async equivalent), regex-escapes keys, preserves trailing newline.
- New CLI arg-parsing branch (`scripts/setup-vault.mjs:2092`): when `--link-workspace <ws-path>` appears in the main bootstrap subcommand, parse the value, **skip the consumed positional** (regression guard: `args.find(a => !a.startsWith('--'))` would have stolen `<ws-path>` as the vault arg otherwise), and pass `linkWorkspace: <ws-path>` to `setupVault()`. Slug is derived from the vault path via the same `defaultNameFromPath()` the router uses at runtime, so the `.env` line and the runtime resolution agree.
- Standalone `--link-workspace <ws> <slug>` subcommand (CLI dispatcher) refactored to call the new helper instead of inlining the logic — net: removed ~60 lines of duplication.
- Help text (`--help`) updated with the new flag.

#### `meta-attach-vault` skill (replaces `meta-add-vault`)

- New skill at `skills/meta-attach-vault/SKILL.md` with three flows behind one wizard:
  - **Workspace-first (default, ~95% of cases)** — context detection (`.git/`? `.obsidian/`? `OBSIDIAN_ROUTER_DEFAULT_VAULT` already set?) → if no `.git/`, **plain-words explanation of what git is for** (versioning, secrets protection, sharing) + offered `git init` → vault path proposal (default `C:\VAULTS\<basename-cwd-as-is>`, modifiable, with garde-fou explaining why it lives OUTSIDE the workspace) → **single** `setup-vault.mjs <vault-path> --link-workspace <cwd>` call (provisions + binds in one prompt) → workspace `.gitignore` edit (idempotent, under `# obsidian-mcp-router` marker comment) → **conventions picker via `AskUserQuestion multiSelect`** with 4 recommended (`roadmap-discipline`, `default-vault-health-check`, `wiki-query-first`, `path-disambiguation`) + 4 opt-in (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`) installed via `/obsidian-router:conventions install <id>` (not raw `append_to_file` — preserves the H2-heading idempotency guard) → final reminders with the `openUri` field from `list_vaults` (pre-encoded for spaces/accents, no hand-composed `obsidian://` URI).
  - **Standalone (rare)** — same as workspace-first but skips git/linking/gitignore steps. For vaults that aren't tied to any project (personal journal style).
  - **Remote (existing flow, preserved)** — register a vault that already runs elsewhere (NAS, VPS, Cloudflare Tunnel). No change from the v0.12.6 `meta-add-vault` remote flow.
- **Style rules baked into the skill** — every Bash call gets a 2-3 line pre-flight explanation in chat (what's about to run, why, what files will be touched) + a full-sentence `description` argument in FR/EN matching the user's language (e.g., `"Provisionner le vault SchoolMouv ET lier le workspace mon-projet : installer les plugins Obsidian, allouer un port, générer une clé API, scaffolder wiki/wiki-meta/, écrire .env + .mcp.json, enregistrer dans ~/.claude/obsidian-mcp-router/config.json, et ajouter OBSIDIAN_ROUTER_DEFAULT_VAULT=schoolmouv dans mon-projet/.env"`). Replaces the v0.12.6 anti-pattern of cryptic command-label descriptions surfaced through the permission prompt.

#### `meta-attach-vault` slash command

- New `commands/meta-attach-vault.md` mirrors the skill: documents the three flows, the new triggers (EN + FR), and the wizard's 7 wired-up steps for workspace-first.

#### Regression tests (6, in `tests/scaffold-wiki-meta.test.mjs`)

- `scaffoldWikiMeta — fresh bootstrap creates wiki/, wiki/sessions/, and 4 wiki-meta scaffolds` — end-to-end CLI spawn, asserts directory structure + 4 scaffolds present + placeholders substituted + log.md has the initial scaffold entry.
- `scaffoldWikiMeta — re-bootstrapping preserves existing scaffolds (idempotent)` — user marker injected before re-run survives the second bootstrap.
- `--link-workspace — bootstrap + writes OBSIDIAN_ROUTER_DEFAULT_VAULT to workspace .env` — verifies the slug derivation matches the vault basename and the `.env` line is correctly upserted.
- `--link-workspace — non-existent workspace path → fails fast` — guard against silent failures.
- `--link-workspace — without a value → fails fast with explicit error` — CLI parsing guard.
- `--link-workspace — positional vault arg is not stolen by --link-workspace value` — regression guard for the `args.find()` consumption bug.

### Changed

- **Skill renamed**: `skills/meta-add-vault/SKILL.md` → `skills/meta-attach-vault/SKILL.md` (skill deleted on disk; the new skill carries all the old trigger phrases plus new attach-flavored ones to preserve muscle memory).
- **Command renamed**: `commands/meta-add-vault.md` → `commands/meta-attach-vault.md`.
- **References updated** across the codebase: `README.md` (lines 140 + 826 entry tables), `docs/quick-reference-fr.html` (line 306), `docs/quick-reference-en.html` (line 306), `docs/announcements.md` (line 25 commands list), `commands/meta-setup.md` (cross-reference), `commands/meta-sync-template.md` (companion-commands list), `skills/meta-setup/SKILL.md` (cross-reference), `skills/meta-sync-template/SKILL.md` (don't section + companion-skills list), `skills/auto-mode/SKILL.md` (push-back-if hint), `.claude-plugin/marketplace.json` (descriptions × 2), `.claude-plugin/plugin.json` (description). Historical mentions in `CHANGELOG.md` are preserved as-is.
- **Marketplace + plugin manifests bumped** to `0.12.7` from `0.12.2` (the manifests were lagging behind the package version — synced as part of this release).
- **Test count**: 459/459 passing (453 pre-existing + 6 new in `tests/scaffold-wiki-meta.test.mjs`). `package.json` test script updated to include the new file.

### Migration

Existing scripts and muscle memory:
- The natural-language triggers from `meta-add-vault` (*"add a vault to the router"*, *"ajoute un vault au router"*, etc.) all match the new skill — no relearning required.
- The slash command `/obsidian-router:meta-add-vault` no longer exists. Use `/obsidian-router:meta-attach-vault`.
- Existing vaults bootstrapped via pre-v0.12.7 `setup-vault.mjs` keep working. They just won't have the scaffolds auto-created; run `/obsidian-router:wiki` on them to add the scaffolds (same as before).
- The conventions picker in the wizard is opt-in per convention — users who want to skip can deselect all 8 and configure later via `/obsidian-router:conventions install <id>`.
- The standalone `setup-vault.mjs --link-workspace <ws> <slug>` subcommand still works for re-linking an existing vault to a different workspace (or first-time binding after a pre-v0.12.7 bootstrap).

### `/review+` hardening (3 passes, Code Reviewer subagent + codex)

`/review+` ran 3 passes (Code Reviewer subagent + `codex review` per pass), surfacing 6 findings across passes 1 and 2; all addressed with 7 regression tests added.

- **[IMPORTANT — pass 1 codex P2 #2]** Early validation of `--link-workspace` path in `setupVault()`. Pre-fix, an invalid `--link-workspace` value only failed AFTER plugins were cloned + port allocated + `config.json` updated, leaving an orphan registry entry. Fix validates the workspace path BEFORE any mutation. Regression test snapshot the `portRegistry` and vault dir absence on refusal.
- **[IMPORTANT — pass 1 codex P2 #1 → refined in pass 2]** Legacy `wiki/<scaffold>.md` layout guard before `scaffoldWikiMeta()`. Initial pass-1 fix used `detectVaultMigrationState() === 'legacy' || 'partial'` placed before the scaffold call — pass 2 codex caught two issues: (a) the guard still fired AFTER plugin clone (same anti-pattern as #2 above), and (b) `'partial'` also matches the benign repair case of "some `wiki-meta/*.md` exist, no legacy files" which `scaffoldWikiMeta` handles idempotently. Pass-2 fix moved the guard to right after `mkdirSync(abs)` and narrowed the refusal condition to `legacyScaffolds.length > 0` (any of the 4 `wiki/<scaffold>.md` present). Regression test asserts no side-effects on refusal + the partial-meta-only state is repaired, not refused.
- **[IMPORTANT — pass 1 codex P2 #3]** Inline `--link-workspace` slug derivation now honors `cfg.vaultNames[abs]` before falling back to `defaultNameFromPath(abs)`. Pre-fix, an existing vault with a custom name configured would get the basename written to the workspace `.env` and the workspace-bound hooks (which resolve `vaultNames[vp] || defaultNameFromPath(vp)`) would fail to find the binding. Regression test pre-registers a custom `vaultNames` entry and asserts the `.env` content uses the custom name.
- **[IMPORTANT — pass 1 Reviewer A #1]** Rebind warning in `linkWorkspaceToVault()`. Pre-fix, overwriting an existing `OBSIDIAN_ROUTER_DEFAULT_VAULT=<old-slug>` with a new slug was silent — exactly the UX antipattern this commit set out to fix. Now reads the previous value (handles quoted/unquoted/whitespace edge cases), warns if different. Two regression tests: rebind to different slug → warns, re-bind to same slug → silent.
- **[NIT — pass 1 Reviewer A #5]** Missing wiki-meta scaffold template now triggers a `warn()` instead of silent `continue` — guards against drift if `WIKI_META_SCAFFOLDS` gains an entry without a matching template file.
- **[NIT — pass 1 Reviewer A #4]** Fixture-vault label changed from `REF-KEY-DO-NOT-LEAK` to `fixture-test-key-not-real` (cosmetic — avoids secret-scanner false-positives).

Final test count: **466/466 passing** (453 pre-existing + 6 v0.12.7 base + 7 review+ regression tests). Both reviewers concluded "OK to merge" at pass 3 with zero new findings.

## [0.12.6] — 2026-05-23

`/review+` hardening pass over v0.12.4's `session-auto-journal` hook (the path-disambiguation work landed independently as v0.12.5 — this release is the parallel review audit's output). Two-pass audit (Code Reviewer subagent + `codex review --commit`) surfaced 7 priority findings on pass 1 + 1 fresh finding on pass 2 (codex caught that the first fallback fix still collided — see the last "Fixed" bullet for the iteration). All 8 addressed with 7 regression tests. Test count: **453/453 passing** (was 452 after v0.12.5 + 1 fresh fallback-collision test added in this pass).

### Fixed

- **Filename collision in same minute** (`hooks/session-auto-journal.mjs:261` — codex P2 #1): two distinct sessions for the same workspace started within the same minute resolved to the same `journalPath` because the filename was `<date>-<HHMM>-<workspace>.md`. The second session then appended into the first session's file. Filename now includes an 8-char session-id discriminator: `<date>-<HHMM>-<workspace>-<sessionIdShort>.md`.
- **`rewriteFrontmatter` silent no-op when `status:` was absent** (`hooks/session-auto-journal.mjs:430-437` — Reviewer A #1): the regex `.replace(/^status:.*$/m, ...)` was a no-op if the `status:` key had been stripped (manual edit or upstream bug) — the journal stayed `open` forever. Now falls back to appending `\nstatus: closed`.
- **`mcp__obsidian-router__execute_template` not journaled** (`hooks/session-auto-journal.mjs:204` + matchers — codex P2 #2): `execute_template` with `createFile: true` is a write tool per `src/index.mjs`'s `WRITE_TOOL_NAMES`, but the journal hook and `hooks.example.json` matchers omitted it. Added to both the in-hook `LOGGED_TOOLS` Set and the two relevant matcher blocks (wiki-autocommit + session-auto-journal).
- **`move_file` + `execute_template` recap missed endpoints** (`hooks/session-auto-journal.mjs:373` — codex P3 #3): the MCP-write branch read only `tool_input.path`, but `move_file` uses `from`/`to` and `execute_template` uses `targetPath`. Now collects `path | from | to | targetPath`.
- **User prompts > 100 KB corrupting the journal** (`hooks/session-auto-journal.mjs:318` — Reviewer A #5): user pasting a large dump into a prompt ballooned the journal beyond render capacity. Now truncated at 100 KB with a marker pointing to Claude Code's transcript for the full content.
- **Doc/wiring drift on the `SessionStart` matcher** (`hooks/hot-cache-load.mjs:26` — Reviewer A #2): inline doc still described `startup|resume`, but `hooks.example.json` was widened to `startup|resume|clear` in v0.12.4. Aligned with a note explaining the widening.
- **Fallback `session_id` lost entropy at `slice(0, 8)`** (`hooks/session-auto-journal.mjs:235-242` — Reviewer A pass 2 + codex pass 2 P3): the v0.12.4 fallback `unknown-${Date.now()}` survived `String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)` as the literal `unknown1` — only the first digit of the timestamp. A first attempt at the fix used `fallback-${randomUUID()}`, but codex caught that `fallback` is exactly 8 chars → `slice(0, 8)` consumed the whole prefix and never sampled the UUID, so two fallback sessions still collided on the same suffix. Final fix: use a raw `randomUUID()` as the fallback, no prefix — the first 8 alphanum chars are then 32 bits of UUID entropy.

### Regression tests added (7, in `tests/session-auto-journal.test.mjs`)

- `codex P2 #1` — distinct session_ids never collide on filename
- `Reviewer A IMPORTANT #2` — SessionEnd closes frontmatter even when `status:` was removed
- `Reviewer A IMPORTANT #5` — user prompts > 100 KB are truncated with a marker
- `codex P2 #2` — `execute_template` (with createFile) is logged + `targetPath` added to state.files
- `codex P3 #3` — `move_file` adds both `from` and `to` to state.files
- `codex pass 2 P3` — fallback session_id (Claude Code omits one) does not collide on filename
- `Reviewer A IMPORTANT #7` — SessionStart 2x with same session_id is idempotent on the journal file

### Deferred to follow-up (NIT, tracked but out of scope)

- Casing `wiki/Sessions/` vs `wiki/sessions/` on case-sensitive filesystems (Linux ext4 / case-sensitive APFS) — needs a convention decision rather than a code-only fix.
- `MAX_PROMPT_BYTES = 100_000` could be made env-overridable (`OBSIDIAN_ROUTER_JOURNAL_MAX_PROMPT_BYTES`) — 2-line change, deferred until real demand.
- `appendFileSync` non-atomic multi-process — documented inline; only a real issue if Claude Code dispatches concurrent events for the same session_id, which it doesn't today.

## [0.12.5] — 2026-05-23

Closes a recurring path-confusion footgun in workspace-bound mode: when the workspace cwd and the associated vault share the same basename (e.g. `C:\Users\me\DEDIBOX` ↔ `C:\VAULTS\DEDIBOX`), Claude could generate filesystem paths that concatenate the cwd path with a vault-internal subpath (`wiki/`, `wiki-meta/`) — producing non-existent paths. The pre-existing `wiki-query-first-nudge` hook already warned `cwd ≠ vault` but didn't give the two absolute paths concretely or forbid the mix explicitly. v0.12.5 enriches the hook with a dynamic `PATH RESOLUTION RULES` block + ships a matching installable convention + a backup section in the global user CLAUDE.md.

### Added

#### Hook enhancement (deterministic, fires at every prompt-submit)

- **New `PATH RESOLUTION RULES` block** in `hooks/wiki-query-first-nudge.mjs`, emitted only when `ctx.mode === 'workspace-bound'`. The block resolves the two absolute roots dynamically from the running context:
  - `cwd` (workspace path, from hook input)
  - `ctx.vaultPath` (associated vault path, from `OBSIDIAN_ROUTER_DEFAULT_VAULT` resolution)

  and renders them inline with concrete WRONG/RIGHT examples that use the *actual* paths of the current session (not generic placeholders). Plus an ordered preference list: wikilink `[[basename]]` → click-to-open link → filesystem path (only when explicitly asked, double-checked).
- **`defaultNameFromPath` now imported** from `hooks/_helpers/workspace-vault.mjs` to compute the shared basename for the explanation text (e.g. "they share the same basename `dedibox` but live under different parents").
- In `cwd-is-vault` mode, the new block is suppressed entirely — there's only one root in that mode, no confusion possible.

#### Installable convention (visible in vault CLAUDE.md)

- **New convention snippet** `skills/conventions/snippets/path-disambiguation.md` (~3 KB) — install via `/obsidian-router:conventions install path-disambiguation`. Same content as the hook's PATH RESOLUTION RULES block but in static markdown form, so any contributor opening a CLAUDE.md sees the rule even without the hook running.
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds `path-disambiguation` to the documented library.

#### Global user CLAUDE.md (backup layer)

- **New section "Workspace-bound path disambiguation — NEVER mix cwd path with vault subpath (universel)"** added to `~/.claude/CLAUDE.md` after the `Wiki-query-first reflex` section. Same content as the snippet, applies by default to every session whether or not the hook fires (covers opt-out via `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`, settings.json missing hook entry, or hook silent failure).

### Why

Roland's verbatim trigger: *"avant tu m'as créé ce lien : `C:\Users\me\DEDIBOX/Stack/host.md` !!!!!!! lui c'est de la merde"* followed by *"c'est insupportable que tu ignores des regles, je ne veux plus que ça arrive, trouve moi une solution perenne pour tous les vaults"*.

The previous protection (wiki-query-first nudge with "cwd is a code/dev project, not the vault itself") was too generic — it told Claude the cwd and vault are different but didn't show the concrete paths side-by-side or forbid the trap pattern explicitly. With both paths visible (`C:\Users\me\DEDIBOX` next to `C:\VAULTS\DEDIBOX`) and a WRONG/RIGHT example using the actual session paths, the LLM has zero excuse to mix them — the trap is named, shown, and a safer default (wikilink `[[basename]]`) is recommended.

Three layers of defense in depth, mirroring the `roadmap-discipline` v0.10.1 + `wiki-query-first` v0.11.6 patterns:
1. **Hook** (deterministic, fires at every prompt-submit) — most reliable layer
2. **Installable convention** (per-vault, visible in CLAUDE.md) — useful when sharing a vault or for contributors who turned off the hook
3. **Global user CLAUDE.md** (every session) — backup for opt-out / hook failure

### Backward compatible

- **Hook change is additive** — same JSON output shape, just longer `additionalContext` payload (workspace-bound mode only). cwd-is-vault sessions get the identical pre-v0.12.5 nudge.
- **Convention is opt-in** — vaults that don't install `path-disambiguation` see no change. The hook still injects the rule at prompt-submit for them via the global CLAUDE.md layer.
- **No API change** — no new tools, no schema changes, no env vars added.
- The hook can still be disabled per-session via `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true` (in which case only the global CLAUDE.md layer protects).
- Test added: `tests/wiki-query-first-nudge.test.mjs` covers the new block (cwd-is-vault: no block emitted; workspace-bound: block present with both paths + WRONG/RIGHT example).

## [0.12.4] — 2026-05-23

Adds automatic per-session journaling to the router. Splits "what happened during a session" (now auto-captured chronologically) from "what's worth keeping as a polished document" (still `/save`-triggered). Triggered by Roland noticing the `wiki/Sessions/` folder in the DEDIBOX vault and wanting full-auto journaling everywhere instead of manual `/save` for chronology.

### Added

- **`hooks/session-auto-journal.mjs`** — multi-event hook that auto-writes one journal file per Claude Code session under `<vault>/wiki/Sessions/<YYYY-MM-DD>-<HHMM>-<workspace-slug>.md`. Dispatches on `hook_event_name`:
  - **`SessionStart`** (matcher `startup|resume|clear`): creates the file with frontmatter `type: session, status: open, session-id, workspace, cwd, started-at`. Records state in `~/.claude/obsidian-mcp-router/session-journals/<session-id>.json` for cross-event continuity.
  - **`UserPromptSubmit`**: appends `## HH:MM:SS — User prompt` with the prompt verbatim. Lazy-creates the journal if SessionStart wasn't wired or fired.
  - **`PostToolUse`** (matcher restricted to write-flavored tools — `Write|Edit|MultiEdit|Bash|mcp__obsidian-router__write_file|patch_file|append_to_file|set_frontmatter|merge_frontmatter|delete_file|move_file`): appends `### HH:MM:SS — tool: <name>` with concise args. Reads intentionally skipped (too noisy).
  - **`SessionEnd`**: inserts a heuristic recap at the top of the journal (counts of prompts/tools, files touched, bash highlights, duration, vault), rewrites frontmatter `status: closed` + `ended-at` + `duration`, deletes the state JSON.
- Vault target follows the same dual-mode resolution as `hot-cache-load`: cwd-is-vault writes under `<cwd>/wiki/Sessions/`, workspace-bound writes under the linked vault's `wiki/Sessions/`. No association → silent skip.
- Opt-out per-session: `OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true`.
- **`tests/session-auto-journal.test.mjs`** — 10 tests covering SessionStart creation, lazy creation on UserPromptSubmit, Write/Bash logging, Read silencing, full SessionEnd flow (recap + frontmatter rewrite + state cleanup), workspace-bound vault target, no-vault silent skip, opt-out env var, unknown-event forward-compat.

### Changed

- **`skills/save/SKILL.md`** — `/save` no longer routes any flavor to `wiki/Sessions/`. The "whole conversation as session note" flavor is deprecated and now redirects: *"the auto-journal captures the chronology; which polished insight from this session do you want extracted into a permanent document?"*. `/save` keeps its job (polished, type-classified documents in `decisions/` / `answers/` / `refs/` / `techniques/` / `adrs/` / `ideas/`).
- **`hooks/hooks.example.json`** — adds `session-auto-journal.mjs` to `SessionStart`, `UserPromptSubmit`, `PostToolUse` (with the write-tool matcher), and the new `SessionEnd` event slot. `SessionStart` matcher widened from `startup|resume` to `startup|resume|clear` to also journal across context-clear events.

### Why this split

Manual `/save` produces high-polish notes (structured frontmatter, narrative sections, cross-links) but requires Roland's discipline to invoke at the right moment. Auto-journal produces low-polish but high-coverage chronological capture: every session lands a file, no exceptions. The two complement each other: the journal is the raw "what happened", `/save` outputs are the curated "what mattered". A `/save`-produced document can backlink to its session journal for context recovery (e.g. *"this decision was made during [[2026-05-23-2200-obsidian-mcp-router]]"*).

### Recap quality (current limit)

The SessionEnd recap is **heuristic-only** for v0.12.4: counts + files touched + bash highlights + duration. No LLM call. Considered shipping LLM-driven extractive recap but rejected for v1 — it requires `ANTHROPIC_API_KEY` in the workspace `.env`, adds API call latency at SessionEnd, and the heuristic recap already covers ~80% of the "what happened" scan-read use case. LLM-driven recap is a planned v0.12.5 feature behind the opt-in env var, with heuristic fallback when absent.

### Test count: **444/444 passing** (was 434 at v0.12.3; +10 session-auto-journal tests).

## [0.12.3] — 2026-05-23

Hardens the click-to-open feature against silent drift. Triggered by an audit discovery that **8/10 vaults** had been running with a stale bridge plugin (v0.1.1, no `/open/*` route) AND a too-old Local REST API plugin (v3.6.1, no `addPublicRoute()` method) for over a week — both states invisible to the existing `meta-status` diagnostic, which only checks the router → vault HTTP ping. Roland's request: *"je veux que le routeur soit infaillible"*.

### Added

- **`scripts/meta-audit-bridge-readiness.mjs`** — read-only audit of every vault in `portRegistry` for click-to-open readiness. Four checks per vault:
  1. `mcp-router-bridge` plugin ≥ v0.2.0 installed (route handler exists on disk)
  2. `obsidian-local-rest-api` plugin ≥ v4.0.0 installed (exposes `addPublicRoute()`)
  3. `enableInsecureServer: true` + `insecurePort` set in LRA's `data.json` (HTTP server listening)
  4. **Live probe**: `GET http://127.0.0.1:<insecurePort>/open/<nonexistent>.md` returns 404 (route registered) vs 401 (auth-middleware catch-all = route never registered, usually because Obsidian holds stale code in memory)

  The live probe (#4) is the key contribution: static manifest checks alone cannot detect "files on disk are correct but Obsidian hasn't reloaded since the sync". Output is a compact ANSI-coloured table + per-failure remediation hints. Flags: `--json` (machine-readable for skill / CI consumers), `--vault <slug-or-path>` (single-vault audit). Exit code 0 if all ready, 1 if any vault is not ready, 2 on script error.

- **`skills/meta-audit-bridge-readiness/SKILL.md`** — natural-language wrapper for the audit. Triggers (EN) `audit my click-to-open links`, `which vaults need a reload`, `check bridge readiness`. Triggers (FR) `audite les liens cliquables`, `vérifie le bridge sur tous les vaults`, `quels vaults ont besoin d'un reload`.
- **`commands/meta-audit-bridge-readiness.md`** — slash command (`/obsidian-router:meta-audit-bridge-readiness`).
- **`npm run audit:bridge-readiness`** — `package.json` script entry for direct CLI use.

### Why this matters

`meta-status` (existing) checks the router can reach each vault (HTTP ping `/`). `meta-audit-bridge-readiness` (new) is its complement: it checks the *clickable links* you put in chat actually work, end-to-end including in-memory route registration. The two diagnostics together cover the full surface of "is the router working for me?" — connectivity AND feature-level readiness.

### Test count: **434/434 passing** (unchanged from v0.12.2 — the new audit script is integration-tested via the smoke run during shipping, which exercised the live probe against all 10 configured vaults).

## [0.12.2] — 2026-05-23

Session 3 of the v0.12.0 phased rollout. Closes the three-session arc with verification + a defensive code improvement to the migration script.

### Audit result on Roland's 9 migrated vaults (post-v0.12.1)

Scanned every `CLAUDE.md` found within 2 levels of each vault root. Result:

| Vault | CLAUDE.md location | Stale `wiki/<scaffold>.md` | `wiki-meta/` refs | workspace-bound mentions |
|---|---|---|---|---|
| .template | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| TradingView | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| Roland | `wiki-meta/CLAUDE.md` | 0 | 15 | 6 |
| SCI DU SOURIRE | (none) | — | — | — |
| portfolio.nicolasgalzy.fr | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| Smile | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| portfolio.ameliegalzy.fr | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| DEDIBOX | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| opsidian-mcp-router et bridge | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |

**Findings**:
- 8/9 vaults have a `CLAUDE.md`. The 9th (`SCI`) intentionally has none (deleted in a previous audit).
- **All 8 are already current**: 0 stale `wiki/<scaffold>.md` paths + 6 workspace-bound mentions = the v0.11.6 convention text is present in every vault.
- The "convention refresh" task originally planned for Session 3 is therefore a **no-op** — the path swap in v0.12.1 already cleaned scaffold paths, and the v0.11.6 install (run at the time) put the workspace-bound section in place across the fleet.
- `wiki/` directories: 7 are gone (auto-cleaned post-migration), 2 (DEDIBOX + project-router) correctly preserved for user content (Refs/, Decisions/, project notes).
- The `wiki-query-first-nudge` hook fired correctly in workspace-bound mode in the verification session — end-to-end functionality confirmed.

### Changed

- **`scripts/setup-vault.mjs` `rewriteClaudeMdScaffoldPaths(vaultPath)`** — extended from "vault root only" to scan three common locations: `<vault>/CLAUDE.md`, `<vault>/wiki-meta/CLAUDE.md`, `<vault>/Documentation/CLAUDE.md`. Rewrites scaffold paths in every copy found, returns the total replacement count across all. Defensive enhancement triggered by the Session 3 audit (the migration's path rewrite would otherwise miss Roland's vaults where CLAUDE.md is not at root). Idempotent and backward-compatible: vaults with CLAUDE.md at root continue to work exactly as before.
- **`tests/migrate-wiki-meta.test.mjs`** — 3 new tests for the multi-location branch: rewrite in `wiki-meta/CLAUDE.md`, rewrite in `Documentation/CLAUDE.md`, rewrite across two CLAUDE.md copies at once with summed count.

### Test count: **434/434 passing** (was 431 at v0.12.1; +3 multi-location tests).

### Phased rollout v0.12.0 — closed

Three releases over 2026-05-23:
- **v0.12.0** — code refactor (hooks + scripts + src all probe `wiki-meta/`), templates moved, tests + docs updated. Clean break, no fallback.
- **v0.12.1** — `setup-vault.mjs --migrate-wiki-meta` + batch form. Ran on Roland's 10 vaults: 9 migrated (1 git mv, 8 fs rename), 1 skipped (Coursera, never bootstrapped).
- **v0.12.2** — verification + multi-location CLAUDE.md rewrite.

The vault layout (`wiki-meta/` for scaffolds, `wiki/` for user content) is now the established convention. Future scaffolds and conventions land in `wiki-meta/`; user notes stay under `wiki/`.

## [0.12.1] — 2026-05-23

Session 2 of the v0.12.0 phased rollout: ships the migration tooling and runs it across the 10 existing vaults. Closes the broken-window state left at v0.12.0 (hooks were silent on vaults still using the legacy `wiki/<scaffold>.md` layout).

### Added

- **`scripts/setup-vault.mjs --migrate-wiki-meta <vault-path>`** — single-vault migration. Detects state (`legacy` / `fresh` / `partial` / `empty` / `no-vault`), refuses on `partial` with a clear diagnostic, no-ops on `fresh` (unless `--force`). For `legacy`: ensures `wiki-meta/` exists, moves the 4 scaffolds via `git mv` if the vault is a git repo (preserves history + auto-stages) or `fs.rename` otherwise, rewrites `wiki/(hot|index|log|overview)\.md` → `wiki-meta/$1.md` in the vault's root `CLAUDE.md`, and appends a migration-line to the (now-moved) `wiki-meta/log.md`.
- **`scripts/setup-vault.mjs --migrate-all-wiki-meta`** — batch form. Iterates over `cfg.portRegistry`, runs the same migration on each vault, reports a per-vault status summary at the end. Exits non-zero if any vault fails. Shared flags: `--dry-run` (preview without writes), `--force` (re-rewrite CLAUDE.md on already-migrated vaults — useful if a previous migration crashed mid-flight).
- **`tests/migrate-wiki-meta.test.mjs`** (NEW) — 15 tests covering: plain-rename branch, git-mv branch (with real `git init` fixtures), CLAUDE.md scaffold-path rewrite (preserving non-scaffold `wiki/...` user-content paths), idempotency, `--force` re-rewrite, `--dry-run` no-op, batch summary aggregation, batch `--dry-run`, partial-state refusal, empty-state skip, missing-arg error, non-existent path failure, empty-portRegistry batch failure.

### Migrated on Roland's machine (9 vaults)

Ran `--migrate-all-wiki-meta` against the 10 vaults in `portRegistry`. Result:

```
✓ C:\VAULTS\.template                                — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\TradingView                              — fs    rename, 31 CLAUDE.md replacements
✓ P:\Mon Drive\VAULTS\Roland                         — fs    rename, 17 CLAUDE.md replacements
✓ P:\Mon Drive\SCI DU SOURIRE VAULT OBSIDIAN         — fs    rename, 17 CLAUDE.md replacements
✓ M:\Mon Drive\VAULTS\portfolio.nicolasgalzy.fr      — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\Smile                                    — fs    rename, 31 CLAUDE.md replacements
✓ M:\Mon Drive\VAULTS\portfolio.ameliegalzy.fr       — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\DEDIBOX                                  — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\opsidian-mcp-router et bridge            — git mv,  31 CLAUDE.md replacements

— C:\VAULTS\Coursera                                 — skipped (empty state, never bootstrapped via /obsidian-router:wiki)
```

The broken-window status from v0.12.0 is now closed: `hot-cache-load` and `wiki-query-first-nudge` resume normal operation on these 9 vaults next session start.

### Test count: **431/431 passing** (was 416 at v0.12.0; +15 from `migrate-wiki-meta.test.mjs`).

### What's left for Session 3 (v0.12.2)

The convention snippets installed in per-vault CLAUDE.md (`wiki-query-first`, `roadmap-discipline`) still contain old `wiki/<scaffold>.md` references in their prose. v0.12.1's `--migrate-wiki-meta` already swept those (the regex is unconditional on the 4 scaffold filenames anywhere in CLAUDE.md), so most are fixed. Session 3 will re-install the latest snippet versions to pick up other recent changes + run a verification sweep across the fleet.

## [0.12.0] — 2026-05-23

**BREAKING** (vault layout): the 4 wiki scaffolds — `hot.md`, `index.md`, `log.md`, `overview.md` — move out of `wiki/` into a sibling `wiki-meta/` directory. User content stays under `wiki/` (people, concepts, sessions, decisions, references, projects, …). This is a clean break — there is **no fallback** to the old layout in the code. Vaults still on `wiki/<scaffold>.md` will appear "empty" to the hooks (silent exit) until migrated.

Roland's motivation: the 4 scaffolds are conceptually META (catalog + recent-context cache + operation log + executive summary) — visually mixing them with user notes under a single `wiki/` clutters Obsidian's file tree. The split makes the boundary semantic: open `wiki-meta/` for system files, `wiki/` for content.

### Phased rollout (Session 1 = THIS release, Sessions 2 & 3 ship after)

- **Session 1 (v0.12.0)** — code refactor + tests green + templates moved. Existing vaults are NOT touched.
- **Session 2 (v0.12.1, planned)** — `setup-vault.mjs --migrate-wiki-meta <vault>` + `--migrate-all-wiki-meta`. Atomic `git mv` of the 4 files + edit of the vault's `CLAUDE.md`. Run on all bootstrapped vaults.
- **Session 3 (v0.12.2, planned)** — re-install the convention snippets (`wiki-query-first`, `roadmap-discipline`) on each vault so their per-vault `CLAUDE.md` references catch up to the new paths.

Between Session 1 and Session 2, vaults still on the old layout cause the `hot-cache-load` and `wiki-query-first-nudge` hooks to silent-exit (detection probe `wiki-meta/index.md` fails). Accept this as the cost of clean break; alternative was carrying fallback logic indefinitely.

### Changed

- **`hooks/_helpers/workspace-vault.mjs` `detectVaultContext()`** — scaffold-detection probe switched from `wiki/index.md` to `wiki-meta/index.md`. Both `cwd-is-vault` and `workspace-bound` modes affected.
- **`hooks/hot-cache-load.mjs`** — reads `<vault>/wiki-meta/hot.md` instead of `<vault>/wiki/hot.md`. Marker text (workspace-bound mode) updated accordingly.
- **`hooks/wiki-query-first-nudge.mjs`** — nudge enumerates the 4 entry points as `wiki-meta/hot.md`, `wiki-meta/index.md`, `wiki-meta/log.md`, `wiki-meta/overview.md`. Mode-aware read guidance covers both `wiki-meta/<scaffold>` and `wiki/<page>` so Claude knows the split.
- **`hooks/hot-cache-update-prompt.mjs`** — trigger now scans `wiki/` AND `wiki-meta/` (`git diff` / `git log` against both paths). Refresh nudge text says "update `wiki-meta/hot.md`".
- **`hooks/wiki-autocommit.mjs`** — added `wiki-meta` to `trackedDirs` array. Otherwise scaffold edits (notably the hot.md refresh) would silently fall outside autocommit coverage.
- **`hooks/vault-link-linter.mjs`** — docstring examples updated; runtime logic unchanged (the linter already handles any `.md` inside a vault).
- **`scripts/setup-vault.mjs --link-workspace`** — validation now requires `<vault>/wiki-meta/index.md`. Error message points at `--migrate-wiki-meta` (v0.12.1) for vaults on the legacy layout.
- **`src/index.mjs`** — audit log (`OBSIDIAN_ROUTER_USER_ID`) appends to `<vault>/wiki-meta/log.md` instead of `<vault>/wiki/log.md`.
- **`templates/wiki/{hot,index,log,overview}.md`** physically moved to **`templates/wiki-meta/{...}.md`** (4× `git mv`). Same for `templates/reference-vault-skeleton/wiki/{...}` → `wiki-meta/{...}` — the `wiki/` subdir under the skeleton is removed. `templates/wiki/CLAUDE.md` and `templates/reference-vault-skeleton/CLAUDE.md` stay where they are (vault-root CLAUDE.md, not a scaffold) but their CONTENT was updated to reference `wiki-meta/` for the 4 scaffolds and to explain the split.
- **All `skills/` SKILL.md, `commands/`, `agents/`** mentioning the 4 scaffolds — bulk-swept (`wiki/<scaffold>.md` → `wiki-meta/<scaffold>.md`, 64 replacements across 17 files).
- **Convention snippets** (`skills/conventions/snippets/wiki-query-first.md`, `roadmap-discipline.md`, `auto-enrichment.md`) — same sweep. Note: per-vault installed copies of these snippets need re-install via Session 3 to pick up the new paths.

### Test count: **416/416 passing** (unchanged headcount — refactor + fixture path updates, no new tests this session).

### Migration note for vault owners

If your vault was bootstrapped before v0.12.0, the hooks `hot-cache-load` and `wiki-query-first-nudge` will be silent for that vault until you migrate. Quickest workaround pending the v0.12.1 script:

```bash
cd /path/to/your/vault
mkdir wiki-meta
git mv wiki/hot.md wiki-meta/hot.md
git mv wiki/index.md wiki-meta/index.md
git mv wiki/log.md wiki-meta/log.md
git mv wiki/overview.md wiki-meta/overview.md
# Then edit CLAUDE.md to swap the 4 wiki/<scaffold>.md refs for wiki-meta/<scaffold>.md
```

The automated `setup-vault.mjs --migrate-wiki-meta <vault-path>` ships in v0.12.1 and handles the CLAUDE.md edits too.

## [0.11.6] — 2026-05-23

Closes the v0.11.5 gap Roland surfaced: the new `wiki-query-first-nudge` hook only detected vault context when cwd ITSELF contained `wiki/index.md`, missing the common case where the workspace is a code/dev project ASSOCIATED with a vault (e.g. `<repo>` ↔ vault `opsidian-mcp-router et bridge`). v0.11.6 introduces **workspace-bound mode**: hooks resolve an associated vault via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in the workspace `.env`, and operate against THAT vault's wiki when cwd has none. Also closes the related gap on `hot-cache-load` (now reads associated vault's `wiki/hot.md` with a marker).

### Added

- **`hooks/_helpers/workspace-vault.mjs`** — new shared helper module. Exports `loadWorkspaceDotenv(cwd)`, `readRouterConfig()`, `routerConfigPath()`, `defaultNameFromPath(p)`, `resolveVaultBySlug(cfg, slug)`, `detectVaultContext(cwd, cfg)`. Pure functions where possible; I/O isolated to dotenv autoload + config read. Eliminates 3-way duplication of the same code across hooks. Used by `wiki-query-first-nudge.mjs` and `hot-cache-load.mjs`.
- **`hooks/wiki-query-first-nudge.mjs` — dual-mode detection (v0.11.6)** — refactored to use `detectVaultContext()`. Returns one of `cwd-is-vault` / `workspace-bound` / null. Nudge text now mode-aware: in cwd-is-vault mode, instructs `Read("wiki/<file>")` (filesystem); in workspace-bound, instructs `mcp__obsidian-router__get_file({ vault: "<slug>", path: "wiki/<file>" })` (cwd has no wiki/). Nudge text explicitly enumerates the 4 canonical wiki entry points (hot/index/log/overview) with their purpose.
- **`hooks/hot-cache-load.mjs` — workspace-bound mode (v0.11.6)** — refactored to use `detectVaultContext()`. In cwd-is-vault mode, prints `cwd/wiki/hot.md` (original behavior). In workspace-bound mode, prints the ASSOCIATED vault's `wiki/hot.md`, prefixed with an HTML-comment marker explaining the workspace ≠ vault setup and instructing Claude to use `mcp__obsidian-router__get_file` for further wiki reads (since `Read` on `wiki/X.md` would fail with ENOENT in workspace-bound). Silent exit when neither mode applies or when the resolved vault has `wiki/index.md` but no `wiki/hot.md` yet.
- **`scripts/setup-vault.mjs --link-workspace <workspace-path> <vault-slug>`** — new CLI command to bind a code workspace to a vault. Writes `OBSIDIAN_ROUTER_DEFAULT_VAULT="<slug>"` (auto-quoted when slug contains spaces) into the workspace's `.env`. Validates: workspace path exists + is a directory, vault-slug exists in `portRegistry`, vault has `wiki/index.md`. Preserves other `.env` keys via the same dotenv merge logic used by `lock_vault`. Idempotent.
- **`scripts/setup-vault.mjs --unlink-workspace <workspace-path>`** — symmetric remove. Strips ONLY the `OBSIDIAN_ROUTER_DEFAULT_VAULT=` line, preserves all others. Silent no-op if .env absent or key not set.
- **`tests/hot-cache-load.test.mjs`** (NEW) — 10 tests covering both modes (cwd-is-vault regression + workspace-bound activation, marker presence, stdin cwd field, env var fallback, silent on unresolvable slug, silent when vault has no hot.md yet, cwd-is-vault precedence over .env link).
- **`tests/wiki-query-first-nudge.test.mjs`** extended with 8 new tests (+ workspace-bound suite): nudge mentions 4 entry points, mode label is "cwd-is-vault", workspace-bound activation, MCP get_file instructions in workspace-bound nudge, silent on unresolvable slug, silent without .env or env var, process.env wins over .env file.
- **`tests/install-hooks.test.mjs`** extended with 8 new tests for `--link-workspace` / `--unlink-workspace`: write to fresh .env, quote spacy slugs, preserve other keys, fail on unknown slug / vault without wiki/index.md / non-existent workspace path, remove preserves other lines, no-op without .env.
- **`skills/conventions/snippets/wiki-query-first.md`** — refreshed to document both modes + setup procedure (`--link-workspace`) + 4 entry points.
- **`~/.claude/CLAUDE.md` global "Wiki-query-first reflex (universel)"** — same updates mirrored.

### Total test count: **416/416 passing** (was 391 at v0.11.5).

### Activation for Roland's setup

Run from the router repo for each code workspace that's associated with a vault:
```bash
cd <router-repo>
node scripts/setup-vault.mjs --link-workspace . "opsidian-mcp-router et bridge"
# (already run on <repo> during this session)

# Repeat for other code workspaces (SMILE, PORTFOLIO-NICOLAS, etc.)
```

After restart, hot-cache-load auto-prints the associated vault's hot.md (with marker), and wiki-query-first-nudge fires with mode-aware instructions.

### Trigger

Roland 2026-05-23: *"un workspace peut être effectivement un obsidian vault mais pas seulement. Un workspace peut être le développement d'une application complétement en dehors des repertoires du vault MAIS associé à un vault Obsidian. Tu comprends la nuance ?"* — followed by *"les points d'entrée des vaults associés à un workspace : hot, index, log et overview seront t'ils bien pris en compte ?"*. Both gaps closed in this release.

## [0.11.5] — 2026-05-23

Closes the 3rd category of "Claude forgets a context rule at the moment of application" slip Roland has caught this year (after vault-link-linter v0.11.3 for clickable vault links and doc-propagation-checker v0.11.4 for post-commit doc drift). The new slip: in a vault-bound session, Claude answers user questions without first checking whether the topic has been discussed/documented in the vault wiki — wasting prior research, decisions, and references. Codified following the same 3-layer pattern: installable convention + global CLAUDE.md section + deterministic hook.

### Added

- **`hooks/wiki-query-first-nudge.mjs`** — new `UserPromptSubmit` hook. Fires BEFORE Claude sees the user's prompt. When the workspace is an Obsidian vault (detected by presence of `wiki/index.md`) AND the prompt looks substantive (not trivial follow-up, slash command, single-word ack), injects a reminder into Claude's context via `additionalContext` field (UserPromptSubmit spec). Reminder includes the 4-step pre-answer flow: (1) read `wiki/index.md`, (2) read relevant page directly, (3) `search_smart` for semantic-fit topics, (4) cite notes with click-to-open links. Conservative filtering: skips on length < 20 chars, slash command, regex match against trivial pattern (`oui|non|ok|d'?accord|merci|thanks|yes|no|continue|next|skip|pass|cancel|nevermind|nm`), and obviously empty prompts. 30s timeout respected (hook is ~10ms). Opt-out: `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`.
- **`skills/conventions/snippets/wiki-query-first.md`** — 7th installable convention (bilingual FR + EN). Detailed procedure, skip-conditions, anti-patterns, audit trail with Roland's DEDIBOX/RDP example. Installable via `/obsidian-router:conventions install wiki-query-first` on any vault.
- **Global `~/.claude/CLAUDE.md` section "Wiki-query-first reflex"** — mirrors the convention as a globally-applied rule so it covers ALL sessions even without per-vault install. Same defense-in-depth pattern as `default-vault-health-check` (v0.10.0) and `roadmap-discipline` (v0.10.1).
- **`tests/wiki-query-first-nudge.test.mjs`** — 15 tests covering: 10 silent cases (non-vault, empty/short/trivial prompt, slash command, opt-out env var, empty/malformed stdin, "OK"/"Continue" single-word) + 5 inject cases (substantive question, imperative, opt-out env var name visible in nudge, `CLAUDE_PROJECT_DIR` fallback, borderline-trivial with question mark > 20 chars).
- **`hooks/hooks.example.json`** — new `UserPromptSubmit` block wired with the new hook.
- **`skills/conventions/SKILL.md`** — convention mapping table extended 6 → 7 rows.

### Activation

Already done in this session's continuation: the hook is wired in Roland's `~/.claude/settings.json` `UserPromptSubmit` block. The convention is installed on all 10 configured vaults. The global CLAUDE.md section is in place. Fires from the next Claude Code restart onward.

### Total test count: **391/391 passing** (was 376 at v0.11.4).

### Trigger

Roland 2026-05-23 observed in a DEDIBOX-vault session: he asked *"je veux créer une connexion RDP depuis mon PC maison vers mon PC cabinet via WireGuard"*. That session read `roadmap_dedibox.md` but missed `wiki/Refs/dedibox-rdp-pc-cabinet.md` which contained the exact procedure. He had to point manually: *"tu es allé consulter ceci `wiki/Refs/dedibox-rdp-pc-cabinet`?"*. The wiki-query-first reflex would have caught it — a `search_smart` on "RDP cabinet WireGuard" would have surfaced the note immediately. Pattern recognized: 3rd "context rule recall" slip this year, all 3 now codified with the same defense-in-depth approach.

### Future enhancement (Couche 3 — multi-session)

The `meta-config` skill (Phase 4.1) will let the user toggle these per-prompt hooks on/off without env vars or JSON editing. Tracked in [[router-ux-improvements-roadmap]].

## [0.11.4] — 2026-05-23

Closes the "router-as-assistant" UX gap: hooks shipped on disk but stayed dormant because activating them required hand-editing `~/.claude/settings.json`. v0.11.4 ships a `--install-hooks` CLI family + `meta-setup` interactive prompt + new-hooks tips in the daily update check, so the user can opt in (or extend their selection) without ever touching JSON. Roland: *"il faut guider l'utilisateur pour qu'il active tout cela : mise à jour de la doc, git réguliers, liens valides vers les notes... Je veux que obsidian-router devienne un vrai assistant"* — this release closes Couche 1 + Couche 2 of that vision.

### Added

- **`hooks/doc-propagation-checker.mjs`** — `PostToolUse` hook on `Bash`. After every `git commit` (matched via `/(?:^|[\s;&|])git\s+commit\b/` to catch compound shell commands and amend variants), checks that the repo's documentation surface is aligned with `package.json` version. Emits a prompt-style stdout nudge (NOT a block — exit 0 always) when drift is detected, listing concrete actions. Checks: (1) `CHANGELOG.md` has a `## [X.Y.Z]` section for the current version; (2) `ROADMAP.md` has a `## ✅ vX.Y.Z` section; (3) `CHANGELOG.md` `[Unreleased]` doesn't have substantive content when the current version section already exists (suggests forgotten promotion); (4) vault wiki `router-changelog.md` mentions the current version (multi-tier check: iterates `portRegistry`, finds first vault containing the project wiki, scans). Recognizes the project's "Nothing pending right now." placeholder so it doesn't false-positive on empty `[Unreleased]`. Built in response to recurring slip pattern: Claude ships a feat commit, bumps `package.json`, but forgets to propagate to CHANGELOG/ROADMAP/vault wiki — caught manually 2× before being codified. Same spirit as `vault-link-linter`: deterministic check OUTSIDE the LLM attention loop. Opt-out: `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true`. 14 tests in `tests/doc-propagation-checker.test.mjs` (6 silent / 8 nudge).
- **`tests/doc-propagation-checker.test.mjs`** — 14 tests (6 silent / 8 nudge). Silent: non-Bash tool, non-git-commit command, aligned CHANGELOG+ROADMAP, opt-out env var, no package.json, malformed stdin. Nudge: missing CHANGELOG version section, missing ROADMAP version section, stale Unreleased when version section exists, no double-nudge when version section is missing (user mid-flow), vault wiki check, opt-out env var discoverable in stderr, compound shell commands (`git add . && git commit ...`), git commit variants (`--amend`, `-a`, `-am`).
- **`scripts/setup-vault.mjs --install-hooks`** — merges `hooks/hooks.example.json` into `~/.claude/settings.json`. Idempotent (re-run safe — detection by hook script basename). Preserves user-defined non-router hooks. Auto-detects this router's absolute path via `import.meta.url` and uses forward slashes in JSON for Windows compatibility (escape-free). Replaces the `<router-repo>` placeholder transparently. Layout: appends new matcher blocks alongside existing ones rather than merging into them — Claude Code unions all blocks under the same event name at runtime, so this is functionally equivalent and avoids regex-matching matcher strings.
- **`scripts/setup-vault.mjs --install-hooks --select <a,b,c>`** — partial install. Comma-separated hook basenames, with or without `.mjs` extension. Skips hooks not in the list AND hooks already installed (still idempotent).
- **`scripts/setup-vault.mjs --uninstall-hooks`** — removes ALL router hooks from `~/.claude/settings.json` (detected by path containing `obsidian-mcp-router/hooks/`). Preserves user-defined hooks. Cleans up empty matcher blocks + empty event arrays + empty `hooks` object so the file stays tidy.
- **`scripts/setup-vault.mjs --hooks-status`** — diagnostic. Lists every hook in `hooks/hooks.example.json` with `✓ active` or `○ inactive` based on `~/.claude/settings.json` presence. Reports the settings file path + the resolved router repo path for transparency.
- **`hooks/check-router-update.mjs` v0.11.4 extension** — on top of the once-per-day version-update notice, the hook now snapshots the local `hooks/` listing in `~/.claude/obsidian-mcp-router/.last-version-check.json`. On the next run, diffs the current local listing vs the snapshot. If new hooks appeared (= the user updated and got new hooks) AND those hooks aren't already wired in `~/.claude/settings.json`, appends a 💡 tip to the notice listing them + the one-line `--install-hooks --select <names>` command to activate. Tip is Claude-CLI-style and gets relayed by Claude on the first response. Snapshot is computed offline (no GitHub dep), so the tip fires even when offline. Same opt-out: `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` silences both the version notice and the tip.
- **`skills/meta-setup/SKILL.md` — "Install router hooks (recommended)" section** — interactive prompt at the end of meta-setup proposing `--install-hooks` with 3 modes (All / Pick / Skip). Documents the 6 hooks + their per-hook opt-out env vars. Mentions `--hooks-status` for verification.
- **`tests/install-hooks.test.mjs`** — 14 integration tests covering the full `--install-hooks` / `--uninstall-hooks` / `--hooks-status` matrix: fresh install, merge into existing, idempotency, --select partial + with/without .mjs, --select fails on missing value, forward-slash paths in JSON, placeholder replacement, uninstall preserves user-defined, uninstall cleans up empty objects, status reports correctly on empty/full/partial.
- **`tests/check-router-update-tips.test.mjs`** — 7 integration tests for the snapshot/tip logic: first run (no tip, snapshot stored), no diff (silent), diff detected (tip), already-wired (no tip), multiple new hooks (correct slug list), snapshot updated after run, opt-out env var silences.

Total test count: **376/376 passing** (was 355 — 341 at v0.11.3, plus the 14 doc-propagation-checker tests folded into this section).

### Fixed (this release)

- Nothing — pure feature add.

### Activation path for existing v0.11.3 users

The hooks didn't auto-activate before because `~/.claude/settings.json` is user-controlled. After updating to v0.11.4:

1. Run `node <router-repo>/scripts/setup-vault.mjs --install-hooks` once. Idempotent — safe to re-run.
2. Restart Claude Code so it picks up the new hooks.
3. The next session-start `check-router-update` hook will start snapshotting your local `hooks/` listing. Any future router update that adds hooks will surface a 💡 tip on the next 24h check.

Future enhancement (Couche 3 — multi-session): a `meta-config` skill or slash command to toggle individual hooks on/off without touching JSON or env vars, plus proactive usage tips ("your wiki has 80 unfolded entries, consider `/wiki-fold`"). Tracked in [[router-ux-improvements-roadmap]].

## [0.11.3] — 2026-05-23

Closes a recurring slip: the "Obsidian vault links" convention from `~/.claude/CLAUDE.md` (vault file mentions must use markdown links pointing to the bridge plugin's `/open/<path>` endpoint, not bare relative paths) — although loaded into Claude's context every session, sometimes isn't triggered at recap time (cognitive bottleneck during multi-step turns). This release ships a `Stop` hook that enforces the convention deterministically OUTSIDE the LLM attention loop, same spirit as `wiki-autocommit` and `check-router-update`.

### Added

- **`hooks/vault-link-linter.mjs`** — new `Stop` hook that enforces the "Obsidian vault links" convention from `~/.claude/CLAUDE.md` (click-to-open markdown links pointing at the `obsidian-mcp-router-bridge` plugin's `/open/<path>` endpoint, instead of bare relative paths that aren't clickable in Claude Code). The hook reads the transcript, finds `[label](href.md)` links where `href` has no scheme and is relative, verifies each candidate against `portRegistry` vault paths on disk (filesystem check = false-positive avoidance), and if any verified-as-vault-file mentions remain, exits 2 with a bilingual stderr listing each violation + the corrected form (auto-derives the right `insecurePort` from each owning vault's `obsidian-local-rest-api/data.json`, with HTTPS fallback caveat when `enableInsecureServer: false`). Claude Code re-runs the turn so the user only sees the corrected response. Strips fenced code blocks and inline code before scanning to avoid flagging examples. Recursion guard via `stop_hook_active`. Opt-out via `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` (truthy: `true`/`1`/`yes`/`on`). Wire-up: added to `Stop` block in `hooks/hooks.example.json` alongside `hot-cache-update-prompt.mjs` (both run on every Stop event). Built after recurring observation that the convention — though loaded into Claude's context via the global CLAUDE.md — sometimes doesn't trigger at the moment of application (LLM attention bottleneck during multi-step recap turns); the hook is a deterministic check outside the LLM attention loop, same spirit as `wiki-autocommit` and `check-router-update`.
- **`tests/vault-link-linter.test.mjs`** — 33 tests covering: 13 pass cases (no links, http/https/obsidian scheme already correct, code-block stripping incl. 4-space-indented, path not in any vault, path-traversal escape attempts, recursion guard, opt-out env var, missing config, absolute paths) + 16 block cases (bare-path link, multiple violations, percent-encoded href, FR+EN preamble, opt-out env var name in stderr, code-block stripping respected, HTTPS fallback when insecureServer disabled, REGRESSION tests for: filename with literal `%`, multi-vault `defaultVault` preference, `disabledVaults` filtering, `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist, `OBSIDIAN_ROUTER_DEFAULT_VAULT` env override, `VAULT_PATH` env path-based default, workspace `.env` autoload, `OBSIDIAN_ROUTER_LOCKED` lock-mode isolation) + 4 robustness tests (empty stdin, non-JSON stdin, missing transcript_path, no assistant messages). Total test count: **341/341 passing** (was 308).

#### Multi-tenant correctness (vault-link-linter)

The linter honors the same active-vault filtering and default-resolution cascade as the router itself, so it never lints against vaults the router would refuse to expose:

- **Workspace `.env` autoload** — the hook runs as a separate Node subprocess invoked by Claude Code, so it does NOT inherit the workspace `.env` the router binary loads itself. The hook now loads `$CLAUDE_PROJECT_DIR/.env` (or `cwd()/.env`) at startup with standard dotenv semantics (file values fill only UNSET keys; `process.env` always wins). Without this, the multi-vault cascade below would always fall back to tier 3 in vault-bootstrapped workspaces (where `VAULT_PATH` lives only in `.env`).
- **`cfg.disabledVaults`** entries (accepted as slug NAME or absolute PATH per v0.5.0+ convention) are excluded from linting.
- **`OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c`** env var (v0.9.0+ multi-tenant whitelist) restricts linting to the listed slugs.
- **`OBSIDIAN_ROUTER_LOCKED=<slug>`** (v0.8.0+ single-vault isolation) restricts linting to ONLY the locked vault. If the locked slug doesn't match any active vault, the linter skips entirely (the router would refuse to resolve too — no safe suggestion to make).
- **Default-vault resolution** for the URL-suggestion bias follows the router's per-process cascade: (1) `OBSIDIAN_ROUTER_DEFAULT_VAULT` env (slug) — explicit per-process override; (2) `VAULT_PATH` env (absolute path) — auto-detected by `setup-vault.mjs` in each bootstrapped vault's `.env`; (3) `cfg.defaultVault` (slug) — global fallback.

## [0.11.2] — 2026-05-23

Adds `/obsidian-router:meta-sync-template` (template propagation skill) and closes two real safety bugs in `setup-vault.mjs` discovered while building the skill — one data-loss path (case-sensitive reference self-skip on Windows NTFS) and one credential-leak path (first-time copy of `obsidian-local-rest-api` cloned the reference's `data.json` into targets).

### Added

- **`/obsidian-router:meta-sync-template`** + companion **`skills/meta-sync-template/SKILL.md`** — interactive slash command that propagates the reference (`.template`) vault's plugins, snippets, and root docs to one or more configured vaults. Lists every vault in `portRegistry` with online status (via the router's `list_vaults`), flags vaults missing `obsidian-local-rest-api` upfront with `⚠️ needs bootstrap`, lets the user pick **all**, a **subset** (comma-separated numbers/names/abs-paths), or **cancel**, then asks whether to pass `--force`. Uses `npm run setup-vault -- --sync-all` for the all-vaults case (the script handles iteration + reference skip + credential-leak protection internally) and loops `setup-vault.mjs "<path>" --sync-plugins` for subsets. Propagates `OBSIDIAN_ROUTER_CONFIG` to spawned subprocesses when the active config is non-default. Brings total commands shipped by the plugin from 30 → 31 (4 meta helpers now: `meta-setup` / `meta-add-vault` / `meta-status` / `meta-sync-template`).
- **`scripts/path-helpers.mjs`** — pure module exporting `samePath()` and `canonicalPath()`. Backed by `fs.realpathSync.native()` (resolves on-disk casing on Windows NTFS, follows symlinks on POSIX) with a per-platform fallback for non-existent paths (`win32` and `darwin` lowercase, `linux` exact). Used by every same-path compare in `setup-vault.mjs` so case-different registry entries can't sneak past safety checks.

### Fixed

- **`scripts/setup-vault.mjs:1056` — `--sync-all` case-sensitive self-skip (data-loss)**: the previous check `path.resolve(a) === path.resolve(b)` treated `C:\VAULTS\.template` and `c:\vaults\.template` as unequal even though Windows NTFS resolves them to the same physical directory. A reference vault registered with mismatched casing in `portRegistry` would slip past the skip and, with `--force`, the per-vault sync would `rm -rf` the source's own plugin folder before re-copying from the now-empty source. Replaced with `samePath()` (regression test in `tests/setup-vault-safety.test.mjs`).
- **`scripts/setup-vault.mjs:syncPluginsMode` — top-level reference guard**: explicit `samePath(abs, cfg.referenceVault)` at the entry of `syncPluginsMode()`. A direct invocation `node scripts/setup-vault.mjs "<reference>" --sync-plugins --force` is now refused with a clear error message instead of silently destroying the template's plugins. Belt-and-suspenders with the `--sync-all` self-skip fix above.
- **`scripts/setup-vault.mjs:syncPluginsMode` — credential-leak avoidance**: `syncPluginsMode()` now refuses to copy any plugin listed in `CREDENTIAL_LEAK_PLUGINS` (currently `obsidian-local-rest-api`) into a target that lacks its own `data.json`. This covers BOTH cases: the obvious first-time copy (plugin folder absent), and the subtler `--force` refresh case (plugin folder present but `data.json` never written because the plugin was installed but never activated — see codex P1 in the review trail). Without these guards, the wholesale copy would clone the reference's `data.json` (port + API key) into the target — every target would share the same key, and the bound port would conflict on bind. Refused plugins are surfaced via a `warn()` in normal mode and a `[obsidian-mcp-router] WARNING:` line in `--quiet` mode (yes, even `--quiet` — credential-leak avoidance must not be silenced for hooks). Existing-plugin re-clones with `--force` AND existing `data.json` are unaffected — the preservation branch already protected that path.
- **`scripts/setup-vault.mjs:syncPluginsMode` — `throwOnError` opt-in for bulk callers**: when called from `--sync-all` with `opts.throwOnError: true`, error paths that previously called `fail()` (which does `process.exit(1)`) now throw instead, so a single failing vault no longer tears down the whole `--sync-all` loop. Direct CLI invocation keeps the legacy exit behavior (non-zero exit on failure). Closes the latent risk flagged by Reviewer A I1 in the review trail.
- **`scripts/setup-vault.mjs` — honors `OBSIDIAN_ROUTER_CONFIG`**: previously hard-coded `$HOME/.claude/obsidian-mcp-router/config.json`. Now reads `OBSIDIAN_ROUTER_CONFIG` first, consistent with the router binary's `--config` flag. Defaults unchanged when the env var is unset.
- **`scripts/setup-vault.mjs:writeMcpJson` — embeds `--config <path>` for non-default configs**: when the bootstrap is running against a custom config (env var or CLI flag), the generated `.mcp.json` now passes `--config <path>` to the router so MCP clients (Claude Code, Claude Desktop) launch the router against the same config the user bootstrapped against. Previously the spawned router would silently fall back to the default config and report the freshly-registered vault as missing.

### Tests

- **`tests/setup-vault-safety.test.mjs`** — 16 new tests (7 unit tests for `samePath()` + 9 integration tests spawning `setup-vault.mjs` with temp fixtures via `OBSIDIAN_ROUTER_CONFIG`). Coverage: case-insensitive same-path matches, non-existent path handling, refusal to target reference (same and mis-cased), credentialed-plugin skip on first-time AND on `--force` with missing target `data.json` (codex P1 regression), `data.json` preservation across normal `--force` re-clone, `--quiet` warning visibility, `--sync-all` self-skip on same-casing AND mis-cased reference entries, `--sync-all` loop survives a single failing vault (Reviewer A I1 regression). Total test count: **308/308 passing** (was 271).

## [0.11.1] — 2026-05-22 — `/ultrareview` follow-up: 7 security + correctness fixes

Cloud `/ultrareview` ran ~17 minutes after the v0.11.0 commit landed and surfaced **7 valid findings the local `/review+` had missed** (Reviewer A subagent + codex CLI, 3 passes). All addressed here.

The distribution of findings is the argument for a three-tier review stack, and worth recording: the **local** pass caught the foundational bugs — the textual-only SSRF check, argv injection, the TOCTOU tempfile, a credential leak in `.claude/settings.local.json`, a missing lockfile regeneration. The **cloud** pass reasoned one level up, about *composition* with the threat model: that validate-then-fetch is TOCTOU **without IP pinning**, that `OBSIDIAN_ROUTER_READONLY`'s semantics shifted silently the day file-input tools shipped, and that Node 20.12's CVE-2024-27980 had quietly turned `.cmd` execFile into dead code on Windows.

### Fixed

- **DNS rebinding TOCTOU (SSRF).** v0.11.0 did `dns.lookup` → `isPrivateIp` → `fetch`, with nothing pinning the address between validation and connection: an attacker-controlled DNS server with `TTL=0` returns a public IP at validation time and a private one (loopback, RFC1918, or the `169.254.169.254` cloud metadata endpoint) at connect time. New `resolveAndAssertPublic()` returns `{ address, family }`, and `safeFetch` builds a custom undici `Agent` whose `connect.lookup` calls back with the **pre-resolved** address, pinning the connection. Per-redirect-hop pinning is preserved.
- **`OBSIDIAN_ROUTER_READONLY` bypass on file-input conversion tools.** The six file-input `*_to_markdown` tools were deliberately excluded from `WRITE_TOOL_NAMES` (they write nothing), but that left them exposed in multi-tenant setups where `READONLY` + `ALLOWED_VAULTS` are the isolation boundary — so `pdf_to_markdown({ filepath: "/etc/passwd" })` exfiltrated arbitrary server files. New `assertSandboxConsistent()` runs at `startServer` boot and **refuses to start** when any multi-tenant signal is set without `MD_ALLOWED_PATHS`. Single-user setups are unaffected.
- **No HTTP status check, and no body size cap.** Two independent holes in the same function: `safeFetch` returned 4xx/5xx responses unchanged, so a 404 HTML error page was converted to `# Page Not Found` markdown and shipped to MCP clients as if it were the requested content; and `response.arrayBuffer()` buffered the whole body before any size check, so an attacker URL could OOM the router. `safeFetch` now throws on `!response.ok` with the status code, and a new `readBodyWithCap()` streams with a 50 MB budget (matching the existing `maxBuffer` ceiling on the markitdown/repomix subprocesses), plus an upfront `Content-Length` check when the header is present.
- **Windows `.cmd` execFile broken on Node ≥ 20.12.** CVE-2024-27980 banned `execFile` of `.cmd` / `.bat` without `{ shell: true }`, and v0.11.0's resolver preferred `repomix.cmd` on Windows — so `git_repo_to_markdown` failed with a cryptic `EINVAL` on **every** Windows install. New `resolveRepomixCommand()` skips the `.cmd` shim and invokes `node node_modules/repomix/bin/repomix.cjs` directly on Windows; the POSIX path is unchanged and the `REPOMIX_PATH` override still wins.
- **`inferExtensionFromUrl` misclassified PDFs.** `url.endsWith('.pdf')` fails for signed S3 URLs (`?X-Amz-Signature=…`), Google Drive downloads (`?export=download`) and `.pdf#page=5` bookmarks — those PDFs were saved as `.html` and run through markitdown's HTML converter, producing garbage. Now tested against `new URL(url).pathname`.
- **Bracketed IPv6 broke `dns.lookup` in the SSRF guard.** `new URL('http://[2001:db8::1]/').hostname` keeps the brackets, and `getaddrinfo` rejects that form with `ENOTFOUND` — so public IPv6-literal URLs failed with a misleading DNS error. Brackets are now stripped at the top of `assertHostnameNotPrivate`, and IP literals short-circuit via `net.isIP` (which also saves a DNS round-trip).
- **`isUnconvertedHtml` missed uppercase `<HTML>`.** The DOCTYPE branch was case-conscious but the bare-`<html` check was lowercase-only, so legacy CMS pages, Office HTML exports and hand-written HTML slipped past the SPA-detection safety net.

### Tests

- **292/292 passing** (was 289 at v0.11.0). New coverage for `resolveAndAssertPublic` (short-circuit + bracket-strip), `resolveRepomixCommand` (env override honoured, structured shape contract), and `assertSandboxConsistent` across all six combinations of `{READONLY, ALLOWED_VAULTS, USER_ID}` × `{with, without MD_ALLOWED_PATHS}`, plus the legacy `MD_SHARE_DIR` alias.

## [0.11.0] — 2026-05-22 — markdownify-mcp vendor port: 10 conversion tools

Ports [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT, TypeScript) to pure ESM JavaScript inside this router: 10 MCP tools that turn PDF, DOCX, XLSX, PPTX, image, audio, YouTube, Bing results, generic web pages and git repositories into clean markdown, via the bundled `markitdown[all]` Python CLI (or `repomix` for git repos).

**Why bundle this into the router** rather than register markdownify-mcp as a sibling MCP server: the vault is the artifact destination, and other MCP clients (Cursor, Cline, Continue, Goose, custom ones) have no native file conversion — bundling makes the router useful beyond Claude. The tools return the markdown **string only**; composition (writing it into a vault) stays explicit on the caller's side, which is also why they take no `vault` argument.

### Added

- **10 MCP tools**, snake_case per router convention. File inputs: `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`. URL inputs: `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`. Git repositories: `git_repo_to_markdown` via [`repomix`](https://github.com/yamadashy/repomix).
- **A JS/ESM port of the upstream TypeScript**, with no Bun and no build step, fitting the router's `*.mjs` architecture: `src/markdownify/utils.mjs`, `src/markdownify/markitdown.mjs`, `src/tools/convert.mjs`.
- **`scripts/install-markitdown.mjs`** — postinstall bootstrap that detects `python3` / `python` (3.10+), creates a repo-local `.venv`, and pip-installs `markitdown[all]`.
- **An inline replacement for the `private-ip` dependency** — the upstream pulls that npm package for its SSRF guard; the port reimplements it in ~25 lines covering loopback, RFC1918, link-local and CGNAT.
- **`MD_ALLOWED_PATHS`** — opt-in sandbox listing which directories the file-input tools may read (`:`-separated on POSIX, `;`-separated on Windows), plus **`MARKITDOWN_PATH`** / **`REPOMIX_PATH`** overrides for system-wide installs.
- **NOTICE** — full MIT vendor credit for markdownify-mcp (Zach Caceres) and attribution for Microsoft's `markitdown` Python CLI.

### Deliberate scoping

- The 10 tools are **not** in `WRITE_TOOL_NAMES`, so `OBSIDIAN_ROUTER_READONLY=true` deployments keep them exposed — they are read-only by nature. *(This turned out to be exactly half right: see the `READONLY` bypass fixed in v0.11.1 below, where read-only-by-nature still meant arbitrary server file reads once a sandbox was absent.)*
- `get-markdown-file` was excluded from the upstream tool list as redundant with the router's own `get_file`.

### Fixed (review findings addressed before ship, 3 passes)

- **SSRF — `isPrivateIp` was bypassable** via IPv4-mapped IPv6 (`::ffff:127.0.0.1`), encoded IPv4 (decimal, hex, octal), bracketed IPv6 hostnames, trailing-dot FQDNs (`localhost.`), IPv6 site-local (`fec0::/10`) and IPv6 multicast (`ff00::/8`). Rewritten around `net.isIP()` with per-family range checks, refusing `::ffff:` and `64:ff9b:` unconditionally and normalising brackets and trailing dots first.
- **SSRF — argv injection.** A `filepath` starting with `-` was interpreted as a flag by the markitdown CLI; fixed with a `--` separator in the `execFile` args, and `--key=value` form for repomix.
- **SSRF — DNS rebinding, and `validateRepoUrl`.** A public hostname resolving to a private IP defeated the textual guard, so an async `assertHostnameNotPrivate()` now runs before every fetch and on **each redirect hop**; and `http://127.0.0.1/repo.git`, `http://[::1]/` and `http://169.254.169.254/` (AWS metadata) were all accepted as repo URLs until `isPrivateIp` was applied to the full-URL form.
- **TOCTOU tempfile.** The predictable `markdown_<pid>_<ms>.html` name enabled a symlink attack on POSIX; replaced with `fs.mkdtempSync()` (atomic, mode 0700) plus cleanup on write failure so no orphan directory is left behind.
- **Symlink sandbox escape.** `MD_ALLOWED_PATHS` used lexical `path.resolve` only, but markitdown follows symlinks — a sandbox-internal symlink to `~/.ssh/id_rsa` escaped. Both the candidate and the allowed roots now go through `fs.realpathSync`.
- **Wrong return shape.** The convert handlers returned the wrapper `{ text }` object instead of the markdown string, and `wrapResult` JSON-stringifies non-strings — so MCP clients received `{"text":"..."}` rather than the markdown.
- Smaller: a Python version check that would have rejected a hypothetical 4.0, a missing fetch timeout (slowloris), an unvalidated `branch` argument passed to `repomix --remote-branch`, and a `package-lock.json` missing the repomix entries (which would have broken `npm ci`).

### Tests

- **289/289 passing.** `tests/markdownify.test.mjs` covers the pure helpers — the SSRF guard across loopback / RFC1918 / link-local / CGNAT, and the `MD_ALLOWED_PATHS` sandbox with path-segment checks. The SSRF guards were additionally smoke-tested directly: `localhost.`, `fec0::1`, `ff02::1`, `2130706433` and `::ffff:127.0.0.1` all blocked, `github.com` still allowed.

## [0.10.3] — 2026-05-22

Closes the "I didn't know there was an update" gap. Ships a SessionStart hook that, at most once per 24 hours, checks GitHub for a newer router version and emits a notice as session context — Claude relays it on the first response, so the user finds out without having to remember to check. Combined with a dedicated [`docs/how-to-update.md`](./docs/how-to-update.md) bilingual guide covering both `/plugin update` and the 5-step manual filesystem path (for environments where `/plugin` is unavailable).

### Added

- **`hooks/check-router-update.mjs`** — SessionStart hook (110 lines, vanilla Node `https` — no new deps). Reads installed version from the plugin's own `package.json`, fetches `https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json`, compares with [`semver-compare`](./src/helpers/semver-compare.mjs), emits a markdown notice to stdout when GitHub is ahead. Cached in `~/.claude/obsidian-mcp-router/.last-version-check.json` with a 24h TTL — within the throttle window the cached notice is replayed (so the user keeps seeing it across sessions without spamming GitHub). **Fails silently** on any error (network, parse, cache I/O) — never disturbs the user. **3-second timeout** on the HTTPS request so offline sessions get at most a 3s session-start delay.
- **`src/helpers/semver-compare.mjs`** — tiny semver parser + comparator (`parseSemver(v)`, `compareSemver(a, b)`). Narrow on purpose: handles `X.Y.Z` and `X.Y.Z-prerelease`, returns 0 on unparseable input (safe fallback — caller treats "can't compare" as "up to date" rather than surfacing a fake update notice). Includes the `0.10 > 0.9` numeric-not-lexicographic rule and the `1.0.0-alpha < 1.0.0` prerelease-is-older convention.
- **`tests/semver-compare.test.mjs`** — 17 new tests covering parse (basic, `v` prefix, prerelease, whitespace, double-digit segments, unparseable, non-string), compare (equal, major/minor/patch dominance, the v0.10-vs-v0.9 trap, prerelease ordering, unparseable fallback). Total test count: **271/271** passing (was 254).
- **`docs/how-to-update.md`** — bilingual EN+FR update guide. Covers: (1) the three discovery paths (built-in hook, GitHub Watch on Releases, periodic blind check), (2) the two application paths (`/plugin update` slash command for environments that have it, 5-step manual filesystem recipe for those that don't — both bash and PowerShell variants), (3) why updates aren't fully auto-applied (Claude Code design choice: plugin authors don't control auto-install — security tradeoff), (4) troubleshooting (notice persists, skipping a release, dev install ahead of main, offline behavior). Linked from README EN+FR under a new "Staying up to date" / "Rester à jour" subsection.
- **`hooks/hooks.example.json`** — the `SessionStart` block now wires up both `hot-cache-load.mjs` AND `check-router-update.mjs`. Fresh installs via the `meta-setup` skill pick up both. Existing setups that hand-rolled their hooks file need to add the second entry (documented in `docs/how-to-update.md`).
- **README sections** — new "Staying up to date" (EN, line ~277) and "Rester à jour" (FR, line ~939) subsections under Install, between `meta-setup` walkthrough and `CLI flags`. Briefly explain the hook, point at `docs/how-to-update.md` for the manual recipe, document the opt-out env vars.

### Opt-out

Either of these env vars skips the check entirely:

- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (truthy: `true` / `1` / `yes` / `on`)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (the multi-tenant audit-log var from v0.9.0 — its presence indicates a multi-tenant deployment where the sysadmin manages updates centrally; the per-user notice would be noise)

### Why

User-facing problem: a user installs the router on day 1 (say v0.8.6), the router gains 4 versions worth of features and fixes over 8 days, and the user has **no way to know** unless they actively go check the repo. There's no badge, no notif, no command that says "you're behind". This is a real UX gap — Claude Code's plugin system currently relies on the user manually running `/plugin update <name>` as a periodic blind check.

Three options for the plugin author to address this:
1. **Hook that notifies** — what v0.10.3 ships. Minimal effort, opt-out, fails silent.
2. **Custom MCP tool** — Claude could invoke `check_router_update` itself. Overkill for what's essentially a static comparison.
3. **README mention only** — pushes the responsibility entirely onto the user. Not enough on its own.

This release goes with (1) + the README mention as a fallback for users who landed via GitHub before installing.

### Privacy

The check is a single anonymous HTTPS GET to `raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json` with the User-Agent `obsidian-mcp-router/check-router-update`. No payload sent. No telemetry. No collection. The cache file (`~/.claude/obsidian-mcp-router/.last-version-check.json`) is local-only — it stores `{ checkedAt: <ms>, notice: <string|null>, installedAtCheck: <version> }`. The hook source is 110 lines of vanilla Node, auditable in [`hooks/check-router-update.mjs`](./hooks/check-router-update.mjs).

### Tests

- 271/271 passing — 254 from v0.10.2 + 17 new `semver-compare.test.mjs` cases.
- `package.json` `test` script extended with `tests/semver-compare.test.mjs`.

### Backward compatible

- The hook is opt-out, not opt-in by default — but a user that doesn't update `hooks.example.json` after v0.10.3 won't get the check (because their personal `hooks.json` still only references `hot-cache-load.mjs`). To activate retroactively on an existing setup, copy the second entry from the shipped `hooks.example.json` into your `~/.claude/settings.json` (or the project-scope equivalent).
- No tool surface change, no MCP-protocol change.
- The `semver-compare` helper is a new module; nothing else in the runtime imports it yet (only the hook does).

## [0.10.2] — 2026-05-22

Discovery hygiene fix for the Claude Code skills panel + marketplace/plugin version sync. The Claude Code "Compétences" UI iterates over both `skills/` and `commands/`, but only items with a real `skills/<name>/SKILL.md` render cleanly — command-only items produce a misleading `Plugin not found: obsidian-router@obsidian-mcp-router-marketplace` error. **All 17 previously command-only entries are now promoted to proper skills**, so every entry the panel surfaces has a backing SKILL.md and the error disappears entirely.

### Added — 17 new skills (1 SKILL.md per previously command-only entry)

**Router-state (3)**:
- **`skills/auto-mode/SKILL.md`** — mode-decision rules (when to pick `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`), bilingual NL phrase → mode mapping, disambiguation of *"stop asking me"* (could mean `off` OR `FullAuto` OR `Hybrid`), homedir refusal caveat, persist defaults inference from *"de manière permanente"*.
- **`skills/lock/SKILL.md`** — single-vault isolation, EN+FR triggers, push-back when already locked to a different vault, homedir refusal caveat.
- **`skills/unlock/SKILL.md`** — lift the lock, EN+FR triggers, gentle no-op surfacing when not locked, info-level reporting when `persist=true` but `.env` had nothing to remove.

**Discovery (2)**:
- **`skills/discover-list-files/SKILL.md`** — list files in a vault directory, vault-prefix path parsing, >50-entry summarization.
- **`skills/discover-list-vaults/SKILL.md`** — list configured vaults (active + disabled), render adaptation based on whether the user asked about active / disabled / both, status-line + table format.

**Read (4)**:
- **`skills/read-get/SKILL.md`** — fetch a file (markdown + frontmatter), `<vault>/<path>` shorthand, frontmatter-as-YAML rendering, large-file truncation policy.
- **`skills/read-frontmatter/SKILL.md`** — read frontmatter (whole object or single key), type-preserving render (number/boolean/array/null/object distinctions kept).
- **`skills/read-search/SKILL.md`** — plain-text substring search, cross-vault fan-out via `vault=*`, suggestion to fall back to `read-search-smart` for semantic queries.
- **`skills/read-search-smart/SKILL.md`** — Smart Connections semantic search, pre-req check (bridge + smart-connections plugins must be installed and indexed), 503-handling.

**Write (5)**:
- **`skills/write-append/SKILL.md`** — append to file, auto-create unless `requireExisting=true`, use-case guidance (journals vs surgical edits → `write-patch`).
- **`skills/write-create-or-replace/SKILL.md`** — create or full-replace, overwrite-confirm safety prompt (preview top 10 lines before clobbering unless user said "overwrite" / "remplace").
- **`skills/write-patch/SKILL.md`** — surgical heading/block/frontmatter edit, FULL heading path footgun (must be `Section::Sub`, not just `Sub`), idempotency flag, common quick patterns.
- **`skills/write-frontmatter-set/SKILL.md`** — single-key set, type inference from $ARGUMENTS (numeric / boolean / null / array / object), `--no-create` flag.
- **`skills/write-frontmatter-merge/SKILL.md`** — multi-key set, non-atomicity warning (partial failures reported per-key), alternative for true atomicity (read + modify + `write-create-or-replace`).

**Manage (2)**:
- **`skills/manage-delete/SKILL.md`** — two-step confirm guard against hallucinated deletes (first call previews + refuses, second call with `confirm=true` actually deletes).
- **`skills/manage-move/SKILL.md`** — move/rename via GET → PUT → DELETE fallback (no native REST endpoint), partial-failure mode reporting (`sourceDeleted: false` + warning).

**Template (1)**:
- **`skills/template-execute/SKILL.md`** — Templater dispatch with the `tp.mcpTools` vs `tp.user.mcpTools` footgun explained with WRONG/RIGHT examples, 503-when-Templater-missing handling.

### Changed

- **All 17 corresponding `commands/<name>.md` files** slimmed to short dispatchers pointing to their skill (same pattern as `commands/autoresearch.md` / `commands/save.md`). The skill is now the source of truth for the rich content; the command file is just the slash-command entry point with a 2-3 line dispatch hint.
- **`.claude-plugin/marketplace.json`** marketplace `metadata.version` and plugin `version` bumped 0.8.6 → 0.10.2. Out of sync with `package.json` since v0.8.6 shipped on 2026-05-14 — the marketplace/plugin manifests now track the package version so `/plugin update` users don't stay on a stale cache.
- **`.claude-plugin/plugin.json`** `version` bumped 0.8.6 → 0.10.2 for the same reason.

### Why

Roland surfaced the bug via screenshot of the Claude Code skills panel: the bottom half of the list showed entries (`auto-mode`, `discover-list-files`, `lock`, `manage-delete`, etc.) with a "Plugin not found" error in the right pane. Root cause investigation showed the plugin is correctly installed at v0.8.6 — the error is the UI's wording for "no `SKILL.md` file found for this entry in the plugin's `skills/` folder". An initial scoped fix only promoted the 4 most NL-trigger-heavy commands, but on Roland's *"je ne veux aucune erreur d'affichage, débrouille toi"* the scope expanded to **all 17** previously command-only entries. Now every entry the panel iterates over has a backing SKILL.md → zero "Plugin not found" errors.

### Backward compatible

- All 17 slash commands (`/obsidian-router:auto-mode`, `/obsidian-router:discover-list-files`, `/obsidian-router:write-patch`, etc.) still work identically — each command file delegates to the matching skill which holds the prior rich content.
- The NL triggers (EN + FR) are preserved verbatim in every skill description, so phrasings like *"passe en mode Hybrid"* / *"liste les fichiers du dossier Sessions"* / *"trouve mes notes sur la taille de position"* / *"supprime Sessions/old-test.md"* continue to fire as before.
- No MCP tool changed. This is a pure plugin-content reorganization (skills/ and commands/).

## [0.10.1] — 2026-05-21

Extends the `roadmap-discipline` convention with a new **section 2bis** that forbids `~~strikethrough~~` on completed roadmap items, AND ships a matching Obsidian CSS snippet that kills the *default* Obsidian rendering style which paints `- [x]` items with line-through styling — defeating the whole convention visually. Both pieces shipped together: the markdown-level rule + the rendering-level fix.

### Added

#### Convention (markdown-level)

- **Section 2bis "Lisibilité — JAMAIS de strikethrough sur les items livrés"** in `skills/conventions/snippets/roadmap-discipline.md` — explicit no-strikethrough rule, retroactive cleanup directive (mention + ask before stripping `~~...~~` from existing roadmaps), and rationale (`- [x]` is the universal markdown convention; strikethrough is decorative noise on top of an already-signaled-as-complete item).
- **Anti-pattern entry** in the same snippet listing strikethrough on shipped items as a forbidden formatting move.
- **Source-trail line** updated to record the v0.10.1 addition with Roland's verbatim trigger phrase.

#### CSS snippet (rendering-level)

- **New file** `templates/reference-vault-skeleton/.obsidian/snippets/no-task-strikethrough.css` — disables `text-decoration: line-through` on `- [x]` items across all 3 Obsidian render modes (Reading view, Live Preview, Source). Covers default + Minimal + Prism + AnuPpuccin theme conventions via `.task-list-item.is-checked`, `.HyperMD-task-line-checked`, and the `--checklist-done-decoration` CSS variable used by theme authors.
- **New file** `templates/reference-vault-skeleton/.obsidian/appearance.json` — pre-enables the snippet via `"enabledCssSnippets": ["no-task-strikethrough"]` on every freshly-bootstrapped reference vault.
- **`cloneSnippets()` + `enableSnippetsInAppearance()`** functions added to `scripts/setup-vault.mjs`. Every `setup-vault.mjs <path>` and `setup-vault.mjs <path> --sync-plugins` invocation now copies `<referenceVault>/.obsidian/snippets/*.css` into the target vault and merges each basename into `<target>/.obsidian/appearance.json` `enabledCssSnippets`. Idempotent: existing snippets are skipped unless `--force`, and an already-enabled basename is not duplicated. Even when the `.css` file is skipped (already present), the `appearance.json` patch still runs — so a vault with the file on disk but not enabled gets fixed automatically on next sync.
- **New CLI option `--sync-all`** in `scripts/setup-vault.mjs` — iterates `portRegistry` and runs `--sync-plugins` on every configured vault in one go (skipping the reference vault itself and any path that's gone missing). Adds `--force` for re-cloning plugins + snippets when the reference vault's content has been updated. Useful for bulk operations like "push a new snippet to every vault" or "refresh every vault to the latest reference plugin versions".

#### HTTP server convention (click-to-open links)

- **`patchRestApiData()` in `scripts/setup-vault.mjs` now applies the `insecurePort = port + 10` + `enableInsecureServer = true` convention** documented in the user's global `CLAUDE.md` (section "Obsidian vault links — v2 click-to-open"). Every freshly-bootstrapped vault gets a working HTTP server on loopback for the bridge's GET `/open/<path>` click-to-open route, so markdown links like `[note](http://127.0.0.1:<port+10>/open/<path>)` open the file in Obsidian on a single click. Each vault gets a unique HTTP port (HTTPS port + 10) so multiple vaults can have HTTP enabled simultaneously without socket collision on the plugin's default `27123`.
- **Why this lives in the script and not the skeleton**: the Local REST API plugin generates its own `data.json` at first launch (with insecure server disabled by default), so the skeleton can't ship the desired config — only `patchRestApiData()`, which runs AFTER the user has launched Obsidian once, can enforce the convention. Pre-v0.10.1 the script set `apiKey` / `port` / `bindingHost` but left `insecurePort` and `enableInsecureServer` at the plugin defaults, leaving every bootstrapped vault unable to serve click-to-open links — silent footgun, only surfaced when Roland tried a generated link and nothing happened.
- **Why HTTP and not HTTPS**: Bitdefender, ESET, Kaspersky (and other AV/EDR products doing HTTPS inspection) silently drop self-signed loopback TLS connections — the request never reaches the plugin, and the browser shows no cert-warning prompt. Plain HTTP on `127.0.0.1` sidesteps the inspection layer entirely. Safe because the `/open/*` route is navigation-only (it calls `workspace.openLinkText`, no read/write/exec); the routes that DO read/write/search files still require the apiKey on the HTTPS port.
- **Retroactive fix for vaults bootstrapped before v0.10.1**: run `setup-vault.mjs <path> --regenerate` (which forces a fresh `patchRestApiData()` call) on each vault, then reload Obsidian on that vault for the plugin to pick up the new config. The `--regenerate` flag also rotates the apiKey — if you want to preserve the existing apiKey, edit `data.json` by hand and set `"insecurePort": <port>+10, "enableInsecureServer": true`.

### Why

Two-layer fix because two layers of the system were producing the same bad visual:
1. **Markdown convention layer** — past sessions wrote `- [x] ~~feature livrée~~` thinking strikethrough emphasised "done". §2bis bans this.
2. **Obsidian default rendering layer** — even with clean markdown (`- [x] feature livrée` without `~~...~~`), the default Obsidian stylesheet applies `text-decoration: line-through` to checked task items. Visually identical to layer 1's anti-pattern. The CSS snippet kills that automatic styling so what the user types is what the user reads.

Roadmaps are re-read constantly during a project's lifecycle to understand "what got done, when, with what commit". Strikethrough hides keywords, breaks grep/Ctrl+F at the human level, and makes long completed-phase blocks visually painful. The checked box `- [x]` already carries 100% of the "done" semantics — no decorative overlay needed, whether the strike comes from the markdown source or from the renderer.

### Backward compatible

- **Convention** is a pure documentation extension. Vaults that already installed `roadmap-discipline` before v0.10.1 keep working — they get the older 5-step rule. To pull in section 2bis, run `/obsidian-router:conventions install roadmap-discipline` again on the target vault: the H2-presence check will detect "already installed" and skip… so prefer `remove` then `install` (the safety-guarded path), or hand-edit the existing CLAUDE.md to append section 2bis directly.
- **CSS snippet** is opt-out per vault — a user can disable it in `Settings → Appearance → CSS snippets` if they prefer the Obsidian default rendering. Existing vaults bootstrapped before v0.10.1 don't automatically receive the snippet at upgrade time: run `setup-vault.mjs <path> --sync-plugins` (or `--force`) to pull it in retroactively, or copy the file by hand from the skeleton.
- The global `~/.claude/CLAUDE.md` has already been updated with the same section 2bis at the time of the v0.10.1 release.

## [0.10.0] — 2026-05-21

Adds a top-level `defaultVaultStatus` field to the `list_vaults` response, and a matching installable convention (`default-vault-health-check`) that tells Claude to surface a natural-language warning with a clickable `obsidian://open?vault=<name>` link when the default vault is offline at session start. Triggered by Roland's observation that an Obsidian app closed at the start of a session produced cryptic `ECONNREFUSED` errors on the first write tool call, with no actionable hint that "open Obsidian" was the fix.

### Added

- **`defaultVaultStatus` field in `list_vaults`** (`src/tools/list-vaults.mjs`) — top-level summary of the default vault's reachability:
  ```js
  {
    name: 'roland',                                    // router slug
    obsidianName: 'Roland',                            // basename, exact case → for obsidian:// URI
    type: 'local',
    online: false,
    error: 'ECONNREFUSED ...',                         // null when online
    missingApiKey: false,
    openUri: 'obsidian://open?vault=Roland',           // pre-built + URL-encoded
    path: 'P:\\Mon Drive\\VAULTS\\Roland',
  }
  ```
  Returns `null` when no default vault is resolved (empty registry / no cascade match) or when the resolved name doesn't match any active vault (pathological post-load mutation — let the consumer surface the inconsistency).
- **`pathBasename(p)` helper** (`src/registry.mjs`) — exact-case basename, cross-platform Windows/POSIX detection identical to `defaultNameFromPath` but **preserves on-disk casing** because the `obsidian://` URI handler can be case-sensitive about the vault label. Exported as a named export (also visible via `_internals`).
- **`buildDefaultVaultStatus(name, pingedResults)` helper** (`src/tools/list-vaults.mjs`) — pure URI/status composition factored out so unit tests can exercise it without network I/O. Handles spaces, accents, and special characters in `obsidianName` via `encodeURIComponent`.
- **New convention snippet** `skills/conventions/snippets/default-vault-health-check.md` — install on any vault via `/obsidian-router:conventions install default-vault-health-check`. The snippet tells Claude to call `list_vaults` at session start, read `defaultVaultStatus`, and if `online: false` compose a natural-language warning with three options (open Obsidian via the `openUri` link, switch vault for the session, or ignore). The snippet auto-installs on every freshly-bootstrapped vault (it's in the library directory that `setup-vault.mjs` clones).
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds the 6th convention to the documented library (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`, `roadmap-discipline`, **`default-vault-health-check`**).
- **17 new tests** in `tests/registry.test.mjs` — 8 cases for `pathBasename` (Windows / POSIX / UNC / leading-dot / edge cases) + 9 cases for `buildDefaultVaultStatus` (online / offline / missingApiKey / null cases / remote vault / spaces / accents / UNC). Total test count: **254/254** passing (was 237).

### Why

Without this, the typical session-start flow was: user launches Claude Code, asks Claude to write a note, Claude calls `write_file` without `vault:`, the router resolves to the default vault, the default vault is offline (Obsidian closed) → `ECONNREFUSED 127.0.0.1:27124`. The user sees a cryptic network error and doesn't know "open Obsidian" is the fix.

The new architecture is **three layers of defense in depth**:
1. **Router code** (`defaultVaultStatus` field) exposes the truth — is the default vault reachable, and what's the clickable `obsidian://` URI to fix it.
2. **Installable convention** materializes the rule in a vault's `CLAUDE.md` for local visibility (useful when sharing a vault with collaborators).
3. **Global `~/.claude/CLAUDE.md`** carries a copy of the rule so it applies by default to every session, even on vaults that haven't installed the snippet locally.

### Backward compatible

- **Additive response field** — `defaultVaultStatus` is a new top-level field. Existing clients that read only `vaults[]` / `defaultVault` / `disabled[]` / `lockedTo` / `autoEnrichMode` continue to work unchanged. No field renamed or removed.
- **No tool surface change** — same 18 tools, same arguments, same schemas.
- **No env-var contract change** — all v0.9.x env vars (`OBSIDIAN_ROUTER_ALLOWED_VAULTS`, `OBSIDIAN_ROUTER_READONLY`, `OBSIDIAN_ROUTER_USER_ID`, etc.) behave identically.
- **Convention is opt-in per vault** — existing vaults stay unaffected until they explicitly install the snippet (or use the global CLAUDE.md copy).

## [0.9.1] — 2026-05-21

Ships a new installable convention — `roadmap-discipline` — that codifies the rule "every roadmap lives in the current vault, and gets updated in the same session as the shipping commits that close its items". Triggered by recurring drift observed on the mcphub-deployment-roadmap (sessions shipping v0.8.12 / v0.9.0 without flipping the corresponding `- [ ]` to `- [x]`).

### Added

- **New convention snippet** `skills/conventions/snippets/roadmap-discipline.md` — install on any vault via `/obsidian-router:conventions install roadmap-discipline`, or auto-install on every freshly-bootstrapped vault (the snippet is in the library directory that `setup-vault.mjs` clones).
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds the 5th convention to the documented library (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`, **`roadmap-discipline`**).

### Why

The convention codifies a three-part discipline:
1. **Creation**: when the user asks for a roadmap, it MUST be created in the current vault (not in `~/.claude/plans/`, not inline-chat, not in the code repo). Path conventions per vault folder pattern.
2. **Maintenance**: every commit that closes a roadmap checkbox must toggle the box, update the phase header (`✅ · livré <date> (v<version>)`), refresh `updated:`, update the "Ordre d'attaque" section, and append a log.md line.
3. **Pre-flight check**: before announcing "Phase X done" in the chat, re-read the roadmap and verify every relevant checkbox is `- [x]`.

A copy of the rule also lives in `~/.claude/CLAUDE.md` (user-global) so it applies to every session by default, even on vaults that haven't installed the snippet locally.

### Backward compatible

- No code change. Pure documentation snippet addition.
- Existing vaults are unaffected until they explicitly run `/obsidian-router:conventions install roadmap-discipline`.

## [0.9.0] — 2026-05-21

Phase 1 of the multi-tenant MCPHub deployment project (see `wiki/obsidian-mcp-router sur Dedibox et MCPHub/mcphub-deployment-roadmap.md` in the meta vault). Three **opt-in** env vars turn the router into a scoped instance suitable for running behind a hub (MCPHub, `mcpo`, a custom gateway) with one router-server-entry per user. Setting no env vars is fully rétrocompat with v0.8.12 — the router behaves exactly as before.

### Added

- **`OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c`** (`src/registry.mjs`) — whitelist of vault names this instance sees. Comma-separated, spaces tolerated. Vaults outside the list go to `skipped[]` with reason `"not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist"`. Applied **before** default-vault resolution, so `defaultVault` falls through to the filtered set instead of pointing at a wiped vault (risk R3 from the pre-Phase-1 audit). 6 new tests in `tests/registry.test.mjs`.
- **`OBSIDIAN_ROUTER_READONLY=true`** (`src/index.mjs`) — disable the 8 write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file`, `delete_file`, `execute_template`). Two-layer guard: write tools are filtered out of `ListTools` AND refused at `CallTool` time, so a client that already knows a tool name and calls it directly is still rejected. Truthy tokens: `true` / `1` / `yes` / `on` (case-insensitive). New test file `tests/readonly.test.mjs` (14 tests).
- **`OBSIDIAN_ROUTER_USER_ID=<slug>`** (`src/index.mjs`) — audit log: every **successful** write tool call appends a line `[claude-write by <slug>] YYYY-MM-DD HH:MM — <tool> path="<path>"` to the touched vault's `wiki/log.md`. Path is extracted via `pickAuditPath(name, args)` which knows the field shape per tool (`args.path` for most, `args.to` for `move_file`, `args.targetPath` for `execute_template`). Best-effort: a failed audit append logs the cause to stderr but never blocks the original write. **Recursion guard**: the audit append uses `restAppendToFile` (REST client) directly, NOT the `append_to_file` tool wrapper — going through the wrapper would loop infinitely. New test file `tests/user-id-audit.test.mjs` (13 tests).
- **New named exports** from `src/index.mjs`: `isReadonlyMode`, `pickAuditPath`, `formatAuditLine`, `_internals` (with `TOOLS`, `TOOL_HANDLERS`, `WRITE_TOOL_NAMES`, `PKG_VERSION`).

### Changed

- **README.md** gains a "Deployment modes" section documenting Local (default, v0.8.x compatible) vs Multi-tenant (opt-in via env vars). Concrete `mcp_settings.json` example for MCPHub deployments.

### Tests

- 237/237 passing — 204 from v0.8.12 + 6 (ALLOWED_VAULTS) + 14 (READONLY) + 13 (USER_ID).
- `package.json` `test` script extended with `tests/readonly.test.mjs` and `tests/user-id-audit.test.mjs`.

### Backward compatible

- All three env vars are opt-in. Unset = exact v0.8.12 behavior.
- No tool surface change for clients that don't set the env vars.
- No MCP-protocol change.
- The audit-log behavior only writes when `USER_ID` is set. The `restAppendToFile` direct call is internal — clients see the same tool semantics.

### Sources

- `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-codex-audit.md` (precondition: TOOL_REGISTRY refactor done in v0.8.12 → see CHANGELOG).
- `wiki/obsidian-mcp-router sur Dedibox et MCPHub/mcphub-deployment-roadmap.md` Phase 1.1 / 1.2 / 1.3 / 1.4.

## [0.8.12] — 2026-05-21

Pre-Phase-1 cleanup: addresses every IMPORTANT and four NIT findings from the `/review+ --mode=snapshot --target=main` audit run during the 2026-05-20 night session (see `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-review-plus-results.md` in the meta vault). Goal: leave the codebase in a clean state before the v0.9.0 multi-tenant env vars (Phase 1) land.

### Changed

- **IMP-3 — unified tool dispatch (`src/index.mjs`)**. Replaced the static `TOOLS` array + manual `switch (name)` dispatch with `TOOLS` + a paired `TOOL_HANDLERS` map plus a **boot-time cross-check** that throws if the two surfaces drift. Pre-v0.8.12 a typo in a `case` would silently surface as `"Unknown tool"` at runtime; now any drift is a structural error at module load. Precondition for v0.9.0's `OBSIDIAN_ROUTER_READONLY` filtering to be uncircumventable.
- **IMP-2 — handshake version (`src/index.mjs`)**. The MCP `Server` constructor used a hardcoded `version: '0.8.2'` that hadn't been bumped since v0.8.2. Now reads from `package.json` at module load (`PKG_VERSION` constant). Can't drift again.
- **IMP-1 — sanitize wire-up extended (`src/tools/list-files.mjs`, `src/tools/get-frontmatter.mjs`)**. Both tools now wrap their return values in `sanitizeResponse(...)` for consistency with `search` / `search_smart` / `get_file`. Closes a gap where a vault-attacker-controlled path or frontmatter scalar could embed ANSI escapes or agentic markup. `sanitizeResponse` preserves non-string types (numbers / bools / arrays in frontmatter) intact.
- **IMP-7 — fingerprint presence marker (`src/helpers/wiki-fingerprint.mjs`)**. `computeFingerprint` now hashes a presence byte (`'1'` for present, `'0'` for missing) BEFORE the canonical body, so an empty-then-deleted file no longer collides with an unchanged-empty file. The hot-cache hook re-fires correctly on the delete now. New test: `IMP-7 regression — empty file vs missing file produce DIFFERENT fingerprints`.
- **IMP-5 — broader injection-tag blocklist (`src/helpers/sanitize.mjs`)**. Added bare-tag variants to `INJECTION_TAGS`: `function_calls`, `function_results`, `invoke`, `parameter`, `env`, `claudeMd`, `currentDate`, `userEmail`. Pre-v0.8.12 the pattern `antml:[a-z_-]+` covered the Anthropic-prefixed family but not the bare variants that show up in Claude Code system reminders without prefix.
- **IMP-4 — conventions `remove` safety guards (`skills/conventions/SKILL.md`, `commands/conventions.md`)**. The skill now mandates: (1) preview of the section to be removed BEFORE write, (2) sidecar backup `CLAUDE.md.bak-<id>-<timestamp>` in the same vault directory, (3) explicit `confirm:true` argument required when targeting `--all` vaults. Backups are never auto-cleaned. Closes a destructive-data risk where users with hand-edited convention sections would lose their customisations on remove.
- **IMP-6 — pickSeeds fallback policy (`src/helpers/idf-score.mjs`)**. `pickSeeds` and `rankAndPick` gained an `opts.fallbackOnAllZero` argument: `'first-n'` (default, pre-v0.8.12 behavior — returns first N candidates) or `'none'` (returns `[]`). Lets call sites that prefer "no result" over "confidently-wrong result" opt out of the silent fallback. JSDoc on `rankAndPick` warns about the trap. Pre-v0.8.12 callers stay rétrocompat.

### Fixed

- **NIT-2 — IDF tokenise tests consolidated (`tests/idf-score.test.mjs`)**. The previously-confusing pair of conflicting tests (`"numbers count as tokens"` saying `tokenise('v0.8.9 released 2026') === ['released', '2026']` and a separate describe-block saying `tokenise('v0.8.9') === []`) is now a coherent narrative with cross-references. The dev-noise comment `"Fix the version-tokens test which I miscounted above"` is gone.
- **NIT-3 — writeFingerprint failures are visible (`src/helpers/wiki-fingerprint.mjs`)**. The silent catch on disk write failures now logs the cause (with `err.code`) to stderr. Behaviour stays non-throwing (the hook degrades to "re-prompt every time" rather than crashing), but the root cause is greppable in logs now.
- **NIT-4 — commands/conventions.md mirrors SKILL safety (`commands/conventions.md`)**. The destructive-remove warning that lived only in the SKILL.md is now also visible in the slash command's documentation, so a user reading `/help` sees the safety guards before invoking `remove`.
- **NIT-5 — defaultIdf throws on empty corpus (`src/helpers/idf-score.mjs`)**. `defaultIdf(0)` previously returned `Math.log(1) = 0`, which silently zeroed every downstream score and surfaced as confidently-wrong drill via the all-zero `pickSeeds` fallback. Now throws a targeted error: misuse is caught at the call site instead of corrupting answers downstream.

### Tests

- 204/204 passing — 198 from v0.8.11 + 6 new tests (1 for IMP-7 regression, 1 for IMP-5 bare-tag neutralisation, 3 for IMP-6 fallbackOnAllZero, 1 for NIT-5 defaultIdf throws). No skipped, no flaky.
- `package.json` `test` script unchanged (same 4 test files: `registry.test.mjs`, `sanitize.test.mjs`, `idf-score.test.mjs`, `wiki-fingerprint.test.mjs`).

### Backward compatible

- All changes are additive or fail-louder. No tool surface change, no MCP-protocol change.
- `defaultIdf(0)` now throws instead of returning 0 — technically a behavior change, but no documented caller passed `0` (the function is meant to be called with a real corpus size).
- `pickSeeds` default behavior is unchanged when `fallbackOnAllZero` is omitted (stays `'first-n'`).
- The `TOOL_HANDLERS` cross-check would throw at module load if you had monkey-patched `TOOLS` from a fork; otherwise transparent.

### Sources

- Code Reviewer Claude pass: `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-review-plus-results.md` (in the meta vault) — verdict "OK to merge with 7 IMPORTANT fixes before Phase 1", 0 BLOCKER.
- Codex pre-Phase-1 audit (codex:rescue sub-agent): converging on the same IMP-3 finding (`TOOLS` static dispatch fragility) — `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-codex-audit.md`.

## [0.8.11] — 2026-05-18

### Added

- **New skill `conventions`** (`skills/conventions/SKILL.md`) + **new slash command `/obsidian-router:conventions`** (`commands/conventions.md`) — manage CLAUDE.md conventions across vaults via `install` / `remove` / `list` / `sync-all-vaults` sub-commands. Solves the recurring problem of "I added a new convention to the template — how do I propagate it to my N existing vaults without rewriting each CLAUDE.md by hand?". Mirror the `auto-mode` and `lock` patterns for consistency: single command, bilingual NL triggers (FR + EN).
- **Convention snippet library** (`skills/conventions/snippets/*.md`) — initial set of 4 conventions shipped, each a self-contained markdown section with a unique `## H2` heading used for both identification (detect-already-installed) and clean removal :
  - `source-type.md` — the `extracted` / `inferred` / `claude_synthesized` provenance vocabulary (added in v0.8.8 to `templates/wiki/CLAUDE.md`; this snippet lets you install it on any vault retroactively)
  - `bilingual.md` — the FR + EN bilingual convention (FR primary)
  - `heading-hierarchy.md` — the mandatory H1 / H2 / H3 rules + type-specific minimums table
  - `auto-enrichment.md` — the 4-mode auto-save dial (ClaudeAsk / Hybrid / FullAuto / off), including activation conditions, 3 triggers, sensitivity filter, hard cap
- **Extensibility** — adding a new convention = creating one new file under `skills/conventions/snippets/<id>.md`. The skill `Glob`s the directory on every invocation, so newly-added snippets appear immediately without a code change to the skill body itself.

### Why

- Before this skill, propagating a new CLAUDE.md convention required either : (a) manually copy-pasting from `templates/wiki/CLAUDE.md` to every vault's CLAUDE.md, or (b) re-scaffolding via `/obsidian-router:wiki` per vault (which works but is heavy-handed). Both options scaled poorly to the 9-vault setup.
- Today during this session we manually patched 5 vaults with the `source-type` convention. With this skill, the same operation is one slash command : `/obsidian-router:conventions sync-all-vaults source-type`.
- The H2-heading-based identification means the skill is **idempotent** — re-running install on a vault that already has the convention skips silently. And **non-destructive on uninstall** — only the exact section is removed, user customisations elsewhere in CLAUDE.md are untouched.

### Documentation / convention change (no code change in this repo)

- **Click-to-open links in chat** — when the bridge plugin (`tboome33/obsidian-mcp-router-bridge`) is ≥ v0.2.0, Claude formatting rule in `~/.claude/CLAUDE.md` emits markdown links of the form `[label](https://127.0.0.1:<vault-port>/open/<url-encoded-path>)` instead of the previous inline-code `obsidian://` URI format. A click in Claude Code's terminal dispatches the http URL → browser hits the bridge's new `GET /open/<path>` public-route → bridge calls `app.workspace.openLinkText` → Obsidian navigates to the file → tab auto-closes. No copy-paste. Falls back to the inline-code `obsidian://` format when the bridge is too old or the endpoint returns 404.
- Bridge plugin v0.2.0 adds the `GET /open/<path>` route via Local REST API's `addPublicRoute()` (loopback-only, no auth — security analysis in the bridge's `CHANGELOG.md` and `README.md#click-to-open`).
- Router-side: no code change for click-to-open. The convention update lives in the user's global `~/.claude/CLAUDE.md`; no router release is required for it, but users who want click-to-open must update the bridge to ≥ v0.2.0 in each vault.

### Backward compatible

- The new skill + command are purely additive (no breaking changes).
- Vaults without the new skill installed still work as before.
- No version bump required on bridge or any other component.

## [0.8.10] — 2026-05-18

Third (and last) of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.C). Closes the Tier 1 train by enforcing **topology-equality short-circuits** on two derivative-content code paths so re-running with the same input costs zero writes and zero commits.

### Added

- **`src/helpers/wiki-fingerprint.mjs`** — port of graphify's `_canonical_topology_for_compare` pattern (`watch.py` rebuild path) to JS:
  - `canonicalise(text)` — normalise CRLF → LF, strip trailing whitespace per line, collapse trailing blank lines, ensure trailing newline. Narrow on purpose: preserves leading whitespace (matters for markdown lists), internal blank lines, internal whitespace.
  - `canonicalHash(text)` — SHA-256 truncated to 128 bits (32 hex chars) of the canonicalised text. Deterministic across runs.
  - `contentIsUnchanged(filePath, newContent)` — fastest path for "should I skip this write?"; returns true iff the existing file canonicalises to the same hash as `newContent`. Returns false if the file is missing.
  - `computeFingerprint(cwd, relativePaths)` — single fingerprint for a SET of files (sorted, deduplicated, missing files treated as empty). Used by the hot-cache hook to dedup re-prompts.
  - `readFingerprint(filePath)` / `writeFingerprint(filePath, fp)` — sidecar I/O for the dedup state. Silent-fail on write (degrades to pre-v0.8.10 re-prompt behaviour).
- **`tests/wiki-fingerprint.test.mjs`** — 37 cases covering canonicalisation invariants, hash determinism, content-unchanged file I/O, set-fingerprint order-independence + dedup + missing-file handling, sidecar read/write round-trip, malformed-fingerprint rejection, and an integration scenario walking the full hot-cache dedup loop. 198/198 total tests passing.

### Changed

- **`hooks/hot-cache-update-prompt.mjs`** — after detecting wiki changes, computes a fingerprint of the substantive (non-`hot.md`) changed files. If the fingerprint matches what was stored after the previous fire (in `.vault-meta/hot-prompt-fingerprint`), exits silently. Stores the new fingerprint after each fire. Breaks the re-prompt loop that happened when Claude saw the nudge but didn't refresh `hot.md` — the next Stop hook used to fire again with identical state. Whitespace-only edits to wiki files also no longer trigger re-prompts (canonical equivalence is the dedup key).
- **`skills/wiki-fold/SKILL.md`** — new step 4.5 ("Topology-equality short-circuit") instructs the skill to read the existing fold page, canonicalise both bodies, and **skip the write + index update + log entry triplet** if they match byte-for-byte. The "Idempotency contract" section now reads as a two-part guarantee: structural (deterministic naming + sorted output + ISO timestamps) AND operational (the step-4.5 short-circuit enforces it at the disk level). Re-running `/wiki-fold` with the same window now costs one read and zero writes.

### Why

- The PostToolUse auto-commit hook commits every write that touches `wiki/`. Without the short-circuits, two no-op patterns polluted `git log` over time:
  1. `/wiki-fold` re-runs with the same window produced byte-equivalent fold pages but `write_file` still touched the file, the auto-commit recorded a commit, and `git log` accumulated empty "no-op fold" entries. Worse: the auto-commit log was sometimes the ONLY entry between meaningful work, making the history harder to scan.
  2. The Stop hook re-fired the hot.md refresh nudge on every conversation turn that touched wiki/, even when state was identical to what it had just prompted about. Claude rightly ignored the duplicate nudges, but they cluttered the conversation transcript with `WIKI_CHANGED` noise.
- graphify hit the exact same family of issues and solved both with the canonical-equality pattern (`_canonical_topology_for_compare` for the graph file, `topology-equality post-rebuild check` for skipping clustering re-runs). The pattern transfers verbatim — only the format-specific canonicalisation differs (their JSON-sorting → our markdown line-stripping).

### Tests

- 198/198 passing — 161 from v0.8.9 + 37 new wiki-fingerprint cases.
- `package.json` `test` script extended to include `tests/wiki-fingerprint.test.mjs`.

### Backward compatible

- The fingerprint helper is a new module. `hooks/hot-cache-update-prompt.mjs` imports it via relative path `../src/helpers/wiki-fingerprint.mjs` — works for users who installed via `git clone` + `npm link` (the canonical setup); also works for `npm install` distribution because `src/` is in `package.json` `files`.
- The wiki-fold skill change is purely additive (a new step 4.5 between existing steps 4 and 5). Folds without changes now produce a "no changes written" output instead of a write-cycle, but the wire shape of the result is the same.
- `.vault-meta/hot-prompt-fingerprint` is a sidecar file the user can safely delete to reset the dedup state (next Stop hook will then re-fire as before). Recommended `.gitignore` entry: `.vault-meta/`.
- No tool surface change, no MCP-protocol change, no breaking change.

## [0.8.9] — 2026-05-18

Second of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.B). Adds IDF-weighted candidate scoring with dynamic seed selection — the algorithm that ranks pages against a free-text query and prevents weak-runner-up dilution.

### Added

- **`src/helpers/idf-score.mjs`** — port of graphify's `_compute_idf` + `_score_nodes` + `_pick_seeds` (`graphify/serve.py:300-325`) to pure JS:
  - `tokenise(text)` — lowercase + Unicode-aware non-word split + filter tokens ≤ 2 chars.
  - `computeIdf(documents)` — corpus-wide `idf(t) = log(1 + N / (1 + df(t)))`. Suppresses noise terms like `user`, `error`, `the` that appear in many documents.
  - `scoreCandidates({ query, candidates, idf })` — three-tier per-term scoring: exact ×1000, prefix ×100, substring ×1. `secondaryLabel` field matched at ×0.5 weight (use for folder paths / breadcrumbs). Returns candidates sorted by score descending.
  - `pickSeeds(scored, { maxSeeds=3, dominanceRatio=5 })` — returns the top candidate only when its score is more than 5× the runner-up (graphify's fix for issue #897 — dominant matches shouldn't be diluted by weak runner-ups). Otherwise returns up to `maxSeeds`.
  - `rankAndPick({ query, candidates, idf })` — one-shot convenience wrapping the three above.
- **`tests/idf-score.test.mjs`** — 40 cases covering tokenisation (Unicode, version strings, snake_case), IDF formula correctness + iterable input, exact/prefix/substring score tiers, secondary-label half-weight, alias support, IDF down-weighting of common terms, dynamic seed cutoff at exact ratio boundary, all-zeros fallback, and a regression test for graphify issue #897. 161/161 total tests passing.
- **`skills/wiki-query/SKILL.md`** — tier 2 ("index.md") rewritten as a three-step IDF-weighted ranking + dynamic-seed cutoff procedure that Claude follows when picking 1-3 candidate pages to drill into. Tier 5 ("synthesize") now requires confidence-aware citations using the `source_type` frontmatter introduced in v0.8.8 (`(extracted)` / `(inferred)` / `(synthesized)` annotations on every wikilink in the rendered answer).

### Why

- The previous `wiki-query` tier-2 selection ("scan for matching titles, pick 1-3 most relevant") had two recurring failure modes:
  1. **Equal weight per query token.** A question containing one common term ("user") and one rare term ("kelly") gave both equal weight, so a wiki with a `user notes` page and a `kelly criterion` page would surface both equally rather than recognising that "kelly" is the discriminating term. IDF down-weights common terms automatically.
  2. **Always-3-candidate drill.** Even when one page clearly dominated, the skill drilled into two more weak matches and the synthesis became muddled. Dominant-match-only cutoff (graphify's `_pick_seeds`) fixes this — if the top scores >5× the runner-up, drill into ONLY the top.
- The helper is the canonical implementation that T2.A (`wiki-neighbors`), T2.B (`wiki-path`), T2.C (`wiki-explain`), and T3.A (`wiki-export-graph` search bar) will all import for endpoint resolution and result ranking. Shipping it now means those downstream tools don't need to re-implement.
- Combined with v0.8.8's `source_type` vocabulary, the wiki-query answer now tells the reader at a glance whether each cited claim is grounded (`extracted`), interpreted (`inferred`), or synthesised (`synthesized`). Different trust levels become visible without manual frontmatter reading.

### Tests

- 161/161 passing — 121 from v0.8.8 + 40 new IDF-score cases.
- `package.json` `test` script extended to include `tests/idf-score.test.mjs`.

### Backward compatible

- The helper is a new module; nothing imports it yet from the main router runtime. Only `wiki-query` skill (instructions to Claude) consumes it conceptually.
- No tool surface change, no MCP-protocol change, no breaking change.
- v0.8.8's `source_type` annotations from `wiki-query` citations gracefully degrade to `(unmarked)` for pre-v0.8.8 pages without the frontmatter field.

## [0.8.8] — 2026-05-18

First of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.A for the design rationale). Two independent additions packaged together because they both address source-provenance hygiene.

### Added

- **`sanitizeLabel()` / `sanitizeContent()` / `sanitizeResponse()` helpers** in new `src/helpers/sanitize.mjs`. Strip ANSI CSI/OSC escape sequences and control characters from any string that came from a vault before it flows back through MCP into Claude's context. `sanitizeContent` additionally neutralises a narrow set of agentic-markup tokens (`<system-reminder>`, `<tool_use>`, `<*>`, `<assistant>`, etc.) by HTML-encoding the leading `<` — preventing a corpus-injected document from hijacking the model. Length caps default to 16 KiB for labels and 1 MiB for full-page content; both overridable per call site. 33 new test cases in `tests/sanitize.test.mjs` (121/121 total passing).
- **Wire-up in three tools** on the response path:
  - `src/tools/search.mjs` — every match string goes through `sanitizeResponse`.
  - `src/tools/search-smart.mjs` — semantic-search results (breadcrumbs, excerpts, paths) go through `sanitizeResponse`.
  - `src/tools/get-file.mjs` — string-form file content goes through `sanitizeContent` (larger cap, neutralisation ON). Structured-form responses (frontmatter JSON via `application/vnd.olrapi.note+json`) pass through untouched to preserve type fidelity.
- **`source_type` frontmatter vocabulary** documented in `templates/wiki/CLAUDE.md` as a new mandatory section "Source provenance". Three values borrowed verbatim from graphify's `EXTRACTED / INFERRED / AMBIGUOUS`:
  - `extracted` — verbatim or near-quote from a source.
  - `inferred` — derived from a source but not written verbatim.
  - `claude_synthesized` — pure synthesis by Claude.
  - Inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]` for per-paragraph overrides on mixed-provenance pages.
- **Skill updates** — `skills/wiki-ingest/SKILL.md` step 4 (source frontmatter) and step 5 (entity/concept frontmatter) now write `source_type`. `skills/save/SKILL.md` step 4 (frontmatter) documents how to pick the right value per saved-content kind.

### Why

- **Prompt-injection defence.** Vault content is user-authored at best, attacker-authored at worst. Without sanitisation, a malicious file could embed ANSI escapes (corrupting terminal output, hijacking PowerShell scroll buffer on Windows — graphify hit this with graspologic's stderr) or agentic markup (`<system-reminder>ignore all previous</system-reminder>`) that flips Claude's behaviour mid-tool-call. graphify takes this seriously enough to file it as `F-010` in their threat model (`serve.py:261-264`); the router had the same exposure with zero defence.
- **Provenance hygiene.** Until today, a wiki page didn't tell you whether an assertion was a verbatim quote from a source or a synthesis Claude wrote. Three-bucket tagging closes that gap with one frontmatter field per page (plus inline callouts where granularity matters). Downstream features (T1.B IDF citations, T2.D wiki-lint quality flags, T3.A confidence-aware viz) all build on this foundation.

### Tests

- 121/121 passing — 88 pre-existing + 33 new sanitize cases (clean strings, ANSI strip, control-char strip, injection neutralisation in both off/on modes, length caps, real-world markdown regressions including wikilinks/callouts/unicode/frontmatter).
- `package.json` `test` script now lists both test files explicitly (`node --test tests/registry.test.mjs tests/sanitize.test.mjs`) — `node --test tests/` was attempted but Node 20+ interprets a bare directory path as a module rather than a test-discovery root.

### Backward compatible

- Existing wiki pages without `source_type` continue to work — the field is purely additive metadata.
- All tool response shapes are unchanged; sanitisation is in-place string cleanup, not schema change.
- No new MCP tools, no new dependencies.

## [0.8.7] — 2026-05-17

### Added
- **`--bootstrap-reference` command** in `scripts/setup-vault.mjs` — a one-command way to create a fresh reference vault for users cloning the repo from GitHub. Scaffolds from the shipped skeleton, downloads the bridge plugin from its GitHub release, and records the path as `referenceVault` in `~/.claude/obsidian-mcp-router/config.json`. Follow up with `--init-reference <path>` after installing the marketplace plugins via Obsidian to validate and reserve the port.
- New [`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/) directory committed to the repo, containing the canonical starting content for a reference vault: `.obsidian/community-plugins.json` (5-plugin list aligned with the author's `.template`), `.obsidian/app.json`, `.smart-env/smart_env.json` (transformers embedding model, API key field empty for safety), `.claude/settings.json` (Claude Code project settings that enable the `obsidian-router` plugin in this vault), `CLAUDE.md` (LLM-wiki navigation rules), `wiki/{index,log,hot,overview}.md` (Karpathy LLM-wiki scaffolding), and a `README.md` documenting what's in and what's intentionally out.
- New "Fast path" section at the top of [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) — points new users at `--bootstrap-reference` first; the existing manual procedure remains as the long-form reference for customization and troubleshooting.

### Why
- Before this change, anyone cloning the repo had no path to acquire the author's reference vault — `.template` lives only on the author's machine for licensing + secrets reasons (plugin `main.js` files are third-party copyrighted artifacts under MIT/GPL-3.0, and `obsidian-local-rest-api/data.json` contains a TLS cert + private key + API key in cleartext). The manual procedure required ~6 steps with the `mcp-router-bridge` folder-vs-id naming gotcha tripping up most first-time users.
- The fast path turns onboarding into one command + one Obsidian session (click "Install" on the 4 plugin prompts Obsidian raises from the shipped `community-plugins.json`) + one `--init-reference` finalizer. The plugin selection ships in the skeleton's `community-plugins.json` so the consumer's vault matches the author's set by default.

### Plugin acquisition strategy
- The **bridge plugin** (only required plugin not in Obsidian's marketplace) is auto-downloaded from `github.com/tboome33/obsidian-mcp-router-bridge/releases/latest/download/{main.js,manifest.json}` via Node's built-in `https` module — no new dependency.
- The **four marketplace plugins** (Local REST API, Smart Connections, Templater, Quiet Outline) are installed through Obsidian itself when the user opens the freshly-scaffolded vault: Obsidian sees their IDs in `.obsidian/community-plugins.json` without matching folders under `.obsidian/plugins/` and prompts to install.

## [0.8.6] — 2026-05-14

### Added
- **`obsidian-quiet-outline`** added to `OPTIONAL_PLUGINS` in `scripts/setup-vault.mjs`. Quiet Outline is a community plugin that replaces the core Obsidian Outline with a much better sidebar — searchable headings, collapse/expand, drag-to-resize, sync with scroll, markdown rendering of heading text. Newly bootstrapped vaults (and existing vaults synced via `--sync-plugins`) will now clone it from `.template` automatically.
- Operator note: install Quiet Outline once in `.template` via Obsidian's community plugin browser (or drop `main.js` + `manifest.json` + `styles.css` from the [v0.5.12 release](https://github.com/guopenghui/obsidian-quiet-outline/releases/tag/0.5.12) into `.template/.obsidian/plugins/obsidian-quiet-outline/`), then enable it in `.template/.obsidian/community-plugins.json`. From that point on the plugin propagates with the rest.

### Why
- Core Outline plugin is minimal — no search, no collapse, must re-open the panel on every note change unless pinned. On the user's typical wiki note (1500-4500 words, 10-15 H2, 10-20 H3), this gets unwieldy. Quiet Outline fixes the ergonomics without changing the underlying convention (still relies on H1/H2/H3 hierarchy from v0.8.5 consigne).

## [0.8.5] — 2026-05-08

### Added
- **Mandatory heading-hierarchy consigne** in `templates/wiki/CLAUDE.md` (and the personal-mode customization in `.template/CLAUDE.md`). Every wiki page must have exactly one `# H1` at top + at least two `## H2` sections if > 200 words. Type-specific minimums per `type` frontmatter (`session` → Prompt/What happened/Outcome, `decision` → Context/Decision/Consequences, `concept` → Definition/Why it matters/Related, `reference` → Summary/Key takeaways/Source, etc.). The skill pushes back when content is too thin: file as a one-liner in `wiki/facts.md` instead of producing a flat single-section page.
- Light reinforcement of the rule in `skills/save/SKILL.md` step 5 ("Write the body") and `skills/wiki-ingest/SKILL.md` step 4 (source filing) + step 5 (entity/concept pages) — both now spell out the H2 sections per type and reference the CLAUDE.md rule.
- New [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) — step-by-step guide to creating the reference vault that `setup-vault.mjs` clones from. Covers required vs. optional plugins, the `mcp-router-bridge` folder-vs-id naming gotcha (folder must be `mcp-router-bridge` to match the manifest id, even though the GitHub repo is `obsidian-mcp-router-bridge`), update workflow, and troubleshooting. Linked from the README install requirements (EN + FR).

### Fixed
- `scripts/setup-vault.mjs` — required-plugin check at line 64 now expects `mcp-router-bridge` (the actual plugin id from the upstream `manifest.json`) instead of `obsidian-mcp-router-bridge` (the GitHub repo name). Aligns with the canonical Obsidian convention that folder name must match the manifest id. Pre-existing vaults with the divergent name keep working — only newly bootstrapped vaults are affected.

### Why (headings hierarchy)
- Obsidian's **Outline** panel (and any heading-aware navigation) is empty on flat pages with only an H1 + paragraphs. Long notes become unscannable. Auto-generated content from `/save`, `/wiki-ingest`, etc. previously varied in structure; now it must obey a documented hierarchy.
- Documented in the vault consigne so the rule applies cross-skill (and to manual Claude conversations bound to the vault), not just the explicit skill invocations.

## [0.8.4] — 2026-05-08

### Added
- **`meta-setup` skill** now guides users through raising `skillListingBudgetFraction` in `~/.claude/settings.json` from the default 1% to 5% (recommended for router users — see below). Detects under-budgeted setups, asks for confirmation, merges the change without touching unrelated keys, and handles the Windows UTF-8 BOM edge case.
- README install section (EN + FR) — new callout explaining the recommendation, the symptom (`Skill listing will be truncated — N descriptions dropped`) it fixes, and pointing at `meta-setup` for interactive application.

### Why
- The router contributes ~30 skills (slash commands + skills) to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`), the budget is exceeded once router + Anthropic defaults + any other plugin are loaded, and skills like `/save`, `/wiki`, `/autoresearch` get truncated or dropped — silently breaking natural-language triggering.
- Recommended bump to `0.05` (5%) costs ~6k extra tokens per session and keeps the full listing intact. Existing users seeing the warning can apply the same fix manually or via `meta-setup`.

## [0.8.3] — 2026-05-08

### Changed
- **Skill listing budget cleanup** — trimmed descriptions of 13 slash commands that duplicate a skill of the same name (`autoresearch`, `canvas`, `defuddle`, `meta-add-vault`, `meta-setup`, `meta-status`, `obsidian-bases`, `save`, `wiki`, `wiki-fold`, `wiki-ingest`, `wiki-lint`, `wiki-query`). The skill now owns the rich natural-language triggering description; the command keeps only a one-line palette label that points back to the skill. Saves ~1500 tokens of skill-listing budget per session, eliminates the per-entry-cap warning that previously dropped 46 descriptions on busy setups.
- No behavioral change: slash commands still invoke the same skill body, natural-language triggers still resolve through the corresponding skill.

## [0.8.2] — 2026-05-03

### Added
- **Wiki auto-enrichment Phase 1** — 4-mode dial (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`) with runtime toggle and `.env` persistence (`OBSIDIAN_ROUTER_AUTO_ENRICH`). Mirrors the v0.8.0 lock-mode architecture.
- New MCP tool `set_auto_enrich_mode({ mode, persist? })` with case-insensitive + alias canonicalization (`ask`/`auto`/`semi`/`none`).
- New slash command `/obsidian-router:auto-mode <Mode>` with bilingual NL triggers + per-mode use-case bullets in the description.
- New `validateAutoEnrichMode(candidate, context)` helper exported from `src/index.mjs` — fall-through-with-warning on invalid env var (mirrors `validateLock`).
- `list_vaults` response gains 5th field `autoEnrichMode`.
- New [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) (EN+FR) — full guide with use cases per mode + 4 placement channels.
- New `templates/wiki/CLAUDE.md` consigne with mode-dependent behavior at each of the 3 triggers (validation pin / result digest / topic-switch checkpoint).
- New `commands/auto-mode.md` slash command (Phase 1 toggle).
- New bilingual quick-reference PDFs ([FR](./docs/quick-reference-fr.pdf), [EN](./docs/quick-reference-en.pdf)) — 5 pages each, accessible 11pt fonts.
- `setup-vault.mjs` now clones `quick-reference-{fr,en}.pdf` into bootstrapped vaults via `ROOT_FILES_TO_CLONE`.

### Fixed
- **Critical (post-push, Codex audit)** — `set_auto_enrich_mode({ mode: "off", persist: true })` now writes `OBSIDIAN_ROUTER_AUTO_ENRICH=off` literally to `.env` instead of removing the line. Previously the line was deleted, but startup defaulted absent values to `ClaudeAsk` — silently re-enabling auto-suggestions on sensitive vaults at next restart. The success message was also lying ("off across restarts" → false).
- `commands/auto-mode.md` NL trigger ambiguity: phrases like "stop asking me" no longer auto-map to `FullAuto`; the command now disambiguates between `off` / `Hybrid` / `FullAuto` before invocation.
- `templates/wiki/CLAUDE.md` Trigger 2/3 FullAuto branches now explicitly restate the sensitivity filter gate (was implicit, easy to misread).
- Tests for `lock_vault` + `set_auto_enrich_mode` homedir refusal now assert that `~/.env` was NOT created/mutated when the call was rejected (parity fix).

### Tests
- 88/88 passing.

## [0.8.1] — 2026-05-03

### Added
- **Wiki auto-enrichment Phase 0** — Claude proactively suggests wiki saves at 3 triggers: validation pin (inline `🔖`), result-obtained digest, topic-switch checkpoint. Mode hardcoded to `ClaudeAsk` (always confirm).
- `templates/wiki/CLAUDE.md` ships the consigne; future vaults scaffolded via `/obsidian-router:wiki` get it automatically.
- README EN+FR callout with link to the placement guide.

### Note
- Plugin-side update only (no npm router package change). Existing vaults need to re-pull the consigne section into their own `CLAUDE.md`.

## [0.8.0] — 2026-05-03

### Added
- **Lock mode (single-vault isolation)** — `lock_vault({ vault, persist? })` and `unlock_vaults({ persist? })` MCP tools. While locked, every tool call to a different vault throws; cross-vault fan-out (`vault: "*"`) is refused; calls without explicit `vault` resolve to the locked one.
- New `OBSIDIAN_ROUTER_LOCKED=<vault>` env var, read at startup, written by `lock_vault({ persist: true })`.
- New slash commands `/obsidian-router:lock` and `/obsidian-router:unlock` with bilingual NL triggers.
- `list_vaults` response gains 4th field `lockedTo: <name>|null`.
- New `validateLock(candidate, vaults, context)` helper exported from `src/index.mjs`.
- New `applyLockGuard()` exported helper that monkey-patches `registry.resolveVault()` so every existing tool call site inherits the check.
- README EN+FR: new "Lock mode" section with three concrete cases (volatile, permanent for shared install, switching target).
- Tests: 19 new cases covering set/unset, persist round-trip, homedir refusal, hot-reload preserve.

### Fixed
- **Critical** — `samePath()` Windows case-insensitive comparison so a homedir refusal can't be bypassed by typing `C:\Users\alice` vs `C:\Users\Alice`.
- `upsertDotenvVar` now updates the FIRST occurrence (matches the reader convention in `bin/obsidian-mcp-router.mjs`).
- Hot-reload preserves the lock state across config reloads, but revalidates so disabling the locked vault drops the lock instead of bricking.

## [0.7.1] — 2026-05-02

### Added
- `list_vaults` exposes disabled vaults — `disabled: [{ name, type, reason }]` field surfacing what was skipped by `disabledVaults` config.

## [0.7.0] — 2026-05-02

### Added
- Per-workspace default vault resolution — 5-tier cascade: `OBSIDIAN_ROUTER_DEFAULT_VAULT` env > `VAULT_PATH` env auto-detection > `config.defaultVault` > first healthy local > first active.
- `setup-vault.mjs` writes `VAULT_PATH=<path>` into each bootstrapped vault's `.env` so opening Claude Code in a vault directory "just works".

## [0.6.0] — 2026-04-30

### Added
- Knowledge management skill stack (10 commands): `/wiki`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-fold`, `/save`, `/autoresearch`, `/canvas`, `/defuddle`, `/obsidian-bases`.

## [0.5.0] — 2026-04-29

### Added
- Rebrand cleanup, integrated setup scripts, runtime hardening.

## [0.4.x] — 2026-04-28

### Added
- v0.4.0: frontmatter helpers (`get_frontmatter`, `set_frontmatter`, `merge_frontmatter`), `move_file`, `RestApiError` typed error class with categorized `kind` + `hint` fields.
- v0.4.1: onboarding skills (`meta-setup`, `meta-add-vault`, `meta-status`).
- v0.4.2: hot config reload (router watches `~/.claude/obsidian-mcp-router/config.json` and re-loads on changes).

## [0.3.0] — 2026-04-27

### Added
- Write operations (`write_file`, `append_to_file`, `patch_file`, `delete_file`) and Templater execution (`execute_template`) — all via the bridge plugin.

## [0.2.0] — 2026-04-26

### Added
- Semantic search (`search_smart`) via the bridge plugin's `/search/smart` route.

## [0.1.0] — 2026-04-25

### Added
- Initial release: `list_vaults`, `list_files`, `get_file`, `search` MCP tools over the Local REST API plugin. Multi-vault routing via `vault` parameter or default-vault resolution.

---

Full per-version implementation notes (architecture decisions, alternatives considered, deferred Phase 2/3 work, etc.) live in [ROADMAP.md](./ROADMAP.md).
