/**
 * Tests for the C12 multi-host rules installer.
 *
 * Two things are hard to test honestly here, and both get a dedicated strategy.
 *
 * 1. "The preview lists exactly what it would install." Comparing the preview's
 *    text against the installer's own rendering would compare a function with
 *    itself. So the check is against the FILESYSTEM: snapshot every file under
 *    the fake home and the fake project by hash, run the preview, run --apply,
 *    snapshot again, and require the set of paths that changed to equal the set
 *    of paths the preview named. Neither more (a write the preview hid) nor
 *    fewer (a target the preview invented).
 *
 * 2. "The installer cannot read .codex/config.toml." Asserting that the source
 *    contains no `readdir` would be a spell-check. So a fake home is given a
 *    config.toml holding a canary string, the whole flow is run over it, and
 *    the canary is hunted in every byte of output and every written file — with
 *    a POSITIVE CONTROL that points the same hunt at the config file itself and
 *    requires it to succeed. A detector that cannot find the canary where the
 *    canary certainly is would make the negative result meaningless.
 *
 * Nothing here touches a real home directory: HOME, USERPROFILE, HOMEDRIVE and
 * HOMEPATH are all redirected for every child process, and CODEX_HOME is
 * cleared so the codex target resolves under the fake home too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertSafeTarget, assertSafeFile, assertSaneRoot, planTargets, planOne, planOneUninstall, applyOne,
  applyUninstallOne, resolveBase, renderSkillsIndex, collectSkills, wrapBlock, skillLinkPath,
  missingAncestors,
} from '../src/helpers/agent-host-install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-agent-rules.mjs');
const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'agent-host-targets.json'), 'utf8'),
);

const CANARY = 'CANARY-TOKEN-a1b2c3-must-never-leave-the-toml';

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Recursive hash snapshot: relative path -> sha256 of contents. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.set(path.relative(root, abs), sha(fs.readFileSync(abs)));
    }
  };
  walk(root);
  return out;
}

function changedPaths(before, after, root) {
  const changed = [];
  for (const [rel, hash] of after) if (before.get(rel) !== hash) changed.push(path.join(root, rel));
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(path.join(root, rel));
  return changed.sort();
}

/** A fake home holding the one file the installer must never be able to read. */
function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c12-install-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'config.toml'),
    `# machine-local codex config\n[mcp_servers.example]\nbearer_token = "${CANARY}"\n`,
    'utf8',
  );
  return { base, home, project, configToml: path.join(home, '.codex', 'config.toml') };
}

function run(args, { home, project }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: '' };
  delete env.CODEX_HOME;
  return spawnSync(process.execPath, [SCRIPT, '--project', project, ...args], { encoding: 'utf8', env });
}

describe('assertSafeTarget — the guard that makes the token unreachable', () => {
  test('refuses a .toml outright', () => {
    assert.throws(
      () => assertSafeTarget(path.join('any', 'where', 'config.toml'), CONTRACT),
      /allowedTargetExtensions/,
    );
  });

  test('refuses a markdown file the contract never named', () => {
    assert.throws(
      () => assertSafeTarget(path.join('any', 'where', 'secrets.md'), CONTRACT),
      /not a file name declared/,
    );
  });

  test('accepts every file name the contract does declare', () => {
    for (const host of Object.values(CONTRACT.hosts)) {
      for (const target of Object.values(host.targets)) {
        assert.equal(assertSafeTarget(path.join('base', target.file), CONTRACT), true);
      }
    }
  });

  test('the extension check and the name check are independent guards', () => {
    // A declared basename with the wrong extension must still be refused, or
    // the two checks would be one check wearing two hats.
    assert.throws(() => assertSafeTarget(path.join('b', 'AGENTS.toml'), CONTRACT), /allowedTargetExtensions/);
  });
});

describe('resolveBase', () => {
  test('CODEX_HOME wins over the home directory when set', () => {
    const custom = path.join(os.tmpdir(), 'codex-home-probe');
    assert.equal(
      resolveBase('codex-home', CONTRACT, { home: '/h', env: { CODEX_HOME: custom } }),
      path.resolve(custom),
    );
    assert.equal(
      resolveBase('codex-home', CONTRACT, { home: path.join('/h'), env: {} }),
      path.join('/h', '.codex'),
    );
  });

  test('an undeclared base is refused rather than guessed', () => {
    assert.throws(() => resolveBase('nope', CONTRACT, { home: '/h' }), /unknown base/);
  });

  test('a target that tries to climb out of its base is refused before the join', () => {
    // path.join() normalises `..` away, so a basename check downstream would be
    // inspecting a name that had already escaped. The refusal has to happen on
    // the segments.
    for (const bad of ['../escape.md', 'a/../../escape.md', '/abs/escape.md']) {
      const hostile = {
        ...CONTRACT,
        hosts: { evil: { label: 'evil', targets: { project: { file: bad, base: 'project', format: 'markdown' } } } },
      };
      assert.throws(
        () => planTargets(hostile, { projectDir: path.join(os.tmpdir(), 'p'), home: '/h', env: {} }),
        /refusing target/,
        `expected '${bad}' to be refused`,
      );
    }
  });

  test('the shipped contract has no climbing target', () => {
    for (const host of Object.values(CONTRACT.hosts)) {
      for (const t of Object.values(host.targets)) {
        assert.ok(!path.isAbsolute(t.file) && !t.file.split('/').includes('..'), t.file);
      }
    }
  });
});

describe('preview lists exactly what it would install', () => {
  test('the paths that change on --apply are precisely the paths the preview named', () => {
    const { home, project } = makeSandbox();

    const preview = run(['--json'], { home, project });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const plan = JSON.parse(preview.stdout);
    assert.equal(plan.applyRequested, false);
    const promised = plan.targets.map((t) => t.file).sort();
    const declared = Object.values(CONTRACT.hosts).reduce((n, h) => n + Object.keys(h.targets).length, 0);
    assert.equal(promised.length, declared, 'an unfiltered preview must cover every declared target');

    const homeBefore = snapshot(home);
    const projectBefore = snapshot(project);

    // A preview that wrote something would be caught right here.
    const previewAgain = run([], { home, project });
    assert.equal(previewAgain.status, 0);
    assert.deepEqual(changedPaths(homeBefore, snapshot(home), home), []);
    assert.deepEqual(changedPaths(projectBefore, snapshot(project), project), []);

    const applied = run(['--apply', '--json'], { home, project });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);

    const actuallyChanged = [
      ...changedPaths(homeBefore, snapshot(home), home),
      ...changedPaths(projectBefore, snapshot(project), project),
    ].sort();

    assert.deepEqual(actuallyChanged, promised,
      'the set of files touched must equal the set the preview named — no hidden write, no invented target');
  });

  test('--scope narrows the plan to that scope only', () => {
    const { home, project } = makeSandbox();
    const preview = JSON.parse(run(['--scope', 'user', '--json'], { home, project }).stdout);
    assert.ok(preview.targets.length > 0);
    assert.deepEqual([...new Set(preview.targets.map((t) => t.scope))], ['user']);

    const projectBefore = snapshot(project);
    run(['--scope', 'user', '--apply'], { home, project });
    assert.deepEqual(changedPaths(projectBefore, snapshot(project), project), [],
      'a --scope user run must not write into the project');
  });

  test('--host and --scope narrow the plan, and the narrowed plan is what is written', () => {
    const { home, project } = makeSandbox();
    const preview = JSON.parse(run(['--host', 'cursor', '--json'], { home, project }).stdout);
    assert.deepEqual([...new Set(preview.targets.map((t) => t.hostId))], ['cursor']);

    const projectBefore = snapshot(project);
    const homeBefore = snapshot(home);
    run(['--host', 'cursor', '--apply'], { home, project });

    assert.deepEqual(
      changedPaths(projectBefore, snapshot(project), project),
      preview.targets.map((t) => t.file).sort(),
    );
    assert.deepEqual(changedPaths(homeBefore, snapshot(home), home), [],
      'a --host filter must not write outside the hosts it named');
  });

  test('every target carries its provenance, so the user sees what is verified and what is documented', () => {
    const { home, project } = makeSandbox();
    const plan = JSON.parse(run(['--json'], { home, project }).stdout);
    for (const t of plan.targets) {
      assert.ok(t.provenance, `${t.hostId}/${t.scope} has no provenance`);
      assert.ok(t.source && t.source.length > 10, `${t.hostId}/${t.scope} has no source`);
    }
    // And the printed provenance must be THIS target's, not a constant: a run
    // that emitted "documented" for everything would satisfy a /provenance:/
    // match while telling the user nothing.
    const human = run([], { home, project }).stdout;
    for (const t of plan.targets) {
      assert.ok(
        human.includes(`${t.provenance} — ${t.source}`),
        `${t.hostId}/${t.scope} provenance pair missing from the human output`,
      );
    }
  });
});

describe('idempotence, upgrade and user content', () => {
  test('a second --apply changes nothing, byte for byte', () => {
    const { home, project } = makeSandbox();
    run(['--apply'], { home, project });
    const after1 = snapshot(project);
    const homeAfter1 = snapshot(home);

    const second = run(['--apply', '--json'], { home, project });
    const payload = JSON.parse(second.stdout);
    assert.ok(payload.targets.every((t) => t.status === 'already-installed'),
      `expected every target already-installed, got ${payload.targets.map((t) => t.status).join(', ')}`);
    assert.deepEqual(changedPaths(after1, snapshot(project), project), []);
    assert.deepEqual(changedPaths(homeAfter1, snapshot(home), home), []);
  });

  test('text the user wrote around the block survives an upgrade', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    fs.writeFileSync(target, '# My rules\n\nAlways run the tests.\n', 'utf8');

    run(['--host', 'agents-md', '--apply'], { home, project });
    const installed = fs.readFileSync(target, 'utf8');
    assert.match(installed, /^# My rules\n\nAlways run the tests\.\n/);

    // Force an upgrade by corrupting the managed body only.
    const { beginMarker, endMarker } = CONTRACT.block;
    const b = installed.indexOf(beginMarker);
    const e = installed.indexOf(endMarker);
    fs.writeFileSync(target,
      `${installed.slice(0, b + beginMarker.length)}\nSTALE\n${installed.slice(e)}`, 'utf8');

    const upgraded = JSON.parse(run(['--host', 'agents-md', '--apply', '--json'], { home, project }).stdout);
    assert.equal(upgraded.targets[0].status, 'upgraded');

    const now = fs.readFileSync(target, 'utf8');
    assert.match(now, /^# My rules\n\nAlways run the tests\.\n/, 'user prose above the block must be untouched');
    assert.ok(!now.includes('STALE'));
  });

  test('uninstall returns the file to its original bytes', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    const original = '# My rules\n\nAlways run the tests.\n';
    fs.writeFileSync(target, original, 'utf8');
    const originalSha = sha(Buffer.from(original));

    run(['--host', 'agents-md', '--apply'], { home, project });
    assert.notEqual(sha(fs.readFileSync(target)), originalSha);

    const removed = JSON.parse(run(['--host', 'agents-md', '--uninstall', '--apply', '--json'], { home, project }).stdout);
    assert.equal(removed.targets[0].status, 'removed');
    assert.equal(sha(fs.readFileSync(target)), originalSha, 'install + uninstall must be a round trip');
  });

  test('uninstall previews without removing', () => {
    const { home, project } = makeSandbox();
    run(['--host', 'agents-md', '--apply'], { home, project });
    const before = snapshot(project);
    const preview = JSON.parse(run(['--host', 'agents-md', '--uninstall', '--json'], { home, project }).stdout);
    assert.equal(preview.targets[0].status, 'removed');
    assert.deepEqual(changedPaths(before, snapshot(project), project), [],
      'an uninstall preview must not remove anything');
  });

  test('uninstall on a file with no block reports not-installed rather than editing it', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    fs.writeFileSync(target, 'untouched\n', 'utf8');
    const before = snapshot(project);
    const out = JSON.parse(run(['--host', 'agents-md', '--uninstall', '--apply', '--json'], { home, project }).stdout);
    assert.equal(out.targets[0].status, 'not-installed');
    assert.deepEqual(changedPaths(before, snapshot(project), project), []);
  });
});

describe('refusals', () => {
  test('BEGIN without END is refused, exit 1, file untouched', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    const broken = `# Mine\n\n${CONTRACT.block.beginMarker}\nhalf a block, no END\n`;
    fs.writeFileSync(target, broken, 'utf8');
    const before = sha(fs.readFileSync(target));

    const res = run(['--host', 'agents-md', '--apply', '--json'], { home, project });
    assert.equal(res.status, 1, 'an ambiguous state must not exit 0');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.targets[0].status, 'ambiguous-state');
    assert.equal(sha(fs.readFileSync(target)), before, 'refusing means not writing');
  });

  test('uninstall also refuses an unterminated block', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    fs.writeFileSync(target, `${CONTRACT.block.beginMarker}\nno end\n`, 'utf8');
    const before = sha(fs.readFileSync(target));
    const res = run(['--host', 'agents-md', '--uninstall', '--apply', '--json'], { home, project });
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stdout).targets[0].status, 'ambiguous-state');
    assert.equal(sha(fs.readFileSync(target)), before);
  });

  test('a target whose host cap cannot fit the index is refused, not truncated', () => {
    const { project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const tiny = {
      hostId: 'tiny', hostLabel: 'Tiny', scope: 'project',
      file: path.join(project, 'AGENTS.md'), format: 'markdown',
      charBudget: 200, provenance: 'test', source: 'test',
    };
    const plan = planOne(tiny, skills, CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(plan.status, 'over-budget');
    assert.match(plan.error, /Refusing/);
    assert.equal(fs.existsSync(tiny.file), false, 'planning must never create the file');
  });

  test('a host cap that only the compact rendering fits selects compact', () => {
    const { project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const full = wrapBlock(renderSkillsIndex(skills, {
      mode: 'full', targetFile: path.join(project, 'AGENTS.md'), projectDir: project, repoRoot: REPO_ROOT,
    }), CONTRACT).length;
    const compact = wrapBlock(renderSkillsIndex(skills, {
      mode: 'compact', targetFile: path.join(project, 'AGENTS.md'), projectDir: project, repoRoot: REPO_ROOT,
    }), CONTRACT).length;
    assert.ok(compact < full, `compact (${compact}) must be smaller than full (${full})`);

    const target = {
      hostId: 'mid', hostLabel: 'Mid', scope: 'project',
      file: path.join(project, 'AGENTS.md'), format: 'markdown',
      charBudget: Math.floor((full + compact) / 2), provenance: 'test', source: 'test',
    };
    const plan = planOne(target, skills, CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(plan.mode, 'compact');
    assert.equal(plan.status, 'installed');
  });
});

describe('regressions found by adversarial review', () => {
  const skills = () => collectSkills(REPO_ROOT);

  function targetIn(project, { charBudget = null, format = 'markdown' } = {}) {
    return {
      hostId: 't', hostLabel: 'T', scope: 'project', file: path.join(project, 'AGENTS.md'),
      format, charBudget, provenance: 'test', source: 'test',
    };
  }

  test('the compact fallback fires on the RESULTING file, not on the block alone', () => {
    // The bug: the rendering was chosen from block.length while the refusal was
    // computed from the resulting file. With pre-existing user text, a target
    // whose cap the full block fits but the full FILE does not was refused,
    // even though the compact index would have fitted. Every earlier budget
    // test used a non-existent file, where the two formulas coincide — so the
    // bug was structurally invisible.
    const { project } = makeSandbox();
    const target = targetIn(project);
    const full = wrapBlock(renderSkillsIndex(skills(), {
      mode: 'full', targetFile: target.file, projectDir: project, repoRoot: REPO_ROOT,
    }), CONTRACT).length;
    const compact = wrapBlock(renderSkillsIndex(skills(), {
      mode: 'compact', targetFile: target.file, projectDir: project, repoRoot: REPO_ROOT,
    }), CONTRACT).length;

    const existing = `${'u'.repeat(2000)}\n`;
    fs.writeFileSync(target.file, existing, 'utf8');
    const budget = full + 100; // the full BLOCK fits; the full FILE does not
    assert.ok(existing.length + full > budget && existing.length + compact <= budget);

    const plan = planOne({ ...target, charBudget: budget }, skills(), CONTRACT,
      { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(plan.status, 'installed');
    assert.equal(plan.mode, 'compact');
  });

  test('projectedBytes equals the bytes actually written, on insert and on upgrade', () => {
    // The estimate was +2 out on a fresh insert and -1 out on an upgrade, so a
    // budget documented as "checked against the resulting file" was checked
    // against a number no file ever had.
    const { project } = makeSandbox();
    const target = targetIn(project);
    fs.writeFileSync(target.file, '# Mine\n\nSome prose.\n', 'utf8');

    const insert = planOne(target, skills(), CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(insert.status, 'installed');
    applyOne(insert, CONTRACT);
    assert.equal(fs.readFileSync(target.file, 'utf8').length, insert.projectedBytes);

    // Force an upgrade.
    const cur = fs.readFileSync(target.file, 'utf8');
    const b = cur.indexOf(CONTRACT.block.beginMarker);
    fs.writeFileSync(target.file,
      `${cur.slice(0, b + CONTRACT.block.beginMarker.length)}\nSTALE\n${cur.slice(cur.indexOf(CONTRACT.block.endMarker))}`,
      'utf8');
    const upgrade = planOne(target, skills(), CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(upgrade.status, 'upgraded');
    applyOne(upgrade, CONTRACT);
    assert.equal(fs.readFileSync(target.file, 'utf8').length, upgrade.projectedBytes);
  });

  test('a new .mdc counts its own frontmatter towards the budget', () => {
    const { project } = makeSandbox();
    const target = {
      ...targetIn(project, { format: 'mdc' }),
      file: path.join(project, '.cursor', 'rules', 'obsidian-mcp-router-skills.mdc'),
      frontmatter: { description: 'x', alwaysApply: false },
    };
    const plan = planOne(target, skills(), CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    applyOne(plan, CONTRACT);
    assert.equal(fs.readFileSync(target.file, 'utf8').length, plan.projectedBytes);
  });

  test('uninstall does not rewrite blank lines it was not asked to touch', () => {
    // The remover ran /\n{3,}/g over the WHOLE file, which reached far past the
    // join point and collapsed deliberate blank-line runs — including blank
    // lines inside fenced code blocks.
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    const original = '# Mine\n\nPara one.\n\n\n\nPara two.\n\n```text\ncode line 1\n\n\ncode line 3\n```\n';
    fs.writeFileSync(target, original, 'utf8');
    const originalSha = sha(Buffer.from(original));

    run(['--host', 'agents-md', '--apply'], { home, project });
    run(['--host', 'agents-md', '--uninstall', '--apply'], { home, project });
    assert.equal(sha(fs.readFileSync(target)), originalSha,
      'a round trip must return every byte, blank lines and fenced code included');
  });

  test('a stray BEGIN after a complete block is still an ambiguous state', () => {
    // The check only inspected the FIRST BEGIN, so a file holding one good
    // block plus a stray unterminated marker was reported a clean upgrade and
    // the stray survived the write.
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    run(['--host', 'agents-md', '--apply'], { home, project });
    fs.appendFileSync(target, `\n${CONTRACT.block.beginMarker}\nstray, unterminated\n`, 'utf8');
    const before = sha(fs.readFileSync(target));

    for (const args of [['--apply'], ['--uninstall', '--apply']]) {
      const res = run(['--host', 'agents-md', ...args, '--json'], { home, project });
      assert.equal(res.status, 1, `\`${args.join(' ')}\` should refuse`);
      assert.equal(JSON.parse(res.stdout).targets[0].status, 'ambiguous-state');
    }
    assert.equal(sha(fs.readFileSync(target)), before);
  });

  test('two complete blocks with the same marker name are ambiguous', () => {
    // Balanced markers, so the count-mismatch rule does not fire — but "which
    // of the two is the managed one" has no answer, and picking the first would
    // silently orphan the second.
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    run(['--host', 'agents-md', '--apply'], { home, project });
    const one = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, one + one, 'utf8');
    const before = sha(fs.readFileSync(target));

    const res = run(['--host', 'agents-md', '--apply', '--json'], { home, project });
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stdout).targets[0].status, 'ambiguous-state');
    assert.equal(sha(fs.readFileSync(target)), before);
  });

  test('a CRLF file is recognised as already installed instead of upgraded forever', () => {
    const { project } = makeSandbox();
    const target = targetIn(project);
    const plan = planOne(target, skills(), CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    applyOne(plan, CONTRACT);
    // Simulate a CRLF checkout of the file we just wrote.
    fs.writeFileSync(target.file, fs.readFileSync(target.file, 'utf8').replace(/\n/g, '\r\n'), 'utf8');

    const second = planOne(target, skills(), CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(second.status, 'already-installed');
  });

  test('the index carries no stray YAML block-scalar indicator', () => {
    // 23/47 skills declare `description: |`; the indicator is syntax, and it
    // was being emitted as the first character of half the index entries.
    const body = renderSkillsIndex(skills(), {
      mode: 'full', targetFile: path.join(REPO_ROOT, 'AGENTS.md'), projectDir: REPO_ROOT, repoRoot: REPO_ROOT,
    });
    const offenders = body.split('\n').filter((l) => /^- \*\*`[^`]+`\*\* — [|>]/.test(l));
    assert.deepEqual(offenders, []);
    assert.ok(skills().every((s) => !/^[|>]/.test(s.description)));
  });

  test('the preview says when the links it writes are absolute', () => {
    // Project-scope rule files are version-controlled by their vendors' docs,
    // so an absolute path baked in by whoever ran the installer is a dead link
    // for the rest of the team. Unavoidable when the skills tree is elsewhere —
    // so it is reported rather than hidden.
    const { home, project } = makeSandbox();
    const plan = JSON.parse(run(['--json'], { home, project }).stdout);
    const cursor = plan.targets.find((t) => t.hostId === 'cursor');
    assert.equal(cursor.absoluteLinks, true, 'skills live outside the fake project, so links are absolute');
    assert.match(run([], { home, project }).stdout, /absolute path/i);
  });
});

describe('hardening required by the cross review', () => {
  test('apply refuses a file that changed between preview and apply', () => {
    const { project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const target = {
      hostId: 't', hostLabel: 'T', scope: 'project', file: path.join(project, 'AGENTS.md'),
      format: 'markdown', charBudget: null, provenance: 'test', source: 'test',
    };
    fs.writeFileSync(target.file, '# Mine\n', 'utf8');
    const plan = planOne(target, skills, CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });

    // Somebody else writes between the preview and the apply.
    fs.writeFileSync(target.file, '# Mine, edited since you looked\n', 'utf8');
    assert.throws(() => applyOne(plan, CONTRACT), /changed between preview and apply/);
    assert.equal(fs.readFileSync(target.file, 'utf8'), '# Mine, edited since you looked\n',
      'the stale plan must not be written');
  });

  test('a destructive change writes a sidecar backup first; a first install does not', () => {
    const { home, project } = makeSandbox();
    const target = path.join(project, 'AGENTS.md');
    const original = '# Mine\n\nProse.\n';
    fs.writeFileSync(target, original, 'utf8');

    // First install appends; nothing is destroyed, so no backup.
    run(['--host', 'agents-md', '--apply'], { home, project });
    const afterInstall = fs.readdirSync(project).filter((f) => f.includes('.bak-skills-index-'));
    assert.deepEqual(afterInstall, [], 'a non-destructive first install needs no backup');

    // An upgrade replaces bytes between the markers — that is destructive.
    const cur = fs.readFileSync(target, 'utf8');
    const b = cur.indexOf(CONTRACT.block.beginMarker);
    fs.writeFileSync(target,
      `${cur.slice(0, b + CONTRACT.block.beginMarker.length)}\nHAND EDIT\n${cur.slice(cur.indexOf(CONTRACT.block.endMarker))}`,
      'utf8');
    const beforeUpgrade = fs.readFileSync(target, 'utf8');
    run(['--host', 'agents-md', '--apply'], { home, project });

    const backups = fs.readdirSync(project).filter((f) => f.includes('.bak-skills-index-'));
    assert.equal(backups.length, 1, `expected one sidecar, got ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(project, backups[0]), 'utf8'), beforeUpgrade,
      'the sidecar must hold the bytes that were replaced');

    // And uninstall backs up too.
    run(['--host', 'agents-md', '--uninstall', '--apply'], { home, project });
    assert.equal(fs.readdirSync(project).filter((f) => f.includes('.bak-skills-index-')).length, 2);
  });

  test('uninstall shows the exact text it will remove, in preview and before applying', () => {
    const { home, project } = makeSandbox();
    run(['--host', 'agents-md', '--apply'], { home, project });
    const installed = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    const b = installed.indexOf(CONTRACT.block.beginMarker);
    const e = installed.indexOf(CONTRACT.block.endMarker);
    const blockLines = installed.slice(b, e).split('\n').filter((l) => l.trim());

    const out = run(['--host', 'agents-md', '--uninstall'], { home, project }).stdout;
    assert.match(out, /exact text to be removed/);
    // Every non-empty line of the real block appears verbatim in the preview.
    for (const line of blockLines) {
      assert.ok(out.includes(line), `preview omitted a line it will delete: ${line.slice(0, 60)}`);
    }
    const json = JSON.parse(run(['--host', 'agents-md', '--uninstall', '--json'], { home, project }).stdout);
    assert.ok(json.targets[0].removedText.includes(CONTRACT.block.beginMarker));
  });

  test('a filesystem root or a system directory is refused as a base', () => {
    const root = path.parse(process.cwd()).root;
    assert.throws(() => assertSaneRoot(root, '--project'), /filesystem root/);
    const sys = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/foo';
    assert.throws(() => assertSaneRoot(sys, '--project'), /system directory/);
    // A normal directory passes, or the guard would be refusing everything.
    assert.equal(assertSaneRoot(process.cwd(), '--project'), path.resolve(process.cwd()));
  });

  test('CODEX_HOME pointing at a system directory is refused', () => {
    assert.throws(
      () => planTargets(CONTRACT, {
        projectDir: os.tmpdir(),
        home: os.tmpdir(),
        env: { CODEX_HOME: process.platform === 'win32' ? 'C:\\Windows' : '/etc' },
      }),
      /system directory/,
    );
  });

  test('the generation stamp does not turn every run into an upgrade', () => {
    // A wall-clock timestamp inside an idempotent managed block would make each
    // invocation a rewrite. The stamp records when the CONTENT last changed.
    const { project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const target = {
      hostId: 't', hostLabel: 'T', scope: 'project', file: path.join(project, 'AGENTS.md'),
      format: 'markdown', charBudget: null, provenance: 'test', source: 'test',
    };
    const first = planOne(target, skills, CONTRACT, {
      projectDir: project, repoRoot: REPO_ROOT, version: '1.0.0', generatedAt: '2020-01-01',
    });
    applyOne(first, CONTRACT);

    // Same content, a year later: still already-installed.
    const later = planOne(target, skills, CONTRACT, {
      projectDir: project, repoRoot: REPO_ROOT, version: '1.0.0', generatedAt: '2021-06-15',
    });
    assert.equal(later.status, 'already-installed');

    // But a real content change is still an upgrade — the normaliser must not
    // be wide enough to hide that.
    const changed = planOne(target, skills.slice(0, 3), CONTRACT, {
      projectDir: project, repoRoot: REPO_ROOT, version: '1.0.0', generatedAt: '2020-01-01',
    });
    assert.equal(changed.status, 'upgraded');
    const newVersion = planOne(target, skills, CONTRACT, {
      projectDir: project, repoRoot: REPO_ROOT, version: '2.0.0', generatedAt: '2020-01-01',
    });
    assert.equal(newVersion.status, 'upgraded', 'a router version change is a real change');
  });

  test('the block says where it came from and how to regenerate it', () => {
    const { home, project } = makeSandbox();
    run(['--host', 'cursor', '--apply'], { home, project });
    const text = fs.readFileSync(
      path.join(project, '.cursor', 'rules', 'obsidian-mcp-router-skills.mdc'), 'utf8',
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.ok(text.includes(`v${pkg.version}`), 'router version missing');
    assert.ok(text.includes(REPO_ROOT.split(path.sep).join('/')), 'source tree missing');
    assert.match(text, /npm run install:agent-rules/, 'regenerate command missing');
    assert.match(text, /ABSOLUTE and local to the machine/, 'absolute-path warning missing');
    assert.match(text, /read that `SKILL\.md` in full before acting/, 'bridge rule missing');
  });

  test('--skills indexes exactly the named skills and refuses an unknown one', () => {
    const { home, project } = makeSandbox();
    const json = JSON.parse(run(['--host', 'agents-md', '--skills', 'save,lock', '--json'], { home, project }).stdout);
    assert.equal(json.skillCount, 2);

    run(['--host', 'agents-md', '--skills', 'save,lock', '--apply'], { home, project });
    const text = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('`save`') && text.includes('`lock`'));
    assert.ok(!text.includes('`wiki-lint`'), 'an unnamed skill must not be indexed');

    const bad = run(['--host', 'agents-md', '--skills', 'save,nope'], { home, project });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown skill\(s\): nope/);
  });
});

describe('the preview under-declared what apply would do', () => {
  // Found by executing both halves and diffing the filesystem, not by reading
  // the code: in each case the preview named N things and the apply produced
  // more. A preview is a promise, and an incomplete promise is a wrong one.

  function stageUpgrade({ home, project }) {
    run(['--host', 'agents-md', '--apply'], { home, project });
    const target = path.join(project, 'AGENTS.md');
    const cur = fs.readFileSync(target, 'utf8');
    const { beginMarker, endMarker } = CONTRACT.block;
    fs.writeFileSync(target,
      `${cur.slice(0, cur.indexOf(beginMarker) + beginMarker.length)}\nSTALE\n${cur.slice(cur.indexOf(endMarker))}`,
      'utf8');
    return target;
  }

  test('an upgrade preview announces the sidecar the apply will create', () => {
    const { home, project } = makeSandbox();
    stageUpgrade({ home, project });

    const json = JSON.parse(run(['--host', 'agents-md', '--json'], { home, project }).stdout);
    assert.equal(json.targets[0].status, 'upgraded');
    assert.ok(json.targets[0].backup, 'the upgrade plan carries no `backup` field');
    assert.match(json.targets[0].backup, /\.bak-skills-index-/);

    const human = run(['--host', 'agents-md'], { home, project }).stdout;
    assert.match(human, /backup\s*:/, 'the human preview does not mention the backup');
    assert.match(human, /bak-skills-index/);
  });

  test('the number of files the upgrade preview implies is the number apply creates', () => {
    // The defect, stated as the measurement that caught it: preview announced
    // one file, apply produced two.
    const { home, project } = makeSandbox();
    stageUpgrade({ home, project });

    const json = JSON.parse(run(['--host', 'agents-md', '--json'], { home, project }).stdout);
    const announced = new Set([json.targets[0].file]);
    if (json.targets[0].backup) announced.add('backup');

    const before = snapshot(project);
    run(['--host', 'agents-md', '--apply'], { home, project });
    const changed = changedPaths(before, snapshot(project), project);

    assert.equal(changed.length, announced.size,
      `apply touched ${changed.length} path(s) but the preview implied ${announced.size}: ${changed.join(', ')}`);
    assert.equal(changed.filter((f) => f.includes('.bak-skills-index-')).length, 1);
  });

  test('a first install announces no backup, because it destroys nothing', () => {
    const { home, project } = makeSandbox();
    const json = JSON.parse(run(['--host', 'agents-md', '--json'], { home, project }).stdout);
    assert.equal(json.targets[0].status, 'installed');
    assert.equal(json.targets[0].backup, null, 'an append must not promise a backup it will not make');
  });

  test('creatingDirs is the full chain apply walks, not just the immediate parent', () => {
    const { home, project } = makeSandbox();
    const json = JSON.parse(run(['--host', 'cursor', '--json'], { home, project }).stdout);
    const announced = json.targets[0].creatingDirs.map((d) => path.relative(project, d)).sort();
    assert.deepEqual(announced, ['.cursor', path.join('.cursor', 'rules')].sort(),
      'applyOne mkdirs recursively, so `.cursor` is created too and must be announced');

    run(['--host', 'cursor', '--apply'], { home, project });
    for (const rel of announced) {
      assert.ok(fs.existsSync(path.join(project, rel)), `${rel} was announced but not created`);
    }
    assert.equal(missingAncestors(path.join(project, '.cursor', 'rules', 'x.mdc')).length, 0,
      'after apply, nothing in the chain is still missing');
  });

  test('every directory apply creates was named by the preview', () => {
    // The general form, checked against the deepest target rather than a
    // hand-picked one: the Windsurf user file sits under .codeium/windsurf/.
    const { home, project } = makeSandbox();
    const json = JSON.parse(run(['--json'], { home, project }).stdout);
    const announced = new Set(json.targets.flatMap((t) => t.creatingDirs));

    const dirsBefore = new Set();
    const collect = (root, into) => {
      if (!fs.existsSync(root)) return;
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        into.add(path.join(root, e.name));
        collect(path.join(root, e.name), into);
      }
    };
    collect(home, dirsBefore);
    collect(project, dirsBefore);

    run(['--apply'], { home, project });

    const dirsAfter = new Set();
    collect(home, dirsAfter);
    collect(project, dirsAfter);

    const created = [...dirsAfter].filter((d) => !dirsBefore.has(d));
    const unannounced = created.filter((d) => !announced.has(d));
    assert.deepEqual(unannounced, [], `apply created directories the preview never named: ${unannounced.join(', ')}`);
    assert.ok(created.length >= 3, `expected several directories to be created, saw ${created.length}`);
  });

  test('uninstall states that the file itself survives', () => {
    const { home, project } = makeSandbox();
    run(['--host', 'agents-md', '--apply'], { home, project });
    const out = run(['--host', 'agents-md', '--uninstall'], { home, project }).stdout;
    assert.match(out, /the FILE itself is never deleted/);

    // And it is true: the file the installer created is still there, empty.
    run(['--host', 'agents-md', '--uninstall', '--apply'], { home, project });
    const target = path.join(project, 'AGENTS.md');
    assert.ok(fs.existsSync(target), 'uninstall must not delete the file');
    assert.equal(fs.readFileSync(target, 'utf8').trim(), '');
  });

  test('--show-block is refused rather than silently ignored', () => {
    const { home, project } = makeSandbox();
    for (const combo of [['--show-block', '--json'], ['--show-block', '--uninstall']]) {
      const res = run(['--host', 'agents-md', ...combo], { home, project });
      assert.equal(res.status, 1, `${combo.join(' ')} should be refused`);
      assert.match(res.stderr, /--show-block cannot be combined with/);
    }
    // On its own it still works — the refusal is scoped, not a removal.
    const ok = run(['--host', 'agents-md', '--show-block'], { home, project });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /rendered block \(first target\)/);
  });
});

describe('the token next door', () => {
  test('the canary never appears in output or in any written file, and the config is byte-identical', () => {
    const { home, project, configToml } = makeSandbox();
    const configSha = sha(fs.readFileSync(configToml));

    const outputs = [];
    for (const args of [[], ['--show-block'], ['--json'], ['--apply'], ['--uninstall'], ['--uninstall', '--apply']]) {
      const res = run(args, { home, project });
      // Without this, a crash on startup — a syntax error, a bad import —
      // yields empty output, and every "the canary is absent" assertion below
      // passes because nothing ran at all.
      assert.equal(res.status, 0, `\`${args.join(' ')}\` exited ${res.status}: ${res.stderr}`);
      outputs.push(res.stdout || '', res.stderr || '');
    }

    // POSITIVE CONTROL, part one: the detector can see the canary where the
    // canary certainly is.
    const configText = fs.readFileSync(configToml, 'utf8');
    assert.ok(configText.includes(CANARY), 'positive control: the canary must be findable where it certainly is');

    // POSITIVE CONTROL, part two: the subject actually ran and actually wrote.
    // Part one alone only proves that String.includes works, which was never
    // in doubt — it says nothing about whether the installer executed.
    assert.ok(
      outputs.join('').includes('INDEX OF SKILLS'),
      'positive control: the installer produced no recognisable output',
    );

    for (const out of outputs) {
      assert.ok(!out.includes(CANARY), 'the canary reached the installer output');
    }

    for (const root of [home, project]) {
      for (const rel of snapshot(root).keys()) {
        const abs = path.join(root, rel);
        if (abs === configToml) continue;
        assert.ok(!fs.readFileSync(abs, 'utf8').includes(CANARY), `the canary reached ${abs}`);
      }
    }

    assert.equal(sha(fs.readFileSync(configToml)), configSha, 'config.toml must not be modified');
  });

  test('the shipped contract declares no non-markdown target', () => {
    // Contract-drift guard. Named for what it is: deleting assertSafeTarget()
    // entirely would leave this green, so it is not the structural claim.
    for (const host of Object.values(CONTRACT.hosts)) {
      for (const target of Object.values(host.targets)) {
        const ext = path.extname(target.file).toLowerCase();
        assert.ok(CONTRACT.allowedTargetExtensions.includes(ext), `${target.file} has extension ${ext}`);
      }
    }
  });

  test('a contract that DID declare a .toml target is refused by the code, not just absent', () => {
    // The structural claim itself: the refusal lives in the code path, so it
    // survives someone adding a hostile or careless entry to the contract.
    const hostile = {
      ...CONTRACT,
      hosts: {
        evil: { label: 'evil', targets: { user: { file: 'config.toml', base: 'codex-home', format: 'markdown' } } },
      },
    };
    assert.throws(
      () => planTargets(hostile, { projectDir: path.join(os.tmpdir(), 'p'), home: '/h', env: {} }),
      /allowedTargetExtensions/,
    );
  });

  test('a symlink wearing a declared name is refused rather than followed', () => {
    // The name check constrains the leaf; the filesystem constrains the inode.
    // An AGENTS.md symlinked at a .toml passes every name rule and then reads
    // and writes straight through to the token.
    const { home, project, configToml } = makeSandbox();
    const link = path.join(project, 'AGENTS.md');
    try {
      fs.symlinkSync(configToml, link, 'file');
    } catch {
      return; // unprivileged Windows cannot create symlinks; nothing to assert
    }
    const configSha = sha(fs.readFileSync(configToml));

    // The NAME guard passes — that is the whole point of the second guard.
    assert.equal(assertSafeTarget(link, CONTRACT), true);
    assert.throws(() => assertSafeFile(link, CONTRACT), /symbolic link/);

    const res = run(['--host', 'agents-md', '--apply', '--json'], { home, project });
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.targets[0].status, 'failed');
    assert.match(payload.targets[0].error, /symbolic link/);
    assert.equal(sha(fs.readFileSync(configToml)), configSha, 'the linked-to file must be untouched');
    assert.ok(!res.stdout.includes(CANARY));
  });
});

describe('rendering', () => {
  test('the index links every skill that exists, counted not listed', () => {
    const { project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'skills', e.name, 'SKILL.md')));
    assert.equal(skills.length, onDisk.length);

    const body = renderSkillsIndex(skills, {
      mode: 'full', targetFile: path.join(project, 'AGENTS.md'), projectDir: project, repoRoot: REPO_ROOT,
    });
    for (const s of skills) assert.ok(body.includes(`\`${s.name}\``), `${s.name} missing from the index`);
    // Deliberately no count footer — see renderSkillsIndex(). The index must
    // not state a number, so that installing it into a repository whose
    // handshake requires MEASURING that number cannot answer the question.
    assert.ok(!/\d+ skills indexed/.test(body));
  });

  test('a link is relative inside a project and absolute out of it', () => {
    const project = path.join(os.tmpdir(), 'c12-link-project');
    const skillFile = path.join(project, 'skills', 'demo', 'SKILL.md');
    assert.equal(
      skillLinkPath(skillFile, path.join(project, '.cursor', 'rules', 'x.mdc'), project),
      '../../skills/demo/SKILL.md',
    );
    const outside = skillLinkPath(skillFile, path.join(os.tmpdir(), 'elsewhere', 'AGENTS.md'), project);
    assert.equal(outside, skillFile.split(path.sep).join('/'));
  });

  test('a new .mdc gets the frontmatter Cursor needs; an existing file keeps its own', () => {
    const { home, project } = makeSandbox();
    run(['--host', 'cursor', '--apply'], { home, project });
    const file = path.join(project, '.cursor', 'rules', 'obsidian-mcp-router-skills.mdc');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^---\n/);
    // The activation policy is deliberate, not incidental. `alwaysApply: false`
    // with no `globs` is the one combination that makes a Cursor rule inert —
    // nothing matches it and nothing loads it — which for an INDEX is fatal:
    // an agent cannot ask for the catalogue of skills it does not know exists.
    assert.match(text, /alwaysApply: true/);
    assert.match(text, /^globs: /m);
    assert.match(text, /^description: "/m, 'description must be quoted — it contains commas and apostrophes');
    const fmKeys = text.split('---')[1].trim().split('\n')
      .filter((l) => /^[a-zA-Z]/.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(fmKeys.sort(), ['alwaysApply', 'description', 'globs'],
      'only the three keys Cursor documents');

    const { home: home2, project: project2 } = makeSandbox();
    const file2 = path.join(project2, '.cursor', 'rules', 'obsidian-mcp-router-skills.mdc');
    fs.mkdirSync(path.dirname(file2), { recursive: true });
    fs.writeFileSync(file2, '---\ndescription: mine\nalwaysApply: true\n---\n\nMy rule.\n', 'utf8');
    run(['--host', 'cursor', '--apply'], { home: home2, project: project2 });
    const text2 = fs.readFileSync(file2, 'utf8');
    assert.match(text2, /^---\ndescription: mine\nalwaysApply: true\n---\n/, 'existing frontmatter is the owner\'s');
    assert.match(text2, /My rule\./);
  });
});

describe('helper-level plan and apply', () => {
  test('planTargets expands every host in the contract', () => {
    const { home, project } = makeSandbox();
    const targets = planTargets(CONTRACT, { projectDir: project, home, env: {} });
    const declared = Object.values(CONTRACT.hosts)
      .reduce((n, h) => n + Object.keys(h.targets).length, 0);
    assert.equal(targets.length, declared);
  });

  test('applyOne then planOneUninstall agree about what is there', () => {
    const { home, project } = makeSandbox();
    const skills = collectSkills(REPO_ROOT);
    const target = planTargets(CONTRACT, { projectDir: project, home, env: {}, hosts: ['agents-md'] })[0];
    const plan = planOne(target, skills, CONTRACT, { projectDir: project, repoRoot: REPO_ROOT });
    assert.equal(plan.status, 'installed');
    applyOne(plan, CONTRACT);
    assert.equal(planOneUninstall(target, CONTRACT).status, 'removed');
    applyUninstallOne(planOneUninstall(target, CONTRACT), CONTRACT);
    assert.equal(planOneUninstall(target, CONTRACT).status, 'not-installed');
  });
});
