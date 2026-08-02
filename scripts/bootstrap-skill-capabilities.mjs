#!/usr/bin/env node
/**
 * bootstrap-skill-capabilities.mjs — C8 seeding.
 *
 * Derives a PROPOSED capability declaration for every skill from the code:
 * which router MCP tools each SKILL.md names, and what those tools imply
 * about reading, writing, and network access.
 *
 * The output is explicitly a proposal. Every generated entry carries the
 * UNREVIEWED-BOOTSTRAP marker, which the validator rejects — so a generated
 * file cannot go green until a human has read each SKILL.md and replaced the
 * generated reason. That is the mechanism behind "bootstrap automatically,
 * THEN review": without it, "review" is a hope.
 *
 * Preview-first, like every other destructive-ish operation in this repo:
 * with no flags it prints the proposal and writes nothing.
 *
 * Usage:
 *   node scripts/bootstrap-skill-capabilities.mjs             # preview
 *   node scripts/bootstrap-skill-capabilities.mjs --missing-only --write
 *   node scripts/bootstrap-skill-capabilities.mjs --write --out <path>
 *
 * Flags:
 *   --write          actually write the file (default: preview to stdout)
 *   --missing-only   keep existing entries verbatim; only add skills that
 *                    have none. This is the flag to use once the file is
 *                    curated — it can never clobber a reviewed entry.
 *   --force          allow --write to discard reviewed entries (never implicit)
 *   --out <path>     write somewhere else (default: contracts/skill-capabilities.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION, DECLARATIONS_PATH, BOOTSTRAP_SENTINEL,
  discoverSkills, mentionedTools, readDeclarations, duplicateSkillKeys,
  // Imported, never re-declared. Local copies drift, and this module is
  // exactly where a drifted copy does damage: it would propose
  // `network: false` for every newly-added network tool, and the
  // reviewer would have no reason to doubt it.
  NETWORK_TOOLS, PYTHON_TOOLS, TOOL_WRITE_FLOOR,
} from '../src/helpers/skill-capabilities.mjs';
import { _internals } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read + parse a JSON file, mirroring readDeclarations' non-throwing shape —
 * INCLUDING its duplicate-key refusal.
 *
 * Plain `JSON.parse` resolves duplicate skill keys last-wins in silence, so
 * an alternate `--out` target bypassed the very check the default path
 * enforces, and `--missing-only` would then "preserve" a file it had already
 * misread — discarding a reviewed entry while promising not to.
 */
function readJsonAt(abs) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (err) { return { ok: false, data: null, error: err.message }; }
  let data;
  try { data = JSON.parse(text); }
  catch (err) { return { ok: false, data: null, error: err.message }; }
  const dupes = duplicateSkillKeys(text);
  if (dupes.length > 0) {
    return { ok: false, data: null, error: `declares ${dupes.join(', ')} more than once — JSON keeps only the last, so an earlier declaration is being discarded` };
  }
  return { ok: true, data, error: null };
}

function parseArgs(argv) {
  const out = { write: false, missingOnly: false, force: false, out: DECLARATIONS_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--force') out.force = true;
    else if (a === '--missing-only') out.missingOnly = true;
    else if (a === '--out') {
      const value = argv[++i];
      // A missing value used to sail through as `undefined` and blow up
      // later inside path.resolve with an opaque stack trace.
      if (!value || value.startsWith('--')) {
        console.error('--out needs a path, e.g. --out contracts/skill-capabilities.json');
        process.exit(2);
      }
      out.out = value;
    } else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown flag: ${a}`); process.exit(2); }
  }
  return out;
}

/**
 * Propose one entry. Everything here is a guess made explicit — the reads /
 * writes / writeMode fall out of what the named tools do, which is right
 * often enough to save typing and wrong often enough that the sentinel is
 * mandatory. A skill whose SKILL.md names `write_file` inside a "keep this
 * hash for a later write" paragraph will be proposed as a writer; only a
 * human reading the page can tell.
 */
function proposeEntry(skill, toolNames, writeToolNames) {
  const named = [...mentionedTools(skill.text, toolNames)].sort();
  const writes = named.filter((t) => writeToolNames.has(t));
  const reads = new Set();
  const writeAtoms = new Set();

  if (named.length > 0) reads.add('vault:content');
  if (named.some((t) => t === 'list_files' || t === 'list_vaults')) reads.add('vault:listing');
  if (named.some((t) => t === 'search' || t === 'search_smart')) reads.add('vault:search');
  if (named.some((t) => t === 'get_frontmatter')) reads.add('vault:frontmatter');
  if (named.some((t) => NETWORK_TOOLS.includes(t))) reads.add('web');

  for (const t of writes) {
    if ((TOOL_WRITE_FLOOR[t] && TOOL_WRITE_FLOOR[t].atom === 'vault:derived')) writeAtoms.add('vault:derived');
    else if (t === 'set_frontmatter' || t === 'merge_frontmatter') writeAtoms.add('vault:frontmatter');
    else writeAtoms.add('vault:content');
  }

  // Order matters, and it is MAXIMUM-first. Checking `write_bundle` before
  // delete/move used to propose `transactional` for a page that names both,
  // quietly understating a skill that can lose content — the exact direction
  // this whole feature calls dangerous.
  let writeMode = 'read-only';
  if (writes.includes('delete_file') || writes.includes('move_file')) writeMode = 'destructive';
  else if (writes.includes('write_bundle')) writeMode = 'transactional';
  else if (writes.length > 0) {
    writeMode = writes.every((t) => (TOOL_WRITE_FLOOR[t] && TOOL_WRITE_FLOOR[t].atom === 'vault:derived'))
      ? 'cache'
      : (writes.every((t) => t === 'append_to_file') ? 'append-only' : 'mutating');
  }

  return {
    summary: (skill.declaredName || skill.name) + ' — TODO: one line, in plain language.',
    reads: [...reads].sort(),
    writes: [...writeAtoms].sort(),
    tools: named,
    toolsMentionedNotCalled: [],
    writeMode,
    requires: {
      shell: false,
      network: named.some((t) => NETWORK_TOOLS.includes(t)),
      python: named.some((t) => PYTHON_TOOLS.includes(t)),
      obsidianPlugins: [],
      binaries: [],
    },
    verification: {
      status: 'declared',
      reason: `${BOOTSTRAP_SENTINEL}: generated from the tools ${skill.skillMdPath} names. Read the page, correct this entry, then replace this reason.`,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').slice(1, 30).join('\n').replace(/^ \* ?/gm, ''));
    return;
  }

  const toolNames = new Set(_internals.TOOLS.map((t) => t.name));
  const writeToolNames = _internals.WRITE_TOOL_NAMES;
  const skills = discoverSkills(REPO_ROOT);

  // `--missing-only` preserves what is ALREADY IN THE TARGET, not what is in
  // the default manifest. Reading the default while writing elsewhere would
  // silently overwrite a curated alternate file with unrelated entries — the
  // opposite of what the flag promises.
  const targetRel = args.out;
  const targetAbs = path.resolve(REPO_ROOT, targetRel);
  const targetExists = fs.existsSync(targetAbs);
  const existing = targetRel === DECLARATIONS_PATH
    ? readDeclarations(REPO_ROOT)
    : readJsonAt(targetAbs);

  // `--missing-only` promises to keep existing entries verbatim. If the
  // target exists but cannot be understood — malformed JSON, duplicate skill
  // keys — treating it as empty would silently OVERWRITE the curated file it
  // was told to preserve. Refuse instead.
  if (args.missingOnly && targetExists && !existing.ok) {
    console.error(`--missing-only refuses to touch ${targetRel}: ${existing.error}`);
    console.error('Fix the file (or drop --missing-only to regenerate it wholesale) — overwriting a manifest we could not read would discard reviewed work.');
    process.exit(1);
  }
  const prior = (existing.ok && existing.data && existing.data.skills) || {};

  // `--write` WITHOUT `--missing-only` replaces every entry, reviewed ones
  // included. The header of this file promises "preview-first, like every
  // other destructive-ish operation in this repo" — in a repo where the
  // purge demands a C3 seal and `delete_file` demands `confirm:true`,
  // silently discarding 46 hand-reviewed declarations was the one
  // unguarded destructive path left.
  // An existing-but-UNREADABLE target is the state the guard below is most
  // needed for, and it was exactly where it switched off: the check hung on
  // `existing.ok`, so malformed JSON or a duplicate key skipped it entirely
  // and `--write` overwrote 46 reviewed entries with exit 0. The neighbouring
  // `--missing-only` branch already refuses this case for the same stated
  // reason; this one made the same promise and did not keep it.
  if (args.write && !args.missingOnly && targetExists && !existing.ok && !args.force) {
    console.error(`Refusing: ${targetRel} exists but could not be read (${existing.error}).`);
    console.error('It may hold reviewed entries. Fix the file, or pass --force to regenerate it anyway.');
    process.exit(1);
  }
  if (args.write && !args.missingOnly && existing.ok) {
    const reviewed = Object.entries(prior).filter(
      ([, e]) => !(e && e.verification && typeof e.verification.reason === 'string'
        && e.verification.reason.includes(BOOTSTRAP_SENTINEL)),
    );
    if (reviewed.length > 0 && !args.force) {
      console.error(`Refusing: ${targetRel} holds ${reviewed.length} reviewed entr${reviewed.length === 1 ? 'y' : 'ies'} that --write would discard.`);
      console.error('');
      console.error('  --missing-only --write   add only the skills that have no entry (keeps reviewed work)');
      console.error('  --force --write          regenerate everything, discarding those reviews');
      process.exit(1);
    }
  }

  const out = {
    schemaVersion: SCHEMA_VERSION,
    $comment: [
      'Capability contracts for the shipped skills (C8). Machine-readable on purpose:',
      'this is the raw material for MCPHub/SaaS permissioning. Vocabularies and the',
      'honesty rule live in src/helpers/skill-capabilities.mjs; `npm run validate`',
      'fails the build when this file, the SKILL.md pages, and the code disagree.',
    ].join(' '),
    skills: {},
  };

  let added = 0;
  let kept = 0;
  for (const skill of skills) {
    if (args.missingOnly && Object.prototype.hasOwnProperty.call(prior, skill.name)) {
      out.skills[skill.name] = prior[skill.name];
      kept++;
      continue;
    }
    out.skills[skill.name] = proposeEntry(skill, toolNames, writeToolNames);
    added++;
  }

  const json = JSON.stringify(out, null, 2) + '\n';
  const target = path.resolve(REPO_ROOT, args.out);

  if (!args.write) {
    console.log(json);
    console.error(`\n[preview] ${added} proposed, ${kept} kept verbatim. Nothing written.`);
    console.error(`[preview] Re-run with --write to write ${args.out}.`);
    console.error(`[preview] Every proposed entry carries ${BOOTSTRAP_SENTINEL} and WILL fail \`npm run validate\` until reviewed.`);
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json, 'utf8');
  console.log(`Wrote ${args.out} — ${added} proposed, ${kept} kept verbatim.`);
  if (added > 0) {
    console.log(`\n${added} entr${added === 1 ? 'y' : 'ies'} carry ${BOOTSTRAP_SENTINEL}. Review each one, then \`npm run validate\`.`);
  }
}

main();
