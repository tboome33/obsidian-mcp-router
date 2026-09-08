/**
 * Reading and writing a vault's identity file on disk.
 *
 * The one adapter for `.obsidian/obsidian-mcp-router/identity.json`. Everything
 * that DECIDES — what a valid identity is, who owns what — lives in the two
 * pure helpers beside it; this module only moves bytes, conditionally.
 *
 * ---------------------------------------------------------------------------
 * WHY WRITING HERE IS ALLOWED AT ALL
 * ---------------------------------------------------------------------------
 * Invariant I4 says content is written through the MCP router, with a
 * precondition, never through the filesystem. `.obsidian/` is the stated
 * exception: it is the router's own administrative territory, it is not a note,
 * and — decisively — it can be read and written while Obsidian is CLOSED.
 *
 * That last point is the whole reason decision D2 landed here rather than on a
 * note in the wiki. A note would have to be written through MCP, MCP needs the
 * vault's REST server, and the server only runs when Obsidian has that vault
 * open. Migrating 27 vaults would then have meant opening 27 vaults — which
 * §19.4 of the specification forbids requiring and §20 forbids automating. The
 * exception is not a shortcut; it is what makes the operation possible at all.
 *
 * The exception is also narrow: it covers this file, in this directory. It does
 * not extend to a wiki folder or to anything at the vault root.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY, ON A FOLDER GOOGLE DRIVE IS REPLICATING
 * ---------------------------------------------------------------------------
 * `revision` is an opaque token derived from the file's current bytes. A caller
 * that read revision R and writes with `expectedRevision: R` is refused if
 * anything — the other machine, Drive, a person — changed the file since. It is
 * an optimistic check, the same discipline `ifMatch` gives vault content, and it
 * is honest about its limits: it narrows a window between the read and the
 * write, it does not lock anything, and no distributed lock exists across two
 * machines sharing a folder.
 *
 * `ifNew` is the creating counterpart: create only if nothing is there. Two
 * installations racing to stamp the same synchronised vault must not both win.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { contentSha256 } from './helpers/content-hash.mjs';
import { writeFileAtomicSync } from './helpers/write-file-atomic.mjs';
import { isWindowsPath } from './helpers/vault-path-identity.mjs';
import {
  IDENTITY_RELATIVE_PATH,
  validateVaultIdentity,
  serializeVaultIdentity,
} from './helpers/vault-identity.mjs';

/** The four things the file can be, from the reader's side. Mirrors `data.json`'s. */
export const IDENTITY_STATUS = Object.freeze({
  OK: 'ok',
  ABSENT: 'absent',
  UNREADABLE: 'unreadable',
  INVALID: 'invalid',
});

/**
 * Where the identity file lives for this vault.
 *
 * Same cross-platform care as `readLocalRestData`: a config written on Windows
 * can be read by a POSIX runtime (the CI matrix), and joining a `C:\…` string
 * with `path.posix` yields a path well-formed in neither universe.
 */
export function identityPathFor(vaultPath) {
  const lib = isWindowsPath(vaultPath) ? path.win32 : path.posix;
  return lib.join(vaultPath, ...IDENTITY_RELATIVE_PATH);
}

/**
 * Read and validate a vault's identity.
 *
 * NEVER THROWS, and never merges its four outcomes. "No file" (a vault that
 * predates all of this), "cannot read it here" (an unplugged drive), "damaged"
 * and "written by something newer" are four different situations calling for
 * four different actions, and collapsing them is how a corrupt file gets
 * silently replaced.
 *
 * @returns {Promise<{status: string, identity: object|null, revision: string|null, issues: object[]}>}
 */
export async function readVaultIdentity(vaultPath) {
  const file = identityPathFor(vaultPath);

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { status: IDENTITY_STATUS.ABSENT, identity: null, revision: null, issues: [] };
    }
    return {
      status: IDENTITY_STATUS.UNREADABLE,
      identity: null,
      revision: null,
      issues: [{
        kind: 'identity-unreadable',
        severity: 'warning',
        message:
          'This vault\'s identity file exists but could not be read here (permissions, or a drive ' +
          'that is not available). Ownership cannot be established, so nothing will be written to it.',
      }],
    };
  }

  const revision = contentSha256(raw);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: IDENTITY_STATUS.INVALID,
      identity: null,
      revision,
      issues: [{
        kind: 'identity-unparseable',
        severity: 'error',
        message:
          'This vault\'s identity file is present but is not valid JSON. It has NOT been treated as ' +
          'missing and will NOT be regenerated: a fresh identity would silently detach this vault ' +
          'from every installation that still references it.',
      }],
    };
  }

  const { valid, identity, issues } = validateVaultIdentity(parsed);
  if (!valid) return { status: IDENTITY_STATUS.INVALID, identity: null, revision, issues };
  return { status: IDENTITY_STATUS.OK, identity, revision, issues: [] };
}

export class IdentityPreconditionError extends Error {
  constructor(message, { kind, expectedRevision = null, actualRevision = null } = {}) {
    super(message);
    this.name = 'IdentityPreconditionError';
    this.kind = kind;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * Write an identity, conditionally.
 *
 * Exactly one precondition must be chosen, and there is no unconditional form:
 *   - `ifNew: true`          — create; refuse if a file is already there.
 *   - `expectedRevision: R`  — replace; refuse if the bytes are no longer R.
 *
 * The absence of an unconditional write is deliberate. Every caller of this
 * function knows which of the two it means, and a third "just write it" door
 * would be the one that eventually overwrites the other machine's file.
 *
 * @returns {Promise<{revision: string, backupPath: string|null, created: boolean}>}
 */
export async function writeVaultIdentity(vaultPath, identity, {
  expectedRevision = null,
  ifNew = false,
  operation = 'writing the vault identity',
  now = () => new Date(),
} = {}) {
  if (ifNew && expectedRevision !== null) {
    throw new TypeError('writeVaultIdentity: pass either ifNew or expectedRevision, not both');
  }
  if (!ifNew && expectedRevision === null) {
    throw new TypeError(
      'writeVaultIdentity: a precondition is required — ifNew to create, expectedRevision to replace',
    );
  }

  const { valid, issues } = validateVaultIdentity(identity);
  if (!valid) {
    throw new TypeError(
      `writeVaultIdentity: refusing to write an invalid identity — ${issues.map((i) => i.message).join(' ')}`,
    );
  }

  const file = identityPathFor(vaultPath);
  const dir = path.dirname(file);
  const current = await readVaultIdentity(vaultPath);

  if (ifNew) {
    if (current.status !== IDENTITY_STATUS.ABSENT) {
      throw new IdentityPreconditionError(
        `Refusing ${operation}: this vault already has an identity file. Creating a second one ` +
        'would replace an identity other installations may still reference.',
        { kind: 'identity-exists', actualRevision: current.revision },
      );
    }
  } else if (current.status === IDENTITY_STATUS.ABSENT) {
    throw new IdentityPreconditionError(
      `Refusing ${operation}: the identity file expected at revision ${expectedRevision} is gone.`,
      { kind: 'identity-vanished', expectedRevision },
    );
  } else if (current.revision !== expectedRevision) {
    throw new IdentityPreconditionError(
      `Refusing ${operation}: this vault's identity file changed since it was read — another ` +
      'installation, a synchronisation, or a person edited it. Nothing was written; re-read it ' +
      'and decide again.',
      { kind: 'identity-revision-mismatch', expectedRevision, actualRevision: current.revision },
    );
  }

  const serialized = serializeVaultIdentity(identity);

  // Back up whatever is there before replacing it, INCLUDING a file that failed
  // to parse: a damaged identity may still be the only trace of a UUID other
  // machines reference, and "it was broken anyway" is not a reason to destroy it.
  let backupPath = null;
  if (!ifNew && current.status !== IDENTITY_STATUS.ABSENT) {
    backupPath = await backUp(file, now);
  }

  await fs.mkdir(dir, { recursive: true });
  writeFileAtomicSync(file, serialized);

  return { revision: contentSha256(serialized), backupPath, created: ifNew };
}

/**
 * Copy the current file aside as `.bak-<stamp>`, never overwriting an existing
 * backup.
 *
 * The counter suffix matters more than it looks: two operations in the same
 * minute would otherwise produce the same name, and the second would destroy
 * the first backup — losing exactly the state someone would want back.
 */
async function backUp(file, now) {
  const stamp = now();
  const iso = (stamp instanceof Date ? stamp : new Date(stamp)).toISOString();
  const base = `${file}.bak-${iso.slice(0, 19).replace(/[:T]/g, '-')}`;
  let candidate = base;
  let seq = 1;
  while (fsSync.existsSync(candidate)) {
    candidate = `${base}.${seq}`;
    seq += 1;
    if (seq > 1000) throw new Error(`Cannot find a free backup name beside ${file}`);
  }
  await fs.copyFile(file, candidate);
  return candidate;
}
