/**
 * May this installation rewrite that vault's ports?
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD IS, AND WHAT IT HONESTLY IS NOT
 * ---------------------------------------------------------------------------
 * It is a rule the ROUTER applies to itself. It is not a lock, not a permission
 * system, and not protection against another program: Google Drive can
 * overwrite the identity file, a person can edit it, and an older version of
 * this router does not know it exists. Re-reading the identity immediately
 * before a mutation narrows the window; it does not close it, and no message
 * built on this guard may claim otherwise.
 *
 * What it does stop is the thing that actually happens: this router, on this
 * machine, quietly renumbering a vault that belongs to the other installation —
 * a folder Google Drive replicates, whose `data.json` is shared, and whose ports
 * must stay identical on both machines or the click-to-open links in the notes
 * break on one of them.
 *
 * ---------------------------------------------------------------------------
 * UUIDS ARE COMPARED. HOSTNAMES ARE NOT, EVER.
 * ---------------------------------------------------------------------------
 * Two machines can carry the same label; one machine can change its own. A
 * hostname is carried in the identity as a human-readable trace of who claimed
 * the vault and when — it is shown in messages and it decides nothing. The two
 * crossed cases are what this rule exists for, and both are tested:
 *
 *   - a DIFFERENT installId with the SAME hostname → refused;
 *   - the SAME installId with a DIFFERENT hostname → allowed.
 *
 * ---------------------------------------------------------------------------
 * ABSENT, UNKNOWN AND DAMAGED ALL MEAN "NO"
 * ---------------------------------------------------------------------------
 * There is no benefit-of-the-doubt branch. An unclaimed vault refuses, which is
 * exactly the state decision D4 migrates all 27 historic vaults into: claiming
 * is then a deliberate, per-vault act, and the friction is the signal that an
 * authorization is missing rather than merely unstated.
 *
 * READING IS NEVER GATED. This guard governs writes to a vault's own plugin
 * configuration. It does not touch reading a foreign vault, listing it, or
 * updating the LOCAL record of where it lives — none of those change anything
 * inside the vault, and blocking them would make a shared vault useless for the
 * machine that does not own it.
 */

import { isValidUuid } from './vault-identity.mjs';

/** Refusal reasons, as a closed set so callers can branch without string-matching. */
export const OWNERSHIP_VERDICT = Object.freeze({
  OWNED: 'owned',
  UNCLAIMED: 'unclaimed',
  FOREIGN: 'foreign',
  INVALID: 'invalid',
  NO_LOCAL_IDENTITY: 'no-local-identity',
});

export class VaultOwnershipError extends Error {
  constructor(message, { verdict, operation, vaultId = null, ownerHostname = null } = {}) {
    super(message);
    this.name = 'VaultOwnershipError';
    this.kind = 'vault-ownership';
    this.verdict = verdict;
    this.operation = operation;
    this.vaultId = vaultId;
    // The LABEL only, never an installId: naming a foreign installation's UUID
    // in an error would put an identifier from another machine into logs and
    // transcripts for no operational benefit.
    this.ownerHostname = ownerHostname;
  }
}

/**
 * Decide, without throwing.
 *
 * @param {object} args
 * @param {object|null} args.identity A VALIDATED identity, or null when the
 *        file is absent, unreadable or invalid.
 * @param {string|null} args.installId This installation's UUID.
 * @returns {{ verdict: string, allowed: boolean, ownerHostname: string|null }}
 */
export function classifyVaultOwnership({ identity, installId } = {}) {
  if (!isValidUuid(installId)) {
    // This installation cannot claim anything if it has no identity of its own.
    return { verdict: OWNERSHIP_VERDICT.NO_LOCAL_IDENTITY, allowed: false, ownerHostname: null };
  }
  if (!identity || !isValidUuid(identity.vaultId)) {
    return { verdict: OWNERSHIP_VERDICT.INVALID, allowed: false, ownerHostname: null };
  }
  const owner = identity.owner;
  if (owner === null || owner === undefined) {
    return { verdict: OWNERSHIP_VERDICT.UNCLAIMED, allowed: false, ownerHostname: null };
  }
  if (!isValidUuid(owner.installId)) {
    return { verdict: OWNERSHIP_VERDICT.INVALID, allowed: false, ownerHostname: null };
  }
  if (owner.installId === installId) {
    return { verdict: OWNERSHIP_VERDICT.OWNED, allowed: true, ownerHostname: owner.hostname ?? null };
  }
  return { verdict: OWNERSHIP_VERDICT.FOREIGN, allowed: false, ownerHostname: owner.hostname ?? null };
}

/**
 * Decide, and throw a structured refusal when the answer is no.
 *
 * `operation` names what was about to happen, so the refusal reads as a fact
 * about this attempt rather than as a generic denial.
 *
 * @throws {VaultOwnershipError}
 */
export function assertVaultPortOwnership({ identity, installId, operation = 'this operation' } = {}) {
  const { verdict, allowed, ownerHostname } = classifyVaultOwnership({ identity, installId });
  if (allowed) return;

  const vaultId = identity && isValidUuid(identity.vaultId) ? identity.vaultId : null;
  const messages = {
    [OWNERSHIP_VERDICT.UNCLAIMED]:
      `Refusing ${operation}: this vault has no owner recorded, so no installation has claimed the ` +
      'right to change its ports. Claim it explicitly first — claiming changes no port by itself.',
    [OWNERSHIP_VERDICT.FOREIGN]:
      `Refusing ${operation}: this vault is owned by another installation` +
      (ownerHostname ? ` (recorded as "${ownerHostname}")` : '') +
      '. Its ports are shared with that machine — changing them here would break its links, not ' +
      'repair anything. Reading the vault is unaffected.',
    [OWNERSHIP_VERDICT.INVALID]:
      `Refusing ${operation}: this vault's identity file is missing, unreadable or damaged, so ` +
      'ownership cannot be established. It has NOT been regenerated — a new identity would ' +
      'silently detach this vault from every installation that still references it.',
    [OWNERSHIP_VERDICT.NO_LOCAL_IDENTITY]:
      `Refusing ${operation}: this installation has no identity of its own yet, so it cannot be ` +
      'the owner of anything. Run the vault setup once to create one.',
  };

  throw new VaultOwnershipError(messages[verdict] || `Refusing ${operation}.`, {
    verdict,
    operation,
    vaultId,
    ownerHostname,
  });
}
