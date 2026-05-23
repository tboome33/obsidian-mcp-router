/**
 * Tests for v0.9.0 OBSIDIAN_ROUTER_USER_ID audit-log behavior.
 *
 * When the env var is set, every SUCCESSFUL write tool gets a line
 * appended to `<vault>/wiki-meta/log.md` (v0.12.0+) with `[claude-write by <user>]` and
 * a timestamp. Used by the multi-tenant MCPHub deployment to track
 * "who wrote what" without modifying any downstream tool.
 *
 * Unit-tested here: the pure helpers (`pickAuditPath`, `formatAuditLine`).
 * Integration coverage of the actual append is left to deploy-time smoke
 * tests — mocking the rest-client.mjs path would invert the dependency
 * (the test would be testing the mock more than the code).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickAuditPath, formatAuditLine } from '../src/index.mjs';

// ---------------------------------------------------------------------------
// pickAuditPath — extract the touched-file field from args
// ---------------------------------------------------------------------------

describe('pickAuditPath', () => {
  test('default — uses args.path', () => {
    assert.equal(pickAuditPath('write_file', { path: 'Sessions/today.md' }), 'Sessions/today.md');
    assert.equal(pickAuditPath('append_to_file', { path: 'log.md' }), 'log.md');
    assert.equal(pickAuditPath('patch_file', { path: 'a.md' }), 'a.md');
    assert.equal(pickAuditPath('set_frontmatter', { path: 'b.md' }), 'b.md');
    assert.equal(pickAuditPath('merge_frontmatter', { path: 'c.md' }), 'c.md');
    assert.equal(pickAuditPath('delete_file', { path: 'd.md' }), 'd.md');
  });

  test('move_file — prefers args.to (destination)', () => {
    assert.equal(
      pickAuditPath('move_file', { from: 'old.md', to: 'new.md' }),
      'new.md',
      'audit should show where the file ended up, not where it started',
    );
  });

  test('move_file — falls back to args.from if to is missing', () => {
    assert.equal(pickAuditPath('move_file', { from: 'old.md' }), 'old.md');
  });

  test('execute_template — prefers args.targetPath', () => {
    assert.equal(
      pickAuditPath('execute_template', {
        name: 'Templates/Daily.md',
        targetPath: 'Sessions/2026-05-21.md',
      }),
      'Sessions/2026-05-21.md',
      'audit should track the OUTPUT path, not the template path',
    );
  });

  test('execute_template — falls back to args.name when not creating a file', () => {
    assert.equal(
      pickAuditPath('execute_template', { name: 'Templates/Echo.md' }),
      'Templates/Echo.md',
    );
  });

  test('missing path → (unknown) sentinel (never throw)', () => {
    assert.equal(pickAuditPath('write_file', {}), '(unknown)');
    assert.equal(pickAuditPath('move_file', {}), '(unknown)');
    assert.equal(pickAuditPath('execute_template', {}), '(unknown)');
  });
});

// ---------------------------------------------------------------------------
// formatAuditLine — stable shape so we can grep it later
// ---------------------------------------------------------------------------

describe('formatAuditLine', () => {
  test('leading and trailing newlines isolate the entry', () => {
    const line = formatAuditLine({
      userId: 'roland',
      toolName: 'write_file',
      auditPath: 'Sessions/today.md',
      now: new Date('2026-05-21T14:32:00Z'),
    });
    assert.ok(line.startsWith('\n'));
    assert.ok(line.endsWith('\n'));
  });

  test('contains [claude-write by <userId>] marker', () => {
    const line = formatAuditLine({
      userId: 'karine',
      toolName: 'append_to_file',
      auditPath: 'journal.md',
      now: new Date('2026-05-21T14:32:00Z'),
    });
    assert.ok(line.includes('[claude-write by karine]'));
  });

  test('contains the tool name and the path', () => {
    const line = formatAuditLine({
      userId: 'nicolas',
      toolName: 'patch_file',
      auditPath: 'Refs/wp.md',
      now: new Date('2026-05-21T14:32:00Z'),
    });
    assert.ok(line.includes('patch_file'));
    assert.ok(line.includes('path="Refs/wp.md"'));
  });

  test('timestamp format is YYYY-MM-DD HH:MM (minute resolution, UTC)', () => {
    const line = formatAuditLine({
      userId: 'r',
      toolName: 'write_file',
      auditPath: 'p.md',
      now: new Date('2026-05-21T14:32:45.123Z'),
    });
    // 14:32 = minute precision, seconds dropped.
    assert.match(line, /2026-05-21 14:32/);
    assert.ok(!line.includes('14:32:45'), 'seconds should be dropped for stability');
  });

  test('different users at the same timestamp produce DIFFERENT lines', () => {
    const a = formatAuditLine({
      userId: 'roland',
      toolName: 'write_file',
      auditPath: 'p.md',
      now: new Date('2026-05-21T14:32:00Z'),
    });
    const b = formatAuditLine({
      userId: 'karine',
      toolName: 'write_file',
      auditPath: 'p.md',
      now: new Date('2026-05-21T14:32:00Z'),
    });
    assert.notEqual(a, b);
    assert.ok(a.includes('roland') && !a.includes('karine'));
    assert.ok(b.includes('karine') && !b.includes('roland'));
  });

  test('greppable format: a known-good line passes a stable regex', () => {
    const line = formatAuditLine({
      userId: 'maxence',
      toolName: 'merge_frontmatter',
      auditPath: 'Studies/SVT/bio.md',
      now: new Date('2026-05-21T07:15:30Z'),
    });
    // The shape that downstream tooling (audit dashboards, git log greps)
    // can rely on. If this regex breaks, downstream consumers break too —
    // bump the major if you intentionally change the format.
    const SHAPE = /^\n\[claude-write by [\w.@-]+\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — \w+ path="[^"]*"\n$/;
    assert.match(line, SHAPE);
  });
});

// ---------------------------------------------------------------------------
// Wire-up sanity — verify the audit middleware is actually present in
// the dispatcher source. A pure structural test, but it catches "someone
// removed the audit block during a refactor" without running the server.
// ---------------------------------------------------------------------------

describe('audit middleware wire-up sanity', () => {
  test('src/index.mjs references WRITE_TOOL_NAMES inside the CallTool handler region', async () => {
    const src = await import('node:fs').then((m) =>
      m.promises.readFile(new URL('../src/index.mjs', import.meta.url), 'utf8'),
    );
    // Find the actual CallTool HANDLER (the setRequestHandler call), not
    // the import line where the schema name first appears.
    const i = src.indexOf('setRequestHandler(CallToolRequestSchema');
    assert.ok(i > 0, 'setRequestHandler(CallToolRequestSchema must appear in src/index.mjs');
    // Generous slice — readonly guard + audit middleware + try/catch
    // is ~3-4 KB in the current source; 8 KB has slack for future growth.
    const handlerRegion = src.slice(i, i + 8000);
    assert.ok(
      handlerRegion.includes('WRITE_TOOL_NAMES.has(name)'),
      'CallTool must guard against write tools (readonly mode + audit middleware) — the WRITE_TOOL_NAMES.has(name) check ANCHORS both layers',
    );
    assert.ok(
      handlerRegion.includes('restAppendToFile'),
      'audit append must call the REST helper directly (NOT the tool handler) to avoid recursion',
    );
    assert.ok(
      handlerRegion.includes('wiki-meta/log.md'),
      'audit writes target the conventional wiki-meta/log.md path (v0.12.0+)',
    );
  });
});
