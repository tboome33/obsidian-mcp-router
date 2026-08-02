/**
 * `record_source` + `audit_sources` — the MCP surface of the C6 source ledger.
 *
 * `src/helpers/source-ledger.mjs` holds the pure rules (identity, authority,
 * independence, refresh horizons); this module is the I/O around them: read
 * `wiki-meta/source-ledger.json` over REST, apply one forward-fill record, write
 * it back.
 *
 * CONCURRENCY — the ledger is a SHARED file. Parallel sessions ingesting into
 * the same vault would clobber each other's entries with a plain write, so the
 * update is a compare-and-swap using C1's `ifMatch`: the fingerprint read at
 * load time must still hold at write time, otherwise the write is refused with
 * an actionable "re-read and retry" rather than silently dropping someone
 * else's source. (This is exactly the recurring incident C1 was built for; the
 * ledger is a textbook case for it.)
 *
 * The two tools split along a hard line: `record_source` WRITES (forward-fill,
 * one source at a time, authority declared by the caller), `audit_sources` only
 * READS (staleness, review gaps, independence). Nothing infers an entry from
 * existing prose — see the forward-fill rule in the helper.
 */

import * as defaultRestClient from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';
import {
  recordSource,
  auditLedger,
  pageIndependence,
  emptyLedger,
  isUsableLedger,
  AUTHORITY_TIERS,
  REVIEW_STATES,
  SOURCE_LEDGER_PATH,
  LEDGER_VERSION,
} from '../helpers/source-ledger.mjs';

export const RECORD_TOOL_NAME = 'record_source';
export const AUDIT_TOOL_NAME = 'audit_sources';

export const RECORD_TOOL_DEFINITION = {
  name: RECORD_TOOL_NAME,
  description:
    "Record ONE source in the vault's source ledger (`wiki-meta/source-ledger.json`) — the structured register behind \"which sources is this page resting on, how authoritative are they, and when should they be re-checked?\". Call it from an ingestion (wiki-ingest / autoresearch) at the moment the content is fetched. FORWARD-FILL ONLY: the ledger is never back-filled by guessing from prose, and `authority` must be DECLARED (official | primary | secondary | community | synthetic) — it is never inferred from the source itself. URLs are normalised (tracking params stripped, credentials refused) so the same article under two addresses is one entry, and each source gets an `independenceKey` (its registrable domain) so two articles from the same site can never be counted as two independent sources. Re-recording an unchanged source is a no-op; re-recording CHANGED content invalidates any prior human review and says so. The update is a compare-and-swap, so parallel sessions cannot clobber each other's entries.",
  inputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string', description: 'Vault name (see list_vaults). Omit for the default vault.' },
      kind: { type: 'string', enum: ['url', 'file', 'text'], description: "Source kind. 'url' for a fetched page, 'file' for a local document, 'text' for pasted/generated content." },
      url: { type: 'string', description: "Required when kind='url'. Normalised before storage; an address carrying credentials is refused, not sanitised silently." },
      id: { type: 'string', description: "Required when kind='file' or 'text' — a stable identifier (absolute path, or a caller-chosen id for pasted/generated text)." },
      authority: { type: 'string', enum: AUTHORITY_TIERS, description: 'DECLARED authority tier. official = the thing itself (vendor docs, spec, law, the project repo) · primary = first-hand evidence (study, dataset, dated announcement) · secondary = reporting/analysis about primary material · community = forum/blog/Q&A, useful but unvetted · synthetic = produced by a model, recorded so it is never mistaken for evidence.' },
      title: { type: 'string', description: 'Human label for the source.' },
      content: { type: 'string', description: 'The captured content (post-defuddle for URLs) — fingerprinted so a later re-capture can tell whether the source changed. Omit if you already have the digest.' },
      contentHash: { type: 'string', description: 'Pre-computed SHA-256 hex of the captured content (alternative to `content`).' },
      pages: { type: 'array', items: { type: 'string' }, description: 'Vault page path(s) that rest on this source. Accumulated across recordings.' },
      reviewState: { type: 'string', enum: REVIEW_STATES, description: "Defaults to 'unreviewed' — nothing is vetted merely by existing. A 'reviewed' mark is preserved on re-recording UNLESS the content changed, which invalidates it." },
      refreshEveryDays: { type: 'number', description: 'Override the per-tier refresh horizon (official/primary 365, secondary 180, community 90, synthetic 30).' },
      independenceKey: { type: 'string', description: 'Override the derived registrable domain — use when the heuristic groups two genuinely independent publishers, or fails to group two arms of the same one.' },
      capturedAt: { type: 'string', description: 'ISO instant the content was fetched. Defaults to now.' },
      note: { type: 'string', description: 'Free-form note for a reviewer.' },
    },
    required: ['kind', 'authority'],
    additionalProperties: false,
  },
};

export const AUDIT_TOOL_DEFINITION = {
  name: AUDIT_TOOL_NAME,
  description:
    "READ-ONLY audit of the vault's source ledger: which sources are past their refresh horizon (with how many days overdue), which are still unreviewed or disputed, the spread across authority tiers, and how many INDEPENDENT origins the ledger really represents (two articles from the same site count once). Pass `page` to get the independence verdict for one page's sources — whether it is corroborated by at least `required` distinct origins, with synthetic output and retired sources excluded from the count and reported separately. Reports, never rewrites: staleness and single-origin clusters are surfaced for a human to act on. Feeds wiki-lint.",
  inputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string', description: 'Vault name (see list_vaults). Omit for the default vault.' },
      page: { type: 'string', description: 'Vault page path — returns the independence verdict for the sources backing that page.' },
      required: { type: 'number', description: 'How many distinct origins count as corroborated, for `page`. Default 2.' },
    },
    required: [],
    additionalProperties: false,
  },
};

/** Coerce a getFileContent result (string | {content}) into a string. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

/**
 * Read the stored ledger. Returns `{ ledger, raw, existed }` — `raw` is the
 * exact bytes read, so the caller can use their fingerprint as an `ifMatch`
 * precondition. A 404 means "not started yet" (normal); anything else is about
 * the vault and must surface.
 */
export async function readLedger(getFileContent, vault) {
  let raw;
  try {
    raw = asText(await getFileContent(vault, SOURCE_LEDGER_PATH));
  } catch (err) {
    if (err?.kind === 'not_found') return { ledger: emptyLedger(vault.name), raw: null, existed: false };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const e = new Error(
      `The source ledger at ${SOURCE_LEDGER_PATH} in vault "${vault.name}" is not readable JSON. ` +
        `Refusing to overwrite it — inspect or move the file, then record again.`,
    );
    e.kind = 'validation';
    throw e;
  }
  if (!isUsableLedger(parsed)) {
    const found = parsed && typeof parsed.version !== 'undefined' ? String(parsed.version) : 'unknown';
    const e = new Error(
      `The source ledger in vault "${vault.name}" is version ${found}; this router speaks version ` +
        `${LEDGER_VERSION}. Refusing to write against a shape it may misread.`,
    );
    e.kind = 'validation';
    throw e;
  }
  return { ledger: parsed, raw, existed: true };
}

/** MCP tool — forward-fill one source into the ledger (compare-and-swap write). */
export async function recordSourceTool(registry, args = {}, _deps = {}) {
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    writeFileIfMatch: _deps.writeFileIfMatch || defaultRestClient.writeFileIfMatch,
    now: _deps.now || (() => new Date().toISOString()),
  };
  const vault = registry.resolveVault(args.vault);
  const { ledger, raw, existed } = await readLedger(deps.getFileContent, vault);

  // The helper validates the declaration and throws an actionable error on a
  // missing/invalid tier — no silent defaults.
  const { ledger: next, entry, outcome, contentChanged } = recordSource(ledger, {
    kind: args.kind,
    url: args.url,
    id: args.id,
    authority: args.authority,
    title: args.title,
    content: args.content,
    contentHash: args.contentHash,
    pages: args.pages,
    reviewState: args.reviewState,
    refreshEveryDays: args.refreshEveryDays,
    independenceKey: args.independenceKey,
    capturedAt: args.capturedAt ?? deps.now(),
    note: args.note,
  });

  const json = `${JSON.stringify(next, null, 2)}\n`;
  let casMode = null;
  if (outcome === 'unchanged' && existed) {
    // Nothing to persist — do not churn a shared file (and do not risk a
    // spurious conflict) for a write that would change nothing.
    return sanitizeResponse({
      vault: vault.name, path: SOURCE_LEDGER_PATH, outcome, contentChanged,
      written: false, entry, total: Object.keys(next.sources).length,
    });
  }
  if (existed) {
    // Compare-and-swap against exactly the bytes we read (C1): a parallel
    // session that recorded between our read and our write makes this fail
    // loudly instead of erasing their entry.
    const res = await deps.writeFileIfMatch(vault, SOURCE_LEDGER_PATH, json, contentSha256(raw));
    casMode = res?.casMode ?? null;
  } else {
    // Creation is guarded too: without `applyIfContentPreexists:false`, two
    // sessions that both saw a 404 would both plain-write and one session's
    // source would vanish silently — the very lost-update this file's
    // concurrency note claims to prevent, at the moment a fresh vault is most
    // likely under parallel batch ingestion (Fable 5 review).
    try {
      await deps.writeFile(vault, SOURCE_LEDGER_PATH, json, { applyIfContentPreexists: false });
    } catch (err) {
      if (err?.kind === 'conflict' || err?.status === 409) {
        const e = new Error(
          `Another session created the source ledger for vault "${vault.name}" while this record was ` +
            `being prepared. Nothing was overwritten — call record_source again to merge into it.`,
        );
        e.kind = 'conflict';
        throw e;
      }
      throw err;
    }
  }

  return sanitizeResponse({
    vault: vault.name,
    path: SOURCE_LEDGER_PATH,
    outcome,
    contentChanged,
    written: true,
    ...(casMode ? { casMode } : {}),
    entry,
    total: Object.keys(next.sources).length,
  });
}

/** MCP tool — read-only audit of the ledger. */
export async function auditSourcesTool(registry, args = {}, _deps = {}) {
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    now: _deps.now || (() => new Date().toISOString()),
  };
  const vault = registry.resolveVault(args.vault);
  const { ledger, existed } = await readLedger(deps.getFileContent, vault);

  if (!existed) {
    return sanitizeResponse({
      vault: vault.name,
      path: SOURCE_LEDGER_PATH,
      ledgerPresent: false,
      total: 0,
      note:
        `No source ledger yet for vault "${vault.name}". It is filled FORWARD by ingestion ` +
        `(record_source), never back-filled from existing prose — so an empty ledger means ` +
        `"nothing has been recorded yet", not "this vault has no sources".`,
    });
  }

  const report = auditLedger(ledger, deps.now());
  return sanitizeResponse({
    vault: vault.name,
    path: SOURCE_LEDGER_PATH,
    ledgerPresent: true,
    ...report,
    ...(args.page
      ? { pageVerdict: pageIndependence(ledger, args.page, Number.isFinite(args.required) ? args.required : 2) }
      : {}),
  });
}
