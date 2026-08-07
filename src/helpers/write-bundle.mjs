/**
 * Journaled multi-file operation bundle — C2 (borrowed from claude-obsidian v2).
 *
 * THE PROBLEM. A single logical operation in this router is almost never a
 * single write. An ingestion writes the source page, two or three entity pages,
 * patches an index, appends to the journal. A `save` writes the note, appends to
 * the log, patches `hot.md`. `merge_frontmatter` writes one key per call and
 * documents itself as "sequential, NOT atomic". If anything fails at step 3 of
 * 5 — the vault went offline, a heading target vanished, the process died — the
 * vault is left in a state nobody designed: a source page with no index entry, a
 * log line for a note that was never written. Nothing detects it, and the next
 * session builds on top of the debris.
 *
 * WHAT A BUNDLE GUARANTEES — and what it does NOT.
 *
 *   ✅ ALL-OR-NOTHING RECOVERY. Every target's content is read and kept as a
 *      BEFORE-IMAGE before the first mutation. If any step fails, every path the
 *      bundle touched is put back to its before-image.
 *
 *   ✅ CRASH SURVIVAL ("journalisé"). The before-images are persisted to
 *      `wiki-meta/write-journal/<operationId>.json` BEFORE the first mutation,
 *      so a rollback is still possible after the process that started the bundle
 *      is gone. The journal is closed (deleted, or failing that stamped with a
 *      terminal state) on a clean outcome and RETAINED whenever anything is left
 *      dirty or unproven — a leftover PENDING journal is the signal that a vault
 *      needs repair, and `recover` replays the rollback from it.
 *
 *   ✅ COMPOSES WITH C1. A step may carry `ifMatch`; the precondition is checked
 *      against the before-image during pre-flight, so a bundle whose targets
 *      moved under it refuses ENTIRELY, before writing anything.
 *
 *   ❌ NOT ISOLATION. This is recovery, not a transaction. Local REST API has no
 *      multi-file transaction and no snapshot read, so a concurrent reader CAN
 *      observe an intermediate state while the bundle is in flight. What a bundle
 *      removes is the DURABLE half-applied state, not the transient one.
 *
 *   ❌ NOT A LOCK. Nothing stops a third party from writing a target mid-bundle.
 *      That case is detected rather than prevented — as far as detection can
 *      reach, which is stated precisely below.
 *
 * ATTRIBUTION — the rule that keeps rollback from becoming the very clobber C1
 * exists to prevent. Restoring a before-image is itself a write. If a third
 * party edited one of our targets after our step wrote it, blindly restoring
 * would destroy their edit. So a path is only restored when the bundle can say
 * what it left there, and HOW WELL it knows that is carried explicitly:
 *
 *   - `ours`       — the post-image was DERIVED, not observed: for a `write` the
 *                    bundle knows the exact bytes it sent, for a `delete` it
 *                    knows the file is gone. If the read-back disagrees with the
 *                    derivation, a third party (or a write-rewriting plugin) got
 *                    in, and the path is marked foreign and left alone.
 *   - `observed`   — the post-image is a READ taken right after the step, which
 *                    is the only thing available for `patch` / `append` /
 *                    frontmatter ops, whose result the router cannot predict. A
 *                    concurrent write landing inside that one round trip would be
 *                    adopted as the bundle's own. The window is small; it is not
 *                    zero, and this label is how the result says so.
 *   - `unverified` — a step on this path FAILED before any post-image existed.
 *                    See `planRestore`.
 *
 * This module is PURE: validation, plan derivation, journal shape, and the
 * rollback decision table. All I/O lives in `src/tools/write-bundle.mjs`, so
 * every rule here is unit-testable without a vault.
 */
import { contentSha256 } from './content-hash.mjs';
import { canonicalVaultPath as guardVaultPath } from './vault-path-guard.mjs';
import { safeForMessage } from './sanitize.mjs';
import { canonicalize } from './plan-seal.mjs';

/** Where journals live. Outside `wiki/`, so no index/graph/projection walks it. */
export const BUNDLE_JOURNAL_DIR = 'wiki-meta/write-journal';

/** Journal schema version — a journal this router cannot read is never acted on. */
export const JOURNAL_VERSION = 1;

/** Operation tag folded into the C3 plan seal (domain-separated from other ops). */
export const BUNDLE_SEAL_OP = 'write_bundle';

/**
 * Journal lifecycle, and it is deliberately narrow. A journal is either:
 *
 *   - `pending` — the operation did NOT reach a proven clean end. This covers a
 *     crash, a partial rollback, and an unprovable one. All of them are cases a
 *     human may still want to replay, so `recover` must accept them — every
 *     message that advertises `recover` would otherwise point at a record
 *     `recover` refuses. What actually happened is recorded in `lastOutcome`,
 *     which is history, not a gate.
 *   - terminal (`applied` / `rolled-back`) — the operation reached a decided,
 *     proven end. Replaying its before-images would UNDO a bundle that
 *     succeeded, so recovery refuses it. (Reproduced during the C2 review: a
 *     successful bundle whose journal deletion failed could later be reverted by
 *     `recover`, while its own result called the journal "inert".) Normally such
 *     a journal is simply deleted; it is only stamped when the delete fails.
 */
export const JOURNAL_PENDING = 'pending';
export const TERMINAL_JOURNAL_STATES = Object.freeze(['applied', 'rolled-back']);

/**
 * Bounds. A bundle holds every target's full content in memory AND in the
 * journal; unbounded, one call could try to snapshot a whole vault. Both limits
 * refuse loudly with the number that was exceeded — never a silent truncation,
 * which would produce a journal that cannot roll back what it claims to.
 */
export const MAX_STEPS = 25;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

/** The step verbs a bundle can execute, mapped to the existing single-file tools. */
export const STEP_OPS = Object.freeze([
  'write',
  'append',
  'patch',
  'set_frontmatter',
  'merge_frontmatter',
  'delete',
]);

/**
 * Deliberately ABSENT: `move`. A move is two paths whose consistency is its own
 * contract (the existing `move_file` can already half-succeed and says so), and
 * a half-rolled-back move is worse than no rollback at all. Recorded here as a
 * scope decision rather than an oversight — express a move as delete + write if
 * it must ride inside a bundle.
 */
export const UNSUPPORTED_STEP_OPS = Object.freeze(['move']);

/**
 * Bundle-layer error. `kind` feeds `classifyError`: every refusal raised from
 * here is a request the caller must fix (or re-derive), never a retry-in-place.
 */
export class BundleError extends Error {
  constructor(message, { kind = 'validation', ...rest } = {}) {
    super(message);
    this.name = 'BundleError';
    this.kind = kind;
    Object.assign(this, rest);
  }
}

/** Operation ids are `op-` + 16 lowercase hex. Shape-checked before use as a path. */
const OPERATION_ID_RE = /^op-[0-9a-f]{16}$/;

/** @param {unknown} value @returns {boolean} */
export function isOperationId(value) {
  return typeof value === 'string' && OPERATION_ID_RE.test(value);
}

/**
 * Normalise the `recover` argument into `false` | `true` (list) | an operationId.
 *
 * Why this exists: the field is a union (boolean OR operationId string), and a
 * union does NOT survive the trip through every MCP client — observed in
 * production on the first real call, where `recover: true` arrived as the STRING
 * `"true"` and the read-only listing became unreachable. The listing is the
 * entry point to the whole recovery story, so it must not depend on how a client
 * happens to render a boolean. The recognised tokens are the same ones the
 * router already accepts for its boolean env vars.
 *
 * Anything else is returned untouched, so a malformed value still produces the
 * actionable refusal rather than being silently coerced into "list everything".
 *
 * @param {unknown} value
 * @returns {boolean|string|unknown}
 */
export function normalizeRecoverArg(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (token === 'true' || token === '1' || token === 'yes' || token === 'on') return true;
    if (token === '' || token === 'false' || token === '0' || token === 'no' || token === 'off') return false;
  }
  return value;
}

/**
 * Mint an operation id. `randomHex` is injected so tests are deterministic.
 * @param {() => string} randomHex 16 lowercase hex chars
 */
export function newOperationId(randomHex) {
  const hex = String(randomHex()).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(hex)) {
    throw new BundleError('newOperationId: the id source must yield 16 lowercase hex chars.');
  }
  return `op-${hex}`;
}

/**
 * Canonical vault path — delegates to the ONE definition in
 * `helpers/vault-path-guard.mjs`, wrapping refusals in `BundleError` so a
 * step-level rejection keeps this module's error type. The guard used to live
 * here and nowhere else, which is exactly why five write tools never got it.
 *
 * @param {unknown} p
 * @param {string} where label used in the refusal
 * @returns {string} canonical vault-relative path
 */
export function canonicalVaultPath(p, where = 'path') {
  return guardVaultPath(p, where, (m) => new BundleError(m));
}

/**
 * Vault path of a journal. Validates the id FIRST — an unvalidated id
 * concatenated into a path is a traversal primitive (`../../wiki/index.md`).
 * @param {string} operationId
 */
export function journalPathFor(operationId) {
  if (!isOperationId(operationId)) {
    throw new BundleError(
      `Invalid operationId "${operationId}": expected the "op-" + 16 hex form returned by write_bundle.`,
    );
  }
  return `${BUNDLE_JOURNAL_DIR}/${operationId}.json`;
}

/**
 * True when a CANONICAL path is the journal directory or anything inside it.
 * Equality matters as much as descent: a step naming the directory itself would
 * be handed to `delete_file`.
 */
export function isJournalPath(p) {
  return typeof p === 'string' && (p === BUNDLE_JOURNAL_DIR || p.startsWith(`${BUNDLE_JOURNAL_DIR}/`));
}

/**
 * Per-op required arguments. Checked during pre-flight — BEFORE the first write —
 * so a bundle whose fourth step is missing `content` never gets to write its
 * first three. (Each underlying tool validates again at execution time; this is
 * the earlier, cheaper gate that preserves the all-or-nothing promise.)
 */
const REQUIRED_ARGS = {
  write: ['content'],
  append: ['content'],
  patch: ['operation', 'targetType', 'target', 'content'],
  set_frontmatter: ['key', 'value'],
  merge_frontmatter: ['values'],
  delete: [],
};

const PATCH_OPERATIONS = Object.freeze(['append', 'prepend', 'replace']);
const PATCH_TARGET_TYPES = Object.freeze(['heading', 'block', 'frontmatter']);

/**
 * Arguments a step may never carry. `vault` because a bundle is single-vault by
 * construction (one journal, one backup set, one rollback authority); the
 * two-phase flags because a preview inside an executing bundle is meaningless
 * and `approvedPlanSha256` would seal the wrong scope — the BUNDLE carries the
 * seal, not its individual steps.
 */
const FORBIDDEN_STEP_ARGS = ['vault', 'preview', 'approvedPlanSha256'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * TYPE + COMBINATION checks that mirror what the delegated tool would reject at
 * execution time. Presence alone is not enough: a `content: 42` on step 4 passes
 * a presence check, throws inside `write_file`, and turns a knowable request
 * error into a rollback — dragging the whole bundle through the rollback's
 * ambiguities for nothing. Everything knowable before the first write is
 * refused before the first write.
 */
function validateStepShape(op, args, where) {
  for (const required of REQUIRED_ARGS[op]) {
    if (args[required] === undefined) {
      throw new BundleError(`${where} (op "${op}") is missing required argument: ${required}.`);
    }
  }
  if ((op === 'write' || op === 'append' || op === 'patch') && typeof args.content !== 'string') {
    throw new BundleError(`${where} (op "${op}") needs its content argument to be a string (got ${typeof args.content}).`);
  }
  if (op === 'write' && args.ifNew === true && args.ifMatch !== undefined) {
    throw new BundleError(
      `${where} sets both ifNew and ifMatch: "must not exist yet" and "must already hold this content" ` +
        `cannot both be true.`,
    );
  }
  if (op === 'set_frontmatter' && (typeof args.key !== 'string' || args.key.trim() === '')) {
    throw new BundleError(`${where} (op "set_frontmatter") needs a non-empty key.`);
  }
  if (op === 'merge_frontmatter' && !isPlainObject(args.values)) {
    throw new BundleError(`${where} (op "merge_frontmatter") needs values to be a key/value object.`);
  }
  // Boolean options are passed straight through to the delegated tool, where a
  // STRING silently reverses the intent: `requireExisting: "false"` is truthy,
  // so append_to_file would send Create-Target-If-Missing:false and refuse to
  // create a file the caller asked it to create.
  // `confirm` is deliberately absent: a delete has its own stricter check below,
  // whose message is about the guard rather than about types.
  for (const flag of ['ifNew', 'requireExisting', 'createIfMissing', 'createTargetIfMissing', 'applyIfContentPreexists', 'trimTargetWhitespace']) {
    if (args[flag] !== undefined && typeof args[flag] !== 'boolean') {
      throw new BundleError(
        `${where}.${flag} must be a boolean (got ${typeof args[flag]}: ${JSON.stringify(args[flag])}). A ` +
          `string like "false" is truthy and would reverse what you asked for.`,
      );
    }
  }
  if (op === 'patch') {
    if (!PATCH_OPERATIONS.includes(args.operation)) {
      throw new BundleError(
        `${where} (op "patch") needs operation to be one of: ${PATCH_OPERATIONS.join(', ')} ` +
          `(got ${JSON.stringify(args.operation)}).`,
      );
    }
    if (!PATCH_TARGET_TYPES.includes(args.targetType)) {
      throw new BundleError(
        `${where} (op "patch") needs targetType to be one of: ${PATCH_TARGET_TYPES.join(', ')} ` +
          `(got ${JSON.stringify(args.targetType)}).`,
      );
    }
    if (typeof args.target !== 'string' || args.target.trim() === '') {
      throw new BundleError(`${where} (op "patch") needs a non-empty target.`);
    }
  }
  // A delete inside a bundle still needs the same explicit confirmation the
  // standalone tool demands. Bundling must never become a way to smuggle an
  // unconfirmed delete past the guard.
  if (op === 'delete' && args.confirm !== true) {
    throw new BundleError(
      `${where} (op "delete") requires confirm:true, exactly like delete_file. Bundling does not ` +
        `relax the deletion guard.`,
    );
  }
}

/**
 * Validate + normalise the step list. Throws `BundleError` on the first problem,
 * naming the step index so the caller can fix it without guessing. Paths come
 * back CANONICAL — the rest of the bundle deals only in canonical paths.
 *
 * @param {unknown} steps
 * @returns {Array<{index:number, op:string, path:string, args:object}>}
 */
export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new BundleError(
      'Missing or empty argument: steps (a bundle is a non-empty ordered list of write operations).',
    );
  }
  if (steps.length > MAX_STEPS) {
    throw new BundleError(
      `Bundle has ${steps.length} steps, over the limit of ${MAX_STEPS}. A bundle keeps every target's ` +
        `full content in memory and in its journal; split the operation into several bundles.`,
    );
  }

  return steps.map((raw, index) => {
    const where = `steps[${index}]`;
    if (!isPlainObject(raw)) {
      throw new BundleError(`${where} must be an object of the form { op, path, ... }.`);
    }
    const op = raw.op;
    if (typeof op !== 'string' || !STEP_OPS.includes(op)) {
      const extra = UNSUPPORTED_STEP_OPS.includes(op)
        ? ` "${op}" is deliberately not supported inside a bundle — a half-rolled-back move is worse ` +
          `than no rollback; express it as a delete + a write.`
        : '';
      throw new BundleError(
        `${where}.op must be one of: ${STEP_OPS.join(', ')} (got ${JSON.stringify(op)}).${extra}`,
      );
    }
    const filePath = canonicalVaultPath(raw.path, `${where}.path`);
    if (isJournalPath(filePath)) {
      throw new BundleError(
        `${where}.path targets ${BUNDLE_JOURNAL_DIR}/, where bundles keep their rollback journals. ` +
          `A bundle may not write its own recovery record.`,
      );
    }

    const args = { ...raw };
    delete args.op;
    delete args.path;

    for (const banned of FORBIDDEN_STEP_ARGS) {
      if (Object.prototype.hasOwnProperty.call(args, banned)) {
        const why =
          banned === 'vault'
            ? 'a bundle is single-vault — set `vault` once on the bundle itself'
            : 'the sealed preview belongs to the BUNDLE (write_bundle preview:true), not to individual steps';
        throw new BundleError(`${where}.${banned} is not allowed: ${why}.`);
      }
    }

    validateStepShape(op, args, where);
    return { index, op, path: filePath, args };
  });
}

/**
 * The distinct paths a step list touches, in first-appearance order. Backups are
 * taken ONCE per path, so the before-image is the pre-BUNDLE state even when two
 * steps write the same file — rollback restores what existed before the bundle,
 * not what existed before the last step.
 *
 * @param {Array<{path:string}>} steps
 * @returns {string[]}
 */
export function uniquePaths(steps) {
  const seen = new Set();
  const out = [];
  for (const s of steps) {
    if (!seen.has(s.path)) {
      seen.add(s.path);
      out.push(s.path);
    }
  }
  return out;
}

/**
 * Total size of the captured before-images, for the backup bound.
 * @param {Map<string, {existed:boolean, content:string|null}>} backups
 */
export function backupBytes(backups) {
  let total = 0;
  for (const b of backups.values()) {
    if (b && b.existed && typeof b.content === 'string') {
      total += Buffer.byteLength(b.content, 'utf8');
    }
  }
  return total;
}

/**
 * What this step will leave behind, WITHOUT reading the file back — the only
 * evidence strong enough to call a later state "ours".
 *
 * Derivable for exactly two ops, and deliberately not for the others:
 *   - `write`  — the tool PUTs `content` verbatim, so the resulting bytes are known;
 *   - `delete` — the file is gone, which is a state with no bytes to guess.
 * `append`, `patch`, `set_frontmatter` and `merge_frontmatter` are computed by
 * Obsidian's own engines (heading resolution, YAML re-emission, separator rules)
 * and the router does not model them. Predicting them would be worse than not
 * predicting: a wrong derivation reads as a foreign write and would make the
 * bundle refuse to clean up after itself.
 *
 * @returns {{exists:boolean, contentSha256:string|null}|null} null when not derivable
 */
export function derivePostImage(op, args) {
  if (op === 'write') {
    // Fingerprint what a READ-BACK would return, not what was sent. The two
    // differ by exactly one leading BOM: the transport's UTF-8 decoder strips
    // one on the way back, and `contentSha256` strips one more on top. Hashing
    // the sent bytes directly therefore mismatches for content that begins with
    // two BOMs — and a mismatch here means "foreign", which would make the
    // bundle refuse to clean up after its own write. Reproduced by probe over
    // the real wire during the C2 review.
    const asRead = args.content.charCodeAt(0) === 0xfeff ? args.content.slice(1) : args.content;
    return { exists: true, contentSha256: contentSha256(asRead) };
  }
  if (op === 'delete') return { exists: false, contentSha256: null };
  return null;
}

/**
 * Derive the sealable plan — "exactly what will be executed" (C3).
 *
 * Two halves, and both matter:
 *   - `steps`: the ordered verbs and paths, each with a fingerprint of its FULL
 *     normalised arguments. Without the argument fingerprint a caller could
 *     preview `write a.md` with one body and apply it with another under the
 *     same seal, which would make the seal decorative.
 *   - `targets`: the current existence + content fingerprint of every path,
 *     sorted, so any drift in the vault between the preview and the apply
 *     changes the seal.
 *
 * @param {Array<{index:number, op:string, path:string, args:object}>} steps
 * @param {Map<string, {existed:boolean, contentSha256:string|null}>} backups
 */
export function buildBundlePlan(steps, backups) {
  return {
    steps: steps.map((s) => ({
      index: s.index,
      op: s.op,
      path: s.path,
      argsSha256: contentSha256(canonicalize(s.args)),
    })),
    targets: uniquePaths(steps)
      .slice()
      .sort()
      .map((p) => {
        const b = backups.get(p);
        return {
          path: p,
          exists: Boolean(b && b.existed),
          contentSha256: b && b.existed ? b.contentSha256 : null,
        };
      }),
  };
}

/**
 * THE ROLLBACK DECISION TABLE.
 *
 * Pure, exhaustive, and the single place where "may this rollback write here?"
 * is decided. Inputs are three observations of one path:
 *   - `before`: what the bundle captured before its first mutation;
 *   - `last`:   what the bundle knows it left there — `{exists, contentSha256,
 *               source:'derived'|'observed'}`, or `{foreign:true}` when the
 *               bundle PROVED someone else wrote after it, or `null` when no
 *               step on this path ever completed (the first one threw);
 *   - `current`: what is there right now.
 *
 * Actions:
 *   - `none`    — already at the before-image; nothing to do.
 *   - `restore` — write the before-image back.
 *   - `delete`  — the bundle created this file; remove it.
 *   - `skip`    — SOMEONE ELSE's content is there. Never touched, always named
 *                 in the report. This is the C1 doctrine applied to rollback:
 *                 undoing our own damage must not cause someone else's.
 *
 * `attribution` grades the evidence — `ours` (derived), `observed` (read back
 * after the step, so a write inside that one round trip would be adopted), or
 * `unverified` for the single ambiguous case: a step on this path FAILED before
 * any post-image existed, and the content differs from the before-image. Either
 * that failing step wrote partially, or a third party wrote inside a millisecond
 * window. The bundle restores, because abandoning a half-applied bundle breaks
 * the one guarantee C2 sells — but an `unverified` action makes the rollback
 * UNVERIFIED (see `isVerifiedRollback`), which keeps the journal, saves the
 * content that was overwritten into it, and stops the result from claiming a
 * clean undo.
 *
 * @returns {{action:'none'|'restore'|'delete'|'skip', status:string, attribution?:string, reason?:string}}
 */
export function planRestore(before, last, current) {
  const existedBefore = Boolean(before && before.existed);
  const beforeSha = before ? before.contentSha256 : null;
  const alreadyClean = existedBefore
    ? current.exists && current.contentSha256 === beforeSha
    : !current.exists;

  // Already back where it started — the common case after a step that failed
  // without writing. Checked FIRST: even a proven foreign write needs no action
  // when what it left happens to be the pre-bundle content.
  if (alreadyClean) return { action: 'none', status: 'already-clean' };

  // A foreign write the bundle actually PROVED (its derived post-image did not
  // match the read-back). Nothing here is ours to undo.
  if (last && last.foreign) {
    return {
      action: 'skip',
      status: current.exists ? (existedBefore ? 'left-modified' : 'left-created') : 'left-deleted',
      reason:
        'this file changed under the bundle while it was running, in a way the bundle did not write — ' +
        'touching it now would destroy that change',
    };
  }

  const attribution = last && last.source === 'derived' ? 'ours' : 'observed';

  // The file existed and still exists, with different content.
  if (existedBefore && current.exists) {
    if (last && last.exists && last.contentSha256 === current.contentSha256) {
      return { action: 'restore', status: 'restored', attribution };
    }
    if (last) {
      return {
        action: 'skip',
        status: 'left-modified',
        reason:
          'the file was changed by someone else after this bundle wrote it — restoring the backup ' +
          'would destroy that edit',
      };
    }
    return { action: 'restore', status: 'restored', attribution: 'unverified' };
  }

  // The file existed and is now gone.
  if (existedBefore && !current.exists) {
    if (last && !last.exists) return { action: 'restore', status: 'restored', attribution };
    if (last) {
      return {
        action: 'skip',
        status: 'left-deleted',
        reason:
          'the file was deleted by someone else after this bundle wrote it — re-creating it would ' +
          'undo a deletion this bundle did not perform',
      };
    }
    return { action: 'restore', status: 'restored', attribution: 'unverified' };
  }

  // The file did not exist and does now.
  if (last && last.exists && last.contentSha256 === current.contentSha256) {
    return { action: 'delete', status: 'removed', attribution };
  }
  if (last) {
    return {
      action: 'skip',
      status: 'left-created',
      reason:
        'the file now holds content this bundle did not write — deleting it would destroy someone ' +
        "else's work",
    };
  }
  return { action: 'delete', status: 'removed', attribution: 'unverified' };
}

/**
 * A rollback is CLEAN only when every path is verifiably back at its
 * before-image. A skipped path, or a restore that itself errored, means the
 * vault still carries part of the operation — and the result must say so instead
 * of reporting the comforting "rolled back".
 *
 * @param {Array<{status:string, error?:string}>} paths
 */
export function isCleanRollback(paths) {
  return paths.every((p) => !p.error && (p.status === 'already-clean' || p.status === 'restored' || p.status === 'removed'));
}

/**
 * A rollback is VERIFIED when every action it took was attributable — nothing
 * was written back over content the bundle could not tie to itself. Separate
 * from `clean` on purpose: a rollback can put every file back (clean) while
 * being unable to prove that what it overwrote was its own doing.
 *
 * @param {Array<{action?:string, attribution?:string}>} paths
 */
export function isVerifiedRollback(paths) {
  return paths.every((p) => p.action === 'none' || p.action === 'skip' || p.attribution !== 'unverified');
}

/**
 * The journal record persisted before the first mutation. Plain data (null
 * prototype for the path-keyed map, since vault paths are attacker-influenced
 * keys) so a parsed journal can never carry a `__proto__` surprise.
 */
export function buildJournal({ operationId, vaultName, startedAt, steps, backups }) {
  const backupObj = Object.create(null);
  for (const p of uniquePaths(steps)) {
    const b = backups.get(p);
    backupObj[p] = b && b.existed
      ? { existed: true, content: b.content, contentSha256: b.contentSha256 }
      : { existed: false, content: null, contentSha256: null };
  }
  return {
    version: JOURNAL_VERSION,
    operationId,
    vault: vaultName,
    startedAt,
    state: JOURNAL_PENDING,
    steps: steps.map((s) => ({ index: s.index, op: s.op, path: s.path })),
    backups: backupObj,
  };
}

/**
 * Parse + validate a journal read back from the vault. A journal we cannot fully
 * trust is never acted on: it lives INSIDE the vault — a writable, syncable,
 * user-editable place — and rolling back from it means writing its `backups`
 * keys as paths and its `content` as bytes. Every field a recovery would obey is
 * validated here.
 *
 * @param {string} raw
 * @param {string} sourcePath for the error message
 * @param {object} [opts]
 * @param {string} [opts.expectOperationId] refuse a journal whose id does not
 *   match the file it was read from (a renamed/planted record).
 * @param {boolean} [opts.requirePending] refuse a terminal journal (recovery).
 */
export function parseJournal(raw, sourcePath, { expectOperationId, requirePending = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BundleError(
      `The write journal at ${safeForMessage(sourcePath, 200)} is not readable JSON. Refusing to roll back from it — ` +
        `inspect the file by hand.`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new BundleError(`The write journal at ${safeForMessage(sourcePath, 200)} is not an object.`);
  }
  if (parsed.version !== JOURNAL_VERSION) {
    throw new BundleError(
      `The write journal at ${safeForMessage(sourcePath, 200)} is version ${safeForMessage(parsed.version, 80)}; this router speaks ` +
        `version ${JOURNAL_VERSION}. Refusing to act on a shape it may misread.`,
    );
  }
  if (!isOperationId(parsed.operationId)) {
    throw new BundleError(`The write journal at ${safeForMessage(sourcePath, 200)} has no valid operationId.`);
  }
  if (expectOperationId !== undefined && parsed.operationId !== expectOperationId) {
    throw new BundleError(
      `The write journal at ${safeForMessage(sourcePath, 200)} carries operationId "${safeForMessage(parsed.operationId, 80)}" but is filed ` +
        `under "${safeForMessage(expectOperationId, 80)}". Refusing to act on a record that was renamed or planted.`,
    );
  }
  const state = typeof parsed.state === 'string' ? parsed.state : null;
  if (state !== JOURNAL_PENDING && !TERMINAL_JOURNAL_STATES.includes(state)) {
    throw new BundleError(
      `The write journal at ${safeForMessage(sourcePath, 200)} has an unrecognised state ${safeForMessage(JSON.stringify(parsed.state), 80)}.`,
    );
  }
  if (requirePending && state !== JOURNAL_PENDING) {
    throw new BundleError(
      `The write journal at ${safeForMessage(sourcePath, 200)} is already "${safeForMessage(state, 80)}" — that operation reached a decided ` +
        `state. Replaying its backups would UNDO it. Delete the file if you no longer need the record.`,
    );
  }
  const backups = parsed.backups;
  if (!isPlainObject(backups)) {
    throw new BundleError(`The write journal at ${safeForMessage(sourcePath, 200)} has no backups map.`);
  }
  const clean = Object.create(null);
  for (const key of Object.keys(backups)) {
    // The keys become write targets during a recovery. Canonicalise + contain
    // them here, exactly as a live step list is contained.
    const canonical = canonicalVaultPath(key, `The write journal at ${safeForMessage(sourcePath, 200)}: backup path`);
    if (isJournalPath(canonical)) {
      throw new BundleError(
        `The write journal at ${safeForMessage(sourcePath, 200)} names "${safeForMessage(key, 200)}", inside ${BUNDLE_JOURNAL_DIR}/. A recovery ` +
          `never writes into the journal directory.`,
      );
    }
    if (canonical !== key) {
      throw new BundleError(
        `The write journal at ${safeForMessage(sourcePath, 200)} names "${safeForMessage(key, 200)}", which is not the canonical spelling of ` +
          `"${safeForMessage(canonical, 200)}". Refusing to act on a record this router did not write.`,
      );
    }
    const b = backups[key];
    if (!isPlainObject(b) || typeof b.existed !== 'boolean') {
      throw new BundleError(`The write journal at ${safeForMessage(sourcePath, 200)} has a malformed backup for "${safeForMessage(key, 200)}".`);
    }
    if (b.existed && typeof b.content !== 'string') {
      throw new BundleError(
        `The write journal at ${safeForMessage(sourcePath, 200)} records "${safeForMessage(key, 200)}" as existing but stores no content — ` +
          `it cannot restore what it does not hold.`,
      );
    }
    // Re-derive the fingerprint instead of trusting the stored one: a journal
    // whose hash disagrees with its own content would make every attribution
    // check meaningless.
    clean[canonical] = b.existed
      ? { existed: true, content: b.content, contentSha256: contentSha256(b.content) }
      : { existed: false, content: null, contentSha256: null };
  }
  // `salvage` — content a previous unverified action overwrote — must survive a
  // re-read, or a second partial recovery erases the copy the first one made.
  // Validated with the same containment rules as the backups it sits beside.
  const salvage = Object.create(null);
  if (isPlainObject(parsed.salvage)) {
    for (const key of Object.keys(parsed.salvage)) {
      const entry = parsed.salvage[key];
      if (!isPlainObject(entry) || typeof entry.content !== 'string') continue;
      const canonical = canonicalVaultPath(key, `The write journal at ${safeForMessage(sourcePath, 200)}: salvage path`);
      if (canonical !== key || isJournalPath(canonical)) continue;
      salvage[canonical] = { content: entry.content, contentSha256: contentSha256(entry.content) };
    }
  }

  return {
    version: parsed.version,
    operationId: parsed.operationId,
    state,
    vault: typeof parsed.vault === 'string' ? parsed.vault : null,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    backups: clean,
    ...(Object.keys(salvage).length ? { salvage } : {}),
  };
}

/**
 * Human summary of an outcome. Kept here so the wording is identical in the
 * apply path and the recovery path.
 *
 * Note on "identical": restoration puts back exactly the content the router READ
 * — which is the decoded text, not the raw disk bytes. A leading UTF-8 BOM is
 * stripped by the read path (see content-hash.mjs, the same deliberate
 * normalisation C1 depends on), so a BOM-prefixed file comes back without its
 * BOM. That is why the message says "the content the bundle read" rather than
 * the byte-level claim it would be tempting to make.
 */
export function outcomeMessage({ outcome, operationId, applied, skipped = 0, total, failedStep, residue = [], unverified = [], journalPath }) {
  if (outcome === 'applied') {
    const skippedNote = skipped ? ` (${skipped} of them a no-op the target already satisfied)` : '';
    return `Bundle ${operationId} applied all ${total} step(s)${skippedNote}.`;
  }
  const at = `FAILED at step ${failedStep + 1} of ${total}`;
  if (outcome === 'rolled-back') {
    return (
      `Bundle ${operationId} ${at} and was rolled back completely — every file it touched holds exactly ` +
      `the content the bundle read before it started. Nothing partial remains.`
    );
  }
  if (outcome === 'rolled-back-unverified') {
    return (
      `Bundle ${operationId} ${at} and every file was put back, but the undo could NOT be proven for: ` +
      `${unverified.join(', ')}. The failing step never confirmed a write there, so the content that was ` +
      `overwritten could not be attributed — if another session was writing at that instant, its work was ` +
      `the thing overwritten. That content was saved into the journal kept at ${journalPath}.`
    );
  }
  return (
    `Bundle ${operationId} ${at} and could NOT be fully rolled back. ${applied} step(s) had run. ` +
    `Still not restored: ${residue.join(', ')}. The rollback journal was KEPT at ${journalPath} — it holds ` +
    `the exact pre-bundle content of every target. Inspect those files, then either repair them by hand or ` +
    `re-run write_bundle with recover:"${operationId}".`
  );
}
