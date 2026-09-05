/**
 * ONE VAULT, SEVERAL WORKSPACES — where optimistic concurrency stops being a
 * recommendation and becomes a requirement.
 *
 * Decision `ergonomie-creation-liaison-vaults` §3 / point 6, accepted by
 * Roland on 2026-09-04; Phase 4 of `portee-ergonomie-refus-roadmap`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * `write_file` and its seven siblings already implement compare-and-swap: pass
 * `ifMatch` (the `contentSha256` a `get_file` returned) and the write is
 * refused with a 409 if the file changed since you read it. The mechanism has
 * existed on both sides for a long time — the router's `ifMatch` argument, the
 * bridge's `PUT /vault-cas/*` route. It was simply OPTIONAL, and the
 * measurement taken while the decision was written says what optional bought:
 * of the 21 `write_file` call sites in this repository's own skills and
 * commands, 11 mention `ifMatch`. Blind writing is the normal case, not the
 * exception.
 *
 * Two sessions on two different projects, both bound to the same reference
 * vault, can write the same note minutes apart and neither ever learns. The
 * loser's paragraph is simply gone.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REQUIREMENT LIVES ON THE VAULT, AND IS COMPUTED
 * ---------------------------------------------------------------------------
 * Making `ifMatch` mandatory everywhere was considered and refused by the
 * decision itself: it would break every one of those 21 call sites, including
 * flows with no possible collision — a vault only one workspace has ever
 * declared has nobody to race with.
 *
 * So the requirement is a property OF THE VAULT, and it is READ rather than
 * declared: the binding registry already knows, at every instant, which
 * workspaces name which vault. A vault two or more workspaces declare (as
 * their primary `vault` or in their `also`) requires the precondition. A vault
 * one workspace declares does not, and nothing changes for it.
 *
 * There is no new switch, no new list to keep up to date, and — this is the
 * point of computing it — no way for the two to disagree. A checkbox would go
 * stale the first time somebody bound a second workspace and forgot to tick
 * it; that is the failure this repository has paid for in other shapes.
 *
 * `openVaults` is the one case the count cannot see: such a vault is reachable
 * from EVERY workspace without being declared anywhere, so the registry counts
 * zero attachments for it. The decision names the answer — treat it as always
 * multi-attached, by hypothesis, precisely because its readership is not
 * knowable. It is the strictest reading and the only honest one.
 *
 * ---------------------------------------------------------------------------
 * FRESHNESS IS PART OF THE REQUIREMENT, NOT A DETAIL
 * ---------------------------------------------------------------------------
 * The roadmap states it as an acceptance criterion (item 19): a vault that
 * goes from single- to multi-attached must acquire the requirement AT THE
 * INSTANT the second workspace declares it, not after a restart.
 *
 * That cannot be answered from this process's memory. The second workspace is
 * another session, in another directory, in another process: its binding
 * exists only in the config FILE. The live registry holds THIS workspace's
 * binding and nothing else, and the config hot-reload that would eventually
 * notice is off under `--no-watch` and switches itself off after a watcher
 * error. Deciding from the in-memory copy is the exact defect class the Codex
 * round on `fd9e1cd` found four times over, one field at a time: decide on the
 * live copy, apply to the file.
 *
 * So the attachment count is read from the file, per call, through
 * `createBindingsReader` — an `mtime`+`size` guard means the parse happens
 * only after the file actually changes, which on this path costs a `stat` next
 * to a REST round trip.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMIT (the decision requires it to be stated WITH the mechanism)
 * ---------------------------------------------------------------------------
 * Compare-and-swap protects the writers that go through this route FROM EACH
 * OTHER. It does not protect against a writer that does not: a note saved in
 * the Obsidian window open on the machine hosting the vault, an Obsidian
 * Sync / LiveSync replica landing a remote change, a script editing the
 * folder directly. The section is indivisible against other CAS writers, not
 * against the world. That is inherent to optimistic concurrency, not a defect
 * to be fixed later — and it is written here, in the refusal message, and in
 * `docs/remote-vaults.md`, rather than left for someone to discover.
 *
 * Two narrower limits, named for the same reason:
 *   - `move_file`'s precondition guards the SOURCE. With `overwrite: true` the
 *     DESTINATION can still be replaced; the tool offers no second
 *     precondition to require. The default (`overwrite: false`) refuses an
 *     existing destination outright, which is the safe side.
 *   - The router's OWN maintenance writes — the audit line, the first-contact
 *     repair, the projections/search refresh — do not carry preconditions and
 *     are not gated here. They regenerate derived artifacts from the vault's
 *     own content (see `IF_MATCH_EXEMPT` below for why that is not a hole),
 *     and they are already governed by the write tiers.
 */

import fs from 'node:fs';
import { canonicalWorkspaceKey, normalizeBinding, boundVaults, WORKSPACE_BINDINGS_KEY } from './workspace-bindings.mjs';
import { isRecoveryCall } from './write-targets.mjs';

/**
 * Why a vault requires the precondition. Two reasons, deliberately kept
 * distinct: they produce different sentences, and one of them ("several
 * workspaces") can name them.
 */
export const SHARING_REASONS = Object.freeze({
  /** Two or more workspaces declare this vault in the binding registry. */
  MULTI_WORKSPACE: 'multi-workspace',
  /** Listed in `openVaults`: reachable everywhere, readership unknowable. */
  OPEN_VAULT: 'open-vault',
});

/**
 * The workspaces that DECLARE `vaultName` — as their primary or in their
 * `also` — in the binding registry of `config`.
 *
 * Canonicalised and deduplicated, because the count is the whole point and a
 * hand-edited config can hold ONE directory under two spellings (`C:\Work\Repo\`
 * and `c:/work/repo`). Counting those as two workspaces would put a vault only
 * one project uses under a requirement meant for shared ones — a false
 * positive that is impossible to diagnose from the message. `readBinding`
 * already canonicalises both sides for exactly this reason; so does this.
 *
 * Sorted so the message is stable across two runs on the same config (object
 * key order is not a contract).
 *
 * @param {string} vaultName
 * @param {object|null} config the parsed router config, or null when unreadable
 * @returns {string[]} canonical workspace keys, sorted
 */
export function workspacesDeclaring(vaultName, config) {
  if (typeof vaultName !== 'string' || vaultName === '') return [];
  const all = config?.[WORKSPACE_BINDINGS_KEY];
  if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
  const keys = new Set();
  for (const [storedKey, raw] of Object.entries(all)) {
    const binding = normalizeBinding(raw);
    if (!binding) continue;
    if (!boundVaults(binding).includes(vaultName)) continue;
    // A key that will not canonicalise is not a workspace this router can ever
    // be in, so it cannot be a second writer either — it is dropped rather
    // than counted under its raw spelling.
    const key = canonicalWorkspaceKey(storedKey);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Does `vaultName` require an optimistic-concurrency precondition on every
 * write, and why?
 *
 * @param {string} vaultName
 * @param {{ openVaults?: string[] }} registry the live registry (for `openVaults`)
 * @param {object|null} config the config as it is ON DISK RIGHT NOW, or null
 *   when it could not be read — in which case only the `openVaults` half can
 *   be answered, which is stated rather than silently treated as "no
 *   requirement". See `createBindingsReader`, which keeps the last good copy
 *   precisely so this argument is almost never null.
 * @returns {{ required: boolean, reason: string|null, workspaces: string[] }}
 */
export function sharingRequirement(vaultName, registry, config) {
  // `openVaults` comes from the REGISTRY, not from the freshly-read `config`,
  // and the asymmetry with the workspace count below is deliberate. The count
  // must be fresh because the fact it reads is written by ANOTHER PROCESS —
  // that is the whole of roadmap item 19. `openVaults` is hand-edited by the
  // user in their own config, exactly like `alsoLocked`, which the sibling gate
  // (`alsoWriteTierFor`) also reads from the registry: taking one from the file
  // and the other from memory is how two gates that must agree about which
  // vaults are open end up disagreeing after a hand edit. Both follow the
  // registry, and a hand edit takes effect on hot-reload or restart.
  const open = Array.isArray(registry?.openVaults) ? registry.openVaults : [];
  if (open.includes(vaultName)) {
    return { required: true, reason: SHARING_REASONS.OPEN_VAULT, workspaces: [] };
  }
  const workspaces = workspacesDeclaring(vaultName, config);
  if (workspaces.length > 1) {
    return { required: true, reason: SHARING_REASONS.MULTI_WORKSPACE, workspaces };
  }
  return { required: false, reason: null, workspaces };
}

/**
 * Write tools that cannot carry a per-file precondition, and why each one is
 * not a hole. A Map rather than a Set so the reason travels with the name and
 * a test can assert none is missing — an exemption without a written reason is
 * a coverage gap with a nicer name, the rule this repository already applies
 * to its other classification inventories.
 *
 * The partition (covered | exempt) is asserted TOTAL over `WRITE_TOOL_NAMES`
 * in tests/vault-sharing.test.mjs: a write tool added later cannot be silently
 * ungated, which is the only way this list stays true.
 */
export const IF_MATCH_EXEMPT = new Map([
  ['provision_vault',
    'Creates a NEW vault on local disk. It addresses no file in an existing vault, so there is '
    + 'nothing a precondition could pin.'],
  ['register_remote_vault',
    'Writes a `remoteVaults` entry to the router\'s own config.json, never to a vault.'],
  ['download_page_assets',
    'Writes binary asset files to a filesystem directory (`outputDir`), a set of new files rather '
    + 'than an edit to a known one, and it declares no per-file precondition. Its reachability and '
    + 'write tier are still enforced, by path containment (assertAssetOutputDirWritable).'],
  ['build_wiki_graph',
    'Regenerates a DERIVED artifact (the knowledge-graph JSON) wholesale from the vault\'s own '
    + 'content. There is no "content I read" to pin — the input is the whole vault — and two '
    + 'sessions racing regenerate the same thing from the same source. Requiring a precondition '
    + 'would make it permanently impossible on every shared vault, the router\'s own maintenance '
    + 'pass included.'],
  ['build_search_index', 'Same as build_wiki_graph: a derived index regenerated from the vault\'s own content.'],
  ['refresh_okf_projections', 'Same as build_wiki_graph: the OKF projections are regenerated from the pages themselves.'],
  ['record_source',
    'Does its OWN compare-and-swap on the shared ledger — it reads the fingerprint and writes with '
    + 'ifMatch (src/tools/source-ledger.mjs), refusing rather than clobbering a parallel session\'s '
    + 'entry. It is already the discipline this gate exists to impose; a caller-supplied '
    + 'precondition would be a second, weaker one.'],
]);

/**
 * What a call brings to the table, precondition-wise.
 *
 *   'carried'         — it names a precondition; let it through.
 *   'missing'         — it could and does not.
 *   'not-applicable'  — the requirement does not reach this call at all.
 *
 * Presence is what is checked here, never SHAPE: each tool validates its own
 * `ifMatch` (64-hex or a loud refusal) and there must be exactly one validator
 * for that, or the two eventually disagree about what a hash looks like. A
 * malformed value is refused either way — one gate later, with a better
 * message.
 *
 * @param {string} toolName
 * @param {object} args the RAW arguments
 * @returns {'carried'|'missing'|'not-applicable'}
 */
export function preconditionState(toolName, args = {}) {
  if (IF_MATCH_EXEMPT.has(toolName)) return 'not-applicable';

  if (toolName === 'write_bundle') {
    // A RECOVERY RUN replays a journal; it applies no `steps[]` and carries its
    // own guard, verified rather than assumed: `planRestore`'s decision table
    // (helpers/write-bundle.mjs) answers `skip` for a path holding someone
    // else's content — "undoing our own damage must not cause someone else's" —
    // and names it in the report. That IS this requirement, one layer down.
    // Its own limit is stated there and not restated here: an `observed`
    // post-image (patch/append/frontmatter steps) can adopt a write that landed
    // inside a single round trip.
    //
    // Named explicitly rather than left to fall through the loop below, where
    // "no steps" would pass as vacuously satisfied — a hole that reads like a
    // rule.
    if (isRecoveryCall(args.recover)) return 'not-applicable';
    const steps = Array.isArray(args.steps) ? args.steps : [];
    // An empty bundle writes nothing. Not "satisfied": nothing to satisfy.
    if (steps.length === 0) return 'not-applicable';
    const unguarded = steps.some((s) => !stepCarriesPrecondition(s));
    return unguarded ? 'missing' : 'carried';
  }

  // `execute_template` with `createFile: true` writes the rendered template at
  // a caller-named path, through the bridge, and offers NO precondition. It is
  // therefore 'missing' and can never be anything else on a shared vault —
  // deliberately, because there is a real way through: render without
  // `createFile` and write the result with `write_file`, which does carry one.
  // Exempting it instead would leave the one write tool that overwrites a
  // caller-named file unguarded, which is precisely the clobber in question.
  if (toolName === 'execute_template') {
    return args.createFile === true ? 'missing' : 'not-applicable';
  }

  if (typeof args.ifMatch === 'string' && args.ifMatch !== '') return 'carried';

  // `write_file`'s OTHER precondition, and the reason a shared vault can still
  // receive a new note at all: `ifNew: true` sends
  // `Apply-If-Content-Preexists: false`, so the server refuses with a 409 if
  // the file already exists. That is a compare-and-swap against ABSENCE — the
  // only one available for a file that has no hash yet, since there is nothing
  // to have read. Without it this gate would make "create a note" impossible
  // on every shared vault, which is not a stricter rule, it is a broken one.
  //
  // `write_file` ONLY: no other tool declares the flag, so accepting it
  // elsewhere would let a caller through on an argument the handler ignores.
  if (toolName === 'write_file' && args.ifNew === true) return 'carried';

  return 'missing';
}

/**
 * One `write_bundle` step. `ifNew: true` counts on a `write` step for the same
 * reason it does on `write_file`.
 */
function stepCarriesPrecondition(step) {
  if (!step || typeof step !== 'object') return false;
  if (typeof step.ifMatch === 'string' && step.ifMatch !== '') return true;
  return step.op === 'write' && step.ifNew === true;
}

/**
 * What the caller should pass instead, per tool — the second half of every
 * refusal. A message that says "this is required" without saying "here is the
 * argument that satisfies it" costs a round trip and teaches nothing.
 */
const PRECONDITION_HINT = {
  write_file:
    'pass `ifMatch` (the contentSha256 a get_file returned) to write only if the file still holds '
    + 'what you read, or `ifNew: true` to create a file that must not exist yet',
  move_file:
    'pass `ifMatch` (the contentSha256 of the SOURCE, from get_file) — note that it guards the '
    + 'source; leave `overwrite` false so an existing destination is refused rather than replaced',
  write_bundle:
    'give EVERY step its own `ifMatch` (or `ifNew: true` on a write step) — the bundle checks them '
    + 'all before its first write, so a stale bundle refuses whole',
  execute_template:
    'this tool carries no precondition, so it cannot write to a shared vault: call it WITHOUT '
    + '`createFile` to get the rendered text back, then write that with write_file '
    + '(`ifMatch`, or `ifNew: true` for a new note)',
};
const DEFAULT_PRECONDITION_HINT =
  'pass `ifMatch` (the contentSha256 a get_file returned) so the change is refused with a 409 '
  + 'instead of overwriting what changed since you read it';

/** The honest limit, in one sentence, carried by every refusal. */
const HONEST_LIMIT =
  'Honest limit: this protects writes that go through the router from EACH OTHER — not from a '
  + 'note saved in Obsidian itself on the machine hosting the vault, nor from a Sync/LiveSync '
  + 'replica.';

/**
 * Refuse a write to a shared vault that carries no optimistic-concurrency
 * precondition. Silent (no throw) for a vault only one workspace declares, for
 * a call that carries one, and for the tools that cannot.
 *
 * @param {{ name: string }} vault the RESOLVED vault (registry.resolveVault's return)
 * @param {object} registry the live registry
 * @param {string} toolName
 * @param {object} args the RAW arguments
 * @param {object|null} config the config as it is on disk right now
 */
export function assertSharedVaultPrecondition(vault, registry, toolName, args = {}, config = null) {
  const state = preconditionState(toolName, args);
  if (state !== 'missing') return;
  const { required, reason, workspaces } = sharingRequirement(vault?.name, registry, config);
  if (!required) return;

  const why = reason === SHARING_REASONS.OPEN_VAULT
    ? 'it is listed in `openVaults`, so every workspace on this machine can reach it and its '
      + 'readership is not knowable — the decision treats such a vault as shared by hypothesis'
    : `${workspaces.length} workspaces declare it in your router config (${workspaces.join(', ')}), `
      + 'so another session can be writing the same note right now';

  throw new Error(
    `${toolName}: vault "${vault?.name}" is SHARED — ${why}. A write with no optimistic-concurrency `
    + 'precondition would silently overwrite whatever changed since you read the file, so it is '
    + `refused: ${PRECONDITION_HINT[toolName] || DEFAULT_PRECONDITION_HINT}. ${HONEST_LIMIT}`,
  );
}

/**
 * A reader of the binding registry AS IT IS ON DISK, cheap enough to consult on
 * every write.
 *
 * `mtimeMs` + `size` decide whether the file is re-parsed. Both, not just the
 * timestamp: a filesystem with coarse timestamps (or two writes inside the
 * same millisecond, which `updateConfigBindings`' atomic rename makes possible)
 * can leave `mtimeMs` unchanged while the content differs, and the size then
 * catches it. Neither is a hash — this is a cache invalidation heuristic on the
 * router's own config file, not a security boundary; the write path takes a
 * real lock and re-reads inside it.
 *
 * WHAT HAPPENS WHEN THE FILE CANNOT BE READ. The LAST GOOD copy is kept and
 * returned. A transient failure (a rename racing the read, a lock held by an
 * antivirus scanner) must not make a requirement disappear for one call — a
 * guard that fails open at the first hiccup is not a guard. When there has
 * never been a good copy, `null` comes back and `sharingRequirement` answers
 * from `openVaults` alone; that is stated in its doc rather than hidden.
 *
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {(p: string) => string} [opts.readFile]
 * @param {(p: string) => {mtimeMs: number, size: number}} [opts.statFile]
 * @returns {{ current: () => object|null }}
 */
export function createBindingsReader({ configPath, readFile, statFile } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const stat = statFile || ((p) => fs.statSync(p));
  let lastGood = null;
  let stamp = null;

  return {
    current() {
      if (!configPath) return lastGood;
      try {
        const st = stat(configPath);
        const now = `${st.mtimeMs}:${st.size}`;
        if (stamp === now) return lastGood;
        const parsed = JSON.parse(read(configPath));
        // A config that parses to a non-object is not a config. Keeping the
        // previous copy beats adopting `null`/an array and answering "no
        // workspace declares anything" for the rest of the session.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          lastGood = parsed;
          stamp = now;
        }
        return lastGood;
      } catch {
        return lastGood;
      }
    },
  };
}
