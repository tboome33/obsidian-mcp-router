/**
 * plugin-installer — the plan and the disk half of
 * `obsidian-mcp-router --install-plugins`.
 *
 * TWO PHASES, SEALED. `buildInstallPlan` reads the vault, resolves every
 * candidate through the network half (plugin-release-resolver.mjs) and returns
 * a plan: what would be installed, from which repository and tag, with which
 * assets and sizes — and what will NOT be, and why. The dry run prints it with
 * a seal (plan-seal.mjs, the same contract as --sync-from-github and the MCP
 * tools). The apply RE-BUILDS the plan from the current state, and runs only
 * when that plan seals to the value the user approved: a release published
 * between the preview and the apply, a plugin installed by hand in between, or
 * a registry entry that moved, all change the seal and stop the apply before
 * any write.
 *
 * WHAT IS CONSIDERED: the ids enabled in `.obsidian/community-plugins.json`
 * plus the REQUIRED ones, narrowed by `--only` when given. For each:
 *   - an id outside the network allowlist is REPORTED, never downloaded — the
 *     allowlist is setup-vault's NETWORK_PLUGIN_ALLOWLIST, pinned in code, so
 *     a vault's own enabled list can select among it and never enlarge it;
 *   - an id whose main.js is already on disk is left alone unless --force;
 *   - `mcp-router-bridge` is not in the official registry and is ALWAYS taken
 *     from its own GitHub release (the repository named by setup-vault's
 *     BRIDGE_PLUGIN_URLS), even if some day a registry entry claims that id:
 *     a stranger's plugin published under the bridge's name must not be what
 *     this command installs. That is also what frees the bridge from BRAT;
 *   - everything else goes through the official registry.
 *
 * WHAT A WRITE DOES, and what it never does:
 *   - the assets are downloaded and verified (size as declared, manifest id ==
 *     requested id, version present, main.js non-empty and not HTML) into a
 *     staging directory next to the destination, on the same filesystem;
 *   - a plugin directory that does not exist yet is created by ONE rename of
 *     the staging directory — atomic;
 *   - a directory that exists (settings only, or a --force reinstall) receives
 *     its files one rename each, main.js LAST, so Obsidian never sees a new
 *     main.js next to an old manifest. The directory itself is never replaced,
 *     so its data.json — the plugin's settings, and for Local REST API the
 *     vault's API key and certificate — is never read, copied or rewritten;
 *   - an existing main.js is never overwritten without --force;
 *   - the id is added to community-plugins.json when it is missing (atomic
 *     write, Obsidian's own two-space format).
 *
 * DISK-READING CODE, CLI ONLY. Every exported function that touches a vault
 * refuses to run inside the router server process, exactly like
 * semantic-readiness-fs.mjs (see server-process.mjs for why the check is made
 * at run time rather than by scanning imports).
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isServerProcess } from './server-process.mjs';
import { computePlanSeal } from './plan-seal.mjs';
import { writeFileAtomicSync } from './write-file-atomic.mjs';
import {
  PLUGIN_ID_RE,
  fetchRegistry,
  resolveLatestRelease,
  selectPluginAssets,
  downloadAsset,
  verifyManifest,
  verifyMainJs,
  sha256,
} from './plugin-release-resolver.mjs';

export const INSTALL_OP = 'install-plugins';
export const BRIDGE_ID = 'mcp-router-bridge';
export const LOCAL_REST_API_ID = 'obsidian-local-rest-api';

export function assertNotServerProcess(what = 'plugin-installer') {
  if (isServerProcess()) {
    throw new Error(
      `${what}: refusing to read or write a vault's disk inside the router server process. `
      + 'The server is HTTP-only (tests/no-vault-disk.test.mjs); plugin installation is a CLI command.',
    );
  }
}

// Built, not typed: an escape typed into a source file has twice become the
// invisible character itself on its way to disk.
const BOM = String.fromCharCode(0xfeff);

const pluginsDirOf = (vaultPath) => path.join(vaultPath, '.obsidian', 'plugins');
const communityFileOf = (vaultPath) => path.join(vaultPath, '.obsidian', 'community-plugins.json');

/**
 * Read `.obsidian/community-plugins.json`. Three honest answers: the list, an
 * absent file (an empty list — Obsidian's own reading), or a file that is not
 * a JSON array of strings — which is refused, never "repaired" by overwriting.
 *
 * @returns {{ state: 'ok'|'absent'|'invalid', ids: string[], error?: string }}
 */
export function readCommunityPlugins(vaultPath, { fs = nodeFs } = {}) {
  assertNotServerProcess('readCommunityPlugins');
  const file = communityFileOf(vaultPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'absent', ids: [] };
    return { state: 'invalid', ids: [], error: `${file}: ${err.code || err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
  } catch (err) {
    return { state: 'invalid', ids: [], error: `${file} is not valid JSON (${err.message})` };
  }
  if (!Array.isArray(parsed)) return { state: 'invalid', ids: [], error: `${file} is not a JSON array` };
  return { state: 'ok', ids: parsed.filter((x) => typeof x === 'string') };
}

function hasMainJs(fs, dir) {
  try { return fs.statSync(path.join(dir, 'main.js')).isFile(); } catch { return false; }
}

/**
 * The chain vault → .obsidian → plugins must be PLAIN directories. A link
 * anywhere in it (a symlink, a Windows junction) sends every write below to
 * wherever the link points — and the seal, bound to the lexical path, would
 * not notice a link swapped in between the preview and the apply. The vault
 * root itself may well be reached through a mount or a link (a share, a
 * container volume): that is the user's setup, not a redirection INSIDE the
 * vault, so the check starts under the root. A segment that does not exist
 * yet ends the check: it will be created, as a plain directory.
 *
 * WHAT THIS IS NOT: a lock. It is checked by path, before the downloads and
 * again right before this plugin's renames, which narrows the window in
 * which a link could be swapped in to a few milliseconds — it does not close
 * it (that would take directory handles this code does not use). The vault
 * is the user's own disk; a writer racing this command on it is outside
 * what the seal and this check defend against, and that limit is said here
 * rather than implied away — the same honesty as the plugin-cache purge.
 *
 * @throws {Error} naming the offending path, before anything is written
 */
export function assertPlainDirChain(fs, vaultPath, segments) {
  let dir = vaultPath;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${dir} is not a plain directory (a link, or a file) — refusing to write through it`);
    }
  }
}
function exists(fs, p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Parse `--only a,b` into validated ids (unknown shapes are kept, and refused per id later). */
export function parseOnlyList(value) {
  if (value == null) return null;
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(ids)];
}

/**
 * The part of the plan the seal covers — everything that decides what the
 * apply would do, nothing that is only transport detail (download URLs).
 */
export function sealablePlan(plan) {
  return {
    force: plan.force,
    only: plan.only,
    install: plan.install.map((p) => ({
      id: p.id,
      action: p.action,
      source: p.source,
      registryRepo: p.registryRepo,
      resolvedRepo: p.resolvedRepo,
      redirected: p.redirected,
      tag: p.tag,
      version: p.version,
      manifestSha256: p.manifestSha256,
      assets: p.assets.map((a) => ({ name: a.name, size: a.size, id: a.id })),
      destination: p.destination,
      enabledListed: p.enabledListed,
    })),
    alreadyInstalled: plan.alreadyInstalled,
    outsideAllowlist: plan.outsideAllowlist,
    refused: plan.refused,
  };
}

/** The identity a seal is bound to: which vault, by name and by path. */
export function installIdentity(target) {
  return { vaultName: target.name ?? null, vaultPath: path.resolve(target.vaultPath) };
}

export function sealInstallPlan(target, plan) {
  return computePlanSeal({ op: INSTALL_OP, identity: installIdentity(target), plan: sealablePlan(plan) });
}

/**
 * Build the plan. Never writes. Network errors for one plugin refuse THAT
 * plugin (with the reason) and leave the others planned; a registry that
 * cannot be fetched refuses every plugin that needed it.
 *
 * @param {object} p
 * @param {string} p.vaultPath
 * @param {Function} p.fetch             a guarded fetch (createGuardedFetch)
 * @param {Set<string>|string[]} p.allowlist  NETWORK_PLUGIN_ALLOWLIST
 * @param {string[]} p.required          REQUIRED_PLUGINS
 * @param {string} p.bridgeRepo          owner/repo of the bridge's releases
 * @param {string[]|null} [p.only]
 * @param {boolean} [p.force]
 * @param {object} [p.fs]
 */
export async function buildInstallPlan({ vaultPath, fetch, allowlist, required = [], bridgeRepo, only = null, force = false, fs = nodeFs }) {
  assertNotServerProcess('buildInstallPlan');
  const allow = allowlist instanceof Set ? allowlist : new Set(allowlist || []);
  const community = readCommunityPlugins(vaultPath, { fs });
  if (community.state === 'invalid') {
    const err = new Error(`${community.error} — fix it by hand (Obsidian writes a JSON array of plugin ids); nothing was changed.`);
    err.code = 'community_plugins_invalid';
    throw err;
  }
  const enabled = new Set(community.ids);
  const candidates = only ? [...only] : [...new Set([...required, ...community.ids])];

  const plan = {
    force: Boolean(force),
    only: only ? [...only] : null,
    communityPluginsState: community.state,
    install: [],
    alreadyInstalled: [],
    outsideAllowlist: [],
    refused: [],
  };

  const toResolve = [];
  for (const id of candidates) {
    if (!PLUGIN_ID_RE.test(id)) {
      plan.refused.push({ id: String(id).slice(0, 80), reason: 'not a valid plugin id' });
      continue;
    }
    if (!allow.has(id)) {
      plan.outsideAllowlist.push(id);
      continue;
    }
    const dir = path.join(pluginsDirOf(vaultPath), id);
    const installed = hasMainJs(fs, dir);
    if (installed && !force) {
      plan.alreadyInstalled.push(id);
      continue;
    }
    toResolve.push({ id, action: installed ? 'reinstall' : 'install', dir });
  }

  let registry = null;
  let registryError = null;
  const needsRegistry = toResolve.some((c) => c.id !== BRIDGE_ID);
  if (needsRegistry) {
    try { registry = await fetchRegistry(fetch); } catch (err) { registryError = err.message; }
  }

  for (const c of toResolve) {
    let source; let registryRepo; let repo;
    if (c.id === BRIDGE_ID) {
      source = 'bridge-release';
      registryRepo = null;
      repo = bridgeRepo;
      if (!repo) {
        plan.refused.push({ id: c.id, reason: 'the bridge repository is unknown (BRIDGE_PLUGIN_URLS unreadable)' });
        continue;
      }
    } else {
      source = 'registry';
      if (!registry) {
        plan.refused.push({ id: c.id, reason: `the official registry could not be read: ${registryError}` });
        continue;
      }
      registryRepo = registry.get(c.id) ?? null;
      if (!registryRepo) {
        plan.refused.push({ id: c.id, reason: 'not in the official community-plugins registry' });
        continue;
      }
      repo = registryRepo;
    }
    try {
      const release = await resolveLatestRelease(fetch, repo);
      const assets = selectPluginAssets(release);
      const manifestAsset = assets.find((a) => a.name === 'manifest.json');
      const manifestBuf = await downloadAsset(fetch, manifestAsset);
      const { version } = verifyManifest(manifestBuf, c.id);
      plan.install.push({
        id: c.id,
        action: c.action,
        source,
        registryRepo,
        resolvedRepo: release.resolvedRepo,
        redirected: release.redirected,
        tag: release.tag,
        version,
        manifestSha256: sha256(manifestBuf),
        assets,
        destination: `.obsidian/plugins/${c.id}`,
        enabledListed: enabled.has(c.id),
        dataJsonPresent: exists(fs, path.join(c.dir, 'data.json')),
        // Not sealed and not printed: the verified manifest bytes, reused by
        // the apply so what was checked is what is written.
        _manifest: manifestBuf,
      });
    } catch (err) {
      plan.refused.push({ id: c.id, reason: err.message });
    }
  }
  return plan;
}

/**
 * Human rendering of a plan, one block per plugin. Returns lines.
 */
export function formatInstallPlan(plan, { vaultPath } = {}) {
  const lines = [];
  const kb = (n) => (n === null || n === undefined ? '?' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  if (vaultPath) lines.push(`Vault: ${vaultPath}`);
  lines.push(`Plugins to ${plan.force ? 'install or reinstall (--force)' : 'install'}: ${plan.install.length}`);
  for (const p of plan.install) {
    lines.push('');
    lines.push(`  ${p.id}  (${p.action})`);
    if (p.source === 'bridge-release') {
      lines.push(`    source      : the bridge's own GitHub release — ${p.resolvedRepo}${p.redirected ? ' (redirected)' : ''}`);
    } else if (p.redirected) {
      lines.push(`    registry    : ${p.registryRepo} → REDIRECTED to ${p.resolvedRepo} (the repository was renamed or moved)`);
    } else {
      lines.push(`    registry    : ${p.registryRepo}`);
    }
    lines.push(`    release     : ${p.tag}  (manifest version ${p.version})`);
    lines.push(`    assets      : ${p.assets.map((a) => `${a.name} ${kb(a.size)}`).join(', ')}`);
    lines.push(`    destination : ${p.destination}${p.dataJsonPresent ? '  (existing data.json kept untouched)' : ''}`);
    if (!p.enabledListed) lines.push('    note        : not listed in community-plugins.json — it will be added');
  }
  if (plan.alreadyInstalled.length) {
    lines.push('');
    lines.push(`Already installed (code on disk, left alone — --force to reinstall): ${plan.alreadyInstalled.join(', ')}`);
  }
  if (plan.outsideAllowlist.length) {
    lines.push('');
    lines.push(`Outside the network allowlist (reported, never downloaded): ${plan.outsideAllowlist.join(', ')}`);
    lines.push('  Install these from Obsidian: Settings → Community plugins → Browse.');
  }
  if (plan.refused.length) {
    lines.push('');
    lines.push('Refused:');
    for (const r of plan.refused) lines.push(`  ${r.id}: ${r.reason}`);
  }
  return lines;
}

function rmQuiet(fs, p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Apply a plan that was just re-built and seal-checked by the caller. Writes
 * only what the plan lists.
 *
 * @returns {{ installed: Array<{id:string, version:string, files:string[], dataJsonKept:boolean}>,
 *   failed: Array<{id:string, reason:string}>, communityPlugins: {added:string[], state:string, error?:string} }}
 */
export async function applyInstallPlan({ vaultPath, plan, fetch, fs = nodeFs, force = plan.force }) {
  assertNotServerProcess('applyInstallPlan');
  const pluginsDir = pluginsDirOf(vaultPath);
  // Checked ONCE here, and again per plugin below for `<id>` itself: nothing
  // is downloaded or staged through a link.
  assertPlainDirChain(fs, vaultPath, ['.obsidian', 'plugins']);
  const installed = [];
  const failed = [];
  for (const p of plan.install) {
    const dest = path.join(pluginsDir, p.id);
    // Belt and braces on the id: the plan validated it, and the join must
    // still land directly inside plugins/.
    if (!PLUGIN_ID_RE.test(p.id) || path.dirname(dest) !== pluginsDir) {
      failed.push({ id: p.id, reason: 'invalid plugin id' });
      continue;
    }
    const stage = path.join(pluginsDir, `.install-${p.id}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const files = new Map();
      if (!p._manifest) throw new Error('the plan carries no verified manifest — re-run the dry run');
      verifyManifest(p._manifest, p.id);
      for (const a of p.assets) {
        if (a.name === 'manifest.json') { files.set(a.name, p._manifest); continue; }
        const buf = await downloadAsset(fetch, a);
        if (a.name === 'main.js') verifyMainJs(buf, p.id);
        files.set(a.name, buf);
      }
      // Re-checked right before this plugin's FIRST write — the staging
      // directory — because the downloads above took time, and again before
      // the renames. Nothing is staged, let alone installed, through a link.
      assertPlainDirChain(fs, vaultPath, ['.obsidian', 'plugins', p.id]);
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.mkdirSync(stage);
      for (const [name, buf] of files) fs.writeFileSync(path.join(stage, name), buf);

      assertPlainDirChain(fs, vaultPath, ['.obsidian', 'plugins', p.id]);
      let destStat = null;
      try { destStat = fs.lstatSync(dest); } catch { destStat = null; }
      if (destStat && (destStat.isSymbolicLink() || !destStat.isDirectory())) {
        throw new Error(`${p.destination} exists and is not a plain directory — refusing to write through it`);
      }
      if (!destStat) {
        fs.renameSync(stage, dest);
      } else {
        if (hasMainJs(fs, dest) && !force) {
          throw new Error(`${p.destination}/main.js appeared since the plan was made — not overwritten (use --force)`);
        }
        // main.js LAST: Obsidian must not find new code beside an old manifest.
        const order = [...files.keys()].sort((a, b) => (a === 'main.js') - (b === 'main.js'));
        for (const name of order) fs.renameSync(path.join(stage, name), path.join(dest, name));
        rmQuiet(fs, stage);
      }
      installed.push({ id: p.id, version: p.version, files: [...files.keys()], dataJsonKept: exists(fs, path.join(dest, 'data.json')) });
    } catch (err) {
      rmQuiet(fs, stage);
      failed.push({ id: p.id, reason: err.message });
    }
  }

  const communityPlugins = ensureCommunityPluginsListed(vaultPath, installed.map((i) => i.id), { fs });
  return { installed, failed, communityPlugins };
}

/**
 * Add ids to community-plugins.json when missing. A file that is not a JSON
 * array is left exactly as it is and reported.
 */
export function ensureCommunityPluginsListed(vaultPath, ids, { fs = nodeFs } = {}) {
  assertNotServerProcess('ensureCommunityPluginsListed');
  // The list is written through `.obsidian/` too, and the file itself must be
  // a file: a link there would carry the atomic write somewhere else.
  try {
    assertPlainDirChain(fs, vaultPath, ['.obsidian']);
    let st = null;
    try { st = fs.lstatSync(communityFileOf(vaultPath)); } catch { st = null; }
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      throw new Error(`${communityFileOf(vaultPath)} is not a plain file — refusing to write through it`);
    }
  } catch (err) {
    return { added: [], state: 'refused', error: err.message };
  }
  const current = readCommunityPlugins(vaultPath, { fs });
  if (current.state === 'invalid') return { added: [], state: 'invalid', error: current.error };
  const list = [...current.ids];
  const added = [];
  for (const id of ids) {
    if (!list.includes(id)) { list.push(id); added.push(id); }
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(communityFileOf(vaultPath)), { recursive: true });
    writeFileAtomicSync(communityFileOf(vaultPath), `${JSON.stringify(list, null, 2)}`, { fsMod: fs });
  }
  return { added, state: current.state };
}

/** The checklist every successful apply ends with. */
export function postInstallChecklist({ vaultArg, installedIds = [] } = {}) {
  const lines = [
    'Next steps — Obsidian only loads plugin code at start-up:',
    '  1. Reload Obsidian on this vault.',
    '     Desktop: Ctrl+P (Cmd+P on macOS) → "Reload app without saving".',
    '     Container (obsidian-remote / linuxserver): the same command in the web UI, or `docker compose restart`.',
    '  2. Settings → Community plugins: Restricted mode must be OFF, or no community plugin loads.',
  ];
  if (installedIds.includes(LOCAL_REST_API_ID)) {
    lines.push('  3. Local REST API was installed fresh: give this vault its own port and key with setup-vault before relying on it.');
  }
  lines.push(`Then check what Obsidian actually loaded: obsidian-mcp-router --plugin-health ${JSON.stringify(vaultArg ?? '<vault>')}`);
  return lines;
}
