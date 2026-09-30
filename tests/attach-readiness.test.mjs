/**
 * scripts/attach-readiness.mjs — what `--attach` still reports as missing, and
 * in which order.
 *
 * Every case builds a real vault folder under fs.mkdtempSync and drives
 * `assessAttachReadiness` against it: the module reads a disk, so the disk is
 * what the tests hand it. No network, no real vault, no real config.
 *
 * The drift guard at the end parses skills/meta-attach-vault/SKILL.md §1A.5:
 * the nine recommended conventions live in two places (the page the agent
 * reads, the constant the CLI prints), and only a test keeps them one list.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessAttachReadiness,
  readConventionsFromDisk,
  formatReadiness,
  RECOMMENDED_CONVENTIONS,
} from '../scripts/attach-readiness.mjs';
import { loadConventionCatalogue } from '../src/tools/install-conventions.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LRA = 'obsidian-local-rest-api';
const BRIDGE = 'mcp-router-bridge';
const TEMPLATER = 'templater-obsidian';

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-readiness-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const CATALOGUE = loadConventionCatalogue();
/** A conventions file carrying exactly `ids`, in the library's own text. */
function conventionsText(ids) {
  return ['# Vault conventions', '', ...ids.map((id) => {
    const c = CATALOGUE.find((x) => x.id === id);
    assert.ok(c, `the library ships ${id}`);
    return c.text;
  })].join('\n');
}

/**
 * A vault folder. `plugins`: id → 'code' | 'settings'. `enabled`: the
 * community-plugins.json list. `files`: extra relative files (conventions…).
 */
function makeVault({ plugins = {}, enabled = [], files = {} } = {}) {
  const vault = fs.mkdtempSync(path.join(root, 'v-'));
  const pdir = path.join(vault, '.obsidian', 'plugins');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(enabled));
  for (const [id, kind] of Object.entries(plugins)) {
    const d = path.join(pdir, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'data.json'), '{}');
    if (kind === 'code') {
      fs.writeFileSync(path.join(d, 'main.js'), '/* code */');
      fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id, version: '1.0.0' }));
    }
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return vault;
}

const EXPECTED = [LRA, BRIDGE, TEMPLATER];
const ALL_CODE = { [LRA]: 'code', [BRIDGE]: 'code', [TEMPLATER]: 'code' };
const ALL_CONVENTIONS = { 'CLAUDE.md': conventionsText(RECOMMENDED_CONVENTIONS) };
const WIKI_OK = { catalog: true, hot: true };

const assess = (args) => assessAttachReadiness({ vault: 'Box', kind: 'remote', ...args }, { expected: EXPECTED });

describe('assessAttachReadiness — no disk', () => {
  test('remote, no disk, wiki present: the FIRST step declares --local-path; plugins and conventions unknown; not ready', () => {
    const r = assess({ diskPath: null, wiki: WIKI_OK });
    assert.match(r.nextSteps[0], /--attach "Box" --local-path <abs-dir>/);
    assert.equal(r.plugins.available, false);
    assert.equal(r.conventions.available, false);
    assert.equal(r.ready, false);
    const lines = formatReadiness(r).join('\n');
    assert.match(lines, /plugins {5}unknown \(no disk to read\)/);
    assert.match(lines, /conventions unknown \(no disk to read\)/);
  });

  test('remote, no disk, NO wiki (a blank vault): the wiki comes BEFORE --local-path — the folder can only be verified once the vault holds a note', () => {
    const r = assess({ diskPath: null, wiki: { catalog: false, hot: false } });
    assert.equal(r.nextSteps.length, 2, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /Create the wiki: \/obsidian-router:wiki/);
    assert.match(r.nextSteps[1], /--attach "Box" --local-path <abs-dir>/);
    assert.equal(r.ready, false);
  });
});

describe('assessAttachReadiness — plugins on disk', () => {
  test('missing plugin code: the install step names the ids and the --install-plugins command, then the reload/--plugin-health step', () => {
    const vault = makeVault({ plugins: { [LRA]: 'code', [BRIDGE]: 'settings' }, enabled: EXPECTED, files: ALL_CONVENTIONS });
    const r = assess({ diskPath: vault, wiki: WIKI_OK });
    assert.equal(r.nextSteps.length, 2, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /Install the missing plugin code \(2: mcp-router-bridge, templater-obsidian\)/);
    assert.match(r.nextSteps[0], /obsidian-mcp-router --install-plugins "Box" --dry-run/);
    assert.match(r.nextSteps[0], /--approved-plan-sha256/);
    assert.match(r.nextSteps[1], /Reload Obsidian/);
    assert.match(r.nextSteps[1], /obsidian-mcp-router --plugin-health "Box"/);
    assert.deepEqual(r.plugins.missing, [BRIDGE, TEMPLATER]);
    assert.equal(r.plugins.installed, 1);
    assert.equal(r.plugins.expected, 3);
    assert.equal(r.plugins.bridge, 'settings-only');
    assert.equal(r.ready, false);
  });

  test('enabled without code, nothing expected missing: the reload/--plugin-health step ALONE', () => {
    const vault = makeVault({ plugins: { ...ALL_CODE, 'some-extra': 'settings' }, enabled: [...EXPECTED, 'some-extra'], files: ALL_CONVENTIONS });
    const r = assess({ diskPath: vault, wiki: WIKI_OK });
    assert.deepEqual(r.plugins.missing, []);
    assert.deepEqual(r.plugins.enabledWithoutCode, ['some-extra']);
    assert.equal(r.nextSteps.length, 1, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /Reload Obsidian/);
    assert.doesNotMatch(r.nextSteps[0], /--install-plugins/);
    assert.match(formatReadiness(r).join('\n'), /enabled without code: some-extra/);
  });
});

describe('assessAttachReadiness — wiki and conventions', () => {
  test('wiki catalog false: a wiki step, and NO conventions step (conventions come after the wiki)', () => {
    const vault = makeVault({ plugins: ALL_CODE, enabled: EXPECTED });
    const r = assess({ diskPath: vault, wiki: { catalog: false, hot: false } });
    assert.equal(r.conventions.available, true);
    assert.equal(r.conventions.missingRecommended.length, 9, 'the conventions ARE missing — the step is withheld, not absent');
    assert.equal(r.nextSteps.length, 1, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /Create the wiki: \/obsidian-router:wiki/);
    assert.ok(!r.nextSteps.some((s) => /\/obsidian-router:conventions pick/.test(s)), 'no picker step before the wiki exists');
  });

  test('conventions missing from the recommended set: the picker step lists exactly those', () => {
    const present = ['roadmap-discipline', 'wiki-query-first'];
    const vault = makeVault({ plugins: ALL_CODE, enabled: EXPECTED, files: { 'CLAUDE.md': conventionsText(present) } });
    const r = assess({ diskPath: vault, wiki: WIKI_OK });
    const missing = RECOMMENDED_CONVENTIONS.filter((id) => !present.includes(id));
    assert.deepEqual(r.conventions.installed.sort(), [...present].sort());
    assert.deepEqual(r.conventions.missingRecommended, missing);
    assert.equal(r.nextSteps.length, 1, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /\/obsidian-router:conventions pick/);
    assert.ok(r.nextSteps[0].includes(`pre-checked: ${missing.join(', ')};`), r.nextSteps[0]);
    assert.equal(r.ready, false);
  });

  test('two CLAUDE.md candidates: a dedicated step, and no picker step', () => {
    const vault = makeVault({
      plugins: ALL_CODE,
      enabled: EXPECTED,
      files: { 'CLAUDE.md': conventionsText(['bilingual']), 'wiki-meta/CLAUDE.md': '# other\n' },
    });
    const r = assess({ diskPath: vault, wiki: WIKI_OK });
    assert.equal(r.conventions.ambiguous, true);
    assert.equal(r.nextSteps.length, 1, r.nextSteps.join('\n'));
    assert.match(r.nextSteps[0], /Two conventions files exist/);
    assert.doesNotMatch(r.nextSteps[0], /pre-checked/);
    assert.match(formatReadiness(r).join('\n'), /conventions 0 installed \(two candidate files\)/);
  });

  test('readConventionsFromDisk: no conventions file → nothing installed, the nine missing, no file', () => {
    const vault = makeVault({});
    const c = readConventionsFromDisk(vault);
    assert.equal(c.file, null);
    assert.equal(c.ambiguous, false);
    assert.deepEqual(c.installed, []);
    assert.deepEqual(c.missingRecommended, [...RECOMMENDED_CONVENTIONS]);
  });
});

describe('assessAttachReadiness — everything present', () => {
  test('ready true, no next step, and formatReadiness says "ready       yes"', () => {
    const vault = makeVault({ plugins: ALL_CODE, enabled: EXPECTED, files: ALL_CONVENTIONS });
    const r = assess({ diskPath: vault, wiki: WIKI_OK });
    assert.deepEqual(r.nextSteps, []);
    assert.equal(r.ready, true);
    const lines = formatReadiness(r).join('\n');
    assert.match(lines, /^ {2}ready {7}yes/m);
    assert.match(lines, /plugins {5}3\/3 with code · bridge: installed$/m);
    assert.doesNotMatch(lines, /next steps/);
  });

  test('a wiki that could not be probed (catalog null) is never "ready"', () => {
    const vault = makeVault({ plugins: ALL_CODE, enabled: EXPECTED, files: ALL_CONVENTIONS });
    const r = assess({ diskPath: vault, wiki: { catalog: null, hot: null } });
    assert.equal(r.ready, false);
  });
});

describe('RECOMMENDED_CONVENTIONS — drift guard', () => {
  /** The bullets `- **<id>** — …` of §1A.5, between the recommended-set sentence and the next paragraph. */
  function skillRecommended() {
    const md = fs.readFileSync(path.join(REPO, 'skills', 'meta-attach-vault', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const start = md.indexOf('### 1A.5');
    assert.ok(start >= 0, 'SKILL.md has a §1A.5');
    const anchor = md.indexOf('The recommended set', start);
    assert.ok(anchor >= 0, '§1A.5 still introduces "The recommended set"');
    const lines = md.slice(anchor).split('\n').slice(1);
    const ids = [];
    let seen = false;
    for (const line of lines) {
      const m = line.match(/^- \*\*([a-z0-9-]+)\*\* — /);
      if (m) { ids.push(m[1]); seen = true; continue; }
      if (seen && line.trim() !== '') break;
    }
    return ids;
  }

  test('equals the nine ids of skills/meta-attach-vault/SKILL.md §1A.5, in order', () => {
    const ids = skillRecommended();
    assert.equal(ids.length, 9, `parsed ${ids.length} bullets: ${ids.join(', ')}`);
    assert.deepEqual([...RECOMMENDED_CONVENTIONS], ids);
  });

  test('every id exists in skills/conventions/snippets/', () => {
    const dir = path.join(REPO, 'skills', 'conventions', 'snippets');
    const missing = RECOMMENDED_CONVENTIONS.filter((id) => !fs.existsSync(path.join(dir, `${id}.md`)));
    assert.deepEqual(missing, [], `${missing.length}/${RECOMMENDED_CONVENTIONS.length} have no snippet`);
    assert.ok(RECOMMENDED_CONVENTIONS.every((id) => CATALOGUE.some((c) => c.id === id)), 'every id is a loadable catalogue entry');
  });
});
