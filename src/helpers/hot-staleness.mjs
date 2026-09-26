/**
 * hot-staleness.mjs
 *
 * Pure logic for the deterministic hot-cache freshness guard
 * (`hooks/hot-cache-update-prompt.mjs`, v0.25.0). Extracted here so it can
 * be unit-tested without spawning the hook or touching the filesystem.
 *
 * The guard answers ONE question from a session transcript:
 *   "Did this session write a NOTE under some vault's `wiki/` directory
 *    WITHOUT also refreshing that vault's `wiki-meta/hot.md`?"
 *
 * If yes for ≥1 vault, the Stop hook blocks (exit 2) so Claude refreshes
 * hot.md before the turn ends — the recent-context cache stays current by
 * construction.
 *
 * Design notes:
 *   - Detection is TRANSCRIPT-SCOPED (this session's `tool_use` blocks),
 *     never git — so a concurrent session's uncommitted changes or a manual
 *     Obsidian edit can never cause a false block (Claude can only fix what
 *     it itself wrote).
 *   - TRIGGER = a NOTE-BODY write under `wiki/<...>`. The tracked tools are
 *     `write_file`/`patch_file`/`append_to_file`, the built-in
 *     `Write`/`Edit`/`MultiEdit`, `execute_template` (only when
 *     `createFile:true`, via its `targetPath`) and `write_bundle` (per
 *     content-writing step, via `steps[].path`). `move_file`, `delete_file`,
 *     `set_frontmatter`, `merge_frontmatter` are deliberately NOT tracked (a
 *     rename/delete/metadata toggle adds no recent fact worth a hot entry).
 *     Pure scaffold writes (`wiki-meta/catalog.md`, `journal.md`, `overview.md`) do
 *     NOT trigger either. A write to `wiki-meta/hot.md` is the satisfying
 *     action.
 *   - PER-VAULT: each vault judged independently (a session can touch
 *     several). A vault whose root can't be resolved is SKIPPED (fail-open),
 *     never blocked.
 *   - PER-RUN: a resumed session appends to the same transcript, so the file
 *     can hold several runs, days apart. The caller hands `findStaleVaults`
 *     only the current run, cut by `currentRunTranscript`. When that function
 *     finds no run-start marker, the caller must fail open.
 *   - THE SHELL ROUTE: a `Bash` call running `scripts/vault-edit.mjs` is a
 *     write when the call holds exactly one invocation and its output shows
 *     that it wrote. See `parseVaultEditInvocations` and `vaultEditCallWrote`.
 *   - OUTCOME-AWARE: a request is not an effect. A `tool_use` counts only when
 *     the `tool_result` that answers it exists and is not an error — and for
 *     `write_bundle`, which reports failure by RETURNING `ok:false` instead of
 *     throwing, only when its report says `ok` AND, per step, `status: 'ok'`
 *     (a `patch` that found nothing to do is `skipped` inside an applied
 *     bundle). See `extractToolResultOutcomes` for why the asymmetric
 *     alternative was rejected, `resultAppliedWrite` for the call-level bundle
 *     exception, and `appliedBundleStep` for the per-step one.
 *
 * Zero deps. Pure functions; all I/O (config, fs, platform) is injected by
 * the caller via `ctx`.
 */

import { writeTargets } from './write-targets.mjs';

const BUILTIN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// MCP tools whose output can be a NOTE under `wiki/` (or a `wiki-meta/hot.md`
// refresh): the note-body writers, plus `execute_template` (counted only when
// it actually writes) and `write_bundle` (counted per step). Matched by SUFFIX
// so both the local `mcp__obsidian-router__write_file` form and the
// MCPHub-namespaced `mcp__<id>__obsidian-router-<X>-write_file` form work.
//
// `write_bundle` WAS MISSING, and it is the tool that writes the most files at
// once: a bundle applying twelve notes under `wiki/` was invisible here, so the
// Stop hook let the turn end with `hot.md` describing a vault state that no
// longer existed. Same omission, same tool, as the two the factorisation of
// `write-targets.mjs` fixed elsewhere — this copy simply never heard about it.
//
// DELIBERATELY EXCLUDED: `move_file` / `delete_file` / `set_frontmatter` /
// `merge_frontmatter`. A rename, a delete, or a metadata toggle IS a write but
// not "new note content worth a hot entry" — tracking them would force a
// hot.md refresh (and emit a "you wrote notes" message) for operations that
// add no recent fact. Widen the set here if that scope ever needs to change.
const MCP_TRACKED_RE = /(?:^|[_-])(write_file|patch_file|append_to_file|execute_template|write_bundle)$/;

/**
 * The BARE router tool name behind whatever prefix the host imposed, or null.
 * `mcp__plugin_obsidian-router_router__write_file` → `write_file`. Needed
 * because `writeTargets` is keyed on the bare names the server declares.
 */
function bareTrackedToolName(toolName) {
  const m = MCP_TRACKED_RE.exec(String(toolName || ''));
  return m ? m[1] : null;
}

/**
 * A bundle step `op` → the single-file tool it is the equivalent of.
 *
 * This exists so the tracked-set policy above is stated ONCE. Without it, "a
 * bundle's `set_frontmatter` step is a metadata toggle, not note content" would
 * be a second, hand-maintained copy of the exclusion list — and this module's
 * whole defect was a second copy of a rule nobody re-read. Steps are filtered
 * through `isTrackedWriteTool`, the same predicate the top-level names use.
 */
const STEP_OP_TO_TOOL = {
  write: 'write_file',
  append: 'append_to_file',
  patch: 'patch_file',
  set_frontmatter: 'set_frontmatter',
  merge_frontmatter: 'merge_frontmatter',
  delete: 'delete_file',
};

/**
 * A `patch` that targets FRONTMATTER is a metadata-only edit — the low-level
 * equivalent of `set_frontmatter`, which is deliberately excluded. Treated the
 * same so the primitive and the wrapper agree; a heading/block patch IS content.
 * (codex review+ P2, pass 2.) One definition, used by the single-file branch and
 * by the bundle-step filter.
 */
function isFrontmatterOnlyPatch(bareTool, o) {
  return bareTool === 'patch_file' && o?.targetType === 'frontmatter';
}

export function isBuiltinWriteTool(name) {
  return typeof name === 'string' && BUILTIN_WRITE_TOOLS.has(name);
}

/**
 * True if a tool name is one the guard TRACKS: a note-body writer (built-in
 * Write/Edit/MultiEdit, or MCP write_file/patch_file/append_to_file),
 * execute_template, or write_bundle. Non-tracked writes (move_file/delete_file/
 * set_frontmatter/merge_frontmatter) return false by design — see the
 * MCP_TRACKED_RE comment. Also answers for a BARE name, which is how the
 * bundle-step filter reuses this one policy instead of restating it.
 */
export function isTrackedWriteTool(name) {
  if (!name || typeof name !== 'string') return false;
  if (BUILTIN_WRITE_TOOLS.has(name)) return true;
  return MCP_TRACKED_RE.test(name);
}

// ---------------------------------------------------------------------------
// The run bound — which part of the transcript is THIS run's
// ---------------------------------------------------------------------------

/**
 * A transcript is not one run of work. A resumed session appends to the SAME
 * file, so the transcript of a session reopened three times holds three runs,
 * possibly days apart. MEASURED 2026-09-23 on session 886414b9: 1113 entries
 * dated 20/09, 1443 on 21/09, 308 on 23/09, one file. Reading all of it made
 * the guard demand, on the 23rd, a hot refresh for a vault whose last note was
 * written on the 21st — and whose hot.md had been refreshed a minute later.
 *
 * WHERE A RUN STARTS. Claude Code records every SessionStart hook it runs as a
 * transcript `attachment` with `hookEvent: 'SessionStart'` and a `hookName`
 * spelling the source: `SessionStart:startup`, `SessionStart:resume`,
 * `SessionStart:clear`, `SessionStart:compact`. On 886414b9 there is one
 * `resume` marker at each reopening, including the one on 23/09.
 *
 * A MARKER IS NOT GUARANTEED where this guard runs. The router's plugin
 * installs the SessionStart hook, but this Stop guard is installed separately
 * (`hooks/hooks.example.json`), so one can be present without the other.
 * MEASURED (review round 1): 49 of 403 local transcripts have no marker, and
 * in 20 of those 49 this guard ran (5 of them it blocked).
 *
 * The bound is the POSITION of the last marker in the file, not its timestamp.
 * The timestamps are not in file order: the resume marker on 20/09 is stamped
 * 14:05:24, and the queue entry written just before it is stamped 14:06:07.
 *
 * Two marker kinds are deliberately NOT boundaries:
 *   - `compact`: compaction happens INSIDE a run. The notes written just before
 *     an auto-compaction are exactly the ones whose hot refresh is still owed.
 *   - `async_hook_response`: an async hook answers whenever it finishes, which
 *     can be after the run's first writes. Taking it as the start would push
 *     the bound past those writes.
 *
 * Returns the text AFTER the last run-start marker, or `null` when the
 * transcript has none. `null` means "the run cannot be bounded", and the
 * caller must then FAIL OPEN: blocking with a window it cannot justify would
 * bring back the false alarm this bound exists to remove. Because the 20
 * sessions above show that failing open switches off a guard that used to
 * work, the caller must also SAY so, not pass in silence.
 *
 * Other bounds that were considered and rejected:
 *   - a field of the Stop hook's input. It carries `session_id` and
 *     `transcript_path`, not a run start, and `session_id` stays the same
 *     across a resume (measured: the same id on all three days of 886414b9);
 *   - a gap in time between two entries. Resumes on 886414b9 follow gaps of
 *     1310 and 2580 minutes, but also gaps of 70, 87 and 135 minutes inside a
 *     single day. Any threshold would be a setting that someone tuned, not a
 *     fact the transcript records.
 */
const RUN_START_HOOK_RE = /^SessionStart:(startup|resume|clear)$/;

export function isRunStartMarker(entry) {
  if (!entry || entry.type !== 'attachment') return false;
  const a = entry.attachment;
  if (!a || a.hookEvent !== 'SessionStart') return false;
  if (a.type === 'async_hook_response') return false;
  return RUN_START_HOOK_RE.test(String(a.hookName || ''));
}

/*
 * COPIES OF OLD HISTORY ARE NOT THE CURRENT RUN. Claude Code can append a
 * second copy of earlier entries to the same file. MEASURED (review round 1):
 * session 8602edea holds 2200 entries whose `uuid` already appeared earlier,
 * among them 6 old markers, and its last marker is such a copy. 2 of 403
 * transcripts are in this state. Taking the last marker by position alone
 * judged those copies and left out the real current run. So:
 *   - an entry whose `uuid` was already seen is a copy and is dropped;
 *   - the bound is the last marker that is NOT a copy.
 * An entry without a `uuid` is kept as it is.
 *
 * There is no text pre-filter: every line is parsed anyway, and JSON may spell
 * any character of the marker as an escape. The parsed value is judged.
 */
export function currentRunTranscript(jsonlText) {
  if (!jsonlText || typeof jsonlText !== 'string') return null;
  const lines = jsonlText.split('\n');
  const seen = new Set();
  const firstSeen = new Array(lines.length).fill(true);
  let bound = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const uuid = entry && typeof entry.uuid === 'string' ? entry.uuid : null;
    if (uuid) {
      if (seen.has(uuid)) { firstSeen[i] = false; continue; }
      seen.add(uuid);
    }
    if (isRunStartMarker(entry)) bound = i;
  }
  if (bound < 0) return null;
  const out = [];
  for (let i = bound + 1; i < lines.length; i += 1) if (firstSeen[i]) out.push(lines[i]);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// scripts/vault-edit.mjs — the write route the repository itself prescribes
// ---------------------------------------------------------------------------

/**
 * In a SHARED vault, AGENTS.md and the vault's hot.md tell the agent to write
 * through `scripts/vault-edit.mjs`, which runs in a `Bash` tool call. The guard
 * only knew MCP and built-in tool names, so it could not see that route in
 * either direction: a hot refresh made through it did not count, and neither did
 * a note. OBSERVED 2026-09-23: the router's own vault stayed in the complaint
 * while its hot.md was refreshed this way, and left it as soon as a write went
 * through the MCP tool. The file on disk had been correct the whole time.
 *
 * Only `Bash`. MEASURED 2026-09-24 over the local transcripts: every Bash call
 * that printed a vault-edit write (31 that day) is recognised; none of the
 * calls ran in `PowerShell`, so a call from the PowerShell tool is not seen.
 * (The total of calls that merely MENTION the script grows with every session
 * that reads it, so it is not given here.)
 *
 * THREAT MODEL. This guard defends against FORGETTING the hot refresh, not
 * against an agent that lies: any agent can clear it by writing a trivial
 * hot.md. So the rules below close the shapes a normal session produces by
 * accident. An input built on purpose to forge the script's output (an edit
 * anchor or an argument that spells the success lines) is out of scope.
 */
const VAULT_EDIT_SHELL_TOOLS = new Set(['Bash']);
const VAULT_EDIT_SCRIPT_RE = /(?:^|[\\/])vault-edit\.mjs$/;
const NODE_BIN_RE = /(?:^|[\\/])node(?:\.exe)?$/i;

/**
 * How the script says it wrote. It prints two lines in a row, both formatted
 * by the script itself: the size-and-precondition line, then the success line
 * once `writeFileIfMatch` has returned.
 *
 * WHY `is_error` IS NOT ENOUGH HERE. Every real invocation measured is piped
 * (`2>&1 | tail -N`), so the exit status the transcript records is `tail`'s.
 * A refusal (`refused: edits[3].to must be a single line`) came back with
 * `is_error: false`.
 *
 * THE RULE: the LAST size-and-precondition line of the output must be followed
 * immediately by the success line. Why the last one (review rounds 1 and 2):
 *   - The script ECHOES caller text before its own size line: the first 100
 *     characters of each replaced span, which may hold newlines and so may
 *     hold lines that look like the pair, or like a refusal. Echoes always
 *     come BEFORE the script's real size line, so the last size line is the
 *     script's own. A rule that looked at every line was fooled both ways: an
 *     echoed `refused:` vetoed a real write, an echoed pair doubled the count.
 *   - On a failure after the size line (409, network error, stack trace), the
 *     line after the real size line is the failure, not the success line.
 *   - Output printed AFTER the success line, by commands chained after the
 *     call, does not matter. MEASURED: 20 of the 31 real writes are followed by
 *     such verification output (word counts, sizes), so requiring the pair to
 *     end the output would miss them.
 * Out of scope (see THREAT MODEL): a failure BEFORE the size line, such as an
 * edit refused for a missing anchor, whose own quoted caller text spells the
 * pair. Closing that needs the producer to name the path on its success line.
 * Also out of scope, because it is not attributable without a producer
 * receipt: a failed call whose command replays an older, genuine output (a log
 * written by `tee` in an earlier call and read back here).
 * A truncation (`tail -1`, or a Bash result so large that Claude Code keeps
 * only a preview) that cuts the size line off makes the call count as nothing.
 * A MISSED write is not harmless: a missed note written after the last hot
 * refresh lets the turn end as if the vault were fresh. Misses are listed so
 * they are known, not because they are safe.
 */
const VAULT_EDIT_SIZE_LINE_RE = /^\d+ → \d+ caractères, précondition [0-9a-f]{12}…$/;
const VAULT_EDIT_WROTE_LINE_RE = /^écrit — casMode: \S+$/;

export function isVaultEditShellTool(name) {
  return typeof name === 'string' && VAULT_EDIT_SHELL_TOOLS.has(name);
}

/**
 * Split a shell command into simple commands, each a list of words, applying
 * the quoting rules bash applies. Returns `null` when a quote is left open:
 * such a command is not understood, so it is not counted.
 *
 * What is handled, because each would otherwise make text look like a call:
 *   - single quotes (literal), double quotes (`\` escapes `"` `\` `$` and a
 *     backtick), an unquoted `\`, and a `\` before a newline, which continues
 *     the line;
 *   - `#` at the start of a word begins a comment, so a commented-out call is
 *     not a call;
 *   - `;`, `&`, `|`, `(`, `)` and newlines end a simple command;
 *   - redirections: `2>&1` produces no word, `> file` and `>| file` drop
 *     `file`, and a here-string `<<< word` drops `word`;
 *   - a HEREDOC body (`<<EOF` … `EOF`, `<<-` strips leading tabs) is data, not
 *     commands: it is skipped up to its delimiter line (review round 1: its
 *     lines were parsed as commands, so a body that merely spelled a call
 *     counted as one, and an apostrophe in a body hid the real call after it).
 *     A heredoc whose delimiter cannot be read makes the command not understood.
 *     Known miss: an UNQUOTED heredoc body can itself run `$( … )`; it is
 *     skipped as data all the same.
 *   - command substitution runs its content, so that content is tokenized as
 *     commands of its own: `$( … )` inside double quotes, and backticks
 *     anywhere. (An unquoted `$( … )` needs nothing: its parentheses already
 *     separate commands.)
 *   - arithmetic `$(( … ))` / `(( … ))` is one word. Known misses: `let x=1<<3`
 *     (read as a heredoc), and `((cd x && node …) && …)`, which bash reads as
 *     two subshells but this reads as arithmetic.
 * A quoted string stays ONE word. So `echo "node scripts/vault-edit.mjs"` has
 * no word equal to the script path.
 */
function shellSimpleCommands(command) {
  const src = String(command || '');
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false; // a word has started (even if it is an empty quoted string)
  let quotedInWord = false;
  let dropNextWord = false;
  const heredocs = []; // pending { delim, stripTabs }, read at the next newline

  const endWord = () => {
    if (inWord) {
      if (dropNextWord) dropNextWord = false;
      else words.push(word);
    }
    word = '';
    inWord = false;
    quotedInWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  // COMMAND SUBSTITUTION RUNS COMMANDS (review round 3): in
  // `out="$(node …vault-edit.mjs …)"` the call really executes. Its text is
  // tokenized as commands of its own and added to the list; the enclosing
  // word keeps the raw text. `closeParen` returns the index of the `)` that
  // closes a `$(` whose content starts at `from`, skipping quoted text.
  const closeParen = (from) => {
    let depth = 1;
    let k = from;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '\'') {
        const q = src.indexOf('\'', k + 1);
        if (q === -1) return -1;
        k = q + 1;
        continue;
      }
      if (c === '"') {
        k += 1;
        while (k < src.length && src[k] !== '"') k += src[k] === '\\' ? 2 : 1;
        if (k >= src.length) return -1;
        k += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return k; }
      k += 1;
    }
    return -1;
  };
  const closeBacktick = (from) => {
    let k = from;
    while (k < src.length && src[k] !== '`') k += src[k] === '\\' ? 2 : 1;
    return k < src.length ? k : -1;
  };
  // Tokenize a substitution's content and add its commands. `false` = the
  // content is not understood: the CALLER then keeps the substitution as
  // plain text, as before this rule existed, instead of failing the whole
  // command (review round 4: `git commit -m "$(cat <<'EOF' … don't … EOF)"`
  // hid a real call written next to it, because the apostrophe of the body
  // was read as a quote). Measured on 22 238 real Bash commands against the
  // fatal version: 0 calls lost, 19 more recognised. It is NOT a guarantee
  // that only calls inside the substitution can be hidden (review round 5):
  // kept as text, a heredoc body is then read as double-quoted text, so a `"`
  // in it ends the string early. 2 of 51 real commit heredocs do that.
  const substitute = (inner) => {
    const sub = shellSimpleCommands(inner);
    if (!sub) return false;
    commands.push(...sub);
    return true;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // An UNQUOTED `$( … )` needs no branch: its parentheses already end the
    // simple commands around the call inside, which is then recognised.
    if (ch === '`') {
      const end = closeBacktick(i + 1);
      if (end !== -1 && substitute(src.slice(i + 1, end))) {
        word += src.slice(i, end + 1);
        inWord = true;
        i = end + 1;
        continue;
      }
      // Not understood: the backtick falls through as an ordinary character.
    }
    // Arithmetic `$(( … ))` / `(( … ))`: its `<<` is a shift, not a heredoc.
    // Kept as part of the current word, up to the matching parenthesis.
    if ((ch === '$' && src[i + 1] === '(' && src[i + 2] === '(') || (ch === '(' && src[i + 1] === '(' && !inWord)) {
      let j = ch === '$' ? i + 1 : i;
      let depth = 0;
      do {
        if (src[j] === '(') depth += 1;
        else if (src[j] === ')') depth -= 1;
        j += 1;
      } while (j < src.length && depth > 0);
      if (depth > 0) return null;
      word += src.slice(i, j);
      inWord = true;
      i = j;
      continue;
    }
    // ANSI-C quoting `$'…'`: a backslash escapes the next character, so
    // `$'it\'s'` does not leave a quote open.
    if (ch === '$' && src[i + 1] === '\'') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\'') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return null;
      word += src.slice(i + 2, j);
      inWord = true;
      quotedInWord = true;
      i = j + 1;
      continue;
    }
    if (ch === '\'') {
      const close = src.indexOf('\'', i + 1);
      if (close === -1) return null;
      word += src.slice(i + 1, close);
      inWord = true;
      quotedInWord = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          if (n === '\n') { j += 2; continue; }
          if (n === '"' || n === '\\' || n === '$' || n === '`') { word += n; j += 2; continue; }
          word += c;
          j += 1;
          continue;
        }
        if (c === '"') { closed = true; break; }
        // A substitution inside double quotes still runs its commands.
        if (c === '$' && src[j + 1] === '(' && src[j + 2] !== '(') {
          const end = closeParen(j + 2);
          if (end !== -1 && substitute(src.slice(j + 2, end))) {
            word += src.slice(j, end + 1);
            j = end + 1;
            continue;
          }
          // Not understood: kept as text (see `substitute`).
        }
        if (c === '`') {
          const end = closeBacktick(j + 1);
          if (end !== -1 && substitute(src.slice(j + 1, end))) {
            word += src.slice(j, end + 1);
            j = end + 1;
            continue;
          }
        }
        word += c;
        j += 1;
      }
      if (!closed) return null;
      inWord = true;
      quotedInWord = true;
      i = j + 1;
      continue;
    }
    if (ch === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { word += src[i + 1]; inWord = true; }
      i += 2;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // Heredoc: read the delimiter now, skip the body at the next newline.
      if (inWord && !quotedInWord && /^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j += 1;
      while (src[j] === ' ' || src[j] === '\t') j += 1;
      let delim = '';
      while (j < src.length && !/[\s;&|()<>]/.test(src[j])) {
        const c = src[j];
        if (c === '\'' || c === '"') {
          const close = src.indexOf(c, j + 1);
          if (close === -1) return null;
          delim += src.slice(j + 1, close);
          j = close + 1;
          continue;
        }
        if (c === '\\') { delim += src[j + 1] || ''; j += 2; continue; }
        delim += c;
        j += 1;
      }
      if (!delim) return null;
      heredocs.push({ delim, stripTabs });
      i = j;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && src[i + 1] === '>')) {
      // A file-descriptor number glued to the operator (`2>`) is not a word.
      if (inWord && !quotedInWord && /^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      let j = i;
      while (j < src.length && (src[j] === '>' || src[j] === '<' || src[j] === '&')) {
        if (src[j] === '&' && j > i && /[\d-]/.test(src[j + 1] || '')) break;
        j += 1;
      }
      if (src[j] === '|' && src[j - 1] === '>') j += 1; // `>|`: clobber, not a pipe
      if (src[j] === '&') {
        j += 1;
        while (j < src.length && /[\d-]/.test(src[j])) j += 1; // `>&1`: no target word
      } else {
        dropNextWord = true; // `> file` / `<<< word`: the next word is the target
      }
      i = j;
      continue;
    }
    if (ch === '\n' && heredocs.length) {
      endCommand();
      dropNextWord = false;
      let j = i + 1;
      // As bash does, a body whose delimiter line never comes runs to the end
      // of the input. (A shift like `$((1<<3))` never gets here: the
      // arithmetic branch above keeps it out of the heredoc path.)
      for (const { delim, stripTabs } of heredocs) {
        while (j < src.length) {
          const nl = src.indexOf('\n', j);
          const end = nl === -1 ? src.length : nl;
          let bodyLine = src.slice(j, end).replace(/\r$/, '');
          if (stripTabs) bodyLine = bodyLine.replace(/^\t+/, '');
          j = end + 1;
          if (bodyLine === delim) break;
        }
      }
      heredocs.length = 0;
      i = j;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')' || ch === '\n') {
      endCommand();
      dropNextWord = false;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
      i += 1;
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  endCommand();
  return commands;
}

/**
 * Every `node …/vault-edit.mjs …` invocation in a shell command, in order, as
 * `{ vault, path, dryRun }`. The script's arguments are read with the script's
 * own rules (`parseArgv`): `--dry-run` is a switch, every other `--key` takes
 * the next word, and the last value given wins. A missing `--vault` or
 * `--path` leaves that field undefined. The call is still an invocation, and
 * `classifyToolUse` skips a target it cannot resolve.
 *
 * An invocation is a simple command whose COMMAND WORD is `node` (after any
 * `VAR=value` prefixes), whose node options are skipped, and whose first
 * operand is the script. So none of these is one (review round 1):
 *   - the path read by another program (`sed -n … vault-edit.mjs`, `ls`), or
 *     passed as an argument (`printf '%s' node scripts/vault-edit.mjs`);
 *   - `node -e` / `-p` / `--eval` / `--print`: node runs the SOURCE TEXT, and a
 *     script path inside it is only text;
 *   - a call inside a quoted string, a comment or a heredoc body.
 * Node options that take a separate value (`--require x`, `--import x`, …) are
 * skipped together with their value.
 *
 * `--config` makes the script resolve `--vault` in ANOTHER registry, which the
 * guard cannot read. Such an invocation still counts as an invocation, but its
 * vault is left undefined, so `classifyToolUse` skips it rather than crediting
 * a same-named vault of the default registry.
 * A `$VAR` in `--vault` or `--path` is not expanded: the literal is kept, and a
 * vault spelled `$V` does not resolve, so the target is skipped.
 */
const NODE_EVAL_OPT_RE = /^(?:-[A-Za-z]*[ep][A-Za-z]*|--eval(?:=.*)?|--print(?:=.*)?)$/;
const NODE_VALUE_OPTS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--input-type', '-C', '--conditions', '--env-file', '--title', '--disable-warning',
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Reserved words that can stand before a command in the same simple command
// (`for …; do node …`, `if node …; then …`, `while node …`). Skipped, so the
// call behind them is recognised. A launcher that is NOT listed here (`env`,
// `timeout`, `npx`, `bash -c` …) leaves the call unrecognised, and the
// one-mention rule in `vaultEditCallWrote` then credits nothing in that Bash
// call: an unrecognised call could otherwise lend its output to a recognised one.
const SHELL_PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);

function vaultEditArgsOf(words) {
  let k = 0;
  while (k < words.length && (ENV_ASSIGNMENT_RE.test(words[k]) || SHELL_PREFIX_WORDS.has(words[k]))) k += 1;
  if (!NODE_BIN_RE.test(words[k] || '')) return null;
  let j = k + 1;
  while (j < words.length && words[j].startsWith('-')) {
    const opt = words[j];
    if (NODE_EVAL_OPT_RE.test(opt)) return null;
    j += NODE_VALUE_OPTS.has(opt) ? 2 : 1;
  }
  if (!VAULT_EDIT_SCRIPT_RE.test(words[j] || '')) return null;
  return words.slice(j + 1);
}

export function parseVaultEditInvocations(command) {
  const commands = shellSimpleCommands(command);
  if (!commands) return [];
  // The registry can also come from the environment (`OBSIDIAN_ROUTER_CONFIG=…
  // node …`, or an `export` earlier in the command). Any mention of it in the
  // command makes the vault unattributable, like `--config` (review round 2).
  const envRegistry = String(command).includes('OBSIDIAN_ROUTER_CONFIG');
  const out = [];
  for (const words of commands) {
    const args = vaultEditArgsOf(words);
    if (!args) continue;
    const inv = { vault: undefined, path: undefined, dryRun: false };
    let otherRegistry = false;
    for (let a = 0; a < args.length; a += 1) {
      const arg = args[a];
      if (arg === '--dry-run') { inv.dryRun = true; continue; }
      if (!arg.startsWith('--')) continue;
      const value = args[a + 1];
      if (value === undefined || value.startsWith('--')) continue;
      a += 1;
      if (arg === '--vault') inv.vault = value;
      else if (arg === '--path') inv.path = value;
      else if (arg === '--config') otherRegistry = true;
    }
    if (otherRegistry || envRegistry) inv.vault = undefined;
    out.push(inv);
  }
  return out;
}

/**
 * Did the vault-edit invocation of this Bash call actually write?
 *
 * EXACTLY ONE RECOGNISED INVOCATION, AND THE COMMAND TEXT MENTIONS
 * `vault-edit.mjs` EXACTLY ONCE, or nothing is credited. The output is one
 * stream, so it cannot say which of two calls wrote, nor which ran first
 * (`a & b`, `(sleep 2; a) & b`; review round 1). Counting only RECOGNISED
 * calls was not enough (review round 2): in
 * `timeout 60 node …vault-edit.mjs --path wiki/n.md …; node …vault-edit.mjs
 * --path wiki-meta/hot.md --spec typo.json`, the first call is not recognised
 * (its launcher is `timeout`), writes, and prints the success lines; the
 * second is recognised, fails, and was credited with the first one's output.
 * Counting the raw mentions closes that: any second mention, recognised or
 * not, credits nothing. MEASURED: all 31 real writes mention the script
 * exactly once. The price is a miss, never an invented write.
 *
 * `command` is the raw command text. It is optional so that existing callers
 * that pass only the parse keep working, but then the mention rule cannot run
 * and nothing is credited.
 */
export function vaultEditCallWrote(invocations, outcome, command) {
  // `invocations.length !== 1` is implied by the one-mention rule below (each
  // recognised call is a mention); kept as the explicit statement of intent.
  if (!Array.isArray(invocations) || invocations.length !== 1) return false;
  if (typeof command !== 'string' || command.split('vault-edit.mjs').length - 1 !== 1) return false;
  // `is_error` is NOT read on this route (review round 3). Claude Code sets it
  // when ANY command of the Bash call exits non-zero — a `grep -c` finding
  // nothing after the write, for instance (measured: 91 chained checks among
  // 717 error results out of 22 646 Bash results). The script prints its lines
  // only after the write returned and prints nothing after them, so a failure
  // that comes later cannot undo the write. A failure of the script itself
  // never prints them.
  if (!outcome) return false;
  const lines = String(outcome.text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  let lastSize = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (VAULT_EDIT_SIZE_LINE_RE.test(lines[i])) lastSize = i;
  }
  // "no change: … nothing written" is NOT credited (review round 4, after one
  // round of crediting it). The script says outright that it wrote nothing,
  // and with vault-edit the new text lives in a spec file: re-running the
  // same command after the guard blocked, without updating that file, is the
  // very slip this guard exists to catch. Counting it would clear a hot.md
  // that never took the new note in, and would make an unchanged note a debt.
  return lastSize >= 0 && VAULT_EDIT_WROTE_LINE_RE.test(lines[lastSize + 1] || '');
}

/**
 * Parse a JSONL transcript string → `Map<tool_use_id, { isError, text }>`, one
 * entry per `tool_result` block found. An id absent from the map has NO
 * result in the transcript (call still in flight, or the file was truncated).
 *
 * SHAPES ARE MEASURED, NOT ASSUMED (10 real transcripts under
 * `~/.claude/projects/`, 16 731 `tool_use` blocks):
 *   - a `tool_use` is a content chunk of an `entry.type === "assistant"` line,
 *     keyed `{ type, id, name, input, caller }` — the identity is `c.id`;
 *   - a `tool_result` is a content chunk of an `entry.type === "user"` line,
 *     keyed `{ tool_use_id, type, content, is_error }`;
 *   - a failed call really does carry `is_error: true` AND its `tool_use_id`
 *     (observed on a router write refused with `HTTP 404`).
 * `isError` is accepted alongside `is_error` because that is the spelling in
 * the MCP `CallToolResult` the host maps from; only `is_error` was observed
 * here, so the second branch is defensive breadth, not a measurement.
 *
 * `text` is carried because `is_error` is not the whole story: `write_bundle`
 * reports a failure, and reports which of its steps were no-ops, INSIDE this
 * payload. Only `resultAppliedWrite` and `parseToolResultReport` read it.
 *
 * WHY THIS EXISTS AT ALL. The classifier used to read only the assistant's
 * REQUESTS, so a `wiki-meta/hot.md` write that FAILED — a concurrency 409, an
 * offline vault, a refused path — satisfied the guard exactly like one that
 * succeeded. The turn ended clean while the cache had not moved: a false
 * assurance, which is worse at that instant than no guard at all.
 */
export function extractToolResultOutcomes(jsonlText) {
  const outcomes = new Map();
  if (!jsonlText || typeof jsonlText !== 'string') return outcomes;
  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'user') continue;
    const msg = entry.message || entry;
    const chunks = Array.isArray(msg.content) ? msg.content : [];
    for (const c of chunks) {
      if (!c || c.type !== 'tool_result') continue;
      const id = c.tool_use_id;
      if (typeof id !== 'string' || !id) continue;
      outcomes.set(id, {
        isError: c.is_error === true || c.isError === true,
        text: resultText(c.content),
      });
    }
  }
  return outcomes;
}

/**
 * The readable payload of a `tool_result`, whatever container it arrived in.
 * MEASURED on the same transcripts: a SUCCESSFUL router write carries an ARRAY
 * of blocks (`[{ type: 'text', text: '<the JSON the tool returned>' }]`, 222 of
 * them), while a failure arrives as a bare STRING. Both shapes occur, so both
 * are read; anything else yields `''`.
 *
 * What `''` COSTS is tool-specific, and saying otherwise would overstate it: for
 * `write_bundle` the report becomes unreadable, so the call cannot be shown to
 * have applied and counts as nothing. For every other tracked tool the payload
 * is never consulted — `is_error` alone decides — so an empty text changes
 * nothing.
 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/**
 * Did this call actually WRITE? `isError` answers it for every TRACKED tool that
 * signals failure by throwing — which is all of them but `write_bundle`.
 * (Untracked tools are not this function's business: `merge_frontmatter`, for
 * one, also reports a partial failure in its result, and the bundle's own
 * `RESULT_FAILURE_PROBES` table exists for exactly that. It never reaches here.)
 *
 * `write_bundle` IS THE EXCEPTION, and it is the tool that writes the most
 * files at once. Its own contract says so: "a failure mid-bundle RETURNS this
 * report with `ok:false` rather than throwing; only refusals BEFORE the first
 * write throw." The dispatcher's `wrapResult` never sets `isError` on a value a
 * handler RETURNED — only the catch-all around a throw does — so a bundle that
 * failed at step 3 and rolled every file back reaches the transcript as
 * `is_error: false`. Pairing on `is_error` alone therefore left this guard's
 * original blind spot fully open for bundles: a rolled-back `wiki-meta/hot.md`
 * refresh would still have cleared the vault. Fixing the throw path and calling
 * the class closed was the same mistake one layer up.
 *
 * So a bundle counts only when its own report says so: the predicate is exactly
 * `JSON.parse(text)?.ok === true`, the flag the producer sets beside
 * `outcome: 'applied'`. `ok` is the field read — not `outcome`, which is listed
 * here (`rolled-back`, `rolled-back-unverified`, `rolled-back-partial`) to say
 * what a failing bundle looks like, not as a second gate. A report that cannot
 * be parsed counts as nothing. Two consequences worth naming:
 *
 *   - `preview: true` writes nothing and its report carries no `ok` field, so it
 *     stops counting as a write here. `writeTargets` gates on `recover` but not
 *     on `preview`, so a preview used to mark a vault stale for files it had
 *     only described. That hole closes as a side effect of asking the right
 *     question — "did it apply?" rather than "was it requested?".
 *   - KNOWN LIMIT, deliberately not covered: `rolled-back-partial` means some
 *     files are still dirty. Counting the whole call as nothing can therefore
 *     MISS a note that survived the rollback, and no hot refresh is demanded for
 *     it. That is the same fail-open direction as an unanswered call, chosen for
 *     the same reason and by the same symmetric rule — never the direction that
 *     falsely certifies a refresh. Per-step attribution is what a fix would need.
 *
 * Deliberately NOT done: reading failure out of arbitrary result PROSE. The
 * check is the producer's own structured field or nothing — a scanner that
 * guesses at English is a scanner that will be wrong in a new way next release.
 */
export function resultAppliedWrite(toolName, outcome) {
  if (!outcome || outcome.isError) return false;
  if (bareTrackedToolName(toolName) !== 'write_bundle') return true;
  return parseToolResultReport(outcome)?.ok === true;
}

/**
 * The structured report a tool returned, or `null` when there is none to read.
 * Split out from `resultAppliedWrite` because the bundle's report is needed
 * TWICE: once to decide whether the call applied at all, and once to decide
 * WHICH of its steps did — see `appliedBundleStep`.
 */
export function parseToolResultReport(outcome) {
  if (!outcome || typeof outcome.text !== 'string' || !outcome.text) return null;
  try {
    return JSON.parse(outcome.text);
  } catch {
    return null; // an unreadable report is not a proven write
  }
}

/**
 * Did the bundle step at input position `i` actually change the file?
 *
 * `ok: true` does NOT mean every step wrote. A `patch` step whose target already
 * satisfied the patch is reported `status: 'skipped'` — that is the producer's
 * only skip probe (`RESULT_SKIP_PROBES`, keyed on `patch`, fired when
 * `patched === false`) — and the bundle still finishes `ok: true,
 * outcome: 'applied'`. `patch` IS one of this guard's tracked content ops, so
 * reading only the top-level flag credited a no-op as a write. A bundle whose
 * `wiki-meta/hot.md` patch changed nothing would have cleared the vault: the
 * SAME defect class as the one this module was just repaired for — a request
 * counted as an effect — surviving one level further down. Third instance;
 * hence the check moved to where the producer states the fact, per step.
 *
 * Report entries carry `index`, which `validateSteps` assigns as the step's
 * position in the caller's array, so they map back exactly. A step with no
 * matching entry, or any status other than `ok` (`skipped` / `failed` /
 * `not-run`), did not write.
 *
 * `report === undefined` means the caller supplied no outcome at all — the
 * direct unit tests, and anyone asking only "what did this call TARGET?". Then
 * nothing is filtered. A report that IS present but carries no `steps` array
 * filters everything out, by the same rule that governs a missing result.
 *
 * The report is TRUSTED as the producer's own output, not validated against the
 * request: matching is on `index` alone, and `path`/`op` are not cross-checked.
 * A self-inconsistent report could therefore misattribute a verdict. Left as is
 * deliberately — the producer has no route to one, and a path cross-check would
 * have to replicate `canonicalVaultPath`, whose disagreement would silently drop
 * legitimate steps. Revisit if a bundle report ever crosses a trust boundary.
 */
function appliedBundleStep(report, i) {
  if (report === undefined) return true;
  if (!report || !Array.isArray(report.steps)) return false;
  const entry = report.steps.find((e) => e && e.index === i);
  return !!entry && entry.status === 'ok';
}

/**
 * Parse a JSONL transcript string → array of `{ id, toolName, input }` for
 * every write-flavored `tool_use` block that ACTUALLY WROTE: one the
 * assistant requested AND whose `tool_result` came back without an error.
 * Robust to malformed lines (skipped) and missing fields.
 *
 * THE RULE FOR A `tool_use` WITH NO `tool_result`, stated once and applied to
 * both sides: an absent result is not a success, so the call is not counted —
 * neither as a note write nor as a hot refresh. Two consequences, both wanted:
 *
 *   - a hot.md write still in flight (or lost to a truncated transcript) does
 *     not clear a vault, so the guard never certifies a refresh it did not see
 *     land — the whole point of the fix;
 *   - a NOTE write in the same state does not mark a vault stale either, so the
 *     correction cannot produce the mirror-image defect of blocking a turn for
 *     a write that never happened.
 *
 * Treating the two sides differently was the tempting alternative — count an
 * unresolved note write, ignore an unresolved hot write, i.e. "block when in
 * doubt". It was rejected: a transcript whose results are missing WHOLESALE
 * (another host's format, a half-flushed file) would then block every turn that
 * touched a vault, and this hook must never wedge a session on a file it could
 * not read. Under the symmetric rule that case counts nothing and passes.
 *
 * The cost of the symmetric rule was measured before it was chosen: across ten
 * real transcripts, 2 of 16 731 `tool_use` blocks had no result, both of them
 * the single call in flight while the file was being read, and neither a write.
 * At Stop-hook time the results of a finished turn are already on disk.
 */
export function extractWriteToolUses(jsonlText) {
  const out = [];
  if (!jsonlText || typeof jsonlText !== 'string') return out;
  const outcomes = extractToolResultOutcomes(jsonlText);
  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'assistant') continue;
    const msg = entry.message || entry;
    const chunks = Array.isArray(msg.content) ? msg.content : [];
    for (const c of chunks) {
      if (!c || c.type !== 'tool_use') continue;
      // The pairing key. A block with no usable id can never be shown to have
      // succeeded, so it falls under the same rule as a missing result.
      const id = typeof c.id === 'string' && c.id ? c.id : null;
      if (isVaultEditShellTool(c.name)) {
        if (!id) continue;
        const invocations = parseVaultEditInvocations(c.input && c.input.command);
        if (!vaultEditCallWrote(invocations, outcomes.get(id), c.input && c.input.command)) continue;
        out.push({ id, toolName: c.name, input: c.input, invocations });
        continue;
      }
      if (!isTrackedWriteTool(c.name)) continue;
      if (!id) continue;
      const outcome = outcomes.get(id);
      if (!resultAppliedWrite(c.name, outcome)) continue;
      out.push({
        id,
        toolName: c.name,
        input: c.input && typeof c.input === 'object' ? c.input : {},
        // Carried so target extraction can honour the PER-STEP verdict, not just
        // the call-level one. Only a bundle has anything to say here.
        ...(bareTrackedToolName(c.name) === 'write_bundle'
          ? { report: parseToolResultReport(outcome) }
          : {}),
      });
    }
  }
  return out;
}

/** Normalize a vault-relative path: forward slashes, collapse repeats, strip leading `./` and `/`. */
function normRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** Normalize an absolute path for prefix comparison (slashes, no trailing slash, lowercased on Windows). */
function normAbs(p, isWin) {
  let s = String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  if (isWin) s = s.toLowerCase();
  return s;
}

/**
 * Pull the candidate written path(s) + optional vault slug out of one tracked
 * tool call. Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`; the
 * router tools carry vault-RELATIVE paths and may carry an optional `vault`
 * slug.
 *
 * WHICH FIELD NAMES THE TARGET IS NOT DECIDED HERE ANY MORE.
 * `helpers/write-targets.mjs` is the one definition — `path` for most tools,
 * `targetPath` only when `execute_template` has `createFile === true`,
 * `steps[].path` for a bundle, nothing for a recovery replay. This function had
 * its own copy of two of those rules and had never heard of the other two:
 *
 *   - it re-spelled the `createFile === true` gate inline, the very rule the
 *     shared module was extracted to own;
 *   - it did not know `write_bundle` existed, so a bundle writing twelve notes
 *     produced zero targets and the freshness guard saw an idle session.
 *
 * The docstring over there says it out loud — "two rounds of propagate-the-fix
 * is exactly how the copies drift, and the second copy is always the one nobody
 * re-reads". This was that copy. What stays local is only what is genuinely this
 * guard's own policy: which tools count as NOTE CONTENT at all.
 */
export function targetsFromToolUse({ toolName, input, report } = {}) {
  const inp = input && typeof input === 'object' ? input : {};

  // Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`.
  if (isBuiltinWriteTool(toolName)) {
    const fp = inp.file_path || inp.filePath;
    return { absolutePaths: typeof fp === 'string' && fp ? [fp] : [], relPaths: [], vaultSlug: undefined };
  }

  const vaultSlug = typeof inp.vault === 'string' && inp.vault.trim() ? inp.vault.trim() : undefined;
  const none = { absolutePaths: [], relPaths: [], vaultSlug };

  const bare = bareTrackedToolName(toolName);
  if (!bare) return none;
  if (isFrontmatterOnlyPatch(bare, inp)) return none;

  // A bundle's steps are filtered BEFORE the shared extractor runs, so
  // `writeTargets` stays the sole authority on the recovery gate and on the
  // `steps[].path` shape, while both policies are applied to its input rather
  // than re-derived from its output. Two filters, different questions:
  //   - is this step's op NOTE CONTENT at all? (this guard's own policy)
  //   - did it actually change the file? (the producer's per-step verdict)
  // `filter` preserves order, which the per-target ordering in `findStaleVaults`
  // depends on.
  const args = bare === 'write_bundle' && Array.isArray(inp.steps)
    ? { ...inp, steps: inp.steps.filter((s, i) => {
      const stepTool = STEP_OP_TO_TOOL[s?.op];
      if (!isTrackedWriteTool(stepTool) || isFrontmatterOnlyPatch(stepTool, s)) return false;
      return appliedBundleStep(report, i);
    }) }
    : inp;

  return { absolutePaths: [], relPaths: writeTargets(bare, args), vaultSlug };
}

/** Classify a vault-relative path into 'hot' | 'content' | 'other'. */
export function pathKind(relPath, { contentPrefix = 'wiki/', hotPath = 'wiki-meta/hot.md' } = {}) {
  const r = normRel(relPath);
  if (!r) return 'other';
  if (r === hotPath) return 'hot';
  if (r.startsWith(contentPrefix)) return 'content';
  return 'other';
}

/**
 * Classify one write tool call into zero or more `{ vaultKey, vaultRootRaw,
 * kind }`. `vaultKey` is the normalized absolute vault root used for
 * grouping; `null` means "could not resolve which vault" → caller skips
 * (fail-open, never block). `ctx`:
 *   - vaultRoots: string[]  (absolute vault roots, e.g. config.portRegistry keys)
 *   - slugToRoot: (slug) => string|null
 *   - defaultRoot: string|null  (vault used for MCP writes with no explicit `vault`)
 *   - isWin: bool
 *   - contentPrefix / hotPath: overridable path conventions
 */
export function classifyToolUse(toolUse, ctx = {}) {
  const isWin = !!ctx.isWin;

  // A vault-edit Bash call: one target per invocation, each naming its own
  // vault, resolved exactly as an MCP call's explicit `vault` is. A `--dry-run`
  // writes nothing, so it is `other` whatever path it names.
  if (isVaultEditShellTool(toolUse && toolUse.toolName)) {
    const invocations = Array.isArray(toolUse.invocations)
      ? toolUse.invocations
      : parseVaultEditInvocations(toolUse.input && toolUse.input.command);
    return invocations.map((inv) => {
      const rootRaw = inv.vault && typeof ctx.slugToRoot === 'function' ? ctx.slugToRoot(inv.vault) || null : null;
      return {
        vaultKey: rootRaw ? normAbs(rootRaw, isWin) : null,
        vaultRootRaw: rootRaw,
        kind: inv.dryRun ? 'other' : pathKind(inv.path, ctx),
      };
    });
  }

  const { absolutePaths, relPaths, vaultSlug } = targetsFromToolUse(toolUse);
  const roots = (ctx.vaultRoots || []).map((r) => ({ raw: r, norm: normAbs(r, isWin) }));
  const results = [];

  // Absolute (built-in Write/Edit/MultiEdit): match the LONGEST root prefix.
  for (const ap of absolutePaths) {
    const apNorm = normAbs(ap, isWin);
    let best = null;
    for (const root of roots) {
      if (apNorm === root.norm || apNorm.startsWith(root.norm + '/')) {
        if (!best || root.norm.length > best.norm.length) best = root;
      }
    }
    if (!best) {
      results.push({ vaultKey: null, vaultRootRaw: null, kind: 'other' });
      continue;
    }
    const rel = apNorm.slice(best.norm.length).replace(/^\/+/, '');
    results.push({ vaultKey: best.norm, vaultRootRaw: best.raw, kind: pathKind(rel, ctx) });
  }

  // Relative (MCP): resolve the vault root via explicit slug or the default.
  if (relPaths.length) {
    let rootRaw = null;
    if (vaultSlug && typeof ctx.slugToRoot === 'function') rootRaw = ctx.slugToRoot(vaultSlug) || null;
    if (!rootRaw && !vaultSlug) rootRaw = ctx.defaultRoot || null;
    const vaultKey = rootRaw ? normAbs(rootRaw, isWin) : null;
    for (const rp of relPaths) {
      results.push({ vaultKey, vaultRootRaw: rootRaw, kind: pathKind(rp, ctx) });
    }
  }

  return results;
}

/**
 * Main entry point. Given a transcript (JSONL string) + ctx, return:
 *   { stale: [{ vaultKey, vaultRoot }], byVault: Map<vaultKey,{lastContent,lastHot}> }
 *
 * A vault is STALE when its most recent `wiki/` content write comes AFTER its
 * most recent `wiki-meta/hot.md` refresh (or there was no hot refresh at all).
 *
 * Tracking ORDER — not just two booleans — is essential: in a multi-turn
 * session, ONE early hot refresh must NOT excuse a note written later. The
 * hot refresh has to FOLLOW the latest content write to clear the vault,
 * otherwise the cache no longer reflects the latest touched pages. (Without
 * ordering, `content:true, hot:true` would pass forever after the first
 * refresh — codex review+ P1.)
 *
 * Indices are per-APPLIED-TARGET (monotonic), walked in transcript order over
 * the calls `extractWriteToolUses` kept — i.e. the ones shown to have written.
 * A vault is stale iff `lastContent >= 0 && lastContent > lastHot`. Every
 * target gets its OWN position, including each step of a `write_bundle`, so a
 * hot write and a content write can never share an index and the strict `>` is
 * safe. That was previously asserted rather than arranged, and it was false for
 * bundles — see the loop below.
 */
export function findStaleVaults(jsonlText, ctx = {}) {
  const toolUses = extractWriteToolUses(jsonlText);
  const byVault = new Map(); // vaultKey -> { lastContent, lastHot } (tool-use indices, -1 = none)
  const rawByKey = new Map(); // vaultKey -> raw root (for messaging)

  for (const r of ctx.vaultRoots || []) rawByKey.set(normAbs(r, !!ctx.isWin), r);

  // ONE POSITION PER TARGET, not per tool call. A `write_bundle` writes several
  // files in ONE `tool_use`, in the order its steps are listed, and giving them
  // all the same index made `lastContent === lastHot` — which the stale test
  // (`lastContent > lastHot`) reads as fresh. A single bundle that refreshed
  // `wiki-meta/hot.md` and THEN wrote a note came out clean, in the tool built
  // to write "the note, an index, the journal, hot.md" together. The old comment
  // here asserted that equality was "impossible for our tracked tools"; it was
  // false from the moment `write_bundle` joined the set, and measuring it was
  // what showed the claim had never been tested. `classifyToolUse` returns
  // targets in step order, so counting per target restores the real sequence —
  // and now makes the equality genuinely unreachable.
  // REQUEST ORDER STANDS IN FOR WRITE ORDER, and that was measured, not assumed
  // (2026-09-26, 440 local transcripts). Calls issued together in ONE assistant
  // message could in principle run concurrently, so a hot refresh requested
  // after a note could land first. Their results, written in completion order,
  // never came back out of request order for writes: 0 of 553 pairs where both
  // calls target a hot.md or a wiki/ note, 0 of 1 290 MCP-write pairs, 0 of
  // 10 639 Write/Edit pairs. The same instrument does see concurrency where it
  // exists (181 batches of reads or read-only Bash come back out of order), so
  // the zero is a measurement, not a blind spot. No batch rule was added; if
  // write calls ever start running concurrently, this is where it goes.
  let idx = 0;
  for (const tu of toolUses) {
    for (const { vaultKey, vaultRootRaw, kind } of classifyToolUse(tu, ctx)) {
      const position = idx++;
      if (!vaultKey || kind === 'other') continue; // unresolvable or irrelevant → skip
      if (vaultRootRaw && !rawByKey.has(vaultKey)) rawByKey.set(vaultKey, vaultRootRaw);
      const cur = byVault.get(vaultKey) || { lastContent: -1, lastHot: -1 };
      if (kind === 'content') cur.lastContent = position;
      else if (kind === 'hot') cur.lastHot = position;
      byVault.set(vaultKey, cur);
    }
  }

  const stale = [];
  for (const [key, v] of byVault) {
    // Stale when content was written AND the latest content write is more
    // recent than the latest hot refresh (or there was none).
    if (v.lastContent >= 0 && v.lastContent > v.lastHot) {
      stale.push({ vaultKey: key, vaultRoot: rawByKey.get(key) || key });
    }
  }
  return { stale, byVault };
}
