/**
 * The binding WRITE TRANSFORM — what a writer computes, inside the config
 * lock, between "here is the file" and "here is the entry to store".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A CLOSURE INSIDE ONE TOOL
 * ---------------------------------------------------------------------------
 * The accepted decision `politique-desactive-et-reparation-des-liaisons`
 * (Roland, 2026-09-20) asks for the promise "a repair loses nothing" to stop
 * being a property of the SENTENCE the diagnostic writes and become a property
 * of the CODE. Until this module, `describeBindingRepair` spelled a call that
 * named everything worth keeping — every secondary, every local tier, and
 * `locked: true` — and the guarantee held for exactly as long as the caller
 * copied that sentence verbatim. A caller who assembled its own call lost
 * whatever it forgot, in silence.
 *
 * The same decision opens a command-line route to a repair (`4a`, `5`). Two
 * façades, one transformation: if the sharing covered only the MESSAGES and
 * not the transformation, the lot would have rebuilt the very defect it exists
 * to close.
 *
 * ---------------------------------------------------------------------------
 * THE TWO MODES
 * ---------------------------------------------------------------------------
 *   - `replace` — the behaviour `confirm_workspace_binding` has always had:
 *     the call names the binding, and a secondary not named again is gone. The
 *     decision explicitly declined to break this general API (Q4: no
 *     `dropSecondaries` obligation on every writer).
 *   - `repair` — the call declares itself a repair, and the entry's own
 *     secondaries, their LOCAL tiers, its lock and its unknown fields are kept
 *     whether or not the caller thought to name them.
 *
 * ---------------------------------------------------------------------------
 * TWO PROPERTIES THIS FILE OWES A COMMENT, BECAUSE BOTH ARE COUNTER-INTUITIVE
 * ---------------------------------------------------------------------------
 * 1. WHAT IS KEPT IS THE ENTRY'S **LOCAL** DATA, NEVER THE **EFFECTIVE** TIER.
 *    A secondary's effective write tier is computed at read time from the
 *    binding's own lists AND the config's global `alsoLocked`/`alsoWritable`
 *    (see `alsoWriteTierFor`): strict anywhere wins. If a writer resolved that
 *    effective tier and froze it into the entry, a vault that was strict only
 *    because of a GLOBAL rule would stay strict in this workspace after that
 *    rule was deleted — a new local restriction, created by a repair. So
 *    `keep()` below filters the entry's own lists and nothing else. The
 *    effective answer is computed, announced, and never stored.
 *
 * 2. KEEPING `locked: true` WHILE CHANGING PRIMARY **MOVES** THE LOCK. A lock
 *    is not a flag on the workspace, it is a lock onto one vault: every other
 *    vault stops answering. An entry that names no primary but carries
 *    `locked: true` therefore cannot have its lock "kept" in place — repairing
 *    it necessarily points the lock at whichever primary the repair chooses.
 *    That is the right outcome (dropping the lock would silently reopen the
 *    fleet), but it is a displacement and `lockMovesTo` names it so a façade
 *    can say so rather than reporting a carried boolean.
 *
 * Nothing here reads the disk, the environment or a registry: this module is
 * given the parsed config the caller re-read inside its lock and it returns
 * plain data.
 *
 * THE CLOCK IS THE ONE EXCEPTION, and only on one path. `planBindingWrite` is
 * clock-free without qualification. `applyBindingWrite` calls `withBinding`,
 * which stamps `new Date()` when the entry it is given carries no
 * `confirmedAt` — the MCP tool's case, and right for it, because a tool has no
 * preview to agree with. A two-phase caller passes the date (see the
 * `confirmedAt` option), and then no clock is read on that path either. The
 * header used to claim the module read no clock at all, which was true of the
 * function under it and false of the one exported beside it. (Codex, round 8.)
 */

import {
  readBinding,
  rawBindingEntry,
  rawSecondaryTiers,
  withBinding,
} from './workspace-bindings.mjs';

/**
 * WHAT A WRITE TO THE CONFIG FILE DOES TO A SESSION THAT IS ALREADY RUNNING —
 * one sentence, exported, because three readers were saying three things.
 *
 * The router WATCHES its config directory (`fs.watch`, src/index.mjs) and
 * rebuilds its registry on a change, unless it was started with `--no-watch`.
 * So any claim that a running session will not see the change until someone
 * restarts it is false as a RULE — a watching router may well pick it up —
 * and a command that states it flatly has told the operator their change would
 * wait when it may not. The opposite statement would be just as wrong: a
 * reload that throws keeps the previous registry, so sometimes it does wait.
 * Neither certainty is available, which is why the note below offers neither.
 * (That claim is not
 * reproduced verbatim anywhere, not even here to be denied: the test that
 * keeps it from coming back is a SCAN of these sources, and a scan cannot
 * tell a quotation from a relapse without an exemption — and an exemption is
 * how a scan comes to pass while the thing it hunts is still in the file.)
 *
 * That sentence was corrected inside `LOCK_VOICE.stored` and left standing in
 * the command's preview, in the command's recap and in this file's own `voice`
 * documentation — a repair that reached one of four readers and was announced
 * for all, which is the defect this repository keeps rediscovering and which
 * this very lot was written to close. Denominator now: one definition, and
 * every reader quotes it. (Codex, review round 4.)
 */
// EVERY CLAUSE IS WHAT THE WATCHER ACTUALLY DOES, not what would be reassuring
// to say. The first version promised a prompt reload, which the
// implementation does not owe: the handler DEBOUNCES by 500 ms, so a stream of
// changes arriving faster than that keeps postponing it; a rebuild that throws
// is caught and the PREVIOUS registry is kept; and watching is skipped under
// `--no-watch`, abandoned on a watcher error, and never started if the
// directory cannot be watched. So the note says "attempts", and names the two
// ways the attempt does not land. (Codex, review round 5.)
export const RUNNING_SESSION_NOTE =
  'With config watching on (the default) the router ATTEMPTS a reload once the changes settle, so a '
  + 'session already running may pick this up without being restarted — but a reload that fails keeps the '
  + 'previous state, and watching can be off (--no-watch) or have been abandoned after an error. Restart '
  + 'the session if you need to be sure it is in force.';

/** The two modes, named once so a façade cannot invent a third by typo. */
export const BINDING_WRITE_MODE = Object.freeze({
  REPLACE: 'replace',
  REPAIR: 'repair',
});

/**
 * Everything a writer needs to know about the entry it is about to replace,
 * read ONCE from the config it holds under the lock.
 *
 * `source` is the heart of it. The repaired reading (`previous`) is what the
 * router routes by, and it is `null` for an entry that names no usable primary
 * — which is precisely the entry a repair is FOR. Round 10 taught the tiers to
 * fall back to the entry as written when that happens; the lock never learned
 * the same lesson, and that is the defect this lot closes. One `source`, asked
 * by both questions, so they cannot drift apart again.
 *
 * The raw fallback carries `vault: null` deliberately: no name is invented. A
 * sentinel would be a string some vault can be called, and round 11 measured
 * what that costs — an entry holding a secondary of the sentinel's name lost
 * it, and a strict secondary of that name stopped being a secondary before the
 * promotion guard could ask about it.
 *
 * @param {unknown} cfg the parsed router config, as re-read inside the lock
 * @param {string} cwd the workspace being written
 * @returns {{ previous: object|null, rawPrevious: unknown, rawTiers: object|null,
 *   rawAsBinding: object|null, source: object|null }}
 */
export function readBindingWriteContext(cfg, cwd) {
  const previous = readBinding(cfg, cwd);
  const rawPrevious = rawBindingEntry(cfg, cwd);
  // Only consulted when the repaired reading is null: when there IS a binding,
  // the binding is the entry, read through the one boundary that typechecks it.
  const rawTiers = previous ? null : rawSecondaryTiers(rawPrevious);
  // `rawTiers` is non-null only for a non-array object, so reading `.locked`
  // off `rawPrevious` here is safe without a second shape check.
  const rawAsBinding = rawTiers
    ? { vault: null, ...rawTiers, locked: rawPrevious.locked === true }
    : null;
  return { previous, rawPrevious, rawTiers, rawAsBinding, source: previous ?? rawAsBinding };
}

/**
 * The entry to write, and the facts a façade needs to describe what it did.
 *
 * @param {{ previous: object|null, source: object|null }} ctx from `readBindingWriteContext`
 * @param {object} options
 * @param {string} options.mode one of `BINDING_WRITE_MODE`
 * @param {string} options.primary the vault this workspace is being bound to
 * @param {string[]} options.also the secondaries the CALL names
 * @param {boolean} [options.locked] tri-state: absent keeps what the entry holds
 * @param {string} options.confirmedVia how the binding got there, for the human who reads the file
 * @param {string} [options.confirmedAt] the date to stamp. ABSENT lets
 *   `withBinding` read the clock itself, which is what the MCP tool has always
 *   done and stays right for it: there is no preview to agree with.
 *   A two-phase caller MUST pass it. Its plan is approved by a seal, and a
 *   seal that does not cover the stamped date lets an apply write a date the
 *   preview never described — and even sealing the date is not enough while
 *   the WRITER reads its own clock, because the two reads can straddle
 *   midnight. One clock read per plan, carried through. (Codex, round 6.)
 * @returns {{ entry: object, also: string[], keptFromEntry: string[],
 *   droppedSecondaries: string[], lockedFrom: string, lockMovesTo: string|null }}
 */
export function planBindingWrite(ctx, { mode, primary, also = [], locked, confirmedVia, confirmedAt } = {}) {
  if (mode !== BINDING_WRITE_MODE.REPLACE && mode !== BINDING_WRITE_MODE.REPAIR) {
    throw new TypeError(`planBindingWrite: unknown mode "${String(mode)}" (expected "replace" or "repair").`);
  }
  if (typeof primary !== 'string' || primary.trim() === '') {
    throw new TypeError('planBindingWrite: `primary` must be a non-empty vault name.');
  }
  // A DATE THAT IS SUPPLIED MUST BE USABLE. Absent means "let `withBinding`
  // stamp today", which is a real choice; an EMPTY OR MALFORMED value is not a
  // choice, and the first version silently treated it as absence — so a
  // two-phase caller could seal `confirmedAt: ''`, the writer would fall back
  // to its own clock, and the approved plan named a date the write did not
  // use. A silent degradation to the clock is exactly the hole the sealed date
  // was added to close. (Codex, round 8.)
  if (confirmedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(confirmedAt))) {
    throw new TypeError(
      'planBindingWrite: `confirmedAt`, when given, must be a YYYY-MM-DD date — omit it to let the writer '
      + 'stamp today, but do not pass an empty or malformed one, which would silently become that.',
    );
  }
  const source = ctx?.source ?? null;
  const requested = (Array.isArray(also) ? also : []).filter((n) => typeof n === 'string' && n !== primary);
  const entryAlso = (Array.isArray(source?.also) ? source.also : []).filter((n) => n !== primary);

  // REPAIR KEEPS WHAT THE ENTRY HOLDS, whether or not the call named it. That
  // is the whole difference between the two modes, and the reason the
  // guarantee no longer depends on a caller copying a sentence.
  const written = mode === BINDING_WRITE_MODE.REPAIR
    ? [...new Set([...requested, ...entryAlso])]
    : [...new Set(requested)];

  // THE ENTRY'S OWN LISTS, filtered to the vaults that are still secondaries
  // after this call — never the config's global lists. See property 1 at the
  // top of this file for what freezing a global tier here would cost.
  const keep = (list) => (source && Array.isArray(list) ? list.filter((n) => written.includes(n)) : []);

  // THE LOCK IS CONSERVED DIFFERENTLY BY THE TWO MODES, and the difference is
  // the whole reason `repair` exists as a mode rather than a label.
  //
  //   - `replace` keeps a lock only for the SAME primary (a lock belongs to
  //     the vault it names, and re-pointing the workspace elsewhere without
  //     saying `locked` must not lock the new one), plus the `?? raw` this lot
  //     added: `source.vault === null` is the entry that names no primary, the
  //     case the repaired reading cannot see at all.
  //
  //   - `repair` keeps it FULL STOP. The first version of this function gave
  //     repair the replace rule, and a review round measured what that cost:
  //     an entry `{ vault: "old", locked: true }` whose primary the config no
  //     longer binds reads back FINE through `normalizeBinding` — `previous`
  //     is not null, its vault is simply unbindable — so repairing it to a new
  //     primary took the `source.vault === primary` branch, found false, and
  //     dropped the lock in silence, under a preview that promised in writing
  //     not to. The lot's own defect, one case over from the one it fixed:
  //     the missing-primary entry was repaired and announced for all entries.
  //     A repair keeps what the entry holds; where that lock LANDS is a
  //     displacement, and `lockMovesTo` below is what says so.
  const isRepair = mode === BINDING_WRITE_MODE.REPAIR;
  const carried = Boolean(source?.locked)
    && (isRepair || source.vault === null || source.vault === primary);
  const lockedOut = typeof locked === 'boolean' ? locked : carried;

  const previousPrimary = ctx?.previous ? ctx.previous.vault : null;
  // A SECONDARY MADE PRIMARY IS A LOSS THE CONSERVATION SENTENCE HID. It
  // leaves `also` and its local tier goes with it — a tier qualifies a
  // SECONDARY role, and the vault no longer has one (it is read-write as a
  // primary, which is why this is allowed at all for a soft or writable one;
  // a strict one is refused outright by the promotion guard).
  //
  // `droppedSecondaries` cannot report it, and that is not an oversight to
  // fix there: `entryAlso` excludes the new primary before the losses are
  // computed, deliberately, because "dropped" means "no longer declared" and
  // this vault is still very much declared — as the primary. So it is its own
  // fact, and a façade that promises to drop no secondary and no tier has to
  // say this one out loud. (Codex, review round 3.)
  const wasSecondary = Array.isArray(source?.also) && source.also.includes(primary);
  const promoted = wasSecondary
    ? {
      vault: primary,
      tier: source.alsoLocked?.includes(primary)
        ? 'locked'
        : (source.alsoWritable?.includes(primary) ? 'writable' : 'soft'),
    }
    : null;
  return {
    entry: {
      vault: primary,
      also: written,
      locked: lockedOut,
      confirmedVia,
      // Absent stays absent, so `withBinding` keeps its own behaviour for the
      // caller that has no preview to agree with. Anything else has already
      // been refused above — there is no falsy-means-absent path left.
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
      alsoLocked: keep(source?.alsoLocked),
      alsoWritable: keep(source?.alsoWritable),
    },
    also: written,
    keptFromEntry: entryAlso.filter((n) => written.includes(n)),
    droppedSecondaries: entryAlso.filter((n) => !written.includes(n)),
    promoted,
    lockedFrom: typeof locked === 'boolean' ? 'argument' : (carried ? (ctx?.previous ? 'binding' : 'rawEntry') : 'none'),
    // Property 2: a lock that was recorded, is kept, and now names a vault
    // other than the one it named before — including the case where the entry
    // named no primary at all, so the lock had nothing to name.
    lockMovesTo: lockedOut && source?.locked === true && previousPrimary !== primary ? primary : null,
  };
}

/**
 * The transform a writer hands to `updateConfigBindings`: the guards in the
 * order seventeen rounds of review settled on, then the plan, then the write.
 *
 * THE ORDER IS THE CONTRACT, and it is why this function exists rather than
 * each façade calling `planBindingWrite` after its own preamble. Each step was
 * put where it is by a measured failure:
 *
 *   1. `precondition` — the entry digest. Asked FIRST, because
 *      `assertNames` exempts a secondary the entry holds: when a sibling
 *      removes that secondary between the diagnostic and the repair, the name
 *      stops being "kept" and, asked first, the writer refused it as "not a
 *      registered vault … register it first" for what was simply a stale
 *      repair. (Round 14, S9.)
 *   2. `guardPromotion` — a secondary held as strict read-only never becomes
 *      the primary through one call. Asked of the FILE, and of the raw entry
 *      when the repaired reading is null (round 11).
 *   3. `reresolve` — the acceptance of a proposal, re-derived against the file.
 *      Absent for a façade that has no proposals to accept.
 *   4. `assertNames` — the names come LAST, so that a primary a sibling
 *      dropped between the preflight and this lock is diagnosed by the steps
 *      above rather than answered with registration advice. (Round 15, S13.)
 *
 * Each guard THROWS to refuse; none returns a value that decides anything.
 * The sentences belong to the façades — a CLI refusal names a flag, a tool
 * refusal names a call — but the sequence belongs here.
 *
 * @param {unknown} cfg the parsed config, inside the lock
 * @param {string} cwd
 * @param {object} options passed to `planBindingWrite`
 * @param {object} [guards]
 * @param {(ctx: object) => void} [guards.precondition]
 * @param {(ctx: object) => void} [guards.guardPromotion]
 * @param {(ctx: object) => void} [guards.reresolve]
 * @param {(cfg: unknown, ctx: object) => void} [guards.assertNames]
 * @param {(plan: object, ctx: object) => void} [guards.onPlan] observer, for a
 *   façade that needs the plan's facts outside the lock; never decides.
 * @returns {unknown} the next config
 */
export function applyBindingWrite(cfg, cwd, options, guards = {}) {
  const ctx = readBindingWriteContext(cfg, cwd);
  if (guards.precondition) guards.precondition(ctx);
  if (guards.guardPromotion) guards.guardPromotion(ctx);
  if (guards.reresolve) guards.reresolve(ctx);
  if (guards.assertNames) guards.assertNames(cfg, ctx);
  const plan = planBindingWrite(ctx, options);
  if (guards.onPlan) guards.onPlan(plan, ctx);
  return withBinding(cfg, cwd, plan.entry);
}

/**
 * The two consequences a façade must state rather than imply, as sentences.
 * Both are counter-intuitive enough that a reader who is not told gets them
 * backwards — see properties 1 and 2 at the top of this file, and the fact the
 * decision page records about removals.
 *
 * Returns an array of sentences (possibly empty), so a caller can join them
 * into whatever it prints.
 *
 * @param {{ lockMovesTo: string|null, droppedSecondaries: string[] }} plan
 * @param {(s: string) => string} quote how the façade renders a vault name
 *   (sanitised for a terminal, or quoted for a tool message)
 * @param {{ unlockHint?: string, voice?: string }} [opts]
 *   `unlockHint`: how THIS façade is told not to lock — a tool argument or a
 *   command-line flag. The remedy has to name the thing the reader can
 *   actually type: telling a terminal operator to "pass `locked: false`" names
 *   an argument no command of theirs has.
 *
 *   `voice`: WHEN what is described takes effect, and this is not decoration.
 *   The one sentence used to say "the session is now locked to X, and no other
 *   vault answers" for all three readers. It is true of the MCP tool, which
 *   adopts the routing in the live registry on the spot. It is false of a
 *   command-line APPLY, which writes a FILE — a different thing, on a
 *   different clock (see `RUNNING_SESSION_NOTE`). And it is false twice over
 *   of a DRY-RUN, which has written nothing at all. A preview that narrates an
 *   accomplished fact is the worst of the three.
 *     - `live`    (default) the tool: this session's routing has changed.
 *     - `stored`  a command-line apply: the file records it, and what a
 *                 running session does about that is `RUNNING_SESSION_NOTE`.
 *     - `planned` a dry-run: nothing has happened yet.
 * @returns {string[]}
 */
// NULL PROTOTYPE, and the reason is the same one `plan-seal.mjs` gives for its
// canonicaliser's accumulator. A plain object literal INHERITS from
// Object.prototype, so a lookup by an inherited name finds something:
// `VOICE['toString']` is a function and is not nullish, so `?? VOICE.live`
// never fires and the sentence renders "[object Undefined]";
// `VOICE['__proto__']` is an object, not a function, and throws. Every caller
// today passes a literal, so this is a contract defect rather than a live bug
// — which is exactly the kind that waits for a fourth caller. (Codex, review
// round 3.)
const nullProto = (obj) => Object.freeze(Object.assign(Object.create(null), obj));

const LOCK_VOICE = nullProto({
  live: (v) => `the session is now locked to ${v}, and no other vault answers while it holds`,
  // NOT "until it is restarted", which was an unjustified promise: the router
  // WATCHES its config by default. The one definition of what that means for
  // a running session is `RUNNING_SESSION_NOTE`, quoted rather than
  // paraphrased — a paraphrase is how the four readers came to disagree.
  stored: (v) => `the binding now RECORDS a lock on ${v}, so no other vault answers a session that loads it. `
    + RUNNING_SESSION_NOTE,
  planned: (v) => `the binding WOULD record a lock on ${v}, so no other vault would answer a session that `
    + 'loads it (nothing has been written yet)',
});
const BECOME_VOICE = nullProto({
  live: 'is now',
  stored: 'is now, in the stored binding,',
  planned: 'WOULD become',
});
const DROP_VOICE = nullProto({
  live: 'Dropped from this workspace\'s secondaries',
  stored: 'Dropped from this workspace\'s secondaries',
  planned: 'WOULD be dropped from this workspace\'s secondaries',
});

export function describeBindingWriteEffects(
  plan,
  quote = (s) => `"${s}"`,
  { unlockHint = 'pass `locked: false`', voice = 'live' } = {},
) {
  const say = LOCK_VOICE[voice] ?? LOCK_VOICE.live;
  const dropped = DROP_VOICE[voice] ?? DROP_VOICE.live;
  const become = () => BECOME_VOICE[voice] ?? BECOME_VOICE.live;
  const out = [];
  if (plan?.promoted) {
    // The loss `droppedSecondaries` deliberately does not report, said here
    // rather than hidden behind "a repair keeps what the entry holds".
    //
    // AND IT SPEAKS IN THE SAME TENSE AS THE REST. This sentence was added by
    // the round that reviewed the VOICE repair, and it walked straight past
    // it: "is now its PRIMARY" under `planned`, where nothing has been
    // written. A new sentence inherits a rule only if someone gives it one.
    // (Codex, review round 4.)
    out.push(
      `${quote(plan.promoted.vault)} was a SECONDARY of this workspace and ${become(plan.promoted.vault)} its `
      + `PRIMARY. It leaves \`also\`, and the ${plan.promoted.tier} tier RECORDED ON THIS BINDING leaves with `
      + 'it — a tier qualifies a secondary role, and a primary is read-write. Re-declaring it as a secondary '
      + 'later brings back no tier of its own unless set_secondary_vault_mode sets one again; a GLOBAL '
      + 'alsoLocked/alsoWritable rule naming it is untouched by any of this and applies again the moment it '
      + 'is a secondary.',
    );
  }
  if (plan?.lockMovesTo) {
    out.push(
      `The lock this entry recorded is KEPT, and keeping it MOVES it: ${say(quote(plan.lockMovesTo))} — not `
      + `the vault the lock named before, and not the secondaries this binding declares. If that is not what `
      + `you want, ${unlockHint}.`,
    );
  }
  if (plan?.droppedSecondaries?.length) {
    // THE COUNTER-INTUITIVE HALF, and the reason this sentence is not "access
    // reduced". `alsoWriteTierFor` returns null the moment a name is no longer
    // in `also` — BEFORE it consults the config's global lists — and
    // `assertVaultWritable` lets a null tier write. So a vault held as strict
    // read-only, dropped from `also` but still reachable another way
    // (`openVaults`, or `vaultReach` inactive), comes out WRITABLE.
    out.push(
      `${dropped}: ${plan.droppedSecondaries.map(quote).join(', ')}. `
      + 'Removing a declaration is not the same as reducing an access: a write tier only applies to a vault '
      + 'this binding declares, so a vault that stays reachable by another route (openVaults, or vaultReach '
      + 'inactive) becomes WRITABLE once it is no longer a secondary here — including one that was held as '
      + 'strict read-only. Re-declare it, or check `disabledVaults`/`openVaults`, if that is not what you want.',
    );
  }
  return out;
}
