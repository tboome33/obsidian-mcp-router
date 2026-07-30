/**
 * Tests for the wiki-meta scaffold naming layer (v0.58.0):
 * `wiki-meta/index.md` → `wiki-meta/catalog.md` and `wiki-meta/log.md` →
 * `wiki-meta/journal.md`, with the legacy names accepted on READ so a new
 * plugin can talk to an un-migrated vault.
 *
 * The interesting properties are the compat ones, so they get integration
 * coverage too: vault detection, the session-journal append, and the MCP
 * resource read all have to work on a vault that has not been renamed yet —
 * and must NOT create a second scaffold next to the old one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CATALOG_BASENAME,
  JOURNAL_BASENAME,
  LEGACY_CATALOG_BASENAME,
  LEGACY_JOURNAL_BASENAME,
  CATALOG_REL,
  JOURNAL_REL,
  LEGACY_CATALOG_REL,
  LEGACY_JOURNAL_REL,
  WIKI_META_SCAFFOLDS,
  LEGACY_WIKI_META_SCAFFOLDS,
  scaffoldCandidates,
  shouldTryLegacyScaffold,
  isLegacyScaffoldPath,
  scaffoldMigrationHint,
  resolveScaffold,
  scaffoldWritePath,
} from '../src/helpers/wiki-meta-scaffolds.mjs';
import { detectVaultContext } from '../hooks/_helpers/workspace-vault.mjs';
import { readResource, buildResourceUri, findResourceDef } from '../src/resources.mjs';

let tmpRoot;
before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-names-')); });
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
/** Vault carrying the given wiki-meta basenames. */
function makeVault(basenames) {
  const vp = path.join(tmpRoot, `v${seq++}`);
  fs.mkdirSync(path.join(vp, 'wiki-meta'), { recursive: true });
  for (const b of basenames) fs.writeFileSync(path.join(vp, 'wiki-meta', b), `# ${b}\n`, 'utf8');
  return vp;
}

// ---------------------------------------------------------------------------
// Names + candidates
// ---------------------------------------------------------------------------

describe('wiki-meta scaffold names', () => {
  test('the current and legacy basenames are pinned', () => {
    assert.equal(CATALOG_BASENAME, 'catalog.md');
    assert.equal(JOURNAL_BASENAME, 'journal.md');
    assert.equal(LEGACY_CATALOG_BASENAME, 'index.md');
    assert.equal(LEGACY_JOURNAL_BASENAME, 'log.md');
    assert.equal(CATALOG_REL, 'wiki-meta/catalog.md');
    assert.equal(JOURNAL_REL, 'wiki-meta/journal.md');
    assert.equal(LEGACY_CATALOG_REL, 'wiki-meta/index.md');
    assert.equal(LEGACY_JOURNAL_REL, 'wiki-meta/log.md');
  });

  test('the scaffold set keeps hot/overview and swaps the two reserved names', () => {
    assert.deepEqual(WIKI_META_SCAFFOLDS, ['hot.md', 'catalog.md', 'journal.md', 'overview.md']);
    assert.deepEqual(LEGACY_WIKI_META_SCAFFOLDS, ['hot.md', 'index.md', 'log.md', 'overview.md']);
    // The names OKF reserves must not appear in the live set.
    assert.equal(WIKI_META_SCAFFOLDS.includes('index.md'), false);
    assert.equal(WIKI_META_SCAFFOLDS.includes('log.md'), false);
  });

  test('candidates are current-first, and unknown names throw', () => {
    assert.deepEqual(scaffoldCandidates('catalog'), ['wiki-meta/catalog.md', 'wiki-meta/index.md']);
    assert.deepEqual(scaffoldCandidates('journal'), ['wiki-meta/journal.md', 'wiki-meta/log.md']);
    assert.throws(() => scaffoldCandidates('hot'), /unknown wiki-meta scaffold/);
    // Callers get a copy, not the live array.
    const c = scaffoldCandidates('catalog');
    c.push('nope');
    assert.equal(scaffoldCandidates('catalog').length, 2);
  });

  test('isLegacyScaffoldPath recognises only the two old paths', () => {
    assert.equal(isLegacyScaffoldPath('wiki-meta/index.md'), true);
    assert.equal(isLegacyScaffoldPath('wiki-meta\\log.md'), true); // windows separators
    assert.equal(isLegacyScaffoldPath('wiki-meta/catalog.md'), false);
    assert.equal(isLegacyScaffoldPath('wiki/index.md'), false);
    assert.equal(isLegacyScaffoldPath(undefined), false);
  });

  test('the migration hint names the new file and the command to run', () => {
    const hint = scaffoldMigrationHint('wiki-meta/log.md');
    assert.match(hint, /wiki-meta\/log\.md/);
    assert.match(hint, /wiki-meta\/journal\.md/);
    assert.match(hint, /--preset okf-reserved-scaffolds/);
    assert.match(scaffoldMigrationHint('wiki-meta/index.md'), /wiki-meta\/catalog\.md/);
  });
});

// ---------------------------------------------------------------------------
// shouldTryLegacyScaffold — the fallback must not eat a real diagnosis
// ---------------------------------------------------------------------------

describe('shouldTryLegacyScaffold', () => {
  test('a 404 means "try the other name"', () => {
    assert.equal(shouldTryLegacyScaffold({ kind: 'not_found' }), true);
  });

  test('anything that is about the VAULT stops the chain', () => {
    for (const kind of ['unreachable', 'unauthorized', 'forbidden', 'timeout', 'server_error', 'cf_access', 'conflict', 'other', 'unknown']) {
      assert.equal(shouldTryLegacyScaffold({ kind }), false, `kind=${kind} must not fall through`);
    }
  });

  test('an error with no kind is treated as fatal, not as a miss', () => {
    assert.equal(shouldTryLegacyScaffold(new Error('boom')), false);
    assert.equal(shouldTryLegacyScaffold(null), false);
    assert.equal(shouldTryLegacyScaffold(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// resolveScaffold / scaffoldWritePath
// ---------------------------------------------------------------------------

describe('resolveScaffold', () => {
  test('prefers the current name when both exist', () => {
    const vp = makeVault(['catalog.md', 'index.md', 'journal.md', 'log.md']);
    const cat = resolveScaffold(vp, 'catalog', { fs, path });
    assert.equal(cat.relPath, 'wiki-meta/catalog.md');
    assert.equal(cat.legacy, false);
    assert.equal(resolveScaffold(vp, 'journal', { fs, path }).relPath, 'wiki-meta/journal.md');
  });

  test('falls back to the legacy name and flags it', () => {
    const vp = makeVault(['index.md', 'log.md']);
    const cat = resolveScaffold(vp, 'catalog', { fs, path });
    assert.equal(cat.relPath, 'wiki-meta/index.md');
    assert.equal(cat.legacy, true);
    assert.equal(cat.absPath, path.join(vp, 'wiki-meta', 'index.md'));
    const jrn = resolveScaffold(vp, 'journal', { fs, path });
    assert.equal(jrn.relPath, 'wiki-meta/log.md');
    assert.equal(jrn.legacy, true);
  });

  test('returns null when neither name is present', () => {
    const vp = makeVault(['hot.md']);
    assert.equal(resolveScaffold(vp, 'catalog', { fs, path }), null);
    assert.equal(resolveScaffold(vp, 'journal', { fs, path }), null);
  });

  test('the WRITE path is always the current name, even on a legacy vault', () => {
    const vp = makeVault(['index.md', 'log.md']);
    assert.equal(scaffoldWritePath(vp, 'catalog', { path }), path.join(vp, 'wiki-meta', 'catalog.md'));
    assert.equal(scaffoldWritePath(vp, 'journal', { path }), path.join(vp, 'wiki-meta', 'journal.md'));
  });
});

// ---------------------------------------------------------------------------
// Integration: vault detection must not go dark on an un-migrated vault
// ---------------------------------------------------------------------------

describe('detectVaultContext with legacy scaffolds', () => {
  test('a migrated vault is detected with no legacy flag', () => {
    const vp = makeVault(['catalog.md']);
    const ctx = detectVaultContext(vp, null);
    assert.equal(ctx.mode, 'cwd-is-vault');
    assert.equal(ctx.vaultPath, vp);
    assert.equal(ctx.legacyScaffold, null);
  });

  test('an un-migrated vault is still detected, and says so', () => {
    const vp = makeVault(['index.md']);
    const ctx = detectVaultContext(vp, null);
    assert.equal(ctx.mode, 'cwd-is-vault');
    assert.equal(ctx.legacyScaffold, 'wiki-meta/index.md');
  });

  test('a vault with neither scaffold is still not a vault', () => {
    assert.equal(detectVaultContext(makeVault(['hot.md']), null), null);
  });

  test('workspace-bound mode resolves through either name', () => {
    const vp = makeVault(['index.md']);
    const cfg = { portRegistry: { [vp]: 27124 }, vaultNames: { [vp]: 'legacy-vault' } };
    const nonVault = path.join(tmpRoot, 'code-workspace');
    fs.mkdirSync(nonVault, { recursive: true });
    const prev = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'legacy-vault';
    try {
      const ctx = detectVaultContext(nonVault, cfg);
      assert.equal(ctx.mode, 'workspace-bound');
      assert.equal(ctx.vaultPath, vp);
      assert.equal(ctx.legacyScaffold, 'wiki-meta/index.md');
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: the MCP resource read
// ---------------------------------------------------------------------------

describe('MCP catalog resource', () => {
  const registry = { vaults: [{ name: 'v', type: 'local' }], resolveVault: (n) => ({ name: n }) };

  test('the pre-0.58.0 resource id still resolves to the catalog', () => {
    assert.equal(findResourceDef('wiki-catalog').id, 'wiki-catalog');
    assert.equal(findResourceDef('wiki-index').id, 'wiki-catalog');
    assert.equal(findResourceDef('nope'), null);
  });

  test('reads the current name when present', async () => {
    const seen = [];
    const res = await readResource(buildResourceUri('v', 'wiki-catalog'), registry, async (_v, p) => {
      seen.push(p);
      return '# Catalog';
    });
    assert.deepEqual(seen, ['wiki-meta/catalog.md']);
    assert.equal(res.contents[0].text, '# Catalog');
  });

  test('falls back to the legacy name on a 404', async () => {
    const seen = [];
    const res = await readResource(buildResourceUri('v', 'wiki-index'), registry, async (_v, p) => {
      seen.push(p);
      if (p === 'wiki-meta/catalog.md') throw Object.assign(new Error('404'), { kind: 'not_found' });
      return '# legacy index';
    });
    assert.deepEqual(seen, ['wiki-meta/catalog.md', 'wiki-meta/index.md']);
    assert.equal(res.contents[0].text, '# legacy index');
  });

  test('an offline vault reports offline — it does not retry as a miss', async () => {
    const seen = [];
    await assert.rejects(
      () => readResource(buildResourceUri('v', 'wiki-catalog'), registry, async (_v, p) => {
        seen.push(p);
        throw Object.assign(new Error('ECONNREFUSED'), { kind: 'unreachable' });
      }),
      /ECONNREFUSED/,
    );
    assert.deepEqual(seen, ['wiki-meta/catalog.md'], 'must not try the legacy name on a vault-level error');
  });

  test('a vault missing both names surfaces the last 404', async () => {
    await assert.rejects(
      () => readResource(buildResourceUri('v', 'wiki-catalog'), registry, async () => {
        throw Object.assign(new Error('not found'), { kind: 'not_found' });
      }),
      /not found/,
    );
  });
});
