/**
 * Fixture for tests/copy-tree.test.mjs — measures, in a SEPARATE process, what
 * `fs.cpSync` and `copyTreeSync` each do with an accented destination.
 *
 * It runs in its own process because the accented-SOURCE form of this defect is
 * a native fast-fail on win32 (exit 0xC0000409, no JavaScript error, no stderr):
 * a test that measured it in-process would take the whole suite down with it.
 * Only the destination form is exercised here, which is enough to tell the two
 * implementations apart, and the process is left free to die if it must.
 *
 * Everything happens under os.tmpdir() and is removed afterwards. The last line
 * of stdout is the verdict, as JSON.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyTreeSync } from '../../src/helpers/copy-tree.mjs';

const E_ACUTE = String.fromCharCode(0xe9);

/** Copy `source` into `<root>/<accented>/vault` and list what appeared in root. */
function measure(copy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-probe-'));
  try {
    const src = path.join(root, 'source');
    fs.mkdirSync(path.join(src, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(src, 'inner', 'a.txt'), 'x');

    const accented = 'La m' + E_ACUTE + 'thode';
    const dst = path.join(root, accented, 'vault');
    // The accented parent is created by a call MEASURED to be path-safe, so any
    // extra directory that appears was created by the copy under test.
    fs.mkdirSync(path.join(root, accented), { recursive: true });

    let error = null;
    try {
      copy(src, dst);
    } catch (err) {
      error = String(err && err.message);
    }
    // Everything under root except the source tree itself.
    const entries = fs.readdirSync(root).filter((e) => e !== 'source');
    return { entries, error };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cp = measure((src, dst) => fs.cpSync(src, dst, { recursive: true }));
const tree = measure((src, dst) => copyTreeSync(src, dst));

console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  cpSyncEntries: cp.entries,
  cpSyncError: cp.error,
  copyTreeEntries: tree.entries,
  copyTreeError: tree.error,
}));
