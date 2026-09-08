/**
 * WHO this installation of the router is, as a durable identity.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INSTALLATION NEEDS A NAME AT ALL
 * ---------------------------------------------------------------------------
 * Because ownership of a vault's ports has to be attributable to something that
 * survives a rename. Two installations exist today — Roland's Windows box and
 * his son's machine — and they share vault folders through Google Drive,
 * `.obsidian/` included. When one of them wants to rewrite a vault's
 * `data.json`, the question "is this mine?" must have an answer that a renamed
 * machine, a restored backup or a second account cannot accidentally change.
 *
 * A hostname is NOT that answer. Two machines can carry the same label, one
 * machine can change its label on a Tuesday, and neither event has anything to
 * do with who set a vault up. Invariant I7 says it in one line: the machine
 * name is not an identity. So `installId` is a UUID, and `installHostname` is a
 * human-readable label recorded ONCE, at attribution time, and never used to
 * decide anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE REFUSES TO DO
 * ---------------------------------------------------------------------------
 * It never repairs. A configuration carrying an `installId` that is not a UUID,
 * or a `portStart` that is not a port, gets a DIAGNOSTIC and keeps its value —
 * it is not silently replaced. Silent replacement is how an installation loses
 * the identity that other machines' vaults still name as their owner, and the
 * loss would look exactly like a successful start-up.
 *
 * It never redraws an existing base. Invariant I7 again: if `portStart` is
 * valid, initialization keeps it, whatever the current policy would have
 * chosen. Roland's 27181 predates the band decided on 2026-09-09 and stays.
 * Only the explicit base-change command may move it.
 *
 * It never reacts to a changed hostname. A restored `config.json` on a second
 * PC will carry the SAME `installId` as the machine it came from — a real
 * hazard, and the honest answer to it is an explicit "reset this installation"
 * procedure, not an automatic regeneration triggered by a label that differs.
 * Guessing here would rewrite identity on the one day someone renamed a laptop.
 *
 * PURE. No `fs`, no `net`, no clock, no `os`. Both randomness sources are
 * injected, and NEITHER may be derived from a MAC address, an interface order
 * or any other hardware identifier.
 */

import { choosePortStart, DEFAULT_PORT_POLICY } from './port-policy.mjs';
import { MAX_PORT } from './port-registry.mjs';

/**
 * RFC 4122 shape, checked strictly.
 *
 * Deliberately not a loose "looks like hex with dashes" test: the whole value
 * of the field is that a damaged one is DETECTED rather than carried forward as
 * an owner nobody can match.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPort(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT;
}

/**
 * Decide what a config needs so that this installation has an identity and a
 * base — WITHOUT touching anything else in it.
 *
 * @param {object} cfg The router's config object, as read. Not mutated.
 * @param {object} args
 * @param {string} [args.hostname] A human label for this machine. Recorded only
 *        when none is recorded yet, because the field means "the label at the
 *        time the identity was created", not "the label today".
 * @param {() => string} args.randomUUID
 * @param {(min: number, max: number) => number} args.randomInt
 * @param {object} [args.policy]
 * @param {Set<number>|Iterable<number>} [args.reservedPorts]
 * @returns {{ nextConfig: object, changes: object[], issues: object[] }}
 *          `nextConfig` is a NEW object; `changes` is empty when nothing needs
 *          persisting, which is what makes a second initialization a no-op.
 */
export function planInstallationInitialization(cfg, {
  hostname = null,
  randomUUID,
  randomInt,
  policy = DEFAULT_PORT_POLICY,
  reservedPorts = new Set(),
} = {}) {
  if (typeof randomUUID !== 'function') {
    throw new TypeError('planInstallationInitialization requires a randomUUID() function');
  }
  if (typeof randomInt !== 'function') {
    throw new TypeError('planInstallationInitialization requires a randomInt(min, max) function');
  }

  const source = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const nextConfig = { ...source };
  const changes = [];
  const issues = [];

  // --- installId ------------------------------------------------------------
  if (isValidUuid(source.installId)) {
    // Already ours. Nothing to do, whatever the hostname says today.
  } else if (source.installId === undefined || source.installId === null) {
    const id = randomUUID();
    if (!isValidUuid(id)) {
      throw new Error('randomUUID() did not return a valid UUID');
    }
    nextConfig.installId = id;
    changes.push({ field: 'installId', from: null, to: id, reason: 'absent' });
  } else {
    // PRESENT AND WRONG. Kept as-is, on purpose. Replacing it would orphan
    // every vault out there that names this installation as its owner, and the
    // orphaning would be invisible.
    issues.push({
      kind: 'invalid-install-id',
      severity: 'error',
      message:
        'This installation\'s recorded identifier is not a valid UUID. It has NOT been ' +
        'replaced: a new identifier would silently orphan every vault that names this ' +
        'installation as its owner. Repair it explicitly, or reset the installation.',
    });
  }

  // --- installHostname ------------------------------------------------------
  // Written once, read never (by any authorization decision). A machine renamed
  // after the fact keeps the label it had when the identity was created, which
  // is the honest record; a changed hostname regenerates nothing.
  if (
    (source.installHostname === undefined || source.installHostname === null || source.installHostname === '') &&
    typeof hostname === 'string' &&
    hostname.length > 0
  ) {
    nextConfig.installHostname = hostname;
    changes.push({ field: 'installHostname', from: null, to: hostname, reason: 'absent' });
  }

  // --- portStart ------------------------------------------------------------
  if (isPort(source.portStart)) {
    // KEPT, unconditionally — including 27181, which the band decided on
    // 2026-09-09 would never have drawn. Invariant I7. The allocator's circular
    // walk starts here and finds the first base the policy does allow, so an
    // out-of-band base costs nothing and breaks nothing.
    if (source.portStart !== undefined) {
      // No change, no issue. Recorded here only so the reader sees the branch
      // was considered rather than forgotten.
    }
  } else if (source.portStart === undefined || source.portStart === null) {
    const draw = choosePortStart({ policy, reservedPorts, previousPortStart: null, randomInt });
    if (draw.portStart === null) {
      issues.push({
        kind: 'port-space-exhausted',
        severity: 'error',
        message:
          `No allocation base is available: ${draw.candidatesExamined} candidate base(s) fit the ` +
          'policy and none has both of its ports free. Widen the band or free ports; the router ' +
          'will not allocate outside the band.',
      });
    } else {
      nextConfig.portStart = draw.portStart;
      changes.push({
        field: 'portStart',
        from: null,
        to: draw.portStart,
        reason: 'absent',
        candidatesExamined: draw.candidatesExamined,
        candidatesFree: draw.candidatesFree,
      });
    }
  } else {
    issues.push({
      kind: 'invalid-port-start',
      severity: 'error',
      message:
        'The recorded allocation base is not a usable port number. It has NOT been replaced — ' +
        'a base is a deliberate setting, and overwriting a damaged one would hide the damage. ' +
        'Set it explicitly, or clear it so a new one can be drawn.',
    });
  }

  return { nextConfig, changes, issues };
}

/**
 * The identity of this installation, as it should be written into a vault it
 * owns. A LABEL travels with it; the UUID is what is ever compared.
 */
export function installationOwnerRef(cfg) {
  if (!isValidUuid(cfg?.installId)) return null;
  return {
    installId: cfg.installId,
    hostname: typeof cfg.installHostname === 'string' ? cfg.installHostname : null,
  };
}
