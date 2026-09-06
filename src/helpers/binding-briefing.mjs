/**
 * binding-briefing.mjs — the few lines a session opens with: what this
 * workspace is attached to, and how to change it.
 *
 * ---------------------------------------------------------------------------
 * WHY A BRIEFING AT ALL
 * ---------------------------------------------------------------------------
 * The accepted decision `liaison-workspace-vault-hors-depot` moves the
 * workspace→vault binding out of the project's dotenv file and into the user's
 * own config. That fixes WHO decides, but it creates a second problem
 * immediately: a binding that lives in a file nobody opens is a decision the
 * user cannot see. Roland's requirement, 2026-09-03, is the answer — every
 * session starts by saying which vault(s) this workspace is attached to, that
 * the attachment can be changed, what the enrichment mode is and what its
 * range is, and how to list every vault.
 *
 * It is also what makes the migration (the next phase) defensible. Importing
 * existing dotenv hints as confirmed bindings would be an act of trust in
 * project files — which is the very thing this decision removes — were it not
 * for this: an import that got it wrong ANNOUNCES ITSELF at the start of every
 * session, so it is corrected in one sentence instead of quietly deciding
 * where a year of notes get written.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPOSITION IS PURE, AND SEPARATE FROM THE HOOK
 * ---------------------------------------------------------------------------
 * The hook that prints this reads a config, a dotenv file and an environment;
 * none of that can be exercised exhaustively. The wording, on the other hand,
 * is where the rules live — three attachment states and not two, silence when
 * there is nothing to say, a hint reported as REFUSED rather than as the
 * source of anything — and those are exactly the things a test must be able to
 * pin. So this file decides every word and touches nothing; the hook gathers
 * the facts and prints what comes back.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET IS PART OF THE SPECIFICATION
 * ---------------------------------------------------------------------------
 * Four SessionStart hooks already write into Claude's context, and this is the
 * fifth. Every line costs tokens in every session of every project, forever.
 * The target is a few lines, not a paragraph per item: the success criterion
 * is that someone who has never read it understands, in one reading, what they
 * are attached to and how to change it. `MAX_LINES` is that budget made
 * checkable — a test asserts it, so a later addition has to argue with a red
 * test rather than slip in.
 *
 * No imports beyond two dependency-free local helpers: this module is loaded
 * by a hook, and hooks must work on a checkout that has never seen
 * `npm install`.
 */

import { safeForMessage } from './sanitize.mjs';
import { HINT_STATUS, hintIsWorthSignalling } from './workspace-bindings.mjs';

/**
 * The line Claude and the user recognise the block by. Same shape as the other
 * hooks' markers, so a reader scanning a session's opening context can tell
 * the five blocks apart.
 */
export const BRIEFING_MARKER = 'WORKSPACE_VAULT_BRIEFING';

/**
 * The line budget, marker included. Not a formatting preference: see the
 * header. A test pins it.
 */
export const MAX_LINES = 7;

/** The default mode, matching `set_auto_enrich_mode` — Claude proposes, the user confirms. */
const DEFAULT_MODE = 'ClaudeAsk';

/**
 * Which of the THREE attachment states this workspace is in.
 *
 * The distinction Roland asked for, 2026-09-03, and the reason `also` exists
 * in the registry at all: "one vault" and "all vaults" are not the whole
 * story, and a briefing that offered only those two would misdescribe a
 * workspace bound to a primary plus secondaries.
 *
 * `null` is ALL, never "no vault" — the absence of a binding means every
 * registered vault stays addressable and the cascade picks the default.
 *
 * @param {{ vault: string, also: string[] }|null} binding
 * @returns {'all'|'one'|'several'}
 */
export function attachmentState(binding) {
  if (!binding || typeof binding.vault !== 'string' || !binding.vault) return 'all';
  return Array.isArray(binding.also) && binding.also.length > 0 ? 'several' : 'one';
}

/** Quote a name that came from a config file or a dotenv line, safely. */
function q(name) {
  return `"${safeForMessage(String(name), 80)}"`;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function joinNames(names) {
  const quoted = names.map(q);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The attachment sentence — the one line the whole briefing exists for.
 *
 * @param {{ vault: string, also: string[], locked: boolean }|null} binding
 */
function attachmentLine(binding, isRegistered) {
  const state = attachmentState(binding);
  // A BINDING TO A VAULT THIS MACHINE NO LONGER HAS is said as such, not as
  // "bound to X". The cascade falls through such a binding gracefully; a
  // briefing that announced it as in force would be the one place in the
  // system still asserting it. Round 2 of the Codex review, 2026-09-03.
  if (state !== 'all' && typeof isRegistered === 'function' && !isRegistered(binding.vault)) {
    return `This workspace is bound to the vault ${q(binding.vault)}, which is not registered on this `
      + 'machine any more — the binding is ignored until you register it again or clear it with '
      + 'confirm_workspace_binding({ clear: true }).';
  }
  if (state === 'all') {
    // Deliberately names NEITHER the default vault nor how many there are.
    // Both answers belong to the registry: resolving the default runs a
    // cascade that pings vaults, and counting them means merging three
    // sources (portRegistry, remoteVaults, VAULT_* environment entries) minus
    // what `disabledVaults` hides. A hook that re-implemented either would be
    // wrong precisely where it matters — a census that is quietly short reads
    // as authoritative, and a guessed default is wrong exactly when a vault is
    // closed. `list_vaults` answers both, and the last line points there.
    return 'This workspace is bound to no vault in particular: every registered vault is '
      + "available, and list_vaults names this session's default.";
  }
  const locked = binding.locked ? ', and locked to it — no other vault answers' : '';
  if (state === 'one') {
    return `This workspace is bound to the vault ${q(binding.vault)}${locked}.`;
  }
  // LOCKED AND SEVERAL is the state `lock_vault --persist` produces on a
  // workspace with secondaries, and "no other vault answers, with X also
  // addressable by name" contradicted itself in one sentence. The guard is the
  // truth: secondaries stay bound, and answer again once the lock is lifted.
  // (Sixth review, 2026-09-04.)
  if (binding.locked) {
    return `This workspace is bound to the vault ${q(binding.vault)}${locked} while the lock holds; `
      + `${joinNames(binding.also)} ${binding.also.length > 1 ? 'stay' : 'stays'} bound and `
      + 'addressable by name again once it is lifted.';
  }
  return `This workspace is bound to the vault ${q(binding.vault)}, `
    + `with ${joinNames(binding.also)} also bound and addressable by name.`;
}

/**
 * The hint sentence, or null when there is nothing to report.
 *
 * A hint is NEVER the source of what is in force — it is reported as something
 * the file asked for and did not get. That is v0.89.0's rule ("a refused value
 * is not the source of what replaced it") applied one setting over, and it is
 * why this is its own sentence rather than a qualifier on the line above.
 *
 * The sentence names WHO proposed, from the hint's own `origin`, and never
 * guesses. "Your project's .env asked for this" is a useful thing to be told
 * and a bad thing to be told wrongly: the user goes and looks for a line that
 * is not there, in a file that is innocent, while the setting that actually
 * did it — their own MCP host declaration — goes unmentioned.
 *
 * EVERY signalled proposal names the way to say NO. Until the decision
 * `refus-d-une-proposition-de-liaison` there was none: a proposal the user did
 * not want was re-announced at every session, forever, because the router had
 * nowhere to write that the question had been answered. `refused` is silence
 * (`hintIsWorthSignalling`), so this line is the one place the refusal has to
 * be offered — and it is offered for all three signalled statuses, not only
 * for `unconfirmed`, because "the binding wins" and "not registered here" are
 * both still a sentence repeated at every start.
 *
 * `previouslyRefused` is the reinstall case: the workspace file itself says
 * this very proposal was refused here before, and the config that silenced it
 * is gone. The question is asked once more, WITH that context — which is the
 * whole reason the refusal is written into the file at all.
 *
 * @param {{ status: string, hint: string|null, origin: string|null, previouslyRefused?: boolean }|null} hint
 */
function hintLine(hint) {
  if (!hint || !hintIsWorthSignalling(hint)) return null;
  const name = q(hint.hint);
  const who = hint.origin === 'workspace-dotenv'
    ? "This project's .env"
    : (hint.origin === 'host' ? 'The environment this router was started in' : 'The environment');
  // "NO REFUSAL of it is recorded", not "no answer": with `conflicts` the
  // config does hold an answer for this workspace — a binding to another
  // vault — and the first wording contradicted the line above it. (Fable
  // round on 7efbad1, found twice over.)
  const before = hint.previouslyRefused === true
    ? ' A refusal of it was recorded here before (the file carries OBSIDIAN_ROUTER_REFUSED_VAULT), '
      + 'but no refusal of it is recorded in your own router config, so you are asked once more.'
    : '';
  const refuse = `confirm_workspace_binding({ refuse: ${name} })`;
  if (hint.status === HINT_STATUS.UNKNOWN_VAULT) {
    return `${who} proposes the vault ${name}, which is not registered on this machine; `
      + `it was not applied.${before} Refuse it with ${refuse} and this notice stops.`;
  }
  if (hint.status === HINT_STATUS.CONFLICTS) {
    return `${who} proposes ${name} instead; the binding above wins and the proposal was `
      + `not applied.${before} Refuse it with ${refuse} and this notice stops.`;
  }
  return `${who} proposes the vault ${name}; it was not applied.${before} Accept it with `
    + `confirm_workspace_binding({ vault: ${name} }) if it is what you want, or refuse it with `
    + `${refuse} and you will not be asked again.`;
}

/**
 * The enrichment-mode sentence, with its range — the part of the briefing that
 * tells a user something they cannot otherwise discover: that the mode is a
 * dial with four positions and not a switch.
 *
 * @param {string|null} mode the mode this session starts in
 * @param {{ canonical?: string }|null} modeRefused what a workspace file asked for and did not get
 */
function modeLine(mode, modeRefused) {
  const current = mode || DEFAULT_MODE;
  const refused = modeRefused
    // Named because otherwise the mode reported here silently contradicts what
    // the user wrote in their own file, which reads as a bug rather than as
    // the rule it is.
    ? ` This project's .env asked for ${q(modeRefused.canonical || 'FullAuto')} and was refused: `
      + 'that mode is never taken from a project file.'
    : '';
  return `Wiki auto-enrichment starts in ${q(current)} mode; the range runs FullAuto (saves without `
    + 'asking) → Hybrid → ClaudeAsk (asks every time) → off, and set_auto_enrich_mode moves it.'
    + refused;
}

/**
 * The one-time import's sentence, or null.
 *
 * This is the half of the migration's bargain that makes the other half
 * defensible. The router imported a binding from a project file WITHOUT being
 * asked, once, so that installations in the field kept working when the gate
 * closed — and the whole reason that is acceptable rather than a betrayal of
 * the decision is that it is said out loud, here, at the top of the session
 * where a wrong guess costs one sentence to undo.
 *
 * @param {{ vault: string, dotenvFile: string|null, locked?: boolean }|null} imported
 */
function importedLine(imported) {
  if (!imported || typeof imported.vault !== 'string' || !imported.vault) return null;
  const from = imported.dotenvFile ? ` from ${q(imported.dotenvFile)}` : '';
  // THE LOCK IS NAMED WHERE IT CAME FROM. The migration carries a persisted
  // `OBSIDIAN_ROUTER_LOCKED` across, so the isolation an upgrading user had
  // does not vanish — and the line above already says the session is locked.
  // What only this sentence can say is that NOBODY CHOSE IT TODAY: it was
  // inferred from the same file, and the same one call undoes both halves.
  const lock = imported.locked === true
    ? ' The lock came from that file too, and is in force for the same reason.'
    : '';
  // "WAS IMPORTED", not "was just imported". The hook reports a standing fact
  // read from the binding's own provenance, so it is true in the session that
  // ran the import and in every session after it — which is the useful
  // behaviour: a wrong guess keeps saying so until somebody acts on it,
  // instead of scrolling past once and being forgotten.
  return `NOBODY CONFIRMED THIS BINDING: it was imported automatically${from}, once, so that this `
    + `project kept working now that a project file no longer chooses a vault on its own.${lock} If it is `
    + 'wrong, confirm_workspace_binding({ clear: true }) undoes it and it will not come back; '
    + 'confirm_workspace_binding({ vault: … }) makes it yours and this line stops.';
}

/** The closing line: the two calls that answer "and how do I change this?". */
function actionsLine() {
  return 'list_vaults lists every registered vault, open or closed; confirm_workspace_binding '
    + 'changes what this workspace is bound to (one vault, several via `also`, or `clear: true` '
    + 'for all) and opens a bound vault that is not running.';
}

/**
 * Compose the whole block, or null when there is nothing worth saying.
 *
 * Returns null when the machine has no registered vault: the router is
 * installed but unused, and a briefing about an attachment that cannot exist
 * would be the first thing a new user reads. This is also the "silent no-op
 * without a vault" property that lets this hook ship with the plugin instead
 * of behind an opt-in step.
 *
 * `registeredCount` is a GATE and nothing else — it is never printed, so the
 * caller may pass the lower bound it can compute cheaply (see
 * `attachmentLine`).
 *
 * @param {{
 *   binding?: object|null,
 *   hint?: object|null,
 *   mode?: string|null,
 *   modeRefused?: object|null,
 *   registeredCount?: number,
 * }} input
 * @returns {string|null}
 */
export function composeBriefing({
  binding = null,
  hint = null,
  mode = null,
  modeRefused = null,
  registeredCount = 0,
  isRegistered = null,
  imported = null,
} = {}) {
  if (!Number.isInteger(registeredCount) || registeredCount <= 0) return null;

  const lines = [
    BRIEFING_MARKER,
    attachmentLine(binding, isRegistered),
    // Before the hint: when an import just happened, the hint that produced it
    // is now `confirmed` and silent anyway, and the import is the news.
    importedLine(imported),
    hintLine(hint),
    modeLine(mode, modeRefused),
    actionsLine(),
  ].filter(Boolean);

  return lines.join('\n');
}
