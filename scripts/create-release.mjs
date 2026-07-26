#!/usr/bin/env node
/**
 * create-release.mjs — publish the current version as a GitHub release.
 *
 * Counterpart of the `.githooks/post-commit` auto-tag hook: the hook
 * creates the local `v<version>` tag when the bump commit lands; this
 * script makes it public. Exists because between v0.8.2 and v0.47.0 the
 * repo shipped 40 versions with pushed commits but no tags and no
 * releases — GitHub's Releases box kept showing "v0.8.2, 2 months ago".
 *
 * What it does (in order):
 *   1. Reads `version` from package.json → tag `v<version>`.
 *   2. Extracts the matching CHANGELOG.md section (refuses to publish a
 *      stub still containing TODO — write the real entry first).
 *   3. Self-heals the tag: if `v<version>` doesn't exist locally but HEAD's
 *      package.json already carries that version, tags HEAD (covers commits
 *      made before the hook was armed). Refuses if the bump isn't committed.
 *   4. Pushes the current branch and the tag to `origin`.
 *   5. Creates the GitHub release via `gh release create` (or updates it
 *      via `gh release edit` if it already exists — idempotent re-runs).
 *
 * Usage:
 *   npm run release              — the real thing (pushes + publishes)
 *   npm run release -- --dry-run — show what would happen, touch nothing
 *
 * Exit codes: 0 success · 1 precondition failed (no committed bump, stub
 * changelog, missing gh, push/release failure).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Extract the CHANGELOG block for `version` from the raw file text.
 *
 * Expected heading shape (what bump-version.mjs inserts):
 *   ## [<version>] — <date> — <title>
 * Body = everything until the next `## [` heading (or EOF).
 *
 * Returns `{ heading, title, body }` or `null` when the version has no
 * entry. `title` falls back to the full heading remainder when the
 * `— date — title` shape isn't matched (hand-written entries vary).
 */
export function extractChangelogSection(raw, version) {
  const lines = raw.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^## \\[${escaped}\\](.*)$`);

  let start = -1;
  let headingRest = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      start = i;
      headingRest = m[1].trim();
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }

  // heading rest looks like "— 2026-07-26 — one-line title"; the title is
  // whatever follows the date separator. Fall back to the whole rest.
  const parts = headingRest.split('—').map((p) => p.trim()).filter(Boolean);
  const title = parts.length >= 2 ? parts.slice(1).join(' — ') : (parts[0] || '');

  const body = lines.slice(start + 1, end).join('\n').trim();
  return { heading: lines[start], title, body };
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts }).trim();
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', ...opts }).trim();
}

function fail(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  const say = (s) => process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${s}\n`);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;

  // 1. Release notes come from the CHANGELOG — no entry, no release.
  const changelogRaw = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const section = extractChangelogSection(changelogRaw, version);
  if (!section) {
    fail(`CHANGELOG.md has no "## [${version}]" entry. Write it before releasing.`);
  }
  if (/\bTODO\b/.test(section.heading + '\n' + section.body)) {
    fail(`the CHANGELOG entry for ${version} still contains TODO — replace the bump stub with the real notes first.`);
  }

  // 2. The bump must be committed (tag targets a commit, not the worktree).
  let headPkgVersion = null;
  try {
    headPkgVersion = JSON.parse(git(['show', 'HEAD:package.json'])).version;
  } catch {
    fail('cannot read package.json at HEAD — is this a git repo with at least one commit?');
  }
  if (headPkgVersion !== version) {
    fail(`package.json at HEAD is v${headPkgVersion} but the worktree says v${version} — commit the bump first (the post-commit hook will tag it).`);
  }

  // 3. Tag: normally created by .githooks/post-commit. Self-heal when absent.
  let tagExists = true;
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  } catch {
    tagExists = false;
  }
  if (!tagExists) {
    say(`tag ${tag} missing — creating it on HEAD (hook was not armed for that commit).`);
    if (!dryRun) git(['tag', '-a', tag, '-m', tag, 'HEAD']);
  } else {
    say(`tag ${tag} exists.`);
  }

  // 4. gh CLI is the release channel — bail early if absent/unauthenticated.
  try {
    gh(['--version']);
  } catch {
    fail('the GitHub CLI (gh) is required to create the release — https://cli.github.com/');
  }

  // 5. Publish: branch first (the tag's commit must be reachable), then tag.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  say(`pushing ${branch} + ${tag} to origin…`);
  if (!dryRun) {
    git(['push', 'origin', branch], { stdio: ['ignore', 'inherit', 'inherit'] });
    git(['push', 'origin', tag], { stdio: ['ignore', 'inherit', 'inherit'] });
  }

  // 6. Create or update the GitHub release. Notes go through a temp file so
  //    multi-line markdown survives Windows shell quoting.
  const title = section.title ? `${tag} — ${section.title}` : tag;
  const notesFile = path.join(os.tmpdir(), `obsidian-mcp-router-release-${version}.md`);
  fs.writeFileSync(notesFile, section.body + '\n');

  let releaseExists = false;
  try {
    gh(['release', 'view', tag, '--json', 'tagName']);
    releaseExists = true;
  } catch {
    releaseExists = false;
  }

  try {
    if (dryRun) {
      say(`would ${releaseExists ? 'update' : 'create'} GitHub release "${title}" from the CHANGELOG entry (${section.body.length} chars).`);
    } else if (releaseExists) {
      gh(['release', 'edit', tag, '--title', title, '--notes-file', notesFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      say(`updated existing release ${tag}.`);
    } else {
      gh(['release', 'create', tag, '--verify-tag', '--title', title, '--notes-file', notesFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      say(`created release ${tag}.`);
    }
  } finally {
    fs.rmSync(notesFile, { force: true });
  }

  if (!dryRun) {
    try {
      const url = gh(['release', 'view', tag, '--json', 'url', '--jq', '.url']);
      process.stdout.write(`Release: ${url}\n`);
    } catch {
      // cosmetic only
    }
  }
}
