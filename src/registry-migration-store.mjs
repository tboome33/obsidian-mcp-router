/**
 * Running a registry migration, and surviving being interrupted halfway.
 *
 * ---------------------------------------------------------------------------
 * WHY A JOURNAL RATHER THAN A TRANSACTION
 * ---------------------------------------------------------------------------
 * There is no atomic transaction spanning 27 folders that Google Drive is
 * replicating and one local configuration file. Pretending otherwise is how a
 * migration ends with identities written into vaults and a config that never
 * learned about them — or worse, with a rollback that deletes an identity the
 * other machine has already synchronised and started referencing.
 *
 * So the sequence is ordered by what is recoverable:
 *
 *   1. Pre-validate everything. A blocker stops the run before any write.
 *   2. Take the config's revision, and back the config up.
 *   3. Write the journal — BEFORE creating anything, so an interruption always
 *      leaves a record of what was in flight.
 *   4. Create the missing identities, conditionally (`ifNew`), one by one,
 *      appending each success to the journal.
 *   5. Re-read every identity and check it says what the plan assumed.
 *   6. Write the new configuration, atomically, LAST.
 *
 * If step 4 or 5 is interrupted, the vaults carry identities and the config
 * does not — a state that is inconsistent but harmless, because nothing reads
 * an identity file until the config points at it. A resume finds the journal,
 * REUSES the identities already created (never a second UUID for the same
 * folder), and finishes.
 *
 * NOTHING IS EVER ROLLED BACK BLINDLY. An identity created here may already
 * have been synchronised to the other machine; deleting it to "clean up" would
 * detach a vault that is now referenced elsewhere. The failure path explains
 * what exists and how to resume; it does not undo.
 *
 * NO API KEY REACHES THIS MODULE. It reads identities and writes a config; the
 * keys live in `data.json`, which this file never opens.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from './helpers/write-file-atomic.mjs';
import { createVaultIdentity } from './helpers/vault-identity.mjs';
import { readVaultIdentity, writeVaultIdentity, IDENTITY_STATUS } from './vault-identity-store.mjs';
import { applyPlanToConfig } from './helpers/registry-migration.mjs';
import { registeredVaultPaths } from './helpers/vault-slug.mjs';
import { portEntryOf } from './helpers/port-registry.mjs';

/** Where a run's journal lives. Beside the config, not inside a vault. */
export function journalPathFor(configPath, transactionId) {
  return path.join(path.dirname(configPath), `.migration-${transactionId}.journal.json`);
}

async function readJournal(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJournal(file, journal) {
  writeFileAtomicSync(file, `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * Observe every registered vault: does its directory exist, what does its
 * identity file say, and can it be read at all.
 *
 * Reading only — this is what a `--dry-run` calls, and it opens no vault's
 * `data.json` and starts no server.
 */
export async function observeVaults(paths) {
  const observations = [];
  for (const vaultPath of paths) {
    const pathExists = fsSync.existsSync(vaultPath);
    if (!pathExists) {
      observations.push({ path: vaultPath, pathExists: false, identityStatus: 'absent', vaultId: null, owner: null });
      continue;
    }
    const { status, identity } = await readVaultIdentity(vaultPath);
    observations.push({
      path: vaultPath,
      pathExists: true,
      identityStatus: status,
      vaultId: identity?.vaultId ?? null,
      owner: identity?.owner ?? null,
    });
  }
  return observations;
}

export class MigrationRefusedError extends Error {
  constructor(message, { kind, blockers = [] } = {}) {
    super(message);
    this.name = 'MigrationRefusedError';
    this.kind = kind;
    this.blockers = blockers;
  }
}

/**
 * Apply a plan.
 *
 * @param {object} plan
 * @param {object} stores
 * @param {string} stores.configPath
 * @param {() => object} stores.readConfig
 * @param {(cfg: object) => void} stores.writeConfig
 * @param {string} [stores.expectedConfigRevision] the config's hash at plan time
 * @param {() => Date} [stores.now]
 * @returns {Promise<object>} the report
 */
export async function applyRegistryMigration(plan, {
  configPath,
  readConfig,
  writeConfig,
  expectedConfigRevision = null,
  now = () => new Date(),
} = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('applyRegistryMigration needs a plan');

  if (plan.blockers && plan.blockers.length > 0) {
    throw new MigrationRefusedError(
      `Refusing to migrate: ${plan.blockers.length} thing(s) must be settled first. Nothing was changed.`,
      { kind: 'blocked', blockers: plan.blockers },
    );
  }

  const journalFile = journalPathFor(configPath, plan.transactionId);
  const existingJournal = await readJournal(journalFile);
  const created = new Map(
    existingJournal?.created?.map((c) => [c.path, c.vaultId]) ?? [],
  );

  // The config must still be what the plan was computed against.
  const cfg = readConfig();
  if (expectedConfigRevision !== null) {
    const actual = configRevision(cfg);
    if (actual !== expectedConfigRevision) {
      throw new MigrationRefusedError(
        'Refusing to migrate: the router configuration changed since the plan was made. ' +
        'Nothing was written; re-run the preview.',
        { kind: 'config-drift' },
      );
    }
  }

  // Back the config up BEFORE anything is created.
  const backupPath = `${configPath}.bak-${(now() instanceof Date ? now() : new Date()).toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  if (!fsSync.existsSync(backupPath)) {
    await fs.copyFile(configPath, backupPath);
  }

  const journal = existingJournal ?? {
    transactionId: plan.transactionId,
    configPath,
    backupPath,
    startedAt: (now() instanceof Date ? now() : new Date()).toISOString(),
    created: [],
    finished: false,
  };
  journal.backupPath = journal.backupPath ?? backupPath;
  writeJournal(journalFile, journal);

  // Create the identities the plan says are missing — conditionally, and one at
  // a time, recording each before moving on.
  //
  // THE INSTALLATION'S OWN IDENTITY IS DELIBERATELY NOT USED AS THE OWNER HERE.
  // An earlier draft of this loop composed one from `plan.installation` and
  // stamped it into every vault, which is precisely the implicit claim over the
  // historic fleet that decision D4 forbids. The owner written is the one the
  // PLAN carries for that path — `null` unless the user named the vault.
  for (const pending of plan.identitiesToCreate) {
    if (created.has(pending.path)) continue;

    const current = await readVaultIdentity(pending.path);
    if (current.status === IDENTITY_STATUS.OK) {
      // Somebody stamped it between the plan and now — the other machine,
      // typically. Adopt what is there; never overwrite it.
      created.set(pending.path, current.identity.vaultId);
      journal.created.push({ path: pending.path, vaultId: current.identity.vaultId, adopted: true });
      writeJournal(journalFile, journal);
      continue;
    }
    if (current.status !== IDENTITY_STATUS.ABSENT) {
      throw new MigrationRefusedError(
        `Refusing to continue: ${pending.path} has an identity file that cannot be read or ` +
        'understood. It was NOT replaced. Earlier identities created by this run are recorded in ' +
        `${journalFile} and will be reused when you resume.`,
        { kind: 'identity-unusable' },
      );
    }

    // D4: the migration claims NOTHING. The owner recorded is the one the plan
    // carries for this path, which is `null` unless the user named this vault
    // explicitly.
    const plannedOwner = plan.vaultsById[pending.vaultId]?.owner ?? null;
    const identity = createVaultIdentity({
      randomUUID: () => pending.vaultId,
      now,
      owner: plannedOwner,
    });
    await writeVaultIdentity(pending.path, identity, { ifNew: true, operation: 'migrating this vault\'s registry entry' });
    created.set(pending.path, pending.vaultId);
    journal.created.push({ path: pending.path, vaultId: pending.vaultId, adopted: false });
    writeJournal(journalFile, journal);
  }

  // Re-read everything the plan assumed, before the configuration is rewritten.
  const verified = [];
  const vaultsById = {};
  for (const [vaultId, record] of Object.entries(plan.vaultsById)) {
    const observed = await readVaultIdentity(record.path);
    if (observed.status !== IDENTITY_STATUS.OK) {
      throw new MigrationRefusedError(
        `Refusing to finish: ${record.path} no longer presents a readable identity. The ` +
        `configuration was NOT rewritten; resume with the journal at ${journalFile}.`,
        { kind: 'verification-failed' },
      );
    }
    const effectiveId = created.get(record.path) ?? observed.identity.vaultId;
    if (observed.identity.vaultId !== effectiveId) {
      throw new MigrationRefusedError(
        `Refusing to finish: ${record.path} carries a different UUID than this run created. ` +
        'The configuration was NOT rewritten.',
        { kind: 'verification-failed' },
      );
    }
    vaultsById[observed.identity.vaultId] = {
      path: record.path,
      ports: record.ports,
      owner: observed.identity.owner ?? null,
    };
    verified.push({ path: record.path, vaultId: observed.identity.vaultId });
  }

  // The configuration, atomically, last.
  const next = applyPlanToConfig(readConfig(), { ...plan, vaultsById });
  writeConfig(next);

  journal.finished = true;
  journal.finishedAt = (now() instanceof Date ? now() : new Date()).toISOString();
  writeJournal(journalFile, journal);

  return {
    transactionId: plan.transactionId,
    migrated: verified.length,
    identitiesCreated: [...created.entries()].map(([p, id]) => ({ path: p, vaultId: id })),
    dataJsonModified: 0,
    backupPath: journal.backupPath,
    journalPath: journalFile,
    resumed: Boolean(existingJournal),
  };
}

/**
 * Finish a run that was interrupted.
 *
 * Reuses the identities the journal records, so a folder that already got a
 * UUID never gets a second one — the single most damaging thing a naive retry
 * could do, because the first UUID may already be on the other machine.
 */
export async function resumeRegistryMigration(transactionId, { configPath, readConfig, writeConfig, buildPlan, now } = {}) {
  const journalFile = journalPathFor(configPath, transactionId);
  const journal = await readJournal(journalFile);
  if (!journal) {
    throw new MigrationRefusedError(
      `No journal found for transaction ${transactionId} beside ${configPath}. Nothing to resume.`,
      { kind: 'no-journal' },
    );
  }
  if (journal.finished) {
    return { transactionId, migrated: 0, alreadyFinished: true, journalPath: journalFile, dataJsonModified: 0 };
  }
  if (typeof buildPlan !== 'function') {
    throw new TypeError('resumeRegistryMigration needs buildPlan() to re-derive the plan');
  }

  // Re-derive against CURRENT state, then force the already-created UUIDs back
  // into it so the resume cannot mint a second identity for a folder that has
  // one.
  const plan = await buildPlan({ transactionId });
  for (const entry of journal.created) {
    const stale = Object.entries(plan.vaultsById).find(([, r]) => r.path === entry.path);
    if (stale && stale[0] !== entry.vaultId) {
      plan.vaultsById[entry.vaultId] = plan.vaultsById[stale[0]];
      delete plan.vaultsById[stale[0]];
    }
    plan.identitiesToCreate = plan.identitiesToCreate.filter((c) => c.path !== entry.path);
  }

  return applyRegistryMigration(plan, { configPath, readConfig, writeConfig, now });
}

/**
 * A cheap fingerprint of the config, used only to detect that it moved between
 * the plan and the apply. Deliberately NOT a hash of the file's bytes: a
 * reformat is not a change of meaning, and the fields that matter are few.
 */
export function configRevision(cfg) {
  // Composed from the ACCESSORS, not from the raw containers. Two reasons, and
  // the second is the one that matters: a reformat of the file is not a change
  // of meaning and must not invalidate a plan; and reading `cfg.portRegistry`
  // directly is exactly the access the source scan in `tests/vault-slug.test.mjs`
  // refuses everywhere outside `vault-slug.mjs` — a hand-edited `"portRegistry":
  // "AB"` once manufactured vault paths named "0" and "1", and a fingerprint
  // built on that would have been computed over invented vaults.
  const paths = registeredVaultPaths(cfg).slice().sort();
  return JSON.stringify({
    schemaVersion: cfg?.schemaVersion ?? 1,
    vaults: paths.map((p) => {
      const entry = portEntryOf(cfg, p);
      return { path: p, https: entry.https, http: entry.http };
    }),
  });
}

/** Every unfinished journal beside a config — what a resume needs to find. */
export function pendingMigrations(configPath) {
  const dir = path.dirname(configPath);
  if (!fsSync.existsSync(dir)) return [];
  return fsSync
    .readdirSync(dir)
    .filter((f) => /^\.migration-.+\.journal\.json$/.test(f))
    .map((f) => {
      try {
        const journal = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf8'));
        return journal.finished ? null : journal;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
