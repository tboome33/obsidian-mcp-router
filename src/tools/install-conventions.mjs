/**
 * `install_conventions` — install one or more library conventions into a
 * vault's conventions file in ONE guarded write, and prove the result.
 *
 * WHY A TOOL AND NOT A SKILL PROCEDURE
 * ------------------------------------
 * The `conventions` skill used to do `get_file` then one `append_to_file` per
 * convention, with no precondition. Two things were wrong with that:
 *
 *   1. On a vault `list_vaults` reports as shared (`writesRequireIfMatch`) a
 *      bare append is REFUSED by the shared-vault gate — so the installer the
 *      wizards delegate to did not work on exactly the vaults that most need
 *      conventions to be consistent.
 *   2. The model had to COPY each snippet (~31 KB for the whole library) into
 *      its tool calls. A copied rule is an altered rule waiting to happen: a
 *      dropped line, a "fixed" typo, a fence closed one line early.
 *
 * Here the texts are read SERVER-SIDE from this package's own
 * `skills/conventions/snippets/` — never from the vault, never from the
 * caller — and the model only names ids.
 *
 * CONCURRENCY — the same compare-and-swap discipline as `record_source`
 * (src/tools/source-ledger.mjs): read the raw bytes, build ONE new content,
 * write it with `writeFileIfMatch(contentSha256(raw))`; create-if-absent goes
 * through `applyIfContentPreexists: false`. A parallel edit between the read
 * and the write is a 409 with an actionable "re-run" — never a clobber. That is
 * why the tool is `IF_MATCH_EXEMPT` in helpers/vault-sharing.mjs: it already
 * carries its own precondition, derived from bytes it read itself.
 *
 * VERIFICATION IS PART OF THE WRITE. Before writing, the proposed content is
 * checked with `detectConventions` (fence-aware, exact identity): every
 * requested id must be present exactly once, or nothing is written — an
 * earlier section that leaves a fence open would otherwise swallow the new
 * heading. After writing, the file is read BACK and checked again; `verified`
 * reports that second check, and it is false whenever the vault does not hold
 * what was written.
 *
 * APPEND-ONLY BY CONSTRUCTION: the new content is the original bytes followed
 * by the missing snippets. Nothing already in the file is rewritten, and an
 * installed convention is never "updated" — drift is a separate, read-only
 * question (`convention-drift.mjs`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as defaultRestClient from '../rest-client.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';
import { buildClickToOpenUrl } from '../helpers/click-to-open.mjs';
import {
  CLAUDE_MD_CANDIDATES,
  resolveClaudeMd,
  detectConventions,
} from '../helpers/claude-md-conventions.mjs';
import { CONFIRM_SECONDARY_WRITE_PROP } from '../helpers/vault-reach.mjs';
import { RETIRED_DIR } from '../helpers/convention-catalogue.mjs';
import {
  LANGUAGES_CONVENTION_ID,
  renderLanguagesSection,
  hasUnfilledPlaceholder,
  readVaultLanguages,
} from '../helpers/convention-languages.mjs';

export const TOOL_NAME = 'install_conventions';

/** The package's own snippet library — `<package>/skills/conventions/snippets/`. */
export const SNIPPETS_DIR = fileURLToPath(new URL('../../skills/conventions/snippets/', import.meta.url));

/**
 * A convention id: the snippet's file name without `.md`. Lowercase ASCII,
 * digits and hyphens, starting with a letter or digit — so no separator, no
 * dot, no `..`, nothing a path join could turn into another directory.
 */
export const CONVENTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Upper bound on ids per call — the library is far smaller; this bounds a hostile array. */
const MAX_IDS = 64;

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Install one or more CLAUDE.md conventions from the router's own library into a vault's conventions file, in ONE guarded write. Name the conventions by id (the snippet file name, e.g. `source-type`, `heading-hierarchy`); the texts are read server-side from the package, so never paste them. The conventions file is resolved like the `conventions` skill does (`CLAUDE.md`, `wiki-meta/CLAUDE.md`, `Documentation/CLAUDE.md`): two of them present is refused (name the files to the user), none present creates `CLAUDE.md` at the vault root. Conventions already present are skipped and reported in `alreadyPresent` (never as installed); unknown ids are reported in `unknown`; a RETIRED convention (`skills/conventions/retired/`, e.g. `bilingual`) is never installed and is reported in `retired`. The `languages` convention carries the vault's own value: pass `languages` (ISO 639-1 codes, the primary language first — ask the owner, never assume) or the call is refused; the value is rendered server-side into the section's one value line. The write is a compare-and-swap on the bytes read (409 → re-run; nothing is overwritten), so it works on shared vaults with no `ifMatch` from you. The file is read back and checked: `verified: true` means every requested convention is present exactly once in what the vault now holds; `vaultLanguages` reports the value the file declares. `dryRun: true` returns the plan and the full `detection` of the library (retired conventions included, flagged) against the file, writing nothing — call it with `ids: []` to get the state a conventions picker needs.",
  inputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string', description: 'Vault name (see list_vaults). Omit for the default vault.' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Convention ids to install — the snippet file names without `.md` (lowercase letters, digits, hyphens). May be empty only with `dryRun: true`.',
      },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: 'The value of the `languages` convention for THIS vault: ISO 639-1 codes, primary language first (e.g. ["fr"] or ["fr", "en"]). Required when `ids` names `languages` and the call is not a dry run; refused when `languages` is not among `ids`.',
      },
      dryRun: { type: 'boolean', description: 'Report the plan and the detection without writing anything.' },
      confirmSecondaryWrite: CONFIRM_SECONDARY_WRITE_PROP,
    },
    required: ['ids'],
    additionalProperties: false,
  },
};

function validationError(message) {
  const e = new Error(message);
  e.kind = 'validation';
  return e;
}

function conflictError(message) {
  const e = new Error(message);
  e.kind = 'conflict';
  e.status = 409;
  return e;
}

/** Coerce a getFileContent result (string | {content}) into a string. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

/**
 * The library as it ships: `[{id, heading, text}]`, id order. A file whose
 * first line is not a `## ` heading is not a convention and is left out — the
 * id then reports as unknown rather than installing something unidentifiable.
 * Text is normalised to LF with one trailing newline and no BOM.
 */
export function loadConventionSnippets(dir = SNIPPETS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -3))
    .filter((id) => CONVENTION_ID_RE.test(id))
    .sort();
  const out = [];
  for (const id of entries) {
    const file = path.join(dir, `${id}.md`);
    // Belt and braces: the id regex already excludes separators and dots.
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) continue;
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    const firstLine = text.split('\n', 1)[0];
    if (!/^## \S/.test(firstLine)) continue;
    text = `${text.replace(/\n+$/, '')}\n`;
    out.push({ id, heading: firstLine.trim(), text });
  }
  return out;
}

/**
 * The RETIRED conventions — `skills/conventions/retired/` — read like the
 * library but flagged `retired: true`. They are recognised (a vault that still
 * carries one shows up in `detection`, so a picker can propose the migration)
 * and never installed. An absent folder is an empty one: a checkout that has
 * retired nothing has no such folder.
 */
export function loadRetiredCatalogue(dir = RETIRED_DIR) {
  let entries;
  try {
    entries = loadConventionSnippets(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return entries.map((e) => ({ ...e, retired: true }));
}

/**
 * The `languages` value, validated and rendered into the snippet — BEFORE any
 * I/O, so a call that cannot succeed does not read the vault. Returns the
 * rendered snippet entry, or null when `languages` is not being installed.
 *
 * Refused: a value given for a call that does not name `languages` (said, not
 * silently dropped), and a real install of `languages` without a value — the
 * value belongs to the vault and is asked of its owner; defaulting it to
 * anything would declare a language nobody chose.
 */
function renderLanguagesSnippet(args, ids, requested, byId, dryRun) {
  const named = ids.includes(LANGUAGES_CONVENTION_ID);
  if (args.languages !== undefined && !named) {
    throw validationError(
      'install_conventions: a `languages` value was given but `languages` is not among the ids — '
      + 'nothing was read or written. Name it in `ids` to install it, or drop the value.',
    );
  }
  // Named but not shipped by this library: it reports as `unknown` (or
  // `retired`), and the value has nothing to render into.
  const wanted = named && requested.includes(LANGUAGES_CONVENTION_ID) && byId.has(LANGUAGES_CONVENTION_ID);
  if (!wanted) return null;
  if (args.languages === undefined) {
    if (dryRun) return null;
    throw validationError(
      'install_conventions: `languages` carries a value that belongs to the vault — pass '
      + '`languages: ["fr"]` (ISO 639-1 codes, the primary language first), asked of the owner. '
      + 'Nothing was read or written.',
    );
  }
  const rendered = renderLanguagesSection(byId.get(LANGUAGES_CONVENTION_ID).text, args.languages);
  if (!rendered.ok) {
    throw validationError(`install_conventions: the \`languages\` value was refused — ${rendered.error}. Nothing was read or written.`);
  }
  if (hasUnfilledPlaceholder(rendered.text)) {
    throw validationError('install_conventions: the rendered `languages` section still holds the placeholder. Nothing was read or written.');
  }
  return { ...byId.get(LANGUAGES_CONVENTION_ID), text: rendered.text, languages: rendered.languages };
}

/**
 * Validate the requested ids. A MALFORMED id (separator, dot, uppercase,
 * anything outside the id alphabet) is a refusal — it can only be a mistake or
 * an attempt to name a file outside the library. A WELL-FORMED id the library
 * does not ship is reported in `unknown`, not fatal.
 */
function validateIds(ids, dryRun) {
  if (!Array.isArray(ids)) throw validationError('install_conventions: `ids` must be an array of convention ids.');
  if (ids.length > MAX_IDS) throw validationError(`install_conventions: at most ${MAX_IDS} ids per call.`);
  const bad = ids.filter((id) => typeof id !== 'string' || !CONVENTION_ID_RE.test(id));
  if (bad.length) {
    throw validationError(
      `install_conventions: refused ${bad.length} malformed id(s) ${JSON.stringify(bad.slice(0, 5))} — `
      + 'an id is a snippet file name without `.md`: lowercase letters, digits and hyphens only. '
      + 'Nothing was read or written.',
    );
  }
  if (ids.length === 0 && dryRun !== true) {
    throw validationError('install_conventions: `ids` is empty — name at least one convention, or pass `dryRun: true` for the state only.');
  }
  return [...new Set(ids)];
}

/**
 * Find the vault's conventions file through REST: the root listing, plus
 * `wiki-meta/` and `Documentation/` when the root shows them. A missing
 * sub-directory is simply "no candidate there"; any other listing failure is
 * the vault's own and surfaces — guessing "absent" from an error is how a
 * second conventions file gets created.
 */
async function probeCandidates(listFilesIn, vault) {
  const found = [];
  const root = await listFilesIn(vault, '');
  const rootNames = Array.isArray(root?.files) ? root.files : [];
  for (const n of rootNames) if (n === 'CLAUDE.md') found.push('CLAUDE.md');
  const dirs = [...new Set(CLAUDE_MD_CANDIDATES.filter((c) => c.includes('/')).map((c) => c.split('/')[0]))];
  for (const dir of dirs) {
    if (!rootNames.includes(`${dir}/`)) continue;
    let listing;
    try {
      listing = await listFilesIn(vault, dir);
    } catch (err) {
      if (err?.kind === 'not_found' || err?.status === 404) continue;
      throw err;
    }
    const names = Array.isArray(listing?.files) ? listing.files : [];
    if (names.includes('CLAUDE.md')) found.push(`${dir}/CLAUDE.md`);
  }
  return found;
}

/** Append the missing snippets to `original`, one blank line between sections. */
function buildContent(original, snippets) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let out = original;
  for (const s of snippets) {
    const text = eol === '\n' ? s.text : s.text.replace(/\n/g, '\r\n');
    if (out.length === 0) {
      out = text;
      continue;
    }
    if (!out.endsWith('\n')) out += eol;
    out += eol + text;
  }
  return out;
}

/** Every requested id present exactly once? Returns the problems, empty when fine. */
function checkInstalled(detection, requested) {
  const problems = [];
  for (const id of requested) {
    const d = detection.find((x) => x.id === id);
    if (!d || !d.installed) problems.push(`${id} is not detectable in the file`);
    else if (d.duplicate) problems.push(`${id} appears more than once in the file`);
  }
  return problems;
}

/** MCP tool — install conventions with one compare-and-swap write, then verify. */
export async function installConventionsTool(registry, args = {}, _deps = {}) {
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    writeFileIfMatch: _deps.writeFileIfMatch || defaultRestClient.writeFileIfMatch,
    loadCatalogue: _deps.loadCatalogue || (() => loadConventionSnippets()),
    loadRetired: _deps.loadRetired || (() => loadRetiredCatalogue()),
  };
  const dryRun = args.dryRun === true;
  const ids = validateIds(args.ids, dryRun);

  // Recognised, never offered: a retired id is reported, not installed, and
  // its heading still counts in `detection` (a vault to migrate is visible).
  // An id present in BOTH folders is retired — the safe reading of a state
  // the catalogue helper already reports as an error.
  const retiredCatalogue = deps.loadRetired();
  const retiredById = new Map(retiredCatalogue.map((c) => [c.id, c]));
  const catalogue = deps.loadCatalogue().filter((c) => !retiredById.has(c.id));
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const identities = [...catalogue, ...retiredCatalogue];
  const unknown = ids.filter((id) => !byId.has(id) && !retiredById.has(id));
  const retired = ids.filter((id) => retiredById.has(id));
  const requested = ids.filter((id) => byId.has(id));
  const languagesSnippet = renderLanguagesSnippet(args, ids, requested, byId, dryRun);

  const vault = registry.resolveVault(args.vault);

  const resolved = resolveClaudeMd(await probeCandidates(deps.listFilesIn, vault));
  if (resolved.ambiguous) {
    throw validationError(
      `install_conventions: vault "${vault.name}" has ${resolved.present.length} conventions files `
      + `(${resolved.present.join(', ')}). Two files means two sets of rules, one of which is not being read, `
      + 'so nothing was written. Ask the user which one is theirs, merge or remove the other, then run again.',
    );
  }

  let filePath = resolved.path;
  let raw = null;
  if (filePath) {
    try {
      raw = asText(await deps.getFileContent(vault, filePath));
    } catch (err) {
      // Listed a moment ago, gone now: treat as absent, and let the
      // create-only write below refuse if it reappears.
      if (err?.kind !== 'not_found' && err?.status !== 404) throw err;
      raw = null;
    }
  }
  const existed = raw !== null;
  if (!filePath) filePath = resolved.createAt;
  const original = existed ? raw : '';

  const before = detectConventions(original, identities);
  const alreadyPresent = requested.filter((id) => before.find((d) => d.id === id)?.installed);
  const toInstall = requested.filter((id) => !alreadyPresent.includes(id));
  const duplicates = before.filter((d) => d.duplicate && requested.includes(d.id)).map((d) => d.id);

  const base = {
    vault: vault.name,
    path: filePath,
    fileExisted: existed,
    unknown,
    retired,
    alreadyPresent,
    duplicates,
    // `verified` speaks of the conventions the library could install; this
    // says whether EVERY id the caller named was one of them. A run that
    // installed two of three and dropped an unknown one is verified, not
    // satisfied — a summary must not read the first as the second.
    satisfied: unknown.length === 0 && retired.length === 0,
  };

  if (dryRun) {
    const clickToOpenUrl = existed ? buildClickToOpenUrl(vault, filePath) : null;
    return {
      ...base,
      dryRun: true,
      written: false,
      wouldInstall: toInstall,
      installed: [],
      detection: before,
      catalogue: identities.map(({ id, heading, retired: r }) => ({ id, heading, ...(r && { retired: true }) })),
      vaultLanguages: readVaultLanguages(original),
      contentSha256: existed ? contentSha256(original) : null,
      ...(clickToOpenUrl && { clickToOpenUrl }),
    };
  }

  if (toInstall.length === 0) {
    const problems = checkInstalled(before, requested);
    const clickToOpenUrl = existed ? buildClickToOpenUrl(vault, filePath) : null;
    return {
      ...base,
      written: false,
      installed: [],
      verified: requested.length > 0 && problems.length === 0,
      problems,
      detection: before,
      vaultLanguages: readVaultLanguages(original),
      contentSha256: existed ? contentSha256(original) : null,
      ...(clickToOpenUrl && { clickToOpenUrl }),
    };
  }

  // The `languages` snippet is appended RENDERED — its value line holds the
  // owner's value, never the library's placeholder.
  if (toInstall.includes(LANGUAGES_CONVENTION_ID) && !languagesSnippet) {
    // Unreachable by construction (a real install of `languages` rendered it
    // above, or was refused); kept as a hard stop rather than a belief.
    throw validationError('install_conventions: the `languages` section was not rendered — nothing was written.');
  }
  const snippets = toInstall.map((id) => (id === LANGUAGES_CONVENTION_ID ? languagesSnippet : byId.get(id)));
  const next = buildContent(original, snippets);

  // PRE-WRITE CHECK: refuse a content in which a requested convention would not
  // be readable — an unclosed fence above the append point swallows it.
  const planned = detectConventions(next, identities);
  const preProblems = checkInstalled(planned, requested);
  if (preProblems.length) {
    throw validationError(
      `install_conventions: the file ${filePath} in vault "${vault.name}" would not hold the requested `
      + `conventions after the append (${preProblems.join('; ')}). This usually means a fenced code block `
      + 'above the end of the file is never closed. Nothing was written — close the fence, then run again.',
    );
  }

  let casMode = null;
  try {
    if (existed) {
      const res = await deps.writeFileIfMatch(vault, filePath, next, contentSha256(original));
      casMode = res?.casMode ?? null;
    } else {
      await deps.writeFile(vault, filePath, next, { applyIfContentPreexists: false });
    }
  } catch (err) {
    if (err?.kind === 'conflict' || err?.status === 409) {
      throw conflictError(
        `install_conventions: ${filePath} in vault "${vault.name}" `
        + (existed ? 'changed since it was read' : 'was created by someone else while this install was prepared')
        + ', so nothing was written. Run install_conventions again with the same ids — it re-reads the file, '
        + 'skips what is already present, and never overwrites.',
      );
    }
    throw err;
  }

  // POST-WRITE CHECK — read back what the vault now holds.
  let after = null;
  const problems = [];
  try {
    after = asText(await deps.getFileContent(vault, filePath));
  } catch (err) {
    problems.push(`the file could not be read back (${err?.message || err})`);
  }
  const detection = detectConventions(after ?? '', identities);
  if (after !== null) {
    problems.push(...checkInstalled(detection, requested));
    if (after !== next) problems.push('the file read back differs from what was written');
  }
  const vaultLanguages = readVaultLanguages(after ?? next);
  if (languagesSnippet && toInstall.includes(LANGUAGES_CONVENTION_ID)) {
    // The value is part of what was written: a read-back that does not
    // declare it is not verified, whatever the heading check says.
    const got = Array.isArray(vaultLanguages.languages) ? vaultLanguages.languages.join(',') : null;
    if (got !== languagesSnippet.languages.join(',')) {
      problems.push(`the languages value read back (${got ?? vaultLanguages.problem ?? 'none'}) is not the one written (${languagesSnippet.languages.join(', ')})`);
    }
  }
  const clickToOpenUrl = buildClickToOpenUrl(vault, filePath);
  return {
    ...base,
    written: true,
    created: !existed,
    ...(casMode ? { casMode } : {}),
    installed: toInstall,
    verified: problems.length === 0,
    problems,
    detection,
    vaultLanguages,
    contentSha256: after !== null ? contentSha256(after) : null,
    ...(clickToOpenUrl && { clickToOpenUrl }),
  };
}
