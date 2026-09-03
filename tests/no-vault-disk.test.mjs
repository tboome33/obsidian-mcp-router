/**
 * THE MEASUREMENT, not the reading — the HTTP-only claim, held by the operating
 * system instead of by a regular expression.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The HTTP-only workstream rests on one claim: **with the API key in the config,
 * no tool needs the vault's disk.** Lot 0 measured it once, by hand, running the
 * whole tool surface under `node --permission` with the vault's directory denied
 * — a refusal pronounced by Node's C++ binding layer, BELOW JavaScript, and
 * therefore blind to how an import was spelled. Then the rig was thrown away. It
 * survived only as prose in the CHANGELOG and the ROADMAP, which is to say it
 * stopped protecting anything the day it was written.
 *
 * Meanwhile the same claim was defended in `tests/ingest-state.test.mjs` by
 * reading source text, and three successive reviews walked through three
 * successive versions of that test — `import * as ns`, then an indirect
 * specifier, then a bare side-effect import. Each repair named a form and missed
 * the next. That is not a regex problem; **a regex over source text cannot
 * answer a question about a module graph.** This file answers it by running the
 * program with the disk taken away.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT COVER, said plainly (lot 0 measured every one of these)
 * ---------------------------------------------------------------------------
 *  - `--permission` gates neither CHILD PROCESSES nor NATIVE ADDONS. The twelve
 *    conversion tools spawn binaries; they sit on a different axis (local
 *    machine, not vault disk) and are deliberately out of scope. Allowing
 *    `--allow-child-process` to include them would hand the child the very disk
 *    access this measures.
 *  - It is a LOCK, NOT A JOURNAL. "No denial" means "no denial that reached us":
 *    a handler that catches `ERR_ACCESS_DENIED` and degrades silently looks
 *    identical to one that never touched a disk. Every case therefore carries an
 *    ORACLE — the result must contain what the stub actually holds — and the
 *    writes are checked against what the stub RECEIVED, which no handler can
 *    fake from inside.
 *  - It is a CURATED SET, not all fifty tools — and that set can no longer drift
 *    silently: the last describe here requires every handler to be exercised,
 *    exempt with a written reason, or declared REST-only.
 *  - It does NOT replace the import-boundary test in `ingest-state.test.mjs`.
 *    An UNUSED import performs no denied access, so it would sail through this
 *    bench while still breaking the module boundary. The two measure different
 *    properties and both are kept.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE FALSE POSITIVES LOT 0 PAID FOR, avoided here by construction
 * ---------------------------------------------------------------------------
 *  1. `--allow-fs-read` does NOT take a comma list on Node 23 — repeat the flag,
 *     and use a `\*` suffix for recursion.
 *  2. Denying child processes made converters look disk-dependent. Not measured.
 *  3. A vault inside `os.tmpdir()` cannot be denied if tmpdir is allowed. Here
 *     NOTHING under tmpdir is allowed: the config file lives in its own
 *     directory, allowed by exact path, and the vault directory is never named.
 *  4. Invalid tool arguments failed before the code under test. Every case in
 *     the harness is a real call with real arguments against a live stub.
 *  5. A stub that wrapped `.json` in the markdown envelope broke four tools.
 *     This stub honours `Accept` and serves raw bytes otherwise.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HARNESS = path.join(HERE, 'fixtures', 'no-vault-disk-harness.mjs');

/**
 * Which spelling of the permission flag THIS runtime accepts.
 *
 * Node renamed `--experimental-permission` to `--permission` in v20.19.0,
 * v22.13.0 and v23.5.0. The CI matrix used to pin node 20.18.1 — one patch
 * below the rename — so every run on that leg died with `bad option:
 * --permission` before reaching a single assertion, and the 18 subtests of the
 * four suites below (6 + 4 + 5 + 3, counted) were reported as "did not finish
 * before its parent and was cancelled": a stack of failures that named neither
 * the flag nor the version.
 *
 * That is why `engines.node` is now `>=20.19.0` and the low matrix leg is
 * pinned to exactly that: the floor exists so this bench RUNS, and a floor
 * nothing runs at is a claim rather than a guarantee. The probe and the skip
 * below are therefore expected to be dead code on any supported runtime — they
 * stay because the alternative to a loud skip is a silent one.
 *
 * The flag is PROBED rather than derived from process.version. A version
 * comparison encodes today's release notes and goes stale; asking the binary
 * what it accepts cannot. If neither spelling works the suite SKIPS LOUDLY —
 * this file's whole value is that the OS pronounces the refusal, and a green
 * tick without the permission model would be a lie about a security property.
 */
const PERMISSION_FLAG = (() => {
  for (const flag of ['--permission', '--experimental-permission']) {
    const probe = spawnSync(process.execPath, [flag, `--allow-fs-read=${path.join(REPO, '*')}`, '-e', '0'],
      { encoding: 'utf8' });
    if (probe.status === 0) return flag;
  }
  return null;
})();

const NO_PERMISSION_MODEL = PERMISSION_FLAG
  ? false
  : `this runtime (${process.version}) accepts neither --permission nor `
    + '--experimental-permission, so the OS-level denial this file measures cannot be armed';


// A key the leak scanner will not mistake for a real one: CONSTRUCTED, and
// short of the 32-hex shape the plugin actually uses.
const FAKE_KEY = ['deadbeef', 'cafe', 'f00d'].join('-');

let vaultDir;      // on disk, and DENIED to the child
let confDir;       // holds config.json, allowed to the child by exact path
let confPath;
let server;
let port;
// A SECOND stub, on its own port, reachable ONLY by the config-key profile.
//
// The writes' oracle has to name its author. With one shared stub and one
// shared array, "the expected PUT arrived" proves a write happened — not that
// THIS child made it. Today the other profiles cannot reach the stub because
// their baseUrl is `https://` and it speaks plain HTTP; leaning on that
// accident as isolation would rebuild the confound that made the negative
// control false in the first place (review, 2026-08-31). A dedicated port is
// isolation by construction.
let writeServer;
let writePort;
// Holds a port and destroys every connection — the oracle calibration's peer.
let deadServer;
/** Every PUT/POST the DEDICATED stub received, with its body. */
const writesSeen = [];

/** The vault's markdown, served by the stub. Keys are vault-relative paths. */
const FILES = {
  'wiki/alpha.md': '---\ntype: reference\n---\n\n# Alpha\n\nsome prose about alpha\n',
  'wiki/deep/cible.md': '# Cible\n\nplus loin\n',
};
/** Directory listings, in the Local REST API shape (folders end with `/`). */
const DIRS = {
  '': ['wiki/'],
  'wiki/': ['alpha.md', 'deep/'],
  'wiki/deep/': ['cible.md'],
};

before(async () => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvd-vault-'));
  confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvd-conf-'));

  // A REAL data.json on disk, with a REAL-shaped key. If the child could read
  // it, the vault would resolve as a local vault and the whole premise would be
  // untested — which is exactly what the control assertion checks.
  const pluginDir = path.join(vaultDir, '.obsidian', 'plugins', 'obsidian-local-rest-api');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'data.json'),
    JSON.stringify({ apiKey: FAKE_KEY, port: 27126, insecurePort: 27136, enableInsecureServer: true }),
  );
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(vaultDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  const makeHandler = (sink) => (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/') return send(200, { status: 'OK', service: 'stub', versions: {} });
    if (url.pathname.startsWith('/search/simple')) {
      return send(200, [{ filename: 'wiki/alpha.md', score: 1, matches: [] }]);
    }
    if (url.pathname.startsWith('/vault/') || url.pathname === '/vault/') {
      const raw = decodeURIComponent(url.pathname.slice('/vault/'.length));
      if (raw === '' || raw.endsWith('/')) {
        const listing = DIRS[raw];
        if (!listing) return send(404, { message: 'Not Found', errorCode: 40400 });
        return send(200, { files: listing });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        // RECORDED, and this is the writes' oracle. A handler that swallowed
        // ERR_ACCESS_DENIED and returned a success-shaped object would be
        // indistinguishable from a real write by looking at its return value —
        // but it cannot fake a request that never arrived here (review,
        // 2026-08-31). Nothing is written to disk: a stub that wrote would be
        // measuring itself.
        let body = '';
        req.on('data', (d) => { body += d; });
        return req.on('end', () => {
          // Only the DEDICATED stub records; the shared one has no sink. That is
          // what lets an assertion name the child that produced a write.
          if (sink) sink.push({ method: req.method, path: raw, body });
          res.writeHead(204);
          res.end();
        });
      }
      const content = FILES[raw];
      if (content === undefined) return send(404, { message: 'Not Found', errorCode: 40400 });
      // FALSE POSITIVE #5: only the note+json negotiation gets the envelope.
      //
      // AND THE ENVELOPE CARRIES REAL FRONTMATTER. It used to hardcode `{}`,
      // which meant `get_frontmatter` returned an empty object — a tool that
      // "worked" while answering nothing. The oracle added after the review
      // caught it on its first run, which is the point of having one: a stub
      // that lies is a bench that certifies silence.
      if ((req.headers.accept || '').includes('olrapi.note+json')) {
        const fm = {};
        const m = /^---\n([\s\S]*?)\n---/.exec(content);
        if (m) {
          for (const line of m[1].split('\n')) {
            const kv = /^(\w+):\s*(.+)$/.exec(line.trim());
            if (kv) fm[kv[1]] = kv[2];
          }
        }
        return send(200, { path: raw, content, frontmatter: fm, tags: [], stat: {} });
      }
      return send(200, content, 'text/markdown');
    }
    return send(404, { message: 'Not Found', errorCode: 40400 });
  };

  // The SHARED stub — the on-disk profiles' registry points at this port. It
  // records nothing (`sink` is null), so nothing they do can land in the
  // writes' evidence.
  server = http.createServer(makeHandler(null));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  // The DEDICATED stub — only the config-key profile is pointed here, so a
  // request recorded on it can only have come from that child.
  writeServer = http.createServer(makeHandler(writesSeen));
  await new Promise((resolve) => writeServer.listen(0, '127.0.0.1', resolve));
  writePort = writeServer.address().port;

  // THE CONFIG THAT MAKES THE POINT: `portRegistry` is EMPTY, so nothing sends
  // the router back to a vault's data.json for a key. The key is right here.
  confPath = path.join(confDir, 'config.json');
  fs.writeFileSync(confPath, JSON.stringify({
    portRegistry: {},
    remoteVaults: [{
      name: 'stubbed',
      baseUrl: `http://127.0.0.1:${writePort}`,
      apiKey: FAKE_KEY,
      insecurePort: 27136,
    }],
  }));

  // THE NEGATIVE CONTROL'S CONFIG — the SAME vault, declared the OLD way: as a
  // local vault in `portRegistry`, so the router must go to its data.json for
  // the key. Under the same denial, that read cannot happen. If both profiles
  // behaved alike, this bench would be measuring nothing.
  const onDiskConf = path.join(confDir, 'config-ondisk.json');
  fs.writeFileSync(onDiskConf, JSON.stringify({
    portRegistry: { [vaultDir]: { https: port, http: 27136 } },
    vaultNames: { [vaultDir]: 'stubbed' },
  }));

  // Kicked off ONCE each, here, while the stub is up and the loop is free —
  // and AWAITED here too. Started-but-not-awaited promises sat unobserved
  // across the first describe block; a fast rejection (spawn failure, no
  // report, malformed JSON) would have surfaced as an unhandled rejection
  // rather than as the assertion that was waiting for it, three tests later
  // (review, 2026-08-31). Settling them here costs nothing: the three children
  // run concurrently either way.
  // A port that answers NOTHING USABLE — and it stays bound on purpose.
  //
  // The first version opened an ephemeral port, read its number and closed it,
  // so the profile tested "connection refused". That has a release-and-reuse
  // race: between the close and the child's connect, any process can take the
  // port, and the calibration then measures a stranger (review, 2026-08-31).
  // Holding the port and destroying every socket removes the race. It tests
  // "no usable response" rather than "nothing listening", which is what the
  // oracle calibration actually needs.
  deadServer = http.createServer(() => {});
  deadServer.on('connection', (socket) => socket.destroy());
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const deadPort = deadServer.address().port;
  const deadConf = path.join(confDir, 'config-noserver.json');
  fs.writeFileSync(deadConf, JSON.stringify({
    portRegistry: {},
    remoteVaults: [{ name: 'stubbed', baseUrl: `http://127.0.0.1:${deadPort}`, apiKey: FAKE_KEY, insecurePort: 27136 }],
  }));

  [gated, gatedOnDisk, gatedOnDiskAllowed, gatedNoServer] = await Promise.all([
    runGated(),
    runGated(onDiskConf),
    runGated(onDiskConf, { allowVault: true }),
    runGated(deadConf),
  ]);
});

after(async () => {
  for (const s of [server, writeServer, deadServer]) {
    if (s) await new Promise((resolve) => s.close(resolve));
  }
  for (const d of [vaultDir, confDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Run the harness in a permission-gated child and parse its one JSON line.
 *
 * ASYNCHRONOUS, AND THE REASON IS A DEADLOCK. The first draft used `spawnSync`,
 * which blocks the parent's event loop — including the stub HTTP server the
 * child is trying to reach. Child waits for a response, parent cannot serve it,
 * both sit there until the timeout. Every assertion then failed on a null
 * report, which reads like "the harness is broken" rather than "you blocked
 * your own server". Worth the comment: a synchronous spawn is quietly
 * incompatible with a parent that is also the peer.
 */
function runGated(configFile = confPath, { allowVault = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      PERMISSION_FLAG,
      // FALSE POSITIVE #1: one flag per path, `*` suffix for recursion. A comma
      // list is silently invalid on Node 23 and denies everything.
      `--allow-fs-read=${path.join(REPO, '*')}`,
      `--allow-fs-read=${configFile}`,
    ];
    // The arbiter profile: the SAME on-disk config, with the vault readable.
    // It exists to prove the negative control below fails for the right reason.
    if (allowVault) args.push(`--allow-fs-read=${path.join(vaultDir, '*')}`);
    const child = spawn(process.execPath, [
      ...args,
      HARNESS,
      configFile,
      path.join(vaultDir, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        reject(new Error(`harness produced no report (exit ${code}).\nstdout: ${out}\nstderr: ${err}`));
        return;
      }
      // THE EXIT CODE IS PART OF THE ANSWER. A valid JSON line followed by a
      // non-zero exit would otherwise pass — the harness would look like it
      // completed while the process had actually died afterwards. And a
      // malformed line must become a REJECTED promise, not an exception thrown
      // inside this callback, where nothing would catch it (review, 2026-08-31).
      try {
        const report = JSON.parse(line);
        if (code !== 0) {
          reject(new Error(`harness exited ${code} despite reporting.\nstderr: ${err}`));
          return;
        }
        resolve({ report, stderr: err });
      } catch (parseErr) {
        reject(new Error(`harness report is not JSON (exit ${code}): ${parseErr.message}\nline: ${line.slice(0, 300)}`));
      }
    });
  });
}

// ONE measurement, several assertions. Spawning per test would run the whole
// gated surface five times for no extra information.
let gated;
// …and a SECOND measurement with the key on disk instead of in the config, to
// calibrate the instrument in the other direction. See the negative-control test.
let gatedOnDisk;
// …and a THIRD, identical to the second EXCEPT that the vault is readable. It
// is the arbiter: it is what turns the second from a coincidence into a control.
let gatedOnDiskAllowed;
// …and a FOURTH, against a port where nothing listens. It calibrates the
// ORACLES the way the third calibrates the denial. See the last describe.
let gatedNoServer;

describe('the vault disk is not needed once the key is in the config', { skip: NO_PERMISSION_MODEL }, () => {
  test('THE CONTROL: the vault is genuinely out of reach', async () => {
    const { report } = gated;
    assert.equal(
      report.control.denied, true,
      `the vault's data.json was READABLE (code: ${report.control.code}). Every other assertion in `
      + 'this file would then pass for the wrong reason — the permission flag is not in effect.',
    );
  });

  test('the registry loads, and the router boots, with no vault disk at all', async () => {
    const { report } = gated;
    assert.equal(report.fatal, null, `harness died: ${JSON.stringify(report.fatal)}`);
    // Lot 0's central finding: credential resolution was the ONE universal
    // coupling. With the key in config it is gone — and this is what proves it,
    // because `loadRegistry` runs before any handler.
    const listVaults = report.tools.find((t) => t.name === 'list_vaults');
    assert.equal(listVaults.ok, true, `list_vaults failed: ${listVaults.error}`);
  });

  test('NO tool is refused by the permission model', async () => {
    const { report } = gated;
    const denied = report.tools.filter((t) => t.denied);
    assert.deepEqual(
      denied.map((t) => `${t.name}: ${t.error}`), [],
      'a tool reached the vault disk — the HTTP-only claim is false for it',
    );
  });

  test('and they actually WORK — a lock is not a journal', async () => {
    const { report } = gated;
    const failed = report.tools.filter((t) => !t.ok);
    assert.deepEqual(
      failed.map((t) => `${t.name}: ${t.error}`), [],
      'no denial, but no result either — that is degradation, not independence',
    );

    // "IT RESOLVED" IS NOT "IT ANSWERED". A handler catching ERR_ACCESS_DENIED
    // and returning `{ files: [] }` resolves happily, and the denial test above
    // stays green too — both would certify a tool that silently did nothing.
    // Each case therefore carries an oracle checking the result contains what
    // the stub actually holds (review, 2026-08-31).
    const mute = report.tools.filter((t) => t.ok && !t.answered);
    assert.deepEqual(
      mute.map((t) => `${t.name}: ${t.oracleError || t.sample}`), [],
      'resolved without returning the vault content the stub holds — a swallowed denial looks exactly like this',
    );
  });

  test('the writes actually REACHED the vault, not just returned', async () => {
    await gated;
    // The one oracle a handler cannot fake from inside: the stub, in THIS
    // process, either received the request or did not.
    const paths = writesSeen.map((w) => `${w.method} ${w.path}`);
    assert.ok(
      paths.includes('PUT wiki/written.md'),
      `write_file never reached the server. Seen: ${JSON.stringify(paths)}`,
    );
    assert.ok(
      paths.some((p) => p.endsWith('wiki/alpha.md')),
      `append_to_file never reached the server. Seen: ${JSON.stringify(paths)}`,
    );
    // THE BODY, not its length. `bytes > 0` is satisfied by a handler sending
    // `"x"` to the right endpoint — it proves a request, not the right one.
    const put = writesSeen.find((w) => w.method === 'PUT' && w.path === 'wiki/written.md');
    assert.equal(put.body, '# written\n', 'the content the tool was given must be what arrived');
    const appended = writesSeen.find((w) => w.method === 'POST' && w.path === 'wiki/alpha.md');
    assert.ok(appended, `append_to_file did not POST. Seen: ${JSON.stringify(paths)}`);
    assert.match(appended.body, /plus/, 'the appended text must be what arrived');

    // EXACTLY ONE writer, on a stub only ONE profile can reach. The count is a
    // second line of defence: if the isolation ever breaks, this says so
    // instead of letting a write from the wrong child stand in for the right
    // one's.
    const puts = paths.filter((p) => p === 'PUT wiki/written.md');
    assert.equal(
      puts.length, 1,
      `expected exactly one write of that path, saw ${puts.length}: ${JSON.stringify(paths)}`,
    );
  });

  test('the REST path verification runs with no disk, and still corrects a path', async () => {
    const { report } = gated;
    // Two `build_open_link` cases: the exact path, and a bare basename that only
    // a vault WALK can resolve. The second is the one that would have been
    // `pathVerified: false` before v0.80.0.
    const links = report.tools.filter((t) => t.name === 'build_open_link');
    assert.equal(links.length, 3);
    for (const l of links) assert.equal(l.ok, true, `${l.error}`);

    // THE ONE THAT MATTERS. `alpha.md` is a bare basename: only an enumeration
    // of the vault can turn it into `wiki/alpha.md`. Before v0.80.0 that walk
    // needed a disk, so this call returned the path unchanged with
    // `pathVerified: false`. It now resolves over REST, with no disk in reach.
    const corrected = links.find((l) => l.paths.includes('wiki/alpha.md') && l.sample.includes('"corrected":true'));
    assert.ok(corrected, `a bare basename must be corrected over REST: ${links.map((l) => l.sample).join(' | ')}`);

    // The batch case reached the deep file, which lives two listings down.
    const batch = links.find((l) => l.paths.length > 1);
    assert.ok(batch, 'the batch case should report several paths');
    assert.ok(
      batch.paths.includes('wiki/deep/cible.md'),
      `the batch must have resolved the deep path: ${JSON.stringify(batch.paths)}`,
    );

    // And nothing came back unverified — which is the whole claim.
    for (const l of links) {
      assert.ok(l.verified.length > 0, `${l.name} reported no pathVerified at all: ${l.sample}`);
      assert.deepEqual(
        l.verified.filter((v) => v === false), [],
        `a path went unverified with the vault reachable over REST: ${l.sample}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

// THE NEGATIVE CONTROL — and the first version of it was FALSE.
//
// Everything above is green. That is only meaningful if the same rig, pointed at
// the arrangement lot 0 identified as coupled, comes back RED for THE RIGHT
// REASON. The old arrangement is one line of config: declare the vault under
// `portRegistry` instead of `remoteVaults`, so the router must fetch its key
// from the vault's own data.json before any handler runs.
//
// THE TRAP, found by measurement while the pre-push review was running. The
// first draft asserted "the read tools fail". They do — but not because of the
// key. `registry.mjs` builds a LOCAL vault's baseUrl as `https://127.0.0.1:<port>`,
// and this stub speaks plain HTTP, so every call dies with
// ERR_SSL_WRONG_VERSION_NUMBER whether the key was readable or not. Proven by
// running a THIRD profile — same on-disk config, vault ALLOWED — which failed
// identically. A control that stays green when the defect is removed is worse
// than no control: it certifies nothing while looking rigorous.
//
// So the control now asserts the ONE observable that isolates the coupling:
// `missingApiKey`, set by `loadRegistry` exactly when it could not read a local
// vault's data.json. And the arbiter profile is kept, permanently, because it is
// what makes the assertion a control rather than a coincidence.
describe('the same bench, calibrated the other way', { skip: NO_PERMISSION_MODEL }, () => {
  const only = (report) => {
    assert.equal(report.registry.length, 1, `expected one vault, got ${JSON.stringify(report.registry)}`);
    return report.registry[0];
  };

  test('key on DISK + disk DENIED → the router cannot get the key', async () => {
    const { report } = gatedOnDisk;
    assert.equal(report.control.denied, true, 'the denial must still be in force');
    assert.equal(report.fatal, null, `harness died: ${JSON.stringify(report.fatal)}`);
    const v = only(report);
    assert.equal(v.type, 'local', 'the point of this profile is that the vault is LOCAL');
    assert.equal(v.missingApiKey, true, 'this is the coupling: no disk, no key');
    assert.equal(v.keyPresent, false);
  });

  // THE ARBITER. Same config, same stub, same everything — except the vault is
  // readable. If this ALSO reported a missing key, the assertion above would be
  // measuring something other than the disk.
  test('key on DISK + disk ALLOWED → the key comes back', async () => {
    const { report } = gatedOnDiskAllowed;
    assert.equal(report.control.denied, false, 'this profile is the one where the vault IS readable');
    const v = only(report);
    assert.equal(v.type, 'local');
    assert.equal(v.missingApiKey, false, 'with the disk in reach the key resolves — so the denial above is what did it');
    assert.equal(v.keyPresent, true);
  });

  test('key in CONFIG + disk DENIED → no disk, and no missing key either', async () => {
    const { report } = gated;
    const v = only(report);
    assert.equal(v.type, 'remote');
    assert.equal(v.missingApiKey, false);
    assert.equal(v.keyPresent, true, 'the key came from the config, with the vault out of reach');
  });

  // THE CONTROLLED PAIR is the two LOCAL profiles: same config, same vault,
  // same everything, differing only in whether the disk is readable. That is
  // the experiment, and `keyPresent` is its readout.
  //
  // The remote profile is a positive comparator, NOT the third arm of a
  // one-variable experiment — it also changes the config section, the vault
  // type, the credential source and the URL scheme. An earlier comment here
  // said the three "differ at exactly one variable", which is true of the pair
  // and false of the trio (review, 2026-08-31).
  test('the three profiles differ where they should', async () => {
    const [a, b, c] = [gated, gatedOnDisk, gatedOnDiskAllowed];
    const shape = (r) => {
      const v = r.report.registry[0];
      return `${v.type}/${r.report.control.denied ? 'denied' : 'allowed'}/key:${v.keyPresent}`;
    };
    assert.deepEqual(
      [shape(a), shape(b), shape(c)],
      ['remote/denied/key:true', 'local/denied/key:false', 'local/allowed/key:true'],
    );
  });
});
// ---------------------------------------------------------------------------

// COVERAGE CANNOT DRIFT SILENTLY.
//
// The bench above exercises ten calls. That is not "every tool", and the first
// version of this file said so in a comment while the CHANGELOG claimed the
// bench "covers ALL disk coupling" — a contradiction a review caught, and one
// with teeth: a new handler reading vault disk would ship green, because
// nothing required it to be tested.
//
// So every entry in TOOL_HANDLERS must be either EXERCISED by the harness or
// EXEMPT with a written reason. Adding a tool without classifying it fails this
// test. The exemptions are not a way to shrink the claim quietly — each one
// names the axis it belongs to.
describe('every tool is classified: exercised by the bench, or exempt with a reason', { skip: NO_PERMISSION_MODEL }, () => {
  // The twelve conversion tools and the vault wizard spawn child processes or
  // write to the host. `--permission` does not gate child processes, so testing
  // them here would need `--allow-child-process` — which would hand the child
  // the very disk access this bench measures. Different axis, stated as such.
  const EXEMPT = {
    audio_to_markdown: 'spawns a converter binary — local-machine axis',
    bing_search_to_markdown: 'spawns a converter binary — local-machine axis',
    docx_to_markdown: 'spawns a converter binary — local-machine axis',
    git_repo_to_markdown: 'spawns a converter binary — local-machine axis',
    image_to_markdown: 'spawns a converter binary — local-machine axis',
    pdf_to_images: 'spawns a converter binary — local-machine axis',
    pdf_to_markdown: 'spawns a converter binary — local-machine axis',
    pdf_to_markdown_docling: 'spawns a converter binary — local-machine axis',
    pptx_to_markdown: 'spawns a converter binary — local-machine axis',
    webpage_to_markdown: 'spawns a converter binary — local-machine axis',
    xlsx_to_markdown: 'spawns a converter binary — local-machine axis',
    youtube_to_markdown: 'spawns a converter binary — local-machine axis',
    download_page_assets: 'writes bytes into the vault through an argument path — local-machine axis',
    plan_vault: 'drives setup-vault.mjs in a child process — writes to the HOST',
    provision_vault: 'drives setup-vault.mjs in a child process — writes to the HOST',
    find_twin_pages: "since v0.82.0 it HAS a diskless path (the bridge's GET /smart-env/sources), so it is no longer exempt for the old reason. It is exempt for a fixture reason: a derived threshold needs ~9 comparable pages and this bench's vault has two, so exercising it here would only ever measure `corpus-too-small`. Its disk-independence is proven in find-twin-pages.test.mjs, where the REST path runs to a real ranking with an `fs` that throws on every access",
    open_in_obsidian: 'drives the bridge / view-agent, not the vault REST surface',
    get_view_link: 'calls the optional external view-agent; absent without OBSIDIAN_ROUTER_VIEW_AGENT_URL',
    // Pure, argument-in/argument-out: they never see a vault at all.
    extract_page_metadata: 'pure function over supplied markdown — no vault',
    propose_linked_sources: 'pure function over supplied markdown — no vault',
    filter_relevant_blocks: 'pure function over supplied markdown — no vault',
  };

  // NOT EXERCISED HERE — and the name is deliberately that, not "REST-only".
  //
  // An earlier draft called this `UNTESTED_BUT_REST_ONLY`, which asserts a
  // property nothing in this file measures. That is the exact defect class this
  // session kept finding — a name claiming more than the evidence — committed
  // one line below a comment saying "an exemption without a reason is a coverage
  // gap with a nicer name". So: these tools are simply NOT MEASURED by this
  // bench. They may well be REST-only; this file does not know.
  //
  // What the classification buys is therefore modest and worth stating exactly:
  // a NEW tool cannot appear without someone deciding which bucket it is in.
  // It is a forcing function against silent drift, not evidence about these 21.
  const NOT_EXERCISED_HERE = new Set([
    'audit_sources', 'build_search_index', 'build_wiki_graph',
    'build_wiki_tour', 'delete_file', 'execute_template', 'find_boundary_pages',
    'get_page_neighbors', 'get_wiki_context_pack', 'lock_vault', 'merge_frontmatter',
    'move_file', 'patch_file', 'record_source', 'refresh_okf_projections',
    'search_smart', 'set_auto_enrich_mode', 'set_frontmatter', 'unlock_vaults',
    'wiki_path', 'write_bundle',
    // v0.90.0 — writes the USER'S OWN CONFIG, not a vault, so this bench (which
    // proves no tool touches vault disk) has nothing to catch here. It sits
    // beside `lock_vault` and `set_auto_enrich_mode` for the same reason: they
    // are session and configuration routing. Its own behaviour is covered by
    // tests/workspace-binding-tool.test.mjs, which drives it through injected
    // read/write/launch seams and never touches a real config or a real disk.
    'confirm_workspace_binding',
  ]);

  /** What the harness ACTUALLY ran — read from the run, never re-declared. */
  const exercised = () => new Set(gated.report.tools.map((t) => t.name));

  test('no handler is unclassified', async () => {
    const { _internals } = await import('../src/index.mjs');
    const ran = exercised();
    const unclassified = Object.keys(_internals.TOOL_HANDLERS).sort().filter(
      (n) => !ran.has(n) && !(n in EXEMPT) && !NOT_EXERCISED_HERE.has(n),
    );
    assert.deepEqual(
      unclassified, [],
      'a tool exists that is neither exercised by the bench, nor exempt with a reason, nor '
      + 'declared not-exercised. Classify it: add it to the harness CASES, to EXEMPT, or to NOT_EXERCISED_HERE.',
    );
  });

  // THE THREE BUCKETS MUST BE DISJOINT. The first draft listed the exercised
  // tools in the not-exercised set as well, which made the classification
  // self-contradictory and the first test unable to fail for the right reason.
  test('the buckets do not overlap', () => {
    const ran = exercised();
    const both = [...ran].filter((n) => NOT_EXERCISED_HERE.has(n) || n in EXEMPT);
    assert.deepEqual(both, [], 'a tool is listed as unexercised or exempt while the bench runs it');
    const exemptAndListed = Object.keys(EXEMPT).filter((n) => NOT_EXERCISED_HERE.has(n));
    assert.deepEqual(exemptAndListed, [], 'a tool is both exempt and merely not-exercised — pick one');
  });

  test('the classification names real tools, and only real tools', async () => {
    const { _internals } = await import('../src/index.mjs');
    const all = new Set(Object.keys(_internals.TOOL_HANDLERS));
    const ghosts = [...Object.keys(EXEMPT), ...NOT_EXERCISED_HERE].filter((n) => !all.has(n));
    assert.deepEqual(ghosts, [], 'the classification mentions tools that no longer exist');
  });

  test('every exemption carries a written reason', () => {
    const mute = Object.entries(EXEMPT).filter(([, why]) => !why || why.trim().length < 20);
    assert.deepEqual(mute.map(([n]) => n), [], 'an exemption without a reason is a coverage gap with a nicer name');
  });

  // WHAT THE BENCH ACTUALLY EXERCISES, pinned so the CHANGELOG cannot outrun it.
  test('the harness really did run the tools this file claims it did', async () => {
    const { report } = gated;
    const exercised = new Set(report.tools.map((t) => t.name));
    for (const expected of [
      'list_vaults', 'list_files', 'get_file', 'get_frontmatter',
      'search', 'write_file', 'append_to_file', 'build_open_link',
    ]) {
      assert.ok(exercised.has(expected), `${expected} was never run`);
    }
    assert.equal(exercised.size, 8, `the bench exercises 8 distinct handlers, not ${exercised.size}`);
  });
});

// ---------------------------------------------------------------------------

// THE ORACLES ARE CALIBRATED TOO — and one of them was a false witness.
//
// The oracles exist so that "the tool resolved" cannot pass for "the tool
// answered". But an oracle can itself be satisfiable without the vault
// answering, and then it certifies exactly what it was added to prevent. That
// is not hypothetical here: `list_vaults` was first checked by looking for the
// vault's NAME — which comes from the config file. With the stub killed, that
// oracle stayed TRUE while every other one failed. It now requires
// `online: true`, which only a real REST ping to `/` produces.
//
// So this profile points the same harness at a port where nothing listens, and
// requires EVERY oracle to fail. An oracle still satisfied here is measuring the
// config, not the vault.
describe('no oracle is satisfiable without the vault answering', { skip: NO_PERMISSION_MODEL }, () => {
  test('with nothing listening, not one tool reports an answer', () => {
    const { report } = gatedNoServer;
    assert.equal(report.fatal, null, `harness died: ${JSON.stringify(report.fatal)}`);
    // The registry still loads — the key is in the config, and that is the point
    // of the profile: only the NETWORK is missing.
    assert.equal(report.registry[0]?.keyPresent, true);

    const falseWitnesses = report.tools.filter((t) => t.answered === true);
    assert.deepEqual(
      falseWitnesses.map((t) => `${t.name}: ${t.sample}`), [],
      'an oracle passed with no server behind it — it is checking the config, not the vault',
    );
  });

  // …and the same run must still show NO permission denial. "The vault is
  // unreachable" and "the router touched the disk" are different failures, and
  // a bench that confused them would blame the wrong thing.
  test('an unreachable vault is still not a disk access', () => {
    const { report } = gatedNoServer;
    const denied = report.tools.filter((t) => t.denied);
    assert.deepEqual(denied.map((t) => t.name), []);
  });

  // The contrast, side by side: the same oracles, same harness, same key —
  // only the server differs.
  test('the live profile answers where the dead one cannot', () => {
    const answered = (r) => r.report.tools.filter((t) => t.answered).map((t) => t.name).sort();
    const live = answered(gated);
    const dead = answered(gatedNoServer);
    assert.ok(live.length >= 6, `expected the live profile to answer broadly, got ${JSON.stringify(live)}`);
    assert.deepEqual(dead, [], `the dead profile answered: ${JSON.stringify(dead)}`);
  });
});

/**
 * v0.83.0 — the bench says out loud whether it was armed.
 *
 * Node renamed `--experimental-permission` to `--permission` in v20.19.0,
 * v22.13.0 and v23.5.0. The CI matrix used to pin node 20.18.1 — one patch
 * below the rename — so on that leg the gated child died with `bad option:
 * --permission` and all 18 measurements were reported as "did not finish
 * before its parent and was cancelled". Nothing in that wall of output named
 * the flag or the version.
 *
 * (18, counted per suite: 6 + 4 + 5 + 3. The commit messages for `a862aed` and
 * `59be380` say 22 — an estimate I wrote without counting, in a file whose
 * whole subject is not asserting what you have not measured. Corrected here
 * rather than by rewriting pushed history.)
 *
 * TWO FIXES, AND THIS FILE IS THE SECOND. The first raised `engines.node` to
 * `>=20.19.0` and pinned the low matrix leg to exactly that, so the bench runs
 * everywhere the package claims to work. The second is this describe, because
 * the skip that keeps an unsupported runtime green creates a new risk and it is
 * the worse one: a security bench that skips itself looks exactly like a
 * security bench that passed. `node --test` prints `# SKIP <reason>` per suite,
 * but its summary counts a skipped suite as neither passed nor skipped — so a
 * reader watching totals sees `pass 0, fail 0` and no coverage.
 *
 * This describe therefore ALWAYS runs. It states the arming in the summary, and
 * it FAILS on a runtime that ought to have the flag — so the next rename, or a
 * floor quietly lowered back below it, is a red build rather than a silent loss
 * of the measurement.
 */
describe('the permission model is armed, and says so whether it is or not', () => {
  /** [major, minor, patch] of the running node. */
  const version = process.versions.node.split('.').map(Number);
  const atLeast = (maj, min, pat) => {
    const [a, b, c] = version;
    if (a !== maj) return a > maj;
    if (b !== min) return b > min;
    return c >= pat;
  };

  // The releases that carry the renamed flag. Stated once, here, next to the
  // probe that makes the check unnecessary in the happy path.
  const SHOULD_HAVE_FLAG = atLeast(20, 19, 0) || atLeast(22, 13, 0) || atLeast(23, 5, 0);

  test('this run reports which flag armed it, or why nothing did', () => {
    if (PERMISSION_FLAG) {
      assert.ok(['--permission', '--experimental-permission'].includes(PERMISSION_FLAG));
      return;
    }
    // Not armed. That is tolerable ONLY below the rename; above it, the probe
    // failing means the flag moved again and the bench has gone quiet.
    assert.equal(
      SHOULD_HAVE_FLAG, false,
      `node ${process.versions.node} should accept --permission (renamed in 20.19.0 / 22.13.0 / `
      + '23.5.0) but the probe was refused — the OS-level bench is no longer running. '
      + 'Do not silence this: find the flag it wants.',
    );
    // Below the rename the measurement is genuinely unavailable. Say it in the
    // one place a reader of totals will see.
    console.error(
      `\n  [no-vault-disk] NOT MEASURED on node ${process.versions.node}: the permission model `
      + 'needs >= 20.19.0. The four OS-level suites in this file were SKIPPED, not passed.\n',
    );
  });

  test('the probe asks the binary rather than trusting a version table', () => {
    // A version comparison encodes today's release notes. The probe is the
    // authority; SHOULD_HAVE_FLAG only exists to catch the probe going quiet.
    // On a runtime that has the flag, both must agree.
    if (SHOULD_HAVE_FLAG) {
      assert.ok(PERMISSION_FLAG, 'version says yes, probe says no — see the test above');
    }
    // And the comparator itself is not vacuous.
    assert.equal(atLeast(20, 19, 0) && version[0] === 20 && version[1] === 18, false);
  });

  /**
   * GUARD: the published floor and the floor CI runs are the same number.
   *
   * This is the drift that produced the whole incident. `engines.node` said
   * `>=20.18.1`, the matrix's low leg said `'20.18.1'`, and both were one patch
   * below the flag this file needs — so the leg ran, skipped its four OS-level
   * suites, and reported green for weeks. Nothing compared the two facts,
   * because they AGREED with each other; they just both disagreed with what the
   * bench required.
   *
   * So the guard is not "engines equals the matrix" alone. It is three claims at
   * once: the two agree, they are at or above the rename, and the matrix really
   * pins an exact version rather than a floating major (`'20'` would resolve to
   * whatever is newest and silently stop testing the floor).
   */
  test('GUARD: engines.node, the CI matrix low leg, and the flag rename agree', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'test.yml'), 'utf8');

    const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
    assert.ok(floor, `engines.node must be a plain >=x.y.z floor, got ${pkg.engines.node}`);

    const nodeLine = /^\s*node:\s*\[(.+)\]\s*$/m.exec(workflow);
    assert.ok(nodeLine, 'could not find the matrix `node:` list in .github/workflows/test.yml');
    const legs = nodeLine[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.ok(legs.length >= 2, `expected at least two matrix legs, got ${JSON.stringify(legs)}`);

    // The low leg must be the floor, spelled exactly.
    const [, maj, min, pat] = floor;
    assert.equal(legs[0], `${maj}.${min}.${pat}`,
      `the matrix's low leg (${legs[0]}) must pin engines.node (${pkg.engines.node}) exactly — `
      + 'a floor no CI leg runs at is a claim, not a guarantee');

    // And the floor must be at or above the release that renamed the flag this
    // file cannot run without.
    const n = (a, b, c) => (a * 1e6) + (b * 1e3) + c;
    assert.ok(
      n(+maj, +min, +pat) >= n(20, 19, 0),
      `engines.node is ${pkg.engines.node}, below the 20.19.0 that renamed `
      + '--experimental-permission to --permission. Lower it and this file stops measuring.',
    );
  });
});
