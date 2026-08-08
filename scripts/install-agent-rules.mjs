#!/usr/bin/env node
/**
 * install-agent-rules.mjs — C12.
 *
 * Installs an INDEX OF SKILLS into the rule files that Codex, Gemini CLI, Cursor
 * and Windsurf read, so an agent arriving through one of those hosts gets a
 * catalogue of the manuals and where to read them — not only the tool list.
 *
 * WHAT THIS IS NOT. It does not install skills. Nothing here makes a foreign
 * host execute a `SKILL.md`; the skills stay where they are and the hosts keep
 * whatever skill support they have. What travels is a list of pointers plus the
 * rule that says to read the pointed-at page before acting. Calling it "installing
 * the skills" would promise an execution semantics that no line of this file
 * provides — see the README for the native-adapter route, which would.
 *
 * PREVIEW IS THE DEFAULT, and not as a courtesy: every target but one is a file
 * in the user's home directory or in a repository this tool did not author. The
 * run that writes is the one that had to be asked for. Preview is also the
 * STATUS command — with no flags it reports, per target, what is currently
 * installed there.
 *
 * Usage:
 *   node scripts/install-agent-rules.mjs                       # status / preview, writes nothing
 *   node scripts/install-agent-rules.mjs --host codex          # filter by host (repeatable)
 *   node scripts/install-agent-rules.mjs --scope project       # filter by scope
 *   node scripts/install-agent-rules.mjs --skills a,b,c        # index only these skills
 *   node scripts/install-agent-rules.mjs --project <dir>       # project root (default: cwd)
 *   node scripts/install-agent-rules.mjs --apply               # write
 *   node scripts/install-agent-rules.mjs --uninstall           # preview removal (shows it verbatim)
 *   node scripts/install-agent-rules.mjs --uninstall --apply   # remove
 *   node scripts/install-agent-rules.mjs --show-block          # print the rendered block
 *   node scripts/install-agent-rules.mjs --json                # machine output
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planTargets, planOne, planOneUninstall, applyOne, applyUninstallOne, collectSkills,
} from '../src/helpers/agent-host-install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_REL = 'contracts/agent-host-targets.json';

const argv = process.argv.slice(2);
function multi(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  return out.length ? out : null;
}
function single(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  // `--project --apply` must not resolve the project to `<cwd>/--apply` and
  // then cheerfully write four files there.
  if (!v || v.startsWith('--')) {
    console.error(`${flag} requires a value.`);
    process.exit(1);
  }
  return v;
}

const apply = argv.includes('--apply');
const uninstall = argv.includes('--uninstall');
const asJson = argv.includes('--json');
const showBlock = argv.includes('--show-block');
// A flag that is silently ignored is a bad state: the user asked for something
// and got no output and no error. Refuse the combination and name the reason.
if (showBlock && (asJson || uninstall)) {
  console.error(
    '--show-block cannot be combined with '
    + `${asJson ? '--json' : '--uninstall'}.`,
  );
  console.error(asJson
    ? '  In --json mode the rendered block is deliberately not in the payload; use --show-block on its own.'
    : '  On the uninstall path the block that will be removed is already printed verbatim.');
  process.exit(1);
}

const projectDir = path.resolve(single('--project', process.cwd()));
const hosts = multi('--host');
const scopes = multi('--scope');

const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONTRACT_REL), 'utf8'));

let targets;
try {
  targets = planTargets(contract, { projectDir, home: os.homedir(), env: process.env, hosts, scopes });
} catch (err) {
  console.error(`refused: ${err.message}`);
  process.exit(1);
}

if (targets.length === 0) {
  console.error('no targets matched the --host / --scope filters.');
  console.error(`hosts: ${Object.keys(contract.hosts).join(', ')}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

let skills = collectSkills(REPO_ROOT);
const wantSkills = single('--skills', null);
if (wantSkills) {
  const asked = wantSkills.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(skills.map((s) => s.name));
  const unknown = asked.filter((a) => !known.has(a));
  if (unknown.length) {
    // Refuse rather than quietly index a shorter list: an index that silently
    // omits what you asked for is worse than an error, because the gap looks
    // like a skill that does not exist.
    console.error(`unknown skill(s): ${unknown.join(', ')}`);
    console.error(`known (${known.size}): ${[...known].sort().join(', ')}`);
    process.exit(1);
  }
  const wanted = new Set(asked);
  skills = skills.filter((s) => wanted.has(s.name));
}

const plans = uninstall
  ? targets.map((t) => planOneUninstall(t, contract))
  : targets.map((t) => planOne(t, skills, contract, {
    projectDir, repoRoot: REPO_ROOT, version: pkg.version,
  }));

const CHANGING = uninstall ? new Set(['removed']) : new Set(['installed', 'upgraded']);
const BLOCKED = new Set(['ambiguous-state', 'over-budget', 'failed']);

const applied = [];
if (apply) {
  for (const plan of plans) {
    if (!CHANGING.has(plan.status)) continue;
    try {
      const res = uninstall ? applyUninstallOne(plan, contract) : applyOne(plan, contract);
      applied.push({ file: res.file, status: plan.status, bytes: res.bytes, backup: res.backup });
      // Not in --json mode: a stray human line ahead of the payload makes the
      // whole document unparseable, which is how this was found.
      if (res.backup && !asJson) console.log(`  backup: ${res.backup}`);
    } catch (err) {
      plan.status = 'failed';
      plan.error = err.message;
    }
  }
}

const blocked = plans.filter((p) => BLOCKED.has(p.status));

if (asJson) {
  console.log(JSON.stringify({
    ok: blocked.length === 0,
    mode: uninstall ? 'uninstall' : 'install',
    applyRequested: apply,
    projectDir,
    skillCount: skills.length,
    targets: plans.map(({ body, expectExisting, ...rest }) => rest),
    written: applied,
  }, null, 2));
} else {
  const verb = uninstall ? 'REMOVE' : 'INSTALL';
  console.log(`${apply ? '' : '[PREVIEW] '}${verb} — obsidian-mcp-router INDEX OF SKILLS (pointers to manuals, not the skills themselves)`);
  console.log(`  project        : ${projectDir}`);
  console.log(`  skills indexed : ${skills.length} (counted under ${path.join(REPO_ROOT, 'skills')})`);
  console.log(`  marker         : ${contract.block.beginMarker}`);
  console.log('');
  for (const p of plans) {
    console.log(`  ${p.hostId}/${p.scope} — ${p.hostLabel}`);
    console.log(`    file      : ${p.file}`);
    console.log(`    status    : ${p.status}${p.exists ? '' : ' (file does not exist yet)'}`);
    if (!uninstall) {
      console.log(`    block     : ${p.bytes} chars, ${p.mode} rendering`
        + ` → file ${p.projectedBytes} chars${p.charBudget ? ` (host cap ${p.charBudget})` : ''}`);
      if (p.creatingDirs.length) console.log(`    creates   : ${p.creatingDirs.join(', ')}`);
      if (p.backup) {
        console.log(`    backup    : ${p.backup}`);
        console.log('                (this upgrade replaces the bytes between the markers, so a sidecar '
          + 'copy of the current file is written first — one extra file will appear)');
      }
      if (p.absoluteLinks) {
        console.log('    heads up  : the skill links are written as an absolute path on THIS machine, '
          + 'because the skills tree is outside --project. Rule files under .cursor/ and .windsurf/ '
          + 'are normally committed, where such a link is dead for everyone else.');
      }
    } else if (p.status === 'removed') {
      console.log(`    removing  : ${p.removedBytes} chars between the markers`);
      // Verbatim, never abbreviated. The user is approving a deletion; a
      // summary of what will be deleted is a promise, not a review.
      console.log('    ----- exact text to be removed -----');
      for (const line of p.removedText.replace(/\n$/, '').split('\n')) console.log(`    | ${line}`);
      console.log('    ----- end -----');
      if (p.backup) console.log(`    backup    : ${p.backup} (written before removal)`);
      console.log('    note      : only the block is removed — the FILE itself is never deleted, even '
        + 'if this installer created it. It may be left empty, or holding just its own frontmatter. '
        + 'Without a receipt proving authorship, deleting a file we might not own is not a call this tool makes.');
    }
    console.log(`    provenance: ${p.provenance} — ${p.source}`);
    if (p.note) console.log(`    note      : ${p.note}`);
    if (p.error) console.log(`    REFUSED   : ${p.error}`);
    console.log('');
  }

  if (showBlock) {
    console.log('--- rendered block (first target) ---');
    console.log(plans[0].body);
    console.log('--- end ---');
  }

  const tally = {};
  for (const p of plans) tally[p.status] = (tally[p.status] || 0) + 1;
  console.log(`  ${plans.length} target(s): ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  if (!apply) {
    const changing = plans.filter((p) => CHANGING.has(p.status)).length;
    console.log(`  Nothing was written. ${changing}/${plans.length} target(s) would change — re-run with --apply.`);
  } else {
    console.log(`  ${applied.length}/${plans.length} target(s) written.`);
  }
  if (blocked.length) {
    console.log(`  ${blocked.length}/${plans.length} target(s) refused — see REFUSED above.`);
  }
}

process.exitCode = blocked.length === 0 ? 0 : 1;
