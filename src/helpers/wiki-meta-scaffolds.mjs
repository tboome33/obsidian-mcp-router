/**
 * The names of the private `wiki-meta/` scaffolds — one place, because they
 * are referenced from hooks, skills, the server, the scaffolder and the lint.
 *
 * Roland's 2026-07-30 decision (vault note
 * `wiki/obsidian-mcp-router/decisions/catalog-journal-et-projections-okf.md`)
 * renamed two of them:
 *
 *   wiki-meta/index.md  →  wiki-meta/catalog.md
 *   wiki-meta/log.md    →  wiki-meta/journal.md
 *
 * Not cosmetics: OKF **reserves** the basenames `index.md` (per-directory
 * table of contents) and `log.md` (newest-first content history), and the
 * next lot adds conformant files under those exact names inside `wiki/`.
 * Obsidian resolves wikilinks by basename, so leaving our scaffolds where
 * they were would make `[[index]]`/`[[log]]` — cited ~480 times across the
 * fleet — silently retarget to the generated artefacts. `hot.md` and
 * `overview.md` collide with nothing and keep their names.
 *
 * Every READ path accepts the legacy name as a fallback, because the code
 * ships as a plugin that updates independently of the vaults it reads: a
 * user can be on a new plugin with an un-migrated vault. Reads degrade to
 * the old file and surface `scaffoldMigrationHint()`; WRITES always target
 * the new name. Migrate a vault with:
 *
 *   node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --all-vaults --apply
 */

/** Current basenames. */
export const CATALOG_BASENAME = 'catalog.md';
export const JOURNAL_BASENAME = 'journal.md';

/** Pre-2026-07-30 basenames — read-only compatibility. */
export const LEGACY_CATALOG_BASENAME = 'index.md';
export const LEGACY_JOURNAL_BASENAME = 'log.md';

/** Vault-relative paths (posix), current names. */
export const CATALOG_REL = `wiki-meta/${CATALOG_BASENAME}`;
export const JOURNAL_REL = `wiki-meta/${JOURNAL_BASENAME}`;

/** Vault-relative paths (posix), legacy names. */
export const LEGACY_CATALOG_REL = `wiki-meta/${LEGACY_CATALOG_BASENAME}`;
export const LEGACY_JOURNAL_REL = `wiki-meta/${LEGACY_JOURNAL_BASENAME}`;

/**
 * The four scaffolds a bootstrapped vault carries, current names.
 * Order is the scaffolding order, not alphabetical.
 */
export const WIKI_META_SCAFFOLDS = ['hot.md', CATALOG_BASENAME, JOURNAL_BASENAME, 'overview.md'];

/** Same list under the pre-2026-07-30 names. */
export const LEGACY_WIKI_META_SCAFFOLDS = [
  'hot.md',
  LEGACY_CATALOG_BASENAME,
  LEGACY_JOURNAL_BASENAME,
  'overview.md',
];

const CANDIDATES = {
  catalog: [CATALOG_REL, LEGACY_CATALOG_REL],
  journal: [JOURNAL_REL, LEGACY_JOURNAL_REL],
};

/**
 * Vault-relative paths to try for a scaffold, most-current first.
 *
 * @param {'catalog'|'journal'} which
 * @returns {string[]}
 */
export function scaffoldCandidates(which) {
  const list = CANDIDATES[which];
  if (!list) throw new TypeError(`unknown wiki-meta scaffold "${which}" (expected "catalog" or "journal")`);
  return [...list];
}

/**
 * Should a failed read of the current name fall through to the legacy one?
 *
 * ONLY on a genuine "that file is not there" (HTTP 404 → `kind: 'not_found'`).
 * Any other kind — `unreachable`, `unauthorized`, `timeout`, `server_error` —
 * says something about the VAULT, not about which name the scaffold has:
 * retrying under the old name cannot succeed, and it replaces a precise
 * diagnosis with a misleading one (an offline vault reporting "catalog not
 * found" instead of "vault offline"). Errors without a `kind` are treated as
 * fatal for the same reason: unknown cause, don't guess.
 *
 * @param {unknown} err
 */
export function shouldTryLegacyScaffold(err) {
  return Boolean(err) && err.kind === 'not_found';
}

/** True when `relPath` names the legacy file rather than the current one. */
export function isLegacyScaffoldPath(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/');
  return p === LEGACY_CATALOG_REL || p === LEGACY_JOURNAL_REL;
}

/**
 * One-line bilingual nudge to print when a read fell back to a legacy name.
 * Kept short: it rides along inside hook output and tool results.
 *
 * @param {string} relPath The legacy path that was actually read
 */
export function scaffoldMigrationHint(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/');
  const next = p === LEGACY_CATALOG_REL ? CATALOG_REL : JOURNAL_REL;
  return (
    `\`${p}\` utilise l'ancien nom — OKF réserve ce basename. Renommez-le en \`${next}\` : ` +
    '`node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --all-vaults --apply`' +
    ` · \`${p}\` uses the pre-0.58.0 name — OKF reserves that basename; rename it to \`${next}\`.`
  );
}

/**
 * Resolve a scaffold against the filesystem: the current name when present,
 * else the legacy one, else null.
 *
 * `fsMod`/`pathMod` are injected so this module stays importable from pure
 * contexts; callers in hooks/scripts pass node's `fs`/`path`.
 *
 * @param {string} vaultPath Absolute vault root
 * @param {'catalog'|'journal'} which
 * @param {{fs: object, path: object}} mods
 * @returns {{absPath: string, relPath: string, legacy: boolean} | null}
 */
export function resolveScaffold(vaultPath, which, { fs, path }) {
  for (const rel of scaffoldCandidates(which)) {
    const absPath = path.join(vaultPath, ...rel.split('/'));
    if (fs.existsSync(absPath)) {
      return { absPath, relPath: rel, legacy: isLegacyScaffoldPath(rel) };
    }
  }
  return null;
}

/**
 * Path to WRITE a scaffold to: always the current name, whether or not the
 * legacy file is still sitting next to it.
 *
 * @param {string} vaultPath
 * @param {'catalog'|'journal'} which
 * @param {{path: object}} mods
 */
export function scaffoldWritePath(vaultPath, which, { path }) {
  const rel = scaffoldCandidates(which)[0];
  return path.join(vaultPath, ...rel.split('/'));
}
