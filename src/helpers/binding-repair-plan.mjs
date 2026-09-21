/**
 * The PLAN of a binding repair — what a `--repair-binding --dry-run` shows,
 * what `--approved-plan-sha256` seals, and what the apply re-derives inside
 * the config lock and compares against.
 *
 * Pure: it is handed a parsed config and a workspace path and returns plain
 * data. No disk, no registry, no terminal.
 *
 * ONE EXCEPTION, AND IT IS DELIBERATE: `today`. The confirmation date the
 * write will stamp has to be IN the plan — sealing a boolean "the metadata
 * differs" let two previews a day apart share one seal, and the write then
 * stamped a date nobody previewed. So the date is a value the plan carries,
 * injectable (pass `today` and this function reads no clock at all, which is
 * how it is tested) and defaulting to the clock for a caller that has no
 * opinion. The consequence to know: two otherwise identical plans on either
 * side of midnight are DIFFERENT plans and do not share a seal. That is
 * correct — the writes differ — and it means a seal does not survive the day
 * it was minted in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SEAL DOES NOT USE `vaultIdentity`
 * ---------------------------------------------------------------------------
 * `plan-seal.mjs` binds a seal to a resolved-vault identity — `{ name, baseUrl }`
 * — because the operations it was written for (delete a file, provision a
 * vault, refresh projections) all act ON a vault, and a preview computed
 * against vault A must never confirm an apply against vault B.
 *
 * A binding repair acts on neither. It acts on a WORKSPACE and on a CONFIG
 * FILE: the vault names inside it are values the plan carries, not the thing
 * the plan is about. Two different workspaces can be repaired to the same
 * primary vault, and the same workspace can be repaired in two different
 * config files (`OBSIDIAN_ROUTER_CONFIG` points at one). Borrowing
 * `vaultIdentity` here would have bound the seal to the wrong axis entirely:
 * a plan previewed for workspace A could be applied to workspace B whenever
 * both chose the same primary. So this operation gets its own identity —
 * `{ workspace, configPath }` — and the vault names stay in the plan, where
 * drift in them is drift in the plan.
 *
 * ---------------------------------------------------------------------------
 * TWO PRECONDITIONS, TWO QUESTIONS
 * ---------------------------------------------------------------------------
 *   - `entryDigest` (`rawEntryDigest`) answers "has this workspace's ENTRY
 *     moved since I looked?". It is the precondition the MCP repair call
 *     already carries as `ifBindingDigest`, and the apply asks it inside the
 *     lock, with its own sentence.
 *   - the SEAL answers "is the plan I approved still the plan that would run?".
 *     It covers what this operation WRITES: the chosen primary, the kept
 *     secondaries and their local tiers, the lock, what is dropped, the alias
 *     entries collapsed and the refusals removed — plus the identity above.
 *
 * NOT "everything the operator read", which is what this comment used to
 * claim and what a review round refuted. The preview also prints the
 * EFFECTIVE write tiers, computed from the config's GLOBAL lists, and those
 * are deliberately outside the seal: this repair writes no global list, so
 * sealing them would refuse an apply because someone edited a rule it does not
 * touch. The display says so in as many words. A seal that covered
 * everything on screen would be a different, and wrong, contract.
 *
 * Neither stands in for the other, and the decision of 2026-09-20 asks for
 * both: an entry can be byte-identical while the plan changes (the config's
 * `disabledVaults` moved, so a name that was bindable no longer is), and the
 * plan can be stable while the entry is replaced by an equivalent one from a
 * sibling session.
 */

import path from 'node:path';
import {
  canonicalWorkspaceKey,
  rawBindingEntry,
  rawEntryDigest,
  bindingIncoherences,
  registryIncoherences,
  normalizeBinding,
  writerBindableNames,
  WORKSPACE_BINDINGS_KEY,
  bindingEntryAliases,
  refusalEntrySpellings,
  readRefusals,
  boundVaults,
  BINDING_INCOHERENCE,
} from './workspace-bindings.mjs';
import { readBindingWriteContext, planBindingWrite, BINDING_WRITE_MODE } from './binding-write.mjs';
import { isPromotionOfLockedSecondaryOnDisk, alsoWriteTierFor } from './vault-reach.mjs';
import { disabledVaultNames, alsoLockedEntries, alsoWritableEntries } from './vault-slug.mjs';

/** The operation tag folded into every seal of this kind. */
export const BINDING_REPAIR_OP = 'repair-binding';

/** The fields `withBinding` writes from the normalised record; everything else is "unknown". */
const KNOWN_ENTRY_FIELDS = new Set([
  'vault', 'also', 'locked', 'confirmedAt', 'confirmedVia', 'alsoLocked', 'alsoWritable',
]);

/**
 * The identity a binding-repair seal is bound to: the WORKSPACE and the CONFIG
 * FILE, not a vault. See the header for why `vaultIdentity` is the wrong axis
 * here.
 *
 * Both are normalised the way their own readers normalise them — the workspace
 * through `canonicalWorkspaceKey` (the same key the entry is stored under), the
 * config path through `path.resolve` — so that a preview and an apply that name
 * the same file two different ways still agree.
 *
 * @param {{ cwd: string, configPath: string }} where
 * @returns {{ workspace: string, configPath: string }}
 */
export function bindingRepairIdentity({ cwd, configPath }) {
  return {
    workspace: canonicalWorkspaceKey(cwd) ?? '',
    configPath: typeof configPath === 'string' && configPath ? path.resolve(configPath) : '',
  };
}

/**
 * The facts a COMMAND judges a binding by: the config file's own, and nothing
 * else.
 *
 * `registryFactsFor` builds the same three sets for a SESSION, where
 * `sessionNames` is the catalogue that session loaded — the set that tells
 * "the file lists it but this session has not loaded it yet" from "nobody
 * registered it". A command-line process loads no vaults at all, so passing it
 * an empty catalogue would make `sessionNames` empty and report EVERY name,
 * however healthy, as "not loaded here" — advice to restart a session that
 * does not exist.
 *
 * "Not loaded here" is a session's fact, and a command has no session. So the
 * file's own bindable set answers both questions: what the next start will
 * read is exactly what this command can see.
 *
 * @param {unknown} cfg
 * @returns {{ bindable: Set<string>, sessionNames: Set<string>, disabled: Set<string> }}
 */
export function fileOnlyBindingFacts(cfg) {
  const bindable = writerBindableNames(cfg, []);
  return { bindable, sessionNames: bindable, disabled: disabledVaultNames(cfg) };
}

/**
 * The repair a `--dry-run` describes and an apply performs.
 *
 * The primary is CHOSEN, never invented: `wantedPrimary` is what the operator
 * asked for; absent that, the entry's own primary is kept when the file can
 * still bind it. An entry that names no usable primary and no `--primary` was
 * given yields `primary: null` and `blocked: 'no-primary'` — the one thing a
 * repair genuinely cannot decide on its own, exactly as
 * `describeBindingRepair` refuses to fill its placeholder.
 *
 * `facts` defaults to the FILE's own (`fileOnlyBindingFacts`), which is the
 * right judge for a command: the file is what the next start reads, and
 * `--link-workspace` already asks the question that way. A caller that DOES
 * have a session catalogue — a future MCP-side preview — passes
 * `registryFactsFor(cfg, registry.vaults)` instead and gets the session's
 * three-way answer.
 *
 * @param {unknown} cfg the parsed router config
 * @param {string} cwd the workspace being repaired
 * @param {object} [options]
 * @param {string|null} [options.wantedPrimary]
 * @param {boolean} [options.locked] tri-state: absent conserves the entry's lock
 * @param {{ bindable: Set<string>, sessionNames: Set<string>, disabled: Set<string> }} [options.facts]
 * @param {string} [options.confirmedVia]
 * @returns {object} the plan, plus the diagnosis a façade prints
 */
export function planBindingRepair(cfg, cwd, {
  wantedPrimary = null,
  locked,
  facts = fileOnlyBindingFacts(cfg),
  confirmedVia = 'repair-binding',
  // THE DATE `withBinding` WOULD STAMP. Injected, this function reads no
  // clock at all — which is how it is tested. Defaulted, it reads one, once.
  // It enters the sealed plan, which means a preview taken at 23:59 and
  // applied at 00:01 refuses — correctly: the write really would differ from
  // the one that was approved.
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const raw = rawBindingEntry(cfg, cwd);
  const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const canonicalKey = canonicalWorkspaceKey(cwd) ?? '';
  const storedBindings = cfg?.[WORKSPACE_BINDINGS_KEY];
  const allBindings = storedBindings && typeof storedBindings === 'object' && !Array.isArray(storedBindings)
    ? storedBindings
    : {};
  // BOTH FAMILIES OF ANOMALY, as every other door that spells a repair reads
  // them: the structural ones (`bindingIncoherences` — a duplicate, a tier
  // without a role, an entry that is not an object) and the registry ones
  // (`registryIncoherences` — a primary the file no longer binds, a disabled
  // secondary). One renderer, the same facts.
  const structural = bindingIncoherences(raw);
  const registryFacts = registryIncoherences(raw, facts);
  const anomalies = [...structural, ...registryFacts];

  const ctx = readBindingWriteContext(cfg, cwd);
  const repaired = ctx.previous;
  const primaryUnbindable = registryFacts.some((f) => f.kind === BINDING_INCOHERENCE.PRIMARY_NOT_REGISTERED
    || f.kind === BINDING_INCOHERENCE.PRIMARY_DISABLED
    || f.kind === BINDING_INCOHERENCE.PRIMARY_NOT_LOADED_HERE);
  // The entry's own primary is kept only when the FILE can still bind it.
  const keptPrimary = repaired && !primaryUnbindable && facts.bindable.has(repaired.vault)
    ? repaired.vault
    : null;
  const primary = wantedPrimary ?? keptPrimary;

  const unknownFields = rawObject
    ? Object.keys(rawObject).filter((k) => !KNOWN_ENTRY_FIELDS.has(k)).sort()
    : [];

  const base = {
    op: BINDING_REPAIR_OP,
    workspace: canonicalWorkspaceKey(cwd) ?? '',
    // THE ENTRY AS WRITTEN, through the same function the MCP precondition
    // uses, on the same value — so a repair prepared here and a repair spelled
    // by a diagnostic speak one language.
    entryDigest: rawEntryDigest(raw),
    hasEntry: raw !== undefined,
    anomalies: anomalies.map((a) => ({ kind: a.kind, names: [...(a.names ?? [])].map(String).sort() })),
    unknownFields,
    // THE REST OF THE WRITE'S FOOTPRINT — what `withBinding` does BESIDES
    // storing the entry, and what a preview that named only the entry was
    // quietly leaving out. Both are real writes by this operation, which is
    // why they ARE sealed (unlike the effective tiers, which are computed and
    // written nowhere).
    //
    // `aliasesCollapsed`: a hand-edited config can hold this one workspace
    // under two spellings; the write deletes every one of them, with whatever
    // vault, tiers, lock and unknown fields the losers carried.
    aliasesCollapsed: bindingEntryAliases(cfg, cwd),
    // THE ENTRY MOVES TO THE CANONICAL KEY when the file holds it under some
    // other spelling: `withBinding` deletes the key it was read from and
    // stores the canonical one. No alias is involved and no content is lost,
    // but the file is not what it was, and a preview reporting "changing
    // nothing" was wrong about it. (Codex, review round 4.)
    relocatesToCanonicalKey: raw !== undefined && !Object.hasOwn(allBindings, canonicalKey),
    // THE METADATA IS NOT CONSERVED, and never was: `confirmedVia` becomes
    // this operation's name and `confirmedAt` becomes today. That is right —
    // a repair IS a fresh confirmation, and `bindingIncoherences` puts
    // metadata outside the conservation claim on purpose — but "right" is not
    // the same as "goes without saying".
    //
    // "DIFFERS", NOT "EXISTS". The first version said `raw !== undefined`,
    // which is whether the metadata gets ASSIGNED, not whether it CHANGES.
    // Repair the same entry twice on one day and the second call assigns the
    // identical `confirmedVia` and `confirmedAt` — `unchangedBindings` then
    // finds the record identical and NO FILE IS WRITTEN — while the preview
    // announced a metadata change and (worse) the "this writes nothing"
    // branch had been deleted as unreachable on the strength of that same
    // wrong predicate. (Codex, review round 5.)
    metadataRewritten: raw !== undefined
      && ((rawObject?.confirmedVia ?? null) !== confirmedVia || (rawObject?.confirmedAt ?? null) !== today),
  };

  // EVERY REASON THE APPLY WOULD REFUSE IS ASKED HERE TOO, and this is not a
  // convenience. A preview that prints a plan and a seal for a repair the
  // apply then turns away hands the operator an approval for something that
  // cannot happen — which is worse than a refusal, because it reads as a
  // green light. The three reasons, in the order the apply asks them:
  //   - no primary this file can bind, and none given;
  //   - a `--primary` the file cannot bind;
  //   - a `--primary` the entry holds as a STRICT read-only secondary.
  const blocked = (kind, reason) => ({
    ...base,
    blocked: kind,
    reason,
    primary: null,
    also: [],
    alsoLocked: [],
    alsoWritable: [],
    locked: false,
    dropped: [],
    lockMovesTo: null,
    keptFromEntry: [],
    promoted: null,
    demoted: null,
    refusalsDropped: [],
    refusalSpellings: [],
    refusalsSurviving: [],
    confirmedAt: today,
    effectiveTiers: [],
  });

  // THERE IS NO ENTRY: THERE IS NOTHING TO REPAIR, and this is asked BEFORE
  // the primary, not inside the branch that handles a missing one. The first
  // version rejected absence only when no primary could be chosen — so
  // `--repair-binding <ws> --primary main` on a workspace with no entry at all
  // sailed past the refusal and CREATED a binding. That is `--attach`'s job,
  // and `--attach` does four other things (the `.env` hint, the plugin
  // settings, the CLAUDE.md block) that a workspace bound this way would never
  // get. A repair repairs; it does not bind. (Codex, review of this lot.)
  if (raw === undefined) {
    return blocked('no-entry', 'this workspace has no binding entry to repair');
  }
  if (!primary) {
    return blocked('no-primary', 'the entry names no primary this config file can bind, and none was given');
  }
  // A NAME THE OPERATOR TYPED IS JUDGED LIKE ANY OTHER. `wantedPrimary` was
  // taken on trust by the first version, so `--primary ghost --dry-run`
  // printed a full plan and a seal for a repair the apply refused one command
  // later. The file is the judge, as it is for `--link-workspace`: it is what
  // the next start reads.
  if (!facts.bindable.has(primary)) {
    return blocked('primary-not-bindable',
      `"${primary}" is not a vault this config file can bind (absent from \`portRegistry\`/\`remoteVaults\`, `
      + 'or named in `disabledVaults`)');
  }
  // A STRICT SECONDARY IS NEVER PROMOTED, whatever the operator typed — the
  // same guard the tools ask, on the same reading (the raw entry when the
  // repaired reading is null, which is precisely the entry a repair is for).
  // Question 4(b) of the decision page stays where it was: refused since round
  // sixteen, and opening a terminal route does not reopen it.
  if (isPromotionOfLockedSecondaryOnDisk(primary, ctx.source, cfg)) {
    return blocked('promotion-refused',
      `"${primary}" is a secondary this workspace holds as LOCKED read-only (alsoLocked), and making it the `
      + 'primary would lift that restriction in one command');
  }

  const plan = planBindingWrite(ctx, {
    // A repair keeps what the entry holds whether or not the call named it —
    // that is the mode the decision asks for, and the reason this lot exists.
    mode: BINDING_WRITE_MODE.REPAIR,
    primary,
    also: [],
    locked,
    confirmedVia,
    // ONE CLOCK READ PER PLAN, CARRIED THROUGH TO THE WRITER. Sealing a
    // BOOLEAN ("the metadata differs") could not tell the 21st from the 22nd:
    // both previews said `true`, the cores matched, the seal passed, and the
    // writer stamped a date the preview never showed. And sealing the date
    // alone would still not be enough while `withBinding` reads its own clock
    // — the two reads can straddle midnight. So the value is resolved here,
    // travels in the sealed core, and is handed to the writer. (Codex, round 6.)
    confirmedAt: today,
  });

  // THE REFUSAL FOOTPRINT, DERIVED ONCE. Three fields describe one event —
  // which refusals are dropped, which spellings the drop collapses, what is
  // written back — and they must agree about WHETHER it happens at all.
  // Derived separately, they disagreed: two were gated on a rebuild and the
  // third was not. (Codex, review round 7.)
  const droppedRefusals = boundVaults(plan.entry).filter((n) => readRefusals(cfg, cwd).has(n));
  const rebuildsRefusals = droppedRefusals.length > 0;

  return {
    ...base,
    blocked: null,
    reason: null,
    primary,
    also: plan.entry.also,
    alsoLocked: plan.entry.alsoLocked,
    alsoWritable: plan.entry.alsoWritable,
    locked: plan.entry.locked,
    // A repair drops nothing by construction; the field is here so the shape
    // is the same on both branches and a façade can read it without a guard.
    dropped: plan.droppedSecondaries,
    lockMovesTo: plan.lockMovesTo,
    keptFromEntry: plan.keptFromEntry,
    // A secondary made primary: still declared, but no longer a secondary, and
    // its local tier goes with the role. Named separately because
    // `droppedSecondaries` deliberately does not count it.
    promoted: plan.promoted,
    // The old primary, kept as a secondary rather than dropped in silence
    // (Roland, 2026-09-21). Sealed like `promoted`: which vault changes role
    // is part of the plan an operator approves.
    //
    // `bindable` IS THE PRECONDITION OF THE MECHANISM THIS COPIES.
    // `lock_vault --persist` carries the old primary down unconditionally —
    // including one the file has dropped or disabled, by the round-13 rule
    // that a name the entry already holds is KEPT — and it NAMES it when this
    // session cannot resolve it (round 15). Copying the carry without the
    // naming would keep a dead declaration and call it a conservation.
    // `disabled` IS TOLD APART FROM `absent`, because their remedies are
    // opposites: registering a name again lifts nothing for a disabled one.
    // Every other diagnostic in this project makes that distinction; this one
    // said "register it" for both. (Codex, review of the demotion.)
    demoted: plan.demoted
      ? {
        ...plan.demoted,
        bindable: facts.bindable.has(plan.demoted.vault),
        disabled: facts.disabled.has(plan.demoted.vault),
      }
      : null,
    // `withBinding` drops a recorded refusal for every vault it binds —
    // adopting is the opposite of refusing. The MCP façade has always named
    // them in its answer; this one did not even know about them. Sealed,
    // because a refusal recorded between the preview and the apply is a write
    // the operator did not approve.
    refusalsDropped: droppedRefusals,
    // AND THE SPELLINGS THAT REMOVAL COLLAPSES. Dropping a refusal does not
    // edit one key: `withoutRefusal` rebuilds this workspace's entry from the
    // UNION and deletes every colliding spelling, so a sibling editing a
    // spelling that loses the union destroys content the selected entry's
    // digest cannot see — the alias defect of round 3, one object over, found
    // by the round that reviewed the repair for it. Carried only when a
    // refusal IS dropped: with none, `withoutRefusal` is identity and nothing
    // is collapsed, so sealing them would refuse an apply for an edit this
    // write does not touch. (Codex, review round 4.)
    refusalSpellings: rebuildsRefusals ? refusalEntrySpellings(cfg, cwd) : [],
    // WHAT SURVIVES THE REBUILD, which is not always "one canonical entry".
    // `withoutRefusal` writes the canonical entry only `if (current.size)`:
    // when the vaults being bound are the ONLY refusals this workspace had,
    // the record is removed outright, and with no other workspace's refusals
    // the top-level property goes too. The preview promised a canonical entry
    // in every case. (Codex, round 6.)
    //
    // BEHIND THE SAME GATE AS THE SPELLINGS, and it was not, for one round.
    // The rule was stated correctly for `refusalSpellings` — seal them only
    // when a rebuild actually happens, or an apply refuses for an edit this
    // write never touches — and the field added beside it, by the repair for
    // the round that found that rule, did not get it: a sibling recording an
    // UNRELATED refusal between preview and apply moved the core and refused
    // a repair whose footprint had not changed at all. A rule is not applied
    // where it is written down; it is applied where it is used. (Codex,
    // review round 7.)
    refusalsSurviving: rebuildsRefusals
      ? [...readRefusals(cfg, cwd).keys()].filter((n) => !boundVaults(plan.entry).includes(n)).sort()
      : [],
    // The date this plan will stamp, so a façade can show it and the seal can
    // cover it.
    confirmedAt: today,
    // The KNOWN fields of the entry, normalised as the writer will normalise
    // them — so a dry-run shows the values that will land on disk and not a
    // hopeful paraphrase of them.
    //
    // NOT the whole stored record: `withBinding` also copies through every
    // field this version does not know, and those are not here. Their NAMES
    // are, in `unknownFields`, and their VALUES are covered by `entryDigest`.
    // The comment used to promise "the entry that will land on disk", which
    // over-promised by exactly those fields. (Codex, round 8.)
    entry: normalizeBinding(plan.entry),
    // WHAT THE REPAIRED BINDING WILL ACTUALLY PERMIT, which the local lists
    // above do not answer on their own: the effective tier of a secondary is
    // decided by the entry's lists AND the config's global ones, strict
    // anywhere winning. An operator reading "alsoLocked: (none)" could
    // reasonably conclude a vault is writable when a global rule holds it
    // strict.
    //
    // DISPLAY ONLY, AND DELIBERATELY OUTSIDE THE SEAL. The seal covers what
    // will be WRITTEN, and this repair writes no global list: sealing the
    // effective tier would refuse an apply because someone edited a global
    // rule the repair does not touch — and would blur the very line this lot
    // exists to hold, between the LOCAL data that is kept and the EFFECTIVE
    // answer that is computed. So it is shown, labelled as of this reading,
    // and not folded into `bindingRepairPlanCore`.
    effectiveTiers: effectiveTiersFor(cfg, plan.entry),
  };
}

/**
 * The tier each secondary of a candidate entry would actually get — the
 * entry's own lists and the config's global ones together, strict anywhere
 * winning. Exactly `alsoWriteTierFor`, asked for the binding about to be
 * written rather than for a live session.
 *
 * @param {unknown} cfg
 * @param {{ vault: string, also: string[], alsoLocked: string[], alsoWritable: string[] }} entry
 * @returns {Array<{ vault: string, tier: string }>}
 */
function effectiveTiersFor(cfg, entry) {
  const registry = {
    workspaceBinding: entry,
    alsoLocked: alsoLockedEntries(cfg),
    alsoWritable: alsoWritableEntries(cfg),
  };
  return (entry.also ?? []).map((name) => ({ vault: name, tier: alsoWriteTierFor(name, registry) }));
}

/**
 * The drift-sensitive CORE of the plan — what the seal covers, and nothing
 * else. Keys sorted by `canonicalize`, so nothing here depends on insertion
 * order.
 *
 * Deliberately EXCLUDES the prose a façade prints, and the EFFECTIVE write
 * tiers, which this repair computes and writes nowhere.
 *
 * Deliberately INCLUDES the confirmation metadata — `confirmedAt` AND
 * `confirmedVia` — as VALUES. This comment used to say the opposite, that
 * `confirmedAt` was excluded "because the clock would make every seal
 * unique"; that was the reasoning, and it was wrong in the way that matters:
 * the write stamps a date, so a seal that does not name it approves a write
 * it has not seen. The cost is real and is the price — a seal does not
 * survive midnight — and the comment now says so instead of describing a
 * decision the code no longer makes.
 *
 * Deliberately INCLUDES the anomalies: an operator approves a repair of the
 * anomalies they were shown, and a plan whose anomaly set changed is a
 * different plan even when its outcome happens to coincide.
 *
 * @param {object} plan from `planBindingRepair`
 * @returns {object}
 */
export function bindingRepairPlanCore(plan) {
  const p = plan || {};
  return {
    op: BINDING_REPAIR_OP,
    workspace: p.workspace ?? '',
    entryDigest: p.entryDigest ?? null,
    hasEntry: Boolean(p.hasEntry),
    blocked: p.blocked ?? null,
    primary: p.primary ?? null,
    also: [...(p.also ?? [])].map(String),
    alsoLocked: [...(p.alsoLocked ?? [])].map(String),
    alsoWritable: [...(p.alsoWritable ?? [])].map(String),
    locked: Boolean(p.locked),
    dropped: [...(p.dropped ?? [])].map(String),
    lockMovesTo: p.lockMovesTo ?? null,
    promoted: p.promoted ?? null,
    demoted: p.demoted ?? null,
    unknownFields: [...(p.unknownFields ?? [])].map(String),
    // The rest of the write's footprint. Sealed because this operation WRITES
    // them: a sibling that adds an alias entry, EDITS one, or records a
    // refusal between the preview and the apply changes what the apply
    // destroys. The per-alias digest is what catches the edit — the key alone
    // caught only the addition.
    aliasesCollapsed: (p.aliasesCollapsed ?? []).map((a) => ({ key: String(a.key), digest: String(a.digest) })),
    refusalsDropped: [...(p.refusalsDropped ?? [])].map(String),
    refusalSpellings: (p.refusalSpellings ?? []).map((a) => ({ key: String(a.key), digest: String(a.digest) })),
    refusalsSurviving: [...(p.refusalsSurviving ?? [])].map(String),
    relocatesToCanonicalKey: Boolean(p.relocatesToCanonicalKey),
    metadataRewritten: Boolean(p.metadataRewritten),
    // THE VALUES, not the boolean beside them. A boolean cannot tell one date
    // from another, so two previews a day apart produced identical cores and
    // one seal approved the other's write (round 6). `confirmedVia` is the
    // same shape of hole one field over: the planner takes it as an option,
    // two plans differing only in it sealed identically, and only the CLI's
    // hard-coded value kept that from being an approval bypass today. A
    // helper whose contract holds by virtue of its one caller has no
    // contract. (Codex, round 7.)
    confirmedAt: p.confirmedAt ?? null,
    confirmedVia: p.entry?.confirmedVia ?? null,
    anomalies: (p.anomalies ?? []).map((a) => ({ kind: String(a.kind), names: [...(a.names ?? [])].map(String) })),
  };
}
