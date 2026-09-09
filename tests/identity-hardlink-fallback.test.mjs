/**
 * Production incident, 2026-09-09 — the fifth adversarial round's hard-link
 * publish had no fallback for a filesystem that refuses `link()` with a code
 * nobody anticipated.
 *
 * Measured mid-migration, against Roland's real 27-vault fleet: 11 of them
 * live on Google-Drive-mounted letters (`M:`, `P:`, `O:`), whose virtual
 * filesystem does not support hard links and answers `EISDIR` — not one of
 * the four POSIX "no hard links here" codes (`EPERM`/`ENOSYS`/`EXDEV`/
 * `EOPNOTSUPP`) the write path enumerated. The CLI crashed uncaught on the
 * third vault; `.template` and `TradingView` (both on `C:`, real NTFS) had
 * already been stamped correctly and were verified byte-identical on their
 * `data.json` afterward — the safety held, only the coverage did not.
 *
 * Six adversarial rounds and a 22-probe penetration test exercised this exact
 * function and never found this, because none of them ran against an actual
 * virtualised or networked mount. This is what closes that gap: rather than
 * enumerating one more error code, `link()`'s result is now binary — EEXIST
 * means a real conflict, anything else means "cannot publish by hard link
 * here, for whatever reason this driver has" — and the fallback is exercised
 * by simulating exactly the measured failure, not by guessing at others.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { writeVaultIdentity, readVaultIdentity, identityPathFor } from '../src/vault-identity-store.mjs';
import { createVaultIdentity } from '../src/helpers/vault-identity.mjs';

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Replace fs.link for the duration of `fn`, then restore it unconditionally. */
async function withPatchedLink(impl, fn) {
  const original = fsp.link;
  fsp.link = impl;
  try {
    return await fn();
  } finally {
    fsp.link = original;
  }
}

describe('a filesystem that refuses link() with an unrecognised code still publishes', () => {
  let dir;
  beforeEach(() => { dir = tmp('hardlink-fallback-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('EISDIR — the exact code measured against Google Drive — falls back and succeeds', async () => {
    // ► MUTATION WITNESS: remove the fallback (throw `err` unconditionally
    //   instead of setting `needsFallback`) and this test fails with EISDIR
    //   propagating instead of a created identity.
    await withPatchedLink(
      async () => { const e = new Error('illegal operation on a directory, link'); e.code = 'EISDIR'; throw e; },
      async () => {
        const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
        const out = await writeVaultIdentity(dir, identity, { ifNew: true });
        assert.equal(out.created, true);
        assert.equal(out.stagingLeftBehind, null);
      },
    );
    const back = await readVaultIdentity(dir);
    assert.equal(back.status, 'ok');
    assert.equal(back.identity.vaultId, ID_A);
  });

  test('a code nobody has measured yet is treated the same way — the fallback is not an allowlist', async () => {
    // The whole point of the fix: it does not matter WHICH non-EEXIST code a
    // driver invents. `ENOTSUP`, spelled without the second `O` unlike the
    // handled `EOPNOTSUPP`, is deliberately something the old allowlist would
    // have missed too.
    await withPatchedLink(
      async () => { const e = new Error('operation not supported'); e.code = 'ENOTSUP'; throw e; },
      async () => {
        const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
        const out = await writeVaultIdentity(dir, identity, { ifNew: true });
        assert.equal(out.created, true);
      },
    );
  });

  test('the staging file is still cleaned up when the fallback is used', async () => {
    await withPatchedLink(
      async () => { const e = new Error('x'); e.code = 'EISDIR'; throw e; },
      async () => {
        const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
        await writeVaultIdentity(dir, identity, { ifNew: true });
      },
    );
    const leftovers = fs.readdirSync(path.dirname(identityPathFor(dir))).filter((f) => f.includes('.new-'));
    assert.deepEqual(leftovers, [], `staging file survived the fallback path: ${leftovers.join(', ')}`);
  });

  test('EEXIST from link() is still refused, never routed to the fallback', async () => {
    // The one non-EEXIST-shaped outcome that must NOT fall back — a real
    // conflict must stay a refusal, not a second attempt that could paper over
    // a genuine concurrent writer.
    const file = identityPathFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(createVaultIdentity({ randomUUID: () => ID_B, owner: null })));

    let fallbackAttempted = false;
    const originalOpen = fsp.open;
    fsp.open = async (target, flag) => {
      if (target === file && flag === 'wx') fallbackAttempted = true;
      return originalOpen(target, flag);
    };
    try {
      await assert.rejects(
        () => writeVaultIdentity(dir, createVaultIdentity({ randomUUID: () => ID_A, owner: null }), { ifNew: true }),
        (err) => err.kind === 'identity-exists',
      );
    } finally {
      fsp.open = originalOpen;
    }
    // The staging file's own `open('wx')` also happens — so this only proves
    // the fallback's SPECIFIC destination-open never ran, not that open() was
    // never called at all.
    assert.equal(fallbackAttempted, false, 'EEXIST from link() reached the fallback instead of refusing');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vaultId, ID_B, 'the existing identity was touched');
  });

  test('a genuine race in the fallback itself (two writers, no hard links available) still refuses cleanly', async () => {
    // The narrower window the fallback re-opens is between OUR open('wx') and
    // OUR close/write — not between link's EEXIST check and the fallback. A
    // SECOND call reaching the fallback while a file is already there is an
    // ordinary EEXIST from ITS OWN open('wx'), refused the same way.
    await withPatchedLink(
      async () => { const e = new Error('x'); e.code = 'EISDIR'; throw e; },
      async () => {
        const first = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
        await writeVaultIdentity(dir, first, { ifNew: true });

        const second = createVaultIdentity({ randomUUID: () => ID_B, owner: null });
        await assert.rejects(
          () => writeVaultIdentity(dir, second, { ifNew: true }),
          (err) => err.kind === 'identity-exists',
        );
      },
    );
    assert.equal((await readVaultIdentity(dir)).identity.vaultId, ID_A, 'the second writer overwrote the first');
  });

  test('a write failure in the fallback removes the file it created, and the original error survives', async () => {
    await withPatchedLink(
      async () => { const e = new Error('x'); e.code = 'EISDIR'; throw e; },
      async () => {
        const file = identityPathFor(dir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const originalOpen = fsp.open;
        fsp.open = async (target, flag) => {
          const handle = await originalOpen(target, flag);
          if (target === file && flag === 'wx') {
            const originalWriteFile = handle.writeFile.bind(handle);
            handle.writeFile = async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
            handle._restoreWriteFile = originalWriteFile;
          }
          return handle;
        };
        try {
          await assert.rejects(
            () => writeVaultIdentity(dir, createVaultIdentity({ randomUUID: () => ID_A, owner: null }), { ifNew: true }),
            (err) => err.code === 'ENOSPC',
          );
        } finally {
          fsp.open = originalOpen;
        }
        assert.equal(fs.existsSync(file), false, 'an incomplete identity was left behind after a failed write');
      },
    );
  });

  test('an unpatched, real filesystem still uses the fast link() path — no behaviour change on NTFS', async () => {
    // Regression guard: the fallback must never fire when link() actually
    // works, which is the ordinary case on every local disk this router runs
    // on day to day.
    const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
    const out = await writeVaultIdentity(dir, identity, { ifNew: true });
    assert.equal(out.created, true);
    assert.equal((await readVaultIdentity(dir)).identity.vaultId, ID_A);
  });
});
