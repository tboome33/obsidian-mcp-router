/**
 * A vault's conventions, read over its REST API — for the audit tool, and for
 * the brief a session receives the first time it writes into that vault.
 *
 * WHY THE BRIEF EXISTS. Claude Code loads the `CLAUDE.md` of the working
 * directory and its parents, and nothing else. From a code workspace, the
 * conventions file of the vault it writes into is never read; inside a vault
 * born from the template, that file sits under `Documentation/`, which is not
 * read either. On 2026-09-25 a session wrote a whole night of pages into a
 * secondary vault without knowing its conventions existed. The write tools were
 * the one place every such session passes through — so that is where the
 * conventions are now presented: once per vault per session, in the response
 * of the first write, with the path to read for the full text.
 *
 * WHAT IT NEVER DOES. It never blocks a write, never writes, and never fails
 * the call that triggered it: a vault whose conventions cannot be read gets a
 * brief that says so, and the write result is otherwise untouched.
 */
import { getFileContent, listFilesIn } from '../rest-client.mjs';
import { CLAUDE_MD_CANDIDATES } from '../helpers/claude-md-conventions.mjs';
import { auditVaultConventions, backupKey, RECOMMENDED_CONVENTION_IDS } from '../helpers/conventions-audit.mjs';
import { loadConventionCatalogue } from '../helpers/convention-catalogue.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';
import { isBackupName } from '../helpers/root-docs-filter.mjs';
import { checkWrittenPage } from '../helpers/write-time-page-checks.mjs';

export const TOOL_DEFINITION = {
  name: 'audit_vault_conventions',
  description:
    "READ-ONLY. Which conventions a vault is really under: the conventions file the router resolves (or the two it cannot choose between), the conventions it carries, the recommended ones it lacks, which files are verbatim copies of the reference (template) vault's, and which CLAUDE.md.bak-* backups are the template's history rather than this vault's. Works on remote vaults (over REST). Each finding carries a repair step (a move_file with its ifMatch, or a conventions-skill install from the CURRENT snippet) to PROPOSE to the user — never apply one without their go-ahead. A backup that holds a convention the current file lacks is NOT evidence of a loss when the audit marks it inherited.",
  inputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string', description: 'Vault name (see list_vaults). Omit for the default vault.' },
    },
    required: [],
    additionalProperties: false,
  },
};

/** getFileContent answers a string, or an object carrying `content`. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

/** A 404 on a directory listing means "this folder does not exist". */
function isNotFound(err) {
  return err?.status === 404 || err?.statusCode === 404 || /\b404\b/.test(String(err?.message ?? ''));
}

/**
 * Candidates, and the backups beside them, read over REST.
 * @returns {Promise<{candidates: object[], backups: object[]}>}
 */
export async function readVaultConventionsOverRest(vault, deps = {}, { withBackups = true, deadlineAt = Infinity } = {}) {
  // Racing the whole read against a deadline stops the WAITING, not the work:
  // a late listing would still go on to issue its reads. So each request is
  // gated on the deadline before it is sent. (One request already in flight
  // runs to its own REST timeout; nothing after it starts.)
  const gate = () => {
    if (Date.now() >= deadlineAt) throw new Error('deadline passed before the next request');
  };
  const list = async (...a) => { gate(); return (deps.listFilesIn ?? listFilesIn)(...a); };
  const read = async (...a) => { gate(); return (deps.getFileContent ?? getFileContent)(...a); };
  const dirs = [...new Set(CLAUDE_MD_CANDIDATES.map((c) => (c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '')))];
  const candidates = [];
  const backups = [];
  for (const dir of dirs) {
    let files;
    try {
      const listing = await list(vault, dir);
      files = Array.isArray(listing?.files) ? listing.files : [];
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    for (const name of files) {
      if (typeof name !== 'string' || name.endsWith('/')) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (CLAUDE_MD_CANDIDATES.includes(rel)) {
        const content = asText(await read(vault, rel));
        candidates.push({ path: rel, content, sha256: contentSha256(content) });
      } else if (withBackups && name.startsWith('CLAUDE.md') && isBackupName(name)) {
        const content = asText(await read(vault, rel));
        backups.push({ path: rel, sha256: contentSha256(content) });
      }
    }
  }
  // Candidate order, not listing order: resolveClaudeMd reports `present` in
  // this order and a stable order keeps the brief stable.
  candidates.sort((a, b) => CLAUDE_MD_CANDIDATES.indexOf(a.path) - CLAUDE_MD_CANDIDATES.indexOf(b.path));
  return { candidates, backups };
}

/**
 * The `audit_vault_conventions` tool.
 *
 * @param {object} registry
 * @param {{vault?: string}} args
 * @param {{referenceVaultName?: () => string|null}} [ctx] names the registered
 *   vault that is the reference (template), when there is one
 */
export async function auditVaultConventionsTool(registry, args = {}, ctx = {}, deps = {}) {
  const vault = registry.resolveVault(args.vault);
  const { catalogue, errors } = loadConventionCatalogue();
  if (catalogue.length === 0) {
    throw new Error(`the convention library could not be loaded: ${errors.join('; ') || 'no snippets'}`);
  }
  const { candidates, backups } = await readVaultConventionsOverRest(vault, deps);

  let referenceFingerprints = null;
  let referenceBackups = [];
  let reference = { name: null, status: 'not-configured' };
  const refName = typeof ctx.referenceVaultName === 'function' ? ctx.referenceVaultName() : null;
  if (refName && refName === vault.name) {
    referenceFingerprints = new Set();
    reference = { name: refName, status: 'is-this-vault' };
  } else if (refName) {
    try {
      const refVault = registry.resolveVault(refName);
      const ref = await readVaultConventionsOverRest(refVault, deps);
      referenceFingerprints = new Set([...ref.candidates.map((c) => c.sha256), ...ref.backups.map((b) => b.sha256)]);
      referenceBackups = ref.backups.map((b) => backupKey(b.path, b.sha256));
      reference = { name: refName, status: 'read' };
    } catch (err) {
      reference = { name: refName, status: 'unreadable', reason: String(err?.message ?? err).slice(0, 200) };
    }
  }

  const audit = auditVaultConventions({ vault: vault.name, candidates, backups, referenceFingerprints, referenceBackups, catalogue });
  return {
    ...audit,
    reference,
    ...(errors.length > 0 && { libraryErrors: errors }),
    note: 'Read-only. Each finding\'s repair is a step to propose to the user and apply only on their go-ahead — never automatically.',
  };
}

/** One line per decision-page rule, for the brief. */
const DECISION_CONTRACT = Object.freeze({
  types: ['decision', 'adr', 'decision-input'],
  status: ['proposed', 'accepted', 'superseded', 'rejected'],
  statusRule: 'an agent writes `proposed`; only the human accepts',
  frontmatter: ['type', 'status', 'scope', 'description', 'created', 'updated', 'source_type (when the source-type convention is installed)'],
  sections: {
    'decision / adr': ['## Context', '## Decision', '## Consequences', '## Alternatives considered'],
    'decision-input': ['## Context'],
  },
});

/** The compact brief, from an audit. Pure. */
export function buildConventionsBrief(audit) {
  const effective = audit.candidates.find((c) => c.path === audit.conventionsFile) ?? null;
  const installed = effective ? effective.conventions : [];
  const brief = {
    vault: audit.vault,
    conventionsFile: audit.conventionsFile,
    installed,
    missingRecommended: audit.missingRecommended.filter((id) => RECOMMENDED_CONVENTION_IDS.includes(id)),
    decisionPages: DECISION_CONTRACT,
  };
  if (audit.ambiguous) {
    brief.ambiguous = audit.candidates.map((c) => ({ path: c.path, conventions: c.conventions }));
    brief.read = `This vault has ${audit.candidates.length} conventions files and the router cannot tell which is in force: read them (get_file) and ask the user before writing substantive pages. audit_vault_conventions proposes the repair.`;
  } else if (audit.conventionsFile) {
    brief.read = `Read it before writing substantive pages: get_file({ vault: "${audit.vault}", path: "${audit.conventionsFile}" }). It is not loaded into your context by anything else.`;
  } else {
    brief.read = 'This vault has no conventions file: no convention is in force. Follow the decision-page contract below anyway — the wiki lint enforces it.';
  }
  brief.shown = 'once per vault per server process — one session, for the plugin';
  return brief;
}

/** Tools whose successful call may have written a page. */
export const CONVENTIONS_BRIEF_TOOLS = new Set([
  'write_file', 'append_to_file', 'patch_file', 'write_bundle', 'set_frontmatter', 'merge_frontmatter',
]);

const MAX_PAGES_CHECKED = 10;

/** The vault-relative `.md` paths a successful call wrote, and any content it already carries. */
function pagesTouched(name, args) {
  const pages = [];
  const isMd = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.md');
  if (name === 'write_bundle') {
    // Always read back: a later step of the same bundle (append, patch,
    // frontmatter) can change a page an earlier `write` step created, so the
    // step's own content is not what the page now says.
    // A page whose LAST step is a delete no longer exists: nothing to check.
    const lastOp = new Map();
    for (const step of Array.isArray(args?.steps) ? args.steps : []) {
      if (isMd(step?.path)) lastOp.set(step.path, step.op);
    }
    for (const [p, op] of lastOp) {
      if (op !== 'delete') pages.push({ path: p, content: null });
    }
  } else if (name === 'append_to_file') {
    // Not checked: an append adds to the END of a page and cannot remove a
    // frontmatter field or a section — and checking it meant downloading the
    // whole page (a large journal.md) on every append.
  } else if (isMd(args?.path)) {
    pages.push({ path: args.path, content: name === 'write_file' && typeof args.content === 'string' ? args.content : null });
  }
  return pages;
}

/**
 * The whole post-write addition shares ONE deadline: the write has already
 * succeeded, and a slow or hung vault must not hold its response. Past the
 * deadline the result says the brief was not built, instead of waiting.
 */
export const BRIEF_DEADLINE_MS = 5000;

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Per-session state: which vaults have had their brief. One instance per server.
 */
export function createConventionsBriefing(deps = {}) {
  const briefed = new Set();
  const audits = new Map(); // vault name → the audit its brief was built from
  const read = deps.getFileContent ?? getFileContent;
  const deadlineMs = Number.isFinite(deps.deadlineMs) && deps.deadlineMs > 0 ? deps.deadlineMs : BRIEF_DEADLINE_MS;
  return {
    /** For tests and diagnostics. */
    briefedVaults: () => [...briefed],
    /**
     * @returns {Promise<object|null>} fields to merge into the write result
     */
    async forWrite(registry, name, args, result) {
      if (!CONVENTIONS_BRIEF_TOOLS.has(name)) return null;
      // A call that wrote NOTHING this time — a patch skipped by
      // `applyIfContentPreexists`, a merge that applied no key — neither
      // spends the vault's one brief nor re-checks a page it did not change.
      if (result?.patched === false || result?.applied === 0) return null;
      const out = {};
      let vault;
      try { vault = registry.resolveVault(result?.vault ?? args?.vault); } catch { return null; }
      const started = Date.now();
      const remaining = () => Math.max(1, deadlineMs - (Date.now() - started));

      if (!briefed.has(vault.name)) {
        briefed.add(vault.name);
        try {
          const { catalogue } = loadConventionCatalogue();
          // The brief needs the conventions file(s), not the backups: reading
          // them would add one GET per backup to the session's first write.
          const { candidates } = await withDeadline(
            readVaultConventionsOverRest(vault, deps, { withBackups: false, deadlineAt: started + deadlineMs }), remaining(), 'reading the conventions file',
          );
          const fresh = auditVaultConventions({
            vault: vault.name, candidates, backups: [], referenceFingerprints: null, catalogue,
          });
          audits.set(vault.name, fresh);
          out.vaultConventions = buildConventionsBrief(fresh);
        } catch (err) {
          out.vaultConventions = {
            vault: vault.name,
            unavailable: `the conventions file could not be read (${String(err?.message ?? err).slice(0, 160)}) — read it yourself before writing substantive pages`,
            decisionPages: DECISION_CONTRACT,
          };
        }
      }

      const audit = audits.get(vault.name) ?? null;
      const vaultHasSourceType = audit
        ? (audit.ambiguous ? null : (audit.candidates.find((c) => c.path === audit.conventionsFile)?.conventions.includes('source-type') ?? false))
        : null;
      const checks = [];
      const skipped = [];
      const touched = pagesTouched(name, args);
      // Past the cap, pages are REPORTED as unchecked — dropping them before the
      // loop let an eleventh bad decision page pass in silence (review round 2).
      const overCap = touched.slice(MAX_PAGES_CHECKED).map((p) => p.path);
      for (const page of touched.slice(0, MAX_PAGES_CHECKED)) {
        let content = page.content;
        if (content === null) {
          if (Date.now() - started >= deadlineMs) { skipped.push(page.path); continue; }
          try { content = asText(await withDeadline(read(vault, page.path), remaining(), `reading ${page.path}`)); } catch { skipped.push(page.path); continue; }
        }
        const r = checkWrittenPage({ path: page.path, content, vaultHasSourceType });
        if (r.checked && r.findings.length > 0) checks.push({ path: page.path, type: r.type, findings: r.findings });
      }
      if (checks.length > 0) {
        out.pageChecks = checks;
        out.pageChecksNote = 'Written as asked — these are warnings, not refusals. Fix them in a follow-up write.';
      }
      if (skipped.length > 0 || overCap.length > 0) {
        // Unchecked is said, never passed off as clean.
        out.pageChecksSkipped = {
          ...(skipped.length > 0 && { paths: skipped, reason: `not read back within ${deadlineMs} ms, or unreadable — these pages were NOT checked` }),
          ...(overCap.length > 0 && { overLimit: overCap, overLimitReason: `only the first ${MAX_PAGES_CHECKED} pages of a call are checked — these were NOT` }),
        };
      }
      return Object.keys(out).length > 0 ? out : null;
    },
  };
}
