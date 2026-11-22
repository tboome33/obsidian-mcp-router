#!/usr/bin/env node
/**
 * MEASURE THE ROUTER'S RESPONSES, TOOL BY TOOL, FROM CLAUDE CODE TRANSCRIPTS.
 *
 * Why this script exists: the RTK borrowing roadmap (vault page `rtk-roadmap`)
 * proposes to make the router's answers lighter, and its first review said the
 * obvious thing — rank the work by measured weight, not by intuition. Claude
 * Code already records every tool call and the exact text the model got back,
 * so the measurement needs no change to the server: it reads that record.
 *
 * READ-ONLY, AND IT PRINTS NO CONTENT. It reads transcripts (and the files the
 * client set aside for results too large to show) in order to count them, and
 * prints numbers only: calls, bytes, how many results were too large to show,
 * and what compact JSON would weigh. Nothing it prints quotes a vault.
 *
 *   node scripts/measure-tool-responses.mjs
 *   node scripts/measure-tool-responses.mjs --since 2026-11-01
 *   node scripts/measure-tool-responses.mjs --project obsidian-mcp-router --json
 *   node scripts/measure-tool-responses.mjs --projects <dir>
 *
 * Sizes are UTF-8 BYTES, never tokens: no tokenizer for the target model is
 * available offline. Only Claude Code sessions on this machine are covered —
 * claude.ai through MCPHub, Codex and other hosts keep their own records.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  DEFAULT_TOOL_MATCHER, collectFromLines, newState, summarize, measureText,
} from '../src/helpers/tool-response-stats.mjs';

function parseArgs(argv) {
  const args = { projects: null, project: null, since: null, json: false, match: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--projects') args.projects = next();
    else if (a === '--project') args.project = next();
    else if (a === '--since') args.since = next();
    else if (a === '--match') args.match = next();
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error(`--since wants YYYY-MM-DD, got ${JSON.stringify(args.since)}`);
  }
  return args;
}

// Every *.jsonl under the root, sub-agent transcripts included. A directory
// that cannot be read is REPORTED, never skipped in silence: a hole in the walk
// is a hole in the totals, and the reader has to know it is there.
function listTranscripts(root, unreadable) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ path: dir, error: err.code ?? err.message });
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

async function readLines(file, state, matcher) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const batch = [];
  for await (const line of rl) {
    batch.push(line);
    if (batch.length >= 500) collectFromLines(batch.splice(0), state, { matcher });
  }
  collectFromLines(batch, state, { matcher });
}

// A result too large to show was written to a file by the client; when that
// file is still there, measure what the tool really produced.
function recoverDiverted(records) {
  let missing = 0;
  for (const r of records) {
    if (!r.diverted) continue;
    const p = r.diverted.savedPath;
    let text = null;
    if (p) {
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
    }
    if (text === null) {
      missing += 1;
      continue;
    }
    const m = measureText(text);
    r.fullBytes = m.bytes;
    if (m.compactBytes !== null) r.fullCompactBytes = m.compactBytes;
  }
  return missing;
}

function pct(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

function render(report) {
  const lines = [];
  lines.push(`Router tool responses in Claude Code transcripts — ${report.scope}`);
  lines.push(`Transcripts read: ${report.transcriptsRead}/${report.transcriptsFound}`
    + (report.unreadable.length ? ` (${report.unreadable.length} unreadable — totals are incomplete)` : ''));
  lines.push(`Calls measured: ${report.totals.calls} (${report.totals.unanswered} calls without a result in the record)`);
  lines.push(`Bytes received by the model: ${report.totals.bytes}`);
  lines.push(`Too large to show (diverted to a file): ${report.totals.diverted}/${report.totals.calls}`
    + `, recovered ${report.totals.divertedRecovered}/${report.totals.diverted}`);
  lines.push(`JSON responses: ${report.totals.jsonCalls}/${report.totals.calls}`
    + `, of which 2-space indented: ${report.totals.prettyCalls}/${report.totals.jsonCalls}`);
  lines.push(`Compact JSON would remove ${report.totals.jsonBytes - report.totals.compactBytes}/${report.totals.jsonBytes} bytes`
    + ` (${pct(report.totals.jsonBytes - report.totals.compactBytes, report.totals.jsonBytes)}) of the JSON responses shown`);
  lines.push('');
  lines.push('tool | calls | bytes | share | median | p95 | max | diverted | compact saves');
  lines.push('---|---|---|---|---|---|---|---|---');
  for (const r of report.tools) {
    lines.push([
      r.tool, r.calls, r.bytes, pct(r.bytes, report.totals.bytes), r.median, r.p95, r.max,
      r.diverted ? `${r.diverted} (${r.divertedFullBytes} B behind)` : 0,
      r.jsonBytes ? pct(r.jsonBytes - r.compactBytes, r.jsonBytes) : '—',
    ].join(' | '));
  }
  lines.push('');
  lines.push('Bytes are UTF-8 bytes of the text the model received, not tokens.');
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`measure-tool-responses: ${err.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log('usage: node scripts/measure-tool-responses.mjs [--projects <dir>] [--project <name part>] [--since YYYY-MM-DD] [--match <regex>] [--json]');
    return;
  }
  const root = args.projects ?? path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) {
    // UNAVAILABLE IS NOT ZERO. No transcript store means nothing was measured,
    // and a table of zeros would say the opposite.
    console.error(`measure-tool-responses: no transcript store at ${root} — nothing measured`);
    process.exit(3);
  }
  let matcher = DEFAULT_TOOL_MATCHER;
  if (args.match) {
    try {
      matcher = new RegExp(args.match);
    } catch (err) {
      console.error(`measure-tool-responses: --match is not a valid regex: ${err.message}`);
      process.exit(2);
    }
  }
  const unreadable = [];
  let files = listTranscripts(root, unreadable);
  const found = files.length;
  if (args.project) {
    const needle = args.project.toLowerCase();
    files = files.filter((f) => path.relative(root, f).split(path.sep)[0].toLowerCase().includes(needle));
  }
  if (args.since) {
    const since = Date.parse(`${args.since}T00:00:00Z`);
    files = files.filter((f) => {
      try {
        return fs.statSync(f).mtimeMs >= since;
      } catch {
        return false;
      }
    });
  }
  const state = newState();
  let read = 0;
  for (const f of files) {
    try {
      await readLines(f, state, matcher);
      read += 1;
    } catch (err) {
      unreadable.push({ path: f, error: err.code ?? err.message });
    }
  }
  const missing = recoverDiverted(state.records);
  const tools = summarize(state.records);
  const sum = (k) => tools.reduce((n, r) => n + r[k], 0);
  const report = {
    scope: [
      args.project ? `project ~ "${args.project}"` : 'all projects',
      args.since ? `transcripts modified since ${args.since}` : 'all dates',
    ].join(', '),
    transcriptsFound: args.project || args.since ? files.length : found,
    transcriptsRead: read,
    unreadable,
    unparsableLines: state.unparsable,
    totals: {
      calls: state.records.length,
      unanswered: state.pending.size,
      bytes: sum('bytes'),
      diverted: sum('diverted'),
      divertedRecovered: sum('divertedRecovered'),
      divertedMissing: missing,
      divertedFullBytes: sum('divertedFullBytes'),
      jsonCalls: sum('jsonCalls'),
      prettyCalls: sum('prettyCalls'),
      jsonBytes: sum('jsonBytes'),
      compactBytes: sum('compactBytes'),
      divertedFullJsonBytes: sum('divertedFullJsonBytes'),
      divertedFullCompactBytes: sum('divertedFullCompactBytes'),
    },
    tools,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
}

await main();
