/**
 * Tests for src/helpers/resolve-vault-path.mjs — the on-disk path verifier /
 * basename repairer behind build_open_link's determinism guarantee.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveVaultPathOnDisk, resolveVaultPathViaRest } from '../src/helpers/resolve-vault-path.mjs';

let vaultPath;
let vault;

before(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-vault-'));
  for (const rel of [
    'wiki/Projects/secrets.md', // unique basename
    'wiki/a/dup.md', // dup basename #1
    'wiki/b/dup.md', // dup basename #2
    '.obsidian/plugins/x/dup.md', // dot-dir → must be ignored by the walk
  ]) {
    const abs = path.join(vaultPath, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# ' + rel);
  }
  vault = { type: 'local', path: vaultPath, name: 'test' };
});

after(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

describe('resolveVaultPathOnDisk', () => {
  test('exact path → ok', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/Projects/secrets.md'), {
      status: 'ok',
      path: 'wiki/Projects/secrets.md',
    });
  });

  test('wrong folder, unique basename → corrected to the real path', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/WRONG/secrets.md'), {
      status: 'corrected',
      path: 'wiki/Projects/secrets.md',
      from: 'wiki/WRONG/secrets.md',
    });
  });

  test('ambiguous basename → ambiguous with both real paths (dot-dir excluded)', () => {
    const r = resolveVaultPathOnDisk(vault, 'anywhere/dup.md');
    assert.equal(r.status, 'ambiguous');
    assert.deepEqual(r.matches.slice().sort(), ['wiki/a/dup.md', 'wiki/b/dup.md']);
    // the .obsidian copy must NOT count (walk skips dot-dirs)
    assert.ok(!r.matches.some((m) => m.includes('.obsidian')));
  });

  test('no such basename → not_found', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/ghost.md'), { status: 'not_found' });
  });

  test('folder exact path → ok (folders are openable)', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/Projects'), {
      status: 'ok',
      path: 'wiki/Projects',
    });
  });

  test('remote vault → unverifiable (skip, cannot stat)', () => {
    assert.deepEqual(resolveVaultPathOnDisk({ type: 'remote', name: 'r' }, 'x.md'), {
      status: 'unverifiable',
    });
  });

  test('missing path arg → unverifiable', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, ''), { status: 'unverifiable' });
  });

  test('backslash separators are normalised before lookup', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki\\Projects\\secrets.md'), {
      status: 'ok',
      path: 'wiki/Projects/secrets.md',
    });
  });
});

// ---------------------------------------------------------------------------

// PARITY BETWEEN THE TWO BACKENDS (v0.80.0) — and this table found two real
// defects the moment it was written.
//
// `resolveVaultPathViaRest` claims to answer "the same five verdicts" as the
// on-disk resolver. A claim of equivalence is only worth what a case-by-case
// comparison says, so here is the comparison, as a table, over the path shapes
// that actually differ in handling. Reading either implementation would not have
// caught either defect:
//
//   - a bare NON-MARKDOWN basename (`image.png`) answered `not_found` over REST
//     for a file that EXISTS, because the fallback leaned on the markdown-only
//     walker `build_search_index` shares. A fabricated verdict, and one that
//     makes single mode THROW. Fixed by walking like the disk does (every file),
//     not by narrowing the claim.
//   - a folder with a TRAILING SLASH (`wiki/deep/`) answered `unverifiable`,
//     because the basename of `a/b/` is the empty string. The disk backend says
//     `ok`.
//
// WHERE PARITY STOPS, and it is a bound not a bug. Both backends cap their
// walk, but they count different things: the disk walk stops at 20 000 entries
// EXAMINED, this one at 5 000 files COLLECTED (assets included) or 20 000
// visited. On a vault with tens of thousands of attachments the REST side can
// therefore hit its ceiling first and answer `resolution_incomplete` where the
// disk answers `corrected`. That divergence is SAFE — the cautious verdict, not
// a fabricated one — but it means parity is claimed for enumerations that
// COMPLETE, which is what this table exercises (review, 2026-08-31).
//
// If a future change makes the two disagree again, this table is where it shows.
describe('the REST backend answers exactly what the disk backend answers', () => {
  const FILES = [
    'wiki/alpha.md', 'wiki/deep/cible.md', 'wiki/image.png',
    'racine.md', 'wiki/a/twin.md', 'wiki/b/twin.md',
  ];
  let root;
  let localVault;
  let deps;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-parity-'));
    for (const rel of FILES) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '# x\n');
    }
    localVault = { name: 'v', type: 'local', path: root };

    // The SAME tree, served through a fake `listFilesIn` in the Local REST API
    // shape (folders carry a trailing slash). Same content, two instruments.
    const dirs = {};
    for (const rel of FILES) {
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        const entry = i === parts.length - 1 ? parts[i] : `${parts[i]}/`;
        (dirs[dir] ||= new Set()).add(entry);
      }
    }
    deps = {
      listFilesIn: async (_v, dir) => {
        const key = String(dir).replace(/\/+$/, '');
        if (!(key in dirs)) { const e = new Error('not found'); e.kind = 'not_found'; throw e; }
        return { files: [...dirs[key]] };
      },
    };
  });

  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  const CASES = [
    ['wiki/alpha.md', 'exact, nested'],
    ['racine.md', 'exact, at the ROOT (parent is the empty string)'],
    ['alpha.md', 'bare basename, unique → corrected'],
    ['cible.md', 'bare basename, two levels down'],
    ['twin.md', 'bare basename, AMBIGUOUS'],
    ['wiki/inexistant.md', 'absent, parent exists'],
    ['nulle/part/x.md', 'absent, parent does not exist either'],
    ['wiki/image.png', 'exact, NOT markdown'],
    ['wiki/absente.png', 'absent, not markdown, parent exists'],
    ['image.png', 'bare basename, NOT markdown — the fabricated not_found'],
    ['wiki/deep', 'a FOLDER'],
    ['wiki/deep/', 'a folder with a trailing slash — the empty-basename case'],
    ['wiki\\alpha.md', 'Windows separators'],
    ['/wiki/alpha.md', 'leading slash'],
    // A REVIEW CLAIMED the disk backend answers `corrected` here and the REST
    // one `not_found`, making the walker's exclusion of directories a parity
    // bug. Measured: BOTH say `not_found` — `findByBasename` pushes a directory
    // onto its stack and never into `matches`, so a bare folder basename is
    // unresolvable on either side. The REST walker mirrors that deliberately.
    // Pinned so the claim does not have to be re-litigated from memory.
    ['deep', 'bare basename of a FOLDER — not_found on BOTH, by design'],
    ['a', 'same, one level down'],
  ];

  // The verdict and the resolved path must match. The `matches` ARRAY may
  // differ in length — the disk walk stops early once ambiguity is settled,
  // this one has the whole list — so only its emptiness is compared.
  const shape = (v) => `${v.status}|${v.path ?? ''}|${v.matches ? 'matches' : ''}`;

  for (const [input, why] of CASES) {
    test(`${JSON.stringify(input)} — ${why}`, async () => {
      const onDisk = resolveVaultPathOnDisk(localVault, input);
      const viaRest = await resolveVaultPathViaRest(
        { name: 'v', type: 'remote', baseUrl: 'http://127.0.0.1:1' }, input, deps,
      );
      assert.equal(shape(viaRest), shape(onDisk));
    });
  }

  // The shared walker memoises its PROMISE, including a rejected one. Two
  // callers must both get the same graceful `unverifiable` — not one rejection
  // handled and a second one escaping as an unhandled rejection — and the walk
  // must run once.
  test('a failing shared walk is reported once, gracefully, to every caller', async () => {
    let calls = 0;
    let pending = null;
    const walk = () => {
      if (!pending) { calls += 1; pending = Promise.reject(new Error('walk failed')); }
      return pending;
    };
    const vault = { name: 'v', type: 'remote', baseUrl: 'http://127.0.0.1:1' };
    const a = await resolveVaultPathViaRest(vault, 'inconnu.md', { ...deps, walk });
    const b = await resolveVaultPathViaRest(vault, 'autre.md', { ...deps, walk });
    assert.equal(a.status, 'unverifiable');
    assert.equal(b.status, 'unverifiable');
    assert.equal(calls, 1, 'the rejected promise is shared, not re-attempted per path');
  });

  // A shared `walk` is enough on its own: demanding `collectMarkdown` too made
  // the injection point unusable standalone (found while probing before the push).
  test('a caller supplying only listFilesIn + walk is served', async () => {
    const vault = { name: 'v', type: 'remote', baseUrl: 'http://127.0.0.1:1' };
    const walk = async () => ({ paths: ['wiki/alpha.md'], truncated: false, listFailures: 0 });
    const r = await resolveVaultPathViaRest(vault, 'alpha.md', { listFilesIn: deps.listFilesIn, walk });
    assert.equal(r.status, 'corrected');
    assert.equal(r.path, 'wiki/alpha.md');
  });
});

// ---------------------------------------------------------------------------

// A MALFORMED ANSWER IS NOT AN EMPTY VAULT — the rule, held in BOTH places.
//
// The exact-path branch learned this first; a review then found the same
// coercion still sitting in the fallback walker, where it could fabricate
// `not_found` from a response nobody could read. Same defect class, one
// function down. These tests pin both halves, and the reason each carries.
describe('the REST backend never invents absence', () => {
  const vault = { name: 'v', type: 'remote', baseUrl: 'http://127.0.0.1:1' };
  const notFound = () => { const e = new Error('nf'); e.kind = 'not_found'; throw e; };

  test('a parent listing with a non-array `files` is unverifiable, not not_found', async () => {
    const r = await resolveVaultPathViaRest(vault, 'wiki/a.md', {
      listFilesIn: async () => ({ files: null }),
    });
    assert.equal(r.status, 'unverifiable');
    assert.equal(r.reason, 'malformed-listing');
  });

  test('a WALK listing with a non-array `files` is unverifiable too', async () => {
    // The parent 404s (so the fallback runs); the root then answers 200 with a
    // shape nobody can read. An empty-vault reading here would say `not_found`.
    const r = await resolveVaultPathViaRest(vault, 'absent/a.md', {
      listFilesIn: async (_v, dir) => {
        if (dir === 'absent') return notFound();
        return { files: null };
      },
    });
    assert.equal(r.status, 'unverifiable');
    assert.equal(r.reason, 'malformed-listing');
  });

  // A WALK THAT NEVER BEGAN is not a partial scan. Telling the caller to "pass
  // the exact full path" fixes nothing when the answer was 401.
  test('a walk whose every listing failed reports WHY, not "incomplete"', async () => {
    for (const kind of ['unauthorized', 'timeout', 'server_error']) {
      const r = await resolveVaultPathViaRest(vault, 'absent/a.md', {
        listFilesIn: async (_v, dir) => {
          if (dir === 'absent') return notFound();
          const e = new Error(kind); e.kind = kind; throw e;
        },
      });
      assert.equal(r.status, 'unverifiable', kind);
      assert.equal(r.reason, kind, `the reason must survive the walk: ${kind}`);
    }
  });

  // …but a walk that DID read something and merely stumbled later is still a
  // partial scan, and stays actionable.
  test('a partially-read walk is resolution_incomplete, not unverifiable', async () => {
    const r = await resolveVaultPathViaRest(vault, 'absent/a.md', {
      listFilesIn: async (_v, dir) => {
        if (dir === 'absent') return notFound();
        if (dir === '') return { files: ['sub/'] };
        const e = new Error('boom'); e.kind = 'server_error'; throw e;
      },
    });
    assert.equal(r.status, 'resolution_incomplete');
  });
});

// ---------------------------------------------------------------------------

// THE WALKER'S FAILURE MODES, PARTITIONED — measured, not reasoned about.
//
// Three verdicts share one code path and the boundaries between them are where
// a fabricated answer hides. Each row below is a distinct way the enumeration
// can go wrong, and the row for "the root simply is not there" is checked
// against the DISK backend rather than against my own expectation.
describe('every way the walk can fail lands on the right verdict', () => {
  const vault = { name: 'v', type: 'remote', baseUrl: 'http://127.0.0.1:1' };
  const nf = () => { const e = new Error('nf'); e.kind = 'not_found'; throw e; };
  const fail = (kind) => () => { const e = new Error(kind); e.kind = kind; throw e; };

  const SCENARIOS = [
    // A ROOT 404 IS NOT AN EMPTY VAULT. It is a route that did not answer — a
    // wrong endpoint, a proxy, an API without `/vault/`. An earlier version
    // called this `not_found`, and defended it by measuring that the DISK
    // backend agrees. That reasoning was wrong: agreement between two backends
    // is agreement, not proof. On disk a missing root really is an absent
    // vault; over REST it is only an unanswered request (review, 2026-08-31).
    ['the ROOT 404s — nothing could be enumerated', async () => nf(), 'unverifiable', 'root-listing-not-found'],
    // …whereas a root that ANSWERS and is empty is a proven absence.
    ['the root is empty', async (_v, d) => (d === '' ? { files: [] } : nf()), 'not_found', null],
    ['a listing ENTRY is unreadable', async (_v, d) => (d === '' ? { files: [null, 'wiki/'] } : nf()), 'resolution_incomplete', null],
    ['the root refuses', async (_v, d) => (d === '' ? fail('unauthorized')() : nf()), 'unverifiable', 'unauthorized'],
    ['the root is unreadable', async (_v, d) => (d === '' ? { files: null } : nf()), 'unverifiable', 'malformed-listing'],
    ['the root reads, a subdirectory fails', async (_v, d) => {
      if (d === '') return { files: ['sub/'] };
      if (d === 'sub') return fail('server_error')();
      return nf();
    }, 'resolution_incomplete', null],
  ];

  for (const [why, listFilesIn, status, reason] of SCENARIOS) {
    test(`${why} → ${status}${reason ? ` (${reason})` : ''}`, async () => {
      const r = await resolveVaultPathViaRest(vault, 'absent/x.md', { listFilesIn });
      assert.equal(r.status, status);
      if (reason) assert.equal(r.reason, reason);
    });
  }

  // A DELIBERATE DIVERGENCE FROM THE DISK BACKEND, and the one place parity is
  // the wrong goal. An empty directory on disk is a fact the filesystem states;
  // a `404` from a REST route is a fact about the ROUTE. Making the two agree
  // would mean adopting the disk's certainty without the disk's evidence.
  test('an empty vault: not_found on disk, unverifiable over REST — on purpose', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-empty-'));
    try {
      const onDisk = resolveVaultPathOnDisk({ name: 'v', type: 'local', path: emptyDir }, 'absent/x.md');
      const viaRest = await resolveVaultPathViaRest(vault, 'absent/x.md', { listFilesIn: async () => nf() });
      assert.equal(onDisk.status, 'not_found', 'the filesystem CAN prove absence');
      assert.equal(viaRest.status, 'unverifiable', 'an unanswered route cannot');
      assert.equal(viaRest.reason, 'root-listing-not-found');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // The finer half of the same rule: one bad MEMBER of a listing is unreadable
  // data, not a missing file. Checking only that `files` is an array left this
  // to be skipped entry by entry, and an empty enumeration then produced a
  // decisive `not_found` (review, 2026-08-31).
  test('a listing carrying a junk entry cannot yield a decisive not_found', async () => {
    const r = await resolveVaultPathViaRest(vault, 'absent/a.md', {
      listFilesIn: async (_v, d) => {
        if (d === 'absent') return nf();
        if (d === '') return { files: [null, { path: 'wiki/a.md' }] };
        return nf();
      },
    });
    assert.notEqual(r.status, 'not_found', 'absence was never proven — the listing was unreadable');
    assert.equal(r.status, 'resolution_incomplete');
  });

  // …and valid members alongside a junk one are still USED: dropping real data
  // would trade one fabricated answer for another.
  test('valid entries beside a junk one are still enumerated', async () => {
    const r = await resolveVaultPathViaRest(vault, 'cible.md', {
      listFilesIn: async (_v, d) => {
        if (d === '') return { files: [null, 'wiki/'] };
        if (d === 'wiki') return { files: ['cible.md'] };
        return nf();
      },
    });
    // The file WAS found, so ambiguity/absence never arises — but the walk was
    // flagged, so the verdict stays cautious rather than `corrected`.
    assert.equal(r.status, 'resolution_incomplete');
  });
});
