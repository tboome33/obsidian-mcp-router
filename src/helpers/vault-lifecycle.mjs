/**
 * The five things that can happen to a vault, told apart before anything is
 * written.
 *
 * Registration, relocation, an independent copy, and a change of owner are
 * separate operations here because they call for opposite actions and are
 * indistinguishable from the outside. Deciding which one is happening is the
 * whole job; doing it is trivial afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHARED API KEY IS AN ANOMALY AND NOT AN IDENTITY
 * ---------------------------------------------------------------------------
 * A vault copied folder-and-all carries its source's API key. Until now the
 * router noticed that in exactly one case: when the copy came from the
 * REFERENCE vault. A copy of any other vault — and copies of ordinary vaults
 * are the common case — kept a key another vault was still using, and the fleet
 * looked healthy while two vaults answered to one credential. That is the
 * "twin vault" the identity probe cannot see through, because the probe checks
 * whether a key is accepted, not whether it is unique.
 *
 * So keys are compared ACROSS EVERY LOCAL VAULT, by truncated SHA-256, and a
 * match is reported as an anomaly. What it is not:
 *
 *   - not an identity (two vaults can share it; that is the whole problem);
 *   - not a licence to regenerate anything automatically — a synchronised
 *     replica legitimately shares its source's key, and rotating it would lock
 *     the other machine out;
 *   - not something two fresh UUIDs make go away. Stamping distinct identities
 *     on two vaults that share a credential makes the registry look correct
 *     while the probe stays ambiguous. Both facts have to be reported.
 *
 * NO KEY EVER LEAVES THIS MODULE. It receives fingerprints, not secrets, and
 * the fingerprints it emits are truncated (invariant I3: 8-12 hex characters, no
 * key prefix).
 *
 * PURE. No fs, no network, no clock, no randomness.
 */

import { normalizePathForCompare } from './vault-path-identity.mjs';
import { isValidUuid } from './vault-identity.mjs';

/** How much of a SHA-256 travels in a diagnostic. Invariant I3. */
export const FINGERPRINT_LENGTH = 12;

/**
 * Truncate a full digest for display.
 *
 * IT VERIFIES THAT IT WAS GIVEN A DIGEST. The first version sliced whatever
 * string it received, so a caller that passed a raw API key by mistake would
 * have printed the first twelve characters of it — which invariant I3 forbids
 * by name ("no key prefix"). The penetration test of this release fed it a key
 * and watched twelve characters of the key come back (probe F1). A function
 * whose whole purpose is to make a value safe to print must not depend on its
 * caller having already made it safe.
 *
 * Anything that is not a 64-character lowercase hex SHA-256 yields `null`, and
 * callers render that as "unavailable" rather than as a value.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function shortFingerprint(digest) {
  if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) return null;
  return digest.slice(0, FINGERPRINT_LENGTH);
}

/**
 * Which vaults share a credential fingerprint with which.
 *
 * @param {Array<{path: string, name?: string, keyFingerprint: string|null}>} vaults
 * @returns {Array<{fingerprint: string, paths: string[], message: string}>}
 */
export function findSharedKeyGroups(vaults) {
  const byFingerprint = new Map();
  for (const vault of Array.isArray(vaults) ? vaults : []) {
    const fp = vault?.keyFingerprint;
    if (typeof fp !== 'string' || fp.length === 0) continue;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(vault);
  }

  const groups = [];
  for (const [fingerprint, group] of byFingerprint) {
    // Two spellings of one directory are one vault, not two sharing a key.
    const distinct = new Map();
    for (const v of group) distinct.set(normalizePathForCompare(v.path), v);
    if (distinct.size < 2) continue;

    const paths = [...distinct.values()].map((v) => v.path);
    // `null` when what arrived was not a digest — the group is still reported
    // (two vaults DO share a credential, which is the fact that matters), but
    // nothing derived from the value is printed.
    const shown = shortFingerprint(fingerprint) ?? 'unavailable';
    groups.push({
      fingerprint: shortFingerprint(fingerprint),
      paths,
      message:
        `${paths.length} vaults present the same API key (fingerprint ${shown}…): ` +
        `${paths.join(', ')}. That is normal for a synchronised replica and an anomaly for anything ` +
        'else — a copy carries its source\'s credential. Nothing was rotated: rotating a replica\'s ' +
        'key locks the other machine out. Giving them separate UUIDs does not resolve it either.',
    });
  }
  return groups;
}

/**
 * Plan the registration of a vault the router is being pointed at.
 *
 * @param {object} args
 * @param {object} args.cfg
 * @param {{path: string, identityStatus: string, vaultId: string|null, owner: object|null,
 *          ports: object|null, keyFingerprint: string|null, exists: boolean}} args.candidate
 * @param {{installId: string|null, hostname: string|null}} args.installation
 * @param {'create'|'adopt'} [args.intent]
 * @returns {{action: string, vaultId: string|null, owner: object|null, mayWritePorts: boolean,
 *            preservePorts: boolean, warnings: object[], blockers: object[]}}
 */
export function planVaultRegistration({ cfg, candidate, installation = {}, intent = 'adopt' } = {}) {
  const warnings = [];
  const blockers = [];
  const localId = installation.installId ?? null;

  if (!candidate || candidate.exists === false) {
    blockers.push({
      kind: 'target-missing',
      message: 'The vault directory does not exist. A binding never creates a vault.',
    });
    return { action: 'refuse', vaultId: null, owner: null, mayWritePorts: false, preservePorts: true, warnings, blockers };
  }

  if (candidate.identityStatus === 'invalid' || candidate.identityStatus === 'unreadable') {
    blockers.push({
      kind: 'identity-unusable',
      message:
        'This vault\'s identity file cannot be read or understood. It will NOT be replaced — a new ' +
        'identity would detach it from every installation that still references it.',
    });
    return { action: 'refuse', vaultId: null, owner: null, mayWritePorts: false, preservePorts: true, warnings, blockers };
  }

  // A BRAND-NEW VAULT: this installation is making it, so it owns it, and it
  // gets a pair from the current policy.
  if (intent === 'create') {
    return {
      action: 'create',
      vaultId: null,
      owner: localId ? { installId: localId, hostname: installation.hostname ?? null } : null,
      mayWritePorts: true,
      preservePorts: false,
      warnings,
      blockers,
    };
  }

  // AN EXISTING VAULT NOBODY HAS CLAIMED. Adopting it is an explicit act — the
  // user named this path — so the claim is allowed here, and only here.
  if (candidate.owner === null || candidate.owner === undefined) {
    return {
      action: candidate.vaultId ? 'claim' : 'stamp-and-claim',
      vaultId: candidate.vaultId ?? null,
      owner: localId ? { installId: localId, hostname: installation.hostname ?? null } : null,
      mayWritePorts: Boolean(localId),
      // ITS OWN PORTS ARE KEPT. The local band is a rule for CREATION; it is
      // never a reason to renumber a vault that already has ports, whose
      // plaintext number is written into click-to-open links.
      preservePorts: true,
      warnings,
      blockers,
    };
  }

  if (!isValidUuid(candidate.owner.installId)) {
    blockers.push({
      kind: 'identity-unusable',
      message: 'This vault names an owner that cannot be matched. Nothing was changed.',
    });
    return { action: 'refuse', vaultId: candidate.vaultId ?? null, owner: null, mayWritePorts: false, preservePorts: true, warnings, blockers };
  }

  if (candidate.owner.installId === localId) {
    return {
      action: 'adopt',
      vaultId: candidate.vaultId ?? null,
      owner: candidate.owner,
      mayWritePorts: true,
      preservePorts: true,
      warnings,
      blockers,
    };
  }

  // A VAULT THE OTHER INSTALLATION OWNS. Registering its local path is fine and
  // useful — that is how a shared vault becomes reachable here. Writing its
  // plugin configuration is not.
  warnings.push({
    kind: 'foreign-owner',
    message:
      'This vault is owned by another installation' +
      (candidate.owner.hostname ? ` (recorded as "${candidate.owner.hostname}")` : '') +
      '. Its path is registered so it can be read and used here; its ports, key and identity are ' +
      'left exactly as they are. If one of its ports collides locally, that is a conflict to ' +
      'explain — not something to repair on somebody else\'s vault.',
  });
  return {
    action: 'register-foreign',
    vaultId: candidate.vaultId ?? null,
    owner: candidate.owner,
    mayWritePorts: false,
    preservePorts: true,
    warnings,
    blockers,
  };
}

/**
 * Plan a move: the same vault, at a new path.
 *
 * IDENTIFIED BY UUID, NEVER BY PATH — that is the point of the whole lot. And
 * the reverse matters just as much: an old path REUSED by a different vault
 * must not inherit the historic registration.
 */
export function planVaultRelocation({ vaultId, previousEntry, candidate, observations = [] } = {}) {
  const blockers = [];

  if (!isValidUuid(vaultId)) {
    blockers.push({ kind: 'no-identity', message: 'A move needs the vault\'s UUID; this one has none yet.' });
    return { action: 'refuse', blockers };
  }
  if (!candidate?.path) {
    blockers.push({
      kind: 'no-candidate-path',
      message:
        'A move needs the new location, given explicitly. The router does not search the disks for ' +
        'a folder that went missing, and will not pretend it can.',
    });
    return { action: 'refuse', blockers };
  }
  if (candidate.vaultId && candidate.vaultId !== vaultId) {
    blockers.push({
      kind: 'different-vault',
      message:
        `The directory at ${candidate.path} carries a different identity. It is not this vault at a ` +
        'new location, and it must not inherit its registration.',
    });
    return { action: 'refuse', blockers };
  }

  const oldStillThere = observations.some(
    (o) => previousEntry && normalizePathForCompare(o.path) === normalizePathForCompare(previousEntry.path)
      && o.exists !== false && o.vaultId === vaultId,
  );
  if (oldStillThere && normalizePathForCompare(previousEntry.path) !== normalizePathForCompare(candidate.path)) {
    blockers.push({
      kind: 'both-present',
      message:
        `Both ${previousEntry.path} and ${candidate.path} exist and carry the UUID ${vaultId}. That ` +
        'is a replica, a stale entry or an independent copy — three different answers. Nothing was ' +
        'changed.',
    });
    return { action: 'refuse', blockers };
  }

  return {
    action: 'relocate',
    vaultId,
    from: previousEntry?.path ?? null,
    to: candidate.path,
    // A move changes WHERE, and nothing else. Same ports, same key, same owner,
    // same bindings, same custom name.
    portsChanged: 0,
    keyChanged: false,
    ownerChanged: false,
    blockers,
  };
}

/**
 * Plan an independent copy: a folder that was a duplicate and is to become its
 * own vault.
 *
 * NOTHING HERE IS AUTOMATIC. The target is named explicitly, checked not to be
 * the source under another spelling, and the consent must state that the copy
 * is to become independent — because the alternative reading of the same
 * situation is a synchronised replica, where every change made here would be
 * an attack on the other machine.
 */
export function planIndependentCopy({ sourceIdentity, target, installation = {}, reservedPorts = new Set(), consent = null } = {}) {
  const blockers = [];

  if (!target?.path) {
    blockers.push({ kind: 'no-target', message: 'Name the copy explicitly. Nothing is inferred here.' });
    return { action: 'refuse', blockers };
  }
  if (sourceIdentity?.path
    && normalizePathForCompare(sourceIdentity.path) === normalizePathForCompare(target.path)) {
    blockers.push({
      kind: 'same-directory',
      message: 'The target is the source under another spelling. Detaching a folder from itself is not an operation.',
    });
    return { action: 'refuse', blockers };
  }
  if (consent?.becomesIndependent !== true) {
    blockers.push({
      kind: 'no-consent',
      message:
        'Refusing: this changes the copy\'s identity, its owner, its key and its ports. Confirm that ' +
        'it is to become independent and that its changes will NOT propagate back to the source ' +
        'through synchronisation.',
    });
    return { action: 'refuse', blockers };
  }

  // INVARIANT I1 REACHES HERE TOO. If the copy already serves a plaintext port,
  // links may already point at it. Without explicit consent to renumber HTTP,
  // the honest answer is to stop — not to create a twin, and not to break links.
  if (Number.isInteger(target.currentHttpPort) && consent?.mayRenumberHttp !== true) {
    blockers.push({
      kind: 'http-renumbering-not-consented',
      message:
        `This copy already serves plaintext HTTP on ${target.currentHttpPort}, so links may already ` +
        'point at it. Detaching it requires a different port, which means renumbering that one — a ' +
        'decision of its own. Nothing was changed.',
    });
    return { action: 'refuse', blockers };
  }

  return {
    action: 'detach-copy',
    target: target.path,
    source: sourceIdentity?.path ?? null,
    newIdentity: true,
    newKey: true,
    newPorts: true,
    owner: installation.installId
      ? { installId: installation.installId, hostname: installation.hostname ?? null }
      : null,
    reservedPortCount: reservedPorts instanceof Set ? reservedPorts.size : 0,
    sourceUntouched: true,
    blockers,
  };
}

/**
 * Plan a change of owner.
 *
 * A DEDICATED ACTION, with both parties visible, and it touches no port. Making
 * it a side effect of anything else is how an installation ends up owning a
 * vault nobody handed it.
 */
export function planOwnershipChange({ identity, expectedOwner = undefined, nextOwner, consent = null } = {}) {
  const blockers = [];

  if (!identity || !isValidUuid(identity.vaultId)) {
    blockers.push({ kind: 'identity-unusable', message: 'This vault has no readable identity; ownership cannot be changed.' });
    return { action: 'refuse', blockers };
  }
  if (nextOwner !== null && !isValidUuid(nextOwner?.installId)) {
    blockers.push({ kind: 'bad-owner', message: 'A new owner must be an installation UUID, or null to release the vault.' });
    return { action: 'refuse', blockers };
  }

  const current = identity.owner ?? null;
  if (expectedOwner !== undefined) {
    const expectedId = expectedOwner === null ? null : expectedOwner?.installId ?? null;
    const currentId = current === null ? null : current.installId;
    if (expectedId !== currentId) {
      blockers.push({
        kind: 'owner-changed',
        message:
          'Refusing: this vault\'s owner is not what the request expected — it changed since it was ' +
          'read. Nothing was written.',
      });
      return { action: 'refuse', blockers };
    }
  }
  if (current !== null && consent?.transferAcknowledged !== true) {
    blockers.push({
      kind: 'transfer-not-acknowledged',
      message:
        'Refusing: this vault already has an owner' +
        (current.hostname ? ` (recorded as "${current.hostname}")` : '') +
        '. A transfer must be acknowledged explicitly, with both parties named.',
    });
    return { action: 'refuse', blockers };
  }

  return {
    action: current === null ? 'claim' : 'transfer',
    vaultId: identity.vaultId,
    from: current,
    to: nextOwner,
    // Said explicitly because it is the question anyone asks about this
    // operation, and the answer must not have to be inferred.
    portsChanged: 0,
    keyChanged: false,
    blockers,
  };
}
