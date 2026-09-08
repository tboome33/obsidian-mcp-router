/**
 * Lot 1 — the router talks to the port the vault actually binds.
 *
 * Two layers, on purpose:
 *
 *   1. `resolveLocalRestState` / `describeEndpointDrift` are PURE, so the whole
 *      state machine (three disk states, a port that is present but not a port,
 *      a plaintext server that is off) is exercised without a filesystem.
 *   2. `loadRegistry` is then run against real temp vaults, because the defect
 *      this lot fixes was not in a helper — it was one line in `registry.mjs`
 *      reading `entry.https` where the plaintext port two fields below already
 *      preferred the disk. A pure test would not have caught it, and did not.
 *
 * THE MUTATION WITNESS is `dials the HTTPS port the vault binds, not the one
 * the registry remembers`: putting `entry.https` back turns it red.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveLocalRestState,
  describeEndpointDrift,
  REST_DATA_STATUS,
  PORT_SOURCE,
} from '../src/helpers/rest-endpoint-state.mjs';
import { loadRegistry } from '../src/registry.mjs';

// ---------------------------------------------------------------------------
// resolveLocalRestState — the three disk states
// ---------------------------------------------------------------------------

describe('resolveLocalRestState — where each port comes from', () => {
  test('a readable data.json wins over the registry, for BOTH protocols', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: { port: 27192, insecurePort: 27134, enableInsecureServer: true, rawPort: 27192, rawInsecurePort: 27134 },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.effectivePorts.https, 27192);
    assert.equal(state.httpsSource, PORT_SOURCE.DISK);
    assert.equal(state.effectivePorts.http, 27134);
    assert.equal(state.httpSource, PORT_SOURCE.DISK);
    assert.deepEqual(state.issues, []);
  });

  test('an ABSENT data.json falls back to the registry and says so', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: null,
      restDataStatus: REST_DATA_STATUS.ABSENT,
    });
    assert.equal(state.effectivePorts.https, 27124);
    assert.equal(state.httpsSource, PORT_SOURCE.REGISTRY);
    assert.equal(state.issues.length, 1);
    assert.equal(state.issues[0].kind, 'rest-data-absent');
  });

  test('an UNREADABLE data.json is a different fact from an absent one', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: null },
      restData: null,
      restDataStatus: REST_DATA_STATUS.UNREADABLE,
    });
    assert.equal(state.effectivePorts.https, 27124);
    assert.equal(state.issues[0].kind, 'rest-data-unreadable');
    // No registry value either — nobody knows this port.
    assert.equal(state.httpSource, PORT_SOURCE.NONE);
    assert.equal(state.effectivePorts.http, null);
  });

  test('a CORRUPT data.json is an error, and is never read as "never configured"', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: null,
      restDataStatus: REST_DATA_STATUS.INVALID,
    });
    assert.equal(state.issues[0].kind, 'rest-data-invalid');
    assert.equal(state.issues[0].severity, 'error');
    assert.notEqual(state.issues[0].kind, 'rest-data-absent');
  });

  test('status "ok" with a payload that is not an object is treated as invalid', () => {
    for (const payload of [null, undefined, [], 'ok', 42]) {
      const state = resolveLocalRestState({
        registryPorts: { https: 27124, http: null },
        restData: payload,
        restDataStatus: REST_DATA_STATUS.OK,
      });
      assert.equal(state.issues[0].kind, 'rest-data-invalid', `payload ${JSON.stringify(payload)}`);
      assert.equal(state.effectivePorts.https, 27124);
    }
  });

  test('an unrecognised status is treated as invalid, never as authoritative', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: null },
      restData: { port: 29999, rawPort: 29999 },
      restDataStatus: 'OK',
    });
    // A caller's typo must not promote an unread file to the source of truth.
    assert.equal(state.effectivePorts.https, 27124);
    assert.equal(state.httpsSource, PORT_SOURCE.REGISTRY);
  });
});

describe('resolveLocalRestState — a value that is present but is not a port', () => {
  for (const [label, raw] of [
    ['zero', 0],
    ['a string', '27124'],
    ['out of range', 70000],
    ['negative', -1],
    ['an object', {}],
    ['a float', 27124.5],
  ]) {
    test(`HTTPS port ${label} → diagnosed, and the registry answers`, () => {
      const state = resolveLocalRestState({
        registryPorts: { https: 27124, http: 27134 },
        restData: { port: null, insecurePort: 27134, enableInsecureServer: true, rawPort: raw, rawInsecurePort: 27134 },
        restDataStatus: REST_DATA_STATUS.OK,
      });
      const issue = state.issues.find((i) => i.kind === 'invalid-port' && i.protocol === 'https');
      assert.ok(issue, 'expected an invalid-port issue for https');
      assert.equal(state.effectivePorts.https, 27124);
      assert.equal(state.httpsSource, PORT_SOURCE.REGISTRY);
    });
  }

  test('an ABSENT field is ordinary and silent — not an invalid one', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: { port: 27192, insecurePort: null, enableInsecureServer: false, rawPort: 27192, rawInsecurePort: undefined },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.issues.filter((i) => i.kind === 'invalid-port').length, 0);
  });
});

describe('resolveLocalRestState — a port number is not an announcement', () => {
  test('enableInsecureServer false, with a port still recorded → NOT available', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: { port: 27124, insecurePort: 27134, enableInsecureServer: false, rawPort: 27124, rawInsecurePort: 27134 },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.httpEnabled, false);
    // The NUMBER is still known — it is the availability that is false.
    assert.equal(state.effectivePorts.http, 27134);
  });

  test('an absent enableInsecureServer means off — the plugin default is false', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: { port: 27124, insecurePort: 27134, rawPort: 27124, rawInsecurePort: 27134 },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.httpEnabled, false);
  });

  test('a truthy non-true value does not turn it on', () => {
    for (const value of ['true', 1, {}, 'false']) {
      const state = resolveLocalRestState({
        registryPorts: { https: 27124, http: 27134 },
        restData: { port: 27124, insecurePort: 27134, enableInsecureServer: value, rawPort: 27124, rawInsecurePort: 27134 },
        restDataStatus: REST_DATA_STATUS.OK,
      });
      assert.equal(state.httpEnabled, false, `value ${JSON.stringify(value)}`);
    }
  });

  test('an UNREADABLE disk leaves availability unknown — null, which is not false', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: 27134 },
      restData: null,
      restDataStatus: REST_DATA_STATUS.UNREADABLE,
    });
    assert.equal(state.httpEnabled, null);
    assert.notEqual(state.httpEnabled, false);
  });

  test('enabled but nameless → said out loud', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27124, http: null },
      restData: { port: 27124, insecurePort: null, enableInsecureServer: true, rawPort: 27124, rawInsecurePort: undefined },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.ok(state.issues.some((i) => i.kind === 'http-enabled-without-port'));
  });
});

describe('resolveLocalRestState — historic pairs are never normalized', () => {
  // Invariant I6. 18 of the 27 pairs on the production fleet do not respect the
  // +10 gap, and 6 of them run BACKWARDS (http below https) — `tribu` is
  // 27172/27145. Any code that "repairs" the gap would move a plaintext port,
  // and every click-to-open link written in a note carries that number.
  test('a negative gap survives untouched', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27172, http: 27145 },
      restData: { port: 27172, insecurePort: 27145, enableInsecureServer: true, rawPort: 27172, rawInsecurePort: 27145 },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.effectivePorts.https, 27172);
    assert.equal(state.effectivePorts.http, 27145);
    assert.ok(state.effectivePorts.http < state.effectivePorts.https);
  });

  test('a gap of one survives untouched', () => {
    const state = resolveLocalRestState({
      registryPorts: { https: 27175, http: 27176 },
      restData: { port: 27175, insecurePort: 27176, enableInsecureServer: true, rawPort: 27175, rawInsecurePort: 27176 },
      restDataStatus: REST_DATA_STATUS.OK,
    });
    assert.equal(state.effectivePorts.http, 27176);
  });
});

// ---------------------------------------------------------------------------
// describeEndpointDrift
// ---------------------------------------------------------------------------

describe('describeEndpointDrift', () => {
  test('names the old value, the new one and the source', () => {
    const [d] = describeEndpointDrift({
      path: '/vaults/crea-jeu',
      name: 'Crea-Jeu',
      registeredPorts: { https: 27124, http: 27134 },
      effectivePorts: { https: 20541, http: 27134 },
      sources: { https: PORT_SOURCE.DISK, http: PORT_SOURCE.DISK },
    });
    assert.equal(d.kind, 'port-drift');
    assert.equal(d.protocol, 'https');
    assert.equal(d.from, 27124);
    assert.equal(d.to, 20541);
    assert.equal(d.source, PORT_SOURCE.DISK);
    assert.match(d.message, /27124/);
    assert.match(d.message, /20541/);
  });

  test('a message never promises a cause, and never orders a repair', () => {
    const [d] = describeEndpointDrift({
      path: '/vaults/x',
      name: 'X',
      registeredPorts: { https: 27124, http: null },
      effectivePorts: { https: 20541, http: null },
      sources: { https: PORT_SOURCE.DISK },
    });
    assert.doesNotMatch(d.message, /Google Drive|Drive|synchroni/i);
    // Decision D6: the drift is USED, and refreshing the record is a separate
    // act the user chooses. The message must not claim a port was changed.
    assert.match(d.message, /no port of the vault will be modified/i);
  });

  test('identical ports produce nothing at all', () => {
    const out = describeEndpointDrift({
      path: '/vaults/x',
      name: 'X',
      registeredPorts: { https: 27124, http: 27134 },
      effectivePorts: { https: 27124, http: 27134 },
      sources: { https: PORT_SOURCE.DISK, http: PORT_SOURCE.DISK },
    });
    assert.deepEqual(out, []);
  });

  test('a registry that never recorded a port has not drifted — it is incomplete', () => {
    const out = describeEndpointDrift({
      path: '/vaults/x',
      name: 'X',
      registeredPorts: { https: 27124, http: null },
      effectivePorts: { https: 27124, http: 27134 },
      sources: { https: PORT_SOURCE.DISK, http: PORT_SOURCE.DISK },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'port-unrecorded');
    assert.equal(out[0].severity, 'info');
    assert.equal(out[0].from, null);
  });

  test('an unrecorded port with no disk claim says nothing', () => {
    const out = describeEndpointDrift({
      path: '/vaults/x',
      name: 'X',
      registeredPorts: { https: null, http: null },
      effectivePorts: { https: null, http: null },
      sources: { https: PORT_SOURCE.NONE, http: PORT_SOURCE.NONE },
    });
    assert.deepEqual(out, []);
  });

  test('both protocols can drift at once, and each is reported', () => {
    const out = describeEndpointDrift({
      path: '/vaults/x',
      name: 'X',
      registeredPorts: { https: 27124, http: 27134 },
      effectivePorts: { https: 20541, http: 20551 },
      sources: { https: PORT_SOURCE.DISK, http: PORT_SOURCE.DISK },
    });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((d) => d.protocol).sort(), ['http', 'https']);
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — against real files. THIS is where the defect lived.
// ---------------------------------------------------------------------------

describe('loadRegistry — the port the router actually dials', () => {
  let tmpDir;
  let cfgPath;

  const SECRET = 'test-key-do-not-leak-9d41f0';

  /** Write a vault folder with a Local REST API data.json. */
  function makeVault(name, data) {
    const dir = path.join(tmpDir, name);
    const pluginDir = path.join(dir, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fsSync.mkdirSync(pluginDir, { recursive: true });
    if (data !== null) {
      fsSync.writeFileSync(
        path.join(pluginDir, 'data.json'),
        typeof data === 'string' ? data : JSON.stringify({ apiKey: SECRET, ...data }),
      );
    }
    return dir;
  }

  async function load(portRegistry, extra = {}) {
    fsSync.writeFileSync(cfgPath, JSON.stringify({ portRegistry, ...extra }));
    return loadRegistry({ configPath: cfgPath });
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-endpoint-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('dials the HTTPS port the vault binds, not the one the registry remembers', async () => {
    // The `recherches-etudes-sup` case, 2026-09-08: moved to HTTPS 27192 while
    // the registry still said 27124. Before this lot the router kept calling
    // 27124 and the vault looked closed.
    //
    // ► MUTATION WITNESS: restore `const port = entry.https` in registry.mjs
    //   and this assertion turns red.
    const dir = makeVault('moved', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.baseUrl, 'https://127.0.0.1:27192');
  });

  test('the plaintext port that did NOT move stays where it was', async () => {
    const dir = makeVault('http-stable', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.insecurePort, 27134);
  });

  test('the drift is reported, with both numbers, for a CLOSED vault', async () => {
    // No server is running anywhere in this test. Reading data.json needs none,
    // which is the whole point: a drift is visible while Obsidian is shut.
    const dir = makeVault('drifted', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    const drift = reg.portDiagnostics.find((d) => d.kind === 'port-drift' && d.path === dir);
    assert.ok(drift, 'expected a port-drift diagnostic');
    assert.equal(drift.from, 27124);
    assert.equal(drift.to, 27192);
  });

  test('a negative-gap pair survives a load untouched', async () => {
    const dir = makeVault('tribu-like', { port: 27172, insecurePort: 27145, enableInsecureServer: true });
    const reg = await load({ [dir]: { https: 27172, http: 27145 } });
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.baseUrl, 'https://127.0.0.1:27172');
    assert.equal(vault.insecurePort, 27145);
    assert.equal(reg.portDiagnostics.filter((d) => d.path === dir && d.kind === 'port-drift').length, 0);
  });

  test('HTTP turned off is not announced as available', async () => {
    const dir = makeVault('http-off', { port: 27124, insecurePort: 27134, enableInsecureServer: false });
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.httpEnabled, false);
  });

  test('a vault with no data.json falls back to the registry, availability unknown', async () => {
    const dir = makeVault('bare', null);
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.baseUrl, 'https://127.0.0.1:27124');
    assert.equal(vault.httpEnabled, null);
    assert.ok(reg.portDiagnostics.some((d) => d.path === dir && d.kind === 'rest-data-absent'));
  });

  test('a corrupt data.json is diagnosed as damaged, not as unconfigured', async () => {
    const dir = makeVault('corrupt', '{ this is not json');
    const reg = await load({ [dir]: { https: 27124, http: 27134 } });
    assert.ok(reg.portDiagnostics.some((d) => d.path === dir && d.kind === 'rest-data-invalid'));
    assert.ok(!reg.portDiagnostics.some((d) => d.path === dir && d.kind === 'rest-data-absent'));
    const vault = reg.vaults.find((v) => v.path === dir);
    assert.equal(vault.baseUrl, 'https://127.0.0.1:27124');
  });

  test('no diagnostic anywhere carries the vault API key', async () => {
    // Invariant I3. The same data.json holds the key and the TLS private key.
    const a = makeVault('secret-a', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    const b = makeVault('secret-b', '{ broken');
    const reg = await load({ [a]: { https: 27124, http: 27134 }, [b]: { https: 27125, http: 27135 } });
    const serialized = JSON.stringify(reg.portDiagnostics);
    assert.ok(reg.portDiagnostics.length > 0, 'the fixture must actually produce diagnostics');
    assert.ok(!serialized.includes(SECRET), 'a diagnostic leaked the API key');
  });

  /**
   * Record every write target of `fn`. The fs module objects are SHARED with
   * registry.mjs, so this counts the calls it really makes rather than the ones
   * a reading of the source suggests.
   */
  async function recordWrites(fn) {
    const writers = ['writeFile', 'appendFile', 'rename', 'copyFile', 'rm', 'unlink', 'mkdir', 'truncate'];
    const saved = [];
    const targets = [];
    for (const name of writers) {
      const asyncName = name;
      const syncName = `${name}Sync`;
      if (typeof fs[asyncName] === 'function') {
        const original = fs[asyncName];
        saved.push([fs, asyncName, original]);
        fs[asyncName] = async (...args) => { targets.push(String(args[0])); return original(...args); };
      }
      if (typeof fsSync[syncName] === 'function') {
        const original = fsSync[syncName];
        saved.push([fsSync, syncName, original]);
        fsSync[syncName] = (...args) => { targets.push(String(args[0])); return original(...args); };
      }
    }
    try {
      await fn();
    } finally {
      for (const [obj, name, original] of saved) obj[name] = original;
    }
    return targets;
  }

  test('loading the registry never writes a vault file, and never rewrites a port', async () => {
    // Invariant I8, TESTED AS WRITTEN: a load does not rewrite ports or
    // identities. It is NOT "a load writes nothing at all" — the first load in
    // a workspace still performs the one-time dotenv-hint import into the
    // binding registry, which touches `workspaceBindings` and nothing else.
    // Asserting zero writes would have been stricter than the invariant and
    // would have failed on a deliberate, documented migration.
    //
    // What must never happen is a write INTO A VAULT, or a port moving under a
    // read. Both are asserted, the second on the bytes rather than in memory.
    const dir = makeVault('readonly-load', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    fsSync.writeFileSync(cfgPath, JSON.stringify({ portRegistry: { [dir]: { https: 27124, http: 27134 } } }));

    const targets = await recordWrites(() => loadRegistry({ configPath: cfgPath }));

    const intoVault = targets.filter((t) => t.startsWith(dir));
    assert.deepEqual(intoVault, [], `a load wrote inside a vault: ${intoVault.join(', ')}`);
    assert.deepEqual(
      targets.filter((t) => t.includes('data.json')),
      [],
      'a load touched a Local REST API data.json',
    );

    const after = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(
      after.portRegistry,
      { [dir]: { https: 27124, http: 27134 } },
      'the drift was persisted into the registry — decision D6 says it must not be',
    );
  });

  test('a second load writes nothing at all — the one-time import stays one-time', async () => {
    // The corollary that makes the exception above safe: whatever the first
    // load migrates, it records as done. A migration that forgot to record
    // itself would rewrite the config on every single start-up, and the drift
    // exception would quietly become a permanent writer.
    const dir = makeVault('second-load', { port: 27192, insecurePort: 27134, enableInsecureServer: true });
    fsSync.writeFileSync(cfgPath, JSON.stringify({ portRegistry: { [dir]: { https: 27124, http: 27134 } } }));

    await loadRegistry({ configPath: cfgPath });
    const targets = await recordWrites(() => loadRegistry({ configPath: cfgPath }));

    assert.deepEqual(targets, [], `a repeat load wrote: ${targets.join(', ')}`);
  });
});
