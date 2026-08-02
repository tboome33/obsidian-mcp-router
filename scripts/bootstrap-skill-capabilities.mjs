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
 *   --out <path>     write somewhere else (default: contracts/skill-capabilities.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION, DECLARATIONS_PATH, BOOTSTRAP_SENTINEL,
  discoverSkills, mentionedTools, readDeclarations,
} from '../src/helpers/skill-capabilities.mjs';
import { _internals } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tools whose implementation reaches the public internet. Derived by reading
 * src/tools/ — kept as an explicit list here (rather than guessed from the
 * name) because getting this wrong in the permissive direction is how a
 * "no network" declaration becomes false.
 */
const NETWORK_TOOLS = new Set([
  'webpage_to_markdown', 'youtube_to_markdown', 'bing_search_to_markdown',
  'git_repo_to_markdown', 'download_page_assets', 'extract_page_metadata',
]);

/** Tools that need the bundled Python toolchain (MarkItDown / Docling). */
const PYTHON_TOOLS = new Set([
  'pdf_to_markdown', 'pdf_to_markdown_docling', 'pdf_to_images',
  'docx_to_markdown', 'pptx_to_markdown', 'xlsx_to_markdown',
  'audio_to_markdown', 'image_to_markdown',
]);

/** Tools that write only regenerable, derived artifacts. */
const DERIVED_WRITE_TOOLS = new Set([
  'build_search_index', 'build_wiki_graph', 'refresh_okf_projections', 'record_source',
]);

/** Read + parse a JSON file, mirroring readDeclarations' non-throwing shape. */
function readJsonAt(abs) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(abs, 'utf8')), error: null }; }
  catch (err) { return { ok: false, data: null, error: err.message }; }
}

function parseArgs(argv) {
  const out = { write: false, missingOnly: false, out: DECLARATIONS_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
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
  if (named.some((t) => NETWORK_TOOLS.has(t))) reads.add('web');

  for (const t of writes) {
    if (DERIVED_WRITE_TOOLS.has(t)) writeAtoms.add('vault:derived');
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
    writeMode = writes.every((t) => DERIVED_WRITE_TOOLS.has(t))
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
      network: named.some((t) => NETWORK_TOOLS.has(t)),
      python: named.some((t) => PYTHON_TOOLS.has(t)),
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
