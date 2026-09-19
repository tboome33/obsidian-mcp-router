#!/usr/bin/env node
/**
 * EDIT A VAULT FILE THROUGH THE DOOR THAT HAS A LOCK ON IT.
 *
 * Why this script exists, stated as the failure it prevents. On 2026-09-19 a
 * session edited three notes in a SHARED vault with a hand-rolled fetch:
 *
 *     await fetch(url, { method: 'PUT', headers: { ...auth,
 *       ...(sha ? { 'If-Match': `"${sha}"` } : {}) }, body });
 *
 * Every one of those writes landed with NO precondition, and nothing said so.
 * Two independent reasons, and the second is the one that matters:
 *
 *   1. The sha came from `stat.contentSha256` on the Local REST API's note
 *      JSON — a field that does not exist there (`stat` is `{ctime, mtime,
 *      size}`). It was `undefined`, so the conditional spread contributed
 *      nothing and the header was simply absent.
 *   2. Even with a correct hash it would have changed nothing: the core
 *      plugin's `PUT /vault/<path>` implements no precondition at all. Its
 *      only `if-match` code sits inside the bundled `send` library, which
 *      serves static GETs. MEASURED, not assumed.
 *
 * The precondition this repo relies on is `If-Match-Content-Sha256` on
 * `PUT /vault-cas/<path>`, a route the companion bridge plugin serves by doing
 * read-compare-write under a mutex inside the Obsidian process. That is the
 * door, and `writeFileIfMatch` in `src/rest-client.mjs` is the only handle on
 * it. This script exists so that reaching for the handle is SHORTER than
 * reaching for `fetch`, because the reason the rule was broken was never
 * ignorance — the rule was written down — it was that the wrong way took ten
 * lines and the right way took forty.
 *
 * WHAT IT GUARANTEES, and what it does not:
 *   - it never issues a write without a precondition computed from the bytes
 *     it just read, and it refuses to start rather than degrade;
 *   - every edit must match EXACTLY ONCE, or nothing is written;
 *   - for targeted edits, everything outside the replaced spans is proven
 *     byte-identical before the write;
 *   - it does NOT make the write atomic against Obsidian's own editor or a
 *     Sync/LiveSync apply. The CAS route serialises against other CAS writers
 *     only. `writeFileIfMatch` says so in its own contract, and this script
 *     reports which tier served the write instead of hiding the difference.
 *
 * USAGE
 *
 *   node scripts/vault-edit.mjs --vault "<name>" --path "<vault/relative.md>" \
 *        --spec <spec.json> [--dry-run] [--config <router-config.json>]
 *
 * The spec is a JSON file, and the replacement text lives in it rather than in
 * argv on purpose: a shell eats backslashes and backticks in silence, and this
 * repo has shipped two releases with text a heredoc mangled.
 *
 *   { "contentFile": "<local file>" }          whole-file replacement
 *
 *   { "edits": [                               targeted, order-independent
 *       { "kind": "unique", "from": "...", "to": "..." },
 *       { "kind": "line",   "startsWith": "...", "to": "<whole new line>" }
 *   ] }
 *
 * `unique` replaces one occurrence of an exact substring. `line` replaces one
 * whole line identified by its prefix — the form to use when the text carries
 * an apostrophe or a dash whose exact spelling you would otherwise have to
 * guess (a straight `'` and a typographic `’` look identical in a terminal and
 * cost a failed run each time).
 *
 * EXIT CODES: 0 wrote (or dry-run completed), 1 refused, 2 bad invocation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/registry.mjs';
import { getFileContent, writeFileIfMatch, RestApiError } from '../src/rest-client.mjs';
import { contentSha256, isContentSha256 } from '../src/helpers/content-hash.mjs';

const USAGE =
  'usage: node scripts/vault-edit.mjs --vault <name> --path <vault/relative.md> '
  + '--spec <spec.json> [--dry-run] [--config <path>]';

function die(code, message) {
  console.error(message);
  process.exit(code);
}

/** Parse `--flag value` pairs and bare `--flag` switches. No positional args. */
function parseArgv(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    if (!arg.startsWith('--')) die(2, `unexpected argument "${arg}"\n${USAGE}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(2, `--${key} needs a value\n${USAGE}`);
    i += 1;
    if (key === 'vault') out.vault = value;
    else if (key === 'path') out.path = value;
    else if (key === 'spec') out.spec = value;
    else if (key === 'config') out.configPath = value;
    else die(2, `unknown flag --${key}\n${USAGE}`);
  }
  return out;
}

/**
 * Apply the spec's edits to `before`, or throw with the reason.
 *
 * EVERY EDIT MATCHES EXACTLY ONCE. Zero matches means the anchor is stale and
 * the caller's mental model of the file is wrong; two or more means the anchor
 * does not identify what the caller thinks it identifies. Both are refusals,
 * because both would otherwise write a file nobody intended.
 *
 * Exported for the test suite: the decision logic is pure, so it can be driven
 * without a vault, and the network half stays a thin shell around it.
 *
 * @param {string} before
 * @param {Array<object>} edits
 * @returns {{ after: string, applied: Array<{ label: string, was: string, now: string }> }}
 */
export function applyEdits(before, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('spec.edits must be a non-empty array');
  }
  let working = before;
  const applied = [];
  const replacedSpans = [];

  for (const [index, edit] of edits.entries()) {
    const at = `edits[${index}]`;
    if (!edit || typeof edit !== 'object') throw new Error(`${at} is not an object`);
    if (typeof edit.to !== 'string') throw new Error(`${at}.to must be a string`);

    if (edit.kind === 'unique') {
      if (typeof edit.from !== 'string' || edit.from === '') {
        throw new Error(`${at}.from must be a non-empty string`);
      }
      const hits = working.split(edit.from).length - 1;
      if (hits !== 1) {
        throw new Error(
          `${at}: "${edit.from.slice(0, 60)}" matched ${hits} times, expected exactly 1`,
        );
      }
      working = working.replace(edit.from, edit.to);
      replacedSpans.push({ from: edit.from, to: edit.to });
      applied.push({ label: at, was: edit.from, now: edit.to });
      continue;
    }

    if (edit.kind === 'line') {
      if (typeof edit.startsWith !== 'string' || edit.startsWith === '') {
        throw new Error(`${at}.startsWith must be a non-empty string`);
      }
      const lines = working.split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startsWith(edit.startsWith)) hits.push(i);
      }
      if (hits.length !== 1) {
        throw new Error(
          `${at}: ${hits.length} lines start with "${edit.startsWith.slice(0, 60)}", expected exactly 1`,
        );
      }
      const was = lines[hits[0]];
      if (edit.to.includes('\n')) throw new Error(`${at}.to must be a single line`);
      lines[hits[0]] = edit.to;
      working = lines.join('\n');
      replacedSpans.push({ from: was, to: edit.to });
      applied.push({ label: at, was, now: edit.to });
      continue;
    }

    throw new Error(`${at}.kind must be "unique" or "line", got ${JSON.stringify(edit.kind)}`);
  }

  // NOTHING OUTSIDE THE REPLACED SPANS MAY MOVE. Rebuild the original from the
  // result by undoing each replacement in reverse, and require the bytes back.
  // This is the check that catches an edit whose `to` happens to contain
  // another edit's `from` — a reordering that silently corrupts a region the
  // caller never looked at. Skipped only when a replacement is not invertible
  // this way, which the `to === from` case below makes explicit.
  let rebuilt = working;
  for (let i = replacedSpans.length - 1; i >= 0; i -= 1) {
    const { from, to } = replacedSpans[i];
    if (to === from) continue;
    const back = rebuilt.split(to).length - 1;
    if (back !== 1) {
      throw new Error(
        `refused: the replacement for edits[${i}] cannot be verified (its new text occurs ${back} times). `
        + 'Choose a more specific anchor, or pass the whole file with "contentFile".',
      );
    }
    rebuilt = rebuilt.replace(to, from);
  }
  if (rebuilt !== before) {
    throw new Error('refused: something outside the replaced spans would have moved');
  }

  return { after: working, applied };
}

/** Read and validate the spec file; returns a resolver for the new content. */
function loadSpec(specPath) {
  let raw;
  try {
    raw = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    die(2, `cannot read spec ${specPath}: ${err.code ?? err.message}`);
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    die(2, `spec ${specPath} is not valid JSON: ${err.message}`);
  }
  const hasContent = typeof spec.contentFile === 'string';
  const hasEdits = spec.edits !== undefined;
  if (hasContent === hasEdits) {
    die(2, 'spec must carry EXACTLY ONE of "contentFile" or "edits"');
  }
  return { spec, hasContent };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (!args.vault || !args.path || !args.spec) die(2, USAGE);

  const { spec, hasContent } = loadSpec(args.spec);

  const registry = await loadRegistry(
    args.configPath ? { configPath: args.configPath } : {},
  );
  const vault = registry.resolveVault(args.vault);

  // THE READ THE WHOLE OPERATION HANGS ON. The precondition is computed from
  // these exact bytes, by the same hash core the router and the bridge both
  // use, so all three agree about what "unchanged" means.
  let before;
  try {
    before = await getFileContent(vault, args.path);
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'not_found') {
      die(1, `refused: ${args.path} does not exist in "${vault.name}". `
        + 'A file that is not there cannot be guarded by a content hash — create it with '
        + 'the router\'s write_file and `ifNew: true`, then edit it here.');
    }
    throw err;
  }
  before = typeof before === 'string' ? before : String(before);
  const sha = contentSha256(before);

  // FAIL AT THE DOOR, NOT ON THE WIRE. `writeFileIfMatch` is fail-closed with
  // a bad precondition, but it discovers that at the far end and reports it as
  // a conflict. The bug this script exists to prevent is a MISSING
  // precondition, so it is named here, before anything is sent.
  if (!isContentSha256(sha)) {
    die(1, 'refused: could not compute a content hash for the precondition — '
      + 'writing without one is the defect this script exists to prevent');
  }

  let after;
  let applied = [];
  if (hasContent) {
    const localPath = path.resolve(spec.contentFile);
    try {
      after = fs.readFileSync(localPath, 'utf8');
    } catch (err) {
      die(2, `cannot read contentFile ${localPath}: ${err.code ?? err.message}`);
    }
  } else {
    try {
      ({ after, applied } = applyEdits(before, spec.edits));
    } catch (err) {
      die(1, `refused: ${err.message}`);
    }
  }

  if (after === before) {
    console.log(`no change: ${args.path} already has this content — nothing written`);
    return;
  }

  for (const { label, was, now } of applied) {
    console.log(`  ${label}`);
    console.log(`    -  ${was.slice(0, 100)}`);
    console.log(`    +  ${now.slice(0, 100)}`);
  }
  console.log(
    `${before.length} → ${after.length} caractères, précondition ${sha.slice(0, 12)}…`,
  );

  if (args.dryRun) {
    console.log('--dry-run : rien écrit');
    return;
  }

  try {
    const result = await writeFileIfMatch(vault, args.path, after, sha);
    // The tier is REPORTED, never hidden: "atomic" is serialised by the bridge
    // against other CAS writers, "fallback" only re-checked the hash one round
    // trip before a plain PUT. They are not the same promise.
    console.log(`écrit — casMode: ${result.casMode}`);
  } catch (err) {
    if (err instanceof RestApiError && err.kind === 'conflict') {
      die(1, `refusé (409) : ${args.path} a changé depuis la lecture. Rien n'a été écrit. `
        + 'Relancer : la lecture reprendra le contenu courant.');
    }
    throw err;
  }
}

// Only run when invoked as a program — importing `applyEdits` for the tests
// must not reach the network. `fileURLToPath` rather than `new URL().pathname`
// because the latter yields "/I:/..." on Windows and would never compare equal.
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
