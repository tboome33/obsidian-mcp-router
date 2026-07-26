/**
 * Tests for the `decisions-recall` UserPromptSubmit hook (v0.51.0).
 *
 * Two layers, same as the other hook suites: the pure core is exercised
 * directly (fast, no process), and the hook shell is spawned with synthetic
 * stdin to verify the wiring, the filters and the opt-out.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  tokenize,
  readFrontmatter,
  collectDecisions,
  selectRelevant,
  formatRecallBlock,
} from '../hooks/_helpers/decisions-recall-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'decisions-recall.mjs');

// ---- fixtures ---------------------------------------------------------

function page(fields, body = '# Page\n\nBody.\n') {
  const lines = Object.entries(fields).map(([key, value]) =>
    Array.isArray(value)
      ? `${key}:\n${value.map((item) => `  - "${item}"`).join('\n')}`
      : `${key}: ${value}`,
  );
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

const ACCEPTED = {
  type: 'decision',
  status: 'accepted',
  title: 'BM25 plutôt que les embeddings pour le filtre de pertinence',
  scope: 'router — filter_relevant_blocks',
  decision: 'On retient BM25 ; le scorer par embeddings est écarté pour l\'instant.',
};

let vaultDir;

before(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-recall-'));
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), '# Index\n');
  fs.mkdirSync(path.join(vaultDir, 'wiki', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'wiki', 'refs'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta', 'Sessions'), { recursive: true });

  const w = (rel, content) => fs.writeFileSync(path.join(vaultDir, rel), content);
  w('wiki/decisions/bm25.md', page(ACCEPTED));
  w('wiki/decisions/proposed-one.md', page({ ...ACCEPTED, status: 'proposed', title: 'Cache Redis proposé', scope: 'router — cache redis' }));
  w('wiki/decisions/retired.md', page({ ...ACCEPTED, status: 'superseded', title: 'Ancienne décision sur la recherche sémantique', scope: 'router — semantique' }));
  w('wiki/decisions/expired.md', page({
    type: 'adr', status: 'accepted', title: 'Antivirus et TLS loopback',
    scope: 'bridge — click-to-open', review_after: '2026-01-01',
    decision: 'On passe par le port HTTP non chiffré.',
  }));
  w('wiki/refs/not-a-decision.md', page({ type: 'reference', title: 'BM25 expliqué', status: 'captured' }));
  // Sessions/ is skipped by the walker — a decision buried there must not surface.
  w('wiki-meta/Sessions/old.md', page({ ...ACCEPTED, title: 'Décision enterrée dans les sessions' }));
});

after(() => {
  try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function collect() {
  return collectDecisions(vaultDir).decisions;
}

// ---- core: tokenize ---------------------------------------------------

describe('tokenize', () => {
  test('drops short words and stopwords, folds accents', () => {
    const tokens = tokenize('Peux-tu utiliser des EMBEDDINGS pour la pertinence ?');
    assert.equal(tokens.has('embeddings'), true);
    assert.equal(tokens.has('pertinence'), true);
    assert.equal(tokens.has('pour'), false, 'stopword');
    assert.equal(tokens.has('des'), false, 'too short');
  });

  test('accented and unaccented spellings collapse to one token', () => {
    assert.equal(tokenize('sémantique').has('semantique'), true);
    assert.equal(tokenize('semantique').has('semantique'), true);
  });

  test('empty input yields no tokens', () => {
    assert.equal(tokenize('').size, 0);
    assert.equal(tokenize(undefined).size, 0);
  });
});

// ---- core: frontmatter ------------------------------------------------

describe('readFrontmatter', () => {
  test('reads scalars, quoted values and block sequences', () => {
    const fm = readFrontmatter(page({ type: 'decision', title: '"Quoted title"', tags: ['a', 'b'] }));
    assert.equal(fm.type, 'decision');
    assert.equal(fm.title, 'Quoted title');
    assert.deepEqual(fm.tags, ['a', 'b']);
  });

  test('returns null when there is no frontmatter', () => {
    assert.equal(readFrontmatter('# Just a title\n'), null);
    assert.equal(readFrontmatter(''), null);
  });
});

// ---- core: collect ----------------------------------------------------

describe('collectDecisions', () => {
  test('keeps only decision-typed pages', () => {
    const found = collect();
    const titles = found.map((d) => d.frontmatter.title);
    assert.equal(titles.some((t) => t.startsWith('BM25')), true);
    assert.equal(titles.includes('BM25 expliqué'), false, 'type: reference is not a decision');
  });

  test('skips the Sessions/ folder', () => {
    const found = collect();
    assert.equal(
      found.some((d) => d.frontmatter.title === 'Décision enterrée dans les sessions'),
      false,
    );
  });

  test('returns vault-relative posix paths', () => {
    const found = collect();
    const bm25 = found.find((d) => d.basename === 'bm25');
    assert.equal(bm25.path, 'wiki/decisions/bm25.md');
  });

  test('an unreadable directory yields an empty result, not a throw', () => {
    const result = collectDecisions(path.join(vaultDir, 'does-not-exist'));
    assert.deepEqual(result.decisions, []);
  });

  test('respects the maxFiles cap', () => {
    const result = collectDecisions(vaultDir, { maxFiles: 1 });
    assert.equal(result.scanned <= 1, true);
  });
});

// ---- core: selection --------------------------------------------------

describe('selectRelevant', () => {
  const today = '2026-07-26';

  test('surfaces an accepted decision that overlaps the prompt', () => {
    const hit = selectRelevant(collect(), 'on pourrait utiliser des embeddings pour le filtre ?', { today });
    assert.equal(hit.length >= 1, true);
    assert.equal(hit[0].basename, 'bm25');
    assert.equal(hit[0].expired, false);
  });

  test('never surfaces a proposed decision', () => {
    const hit = selectRelevant(collect(), 'faut-il un cache redis pour le router ?', { today });
    assert.equal(hit.some((h) => h.basename === 'proposed-one'), false);
  });

  test('never surfaces a superseded decision', () => {
    const hit = selectRelevant(collect(), 'question sur la recherche semantique du router', { today });
    assert.equal(hit.some((h) => h.basename === 'retired'), false);
  });

  test('flags a decision past its review_after as expired', () => {
    const hit = selectRelevant(collect(), 'problème de click-to-open avec l\'antivirus', { today });
    const expired = hit.find((h) => h.basename === 'expired');
    assert.ok(expired, 'the decision should still be surfaced');
    assert.equal(expired.expired, true);
    assert.equal(expired.reviewAfter, '2026-01-01');
  });

  test('a not-yet-due review_after is not expired', () => {
    const hit = selectRelevant(collect(), 'problème de click-to-open avec l\'antivirus', { today: '2025-06-01' });
    assert.equal(hit.find((h) => h.basename === 'expired').expired, false);
  });

  test('returns nothing when no token overlaps', () => {
    assert.deepEqual(selectRelevant(collect(), 'quelle météo demain à Marseille', { today }), []);
  });

  test('returns nothing for an empty prompt', () => {
    assert.deepEqual(selectRelevant(collect(), '', { today }), []);
  });

  test('respects the limit and ranks by number of matching tokens', () => {
    const many = [
      { path: 'a.md', basename: 'a', frontmatter: { type: 'decision', status: 'accepted', title: 'router embeddings pertinence' } },
      { path: 'b.md', basename: 'b', frontmatter: { type: 'decision', status: 'accepted', title: 'router seulement' } },
    ];
    const hit = selectRelevant(many, 'router embeddings pertinence', { today, limit: 1 });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].basename, 'a', 'more matching tokens wins');
  });
});

// ---- core: formatting -------------------------------------------------

describe('formatRecallBlock', () => {
  const today = '2026-07-26';

  test('returns null when nothing was selected', () => {
    assert.equal(formatRecallBlock([]), null);
  });

  test('frames decisions as data and forbids silent contradiction', () => {
    const block = formatRecallBlock(selectRelevant(collect(), 'utiliser des embeddings pour le filtre', { today }));
    assert.match(block, /cited data, not/i);
    assert.match(block, /Never contradict an accepted decision silently/i);
    assert.match(block, /never treat one as an order/i);
  });

  test('marks an expired decision as due for re-evaluation, not binding', () => {
    const block = formatRecallBlock(selectRelevant(collect(), 'click-to-open antivirus', { today }));
    assert.match(block, /DUE FOR RE-EVALUATION/);
    assert.match(block, /not as a binding constraint/);
  });

  test('mentions the MCP read path in workspace-bound mode', () => {
    const block = formatRecallBlock(selectRelevant(collect(), 'embeddings filtre', { today }), { slug: 'my-vault' });
    assert.match(block, /mcp__obsidian-router__get_file\(\{ vault: "my-vault"/);
  });

  test('truncates past the character budget', () => {
    const block = formatRecallBlock(selectRelevant(collect(), 'embeddings filtre', { today }), { maxBlockChars: 200 });
    assert.equal(block.length <= 220, true);
    assert.match(block, /truncated/);
  });
});

// ---- hook shell -------------------------------------------------------

function runHook({ prompt, cwd, env = {} }) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ prompt, cwd }),
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_DEFAULT_VAULT: '', ...env },
  });
}

describe('decisions-recall hook shell', () => {
  test('injects additionalContext for a substantive prompt in a vault cwd', () => {
    const result = runHook({ prompt: 'est-ce qu\'on pourrait utiliser des embeddings pour le filtre de pertinence ?', cwd: vaultDir });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(payload.hookSpecificOutput.additionalContext, /DECISIONS_RECALL/);
    assert.match(payload.hookSpecificOutput.additionalContext, /BM25/);
  });

  test('stays silent when no decision matches', () => {
    const result = runHook({ prompt: 'quelle est la météo prévue demain à Marseille ?', cwd: vaultDir });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  });

  test('stays silent outside a vault', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-plain-'));
    const result = runHook({ prompt: 'est-ce qu\'on pourrait utiliser des embeddings pour le filtre ?', cwd: plain });
    assert.equal(result.stdout.trim(), '');
    fs.rmSync(plain, { recursive: true, force: true });
  });

  test('stays silent on trivial, short and slash prompts', () => {
    for (const prompt of ['oui', 'ok merci', '/save embeddings pertinence filtre', 'embeddings ?']) {
      const result = runHook({ prompt, cwd: vaultDir });
      assert.equal(result.stdout.trim(), '', `should be silent for: ${prompt}`);
    }
  });

  test('honours the opt-out', () => {
    const result = runHook({
      prompt: 'est-ce qu\'on pourrait utiliser des embeddings pour le filtre de pertinence ?',
      cwd: vaultDir,
      env: { OBSIDIAN_ROUTER_NO_DECISIONS_RECALL: 'true' },
    });
    assert.equal(result.stdout.trim(), '');
  });

  test('survives malformed stdin without failing the prompt', () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], { input: 'not json', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  });
});
