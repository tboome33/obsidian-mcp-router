/**
 * `setup-vault.mjs <vault> --sync-plugins` — what the report, the enabled list,
 * the root docs and .smart-env look like after a sync from a SKELETON-shaped
 * source, and what `--sync-plugins --dry-run` prints.
 *
 * The fixture mirrors templates/reference-vault-skeleton: BRAT with code, two
 * settings-only pre-seeds (the bridge, icon-folder), and an enabled list naming
 * plugins the skeleton never ships (smart-connections, local-rest-api). It sits
 * at `<tmp>/templates/reference-vault-skeleton` — where the sync recognises a
 * shipped skeleton — so its README must never reach the vault.
 *
 * Everything under fs.mkdtempSync; the child gets its own HOME/USERPROFILE and
 * an OBSIDIAN_ROUTER_CONFIG pointing into the temp dir. No network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describeVaultSyncPlan, syncPlanCore } from '../scripts/setup-vault.mjs';
import { computePlanSeal } from '../src/helpers/plan-seal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');
const GEMMA = 'onnx-community/embeddinggemma-300m-ONNX';
const BGE = 'TaylorAI/bge-micro-v2';

let workDir;
let home;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-report-cli-'));
  home = path.join(workDir, 'home');
  fs.mkdirSync(home, { recursive: true });
});
after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/** A skeleton-shaped source. `underTemplates` places it where a shipped skeleton lives. */
function makeSource(name, { underTemplates = true } = {}) {
  const root = fs.mkdtempSync(path.join(workDir, `${name}-`));
  const src = underTemplates ? path.join(root, 'templates', 'reference-vault-skeleton') : path.join(root, '.template');
  const plug = (id, file) => path.join(src, '.obsidian', 'plugins', id, file);
  write(path.join(src, '.obsidian', 'community-plugins.json'), JSON.stringify([
    'obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections', 'obsidian-icon-folder', 'obsidian42-brat',
  ], null, 2));
  write(plug('obsidian42-brat', 'main.js'), '// brat code\n');
  write(plug('obsidian42-brat', 'manifest.json'), JSON.stringify({ id: 'obsidian42-brat', version: '2.0.8' }));
  write(plug('obsidian42-brat', 'data.json'), JSON.stringify({ pluginList: ['tboome33/obsidian-mcp-router-bridge'] }));
  write(plug('mcp-router-bridge', 'data.json'), JSON.stringify({ seeded: true }));
  write(plug('obsidian-icon-folder', 'data.json'), JSON.stringify({ seeded: true }));
  write(path.join(src, '.smart-env', 'smart_env.json'), JSON.stringify({
    smart_sources: { embed_model: { adapter: 'transformers', transformers: { model_key: BGE } } },
    language: 'en',
  }, null, 2));
  write(path.join(src, 'README.md'), '# Reference vault skeleton\n');
  return src;
}

function makeVault(name) {
  const v = fs.mkdtempSync(path.join(workDir, `${name}-`));
  fs.mkdirSync(path.join(v, '.obsidian'), { recursive: true });
  return v;
}

function run(source, vault, extra = []) {
  const cfg = path.join(fs.mkdtempSync(path.join(workDir, 'cfg-')), 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ referenceVault: source, portRegistry: { [vault]: 27300 }, portStart: 27300 }, null, 2));
  const r = spawnSync(process.execPath, [SCRIPT_PATH, vault, '--sync-plugins', ...extra], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      OBSIDIAN_ROUTER_CONFIG: cfg,
      HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: home,
      NO_COLOR: '1',
    },
  });
  return { ...r, out: (r.stdout || '') + (r.stderr || '') };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const smartEnv = (v) => readJson(path.join(v, '.smart-env', 'smart_env.json'));

/** Every file under a directory, relative — to prove a dry-run wrote nothing. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

describe('--sync-plugins from a skeleton-shaped source', () => {
  test('report in three buckets; settings-only plugins are never called synced', () => {
    const src = makeSource('bucket');
    const v = makeVault('bucket-vault');
    const r = run(src, v);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Synced \d+ new plugin/, r.out);
    assert.match(r.out, /Code installed for 1 plugin\(s\): obsidian42-brat/);
    assert.match(r.out, /Settings only for 2 plugin\(s\) — code still to install: mcp-router-bridge, obsidian-icon-folder/);
    assert.match(r.out, /Enabled without code — 4 plugin\(s\); listed in this vault: mcp-router-bridge, obsidian-icon-folder; enabled by the sync source, not listed here: obsidian-local-rest-api, smart-connections/);
    assert.match(r.out, /NOT counted as synced/);
    assert.match(r.out, /Browse/);
    assert.ok(r.out.includes(`--install-plugins "${v}"`), r.out);
  });

  test('community-plugins.json still lists every copied id, code or not', () => {
    const src = makeSource('cp');
    const v = makeVault('cp-vault');
    assert.equal(run(src, v).status, 0);
    const list = readJson(path.join(v, '.obsidian', 'community-plugins.json'));
    assert.deepEqual([...list].sort(), ['mcp-router-bridge', 'obsidian-icon-folder', 'obsidian42-brat']);
  });

  test('post-sync checklist: reload, restricted mode, BRAT update, verify', () => {
    const src = makeSource('check');
    const v = makeVault('check-vault');
    const r = run(src, v);
    assert.match(r.out, /Next steps in Obsidian for /);
    assert.match(r.out, /Reload app without saving/);
    assert.match(r.out, /docker compose restart/, 'unknown host: both variants');
    assert.match(r.out, /Restricted mode/);
    assert.match(r.out, /obsidian42-brat:checkForUpdatesAndUpdate/);
    assert.ok(r.out.includes(`--plugin-health "${v}"`), r.out);
    const withContainer = run(makeSource('check2'), makeVault('check2-vault'), ['--container']);
    assert.doesNotMatch(withContainer.out, /Reload app without saving"; /);
    assert.match(withContainer.out, /container \(e\.g\. linuxserver\/obsidian\)/);
  });

  test('the skeleton README never reaches the vault', () => {
    const src = makeSource('readme');
    const v = makeVault('readme-vault');
    assert.equal(run(src, v).status, 0);
    assert.equal(fs.existsSync(path.join(v, 'README.md')), false);
  });

  test("a user's own reference vault still sends its README", () => {
    const src = makeSource('userref', { underTemplates: false });
    const v = makeVault('userref-vault');
    assert.equal(run(src, v).status, 0);
    assert.equal(fs.readFileSync(path.join(v, 'README.md'), 'utf8'), '# Reference vault skeleton\n');
  });
});

describe('.smart-env language', () => {
  test('no --lang, nothing declared → the source model is kept and a hint is printed', () => {
    const v = makeVault('lang-none');
    const r = run(makeSource('lang-none-src'), v);
    assert.equal(smartEnv(v).smart_sources.embed_model.transformers.model_key, BGE);
    assert.match(r.out, /--lang <code>/);
  });

  test('--lang fr → multilingual model and language fr', () => {
    const v = makeVault('lang-fr');
    const r = run(makeSource('lang-fr-src'), v, ['--lang', 'fr']);
    assert.equal(r.status, 0, r.out);
    const env = smartEnv(v);
    assert.equal(env.smart_sources.embed_model.transformers.model_key, GEMMA);
    assert.equal(env.language, 'fr');
  });

  test('the bilingual convention in the vault CLAUDE.md is picked up without --lang', () => {
    const v = makeVault('lang-bi');
    write(path.join(v, 'CLAUDE.md'), '# Vault\n\n## Bilingual convention (FR + EN, FR primary)\n\nText.\n');
    run(makeSource('lang-bi-src'), v);
    const env = smartEnv(v);
    assert.equal(env.smart_sources.embed_model.transformers.model_key, GEMMA);
    assert.equal(env.language, 'fr');
  });

  test('an existing .smart-env is never overwritten, even with --lang', () => {
    const v = makeVault('lang-keep');
    const mine = JSON.stringify({ language: 'en', mine: true });
    write(path.join(v, '.smart-env', 'smart_env.json'), mine);
    const r = run(makeSource('lang-keep-src'), v, ['--lang', 'de']);
    assert.equal(fs.readFileSync(path.join(v, '.smart-env', 'smart_env.json'), 'utf8'), mine);
    assert.match(r.out, /never overwritten/);
  });

  test('an invalid --lang fails before anything is written', () => {
    const v = makeVault('lang-bad');
    const r = run(makeSource('lang-bad-src'), v, ['--lang', 'not a lang']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(tree(v), []);
  });
});

describe('--sync-plugins --dry-run', () => {
  test('per-plugin detail, enable list, still-without-code list — and nothing written', () => {
    const src = makeSource('dry');
    const v = makeVault('dry-vault');
    const before = tree(v);
    const r = run(src, v, ['--dry-run', '--lang', 'fr']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(tree(v), before, 'dry-run wrote nothing');
    assert.match(r.out, /obsidian42-brat: copy \[code\] \(data\.json, main\.js, manifest\.json\)/);
    assert.match(r.out, /mcp-router-bridge: copy \[settings only — code still to install\] \(data\.json\)/);
    assert.match(r.out, /will enable: mcp-router-bridge, obsidian-icon-folder, obsidian42-brat/);
    assert.match(r.out, /enabled but still without code afterwards: mcp-router-bridge, obsidian-icon-folder, obsidian-local-rest-api, smart-connections/);
    assert.ok(r.out.includes(`.smart-env: clone — model ${GEMMA}, language fr (--lang)`), r.out);
    assert.match(r.out, /root docs: \(none\)/);
    assert.doesNotMatch(r.out, /provision/i, 'not the bootstrap dry-run');
  });

  test('a plugin already present is shown as a skip', () => {
    const src = makeSource('dry-skip');
    const v = makeVault('dry-skip-vault');
    write(path.join(v, '.obsidian', 'plugins', 'obsidian42-brat', 'main.js'), '// installed\n');
    const r = run(src, v, ['--dry-run']);
    assert.match(r.out, /obsidian42-brat: skip — already present/);
  });
});

describe('the sync plan seal covers the per-plugin detail', () => {
  const sealFor = (src, v, lang = null) => computePlanSeal({
    op: 'sync-from-github',
    identity: { repo: 'o/r' },
    plan: syncPlanCore({
      repo: 'o/r', ref: 'main', force: false, lang, archiveSha256: 'a'.repeat(64), targets: [v],
      vaultPlans: [describeVaultSyncPlan(src, v, { networkSource: true, lang }).core],
    }),
  });

  test('same source + same vault → same seal', () => {
    const src = makeSource('seal-same');
    const v = makeVault('seal-same-vault');
    assert.equal(sealFor(src, v), sealFor(src, v));
  });

  test('a plugin folder appearing in the target changes the seal', () => {
    const src = makeSource('seal-drift');
    const v = makeVault('seal-drift-vault');
    const s1 = sealFor(src, v);
    write(path.join(v, '.obsidian', 'plugins', 'obsidian-icon-folder', 'data.json'), '{}');
    assert.notEqual(sealFor(src, v), s1);
  });

  test('a vault growing a declared language changes the seal', () => {
    const src = makeSource('seal-lang');
    const v = makeVault('seal-lang-vault');
    const s1 = sealFor(src, v);
    write(path.join(v, 'CLAUDE.md'), '## Bilingual convention (FR + EN, FR primary)\n');
    assert.notEqual(sealFor(src, v), s1);
  });

  test('the network plan never proposes the skeleton README', () => {
    const src = makeSource('seal-readme', { underTemplates: false });
    const v = makeVault('seal-readme-vault');
    assert.deepEqual(describeVaultSyncPlan(src, v, { networkSource: true }).core.rootDocs, []);
  });
});
