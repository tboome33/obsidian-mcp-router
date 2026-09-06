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
 * `write_file` and its six siblings already implement compare-and-swap: pass
 * `ifMatch` (the `contentSha256` a `get_file` returned) and the write is
 * refused with a 409 if the file changed since you read it. The mechanism has
 * existed on both sides for a long time — the router's `ifMatch` argument, the
 * bridge's `PUT /vault-cas/*` route. It was simply OPTIONAL, and the
 * measurement taken while the decision was written (2026-09-04, by hand, over
 * skills/ and commands/) says what optional bought: of the 21 `write_file`
 * call sites counted then, 11 mentioned `ifMatch`. The tree has grown since —
 * re-measure rather than quote the figure. Blind writing is the normal case,
 * not the exception.
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
 * `createBindingsReader` — the bytes are read every time and re-parsed only
 * when they changed, which on this path costs one small file read next to a
 * REST round trip. (Not `mtime`+`size`: a coarse timestamp hides a same-length
 * replacement — Codex round on 23bbbaa.)
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
// The bundle's OWN normaliser and id test, not a mirror of them. The first
// version used `isRecoveryCall` (write-targets.mjs) — a second copy of the same
// rule, which disagreed with the handler on non-string junk (`recover: 1`), so
// a malformed call met this gate's refusal instead of the handler's "invalid
// recover value". Two predicates asking one question is how they end up
// disagreeing; this one now asks the handler's. (Fable 5.1 round.)
import { normalizeRecoverArg, isOperationId } from './write-bundle.mjs';
// A C3 plan seal IS a content-pinned precondition (see `preconditionState`).
import { isPlanSeal } from './plan-seal.mjs';
// The ONE boundary that turns a config key into a list of names — container
// guard included, so a hand-edited `openVaults: "roland"` is not iterated
// character by character. Reading `config.openVaults` here by hand duplicated
// that check and re-opened a class the repository swept shut on purpose; its
// own scan caught it (tests/vault-slug.test.mjs).
import { openVaultEntries } from './vault-slug.mjs';

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
  /**
   * The binding registry could not be read, so how many workspaces declare
   * this vault is UNKNOWN. Treated as shared — see `sharingRequirement`.
   */
  UNKNOWN: 'registry-unreadable',
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
 *   when the current read failed — uncertainty is treated as shared, even
 *   if an earlier read succeeded.
 * @returns {{ required: boolean, reason: string|null, workspaces: string[] }}
 */
export function sharingRequirement(vaultName, registry, config) {
  // `openVaults` is read from BOTH the fresh file and the registry (union,
  // below). The first version read the registry alone and defended the
  // asymmetry with the workspace count as "consistency with the sibling gate";
  // Codex argued the other side and was right — see the comment at the union.
  //
  // AND IT COUNTS WHETHER OR NOT `vaultReach` IS ACTIVE — deliberate, not an
  // oversight. `openVaults` is `vaultReach: "declared"`'s exception list, so
  // one could argue it means nothing while that switch is off. But the two
  // possible mistakes are not symmetric: counting it always can surprise
  // somebody whose `openVaults` was inert with a refusal that explains itself
  // and points at the fix, whereas counting it only under `vaultReach` would
  // SILENTLY drop the protection from a user's shared personal vaults the day
  // they turn the switch off. For a guard, the safe direction is the one that
  // errs towards refusing. The sentence in the refusal stays true either way:
  // with the switch off, every workspace really can reach every vault.
  // OPEN IN EITHER VIEW COUNTS. Read from the fresh file AND from the
  // registry, union. Codex round on 23bbbaa argued the first version's
  // registry-only read the other way and was right: a vault ADDED to
  // `openVaults` takes effect only after the watcher's delayed reload — and
  // never at all with `--no-watch` or after a watcher error — so during that
  // window blind writes were permitted. Reading the file alone would have the
  // mirror hole (a vault still open in this session's registry but already
  // removed from the file). For a guard, the union is the safe reading, and it
  // is stricter-sooner in both directions.
  const open = new Set([
    ...(Array.isArray(registry?.openVaults) ? registry.openVaults : []),
    ...openVaultEntries(config),
  ]);
  if (open.has(vaultName)) {
    return { required: true, reason: SHARING_REASONS.OPEN_VAULT, workspaces: [] };
  }
  // A CONFIG THAT COULD NOT BE READ IS "I DO NOT KNOW", NOT "NOBODY DECLARES
  // IT". The first version returned `required: false` here, and a test blessed
  // it — a guard that fails open the moment it cannot see is not a guard, and
  // the whole point of this one is that the fact it needs lives in a file
  // another process writes. Refusing costs one actionable message on a broken
  // or momentarily-locked config; the other direction costs a silent clobber
  // on a vault the router already knew was shared. (Codex round on 23bbbaa,
  // found by both passes.)
  if (!config) {
    return { required: true, reason: SHARING_REASONS.UNKNOWN, workspaces: [] };
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
    'Creates a NEW vault on local disk, or ADOPTS an existing folder (the adopt path keeps a '
    + 'pre-existing app.json and skips plugin directories that are already there — '
    + 'helpers/vault-wizard-engine.mjs). Either way it writes scaffolding into a folder that is not '
    + 'yet a registered vault when the call is made, so no binding can declare it shared and there '
    + 'is no note content a precondition could pin.'],
  ['register_remote_vault',
    'Writes a `remoteVaults` entry to the router\'s own config.json, never to a vault.'],
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
    + 'entry; its CREATE path writes with `applyIfContentPreexists: false`, which `rest-client`\'s '
    + 'writeFile now enforces router-side (the server ignored the header — Fable 5.1 round). It is '
    + 'already the discipline this gate exists to impose; a caller-supplied precondition would be a '
    + 'second, weaker one.'],
]);

/**
 * Is `value` the content-pinned precondition a C3 sealed two-phase call
 * carries? `delete_file` with `approvedPlanSha256` rebuilds the plan from the
 * file's CURRENT content and refuses on drift before the DELETE
 * (tools/delete-file.mjs); `write_bundle` with `approvedPlanSha256` verifies
 * the seal over a plan that carries every target's before-image hash, before
 * the journal is even written (tools/write-bundle.mjs). Same check-then-mutate
 * grade as `assertContentMatches`. The first version recognised only `ifMatch`
 * and sent the documented preview → confirm flows (the `manage-delete` skill,
 * a sealed bundle) to fetch a hash they had already pinned. (Fable 5.1 round.)
 */
const carriesSeal = (args) => isPlanSeal(args.approvedPlanSha256);

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
    // ROUTED EXACTLY AS THE HANDLER ROUTES: on `recover` first, through the
    // handler's own normaliser. `true` is the read-only listing (never reaches
    // here — `requiresAlsoTierCheck` exempts it — but named so the two agree);
    // an operation id is a RUN; anything else is malformed and the handler
    // refuses it with its own message, writing nothing.
    const recover = normalizeRecoverArg(args.recover);
    if (recover === true) return 'not-applicable';
    if (isOperationId(recover)) {
      // A RECOVERY RUN WRITES, AND ITS BUILT-IN GUARD DOES NOT COVER THIS CASE:
      // `planRestore` answers `skip` for someone else's content only when the
      // bundle KNOWS what it left there (`last`); a recovery replays with an
      // EMPTY last-state and restores over differing content as `unverified`,
      // on purpose. (Codex round on 23bbbaa — the first version had exempted
      // it on a claim read from the module header, not the branch.)
      //
      // ITS PRECONDITION IS `expect`: { path: currentSha256 | null } for every
      // path the run will restore, taken from the `recover: true` listing. The
      // handler refuses the whole run before any write if one no longer
      // matches — per-path `ifMatch`, in the recovery's own vocabulary. The
      // first repair refused the run outright and sent the caller to "repair
      // the named files deliberately" with nothing to do it with: no hash, no
      // journal path, and a `write_file` that cannot carry what the listing
      // did not show. (Fable 5.1 round.)
      return expectCarriesPrecondition(args.expect) ? 'carried' : 'missing';
    }
    if (recover !== false) return 'not-applicable';
    // A SEALED APPLY pins every target's before-image in the plan the seal
    // covers; the handler refuses on drift before the journal is written.
    if (carriesSeal(args)) return 'carried';
    const steps = Array.isArray(args.steps) ? args.steps : [];
    // An empty bundle writes nothing. Not "satisfied": nothing to satisfy.
    if (steps.length === 0) return 'not-applicable';
    const unguarded = steps.some((s) => !stepCarriesPrecondition(s));
    return unguarded ? 'missing' : 'carried';
  }

  // `execute_template` with `createFile: true` IS create-only: the bridge
  // refuses an existing `targetPath` with a 409 before rendering, and
  // `app.vault.create` throws on an existing file besides (bridge
  // `templates-execute.ts`, since the route's first commit). That is the
  // compare-and-swap against ABSENCE this gate credits `ifNew: true` with —
  // the first version refused the one write here that cannot clobber, on the
  // claim that it "carries no precondition". Read against the bridge's branch,
  // not this repository's comment about it. (Fable 5.1 round.) A render-only
  // call writes nothing.
  if (toolName === 'execute_template') return args.createFile === true ? 'carried' : 'not-applicable';

  // `download_page_assets` writes a batch of BINARY files, which no other tool
  // can carry (write_file's content is a markdown string). Its precondition is
  // `createOnly: true` — the asset analogue of `ifNew`: every file is opened
  // with the `wx` flag, an existing name falls through to the content-hash
  // name, and an existing content-hash name means the identical asset is
  // already there. Nothing is ever overwritten. The first repair refused the
  // tool outright on a shared vault and pointed at write_file, a remedy that
  // cannot carry a PNG. (Fable 5.1 round.)
  if (toolName === 'download_page_assets') return args.createOnly === true ? 'carried' : 'missing';

  // A DELETE THAT IS NOT CONFIRMED WRITES NOTHING. `delete_file` refuses
  // without `confirm: true`, but `requiresAlsoTierCheck` only exempts the
  // `preview` form, so this gate ran first and answered "you need ifMatch" to a
  // call whose real problem was the missing confirmation — sending the caller
  // to fetch a hash for a delete that was never going to happen. The handler's
  // own refusal is the right one. (Codex round on 23bbbaa.) Handled here rather
  // than in `requiresAlsoTierCheck`, which the write-tier gate shares and which
  // has its own review history.
  if (toolName === 'delete_file') {
    if (args.confirm !== true) return 'not-applicable';
    if (carriesSeal(args)) return 'carried';
  }

  if (typeof args.ifMatch === 'string' && args.ifMatch !== '') return 'carried';

  // `write_file`'s OTHER precondition, and the reason a shared vault can still
  // receive a new note at all: `ifNew: true` refuses with a 409 if the file
  // already exists — a compare-and-swap against ABSENCE, the only one
  // available for a file that has no hash yet. Without it this gate would make
  // "create a note" impossible on every shared vault, which is not a stricter
  // rule, it is a broken one.
  //
  // WHERE THAT REFUSAL ACTUALLY HAPPENS, verified rather than assumed: in the
  // ROUTER, before the PUT (`rest-client.writeFile` probes the path when
  // `applyIfContentPreexists: false`). The header it also sends,
  // `Apply-If-Content-Preexists`, is read by NO version of the Local REST API
  // plugin (4.0.2 reads `Reject-If-Content-Preexists`, and only in PATCH) —
  // so before the Fable 5.1 round `ifNew: true` was a plain overwriting PUT on
  // every real installation, and this gate credited it with a protection that
  // did not exist. The check is check-then-write, one round trip wide, and
  // `HONEST_LIMIT` says so.
  //
  // `write_file` ONLY: no other tool declares the flag, so accepting it
  // elsewhere would let a caller through on an argument the handler ignores.
  if (toolName === 'write_file' && args.ifNew === true) return 'carried';

  return 'missing';
}

/**
 * One `write_bundle` step. `ifNew: true` counts on a `write` step for the same
 * reason it does on `write_file` — and the bundle's pre-flight now checks it
 * against the before-images like `ifMatch`, so a stale one refuses whole.
 */
function stepCarriesPrecondition(step) {
  if (!step || typeof step !== 'object') return false;
  if (typeof step.ifMatch === 'string' && step.ifMatch !== '') return true;
  return step.op === 'write' && step.ifNew === true;
}

/**
 * A recovery run's `expect` map: a plain object with at least one entry whose
 * values are each a content hash or `null` ("this file does not exist").
 * Coverage of EVERY path the run restores is the handler's check — it alone
 * knows the journal; here, as everywhere in this gate, presence and shape are
 * what is asked.
 */
function expectCarriesPrecondition(expect) {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) return false;
  const values = Object.values(expect);
  if (values.length === 0) return false;
  return values.every((v) => v === null || isPlanSeal(v));
}

/**
 * What the caller should pass instead, per tool — the second half of every
 * refusal. A message that says "this is required" without saying "here is the
 * argument that satisfies it" costs a round trip and teaches nothing.
 */
const NEW_FILE_HINT =
  ' A file that does not exist yet cannot be guarded this way (get_file 404s and `ifMatch` would '
  + 'answer "target missing"): create it with write_file and `ifNew: true`, then append or patch it';
const PRECONDITION_HINT = {
  write_file:
    'pass `ifMatch` (the contentSha256 a get_file returned) to write only if the file still holds '
    + 'what you read, or `ifNew: true` to create a file that must not exist yet',
  append_to_file:
    'pass `ifMatch` (the contentSha256 a get_file returned) so the append is refused if the file '
    + 'changed since you read it.' + NEW_FILE_HINT,
  patch_file:
    'pass `ifMatch` (the contentSha256 a get_file returned) so the patch is refused if the file '
    + 'changed since you read it.' + NEW_FILE_HINT,
  set_frontmatter:
    'pass `ifMatch` (the contentSha256 a get_file returned — get_frontmatter does not return one).'
    + NEW_FILE_HINT,
  merge_frontmatter:
    'pass `ifMatch` (the contentSha256 a get_file returned — get_frontmatter does not return one).'
    + NEW_FILE_HINT,
  move_file:
    'pass `ifMatch` (the contentSha256 of the SOURCE, from get_file) — note that it guards the '
    + 'source; leave `overwrite` false so an existing destination is refused rather than replaced',
  delete_file:
    'pass `ifMatch` (the contentSha256 a get_file returned), or the `approvedPlanSha256` a '
    + 'preview:true call returned — the seal pins the file\'s content and the delete is refused if '
    + 'it drifted',
  write_bundle:
    'give EVERY step its own `ifMatch` (or `ifNew: true` on a write step) — the bundle checks them '
    + 'all before its first write, so a stale bundle refuses whole; or pass the `approvedPlanSha256` '
    + 'a preview:true call returned, which pins every target. For a RECOVERY RUN pass `expect`: '
    + '{ "<path>": "<currentSha256>" | null } for every path it will restore, copied from the '
    + '`recover: true` listing (read-only) — the run is refused before any write if a file no '
    + 'longer matches',
  download_page_assets:
    'pass `createOnly: true` — every asset is then written create-only (`wx`), an existing name '
    + 'falls through to the content-hash name, and an asset already there is reported, never '
    + 'overwritten',
};
const DEFAULT_PRECONDITION_HINT =
  'pass `ifMatch` (the contentSha256 a get_file returned) so the change is refused with a 409 '
  + 'instead of overwriting what changed since you read it';

/**
 * The honest limit, in one sentence, carried by every refusal.
 *
 * The second half grades the protection, and is not decoration. Only
 * `write_file` with `ifMatch` — called directly, as a `write_bundle` step, or by
 * `record_source` — against a bridge that serves `/vault-cas/` is a true atomic
 * compare-and-swap. Everything else — the GET-compare fallback on an older
 * bridge; `assertContentMatches` for patch/append/frontmatter/delete;
 * `move_file`'s own source compare; the router-side existence probe behind
 * `ifNew`; the recovery's `expect` probe; a C3 seal's re-derived plan — is
 * check-then-mutate: it narrows the window from unbounded to one round trip, it
 * does not close it.
 *
 * Codex (round on 23bbbaa) proposed refusing the non-atomic modes outright.
 * Declined, with the reason on record: no atomic route exists for six of the
 * seven tools, so that rule would leave a shared vault writable only by
 * `write_file` against a recent bridge — it would not make the router safer,
 * it would make it unusable and push the work back onto blind writes elsewhere.
 * The decision asks for `ifMatch`; what `ifMatch` is worth is stated instead of
 * overclaimed, the same way `write_bundle` grades its own attribution as
 * `ours` / `observed` rather than pretending to isolation.
 */
const HONEST_LIMIT =
  'Honest limit: this protects writes that go through the router from EACH OTHER — an edit '
  + 'already saved in Obsidian is caught by the hash, a save landing after the check is not, and a '
  + 'Sync/LiveSync replica never passes here at all. And only `write_file` + `ifMatch` (directly '
  + 'or as a bundle write step) against a bridge serving /vault-cas/ is truly atomic; every other '
  + 'check runs just before the write, which narrows the window to one round trip rather than '
  + 'closing it.';

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

  let why;
  if (reason === SHARING_REASONS.OPEN_VAULT) {
    why = 'it is listed in `openVaults` (in the config file, or in the registry this session loaded — '
      + 'a hand edit to the file takes full effect on hot-reload or restart), so every workspace on '
      + 'this machine can reach it and its readership is not knowable — the decision treats such a '
      + 'vault as shared by hypothesis';
  } else if (reason === SHARING_REASONS.UNKNOWN) {
    why = 'the router config could not be read just now, so how many workspaces declare this vault '
      + 'is UNKNOWN — and an unknown answer is treated as shared rather than as "nobody". Check '
      + 'that the config file is readable; the requirement lifts by itself as soon as it is';
  } else {
    why = `${workspaces.length} workspaces declare it in your router config (${workspaces.join(', ')}), `
      + 'so another session can be writing the same note right now';
  }

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
 * The BYTES decide whether the file is re-parsed: it is read on every call and
 * parsed again only when the content differs from the last good read. Not
 * `mtime` + `size` — a filesystem with coarse timestamps can hide a same-length
 * replacement inside one tick, and the stat saved a 2 KB read next to an HTTP
 * round trip (Codex round on 23bbbaa). This is a parse cache on the router's
 * own config file, not a security boundary; the write path takes a real lock
 * and re-reads inside it.
 *
 * A failed current read returns null (UNKNOWN). The parse cache survives for
 * reuse after recovery, but a cached single-workspace answer cannot establish
 * that no other workspace attached since the last successful read.
 *
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {(p: string) => string} [opts.readFile]
 * @returns {{ current: () => object|null }}
 */
export function createBindingsReader({ configPath, readFile } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let lastGood = null;
  let lastBytes = null;

  const reader = {
    current() {
      if (!configPath) return lastGood;
      try {
        const bytes = read(configPath);
        // THE BYTES ARE THE IDENTITY, not the metadata. The first version
        // compared `mtimeMs` + `size` and skipped the read when they matched —
        // and both Codex passes found the same hole in it: on a filesystem with
        // coarse timestamps, one process can replace the config with
        // same-length JSON inside a single tick (changing a workspace's vault
        // name for another of equal length is enough), leaving this reader on a
        // stale answer that permits a blind write. The stat was saving a 2 KB
        // read next to an HTTP round trip; correctness is worth more than that.
        // The cache now only avoids re-PARSING unchanged bytes.
        if (bytes === lastBytes) return lastGood;
        const parsed = JSON.parse(bytes);
        // A config that parses to a non-object is not a config. Keeping the
        // previous copy beats adopting `null`/an array and answering "no
        // workspace declares anything" for the rest of the session.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          lastGood = parsed;
          lastBytes = bytes;
        }
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? lastGood : null;
      } catch {
        return null;
      }
    },
  };

  // Prime the parse cache; every subsequent call still requires a fresh read.
  reader.current();
  return reader;
}
