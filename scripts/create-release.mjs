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
 * Publishes the whole BACKLOG, not just the current version. Several
 * versions routinely accumulate locally before a push; the first version of
 * this script handled only `package.json`'s, so the others stayed as local
 * tags and left holes in the Releases page — the exact drift this tooling
 * was written to end, reappearing through its blind spot (observed
 * 2026-07-27 on four versions, backfilled by hand).
 *
 * What it does (in order):
 *   1. Reads `version` from package.json → tag `v<version>`.
 *   2. Extracts the matching CHANGELOG.md section (refuses to publish a
 *      stub still containing TODO — write the real entry first).
 *   3. Self-heals the tag: if `v<version>` doesn't exist locally but HEAD's
 *      package.json already carries that version, tags HEAD (covers commits
 *      made before the hook was armed). Refuses if the bump isn't committed.
 *   4. Collects every version that has a CHANGELOG entry AND a local tag
 *      reachable from HEAD AND no GitHub release yet — the backlog.
 *   5. Pushes the current branch, then every pending tag.
 *   6. Creates each release oldest-first via `gh release create` (or
 *      updates it via `gh release edit` — idempotent re-runs), with
 *      `--latest` on the highest version overall. GitHub ranks "Latest" by
 *      creation date, so publishing a backlog without that flag would leave
 *      the badge on whichever release happened to be created last.
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

import { compareSemver } from '../src/helpers/semver-compare.mjs';
import { scanEntries, renderFindings } from '../src/helpers/export-gate.mjs';
import { readContract, collectPrivateRoots } from './export-gate.mjs';

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

/**
 * True when a CHANGELOG section is still the untouched bump-version.mjs
 * stub. Matches the stub's exact line signatures — NOT any occurrence of
 * the word "TODO", which a real entry may legitimately mention in prose
 * (the v0.48.0 entry describes this very guard and tripped the naive
 * version of this check on its first run).
 */
export function isStubEntry(section) {
  const text = section.heading + '\n' + section.body;
  return /TODO: one-line title|TODO: short description|^-\s*TODO\s*$/m.test(text);
}

/** Every version that has a `## [x.y.z]` entry in the CHANGELOG. */
export function parseChangelogVersions(raw) {
  return [...String(raw).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
}

/**
 * Which versions still need a GitHub release.
 *
 * A version qualifies when it has release notes (a CHANGELOG entry) AND a
 * local tag AND no published release. The tag requirement is what keeps the
 * 40 pre-v0.48.0 versions — documented in the CHANGELOG, never tagged —
 * from being resurrected: without a tag there is no commit to release.
 *
 * Sorted ascending so a batch publishes oldest-first and GitHub's
 * chronology matches the version order.
 *
 * Exists because the script used to handle only `package.json`'s version:
 * pushing a batch of accumulated versions published the newest and left the
 * others as local tags and holes in the Releases page — the very drift the
 * release tooling was written to end, in its blind spot.
 */
export function selectPendingReleases({ changelogVersions, localTags, publishedTags }) {
  const tagged = new Set(localTags.map((t) => t.replace(/^v/, '')));
  const published = new Set(publishedTags.map((t) => t.replace(/^v/, '')));
  return [...new Set(changelogVersions)]
    .filter((v) => tagged.has(v) && !published.has(v))
    .sort(compareSemver);
}

/** Highest version of a list, by semver. `null` for an empty list. */
export function highestVersion(versions) {
  const sorted = [...versions].filter(Boolean).sort(compareSemver);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

// execFileSync returns null (not '') for captured streams when the caller
// inherits stdio — the push/release calls do, to surface git's progress.
function git(args, opts = {}) {
  const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts });
  return out == null ? '' : out.trim();
}

function gh(args, opts = {}) {
  const out = execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', ...opts });
  return out == null ? '' : out.trim();
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
  if (isStubEntry(section)) {
    fail(`the CHANGELOG entry for ${version} is still the bump stub — write the real notes first.`);
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

  // 5. Discover the BATCH. `npm run release` used to publish only the
  //    version in package.json; when several versions accumulate locally
  //    before a push (the normal rhythm here), the older ones stayed as
  //    local tags with no release — holes in the Releases page.
  //
  //    Only tags reachable from HEAD are considered: a tag on another
  //    branch is not part of this line of history and must not be
  //    published as if it were.
  const localTags = git(['tag', '--list', 'v*.*.*'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      try {
        git(['merge-base', '--is-ancestor', `${t}^{commit}`, 'HEAD']);
        return true;
      } catch {
        return false; // unreachable from HEAD (other branch, or dangling)
      }
    });

  let publishedTags = [];
  try {
    publishedTags = gh(['release', 'list', '--limit', '200', '--json', 'tagName', '--jq', '.[].tagName'])
      .split('\n').map((t) => t.trim()).filter(Boolean);
  } catch {
    // No releases yet, or the repo has none — treat as empty, not fatal.
    publishedTags = [];
  }

  const changelogVersions = parseChangelogVersions(changelogRaw);
  const pending = selectPendingReleases({ changelogVersions, localTags, publishedTags });
  // The current version always belongs to the batch: its tag may have just
  // been self-healed above, so it isn't in `localTags` read before that.
  if (!pending.includes(version)) pending.push(version);
  pending.sort(compareSemver);

  // `--latest` must land on the highest version overall, not on whichever
  // release was created last: GitHub ranks by creation date, so publishing
  // a backlog oldest-first would otherwise leave the badge on the wrong one.
  const overallHighest = highestVersion([
    ...pending,
    ...publishedTags.map((t) => t.replace(/^v/, '')),
  ]);

  if (pending.length > 1) {
    say(`${pending.length} versions to publish: ${pending.map((v) => `v${v}`).join(', ')}`);
  }

  // 5b. C9 — the export gate. A GitHub release is the third exit, and the one
  //     whose mistakes are hardest to take back: a tag is public the moment it
  //     is pushed, and the notes are mirrored into e-mail and feeds within
  //     seconds. Both halves are checked BEFORE the first push, so a refusal
  //     costs nothing.
  //
  //     The notes are scanned as their own document because they are prose
  //     written by hand at the end of a long session — the exact conditions
  //     under which a real path or an address gets pasted in. The source
  //     surface is scanned because that is what the tag makes downloadable.
  //
  //     There is no bypass flag. Fix the file, or add a `scanExceptions`
  //     entry with a written reason to contracts/export-allowlist.json.
  {
    say('running the C9 export gate over every pending tag + its notes…');
    const { contract } = readContract(repoRoot);
    const privatePathRoots = collectPrivateRoots({ repoRoot });

    // What a GitHub release actually publishes is the auto-generated source
    // archive of the TAG, and that archive contains EVERY TRACKED FILE. Two
    // consequences the first version of this gate got wrong:
    //
    //   1. It scanned the worktree. The worktree is not what ships: a secret
    //      committed and then "fixed" on disk without committing passed the
    //      gate while the tag published the key. Blobs are now read from the
    //      tag with `git show`, so what is scanned is what is served.
    //   2. It scanned the `release` allowlist subset — 309 of 465 tracked
    //      files. The allowlist governs what WE assemble into a bundle; it
    //      cannot shrink an archive GitHub generates. `docs/`, `tests/`,
    //      `.github/` and the deployment files are all published regardless,
    //      so every tracked blob is scanned here.
    //
    // Every pending tag is checked, not just the current version: this script
    // publishes a BACKLOG, so an older tag carrying a leak would otherwise be
    // released on the strength of today's clean tree.
    const alreadyPublished = new Set(publishedTags.map((t) => t.replace(/^v/, '')));
    for (const v of pending) {
      const vTag = `v${v}`;
      // Gate what is ABOUT to become public, not what already is. The current
      // version is force-added to `pending` so its notes can be refreshed via
      // `gh release edit`; gating it again means an already-published tag —
      // whose bytes are immutable — can never be re-run, and a finding there
      // could only ever be excepted, never fixed.
      if (alreadyPublished.has(v)) {
        say(`${vTag}: already published — gate skipped (its bytes are public and immutable).`);
        continue;
      }
      // Which tree does this version actually publish? Normally the tag. But
      // `--dry-run` does not create the tag at step 3, so a naive "no tag →
      // skip" turned the dry run into a guaranteed pass — the one mode whose
      // entire purpose is to tell you what the real run will do. When the tag
      // is absent and the version is the one HEAD carries, HEAD *is* the tree
      // the tag will be created on, so scan that and say so. Any other missing
      // tag is a hard failure, never a skip.
      let treeish = vTag;
      let tagExistsForV = true;
      try {
        git(['rev-parse', '-q', '--verify', `refs/tags/${vTag}`]);
      } catch {
        tagExistsForV = false;
        if (v === version) {
          treeish = 'HEAD';
          say(`${vTag}: tag not created yet — gating HEAD, which is the commit it will point at.`);
        } else {
          fail(`the export gate cannot read ${vTag} (no such tag) — refusing to publish a version it could not scan.`);
        }
      }

      let listing;
      try {
        // `-z` + `core.quotePath=false`: with the defaults, git RENDERS a
        // non-ASCII path as a C-quoted literal (`"caf\303\251.md"`). The gate
        // then saw backslashes in the name, reported `path-traversal` — which
        // is deliberately unsuppressable — and refused the release with a
        // message about a "backslash separator" in a filename containing
        // none. One accented file anywhere in the tree was an unfixable block.
        // A larger `maxBuffer` because the default 1 MiB caps out on a big
        // tree, and the failure would land mid-gate.
        listing = execFileSync(
          'git',
          ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', treeish],
          { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (err) {
        fail(`the export gate could not read the tree of ${tagExistsForV ? vTag : 'HEAD'}: ${err.message}`);
      }

      const blobs = [];
      for (const line of listing.split('\0')) {
        // `<mode> <type> <sha>\t<path>`
        const m = line.match(/^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/);
        if (!m) continue;
        const [, mode, type, sha, filePath] = m;
        if (type === 'commit') {
          blobs.push({ path: filePath, content: '', isSymlink: false, submodule: true });
          continue;
        }
        // Mode 120000 is a symlink: its blob content is the link TARGET, and
        // the gate must see it as a link rather than as a one-line text file.
        if (mode === '120000') {
          const target = execFileSync('git', ['cat-file', 'blob', sha], { cwd: repoRoot, encoding: 'utf8' });
          blobs.push({ path: filePath, isSymlink: true, linkTarget: target.trim(), content: null });
          continue;
        }
        const content = execFileSync('git', ['cat-file', 'blob', sha], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
        blobs.push({ path: filePath, content, isSymlink: false });
      }

      if (blobs.length === 0) {
        fail(`the export gate read 0 files from ${vTag} — refusing to treat an empty scan as clean.`);
      }

      const scan = scanEntries(blobs, {
        target: 'release',
        exceptions: contract.scanExceptions || [],
        privatePathRoots,
        emailAllowlist: contract.emailAllowlist || [],
      });
      if (!scan.ok) {
        process.stderr.write(`\n${renderFindings(scan.findings)}\n`);
        fail(`the export gate refused the source archive of ${vTag} (${blobs.length} tracked files) — nothing was pushed.`);
      }
      say(`export gate: ${vTag} clean (${blobs.length} tracked files scanned from the tag itself).`);
    }

    const noteDocs = pending.map((v) => {
      const s = extractChangelogSection(changelogRaw, v);
      return s ? { path: `release-notes/v${v}.md`, content: s.heading + '\n' + s.body, zone: 'authored' } : null;
    }).filter(Boolean);
    const noteScan = scanEntries(noteDocs, {
      target: 'release',
      exceptions: contract.scanExceptions || [],
      privatePathRoots,
      emailAllowlist: contract.emailAllowlist || [],
    });
    if (!noteScan.ok) {
      process.stderr.write(`\n${renderFindings(noteScan.findings)}\n`);
      fail('the export gate refused the release notes — nothing was pushed.');
    }
    say(`export gate: OK — ${pending.length} tag(s) and ${noteDocs.length} note document(s) clean.`);
  }

  // 6. Push: the branch once (tag commits must be reachable), then each tag.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  say(`pushing ${branch} + ${pending.map((v) => `v${v}`).join(' ')} to origin…`);
  if (!dryRun) {
    git(['push', 'origin', branch], { stdio: ['ignore', 'inherit', 'inherit'] });
    for (const v of pending) {
      git(['push', 'origin', `v${v}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
  }

  // 7. Publish each pending version, oldest first. Notes go through a temp
  //    file so multi-line markdown survives Windows shell quoting.
  const published = [];
  for (const v of pending) {
    const vTag = `v${v}`;
    const vSection = extractChangelogSection(changelogRaw, v);
    if (!vSection) {
      say(`⚠️  ${vTag}: no CHANGELOG entry — skipped.`);
      continue;
    }
    if (isStubEntry(vSection)) {
      // The current version already failed hard above; an older one in the
      // backlog only warns — its notes are missing, not this run's fault.
      say(`⚠️  ${vTag}: CHANGELOG entry is still the bump stub — skipped.`);
      continue;
    }

    const vTitle = vSection.title ? `${vTag} — ${vSection.title}` : vTag;
    const latestFlag = v === overallHighest ? '--latest' : '--latest=false';
    const notesFile = path.join(os.tmpdir(), `obsidian-mcp-router-release-${v}.md`);
    fs.writeFileSync(notesFile, vSection.body + '\n');

    let releaseExists = false;
    try {
      gh(['release', 'view', vTag, '--json', 'tagName']);
      releaseExists = true;
    } catch {
      releaseExists = false;
    }

    try {
      if (dryRun) {
        say(`would ${releaseExists ? 'update' : 'create'} "${vTitle}" (${vSection.body.length} chars, ${latestFlag}).`);
      } else if (releaseExists) {
        gh(['release', 'edit', vTag, '--title', vTitle, '--notes-file', notesFile, latestFlag], { stdio: ['ignore', 'inherit', 'inherit'] });
        say(`updated existing release ${vTag}.`);
      } else {
        gh(['release', 'create', vTag, '--verify-tag', '--title', vTitle, '--notes-file', notesFile, latestFlag], { stdio: ['ignore', 'inherit', 'inherit'] });
        say(`created release ${vTag}.`);
      }
      published.push(v);
    } finally {
      fs.rmSync(notesFile, { force: true });
    }
  }

  if (!dryRun && published.length) {
    for (const v of published) {
      try {
        const url = gh(['release', 'view', `v${v}`, '--json', 'url', '--jq', '.url']);
        process.stdout.write(`Release: ${url}${v === overallHighest ? '  (latest)' : ''}\n`);
      } catch {
        // cosmetic only
      }
    }
  }
}
