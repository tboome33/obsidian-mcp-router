/**
 * Lot 7 — saying why a vault is not answering, and not saying anything else.
 *
 * The mutation witness the specification asks for is
 * `the drift is visible in what the USER sees`: delete the drift diagnostic and
 * it turns red even though the technical URL the router dials stays correct.
 * That distinction is the point of the lot — the router already followed the
 * moved port in v0.94.0 lot 1; what was missing was telling anyone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyVaultReachability,
  planLocalRegistryReconciliation,
  makeDiagnosticDeduper,
  REACHABILITY,
} from '../src/helpers/vault-reachability.mjs';

const endpoint = (over = {}) => ({
  effectivePorts: { https: 27124, http: 27134 },
  registeredPorts: { https: 27124, http: 27134 },
  httpsSource: 'registry',
  httpSource: 'registry',
  httpEnabled: true,
  issues: [],
  ...over,
});
const answered = { answered: true, authenticated: true, identity: 'confirmed' };

describe('classifyVaultReachability — the eight situations', () => {
  test('agreeing, answering, authenticated → healthy, and nothing is said', () => {
    const out = classifyVaultReachability({ endpointState: endpoint(), probeResult: answered, name: 'Crea-Jeu' });
    assert.equal(out.status, REACHABILITY.HEALTHY);
    assert.deepEqual(out.diagnostics, []);
    assert.deepEqual(out.suggestedActions, []);
  });

  test('the drift is visible in what the USER sees, with both numbers', () => {
    // ► MUTATION WITNESS: remove the drift diagnostic and this fails, even
    //   though the port the router dials would still be correct.
    const out = classifyVaultReachability({
      endpointState: endpoint({ effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }),
      probeResult: answered,
      name: 'Crea-Jeu',
    });
    assert.equal(out.status, REACHABILITY.DRIFTED_REACHABLE);
    const drift = out.diagnostics.find((d) => d.kind === 'port-drift');
    assert.ok(drift, 'no drift was reported to the user');
    assert.match(drift.message, /27124/);
    assert.match(drift.message, /20541/);
    assert.match(drift.message, /no port of the vault will be modified/i);
  });

  test('a drift proposes refreshing the LOCAL record, and says it writes no vault', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint({ effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }),
      probeResult: answered,
    });
    const action = out.suggestedActions.find((a) => a.kind === 'reconcile-registry');
    assert.ok(action);
    assert.equal(action.writesVault, false);
  });

  test('a drift with nothing listening asks for a window — that one IS the right advice', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint({ effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }),
      probeResult: { answered: false },
      name: 'Crea-Jeu',
    });
    assert.equal(out.status, REACHABILITY.DRIFTED_UNREACHABLE);
    assert.match(out.diagnostics[0].message, /20541/);
    assert.ok(out.suggestedActions.some((a) => a.kind === 'open-obsidian'));
  });

  test('an authentication failure NEVER becomes "open Obsidian"', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint(),
      probeResult: { answered: true, authenticated: false, identity: 'rejected' },
      name: 'tribu',
    });
    assert.equal(out.status, REACHABILITY.AUTH_FAILED);
    assert.equal(out.suggestedActions.filter((a) => a.kind === 'open-obsidian').length, 0);
    // And it names BOTH causes, because they are indistinguishable from here.
    assert.match(out.diagnostics[0].message, /something else holds the port/i);
    assert.match(out.diagnostics[0].message, /stale/i);
  });

  test('a known collision is not reported as an unexplained silence', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint(),
      probeResult: { answered: false },
      collisions: [{ kind: 'shared-port', port: 27124 }],
      name: 'X',
    });
    assert.equal(out.status, REACHABILITY.COLLISION);
    assert.match(out.diagnostics[0].message, /may not be enough/i);
    assert.equal(out.suggestedActions.filter((a) => a.kind === 'open-obsidian').length, 0);
  });

  test('something that answered but could not be identified is liveness, not confirmation', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint(),
      probeResult: { answered: true, authenticated: null, identity: 'unverified' },
    });
    assert.equal(out.status, REACHABILITY.IDENTITY_UNVERIFIED);
    assert.match(out.diagnostics[0].message, /never as confirmation/i);
  });

  test('an unreadable data.json asserts nothing about ports', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint({ issues: [{ kind: 'rest-data-invalid', severity: 'error', message: 'x' }] }),
      probeResult: answered,
    });
    assert.equal(out.status, REACHABILITY.CONFIG_UNREADABLE);
    assert.match(out.diagnostics[0].message, /nothing was written/i);
  });

  test('HTTP switched off is not announced as an available link', () => {
    const out = classifyVaultReachability({
      endpointState: endpoint({ httpEnabled: false }),
      probeResult: answered,
      name: 'X',
    });
    assert.equal(out.status, REACHABILITY.HTTP_DISABLED);
    assert.match(out.diagnostics[0].message, /not a promise that anything is listening/i);
  });

  test('no message ever blames synchronisation for a drift', () => {
    // A plausible cause stated as a fact is how somebody stops looking for the
    // real one. Google Drive is plausible here and is never asserted.
    const cases = [
      { endpointState: endpoint({ effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }), probeResult: answered },
      { endpointState: endpoint({ effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }), probeResult: { answered: false } },
      { endpointState: endpoint(), probeResult: { answered: true, authenticated: false } },
    ];
    for (const c of cases) {
      const text = JSON.stringify(classifyVaultReachability(c).diagnostics);
      assert.doesNotMatch(text, /Google Drive|Drive|synchronisation caused|because of sync/i);
    }
  });

  test('"open Obsidian" is proposed for exactly the states where it can work', () => {
    const wants = (probeResult, over = {}, collisions = []) =>
      classifyVaultReachability({ endpointState: endpoint(over), probeResult, collisions })
        .suggestedActions.some((a) => a.kind === 'open-obsidian');

    assert.equal(wants({ answered: false }), true, 'nothing answered');
    assert.equal(wants({ answered: false }, { effectivePorts: { https: 20541, http: 27134 }, httpsSource: 'disk' }), true);
    assert.equal(wants({ answered: true, authenticated: false }), false, 'a refusal is not a closed window');
    assert.equal(wants({ answered: false }, {}, [{ kind: 'shared-port' }]), false, 'a window cannot take a port back');
    assert.equal(wants(answered), false, 'a healthy vault needs nothing');
    assert.equal(
      wants(answered, { issues: [{ kind: 'rest-data-unreadable' }] }),
      false,
      'an unreadable file is not fixed by a window',
    );
  });
});

describe('planLocalRegistryReconciliation', () => {
  test('lists what would change, and states it writes no vault', () => {
    const plan = planLocalRegistryReconciliation({
      cfg: {},
      observations: [
        { path: 'C:\\A', registeredPorts: { https: 27124, http: 27134 }, effectivePorts: { https: 20541, http: 27134 } },
        { path: 'C:\\B', registeredPorts: { https: 27150, http: 27160 }, effectivePorts: { https: 27150, http: 27160 } },
      ],
    });
    assert.equal(plan.writesVault, false);
    assert.equal(plan.wouldChange, 1);
    assert.deepEqual(plan.changes[0], { path: 'C:\\A', protocol: 'https', from: 27124, to: 20541, source: 'disk' });
  });

  test('an unknown effective port proposes nothing — absence is not a value', () => {
    const plan = planLocalRegistryReconciliation({
      cfg: {},
      observations: [{ path: 'C:\\A', registeredPorts: { https: 27124, http: 27134 }, effectivePorts: { https: null, http: null } }],
    });
    assert.equal(plan.wouldChange, 0);
  });

  test('a port the registry never recorded is a change worth making', () => {
    const plan = planLocalRegistryReconciliation({
      cfg: {},
      observations: [{ path: 'C:\\A', registeredPorts: { https: 27124, http: null }, effectivePorts: { https: 27124, http: 27134 } }],
    });
    assert.equal(plan.wouldChange, 1);
    assert.equal(plan.changes[0].from, null);
  });
});

describe('makeDiagnosticDeduper', () => {
  const a = [{ kind: 'port-drift', path: 'C:\\A', from: 1, to: 2 }];
  const b = [{ kind: 'port-drift', path: 'C:\\B', from: 3, to: 4 }];

  test('an identical repeat is silent', () => {
    const should = makeDiagnosticDeduper();
    assert.equal(should(a), true);
    assert.equal(should(a), false);
  });

  test('a DIFFERENT situation speaks — the whole reason it is not a boolean', () => {
    const should = makeDiagnosticDeduper();
    should(a);
    assert.equal(should(b), true, 'a new problem was swallowed by the latch');
  });

  test('order does not make two identical sets look different', () => {
    const should = makeDiagnosticDeduper();
    should([...a, ...b]);
    assert.equal(should([...b, ...a]), false);
  });

  test('a clean state resets, so a repaired-then-broken vault speaks again', () => {
    const should = makeDiagnosticDeduper();
    should(a);
    assert.equal(should([]), false);
    assert.equal(should(a), true);
  });
});
