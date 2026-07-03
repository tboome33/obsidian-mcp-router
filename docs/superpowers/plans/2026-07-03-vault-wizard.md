# Vault-Creation Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a guided vault-creation wizard as a 3-layer engine — enriched `setup-vault.mjs` CLI flags (layer 0), harness-agnostic `plan_vault`/`provision_vault` MCP tools (layer 1), and thin frontends (layer 2: `meta-attach-vault` v2 skill + `docs/vault-wizard.md` playbook) — so a new local vault is created in a single interaction from any LLM harness.

**Architecture:** The wizard lives in *data*, not the harness. `plan_vault` returns a structured questionnaire (detected context + computed defaults + option lists with descriptions) and asks nothing; the harness LLM drives the conversation and calls `provision_vault` once. Both MCP tools compose the same CLI engine (`setup-vault.mjs --dry-run --json` for planning, a single provisioning call for applying). The CLI stays scriptable and fully backward-compatible.

**Tech Stack:** Node ESM (`node:*` builtins only, no new deps), `node --test`, Obsidian Local REST API + `mcp-router-bridge`, `@modelcontextprotocol/sdk`.

## Global Constraints

- **Backward compatibility TOTALE** — no existing `setup-vault.mjs` invocation may change behavior. Every existing test in the `npm test` manifest (package.json) stays green. New test files are appended to that manifest.
- **Concurrent Claude sessions on this repo** — SELECTIVE git staging only. NEVER `git add -A` / `git add .`. Stage only files this plan authors: `scripts/setup-vault.mjs`, `src/tools/plan-vault.mjs`, `src/tools/provision-vault.mjs`, `src/index.mjs`, `skills/meta-attach-vault/**`, `docs/vault-wizard.md`, `templates/wiki-meta/*.md`, `tests/*.test.mjs`, `CHANGELOG.md`, `README.md`, the 3 version files. NEVER commit the Lot 2 working-tree files: `templates/reference-vault-skeleton/.obsidian/{app,appearance,community-plugins}.json`, `templates/reference-vault-skeleton/.obsidian/plugins/`, `templates/reference-vault-skeleton/.obsidian/themes/`, `.codex/`.
- **Lot 2 coordination** — the Blue Topaz theme chantier (`cloneThemes()` + dynamic `cssTheme`) is NOT merged (uncommitted, and `cloneThemes()` is not even implemented yet). Therefore `--theme` is SKIPPED in W1 (its task is written but marked blocked). W0's derive-from-source refactor supersedes Lot 2's `+obsidian42-brat` edit to `OPTIONAL_PLUGINS`; that is intended (brat rides in via the source's `community-plugins.json`).
- **Version bump uses `npm run bump`** (scripts/bump-version.mjs), NEVER `npm version` — 3 version files: `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`.
- **Security (W2, non-negotiable)** — `plan_vault`/`provision_vault` are ABSENT from the tool list when `OBSIDIAN_ROUTER_USER_ID` is set (gated deployment). `provision_vault` refuses any path outside known vault roots (config `vaultsRoot` + `portRegistry` roots). `--from-vault` copy re-applies `CREDENTIAL_LEAK_PLUGINS` exclusions + drops `workspace.json`; port + apiKey ALWAYS regenerated.
- **Per-phase close-out** — each phase = one release: code + tests + CHANGELOG + `npm run bump` + selective commit. Then update the vault roadmap (`wiki/obsidian-mcp-router/vault-wizard-roadmap.md`) checkboxes + phase header, append a `wiki-meta/log.md` line, refresh `wiki-meta/hot.md`, bump `updated:` in the roadmap frontmatter. Run `/review+` after W1 and after W2. Do NOT push to GitHub without Roland's explicit approval.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `scripts/setup-vault.mjs` | Layer 0 engine — root-docs fix, derive-from-source plugins, all new wizard flags, `buildProvisionPlan()`/`--dry-run --json` | W0, W1 |
| `src/tools/plan-vault.mjs` | Layer 1 read-only planner tool handler | W2 |
| `src/tools/provision-vault.mjs` | Layer 1 provisioning tool handler | W2 |
| `src/index.mjs` | Gated registration of the 2 tools | W2 |
| `templates/wiki-meta/{index,overview}.md` | Per-wiki-mode parameterization seeds | W1 |
| `skills/meta-attach-vault/SKILL.md` | Layer 2 defaults-first frontend | W3 |
| `docs/vault-wizard.md` | Layer 2 harness-agnostic playbook | W3 |
| `tests/setup-vault-plugins-derived.test.mjs` | W0 refactor coverage | W0 |
| `tests/setup-vault-root-docs.test.mjs` | W0 root-docs fix coverage | W0 |
| `tests/setup-vault-wizard-flags.test.mjs` | W1 flag parsing + dry-run plan | W1 |
| `tests/setup-vault-from-vault.test.mjs` | W1 `--from-vault` copy + exclusions | W1 |
| `tests/plan-vault.test.mjs` | W2 planner output shape | W2 |
| `tests/provision-vault.test.mjs` | W2 provisioning + security gates | W2 |

---

## Phase W0 — Prerequisite fixes (root docs + plugins-derived-from-source)

**Deliverable:** Root docs clone again from a `Documentation/`-reorganized reference; the plugin clone list derives from the source's `community-plugins.json` (killing the "activated-but-never-cloned" drift). Suite green, zero behavior change for existing invocations. One release.

**Grounding facts (verified 2026-07-03):**
- `ROOT_FILES_TO_CLONE` (setup-vault.mjs:1528) = `['README.md', 'quick-reference-fr.pdf', 'quick-reference-en.pdf', '.claude']`. Reference `C:\VAULTS\.template` now holds `Documentation/{quick-reference-en.pdf,quick-reference-fr.pdf,SETUP.md,CLAUDE.md}` and NO root README/PDFs; `.claude/` still at root. Shipped skeleton has root `README.md`, no `Documentation/`.
- `cloneRootDocs()` (setup-vault.mjs:1530) already dir-aware (`fs.statSync(src).isDirectory()` → `cpSync recursive`).
- `PLUGINS_TO_CLONE` = `[...REQUIRED_PLUGINS, ...OPTIONAL_PLUGINS]` (setup-vault.mjs:131) consumed at 3 sites: `initReference` info line (716), `ensureCommunityPlugins` (1227), `setupVault` clone loop (1917).
- `REQUIRED_PLUGINS` (80) = `['obsidian-local-rest-api', 'mcp-router-bridge']`; `CREDENTIAL_LEAK_PLUGINS` (105) = `Set(['obsidian-local-rest-api'])`.

### Task W0.1: Root-docs clone includes `Documentation/`

**Files:**
- Modify: `scripts/setup-vault.mjs:1528` (the `ROOT_FILES_TO_CLONE` constant)
- Test: `tests/setup-vault-root-docs.test.mjs` (create)

**Interfaces:**
- Consumes: `cloneRootDocs(referenceVault, targetVault, force)` (existing, unchanged signature).
- Produces: none (constant edit).

- [ ] **Step 1: Write the failing test** — `tests/setup-vault-root-docs.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cloneRootDocs is not exported; drive it via the constant contract instead.
// We assert the shipped constant lists `Documentation` so a reference vault
// that reorganized its human docs under Documentation/ gets them cloned.
test('ROOT_FILES_TO_CLONE includes Documentation (not stale root PDFs)', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'setup-vault.mjs'), 'utf8');
  const m = src.match(/const ROOT_FILES_TO_CLONE = (\[[^\]]*\]);/);
  assert.ok(m, 'ROOT_FILES_TO_CLONE constant found');
  const list = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(list.includes('Documentation'), 'Documentation folder cloned');
  assert.ok(list.includes('README.md'), 'README.md still cloned (skeleton)');
  assert.ok(list.includes('.claude'), '.claude still cloned');
  assert.ok(!list.includes('quick-reference-fr.pdf'),
    'stale root-level PDF entry removed (now inside Documentation/)');
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests/setup-vault-root-docs.test.mjs` → FAIL (`Documentation` not in list).

- [ ] **Step 3: Implement** — edit setup-vault.mjs:1528:

```js
// Human-facing docs cloned to a fresh vault. `Documentation/` is the reference
// vault's docs folder (quick-reference PDFs, SETUP.md, the vault-facing
// CLAUDE.md) — reorganized there from the vault root, so the old per-PDF
// entries found nothing. Dir entries (`Documentation`, `.claude`) are cloned
// recursively by cloneRootDocs(); `README.md` covers the shipped skeleton
// (which keeps its README at root and has no Documentation/). Non-existent
// entries are silently skipped, so this list is a union across source shapes.
const ROOT_FILES_TO_CLONE = ['README.md', 'Documentation', '.claude'];
```

- [ ] **Step 4: Run test to verify it passes** — `node --test tests/setup-vault-root-docs.test.mjs` → PASS.

- [ ] **Step 5: Add an end-to-end fixture test** (same file) proving a fake reference with `Documentation/` clones it:

```js
test('cloneRootDocs copies Documentation/ from a reference into a target', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rootdocs-'));
  const ref = path.join(tmp, 'ref'); const tgt = path.join(tmp, 'tgt');
  fs.mkdirSync(path.join(ref, 'Documentation'), { recursive: true });
  fs.writeFileSync(path.join(ref, 'Documentation', 'SETUP.md'), '# setup');
  fs.writeFileSync(path.join(ref, 'README.md'), '# readme');
  fs.mkdirSync(tgt, { recursive: true });
  // Minimal harness: import the module's helper via a tiny inline runner is not
  // possible (not exported); instead assert the copy semantics with fs.cpSync
  // mirror used by cloneRootDocs, guarding the dir-aware path stays intact.
  for (const item of ['README.md', 'Documentation', '.claude']) {
    const s = path.join(ref, item), d = path.join(tgt, item);
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true });
    else fs.copyFileSync(s, d);
  }
  assert.ok(fs.existsSync(path.join(tgt, 'Documentation', 'SETUP.md')));
  assert.ok(fs.existsSync(path.join(tgt, 'README.md')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

> Note at execution: if `cloneRootDocs` can be cheaply exported for a truer test without breaking the CLI, prefer that. Only export if it does not perturb the module's top-level CLI dispatch (the file runs its CLI on import). If export risks running CLI side-effects, keep the constant + semantics tests above.

- [ ] **Step 6: Run the file** — `node --test tests/setup-vault-root-docs.test.mjs` → PASS.

### Task W0.2: Derive the plugin clone list from the source's `community-plugins.json`

**Files:**
- Modify: `scripts/setup-vault.mjs` — replace `OPTIONAL_PLUGINS`/`PLUGINS_TO_CLONE` module constants (106-131) with a resolver; update the 3 consumption sites (716, 1227, 1917).
- Test: `tests/setup-vault-plugins-derived.test.mjs` (create)

**Interfaces:**
- Produces: `resolvePluginsToClone(referenceVault)` → `string[]` — reads `<referenceVault>/.obsidian/community-plugins.json`, unions with `REQUIRED_PLUGINS`, dedups preserving REQUIRED-first order, returns the list. On missing/malformed file → returns `[...REQUIRED_PLUGINS]`.
- Consumes: `REQUIRED_PLUGINS`, `cfg.referenceVault`.

- [ ] **Step 1: Write the failing test** — `tests/setup-vault-plugins-derived.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginsToClone } from '../scripts/setup-vault.mjs';

function makeRef(plugins) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  fs.mkdirSync(path.join(tmp, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.obsidian', 'community-plugins.json'),
    JSON.stringify(plugins));
  return tmp;
}

test('derives clone list from source community-plugins.json + REQUIRED', () => {
  const ref = makeRef(['smart-connections', 'realclaudian', 'obsidian42-brat']);
  const list = resolvePluginsToClone(ref);
  for (const req of ['obsidian-local-rest-api', 'mcp-router-bridge'])
    assert.ok(list.includes(req), `REQUIRED ${req} always present`);
  assert.ok(list.includes('realclaudian'), 'source plugin propagated (drift fix)');
  assert.ok(list.includes('obsidian42-brat'));
  assert.equal(new Set(list).size, list.length, 'deduped');
  fs.rmSync(ref, { recursive: true, force: true });
});

test('missing community-plugins.json falls back to REQUIRED only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  const list = resolvePluginsToClone(tmp);
  assert.deepEqual(list, ['obsidian-local-rest-api', 'mcp-router-bridge']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('malformed community-plugins.json falls back to REQUIRED only', () => {
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  fs.mkdirSync(path.join(ref, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'), '{ not json');
  const list = resolvePluginsToClone(ref);
  assert.deepEqual(list, ['obsidian-local-rest-api', 'mcp-router-bridge']);
  fs.rmSync(ref, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests/setup-vault-plugins-derived.test.mjs` → FAIL (`resolvePluginsToClone` not exported / not defined).

- [ ] **Step 3: Implement the resolver** — in setup-vault.mjs, replace the `OPTIONAL_PLUGINS`/`PLUGINS_TO_CLONE` block (keep the historical comment trimmed) with:

```js
// The plugin clone list is DERIVED from the source vault's own
// community-plugins.json (union REQUIRED). Any plugin the reference enables is
// cloned automatically — no constant to keep in sync (kills the historical
// "activated in the skeleton but absent from OPTIONAL_PLUGINS → never cloned"
// drift). REQUIRED_PLUGINS is the only hard list left: those MUST exist in the
// reference or setupVault() fails. CREDENTIAL_LEAK_PLUGINS exclusions and the
// data.json regeneration for the REST API plugin are applied downstream,
// independent of this list.
export function resolvePluginsToClone(referenceVault) {
  const seen = new Set(REQUIRED_PLUGINS);
  const list = [...REQUIRED_PLUGINS];
  try {
    const cp = JSON.parse(fs.readFileSync(
      path.join(referenceVault, '.obsidian', 'community-plugins.json'), 'utf8'));
    if (Array.isArray(cp)) {
      for (const p of cp) {
        if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); list.push(p); }
      }
    }
  } catch { /* missing/malformed → REQUIRED only */ }
  return list;
}
```

- [ ] **Step 4: Update the 3 consumption sites** to call `resolvePluginsToClone(<sourceVault>)`:
  - `initReference` (716): compute `const pluginsToClone = resolvePluginsToClone(refPath);` (use the ref path that function already has) and filter over it in the info line.
  - `ensureCommunityPlugins` (1227): this iterates plugins found on-disk in the *target*. Change its loop to derive from the target's own cloned plugin folders — read `fs.readdirSync(<target>/.obsidian/plugins)` (dirs) unioned with REQUIRED, instead of the module constant. (The target already has exactly the cloned set at this point.) Keep the enable-in-community-plugins semantics.
  - `setupVault` clone loop (1917): `for (const p of resolvePluginsToClone(cfg.referenceVault))`.

> At execution: read each site's surrounding 15 lines before editing; preserve the REQUIRED-missing `fail()` and the `--force` data.json-preservation logic verbatim.

- [ ] **Step 5: Run the new test + the safety test** — `node --test tests/setup-vault-plugins-derived.test.mjs tests/setup-vault-safety.test.mjs` → PASS.

- [ ] **Step 6: Run the FULL suite** — `npm test` → all green (proves no behavior change for existing invocations).

### Task W0.3: Release W0

- [ ] **Step 1:** Add `tests/setup-vault-root-docs.test.mjs` + `tests/setup-vault-plugins-derived.test.mjs` to the `npm test` manifest in `package.json`.
- [ ] **Step 2:** `npm test` → all green.
- [ ] **Step 3:** Prepend a W0 entry to `CHANGELOG.md` (create the section for the next patch version; FR+EN bullet describing the root-docs fix + plugins-derived-from-source refactor).
- [ ] **Step 4:** `npm run bump patch` (0.33.0 → 0.33.1). Verify all 3 version files updated (`node --test tests/bump-version.test.mjs` stays green).
- [ ] **Step 5:** Selective commit — `git add scripts/setup-vault.mjs tests/setup-vault-root-docs.test.mjs tests/setup-vault-plugins-derived.test.mjs package.json package-lock.json .claude-plugin/plugin.json CHANGELOG.md` then commit `feat(setup-vault): W0 — clone Documentation/ root docs + derive plugin list from source community-plugins.json`. VERIFY `git status` shows the Lot 2 files still unstaged.
- [ ] **Step 6:** Vault close-out — tick W0 boxes in the roadmap, set the phase header `✅ · livré 2026-07-03 (v0.33.1)`, bump `updated:`, append `wiki-meta/log.md` line, refresh `wiki-meta/hot.md`.

---

## Phase W1 — Engine wizard flags

**Deliverable:** All new `setup-vault.mjs` flags functional (`--theme` excepted, blocked on Lot 2). `--dry-run --json` emits the complete provision plan. Backward compatibility proven by the untouched existing tests. One release + `/review+`.

**Phase-start grounding step (do FIRST):** read `setupVault()` body in full (setup-vault.mjs:1844-2050), `scaffoldWikiMeta()` (1460), `linkWorkspaceToVault()` (1359), `patchRestApiData()` (737), and the main CLI dispatch tail (3251-3290). Record exact insertion points before writing tasks' code.

### Task W1.1: `buildProvisionPlan()` + `--dry-run`/`--json` (no mutation)

**Files:** Modify `scripts/setup-vault.mjs`; Test `tests/setup-vault-wizard-flags.test.mjs`.

**Interfaces:**
- Produces: `buildProvisionPlan(opts)` → plan object `{ name, slug, path, source:{kind,fromVault?}, plugins:{profile,resolved:[]}, theme, wikiMode:{mode,sections?}, conventions:[], claudeWorkspace, open, gitInit, warnings:[], steps:[] }`. Pure/read-only — no fs writes. Emitted as JSON when `--json`, human-readable otherwise.
- Consumes: `loadConfig()`, `resolvePluginsToClone()`, `defaultNameFromPath()`, `discoverVaults()` (for `--from-vault` slug resolution + known-root computation).

- [ ] **Step 1:** Write failing tests: `--dry-run --json <path>` prints valid JSON with the plan keys and performs no writes (assert target dir NOT created); slug derives from `--name`; `--plugins minimal` → resolved == REQUIRED; unknown `--plugins` value → warning entry.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildProvisionPlan()` (read-only) + wire a `--dry-run` branch in the main dispatch that prints the plan and exits 0 (JSON when `--json`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit checkpoint (within-phase; final release commit at W1.9).

### Task W1.2: `--name` (display name → `vaultNames`, derived slug, collision guard)
- [ ] TDD: display name written to config `vaultNames` when name ≠ path basename; slug lowercased; slug collision against registry/`vaultNames` → explicit `fail()` with suggestion. Backward compat: no `--name` → unchanged path-basename behavior (existing tests cover this).

### Task W1.3: `--from-vault <slug|path>` (config-only copy + security exclusions) + `--with-folder-tree`
- [ ] TDD with fixtures: copies `.obsidian/` (plugins/themes/snippets/appearance), `.smart-env`, `CLAUDE.md`; EXCLUDES `workspace.json` and every `CREDENTIAL_LEAK_PLUGINS` `data.json`; regenerates port + apiKey (assert copied apiKey ≠ source apiKey). `wiki-meta/` scaffolds fresh+empty. `--with-folder-tree` recreates `wiki/` dir tree empty (no `.md` files copied). This exclusion logic is SHARED with `provision_vault` (W2) — factor into a helper `copyVaultConfig(src, dst, {withFolderTree})`.

### Task W1.4: `--from-skeleton` + `--bare`
- [ ] `--from-skeleton` reuses `bootstrapReference()` mechanics (skeleton + bridge download). `--bare` = REQUIRED plugins only (override the derived list to `[...REQUIRED_PLUGINS]`).

### Task W1.5: `--plugins recommended|minimal|custom:a,b,c`
- [ ] `recommended` = full derived source set; `minimal` = REQUIRED; `custom:...` = explicit list ∪ REQUIRED. Drives the clone loop's effective list. TDD each profile.

### Task W1.6: `--wiki-mode` + `--wiki-sections` (template parameterization)

**Files:** Modify `scripts/setup-vault.mjs` (`scaffoldWikiMeta`), `templates/wiki-meta/{index,overview}.md`.
- [ ] Parameterize `templates/wiki-meta/index.md` + `overview.md` seeds by mode (`personal|research|business|code|domain`). `domain` consumes `--wiki-sections "A,B,C"` (flat list from the frontend; engine stays deterministic, no AI). Default `code` when workspace-linked, else `personal`. TDD: each mode seeds the documented section headers; `domain` without sections → warning + generic seed.

### Task W1.7: `--claude-workspace` (writes the WORKSPACE `.claude/settings.json` + global `extraKnownMarketplaces`)
- [ ] Idempotent merge of `enabledPlugins` into `<workspace>/.claude/settings.json`; verify/write global `extraKnownMarketplaces`. TDD idempotency (second run = no-op).

### Task W1.8: `--open` + `--probe [--probe-timeout N]`
- [ ] `--open` → `Start-Process obsidian://open?vault=…` (guard non-win32; the engine composes the URI, spawn is best-effort). `--probe` reuses `scripts/meta-audit-bridge-readiness.mjs` mechanics (poll REST port + `/open/*` sonde) → verdict + JSON report, non-zero exit on red. TDD the URI composition + the probe result shape with a stubbed fetch.

### Task W1.9: `--theme` (BLOCKED — write task, do not implement)
- [ ] Write the task skeleton + a skipped test (`test.skip`) documenting the intended `cssTheme` write, referencing Lot 2. Note in CHANGELOG that `--theme` lands with Lot 2. DO NOT implement `cloneThemes()`.

### Task W1.10: Release W1
- [ ] Full suite green (incl. all existing tests — backward-compat proof). Add new test files to `package.json` manifest. CHANGELOG (FR+EN). `npm run bump minor` (→ 0.34.0). Selective commit. `/review+`. Vault close-out.

---

## Phase W2 — MCP tools (`plan_vault` + `provision_vault`) + security gates

**Deliverable:** A raw MCP client can run `plan_vault` → `provision_vault` end-to-end. Both tools are invisible on a gated instance (`OBSIDIAN_ROUTER_USER_ID` set), proven by test. One release + `/review+`.

**Phase-start grounding step:** read `src/index.mjs` tool-registration + the existing gate pattern (grep `OBSIDIAN_ROUTER_USER_ID`, `MD_ALLOWED_PATHS`), and how existing tool handlers under `src/tools/` are shaped (schema + handler contract).

### Task W2.1: `plan_vault` (read-only)
- [ ] Handler calls the engine's `buildProvisionPlan()` (spawn `setup-vault.mjs --dry-run --json` or import the function) and returns `{ context, defaults, questions[], warnings[] }` — the 5 wiki modes with descriptions, real themes installed in the source, copyable vaults from the registry, plugin profiles with the source's plugin detail. TDD the output shape; assert zero mutation.

### Task W2.2: `provision_vault`
- [ ] Handler maps structured answers → one engine call; returns step-by-step report + `port`, `insecurePort`, `openUri`, `probeResult`. Reuses `copyVaultConfig` exclusions from W1.3. TDD happy path against a temp target under a known root.

### Task W2.3: Security gates
- [ ] Registration gate: when `OBSIDIAN_ROUTER_USER_ID` is set, neither tool appears in the tools list (mirror `MD_ALLOWED_PATHS` pattern). TDD: with the env var set, a tools/list snapshot excludes both.
- [ ] Path gate: `provision_vault` refuses any target path outside `{vaultsRoot} ∪ {portRegistry roots}` unless explicit opt-in. TDD refusal + allow.
- [ ] `--from-vault` secret exclusions re-applied regardless of caller layer (shared helper already enforces).

### Task W2.4: Release W2
- [ ] Suite green. Add `tests/plan-vault.test.mjs` + `tests/provision-vault.test.mjs` to manifest. CHANGELOG (FR+EN). `npm run bump minor` (→ 0.35.0). Selective commit. `/review+`. Vault close-out.

---

## Phase W3 — Frontends (skill v2 + playbook + README)

**Deliverable:** `meta-attach-vault` v2 does the happy path in 1 interaction (defaults-first). `docs/vault-wizard.md` playbook written for skill-less harnesses. One release.

### Task W3.1: `meta-attach-vault` v2 (defaults-first)
- [ ] Thin frontend: call `plan_vault` (or engine `--dry-run`), present the "plan proposé" one-liner + "OK tel quel, ou ajuster ?", collect adjustments (each point individually adjustable; the 5 wiki modes shown with explanations on adjust), compose ONE `provision_vault`. Preserve existing didactics: git pedagogy, explanatory pre-flight, conventions picker (unchanged), workspace `.gitignore` edit. Programmatic Obsidian open + probe tail.

### Task W3.2: `docs/vault-wizard.md` playbook
- [ ] Document the same sequence for harnesses without skills: read playbook → call `plan_vault` → drive questions → call `provision_vault`. Include the security-gate note (tools absent on gated deployments).

### Task W3.3: README + Release W3
- [ ] README user-journey section. CHANGELOG (FR+EN). `npm run bump minor` (→ 0.36.0). Selective commit. Vault close-out. (No `/review+` required for docs-heavy W3, but re-run `npm test`.)

---

## Self-Review (spec coverage)

- Spec §5 flags → W1.1–W1.9 (all flags; `--theme` blocked per Lot 2 constraint). ✅
- Spec §6 W0 (root docs + plugins-derived + Lot 2 check) → W0.1, W0.2, Global Constraints (Lot 2). ✅
- Spec §7 MCP tools + gates → W2.1–W2.3. ✅
- Spec §8 frontends → W3.1–W3.2. ✅
- Spec §12 success criteria → 1-interaction (W3.1), `--from-vault` zero-secret (W1.3 + W2.3), non-Claude harness path (W2 + W3.2 playbook), suite green + backward compat (every phase's full-suite gate). ✅
- Spec §10 roadmap impact → per-phase vault close-out + `saas-web-app-roadmap` P2 item (noted for a later, separate touch — out of this repo's code scope, tracked in vault).

**Placeholder scan:** W1–W3 tasks intentionally carry a "phase-start grounding step" instead of pre-speculated line numbers, because the exact `setupVault()` internals must be re-read at each phase to keep code accurate against the evolving file. W0 tasks are fully concrete (line-verified 2026-07-03).
