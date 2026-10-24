import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIVITY_FILE, RECENT_MAX, activityPathFor, activityPaths, readActivity, recordActivity } from '../src/helpers/vault-activity.mjs';

function configIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-activity-'));

  return path.join(dir, 'config.json');
}

test('the sidecar sits beside the config, never in it', () => {
  const config = configIn();
  assert.equal(activityPathFor(config), path.join(path.dirname(config), ACTIVITY_FILE));
  assert.equal(activityPathFor(null), null);
});

test('a write records the vault, its time and its file; a second one goes first, a rewrite moves up', async () => {
  const config = configIn();
  assert.deepEqual(readActivity(config), {});
  assert.equal(await recordActivity(config, 'docs', ['wiki/a.md'], '2026-10-24T10:00:00.000Z'), true);
  assert.equal(await recordActivity(config, 'docs', ['wiki/b.md'], '2026-10-24T11:00:00.000Z'), true);
  assert.equal(await recordActivity(config, 'docs', ['wiki/a.md'], '2026-10-24T12:00:00.000Z'), true);
  assert.deepEqual(readActivity(config), {
    docs: {
      lastWriteAt: '2026-10-24T12:00:00.000Z',
      recent: [
        { path: 'wiki/a.md', at: '2026-10-24T12:00:00.000Z' },
        { path: 'wiki/b.md', at: '2026-10-24T11:00:00.000Z' },
      ],
    },
  });
  // The config itself is untouched (it was never created).
  assert.equal(fs.existsSync(config), false);
});

test(`at most ${RECENT_MAX} files are kept, newest first, one entry per vault`, async () => {
  const config = configIn();
  for (let i = 1; i <= RECENT_MAX + 2; i += 1) {
    await recordActivity(config, 'docs', [`n${i}.md`], `2026-10-24T10:0${i}:00.000Z`);
  }
  await recordActivity(config, 'notes', ['x.md'], '2026-10-24T09:00:00.000Z');
  const all = readActivity(config);
  assert.deepEqual(all.docs.recent.map((e) => e.path), ['n7.md', 'n6.md', 'n5.md', 'n4.md', 'n3.md']);
  assert.deepEqual(all.notes.recent.map((e) => e.path), ['x.md']);
});

test('a lock not taken records nothing and throws nothing', async () => {
  const config = configIn();
  assert.equal(await recordActivity(config, 'docs', ['a.md'], undefined, { lock: async () => null }), false);
  assert.deepEqual(readActivity(config), {});
  assert.equal(await recordActivity(config, 'docs', [], undefined), false);
});

test('an unreadable sidecar reads as empty, and the next write starts it over', async () => {
  const config = configIn();
  fs.writeFileSync(activityPathFor(config), '{ not json');
  assert.deepEqual(readActivity(config), {});
  await recordActivity(config, 'docs', ['a.md'], '2026-10-24T10:00:00.000Z');
  assert.equal(readActivity(config).docs.recent[0].path, 'a.md');
});

test("the paths a tool's call created or changed: a note's own tools only, a move's destination", () => {
  assert.deepEqual(activityPaths('write_file', { path: 'wiki/a.md', content: 'x' }), ['wiki/a.md']);
  assert.deepEqual(activityPaths('move_file', { from: 'old.md', to: 'new.md' }), ['new.md']);
  // A bundle is read from its result: without one, nothing is known to have run.
  assert.deepEqual(activityPaths('write_bundle', { steps: [{ path: 'a.md' }] }), []);
  // The router's upkeep and a delete are no "file to open".
  assert.deepEqual(activityPaths('build_search_index', {}), []);
  assert.deepEqual(activityPaths('delete_file', { path: 'a.md' }), []);
});

test('only what a call actually wrote: no change, no record; a bundle its run steps, deletes left out, the last written first', async () => {
  assert.deepEqual(activityPaths('patch_file', { path: 'a.md' }, { result: { patched: false } }), []);
  assert.deepEqual(activityPaths('merge_frontmatter', { path: 'a.md' }, { result: { applied: 0 } }), []);
  assert.deepEqual(activityPaths('move_file', { from: 'a.md', to: 'b.md' }, { result: { moved: false } }), []);
  assert.deepEqual(activityPaths('write_bundle', { steps: [{ path: 'a.md' }] }, { result: { ok: false, steps: [] } }), []);
  const result = {
    ok: true,
    steps: [
      { op: 'write', path: 'a.md', status: 'ok' },
      { op: 'delete', path: 'gone.md', status: 'ok' },
      { op: 'patch', path: 'b.md', status: 'skipped' },
      { op: 'append', path: 'c.md', status: 'ok' },
    ],
  };
  assert.deepEqual(activityPaths('write_bundle', { steps: [] }, { result }), ['a.md', 'c.md']);
  assert.deepEqual(activityPaths('write_bundle', { recover: true }, { result }), []);
  const config = configIn();
  await recordActivity(config, 'docs', ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'], '2026-10-24T10:00:00.000Z');
  assert.deepEqual(readActivity(config).docs.recent.map((e) => e.path), ['f.md', 'e.md', 'd.md', 'c.md', 'b.md']);
});

test('paths as the router spells them; a write then a delete in one bundle leaves nothing; an older recording never jumps ahead', async () => {
  assert.deepEqual(activityPaths('write_file', { path: 'wiki//a.md' }, { result: {} }), ['wiki/a.md']);
  const result = { ok: true, steps: [{ op: 'write', path: 'gone.md', status: 'ok' }, { op: 'delete', path: 'gone.md', status: 'ok' }, { op: 'write', path: 'kept.md', status: 'ok' }] };
  assert.deepEqual(activityPaths('write_bundle', {}, { result }), ['kept.md']);
  const config = configIn();
  await recordActivity(config, 'docs', ['new.md'], '2026-10-24T12:00:00.000Z');
  // Held up, an older write lands after: it does not take the head, nor the time.
  await recordActivity(config, 'docs', ['old.md'], '2026-10-24T11:00:00.000Z');
  const docs = readActivity(config).docs;
  assert.equal(docs.lastWriteAt, '2026-10-24T12:00:00.000Z');
  assert.deepEqual(docs.recent.map((e) => e.path), ['new.md', 'old.md']);
});

test("a move's destination as the router spells it; an older recording keeps a newer bundle's order", async () => {
  assert.deepEqual(activityPaths('move_file', { from: 'a.md', to: 'wiki//b.md' }, { result: {} }), ['wiki/b.md']);
  const config = configIn();
  await recordActivity(config, 'docs', ['a.md', 'b.md', 'c.md'], '2026-10-24T12:00:00.000Z');
  await recordActivity(config, 'docs', ['a.md'], '2026-10-24T11:00:00.000Z');
  assert.deepEqual(readActivity(config).docs.recent.map((e) => e.path), ['c.md', 'b.md', 'a.md']);
});
