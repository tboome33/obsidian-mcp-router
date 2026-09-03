/**
 * confirm_workspace_binding — the conversational half of the workspace→vault
 * binding.
 *
 * Points 1 and 2 of the accepted decision `liaison-workspace-vault-hors-depot`
 * ask for a binding the USER confirms, once per machine, rather than one a
 * project file decides on its own. `--attach` is the deliberate command-line
 * half; this is the half that works inside a conversation: Claude sees an
 * unconfirmed hint in `list_vaults`, tells the user, the user says yes, and
 * this records it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT DO
 * ---------------------------------------------------------------------------
 *   - It records a binding for the CURRENT workspace only. There is no
 *     parameter for another path: binding a directory the user is not in is
 *     not a thing a conversation should be able to do by accident.
 *   - Every vault named must ALREADY BE REGISTERED. A binding can never call a
 *     vault into existence, exactly like the dotenv hint it replaces — the
 *     value is checked against the registry, not against a pattern.
 *   - It may OPEN the vaults it binds, because a vault whose Obsidian is not
 *     running does not answer and a binding to a closed vault would be a
 *     promise that does not work. Opening is subordinate to this explicit
 *     call: nothing here runs at start-up, and nothing opens a vault the user
 *     did not name.
 *   - `clear: true` removes the binding and returns the workspace to ALL
 *     vaults — the third state, and the way to undo a confirmation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../helpers/write-file-atomic.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import {
  withBinding,
  withoutBinding,
  readBinding,
  boundVaults,
  canonicalWorkspaceKey,
  updateConfigBindings,
  withMigrationState,
  refreshRegistryBindingHint,
  authoritativeDefaultVault,
  authoritativeLockedVault,
} from '../helpers/workspace-bindings.mjs';
import { launchObsidianVault } from '../helpers/obsidian-launcher.mjs';
import { pingVault } from '../rest-client.mjs';
import { pathBasename, _internals as registryInternals } from '../registry.mjs';
import { registeredVaultPaths, vaultSlug } from '../helpers/vault-slug.mjs';

const { resolveDefaultVaultWithSource } = registryInternals;

/** How the binding got there, recorded for the human who reads the config later. */
const CONFIRMED_VIA = 'tool';

/**
 * Record (or clear) this workspace's binding.
 *
 * @param {object} registry the live registry — used for the vault catalogue and configPath
 * @param {{ vault?: string, also?: string[], locked?: boolean, open?: boolean, clear?: boolean }} args
 * @param {{ cwd?: string, readFile?: Function, writeFile?: Function, launch?: Function }} [seams] test seams
 */
export async function confirmWorkspaceBinding(registry, args = {}, seams = {}) {
  const {
    cwd = process.cwd(),
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    writeFile = (p, c) => writeFileAtomicSync(p, c),
    launch = launchObsidianVault,
    ping = pingVault,
  } = seams;

  const configPath = registry?.configPath;
  if (!configPath) {
    throw new Error('confirm_workspace_binding: the router has no config path — nothing to write a binding into.');
  }
  const key = canonicalWorkspaceKey(cwd);
  if (!key) {
    throw new Error('confirm_workspace_binding: no usable working directory, so there is no workspace to bind.');
  }

  // Everything below goes through `updateConfigBindings`, the ONE writer of
  // `workspaceBindings` on disk: it re-reads the file (another session,
  // `--attach` or a hand edit may have touched it) and writes atomically (the
  // config holds the vault registry and API keys — a torn write is a router
  // that no longer starts).
  const io = { readFile, writeFile };
  const readConfig = () => {
    try {
      return JSON.parse(readFile(configPath));
    } catch (err) {
      throw new Error(
        `confirm_workspace_binding: cannot read the router config at ${configPath} (${err.code || err.message}). `
        + 'Nothing was changed.',
      );
    }
  };

  if (args.clear === true) {
    // READ INSIDE THE LOCK, and reported from there. `had` used to come from a
    // read taken before the lock, so the message could name a vault another
    // process had already replaced.
    //
    // THE WORKSPACE IS ALSO RECORDED AS CONSIDERED, which is what makes this
    // clear permanent. The one-time import only wrote the workspace into
    // `imported[]` when it had actually imported something — so a workspace
    // that was ALREADY BOUND at the first start of this version was never
    // recorded, and clearing its binding re-opened the window: the next start
    // read the dotenv hint again and put the binding back, `confirmedVia:
    // 'migration'`. Measured against the real `loadRegistry` on 2026-09-03.
    // The registry side closes it for `already-bound`; this closes it for the
    // act the user just performed, whatever the migration had decided.
    let had = null;
    updateConfigBindings(configPath, (cfg) => {
      had = readBinding(cfg, cwd);
      return withMigrationState(withoutBinding(cfg, cwd), { cwd, recordImported: true });
    }, io);

    // THE LIVE REGISTRY IS RELEASED TOO, not only the file. The first version
    // wrote the config and returned "all registered vaults are available
    // again" while the running server stayed bound — and with `--no-watch`
    // there is nothing to reload it, so the sentence stayed false for the rest
    // of the session. Found by the Codex review, 2026-09-03.
    registry.workspaceBinding = null;
    // A lock the BINDING imposed goes with it. One the host imposed does not —
    // and a host lock the binding had been SHADOWING comes back, whatever
    // vault it names. The first version kept the host lock only when it named
    // the same vault as the binding, so clearing a binding locked to A
    // silently dropped a host lock on B. Codex round 2.
    //
    // THE TEST IS THE SOURCE, NOT THE NAME. Comparing `registry.lockedVault`
    // with `had.vault` asks "does the lock in force name the vault the file
    // said a moment ago", and those can differ for a reason that has nothing
    // to do with the host: this session started locked to A by its binding,
    // another process re-bound the workspace to B, and `had` — correctly read
    // inside the lock — is now B. The name comparison then failed, so the
    // session stayed locked to A while this call answered "all registered
    // vaults are available again". `lockSource` says who imposed the lock,
    // which is the question actually being asked. (Codex, round 5.)
    if (registry.lockSource?.origin === 'binding') releaseBindingLock(registry);
    // A lock that SURVIVES this — a volatile `lock_vault` of this session, or
    // the host's — is not this call's to lift, but it is this call's to
    // mention: "all registered vaults are available again" was said while the
    // guard still refused every one of them. (Sixth review, 2026-09-04.)
    const stillLocked = registry.lockedVault
      ? ` The session is still locked to "${safeForMessage(String(registry.lockedVault), 80)}" by `
        + (registry.lockSource?.origin === 'host'
          ? 'the host\'s OBSIDIAN_ROUTER_LOCKED, which this call does not touch.'
          : 'this session\'s own lock_vault call; unlock_vaults lifts it.')
      : '';
    // Same correction one field over: the default is re-derived when the
    // BINDING was the tier that chose it — and also when it merely names the
    // vault just unbound, which re-runs the cascade for the same answer at
    // worst. The name half is kept on purpose: it costs one resolution and
    // covers a registry whose source field is stale.
    if (registry.defaultVaultSource?.origin === 'binding' || registry.defaultVault === had?.vault) {
      // The binding was tier 0; with it gone the cascade answers again. THE
      // REAL CASCADE is re-run, not a hand-rolled imitation of it: a second
      // implementation of "which vault is the default" would be a second
      // answer to the one question this whole lot exists to have one answer
      // for, and it would drift the first time a tier changed.
      const again = resolveDefaultVaultWithSource({
        vaults: registry.vaults || [],
        configuredDefault: registry.configuredDefault,
        binding: null,
      });
      registry.defaultVault = again.name;
      registry.defaultVaultSource = { origin: again.origin, variable: again.variable };
    }
    // The hint is a statement ABOUT the binding: with the binding gone, a hint
    // that read `confirmed` a moment ago is an unconfirmed proposal again.
    refreshRegistryBindingHint(registry);

    return {
      cleared: true,
      workspace: key,
      previous: had ? { vault: had.vault, also: had.also } : null,
      boundTo: null,
      message: had
        // SANITISED. `had.vault` comes straight out of a hand-editable config
        // and is never checked against the registry on this path, so a name
        // carrying an escape sequence or a newline reached this message raw —
        // measured on 2026-09-03. Every other config-derived value in this
        // file goes through `safeForMessage`; this one had been missed.
        ? `This workspace is no longer bound to "${safeForMessage(had.vault, 80)}". All registered vaults are available again, and the default is resolved by the usual cascade.${stillLocked}`
        : `This workspace had no binding; nothing changed. All registered vaults were, and remain, available.${stillLocked}`,
    };
  }

  const primary = args.vault;
  if (typeof primary !== 'string' || primary.trim() === '') {
    throw new Error(
      'confirm_workspace_binding: `vault` is required (the vault this workspace should be bound to). '
      + 'Pass `clear: true` instead to remove the binding and return to all vaults.',
    );
  }

  // EVERY name is checked against the registry. This is the same rule the
  // dotenv hint has always had, and the reason a binding cannot reach a vault
  // the user never registered.
  //
  // AGAINST BOTH THE LIVE REGISTRY AND THE CONFIG JUST RE-READ. The live
  // registry is what this session can actually resolve (it includes remote
  // and VAULT_* vaults the config file does not list); the file is what the
  // NEXT session will load. A vault removed from the config since start-up is
  // still in the live registry under `--no-watch`, and round 1 of the Codex
  // review showed the tool happily binding to it — a binding the next start
  // would silently fall through. Requiring both closes that without letting
  // a vault that is in the file but not yet loaded be bound either.
  // The file's vault names come from `vaultSlug`, the one boundary that
  // type-checks the config's word. The first version derived them here by
  // hand — `typeof onDisk.vaultNames[vp] === 'string' ? … : basename(vp)` —
  // which is precisely the expression the `vaultNames` sweep collapsed into
  // that helper, and precisely what its scan guard refuses outside it. Two
  // separate repairs meeting: this one decides WHICH vaults may be bound, the
  // helper decides what a vault is CALLED, and only one of them should own
  // the second question.
  const known = new Map(registry.vaults.map((v) => [v.name, v]));
  const requested = [primary, ...(Array.isArray(args.also) ? args.also : [])];
  const also = requested.slice(1).filter((n) => n !== primary);

  /**
   * Refuse any name this machine will not resolve — against BOTH the live
   * registry and the config as it is INSIDE THE LOCK.
   *
   * The live registry is what this session can actually reach (it includes
   * remote and `VAULT_*` vaults the config file does not list); the file is
   * what the NEXT session will load. A vault removed from the config since
   * start-up is still in the live registry under `--no-watch`, and round 1 of
   * the Codex review showed the tool happily binding to it — a binding the
   * next start would silently fall through.
   *
   * THE FILE HALF IS RE-READ INSIDE THE LOCK. Validating it from a copy taken
   * before the lock is the same defect as deciding `locked` outside it: A
   * validates vault X, B removes X from the config and saves, A takes the lock
   * and writes a binding to a vault that is no longer there — and reports
   * success. Found by Codex in round 5, one field over from where round 4 had
   * just fixed it. The check now runs on the config the transform was handed,
   * and throwing from there propagates out of `updateConfigBindings`, which
   * releases the lock on every exit path.
   *
   * The file's vault names come from `vaultSlug`, the one boundary that
   * type-checks the config's word about a name.
   */
  const assertBindable = (cfg) => {
    const fileNames = new Set([
      ...registeredVaultPaths(cfg).map((vp) => vaultSlug(cfg, vp)),
      ...(Array.isArray(cfg.remoteVaults) ? cfg.remoteVaults : [])
        .map((r) => (typeof r?.name === 'string' ? r.name : null)).filter(Boolean),
    ]);
    const unknown = requested.filter((n) => typeof n !== 'string' || !known.has(n)
      // A live vault that the file no longer lists — or that only the
      // environment provides (VAULT_*), which the next session may not have.
      || (known.get(n)?.type === 'local' && !fileNames.has(n)));
    if (!unknown.length) return;
    const names = unknown.map((n) => `"${safeForMessage(String(n), 60)}"`).join(', ');
    // THE CATALOGUE IS SANITISED TOO. These names come from `vaultNames`, from
    // `remoteVaults[].name` and from vault paths — all hand-editable — so a
    // name carrying a terminal escape or a newline reached this message raw
    // while the rejected argument beside it was carefully cleaned. Half a
    // guard reads as a guard. Found in the final review, 2026-09-03.
    const available = [...known.keys()].map((n) => safeForMessage(String(n), 60)).join(', ') || '(none)';
    throw new Error(
      `confirm_workspace_binding: ${names} is not a registered vault, so it cannot be bound. `
      + `Registered vaults: ${available}. Register it first (setup-vault), then confirm.`,
    );
  };
  // `locked` IS TRI-STATE. `true` locks, `false` unlocks, and ABSENT keeps
  // whatever the binding already says. The first version wrote
  // `args.locked === true`, so re-confirming a locked workspace without
  // mentioning the lock — the ordinary way of adding an `also` — silently
  // unlocked it on disk while the live guard stayed locked, and the restart
  // sided with the disk. Found in round 2 (2026-09-03), in this tool and in
  // `--attach` alike: the same rewrite-drops-the-lock shape, twice.
  //
  // AND THE "WHATEVER IT ALREADY SAYS" IS READ INSIDE THE LOCK. Reading it
  // from the copy above and applying the result in the transform is the same
  // defect one field over: A reads `locked: false`, B persists `locked: true`,
  // A re-confirms without mentioning the lock and writes its stale `false`
  // over B — inside the very function that re-reads to prevent exactly that.
  // Found in the final review, 2026-09-03; the merge review had found the
  // identical shape in the migration.
  const next = updateConfigBindings(configPath, (cfg) => {
    assertBindable(cfg);
    const previous = readBinding(cfg, cwd);
    const locked = typeof args.locked === 'boolean'
      ? args.locked
      : Boolean(previous && previous.vault === primary && previous.locked);
    return withBinding(cfg, cwd, {
      vault: primary,
      also,
      locked,
      confirmedVia: CONFIRMED_VIA,
    });
  }, io);

  // Apply to the LIVE registry too, so the session that just confirmed does
  // not have to be restarted to see its own answer.
  const binding = readBinding(next, cwd);
  registry.workspaceBinding = binding;
  registry.defaultVault = primary;
  registry.defaultVaultSource = { origin: 'binding', variable: null };
  // AND THE HINT IS RE-CLASSIFIED. It was computed once at start-up, so a hint
  // the user had just adopted through this very call went on being reported as
  // `unconfirmed` — and this tool's own description tells Claude to offer a
  // confirmation whenever it sees that status, so the assistant would keep
  // proposing what had already been accepted. Under `--no-watch` nothing ever
  // corrected it. Measured through the real `list_vaults`, in one process, in
  // the final review of 2026-09-03.
  refreshRegistryBindingHint(registry);

  // A LOCK THAT IS RECORDED IS A LOCK THAT IS IN FORCE. The first version
  // stored `locked: true`, reported it back, and never touched
  // `registry.lockedVault` — the only field the lock guard reads. So the tool
  // said the workspace was locked, `list_vaults` agreed, and every other vault
  // still answered. A restart did not help either: start-up derived the lock
  // from the environment alone. Found by the Codex review, 2026-09-03; the
  // start-up half is fixed in src/index.mjs.
  if (binding.locked) {
    registry.lockedVault = primary;
    registry.lockSource = { origin: 'binding', variable: null };
  } else if (registry.lockedVault) {
    // The binding no longer imposes a lock — either because the workspace was
    // re-bound elsewhere, or because it was re-confirmed with `locked: false`
    // on the SAME vault (round 2 found that case left the live guard locked
    // while the file and the response both said unlocked). A binding-imposed
    // lock goes; a host-imposed one is re-derived, not merely kept, so that a
    // host lock the binding had been shadowing comes back rather than being
    // dropped with it.
    releaseBindingLock(registry);
  }

  // Open what is not open. Best effort by design: a window that did not appear
  // must not undo a binding that was recorded.
  //
  // WHETHER A VAULT IS OPEN IS ASKED, NOT ASSUMED. The first version tested
  // `v.online` — a field that EXISTS ONLY on the `list_vaults` response, never
  // on a registry entry, so it was always `undefined` and every bound vault
  // was relaunched, running or not. The test did not catch it because it built
  // its own registry entries with `online: true`: it measured a world the test
  // had made up. Found by the Codex review, 2026-09-03.
  //
  // A ping costs a round trip to loopback and this is an explicit user action,
  // so the cost is proportionate — unlike in the session-start hook, where the
  // same question is deliberately left to `list_vaults`.
  const opened = [];
  if (args.open !== false) {
    for (const name of boundVaults(binding)) {
      const v = known.get(name);
      if (!v) continue;
      const alive = await ping(v).catch(() => ({ online: false }));
      if (alive?.online) continue;
      // The Obsidian-side label is the on-disk basename WITH its casing, not
      // the router's lowercased slug — the URI handler matches what Obsidian
      // registered. Remote vaults have no local path and nothing to open.
      const label = v.path ? pathBasename(v.path) : null;
      if (!label) continue;
      const r = launch(label);
      opened.push({ vault: name, launched: r.launched, uri: r.uri, reason: r.reason });
    }
  }

  const several = also.length > 0;
  return {
    cleared: false,
    workspace: key,
    boundTo: primary,
    also,
    locked: binding.locked,
    opened,
    message:
      // Sanitised like every other config-derived name in this file: these
      // are the REGISTERED spellings, which come from `vaultNames` and from
      // vault paths, so they are the config's word and not the router's.
      //
      // "ADDRESSABLE BY NAME" IS ONLY TRUE UNLOCKED. While the lock holds, the
      // guard refuses every vault but the primary, secondaries included; they
      // stay bound and answer again once it is lifted. (Sixth review.)
      (several
        ? `This workspace is now bound to "${safeForMessage(primary, 80)}", with ${also.map((n) => `"${safeForMessage(n, 80)}"`).join(', ')} also bound and `
          + (binding.locked ? 'addressable by name once the lock is lifted (while it holds, no other vault answers).' : 'addressable by name.')
        : `This workspace is now bound to "${safeForMessage(primary, 80)}".`)
      + (opened.length
        ? ` Opening ${opened.filter((o) => o.launched).length} of ${opened.length} vault(s) that were not running — Obsidian may take a moment, and a vault answers only once it is open.`
        : '')
      + ' The binding lives in your own router config, not in this project, so it does not travel with a clone.',
  };
}

/**
 * Drop a binding-imposed lock and RE-DERIVE what the host imposes, if
 * anything. The host's `OBSIDIAN_ROUTER_LOCKED` is an authority the binding
 * may have been shadowing; removing the binding must restore it, not erase
 * it. Validated against the live vault set like every other lock candidate:
 * a host lock naming a vault that is gone yields no lock, not a broken one.
 */
function releaseBindingLock(registry) {
  const fromHost = authoritativeLockedVault();
  const active = fromHost && (registry.vaults || []).some((v) => v.name === fromHost);
  registry.lockedVault = active ? fromHost : null;
  registry.lockSource = active
    ? { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' }
    : { origin: 'unset', variable: null };
}

/** Exported for tests only. */
export const _internals = { CONFIRMED_VIA, defaultConfigDir: path.dirname };
