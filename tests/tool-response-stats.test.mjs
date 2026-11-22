/**
 * Phase 0 of the RTK borrowing roadmap: measuring the router's responses per
 * tool from Claude Code transcripts. Two layers are tested:
 *
 *   - the pure helper `src/helpers/tool-response-stats.mjs` — matching, the
 *     "too large to show" stand-in, de-duplication, the compact-JSON figure;
 *   - the CLI `scripts/measure-tool-responses.mjs`, driven end to end on a
 *     transcript store built in a temporary directory, including the property
 *     the whole thing rests on: it prints NO content.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  routerToolName, parseDiverted, resultText, measureText, collectFromLines, newState, summarize,
} from '../src/helpers/tool-response-stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'measure-tool-responses.mjs');

// One transcript line for a tool call, and one for its result, in the shape
// Claude Code writes them.
const useLine = (id, name) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const resultLine = (id, content, extra = {}) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});

describe('routerToolName', () => {
  test('recognises the plugin name and the hand-declared server name', () => {
    assert.equal(routerToolName('mcp__plugin_obsidian-router_router__search'), 'search');
    assert.equal(routerToolName('mcp__obsidian-router__get_file'), 'get_file');
  });

  test('refuses every other tool', () => {
    for (const name of ['Read', 'mcp__other__search', 'mcp__plugin_other_router__search', '', null, undefined]) {
      assert.equal(routerToolName(name), null, String(name));
    }
  });
});

describe('parseDiverted', () => {
  test('reads the original size whatever the digit grouping, and the saved path', () => {
    for (const grouped of ['72655', '72 655', '72 655', '72 655', '72,655']) {
      const text = `Error: result (${grouped} characters across 1 886 lines) exceeds maximum allowed tokens. `
        + 'Output has been saved to /tmp/x/tool-results/mcp-plugin_obsidian-router_router-search-1-a.txt.\nFormat: Plain text';
      const d = parseDiverted(text);
      assert.ok(d, grouped);
      assert.equal(d.originalChars, 72655, grouped);
      assert.equal(d.savedPath, '/tmp/x/tool-results/mcp-plugin_obsidian-router_router-search-1-a.txt');
    }
  });

  test('a normal result, or an error that merely mentions the phrase later, is not a diversion', () => {
    assert.equal(parseDiverted('{"ok":true}'), null);
    assert.equal(parseDiverted('note: result (5 characters across 1 lines) exceeds maximum allowed tokens'), null);
  });
});

describe('resultText and measureText', () => {
  test('joins text blocks and counts the other blocks apart', () => {
    assert.deepEqual(resultText('abc'), { text: 'abc', otherBlocks: 0 });
    assert.deepEqual(
      resultText([{ type: 'text', text: 'a' }, { type: 'image', data: 'xx' }, { type: 'text', text: 'b' }]),
      { text: 'ab', otherBlocks: 1 },
    );
    assert.deepEqual(resultText(undefined), { text: '', otherBlocks: 0 });
  });

  test('counts UTF-8 bytes, not characters', () => {
    assert.equal(measureText('é').bytes, 2);
    assert.equal(measureText('🇫🇷').bytes, 8);
  });

  test('gives the compact size of an indented JSON object and recognises the router\'s rendering', () => {
    const value = { vault: 'v', matches: [{ filename: 'a.md', context: 'ligne 1\r\nligne "2"\\' }] };
    const pretty = JSON.stringify(value, null, 2);
    const m = measureText(pretty);
    assert.equal(m.bytes, Buffer.byteLength(pretty));
    assert.equal(m.compactBytes, Buffer.byteLength(JSON.stringify(value)));
    assert.ok(m.compactBytes < m.bytes, 'indentation must be the difference');
    assert.equal(m.pretty, true);
    assert.equal(measureText(JSON.stringify(value)).pretty, false, 'compact text is not the 2-space rendering');
  });

  test('plain text and JSON scalars have nothing to compact', () => {
    assert.equal(measureText('Error: nope').compactBytes, null);
    assert.equal(measureText('42').compactBytes, null);
    assert.equal(measureText('"str"').compactBytes, null);
  });
});

describe('collectFromLines', () => {
  test('keeps only the router\'s calls, pairs them with their results, counts each id once', () => {
    const state = newState();
    const lines = [
      useLine('t1', 'mcp__plugin_obsidian-router_router__search'),
      useLine('t2', 'Read'),
      'not json but mentions "tool_use"',
      resultLine('t1', JSON.stringify({ a: 1 }, null, 2)),
      resultLine('t2', 'file body'),
      useLine('t3', 'mcp__obsidian-router__get_file'),
      resultLine('t3', [{ type: 'text', text: 'boom' }], { is_error: true }),
    ];
    collectFromLines(lines, state);
    // A resumed session copies earlier lines into its file: the copy must not count.
    collectFromLines([lines[0], lines[3]], state);
    assert.equal(state.records.length, 2);
    assert.deepEqual(state.records.map((r) => r.tool), ['search', 'get_file']);
    assert.equal(state.records[1].isError, true);
    assert.equal(state.unparsable, 1);
    assert.equal(state.pending.size, 0);
  });

  test('a call whose result never arrived stays pending instead of being counted as empty', () => {
    const state = newState();
    collectFromLines([useLine('t9', 'mcp__obsidian-router__search')], state);
    assert.equal(state.records.length, 0);
    assert.equal(state.pending.size, 1);
  });
});

describe('summarize', () => {
  test('per-tool totals, median, p95 and max, heaviest tool first', () => {
    const rec = (tool, bytes, extra = {}) => ({ tool, bytes, compactBytes: null, pretty: false, isError: false, diverted: null, ...extra });
    const rows = summarize([
      rec('a', 10), rec('a', 20), rec('a', 30), rec('a', 40),
      rec('b', 500, { compactBytes: 300, pretty: true }),
      rec('b', 100, { diverted: { originalChars: 9 }, fullBytes: 900, fullCompactBytes: 600 }),
    ]);
    assert.deepEqual(rows.map((r) => r.tool), ['b', 'a']);
    const a = rows[1];
    assert.equal(a.calls, 4);
    assert.equal(a.bytes, 100);
    assert.equal(a.median, 20);
    assert.equal(a.p95, 40);
    assert.equal(a.max, 40);
    const b = rows[0];
    assert.equal(b.jsonCalls, 1);
    assert.equal(b.prettyCalls, 1);
    assert.equal(b.compactBytes, 300);
    assert.equal(b.diverted, 1);
    assert.equal(b.divertedRecovered, 1);
    assert.equal(b.divertedFullBytes, 900);
    assert.equal(b.divertedFullCompactBytes, 600);
  });
});

describe('measure-tool-responses CLI', () => {
  // A transcript store in a temporary directory, with a HOME that points there
  // too, so nothing on the real machine is read.
  function buildStore() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-measure-'));
    const projects = path.join(tmp, '.claude', 'projects');
    const proj = path.join(projects, 'proj-alpha');
    const saved = path.join(proj, 'sess', 'tool-results', 'mcp-plugin_obsidian-router_router-search-1-a.txt');
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    const secret = 'CONTENU-PRIVE-DU-VAULT';
    const big = JSON.stringify({ matches: [{ context: `${secret} `.repeat(50) }] }, null, 2);
    fs.writeFileSync(saved, big);
    const diverted = `Error: result (${big.length} characters across 9 lines) exceeds maximum allowed tokens. Output has been saved to ${saved}.`;
    const lines = [
      useLine('u1', 'mcp__plugin_obsidian-router_router__search'),
      resultLine('u1', JSON.stringify({ hit: secret }, null, 2)),
      useLine('u2', 'mcp__plugin_obsidian-router_router__search'),
      resultLine('u2', diverted),
      useLine('u3', 'mcp__plugin_obsidian-router_router__get_file'),
      resultLine('u3', [{ type: 'text', text: secret }]),
    ];
    fs.writeFileSync(path.join(proj, 'sess.jsonl'), `${lines.join('\n')}\n`);
    // A second project, a sub-agent transcript, holding a COPY of u1 and a new call.
    const sub = path.join(projects, 'proj-beta', 'sess2', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent.jsonl'), [
      lines[0], lines[1],
      useLine('v1', 'mcp__obsidian-router__list_vaults'),
      resultLine('v1', JSON.stringify({ vaults: [] }, null, 2)),
    ].join('\n'));
    return { tmp, projects, secret, big };
  }

  function run(args, tmp) {
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, HOMEDRIVE: '', HOMEPATH: tmp };
    return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  }

  test('measures every router call once, recovers the diverted one, prints no content', () => {
    const { tmp, projects, secret, big } = buildStore();
    try {
      const res = run(['--projects', projects, '--json'], tmp);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!res.stdout.includes(secret), 'the report must not quote a response');
      const report = JSON.parse(res.stdout);
      assert.equal(report.transcriptsRead, 2);
      assert.equal(report.totals.calls, 4, 'u1 is in two files and counts once');
      assert.equal(report.totals.diverted, 1);
      assert.equal(report.totals.divertedRecovered, 1);
      assert.equal(report.totals.divertedFullBytes, Buffer.byteLength(big));
      const tools = Object.fromEntries(report.tools.map((r) => [r.tool, r]));
      assert.equal(tools.search.calls, 2);
      assert.equal(tools.get_file.calls, 1);
      assert.equal(tools.list_vaults.calls, 1);
      // Shown JSON: u1 and v1. The diverted stand-in and the get_file text are plain text;
      // the diverted result's own JSON is counted apart, from the saved file.
      assert.equal(report.totals.jsonCalls, 2);
      assert.equal(report.totals.prettyCalls, 2);
      assert.equal(report.totals.divertedFullJsonBytes, Buffer.byteLength(big));
      assert.equal(report.totals.divertedFullCompactBytes, Buffer.byteLength(JSON.stringify(JSON.parse(big))));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the table form prints no content either', () => {
    const { tmp, projects, secret } = buildStore();
    try {
      const res = run(['--projects', projects], tmp);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!res.stdout.includes(secret));
      assert.match(res.stdout, /Calls measured: 4\b/);
      assert.match(res.stdout, /Too large to show \(diverted to a file\): 1\/4, recovered 1\/1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--project narrows to one project directory', () => {
    const { tmp, projects } = buildStore();
    try {
      const res = run(['--projects', projects, '--project', 'beta', '--json'], tmp);
      assert.equal(res.status, 0, res.stderr);
      const report = JSON.parse(res.stdout);
      assert.equal(report.transcriptsRead, 1);
      assert.equal(report.totals.calls, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing store is reported as unmeasured, not as zero calls', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-measure-'));
    try {
      const res = run(['--projects', path.join(tmp, 'nope')], tmp);
      assert.equal(res.status, 3);
      assert.match(res.stderr, /nothing measured/);
      assert.equal(res.stdout, '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('bad arguments are refused', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-measure-'));
    try {
      assert.equal(run(['--since', 'yesterday'], tmp).status, 2);
      assert.equal(run(['--bogus'], tmp).status, 2);
      assert.equal(run(['--match', '('], tmp).status !== 0, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
