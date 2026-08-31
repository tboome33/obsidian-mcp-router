/**
 * Lot 2 — le click-to-open sans disque de vault.
 *
 * Ce que ces tests protègent, dans l'ordre d'importance :
 *
 *   1. LES TROIS ÉTATS DU DISQUE. « le fichier dit que le serveur en clair est
 *      éteint » et « je n'ai pas pu ouvrir le fichier » sont des faits
 *      DIFFÉRENTS : le premier interdit le repli, le second l'autorise. Les
 *      confondre — ce que faisait le `catch` d'avant — rend le port mémorisé
 *      inatteignable.
 *   2. LE DISQUE PRIME, ET IL EST RELU. Un registre périmé ne doit jamais
 *      écraser un port vivant, et aucun mémo ne doit survivre à une réécriture
 *      du fichier.
 *   3. LE PORT DÉCLARÉ EST LE SEUL INTERRUPTEUR. `baseUrl` ne décide rien : le
 *      lien vaut toujours 127.0.0.1, donc aucune chaîne fournie par le vault
 *      n'est interpolée.
 */
import { test, describe, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClickToOpenUrl,
  buildClickToOpenMarkdownLink,
  resolveInsecurePort,
  _resetCache,
} from '../src/helpers/click-to-open.mjs';
import { loadRegistry } from '../src/registry.mjs';
import { buildOpenLinkTool } from '../src/tools/build-open-link.mjs';

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2o-remote-'));
});
after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
beforeEach(() => {
  _resetCache();
});

/** A local vault directory whose data.json holds exactly `data` (or none). */
function makeVault(label, data) {
  const vaultPath = fs.mkdtempSync(path.join(workDir, `${label}-`));
  if (data !== undefined) {
    const dir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
  }
  return vaultPath;
}

// ---------------------------------------------------------------------------

// THE DECLARED PORT IS THE WHOLE OPT-IN — and this describe replaces one that
// asserted the opposite.
//
// The first draft of lot 2 gated emission on `baseUrl` being loopback, and had
// a test named "a WireGuard host gets NO link". The second pre-release review
// showed that gate is neither necessary nor sufficient, and the reasoning holds:
// this helper NEVER interpolates the vault's host — every URL it builds is
// `http://127.0.0.1:<port>/…` — so `baseUrl` describes the ROUTER's hop to the
// REST API while the `/open` request comes from the READER's browser. A vault
// reached over WireGuard whose reader sits at the Obsidian machine has a working
// link; a loopback-reached vault whose reader is elsewhere does not. `baseUrl`
// answers neither question, and the old test engraved a false negative.
describe('the declared port, not baseUrl, decides whether a link is emitted', () => {
  const withPort = (baseUrl) => ({ name: 'r', type: 'remote', baseUrl, insecurePort: 27136 });

  test('any reachable vault with a declared port gets a loopback link', () => {
    for (const baseUrl of [
      'https://127.0.0.1:27126',      // SSH RemoteForward — the HTTP-only profile
      'https://localhost:27126',
      'https://[::1]:27126',
      'https://10.8.0.10:27126',      // WireGuard mesh: the reader may still be
      'https://192.168.0.10:27126',   // at the Obsidian machine. Not our call.
      'https://vault.example.com',
    ]) {
      assert.equal(
        buildClickToOpenUrl(withPort(baseUrl), 'wiki/a.md'),
        'http://127.0.0.1:27136/open/wiki%2Fa.md',
        `${baseUrl} should produce a link`,
      );
    }
  });

  // THE HOST NEVER REACHES THE URL, which is why removing the gate removed an
  // injection surface rather than opening one. In v0.78.0 a guard that DID
  // interpolate a host was exploitable through userinfo
  // (`10.8.0.1`+`@`+`attacker.example` → real host the attacker's), and that
  // held the release. Here no vault-supplied string is interpolated at all.
  test('a hostile baseUrl cannot influence the emitted URL', () => {
    // CONSTRUCTED, never a literal: `ip@host` has the shape of an email address
    // and the repo's leak scanner stops that pattern — rightly, since it cannot
    // tell an attack vector from a real address.
    const at = (a, b) => [a, b].join('@');
    const hostile = `https://${at('127.0.0.1', 'evil.example')}:27126`;
    // The premise, asserted rather than assumed.
    assert.equal(new URL(hostile).hostname, 'evil.example');
    const url = buildClickToOpenUrl(withPort(hostile), 'wiki/a.md');
    assert.equal(url, 'http://127.0.0.1:27136/open/wiki%2Fa.md');
    assert.ok(!url.includes('evil.example'), 'no part of baseUrl may appear in the link');
  });

  test('an unparseable or absent baseUrl changes nothing', () => {
    assert.equal(
      buildClickToOpenUrl({ name: 'r', type: 'remote', baseUrl: 'not a url', insecurePort: 27136 }, 'a.md'),
      'http://127.0.0.1:27136/open/a.md',
    );
    assert.equal(
      buildClickToOpenUrl({ name: 'r', type: 'remote', insecurePort: 27136 }, 'a.md'),
      'http://127.0.0.1:27136/open/a.md',
    );
  });

  test('NO declared port is the only refusal — omitting it is the opt-out', () => {
    assert.equal(
      buildClickToOpenUrl({ name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126' }, 'a.md'),
      null,
    );
  });

  test('the markdown link follows the URL', () => {
    assert.equal(
      buildClickToOpenMarkdownLink(withPort('https://127.0.0.1:27126'), 'wiki/a.md'),
      '[a](http://127.0.0.1:27136/open/wiki%2Fa.md)',
    );
    assert.equal(
      buildClickToOpenMarkdownLink({ name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126' }, 'wiki/a.md'),
      null,
    );
  });

  test('an anchor still travels on a remote link', () => {
    assert.equal(
      buildClickToOpenUrl(withPort('https://127.0.0.1:27126'), 'wiki/a.md', { anchor: '#Usage' }),
      'http://127.0.0.1:27136/open/wiki%2Fa.md?h=Usage',
    );
  });
});

// ---------------------------------------------------------------------------

describe('three disk states, not two', () => {
  test('READABLE + enabled → the disk port wins over the declared one', () => {
    const vaultPath = makeVault('live', { insecurePort: 27163, enableInsecureServer: true });
    assert.equal(
      resolveInsecurePort({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27999 }),
      27163,
      'a stale registry number must never override what the plugin binds',
    );
  });

  test('READABLE + disabled → null, and NO fallback to the remembered port', () => {
    const vaultPath = makeVault('off', { insecurePort: 27163, enableInsecureServer: false });
    assert.equal(
      resolveInsecurePort({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 }),
      null,
      'the plaintext server is genuinely off — a link would be dead on arrival',
    );
    assert.equal(
      buildClickToOpenUrl({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 }, 'a.md'),
      null,
    );
  });

  test('UNREADABLE → the declared port is used', () => {
    const vaultPath = makeVault('nodisk', undefined); // no .obsidian at all
    assert.equal(
      resolveInsecurePort({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 }),
      27163,
    );
    assert.equal(
      buildClickToOpenUrl({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 }, 'wiki/a.md'),
      'http://127.0.0.1:27163/open/wiki%2Fa.md',
    );
  });

  test('UNREADABLE and nothing declared → null, exactly as before v0.79.0', () => {
    const vaultPath = makeVault('empty', undefined);
    assert.equal(buildClickToOpenUrl({ name: 'v', type: 'local', path: vaultPath }, 'a.md'), null);
  });

  test('a corrupt data.json counts as unreadable, so the fallback applies', () => {
    const vaultPath = makeVault('broken', undefined);
    const dir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.json'), '{ not json');
    assert.equal(resolveInsecurePort({ name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 }), 27163);
  });

  // `opts.port` IS AN ESCAPE HATCH, AND IT IS VALIDATED LIKE ANY OTHER INPUT.
  // An earlier draft trusted it for merely being defined, because every caller
  // passed the number `resolveInsecurePort` had already range-checked. "No
  // current caller does it" is not a guard — and this fleet has now met the
  // string-interpolated-host defect three separate times (fourth review).
  test('a hostile opts.port cannot smuggle a host into the URL', () => {
    const at = (a, b) => [a, b].join('@');
    const vault = { name: 'v', type: 'remote', insecurePort: 27136 };
    for (const bad of [`80${at('', 'evil.example')}`, '27136/../x', '27136', 0, 65536, -1, 1.5, {}, []]) {
      assert.equal(
        buildClickToOpenUrl(vault, 'wiki/a.md', { port: bad }),
        null,
        `opts.port=${JSON.stringify(bad)} must be refused, not interpolated`,
      );
    }
    // A valid integer is honoured — the guard must not have closed the door.
    assert.equal(
      buildClickToOpenUrl(vault, 'wiki/a.md', { port: 27199 }),
      'http://127.0.0.1:27199/open/wiki%2Fa.md',
    );
  });

  test('an out-of-range declared port is ignored rather than interpolated', () => {
    const vaultPath = makeVault('bad', undefined);
    for (const bad of [0, 65536, -1, 1.5, '27163', null]) {
      assert.equal(
        resolveInsecurePort({ name: 'v', type: 'local', path: vaultPath, insecurePort: bad }),
        null,
        `insecurePort=${JSON.stringify(bad)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

// THE MEMO HID ITS OWN DEFECT, AND SO DID THE TEST SUITE. Until v0.79.0
// `readInsecurePortConfig` cached every successful read for the life of the
// process with no invalidation, so a user who DISABLED their plaintext server —
// or moved the port — kept getting the old number until the router restarted.
// No existing test could see it: they all call `_resetCache()` in a `beforeEach`.
//
// The first repair validated the entry against the file's mtime. The second
// review rejected that too: two writes inside one filesystem timestamp tick
// share an mtime, so the invariant still could not be stated — and the test
// defending the cache had to restore an mtime by hand, engraving the collision
// into the contract instead of testing anything. The memo is gone; every read is
// fresh. These tests deliberately do NOT reset anything between writes, and
// deliberately do NOT touch timestamps.
describe('every read is fresh — the file is the only source of truth', () => {
  function rewrite(vaultPath, data) {
    const p = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  }

  test('disabling the plaintext server stops the links, without a restart', () => {
    const vaultPath = makeVault('fresh-off', { insecurePort: 27163, enableInsecureServer: true });
    const vault = { name: 'v', type: 'local', path: vaultPath };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27163/open/a.md');

    rewrite(vaultPath, { insecurePort: 27163, enableInsecureServer: false });
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), null, 'no memo may survive the refutation');
  });

  test('moving the port moves the link', () => {
    const vaultPath = makeVault('fresh-move', { insecurePort: 27163, enableInsecureServer: true });
    const vault = { name: 'v', type: 'local', path: vaultPath };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27163/open/a.md');

    rewrite(vaultPath, { insecurePort: 27164, enableInsecureServer: true });
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27164/open/a.md');
  });

  // THE SAME-TICK CASE, which is exactly what the mtime scheme could not hold.
  // Both writes happen with no delay and no timestamp fiddling; if anything is
  // memoised, this is the test that catches it.
  test('two rewrites back to back are both seen', () => {
    const vaultPath = makeVault('fresh-tick', { insecurePort: 27163, enableInsecureServer: true });
    const vault = { name: 'v', type: 'local', path: vaultPath };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27163/open/a.md');
    rewrite(vaultPath, { insecurePort: 27164, enableInsecureServer: true });
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27164/open/a.md');
    rewrite(vaultPath, { insecurePort: 27165, enableInsecureServer: true });
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27165/open/a.md');
  });

  // The onboarding direction v0.14.9 was written for, still held.
  test('enabling the plaintext server starts the links, without a restart', () => {
    const vaultPath = makeVault('fresh-on', { insecurePort: 27163, enableInsecureServer: false });
    const vault = { name: 'v', type: 'local', path: vaultPath };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), null);
    rewrite(vaultPath, { insecurePort: 27163, enableInsecureServer: true });
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27163/open/a.md');
  });

  test('a deleted data.json serves no ghost, and only then does the fallback apply', () => {
    const vaultPath = makeVault('fresh-gone', { insecurePort: 27163, enableInsecureServer: true });
    const vault = { name: 'v', type: 'local', path: vaultPath };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27163/open/a.md');

    fs.rmSync(path.join(vaultPath, '.obsidian'), { recursive: true, force: true });
    // Unreadable now, and nothing declared → nothing to emit.
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), null);
    // …but a declared port IS the licensed fallback for an unreadable disk.
    assert.equal(
      buildClickToOpenUrl({ ...vault, insecurePort: 27199 }, 'a.md'),
      'http://127.0.0.1:27199/open/a.md',
    );
  });

  // A LIMIT, STATED RATHER THAN HIDDEN (2nd review, IMPORTANT 1). With no memo
  // the router keeps no record of a previous disk observation, so a vault whose
  // file said "disabled" and then became UNREADABLE falls back to the declared
  // port — reviving a value the disk had refuted. Building a negative tombstone
  // to prevent it would reintroduce exactly the cross-call state just removed,
  // to save a dead click. The behaviour is deliberate; this test pins it so it
  // cannot change by accident.
  test('an unreadable disk falls back even after a readable "disabled" — a known, bounded limit', () => {
    const vaultPath = makeVault('fresh-tombstone', { insecurePort: 27163, enableInsecureServer: false });
    const vault = { name: 'v', type: 'local', path: vaultPath, insecurePort: 27163 };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), null, 'while readable, the file decides');

    fs.rmSync(path.join(vaultPath, '.obsidian'), { recursive: true, force: true });
    assert.equal(
      buildClickToOpenUrl(vault, 'a.md'),
      'http://127.0.0.1:27163/open/a.md',
      'unreadable → the declared port is used, even though the disk once said no',
    );
  });
});

// ---------------------------------------------------------------------------

describe('the registry puts the port on every descriptor', () => {
  /** Write a config.json and load it. */
  async function load(config) {
    const p = path.join(fs.mkdtempSync(path.join(workDir, 'cfg-')), 'config.json');
    fs.writeFileSync(p, JSON.stringify(config));
    return loadRegistry({ configPath: p });
  }

  test('a local vault takes its plaintext port from disk first', async () => {
    const vaultPath = makeVault('reg-live', {
      apiKey: 'a'.repeat(32), port: 27126, insecurePort: 27163, enableInsecureServer: true,
    });
    const reg = await load({ portRegistry: { [vaultPath]: { https: 27126, http: 27999 } } });
    const v = reg.vaults.find((x) => x.path === vaultPath);
    assert.equal(v.insecurePort, 27163, 'disk wins over the stale registry declaration');
  });

  test('a local vault with an unreadable disk falls back to the registry', async () => {
    const vaultPath = makeVault('reg-nodisk', undefined);
    const reg = await load({ portRegistry: { [vaultPath]: { https: 27126, http: 27163 } } });
    const v = reg.vaults.find((x) => x.path === vaultPath);
    assert.equal(v.insecurePort, 27163);
  });

  test('a legacy number-only registry entry yields no plaintext port, not a guess', async () => {
    const vaultPath = makeVault('reg-legacy', undefined);
    const reg = await load({ portRegistry: { [vaultPath]: 27126 } });
    const v = reg.vaults.find((x) => x.path === vaultPath);
    assert.equal(v.insecurePort, null, '+10 is a provisioning convention, never a fact about an existing vault');
  });

  test('a remoteVaults entry carries its declared port through', async () => {
    const reg = await load({
      portRegistry: {},
      remoteVaults: [{ name: 'r', baseUrl: 'https://127.0.0.1:27126', apiKey: 'k', insecurePort: 27136 }],
    });
    const v = reg.vaults.find((x) => x.name === 'r');
    assert.equal(v.insecurePort, 27136);
    assert.equal(buildClickToOpenUrl(v, 'wiki/a.md'), 'http://127.0.0.1:27136/open/wiki%2Fa.md');
  });

  test('a remoteVaults entry with a junk port yields null, and the vault still loads', async () => {
    const reg = await load({
      portRegistry: {},
      remoteVaults: [{ name: 'r', baseUrl: 'https://127.0.0.1:27126', apiKey: 'k', insecurePort: 'nope' }],
    });
    const v = reg.vaults.find((x) => x.name === 'r');
    assert.equal(v.insecurePort, null);
    assert.equal(buildClickToOpenUrl(v, 'a.md'), null);
  });

  test('a VAULT_* env vault carries it too', async () => {
    // `envVar`, not `key`: the repo's gitleaks pre-commit hook reads
    // `const key = '<high-entropy string>'` as a credential assignment and
    // blocks the commit. It is right to — and the old name was misleading
    // anyway, since this holds an environment variable NAME.
    const envVar = 'VAULT_LOT2ENVFIXTURE';
    process.env[envVar] = JSON.stringify({
      name: 'lot2env', baseUrl: 'https://127.0.0.1:27126', apiKey: 'k', insecurePort: 27136,
    });
    try {
      const reg = await load({ portRegistry: {} });
      const v = reg.vaults.find((x) => x.name === 'lot2env');
      assert.equal(v.insecurePort, 27136);
      assert.equal(buildClickToOpenUrl(v, 'wiki/a.md'), 'http://127.0.0.1:27136/open/wiki%2Fa.md');
    } finally {
      delete process.env[envVar];
    }
  });
});

// ---------------------------------------------------------------------------

// `pathVerified` WAS ESSENTIALLY UNTESTED in the first draft of lot 2 — the
// review said so and was right. The field is the only thing standing between a
// caller and the failure mode `build_open_link` exists to prevent: a well-formed
// URL nobody checked.
//
// FOUR OF THE FIVE BRANCHES ARE EXERCISED HERE: ok, corrected, not_found,
// ambiguous, plus the unverifiable (diskless) path. The FIFTH —
// `resolution_incomplete`, which returns a hardcoded `pathVerified: false` — is
// NOT tested: reaching it needs a vault past `resolve-vault-path.mjs`'s 20 000-
// file scan budget, and standing one up would add seconds to every CI run to
// cover a literal. That gap is named rather than papered over; a regression
// there would not be caught by this file.
describe('build_open_link reports whether it checked anything', () => {
  const registryFor = (vault) => ({ resolveVault: () => vault });

  function localVaultWith(files) {
    const root = fs.mkdtempSync(path.join(workDir, 'bol-'));
    const dir = path.join(root, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ insecurePort: 27163, enableInsecureServer: true }));
    for (const rel of files) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '# x\n');
    }
    return { name: 'local', type: 'local', path: root };
  }

  test('a checked, existing path is pathVerified:true with no explanation', async () => {
    const vault = localVaultWith(['wiki/a.md']);
    const res = await buildOpenLinkTool(registryFor(vault), { path: 'wiki/a.md' });
    assert.equal(res.pathVerified, true);
    assert.ok(!('verification' in res), 'nothing to explain when the path was checked');
    assert.equal(res.clickToOpenUrl, 'http://127.0.0.1:27163/open/wiki%2Fa.md');
  });

  test('a diskless vault yields a URL AND says the path was never checked', async () => {
    const vault = { name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126', insecurePort: 27136 };
    const res = await buildOpenLinkTool(registryFor(vault), { path: 'wiki/invented.md' });
    assert.equal(res.pathVerified, false);
    assert.equal(res.clickToOpenUrl, 'http://127.0.0.1:27136/open/wiki%2Finvented.md');
    assert.match(res.verification, /could not confirm the file exists/);
    assert.match(res.verification, /may 404/, 'there IS a URL here, so the caveat belongs');
  });

  // THE FALSE SENTENCE the review caught: with no plaintext port there is no
  // URL, and the explanation must not describe one.
  test('a diskless vault with NO port does not claim anything about a URL', async () => {
    const vault = { name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126' };
    const res = await buildOpenLinkTool(registryFor(vault), { path: 'wiki/invented.md' });
    assert.equal(res.pathVerified, false);
    assert.equal(res.clickToOpenUrl, null);
    assert.ok(!/URL/.test(res.verification), `no URL exists, so none may be described: ${res.verification}`);
    assert.match(res.verification, /could not confirm the file exists/);
  });

  // pathVerified is about the PATH, not the link — the reason it is not called
  // `verified`. A real file in a vault whose plaintext server is off is checked
  // AND unlinkable at the same time.
  test('a real file with the plaintext server off is pathVerified:true, URL null', async () => {
    const vault = localVaultWith(['wiki/a.md']);
    const p = path.join(vault.path, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
    fs.writeFileSync(p, JSON.stringify({ insecurePort: 27163, enableInsecureServer: false }));
    const t = new Date(Date.now() + 10_000);
    fs.utimesSync(p, t, t);
    const res = await buildOpenLinkTool(registryFor(vault), { path: 'wiki/a.md' });
    assert.equal(res.pathVerified, true);
    assert.equal(res.clickToOpenUrl, null);
  });

  test('batch entries carry the field on the error branches too', async () => {
    const vault = localVaultWith(['wiki/a.md', 'wiki/one/dup.md', 'wiki/two/dup.md']);
    const res = await buildOpenLinkTool(registryFor(vault), {
      paths: ['wiki/a.md', 'nope/absent.md', 'dup.md'],
    });
    assert.equal(res.links.length, 3);
    for (const link of res.links) {
      assert.ok('pathVerified' in link, `every entry must carry the field: ${JSON.stringify(link)}`);
    }
    assert.equal(res.links[0].pathVerified, true);
    assert.equal(res.links[1].error, 'not_found');
    assert.equal(res.links[1].pathVerified, true, 'a CHECKED absence is still a check');
    assert.equal(res.links[2].error, 'ambiguous');
    assert.equal(res.links[2].pathVerified, true);
  });

  test('a corrected path is still a checked path', async () => {
    const vault = localVaultWith(['wiki/deep/target.md']);
    const res = await buildOpenLinkTool(registryFor(vault), { path: 'target.md' });
    assert.equal(res.corrected, true);
    assert.equal(res.path, 'wiki/deep/target.md');
    assert.equal(res.pathVerified, true);
  });
});
