/**
 * attach-remote.mjs — the REMOTE half of `setup-vault.mjs --attach`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * `--attach` resolved names against `portRegistry` only, so a vault declared in
 * `remoteVaults` — Obsidian in a container, reached over its Local REST API —
 * could not be attached to a code workspace at all: "not in portRegistry". The
 * binding layer never had that limit (`bindableVaultNames` has always listed
 * remote names); the CLI did. Measured on the real case: a linuxserver
 * container at http://10.8.0.1:27180 whose files ALSO sit on the machine the
 * router runs on. Attach refused it; `search_smart` declined its freshness
 * check as `no-local-disk`; and the CLAUDE.md block, once written by hand,
 * claimed a hot.md was auto-loaded that did not even exist.
 *
 * This module holds what the CLI needs for that case, kept out of the
 * 7 800-line script so it can be read — and tested — on its own:
 *   - resolving a name against `remoteVaults` (after the local resolution,
 *     never instead of it);
 *   - verifying a declared local directory against the vault over REST
 *     (`verifyRemoteLocalPath`), and asking the vault whether it has a wiki;
 *   - the block's hot-cache sentence, which now says only what is true;
 *   - the "Final state" report.
 *
 * Nothing here runs in the server. The server stays HTTP-only for note
 * content (tests/no-vault-disk.test.mjs); comparing a note's bytes on disk
 * with the REST copy is a CLI act, done once, before the directory is recorded.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isAbsoluteLocalPath, registeredVaultPaths, vaultSlug } from '../src/helpers/vault-slug.mjs';
import { resolveScaffold } from '../src/helpers/wiki-meta-scaffolds.mjs';
import { formatReadiness } from './attach-readiness.mjs';
import {
  verifyRemoteLocalPath,
  probeRemoteWiki,
  defaultRemoteClient,
  LOCAL_PATH_STATUS,
} from '../src/helpers/remote-local-path.mjs';

export { LOCAL_PATH_STATUS };

/** Every `remoteVaults` name the config carries, spelled as stored. */
export function remoteEntryNames(cfg) {
  return (Array.isArray(cfg?.remoteVaults) ? cfg.remoteVaults : [])
    .map((r) => (r && typeof r.name === 'string' ? r.name : null))
    .filter(Boolean);
}

/**
 * The `remoteVaults` entry a typed name designates, or null.
 *
 * Exact first — the registry compares names verbatim. Then a case-folded,
 * trimmed match, as a courtesy to someone typing, but ONLY when it is
 * unambiguous among the remote names AND no local vault folds onto the same
 * spelling: the caller has already failed to resolve it locally, and a folded
 * guess between a local and a remote vault would be the wrong-vault
 * substitution `resolveVaultBySlug` was hardened against.
 *
 * @param {object} cfg
 * @param {string} typed
 * @returns {object|null} the raw entry
 */
export function resolveRemoteEntry(cfg, typed) {
  if (!cfg || typeof typed !== 'string' || !typed.trim()) return null;
  const entries = (Array.isArray(cfg.remoteVaults) ? cfg.remoteVaults : [])
    .filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name);
  const exact = entries.find((r) => r.name === typed);
  if (exact) return exact;
  const target = typed.trim().toLowerCase();
  const localFolds = registeredVaultPaths(cfg).filter((vp) => vaultSlug(cfg, vp).trim().toLowerCase() === target);
  if (localFolds.length > 0) return null;
  const folded = entries.filter((r) => r.name.trim().toLowerCase() === target);
  return folded.length === 1 ? folded[0] : null;
}

/**
 * Establish, for a remote primary, its local directory and its wiki — before
 * anything is written.
 *
 *   - `--local-path <dir>` given: verified against the vault. `mismatch`
 *     REFUSES the command (`fail`); `unverifiable` records nothing and says
 *     why; `verified` is persisted by the caller, in the same locked config
 *     update as the binding.
 *   - no flag, but the entry already declares one: re-verified, reported, never
 *     rewritten — a mismatch is warned about, loudly, since the hooks use it.
 *   - neither: `none`.
 *
 * The wiki is asked of the verified directory when there is one (the same
 * probe a local vault gets), else of the vault over REST. A MISSING wiki is a
 * warning for a remote vault, not the local refusal: the vault is reachable and
 * bindable, and its wiki can be created afterwards from a session.
 *
 * @param {{ primary: object, localPath: string|null, note: Function, fail: Function,
 *           descriptorFor: Function, client?: object }} args
 * @returns {Promise<{ localPath: object, wiki: object, persistLocalPath: string|null }>}
 */
export async function examineRemotePrimary({ primary, localPath, note, fail, descriptorFor, client }) {
  // ONE client for the whole examination, and the default one is CLOSED at the
  // end: this CLI exits with `process.exit()`, and exiting while an HTTP
  // keep-alive socket is still closing crashed Node on Windows (see
  // `closeRestAgentsForExit`). An injected client is the caller's to manage.
  let rc = client;
  let owned = false;
  if (!rc) {
    try {
      rc = await defaultRemoteClient();
      owned = true;
    } catch (err) {
      fail(`Could not load the REST client to reach "${primary.slug}" (${err?.message || err}).`);
    }
  }
  let out;
  try {
    out = await examineWith({ primary, localPath, note, descriptorFor, client: rc });
  } finally {
    if (owned) await rc.close?.().catch(() => {});
  }
  // A refusal is pronounced AFTER the sockets are closed: `fail` exits the
  // process, and a `finally` does not run past `process.exit()`.
  if (out.refusal) fail(out.refusal);
  return out;
}

async function examineWith({ primary, localPath, note, descriptorFor, client }) {
  const vault = descriptorFor(primary.entry);
  const declared = isAbsoluteLocalPath(primary.entry.localPath) ? primary.entry.localPath : null;
  const candidate = localPath ?? declared;
  let lp = { status: 'none' };
  let persistLocalPath = null;

  if (candidate) {
    const source = localPath !== null ? 'flag' : 'config';
    const v = await verifyRemoteLocalPath({ vault, localPath: candidate, client });
    lp = { status: v.status, path: candidate, source, persisted: false, evidence: v.evidence };
    if (v.status === LOCAL_PATH_STATUS.MISMATCH && source === 'flag') {
      return {
        refusal:
          `--local-path ${candidate} is NOT the files of remote vault "${primary.slug}" (${describeEvidence(v.evidence)}).\n` +
          '   Nothing was written. Point --local-path at the directory the container mounts as that vault.',
      };
    }
    if (v.status === LOCAL_PATH_STATUS.MISMATCH) {
      note(
        `The config declares localPath ${candidate} for "${primary.slug}", but it does NOT match the vault\n` +
        `   (${describeEvidence(v.evidence)}). The session hooks would read that directory as the vault:\n` +
        '   fix it with --local-path <right dir>, or remove the field from config.json.',
      );
    } else if (v.status === LOCAL_PATH_STATUS.UNVERIFIABLE) {
      note(
        `Could not verify ${candidate} against "${primary.slug}" (${describeEvidence(v.evidence)}).` +
        (source === 'flag'
          ? '\n   It was NOT recorded. Once the vault holds a note (any .md at its root, or wiki-meta/catalog.md),\n' +
            '   re-run --attach with --local-path.'
          : ''),
      );
    } else if (v.status === LOCAL_PATH_STATUS.VERIFIED && source === 'flag') {
      persistLocalPath = candidate;
      lp.persisted = true; // provisional: the caller's locked write confirms it
    }
  }

  const wiki = { catalog: null, hot: null };
  if (lp.status === LOCAL_PATH_STATUS.VERIFIED) {
    wiki.catalog = Boolean(resolveScaffold(lp.path, 'catalog', { fs, path }));
    wiki.hot = fs.existsSync(path.join(lp.path, 'wiki-meta', 'hot.md'));
  } else {
    const probe = await probeRemoteWiki({ vault, client });
    wiki.catalog = probe.catalog;
    wiki.hot = probe.hot;
    if (probe.error) {
      note(`Could not ask "${primary.slug}" whether it has a wiki (${probe.error}). Attached anyway.`);
    }
  }
  if (wiki.catalog === false) {
    note(
      `"${primary.slug}" has no wiki yet (no wiki-meta/catalog.md). The workspace is attached anyway;\n` +
      '   bootstrap the wiki from a session in this workspace with /obsidian-router:wiki.',
    );
  }
  return { localPath: lp, wiki, persistLocalPath };
}

/** One line for a verification verdict, without echoing any file content. */
export function describeEvidence(e = {}) {
  switch (e.reason) {
    case 'same-content': return `${e.file} is identical on both sides`;
    case 'different-content': return `${e.file} differs between the vault and the directory`;
    case 'present-on-one-side-only': return `${(e.files || []).join(', ')} exists on one side only`;
    case 'not-a-directory': return 'the directory does not exist';
    case 'not-absolute': return 'the path is not absolute';
    case 'nothing-to-compare': return 'the vault has no note to compare yet';
    case 'rest-error': return `the vault did not answer: ${e.error || 'error'}`;
    case 'disk-unreadable': return `the directory could not be read: ${e.error || 'error'}`;
    default: return e.reason || 'no evidence';
  }
}

/** Where a vault of the CLAUDE.md block lives, as the reader needs it said. */
export function describeVaultLocation(v) {
  if (v.kind === 'remote') {
    const files = v.path ? `; files also at ${v.path}` : '';
    return `remote, served at ${v.baseUrl}${files}`;
  }
  return v.path;
}

/**
 * The primary's hot-cache sentence in the CLAUDE.md block. An agent reads the
 * block as fact, so each case says the one thing that is true:
 *   - loadable and present → "Auto-loaded at session start";
 *   - absent               → it does not exist yet (and, for a remote vault
 *                            without a local directory, would not be loaded
 *                            even then);
 *   - not loadable         → a remote vault with no local directory: read it
 *                            with get_file.
 * `hot` absent (an older caller, nothing measured) promises nothing: the
 * conditional sentence only.
 *
 * Even "auto-loaded" is conditioned on the hooks: on 2026-09-25 a remote
 * session ran with no plugin hook at all while the block said "auto-loaded".
 * The file being there is this vault's fact; whether the hooks ran is
 * measured by `list_vaults` → `sessionHooks.status`, and the sentence says so.
 *
 * @param {{ exists: boolean|null, loadable: boolean }|undefined} hot
 */
export function hotSentence(hot) {
  const target = 'the target of every router call made **without** a `vault:` argument.';
  const measured = 'by the plugin\'s `hot-cache-load` hook — **when the hooks run**: `list_vaults` → `sessionHooks.status` says whether they did; if not, read it with `get_file`';
  if (!hot) {
    return `  The target of every router call made **without** a \`vault:\` argument. Its \`wiki-meta/hot.md\`, if it exists, is injected at session start ${measured}.`;
  }
  if (hot.loadable && hot.exists === true) {
    return `  Auto-loaded at session start (its \`wiki-meta/hot.md\`) ${measured}. It is ${target}`;
  }
  const noDisk = 'this is a remote vault with no local directory the session hooks can read — read `wiki-meta/hot.md` with `get_file` when you need it';
  let why;
  if (hot.exists === false) {
    why = 'its `wiki-meta/hot.md` does not exist yet — create the wiki (`/obsidian-router:wiki`)';
    if (!hot.loadable) why += `, and even then it will not be auto-loaded: ${noDisk}`;
  } else if (hot.exists === null && hot.loadable) {
    why = 'whether its `wiki-meta/hot.md` exists could not be checked when this block was written';
  } else {
    why = noDisk;
  }
  return `  NOT auto-loaded at session start: ${why}. It is ${target}`;
}

/**
 * The "Final state" lines of `--attach`, from the `state` object it returns.
 * Plain strings: the caller colours and prints them. Later lots add the
 * plugin's and the conventions' state; each is one more line here.
 *
 * @param {object} state
 * @returns {string[]}
 */
export function formatFinalState(state) {
  const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
  const lp = state.localPath || {};
  const lpText = lp.status === 'not-applicable'
    ? 'n/a (local vault)'
    : lp.status === 'none'
      ? 'none (remote vault, no local directory)'
      : `${lp.status}${lp.path ? ` — ${lp.path}` : ''}${lp.persisted ? ' (recorded)' : ''}`;
  return [
    'État final / Final state',
    `  vault       ${state.vault} (${state.kind})`,
    `  localPath   ${lpText}`,
    `  wiki        catalog: ${yn(state.wiki?.catalog)} · hot.md: ${yn(state.wiki?.hot)}`,
    `  warnings    ${(state.warnings || []).length}`,
    ...(state.readiness ? formatReadiness(state.readiness) : []),
  ];
}
