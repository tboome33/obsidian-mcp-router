#!/usr/bin/env node
/**
 * validate-capabilities.mjs — the C8 gate.
 *
 * Fails (exit 1) when the three tellings of the same story disagree:
 *   CODE      — the router's MCP tool catalog + the agent tool allowlists
 *   DOC       — skills/<name>/SKILL.md, and the artifact counters in
 *               README.md / docs/architecture.md
 *   MANIFEST  — contracts/skill-capabilities.json, .claude-plugin/*.json
 *
 * Run by `npm run validate`, by the test suite
 * (tests/skill-capabilities.test.mjs asserts the live repo is clean), and by
 * CI as its own step so the failure names itself instead of hiding inside a
 * 3000-test run.
 *
 * Usage:
 *   node scripts/validate-capabilities.mjs           # human output
 *   node scripts/validate-capabilities.mjs --json    # machine output
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCapabilityValidation, renderIssues } from '../src/helpers/skill-capabilities.mjs';
import { _internals } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const asJson = process.argv.includes('--json');
const toolNames = new Set(_internals.TOOLS.map((t) => t.name));
const writeToolNames = _internals.WRITE_TOOL_NAMES;
const { issues, counts, skillCount } = runCapabilityValidation(REPO_ROOT, { toolNames, writeToolNames });

if (asJson) {
  console.log(JSON.stringify({ ok: issues.length === 0, counts, skillCount, issues }, null, 2));
} else {
  console.log(renderIssues(issues));
  if (issues.length === 0) {
    console.log(
      `  ${skillCount} skills declared · ${counts.commands} commands · ${counts.agents} agents · `
      + `${counts.hooks} hooks · ${counts.tools} MCP tools — doc, manifest and code agree.`,
    );
  }
}

// process.exitCode, not process.exit(): the latter can truncate piped stdout
// in CI before the findings have flushed, turning a real failure into a
// mysterious blank one.
process.exitCode = issues.length === 0 ? 0 : 1;
