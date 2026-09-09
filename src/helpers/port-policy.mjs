/**
 * Which ports a NEW vault may be given, and how an installation's base is drawn.
 *
 * ---------------------------------------------------------------------------
 * THE BAND, AND WHY IT HAS THESE EDGES — decision D3, 2026-09-09
 * ---------------------------------------------------------------------------
 *   20000 … 32000 inclusive, minus 27000 … 27999 inclusive.
 *
 * The upper edge keeps BOTH ports of a pair below 32768, where Linux starts its
 * ephemeral range (Windows starts its own at 49152, so it does not bind here).
 * A port the kernel hands out to an outgoing connection is a port your server
 * may find taken at the worst possible moment.
 *
 * The 27000-27999 hole is the fleet's own history: the 54 ports configured on
 * the 27 production vaults all sit between 27124 and 27192, and Local REST
 * API's own factory settings are 27124/27123. Excluding the whole thousand is
 * cheaper to reason about than excluding a moving list, and it is what makes
 * the "distance" between old and new allocations REAL rather than a vague
 * margin: there is no notion of "far enough" anywhere in this module, only
 * membership.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RANDOM BASE IS NOT
 * ---------------------------------------------------------------------------
 * It is not a reserved range. Two installations that draw independently can
 * still collide — the draw only makes it unlikely that two machines creating
 * vaults in the same order land on the same numbers. Reservations from the
 * local registry and a real bind check against the OS are still both required,
 * and neither is replaced by the draw. Anyone who describes this as "your
 * installation owns a range" is describing something this code does not do.
 *
 * PURE. No `fs`, no `net`, no clock. `randomInt` is injected so a test can pin
 * the draw, and the candidate set is always built in full before anything is
 * drawn from it — there is no retry loop that could fail to terminate.
 */

// NO IMPORT FROM `port-registry.mjs`, deliberately. That module is the one
// that needs THIS one (its policy-aware allocator lives there), and an ESM
// cycle would leave `DEFAULT_PORT_POLICY` below reading a constant still in its
// temporal dead zone — a ReferenceError at import time, on a line that looks
// like a plain object literal. The two constants are restated here instead, and
// `tests/port-policy.test.mjs` pins them equal to the allocator's so the
// restatement cannot drift.
const MAX_PORT = 65535;
const DEFAULT_INSECURE_OFFSET = 10;

/**
 * The band decided on 2026-09-09. `exclusions` are INCLUSIVE ranges.
 *
 * Frozen so a caller cannot quietly widen the band for one call and leave the
 * next caller with a mutated default.
 */
export const DEFAULT_PORT_POLICY = Object.freeze({
  min: 20000,
  max: 32000,
  exclusions: Object.freeze([Object.freeze({ from: 27000, to: 27999 })]),
  offset: DEFAULT_INSECURE_OFFSET,
});

function isPort(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT;
}

/**
 * May a NEW service port be this number?
 *
 * "New" matters. A historic pair stays exactly where it is even when it falls
 * outside this band — invariant I6, and invariant I1 for the plaintext half.
 * This function is asked about ports being CREATED, never about ports that
 * already exist.
 */
export function isAllowedNewServicePort(port, policy = DEFAULT_PORT_POLICY) {
  if (!isPort(port)) return false;
  const min = Number.isInteger(policy?.min) ? policy.min : DEFAULT_PORT_POLICY.min;
  const max = Number.isInteger(policy?.max) ? policy.max : DEFAULT_PORT_POLICY.max;
  if (port < min || port > max) return false;
  const exclusions = Array.isArray(policy?.exclusions) ? policy.exclusions : [];
  for (const range of exclusions) {
    const from = Number.isInteger(range?.from) ? range.from : null;
    const to = Number.isInteger(range?.to) ? range.to : null;
    if (from === null || to === null) continue;
    if (port >= Math.min(from, to) && port <= Math.max(from, to)) return false;
  }
  return true;
}

/** The offset a policy uses between the two members of a NEW pair. */
export function policyOffset(policy = DEFAULT_PORT_POLICY) {
  const offset = policy?.offset;
  return Number.isInteger(offset) && offset >= 1 ? offset : DEFAULT_INSECURE_OFFSET;
}

/**
 * Every base `p` this policy would accept for a NEW pair — that is, every `p`
 * where BOTH `p` and `p + offset` are allowed.
 *
 * THE SECOND PORT IS CHECKED, NOT ASSUMED. A base one step below the top of
 * the band produces a partner above it, and a base just below an exclusion
 * produces a partner inside it. Both are rejected here, which is the only
 * reason the pair as a whole can be promised to stay in range.
 *
 * @returns {number[]} ascending, and finite by construction.
 */
export function allowedPairBases(policy = DEFAULT_PORT_POLICY) {
  const offset = policyOffset(policy);
  const min = Number.isInteger(policy?.min) ? policy.min : DEFAULT_PORT_POLICY.min;
  const max = Number.isInteger(policy?.max) ? policy.max : DEFAULT_PORT_POLICY.max;
  const bases = [];
  for (let p = min; p <= max; p += 1) {
    if (!isAllowedNewServicePort(p, policy)) continue;
    if (!isAllowedNewServicePort(p + offset, policy)) continue;
    bases.push(p);
  }
  return bases;
}

/**
 * Draw the base an installation will allocate from.
 *
 * Called ONCE for a fresh installation, and again only when the user explicitly
 * asks for a new base. An existing valid base is never redrawn — invariant I7,
 * and the reason Roland's 27181 survives every start-up.
 *
 * @param {object} args
 * @param {object} [args.policy]
 * @param {Set<number>|Iterable<number>} [args.reservedPorts] Ports already
 *        claimed anywhere the caller knows about — both protocols, registry and
 *        disk. A base is rejected if EITHER member of its pair is in here.
 * @param {number|null} [args.previousPortStart] Excluded from the draw, so that
 *        "give me a new base" cannot hand back the one being replaced.
 * @param {(min: number, max: number) => number} args.randomInt Half-open on the
 *        upper bound, like `crypto.randomInt`. Injected: the draw must be
 *        cryptographic in production and pinned in tests, and it must NEVER be
 *        derived from a MAC address, an interface order or a hostname.
 * @returns {{ portStart: number|null, candidatesExamined: number, candidatesFree: number, reason: string|null }}
 */
export function choosePortStart({
  policy = DEFAULT_PORT_POLICY,
  reservedPorts = new Set(),
  previousPortStart = null,
  randomInt,
} = {}) {
  if (typeof randomInt !== 'function') {
    throw new TypeError('choosePortStart requires a randomInt(min, max) function');
  }
  const offset = policyOffset(policy);
  const reserved = reservedPorts instanceof Set ? reservedPorts : new Set(reservedPorts || []);

  const examined = allowedPairBases(policy);
  const free = examined.filter(
    (p) => p !== previousPortStart && !reserved.has(p) && !reserved.has(p + offset),
  );

  if (free.length === 0) {
    // A FINITE, EXPLICIT failure. Never a retry loop, and never a fallback that
    // steps outside the band: overflowing the policy silently is how a new
    // vault ends up on an ephemeral port and breaks weeks later.
    return {
      portStart: null,
      candidatesExamined: examined.length,
      candidatesFree: 0,
      reason: examined.length === 0 ? 'policy-empty' : 'exhausted',
    };
  }

  const index = randomInt(0, free.length);
  const picked = free[Math.min(Math.max(index, 0), free.length - 1)];
  return {
    portStart: picked,
    candidatesExamined: examined.length,
    candidatesFree: free.length,
    reason: null,
  };
}

/**
 * The bases to try, in order, starting at `portStart` and wrapping once.
 *
 * DETERMINISTIC AND CIRCULAR. Starting at a base that the policy does not even
 * allow is an ordinary case, not an error: Roland's installation has
 * `portStart: 27181`, which sits inside the excluded thousand, and invariant I7
 * forbids quietly replacing it. The walk simply finds the first allowed base at
 * or after it, and wraps to the bottom of the band when it runs off the top.
 *
 * Wrapping ONCE, and never revisiting a candidate, is what makes "the space is
 * exhausted" a statement the caller can actually make.
 */
/**
 * Plan a change of allocation base — for FUTURE vaults only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMMAND IS FOR, AND WHAT IT WOULD BE EASY TO MISREAD IT AS
 * ---------------------------------------------------------------------------
 * It moves the number that the NEXT vault's ports are searched from. It does
 * not touch one existing port, does not open a vault, does not rewrite a
 * `data.json`, does not mint a key, and does not change `installId`. The count
 * of ports it modifies is reported as a literal `0` in the plan, because that
 * is the single thing a reader most needs to be sure of before confirming, and
 * "trust me" is not a way to say it.
 *
 * That restraint is decision D1: renumbering existing HTTP ports would break
 * every click-to-open link already written — in the notes, between vaults, and
 * above all in mail and transcripts, where nothing can reach them. A
 * `--renumber` switch bolted onto this command would be that operation wearing
 * this one's clothes, which is why the plan states the zero rather than
 * omitting the subject.
 *
 * ---------------------------------------------------------------------------
 * THE DRAW HAPPENS ONCE, IN THE PROPOSAL
 * ---------------------------------------------------------------------------
 * `nextPortStart` may be passed in, and the apply phase always passes it: the
 * plan that gets applied has to be the plan that was shown. Redrawing at apply
 * time would mean the user confirmed one number and got another — and it would
 * also defeat the seal, since the re-derived plan would never match.
 *
 * `preconditions` fingerprints what the plan was computed against. A vault
 * registered, unregistered or renumbered between the proposal and the apply
 * changes the fingerprint, the seal stops matching, and the apply refuses
 * rather than acting on a stale picture.
 *
 * @returns {{ previousPortStart, nextPortStart, band, exclusions, registeredVaultCount,
 *             affectedVaultIds: string[], existingPortsChanged: 0, installIdPreserved: true,
 *             candidatesExamined, candidatesFree, preconditions, issues }}
 */
export function planPortStartChange(cfg, {
  policy = DEFAULT_PORT_POLICY,
  reservedPorts = new Set(),
  randomInt,
  nextPortStart = null,
  registeredPaths = [],
} = {}) {
  const previousPortStart = Number.isInteger(cfg?.portStart) ? cfg.portStart : null;
  const issues = [];
  const offset = policyOffset(policy);
  const reserved = reservedPorts instanceof Set ? reservedPorts : new Set(reservedPorts || []);

  let chosen = null;
  let candidatesExamined = 0;
  let candidatesFree = 0;

  if (nextPortStart !== null && nextPortStart !== undefined) {
    // The apply path. The number is NOT redrawn; it is re-validated, so a base
    // that has become unusable since the proposal is refused rather than
    // written.
    const bases = allowedPairBases(policy);
    candidatesExamined = bases.length;
    candidatesFree = bases.filter((p) => !reserved.has(p) && !reserved.has(p + offset)).length;
    if (!isAllowedNewServicePort(nextPortStart, policy) || !isAllowedNewServicePort(nextPortStart + offset, policy)) {
      issues.push({
        kind: 'base-outside-band',
        severity: 'error',
        message:
          `${nextPortStart} is not a base this policy allows — either it or its partner ` +
          `${nextPortStart + offset} falls outside the band or inside an exclusion.`,
      });
    } else if (reserved.has(nextPortStart) || reserved.has(nextPortStart + offset)) {
      issues.push({
        kind: 'base-now-taken',
        severity: 'error',
        message:
          `${nextPortStart} is no longer free: it or its partner ${nextPortStart + offset} has been ` +
          'claimed since the plan was proposed. Re-run the proposal.',
      });
    } else {
      chosen = nextPortStart;
    }
  } else {
    const draw = choosePortStart({ policy, reservedPorts: reserved, previousPortStart, randomInt });
    candidatesExamined = draw.candidatesExamined;
    candidatesFree = draw.candidatesFree;
    if (draw.portStart === null) {
      issues.push({
        kind: 'port-space-exhausted',
        severity: 'error',
        message:
          `No base is available: ${draw.candidatesExamined} candidate base(s) fit the policy and ` +
          'none has both of its ports free. Nothing was changed.',
      });
    } else {
      chosen = draw.portStart;
    }
  }

  const paths = Array.isArray(registeredPaths) ? [...registeredPaths] : [];

  return {
    previousPortStart,
    nextPortStart: chosen,
    band: { min: policy?.min ?? null, max: policy?.max ?? null },
    exclusions: Array.isArray(policy?.exclusions) ? policy.exclusions.map((r) => ({ from: r.from, to: r.to })) : [],
    registeredVaultCount: paths.length,
    // Named `affectedVaultIds` by the specification, and deliberately always
    // EMPTY: no registered vault is affected by a change of base. The field is
    // kept so that a future operation which does affect vaults cannot quietly
    // reuse this plan shape without filling it in.
    affectedVaultIds: [],
    existingPortsChanged: 0,
    installIdPreserved: true,
    candidatesExamined,
    candidatesFree,
    preconditions: {
      previousPortStart,
      registeredVaultCount: paths.length,
      // Sorted so the fingerprint does not depend on object key order.
      registeredPaths: paths.slice().sort(),
      // THE RESERVED PORTS TOO, not just the list of vaults. Without this the
      // seal was blind to a vault whose PAIR changed between the proposal and
      // the apply: the path list was identical, the seal matched, and the apply
      // proceeded on a picture that was no longer true (adversarial review of
      // this release, finding 6). Sorted for the same reason as the paths.
      reservedPorts: [...(reservedPorts instanceof Set ? reservedPorts : new Set(reservedPorts || []))]
        .filter((p) => Number.isInteger(p))
        .sort((a, b) => a - b),
    },
    issues,
  };
}

export function orderedPairCandidates(portStart, policy = DEFAULT_PORT_POLICY) {
  const bases = allowedPairBases(policy);
  if (bases.length === 0) return [];
  if (!isPort(portStart)) return bases;
  let cut = bases.findIndex((p) => p >= portStart);
  if (cut < 0) cut = 0;
  return [...bases.slice(cut), ...bases.slice(0, cut)];
}
