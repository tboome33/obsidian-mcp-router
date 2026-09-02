/**
 * conversion-readiness — is the conversion toolbox actually usable on this
 * machine, and if not, what is the one thing to do about it?
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Several of the router's tools shell out to the `markitdown` Python CLI. It is
 * installed by an EXPLICIT opt-in (`npm run install-markitdown`) and never
 * automatically — a deliberate refusal, written down in the
 * `serveur-mcp-porte-par-le-plugin` decision: the router does not impose a
 * Python install on anyone.
 *
 * The cost of that refusal was a silence. Nothing told a new installer the
 * toolbox was dormant: `meta-setup` did not mention it, `meta-status` did not
 * check it, and the auto-update notice fires only for someone who USED to have
 * it (`will-break`) — never for `never-installed`. The only signal was an
 * ENOENT at the first conversion call, which is the worst possible moment: mid
 * task, and easily read as "these tools are broken" rather than "these tools
 * are not provisioned".
 *
 * PROPOSING IS NOT IMPOSING. Nothing here installs anything.
 *
 * ---------------------------------------------------------------------------
 * THE COUNT IS THE CLAIM, SO THE COUNT IS CHECKED
 * ---------------------------------------------------------------------------
 * The first version of this file said "10 tools". It was wrong, in the
 * direction that pushes someone toward a ~150 MB install they may not need —
 * exactly the pressure the no-imposition rule exists to avoid. Verified against
 * the handlers:
 *
 *   - `git_repo_to_markdown` does NOT use markitdown at all. It goes through
 *     `fromRepo` → repomix (`resolveRepomixCommand`). Removed.
 *   - `youtube_to_markdown` tries markitdown FIRST but falls back to yt-dlp
 *     captions, so it DEGRADES rather than dies. Listed separately.
 *
 * Eight tools stop working; one loses its primary path. Saying "nine, one of
 * which has a fallback" is both smaller and truer than "ten".
 *
 * And the fallback is qualified, not promised: yt-dlp is ANOTHER executable
 * this package does not install, so on the fresh machine these messages are
 * written for it may be absent too. "Falls back to yt-dlp captions, so it keeps
 * working only if yt-dlp is installed" is the honest form — an over-promise
 * pointed the reassuring way is still an over-promise.
 *
 * ---------------------------------------------------------------------------
 * CHEAP WHERE IT IS HOT, THOROUGH WHERE IT MATTERS
 * ---------------------------------------------------------------------------
 * {@link probeConversionToolbox} runs NO SUBPROCESS. It rides on `list_vaults`,
 * which the default-vault health-check convention calls at session start.
 *
 * "No subprocess" is not the same as "free", and the honest limit is stated
 * rather than implied: the PATH scan is synchronous `statSync`, so a PATH entry
 * on a dead network mount can block on an OS timeout. It is BOUNDED in both
 * directions (`MAX_PATH_CHARS` before the split, `MAX_PATH_ENTRIES` after) and
 * SKIPS UNC paths. That removes the worst case, NOT the whole class — a
 * disconnected mapped drive is indistinguishable from a local one by its
 * string. See {@link onPath} for why that residual risk is accepted rather than
 * papered over.
 *
 * {@link findPythonDetailed} DOES spawn. It is reserved for the error path and
 * the installers, where the answer changes what the reader should do next:
 * "Python 3.12 is here, one command away", "3.9 is here and is too old" and "we
 * could not find out" are three different problems, and sending someone to an
 * installer that will refuse is worse than saying nothing. Collapsing the third
 * into the second is how a message ends up asserting a fact about a machine
 * nobody ever measured.
 */

import fs from 'node:fs';
import { absolutizeExecutableOverride } from './subprocess-env.mjs';
import path from 'node:path';

import { subprocessOptions, withIsolatedCwd } from './subprocess-env.mjs';

/**
 * Tools that STOP WORKING without markitdown — verified against their handlers,
 * not inferred from their names.
 */
export const MARKITDOWN_TOOLS = Object.freeze([
  'pdf_to_markdown',
  'docx_to_markdown',
  'xlsx_to_markdown',
  'pptx_to_markdown',
  'image_to_markdown',
  'audio_to_markdown',
  'bing_search_to_markdown',
  'webpage_to_markdown',
]);

/**
 * Tools that DEGRADE rather than die: markitdown is their primary path, but
 * another one exists. Counted apart so the message never claims a tool is dead
 * when it merely lost its best route.
 */
export const MARKITDOWN_DEGRADED_TOOLS = Object.freeze(['youtube_to_markdown']);

/** The explicit "I know, leave me alone" opt-out, shared with the update notice. */
export const SKIP_ENV = 'OBSIDIAN_ROUTER_SKIP_MARKITDOWN';

/** Bound on the PATH scan — see the header on why this is not free. */
export const MAX_PATH_ENTRIES = 128;

/**
 * Bound on the PATH *string*, applied BEFORE splitting.
 *
 * Capping entries after `split()` does not bound the work: the split allocates
 * every substring first, so a pathological `PATH` costs its full length in
 * memory regardless of the entry cap. 64 KB is comfortably above any real
 * environment (Windows caps the whole block near 32 KB).
 */
export const MAX_PATH_CHARS = 65536;

/*
 * THE ERROR DIRECTION OF BOTH CAPS, STATED ON PURPOSE.
 *
 * The runtime hands the WHOLE `PATH` to `execFile`; this probe reads a bounded
 * slice of it. So a `markitdown` sitting in entry 129 is found by the runtime
 * and missed here, and the probe says "not installed" about a machine where
 * conversion works.
 *
 * That asymmetry is kept, because the two errors are not equal. Under-reporting
 * costs one unnecessary hint, which the user can ignore or silence. Over-
 * reporting puts a ✅ in front of someone whose next conversion call will fail
 * — the exact silence this whole module was written to end, restored with more
 * confidence than before. When the bound is wrong, it is wrong in the direction
 * that cannot mislead.
 */

/**
 * May this path be interpolated into a double-quoted shell command we are
 * about to SHOW A HUMAN TO PASTE?
 *
 * Counting quotes was not the test. Inside double quotes, both PowerShell and
 * POSIX shells still expand `$…`, and POSIX also runs backticks — so a directory
 * legally named `/tmp/router$(id)` or `C:\router$HOME` produces a "command" that
 * silently targets the wrong path or EXECUTES SOMETHING ELSE. We are not
 * escaping this: we are declining to emit it, and falling back to wording that
 * names no path at all. A hint the reader must retype is a small cost; a hint
 * that runs an attacker-chosen command when pasted is not a cost we take.
 *
 * `%` and `!` are listed for `cmd.exe`, which expands `%TEMP%` inside double
 * quotes and `!NAME!` when delayed expansion is on. The reader's shell is not
 * ours to choose, so the safe set is the intersection across all three.
 *
 * `;`, `&`, `|`, `(`, `)` are deliberately NOT listed — they are inert inside
 * double quotes, and rejecting them would refuse ordinary Windows paths for no
 * gain. What is listed is what survives quoting.
 */
export function isShellSafePath(p) {
  if (typeof p !== 'string' || !p) return false;
  // Backslashes are normalised to `/` FIRST: they are the ordinary Windows
  // separator, and inside double quotes PowerShell does not treat them as an
  // escape character (that role belongs to the backtick, which IS rejected).
  // Nothing below therefore needs to match one — and spelling a doubled
  // backslash here also reads as the start of a UNC path to the export gate.
  // A DOUBLED backslash is rejected BEFORE normalising: inside bash double
  // quotes `\\` collapses to a single one, which silently destroys a UNC
  // prefix (`\\server\share` becomes `\server\share`) and mangles any
  // doubled separator. Single backslashes are fine — bash treats one specially
  // only before `$`, a backtick, `"` or another backslash, and the first three
  // are already rejected below.
  if (p.includes(String.fromCharCode(92).repeat(2))) return false;
  const normalised = p.split(String.fromCharCode(92)).join('/');
  // eslint-disable-next-line no-control-regex
  return !/["$`%!\x00-\x1f]/.test(normalised);
}

/**
 * Is this override a PATH we can meaningfully stat, or a BARE COMMAND NAME?
 *
 * `MARKITDOWN_PATH=markitdown` is a legitimate, working configuration: the
 * runtime hands it to `execFile`, which searches `PATH`. Statting it resolves
 * against the CWD instead, finds nothing, and reports a healthy install as
 * broken — which is exactly what the first version of the override verification
 * did. A name with no separator and no drive letter is DELEGATED, not checked.
 */
function looksLikeFilesystemPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const t = p.trim();
  if (t.includes('/') || t.includes(String.fromCharCode(92))) return true;
  // `C:markitdown` — drive-relative, still a path. WINDOWS ONLY: on POSIX a
  // colon is an ordinary filename character, so `x:markitdown` is a bare
  // command name that execFile resolves through PATH, and statting it against
  // the CWD would report a working configuration broken.
  return process.platform === 'win32' && /^[A-Za-z]:/.test(t);
}

/**
 * A UNC path, where a synchronous stat can block for an OS network timeout.
 * Both slash forms, because Windows accepts either. The PATH scan already skips
 * these; verifying an override must not smuggle the hang back in on the very
 * call the session-start health check makes.
 */
function isUncPath(p) {
  if (typeof p !== 'string') return false;
  const t = p.trim();
  return t.startsWith(String.fromCharCode(92) + String.fromCharCode(92)) || t.startsWith('//');
}

/**
 * Can Windows' `execFile` spawn a file with THIS NAME at all?
 *
 * A pure string rule, so it holds for every tier — including the two the probe
 * deliberately does not stat (a bare command name, a UNC path), where the
 * previous extension check never ran. Two ways a name is unspawnable:
 *
 *  - `.cmd` / `.bat` are refused before execution since the CVE-2024-27980 fix
 *    (`ERR_CHILD_PROCESS_BAD_NAME`).
 *  - Anything that is not an executable IMAGE fails with `EFTYPE`. A `.ps1` is
 *    a script for a shell to read, not a program the OS can load; so is an
 *    extension-less file. Accepting "any regular file that is not .cmd" put a
 *    MEASURED green tick on `MARKITDOWN_PATH=…\build-mcpb.ps1`.
 */
function isWindowsSpawnableName(p) {
  if (process.platform !== 'win32') return true;
  // NOT trimmed. The runtime spawns the raw value, so ` markitdown.exe ` with
  // spaces is an ENOENT there and must be an ENOENT here — trimming for this
  // rule alone produced a green tick for a name the runtime could not resolve.
  // Windows STRIPS TRAILING DOTS from a path component, so `…\\where.` runs
  // `where.exe`. Treating the dot as an (empty) extension rejected a name the
  // runtime launches fine — probe and runtime disagreeing again, on a shape
  // nobody would guess.
  const name = String(p).replace(/\.+$/, '').toLowerCase();
  // Node refuses these outright (ERR_CHILD_PROCESS_BAD_NAME), wherever they sit
  // and however they are spelled.
  if (name.endsWith('.cmd') || name.endsWith('.bat')) return false;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(String.fromCharCode(92)));
  const dot = name.lastIndexOf('.');
  // NO EXTENSION → delegate. `MARKITDOWN_PATH=markitdown` is a working
  // configuration: `execFile` resolves it through PATH + PATHEXT, appending
  // `.exe` itself. Requiring the configured STRING to end in `.exe` rejected
  // that — a regression the previous round's fix introduced while closing the
  // `.ps1` hole.
  if (dot <= slash) return true;
  // An explicit extension that is not an executable image cannot be loaded:
  // a `.ps1` is a script for a shell to read, and execFile answers EFTYPE.
  return name.endsWith('.exe') || name.endsWith('.com');
}

/**
 * Does `candidate` exist as something this router could actually SPAWN?
 *
 * ONE DEFINITION, used by every tier that stats a file. The exec-bit rule first
 * landed in the PATH scan only, which left the bundled-venv tier answering the
 * older, weaker question — the same defect surviving in the branch nobody
 * looked at twice. A rule that holds in one of two places is not a rule.
 */
export function isRunnableFile(candidate, io) {
  // WINDOWS, NO EXTENSION: `execFile('C:\\Tools\\markitdown')` succeeds when
  // `markitdown.exe` is there — CreateProcess appends the extension. Statting
  // the bare path finds nothing and reported a working install broken, so try
  // what the OS would try. (`where` in System32 is the counterexample that
  // proved it: no extension in the path, runs fine, probe said missing.)
  if (process.platform === 'win32' && !/[.][^.\\/]*$/.test(candidate)) {
    return ['.exe', '.com'].some((ext) => isRunnableFile(candidate + ext, io));
  }
  try {
    const st = io.statSync(candidate);
    if (!st || !st.isFile()) return false;
    if (process.platform === 'win32') return isWindowsSpawnableName(candidate);
    if (typeof st.mode !== 'number') return true;
    // A NECESSARY condition, not a sufficient one. `mode 0100` owned by another
    // uid passes this and still gives EACCES — answering "may THIS process
    // execute it" needs the uid/gid comparison `access()` does, and doing that
    // synchronously per candidate is more than this hot path should spend. No
    // execute bit at all is the case worth catching: it is what a
    // half-completed install leaves behind, and it is unambiguous.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Is `markitdown` reachable on `PATH`, in a form this router can actually RUN?
 * Answered by SCANNING rather than spawning, so it stays usable on a hot path.
 *
 * THREE THINGS `existsSync` GETS WRONG, and all three are checked here instead:
 *  - A DIRECTORY named `markitdown` exists and is not an executable.
 *  - On POSIX, a REGULAR FILE named `markitdown` may have no execute bit — a
 *    mode-0644 file makes `execFile` fail with EACCES, so "it is a file" is not
 *    the question; "may I run it" is.
 *  - On Windows a `.cmd` / `.bat` shim exists and CANNOT BE SPAWNED: since the
 *    CVE-2024-27980 fix, `execFile` throws `ERR_CHILD_PROCESS_BAD_NAME` on
 *    those, and every Node this package supports (>=20.19.0) is past that fix.
 *    `resolveRepomixCommand` documents the same trap for repomix. Reporting one
 *    as "available" would promise a call that is guaranteed to fail.
 *
 * ON THE HANG RISK, HONESTLY. Skipping UNC entries removes the WORST case, not
 * the whole class: a disconnected mapped drive (`Z:\tools`) and a dead POSIX
 * network mount (`/mnt/nfs/bin`) look exactly like local paths and can still
 * block `statSync` for an OS timeout. This is an accepted residual risk, not a
 * solved problem — the alternative, an async stat, moves the block to a
 * threadpool thread but then stalls the `list_vaults` response itself, which is
 * the call this has to stay cheap for. If it ever bites, the fix is to drop the
 * PATH tier entirely (the venv and the explicit override both answer without
 * scanning), not to add a timeout this API cannot express.
 */
function onPath(env, io) {
  const rawPath = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '');
  if (!rawPath) return null;
  // Truncate BEFORE splitting — see MAX_PATH_CHARS. A truncated tail may leave
  // a partial final entry, which simply fails to match; that is the correct
  // outcome for a PATH already past any plausible real size.
  const raw = rawPath.length > MAX_PATH_CHARS ? rawPath.slice(0, MAX_PATH_CHARS) : rawPath;
  const isWin = process.platform === 'win32';
  // `.cmd` / `.bat` deliberately excluded on Windows — see above.
  const exts = isWin ? ['.exe', '.com'] : [''];
  const dirs = raw.split(isWin ? ';' : ':').slice(0, MAX_PATH_ENTRIES);
  for (const rawDir of dirs) {
    // Quoted entries are legal in a Windows PATH and must be unquoted, or the
    // candidate becomes `"C:\Tools"\markitdown.exe`, which matches nothing.
    const dir = isWin ? rawDir.replace(/^"+|"+$/g, '') : rawDir;
    if (!dir) continue;
    // A UNC entry is the worst of the synchronous-stat hang risk, and the only
    // part of it detectable from the string alone. Skipped: a missed detection
    // costs one unnecessary hint, a hang costs the session.
    if (dir.startsWith('\\\\') || dir.startsWith('//')) continue;
    for (const ext of exts) {
      // Missing, unreadable, a directory, or a file with no execute bit — none
      // of those is an answer. See `isRunnableFile`.
      const candidate = path.join(dir, `markitdown${ext}`);
      if (isRunnableFile(candidate, io)) return candidate;
    }
  }
  return null;
}

/**
 * What state the conversion toolbox is in, without running anything.
 *
 * NEVER THROWS — including when handed `null`, a Proxy, or an options object
 * whose getters throw. The whole argument handling is inside the try for that
 * reason: destructuring in the signature runs BEFORE any guard could, which is
 * how the previous version could still throw on `probeConversionToolbox(null)`.
 *
 * @param {{projectRoot?: string, env?: object, fs?: object}} [opts]
 * @returns {{
 *   available: boolean,
 *   via: 'env-override'|'bundled-venv'|'path'|null,
 *   path: string|null,
 *   verified: boolean,
 *   optedOut: boolean,
 *   toolsAffected: string[],
 *   toolsDegraded: string[],
 *   hint: string|null,
 * }}
 */
export function probeConversionToolbox(opts) {
  const base = {
    toolsAffected: [...MARKITDOWN_TOOLS],
    toolsDegraded: [...MARKITDOWN_DEGRADED_TOOLS],
  };
  const unknown = {
    ...base, available: false, via: null, path: null, verified: false, optedOut: false, hint: null,
  };
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const io = o.fs || fs;
    const projectRoot = typeof o.projectRoot === 'string' ? o.projectRoot : null;
    // A STRING, strictly. `String(x)` coerced a numeric 1 — and anything whose
    // `toString()` returns "1" — into an opt-out, which the docs said was
    // impossible. Real `process.env` only holds strings; the injectable seam
    // did not, and the claim has to be true of both.
    const optedOut = env[SKIP_ENV] === '1';

    // WHICH path is selected mirrors `resolveMarkitdownPath` exactly — same
    // truthiness test, same value, through the SAME resolver: a bare name or
    // an absolute path byte-for-byte (padding included), a relative path made
    // absolute against the router's cwd (v0.87.0, because the child now runs
    // in a throwaway directory). It must, because that function is what
    // actually runs, and a probe naming a different path than the one that
    // will be spawned is a readiness check that lies. Trimming here looked like
    // a courtesy and was a divergence: `MARKITDOWN_PATH=" /opt/markitdown "`
    // got reported ready at the trimmed path while the runtime spawned the
    // padded one and hit ENOENT. A `"   "` value is likewise truthy to the
    // runtime, so it must be truthy here too.
    //
    // WHETHER it will run is deliberately NOT mirrored — the runtime finds that
    // out by failing, and this exists to say so first.
    const configured = env.MARKITDOWN_PATH;
    const rawOverride = typeof configured === 'string' && configured ? absolutizeExecutableOverride(configured) : configured;
    if (typeof rawOverride === 'string' && rawOverride) {
      // Measured, not assumed. Reporting `available: true` for
      // `MARKITDOWN_PATH=Z:\gone\markitdown.exe` put a ✅ in front of the user
      // for a machine fact nobody had checked, and `meta-status` then stated it
      // as readiness — an override pointing at nothing is one of the likeliest
      // misconfigurations here, and one of the easiest to say plainly.
      //
      // …but only where measuring is meaningful AND safe. A bare command name
      // and a UNC path are taken on the user's word (see the two helpers
      // above), and `verified` records which answer was measured, so no surface
      // has to guess how much the tick is worth.
      //
      // THE NAME RULE IS CHECKED FIRST, because it needs no filesystem at all.
      // It therefore also covers the two tiers we decline to stat — where the
      // extension check previously never ran, so `MARKITDOWN_PATH=markitdown.cmd`
      // came back available for a call `execFile` refuses outright.
      if (!isWindowsSpawnableName(rawOverride)) {
        return {
          ...base,
          available: false,
          via: 'env-override',
          path: rawOverride,
          verified: true,
          optedOut,
          hint: optedOut ? null : overrideUnspawnableHint(rawOverride),
        };
      }
      const verifiable = looksLikeFilesystemPath(rawOverride) && !isUncPath(rawOverride);
      const usable = verifiable ? isRunnableFile(rawOverride, io) : true;
      return {
        ...base,
        available: usable,
        via: 'env-override',
        path: rawOverride,
        verified: verifiable,
        optedOut,
        hint: usable || optedOut ? null : overrideBrokenHint(rawOverride),
      };
    }

    const isWin = process.platform === 'win32';
    const venvBin = projectRoot
      ? path.join(projectRoot, '.venv', isWin ? 'Scripts' : 'bin', `markitdown${isWin ? '.exe' : ''}`)
      : null;
    // Same runnability question as the PATH tier — a `.venv` left behind by a
    // half-finished install can hold a `markitdown` that cannot be executed.
    if (venvBin && isRunnableFile(venvBin, io)) {
      return {
        ...base, available: true, via: 'bundled-venv', path: venvBin, verified: true, optedOut, hint: null,
      };
    }

    const found = onPath(env, io);
    if (found) {
      // The path is reported for diagnosis only. At call time the runtime uses
      // the bare name and lets execFile search — so naming this file as "the
      // one that will run" would be a claim this module cannot keep.
      return {
        ...base, available: true, via: 'path', path: found, verified: true, optedOut, hint: null,
      };
    }

    return {
      ...base,
      available: false,
      via: null,
      path: null,
      // We DID look, within the stated bounds — see the note on MAX_PATH_CHARS
      // for the direction this can be wrong in.
      verified: true,
      optedOut,
      // Silent for someone who has explicitly said they do not want it — the
      // same courtesy the auto-update notice already extends.
      hint: optedOut ? null : conversionHint(projectRoot),
    };
  } catch {
    // Unknown, and said as unknown rather than guessed either way.
    return unknown;
  }
}

/**
 * The single wording for "it is not there, here is the one command".
 *
 * IT NAMES A DIRECTORY WHEN IT KNOWS ONE. "Run `npm run install-markitdown` in
 * the router directory" is unactionable for the normal plugin install, where
 * the router lives under `${CLAUDE_PLUGIN_ROOT}` and the user has no checkout
 * to cd into — they would run it in an unrelated project, or provision the
 * wrong `.venv`. The auto-update notice already emits a cache-specific command;
 * this now does the same whenever the caller knows the root.
 */
/**
 * The wording for "you pointed MARKITDOWN_PATH at something that will not run".
 *
 * Kept separate from {@link conversionHint} because the action is different:
 * nobody needs to install anything here — they need to fix or unset one
 * variable. Telling them to run the installer would be advice for a problem
 * they do not have.
 */
/**
 * Name the directory a user needs to remove. THIS NEVER EMITS A COMMAND.
 *
 * It used to. The broken-venv message built `rm -rf "<dir>"` by interpolation
 * and skipped {@link isShellSafePath} — the guard added three rounds earlier for
 * the *install* command, missing from a recursive delete, so a project root
 * named `/srv/router$(touch X)` turned a diagnostic into command execution.
 * The next version added the guard and `-LiteralPath`, and review took that
 * apart too: `isShellSafePath` answers "can this be interpolated", which is not
 * the same question as "is this a legitimate deletion target". It accepted
 * `/` (→ `rm -rf "/"`), `-rf` (parsed as an option, since the command had no
 * `--`), `../.venv` (relative to wherever the reader happened to be), `~`
 * (quoted, so it targeted a literal `~` child), and a trailing backslash (which
 * escapes the closing quote in bash and leaves the command unterminated).
 *
 * SO THE GENERATOR IS GONE, rather than hardened a third time. Making a
 * destructive command safe needs target validation this module has no business
 * doing — resolve the path, require a `.venv` basename, refuse roots, add
 * `--`. The user does not need a command: they need to know WHICH directory is
 * broken. That is a sentence, it has no threat model, and the invariant is one
 * a reader can check at a glance: **this code never emits a deletion command.**
 */
export function removalInstruction(dir) {
  return `  The directory to remove is: ${describePathForDisplay(dir)}`;
}

/**
 * Render a path for a human to READ in terminal output — never to paste.
 *
 * Control characters are escaped, because raw interpolation is not a data
 * boundary: a directory legally named "a\n    rm -rf /" would print as two
 * lines and impersonate an instruction we never gave. An empty or non-string
 * value says so rather than printing nothing, which would leave the reader with
 * a sentence that names no target at all.
 */
function describePathForDisplay(p) {
  if (typeof p !== 'string' || p === '') return '(an empty path — nothing to show)';
  // C0 **and** DEL, C1, and the Unicode line separators. Escaping only
  // \x00-\x1f left U+0085 (NEL), U+2028 (LINE SEPARATOR) and U+2029 through —
  // and plenty of terminals break a line on those, so a directory named with
  // one could still print as two lines and impersonate an instruction. That is
  // the exact failure this function exists to prevent, surviving one range
  // beyond where the fix stopped.
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}


/**
 * The wording for "that name can never be spawned on Windows, wherever it is".
 * Separate from {@link overrideBrokenHint} because the problem is not the
 * location: a `.cmd` shim or a `.ps1` would fail even if it sat right there.
 */
function overrideUnspawnableHint(overridePath) {
  return `MARKITDOWN_PATH is set to "${overridePath}", which Windows cannot spawn directly `
    + `— Node refuses .cmd/.bat wrappers outright, and only a real executable image `
    + `(.exe/.com) can be launched. ${MARKITDOWN_TOOLS.length} conversion tools will fail `
    + `with that value. Point MARKITDOWN_PATH at the .exe itself (a pipx install has one `
    + `next to its shim), or unset it to fall back to the bundled .venv and PATH.`;
}

function overrideBrokenHint(overridePath) {
  return `MARKITDOWN_PATH is set to "${overridePath}", but nothing runnable is there `
    + `(missing, a directory, or not executable). ${MARKITDOWN_TOOLS.length} conversion `
    + `tools will fail with that value. Fix the path or unset MARKITDOWN_PATH to fall back `
    + `to the bundled .venv and PATH.`;
}

export function conversionHint(projectRoot = null) {
  const dead = MARKITDOWN_TOOLS.length;
  const script = projectRoot ? path.join(projectRoot, 'scripts', 'install-markitdown.mjs') : null;
  const command = isShellSafePath(script)
    ? `node "${script}"`
    : '`npm run install-markitdown` from the router install directory';
  return `${dead} conversion tools (${MARKITDOWN_TOOLS.slice(0, 3).join(', ')}, …) `
    + `need the markitdown Python CLI; the router never installs it on its own. `
    // NOT "still works". The fallback is yt-dlp, which is ANOTHER executable
    // this package does not install — so on the fresh machine this hint is
    // written for, it may be missing too. Claiming the tool is fine would be
    // the same over-promise as the original "ten tools" miscount, pointed the
    // other way.
    + `${MARKITDOWN_DEGRADED_TOOLS.join(', ')} falls back to yt-dlp captions, so it keeps `
    + `working only if yt-dlp is installed. `
    + `To enable them: ${command} (needs Python 3.10+), or set MARKITDOWN_PATH to an `
    + `existing install. Set ${SKIP_ENV}=1 to stop being told.`;
}

/**
 * Resolve a Python interpreter new enough for `markitdown[all]`.
 *
 * ONE DEFINITION. This logic lived in `install-markitdown.mjs` and was copied
 * into `install-docling.mjs` — whose own comment said "same logic as
 * install-markitdown.mjs", which is a copy admitting it is one. The error path
 * needed it too, and a third copy is how a rule ends up fixed in one place and
 * wrong in the others.
 *
 * THE RETURN DISTINGUISHES THREE ANSWERS, because a caller that collapses them
 * tells the user something false:
 *   - `{ok: true, …}`                  a usable interpreter.
 *   - `{ok: false, rejected: [...]}`   Python IS installed but too old. The
 *                                      installers used to print "found 3.9,
 *                                      needs 3.10+" and that must not be lost.
 *   - `{ok: false, rejected: [], checked: true}`   nothing suitable is here. The
 *                                      interpreters were genuinely ABSENT (every
 *                                      candidate failed with ENOENT), so "no
 *                                      Python 3.10+ on PATH" is a measured fact.
 *   - `{ok: false, rejected: [], checked: false}`  we never got to look — a
 *                                      permission error, a timeout, a broken
 *                                      shim. NOT the same as absent, and saying
 *                                      "no Python found" here would invent it.
 *
 * `checked` USED TO MEAN "a subprocess answered", which quietly reintroduced the
 * collapse from the other side: a machine with genuinely no Python reported
 * "could not determine". ENOENT is the OS telling us the answer, not refusing to
 * — so it counts as having looked.
 *
 * @param {{execFile?: Function, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: boolean, cmd?: string, version?: string, major?: number,
 *                    minor?: number, rejected: Array<{cmd: string, version: string}>,
 *                    checked: boolean}>}
 */
/**
 * The interpreter's own answer, which occupies a WHOLE LINE — `Python 3.12.1`.
 * A mention inside a sentence ("install Python 3.12 for support") is somebody
 * else talking, and must not be mistaken for it.
 */
function matchPythonVersion(stream) {
  // ANCHORED AT BOTH ENDS. Anchoring only the start still accepted
  // `Python 3.12 for support` — a wrapper's own sentence that happens to begin
  // with the word — as the interpreter's answer, over the real `Python 2.7.18`
  // on the next line. After the version there may be a patch component and then
  // either end-of-line or a parenthetical (PyPy prints
  // `Python 3.10.14 (main, …)`); prose is not one of the options.
  //
  // And the LAST match wins, not the first: the shape that keeps appearing is a
  // wrapper printing a notice before the interpreter finally identifies itself.
  const re = /^[\s\ufeff]*Python (\d+)\.(\d+)(?:\.\w+)?[^\S\r\n]*(?:\(|\r?$)/gm;
  const all = [...String(stream || '').matchAll(re)];
  return all.length ? all[all.length - 1] : null;
}

export async function findPythonDetailed(deps = {}) {
  const execFileAsync = deps && deps.execFile;
  const rejected = [];
  if (typeof execFileAsync !== 'function') return { ok: false, rejected, checked: false };
  // THE PROBE'S OWN ENVIRONMENT IS THE `python-probe` ALLOWLIST, and its cwd a
  // private throwaway directory (subprocess-env.mjs). This is the one child
  // this module spawns, and it inherited the router's whole process.env like
  // every other site did — a `--version` call carrying the workspace `.env`.
  return withIsolatedCwd('python-probe-', (cwd) => probeCandidates(execFileAsync, rejected, {
    cwd,
    // A bounded wait: a broken shim that hangs must not stall an error
    // message, which is the one place this runs on a user-visible path.
    timeout: Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 5000,
  }));
}

async function probeCandidates(execFileAsync, rejected, probeOptions) {
  // Every candidate must produce a CONCLUSIVE outcome — an answer, or an ENOENT
  // that means "this interpreter is not here". One inconclusive failure is
  // enough to make the whole result "we could not look".
  let conclusive = true;
  for (const candidate of ['python3', 'python']) {
    try {
      // BOTH STREAMS. `python --version` writes to stderr on Python 2.x, so
      // reading stdout alone turned "2.7 is here and is too old" — an
      // actionable, measured fact — into "could not determine".
      const { stdout, stderr } = await execFileAsync(candidate, ['--version'], subprocessOptions('python-probe', probeOptions));
      // ANCHORED TO A LINE START, and stdout is consulted first. An
      // unanchored search over both streams read
      // `warning: install Python 3.12 for support\nPython 2.7.18` as 3.12 —
      // taking a wrapper's advice for the interpreter's own answer, which is a
      // fresh false positive introduced by the fix that started reading stderr
      // at all (Python 2 announces itself there).
      const m = matchPythonVersion(stdout) || matchPythonVersion(stderr);
      if (!m) {
        // It RAN and we still do not know its version — a wrapper banner, a
        // version printed on stderr, a shim that prints nothing. That is the
        // "we could not find out" case, and an earlier version counted it as a
        // conclusion (and pinned that in a test). Saying "no Python 3.10+ on
        // PATH" here asserts something that was never measured.
        conclusive = false;
        continue;
      }
      const major = parseInt(m[1], 10);
      const minor = parseInt(m[2], 10);
      // 3.10+ on the 3.x line, or any future 4.x — so Python 4.0 is not
      // rejected the day it ships merely because `minor < 10`.
      if ((major === 3 && minor >= 10) || major > 3) {
        return { ok: true, cmd: candidate, version: `${major}.${minor}`, major, minor, rejected, checked: true };
      }
      rejected.push({ cmd: candidate, version: `${major}.${minor}` });
    } catch (e) {
      // ENOENT is an ANSWER — "that interpreter is not installed". Anything
      // else (EACCES, ETIMEDOUT, a shim that died) means we did not find out,
      // and the difference is the whole point of this function.
      if (e?.code !== 'ENOENT') conclusive = false;
    }
  }
  // ONE INCONCLUSIVE CANDIDATE INVALIDATES THE CONCLUSION — which is what the
  // invariant above says, and what `answered || conclusive` quietly broke:
  // python3 exiting 0 with unparseable output set `answered`, so a following
  // EACCES from `python` was swallowed and callers stated "No Python 3.10+
  // found" about a machine where one interpreter was never readable.
  //
  // An interpreter that DID run and did not identify itself as 3.10+ leaves
  // `conclusive` true, which is right: we asked, and nothing suitable answered.
  return { ok: false, rejected, checked: conclusive };
}

// THERE IS DELIBERATELY NO `findPython()` HERE.
//
// A `{cmd, version} | null` wrapper existed briefly, to keep the installers'
// call sites reading unchanged. It was removed rather than kept, because `null`
// is precisely the collapse this module exists to prevent: "too old" and "we
// could not look" both became nothing, and both installers then printed "No
// Python 3.10+ found on PATH" — a claim about the user's machine that, in the
// second case, no measurement supports. Callers take `findPythonDetailed` and
// branch on `ok` / `rejected` / `checked`.
//
// Leaving a convenience wrapper that models the defect is how the defect comes
// back: the next caller reaches for the shorter name.
