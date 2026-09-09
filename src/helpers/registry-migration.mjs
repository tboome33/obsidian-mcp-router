/**
 * Moving the registry from "keyed by path" to "keyed by a UUID that survives
 * the path changing".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MIGRATION IS ALLOWED TO CHANGE — a very short list
 * ---------------------------------------------------------------------------
 * The shape of the router's own configuration, and nothing else. Not one port.
 * Not one API key. Not one `data.json`. Not one custom name, not one workspace
 * binding, not one refusal. The plan states `dataJsonToModify: 0` as a literal
 * because that is the number a reader must be certain of before approving, and
 * the acceptance test compares 27 file hashes rather than trusting the sentence.
 *
 * It is also an EXPLICIT operation, never a side effect of starting up. A
 * migration that ran at load would turn every launch into a write, on a folder
 * two machines share through Google Drive.
 *
 * ---------------------------------------------------------------------------
 * A DUPLICATE UUID IS A QUESTION, NOT A DIAGNOSIS
 * ---------------------------------------------------------------------------
 * Two paths carrying one UUID can be four different situations:
 *
 *   - two spellings of ONE folder (`C:\VAULTS\X` and `C:\vaults\x` on NTFS);
 *   - a MOVE, with a stale entry still pointing at the old place;
 *   - two REPLICAS of a synchronised vault, which must stay identical;
 *   - a COPY that has become independent, which must be told apart.
 *
 * Only the first is decidable here — normalising two spellings of one directory
 * is arithmetic. The other three are indistinguishable from the outside, and
 * the draft this specification replaced got that wrong: it treated a duplicate
 * as a copy and regenerated its identity, key and ports. Doing that to a
 * synchronised replica breaks the other machine. So a genuine duplicate is a
 * BLOCKER: the migration stops, names both paths, and waits for a person.
 *
 * Nothing here regenerates an identity, a key or a port. Ever.
 *
 * PURE. No fs, no clock, no randomness — `uuidFactory` and `now` are injected
 * so a plan can be replayed exactly in a test.
 */

import { normalizePathForCompare } from './vault-path-identity.mjs';
import { registeredVaultPaths, vaultRecordsOf } from './vault-slug.mjs';
import { portEntryOf } from './port-registry.mjs';
import { isValidUuid, sameUuid, canonicalUuid } from './vault-identity.mjs';

/** The schema this migration produces. */
export const TARGET_SCHEMA_VERSION = 2;

/**
 * Where a record's unknown fields ride through the plan.
 *
 * A SYMBOL, deliberately. The first version used a property called `extra`,
 * which is an ordinary name a future version might genuinely use — and a record
 * that had one was read as a carrier, unwrapped, and lost the field. A symbol
 * cannot collide with any JSON key, survives object spread, and is invisible to
 * `JSON.stringify`, so it reaches the writer and never reaches the file.
 */
export const CARRIED_EXTRA = Symbol('obsidian-mcp-router/carried-extra');

/** A record without its carrier — the JSON shape, and only that. */
function stripCarrier(record) {
  const out = { ...record };
  delete out[CARRIED_EXTRA];
  return out;
}

/**
 * The registry as two indexes: by UUID and by normalised path.
 *
 * Works on both schemas, which is what lets the CLI show a coherent picture of
 * a config it has not migrated yet.
 *
 * @returns {{ byId: Map, byNormalizedPath: Map, issues: object[] }}
 */
export function buildCanonicalVaultIndex(cfg) {
  const byId = new Map();
  const byNormalizedPath = new Map();
  const issues = [];

  const records = vaultRecordsOf(cfg);
  if (records !== null) {
    for (const record of records) {
      const normalized = normalizePathForCompare(record.path);
      if (byNormalizedPath.has(normalized)) {
        // TWO SPELLINGS OF ONE DIRECTORY ARE NOT AUTOMATICALLY A CONFLICT.
        // `classifyIdentityMatches` folds exactly this case as a harmless
        // alias, and this index used to contradict it by emitting an
        // error-level issue that the planner promoted to a blocker — so the
        // advertised alias handling could never complete (adversarial review,
        // finding 8). It is a conflict only when the two entries DISAGREE about
        // what the vault is; agreeing entries are redundancy, worth saying and
        // not worth stopping for.
        const first = byNormalizedPath.get(normalized);
        // OWNER AND EXTENSIONS COUNT TOO. Comparing only the UUID and the two
        // ports let two records with different owners — or different
        // future-version fields — read as "agreeing", after which `continue`
        // discarded the second one and its data with it.
        const agrees = sameUuid(first.vaultId, record.vaultId)
          && first.ports?.https === record.ports?.https
          && first.ports?.http === record.ports?.http
          && (first.owner?.installId ?? null) === (record.owner?.installId ?? null)
          && JSON.stringify(first.extra ?? {}) === JSON.stringify(record.extra ?? {});
        issues.push({
          kind: agrees ? 'redundant-path-spelling' : 'duplicate-path',
          severity: agrees ? 'warning' : 'error',
          message: agrees
            ? `Two spellings of one directory are registered (${first.path} and ${record.path}); ` +
              'they agree on identity and ports, so one entry is simply redundant.'
            : `Two records point at the same directory and DISAGREE about it: ${first.path} and ` +
              `${record.path}. Nothing was chosen between them.`,
        });
        continue;
      }
      const entry = { vaultId: record.vaultId, path: record.path, ports: record.ports, owner: record.owner, extra: record.extra ?? {} };
      byNormalizedPath.set(normalized, entry);
      if (isValidUuid(record.vaultId)) {
        if (byId.has(canonicalUuid(record.vaultId))) {
          issues.push({
            kind: 'duplicate-id',
            severity: 'error',
            message: `Two records carry the UUID ${record.vaultId}.`,
          });
        } else {
          byId.set(canonicalUuid(record.vaultId), entry);
        }
      }
    }
    return { byId, byNormalizedPath, issues };
  }

  for (const vaultPath of registeredVaultPaths(cfg)) {
    const normalized = normalizePathForCompare(vaultPath);
    if (byNormalizedPath.has(normalized)) {
      // COMPARED, not assumed. The first version of this branch downgraded
      // EVERY repeated spelling to a warning without looking at the values, so
      // two keys naming one directory with DIFFERENT ports slipped through as
      // "redundant" and the second was silently discarded (second adversarial
      // round, finding 3). Only agreement is redundancy; disagreement is a
      // conflict, and nothing here chooses between the two.
      const first = byNormalizedPath.get(normalized);
      const mine = portEntryOf(cfg, vaultPath);
      const agrees = first.ports?.https === mine.https && first.ports?.http === mine.http;
      issues.push({
        kind: agrees ? 'redundant-path-spelling' : 'duplicate-path',
        severity: agrees ? 'warning' : 'error',
        message: agrees
          ? `Two registry keys spell the same directory: ${first.path} and ${vaultPath}. They agree ` +
            'on ports, so one is simply redundant.'
          : `Two registry keys spell the same directory and DISAGREE about its ports: ${first.path} ` +
            `(${first.ports?.https ?? '?'}/${first.ports?.http ?? '?'}) and ${vaultPath} ` +
            `(${mine.https ?? '?'}/${mine.http ?? '?'}). Nothing was chosen between them.`,
      });
      continue;
    }
    byNormalizedPath.set(normalized, {
      vaultId: null,
      path: vaultPath,
      ports: portEntryOf(cfg, vaultPath),
      owner: null,
    });
  }

  return { byId, byNormalizedPath, issues };
}

/**
 * Sort observed vaults into what the migration can act on and what it cannot.
 *
 * @param {Array<{path: string, identityStatus: string, vaultId: string|null, owner: object|null}>} observations
 * @param {object} existingRegistry the output of `buildCanonicalVaultIndex`
 * @returns {{unique: object[], aliases: object[], moves: object[], ambiguousDuplicates: object[], conflicts: object[]}}
 */
export function classifyIdentityMatches(observations, existingRegistry = null) {
  const unique = [];
  const aliases = [];
  const moves = [];
  const ambiguousDuplicates = [];
  const conflicts = [];

  const list = Array.isArray(observations) ? observations : [];

  // Anything that cannot be read is a conflict before anything else is
  // considered: acting on a vault whose identity is damaged is exactly the
  // thing that would replace it.
  const readable = [];
  for (const obs of list) {
    if (obs.identityStatus === 'invalid' || obs.identityStatus === 'unreadable') {
      conflicts.push({
        kind: obs.identityStatus === 'invalid' ? 'identity-invalid' : 'identity-unreadable',
        path: obs.path,
        message:
          obs.identityStatus === 'invalid'
            ? `${obs.path} has an identity file that cannot be understood. It will NOT be replaced.`
            : `${obs.path} has an identity file that could not be read here.`,
      });
      continue;
    }
    readable.push(obs);
  }

  const byId = new Map();
  for (const obs of readable) {
    if (!isValidUuid(obs.vaultId)) {
      unique.push({ ...obs, reason: 'no-identity-yet' });
      continue;
    }
    // Grouped by the CANONICAL form: two case variants of one UUID are one
    // identifier, and grouping the raw strings let a duplicate walk past
    // detection entirely (adversarial review, finding 11).
    const key = canonicalUuid(obs.vaultId);
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(obs);
  }

  for (const [vaultId, group] of byId) {
    if (group.length === 1) {
      const only = group[0];
      // A path that MOVED: the registry knows this UUID at a different place.
      const known = existingRegistry?.byId?.get?.(canonicalUuid(vaultId)) ?? null;
      if (known && normalizePathForCompare(known.path) !== normalizePathForCompare(only.path)) {
        moves.push({ vaultId, from: known.path, to: only.path });
      } else {
        unique.push({ ...only, reason: 'stamped' });
      }
      continue;
    }

    // Several paths, one UUID. Two spellings of one directory fold away; what
    // is left is a question for a person.
    const distinct = new Map();
    for (const obs of group) distinct.set(normalizePathForCompare(obs.path), obs);
    if (distinct.size === 1) {
      const [only] = [...distinct.values()];
      aliases.push({ vaultId, path: only.path, spellings: group.map((g) => g.path) });
      unique.push({ ...only, reason: 'alias-folded' });
      continue;
    }

    ambiguousDuplicates.push({
      vaultId,
      paths: group.map((g) => g.path),
      message:
        `Two directories carry the UUID ${vaultId}. That can be a synchronised replica, a move ` +
        'with a stale entry, or a copy that became independent — and they call for opposite ' +
        'actions. Nothing was changed; say which it is.',
    });
  }

  return { unique, aliases, moves, ambiguousDuplicates, conflicts };
}

/**
 * Build the plan.
 *
 * @param {object} args
 * @param {object} args.cfg
 * @param {Array} args.observations one per registered vault, from the store
 * @param {{installId: string|null, hostname: string|null}} args.installation
 * @param {Map<string, object|null>} [args.ownershipSelections] path → owner to
 *        record. ABSENT means `null`: decision D4 forbids claiming the historic
 *        fleet implicitly, so an empty selection claims nothing.
 * @param {() => string} args.uuidFactory
 * @param {() => Date} [args.now]
 * @returns {object} the plan. Contains no API key, by construction: nothing
 *          here ever receives one.
 */
export function planRegistryMigration({
  cfg,
  observations,
  installation = {},
  ownershipSelections = new Map(),
  uuidFactory,
  now = () => new Date(),
  transactionId = null,
} = {}) {
  if (typeof uuidFactory !== 'function') {
    throw new TypeError('planRegistryMigration requires a uuidFactory() function');
  }

  const index = buildCanonicalVaultIndex(cfg);
  const classified = classifyIdentityMatches(observations, index);
  const blockers = [];

  for (const conflict of classified.conflicts) blockers.push(conflict);
  for (const dup of classified.ambiguousDuplicates) {
    blockers.push({ kind: 'ambiguous-duplicate', paths: dup.paths, message: dup.message });
  }
  for (const issue of index.issues) {
    if (issue.severity === 'error') blockers.push({ kind: issue.kind, message: issue.message });
  }

  const examinedPaths = [];
  const identitiesToCreate = [];
  const vaultsById = {};
  const alreadyMigrated = vaultRecordsOf(cfg) !== null;

  for (const obs of Array.isArray(observations) ? observations : []) {
    examinedPaths.push(obs.path);

    if (obs.pathExists === false) {
      // A registered directory that is not there. Blocking by default: silently
      // migrating the rest while dropping this one is how a vault disappears
      // from a config nobody noticed shrinking.
      blockers.push({
        kind: 'path-missing',
        path: obs.path,
        message:
          `${obs.path} is registered but is not on this machine. Resolve it explicitly — ` +
          'nothing is dropped silently.',
      });
      continue;
    }

    if (obs.identityStatus === 'invalid' || obs.identityStatus === 'unreadable') continue;

    const entry = index.byNormalizedPath.get(normalizePathForCompare(obs.path)) ?? null;
    const ports = entry ? entry.ports : { https: null, http: null };

    let vaultId = obs.vaultId;
    if (!isValidUuid(vaultId)) {
      vaultId = uuidFactory();
      if (!isValidUuid(vaultId)) throw new Error('uuidFactory() did not return a valid UUID');
      identitiesToCreate.push({ path: obs.path, vaultId });
    }

    // OWNERSHIP: what the vault ALREADY says wins; a selection can only fill in
    // a blank, never overwrite a recorded owner. A transfer is its own action.
    const selected = ownershipSelections instanceof Map
      ? ownershipSelections.get(obs.path)
      : ownershipSelections?.[obs.path];
    const owner = obs.owner ?? (selected === undefined ? null : selected);

    // THE CARRIER IS A SYMBOL, not a field called `extra`.
    //
    // Carrying the unknown fields in a property named `extra` meant a record
    // that legitimately HAD a field called `extra` — a perfectly ordinary name
    // for a future extension — was read as a carrier and unwrapped, moving its
    // contents up a level and deleting the field itself. Measured by the second
    // adversarial round (finding 4). A symbol cannot collide with any JSON key,
    // is copied by spread, and is ignored by `JSON.stringify`, so it travels
    // through the plan and never reaches the file.
    vaultsById[vaultId] = {
      ...(entry?.extra ?? {}),
      path: obs.path,
      ports,
      owner: owner ?? null,
      [CARRIED_EXTRA]: entry?.extra ?? {},
    };
  }

  const duplicateIds = new Set();
  const seen = new Set();
  for (const id of Object.keys(vaultsById)) {
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
  }

  const stamp = now();
  return {
    transactionId: transactionId ?? uuidFactory(),
    fromSchema: alreadyMigrated ? TARGET_SCHEMA_VERSION : 1,
    toSchema: TARGET_SCHEMA_VERSION,
    createdAt: stamp instanceof Date ? stamp.toISOString() : String(stamp),
    installation: {
      installId: installation.installId ?? null,
      hostname: installation.hostname ?? null,
    },
    examinedPaths,
    existingIdentities: (observations || [])
      .filter((o) => isValidUuid(o.vaultId))
      .map((o) => ({ path: o.path, vaultId: o.vaultId, ownerKnown: Boolean(o.owner) })),
    identitiesToCreate,
    moves: classified.moves,
    aliases: classified.aliases,
    vaultsById,
    // The literal every reader checks first.
    dataJsonToModify: 0,
    administrativeFiles: identitiesToCreate.map((c) => ({ vaultPath: c.path, kind: 'identity', action: 'create' })),
    blockers,
    duplicateIds: [...duplicateIds],
    preconditions: {
      // Any change to the set of registered vaults, or to any pair, invalidates
      // the plan — which is what makes "approve then apply" mean something.
      registeredPaths: registeredVaultPaths(cfg).slice().sort(),
      pairs: registeredVaultPaths(cfg)
        .slice()
        .sort()
        .map((p) => {
          const e = portEntryOf(cfg, p);
          return { path: p, https: e.https, http: e.http };
        }),
      schemaVersion: alreadyMigrated ? TARGET_SCHEMA_VERSION : 1,
    },
  };
}

/**
 * The configuration the plan produces, applied to a config object.
 *
 * Separated from the writing so it can be checked without a filesystem, and so
 * the apply step has exactly one place where the new shape is composed.
 *
 * EVERYTHING NOT NAMED HERE IS CARRIED THROUGH UNCHANGED — `vaultNames`,
 * `workspaceBindings`, `openVaults`, `disabledVaults`, `vaultReach`,
 * `defaultVault`, `referenceVault`, and any key a future version added that
 * this one has never heard of.
 */
export function applyPlanToConfig(cfg, plan) {
  const next = { ...cfg };
  next.schemaVersion = TARGET_SCHEMA_VERSION;
  // The carrier is a symbol (see CARRIED_EXTRA), so `...record` already drops
  // it from the JSON shape and a record that legitimately holds a field named
  // `extra` keeps it, untouched, as data.
  next.vaultsById = Object.fromEntries(
    Object.entries(plan.vaultsById).map(([id, record]) => [
      id,
      { ...(record[CARRIED_EXTRA] ?? {}), ...stripCarrier(record) },
    ]),
  );
  // The path-keyed container goes away: keeping it would leave a second,
  // independently-editable copy of the same facts, replicated by Drive, free to
  // drift. The path index every caller uses is derived from `vaultsById` on
  // each read instead (§6.3, decision D7).
  delete next.portRegistry;
  return next;
}
