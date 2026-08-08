# AGENTS.md — operating contract for obsidian-mcp-router

Host-neutral instructions for any coding agent working in this repository. Codex, Gemini CLI,
Cursor and Windsurf are all documented as reading this file; per-host provenance — which paths
were confirmed and which are taken on a vendor's word — is recorded in
`contracts/agent-host-targets.json`. Nothing here assumes a particular harness.

This file is read automatically and will steer actions. Treat it as code: every backticked
repository path and every `npm run` script below is resolved against the filesystem and against
`package.json` by `tests/agents-md-contract.test.mjs`, which fails the suite when one goes stale.
That check does not cover prose, so the rule stands for the rest: do not add a claim here you
have not run.

## What this repository is

An MCP server that routes tool calls to one or more Obsidian vaults over each vault's Local REST
API, packaged together with the skills, slash commands, agents and hooks that drive it. Node
`>=20.18.1`, ESM only (`"type": "module"`), no build step — the source in `src/` is what runs.

Layout, all paths relative to the repository root:

| Path | What lives there |
|---|---|
| `bin/` | CLI entry point for the MCP server |
| `src/` | Server, tool implementations, helpers |
| `scripts/` | Operational CLIs (setup, validation, gates, release) |
| `skills/` | The know-how pages — one directory per skill, each with a `SKILL.md` |
| `commands/` | Slash-command definitions |
| `agents/` | Sub-agent definitions |
| `hooks/` | Session hooks |
| `contracts/` | Machine-checked declarations (see below) |
| `templates/` | Files copied into vaults during setup |
| `tests/` | `node:test` suites |
| `docs/` | Long-form documentation |

## The three gates

Run all three before claiming anything is finished. They are independent and catch different
failures.

| Command | What it proves |
|---|---|
| `npm test` | The suites pass. |
| `npm run validate` | Code, documentation and `contracts/skill-capabilities.json` tell the same story. A new skill or tool that is not declared fails here. |
| `npm run gate` | Nothing outside `contracts/export-allowlist.json` would be published, and no credential or private path is inside what would. |

One more check, for the portability surface added by this file:

| Command | What it proves |
|---|---|
| `npm run audit:skills-portability` | Every `SKILL.md` frontmatter stays inside the portable subset, or its deviation is declared. Add `-- --strict` for the spec-distribution view. |

`npm run install:agent-rules` belongs beside those but is a tool, not a gate: it previews (and
with `--apply`, writes) the per-skill index other agent hosts read. It exits non-zero when any
target is **refused** — an ambiguous marker state, or a host whose character cap the index cannot
fit — so a non-zero exit there reports the state of your machine's rule files, not a broken
repository.

## Contracts — the parts that fail loudly on drift

- `contracts/skill-capabilities.json` — what each skill reads, writes and calls. Adding a skill,
  a tool or an agent without declaring it here makes `npm run validate` exit non-zero.
- `contracts/export-allowlist.json` — an allowlist, not a deny list. A file ships because it is
  named there. A deny list once shipped a live token because the directory was created after the
  exclusions were written.
- `contracts/agent-host-targets.json` — where each foreign host reads its rules, and which
  frontmatter keys are portable. Host knowledge lives there, not in the installer.

Two export surfaces, and they differ: `npm run gate` scans the bundle, which excludes `tests/`;
the release scan covers the source archive, which includes `tests/`. A fixture that is fine for
one can block the other.

## Using the skills (the bridge rule)

`skills/` holds the operating know-how this repository has accumulated — one directory per
subject, each with a `SKILL.md`. Knowing the manuals exist is not the same as consulting them, so:

- **When a request matches a skill, read that skill's `SKILL.md` in full before acting.** Not the
  index entry, not the description — the page. Its body is **normative**: procedures, orderings
  and refusals in it are requirements, not suggestions.
- **Read it before the first action, not after the first failure.** These pages exist because the
  failure already happened once to someone.
- **If the skill requires a capability your host does not have** — an MCP tool that is not
  registered, a binary that is absent — **say so and stop.** Report the missing capability. Do not
  approximate the procedure with whatever tools you do have: a half-executed vault write is worse
  than a refusal, and the page was written on the assumption that its steps run in order.
- Skills are loaded on demand by design. Read the one the task calls for; do not preload the set.

## Source precedence

One directory is the source; the rest are copies, and editing a copy loses the edit.

| Path | Status |
|---|---|
| `skills/` | **Canonical.** Edit here. |
| `commands/`, `agents/`, `hooks/`, `templates/`, `contracts/` | **Canonical.** Edit here. |
| `mcpb-staging/` | **Generated** build output. Never edit; never cite as source. |
| a git worktree copy of this repo | **Generated** working copy. The canonical tree is the one this file sits in. |

If the same file appears under a canonical path and a generated one, the canonical path wins and
the generated one is stale by construction.

## Definition of done

**Changing an MCP tool.** Update the implementation in `src/`, then its entry in
`contracts/skill-capabilities.json`, then any `SKILL.md` that calls it. `npm run validate` fails
when code, documentation and manifest disagree — that failure is the feature, not an obstacle.

**Changing or adding a skill.** Edit `skills/<name>/SKILL.md`, declare it in
`contracts/skill-capabilities.json` (an undeclared skill fails `npm run validate`), and keep the
frontmatter inside the portable subset — check with `npm run audit:skills-portability`.

**Shipping any new file.** Export is an allowlist, so a new file ships only if it is named in
`contracts/export-allowlist.json`. Deciding not to ship it is a valid answer; *not deciding* is
not, because the file then silently never reaches users. Confirm with `npm run gate`.

**Before calling anything finished**: `npm test`, `npm run validate`, `npm run gate` — all three,
all green, on the tree you are about to hand over.

## House rules

**Measure, do not recall.** Never state a count, a version or a size you did not just produce.
Always give the denominator — report `matched/total`, never a bare `matched`. Numbers in older
documents in this repository are snapshots and several are already wrong; re-count rather than
quote them.

**No green without a mutation.** A test that has never been seen to fail has not been shown to
test anything. Before reporting a passing test, break what it covers, watch it go red, restore
the file, and confirm the restore by hash. A test that stops finding its target is not a pass —
it is a measurement that did not happen.

**Do not confuse reading a file with testing it.** Asserting that a document contains a sentence
proves the spelling of the sentence. If the claim is behavioural, execute it: run the command the
document names and compare the result, or drive the code and inspect the effect.

**Unavailable is not green.** When a check depends on something absent from the machine — a
binary, a network, a running vault — it must report that it was skipped and why. Silently passing
a check that never ran is worse than failing.

**Never restore with git.** `git checkout --`, `git restore`, `git stash` and `git clean` discard
uncommitted work, and this repository is often worked on from more than one session at a time.
Restore by copying a file back and verifying it by hash. For the same reason, do not stage with
`git add -A`; stage the paths you touched.

**Never commit, tag or push unless asked.** Version numbers are bumped by `npm run bump`, which
syncs several files at once and arms a commit hook; releases go out through `npm run release`.
Do not hand-edit a version, do not create a tag by hand, and do not run `npm version`.

## Test rules

- Tests must not write outside a temporary directory. Create one with `fs.mkdtempSync`, and when
  a test exercises anything that resolves a home directory, override `HOME`, `USERPROFILE`,
  `HOMEDRIVE` and `HOMEPATH` for the child process. Real vault directories and real host
  configuration directories are off limits.
- A fixture never needs a real private path to prove a public property. The release scan reads
  `tests/`, so a machine-specific path in a fixture blocks a release after the tag exists.
- `tests/session-auto-journal.test.mjs` has a known intermittent failure. An isolated red there
  is worth re-running before it is investigated.

## Files not to open

The `.codex` directory is gitignored and holds machine-local configuration including a live
credential. Do not read it, copy it, quote it, or add it to any export surface. The rules
installer has no code path that can name a file its host contract does not name, and it refuses a
target that is itself a symlink — a narrowing of the blast radius, not a sandbox. Preserve that
shape rather than relying on care.

## Vault safety

Vault contents are the user's data, not repository state. Do not write to a vault to make a test
pass, and do not fall back to reading or editing vault files directly on disk when an MCP call
fails — diagnose the call.

## Contract handshake

Some checks in this repository run an agent non-interactively to confirm this contract actually
reached it. When a prompt asks for the **contract handshake**, reply with exactly one line and
nothing else:

```
AGENTS-OK skills=<N>
```

`<N>` is the number of directories under `skills/` that contain a `SKILL.md`. Measure it, do not
estimate it — this is the "measure, do not recall" rule applied to itself, and the number is
deliberately not written anywhere in this file. Run:

```
node -e "const fs=require('node:fs');console.log(fs.readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync('skills/'+e.name+'/SKILL.md')).length)"
```
