/**
 * Conversion readiness — the router proposes markitdown, and never imposes it.
 *
 * Three surfaces, one rule each:
 *   - `list_vaults` carries the state, WITHOUT a subprocess (it rides the
 *     session-start discovery call).
 *   - the ENOENT message says WHICH problem the reader has, because "one command
 *     away", "too old" and "could not check" are three different answers.
 *   - an explicit opt-out silences the lot.
 *
 * Several tests below exist because an adversarial review showed the first
 * version of this file passing without exercising anything.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import * as readiness from '../src/helpers/conversion-readiness.mjs';
import {
  probeConversionToolbox,
  findPythonDetailed,
  conversionHint,
  isShellSafePath,
  isRunnableFile,
  removalInstruction,
  MARKITDOWN_TOOLS,
  MARKITDOWN_DEGRADED_TOOLS,
  MAX_PATH_ENTRIES,
  MAX_PATH_CHARS,
  SKIP_ENV,
} from '../src/helpers/conversion-readiness.mjs';
import { missingMarkitdownMessage } from '../src/markdownify/markitdown.mjs';
import { resolveMarkitdownPath } from '../src/markdownify/utils.mjs';
import { listVaults } from '../src/tools/list-vaults.mjs';

const isWin = process.platform === 'win32';
const venvRel = path.join('.venv', isWin ? 'Scripts' : 'bin', `markitdown${isWin ? '.exe' : ''}`);

/** An fs stub where the listed paths are FILES and nothing else exists. */
const fsWith = (...files) => ({
  statSync: (p) => {
    if (!files.includes(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => true };
  },
});
/** An fs stub where the listed paths are DIRECTORIES. */
const fsDirs = (...dirs) => ({
  statSync: (p) => {
    if (!dirs.includes(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => false };
  },
});

describe('the tool lists — the count IS the claim', () => {
  test('git_repo_to_markdown is NOT listed: it uses repomix, not markitdown', () => {
    // The first version claimed 10 tools and included this one. Wrong, and
    // wrong in the direction that pushes someone toward a ~150 MB install —
    // exactly the pressure the no-imposition rule exists to avoid.
    assert.equal(MARKITDOWN_TOOLS.includes('git_repo_to_markdown'), false);
    assert.equal(MARKITDOWN_DEGRADED_TOOLS.includes('git_repo_to_markdown'), false);
  });

  test('youtube_to_markdown is DEGRADED, not dead — it has a yt-dlp fallback', () => {
    assert.equal(MARKITDOWN_TOOLS.includes('youtube_to_markdown'), false);
    assert.deepEqual([...MARKITDOWN_DEGRADED_TOOLS], ['youtube_to_markdown']);
  });

  test('PIN: the list is derived from the CODE, in BOTH directions', () => {
    // The previous version asserted only that a same-named function existed —
    // which proves nothing about what it calls, and could not notice a NINTH
    // markitdown caller that nobody added to the list. This partitions every
    // handler in convert.mjs by what it actually routes to, then compares the
    // whole partition against the two exported lists.
    // COMMENTS STRIPPED FIRST — otherwise prose decides the classification. The
    // remaining limit is stated rather than papered over: this is a textual
    // scan, not a call graph, so a handler that aliases the wrapper
    // (`const run = convertFile`) would be misfiled. The behavioural tests
    // below are what actually pin routing; this pins the LISTS against drift.
    const convert = fs.readFileSync(new URL('../src/tools/convert.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const snake = (fn) => fn.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    // Split the file into handler bodies: from one `export async function` to
    // the next. Good enough to attribute a call to its enclosing handler.
    const starts = [...convert.matchAll(/^export async function (\w+)\s*\(/gm)];
    assert.ok(starts.length > 8, 'handler scan found nothing — the parse broke, not the code');

    const routesToMarkitdown = new Set();
    const routesElsewhere = new Set();
    for (let i = 0; i < starts.length; i += 1) {
      const name = starts[i][1];
      const body = convert.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : convert.length);
      // `contains`, not `endsWith` — `pdfToMarkdownDocling` is a conversion
      // handler too, and it is one of the two exclusions this test proves.
      if (!name.includes('ToMarkdown')) continue;
      // convertFile / convertUrl are the two wrappers around markitdown's
      // toMarkdown(); a handler reaching either one dies without markitdown.
      if (/\b(convertFile|convertUrl|toMarkdown)\s*\(/.test(body)) routesToMarkitdown.add(snake(name));
      else routesElsewhere.add(snake(name));
    }

    // Every tool that reaches markitdown is accounted for, as dead OR degraded.
    const accounted = new Set([...MARKITDOWN_TOOLS, ...MARKITDOWN_DEGRADED_TOOLS]);
    for (const tool of routesToMarkitdown) {
      assert.ok(accounted.has(tool), `${tool} routes through markitdown but is in neither list`);
    }
    // …and nothing is listed that does NOT reach it. This is the direction the
    // original ten-tool claim failed.
    for (const tool of accounted) {
      assert.ok(routesToMarkitdown.has(tool), `${tool} is listed but does not route through markitdown`);
    }
    // The two famous exclusions, named so a future reader sees them tested.
    assert.ok(routesElsewhere.has('git_repo_to_markdown'), 'git_repo must NOT route through markitdown');
    assert.ok(routesElsewhere.has('pdf_to_markdown_docling'), 'docling must NOT route through markitdown');
    // Degraded means it reaches markitdown AND actually TAKES a second route.
    // Matching the word "fallback" in the handler was vacuous — comments and a
    // variable name satisfy it, so deleting the call still passed.
    const yt = convert.slice(convert.indexOf('export async function youtubeToMarkdown'));
    const ytBody = yt.slice(0, yt.indexOf('\nexport ', 1));
    assert.match(ytBody, /\bcatch\b[\s\S]*?\bawait\s+fallback\s*\(/,
      'youtube must actually CALL its fallback when the primary throws');
  });

  test('PIN: the degraded tool really recovers — behaviour, not source text', async () => {
    // The strongest form: run the handler with a primary that throws and prove
    // the fallback result comes back. If youtube ever stops degrading, this
    // fails no matter how the source is worded.
    const { youtubeToMarkdown } = await import('../src/tools/convert.mjs');
    const out = await youtubeToMarkdown(null, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, {
      primary: () => { throw Object.assign(new Error('markitdown ENOENT'), { code: 'ENOENT' }); },
      fallback: async () => '# captions',
    });
    assert.equal(out, '# captions', 'the degraded path must produce a result');
  });

  test('the hint QUALIFIES the fallback instead of promising it', () => {
    const h = conversionHint();
    assert.match(h, new RegExp(`^${MARKITDOWN_TOOLS.length} conversion tools`));
    // "still works through its yt-dlp fallback" was an over-promise: yt-dlp is
    // ANOTHER executable the router does not install, so on the fresh machine
    // this hint addresses it may be missing too.
    assert.equal(/still works through its yt-dlp fallback/.test(h), false);
    assert.match(h, /only if yt-dlp is installed/);
  });
});

describe('probeConversionToolbox — what is installed, without running anything', () => {
  test('PIN: NO SUBPROCESS — the module cannot spawn, and the probe never tries', () => {
    // The previous version of this test asserted the return held a boolean,
    // which an internally added spawn would also satisfy. This reads the source.
    const src = fs.readFileSync(new URL('../src/helpers/conversion-readiness.mjs', import.meta.url), 'utf8');
    // Module-wide, and deliberately not scoped to one function: the string
    // `child_process` appears NOWHERE, so no static import, no `require`, and
    // no dynamic `import('node:child_process')` either. The one function that
    // does run a child (findPythonDetailed) can only do it with an execFile its
    // caller hands in — which is the second half of this test.
    assert.equal(src.includes('child_process'), false, 'the module must not reach child_process');
    // Behavioural half: hand the probe a spawner and prove it is never used.
    let spawned = 0;
    probeConversionToolbox({
      projectRoot: '/root', env: { PATH: '/nope' }, fs: fsWith(),
      execFile: () => { spawned += 1; }, exec: () => { spawned += 1; },
    });
    assert.equal(spawned, 0, 'the probe must not reach for a subprocess');
  });

  test('the bundled venv is found', () => {
    const venv = path.join('/root', venvRel);
    const r = probeConversionToolbox({ projectRoot: '/root', env: {}, fs: fsWith(venv) });
    assert.equal(r.available, true);
    assert.equal(r.via, 'bundled-venv');
    assert.equal(r.hint, null);
  });

  test('a DIRECTORY named markitdown is not an executable', () => {
    const venv = path.join('/root', venvRel);
    const r = probeConversionToolbox({ projectRoot: '/root', env: {}, fs: fsDirs(venv) });
    assert.equal(r.available, false, 'existsSync would have said yes here');
  });

  // On Windows only a real executable image can be spawned, so an override must
  // carry `.exe` to be plausible there. Every override fixture below is built
  // from this so the suite tests the platform it runs on, not a POSIX fiction.
  const exeSuffix = isWin ? '.exe' : '';

  test('MARKITDOWN_PATH decides WHICH path runs, and whether it runs is MEASURED', () => {
    const good = `/opt/pipx/bin/markitdown${exeSuffix}`;
    const r = probeConversionToolbox({
      projectRoot: '/root', env: { MARKITDOWN_PATH: good }, fs: fsWith(good),
    });
    assert.equal(r.available, true);
    assert.equal(r.via, 'env-override');
    assert.equal(r.path, good);
  });

  test('an override pointing at NOTHING is not "ready" — that was an unmeasured ✅', () => {
    const gone = '/opt/gone/markitdown';
    const r = probeConversionToolbox({
      projectRoot: '/root', env: { MARKITDOWN_PATH: gone }, fs: fsWith(),
    });
    assert.equal(r.available, false, 'meta-status would have printed a green tick for this');
    assert.equal(r.via, 'env-override', 'the tier is still the override — that IS what will run');
    assert.equal(r.path, gone, 'and the path still mirrors the runtime');
    // …and the advice matches the actual problem: fix a variable, not install.
    assert.match(r.hint, /MARKITDOWN_PATH is set to/);
    assert.equal(/install-markitdown/.test(r.hint), false, 'installing fixes nothing here');
  });

  test('PIN: the Windows extension-less RECURSION is exercised, not just delegated', () => {
    // The test below covers a BARE name, which is delegated without ever
    // calling isRunnableFile — so deleting the `.exe` recursion left it green.
    // This one uses a PATH, which does reach the recursion.
    const exe = 'C:\\Tools\\markitdown.exe';
    const io = {
      statSync: (p) => {
        if (String(p) !== exe) throw Object.assign(new Error('x'), { code: 'ENOENT' });
        return { isFile: () => true };
      },
    };
    const bare = isRunnableFile('C:\\Tools\\markitdown', io);
    assert.equal(bare, isWin, isWin
      ? 'CreateProcess appends .exe — the probe must too'
      : 'POSIX appends nothing');
    // …and it must terminate: no runaway recursion on hostile shapes.
    let calls = 0;
    const counting = { statSync: () => { calls += 1; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
    for (const p of ['C:\\Tools\\markitdown', 'C:\\Tools\\', 'C:\\Tools\\...', '']) {
      calls = 0;
      assert.doesNotThrow(() => isRunnableFile(p, counting));
      assert.ok(calls <= 4, `${JSON.stringify(p)} caused ${calls} stats — recursion is not bounded`);
    }
  });

  test('REGRESSION: a bare `markitdown` (NO extension) works on Windows too', () => {
    // Round 5's `.ps1` fix required the configured STRING to end in .exe, which
    // rejected `MARKITDOWN_PATH=markitdown` — a working setup, because execFile
    // resolves it through PATH + PATHEXT and appends `.exe` itself. The test
    // below used to paper over this by appending `.exe` on Windows, so the
    // named behaviour was already deleted while the test stayed green.
    const r = probeConversionToolbox({
      projectRoot: '/root', env: { MARKITDOWN_PATH: 'markitdown' }, fs: fsWith(),
    });
    assert.equal(r.available, true, 'an extension-less bare name must be delegated');
    assert.equal(r.verified, false);
  });

  test('an explicit .cmd is refused in EVERY tier, statted or not', () => {
    // Node refuses .cmd/.bat outright, so the tier that declines to stat must
    // still refuse them — this is a string fact, not a filesystem one.
    for (const value of ['markitdown.cmd', 'C:\\Tools\\markitdown.bat',
      `${'\\'}${'\\'}srv${'\\'}s${'\\'}markitdown.cmd`]) {
      const r = probeConversionToolbox({
        projectRoot: '/root', env: { MARKITDOWN_PATH: value }, fs: fsWith(value),
      });
      if (isWin) {
        assert.equal(r.available, false, `${value} cannot be spawned by execFile`);
        assert.match(r.hint, /cannot spawn directly/);
      }
    }
  });

  if (isWin) {
    test('WINDOWS: a PADDED name is not laundered by trimming', () => {
      // The name rule trimmed while the runtime does not, so `" markitdown.exe "`
      // came back available for a value that ENOENTs at spawn.
      const r = probeConversionToolbox({
        projectRoot: '/root', env: { MARKITDOWN_PATH: ' markitdown.exe ' }, fs: fsWith(),
      });
      assert.equal(r.available, false, 'the runtime spawns the padded string and fails');
    });
  }

  test('REGRESSION: a BARE COMMAND override is not statted — the runtime resolves it', () => {
    // `MARKITDOWN_PATH=markitdown` is a working configuration: execFile searches
    // PATH. Verifying it as a filesystem path resolved it against the CWD, found
    // nothing, and told a healthy install that all eight tools would fail — a
    // regression introduced BY the verification that fixed the false ✅.
    let statted = 0;
    const io = { statSync: () => { statted += 1; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
    const r = probeConversionToolbox({
      projectRoot: '/root', env: { MARKITDOWN_PATH: `markitdown${exeSuffix}` }, fs: io,
    });
    assert.equal(r.available, true, 'a bare command name must be delegated, not stat-checked');
    assert.equal(r.verified, false, 'and it must be marked as taken on trust');
    assert.equal(statted, 0, 'nothing should have been statted');
  });

  test('a UNC override is NOT statted — that stat can hang the session-start call', () => {
    // The PATH scan already skips UNC for this reason; verifying the override
    // must not smuggle the hang back onto the same hot path.
    let statted = 0;
    const io = { statSync: () => { statted += 1; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
    const unc = `${'\\'}${'\\'}dead-server${'\\'}share${'\\'}markitdown.exe`;
    const r = probeConversionToolbox({ projectRoot: '/root', env: { MARKITDOWN_PATH: unc }, fs: io });
    assert.equal(statted, 0, 'a UNC override must never be statted');
    assert.equal(r.available, true);
    assert.equal(r.verified, false);
  });

  test('every result carries `verified`, so no surface has to guess', () => {
    const shapes = [
      probeConversionToolbox(null),
      probeConversionToolbox({ projectRoot: '/root', env: { PATH: '/nope' }, fs: fsWith() }),
      probeConversionToolbox({ projectRoot: '/root', env: { MARKITDOWN_PATH: 'markitdown' }, fs: fsWith() }),
    ];
    for (const s of shapes) assert.equal(typeof s.verified, 'boolean');
  });

  if (isWin) {
    test('WINDOWS: a .cmd OVERRIDE is not runnable either — execFile cannot spawn it', () => {
      // The exclusion lived only in the PATH scan, which tries .exe/.com and so
      // never meets a shim. The override tier arrives with whatever the user
      // named, and reported a guaranteed-to-fail call as ready.
      const shim = 'C:\\Tools\\markitdown.cmd';
      const r = probeConversionToolbox({
        projectRoot: '/root', env: { MARKITDOWN_PATH: shim }, fs: fsWith(shim),
      });
      assert.equal(r.available, false, 'a .cmd shim cannot be spawned by execFile');
      assert.equal(r.verified, true, 'and this one WAS measured');
    });
  }

  test('a broken override stays SILENT for someone who opted out', () => {
    const r = probeConversionToolbox({
      projectRoot: '/root',
      env: { MARKITDOWN_PATH: '/opt/gone/markitdown', [SKIP_ENV]: '1' },
      fs: fsWith(),
    });
    assert.equal(r.optedOut, true);
    assert.equal(r.hint, null);
  });

  test('a non-string MARKITDOWN_PATH is ignored rather than coerced', () => {
    const r = probeConversionToolbox({ projectRoot: '/root', env: { MARKITDOWN_PATH: 42 }, fs: fsWith() });
    assert.equal(r.via, null);
  });

  test('PIN: the probe reports the SAME override path the runtime will spawn', () => {
    // A readiness check that names a different path than the one that runs is a
    // check that lies. The probe used to `.trim()` the override while
    // resolveMarkitdownPath did not, so a padded value was reported ready at
    // the trimmed path and then ENOENTed at the padded one.
    const saved = process.env.MARKITDOWN_PATH;
    try {
      // v0.87.0: a RELATIVE override is resolved against the router's cwd before
      // the spawn (the child runs in a throwaway directory), by the runtime AND
      // by the probe — through the same resolver, or they disagree again.
      for (const value of ['/opt/bin/markitdown', ' /opt/bin/markitdown ', '   ', 'C:\\Tools\\markitdown.exe', './tools/markitdown', 'venv/bin/markitdown', 'markitdown']) {
        process.env.MARKITDOWN_PATH = value;
        const runtime = resolveMarkitdownPath('/root');
        const probe = probeConversionToolbox({ projectRoot: '/root', env: process.env, fs: fsWith() });
        assert.equal(probe.via, 'env-override', `${JSON.stringify(value)} must take the override branch`);
        assert.equal(probe.path, runtime, `probe and runtime disagree for ${JSON.stringify(value)}`);
      }
    } finally {
      if (saved === undefined) delete process.env.MARKITDOWN_PATH;
      else process.env.MARKITDOWN_PATH = saved;
    }
  });

  if (isWin) {
    test('WINDOWS: a .cmd shim is NOT reported available — execFile cannot spawn it', () => {
      // Since the CVE-2024-27980 fix, execFile throws ERR_CHILD_PROCESS_BAD_NAME
      // on .cmd/.bat, and every supported Node (>=20.19.0) is past it. The repo
      // documents the same trap for repomix.
      const shim = path.join('C:\\Tools', 'markitdown.cmd');
      const r = probeConversionToolbox({ projectRoot: '/root', env: { PATH: 'C:\\Tools' }, fs: fsWith(shim) });
      assert.equal(r.available, false);
    });

    test('WINDOWS: a QUOTED PATH entry is unquoted before joining', () => {
      const exe = path.join('C:\\Tools', 'markitdown.exe');
      const r = probeConversionToolbox({ projectRoot: '/root', env: { PATH: '"C:\\Tools"' }, fs: fsWith(exe) });
      assert.equal(r.available, true);
      assert.equal(r.via, 'path');
    });
  }

  test('a UNC PATH entry is SKIPPED — a synchronous stat there can hang the event loop', () => {
    const statted = [];
    const io = {
      statSync: (p) => { statted.push(String(p)); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    };
    probeConversionToolbox({ projectRoot: null, env: { PATH: '\\\\server\\share' }, fs: io });
    assert.equal(statted.some((p) => p.includes('server')), false, 'the UNC entry was never statted');
  });

  test('the PATH scan is BOUNDED — in stats AND in the string it splits', () => {
    let calls = 0;
    const io = {
      statSync: () => { calls += 1; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    };
    const sep = isWin ? ';' : ':';
    const huge = Array.from({ length: 5000 }, (_, i) => `/d${i}`).join(sep);
    probeConversionToolbox({ projectRoot: null, env: { PATH: huge }, fs: io });
    const perEntry = isWin ? 2 : 1; // .exe + .com on Windows
    assert.ok(calls <= MAX_PATH_ENTRIES * perEntry, `${calls} stats for 5000 entries — not bounded`);

    // Counting stats alone was NOT enough: `split()` allocates every substring
    // before `slice()` discards them, so an entry cap bounds the I/O while the
    // parse stays proportional to the whole string. The truncation happens
    // first now — proven by a PATH whose only real entry sits past the cap.
    const marker = path.join('/hit', 'markitdown');
    const padded = 'x'.repeat(MAX_PATH_CHARS) + sep + '/hit';
    const r = probeConversionToolbox({ projectRoot: null, env: { PATH: padded }, fs: fsWith(marker) });
    assert.equal(r.available, false, 'an entry beyond MAX_PATH_CHARS must never be reached');
  });

  test('POSIX: the exec-bit rule holds in the VENV tier too, not just on PATH', () => {
    // The rule first landed only in the PATH scan, leaving the bundled-venv
    // tier answering the older, weaker "is it a file" question — the same
    // defect surviving in the branch nobody looked at twice.
    const venv = path.join('/root', venvRel);
    const modeFs = (mode) => ({
      statSync: (p) => {
        if (String(p) !== venv) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true, mode };
      },
    });
    assert.equal(
      probeConversionToolbox({ projectRoot: '/root', env: {}, fs: modeFs(0o100755) }).available,
      true, 'an executable venv binary must count',
    );
    assert.equal(
      probeConversionToolbox({ projectRoot: '/root', env: {}, fs: modeFs(0o100644) }).available,
      isWin, 'on POSIX a non-executable venv binary must NOT count',
    );
  });

  test('POSIX: a file with NO EXECUTE BIT is not an available tool', () => {
    // execFile on a mode-0644 file fails with EACCES. "It is a regular file"
    // was the wrong question; "may I run it" is the right one.
    const exe = path.join('/bin', 'markitdown');
    const modeFs = (mode) => ({
      statSync: (p) => {
        if (String(p) !== exe) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true, mode };
      },
    });
    const readable = probeConversionToolbox({ projectRoot: null, env: { PATH: '/bin' }, fs: modeFs(0o100644) });
    const runnable = probeConversionToolbox({ projectRoot: null, env: { PATH: '/bin' }, fs: modeFs(0o100755) });
    if (isWin) {
      // Windows has no execute bit; both must still resolve by extension rules.
      assert.equal(readable.available, false, 'no markitdown.exe on this fake PATH');
    } else {
      assert.equal(readable.available, false, 'a non-executable file must not count');
      assert.equal(runnable.available, true, 'an executable one must');
    }
  });

  test('nothing anywhere → not available, with an actionable hint', () => {
    const r = probeConversionToolbox({ projectRoot: '/root', env: { PATH: '/nope' }, fs: fsWith() });
    assert.equal(r.available, false);
    assert.match(r.hint, /never installs it on its own/);
  });

  test('the hint NAMES A REAL COMMAND when the root is known', () => {
    // "Run it in the router directory" is unactionable for a plugin-cache
    // install, where the user has no checkout to cd into.
    const r = probeConversionToolbox({ projectRoot: '/opt/router', env: { PATH: '/nope' }, fs: fsWith() });
    assert.match(r.hint, /install-markitdown\.mjs/);
    assert.ok(r.hint.includes(path.join('/opt/router', 'scripts')), 'the actual root appears');
    // Every emitted command must be paste-able: balanced quotes, no exceptions.
    const quotes = (r.hint.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, 'unbalanced quoting in the generated command');
  });

  test('a root a SHELL WOULD REINTERPRET is never interpolated into a command', () => {
    // Counting quotes was not the test. Inside double quotes both PowerShell
    // and POSIX still expand `$…`, and POSIX runs backticks — so these paths
    // would target the wrong place or EXECUTE SOMETHING ELSE when pasted.
    // `%TEMP%` and `!NAME!` are cmd.exe's expansions, and cmd expands them
    // inside double quotes too — the reader's shell is not ours to choose.
    const unsafe = ['/tmp/router"broken', '/tmp/router$(id)', '/tmp/router`whoami`',
      'C:\\router$HOME', 'C:\\router%TEMP%', 'C:\\router!NAME!'];
    for (const root of unsafe) {
      const h = conversionHint(root);
      assert.equal(h.includes(root), false, `${root} must not be interpolated`);
      assert.match(h, /npm run install-markitdown/, `${root} must fall back`);
    }
    // Ordinary paths still get the specific command, including Windows ones and
    // characters that are inert inside double quotes.
    for (const root of ['/opt/router', 'C:\\Program Files\\router', '/tmp/router;rm -rf x']) {
      assert.ok(conversionHint(root).includes(`node "`), `${root} should still get a real command`);
    }
  });

  test('DOUBLED backslashes are refused — bash collapses them inside double quotes', () => {
    // `\\server\share` pasted into bash double quotes becomes `\server\share`:
    // the UNC prefix is destroyed and the command targets something else. No
    // fixture exercised this, so deleting the guard survived.
    const unc = `${'\\'}${'\\'}server${'\\'}share${'\\'}router`;
    assert.equal(isShellSafePath(unc), false, 'a UNC root must not be interpolated');
    assert.equal(conversionHint(unc).includes('server'), false);
    // …while an ordinary single-separator Windows path still gets a real command.
    assert.equal(isShellSafePath('C:\\Program Files\\router'), true);
  });

  test('NO DELETION COMMAND IS EVER EMITTED — for any input at all', () => {
    // Two rounds tried to make a safe `rm -rf`. The first interpolated without
    // any guard (`/srv/router$(touch X)` executed). The second added the
    // quoting guard and `-LiteralPath`, and review took that apart too:
    // `isShellSafePath` answers "can this be interpolated", NOT "is this a
    // legitimate deletion target". It accepted `/`, `-rf` (an option, since the
    // command had no `--`), `../.venv`, `~`, and a trailing backslash that
    // escapes the closing quote in bash.
    //
    // So the generator is gone. The invariant is now one a reader can check at
    // a glance, and this test is its enforcement.
    const inputs = ['/', '-rf', '~', '../.venv', 'C:\\', 'trailing\\', '',
      '/srv/router$(touch PWNED)/.venv', 'a\nrm -rf /', 'a\r\nrm -rf /', '\u0000',
      // Unicode line separators. Escaping only \x00-\x1f left these through, and
      // terminals that break on them would print a second line the router never
      // wrote — the same impersonation, one range past where the fix stopped.
      '\u0085next-line', '\u2028line-sep', '\u2029para-sep', '\u009fc1',
      null, undefined, 42, {}, []];
    for (const p of inputs) {
      const out = removalInstruction(p);
      assert.equal(/\brm\b|Remove-Item|rmdir|del\s/.test(out), false,
        `a deletion command was emitted for ${JSON.stringify(p)}`);
      assert.equal(/[\r\n\u0085\u2028\u2029]/.test(out), false,
        `${JSON.stringify(p)} produced more than one line — it could impersonate an instruction`);
      // eslint-disable-next-line no-control-regex
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(out), false,
        `${JSON.stringify(p)} leaked a raw control character into terminal output`);
    }
    // An empty target says so rather than naming nothing.
    assert.match(removalInstruction(''), /empty path/);
    // A normal path is shown plainly.
    assert.ok(removalInstruction('/opt/router/.venv').includes('/opt/router/.venv'));
  });

  test('BOTH installers route their removal advice through that helper', () => {
    for (const p of ['../scripts/install-markitdown.mjs', '../scripts/install-docling.mjs']) {
      const src = fs.readFileSync(new URL(p, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      assert.match(src, /removalInstruction\(VENV_DIR\)/, `${p} must not hand-build a delete`);
      assert.equal(/rm -rf/.test(src), false, `${p} must not interpolate its own rm`);
      assert.equal(/Remove-Item/.test(src), false, `${p} must not interpolate its own Remove-Item`);
      // …and the broken-marker branch must RETURN, not fall through into a
      // `python -m venv` that cannot replace what is already there.
      assert.match(src, /Re-running[\s\S]{0,200}removalInstruction\(VENV_DIR\),\s*\);\s*return;/,
        `${p}: the broken-marker branch must bail`);
    }
  });

  test('the SAME rule guards the ENOENT message, not just the hint', async () => {
    const msg = await missingMarkitdownMessage('markitdown', {
      execFile: async () => ({ stdout: 'Python 3.12' }),
      projectRoot: '/tmp/router$(id)',
    });
    assert.equal(msg.includes('$(id)'), false, 'a shell-expanding path must not reach the message');
    assert.match(msg, /npm run install-markitdown/);
  });

  test('AN EXPLICIT OPT-OUT SILENCES THE HINT', () => {
    const r = probeConversionToolbox({
      projectRoot: '/root', env: { PATH: '/nope', [SKIP_ENV]: '1' }, fs: fsWith(),
    });
    assert.equal(r.optedOut, true);
    assert.equal(r.hint, null);
  });

  test('ONLY the exact string "1" opts out — a number 1 does not', () => {
    for (const v of ['true', '0', 'yes', '', 1, { toString: () => '1' }]) {
      const r = probeConversionToolbox({
        projectRoot: '/root', env: { PATH: '/nope', [SKIP_ENV]: v }, fs: fsWith(),
      });
      assert.equal(r.optedOut, false, `${typeof v} ${String(v)} must not opt out`);
    }
  });

  test('it NEVER throws — including on null, and on options whose getters throw', () => {
    // The previous version destructured in the signature, so `probe(null)` threw
    // before any guard could run, while its test only covered a hostile `fs`.
    assert.doesNotThrow(() => probeConversionToolbox(null));
    assert.doesNotThrow(() => probeConversionToolbox());
    assert.doesNotThrow(() => probeConversionToolbox({ get env() { throw new TypeError('boom'); } }));
    assert.doesNotThrow(() => probeConversionToolbox({
      projectRoot: '/r', env: {}, fs: { statSync() { throw new TypeError('boom'); } },
    }));
    // The shape survives a failure. Asserted on a probe whose options blow up,
    // NOT on `probe(null)` — that one reads the real machine, so on a developer
    // box that HAS markitdown it would assert the opposite of what it means.
    const r = probeConversionToolbox({ get env() { throw new TypeError('boom'); } });
    assert.equal(r.available, false);
    assert.equal(r.via, null);
    assert.equal(r.hint, null);
    assert.deepEqual(r.toolsAffected, [...MARKITDOWN_TOOLS], 'the lists survive the failure');
    assert.deepEqual(r.toolsDegraded, [...MARKITDOWN_DEGRADED_TOOLS]);
  });
});

describe('findPythonDetailed — three answers, not two', () => {
  const ok = (out) => async () => ({ stdout: out });

  test('a usable interpreter', async () => {
    const r = await findPythonDetailed({ execFile: ok('Python 3.12.1\n') });
    assert.equal(r.ok, true);
    assert.equal(r.version, '3.12');
  });

  test('TOO OLD is not the same as ABSENT — the rejected version travels', async () => {
    // The installers printed "found 3.9, needs 3.10+". Collapsing that into
    // null told a user with Python 3.9 that no Python was found.
    const r = await findPythonDetailed({ execFile: ok('Python 3.9.6\n') });
    assert.equal(r.ok, false);
    assert.equal(r.checked, true);
    assert.deepEqual(r.rejected.map((x) => x.version), ['3.9', '3.9']);
  });

  test('COULD NOT LOOK is not the same as ABSENT either', async () => {
    const r = await findPythonDetailed({
      execFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.checked, false, 'nothing answered, so nothing was learned');
  });

  test('GENUINELY ABSENT is a measured fact — ENOENT counts as having looked', async () => {
    // The first repair overshot: treating every failure as "could not look"
    // fixed the EACCES lie by telling a new one to the machine that really has
    // no Python. ENOENT is the OS answering, not refusing to answer.
    const r = await findPythonDetailed({
      execFile: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.rejected, []);
    assert.equal(r.checked, true, 'ENOENT everywhere means Python is absent, and we know it');
  });

  test('one INCONCLUSIVE candidate makes the whole answer inconclusive', async () => {
    // python3 missing (an answer) but python unreadable (not an answer) is not
    // enough to conclude absence.
    let call = 0;
    const r = await findPythonDetailed({
      execFile: async () => {
        call += 1;
        throw Object.assign(new Error('x'), { code: call === 1 ? 'ENOENT' : 'EACCES' });
      },
    });
    assert.equal(r.checked, false);
  });

  test('an UNPARSEABLE answer does not launder a later EACCES into a conclusion', async () => {
    // `checked: answered || conclusive` broke its own invariant: python3 exiting
    // 0 with garbage set `answered`, so the EACCES from `python` was swallowed
    // and callers stated "No Python 3.10+ found" about a machine where one
    // interpreter was never readable.
    let call = 0;
    const r = await findPythonDetailed({
      execFile: async () => {
        call += 1;
        if (call === 1) return { stdout: 'some wrapper banner\n' };
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      },
    });
    assert.equal(r.checked, false, 'one unreadable candidate means we did not find out');
  });

  test('a version MENTIONED IN A WARNING is not the interpreter answering', async () => {
    // Reading stderr (needed for Python 2) immediately created a new false
    // positive: an unanchored search read `warning: install Python 3.12 for
    // support\nPython 2.7.18` as 3.12 — a wrapper's advice mistaken for the
    // interpreter's own answer. The version occupies a whole line; a mention
    // inside a sentence is somebody else talking.
    const r = await findPythonDetailed({
      execFile: async () => ({
        stdout: '',
        stderr: 'warning: install Python 3.12 for support\nPython 2.7.18\n',
      }),
    });
    assert.equal(r.ok, false, '2.7 is not usable, whatever the warning suggested');
    assert.deepEqual(r.rejected.map((x) => x.version), ['2.7', '2.7']);
  });

  test('…including a wrapper line that STARTS with the word Python', async () => {
    // The `warning:` prefix above was the easy case — a start-of-line anchor
    // already rejected it. This is the one that survived: a wrapper sentence
    // whose own first word is `Python`, above the interpreter's real answer.
    const r = await findPythonDetailed({
      execFile: async () => ({ stdout: 'Python 3.12 for support\r\nPython 2.7.18\r\n', stderr: '' }),
    });
    assert.equal(r.ok, false, 'prose is not a version line, wherever it starts');
    assert.deepEqual(r.rejected.map((x) => x.version), ['2.7', '2.7']);
  });

  test('a PyPy-style parenthetical is still a version line', async () => {
    // The complement: tightening the match must not reject real interpreters.
    // PyPy and some CPython builds print `Python 3.10.14 (main, …)`.
    const r = await findPythonDetailed({
      execFile: async () => ({ stdout: 'Python 3.10.14 (main, Sep  1 2026, 10:00:00)\n', stderr: '' }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.version, '3.10');
  });

  test('a version printed on STDERR is read — Python 2 does exactly that', async () => {
    // `python --version` writes to stderr on 2.x. Reading stdout alone turned
    // "2.7 is here and is too old" — measured, actionable — into "could not
    // determine", and a test had pinned that as correct.
    const r = await findPythonDetailed({
      execFile: async (cmd) => {
        if (cmd === 'python3') throw Object.assign(new Error('x'), { code: 'ENOENT' });
        return { stdout: '', stderr: 'Python 2.7.18\n' };
      },
    });
    assert.equal(r.checked, true, 'we got an answer, on the other stream');
    assert.deepEqual(r.rejected.map((x) => x.version), ['2.7']);
  });

  test('an UNPARSEABLE answer is inconclusive, not a conclusion', async () => {
    // This test previously pinned the OPPOSITE — that a candidate which ran but
    // never identified its version still let us conclude "no Python 3.10+ on
    // PATH". A review refuted it, correctly: a wrapper banner, a version on
    // stderr, or a silent shim all mean we did not find out. Asserting absence
    // from that is the fabrication this whole function exists to prevent.
    const r = await findPythonDetailed({
      execFile: async (cmd) => {
        if (cmd === 'python3') return { stdout: 'some wrapper banner\n' };
        throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    assert.equal(r.checked, false, 'a version we could not read is not a measurement');
  });

  test('a REAL version answer plus a clean ENOENT still concludes', async () => {
    // The complement, so the fix above cannot quietly make everything
    // inconclusive: python3 answers 3.9 (too old — a real reading), python is
    // absent. That IS a conclusion, and it must keep reaching the "too old"
    // wording rather than collapsing to "could not determine".
    const r = await findPythonDetailed({
      execFile: async (cmd) => {
        if (cmd === 'python3') return { stdout: 'Python 3.9.6\n' };
        throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    assert.equal(r.checked, true);
    assert.deepEqual(r.rejected.map((x) => x.version), ['3.9']);
  });

  test('the three answers reach the ENOENT message as three different sentences', async () => {
    const say = async (execFile) => missingMarkitdownMessage('markitdown', { execFile });
    const absent = await say(async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
    const blocked = await say(async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); });
    const old = await say(async () => ({ stdout: 'Python 3.9.6' }));
    assert.match(absent, /NO Python 3\.10\+ answered/);
    assert.match(blocked, /could NOT be determined/i);
    assert.match(old, /too old/);
    assert.equal(new Set([absent, blocked, old]).size, 3, 'three answers, three messages');
  });

  test('accepts a future 4.x rather than rejecting it for minor < 10', async () => {
    assert.equal((await findPythonDetailed({ execFile: ok('Python 4.0.0\n') })).major, 4);
  });

  test('there is NO findPython() wrapper — `null` is the collapse we removed', () => {
    // A `{cmd, version} | null` convenience existed and was deleted: `null`
    // merged "too old" with "could not look", which is exactly how both
    // installers came to print "No Python 3.10+ found on PATH" for a machine
    // nobody had successfully measured. Leaving the shorter name available is
    // how the next caller reintroduces the defect.
    assert.equal('findPython' in readiness, false, 'the collapsing wrapper must stay deleted');
  });

  test('BOTH installers branch on `checked` instead of printing "no Python"', () => {
    for (const p of ['../scripts/install-markitdown.mjs', '../scripts/install-docling.mjs']) {
      // COMMENTS STRIPPED FIRST. A review showed the naive form passing against
      // a commented-out `// const diagnosis = py.checked` with the branch
      // deleted — the test was reading documentation, not code.
      const src = fs.readFileSync(new URL(p, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      // The property must be READ in a conditional, and both arms must exist.
      assert.match(src, /py(\.checked|\['checked'\]|\["checked"\])\s*\r?\n?\s*\?/,
        `${p} must branch on checked, in code`);
      assert.match(src, /Could NOT determine/, `${p} needs the third wording`);
      assert.match(src, /No Python 3\.10\+ found/, `${p} must keep the genuine-absence wording too`);
      // …and must not gate on a truthiness the detailed result always has.
      assert.equal(/if \(!py\)\s*\{/.test(src), false, `${p} still tests the collapsed shape`);
      // The "already present?" check must ask the SAME question as the probe,
      // and ONLY that question. Matching `isRunnableFile(venvMarker` alone was
      // survivable: `if (existsSync(m) || isRunnableFile(m, fs))` restores the
      // whole broken-venv loop and still matches.
      assert.match(src, /if \(isRunnableFile\(venvMarker, fs\)\) \{/,
        `${p}: the early return must gate on runnability ALONE`);
      // And the broken-but-present case must bail with instructions rather than
      // walk into a `python -m venv` that cannot replace what is already there.
      assert.match(src, /Re-running[\s\S]{0,40}will NOT fix that/,
        `${p} must say a rerun cannot repair this, instead of implying it will`);
    }
  });

  test('PIN: the timeout actually reaches the child, and a real hang is cut short', async () => {
    // The previous test only checked that a fake received an option.
    let seen = null;
    await findPythonDetailed({ execFile: async (_c, _a, o) => { seen = o; return { stdout: 'Python 3.12' }; } });
    assert.ok(Number.isFinite(seen.timeout) && seen.timeout > 0);
    // And end-to-end: a child that sleeps must be killed, not awaited.
    const slept = await new Promise((resolve) => {
      const t0 = Date.now();
      findPythonDetailed({
        timeoutMs: 200,
        execFile: (cmd, args, opts) => new Promise((res, rej) => {
          try {
            execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: opts.timeout });
            res({ stdout: '' });
          } catch (e) { rej(e); }
        }),
      }).then(() => resolve(Date.now() - t0));
    });
    assert.ok(slept < 4000, `a hung probe took ${slept} ms — the timeout did not bite`);
  });
});

describe('the ENOENT message — it says WHICH problem the reader has', () => {
  test('Python present → "one command fixes this", naming a real path', async () => {
    const msg = await missingMarkitdownMessage('markitdown', {
      execFile: async () => ({ stdout: 'Python 3.12.0\n' }),
      projectRoot: '/opt/router',
    });
    assert.match(msg, /Python 3\.12 IS available/);
    assert.ok(msg.includes(path.join('/opt/router', 'scripts', 'install-markitdown.mjs')));
  });

  test('Python TOO OLD gets its own wording, not "no Python"', async () => {
    const msg = await missingMarkitdownMessage('markitdown', {
      execFile: async () => ({ stdout: 'Python 3.9.6\n' }),
    });
    assert.match(msg, /installed but too old \(python3 3\.9/);
    assert.equal(/NO Python/.test(msg), false);
  });

  test('COULD NOT CHECK says so, rather than fabricating a fact about the machine', async () => {
    const msg = await missingMarkitdownMessage('markitdown', {
      execFile: async () => { throw new Error('EACCES'); },
    });
    assert.match(msg, /could NOT be determined/i);
    assert.equal(/NO Python 3\.10\+ answered/.test(msg), false);
  });

  test('a THROWING dependency also lands in "could not check", not "no Python"', async () => {
    // The catch used to assign `null`, which fell past the could-not-determine
    // branch into the categorical one — fabricating the very fact this function
    // exists to avoid fabricating.
    const msg = await missingMarkitdownMessage('markitdown', {
      get execFile() { throw new Error('EACCES'); },
    });
    assert.match(msg, /could NOT be determined/i);
    assert.equal(/NO Python 3\.10\+ answered/.test(msg), false);
  });

  test('PIN: probe and runtime agree on the VENV tier — against a REAL directory', async () => {
    // The previous version was vacuous: it showed the probe a FAKE directory
    // while the runtime looked at a real path that simply did not exist, so
    // putting `existsSync` back left the assertion green. This builds the
    // broken venv on disk, so the runtime meets the same thing the probe does.
    const os = await import('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convready-'));
    const saved = process.env.MARKITDOWN_PATH;
    try {
      delete process.env.MARKITDOWN_PATH;
      // A DIRECTORY exactly where the venv binary belongs — what an interrupted
      // install leaves. `existsSync` says yes; nothing can spawn it.
      const marker = path.join(root, venvRel);
      fs.mkdirSync(marker, { recursive: true });

      assert.equal(fs.existsSync(marker), true, 'the trap must be present for the test to mean anything');
      assert.equal(
        resolveMarkitdownPath(root), 'markitdown',
        'the RUNTIME must fall through to PATH rather than spawn a directory',
      );
      const r = probeConversionToolbox({ projectRoot: root, env: { PATH: '' } });
      assert.notEqual(r.via, 'bundled-venv', 'and the probe must reject it the same way');
    } finally {
      if (saved === undefined) delete process.env.MARKITDOWN_PATH;
      else process.env.MARKITDOWN_PATH = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('PIN: a REAL runnable venv binary is accepted by both, on this platform', async () => {
    const os = await import('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convready-'));
    const saved = process.env.MARKITDOWN_PATH;
    try {
      delete process.env.MARKITDOWN_PATH;
      const marker = path.join(root, venvRel);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '#!/bin/sh\nexit 0\n');
      if (!isWin) fs.chmodSync(marker, 0o755);

      assert.equal(resolveMarkitdownPath(root), marker, 'the runtime must select the venv binary');
      const r = probeConversionToolbox({ projectRoot: root, env: {} });
      assert.equal(r.via, 'bundled-venv');
      assert.equal(r.path, marker, 'probe and runtime must name the SAME file');
    } finally {
      if (saved === undefined) delete process.env.MARKITDOWN_PATH;
      else process.env.MARKITDOWN_PATH = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('THE OPT-OUT IS HONOURED ON THE ERROR PATH TOO — no probe, no pitch', async () => {
    // The one-offer rule was written into the two prose surfaces and skipped
    // the one place that fires on EVERY failed call: someone who had set
    // SKIP=1 still got a Python probe and install commands, per conversion.
    let spawned = 0;
    const msg = await missingMarkitdownMessage('markitdown', {
      env: { [SKIP_ENV]: '1' },
      execFile: async () => { spawned += 1; return { stdout: 'Python 3.12' }; },
    });
    assert.equal(spawned, 0, 'an opted-out user must not pay for a subprocess');
    assert.match(msg, new RegExp(`${SKIP_ENV}=1 is set`));
    assert.equal(/install-markitdown/.test(msg), false, 'and must not be sold the install again');
    // It must still say WHAT failed — silence would be worse than a pitch.
    assert.match(msg, /markitdown executable not found/);
  });

  test('"too old" does not hide a candidate that could not be inspected', async () => {
    // python3 = 3.9 (a real reading) AND python = EACCES (not a reading) is
    // both facts at once. Testing `rejected.length` first swallowed the second
    // and sent the reader to upgrade an interpreter that may not be the one
    // that would have worked.
    const msg = await missingMarkitdownMessage('markitdown', {
      execFile: async (cmd) => {
        if (cmd === 'python3') return { stdout: 'Python 3.9.6\n' };
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      },
    });
    assert.match(msg, /too old \(python3 3\.9\)/);
    assert.match(msg, /another interpreter could not be inspected/);
  });

  test('every wording names the toolbox size and the no-auto-install rule', async () => {
    const cases = [
      async () => ({ stdout: 'Python 3.12' }),
      async () => ({ stdout: 'Python 3.9' }),
      async () => { throw new Error('x'); },
    ];
    for (const execFile of cases) {
      const msg = await missingMarkitdownMessage('markitdown', { execFile });
      assert.match(msg, new RegExp(`${MARKITDOWN_TOOLS.length} conversion tools depend on it`));
      assert.match(msg, /never installs it on its own/);
      assert.match(msg, /MARKITDOWN_PATH/);
    }
  });
});

describe('list_vaults carries it — the surface meta-status already reads', () => {
  const registry = { vaults: [], defaultVault: null, configPath: '/cfg', disabledVaults: {} };

  test('the conversionToolbox shape is EXACTLY this — set equality, not presence', async () => {
    // Listing keys with `k in obj` cannot notice a REMOVED key that nobody
    // listed: `verified` was added to the code and left out of this check, so
    // deleting it again from one branch would have gone unseen.
    const out = await listVaults(registry);
    assert.deepEqual(Object.keys(out.conversionToolbox).sort(), [
      'available', 'hint', 'optedOut', 'path', 'toolsAffected', 'toolsDegraded', 'verified', 'via',
    ]);
    assert.equal(out.conversionToolbox.toolsAffected.length, MARKITDOWN_TOOLS.length);
  });

  test('EVERY tier returns the same key set — a field cannot go missing on one branch', () => {
    const venv = path.join('/root', venvRel);
    const results = [
      probeConversionToolbox(null),
      probeConversionToolbox({ projectRoot: '/root', env: {}, fs: fsWith(venv) }),           // venv
      probeConversionToolbox({ projectRoot: '/r', env: { PATH: '/nope' }, fs: fsWith() }),   // nothing
      probeConversionToolbox({                                                              // override
        projectRoot: '/r', env: { MARKITDOWN_PATH: `/o/markitdown${isWin ? '.exe' : ''}` }, fs: fsWith(),
      }),
      probeConversionToolbox({ projectRoot: '/r', env: { MARKITDOWN_PATH: 'x.cmd' }, fs: fsWith() }),
    ];
    const expected = ['available', 'hint', 'optedOut', 'path', 'toolsAffected', 'toolsDegraded', 'verified', 'via'];
    for (const [i, r] of results.entries()) {
      assert.deepEqual(Object.keys(r).sort(), expected, `branch ${i} has a different shape`);
    }
  });

  test('the top-level field set is EXACTLY this — nothing dropped, nothing snuck in', async () => {
    // Two versions of this test hand-listed five names and missed the same
    // three (`portCollisions`, `lockedTo`, `autoEnrichMode`) — the second one
    // while its comment claimed to have fixed exactly that. Set equality is the
    // only form that cannot be half-written: a removed field fails, and a new
    // field fails too, which forces the contract to be updated deliberately.
    const out = await listVaults(registry);
    assert.deepEqual(Object.keys(out).sort(), [
      'autoEnrichMode',
      // v0.88.0 — WHERE each of the three session settings came from. Added
      // here deliberately, which is the whole point of pinning the set.
      'autoEnrichModeSource',
      'configPath',
      'conversionToolbox',
      'defaultVault',
      'defaultVaultSource',
      'defaultVaultStatus',
      'disabled',
      'lockSource',
      'lockedTo',
      'portCollisions',
      'vaults',
    ]);
  });
});

describe('command / skill parity — the rule must not live in one of the two', () => {
  // Prose wraps, and bold markers land mid-phrase — so every rule below is
  // matched against text with runs of whitespace and `**` collapsed away.
  // Otherwise a passing rule silently becomes a failing one at the next reflow.
  // Markup is stripped (bold markers, code backticks) so a rule is matched on
  // what it SAYS, not on how it happens to be marked up today.
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
    .replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ');

  // Matching one substring per file proved nothing: the command surfaces passed
  // while omitting most of the rules. Each LOAD-BEARING rule is checked
  // separately, in both files, so parity means the same behaviour and not
  // merely the same keywords.
  // Each entry is the INSTRUCTION, not a keyword that happens to appear near
  // it. A review demonstrated the weaker form: deleting the actual "do not
  // raise it unprompted" sentence still matched /session start/i, because a
  // neighbouring paragraph mentions the session-start call for a different
  // reason. A rule you can delete while its test stays green is not tested.
  const META_STATUS_RULES = [
    [/conversionToolbox/, 'reads the field'],
    [/via.{0,40}bundled-venv.{0,40}env-override.{0,40}path/, 'enumerates the three `via` values'],
    [/toolsAffected.{0,60}toolsDegraded/, 'points at both authoritative lists'],
    [/do not raise it unprompted at session start/i, 'forbids nagging at session start'],
    [/optedOut.{0,120}off by choice/, 'maps optedOut to the off-by-choice line'],
    [/verified: false/, 'reads `verified` — a field no surface consults is a field that lies'],
    [/verified: true.{0,80}ready/s, 'gates the ✅ on verified, not on available alone'],
    [/state unknown/, 'has an honest rendering for "the check could not run"'],
    [/env-override.{0,200}(masks|unusable)/, 'calls a broken override what it is, not "not installed"'],
    [/one offer per conversation/i, 'stops after one decline'],
    [/Do not.{0,20}suggest installing it/i, 'forbids re-offering after an opt-out'],
    [/quote the hint.{0,20}verbatim/i, 'requires the hint verbatim rather than a paraphrase'],
    [/only if yt-dlp is installed/, 'qualifies the youtube fallback'],
    [/git_repo_to_markdown.{0,80}repomix/, 'exonerates git_repo by name'],
  ];
  const META_SETUP_RULES = [
    [/npm run install-markitdown|install-markitdown\.mjs/, 'names the opt-in command'],
    [new RegExp(`${SKIP_ENV}`), 'offers the opt-out'],
    [/never installs markitdown on its own/i, 'states the no-imposition rule'],
    [/no .?postinstall/i, 'says WHY nothing happens automatically'],
    [/only if yt-dlp is installed|only where yt-dlp is itself installed/, 'qualifies the youtube fallback'],
    [/git_repo_to_markdown is (unaffected|\*\*unaffected)|unaffected.{0,40}repomix|repomix/, 'exonerates git_repo'],
    [/Docling.{0,200}install-docling/, 'keeps Docling a separate question with its own command'],
    [new RegExp(`CHECK THE OPT-OUT FIRST[\\s\\S]{0,200}${SKIP_ENV}`),
      'checks the opt-out BEFORE offering — otherwise the opt-out is a lie'],
    [/Not now.{0,120}nothing breaks|"not now" as a complete answer|takes .{0,20}not now/i,
      'makes declining a complete answer'],
  ];

  test('BOTH meta-status surfaces carry EVERY load-bearing rule', () => {
    for (const p of ['../skills/meta-status/SKILL.md', '../commands/meta-status.md']) {
      const text = read(p);
      for (const [re, what] of META_STATUS_RULES) {
        assert.match(text, re, `${p} must ${what}`);
      }
    }
  });

  test('BOTH meta-setup surfaces carry EVERY load-bearing rule', () => {
    for (const p of ['../skills/meta-setup/SKILL.md', '../commands/meta-setup.md']) {
      const text = read(p);
      for (const [re, what] of META_SETUP_RULES) {
        assert.match(text, re, `${p} must ${what}`);
      }
    }
  });

  test('no surface inflates the count, blames git_repo, or over-promises yt-dlp', () => {
    for (const p of ['../skills/meta-status/SKILL.md', '../commands/meta-status.md',
      '../skills/meta-setup/SKILL.md', '../commands/meta-setup.md']) {
      const text = read(p);
      assert.equal(/10 tools dormant|Ten of the fifty tools/.test(text), false, `${p} still inflates the count`);
      assert.equal(/still works through its yt-dlp fallback/.test(text), false, `${p} over-promises yt-dlp`);
    }
  });
});
