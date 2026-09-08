/**
 * Lot 2 — an installation's identity, the band new ports are drawn from, and
 * asking the operating system before promising a port to anyone.
 *
 * FOUR MUTATION WITNESSES are named in-line below. Each one names the defect it
 * catches, so that a later reader can reintroduce it and watch the right test
 * turn red rather than trusting a comment:
 *
 *   - ignoring HTTP reservations              → `a port reserved as HTTP elsewhere is not offered as HTTPS`
 *   - dropping the OS probe                   → `a really-open socket makes the candidate unavailable`
 *   - redrawing an existing base              → `an existing base is kept, out-of-band or not`
 *   - dropping the second port's band check   → `a base whose partner falls outside the band is refused`
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  DEFAULT_PORT_POLICY,
  isAllowedNewServicePort,
  allowedPairBases,
  choosePortStart,
  orderedPairCandidates,
  policyOffset,
} from '../src/helpers/port-policy.mjs';
import {
  MAX_PORT,
  DEFAULT_INSECURE_OFFSET,
  allocateAvailablePortPair,
} from '../src/helpers/port-registry.mjs';
import {
  planInstallationInitialization,
  isValidUuid,
  installationOwnerRef,
} from '../src/helpers/installation-identity.mjs';
import { probeLoopbackPort, probeLoopbackPair } from '../src/port-availability.mjs';

const UUID_A = '11111111-2222-4333-8444-555555555555';

/** A deterministic stand-in for crypto.randomInt(min, max) — always the first. */
const firstOf = () => 0;

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

describe('the band — decision D3', () => {
  test('the two constants restated in port-policy match the allocator\'s', () => {
    // port-policy.mjs deliberately does NOT import port-registry.mjs (an ESM
    // cycle would put DEFAULT_PORT_POLICY's offset in a temporal dead zone), so
    // it restates two constants. This is the test that keeps the restatement
    // from drifting — the reason the duplication is acceptable at all.
    assert.equal(DEFAULT_PORT_POLICY.offset, DEFAULT_INSECURE_OFFSET);
    assert.equal(isAllowedNewServicePort(MAX_PORT + 1, { min: 1, max: MAX_PORT + 5, exclusions: [] }), false);
  });

  test('inside the band is allowed, outside is not', () => {
    assert.equal(isAllowedNewServicePort(20000), true);
    assert.equal(isAllowedNewServicePort(32000), true);
    assert.equal(isAllowedNewServicePort(19999), false);
    assert.equal(isAllowedNewServicePort(32001), false);
  });

  test('the whole 27000-27999 thousand is excluded, edges included', () => {
    assert.equal(isAllowedNewServicePort(26999), true);
    assert.equal(isAllowedNewServicePort(27000), false);
    assert.equal(isAllowedNewServicePort(27124), false, 'the plugin factory port');
    assert.equal(isAllowedNewServicePort(27181), false, 'Roland\'s historic base');
    assert.equal(isAllowedNewServicePort(27999), false);
    assert.equal(isAllowedNewServicePort(28000), true);
  });

  test('nothing in the band reaches an ephemeral range', () => {
    // Linux starts at 32768, Windows at 49152. The band's ceiling is what keeps
    // BOTH members of a pair below the lower of the two.
    for (const p of allowedPairBases()) {
      assert.ok(p + policyOffset() < 32768, `${p} + offset reaches the ephemeral range`);
    }
  });

  test('a non-port is never allowed', () => {
    for (const bad of [0, -1, 1.5, '27124', null, undefined, NaN, {}, 70000]) {
      assert.equal(isAllowedNewServicePort(bad), false, `${JSON.stringify(bad)}`);
    }
  });
});

describe('allowedPairBases — the second port is checked, never assumed', () => {
  test('a base whose partner falls outside the band is refused', () => {
    // ► MUTATION WITNESS: drop the `p + offset` check in allowedPairBases and
    //   32000 (whose partner is 32010) becomes a legal base.
    const bases = allowedPairBases();
    assert.ok(!bases.includes(32000), '32000 pairs with 32010, which is out of band');
    assert.ok(!bases.includes(31991), '31991 pairs with 32001, one past the ceiling');
    assert.ok(bases.includes(31990), '31990 pairs with 32000, the last legal pair');
  });

  test('a base just below an exclusion is refused when its partner lands inside', () => {
    const bases = allowedPairBases();
    assert.ok(!bases.includes(26999), '26999 pairs with 27009, inside the excluded thousand');
    assert.ok(bases.includes(26989), '26989 pairs with 26999, the last one clear of it');
  });

  test('the candidate set is finite and ascending', () => {
    const bases = allowedPairBases();
    assert.ok(bases.length > 0);
    for (let i = 1; i < bases.length; i += 1) assert.ok(bases[i] > bases[i - 1]);
  });
});

describe('choosePortStart', () => {
  test('draws only from bases whose BOTH ports are free', () => {
    // ► MUTATION WITNESS (HTTP reservations): drop `reserved.has(p + offset)`
    //   and 20000 becomes drawable even though 20010 is taken.
    const reserved = new Set([20010]);
    const { portStart } = choosePortStart({ reservedPorts: reserved, randomInt: firstOf });
    assert.notEqual(portStart, 20000);
    assert.equal(portStart, 20001);
  });

  test('never redraws the base it is replacing', () => {
    const { portStart } = choosePortStart({
      previousPortStart: 20000,
      randomInt: firstOf,
    });
    assert.notEqual(portStart, 20000);
  });

  test('an exhausted space fails finitely, and does not step outside the band', () => {
    const tiny = { min: 20000, max: 20020, exclusions: [], offset: 10 };
    const everything = new Set();
    for (let p = 20000; p <= 20020; p += 1) everything.add(p);
    const out = choosePortStart({ policy: tiny, reservedPorts: everything, randomInt: firstOf });
    assert.equal(out.portStart, null);
    assert.equal(out.reason, 'exhausted');
    assert.ok(out.candidatesExamined > 0);
  });

  test('a policy that allows nothing is reported as such, not as exhausted', () => {
    const empty = { min: 20000, max: 20000, exclusions: [{ from: 20000, to: 20000 }], offset: 10 };
    const out = choosePortStart({ policy: empty, randomInt: firstOf });
    assert.equal(out.reason, 'policy-empty');
  });

  test('the draw uses the injected randomness and nothing else', () => {
    // No MAC address, no interface order, no hostname anywhere in the path:
    // pinning randomInt pins the answer completely.
    const a = choosePortStart({ randomInt: () => 5 });
    const b = choosePortStart({ randomInt: () => 5 });
    assert.equal(a.portStart, b.portStart);
    const c = choosePortStart({ randomInt: () => 6 });
    assert.notEqual(a.portStart, c.portStart);
  });

  test('an out-of-range index from randomInt cannot escape the candidate set', () => {
    const bases = allowedPairBases();
    const high = choosePortStart({ randomInt: () => 10 ** 9 });
    const low = choosePortStart({ randomInt: () => -5 });
    assert.ok(bases.includes(high.portStart));
    assert.ok(bases.includes(low.portStart));
  });

  test('refuses to run without an injected randomness source', () => {
    assert.throws(() => choosePortStart({}), TypeError);
  });
});

describe('orderedPairCandidates — deterministic and circular', () => {
  test('starts at the first allowed base at or after portStart', () => {
    const out = orderedPairCandidates(25000);
    assert.equal(out[0], 25000);
  });

  test('a base inside the excluded thousand is an ordinary case, not an error', () => {
    // Roland's installation is portStart 27181 — inside the exclusion, kept by
    // invariant I7. The walk must simply find the first allowed base after it.
    const out = orderedPairCandidates(27181);
    assert.equal(out[0], 28000);
    assert.equal(out.length, allowedPairBases().length, 'wrapping must not lose candidates');
  });

  test('wraps to the bottom of the band, exactly once', () => {
    const out = orderedPairCandidates(31990);
    assert.equal(out[0], 31990);
    assert.equal(out[1], 20000);
    assert.equal(new Set(out).size, out.length, 'a candidate was visited twice');
  });

  test('a portStart past the top of the band still yields the whole set', () => {
    const out = orderedPairCandidates(60000);
    assert.equal(out.length, allowedPairBases().length);
    assert.equal(out[0], 20000);
  });
});

// ---------------------------------------------------------------------------
// The installation's identity
// ---------------------------------------------------------------------------

describe('planInstallationInitialization', () => {
  test('a fresh installation gets an identity and a base, once', () => {
    const out = planInstallationInitialization({}, {
      hostname: 'ROLAND-PC',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    assert.equal(out.nextConfig.installId, UUID_A);
    assert.equal(out.nextConfig.installHostname, 'ROLAND-PC');
    assert.equal(out.nextConfig.portStart, 20000);
    assert.equal(out.issues.length, 0);
  });

  test('a second initialization changes nothing at all', () => {
    const first = planInstallationInitialization({}, {
      hostname: 'ROLAND-PC',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    const second = planInstallationInitialization(first.nextConfig, {
      hostname: 'ROLAND-PC',
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      randomInt: () => 7,
    });
    assert.deepEqual(second.changes, []);
    assert.equal(second.nextConfig.installId, UUID_A);
    assert.equal(second.nextConfig.portStart, first.nextConfig.portStart);
  });

  test('an existing base is kept, out-of-band or not', () => {
    // ► MUTATION WITNESS: make initialization recompute portStart and Roland's
    //   27181 is replaced on the next start-up. Invariant I7.
    const out = planInstallationInitialization({ portStart: 27181 }, {
      hostname: 'ROLAND-PC',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    assert.equal(out.nextConfig.portStart, 27181);
    assert.ok(!out.changes.some((c) => c.field === 'portStart'));
    // AND kept for the RIGHT REASON. Without this line the test also passes
    // when the valid-base branch is broken and 27181 merely falls through to
    // the "damaged, do not replace" branch — measured, 2026-09-09: a first
    // mutation run left this witness green while the branch it guards was
    // disabled. A valid base must raise nothing.
    assert.deepEqual(out.issues, [], 'a perfectly valid base must not be diagnosed');
  });

  test('a historic installation gains an identity without its base moving', () => {
    const out = planInstallationInitialization({ portStart: 27181, portRegistry: {} }, {
      hostname: 'ROLAND-PC',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    assert.equal(out.nextConfig.installId, UUID_A);
    assert.equal(out.nextConfig.portStart, 27181);
    assert.deepEqual(out.changes.map((c) => c.field).sort(), ['installHostname', 'installId']);
  });

  test('a different hostname regenerates nothing', () => {
    const base = { installId: UUID_A, installHostname: 'OLD-NAME', portStart: 27181 };
    const out = planInstallationInitialization(base, {
      hostname: 'RENAMED-PC',
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      randomInt: () => 3,
    });
    assert.deepEqual(out.changes, []);
    assert.equal(out.nextConfig.installId, UUID_A);
    assert.equal(out.nextConfig.installHostname, 'OLD-NAME', 'the label records attribution time');
  });

  test('a damaged installId is diagnosed, never replaced', () => {
    const out = planInstallationInitialization({ installId: 'not-a-uuid', portStart: 27181 }, {
      hostname: 'X',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    assert.equal(out.nextConfig.installId, 'not-a-uuid');
    assert.ok(out.issues.some((i) => i.kind === 'invalid-install-id'));
    assert.ok(!out.changes.some((c) => c.field === 'installId'));
  });

  test('a damaged portStart is diagnosed, never replaced', () => {
    const out = planInstallationInitialization({ installId: UUID_A, portStart: 'abc' }, {
      hostname: 'X',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
    });
    assert.equal(out.nextConfig.portStart, 'abc');
    assert.ok(out.issues.some((i) => i.kind === 'invalid-port-start'));
  });

  test('the input config is never mutated', () => {
    const cfg = { portRegistry: {} };
    const frozenCopy = JSON.stringify(cfg);
    planInstallationInitialization(cfg, { hostname: 'X', randomUUID: () => UUID_A, randomInt: firstOf });
    assert.equal(JSON.stringify(cfg), frozenCopy);
  });

  test('unrelated configuration survives untouched', () => {
    const cfg = { portRegistry: { '/v': { https: 27172, http: 27145 } }, vaultNames: { '/v': 'tribu' } };
    const out = planInstallationInitialization(cfg, { hostname: 'X', randomUUID: () => UUID_A, randomInt: firstOf });
    assert.deepEqual(out.nextConfig.portRegistry, cfg.portRegistry);
    assert.deepEqual(out.nextConfig.vaultNames, cfg.vaultNames);
  });

  test('an exhausted band produces an issue, not a base outside it', () => {
    const tiny = { min: 20000, max: 20005, exclusions: [], offset: 10 };
    const out = planInstallationInitialization({}, {
      hostname: 'X',
      randomUUID: () => UUID_A,
      randomInt: firstOf,
      policy: tiny,
    });
    assert.equal(out.nextConfig.portStart, undefined);
    assert.ok(out.issues.some((i) => i.kind === 'port-space-exhausted'));
  });
});

describe('isValidUuid / installationOwnerRef', () => {
  test('accepts a real UUID and rejects near-misses', () => {
    assert.equal(isValidUuid(UUID_A), true);
    for (const bad of ['', 'x', UUID_A.slice(0, -1), `${UUID_A}0`, UUID_A.replace(/-/g, ''), null, 42, {}]) {
      assert.equal(isValidUuid(bad), false, JSON.stringify(bad));
    }
  });

  test('an owner reference carries the UUID and a label, and nothing else', () => {
    const ref = installationOwnerRef({ installId: UUID_A, installHostname: 'ROLAND-PC', portStart: 27181 });
    assert.deepEqual(Object.keys(ref).sort(), ['hostname', 'installId']);
  });

  test('an installation without a valid identity owns nothing', () => {
    assert.equal(installationOwnerRef({ installHostname: 'ROLAND-PC' }), null);
    assert.equal(installationOwnerRef({ installId: 'nope' }), null);
  });
});

// ---------------------------------------------------------------------------
// Asking the operating system
// ---------------------------------------------------------------------------

describe('probeLoopbackPort — a real socket, really opened', () => {
  test('a really-open socket makes the candidate unavailable', async () => {
    // ► MUTATION WITNESS: remove the probe from allocateAvailablePortPair (or
    //   make an error read as "free") and this port is handed to a new vault
    //   while something is sitting on it.
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const { port } = server.address();
    try {
      const taken = await probeLoopbackPort(port);
      assert.equal(taken.available, false);
      assert.ok(taken.reason, 'a refusal must carry a reason');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a free port answers available, and the probe lets it go again', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));

    const first = await probeLoopbackPort(port);
    assert.equal(first.available, true);
    // The whole point of releasing the socket: a second probe of the same port
    // must not see the first one. A leak here would make every candidate after
    // the first look taken by this process.
    const second = await probeLoopbackPort(port);
    assert.equal(second.available, true);
  });

  test('a non-port is refused without touching the network', async () => {
    for (const bad of [0, -1, 70000, 'x', null, undefined, 1.5]) {
      const out = await probeLoopbackPort(bad);
      assert.equal(out.available, false, JSON.stringify(bad));
      assert.equal(out.reason, 'not-a-port');
    }
  });

  test('a timeout is not a free port', async () => {
    const out = await probeLoopbackPort(20000, { host: '203.0.113.1', timeoutMs: 1 });
    // Either the OS refuses the address outright or the clock runs out; both
    // are `false`. What must never happen is `true`.
    assert.equal(out.available, false);
  });

  test('the pair probe short-circuits on the first taken port', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve));
    const { port } = server.address();
    try {
      const out = await probeLoopbackPair(port, port + 1);
      assert.equal(out.available, false);
      assert.equal(out.port, port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// The allocator
// ---------------------------------------------------------------------------

describe('allocateAvailablePortPair', () => {
  const alwaysFree = async () => ({ available: true, reason: null });

  test('a new vault gets a pair inside the band, both members', async () => {
    const cfg = { portStart: 27181, portRegistry: {} };
    const pair = await allocateAvailablePortPair(cfg, '/vaults/new', { probePort: alwaysFree });
    assert.equal(isAllowedNewServicePort(pair.https), true);
    assert.equal(isAllowedNewServicePort(pair.http), true);
    assert.ok(pair.https < 27000 || pair.https > 27999, 'allocated inside the excluded thousand');
    assert.ok(pair.http <= 32000);
    assert.equal(pair.reused, false);
  });

  test('a registered vault gets its own historic pair back, out-of-band or not', async () => {
    // Invariant I6 + I1: 27172/27145 is `tribu`, whose gap is NEGATIVE, and
    // whose plaintext port is written into click-to-open links in the notes.
    const cfg = { portStart: 27181, portRegistry: { '/vaults/tribu': { https: 27172, http: 27145 } } };
    const pair = await allocateAvailablePortPair(cfg, '/vaults/tribu', { probePort: alwaysFree });
    assert.equal(pair.https, 27172);
    assert.equal(pair.http, 27145);
    assert.equal(pair.reused, true);
    assert.equal(pair.probed, 0, 'a reused pair must not be probed — it is in use by its own vault');
  });

  test('a port reserved as HTTP elsewhere is not offered as HTTPS', async () => {
    // ► MUTATION WITNESS: reserve only the HTTPS space and this allocation
    //   hands 28000 to a second vault while another already binds it as HTTP.
    const cfg = {
      portStart: 28000,
      portRegistry: { '/vaults/other': { https: 21000, http: 28000 } },
    };
    const pair = await allocateAvailablePortPair(cfg, '/vaults/new', { probePort: alwaysFree });
    assert.notEqual(pair.https, 28000);
    assert.notEqual(pair.http, 28000);
  });

  test('the disk is reserved too, not only the registry', async () => {
    const cfg = { portStart: 28000, portRegistry: { '/vaults/other': {} } };
    const onDisk = new Map([['/vaults/other', { port: 28000, insecurePort: 28010 }]]);
    const pair = await allocateAvailablePortPair(cfg, '/vaults/new', { onDisk, probePort: alwaysFree });
    assert.notEqual(pair.https, 28000);
    assert.notEqual(pair.https, 28010);
  });

  test('a port the OS says is taken is skipped', async () => {
    const cfg = { portStart: 28000, portRegistry: {} };
    const taken = new Set([28000, 28010]);
    const probePort = async (p) => ({ available: !taken.has(p), reason: taken.has(p) ? 'EADDRINUSE' : null });
    const pair = await allocateAvailablePortPair(cfg, '/vaults/new', { probePort });
    assert.notEqual(pair.https, 28000);
    assert.ok(pair.probed > 0);
  });

  test('a probe that errors counts as taken, never as free', async () => {
    const cfg = { portStart: 28000, portRegistry: {} };
    const probePort = async (p) => (p === 28000 ? { available: false, reason: 'EACCES' } : { available: true, reason: null });
    const pair = await allocateAvailablePortPair(cfg, '/vaults/new', { probePort });
    assert.notEqual(pair.https, 28000);
  });

  test('an exhausted band throws a finite, explicit error and allocates nothing', async () => {
    const tiny = { min: 20000, max: 20015, exclusions: [], offset: 10 };
    const cfg = { portStart: 20000, portRegistry: {} };
    const probePort = async () => ({ available: false, reason: 'EADDRINUSE' });
    await assert.rejects(
      () => allocateAvailablePortPair(cfg, '/vaults/new', { policy: tiny, probePort }),
      (err) => {
        assert.match(err.message, /No allocatable port pair/);
        assert.match(err.message, /outside the band/);
        return true;
      },
    );
  });

  test('forceFresh refuses to hand back the source vault\'s pair', async () => {
    const cfg = { portStart: 28000, portRegistry: { '/vaults/copy': { https: 27172, http: 27145 } } };
    const pair = await allocateAvailablePortPair(cfg, '/vaults/copy', {
      probePort: alwaysFree,
      forceFresh: true,
    });
    assert.notEqual(pair.https, 27172);
    assert.equal(pair.reused, false);
  });
});

describe('the pure modules stay pure', () => {
  test('neither policy nor the allocator imports fs or the network', async () => {
    // A source scan, not a behavioural assertion: the point of the split is
    // that these two files can be reasoned about without a machine, and an
    // import added in a hurry is exactly how that stops being true.
    const fs = await import('node:fs/promises');
    for (const file of ['src/helpers/port-policy.mjs', 'src/helpers/port-registry.mjs', 'src/helpers/installation-identity.mjs']) {
      const src = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/^\s*import[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]);
      for (const spec of imports) {
        assert.ok(
          !/^node:(fs|net|http|https|dns|tls|child_process)/.test(spec),
          `${file} imports ${spec}`,
        );
      }
    }
  });
});
