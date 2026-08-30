/**
 * Tests for the two-port registry (`src/helpers/port-registry.mjs`) — v0.77.0.
 *
 * THE BUG UNDER TEST, stated once. `portRegistry` used to hold ONE port per
 * vault: the HTTPS one. Every vault also runs a plaintext HTTP server on its
 * `insecurePort` — the port every click-to-open link in every note points at.
 * The allocator scanned only the HTTPS column, so it could hand a brand-new
 * vault a port already bound by another vault's plaintext server. Measured on
 * 2026-08-29: 9 collisions across a 27-vault fleet, one of them permanently
 * unreachable (TLS call onto a plaintext listener → ERR_SSL_WRONG_VERSION_NUMBER).
 *
 * The three invariants these tests pin down, in order of importance:
 *
 *   1. An allocation NEVER returns a port occupied in either space.
 *   2. An existing `insecurePort` is NEVER renumbered — those numbers are
 *      frozen into links already written in the user's notes.
 *   3. The `+10` offset is a provisioning convention, never an assumption
 *      about vaults that already exist (two on this fleet escape it).
 *
 * Pure module, pure tests: on-disk truth is injected through `onDisk`, so no
 * fixture vaults and no fs are involved here. The fs-level proof that the CLI
 * honours all this lives in `tests/port-registry-cli.test.mjs`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_INSECURE_OFFSET,
  normalizePortEntry,
  isTwoPortEntry,
  portEntryOf,
  httpsPortOf,
  insecurePortOf,
  effectivePortsOf,
  buildPortIndex,
  reservedPortSet,
  allocatePortPair,
  allocateInsecurePortFor,
  migratePortRegistry,
  detectPortCollisions,
  summarizePortCollisions,
} from '../src/helpers/port-registry.mjs';

const A = 'C:\\VAULTS\\Alpha';
const B = 'C:\\VAULTS\\Beta';
const C = 'C:\\VAULTS\\Gamma';

describe('normalizePortEntry — the single funnel for both shapes', () => {
  test('legacy number becomes { https, http: null } — null means UNKNOWN, not "none"', () => {
    assert.deepEqual(normalizePortEntry(27124), { https: 27124, http: null });
  });

  test('two-port object passes through', () => {
    assert.deepEqual(normalizePortEntry({ https: 27131, http: 27162 }), { https: 27131, http: 27162 });
  });

  test('a half-filled object keeps the half it has', () => {
    assert.deepEqual(normalizePortEntry({ https: 27140 }), { https: 27140, http: null });
    assert.deepEqual(normalizePortEntry({ http: 27150 }), { https: null, http: 27150 });
  });

  test('junk normalizes to two nulls instead of throwing — one corrupt entry must not take the router down', () => {
    for (const junk of [null, undefined, 'nope', 0, -1, 70000, 27124.5, [27124], true]) {
      assert.deepEqual(normalizePortEntry(junk), { https: null, http: null }, `for ${JSON.stringify(junk)}`);
    }
  });

  test('isTwoPortEntry distinguishes the shapes', () => {
    assert.equal(isTwoPortEntry({ https: 1, http: 2 }), true);
    assert.equal(isTwoPortEntry(27124), false);
    assert.equal(isTwoPortEntry([27124]), false);
    assert.equal(isTwoPortEntry(null), false);
  });
});

describe('accessors', () => {
  const cfg = { portRegistry: { [A]: 27124, [B]: { https: 27131, http: 27162 } } };

  test('read either shape without the caller knowing which it got', () => {
    assert.equal(httpsPortOf(cfg, A), 27124);
    assert.equal(insecurePortOf(cfg, A), null);
    assert.equal(httpsPortOf(cfg, B), 27131);
    assert.equal(insecurePortOf(cfg, B), 27162);
  });

  test('an unregistered vault reads as two nulls, not as a throw', () => {
    assert.deepEqual(portEntryOf(cfg, C), { https: null, http: null });
  });
});

describe('effectivePortsOf — data.json wins over the registry', () => {
  test('the disk value is what the plugin binds, so it is the effective one', () => {
    const cfg = { portRegistry: { [A]: { https: 27141, http: 27151 } } };
    const onDisk = new Map([[A, { port: 27151, insecurePort: 27161 }]]);
    const eff = effectivePortsOf(cfg, A, { onDisk });
    assert.equal(eff.https, 27151, 'disk port wins');
    assert.equal(eff.http, 27161, 'disk insecurePort wins');
    assert.deepEqual(eff.declared, { https: 27141, http: 27151 }, 'the declaration is kept, so drift can be reported');
  });

  test('with no disk entry the registry declaration stands', () => {
    const cfg = { portRegistry: { [A]: { https: 27141, http: 27151 } } };
    assert.deepEqual(
      { https: effectivePortsOf(cfg, A).https, http: effectivePortsOf(cfg, A).http },
      { https: 27141, http: 27151 },
    );
  });
});

describe('allocatePortPair — THE FIX', () => {
  test('REFUSES a port occupied by another vault\'s insecurePort (the whole bug, in one assertion)', () => {
    // Beta binds 27125 as its PLAINTEXT port. The old allocator saw only the
    // HTTPS column — 27124 taken, 27125 "free" — and would have handed 27125
    // to the new vault, whose HTTPS server then fights Beta's HTTP server.
    const cfg = {
      portStart: 27124,
      portRegistry: {
        [A]: { https: 27124, http: 27134 },
        [B]: { https: 27115, http: 27125 },
      },
    };
    const pair = allocatePortPair(cfg, C, { onDisk: new Map() });
    assert.notEqual(pair.https, 27125, 'must not hand out a port bound by a plaintext server');
    assert.notEqual(pair.http, 27125);
    assert.equal(pair.https, 27126);
    assert.equal(pair.http, 27136);
  });

  test('both members of the pair must be free — a free p with a taken p+10 is rejected', () => {
    const cfg = {
      portStart: 27200,
      portRegistry: {
        // 27200 is free, but 27210 (its would-be plaintext partner) is bound.
        [A]: { https: 27190, http: 27210 },
      },
    };
    const pair = allocatePortPair(cfg, C, { onDisk: new Map() });
    assert.equal(pair.https, 27201, 'skipped 27200 because 27210 was taken');
    assert.equal(pair.http, 27211);
  });

  test('disk truth is honoured even when the registry never recorded the plaintext port (legacy config)', () => {
    // The legacy shape says nothing about plaintext ports. Reading data.json
    // is what keeps a legacy registry from being allocated over.
    const cfg = { portStart: 27124, portRegistry: { [A]: 27124 } };
    const onDisk = new Map([[A, { port: 27124, insecurePort: 27125 }]]);
    const pair = allocatePortPair(cfg, C, { onDisk });
    assert.notEqual(pair.https, 27125, 'the legacy entry hid this port; the disk revealed it');
    assert.equal(pair.https, 27126);
  });

  test('a stale registry declaration still reserves its port', () => {
    // Registry says 27141, disk says 27151. BOTH stay off-limits: 27151 is
    // bound right now, 27141 is what a repair would put back.
    const cfg = { portStart: 27140, portRegistry: { [A]: { https: 27141, http: 27152 } } };
    const onDisk = new Map([[A, { port: 27151, insecurePort: 27152 }]]);
    const reserved = reservedPortSet(cfg, { onDisk });
    assert.ok(reserved.has(27141), 'stale declaration reserved');
    assert.ok(reserved.has(27151), 'disk value reserved');
  });

  test('an already-registered vault gets its EXISTING pair back — never renumbered', () => {
    const cfg = { portStart: 27124, portRegistry: { [A]: { https: 27131, http: 27162 } } };
    const pair = allocatePortPair(cfg, A, { onDisk: new Map() });
    assert.deepEqual(
      { https: pair.https, http: pair.http, reused: pair.reused },
      { https: 27131, http: 27162, reused: true },
    );
  });

  test('re-allocation fills a missing plaintext port from disk WITHOUT moving the HTTPS one', () => {
    const cfg = { portStart: 27124, portRegistry: { [A]: 27131 } };
    const onDisk = new Map([[A, { port: 27131, insecurePort: 27162 }]]);
    const pair = allocatePortPair(cfg, A, { onDisk });
    assert.equal(pair.https, 27131, 'unchanged');
    assert.equal(pair.http, 27162, 'recovered from data.json — NOT derived as 27141');
  });

  test('the +10 offset is a default, not a law: an off-convention pair is respected as-is', () => {
    // DEDIBOX (27131/27162) and the router vault (27132/27163) really do
    // escape the convention. A helper that "knew" +10 would mis-reserve both.
    const cfg = {
      portStart: 27180,
      portRegistry: {
        [A]: { https: 27131, http: 27162 },
        [B]: { https: 27132, http: 27163 },
      },
    };
    const reserved = reservedPortSet(cfg, { onDisk: new Map() });
    for (const p of [27131, 27162, 27132, 27163]) assert.ok(reserved.has(p), `${p} reserved`);
    for (const p of [27141, 27142]) assert.equal(reserved.has(p), false, `${p} must NOT be assumed taken`);
  });

  test('a custom offset is honoured end to end', () => {
    const cfg = { portStart: 27300, portRegistry: {} };
    const pair = allocatePortPair(cfg, C, { onDisk: new Map(), insecureOffset: 50 });
    assert.deepEqual({ https: pair.https, http: pair.http }, { https: 27300, http: 27350 });
    assert.equal(DEFAULT_INSECURE_OFFSET, 10, 'the shipped default stays 10');
  });

  test('the vault being allocated does not count as its own competitor', () => {
    const cfg = { portStart: 27124, portRegistry: {} };
    const onDisk = new Map([[C, { port: 27124, insecurePort: 27134 }]]);
    const pair = allocatePortPair(cfg, C, { onDisk });
    assert.equal(pair.https, 27124, 'its own current ports must not push it off them');
  });

  test('throws (rather than returning an illegal port) when the space is exhausted', () => {
    const registry = {};
    for (let p = 65500; p <= 65535; p += 1) registry[`V${p}`] = { https: p, http: p };
    assert.throws(
      () => allocatePortPair({ portStart: 65500, portRegistry: registry }, C, { onDisk: new Map() }),
      /No free port pair/,
    );
  });
});

describe('allocateInsecurePortFor — creating a plaintext port that never existed', () => {
  // The pre-v0.10.x population: a vault with a live HTTPS port and no
  // `insecurePort` at all. Before v0.77.0 the code wrote `port + 10` blind,
  // which is the same defect one level down — assigning a plaintext port
  // without looking at what the fleet already binds.
  test('skips the conventional offset when it is already taken', () => {
    const cfg = {
      portRegistry: {
        [A]: { https: 27124, http: 27134 },
        [B]: { https: 27200, http: 27210 },
      },
    };
    // C is live on 27190; 27200 (its +10) belongs to B's HTTPS server.
    assert.equal(allocateInsecurePortFor(cfg, C, 27190, { onDisk: new Map() }), 27201);
  });

  test('uses the conventional offset when it is free', () => {
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27134 } } };
    assert.equal(allocateInsecurePortFor(cfg, C, 27300, { onDisk: new Map() }), 27310);
  });

  test('never returns the vault\'s own HTTPS port', () => {
    // Excluding the vault removes its own ports from the reserved set, so the
    // guard has to put the live HTTPS port back explicitly.
    const cfg = { portRegistry: { [C]: { https: 27310, http: null } } };
    const got = allocateInsecurePortFor(cfg, C, 27310, { onDisk: new Map(), insecureOffset: 0 });
    assert.notEqual(got, 27310, 'its two servers cannot share one socket');
    assert.equal(got, 27311);
  });

  test('honours disk truth, not just the registry', () => {
    const cfg = { portRegistry: { [A]: 27124 } };
    const onDisk = new Map([[A, { port: 27124, insecurePort: 27200 }]]);
    assert.equal(allocateInsecurePortFor(cfg, C, 27190, { onDisk }), 27201);
  });
});

describe('migratePortRegistry — non-destructive by construction', () => {
  test('legacy numbers become pairs, plaintext read from each vault\'s data.json', () => {
    const cfg = { portRegistry: { [A]: 27124, [B]: 27131 } };
    const onDisk = new Map([
      [A, { port: 27124, insecurePort: 27134 }],
      [B, { port: 27131, insecurePort: 27162 }],
    ]);
    const { changed, portRegistry, entries } = migratePortRegistry(cfg, { onDisk });
    assert.equal(changed, true);
    assert.deepEqual(portRegistry[A], { https: 27124, http: 27134 });
    assert.deepEqual(portRegistry[B], { https: 27131, http: 27162 }, 'off-convention pair preserved, not "corrected" to 27141');
    assert.equal(entries.every((e) => e.httpSource === 'disk'), true);
  });

  test('an unreadable vault gets http: null — NEVER a guessed port+10', () => {
    // This is the rule that stops a fiction from being written into the file
    // the allocator then trusts.
    const cfg = { portRegistry: { [A]: 27124 } };
    const { portRegistry, entries } = migratePortRegistry(cfg, { onDisk: new Map() });
    assert.deepEqual(portRegistry[A], { https: 27124, http: null });
    assert.notEqual(portRegistry[A].http, 27134, 'the convention must not be invented here');
    assert.equal(entries[0].httpSource, 'unknown');
  });

  test('NO LOSS: every key survives, and every declared HTTPS port is unchanged', () => {
    const cfg = {
      portRegistry: {
        [A]: 27124,
        [B]: { https: 27131, http: 27162 },
        [C]: 27140,
      },
    };
    const before = JSON.parse(JSON.stringify(cfg.portRegistry));
    const { portRegistry } = migratePortRegistry(cfg, {
      onDisk: new Map([[A, { port: 27124, insecurePort: 27134 }]]),
    });
    assert.deepEqual(Object.keys(portRegistry), Object.keys(before), 'no key added or dropped');
    for (const key of Object.keys(before)) {
      assert.equal(
        normalizePortEntry(portRegistry[key]).https,
        normalizePortEntry(before[key]).https,
        `${key}: HTTPS port must not move`,
      );
    }
    assert.deepEqual(cfg.portRegistry, before, 'the input config is not mutated');
  });

  test('is idempotent — a second run reports no change', () => {
    const onDisk = new Map([[A, { port: 27124, insecurePort: 27134 }]]);
    const once = migratePortRegistry({ portRegistry: { [A]: 27124 } }, { onDisk });
    const twice = migratePortRegistry({ portRegistry: once.portRegistry }, { onDisk });
    assert.equal(twice.changed, false);
    assert.deepEqual(twice.portRegistry, once.portRegistry);
  });

  test('an entry that resolves to nothing usable is preserved verbatim, not nulled out', () => {
    const cfg = { portRegistry: { [A]: 'corrupted' } };
    const { portRegistry, entries } = migratePortRegistry(cfg, { onDisk: new Map() });
    assert.equal(portRegistry[A], 'corrupted', 'a migration that erases what it cannot read is not non-destructive');
    assert.equal(entries[0].status, 'unresolved');
  });

  test('an unreadable-at-the-time entry is completed later, once the vault opens', () => {
    const first = migratePortRegistry({ portRegistry: { [A]: 27124 } }, { onDisk: new Map() });
    assert.equal(first.portRegistry[A].http, null);
    const second = migratePortRegistry(
      { portRegistry: first.portRegistry },
      { onDisk: new Map([[A, { port: 27124, insecurePort: 27134 }]]) },
    );
    assert.equal(second.changed, true);
    assert.equal(second.portRegistry[A].http, 27134);
    assert.equal(second.entries[0].status, 'completed');
  });
});

describe('detectPortCollisions — making the silent failure legible', () => {
  test('two vaults on one port, across the two spaces, is an error-level finding', () => {
    // The measured shape: Alpha serves TLS on 27151, Beta serves plaintext on
    // the same 27151. Second to start fails to bind and looks "offline".
    const cfg = {
      portRegistry: {
        [A]: { https: 27151, http: 27161 },
        [B]: { https: 27141, http: 27151 },
      },
    };
    const findings = detectPortCollisions(cfg, { onDisk: new Map() });
    const dup = findings.filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].port, 27151);
    assert.equal(dup[0].severity, 'error');
    assert.equal(dup[0].claimants.length, 2);
    assert.match(dup[0].message, /ERR_SSL_WRONG_VERSION_NUMBER/);
    assert.match(dup[0].message, /never the insecurePort/, 'the fix must name which port may move');
  });

  test('a clean fleet reports nothing', () => {
    const cfg = {
      portRegistry: {
        [A]: { https: 27124, http: 27134 },
        [B]: { https: 27125, http: 27135 },
      },
    };
    assert.deepEqual(detectPortCollisions(cfg, { onDisk: new Map() }), []);
    assert.equal(summarizePortCollisions([]), null);
  });

  test('registry-vs-disk drift is a warning, and says which side wins', () => {
    const cfg = { portRegistry: { [A]: { https: 27141, http: 27151 } } };
    const onDisk = new Map([[A, { port: 27151, insecurePort: 27161 }]]);
    const findings = detectPortCollisions(cfg, { onDisk });
    const drift = findings.filter((f) => f.kind === 'registry-drift');
    assert.equal(drift.length, 2, 'both roles drifted');
    assert.equal(drift[0].severity, 'warning');
    assert.match(drift.find((f) => f.role === 'https').message, /registry declares.*27141.*data\.json binds 27151/s);
  });

  test('a vault colliding with ITSELF is caught', () => {
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27124 } } };
    const findings = detectPortCollisions(cfg, { onDisk: new Map() });
    const self = findings.find((f) => f.kind === 'self-collision');
    assert.ok(self);
    assert.equal(self.severity, 'error');
  });

  test('an unregistered vault seen on disk still counts as a claimant', () => {
    // The fleet is bigger than the config: 27 vaults on disk, 23 registered.
    // A stray that binds a port must not be invisible to the report.
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27134 } } };
    const onDisk = new Map([[C, { port: 27134, insecurePort: 27144 }]]);
    const dup = detectPortCollisions(cfg, { onDisk }).filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].port, 27134);
    assert.deepEqual(dup[0].claimants.map((x) => x.vaultPath).sort(), [A, C].sort());
  });

  test('the report is deterministic — same fleet, same order', () => {
    const cfg = {
      portRegistry: {
        [A]: { https: 27151, http: 27161 },
        [B]: { https: 27141, http: 27151 },
        [C]: { https: 27141, http: 27171 },
      },
    };
    const once = detectPortCollisions(cfg, { onDisk: new Map() });
    const twice = detectPortCollisions(cfg, { onDisk: new Map() });
    assert.deepEqual(once, twice);
    assert.deepEqual(once.filter((f) => f.kind === 'duplicate-port').map((f) => f.port), [27141, 27151]);
  });

  test('summarizePortCollisions counts errors and warnings separately', () => {
    const cfg = {
      portRegistry: { [A]: { https: 27151, http: 27161 }, [B]: { https: 27141, http: 27151 } },
    };
    const onDisk = new Map([[C, { port: 27200, insecurePort: 27210 }]]);
    assert.match(summarizePortCollisions(detectPortCollisions(cfg, { onDisk })), /1 port collision/);
  });
});

describe('pre-release review fixes (2026-08-30)', () => {
  // Every test here corresponds to a finding from an adversarial review of the
  // fix itself. Most are the release's OWN defect class reappearing one level
  // down: a port written, reserved or reported without consulting both spaces.

  test('the reuse branch takes the DISK plaintext port, not a stale registry one', () => {
    // The caller WRITES what this returns. Returning the registry's stale
    // 27134 while the vault binds 27144 would renumber a live insecurePort —
    // the one thing that must never happen.
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27134 } } };
    const onDisk = new Map([[A, { port: 27124, insecurePort: 27144 }]]);
    const pair = allocatePortPair(cfg, A, { onDisk });
    assert.equal(pair.reused, true);
    assert.equal(pair.http, 27144, 'disk truth wins — the registry entry is drift, reported elsewhere');
  });

  test('forceFresh bypasses the registry entry, so a registered copy is really renumbered', () => {
    // Dropping the target from the disk map was not enough: its registry entry
    // alone sent the allocator down the reuse branch and handed the copy back
    // exactly the source ports it was supposed to move off.
    const cfg = {
      portStart: 27300,
      portRegistry: {
        [A]: { https: 27124, http: 27134 }, // the source
        [B]: { https: 27124, http: 27134 }, // a copy, registered with the SAME pair
      },
    };
    const onDisk = new Map([[A, { port: 27124, insecurePort: 27134 }]]);
    const reused = allocatePortPair(cfg, B, { onDisk });
    assert.equal(reused.https, 27124, 'without forceFresh it reuses — that was the bug');
    const fresh = allocatePortPair(cfg, B, { onDisk, forceFresh: true });
    assert.notEqual(fresh.https, 27124);
    assert.notEqual(fresh.http, 27134);
    assert.equal(fresh.reused, false);
  });

  test('a READABLE data.json with no insecurePort does not promote a stale registry port to "bound"', () => {
    // Alpha's file is readable and simply has no plaintext port — nothing binds
    // on that role. Its stale registry 27134 must not be reported as an active
    // binding colliding with Beta, which really does bind 27134.
    const cfg = {
      portRegistry: {
        [A]: { https: 27124, http: 27134 },
        [B]: { https: 27125, http: 27134 },
      },
    };
    const onDisk = new Map([
      [A, { port: 27124, insecurePort: null }], // readable, field absent
      [B, { port: 27125, insecurePort: 27134 }],
    ]);
    const dup = detectPortCollisions(cfg, { onDisk }).filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 0, 'only ONE vault actually binds 27134');
    // …but the stale declaration is still HELD OUT of new allocations.
    assert.ok(reservedPortSet(cfg, { onDisk }).has(27134));
    // …and it is reported as drift, which is the honest category.
    assert.ok(detectPortCollisions(cfg, { onDisk }).some((f) => f.kind === 'registry-drift'));
  });

  test('an UNREADABLE vault still falls back to its registry declaration', () => {
    // The counterpart: absent-from-the-map means "unknown", and there the
    // registry is the best information available.
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27134 }, [B]: { https: 27125, http: 27134 } } };
    const onDisk = new Map([[B, { port: 27125, insecurePort: 27134 }]]); // A unreadable
    const dup = detectPortCollisions(cfg, { onDisk }).filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 1, 'A is unknown, so its declared 27134 counts');
    assert.equal(dup[0].port, 27134);
  });

  test('migration CORRECTS a stale value from disk instead of preserving it', () => {
    // `--sync-port-registry` claims the registry matches every readable
    // data.json. It has to actually make that true.
    const cfg = { portRegistry: { [A]: { https: 27141, http: 27134 } } };
    const onDisk = new Map([[A, { port: 27151, insecurePort: 27144 }]]);
    const { changed, portRegistry } = migratePortRegistry(cfg, { onDisk });
    assert.equal(changed, true);
    assert.deepEqual(portRegistry[A], { https: 27151, http: 27144 });
  });

  test('migration keeps properties it does not understand', () => {
    const cfg = { portRegistry: { [A]: { https: 27124, http: null, note: 'reserved for the archive box' } } };
    const { portRegistry } = migratePortRegistry(cfg, {
      onDisk: new Map([[A, { port: 27124, insecurePort: 27134 }]]),
    });
    assert.equal(portRegistry[A].http, 27134);
    assert.equal(portRegistry[A].note, 'reserved for the archive box', 'a lossless rewrite keeps unknown fields');
  });

  test('a non-positive or fractional offset is refused rather than yielding an illegal port', () => {
    const cfg = { portStart: 27124, portRegistry: {} };
    for (const bad of [0, -1, 0.5, '10', null]) {
      assert.throws(() => allocatePortPair(cfg, C, { onDisk: new Map(), insecureOffset: bad }),
        /insecureOffset must be a positive integer/, `offset ${JSON.stringify(bad)}`);
    }
  });

  test('allocateInsecurePortFor throws rather than returning an out-of-range port', () => {
    const registry = {};
    for (let p = 65500; p <= 65535; p += 1) registry[`V${p}`] = { https: p, http: p };
    assert.throws(
      () => allocateInsecurePortFor({ portRegistry: registry }, C, 65530, { onDisk: new Map() }),
      /No free plaintext port/,
    );
  });
});

describe('path folding — one directory must not read as two vaults', () => {
  // Found by running the detector against a real 27-vault fleet on
  // 2026-08-30: a disk scan spelled a two-word vault directory in a different
  // case from its registry key, and the report claimed a port collision on
  // 27141 between a vault and itself. On NTFS those are ONE directory. A false
  // alarm raised at router startup is worse than no alarm — it would be
  // believed, and it would send someone renumbering a healthy vault.
  const LOWER = 'C:\\VAULTS\\Project Notes';
  const UPPER = 'C:\\VAULTS\\PROJECT NOTES';

  test('two spellings of one Windows directory do NOT produce a phantom collision', () => {
    const cfg = { portRegistry: { [LOWER]: { https: 27141, http: 27151 } } };
    const onDisk = new Map([[UPPER, { port: 27141, insecurePort: 27151 }]]);
    assert.deepEqual(detectPortCollisions(cfg, { onDisk }), []);
  });

  test('nor a phantom registry drift', () => {
    const cfg = { portRegistry: { [LOWER]: { https: 27141, http: 27151 } } };
    const onDisk = new Map([[UPPER, { port: 27141, insecurePort: 27151 }]]);
    const eff = effectivePortsOf(cfg, LOWER, { onDisk });
    assert.equal(eff.https, 27141);
    assert.equal(eff.disk.https, 27141, 'the disk entry is found despite the casing');
  });

  test('a genuinely different vault at the same port IS still reported', () => {
    // The fold must not swallow real collisions — and this case really does
    // exist on the measured fleet: two distinct `.template` directories on two
    // different drives, both still on the factory 27124/27134.
    const cfg = {
      portRegistry: {
        'C:\\VAULTS\\.template': { https: 27124, http: 27134 },
        'D:\\Vaults\\.template': { https: 27124, http: 27134 },
      },
    };
    const dup = detectPortCollisions(cfg, { onDisk: new Map() }).filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 2, 'both the HTTPS and the plaintext clash are reported');
    assert.deepEqual(dup.map((f) => f.port), [27124, 27134]);
  });

  test('POSIX paths stay case-SENSITIVE — two real directories, two vaults', () => {
    const cfg = {
      portRegistry: {
        '/srv/vaults/Alpha': { https: 27124, http: 27134 },
        '/srv/vaults/alpha': { https: 27124, http: 27134 },
      },
    };
    const dup = detectPortCollisions(cfg, { onDisk: new Map() }).filter((f) => f.kind === 'duplicate-port');
    assert.equal(dup.length, 2, 'on ext4 these are genuinely two vaults on one port');
  });

  test('allocation excludes the target even when spelled with different casing', () => {
    const cfg = { portStart: 27141, portRegistry: { [LOWER]: { https: 27141, http: 27151 } } };
    // Asking for the UPPER spelling must reuse the SAME registered pair, not
    // allocate a second one — that would move a live vault's ports.
    const pair = allocatePortPair(cfg, UPPER, { onDisk: new Map() });
    assert.deepEqual({ https: pair.https, http: pair.http, reused: pair.reused },
      { https: 27141, http: 27151, reused: true });
  });
});

describe('buildPortIndex — who claims what, and on whose authority', () => {
  test('claimants carry their vault, role and source', () => {
    const cfg = { portRegistry: { [A]: { https: 27141, http: 27151 } } };
    const index = buildPortIndex(cfg, { onDisk: new Map([[A, { port: 27151, insecurePort: 27151 }]]) });
    assert.deepEqual(
      index.get(27141),
      [{ vaultPath: A, role: 'https', source: 'registry' }],
      'the stale declaration is still a claim',
    );
    const at27151 = index.get(27151).map((x) => `${x.role}:${x.source}`).sort();
    assert.deepEqual(at27151, ['http:disk', 'https:disk']);
  });

  test('exclude drops one vault entirely from the picture', () => {
    const cfg = { portRegistry: { [A]: { https: 27124, http: 27134 }, [B]: { https: 27125, http: 27135 } } };
    const index = buildPortIndex(cfg, { onDisk: new Map(), exclude: A });
    assert.equal(index.has(27124), false);
    assert.equal(index.has(27134), false);
    assert.equal(index.has(27125), true);
  });
});
