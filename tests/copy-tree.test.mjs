/**
 * copy-tree.mjs — the path-safe tree copy and the mis-encoding guard.
 *
 * THE MEASUREMENT THIS FILE PINS (node v24.13.0, win32, 2026-09-11): a
 * recursive `fs.cpSync` decodes its destination through the Windows ANSI code
 * page, so a tree copied into a directory whose name carries an accent lands in
 * a SECOND directory whose name is that accent double-encoded — while every
 * call reports success. With the accent on the SOURCE side the process dies on
 * an uncaught native exception instead (exit 0xC0000409), which no `try/catch`
 * can observe. That is why the first test here spawns a CHILD: a test that
 * called `fs.cpSync` in-process would take the whole suite down with it.
 *
 * The last describe block is the class sweep. Fixing the five call sites in
 * `setup-vault.mjs` and the one in `plugin-auto-update.mjs` fixes today's
 * copies; only a scan of the source keeps the seventh from arriving next month.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  copyTreeSync,
  isEncodingTwin,
  findEncodingTwins,
  scanEncodingTwins,
  describeEncodingTwins,
  classifyProvisioningTwins,
} from '../src/helpers/copy-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Built, never escaped — a `\u` typed into a source file becomes the character
// itself, and this file is precisely about which bytes end up where.
const E_ACUTE = String.fromCharCode(0xe9);            // é   (UTF-8 C3 A9)
const E_ACUTE_MANGLED = String.fromCharCode(0xc3, 0xa9); // Ã©  (UTF-8 C3 83 C2 A9)
const A_GRAVE = String.fromCharCode(0xe0);
const U_UMLAUT = String.fromCharCode(0xfc);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const EURO = String.fromCharCode(0x20ac);             // 0x80 in windows-1252 only

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-tree-'));
  const src = path.join(root, 'source');
  fs.mkdirSync(path.join(src, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(src, 'top.txt'), 'top');
  fs.writeFileSync(path.join(src, 'nested', 'mid.txt'), 'mid');
  fs.writeFileSync(path.join(src, 'nested', 'deeper', 'leaf.bin'), Buffer.from([0, 1, 2, 255]));
  return { root, src };
}

describe('copyTreeSync carries a non-ASCII path through unchanged', () => {
  test('an accented DESTINATION gets exactly one directory, with the whole tree', () => {
    const { root, src } = tmpTree();
    try {
      const dst = path.join(root, 'La m' + E_ACUTE + 'thode', 'vault');
      copyTreeSync(src, dst);

      assert.deepEqual(
        fs.readdirSync(root).sort(),
        ['La m' + E_ACUTE + 'thode', 'source'],
        'no second, mis-encoded directory may appear',
      );
      assert.equal(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8'), 'top');
      assert.equal(fs.readFileSync(path.join(dst, 'nested', 'mid.txt'), 'utf8'), 'mid');
      assert.deepEqual(
        fs.readFileSync(path.join(dst, 'nested', 'deeper', 'leaf.bin')),
        Buffer.from([0, 1, 2, 255]),
        'binary content must survive byte for byte',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an accented SOURCE is copied, and does not kill the process', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-tree-src-'));
    try {
      const src = path.join(root, 'source-' + E_ACUTE + A_GRAVE + U_UMLAUT);
      fs.mkdirSync(path.join(src, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(src, 'inner', 'a.txt'), 'from an accented source');

      copyTreeSync(src, path.join(root, 'copy'));
      assert.equal(
        fs.readFileSync(path.join(root, 'copy', 'inner', 'a.txt'), 'utf8'),
        'from an accented source',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the fs.cpSync it replaces really does mangle the destination here', () => {
    // Run in a CHILD: on win32 the accented-source form of this defect is a
    // fast-fail (0xC0000409), and even the destination form must not be allowed
    // to litter this process's temp tree if Node ever changes its mind.
    const probe = path.join(REPO_ROOT, 'tests', 'fixtures', 'cp-sync-accent-probe.mjs');
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    const verdict = JSON.parse(r.stdout.trim().split('\n').pop());

    // The point is NOT that cpSync is broken on every platform — it is that
    // copyTreeSync is correct on all of them, INCLUDING the one where cpSync is
    // not. So: assert what the platform actually does, and assert that
    // copyTreeSync did better wherever cpSync misbehaved.
    assert.equal(verdict.copyTreeEntries.length, 1, 'copyTreeSync must always produce one directory');
    if (verdict.cpSyncEntries.length !== 1) {
      assert.ok(
        verdict.cpSyncEntries.some((e) => e.includes(E_ACUTE_MANGLED)),
        `expected the classic double-encoding, got ${JSON.stringify(verdict.cpSyncEntries)}`,
      );
    }
  });

  test('filter skips an entry, and the whole subtree under a skipped directory', () => {
    const { root, src } = tmpTree();
    try {
      const dst = path.join(root, 'filtered');
      copyTreeSync(src, dst, { filter: (from) => path.basename(from) !== 'nested' });
      assert.ok(fs.existsSync(path.join(dst, 'top.txt')));
      assert.ok(!fs.existsSync(path.join(dst, 'nested')), 'a filtered-out directory must not be created');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('force:false leaves an existing destination file alone', () => {
    const { root, src } = tmpTree();
    try {
      const dst = path.join(root, 'no-force');
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(dst, 'top.txt'), 'MINE');
      copyTreeSync(src, dst, { force: false });
      assert.equal(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8'), 'MINE');
      assert.equal(fs.readFileSync(path.join(dst, 'nested', 'mid.txt'), 'utf8'), 'mid',
        'the entries that did NOT exist must still be copied');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a single file copies too, creating its parent directory', () => {
    const { root, src } = tmpTree();
    try {
      const dst = path.join(root, 'out', 'deep', 'renamed.txt');
      copyTreeSync(path.join(src, 'top.txt'), dst);
      assert.equal(fs.readFileSync(dst, 'utf8'), 'top');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isEncodingTwin — the guard\'s name comparator', () => {
  test('the accent seen through the wrong code page IS a twin', () => {
    assert.equal(isEncodingTwin('La m' + E_ACUTE_MANGLED + 'thode', 'La m' + E_ACUTE + 'thode'), true);
    assert.equal(isEncodingTwin('La m' + E_ACUTE + 'thode', 'La m' + E_ACUTE_MANGLED + 'thode'), true,
      'the relation is symmetric — the caller does not know which side is the corrupt one');
  });

  test('several accents in one name', () => {
    const clean = 'vault-' + E_ACUTE + '-' + A_GRAVE + U_UMLAUT;
    const mangled = Buffer.from(clean, 'utf8').toString('latin1');
    assert.notEqual(mangled, clean, 'the fixture must actually differ');
    assert.equal(isEncodingTwin(mangled, clean), true);
  });

  test('a windows-1252-only mangling is caught (the byte range latin1 does not share)', () => {
    // The fixture is BUILT from the windows-1252 table, not obtained from
    // `new TextDecoder('windows-1252')`: measured on node v24.13.0, that
    // decoder reports `encoding: 'windows-1252'` and then behaves as
    // ISO-8859-1, differing from true latin1 at zero of 256 bytes. A fixture
    // taken from it therefore tested latin1 twice and passed with the
    // windows-1252 table removed — the mutation run is what exposed it.
    const clean = 'prix-' + EURO;                       // UTF-8: … E2 82 AC
    const mangled = 'prix-' + String.fromCharCode(0xe2) // E2 -> â  (shared)
      + String.fromCharCode(0x201a)                     // 82 -> ‚  (cp1252 only)
      + String.fromCharCode(0xac);                      // AC -> ¬  (shared)
    const asLatin1 = Buffer.from(clean, 'utf8').toString('latin1');
    assert.notEqual(mangled, asLatin1, 'the fixture must lie in the range where the two tables differ');
    assert.equal(isEncodingTwin(mangled, clean), true);
  });

  test('the windows-1252 table really is windows-1252, not latin1 wearing its name', () => {
    // Pins the measurement above. If this ever goes red because the platform
    // gained a correct decoder, the table can be simplified — but never on the
    // assumption that it has.
    const viaDecoder = new TextDecoder('windows-1252');
    const decoded = viaDecoder.decode(new Uint8Array([0x80, 0x92]));
    assert.equal(viaDecoder.encoding, 'windows-1252', 'the label is accepted, which is what made this trap quiet');
    assert.equal(
      decoded,
      String.fromCharCode(0x80) + String.fromCharCode(0x92),
      'measured: this platform decodes windows-1252 as ISO-8859-1 — hence the written-out table',
    );
    // And the module's own table does the right thing where the decoder does not.
    assert.equal(
      isEncodingTwin('a' + String.fromCharCode(0xc3, 0xa9) + 'b', 'a' + E_ACUTE + 'b'),
      true,
    );
  });

  test('double mangling — a name that crossed two broken boundaries', () => {
    const clean = 'caf' + E_ACUTE;
    const once = Buffer.from(clean, 'utf8').toString('latin1');
    const twice = Buffer.from(once, 'utf8').toString('latin1');
    assert.equal(isEncodingTwin(twice, clean), true);
  });

  test('NFC and NFD spellings of one name are twins, in BOTH directions', () => {
    const nfc = 'caf' + E_ACUTE;
    const nfd = 'cafe' + COMBINING_ACUTE;
    assert.notEqual(nfc, nfd, 'the fixture must be two different strings');
    assert.equal(isEncodingTwin(nfd, nfc), true,
      'two directories, one name to a reader — the same hazard the guard exists for');
    // BOTH DIRECTIONS, and this is the half that carries the weight. The
    // comparator normalises the candidate on its way through
    // `encodingVariants`, so the first assertion passes even when the TARGET is
    // left un-normalised — a mutation run proved it, by removing that
    // normalisation and watching this test stay green. `findEncodingTwins`
    // calls `isEncodingTwin(siblingOnDisk, target)`, and either side can be the
    // NFD one: only asserting the pair separates the two questions.
    assert.equal(isEncodingTwin(nfc, nfd), true,
      'the target may be the decomposed spelling just as easily as the sibling');
  });

  test('NFD spelling on the TARGET side is still a twin', () => {
    // ROUND-2 ASYMMETRY, in its concrete form. `a` is the latin1 mangling of the
    // DECOMPOSED spelling; `b` is the composed one. Un-mangling `a` reaches the
    // decomposed form, which normalises to `b` — but expanding `b` never
    // produces the decomposed spelling to mangle, so the pair answered `true`
    // one way round and `false` the other. `findEncodingTwins` only ever asks
    // one way round, so that was a MISSED twin, not a curiosity.
    const composed = 'caf' + E_ACUTE;
    const decomposed = 'cafe' + COMBINING_ACUTE;
    const mangledDecomposed = Buffer.from(decomposed, 'utf8').toString('latin1');
    assert.equal(isEncodingTwin(mangledDecomposed, composed), true, 'the direction that always worked');
    assert.equal(isEncodingTwin(composed, mangledDecomposed), true, 'and the one that did not');
  });

  test('a difference of CASE alone is NOT a twin', () => {
    // Deliberate. On Windows the pair cannot exist; on POSIX `Notes` and `notes`
    // are two legitimate directories, and flagging them would make the guard
    // refuse correct trees. The defect never changes a letter's case.
    assert.equal(isEncodingTwin('Notes', 'notes'), false);
    assert.equal(isEncodingTwin('LA M' + String.fromCharCode(0xc9) + 'THODE', 'la m' + E_ACUTE + 'thode'), false);
  });

  test('no false positive on ordinary names', () => {
    assert.equal(isEncodingTwin('vault', 'vault'), false, 'a name is not its own duplicate');
    assert.equal(isEncodingTwin('notes', 'vault'), false);
    assert.equal(isEncodingTwin('La methode LICARES', 'La methode LICARE'), false);
    assert.equal(isEncodingTwin('caf' + E_ACUTE, 'th' + E_ACUTE), false,
      'two DIFFERENT accented names must not be mistaken for each other');
    assert.equal(isEncodingTwin('', 'vault'), false);
    assert.equal(isEncodingTwin(null, 'vault'), false);
    assert.equal(isEncodingTwin('vault', undefined), false);
  });
});

describe('findEncodingTwins — the end-of-provisioning scan', () => {
  test('a clean provisioning has no twin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-clean-'));
    try {
      const target = path.join(root, 'La m' + E_ACUTE + 'thode');
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.join(root, 'an unrelated vault'), { recursive: true });
      assert.deepEqual(findEncodingTwins(target), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a mis-encoded SIBLING is found and named', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-sibling-'));
    try {
      const target = path.join(root, 'La m' + E_ACUTE + 'thode');
      const twin = path.join(root, 'La m' + E_ACUTE_MANGLED + 'thode');
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(twin, { recursive: true });
      assert.deepEqual(findEncodingTwins(target), [twin]);
      assert.equal(describeEncodingTwins(target)[0].level, 'self');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a mis-encoded ANCESTOR is found, two levels up', () => {
    // `C:\VAULTS\Café\notes`: the mangling lands next to `Café`, not next to
    // `notes`. A guard that only looked at the target's siblings would call
    // this run clean — which is why the walk exists.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-ancestor-'));
    try {
      const parent = path.join(root, 'Caf' + E_ACUTE);
      const target = path.join(parent, 'notes');
      fs.mkdirSync(target, { recursive: true });
      const twinParent = path.join(root, 'Caf' + E_ACUTE_MANGLED);
      fs.mkdirSync(path.join(twinParent, 'notes'), { recursive: true });

      assert.deepEqual(findEncodingTwins(target), [twinParent]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a parent that does not exist yet is COMPLETE, not blind', () => {
    // Renamed from "an unreadable parent…", which is what round 2 caught it
    // claiming: the fixture was a nonexistent path, and absence is not a
    // permissions failure. ENOENT means there is genuinely nothing to list, so
    // the scan is complete and its emptiness is a fact.
    const missing = path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'deep', 'vault');
    const scan = scanEncodingTwins(missing);
    assert.deepEqual(scan.twins, []);
    assert.equal(scan.complete, true, 'ENOENT is an answer, not a blind spot');
  });

  test('a genuinely UNREADABLE parent marks the scan incomplete', (t) => {
    // The distinction the guard hangs on: a scan that could not look is not a
    // scan that found nothing. Requires being able to make a directory
    // unreadable, which a Windows administrator context cannot demonstrate.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-unreadable-'));
    try {
      const parent = path.join(root, 'locked');
      const target = path.join(parent, 'vault');
      fs.mkdirSync(target, { recursive: true });
      try {
        fs.chmodSync(parent, 0o000);
        if (fs.readdirSync(parent).length >= 0) {
          return t.skip('this process can read a 000 directory (root, or Windows ACLs)');
        }
      } catch {
        // Good: it really is unreadable now.
      }
      const scan = scanEncodingTwins(target);
      assert.equal(scan.complete, false, 'an EACCES parent must be reported as a blind spot');
    } finally {
      try { fs.chmodSync(path.join(root, 'locked'), 0o700); } catch { /* best effort */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CLASS SWEEP — no production code may call fs.cpSync', () => {
  // The defect was not "setup-vault.mjs used the wrong API once". It was "this
  // repository copies trees with fs.cpSync", which was true in six places
  // across two files, one of them writing under the user's HOME. A per-site fix
  // reads as closed while the seventh site is being written. So the rule is
  // enforced on the SOURCE, not on the behaviour of the sites that exist today.
  const SCANNED_DIRS = ['src', 'scripts', 'hooks', 'bin'];

  /** Every JavaScript file under the scanned directories. */
  function productionFiles() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // NOT SILENT. A directory that cannot be read is a hole in the scan,
        // and a scan with a hole reads as coverage. Round-1 review: the
        // population floor below does not close it, because the remaining
        // files can stay above the floor while a whole subtree disappears.
        throw new Error(`the class sweep could not read ${dir}: ${err.message}`);
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          walk(abs);
        } else if (/\.(mjs|cjs|js)$/.test(e.name)) {
          out.push(abs);
        }
      }
    };
    for (const dir of SCANNED_DIRS) walk(path.join(REPO_ROOT, dir));
    return out;
  }

  /**
   * The detector, defined ONCE and used by both the scan and its witness.
   *
   * Round-1 review took the first version apart, and every shape below is one
   * it named. It missed `import { cpSync as copy }` followed by `copy(...)`; it
   * missed `fs['cpSync'](...)`; it missed a call split across two lines; and it
   * reported a violation for `/* fs.cpSync(src, dst) *​/` in a comment, so a
   * future explanation of the defect would have failed the guard that exists
   * because of it. Comments are stripped first, then the whole file is matched
   * as one string.
   *
   * It is a lexical scan, not a parser: it can still be defeated by someone
   * determined to (a computed property name, a string eval). It is a guard
   * against forgetting, not against sabotage.
   */
  function findForbiddenCopies(source) {
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      // `//` starts a comment UNLESS it is the `://` of a URL. The first version
      // excluded any `//` preceded by a colon, which also skipped
      // `case 1:// note` and left that comment to be scanned as code (round 2).
      .replace(/(?<!:)\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    const hits = [];
    const record = (index, what) => {
      hits.push({ line: stripped.slice(0, index).split('\n').length, what });
    };
    // `fs.cpSync(`, `fsSync . cpSync (`, across newlines.
    for (const m of stripped.matchAll(/\.\s*cpSync\s*\(/g)) record(m.index, 'fs.cpSync(');
    // `fs['cpSync'](` / `fs["cpSync"](`
    for (const m of stripped.matchAll(/\[\s*['"]cpSync['"]\s*\]\s*\(/g)) record(m.index, "fs['cpSync'](");
    // A named import of cpSync, under any local alias — the alias itself is
    // then a forbidden call, so importing it at all is what gets reported.
    // `cpSync: copy` is the CommonJS destructuring spelling of the same thing,
    // which the first version missed once `.cjs` files entered the scan.
    for (const m of stripped.matchAll(/\bcpSync\b\s*(?:(?:as|:)\s+?\w+)?\s*[,}]/g)) record(m.index, 'import { cpSync }');
    // The async twin. Banning it is BROADER than the measurement (fs.promises.cp
    // carried accented paths correctly), and deliberately so: it is not used
    // anywhere here, so the ban costs nothing, and it means the rule does not
    // depend on that measurement continuing to hold in a future Node.
    for (const m of stripped.matchAll(/\b(?:fsp|fsPromises|promises)\s*\.\s*cp\s*\(/g)) record(m.index, 'fsPromises.cp(');
    return hits;
  }

  // THERE IS NO EXEMPTION. There was one — the helper itself, on the grounds
  // that its doc-block has to name the function it replaces. Round 2 pointed
  // out that comments are stripped before the scan runs, so the exemption
  // bought nothing and cost the one thing it could: an executable `fs.cpSync`
  // inside the very function written to replace it would have passed. The
  // helper is scanned like everything else, and its explanations survive
  // because they are comments.
  const EXEMPT = new Set();

  test('the scan sees a real population of files', () => {
    // A scan that walks the wrong directory passes silently. Pin the floor.
    assert.ok(productionFiles().length > 50, 'the source scan must actually find the source');
  });

  test('no call to fs.cpSync / fsPromises.cp survives outside the helper', () => {
    const offenders = [];
    for (const file of productionFiles()) {
      if (EXEMPT.has(file)) continue;
      for (const hit of findForbiddenCopies(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${hit.line}: ${hit.what}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use copyTreeSync() from src/helpers/copy-tree.mjs — fs.cpSync corrupts non-ASCII ' +
      'destinations and crashes the process on non-ASCII sources:\n' + offenders.join('\n'),
    );
  });

  test('the scan sees every evasion round 1 found, and no comment', () => {
    // A guard that reports coverage without being able to fail is worse than no
    // guard — and the FIRST version of this witness re-implemented the detector
    // rather than calling it, so it proved a copy of the regex, not the scan.
    // It now drives `findForbiddenCopies`, the same function the scan uses.
    const caught = [
      'fs.cpSync(a, b, { recursive: true });',
      'fs .  cpSync ( a, b );',
      'fs.cpSync\n(a, b, { recursive: true });',
      "fs['cpSync'](a, b, { recursive: true });",
      'fs["cpSync"](a, b);',
      "import { cpSync } from 'node:fs';",
      "import { cpSync as copy } from 'node:fs';",
      'await fsp.cp(a, b, { recursive: true });',
      'await fsPromises.cp(a, b);',
    ];
    for (const source of caught) {
      assert.ok(
        findForbiddenCopies(source).length > 0,
        `the detector must catch: ${JSON.stringify(source)}`,
      );
    }

    const ignored = [
      '// never use fs.cpSync(src, dst) here',
      '/* Example of the defect: fs.cpSync(src, dst, {recursive:true}); */',
      ' * `fs.cpSync` decodes its destination through the ANSI code page',
      'copyTreeSync(src, dst);',
      'const cpSyncIsForbidden = true;',
      'https://example.invalid/fs.cpSync-explained',
    ];
    for (const source of ignored) {
      assert.deepEqual(
        findForbiddenCopies(source),
        [],
        `the detector must NOT flag: ${JSON.stringify(source)}`,
      );
    }
  });

  test('NOTHING is exempt — the replacement helper is scanned like everything else', () => {
    // The helper used to be exempt, on the grounds that its doc-block has to
    // name the function it replaces. Round 2: comments are stripped before the
    // scan, so the exemption bought nothing and cost the one thing it could —
    // an executable `fs.cpSync` inside the very function written to replace it
    // would have passed. Pin the absence of exemptions, and prove the helper is
    // in the scanned population with its explanations intact.
    assert.equal(EXEMPT.size, 0, 'an exemption is a hole; there must be none');
    const helper = path.join(REPO_ROOT, 'src', 'helpers', 'copy-tree.mjs');
    assert.ok(productionFiles().includes(helper), 'the helper must be scanned');
    const source = fs.readFileSync(helper, 'utf8');
    assert.match(source, /fs\.cpSync/, 'its doc-block does name the function, in comments');
    assert.deepEqual(findForbiddenCopies(source), [], 'and none of those mentions is a call');
  });
});

// ---------------------------------------------------------------------------
// Round-1 review findings. Every case below went red before it was repaired.
// ---------------------------------------------------------------------------

/** Can this process create a symlink at all? Windows needs a privilege for it. */
function symlinksAvailable(root) {
  const probe = path.join(root, 'symlink-probe');
  try {
    fs.writeFileSync(path.join(root, 'probe-target.txt'), 'x');
    fs.symlinkSync(path.join(root, 'probe-target.txt'), probe, 'file');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

describe('copyTreeSync — the destructive and silent cases round 1 found', () => {
  test('force:false NEVER deletes an existing destination — not even for a link source', (t) => {
    // The first version removed the destination before consulting `force`, so
    // pointing it at a symlink source with `force:false` deleted a directory
    // full of the operator's files. A copy told not to overwrite must not be
    // able to destroy.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-force-false-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const realDir = path.join(root, 'real');
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, 'from-source.txt'), 'source');

      const link = path.join(root, 'link-to-real');
      fs.symlinkSync(realDir, link, 'junction');

      const dst = path.join(root, 'destination');
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(dst, 'PRECIOUS.txt'), 'the operator own file');

      copyTreeSync(link, dst, { force: false });
      assert.equal(
        fs.readFileSync(path.join(dst, 'PRECIOUS.txt'), 'utf8'),
        'the operator own file',
        'force:false must leave the destination existing content alone',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlinked directory is FOLLOWED, and the filter still applies inside it', (t) => {
    // A recreated RELATIVE link resolves somewhere else once it sits in the new
    // tree, and the old "cannot create links" fallback dropped the filter —
    // which is exactly what keeps a credential file out of a cloned plugin.
    // Following the link removes both problems at once.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-symlink-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const real = path.join(root, 'real-plugin');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'main.js'), '// code');
      fs.writeFileSync(path.join(real, 'data.json'), '{"apiKey":"SECRET"}');

      const link = path.join(root, 'linked-plugin');
      fs.symlinkSync(real, link, 'junction');

      const dst = path.join(root, 'cloned');
      copyTreeSync(link, dst, { filter: (from) => path.basename(from) !== 'data.json' });

      assert.equal(fs.readFileSync(path.join(dst, 'main.js'), 'utf8'), '// code',
        'the linked directory contents must arrive');
      assert.ok(!fs.existsSync(path.join(dst, 'data.json')),
        'the filter must reach inside a directory entered through a link');
      assert.ok(!fs.lstatSync(dst).isSymbolicLink(),
        'the destination must be a real directory, not a link back into the source');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a dangling link is an ERROR, not a silent omission', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-dangling-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const src = path.join(root, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'ok.txt'), 'fine');
      fs.symlinkSync(path.join(root, 'nowhere.txt'), path.join(src, 'broken'), 'file');

      assert.throws(
        () => copyTreeSync(src, path.join(root, 'out')),
        (err) => err.code === 'ENOENT',
        'the old code returned silently here, so the operator learned nothing',
      );
      // ...unless the caller has said it expects them.
      const lenient = path.join(root, 'out-lenient');
      copyTreeSync(src, lenient, { allowDanglingLinks: true });
      assert.equal(fs.readFileSync(path.join(lenient, 'ok.txt'), 'utf8'), 'fine');
      assert.ok(!fs.existsSync(path.join(lenient, 'broken')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a destination INSIDE the source is refused, not copied for ever', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-self-'));
    try {
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(src, 'inner', 'a.txt'), 'x');

      assert.throws(() => copyTreeSync(src, path.join(src, 'copy-of-itself')),
        (err) => err.code === 'ERR_FS_CP_EINVAL');
      assert.throws(() => copyTreeSync(src, src),
        (err) => err.code === 'ERR_FS_CP_EINVAL');
      // A sibling that merely SHARES A PREFIX is not inside it.
      assert.doesNotThrow(() => copyTreeSync(src, path.join(root, 'src-backup')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a link cycle terminates instead of walking for ever', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-cycle-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(src, 'inner', 'a.txt'), 'x');
      fs.symlinkSync(src, path.join(src, 'inner', 'loop'), 'junction');

      copyTreeSync(src, path.join(root, 'out'));
      assert.equal(fs.readFileSync(path.join(root, 'out', 'inner', 'a.txt'), 'utf8'), 'x');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a destination symlink cannot redirect a write outside the destination tree', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-escape-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'victim.txt'), 'untouched');

      const src = path.join(root, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'victim.txt'), 'payload');

      const dst = path.join(root, 'dst');
      fs.mkdirSync(dst, { recursive: true });
      fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(dst, 'victim.txt'), 'file');

      copyTreeSync(src, dst);
      assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'untouched',
        'a pre-existing destination link must not carry the write out of the tree');
      assert.equal(fs.readFileSync(path.join(dst, 'victim.txt'), 'utf8'), 'payload');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Round 2 — defects the round-1 REPAIRS introduced
  // -------------------------------------------------------------------------

  test('a descendant whose name merely BEGINS with two dots is still inside', () => {
    // `path.relative('/tmp/src', '/tmp/src/..cache')` is `..cache`, and the
    // containment check asked `startsWith('..')` — so an ordinary directory
    // name classified as OUTSIDE the source, the self-copy refusal did not
    // fire, and the walk fed on its own output until the depth limit stopped
    // it. The segment has to be exactly `..`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-dotdot-'));
    try {
      const src = path.join(root, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'a.txt'), 'x');
      assert.throws(() => copyTreeSync(src, path.join(src, '..cache')),
        (err) => err.code === 'ERR_FS_CP_EINVAL');
      // ...while a genuine sibling reached via `..` is still outside.
      assert.doesNotThrow(() => copyTreeSync(src, path.join(src, '..', 'elsewhere')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('force:false does not delete a DANGLING destination link', (t) => {
    // `fs.existsSync` follows the link, so a dangling one "does not exist" —
    // execution fell through to the symlink clearing and removed it. A removal
    // on the one setting that promises none.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-dangling-dst-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const src = path.join(root, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'a.txt'), 'new content');

      const dst = path.join(root, 'dst');
      fs.mkdirSync(dst, { recursive: true });
      fs.symlinkSync(path.join(root, 'nowhere.txt'), path.join(dst, 'a.txt'), 'file');

      copyTreeSync(src, dst, { force: false });
      assert.ok(fs.lstatSync(path.join(dst, 'a.txt')).isSymbolicLink(),
        'force:false must leave the existing entry — link or not — exactly where it was');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('force:false neither deletes NOR TRAVERSES a destination directory link', (t) => {
    // Skipping the removal was not enough: `mkdirSync` and the recursion then
    // went straight through the link and created every missing child inside the
    // external directory it named. "Do not overwrite" has to mean "do not write
    // here at all", not "write somewhere else instead".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-nf-dirlink-'));
    try {
      if (!symlinksAvailable(root)) return t.skip('this process cannot create symlinks');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside, { recursive: true });

      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'sub', 'leak.txt'), 'must not escape');

      const dst = path.join(root, 'dst');
      fs.mkdirSync(dst, { recursive: true });
      fs.symlinkSync(outside, path.join(dst, 'sub'), 'junction');

      copyTreeSync(src, dst, { force: false });
      assert.deepEqual(fs.readdirSync(outside), [],
        'nothing may be written through a destination link under force:false');
      assert.ok(fs.lstatSync(path.join(dst, 'sub')).isSymbolicLink(), 'and the link itself must survive');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an excessively deep tree fails with a message instead of blowing the stack', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-deep-'));
    try {
      let deep = path.join(root, 'src');
      for (let i = 0; i < 70; i++) deep = path.join(deep, 'd');
      fs.mkdirSync(deep, { recursive: true });
      assert.throws(() => copyTreeSync(path.join(root, 'src'), path.join(root, 'out')),
        /deeper than \d+ levels/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findEncodingTwins — what is NOT a twin', () => {
  test('a FILE bearing the mangled name is not a twin directory', () => {
    // The first version would have aborted a perfectly healthy provisioning
    // because a stray note next door happened to carry the mangled name.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-file-'));
    try {
      const target = path.join(root, 'La m' + E_ACUTE + 'thode');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(root, 'La m' + E_ACUTE_MANGLED + 'thode'), 'a note, not a vault');
      assert.deepEqual(findEncodingTwins(target), []);
      assert.deepEqual(describeEncodingTwins(target), [], "a file is not a twin directory");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifyProvisioningTwins separates what this run made from what was there', () => {
    // The guard's actual decision, as a pure function — the E2E cannot stage a
    // twin appearing DURING a run without reintroducing the defect, so this is
    // where the failure branch is proved.
    const now = [
      { path: '/v/cafeX', level: 'self', of: '/v/cafe' },
      { path: '/v/olderX', level: 'ancestor', of: '/v' },
    ];
    const split = classifyProvisioningTwins(['/v/olderX'], now);
    assert.deepEqual(split.created.map((t) => t.path), ['/v/cafeX'],
      'only what appeared since the pre-copy scan is this run\'s doing');
    assert.deepEqual(split.preExisting.map((t) => t.path), ['/v/olderX']);

    // Nothing before, nothing now — the ordinary healthy run.
    assert.deepEqual(classifyProvisioningTwins([], []), { created: [], preExisting: [] });
    // Everything pre-existed: a healthy run beside directories the user owns.
    assert.deepEqual(classifyProvisioningTwins(['/v/cafeX', '/v/olderX'], now).created, []);
    // Defensive: absent arguments must not throw inside a provisioning tail.
    assert.deepEqual(classifyProvisioningTwins(undefined, undefined), { created: [], preExisting: [] });
  });

  test('an incomplete before-scan makes provenance UNKNOWN, never blame', () => {
    // ROUND 2: "not in the before-list" only means "this run made it" if the
    // before-list could see everywhere. If a parent was unreadable when the
    // inventory was taken, a twin showing up later may simply have been
    // invisible — and blaming the run for it aborts a healthy provisioning,
    // which is the round-1 defect wearing a permissions error as a disguise.
    const now = [{ path: '/v/cafeX', level: 'self', of: '/v/cafe' }];

    const blind = classifyProvisioningTwins([], now, { beforeComplete: false });
    assert.deepEqual(blind.created, [], 'an unknown-provenance twin must never be blamed on this run');
    assert.equal(blind.preExisting.length, 1);
    assert.equal(blind.preExisting[0].provenance, 'unknown',
      'and it must be reported as unknown, not silently filed as pre-existing');

    // With a complete scan the same input IS this run's doing.
    assert.deepEqual(
      classifyProvisioningTwins([], now, { beforeComplete: true }).created.map((t) => t.path),
      ['/v/cafeX'],
      'the two cases must not collapse into one — otherwise the flag does nothing',
    );
  });

  test('describeEncodingTwins says whether the twin is the vault or a parent', () => {
    // The remedies differ — merging a parallel PARENT into one vault would pull
    // in other vaults' files — so the guard has to be able to tell them apart.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-level-'));
    try {
      const parent = path.join(root, 'Caf' + E_ACUTE);
      const target = path.join(parent, 'notes');
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.join(root, 'Caf' + E_ACUTE_MANGLED), { recursive: true });

      const described = describeEncodingTwins(target);
      assert.equal(described.length, 1);
      assert.equal(described[0].level, 'ancestor');
      assert.equal(described[0].of, parent,
        'the twin must name what it is a twin OF, so the message points at the right level');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
