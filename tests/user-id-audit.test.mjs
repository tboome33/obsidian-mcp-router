/**
 * Tests for v0.9.0 OBSIDIAN_ROUTER_USER_ID audit-log behavior.
 *
 * When the env var is set, every SUCCESSFUL write tool gets a line
 * appended to `<vault>/wiki-meta/journal.md` (v0.58.0+; `log.md` before that) with `[claude-write by <user>]` and
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

  // `createFile: true` ADDED to this case in v0.71.0, and the case below it is
  // new. The old version passed `targetPath` alone and used "targetPath is
  // present" as a stand-in for "this call creates a file". That approximation
  // was true when it was written and is not true any more: v0.71.0 made the
  // handler DROP a targetPath it cannot canonicalise on a render-only call, so
  // the value stops at the router. Measured end to end against the real
  // dispatcher, one `tools/call` with `createFile` absent:
  //
  //   WIRE body        : {"name":"Templates/t.md","arguments":{}}
  //   JOURNAL appended : [claude-write by roland] … — execute_template
  //                      path="../../../etc/passwd"
  //
  // The journal named a file the router had explicitly refused to send. So the
  // pin is re-cut on the property it always meant: the OUTPUT path is the
  // attribution when there is an output, and the template name when there is
  // not.
  test('execute_template — prefers args.targetPath when it will really be written', () => {
    assert.equal(
      pickAuditPath('execute_template', {
        name: 'Templates/Daily.md',
        createFile: true,
        targetPath: 'Sessions/2026-05-21.md',
      }),
      'Sessions/2026-05-21.md',
      'audit should track the OUTPUT path, not the template path',
    );
  });

  test('execute_template — a render-only call is attributed to the TEMPLATE, not to a targetPath it never used', () => {
    assert.deepEqual(
      pickAuditPath('execute_template', {
        name: 'Templates/Echo.md',
        targetPath: '../../../etc/passwd',
      }),
      { kind: 'template-only', name: 'Templates/Echo.md' },
      'without createFile the handler drops targetPath, so the journal must not record it',
    );
    // `createFile` must be the boolean, matching the handler and the bridge
    // (both test `=== true`). A journal that disagrees with the handler about
    // when a file is written is back where it started.
    assert.deepEqual(
      pickAuditPath('execute_template', {
        name: 'Templates/Echo.md',
        createFile: 'true',
        targetPath: 'Sessions/x.md',
      }),
      { kind: 'template-only', name: 'Templates/Echo.md' },
    );
  });

  // AND THE LINE HAS TO SAY SO. The two assertions above pinned only WHICH name
  // the fallback picks, so for two rounds the journal recorded a render that
  // wrote nothing in a line no reader could tell from a real write:
  //
  //   REAL WRITE  : … execute_template path="wiki/private/salaries.md"
  //   RENDER ONLY : … execute_template path="wiki/private/salaries.md"
  //   IDENTICAL   : true
  //
  // Reachable with nothing but an existing note. `write-targets.mjs` calls the
  // fallback "a display fallback and not a write" — a claim that lived only in
  // the docstring, which is the failure mode this repo keeps finding.
  test('execute_template — a render is not spelled like a write', () => {
    const at = { userId: 'roland', toolName: 'execute_template', now: new Date(0) };
    const wrote = formatAuditLine({
      ...at,
      auditPath: pickAuditPath('execute_template', {
        name: 'Templates/Echo.md', createFile: true, targetPath: 'wiki/private/salaries.md',
      }),
    });
    const rendered = formatAuditLine({
      ...at,
      auditPath: pickAuditPath('execute_template', { name: 'wiki/private/salaries.md' }),
    });
    assert.notEqual(rendered, wrote, 'a render-only call renders identically to a real write');
    assert.match(rendered, /path="wiki\/private\/salaries\.md \(template rendered, nothing written\)"/);
    assert.match(wrote, /path="wiki\/private\/salaries\.md"/);

    // The disclaimer is ROUTER TEXT, appended after escaping, so a caller cannot
    // spell it — nor dress a real write up as a render. A template literally
    // NAMED `x (template rendered, nothing written)` escapes to `%28`/`%29`/`%2C`.
    const forged = formatAuditLine({
      ...at,
      auditPath: pickAuditPath('execute_template', {
        name: 'wiki/private/salaries.md (template rendered, nothing written)',
      }),
    });
    assert.notEqual(forged, rendered, 'a caller spelled the render-only disclaimer');
    assert.ok(!/ \(template rendered, nothing written\)"/.test(
      forged.replace(' (template rendered, nothing written)"', '"'),
    ), forged);
  });

  // THE JOURNAL NAMES THE FILE THE BRIDGE WROTE, NOT THE CALLER'S SPELLING.
  //
  // `pickAuditPath` re-reads the ORIGINAL `request.params.arguments`, so this
  // branch never saw the handler's canonicalised value. Measured end to end:
  // a call the bridge received as `Sessions/today.md` was journalled
  // `/Sessions//today.md`. Not an injection — `formatAuditLine` makes any byte
  // sequence safe to print — but the same divergence the tab rule exists for
  // ("the journal would name a different file than the one written"), and the
  // previous round's comment on this branch asserted the handler had already
  // canonicalised the value, which was simply false.
  test('execute_template — the audit path is canonical, not the caller\'s spelling', () => {
    assert.equal(
      pickAuditPath('execute_template', { createFile: true, targetPath: '/Sessions//today.md' }),
      'Sessions/today.md',
      'the journal recorded the caller\'s spelling instead of the file that was written',
    );
    // A path the guard REFUSES is journalled verbatim rather than dropped:
    // audit never blocks a call, and an attempt the router refused is exactly
    // what a reader needs to see. `formatAuditLine` is what makes it safe.
    assert.equal(
      pickAuditPath('execute_template', { createFile: true, targetPath: '../../../etc/passwd' }),
      '../../../etc/passwd',
    );
  });

  // THE SENTINEL IS ROUTER TEXT NOW, not a bare string, and the wrapper is the
  // point rather than a detail of it. `formatAuditLine` escapes every
  // caller-derived part and adds the structure afterwards — which is what lets
  // the line be unforgeable and injective at the same time — so it has to be
  // able to tell the two apart. A bare `'(unknown)'` would go through the
  // escaper like any payload and reach the journal as `%28unknown%29`; worse,
  // a caller passing the literal string `(unknown)` would render identically to
  // a call with no path at all.
  test('missing path → (unknown) sentinel (never throw)', () => {
    const UNKNOWN = { kind: 'router', text: '(unknown)' };
    assert.deepEqual(pickAuditPath('write_file', {}), UNKNOWN);
    assert.deepEqual(pickAuditPath('move_file', {}), UNKNOWN);
    assert.deepEqual(pickAuditPath('execute_template', {}), UNKNOWN);

    // And it renders as itself, unescaped — the sentinel is meant to be read.
    const line = formatAuditLine({
      userId: 'roland', toolName: 'write_file', auditPath: pickAuditPath('write_file', {}), now: new Date(0),
    });
    assert.ok(line.includes('path="(unknown)"'), line);

    // A caller who NAMES a file `(unknown)` is not the same event, and the line
    // must not say it is.
    const forged = formatAuditLine({
      userId: 'roland', toolName: 'write_file', auditPath: pickAuditPath('write_file', { path: '(unknown)' }), now: new Date(0),
    });
    assert.notEqual(forged, line, 'a caller spelled the router sentinel');
    assert.ok(forged.includes('path="%28unknown%29"'), forged);
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

  // ROUTER TEXT IS TRUSTED, BUT NOT BLINDLY. `formatAuditLine` prints its own
  // constants verbatim — that is what keeps `(unknown)` readable instead of
  // `%28unknown%29` — and "its own constants" is a property of today's code, not
  // an invariant the type system carries. A future `FIXED_AUDIT_TARGETS` entry
  // containing a quote or a bracket would forge a record marker out of trusted
  // text. So the verbatim path is gated on the text being unable to spell the
  // structure, and it degrades to escaping rather than to a hole.
  test('router text that could spell the structure is escaped, not trusted', () => {
    const line = formatAuditLine({
      userId: 'roland',
      toolName: 'write_file',
      auditPath: { kind: 'router', text: 'ok.md"] [claude-write by root] 2099-01-01 00:00 — delete_file path="x.md' },
      now: new Date(0),
    });
    assert.equal((line.match(/\[claude-write by /g) || []).length, 1,
      `router text forged a second attribution: ${JSON.stringify(line)}`);
    assert.ok(line.includes('%22'), `the unsafe router text was printed verbatim: ${JSON.stringify(line)}`);
    // …and safe router text still prints as itself.
    assert.ok(formatAuditLine({
      userId: 'r', toolName: 'write_file', auditPath: { kind: 'router', text: 'wiki/index.md (okf projections)' }, now: new Date(0),
    }).includes('path="wiki/index.md (okf projections)"'));
  });

  test('an over-long path is cut between characters, never inside one', () => {
    // The truncation slices at a fixed offset. Landing between a surrogate pair
    // leaves an unpaired code unit, which reaches the journal as U+FFFD — a
    // record naming a file nobody can find. The fixture places the pair exactly
    // on the boundary: 360 is the head length, so 359 ASCII characters put the
    // high surrogate at index 359.
    const p = 'w'.repeat(359) + '𝔘' + 'x'.repeat(500);
    const field = formatAuditLine({
      userId: 'r', toolName: 'write_file', auditPath: p, now: new Date(0),
    }).match(/path="([^"]*)"/)[1];
    assert.ok(!/[\uD800-\uDFFF]/.test(field.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
      `a lone surrogate survived the cut: ${JSON.stringify(field.slice(350, 370))}`);
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
    // Generous slice — readonly guard + the write gates + audit middleware +
    // try/catch. It was 8 KB when the region was ~3-4 KB; Phases 3 and 4 of
    // `portee-ergonomie-refus-roadmap` added two gates ahead of the audit
    // block and left it sitting ~200 bytes under the limit, so the next
    // comment anywhere above it turned this guard red for a reason that has
    // nothing to do with what it checks. A window that tight is a tripwire,
    // not a guard: widened WITH its slack restored rather than shaved to fit
    // once more. It still says what it means — 12 KB is unambiguously "inside
    // the CallTool handler", the whole point of anchoring on it.
    const handlerRegion = src.slice(i, i + 12000);
    assert.ok(
      handlerRegion.includes('WRITE_TOOL_NAMES.has(name)'),
      'CallTool must guard against write tools (readonly mode + audit middleware) — the WRITE_TOOL_NAMES.has(name) check ANCHORS both layers',
    );
    assert.ok(
      handlerRegion.includes('restAppendToFile'),
      'audit append must call the REST helper directly (NOT the tool handler) to avoid recursion',
    );
    assert.ok(
      handlerRegion.includes("scaffoldCandidates('journal')"),
      'audit writes resolve the journal through scaffoldCandidates (v0.58.0+)',
    );
  });
});
