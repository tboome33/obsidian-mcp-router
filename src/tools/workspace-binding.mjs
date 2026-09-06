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
 *   - `refuse: "<vault>"` records that the user said NO to a proposal
 *     (decision `refus-d-une-proposition-de-liaison`, accepted 2026-09-04).
 *     Until then a proposal could only be adopted or endured: the one the
 *     user did not want was re-announced at every session, forever, because
 *     nothing could write down that the question had been answered. The
 *     refusal is written on TWO sides with two roles — the user's own config,
 *     where it is the AUTHORITY that silences the question; and, only when
 *     this project's `.env` itself carried that very proposal, the same file,
 *     as `OBSIDIAN_ROUTER_REFUSED_VAULT`: a portable HINT that survives an
 *     uninstall of the router and makes the question be asked once more,
 *     with its context, after a reinstall. A cloned repository carrying that
 *     line can silence nobody; at worst it makes a question be asked, once.
 *   - `retract: "<vault>"` takes a refusal back. Binding the vault does too,
 *     through `withBinding` — adopting is the opposite of refusing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../helpers/write-file-atomic.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import {
  HINT_STATUS,
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
  readRefusals,
  withRefusal,
  withoutRefusal,
} from '../helpers/workspace-bindings.mjs';
import { upsertDotenvVar } from '../helpers/dotenv-writer.mjs';
import {
  envKeyOrigin,
  envKeySourceFile,
  ENV_ORIGINS,
  REFUSED_VAULT_KEY,
  isGatedDeployment,
} from '../helpers/workspace-dotenv.mjs';
import { launchObsidianVault } from '../helpers/obsidian-launcher.mjs';
import { pingVault } from '../rest-client.mjs';
import { pathBasename, _internals as registryInternals } from '../registry.mjs';
import { registeredVaultPaths, vaultSlug } from '../helpers/vault-slug.mjs';
import {
  isVaultReachable,
  isPromotionOfLockedSecondary,
  isPromotionOfLockedSecondaryOnDisk,
  lockedSecondaryPromotionError,
} from '../helpers/vault-reach.mjs';

const { resolveDefaultVaultWithSource } = registryInternals;

/** How the binding got there, recorded for the human who reads the config later. */
const CONFIRMED_VIA = 'tool';

/**
 * The refusal both the preflight (live registry) and the in-lock check (the
 * file) speak — ONE sentence, so the two cannot drift apart.
 */
const promotionRefusal = (primary) =>
  `confirm_workspace_binding: "${safeForMessage(primary, 80)}" is an alsoLocked SECONDARY of this `
  + 'workspace; binding the workspace to it as its primary would lift that hard read-only tier from '
  + 'the conversation. Edit `alsoLocked` in config.json if this workspace is meant to maintain that '
  + 'vault, or clear the binding first (confirm_workspace_binding({ clear: true })) and re-bind — '
  + 'two explicit acts, not one.';

/**
 * The name a `refuse` or a `retract` is about, validated at the boundary: a
 * plain vault name, nothing that could become a second `.env` line or a
 * message that drives a terminal. NOT checked against the registry — a refusal
 * may name a vault this machine does not have (`unknown-vault` is a signalled
 * status, and refusing it is how the notice stops), so the registry has
 * nothing to say about it.
 */
function refusalName(arg, verb) {
  if (typeof arg !== 'string' || arg.trim() === '') {
    throw new Error(
      `confirm_workspace_binding: \`${verb}\` must name a vault — the one this workspace `
      + (verb === 'refuse' ? 'should no longer be asked about.' : 'may be asked about again.'),
    );
  }
  if (/[\r\n\0]/.test(arg) || arg.length > 255) {
    throw new Error(
      `confirm_workspace_binding: \`${verb}\` must be a plain vault name (no line break, at most 255 `
      + `characters); got "${safeForMessage(arg, 60)}".`,
    );
  }
  return arg;
}

/**
 * Record (or clear) this workspace's binding — or refuse, or un-refuse, a
 * proposal.
 *
 * @param {object} registry the live registry — used for the vault catalogue and configPath
 * @param {{ vault?: string, also?: string[], locked?: boolean, open?: boolean, clear?: boolean, refuse?: string, retract?: string }} args
 * @param {{ cwd?: string, readFile?: Function, writeFile?: Function, launch?: Function, upsertDotenv?: Function }} [seams] test seams
 */
export async function confirmWorkspaceBinding(registry, args = {}, seams = {}) {
  const {
    cwd = process.cwd(),
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    writeFile = (p, c) => writeFileAtomicSync(p, c),
    launch = launchObsidianVault,
    ping = pingVault,
    upsertDotenv = upsertDotenvVar,
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

  // A REFUSAL IS ITS OWN ACT. `refuse` and `retract` answer a proposal; the
  // other arguments write a binding. One call, one act — a call that both
  // bound and refused would be writing two answers to one question, and
  // whichever this function happened to apply first would win in silence.
  const verbs = ['refuse', 'retract'].filter((k) => args[k] !== undefined);
  if (verbs.length) {
    const others = ['vault', 'also', 'locked', 'clear'].filter((k) => args[k] !== undefined);
    if (verbs.length > 1 || others.length) {
      throw new Error(
        `confirm_workspace_binding: \`${verbs[0]}\` cannot be combined with `
        + `${[...verbs.slice(1), ...others].map((k) => `\`${k}\``).join(', ')} — refusing a proposal and `
        + 'binding a vault are two separate calls.',
      );
    }
    // NOT ON A GATED DEPLOYMENT. Under OBSIDIAN_ROUTER_READONLY, ALLOWED_VAULTS
    // or USER_ID the router serves several callers from ONE process whose cwd
    // is the server's own directory: a refusal recorded there lands in the
    // shared config under the server's key and, if that directory's `.env`
    // proposed the vault, as a line in the SERVER's `.env` — one caller's
    // answer standing for all of them, written by a remote hand. The same
    // reason `register_remote_vault` is hidden from gated deployments.
    // Measured by the Fable round on 7efbad1: under READONLY the tool was
    // exposed and `refuse` wrote both halves. (The `vault`/`clear` verbs have
    // the same exposure and predate this phase; that question is on the
    // roadmap, Phase 6.)
    if (isGatedDeployment()) {
      throw new Error(
        `confirm_workspace_binding: \`${verbs[0]}\` is not available on a gated deployment `
        + '(OBSIDIAN_ROUTER_READONLY, OBSIDIAN_ROUTER_ALLOWED_VAULTS or OBSIDIAN_ROUTER_USER_ID is set): the '
        + 'workspace here is the server\'s own directory, shared by every caller, and a refusal recorded there '
        + 'would answer for all of them. Refuse from a session that runs in the project itself.',
      );
    }
    const ctx = { registry, cwd, key, configPath, io, upsertDotenv };
    return verbs[0] === 'refuse'
      ? refuseProposal(ctx, refusalName(args.refuse, 'refuse'))
      : retractRefusal(ctx, refusalName(args.retract, 'retract'));
  }

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
    let refusals = null;
    updateConfigBindings(configPath, (cfg) => {
      had = readBinding(cfg, cwd);
      // Untouched by a clear — read so the live copy below is the file's,
      // not whatever this process loaded at start-up.
      refusals = readRefusals(cfg, cwd);
      return withMigrationState(withoutBinding(cfg, cwd), { cwd, recordImported: true });
    }, io);

    // THE LIVE REGISTRY IS RELEASED TOO, not only the file. The first version
    // wrote the config and returned "all registered vaults are available
    // again" while the running server stayed bound — and with `--no-watch`
    // there is nothing to reload it, so the sentence stayed false for the rest
    // of the session. Found by the Codex review, 2026-09-03.
    registry.workspaceBinding = null;
    registry.workspaceRefusals = refusals;
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
  // A vault this workspace declared as an `alsoLocked` SECONDARY cannot be
  // promoted to PRIMARY from the conversation: `alsoWriteTierFor` returns
  // null for a primary, so this call was the one-step way past "no
  // exceptions" (decision portee-et-mode-ecriture-des-vaults §2; review
  // round 3). Read against the LIVE binding here, for an early answer; the
  // check that DECIDES is asked again of the file, inside the lock (below).
  if (isPromotionOfLockedSecondary(primary, registry)) {
    throw lockedSecondaryPromotionError(promotionRefusal(primary));
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
  let refusalsDropped = [];
  const next = updateConfigBindings(configPath, (cfg) => {
    assertBindable(cfg);
    const previous = readBinding(cfg, cwd);
    // A refusal of any vault being bound is dropped by `withBinding` itself;
    // read here, inside the lock, only so the answer can SAY so.
    const refusedBefore = readRefusals(cfg, cwd);
    refusalsDropped = requested.filter((n) => refusedBefore.has(n));
    // THE PROMOTION REFUSAL IS ASKED AGAIN, OF THE FILE. The preflight above
    // answered from the live registry; between it and this lock a sibling
    // session may have recorded `primary` as a strict secondary of this very
    // workspace (`set_secondary_vault_mode`; under `--no-watch` the live copy
    // never learns), and the `keep` filter below would then have read that
    // fresh tier and dropped it as "no longer a secondary" — the bypass the
    // preflight exists to stop, through the re-read meant to make the write
    // safe. (Codex, round on fd9e1cd.)
    if (isPromotionOfLockedSecondaryOnDisk(primary, previous, cfg)) {
      throw lockedSecondaryPromotionError(promotionRefusal(primary));
    }
    const locked = typeof args.locked === 'boolean'
      ? args.locked
      : Boolean(previous && previous.vault === primary && previous.locked);
    // THE TIER OF EACH SECONDARY SURVIVES A RE-CONFIRMATION. Adding a
    // secondary is the ordinary reason to call this again, and the first
    // version would have reset every mode `set_secondary_vault_mode` had
    // recorded. Carried from the binding as it is INSIDE the lock, filtered
    // to the vaults that are still secondaries after this call.
    const keep = (list) => (previous && Array.isArray(list) ? list.filter((n) => also.includes(n)) : []);
    return withBinding(cfg, cwd, {
      vault: primary,
      also,
      locked,
      confirmedVia: CONFIRMED_VIA,
      alsoLocked: keep(previous?.alsoLocked),
      alsoWritable: keep(previous?.alsoWritable),
    });
  }, io);

  // Apply to the LIVE registry too, so the session that just confirmed does
  // not have to be restarted to see its own answer.
  const binding = readBinding(next, cwd);
  registry.workspaceBinding = binding;
  registry.workspaceRefusals = readRefusals(next, cwd);
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
    // The refusals this binding made stale, and dropped. Named so the user
    // hears that an earlier "no" is gone, rather than discovering it the day
    // the binding is cleared and the proposal comes back.
    refusalsDropped,
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
      + (refusalsDropped.length
        ? ` The earlier refusal of ${refusalsDropped.map((n) => `"${safeForMessage(n, 80)}"`).join(', ')} recorded for this workspace is dropped — binding a vault is adopting it.`
        : '')
      + ' The binding lives in your own router config, not in this project, so it does not travel with a clone.',
  };
}

/**
 * Record that this workspace refused a proposal — `confirm_workspace_binding
 * ({ refuse })`. See the header for the two sides and their roles.
 *
 * THE CONFIG FIRST, THE FILE SECOND, and the file only when it SPOKE. The
 * decision's trap 3: writing into a cloned repository's `.env` is accepting
 * that a `git commit` carries the line to a colleague. Harmless by
 * construction — it asks them a question, once — but it has to be a
 * consequence the user is told about, not a discovery. The mitigation the
 * decision asked to examine first is applied as the rule: the line is written
 * only into the file the LOADER took this very proposal from, i.e. only when
 * `OBSIDIAN_ROUTER_DEFAULT_VAULT` came from this workspace's `.env` and names
 * the vault being refused. A proposal from the host leaves the project's file
 * untouched: there is no line there to answer.
 *
 * @param {{ registry: object, cwd: string, key: string, configPath: string, io: object, upsertDotenv: Function }} ctx
 * @param {string} name the vault being refused
 */
async function refuseProposal({ registry, cwd, key, configPath, io, upsertDotenv }, name) {
  const shown = safeForMessage(name, 80);
  let alreadyRefused = false;
  const next = updateConfigBindings(configPath, (cfg) => {
    // A VAULT THIS WORKSPACE IS BOUND TO CANNOT BE REFUSED. The binding in
    // force outranks a refusal anyway (the classifier says `confirmed`, trap
    // 5), so recording one beside it would be writing two answers to the one
    // question — and the day the binding is cleared, the stale "no" would
    // silence a proposal the user had adopted in between. Asked of the FILE,
    // inside the lock, like every decision that ends in a write here.
    const bound = readBinding(cfg, cwd);
    if (bound && boundVaults(bound).includes(name)) {
      // THE REMEDY DEPENDS ON THE ROLE. "Clear the binding" is the right way
      // out for the primary and the wrong one for a secondary, where it would
      // throw away the primary and every other secondary to refuse one name;
      // the Fable round on 7efbad1 found the briefing sending a user there.
      // IDENTIFIERS IN AN ACTIONABLE COMMAND ARE NOT TRUNCATED. `safeForMessage`
      // clips at its cap and marks the cut; a primary named with 81 characters
      // came out altered, and the suggested re-confirmation failed with "not a
      // registered vault" (Codex, round on 1fad78c). The control-character
      // neutralisation stays; the cap is raised past any real vault name.
      const primaryShown = safeForMessage(bound.vault, 4096);
      const remainder = bound.also.filter((n) => n !== name).map((n) => `"${safeForMessage(n, 4096)}"`).join(', ');
      throw new Error(
        bound.vault === name
          ? `confirm_workspace_binding: this workspace is bound to "${shown}" as its primary, so that vault cannot be `
            + 'refused — a binding in force is the opposite answer. Clear the binding first '
            + '(confirm_workspace_binding({ clear: true })), or bind the workspace elsewhere; then refuse.'
          : `confirm_workspace_binding: "${shown}" is a SECONDARY of this workspace (in \`also\`), so it cannot be `
            + 'refused — a binding in force is the opposite answer. Re-confirm the binding without it first '
            + `(confirm_workspace_binding({ vault: "${primaryShown}", also: [${remainder}] })), then refuse.`,
      );
    }
    alreadyRefused = readRefusals(cfg, cwd).has(name);
    return withRefusal(cfg, cwd, name);
  }, io);

  // The live registry hears the answer in the same session: the very next
  // `list_vaults` reports the proposal as `refused`, and the briefing of the
  // next session says nothing — under `--no-watch` as everywhere else.
  registry.workspaceRefusals = readRefusals(next, cwd);
  const hint = refreshRegistryBindingHint(registry);
  const silencesCurrentHint = hint?.status === HINT_STATUS.REFUSED && hint.hint === name;

  // THE PORTABLE HALF. The file is the loader's record, never a path composed
  // from `cwd` — the same discipline as the one-time import — and it has to
  // be THIS workspace's file, so a test seam pointing `cwd` elsewhere cannot
  // make the tool write into the directory the process was started in.
  //
  // A WORKSPACE FILE PROPOSES A VAULT THROUGH TWO LINES — the default-vault
  // hint and the lock hint, which the one-time import decides first. The
  // reader (`dotenvRefusalHint`) honours a refusal beside either; the first
  // version of this writer looked at the default line alone, so a workspace
  // whose only proposal was `OBSIDIAN_ROUTER_LOCKED=X` got a config-only
  // refusal, and after a reinstall the untouched file had X imported LOCKED
  // despite the explicit no (Codex, both engines, round on 1fad78c).
  const proposalKey = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_LOCKED'].find((envKey) => {
    const source = envKeySourceFile(envKey);
    return Boolean(source)
      && envKeyOrigin(envKey) === ENV_ORIGINS.WORKSPACE_DOTENV
      && process.env[envKey] === name
      && canonicalWorkspaceKey(path.dirname(source)) === key;
  }) || null;
  const file = proposalKey ? envKeySourceFile(proposalKey) : null;
  const fileProposedThisVault = Boolean(file);
  let hintWritten = false;
  let hintError = null;
  if (fileProposedThisVault) {
    // Best effort: the refusal is in force from the config alone. A file the
    // process cannot write costs the reinstall memory, nothing else, and the
    // answer says which half is missing rather than failing a call that did
    // record the user's decision.
    //
    // QUOTED WHEN THE NAME HAS WHITESPACE, exactly as `--attach` quotes the
    // proposal line it stands beside: a `.env` is also sourced by shells, and
    // the loader strips matched outer quotes on read, so the two lines are
    // read back as the same name.
    const literal = /\s/.test(name) ? `"${name}"` : name;
    try {
      await upsertDotenv(file, REFUSED_VAULT_KEY, literal);
      hintWritten = true;
    } catch (err) {
      hintError = err?.message || String(err);
    }
  }

  const where = hintWritten
    ? `, and ${REFUSED_VAULT_KEY}=${shown} was written to ${file} beside the line that proposed it. That line is the portable half: it survives an uninstall of the router and makes the question be asked once more, with this context, after a reinstall — it silences nobody by itself, so a clone of this repository carrying it is at worst asked once. It may travel with the project if the file is committed.`
    : fileProposedThisVault
      ? `. ${REFUSED_VAULT_KEY} could NOT be written to ${file} (${safeForMessage(hintError || 'unknown error', 120)}): the refusal is in force from your config alone; only the memory that would survive a reinstall is missing.`
      : `. Nothing was written to this project's .env: as the router loaded it, neither its OBSIDIAN_ROUTER_DEFAULT_VAULT nor its OBSIDIAN_ROUTER_LOCKED line proposed "${shown}" (the host may have; a line the host overrode does not count), and a refusal is written only beside a line the router took from the file.`;
  return {
    refused: true,
    vault: name,
    workspace: key,
    alreadyRefused,
    silencesCurrentHint,
    hintWritten,
    envPath: hintWritten ? file : undefined,
    hintError,
    message:
      (alreadyRefused
        ? `"${shown}" was already refused for this workspace; nothing changed in your router config`
        : `Refused: this workspace will not be asked about the vault "${shown}" again. Recorded in your own router config, which is the answer that silences the question`)
      + where
      + ` Bind it later with confirm_workspace_binding({ vault: "${shown}" }) — which drops the refusal — or take the refusal back with confirm_workspace_binding({ retract: "${shown}" }).`,
  };
}

/**
 * Take a refusal back — `confirm_workspace_binding({ retract })`. The config
 * half only: a proposal naming that vault is signalled again, as any
 * unanswered proposal is. The file's `OBSIDIAN_ROUTER_REFUSED_VAULT` line, if
 * any, is left alone on purpose — it is a memory that a refusal happened, not
 * an answer, and the briefing reads it as exactly that.
 *
 * @param {{ registry: object, cwd: string, key: string, configPath: string, io: object }} ctx
 * @param {string} name
 */
async function retractRefusal({ registry, cwd, key, configPath, io }, name) {
  const shown = safeForMessage(name, 80);
  let had = false;
  const next = updateConfigBindings(configPath, (cfg) => {
    had = readRefusals(cfg, cwd).has(name);
    return withoutRefusal(cfg, cwd, name);
  }, io);
  registry.workspaceRefusals = readRefusals(next, cwd);
  refreshRegistryBindingHint(registry);
  return {
    retracted: had,
    vault: name,
    workspace: key,
    message: had
      ? `The refusal of "${shown}" is withdrawn: a proposal naming it is signalled again, like any proposal `
        + 'this workspace has not answered. This project\'s .env is left as it is — an '
        + `${REFUSED_VAULT_KEY} line there, if any, records that a refusal happened, and is read as that.`
      : `No refusal of "${shown}" was recorded for this workspace; nothing changed.`,
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
  // "Validated against the live vault set like every other lock candidate" —
  // and, since Phase 2, against REACHABILITY too, exactly as `validateLock`
  // does at start-up: a host lock naming a vault this workspace cannot reach
  // was rejected when the server started, and re-deriving it here without
  // that half of the check handed it back — `lockedVault` set to a name
  // `resolveVault()` refuses, every call failing until `unlock_vaults`.
  // Found in review round 3, one site over from the start-up fix.
  const active = fromHost
    && (registry.vaults || []).some((v) => v.name === fromHost)
    && isVaultReachable(fromHost, registry);
  registry.lockedVault = active ? fromHost : null;
  registry.lockSource = active
    ? { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' }
    : { origin: 'unset', variable: null };
}

/** Exported for tests only. */
export const _internals = { CONFIRMED_VIA, defaultConfigDir: path.dirname };
