/**
 * Tests for AGENTS.md — the host-neutral operating contract at the repository
 * root, read automatically by Codex, Gemini CLI, Cursor and Windsurf.
 *
 * WHY THIS FILE EXISTS AT ALL. AGENTS.md is not documentation; it is an input
 * to third-party models that will act on it. A stale path in a README costs a
 * reader ten seconds. A stale path in AGENTS.md is read by every agent, in
 * every session, on every host, and each one acts on it before anyone notices.
 * So the file is treated as code and given a build.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not assert that AGENTS.md
 * "contains" a rule. A membership test over a document's text measures the
 * spelling of a sentence and nothing else — and the entire value of this file
 * is behavioural. Instead every check crosses the document with a source of
 * truth outside it: paths are resolved against the filesystem, commands against
 * package.json, and the handshake instruction is EXECUTED and its output
 * compared with a freshly counted denominator.
 *
 * The live-agent check lives at the bottom, and is skipped loudly rather than
 * passed quietly when the binary or the opt-in is absent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');

const rawDoc = fs.readFileSync(AGENTS_MD, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const HOST_CONTRACT = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'agent-host-targets.json'), 'utf8'),
);

/**
 * Everything in AGENTS.md that a human wrote.
 *
 * `install-agent-rules` may legitimately add a managed skills-index block to
 * this very file, and that block quotes skill DESCRIPTIONS — which contain
 * backticked vault paths such as `wiki-meta/digests/` that are not repository
 * paths and never will be. Scanning them here would make dogfooding the
 * installer fail the suite, i.e. the test dictating the product instead of
 * measuring it. The generated block has its own tests; this file checks the
 * authored contract.
 */
function authoredText(text) {
  const { beginMarker, endMarker } = HOST_CONTRACT.block;
  const b = text.indexOf(beginMarker);
  if (b === -1) return text;
  const e = text.indexOf(endMarker, b);
  if (e === -1) return text;
  return text.slice(0, b) + text.slice(e + endMarker.length);
}

const doc = authoredText(rawDoc);

/** Count the skills the same way the document tells an agent to. */
function countSkillsOnDisk() {
  return fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'skills', e.name, 'SKILL.md')))
    .length;
}

/** Inline code spans that are shaped like a repository path. */
function referencedPaths(text) {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  return [...new Set(spans.filter((s) => (
    s.includes('/')
    && !/\s/.test(s)
    // `skills/<name>/SKILL.md` is a shape, not a claim that a directory called
    // `<name>` exists. The exclusion is deliberately keyed on the angle
    // brackets — a token with no placeholder in it is still checked, so this
    // cannot become a way to smuggle a broken path past the guard.
    && !/[<>]/.test(s)
    && (s.endsWith('/') || /\.[a-z0-9]+$/i.test(s))
  )))];
}

/** `npm run <script>` and `npm test` occurrences. */
function referencedNpmScripts(text) {
  const runs = [...text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)].map((m) => m[1]);
  if (/npm test\b/.test(text)) runs.push('test');
  return [...new Set(runs)];
}

/** The token the handshake must produce, taken from the document itself. */
function handshakeToken(text) {
  const m = text.match(/^\s*(AGENTS-OK skills=)<N>\s*$/m);
  return m ? m[1] : null;
}

/** The command the document tells the agent to run, taken from the document. */
function handshakeCommand(text) {
  const m = text.match(/```\n(node -e "[\s\S]*?")\n```/);
  if (!m) return null;
  const inner = m[1].match(/^node -e "([\s\S]*)"$/);
  return inner ? inner[1] : null;
}

describe('AGENTS.md — the file exists where every host looks', () => {
  test('it is at the repository root and is not empty', () => {
    assert.ok(fs.existsSync(AGENTS_MD));
    assert.ok(doc.length > 500, `AGENTS.md is ${doc.length} bytes`);
  });

  test('it ships — the allowlist ITSELF decides it in, on both surfaces', async () => {
    // Not `zones.authored.includes('AGENTS.md')`: that reads the contract the
    // way a human reads it, and would pass even if the pattern compiler
    // disagreed. Run the gate's own matcher and ask what it decides.
    const { applyAllowlist } = await import('../src/helpers/export-gate.mjs');
    const allow = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'export-allowlist.json'), 'utf8'));

    for (const target of ['mcpb', 'release']) {
      const { included, excluded } = applyAllowlist(
        ['AGENTS.md', 'not-a-shipped-file.txt'],
        allow.targets[target].zones,
      );
      assert.ok(
        included.some((e) => e.path === 'AGENTS.md'),
        `the ${target} allowlist does not admit AGENTS.md — it would be silently dropped`,
      );
      // Negative control: the matcher is not simply admitting everything.
      assert.ok(excluded.some((e) => e.path === 'not-a-shipped-file.txt'));
    }
  });

  test('the release surface is scanned, and .codex/ is not on it', async () => {
    const { applyAllowlist } = await import('../src/helpers/export-gate.mjs');
    const allow = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'export-allowlist.json'), 'utf8'));
    const { included } = applyAllowlist(
      ['.codex/config.toml', 'AGENTS.md'],
      allow.targets.release.zones,
    );
    assert.deepEqual(included.map((e) => e.path), ['AGENTS.md'],
      'the release surface must carry AGENTS.md and nothing from .codex/');
  });
});

describe('every claim resolves against something outside the document', () => {
  test('every path it names exists on disk', () => {
    const paths = referencedPaths(doc);
    assert.ok(paths.length >= 10, `expected the layout table to yield paths, extracted ${paths.length}`);
    const missing = paths.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    assert.deepEqual(missing, [], `AGENTS.md names ${missing.length}/${paths.length} paths that do not exist`);
  });

  test('every directory it presents as a directory is one', () => {
    const dirs = referencedPaths(doc).filter((p) => p.endsWith('/'));
    assert.ok(dirs.length >= 8, `extracted only ${dirs.length} directory references`);
    for (const d of dirs) {
      assert.ok(fs.statSync(path.join(REPO_ROOT, d)).isDirectory(), `${d} is not a directory`);
    }
  });

  test('every npm script it names is defined in package.json', () => {
    const scripts = referencedNpmScripts(doc);
    assert.ok(scripts.length >= 5, `extracted only ${scripts.length} npm scripts`);
    const missing = scripts.filter((s) => !(s in pkg.scripts));
    assert.deepEqual(missing, [], `AGENTS.md names npm scripts that do not exist: ${missing.join(', ')}`);
  });

  test('the extractors are not vacuous — a fabricated reference is caught', () => {
    // Guards the failure mode where a regex silently stops matching and the
    // three tests above go green over an empty list.
    const poisoned = `${doc}\n\nSee \`scripts/does-not-exist.mjs\` and run \`npm run no-such-script\`.\n`;
    assert.ok(referencedPaths(poisoned).includes('scripts/does-not-exist.mjs'));
    assert.ok(referencedNpmScripts(poisoned).includes('no-such-script'));
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'scripts/does-not-exist.mjs')));

    // And the placeholder exclusion is narrow: it drops the token that carries
    // angle brackets and nothing else on the same line.
    const withPlaceholder = 'See `skills/<name>/SKILL.md` and `scripts/also-missing.mjs`.';
    const extracted = referencedPaths(withPlaceholder);
    assert.ok(!extracted.includes('skills/<name>/SKILL.md'));
    assert.ok(extracted.includes('scripts/also-missing.mjs'));
  });

  test('a managed skills-index block is not mistaken for authored claims', () => {
    // Discovered by running the installer against this repository's own
    // AGENTS.md: the block quotes skill descriptions, several of which contain
    // backticked VAULT paths (`wiki-meta/digests/`) that do not exist in the
    // repository and are not meant to. Without the scoping, installing the
    // index would fail the contract suite.
    const { beginMarker, endMarker } = HOST_CONTRACT.block;
    // Built from the AUTHORED text, not the raw file: if the installer has
    // already been run here, the raw file holds a block and appending a second
    // one would test a state the installer refuses to create.
    const withBlock = `${doc}\n${beginMarker}\n- \`x\` — d → \`wiki-meta/digests/\`\n${endMarker}\n`;
    const stripped = authoredText(withBlock);
    assert.ok(!stripped.includes('wiki-meta/digests/'));
    assert.deepEqual(
      referencedPaths(stripped).filter((p) => !fs.existsSync(path.join(REPO_ROOT, p))),
      [],
    );
    // And the stripping is not a blanket truncation — the authored tail survives.
    assert.ok(stripped.includes('## Contract handshake'));
  });

  test('the node version it states matches package.json engines', () => {
    const m = doc.match(/`(>=[\d.]+)`/);
    assert.ok(m, 'AGENTS.md does not state a node version');
    assert.equal(m[1], pkg.engines.node);
  });
});

describe('the handshake is an instruction, and the instruction is executed', () => {
  test('the document defines the token the live check consumes', () => {
    assert.ok(handshakeToken(doc), 'no `AGENTS-OK skills=<N>` line — the live check has nothing to match');
  });

  test('running the command the document names yields the live skill count', () => {
    // This is the check that makes AGENTS.md testable rather than merely
    // readable: the document's own instruction is run, and its result is
    // compared with a count taken independently a line above.
    const command = handshakeCommand(doc);
    assert.ok(command, 'no runnable handshake command found in AGENTS.md');

    const res = spawnSync(process.execPath, ['-e', command], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, `the documented command failed: ${res.stderr}`);
    assert.equal(Number(res.stdout.trim()), countSkillsOnDisk());
    assert.ok(countSkillsOnDisk() > 20, 'a near-empty skills tree would make this comparison meaningless');
  });

  test('the answer is not written in the authored text — it has to be measured', () => {
    // If the number appeared here, a model could satisfy the handshake by
    // reading rather than by counting, and the check would stop proving that
    // the agent can run anything at all.
    //
    // Scans the RAW file, not the authored text. The threat model is a model
    // reading this file and finding the number, and such a model does not know
    // which bytes a human typed. Scoping this check to the authored half is
    // exactly the blinded-guard mistake — observing the value at a point after
    // the step that removed the difference being looked for. The generated
    // index is kept free of any count so that this check can stay total.
    const count = String(countSkillsOnDisk());
    const withoutCode = rawDoc.replace(/```[\s\S]*?```/g, '');
    assert.ok(
      !new RegExp(`\\b${count}\\b`).test(withoutCode),
      `AGENTS.md contains the literal answer ${count}; the handshake would no longer require a measurement`,
    );
  });

  test('any count it does state about skills is the live one', () => {
    for (const m of doc.matchAll(/(\d+)\s+skills\b/g)) {
      assert.equal(Number(m[1]), countSkillsOnDisk(), `stale skill count "${m[0]}" in AGENTS.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// The live pass. A real agent, a real read of AGENTS.md, a real house rule.
// ---------------------------------------------------------------------------

const optedIn = process.env.ROUTER_CODEX_LIVE === '1';

/**
 * Gated behind the opt-in on purpose: spawning `codex --version` costs up to
 * the timeout on a machine where the binary exists but is slow to start, and
 * this file otherwise runs in about 150 ms inside a suite of 3,800 tests.
 */
function probeCodex() {
  if (!optedIn) return { available: false, reason: 'not probed' };
  try {
    const res = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 20000, shell: process.platform === 'win32' });
    if (res.status === 0 && res.stdout) return { available: true, version: res.stdout.trim() };
    return { available: false, reason: `\`codex --version\` exited ${res.status}` };
  } catch (err) {
    return { available: false, reason: `\`codex --version\` could not be spawned (${err.code || err.message})` };
  }
}

const codex = probeCodex();

/**
 * Why this is opt-in rather than always-on: the pass costs a model call, needs
 * network and credentials, and would make the suite non-deterministic for
 * everyone. Why it is nonetheless skipped LOUDLY: "the tool is missing" and
 * "the check passed" are different answers, and a harness that renders them
 * identically has stopped measuring. The reason is put in the test NAME so it
 * survives every reporter.
 */
const liveSkipReason = !optedIn
  ? 'NOT RUN — set ROUTER_CODEX_LIVE=1 to run the real codex pass (model call + network)'
  : (!codex.available ? `UNAVAILABLE HERE — ${codex.reason}` : null);

describe('live agent pass — codex reads AGENTS.md and obeys a house rule', () => {
  test(
    `codex returns the contract handshake${liveSkipReason ? ` [${liveSkipReason}]` : ''}`,
    { skip: liveSkipReason || false },
    (t) => {
      t.diagnostic(`codex ${codex.version}`);
      const token = handshakeToken(doc);
      const expected = `${token}${countSkillsOnDisk()}`;

      // The prompt goes in on stdin, not as an argv element. `codex` is a shim
      // on Windows, so it has to be spawned through the shell, and a shell
      // re-splits a multi-word argument on spaces — which silently turned the
      // prompt into an unrecognised subcommand the first time this ran.
      // `--ignore-user-config` is load-bearing three times over. It stops the
      // run loading `$CODEX_HOME/config.toml` — the file this repository's own
      // rules say nothing may open — while leaving authentication intact. It
      // removes the machine's MCP servers, whose failed/cancelled tool calls
      // were what pushed the model off measuring. And measured over repeated
      // runs it is both cheaper and more reliable: with the user config loaded,
      // the model fell back to WEB SEARCHING for the number and answered 39.
      const res = spawnSync(
        'codex',
        ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '-'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 300000,
          shell: process.platform === 'win32',
          input: 'Give the contract handshake.',
        },
      );

      assert.equal(res.status, 0, `codex exec failed: ${res.stderr || res.stdout}`);
      const out = `${res.stdout}\n${res.stderr}`;

      // Two independent claims, and the second is the one that matters.
      //
      //  (a) The token proves the file was READ: `AGENTS-OK skills=` appears
      //      nowhere but AGENTS.md, so a model that never loaded it cannot
      //      invent the format.
      //  (b) The number proves the RULE was followed: "measure, do not recall"
      //      is only satisfiable by running something, because the count is
      //      deliberately absent from the file — and older documents in this
      //      repository state a different, stale figure, so recall gives the
      //      wrong answer.
      assert.match(out, new RegExp(token), 'codex did not produce the handshake token — AGENTS.md did not reach it');
      assert.match(
        out,
        new RegExp(`${token}\\s*${countSkillsOnDisk()}\\b`),
        `expected "${expected}" in the codex output; it produced:\n${out.slice(-2000)}`,
      );
    },
  );
});

if (liveSkipReason) {
  // Belt and braces: a line on stderr for anyone reading raw output rather
  // than a TAP summary.
  process.stderr.write(`\n[C12] live codex contract check did not run — ${liveSkipReason}\n\n`);
}
