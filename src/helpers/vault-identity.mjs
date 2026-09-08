/**
 * A vault's durable identity — the UUID that survives a rename, a move, and a
 * change of ports.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REGISTRY'S KEY COULD NOT KEEP BEING THE ANSWER
 * ---------------------------------------------------------------------------
 * The router indexes vaults by absolute path. Rename the folder and the vault
 * becomes a stranger; move it and the old entry becomes a ghost pointing at
 * nothing. Neither event has anything to do with the vault being the same
 * vault, and both happen routinely.
 *
 * Three candidates were considered and rejected before this one:
 *
 *   - The API key. It is a SECRET, it rotates, and — decisively — a vault
 *     copied folder-and-all carries its source's key, so two independent vaults
 *     can present the same one. An identifier that can be duplicated by a file
 *     copy is not an identifier, and one that must never be logged cannot be
 *     used to explain anything to the user.
 *   - Obsidian's own vault ids, from `%APPDATA%/obsidian/obsidian.json`. They
 *     are assigned PER MACHINE: the same folder open on Roland's PC and on his
 *     son's has two different ones. Useful to locate a directory, useless as an
 *     identity across the two installations that share vaults over Drive.
 *   - Anything derived from hardware. A MAC address identifies a network card,
 *     not a vault, and folds the machine into a value that must survive moving
 *     between machines.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FILE MAY NOT CONTAIN — and why each exclusion is deliberate
 * ---------------------------------------------------------------------------
 *   - No API key. Invariant I3, and the file is comparatively public: it sits
 *     in a folder Google Drive replicates to another machine.
 *   - No absolute path. The identity travels with the folder; a path recorded
 *     inside it would be wrong the moment the folder moved, which is precisely
 *     the event this file exists to survive.
 *   - No port. The ports live in the plugin's `data.json`, which is what the
 *     plugin actually binds. A second copy here would be a second source of
 *     truth, replicated by Drive, drifting silently.
 *   - No name that outranks the local configuration. Names are a local matter:
 *     Roland calls a vault one thing, his son may call it another, and neither
 *     of them is wrong.
 *   - No hardware identifier.
 *
 * ---------------------------------------------------------------------------
 * "UNKNOWN OWNER" IS A VALID STATE. "CORRUPT" IS NOT.
 * ---------------------------------------------------------------------------
 * `owner: null` means nobody has claimed the right to rewrite this vault's
 * ports — the state all 27 historic vaults migrate into by decision D4. It is
 * ordinary, and it REFUSES port writes, which is the point.
 *
 * A file that will not parse, or carries a schema version from the future, is a
 * different thing entirely: an error, never repaired automatically. Regenerating
 * an identity that another installation still references is how a vault silently
 * becomes two.
 *
 * PURE. The reading and writing live in `src/vault-identity-store.mjs`.
 */

/** Bumped only for a change no older reader could survive. */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Where the file lives, under the vault root. Decision D2, 2026-09-09. */
export const IDENTITY_RELATIVE_PATH = ['.obsidian', 'obsidian-mcp-router', 'identity.json'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Is this parsed value a usable identity?
 *
 * STRICT ON PURPOSE. Everything downstream — whether a `data.json` may be
 * rewritten, whether two folders are the same vault — rests on this answer, so
 * a "probably fine" verdict here becomes a wrong decision three modules later.
 *
 * @returns {{ valid: boolean, identity: object|null, issues: object[] }}
 */
export function validateVaultIdentity(value) {
  const issues = [];

  if (!isPlainObject(value)) {
    return {
      valid: false,
      identity: null,
      issues: [{
        kind: 'identity-not-an-object',
        severity: 'error',
        message: 'The vault identity file does not contain a JSON object.',
      }],
    };
  }

  const version = value.schemaVersion;
  if (!Number.isInteger(version) || version < 1) {
    issues.push({
      kind: 'identity-bad-schema-version',
      severity: 'error',
      message: 'The vault identity file carries no usable schemaVersion.',
    });
  } else if (version > IDENTITY_SCHEMA_VERSION) {
    // A FUTURE VERSION IS NOT DAMAGE. Something newer than this router wrote
    // it, and overwriting it would destroy whatever that newer thing recorded.
    // Refuse to act, do not "repair".
    issues.push({
      kind: 'identity-future-schema',
      severity: 'error',
      message:
        `This vault's identity was written in schema version ${version}; this router understands ` +
        `version ${IDENTITY_SCHEMA_VERSION}. It will not be read as authoritative and will not be ` +
        'overwritten — a newer router, or another machine, wrote it.',
    });
  }

  if (!isValidUuid(value.vaultId)) {
    issues.push({
      kind: 'identity-bad-vault-id',
      severity: 'error',
      message: 'The vault identity file carries no valid vault UUID.',
    });
  }

  // `owner` may legitimately be absent or null — the migrated state of every
  // historic vault. What it may NOT be is half-formed.
  const owner = value.owner;
  let normalizedOwner = null;
  if (owner === null || owner === undefined) {
    normalizedOwner = null;
  } else if (!isPlainObject(owner)) {
    issues.push({
      kind: 'identity-bad-owner',
      severity: 'error',
      message: 'The vault identity file carries an owner that is not an object.',
    });
  } else if (!isValidUuid(owner.installId)) {
    issues.push({
      kind: 'identity-bad-owner',
      severity: 'error',
      message:
        'The vault identity file names an owner without a valid installation UUID. An owner that ' +
        'cannot be matched is worse than no owner: it looks like a claim and authorizes nothing.',
    });
  } else {
    normalizedOwner = {
      installId: owner.installId,
      hostname: typeof owner.hostname === 'string' ? owner.hostname : null,
    };
  }

  if (issues.length > 0) return { valid: false, identity: null, issues };

  return {
    valid: true,
    identity: {
      schemaVersion: value.schemaVersion,
      vaultId: value.vaultId,
      owner: normalizedOwner,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
      // Anything else the file carried is PRESERVED, not dropped. A field this
      // router does not know may be one a newer one wrote, and rewriting the
      // file must not quietly delete it.
      ...extraFields(value),
    },
    issues: [],
  };
}

const KNOWN_FIELDS = new Set(['schemaVersion', 'vaultId', 'owner', 'createdAt']);

function extraFields(value) {
  const extra = {};
  for (const key of Object.keys(value)) {
    if (KNOWN_FIELDS.has(key)) continue;
    // `__proto__` as a data key must never reach an object literal's prototype.
    if (key === '__proto__') continue;
    extra[key] = value[key];
  }
  return extra;
}

/**
 * Mint a brand-new identity.
 *
 * `owner` is passed in rather than assumed: a vault this installation creates
 * is owned by it, a vault it merely adopts is NOT (decision D4 — no implicit
 * claim over the historic fleet), and only the caller knows which case it is in.
 *
 * @param {object} args
 * @param {() => string} args.randomUUID
 * @param {() => Date|string} [args.now]
 * @param {{installId: string, hostname: string|null}|null} [args.owner]
 */
export function createVaultIdentity({ randomUUID, now = () => new Date(), owner = null } = {}) {
  if (typeof randomUUID !== 'function') {
    throw new TypeError('createVaultIdentity requires a randomUUID() function');
  }
  const vaultId = randomUUID();
  if (!isValidUuid(vaultId)) {
    throw new Error('randomUUID() did not return a valid UUID');
  }
  if (owner !== null && !isValidUuid(owner?.installId)) {
    throw new TypeError('createVaultIdentity: an owner must carry a valid installId, or be null');
  }
  const stamp = now();
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    vaultId,
    owner: owner === null ? null : {
      installId: owner.installId,
      hostname: typeof owner.hostname === 'string' ? owner.hostname : null,
    },
    createdAt: stamp instanceof Date ? stamp.toISOString() : String(stamp),
  };
}

/** Canonical serialization — stable key order, so a rewrite that changes nothing changes no byte. */
export function serializeVaultIdentity(identity) {
  const { schemaVersion, vaultId, owner, createdAt, ...rest } = identity;
  const ordered = { schemaVersion, vaultId, owner: owner ?? null, createdAt: createdAt ?? null };
  for (const key of Object.keys(rest).sort()) ordered[key] = rest[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
