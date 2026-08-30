/**
 * Two-port registry — the router's port bookkeeping, made aware of the SECOND
 * server every vault runs.
 *
 * THE DEFECT THIS CLOSES (found 2026-08-29, vault page
 * `allocateur-ports-aveugle-insecureport`). `config.json` used to memorise ONE
 * port per vault:
 *
 *     "portRegistry": { "C:\\VAULTS\\KIVIRI": 27140 }
 *
 * That is the HTTPS port. But every vault ALSO runs a plaintext HTTP server on
 * its `insecurePort` — the one the bridge's `/open/<path>` route serves, i.e.
 * the one every click-to-open link in every note is pinned to. The allocator
 * walked `Object.values(portRegistry)` and handed out the first absent number,
 * so it could hand a new vault a port already bound by another vault's
 * plaintext server. Measured, not theorised: 9 collisions on a 27-vault fleet,
 * one of them making a vault permanently unreachable (TLS call onto a
 * plaintext listener → ERR_SSL_WRONG_VERSION_NUMBER). The usual damage is
 * quieter: the second vault to open fails to bind and simply looks "offline".
 *
 * THE SHAPE. A registry value is now either the legacy number (still read, and
 * still written by nothing) or `{ https, http }`. Both forms are accepted
 * everywhere; `normalizePortEntry` is the single funnel.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, and that shape this whole module:
 *
 *   1. NEVER renumber an existing `insecurePort`. Those numbers are frozen
 *      into every click-to-open link already written in the user's notes
 *      (`http://127.0.0.1:<insecurePort>/open/…`). Renumbering one silently
 *      breaks links that were correct for months. When a conflict must be
 *      resolved, the HTTPS port is what moves. Nothing here ever proposes a
 *      new value for a port that already exists.
 *   2. NEVER hard-code the `+10` convention as if it were a fact. It is the
 *      convention `patchRestApiData` APPLIES to freshly provisioned vaults —
 *      it is not a law the fleet obeys: two vaults already escape it
 *      (DEDIBOX 27131/27162, the router vault 27132/27163). The source of
 *      truth for an EXISTING vault is its own `data.json`; the registry
 *      reflects that file, it does not predict it. The offset appears in this
 *      module in exactly one place — allocating a pair for a vault that does
 *      not exist yet.
 *
 * PURITY. Every function here is pure: no fs, no config writes. On-disk truth
 * arrives through the `onDisk` parameter (`vaultPath → { port, insecurePort }`)
 * built by the caller — synchronously in `setup-vault.mjs`, from the reads the
 * async registry loader already performs in `src/registry.mjs`. That split is
 * what lets one implementation serve a sync CLI and an async server, and lets
 * the tests drive it with fixtures instead of real vaults.
 *
 * SECRETS. The caller reads `data.json`, which also carries the vault's
 * `apiKey` AND its TLS private key. Only the two integers ever cross into this
 * module — nothing here can leak a credential because nothing here ever
 * receives one.
 */

import { cmp } from './total-order.mjs';
import { normalizePathForCompare } from './vault-path-identity.mjs';

/** The offset `patchRestApiData` applies when provisioning a NEW vault. */
export const DEFAULT_INSECURE_OFFSET = 10;

/** Highest legal TCP port. */
export const MAX_PORT = 65535;

/** Fallback when a config carries no `portStart` (mirrors DEFAULT_CONFIG). */
export const DEFAULT_PORT_START = 27124;

function isPort(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT;
}

/**
 * Normalize a raw `portRegistry` VALUE into `{ https, http }`.
 *
 * Accepts the legacy number (→ `{ https: n, http: null }` — `null` means
 * "unknown", never "none": the plaintext server exists, the registry just
 * never recorded it) and the current object form. Anything else normalizes to
 * two nulls rather than throwing, so one corrupt entry cannot take the router
 * down at load time.
 */
export function normalizePortEntry(value) {
  if (isPort(value)) return { https: value, http: null };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      https: isPort(value.https) ? value.https : null,
      http: isPort(value.http) ? value.http : null,
    };
  }
  return { https: null, http: null };
}

/** True when the value is already in the two-port object form. */
export function isTwoPortEntry(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The normalized entry for one vault path (registry declaration only).
 *
 * Exact key first — that is every real call. The folded fallback catches the
 * case where the caller holds a differently-cased spelling of the same
 * directory (a disk scan's casing vs the registry's), which on NTFS is not a
 * different vault. Without it, such a vault reads as unregistered and its
 * declared ports vanish from every reservation.
 */
export function portEntryOf(cfg, vaultPath) {
  const registry = (cfg && cfg.portRegistry) || {};
  if (Object.prototype.hasOwnProperty.call(registry, vaultPath)) {
    return normalizePortEntry(registry[vaultPath]);
  }
  const wanted = normalizePathForCompare(vaultPath);
  for (const key of Object.keys(registry)) {
    if (normalizePathForCompare(key) === wanted) return normalizePortEntry(registry[key]);
  }
  return normalizePortEntry(undefined);
}

/** The declared HTTPS port for a vault, or null. */
export function httpsPortOf(cfg, vaultPath) {
  return portEntryOf(cfg, vaultPath).https;
}

/** The declared plaintext port for a vault, or null when never recorded. */
export function insecurePortOf(cfg, vaultPath) {
  return portEntryOf(cfg, vaultPath).http;
}

/**
 * Coerce an `onDisk` argument (Map or plain object) into a lookup function,
 * folding path spellings the same way the rest of this module does.
 */
function diskLookup(onDisk) {
  if (!onDisk) return () => null;
  const isMap = typeof onDisk.get === 'function';
  const exact = isMap
    ? (k) => (onDisk.has(k) ? onDisk.get(k) : undefined)
    : (k) => (Object.prototype.hasOwnProperty.call(onDisk, k) ? onDisk[k] : undefined);
  const keys = () => (isMap ? [...onDisk.keys()] : Object.keys(onDisk));
  return (k) => {
    const hit = exact(k);
    if (hit !== undefined) return hit || null;
    const wanted = normalizePathForCompare(k);
    for (const key of keys()) {
      if (normalizePathForCompare(key) === wanted) return exact(key) || null;
    }
    return null;
  };
}

/**
 * Every vault path known to either source, registry order first, folded so
 * that two spellings of ONE directory appear once.
 *
 * The fold is not cosmetic. `C:\VAULTS\Kiviri Stack` and `C:\VAULTS\KIVIRI
 * STACK` are the same directory on NTFS; counted as two vaults they would look
 * like two servers fighting over one port — a false collision alarm about a
 * healthy fleet, raised at router startup where it would be believed. That
 * exact phantom appeared on the real 27-vault fleet on 2026-08-30, on 27141,
 * the moment a disk scan spelled a registry key differently.
 *
 * Pure by design (`normalizePathForCompare`, not `fs.realpathSync`): these
 * helpers must run against fixtures on a machine where none of the fleet's
 * drives are mounted.
 */
function allVaultPaths(cfg, onDisk) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    const key = normalizePathForCompare(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const p of Object.keys((cfg && cfg.portRegistry) || {})) add(p);
  const keys = onDisk
    ? (typeof onDisk.keys === 'function' ? [...onDisk.keys()] : Object.keys(onDisk))
    : [];
  for (const p of keys) add(p);
  return out;
}

/**
 * The EFFECTIVE ports of a vault: what it will actually bind.
 *
 * `data.json` wins over the registry, because `data.json` is what the plugin
 * reads — a registry entry that disagrees is a bookkeeping error, and the
 * process still binds the disk value. The registry value is kept in
 * `declared` so drift can be reported rather than silently overwritten.
 *
 * THREE STATES, NOT TWO — and conflating two of them produced a false alarm
 * (found in pre-release review, 2026-08-30). Per role, the disk can say:
 *   - a valid port      → that is what binds;
 *   - readable, absent  → NOTHING binds on that role. A stale registry number
 *                         must NOT be promoted to "effective" here, or the
 *                         report accuses two vaults of fighting over a port
 *                         that only one of them actually listens on;
 *   - unreadable        → genuinely unknown; the registry is the best guess.
 * `readable` distinguishes the last two. Note that `buildPortIndex` still
 * RESERVES a stale declaration either way — being off-limits for a new
 * allocation and being an active binding are different questions.
 */
export function effectivePortsOf(cfg, vaultPath, { onDisk } = {}) {
  const declared = portEntryOf(cfg, vaultPath);
  const disk = diskLookup(onDisk)(vaultPath);
  const readable = disk !== null && disk !== undefined;
  const diskHttps = readable && isPort(disk.port) ? disk.port : null;
  const diskHttp = readable && isPort(disk.insecurePort) ? disk.insecurePort : null;
  return {
    https: readable ? diskHttps : declared.https,
    http: readable ? diskHttp : declared.http,
    declared,
    disk: { https: diskHttps, http: diskHttp, readable },
  };
}

/**
 * Index every claimed port across BOTH spaces: `port → claimants[]`.
 *
 * A stale registry declaration is indexed alongside the disk value on
 * purpose. If the registry says 27141 and the disk says 27151, BOTH are
 * off-limits for a new vault: 27151 is bound right now, and 27141 is what a
 * repair would put back. Handing either one out would create the very
 * collision this module exists to prevent.
 */
export function buildPortIndex(cfg, { onDisk, exclude = null } = {}) {
  const index = new Map();
  const claim = (port, vaultPath, role, source) => {
    if (!isPort(port)) return;
    if (!index.has(port)) index.set(port, []);
    const claimants = index.get(port);
    if (claimants.some((c) => c.vaultPath === vaultPath && c.role === role && c.source === source)) return;
    claimants.push({ vaultPath, role, source });
  };

  const excludeKey = exclude === null ? null : normalizePathForCompare(exclude);
  for (const vaultPath of allVaultPaths(cfg, onDisk)) {
    // Folded compare: excluding the vault being allocated must work even when
    // the caller spells its path differently from the registry key.
    if (excludeKey !== null && normalizePathForCompare(vaultPath) === excludeKey) continue;
    const { declared, disk } = effectivePortsOf(cfg, vaultPath, { onDisk });
    claim(disk.https, vaultPath, 'https', 'disk');
    claim(disk.http, vaultPath, 'http', 'disk');
    // A declaration that differs from the disk (including "disk unknown") is
    // claimed too — see the docblock: both numbers must stay off-limits.
    if (declared.https !== null && declared.https !== disk.https) claim(declared.https, vaultPath, 'https', 'registry');
    if (declared.http !== null && declared.http !== disk.http) claim(declared.http, vaultPath, 'http', 'registry');
  }
  return index;
}

/** Flat set of every port reserved by any vault, in either space. */
export function reservedPortSet(cfg, { onDisk, exclude = null } = {}) {
  return new Set(buildPortIndex(cfg, { onDisk, exclude }).keys());
}

/**
 * Allocate a FREE PAIR of ports for a vault.
 *
 * The old `allocatePort` took the first number absent from the HTTPS-only
 * registry. This one requires BOTH members of the pair to be free in the
 * UNION of both spaces — that is the whole fix.
 *
 * An already-registered vault gets its existing pair back, never a new one
 * (rule 1: existing ports are frozen). `http` is filled from disk when the
 * registry never recorded it, so a re-run repairs the bookkeeping without
 * touching the vault.
 *
 * @returns {{ https: number, http: number|null, offset: number, reused: boolean }}
 * @throws when the scan runs off the end of the port space.
 */
export function allocatePortPair(cfg, vaultPath, {
  onDisk,
  insecureOffset = DEFAULT_INSECURE_OFFSET,
  portStart,
  forceFresh = false,
} = {}) {
  if (!Number.isInteger(insecureOffset) || insecureOffset < 1) {
    throw new Error(`insecureOffset must be a positive integer, got ${JSON.stringify(insecureOffset)}`);
  }
  const declared = portEntryOf(cfg, vaultPath);
  // `forceFresh` is for the one case where a registered entry must NOT be
  // honoured: the target is a byte-copy of the source vault and its registry
  // entry records the SOURCE's pair. Without it, the reuse branch below hands
  // the copy exactly the ports it was supposed to be renumbered off (found in
  // pre-release review, 2026-08-30 — deleting the target from the disk map was
  // not enough, because the registry alone was sufficient to trigger reuse).
  if (declared.https !== null && !forceFresh) {
    const disk = diskLookup(onDisk)(vaultPath);
    const diskHttp = disk && isPort(disk.insecurePort) ? disk.insecurePort : null;
    // DISK FIRST, not the registry. The vault binds what its data.json says; a
    // registry entry that disagrees is stale bookkeeping, and returning it here
    // would make the caller WRITE the stale number back over the live one —
    // renumbering an existing insecurePort, the one thing that must never
    // happen. The drift is reported by `detectPortCollisions` instead.
    return {
      https: declared.https,
      http: diskHttp ?? declared.http,
      offset: insecureOffset,
      reused: true,
    };
  }

  const reserved = reservedPortSet(cfg, { onDisk, exclude: vaultPath });
  const start = isPort(portStart) ? portStart
    : (isPort(cfg && cfg.portStart) ? cfg.portStart : DEFAULT_PORT_START);

  for (let p = start; p + insecureOffset <= MAX_PORT; p += 1) {
    const pair = p + insecureOffset;
    if (reserved.has(p) || reserved.has(pair)) continue;
    if (!isPort(p) || !isPort(pair)) continue;
    return { https: p, http: pair, offset: insecureOffset, reused: false };
  }
  throw new Error(
    `No free port pair (p, p+${insecureOffset}) available at or above ${start} — ` +
    `${reserved.size} port(s) are already claimed across the HTTPS and plaintext spaces. ` +
    `Lower portStart, or free ports by unregistering vaults you no longer use.`,
  );
}

/**
 * Pick a FREE plaintext port for a vault that has an HTTPS port but no
 * `insecurePort` at all — the pre-v0.10.x population `--upgrade-insecure-server`
 * was written for.
 *
 * Separate from `allocatePortPair` because the two situations differ: there,
 * neither port exists and both may move; here the HTTPS port is fixed and
 * live, and only the plaintext side is being created. Blindly writing
 * `https + offset` (what the code did before v0.77.0) is the SAME defect this
 * module exists to close, one level down: it assigns a plaintext port without
 * looking at what the fleet already binds.
 *
 * This never renumbers anything — it is only ever called for a vault that has
 * no plaintext port yet, so no click-to-open link can exist to break.
 *
 * @returns {number} the first free port at or above `httpsPort + offset`
 * @throws when the scan runs off the end of the port space.
 */
export function allocateInsecurePortFor(cfg, vaultPath, httpsPort, {
  onDisk,
  insecureOffset = DEFAULT_INSECURE_OFFSET,
} = {}) {
  if (!Number.isInteger(insecureOffset) || insecureOffset < 0) {
    throw new Error(`insecureOffset must be a non-negative integer, got ${JSON.stringify(insecureOffset)}`);
  }
  const reserved = reservedPortSet(cfg, { onDisk, exclude: vaultPath });
  // The vault's OWN HTTPS port is live and must not be handed to its own
  // plaintext server, even though excluding the vault removed it above.
  if (isPort(httpsPort)) reserved.add(httpsPort);
  const start = isPort(httpsPort) ? httpsPort + insecureOffset : DEFAULT_PORT_START + insecureOffset;
  for (let p = start; p <= MAX_PORT; p += 1) {
    if (!reserved.has(p)) return p;
  }
  throw new Error(
    `No free plaintext port available at or above ${start} — ${reserved.size} port(s) are ` +
    `already claimed across the HTTPS and plaintext spaces.`,
  );
}

/**
 * Rewrite a legacy (HTTPS-only) `portRegistry` into the two-port shape.
 *
 * NON-DESTRUCTIVE by construction: the plaintext port is only ever filled in
 * from the vault's own `data.json`. When the vault is unreadable — Obsidian
 * never opened it, the plugin was never activated, the drive is unplugged —
 * the entry keeps `http: null` and is reported as `unknown`. It is NOT
 * derived from `port + 10`: guessing here would write a fiction into the file
 * the allocator then trusts, which is exactly how a "+10 is a law" assumption
 * turns into the next collision.
 *
 * (The timestamped backup of the config FILE belongs to the caller that owns
 * the write — see `setup-vault.mjs`'s `backupConfigFile`. This function only
 * computes the new object.)
 *
 * @returns {{ changed: boolean, portRegistry: object, entries: Array }}
 */
export function migratePortRegistry(cfg, { onDisk } = {}) {
  const raw = (cfg && cfg.portRegistry) || {};
  const lookup = diskLookup(onDisk);
  const out = {};
  const entries = [];
  let changed = false;

  for (const [vaultPath, value] of Object.entries(raw)) {
    const normalized = normalizePortEntry(value);
    const disk = lookup(vaultPath);
    const diskHttps = disk && isPort(disk.port) ? disk.port : null;
    const diskHttp = disk && isPort(disk.insecurePort) ? disk.insecurePort : null;

    // DISK FIRST. The doc block above says "the registry reflects data.json";
    // preferring the registry here meant `--sync-port-registry` could never
    // correct a stale non-null value while its success message claimed the two
    // matched (found in pre-release review, 2026-08-30). No port on disk moves
    // — only the bookkeeping catches up — and the timestamped backup taken by
    // the caller makes it reversible.
    const https = diskHttps ?? normalized.https;
    if (https === null) {
      // Nothing usable from either source — preserve the raw value byte for
      // byte rather than replacing an unreadable entry with nulls. A migration
      // that erases what it could not interpret is not non-destructive.
      out[vaultPath] = value;
      entries.push({ vaultPath, before: value, after: value, status: 'unresolved', httpSource: 'none' });
      continue;
    }
    const http = diskHttp ?? normalized.http;
    const wasTwoPort = isTwoPortEntry(value);
    // Carry any extra properties through. The migration rewrites the SHAPE of
    // an entry, and a rewrite that silently drops a field somebody added by
    // hand (`{https, http, note: "reserved for X"}`) is not the lossless
    // operation this function promises (found in pre-release review).
    const after = wasTwoPort ? { ...value, https, http } : { https, http };
    out[vaultPath] = after;

    const same = wasTwoPort && normalized.https === https && normalized.http === http;
    if (!same) changed = true;
    entries.push({
      vaultPath,
      before: value,
      after,
      status: same ? 'unchanged' : (wasTwoPort ? 'completed' : 'migrated'),
      httpSource: diskHttp !== null ? 'disk' : (normalized.http !== null ? 'registry' : 'unknown'),
    });
  }

  return { changed, portRegistry: out, entries };
}

/**
 * Report what is WRONG with the current port layout, in words.
 *
 * This is the "make it legible" half of the fix. Today a port collision
 * presents as a vault that is simply "offline", with nothing anywhere saying
 * why — the second process to bind loses, silently. Three findings:
 *
 *   - `duplicate-port`  — one port, two or more vaults. The real failure.
 *   - `registry-drift`  — the registry and `data.json` disagree. Not fatal on
 *                         its own (the disk wins at bind time), but it means
 *                         the allocator was reasoning from a fiction.
 *   - `self-collision`  — one vault whose HTTPS and plaintext ports are equal;
 *                         its two servers fight each other.
 *
 * Severity: `error` for the two that break a bind, `warning` for drift.
 * Ordered by port then path so two runs on an unchanged fleet print the same
 * report.
 */
export function detectPortCollisions(cfg, { onDisk } = {}) {
  const findings = [];
  const roleLabel = { https: 'HTTPS port', http: 'plaintext insecurePort' };

  // 1. Duplicates over the union of both spaces, on EFFECTIVE values only —
  // a stale registry number that nothing binds is drift, not a duplicate.
  const byPort = new Map();
  for (const vaultPath of allVaultPaths(cfg, onDisk)) {
    const { https, http } = effectivePortsOf(cfg, vaultPath, { onDisk });
    for (const [role, port] of [['https', https], ['http', http]]) {
      if (!isPort(port)) continue;
      if (!byPort.has(port)) byPort.set(port, []);
      byPort.get(port).push({ vaultPath, role });
    }
  }
  for (const [port, claimants] of byPort) {
    const distinctVaults = new Set(claimants.map((c) => c.vaultPath));
    if (distinctVaults.size < 2) continue;
    // `cmp`, not localeCompare: this list is compared between runs (and read
    // by `--check-ports --json`), so it needs a real total order.
    const sorted = [...claimants].sort((a, b) => cmp(a.vaultPath, b.vaultPath));
    findings.push({
      kind: 'duplicate-port',
      severity: 'error',
      port,
      claimants: sorted,
      message:
        `Port ${port} is claimed by ${distinctVaults.size} vaults: ` +
        sorted.map((c) => `${c.vaultPath} (${roleLabel[c.role]})`).join(', ') +
        `. Only the first server to start binds it; the others fail to listen and ` +
        `appear "offline" with no error. If one is an HTTPS port and the other a ` +
        `plaintext port, a TLS call onto the plaintext listener fails with ` +
        `ERR_SSL_WRONG_VERSION_NUMBER. Move the HTTPS port — never the insecurePort, ` +
        `which is frozen into the click-to-open links already written in your notes.`,
    });
  }

  // 2. Registry-vs-disk drift, per vault, per role. Two shapes:
  //    (a) both sides have a value and they disagree;
  //    (b) the file is READABLE and has no value for this role, while the
  //        registry declares one. That number is not a binding — it is a port
  //        the registry holds out of circulation for a server that does not
  //        exist. Reporting it as drift rather than as a collision is the
  //        distinction that stops a false duplicate-port accusation
  //        (pre-release review, 2026-08-30).
  for (const vaultPath of allVaultPaths(cfg, onDisk)) {
    const { declared, disk } = effectivePortsOf(cfg, vaultPath, { onDisk });
    for (const role of ['https', 'http']) {
      const d = declared[role];
      const k = disk[role];
      if (d !== null && k === null && disk.readable) {
        findings.push({
          kind: 'registry-drift',
          severity: 'warning',
          vaultPath,
          role,
          declared: d,
          actual: null,
          port: d,
          message:
            `${vaultPath}: the registry declares ${roleLabel[role]} ${d}, but its data.json ` +
            `has no such port — nothing is listening on ${d} for this vault. The number is ` +
            `still held out of new allocations, so it is simply unusable until reconciled. ` +
            `Re-run \`setup-vault.mjs --sync-port-registry\`` +
            (role === 'http' ? `, or \`--upgrade-insecure-server\` to actually create the plaintext server.` : `.`),
        });
        continue;
      }
      if (d === null || k === null || d === k) continue;
      findings.push({
        kind: 'registry-drift',
        severity: 'warning',
        vaultPath,
        role,
        declared: d,
        actual: k,
        port: k,
        message:
          `${vaultPath}: the registry declares ${roleLabel[role]} ${d}, but its ` +
          `data.json binds ${k}. The vault works (the plugin reads data.json), and ` +
          `BOTH numbers are held out of new allocations — ${k} because it is bound, ` +
          `${d} because a repair would put it back — so ${d} is a port nobody can use ` +
          `until this is reconciled. Re-run \`setup-vault.mjs --sync-port-registry\` ` +
          `to make the registry reflect the disk.`,
      });
    }
  }

  // 3. A vault colliding with itself.
  for (const vaultPath of allVaultPaths(cfg, onDisk)) {
    const { https, http } = effectivePortsOf(cfg, vaultPath, { onDisk });
    if (isPort(https) && https === http) {
      findings.push({
        kind: 'self-collision',
        severity: 'error',
        vaultPath,
        port: https,
        message:
          `${vaultPath}: its HTTPS port and its plaintext insecurePort are both ${https}. ` +
          `The two servers cannot bind the same socket — one of them will not start.`,
      });
    }
  }

  findings.sort((a, b) => {
    const rank = { 'duplicate-port': 0, 'self-collision': 1, 'registry-drift': 2 };
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if ((a.port ?? 0) !== (b.port ?? 0)) return (a.port ?? 0) - (b.port ?? 0);
    return cmp(a.vaultPath ?? '', b.vaultPath ?? '');
  });
  return findings;
}

/** One-line summary of a findings list, or null when the fleet is clean. */
export function summarizePortCollisions(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return null;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const parts = [];
  if (errors) parts.push(`${errors} port collision${errors > 1 ? 's' : ''}`);
  if (warnings) parts.push(`${warnings} registry drift${warnings > 1 ? 's' : ''}`);
  return parts.join(' + ');
}
