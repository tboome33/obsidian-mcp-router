/**
 * C2 — end-to-end tests for the journaled write bundle.
 *
 * Two layers, because they prove different things:
 *
 *   A. ORCHESTRATION, driven through injected executors over an in-memory vault.
 *      Deterministic and fast, so every branch of the contract gets a test:
 *      all-or-nothing apply, byte-for-byte rollback, the C1 group precondition,
 *      the C3 seal, journal lifecycle, and — the ones that matter most — the
 *      cases where rollback must REFUSE to write.
 *
 *   B. THE REAL SINGLE-FILE TOOLS, driven through a real HTTP server standing in
 *      for Local REST API. This is what proves a bundle is not a second write
 *      implementation: the same write_file / append_to_file / patch_file /
 *      delete_file handlers do the work, over the true wire format.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { writeBundleTool } from '../src/tools/write-bundle.mjs';
import { appendToFileTool } from '../src/tools/append-to-file.mjs';
import { setFrontmatterTool } from '../src/tools/set-frontmatter.mjs';
import {
  BUNDLE_JOURNAL_DIR,
  BUNDLE_SEAL_OP,
  MAX_BACKUP_BYTES,
  buildBundlePlan,
  validateSteps,
} from '../src/helpers/write-bundle.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { computePlanSeal, vaultIdentity } from '../src/helpers/plan-seal.mjs';
import { classifyError } from '../src/error-classify.mjs';

const OP_HEX = '0123456789abcdef';
const OP_ID = `op-${OP_HEX}`;
const JOURNAL = `${BUNDLE_JOURNAL_DIR}/${OP_ID}.json`;

const notFound = () => Object.assign(new Error('404 not found'), { kind: 'not_found', status: 404 });
const conflict = (why) => Object.assign(new Error(`409 ${why}`), { kind: 'conflict', status: 409 });

// ---------------------------------------------------------------------------
// A. Orchestration over an in-memory vault
// ---------------------------------------------------------------------------

/**
 * In-memory vault + executors that model what the real single-file tools do to
 * a file. `hooks.failStep` makes one step throw; `hooks.afterStep` lets a test
 * simulate a THIRD PARTY writing between our steps.
 */
function harness({ files = {}, hooks = {} } = {}) {
  const vault = { name: 'v', baseUrl: 'http://v' };
  const registry = { resolveVault: () => vault };
  const store = new Map(Object.entries(files));
  const io = [];

  const read = (p) => {
    if (!store.has(p)) throw notFound();
    return store.get(p);
  };

  const deps = {
    now: () => '2026-08-02T10:00:00.000Z',
    randomHex: () => OP_HEX,
    getFileContent: async (_v, p) => {
      if (hooks.readFails && hooks.readFails(p)) throw Object.assign(new Error('boom'), { kind: 'server_error', status: 500 });
      io.push(['get', p]);
      return read(p);
    },
    writeFile: async (_v, p, content, opts = {}) => {
      if (hooks.writeFails && hooks.writeFails(p)) throw Object.assign(new Error('disk on fire'), { kind: 'server_error' });
      if (opts.applyIfContentPreexists === false && store.has(p)) throw conflict('exists');
      io.push(['put', p]);
      store.set(p, content);
    },
    writeFileIfMatch: async (_v, p, content, expected) => {
      if (!store.has(p)) throw conflict('target-missing');
      if (contentSha256(store.get(p)) !== expected) throw conflict('content-changed');
      io.push(['cas', p]);
      store.set(p, content);
      return { casMode: 'fallback' };
    },
    deleteFile: async (_v, p) => {
      if (!store.has(p)) throw notFound();
      io.push(['del', p]);
      store.delete(p);
    },
    // Local REST API has no conditional DELETE, so the rollback re-asserts the
    // content first — the same guard delete_file with ifMatch uses. Modelled
    // here so the harness exercises that call instead of silently falling
    // through to the real rest-client.
    assertContentMatches: async (_v, p, expected) => {
      if (!store.has(p)) throw conflict('target-missing');
      if (contentSha256(store.get(p)) !== expected) throw conflict('content-changed');
      io.push(['assert', p]);
    },
    listFilesIn: async (_v, dir) => {
      const prefix = `${dir}/`;
      const files = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      if (!files.length) throw notFound();
      return { files };
    },
    executors: {},
  };

  const run = (op, fn) => async (_registry, args) => {
    const step = { op, path: args.path };
    if (hooks.failStep && hooks.failStep(step)) throw new Error(`step "${op}" on ${args.path} exploded`);
    const out = await fn(args);
    if (hooks.afterStep) hooks.afterStep(step, store);
    return out;
  };

  deps.executors = {
    write: run('write', async (args) => {
      if (args.ifMatch !== undefined) {
        if (!store.has(args.path)) throw conflict('target-missing');
        if (contentSha256(store.get(args.path)) !== args.ifMatch) throw conflict('content-changed');
      }
      store.set(args.path, args.content);
      return { path: args.path, bytesWritten: Buffer.byteLength(args.content, 'utf8') };
    }),
    append: run('append', async (args) => {
      store.set(args.path, (store.has(args.path) ? store.get(args.path) : '') + args.content);
      return { path: args.path, bytesAppended: Buffer.byteLength(args.content, 'utf8') };
    }),
    patch: run('patch', async (args) => {
      if (!store.has(args.path)) throw notFound();
      store.set(args.path, `${store.get(args.path)}\n${args.content}`);
      return { path: args.path, patched: true };
    }),
    set_frontmatter: run('set_frontmatter', async (args) => {
      store.set(args.path, `${store.has(args.path) ? store.get(args.path) : ''}\n${args.key}: ${args.value}`);
      return { path: args.path, set: true };
    }),
    merge_frontmatter: run('merge_frontmatter', async (args) => {
      const outcome = hooks.mergeOutcome ? hooks.mergeOutcome(args) : null;
      const keys = Object.keys(args.values);
      if (outcome) {
        // Model the real tool: a PARTIAL merge RETURNS rather than throwing.
        store.set(args.path, `${store.get(args.path) || ''}\n${outcome.appliedText || 'partial'}`);
        return outcome;
      }
      store.set(args.path, `${store.get(args.path) || ''}\n${keys.join(',')}`);
      return { path: args.path, applied: keys.length, failed: 0, results: [] };
    }),
    delete: run('delete', async (args) => {
      if (!store.has(args.path)) throw notFound();
      store.delete(args.path);
      return { path: args.path, deleted: true };
    }),
  };

  return { vault, registry, store, deps, io };
}

describe('write_bundle — success', () => {
  test('applies every step, returns an operation id, and leaves no journal behind', async () => {
    const { registry, store, deps } = harness({ files: { 'index.md': '# Index\n' } });
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'wiki/note.md', content: '# Note\n' },
        { op: 'append', path: 'index.md', content: '- [[note]]\n' },
        { op: 'write', path: 'wiki/other.md', content: '# Other\n' },
      ],
    }, deps);

    assert.equal(out.ok, true);
    assert.equal(out.outcome, 'applied');
    assert.equal(out.operationId, OP_ID);
    assert.equal(out.applied, 3);
    assert.equal(out.total, 3);
    assert.deepEqual(out.steps.map((s) => s.status), ['ok', 'ok', 'ok']);
    assert.match(out.message, /applied all 3 step\(s\)/);

    assert.equal(store.get('wiki/note.md'), '# Note\n');
    assert.equal(store.get('index.md'), '# Index\n- [[note]]\n');
    assert.equal(store.get('wiki/other.md'), '# Other\n');
    assert.equal(store.has(JOURNAL), false, 'a clean bundle removes its journal');
  });

  test('the journal exists DURING the bundle and holds the before-images', async () => {
    const seen = [];
    const h = harness({ files: { 'a.md': 'ORIGINAL A' } });
    h.deps.executors.write = async (_r, args) => {
      seen.push(h.store.get(JOURNAL));
      h.store.set(args.path, args.content);
      return { path: args.path };
    };
    await writeBundleTool(h.registry, {
      steps: [{ op: 'write', path: 'a.md', content: 'NEW A' }],
    }, h.deps);

    assert.equal(seen.length, 1);
    const journal = JSON.parse(seen[0]);
    assert.equal(journal.operationId, OP_ID);
    assert.equal(journal.vault, 'v');
    assert.equal(journal.startedAt, '2026-08-02T10:00:00.000Z');
    assert.deepEqual(journal.backups['a.md'], {
      existed: true,
      content: 'ORIGINAL A',
      contentSha256: contentSha256('ORIGINAL A'),
    });
  });

  test('a partially-applied merge_frontmatter is a FAILED step, not a success', async () => {
    const { registry, store, deps } = harness({
      files: { 'a.md': 'A' },
      hooks: {
        mergeOutcome: () => ({ path: 'a.md', applied: 1, failed: 2, firstError: 'bad key' }),
      },
    });
    const out = await writeBundleTool(registry, {
      steps: [{ op: 'merge_frontmatter', path: 'a.md', values: { x: 1, y: 2, z: 3 } }],
    }, deps);

    assert.equal(out.ok, false);
    // The merge never confirmed a post-image, so the undo is honest about not
    // being provable — but the file IS back.
    assert.equal(out.outcome, 'rolled-back-unverified');
    assert.match(out.error, /applied 1 key\(s\) and failed on 2: bad key/);
    assert.equal(store.get('a.md'), 'A', 'the half-merged file is put back');
    assert.equal(store.has(JOURNAL), true, 'an unproven undo keeps its journal');
    const journal = JSON.parse(store.get(JOURNAL));
    // The record stays PENDING so the `recover` the message advertises actually
    // works; `lastOutcome` is what happened, not a closed state.
    assert.equal(journal.state, 'pending');
    assert.equal(journal.lastOutcome, 'rolled-back-unverified');
    assert.equal(journal.salvage['a.md'].content, 'A\npartial', 'what was overwritten is saved, not lost');
  });
});

describe('write_bundle — failure rolls everything back', () => {
  // CRLF + accents + emoji + a trailing space: a fixture that catches any
  // normalisation on the round trip. Deliberately NO leading BOM — the read path
  // strips one (content-hash.mjs), so an in-memory harness asserting a BOM came
  // back would be pinning a promise the real wire does not keep. The truth about
  // BOM files is pinned separately, over the real HTTP server, below.
  const ORIGINAL_A = '# A\r\nligne accentuée é — 🎯 with trailing space \r\n';
  const ORIGINAL_LOG = '## Log\n- one\n';

  function midFailure(extraHooks = {}) {
    return harness({
      files: { 'a.md': ORIGINAL_A, 'log.md': ORIGINAL_LOG, 'doomed.md': 'DOOMED' },
      hooks: { failStep: (s) => s.path === 'boom.md', ...extraHooks },
    });
  }

  test('every touched file is restored byte-for-byte, created files are removed, deleted files come back', async () => {
    const { registry, store, deps } = midFailure();
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'REWRITTEN' },
        { op: 'append', path: 'log.md', content: '- two\n' },
        { op: 'write', path: 'created.md', content: 'BRAND NEW' },
        { op: 'delete', path: 'doomed.md', confirm: true },
        { op: 'write', path: 'boom.md', content: 'never' },
        { op: 'write', path: 'after.md', content: 'never either' },
      ],
    }, deps);

    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'rolled-back');
    assert.equal(out.applied, 4);
    assert.deepEqual(out.failedStep, { index: 4, op: 'write', path: 'boom.md' });
    assert.deepEqual(out.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'failed', 'not-run']);
    assert.equal(out.rollback.clean, true);

    assert.equal(store.get('a.md'), ORIGINAL_A, 'byte-for-byte: CRLF, accents, emoji and trailing space all intact');
    assert.equal(store.get('log.md'), ORIGINAL_LOG);
    assert.equal(store.has('created.md'), false, 'a file the bundle created is removed');
    assert.equal(store.get('doomed.md'), 'DOOMED', 'a file the bundle deleted is restored');
    assert.equal(store.has('after.md'), false, 'a not-run step wrote nothing');
    assert.equal(store.has(JOURNAL), false, 'a clean rollback removes its journal');
  });

  test('the message never claims success, and the error is classified', async () => {
    const { registry, deps } = midFailure();
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'x' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, deps);
    // 1-based in prose (the machine field stays zero-based).
    assert.match(out.message, /FAILED at step 2 of 2 and was rolled back completely/);
    assert.equal(out.failedStep.index, 1);
    assert.match(out.message, /Nothing partial remains/);
    assert.equal(out.errorCategory, 'unknown');
    assert.equal(out.isRetryable, false);
  });

  test('two steps on the SAME file roll back to the pre-BUNDLE state, not to the intermediate one', async () => {
    const { registry, store, deps } = harness({
      files: { 'a.md': 'v0' },
      hooks: { failStep: (s) => s.op === 'patch' },
    });
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'v1' },
        { op: 'append', path: 'a.md', content: '+v2' },
        { op: 'patch', path: 'a.md', operation: 'append', targetType: 'heading', target: 'H', content: 'v3' },
      ],
    }, deps);
    // The failing step is the last one on a.md, so nothing attributable survives
    // for that path — the undo happens, and says it could not be proven.
    assert.equal(out.outcome, 'rolled-back-unverified');
    assert.equal(out.rollback.clean, true);
    assert.equal(out.rollback.verified, false);
    assert.equal(store.get('a.md'), 'v0');
  });

  test('a step that fails on a file the bundle had already written is still restored (attribution unverified)', async () => {
    // Step 0 writes a.md (confirmed). Step 1 fails ON a.md after mutating it —
    // exactly the case where a post-image from step 0 would wrongly look like a
    // third party's edit.
    const { registry, store, deps } = harness({
      files: { 'a.md': 'ORIGINAL' },
      hooks: {
        failStep: (s) => s.op === 'append',
        afterStep: () => {},
      },
    });
    deps.executors.append = async (_r, args) => {
      store.set(args.path, `${store.get(args.path)}PARTIAL`);
      throw new Error('died after writing');
    };
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'STEP0' },
        { op: 'append', path: 'a.md', content: 'STEP1' },
      ],
    }, deps);

    assert.equal(out.outcome, 'rolled-back-unverified');
    assert.equal(store.get('a.md'), 'ORIGINAL');
    const verdict = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(verdict.attribution, 'unverified');
    assert.match(out.warnings.join(' '), /could not be attributed/);
    // Nothing is destroyed without a copy: the content that was overwritten
    // lands in the retained journal.
    const journal = JSON.parse(store.get(JOURNAL));
    assert.equal(journal.salvage['a.md'].content, 'STEP0PARTIAL');
  });
});

describe('write_bundle — rollback never clobbers a third party', () => {
  test('a file changed by someone else after our step is left alone and the journal is KEPT', async () => {
    const h = harness({
      files: { 'a.md': 'ORIGINAL A', 'b.md': 'ORIGINAL B' },
      hooks: { failStep: (s) => s.path === 'boom.md' },
    });
    // A concurrent session edits a.md AFTER the bundle wrote it AND after the
    // bundle recorded its post-image — the only ordering that makes the edit
    // genuinely foreign. (Writing it inside the executor would simply make it
    // the bundle's own post-image, which is a different scenario entirely.)
    const realGet = h.deps.getFileContent;
    let readsOfA = 0;
    h.deps.getFileContent = async (v, p) => {
      const out = await realGet(v, p);
      if (p === 'a.md' && ++readsOfA === 2) h.store.set('a.md', 'SOMEONE ELSE WAS HERE');
      return out;
    };

    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'append', path: 'a.md', content: '+ours\n' },
        { op: 'append', path: 'b.md', content: '+ours\n' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, h.deps);

    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'rolled-back-partial');
    assert.equal(out.rollback.clean, false);
    assert.equal(h.store.get('a.md'), 'SOMEONE ELSE WAS HERE', 'their edit survives');
    assert.equal(h.store.get('b.md'), 'ORIGINAL B', 'ours is still undone');

    const a = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(a.action, 'skip');
    assert.equal(a.status, 'left-modified');
    assert.match(a.reason, /destroy that edit/);

    assert.equal(out.journalPath, JOURNAL);
    assert.equal(h.store.has(JOURNAL), true, 'a dirty rollback KEEPS the journal for repair');
    assert.match(out.message, /could NOT be fully rolled back/);
    assert.match(out.message, /a\.md/);
    assert.match(out.message, /recover:"op-0123456789abcdef"/);
  });

  test('a file only a NOT-RUN step targeted is never touched by the rollback', async () => {
    const h = harness({
      files: { 'a.md': 'A', 'untouched.md': 'MINE' },
      hooks: { failStep: (s) => s.path === 'a.md' },
    });
    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'x' },
        { op: 'write', path: 'untouched.md', content: 'y' },
      ],
    }, h.deps);
    assert.equal(out.outcome, 'rolled-back');
    assert.equal(h.store.get('untouched.md'), 'MINE');
    assert.equal(out.rollback.paths.some((p) => p.path === 'untouched.md'), false);
  });

  test('a restore that itself fails is reported, and does not stop the other paths', async () => {
    const h = harness({
      files: { 'a.md': 'ORIGINAL A', 'b.md': 'ORIGINAL B' },
      hooks: { failStep: (s) => s.path === 'boom.md' },
    });
    const realCas = h.deps.writeFileIfMatch;
    h.deps.writeFileIfMatch = async (v, p, c, e) => {
      if (p === 'a.md') throw Object.assign(new Error('vault went away'), { kind: 'unreachable' });
      return realCas(v, p, c, e);
    };
    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'x' },
        { op: 'write', path: 'b.md', content: 'y' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, h.deps);

    assert.equal(out.outcome, 'rolled-back-partial');
    const a = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(a.status, 'restore-failed');
    assert.match(a.error, /vault went away/);
    assert.equal(h.store.get('b.md'), 'ORIGINAL B', 'the other path was still restored');
    assert.equal(h.store.has(JOURNAL), true);
  });
});

describe('write_bundle — detecting a concurrent writer', () => {
  /**
   * The bundle knows the exact bytes a `write` step sends, so it does not need
   * the read-back to tell it what it wrote — the read-back becomes EVIDENCE. A
   * disagreement is proof someone else got in, including inside the window
   * between the write landing and the read, which no observation could catch.
   */
  test('a foreign write inside the post-image window is DETECTED and the file is left alone', async () => {
    const h = harness({ files: { 'a.md': 'ORIGINAL A', 'b.md': 'ORIGINAL B' }, hooks: { failStep: (s) => s.path === 'boom.md' } });
    const realGet = h.deps.getFileContent;
    let reads = 0;
    h.deps.getFileContent = async (v, p) => {
      // Land the foreign write between the executor returning and the probe.
      if (p === 'a.md' && ++reads === 2) h.store.set('a.md', 'SOMEONE ELSE WAS HERE');
      return realGet(v, p);
    };

    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'OURS' },
        { op: 'write', path: 'b.md', content: 'OURS B' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, h.deps);

    assert.equal(out.outcome, 'rolled-back-partial');
    assert.equal(h.store.get('a.md'), 'SOMEONE ELSE WAS HERE', 'their write survives');
    assert.equal(h.store.get('b.md'), 'ORIGINAL B', 'ours is still undone');
    const a = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(a.action, 'skip');
    assert.match(a.reason, /in a way the bundle did not write/);
    assert.match(out.warnings.join(' '), /does not hold what step 1 wrote/);
    assert.equal(h.store.has(JOURNAL), true);
  });

  test('the same detection fires on a SUCCESSFUL bundle — a warning, not a silent adoption', async () => {
    const h = harness({ files: { 'a.md': 'ORIGINAL A' } });
    const realGet = h.deps.getFileContent;
    let reads = 0;
    h.deps.getFileContent = async (v, p) => {
      if (p === 'a.md' && ++reads === 2) h.store.set('a.md', 'SOMEONE ELSE');
      return realGet(v, p);
    };
    const out = await writeBundleTool(h.registry, { steps: [{ op: 'write', path: 'a.md', content: 'OURS' }] }, h.deps);
    assert.equal(out.outcome, 'applied');
    assert.match(out.warnings.join(' '), /something else wrote to it while this bundle was running/);
  });

  test('the foreign mark is STICKY — a later step cannot launder a proven foreign write back into "ours"', async () => {
    // Step 0 writes a.md and detects a foreign write. Without stickiness, step 1
    // on the same path would record a fresh `observed` post-image and the
    // rollback would restore over the third party's content — while the very
    // same response still carried "the bundle will not touch that file again".
    const h = harness({ files: { 'a.md': 'ORIGINAL A' } });
    const realGet = h.deps.getFileContent;
    let reads = 0;
    h.deps.getFileContent = async (v, p) => {
      if (p === 'a.md' && ++reads === 2) h.store.set('a.md', 'THEIRS');
      return realGet(v, p);
    };

    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'write', path: 'a.md', content: 'OURS' },
        { op: 'append', path: 'a.md', content: '\nmore of ours' },
      ],
    }, h.deps);

    assert.equal(h.store.get('a.md'), 'THEIRS', 'their content is intact');
    assert.equal(out.steps[1].status, 'failed');
    assert.match(out.steps[1].error, /will not write over a file it has proven it does not own/);
    const a = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(a.action, 'skip');
    assert.notEqual(out.outcome, 'rolled-back', 'a skipped path is never a proven undo');
  });

  test('a SKIPPED step creates no post-image — a no-op must not adopt a concurrent edit', async () => {
    // patch returns patched:false without writing; a third party writes; without
    // the guard their content becomes the bundle's `observed` post-image and the
    // rollback restores over it.
    const h = harness({ files: { 'a.md': 'ORIGINAL A', 'b.md': 'B' }, hooks: { failStep: (s) => s.path === 'boom.md' } });
    h.deps.executors.patch = async (_r, args) => ({ path: args.path, patched: false, skippedReason: 'already there' });
    const realGet = h.deps.getFileContent;
    h.deps.getFileContent = async (v, p) => {
      if (p === 'a.md') h.store.set('a.md', 'THEIRS');
      return realGet(v, p);
    };

    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'patch', path: 'a.md', operation: 'append', targetType: 'heading', target: 'H', content: 'x' },
        { op: 'write', path: 'b.md', content: 'OURS B' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, h.deps);

    assert.equal(out.steps[0].status, 'skipped');
    assert.equal(h.store.get('a.md'), 'THEIRS', 'a no-op step never made this file a rollback target');
    assert.equal(out.rollback.paths.some((p) => p.path === 'a.md'), false);
    assert.equal(h.store.get('b.md'), 'B', 'the real write was still undone');
  });

  test('an unattributable overwrite is refused when its salvage copy cannot be saved first', async () => {
    const h = harness({ files: { 'a.md': 'ORIGINAL' } });
    h.deps.executors.append = async (_r, args) => {
      h.store.set(args.path, `${h.store.get(args.path)}PARTIAL`);
      throw new Error('died after writing');
    };
    const realWrite = h.deps.writeFile;
    let journalWrites = 0;
    h.deps.writeFile = async (v, p, c, o) => {
      if (p.startsWith(BUNDLE_JOURNAL_DIR) && ++journalWrites > 1) throw new Error('journal locked');
      return realWrite(v, p, c, o);
    };

    const out = await writeBundleTool(h.registry, { steps: [{ op: 'append', path: 'a.md', content: 'X' }] }, h.deps);
    // Fail closed: no copy, no overwrite.
    assert.equal(h.store.get('a.md'), 'ORIGINALPARTIAL');
    assert.equal(out.outcome, 'rolled-back-partial');
    const a = out.rollback.paths.find((p) => p.path === 'a.md');
    assert.equal(a.action, 'skip');
    assert.match(a.reason, /copy that would have been kept before overwriting it could not be saved/);
  });

  test('a delete during rollback is CONDITIONAL — a write landing before it wins', async () => {
    const h = harness({ files: { 'keep.md': 'K' }, hooks: { failStep: (s) => s.path === 'boom.md' } });
    const realAssert = h.deps.assertContentMatches;
    h.deps.assertContentMatches = async (v, p, expected) => {
      // A third party recreates the file between the rollback probe and the DELETE.
      if (p === 'created.md') h.store.set('created.md', 'THEIRS NOW');
      return realAssert(v, p, expected);
    };
    const out = await writeBundleTool(h.registry, {
      steps: [
        { op: 'write', path: 'created.md', content: 'OURS' },
        { op: 'write', path: 'boom.md', content: 'never' },
      ],
    }, h.deps);

    assert.equal(out.outcome, 'rolled-back-partial');
    assert.equal(h.store.get('created.md'), 'THEIRS NOW', 'the unconditional delete would have destroyed this');
    const c = out.rollback.paths.find((p) => p.path === 'created.md');
    assert.equal(c.status, 'restore-failed');
    assert.match(c.error, /content-changed/);
  });

  test('a post-image that cannot be READ is reported instead of silently ignored', async () => {
    const h = harness({ files: { 'a.md': 'A' } });
    const realGet = h.deps.getFileContent;
    let reads = 0;
    h.deps.getFileContent = async (v, p) => {
      if (p === 'a.md' && ++reads === 2) throw Object.assign(new Error('vault blinked'), { kind: 'server_error' });
      return realGet(v, p);
    };
    const out = await writeBundleTool(h.registry, { steps: [{ op: 'write', path: 'a.md', content: 'NEW' }] }, h.deps);
    assert.equal(out.outcome, 'applied');
    assert.match(out.warnings.join(' '), /Could not read "a\.md" back after step 1.*final\s+state was not verified/s);
  });
});

describe('write_bundle — the journal never becomes a recovery bomb', () => {
  test('a journal that cannot be DELETED after success is stamped terminal, and recovery then refuses it', async () => {
    const h = harness({ files: { 'a.md': 'ORIGINAL' }, hooks: { deleteFails: (p) => p.startsWith(BUNDLE_JOURNAL_DIR) } });
    // `deleteFails` is not a harness hook by default — wire it explicitly.
    const realDelete = h.deps.deleteFile;
    h.deps.deleteFile = async (v, p) => {
      if (p.startsWith(BUNDLE_JOURNAL_DIR)) throw Object.assign(new Error('locked'), { kind: 'server_error' });
      return realDelete(v, p);
    };

    const out = await writeBundleTool(h.registry, { steps: [{ op: 'write', path: 'a.md', content: 'NEW' }] }, h.deps);
    assert.equal(out.outcome, 'applied');
    assert.match(out.warnings.join(' '), /stamped "applied"/);
    assert.equal(JSON.parse(h.store.get(JOURNAL)).state, 'applied');

    // The listing shows it, but marks it not recoverable…
    const list = await writeBundleTool(h.registry, { recover: true }, h.deps);
    assert.equal(list.pending[0].state, 'applied');
    assert.equal(list.pending[0].recoverable, false);

    // …and a confirmed recovery REFUSES, instead of undoing a bundle that worked.
    await assert.rejects(
      writeBundleTool(h.registry, { recover: OP_ID, confirm: true }, h.deps),
      /already "applied".*Replaying its backups would UNDO it/s,
    );
    assert.equal(h.store.get('a.md'), 'NEW', 'the successful bundle survived');
  });

  test('when neither deleting nor stamping works, the result says DANGER instead of "inert"', async () => {
    const h = harness({ files: { 'a.md': 'ORIGINAL' } });
    const realDelete = h.deps.deleteFile;
    const realWrite = h.deps.writeFile;
    let journalWritten = false;
    h.deps.deleteFile = async (v, p) => {
      if (p.startsWith(BUNDLE_JOURNAL_DIR)) throw new Error('locked');
      return realDelete(v, p);
    };
    h.deps.writeFile = async (v, p, c, o) => {
      if (p.startsWith(BUNDLE_JOURNAL_DIR)) {
        if (journalWritten) throw new Error('still locked');
        journalWritten = true;
      }
      return realWrite(v, p, c, o);
    };
    const out = await writeBundleTool(h.registry, { steps: [{ op: 'write', path: 'a.md', content: 'NEW' }] }, h.deps);
    // The steps DID apply — saying otherwise would be false — but the hazard is
    // machine-readable, not buried in prose.
    assert.equal(out.outcome, 'applied');
    assert.equal(out.journalUnsafe, true);
    assert.equal(out.journalPath, JOURNAL);
    assert.match(out.warnings.join(' '), /DANGER.*still reads as "pending".*Delete that file by hand/s);
  });

  test('BOTH the attribution warning and the journal warning survive — neither overwrites the other', async () => {
    // Two separate `warnings` keys in one object literal silently dropped the
    // first; the one lost was always the safety-relevant one.
    const h = harness({ files: { 'a.md': 'ORIGINAL' } });
    h.deps.executors.append = async (_r, args) => {
      h.store.set(args.path, `${h.store.get(args.path)}PARTIAL`);
      throw new Error('died after writing');
    };
    const realWrite = h.deps.writeFile;
    let journalWrites = 0;
    h.deps.writeFile = async (v, p, c, o) => {
      // Let the initial journal AND the pre-overwrite salvage write through;
      // refuse only the final retention update.
      if (p.startsWith(BUNDLE_JOURNAL_DIR) && ++journalWrites > 2) throw new Error('journal locked');
      return realWrite(v, p, c, o);
    };

    const out = await writeBundleTool(h.registry, { steps: [{ op: 'append', path: 'a.md', content: 'X' }] }, h.deps);
    assert.equal(out.outcome, 'rolled-back-unverified');
    const joined = out.warnings.join(' | ');
    assert.match(joined, /could not be updated with the rollback outcome/, 'journal warning present');
    assert.match(joined, /Restored without being able to prove/, 'attribution warning present');
    assert.equal(out.warnings.length, 2);
  });
});

describe('write_bundle — C1 preconditions guard the WHOLE group', () => {
  test('one stale ifMatch refuses the entire bundle before anything is written', async () => {
    const { registry, store, deps, io } = harness({ files: { 'a.md': 'A', 'b.md': 'B' } });
    await assert.rejects(
      writeBundleTool(registry, {
        steps: [
          { op: 'write', path: 'a.md', content: 'new A', ifMatch: contentSha256('A') },
          { op: 'write', path: 'b.md', content: 'new B', ifMatch: contentSha256('STALE') },
        ],
      }, deps),
      (err) => {
        assert.equal(err.kind, 'conflict');
        assert.match(err.message, /steps\[1\] expects "b\.md" to still hash to/);
        assert.match(err.message, /NOTHING was\s+written/);
        assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
        return true;
      },
    );
    assert.equal(store.get('a.md'), 'A');
    assert.equal(store.get('b.md'), 'B');
    assert.equal(io.some(([verb]) => verb !== 'get'), false, 'not a single write reached the vault');
    assert.equal(store.has(JOURNAL), false, 'no journal for a bundle that never started');
  });

  test('an ifMatch on a file that no longer exists refuses the bundle', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    await assert.rejects(
      writeBundleTool(registry, {
        steps: [{ op: 'write', path: 'gone.md', content: 'x', ifMatch: contentSha256('A') }],
      }, deps),
      /the file no longer exists/,
    );
  });

  test('a malformed ifMatch is refused, not treated as "no guard"', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    await assert.rejects(
      writeBundleTool(registry, { steps: [{ op: 'write', path: 'a.md', content: 'x', ifMatch: 'nope' }] }, deps),
      /steps\[0\]\.ifMatch is not a 64-char lowercase hex content hash/,
    );
  });

  test('matching preconditions let the bundle through', async () => {
    const { registry, store, deps } = harness({ files: { 'a.md': 'A' } });
    const out = await writeBundleTool(registry, {
      steps: [{ op: 'write', path: 'a.md', content: 'new A', ifMatch: contentSha256('A') }],
    }, deps);
    assert.equal(out.outcome, 'applied');
    assert.equal(store.get('a.md'), 'new A');
  });
});

describe('write_bundle — fails closed before it can start', () => {
  test('a target that cannot be READ refuses the bundle (what cannot be backed up cannot be rolled back)', async () => {
    const { registry, store, deps } = harness({
      files: { 'a.md': 'A', 'b.md': 'B' },
      hooks: { readFails: (p) => p === 'b.md' },
    });
    await assert.rejects(
      writeBundleTool(registry, {
        steps: [
          { op: 'write', path: 'a.md', content: 'x' },
          { op: 'write', path: 'b.md', content: 'y' },
        ],
      }, deps),
      /Cannot capture a backup of "b\.md".*cannot be rolled back/s,
    );
    assert.equal(store.get('a.md'), 'A');
  });

  test('a journal that cannot be persisted refuses the bundle', async () => {
    const { registry, store, deps } = harness({
      files: { 'a.md': 'A' },
      hooks: { writeFails: (p) => p.startsWith(BUNDLE_JOURNAL_DIR) },
    });
    await assert.rejects(
      writeBundleTool(registry, { steps: [{ op: 'write', path: 'a.md', content: 'x' }] }, deps),
      /Could not persist the rollback journal.*a crash mid-bundle could not be undone/s,
    );
    assert.equal(store.get('a.md'), 'A');
  });

  test('a journal id already taken refuses the bundle rather than overwriting it', async () => {
    const { registry, deps, store } = harness({ files: { 'a.md': 'A', [JOURNAL]: '{"version":1}' } });
    await assert.rejects(
      writeBundleTool(registry, { steps: [{ op: 'write', path: 'a.md', content: 'x' }] }, deps),
      /Could not persist the rollback journal/,
    );
    assert.equal(store.get(JOURNAL), '{"version":1}');
  });

  test('backups over the size bound refuse the bundle, naming the numbers', async () => {
    const big = 'x'.repeat(MAX_BACKUP_BYTES + 1);
    const { registry, deps } = harness({ files: { 'big.md': big } });
    await assert.rejects(
      writeBundleTool(registry, { steps: [{ op: 'write', path: 'big.md', content: 'small' }] }, deps),
      new RegExp(`${MAX_BACKUP_BYTES + 1} bytes, over the ${MAX_BACKUP_BYTES}-byte backup limit`),
    );
  });
});

describe('write_bundle — sealed preview (C3)', () => {
  const steps = [
    { op: 'write', path: 'a.md', content: 'NEW A' },
    { op: 'write', path: 'fresh.md', content: 'NEW' },
  ];

  test('preview writes nothing and returns the plan plus a seal', async () => {
    const { registry, store, deps, io } = harness({ files: { 'a.md': 'A' } });
    const out = await writeBundleTool(registry, { steps, preview: true }, deps);
    assert.equal(out.preview, true);
    assert.match(out.approvedPlanSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(out.targets, [
      { path: 'a.md', exists: true, contentSha256: contentSha256('A') },
      { path: 'fresh.md', exists: false, contentSha256: null },
    ]);
    assert.equal(io.some(([verb]) => verb !== 'get'), false);
    assert.equal(store.size, 1);
  });

  test('the seal is the one the pure builder computes for this vault and op', async () => {
    const { registry, vault, deps } = harness({ files: { 'a.md': 'A' } });
    const out = await writeBundleTool(registry, { steps, preview: true }, deps);
    const expected = computePlanSeal({
      op: BUNDLE_SEAL_OP,
      identity: vaultIdentity(vault),
      plan: buildBundlePlan(
        validateSteps(steps),
        new Map([
          ['a.md', { existed: true, contentSha256: contentSha256('A') }],
          ['fresh.md', { existed: false, contentSha256: null }],
        ]),
      ),
    });
    assert.equal(out.approvedPlanSha256, expected);
  });

  test('an approved seal applies; a target that drifted refuses BEFORE any write', async () => {
    const h = harness({ files: { 'a.md': 'A' } });
    const preview = await writeBundleTool(h.registry, { steps, preview: true }, h.deps);

    // Someone edits a.md between the preview and the apply.
    h.store.set('a.md', 'A-CHANGED');
    await assert.rejects(
      writeBundleTool(h.registry, { steps, approvedPlanSha256: preview.approvedPlanSha256 }, h.deps),
      (err) => {
        assert.equal(err.kind, 'plan_drift');
        assert.match(err.message, /Nothing was written/);
        return true;
      },
    );
    assert.equal(h.store.get('a.md'), 'A-CHANGED');
    assert.equal(h.store.has('fresh.md'), false);
    assert.equal(h.store.has(JOURNAL), false);

    // Put it back → the same seal applies.
    h.store.set('a.md', 'A');
    const out = await writeBundleTool(h.registry, { steps, approvedPlanSha256: preview.approvedPlanSha256 }, h.deps);
    assert.equal(out.outcome, 'applied');
  });

  test('a seal approved for a DIFFERENT body cannot apply this one', async () => {
    const h = harness({ files: { 'a.md': 'A' } });
    const preview = await writeBundleTool(h.registry, { steps, preview: true }, h.deps);
    const swapped = [{ ...steps[0], content: 'SOMETHING ELSE' }, steps[1]];
    await assert.rejects(
      writeBundleTool(h.registry, { steps: swapped, approvedPlanSha256: preview.approvedPlanSha256 }, h.deps),
      /sealed-preview drift/,
    );
    assert.equal(h.store.get('a.md'), 'A');
  });

  test('a preview REPORTS an already-stale ifMatch instead of throwing — a preview describes reality', async () => {
    const h = harness({ files: { 'a.md': 'A' } });
    const withStale = [{ op: 'write', path: 'a.md', content: 'NEW A', ifMatch: contentSha256('SOMETHING ELSE') }];
    const out = await writeBundleTool(h.registry, { steps: withStale, preview: true }, h.deps);
    assert.equal(out.preview, true);
    assert.equal(out.willRefuse, true);
    assert.equal(out.stalePreconditions.length, 1);
    assert.equal(out.stalePreconditions[0].reason, 'content-changed');
    assert.match(out.message, /would be REFUSED as it stands/);
    // …and the apply of that same bundle still refuses.
    await assert.rejects(writeBundleTool(h.registry, { steps: withStale }, h.deps), /Bundle refused/);
  });

  test('a malformed seal is refused as plan drift, not ignored', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    await assert.rejects(
      writeBundleTool(registry, { steps, approvedPlanSha256: 'not-a-seal' }, deps),
      (err) => {
        assert.equal(err.kind, 'plan_drift');
        assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
        return true;
      },
    );
  });
});

describe('write_bundle — recovery from a journal a crash left behind', () => {
  /** A vault where a bundle died after writing a.md, journal still present. */
  function crashed({ current = { 'a.md': 'HALF WRITTEN', 'created.md': 'PARTIAL' } } = {}) {
    const journal = {
      version: 1,
      operationId: OP_ID,
      vault: 'v',
      startedAt: '2026-08-02T10:00:00.000Z',
      state: 'pending',
      steps: [
        { index: 0, op: 'write', path: 'a.md' },
        { index: 1, op: 'write', path: 'created.md' },
      ],
      backups: {
        'a.md': { existed: true, content: 'ORIGINAL A', contentSha256: contentSha256('ORIGINAL A') },
        'created.md': { existed: false, content: null, contentSha256: null },
      },
    };
    return harness({ files: { ...current, [JOURNAL]: `${JSON.stringify(journal, null, 2)}\n` } });
  }

  test('recover:true LISTS pending journals with a per-file verdict, and writes nothing', async () => {
    const { registry, store, deps, io } = crashed();
    const out = await writeBundleTool(registry, { recover: true }, deps);
    assert.equal(out.recover, 'list');
    assert.equal(out.pending.length, 1);
    const p = out.pending[0];
    assert.equal(p.operationId, OP_ID);
    assert.equal(p.startedAt, '2026-08-02T10:00:00.000Z');
    assert.equal(p.wouldChange, 2);
    assert.deepEqual(
      p.files.map((f) => [f.path, f.matchesBackup]),
      [['a.md', false], ['created.md', false]],
    );
    assert.match(out.message, /1 bundle journal\(s\).*1 still recoverable/s);
    // The listing must not pretend it knows which files the crashed bundle wrote.
    assert.match(out.message, /mixes files the bundle wrote with files YOU may have edited/);
    assert.equal(io.some(([verb]) => verb !== 'get'), false);
    assert.equal(store.get('a.md'), 'HALF WRITTEN');
  });

  test('an empty journal directory reports "nothing pending" rather than erroring', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    const out = await writeBundleTool(registry, { recover: true }, deps);
    assert.deepEqual(out.pending, []);
    assert.match(out.message, /No bundle journals/);
  });

  test('running a recovery without confirm:true is refused, with the reason', async () => {
    const { registry, store, deps } = crashed();
    await assert.rejects(
      writeBundleTool(registry, { recover: OP_ID }, deps),
      /Refusing to recover.*can prove neither.*recover:true first/s,
    );
    assert.equal(store.get('a.md'), 'HALF WRITTEN');
  });

  test('a confirmed recovery restores the pre-bundle state — and KEEPS the journal, because it is now the only copy of what it overwrote', async () => {
    const { registry, store, deps } = crashed();
    const out = await writeBundleTool(registry, { recover: OP_ID, confirm: true }, deps);
    assert.equal(out.recover, 'run');
    assert.equal(out.ok, true);
    assert.equal(store.get('a.md'), 'ORIGINAL A');
    assert.equal(store.has('created.md'), false);
    // No post-images survive a crash: every restore says so, and the outcome
    // must not borrow the word reserved for a PROVEN undo.
    assert.equal(out.outcome, 'rolled-back-unverified');
    assert.equal(out.rollback.verified, false);
    for (const p of out.rollback.paths) {
      if (p.action !== 'none') assert.equal(p.attribution, 'unverified');
    }
    // Deleting the journal here would destroy the post-crash content this
    // recovery just overwrote — the only place it exists.
    assert.equal(store.has(JOURNAL), true);
    const journal = JSON.parse(store.get(JOURNAL));
    assert.equal(journal.salvage['a.md'].content, 'HALF WRITTEN');
    assert.equal(journal.salvage['created.md'].content, 'PARTIAL');
    assert.match(out.warnings.join(' '), /overwrote content it could not attribute/);
  });

  test('a recovery that changes NOTHING is proven, and does remove the journal', async () => {
    const { registry, store, deps } = crashed({ current: { 'a.md': 'ORIGINAL A' } });
    const out = await writeBundleTool(registry, { recover: OP_ID, confirm: true }, deps);
    assert.equal(out.outcome, 'rolled-back');
    assert.equal(out.rollback.verified, true);
    assert.equal(store.has(JOURNAL), false);
  });

  test('two partial recoveries: the second neither re-restores the first\'s paths nor erases its salvage', async () => {
    const { registry, store, deps } = crashed();
    await writeBundleTool(registry, { recover: OP_ID, confirm: true, only: ['a.md'] }, deps);
    assert.equal(store.get('a.md'), 'ORIGINAL A');
    const afterFirst = JSON.parse(store.get(JOURNAL));
    assert.deepEqual(Object.keys(afterFirst.backups), ['created.md'], 'the resolved path is pruned');
    assert.equal(afterFirst.salvage['a.md'].content, 'HALF WRITTEN');

    // Someone edits the already-recovered file. A second recovery must not touch it.
    store.set('a.md', 'A DELIBERATE NEW EDIT');
    await writeBundleTool(registry, { recover: OP_ID, confirm: true }, deps);
    assert.equal(store.get('a.md'), 'A DELIBERATE NEW EDIT', 'the pruned path was never restored again');
    assert.equal(store.has('created.md'), false);
    const afterSecond = JSON.parse(store.get(JOURNAL));
    assert.equal(afterSecond.salvage['a.md'].content, 'HALF WRITTEN', 'the first salvage survived');
    assert.equal(afterSecond.salvage['created.md'].content, 'PARTIAL');
  });

  test('a recovery on files already back at their before-image is a clean no-op', async () => {
    const { registry, store, deps, io } = crashed({ current: { 'a.md': 'ORIGINAL A' } });
    const out = await writeBundleTool(registry, { recover: OP_ID, confirm: true }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.rollback.paths.map((p) => p.status), ['already-clean', 'already-clean']);
    assert.equal(store.get('a.md'), 'ORIGINAL A');
    assert.equal(io.filter(([verb]) => verb === 'put' || verb === 'cas').length, 0);
  });

  test('`only` restores a SUBSET — the answer to "that file I edited myself after the crash"', async () => {
    const { registry, store, deps } = crashed();
    const out = await writeBundleTool(registry, { recover: OP_ID, confirm: true, only: ['a.md'] }, deps);
    assert.equal(store.get('a.md'), 'ORIGINAL A', 'the chosen file is restored');
    assert.equal(store.get('created.md'), 'PARTIAL', 'the one left out is untouched');
    assert.equal(store.has(JOURNAL), true, 'a partial recovery KEEPS the journal so the rest stays recoverable');
    assert.equal(JSON.parse(store.get(JOURNAL)).state, 'pending');
    assert.match(out.message, /Restored 1 of 2 file\(s\)/);
  });

  test('`only` refuses a path the journal never recorded, and a non-canonical spelling resolves', async () => {
    const { registry, store, deps } = crashed();
    await assert.rejects(
      writeBundleTool(registry, { recover: OP_ID, confirm: true, only: ['not-in-there.md'] }, deps),
      /holds no backup for: not-in-there\.md/,
    );
    await assert.rejects(
      writeBundleTool(registry, { recover: OP_ID, confirm: true, only: [] }, deps),
      /must be a non-empty array/,
    );
    const out = await writeBundleTool(registry, { recover: OP_ID, confirm: true, only: ['/a.md'] }, deps);
    assert.equal(store.get('a.md'), 'ORIGINAL A');
    assert.equal(out.ok, true);
  });

  test('an unknown operation id says so instead of failing obscurely', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    await assert.rejects(
      writeBundleTool(registry, { recover: 'op-ffffffffffffffff', confirm: true }, deps),
      /No write journal for operation "op-ffffffffffffffff"/,
    );
  });

  test('a recover value that is neither true nor an operation id is refused', async () => {
    const { registry, deps } = harness({ files: { 'a.md': 'A' } });
    await assert.rejects(
      writeBundleTool(registry, { recover: '../../etc/passwd', confirm: true }, deps),
      /Invalid recover value/,
    );
  });

  test('an unreadable journal is reported in the listing instead of breaking it', async () => {
    const { registry, deps } = harness({ files: { [JOURNAL]: 'not json at all' } });
    const out = await writeBundleTool(registry, { recover: true }, deps);
    assert.equal(out.pending[0].unreadable, true);
    assert.match(out.pending[0].error, /not readable JSON/);
  });
});

// ---------------------------------------------------------------------------
// B. Through the REAL single-file tools, over a real HTTP server.
// ---------------------------------------------------------------------------

describe('write_bundle — drives the real write tools over the wire', () => {
  let server;
  let vault;
  let registry;
  let files;
  let refuse;

  before(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const url = decodeURIComponent(req.url);
      const path = url.startsWith('/vault/') ? url.slice('/vault/'.length) : null;

      if (path && req.method === 'GET') {
        if (!files.has(path)) { res.writeHead(404); res.end('nope'); return; }
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(files.get(path));
        return;
      }
      if (path && req.method === 'PUT') {
        if (refuse.has(path)) { res.writeHead(500); res.end('refused'); return; }
        if (req.headers['apply-if-content-preexists'] === 'false' && files.has(path)) {
          res.writeHead(409); res.end('exists'); return;
        }
        files.set(path, body);
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('');
        return;
      }
      if (path && req.method === 'POST') {
        if (refuse.has(path)) { res.writeHead(500); res.end('refused'); return; }
        files.set(path, (files.get(path) || '') + body);
        res.writeHead(200); res.end('');
        return;
      }
      if (path && req.method === 'DELETE') {
        if (!files.has(path)) { res.writeHead(404); res.end('nope'); return; }
        files.delete(path);
        res.writeHead(200); res.end('');
        return;
      }
      // The atomic CAS route is not implemented here → 404 → the router uses its
      // documented GET-compare fallback, which is exactly the fleet's state on a
      // vault without bridge 0.7.0.
      res.writeHead(404); res.end('');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    vault = {
      name: 'real',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k',
      timeoutMs: 5000,
    };
    registry = { resolveVault: () => vault };
  });

  after(() => new Promise((r) => server.close(r)));

  beforeEach(() => {
    files = new Map();
    refuse = new Set();
  });

  test('a successful bundle really writes, appends and patches through the tools', async () => {
    files.set('wiki/index.md', '# Index\n\n## Pages\n\n');
    files.set('wiki-meta/journal.md', '# Journal\n');

    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'wiki/note.md', content: '# Note\n\nbody\n' },
        { op: 'patch', path: 'wiki/index.md', operation: 'append', targetType: 'heading', target: 'Index::Pages', content: '- [[note]]' },
        { op: 'append', path: 'wiki-meta/journal.md', content: '- created note\n' },
      ],
    }, { randomHex: () => OP_HEX });

    assert.equal(out.outcome, 'applied');
    assert.equal(out.operationId, OP_ID);
    assert.equal(files.get('wiki/note.md'), '# Note\n\nbody\n');
    assert.match(files.get('wiki/index.md'), /## Pages\n\n- \[\[note\]\]/);
    assert.equal(files.get('wiki-meta/journal.md'), '# Journal\n- created note\n');
    assert.equal(files.has(JOURNAL), false);
    // The real write_file result travelled back inside the step report.
    assert.equal(out.steps[0].result.bytesWritten, Buffer.byteLength('# Note\n\nbody\n', 'utf8'));
  });

  test('a real mid-bundle failure rolls the real files back byte-for-byte', async () => {
    const original = '# Index\r\n\r\n## Pages\r\n\r\n- [[old]]\r\n';
    files.set('wiki/index.md', original);
    refuse.add('wiki/broken.md');

    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'wiki/note.md', content: '# Note\n' },
        { op: 'patch', path: 'wiki/index.md', operation: 'append', targetType: 'heading', target: 'Index::Pages', content: '- [[note]]' },
        { op: 'write', path: 'wiki/broken.md', content: 'never lands' },
      ],
    }, { randomHex: () => OP_HEX });

    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'rolled-back');
    assert.equal(out.rollback.clean, true);
    assert.equal(files.has('wiki/note.md'), false);
    assert.equal(files.get('wiki/index.md'), original, 'CRLF index restored byte-for-byte');
    assert.equal(files.has(JOURNAL), false);
  });

  test('a real stale ifMatch refuses the whole bundle without touching the vault', async () => {
    files.set('a.md', 'A');
    files.set('b.md', 'B');
    await assert.rejects(
      writeBundleTool(registry, {
        steps: [
          { op: 'write', path: 'a.md', content: 'new A' },
          { op: 'write', path: 'b.md', content: 'new B', ifMatch: contentSha256('SOMETHING ELSE') },
        ],
      }, { randomHex: () => OP_HEX }),
      /steps\[1\] expects "b\.md"/,
    );
    assert.equal(files.get('a.md'), 'A');
    assert.equal(files.get('b.md'), 'B');
    assert.equal(files.has(JOURNAL), false);
  });

  test('a patch the target already satisfied is reported as SKIPPED, not counted as a write', async () => {
    files.set('wiki/index.md', '# Index\n\n## Pages\n\n- [[note]]\n');
    const out = await writeBundleTool(registry, {
      steps: [{
        op: 'patch', path: 'wiki/index.md', operation: 'append', targetType: 'heading',
        target: 'Index::Pages', content: '- [[note]]', applyIfContentPreexists: true,
      }],
    }, { randomHex: () => OP_HEX });

    assert.equal(out.outcome, 'applied', 'an idempotent no-op is a success, not a rollback trigger');
    assert.equal(out.steps[0].status, 'skipped');
    assert.equal(out.applied, 0);
    assert.equal(out.skipped, 1);
    assert.match(out.message, /1 of them a no-op the target already satisfied/);
  });

  test('a real ifMatch on an APPEND step is enforced by the tool, not just pre-checked', async () => {
    // append_to_file used to accept `ifMatch` and ignore it, so a bundle's
    // pre-flight check was the only guard and the window after it was open.
    files.set('log.md', '# Log\n');
    await assert.rejects(
      appendToFileTool(registry, { path: 'log.md', content: '- x\n', ifMatch: contentSha256('SOMETHING ELSE') }),
      (err) => { assert.equal(err.kind, 'conflict'); return true; },
    );
    assert.equal(files.get('log.md'), '# Log\n', 'nothing was appended');
    await appendToFileTool(registry, { path: 'log.md', content: '- x\n', ifMatch: contentSha256('# Log\n') });
    assert.equal(files.get('log.md'), '# Log\n- x\n');
    await assert.rejects(
      appendToFileTool(registry, { path: 'log.md', content: 'x', ifMatch: 'nope' }),
      /Invalid ifMatch/,
    );
  });

  test('a real ifMatch on set_frontmatter is enforced too', async () => {
    files.set('page.md', '---\nstatus: open\n---\n\nbody\n');
    await assert.rejects(
      setFrontmatterTool(registry, { path: 'page.md', key: 'status', value: 'closed', ifMatch: contentSha256('stale') }),
      (err) => { assert.equal(err.kind, 'conflict'); return true; },
    );
    assert.equal(files.get('page.md'), '---\nstatus: open\n---\n\nbody\n', 'the file was not patched');
  });

  test('BOM: a rollback restores what the router READ, which is the file without its BOM', async () => {
    // Not a defect to fix here but a transport property to pin: Local REST API's
    // body arrives through the WHATWG UTF-8 decoder, which strips a leading BOM
    // (the same normalisation C1's hash depends on — content-hash.mjs). So the
    // honest claim is "the content the bundle read", and this test is what stops
    // anyone from re-asserting "byte-identical" later.
    const withBom = '﻿# Titre\r\nligne\r\n';
    files.set('bom.md', withBom);
    refuse.add('wiki/broken.md');

    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'write', path: 'bom.md', content: 'REWRITTEN' },
        { op: 'write', path: 'wiki/broken.md', content: 'never' },
      ],
    }, { randomHex: () => OP_HEX });

    assert.equal(out.outcome, 'rolled-back');
    assert.equal(files.get('bom.md'), withBom.slice(1), 'restored without the BOM the read path dropped');
    assert.equal(files.get('bom.md').charCodeAt(0) === 0xfeff, false);
    // Everything after the BOM is exact — CRLF included.
    assert.equal(files.get('bom.md'), '# Titre\r\nligne\r\n');
    assert.doesNotMatch(out.message, /byte-identical/);
  });

  test('a real delete step is confirmed, applied, and restored on a later failure', async () => {
    files.set('wiki/stale.md', 'STALE CONTENT');
    refuse.add('wiki/broken.md');
    const out = await writeBundleTool(registry, {
      steps: [
        { op: 'delete', path: 'wiki/stale.md', confirm: true },
        { op: 'write', path: 'wiki/broken.md', content: 'never' },
      ],
    }, { randomHex: () => OP_HEX });
    assert.equal(out.outcome, 'rolled-back');
    assert.equal(files.get('wiki/stale.md'), 'STALE CONTENT');
  });
});
