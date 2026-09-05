/**
 * agent-host-install.mjs — C12, the installer side.
 *
 * Puts a per-skill index where Codex, Gemini CLI, Cursor and Windsurf will read
 * it, so an agent arriving through one of those hosts has the manual and not
 * just the tool list. The MCP tools are already universal; the know-how was not.
 *
 * WHAT IT WRITES, AND WHY THAT SHAPE. One managed block per target, holding one
 * line per skill: name, one sentence, and the path to the SKILL.md to read when
 * the skill is actually needed. That is the progressive-disclosure contract the
 * skills already assume — the index is cheap and always loaded, the body is
 * expensive and loaded on demand — expressed in a form four foreign hosts can
 * all read.
 *
 * REJECTED: one file per skill (47 `.mdc` files under `.cursor/rules/`, which is
 * the native Cursor idiom). Two reasons, both about the day AFTER the install.
 * Uninstall would have to decide, file by file, whether a file it is looking at
 * is one it wrote — and the conventions skill already names that anti-pattern:
 * do not detect by file equality, because a user who edited one line would have
 * it deleted as "unmodified" or orphaned as "not ours". A marker block inside a
 * file the user also owns has no such ambiguity. And 47 new files appearing in
 * someone's repo after one command is an ambush regardless of how correct it is.
 *
 * THE FILE THIS MODULE MUST NOT BE ABLE TO TOUCH. `<repo>/.codex/config.toml`
 * carries a live bearer token and was once shipped inside a released bundle.
 * "Be careful around it" is not a design. So:
 *
 *   - Every path opened here is built by joining a base from the contract with
 *     a `file` fragment from the contract. There is no readdir, glob or walk
 *     over any path derived from user input; the only enumeration in the whole
 *     import graph is `listSkills()` over `skills/`, rooted at `import.meta.url`.
 *   - `assertSafeTarget()` re-checks the resolved path's extension and basename
 *     against the contract. A `.toml` is not nameable by the contract, so it is
 *     not nameable here.
 *   - `assertSafeFile()` refuses a target that IS a symlink.
 *
 * WHAT THE SYMLINK CHECK DOES NOT GIVE YOU, stated because the first draft of
 * this comment claimed more than the code delivers. It is not a guarantee that
 * "the name checked and the inode written cannot diverge". It cannot be: the
 * check inspects the final component only, so a reparse point or symlink on a
 * PARENT directory redirects the write while the leaf looks ordinary; and there
 * is an unavoidable TOCTOU window between the lstat and the rename, so a link
 * created in between is followed. Both holes need write access to the target
 * directory, which is the user's own home or project.
 *
 * The claim that holds: no code path here NAMES a file the contract does not
 * name, and a target that is itself a link is refused rather than followed.
 * That is a real narrowing of the blast radius, not a sandbox — the wider
 * version would be false, and a false security claim is worse than none.
 *
 * Statuses mirror `installGlobalConvention()` (scripts/setup-vault.mjs, v0.13.9)
 * because the situations are the same, including the one that matters most: a
 * BEGIN marker with no matching END is reported as `ambiguous-state` and
 * refused. Guessing where a half-deleted block ended is how an installer eats a
 * paragraph the user wrote.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listSkills, parseFrontmatter } from './agent-portability.mjs';

/**
 * Resolve a contract base name to a directory.
 *
 * `env` and `home` are injected rather than read from the process so the test
 * suite can point every base at a temp directory. The suite must never be one
 * forgotten override away from writing into the real ~/.codex.
 */
export function resolveBase(baseName, contract, { projectDir, home = os.homedir(), env = process.env } = {}) {
  const base = contract.bases[baseName];
  if (!base) throw new Error(`unknown base '${baseName}' — not declared in contracts/agent-host-targets.json`);
  switch (base.kind) {
    case 'cwd':
      if (!projectDir) throw new Error(`base '${baseName}' needs a project directory`);
      return assertSaneRoot(projectDir, '--project');
    case 'home':
      return path.join(home, ...base.homeSubdir.split('/'));
    case 'env-or-home': {
      const fromEnv = env[base.env];
      if (fromEnv && String(fromEnv).trim()) {
        return assertSaneRoot(path.resolve(String(fromEnv).trim()), base.env);
      }
      return path.join(home, ...base.homeSubdir.split('/'));
    }
    default:
      throw new Error(`base '${baseName}' has unsupported kind '${base.kind}'`);
  }
}

/**
 * Refuse roots that are almost certainly a mistake.
 *
 * `--project` and `CODEX_HOME` come from outside. A typo, an unexpanded shell
 * variable or an empty string can land on a drive root or a system directory,
 * and the name/extension guards would happily allow `C:\AGENTS.md` — a legal
 * name in a place nobody meant. This does not pretend to be a sandbox; it
 * catches the aberrant cases and says which one it caught.
 */
export function assertSaneRoot(dir, label) {
  const resolved = path.resolve(dir);
  const parsed = path.parse(resolved);

  if (resolved === parsed.root) {
    throw new Error(`refusing ${label}=${resolved}: that is a filesystem root, not a project.`);
  }

  const SYSTEM_DIRS = [
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
    '/etc', '/bin', '/sbin', '/usr', '/var', '/boot', '/dev', '/proc', '/sys', '/System', '/Library',
  ];
  const cmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  for (const sys of SYSTEM_DIRS) {
    const s = process.platform === 'win32' ? sys.toLowerCase() : sys;
    if (cmp === s || cmp.startsWith(`${s}${path.sep}`)) {
      throw new Error(`refusing ${label}=${resolved}: it is inside the system directory ${sys}.`);
    }
  }
  return resolved;
}

/**
 * Last line of defence before any open().
 *
 * Two independent checks, because either alone has a hole: the extension check
 * alone would admit `.codex/anything.md`, and the basename check alone would
 * admit a `config.toml` if someone ever wrote one into the contract. Together
 * they say: the only files this installer can name are the ones this contract
 * names, and they are markdown.
 */
export function assertSafeTarget(file, contract) {
  const ext = path.extname(file).toLowerCase();
  if (!contract.allowedTargetExtensions.includes(ext)) {
    throw new Error(
      `refusing to touch ${file}: extension '${ext || '(none)'}' is not in allowedTargetExtensions `
      + `(${contract.allowedTargetExtensions.join(', ')}). The installer only ever writes markdown rule files.`,
    );
  }
  const declared = new Set();
  for (const host of Object.values(contract.hosts)) {
    for (const target of Object.values(host.targets)) declared.add(path.basename(target.file));
  }
  const base = path.basename(file);
  if (!declared.has(base)) {
    throw new Error(
      `refusing to touch ${file}: '${base}' is not a file name declared in contracts/agent-host-targets.json `
      + `(declared: ${[...declared].sort().join(', ')}).`,
    );
  }
  return true;
}

/**
 * The filesystem half of the guard, and the reason it is a separate function.
 *
 * `assertSafeTarget()` constrains the NAME. An `AGENTS.md` that is a symlink to
 * `.codex/config.toml` satisfies every name rule and then reads and writes
 * straight through to the token, so the leaf is checked here as well.
 *
 * Scope, precisely: FINAL COMPONENT ONLY, checked once. A link on a parent
 * directory is not detected, and the lstat/rename window is not closed. This
 * removes the easy case, not the class.
 *
 * Kept out of `assertSafeTarget()` so that the two failures stay different
 * kinds of failure: a bad NAME is a contract bug and aborts the whole run,
 * while a symlink is one machine's state and marks one target `failed` while
 * the other six proceed.
 */
export function assertSafeFile(file, contract) {
  assertSafeTarget(file, contract);
  const link = fs.lstatSync(file, { throwIfNoEntry: false });
  if (link && link.isSymbolicLink()) {
    throw new Error(
      `refusing to touch ${file}: it is a symbolic link. This installer writes rule files, and `
      + 'following a link would let the name it checked and the file it wrote diverge.',
    );
  }
  return true;
}

/**
 * Expand the contract into the concrete list of target files.
 *
 * `hosts` / `scopes` filter; omitted means all. Nothing is read from disk here —
 * a plan is a statement about paths, and it must be printable on a machine
 * where none of the four products is installed.
 */
export function planTargets(contract, { projectDir, home = os.homedir(), env = process.env, hosts = null, scopes = null } = {}) {
  const wantHost = hosts ? new Set(hosts) : null;
  const wantScope = scopes ? new Set(scopes) : null;
  const out = [];

  for (const [hostId, host] of Object.entries(contract.hosts)) {
    if (wantHost && !wantHost.has(hostId)) continue;
    for (const [scope, target] of Object.entries(host.targets)) {
      if (wantScope && !wantScope.has(scope)) continue;
      // The contract's `file` is a path fragment, and a fragment that can
      // climb is not a fragment. `path.join` would normalise `..` away before
      // assertSafeTarget() ever saw it, and the basename check would then be
      // inspecting a name that had already escaped its base — so the segments
      // are validated here, before they are joined.
      const segments = target.file.split('/');
      if (path.isAbsolute(target.file) || segments.some((s) => s === '..' || s === '')) {
        throw new Error(
          `refusing target '${target.file}' for ${hostId}/${scope}: a target must be a relative path `
          + 'with no empty or parent segments, so that it cannot leave the base its host declares.',
        );
      }
      const baseDir = resolveBase(target.base, contract, { projectDir, home, env });
      const file = path.join(baseDir, ...segments);
      assertSafeTarget(file, contract);
      out.push({
        hostId,
        hostLabel: host.label,
        scope,
        file,
        format: target.format,
        charBudget: target.charBudget ?? null,
        provenance: target.provenance,
        source: target.source,
        note: target.note || null,
        frontmatter: target.frontmatter || null,
        preferred: Boolean(host.preferred),
      });
    }
  }
  return out;
}

/** First sentence of a description, for the index line. */
function firstSentence(text, max = 160) {
  const s = String(text || '').replace(/\s*\n\s*/g, ' ').replace(/^["']|["']$/g, '').trim();
  if (!s) return '';
  const cut = s.search(/\.\s|\.$/);
  let out = cut === -1 ? s : s.slice(0, cut + 1);
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
}

/**
 * Path to a SKILL.md as written into the index.
 *
 * Relative when both the rule file and the skills tree sit under the same
 * project (a checked-in `.cursor/rules/*.mdc` with an absolute path from
 * whoever ran the installer is a broken link for every teammate); absolute when
 * the rule file lives in the user's home and the skills do not.
 */
export function isInside(dir, file) {
  if (!dir) return false;
  const rel = path.relative(dir, file);
  // On Windows, path.relative() between two DIFFERENT DRIVES returns the target
  // as an absolute path — it does not start with '..', so a `.startsWith('..')`
  // test alone reports "inside" for a file on another volume entirely. That is
  // how a repository on I: and a project on C: were classified as co-located,
  // which silenced the absolute-path warning on precisely the machines that
  // needed it.
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function skillLinkPath(skillFile, targetFile, projectDir) {
  const inProject = isInside(projectDir, skillFile) && isInside(projectDir, targetFile);
  if (!inProject) return skillFile.split(path.sep).join('/');
  return path.relative(path.dirname(targetFile), skillFile).split(path.sep).join('/');
}

/**
 * Render the body of the managed block.
 *
 * THE LADDER, AND WHY IT DEGRADES IN THIS ORDER. This block is a routing table:
 * an agent reads it to decide WHETHER a skill is relevant, and only then opens
 * the `SKILL.md`. The `description` is the entire routing signal — it is the one
 * text that answers "is this my task?". The per-skill path is plumbing: it
 * matters only after the decision is already made.
 *
 * Measured on the 47 skills shipped here, for a user-scope target whose links
 * are absolute:
 *
 *   descriptions   5,212 chars   the routing signal
 *   paths          4,094 chars   plumbing, and 47/47 derivable from the name
 *
 * The old ladder was `full` → `compact`, and `compact` dropped the DESCRIPTIONS
 * while keeping all 4,094 chars of paths. It spent the signal to save the
 * plumbing — an index of 47 bare names, which tells an agent that something
 * exists but never when to reach for it. Worse, keeping absolute paths made the
 * fit depend on WHERE THE REPOSITORY SITS ON DISK: the same 47 skills rendered
 * 5,081 chars under a 36-character checkout root and 6,110 under a 57-character
 * one — one side of Windsurf's 6,000-char cap each, for identical content. A CI
 * runner checks out deep, so CI was refused while every shorter local path
 * passed. (Lengths, not the paths themselves: the export gate refuses to
 * publish a tracked file that names a real private root, and it is right to.)
 *
 * So the rungs now shed plumbing first and signal last:
 *
 *   full     name + description + explicit path per skill
 *   rooted   name + description; the layout is stated ONCE and the 47 paths
 *            drop out, because `skills/<name>/SKILL.md` is derivable from the
 *            name the line already carries. Nothing is lost.
 *   brief    name + CLIPPED description, the clip walked down 80 → 64 → 48 →
 *            32 → 24 chars by the planner. A clipped sentence still says
 *            which domain a skill belongs to; the block says it is clipped.
 *   compact  name + path only. The signal is gone; this is a genuine
 *            degradation and the block says so, in the block.
 *
 * `rooted` is lossless and roughly flat in the checkout depth, so in practice
 * `compact` is now unreachable for this repository — it is kept as the rung
 * below for a host with a cap tighter than the descriptions alone.
 */
export function renderSkillsIndex(skills, {
  mode = 'full', briefChars = 80, targetFile, projectDir, repoRoot, version = null, generatedAt = null,
} = {}) {
  const lines = [];
  lines.push('## obsidian-mcp-router — skills index');
  lines.push('');
  lines.push('This block is an INDEX of pointers, not the skills themselves. Each entry names a manual and');
  lines.push('where to read it; the manual stays on disk until a task calls for it. When a request matches an');
  lines.push('entry, read that `SKILL.md` in full before acting — its body is normative.');
  lines.push('');

  // Self-describing header. A rules file under .cursor/ or .windsurf/ is
  // normally committed, so a colleague inherits it without ever having run the
  // command. They need to know what wrote it, from where, when, and how to
  // refresh it — otherwise the block is folklore that nobody dares touch.
  const absolute = skills.some((s) => !isInside(projectDir, s.file));
  lines.push('<!-- generated -->');
  lines.push(`- Generated by \`obsidian-mcp-router\`${version ? ` v${version}` : ''}`
    + `${generatedAt ? ` on ${generatedAt}` : ''}.`);
  if (repoRoot) lines.push(`- Source tree: \`${repoRoot.split(path.sep).join('/')}\``);
  lines.push('- Regenerate: `npm run install:agent-rules -- --apply` (preview first by omitting `--apply`).');
  lines.push('- Edits between the markers are overwritten on the next run; write your own notes outside them.');
  if (absolute) {
    lines.push('- ⚠️ The paths here are ABSOLUTE and local to the machine that generated this file.');
    lines.push('  If you are reading this from version control, they will not resolve for you — regenerate.');
  }

  const link = (file) => skillLinkPath(file, targetFile, projectDir);

  // The layout rule, when every skill obeys it. `skills/<name>/SKILL.md` under
  // the source tree — so the name already in each line IS the path, and 47
  // copies of the prefix are redundant. Computed, never assumed: a skill that
  // sits elsewhere keeps its explicit path below.
  const layoutBase = repoRoot ? link(path.join(repoRoot, 'skills')) : null;
  const derivable = (s) => (
    layoutBase !== null
    && repoRoot
    && path.resolve(s.file) === path.resolve(path.join(repoRoot, 'skills', s.name, 'SKILL.md'))
  );
  // EVERY rung below `full` states the layout once instead of per line. That is
  // what makes each degraded rung flat in the checkout depth — a rung that kept
  // 47 absolute paths would still be refused on a deep runner, which is the
  // defect this ladder exists to close.
  const useLayout = mode !== 'full' && skills.length > 0 && skills.every(derivable);

  /**
   * The routing text for one skill at this rung.
   *
   * `brief` CLIPS rather than drops. A clipped sentence still says which domain
   * a skill belongs to, which is most of the routing decision; a missing
   * sentence says nothing at all. The clip lands on a word boundary, is marked
   * with an ellipsis, and the header states that the `SKILL.md` is
   * authoritative — an abbreviated description must not read as a complete one.
   *
   * A rung is a CEILING on the clipped length, not a guaranteed prefix: at
   * 24 characters `Deterministic wizard tha` becomes `Deterministic wizard…`,
   * and that is the intended trade — a whole word routes better than three
   * letters of the next one. (Raised in the Codex round on fd9e1cd; kept as
   * designed, since nothing downstream contracts the exact count.)
   *
   * The clip length is a PARAMETER (`briefChars`, 80 by default), because the
   * planner walks it down as a ladder of its own — see `planOne`. With one
   * fixed clip, the 48th skill pushed the tightest real host (Windsurf,
   * 6000 chars) straight from an 80-char brief to the compact rung that says
   * nothing at all, while a 64-char brief would have fitted with the signal
   * intact.
   */
  const BRIEF_CHARS = Math.max(24, Number(briefChars) || 80);
  const routingText = (s) => {
    const d = s.description || '';
    if (mode !== 'brief' || d.length <= BRIEF_CHARS) return d;
    const cut = d.slice(0, BRIEF_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    const kept = lastSpace > BRIEF_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
    return `${kept.replace(/[,;:.\s]+$/, '')}…`;
  };

  if (useLayout) {
    lines.push(`- Layout: every skill below is at \`${layoutBase}/<name>/SKILL.md\` — join the name to that`);
    lines.push('  base to open one. The paths are omitted per line only because they are derivable.');
  }
  if (mode === 'brief') {
    lines.push('- ⚠️ ABBREVIATED: this host\'s character cap did not fit the full descriptions, so each one');
    lines.push('  below is clipped (…). A clipped line is a hint, not a specification — the `SKILL.md` is');
    lines.push('  authoritative, so open it before concluding that a skill does not apply.');
  }
  if (mode === 'compact') {
    lines.push('- ⚠️ DEGRADED INDEX: this host\'s character cap did not fit the descriptions at all, so each');
    lines.push('  entry below is a bare name with no statement of when to use it. Open a `SKILL.md` to');
    lines.push('  find out what it is for, or regenerate for a host with a larger cap.');
  }
  lines.push('');

  if (repoRoot) {
    // Under `useLayout` the source tree is already stated twice above, and a
    // third full copy of it buys nothing: `AGENTS.md` at that root is as
    // unambiguous as the absolute path, and one fewer copy of the prefix is
    // real slack against a tight cap.
    lines.push(useLayout
      ? 'Operating contract for that tree: `AGENTS.md` at the source-tree root.'
      : `Operating contract for that tree: \`${link(path.join(repoRoot, 'AGENTS.md'))}\``);
    lines.push('');
  }

  for (const s of skills) {
    // The path is printed only when it cannot be derived — that is the whole
    // saving, and it is why `useLayout` is computed from the files on disk
    // rather than assumed from a convention.
    const tail = useLayout ? '' : ` → \`${link(s.file)}\``;
    if (mode === 'compact') lines.push(`- \`${s.name}\`${tail}`);
    else lines.push(`- **\`${s.name}\`** — ${routingText(s)}${tail}`);
  }
  // Deliberately no "N skills indexed" footer. Two reasons, and the second is
  // the load-bearing one. A count printed next to the list it counts is a fact
  // that can disagree with the list above it. And this block can legitimately
  // be installed into a repository's own AGENTS.md — including this one, whose
  // contract handshake requires an agent to MEASURE the number of skills. A
  // footer stating it would put the answer three paragraphs below the question
  // and quietly turn a behavioural check into a reading-comprehension check.
  return lines.join('\n');
}

/** Collect the index inputs. Descriptions come from the pages, never a list. */
export function collectSkills(repoRoot) {
  return listSkills(repoRoot).map((s) => {
    const fm = parseFrontmatter(fs.readFileSync(s.file, 'utf8'));
    return { name: s.name, file: s.file, description: firstSentence(fm.values.description) };
  });
}

/** Wrap a body in the contract's markers. */
export function wrapBlock(body, contract) {
  const { beginMarker, endMarker } = contract.block;
  return `${beginMarker}\n${body}\n${endMarker}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate the managed block, and treat every shape that is not exactly one
 * well-formed block as ambiguous.
 *
 * The first version of this only looked at the FIRST `BEGIN` and asked whether
 * an `END` followed it — which meant a file holding a complete block plus a
 * stray unterminated one was reported as a clean upgrade, and the stray marker
 * survived the write. The rule the contract states is "a BEGIN with no matching
 * END is refused", so the check has to be about matching, i.e. about counts.
 */
export function findBlock(existing, contract) {
  const { beginMarker, endMarker } = contract.block;
  const begins = [...existing.matchAll(new RegExp(escapeRe(beginMarker), 'g'))].map((m) => m.index);
  const ends = [...existing.matchAll(new RegExp(escapeRe(endMarker), 'g'))].map((m) => m.index);

  if (begins.length === 0 && ends.length === 0) return { present: false, ambiguous: false };
  if (begins.length !== ends.length) {
    return {
      present: true,
      ambiguous: true,
      reason: `${begins.length} BEGIN marker(s) against ${ends.length} END marker(s)`,
    };
  }
  if (begins.length > 1) {
    return {
      present: true,
      ambiguous: true,
      reason: `${begins.length} blocks share the marker name; only one is managed`,
    };
  }
  if (ends[0] < begins[0]) {
    return { present: true, ambiguous: true, reason: 'the END marker precedes the BEGIN marker' };
  }
  return { present: true, ambiguous: false, begin: begins[0], end: ends[0] };
}

/**
 * Every directory an apply would have to create, outermost first.
 *
 * `applyOne` calls `mkdirSync(..., { recursive: true })`, so it creates the
 * whole missing chain. Announcing only the immediate parent under-declared the
 * change: a preview naming `.cursor/rules` silently also created `.cursor`, and
 * the Windsurf user target silently created `.codeium` and `.codeium/windsurf`.
 * A preview is a promise about what will appear on disk; it has to cover the
 * chain the writer actually walks.
 */
export function missingAncestors(file) {
  const chain = [];
  let dir = path.dirname(file);
  while (!fs.existsSync(dir)) {
    chain.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

/**
 * The sidecar path an apply would create, or null when none would be.
 *
 * The exact name carries an apply-time timestamp, so a preview cannot print the
 * final filename — but it must not therefore stay silent, which is what it did.
 * It prints the pattern, which is what the user needs in order to know a second
 * file is coming and roughly what it will be called.
 */
export function plannedBackup(file, willDestroy) {
  if (!willDestroy || !fs.existsSync(file)) return null;
  return `${file}.bak-skills-index-<timestamp>`;
}

/** Where the managed region stops, including the newline that closes it. */
function blockTailStart(existing, found, contract) {
  const { endMarker } = contract.block;
  const endLineEnd = existing.indexOf('\n', found.end + endMarker.length);
  return endLineEnd === -1 ? existing.length : endLineEnd + 1;
}

function renderMdcFrontmatter(frontmatter) {
  // JSON.stringify for every scalar, strings included: a description holding a
  // colon or a `#` is valid prose and invalid bare YAML, and the contract is
  // explicitly meant to be edited.
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${fm}\n---\n\n`;
}

/**
 * Produce the exact bytes an install would write.
 *
 * ONE definition, called by both `planOne` (to size the result) and `applyOne`
 * (to write it). It was two, and they disagreed: the estimate was two characters
 * short on a fresh insert and one long on an upgrade, and it ignored the `.mdc`
 * frontmatter entirely — so a budget described as "checked against the resulting
 * file" was checked against a number no file ever had.
 */
export function composeNext(existing, plan, contract) {
  const found = findBlock(existing, contract);
  if (found.ambiguous) throw new Error(`ambiguous marker state in ${plan.file}: ${found.reason}`);

  if (found.present) {
    const tailStart = blockTailStart(existing, found, contract);
    return existing.slice(0, found.begin) + plan.body + existing.slice(tailStart);
  }

  let head = existing;
  // A brand-new .mdc needs Cursor's frontmatter, or the rule is inert. An
  // EXISTING file keeps whatever frontmatter its owner put there.
  if (!existing && plan.format === 'mdc' && plan.frontmatter) head = renderMdcFrontmatter(plan.frontmatter);

  let sep = '';
  if (head.length > 0) sep = head.endsWith('\n\n') ? '' : (head.endsWith('\n') ? '\n' : '\n\n');
  return head + sep + plan.body;
}

/**
 * The one volatile line in the block: the generation stamp.
 *
 * Scoped to a single anchored line, matched by its exact shape, because this is
 * a normaliser sitting directly in front of a guard — the comparison that
 * decides `already-installed` versus `upgraded`. Strip a character too many and
 * a real content change reads as "no change" and is never written. So: one
 * line, anchored at both ends, and a test that a substantive edit still
 * registers as an upgrade.
 */
// Only the DATE is volatile. The router VERSION stays in the compared text on
// purpose: a version bump is a real change, and stripping the whole line would
// freeze the stamp at whatever version first wrote it — a self-describing block
// that lies about which release produced it is worse than none.
const GENERATED_STAMP_RE = /^(- Generated by `obsidian-mcp-router`(?: v\S+)?) on \d{4}-\d{2}-\d{2}\.$/m;

function stripVolatile(text) {
  return text.replace(GENERATED_STAMP_RE, '$1.');
}

/**
 * Marker comparison has to survive a CRLF checkout, or every run is an upgrade
 * — and it has to ignore the generation stamp, or every run is an upgrade for a
 * different reason.
 *
 * That is why the stamp records when the CONTENT last changed rather than when
 * the command last ran: a wall-clock timestamp inside an idempotent managed
 * block would turn every invocation into a rewrite and every checked-in rules
 * file into a permanent diff, which is exactly the "re-runs are no-ops"
 * property the whole marker design rests on.
 */
function sameBlock(a, b) {
  const norm = (s) => stripVolatile(s.replace(/\r\n/g, '\n')).trim();
  return norm(a) === norm(b);
}

/**
 * Decide what would happen to one target, without writing.
 *
 * Reads the target file if it exists — that read is gated by assertSafeTarget()
 * exactly like the write is, so "preview" cannot become a way to read something
 * the installer is not allowed to write.
 */
export function planOne(target, skills, contract, {
  projectDir, repoRoot, version = null, generatedAt = new Date().toISOString().slice(0, 10),
}) {
  const plan = {
    ...target,
    status: 'failed',
    mode: 'full',
    bytes: 0,
    projectedBytes: 0,
    existingBytes: 0,
    exists: false,
    creatingDirs: [],
    backup: null,
    absoluteLinks: false,
    error: null,
    body: '',
  };

  try {
    assertSafeFile(target.file, contract);

    const exists = fs.existsSync(target.file);
    plan.exists = exists;
    const existing = exists ? fs.readFileSync(target.file, 'utf8') : '';
    plan.existingBytes = existing.length;
    plan.expectExisting = existing;

    const found = findBlock(existing, contract);
    if (found.ambiguous) {
      plan.status = 'ambiguous-state';
      plan.error = `${found.reason} — refusing to write. Repair the markers by hand; `
        + 'an installer that guesses where a block ended eats the line after it.';
      return plan;
    }

    // Try full, then compact, and size each against the RESULTING FILE rather
    // than the block. The two differ by however much the user has already
    // written, which is exactly the case the compact rendering exists for — an
    // earlier version chose the rendering from the block size alone, so a
    // Windsurf rules file with any pre-existing content was refused outright
    // instead of falling back to the smaller form that would have fitted.
    let chosen = null;
    let lastProjected = 0;
    // `brief` is a ladder of its own: the clip shrinks step by step, down to
    // a floor that still names each skill's domain (24 chars — the "start of
    // the description" the tests pin), BEFORE the index gives up its
    // descriptions entirely. One fixed clip meant the 48th skill pushed the
    // tightest real host from brief straight to compact.
    const rungs = [
      { mode: 'full' },
      { mode: 'rooted' },
      ...[80, 64, 48, 32, 24].map((briefChars) => ({ mode: 'brief', briefChars })),
      { mode: 'compact' },
    ];
    for (const { mode, briefChars } of rungs) {
      const body = renderSkillsIndex(skills, { mode, briefChars, targetFile: target.file, projectDir, repoRoot, version, generatedAt });
      const block = wrapBlock(body, contract);
      const projected = composeNext(existing, { ...plan, body: block, format: target.format }, contract).length;
      lastProjected = projected;
      if (!target.charBudget || projected <= target.charBudget) {
        chosen = { mode, block, projected };
        break;
      }
    }

    if (!chosen) {
      plan.status = 'over-budget';
      plan.mode = 'compact';
      plan.projectedBytes = lastProjected;
      plan.error = `even the compact index — bare skill names, no descriptions — would leave `
        + `${lastProjected} chars, over this host's ${target.charBudget}-char cap. Refusing: a `
        + 'truncated index is worse than none, because the skills past the cut look like skills '
        + 'that do not exist. Install fewer with `--skills a,b,c`.';
      return plan;
    }

    plan.mode = chosen.mode;
    plan.body = chosen.block;
    plan.bytes = chosen.block.length;
    plan.projectedBytes = chosen.projected;

    // Surfaced in the preview because it is a real trap: `.cursor/rules` and
    // `.windsurf/rules` are version-controlled by their vendors' own docs, and
    // a committed rule file carrying the installer-runner's absolute path is a
    // dead link for every teammate. It is unavoidable whenever the skills tree
    // is not inside the project — which is the normal case — so the tool says
    // so rather than pretending otherwise.
    plan.absoluteLinks = /`(?:[A-Za-z]:\/|\/)/.test(chosen.block);

    if (!found.present) {
      plan.status = 'installed';
    } else {
      const current = existing.slice(found.begin, blockTailStart(existing, found, contract));
      plan.status = sameBlock(current, chosen.block) ? 'already-installed' : 'upgraded';
    }

    // The full chain, not just the leaf's parent — applyOne mkdirs recursively.
    plan.creatingDirs = missingAncestors(target.file);

    // An upgrade replaces bytes between the markers, so applyOne backs up first.
    // Say so HERE, where the user is deciding, not only afterwards. Uninstall
    // already announced it; this is the same promise on the other path.
    plan.backup = plannedBackup(target.file, plan.status === 'upgraded');
  } catch (err) {
    plan.status = 'failed';
    plan.error = err.message;
  }
  return plan;
}

/** Same, for removal. */
export function planOneUninstall(target, contract) {
  const plan = { ...target, status: 'failed', exists: false, removedBytes: 0, backup: null, error: null };
  try {
    assertSafeFile(target.file, contract);
    if (!fs.existsSync(target.file)) {
      plan.status = 'not-installed';
      return plan;
    }
    plan.exists = true;
    const existing = fs.readFileSync(target.file, 'utf8');
    plan.expectExisting = existing;
    const found = findBlock(existing, contract);
    if (found.ambiguous) {
      plan.status = 'ambiguous-state';
      plan.error = `${found.reason} — refusing to remove.`;
      return plan;
    }
    if (!found.present) {
      plan.status = 'not-installed';
      return plan;
    }
    plan.status = 'removed';
    plan.backup = plannedBackup(target.file, true);
    const tailStart = blockTailStart(existing, found, contract);
    plan.removedBytes = tailStart - found.begin;
    // The exact bytes that will disappear, so the preview can show them rather
    // than describe them. Same requirement the conventions skill puts on its
    // own remove: "do NOT abbreviate; the user must see verbatim what
    // disappears" — a summary is not review, it is a promise.
    plan.removedText = existing.slice(found.begin, tailStart);
  } catch (err) {
    plan.error = err.message;
  }
  return plan;
}

/**
 * Write a file so that a reader never sees a half-written one.
 *
 * Temp file in the SAME directory (a rename is only atomic within a filesystem)
 * then `fs.renameSync` over the target. These are files a foreign agent reads at
 * session start; a truncated rules file is not a smaller instruction set, it is
 * a corrupt one, and the window for that was previously the whole write.
 */
function writeAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* the original is intact either way */ }
    throw err;
  }
}

/**
 * Sidecar backup before any destructive mutation.
 *
 * House precedent: the `conventions` skill's `remove` is required to write
 * `CLAUDE.md.bak-<id>-<timestamp>` before stripping a section, and to leave it
 * behind rather than clean it up. Same reasoning, same shape: the block sits in
 * a file the user also writes in, an upgrade replaces bytes they may have
 * edited, and rollback should not require them to have a copy of their own.
 */
export function backupSidecar(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-');
  // A second-resolution stamp collides when two mutations land in the same
  // second — which is the normal case, not an edge case: an upgrade followed by
  // an uninstall takes milliseconds, and the second copy silently overwrote the
  // first, destroying the very state the backup existed to preserve.
  let bak = `${file}.bak-skills-index-${stamp}`;
  let n = 1;
  while (fs.existsSync(bak)) {
    bak = `${file}.bak-skills-index-${stamp}-${n}`;
    n += 1;
  }
  fs.copyFileSync(file, bak);
  return bak;
}

/**
 * Write one planned install. Only called for statuses that mean a change.
 *
 * RE-VERIFIES before writing. A plan is a statement about the file as it was
 * when the preview ran; between that and `--apply` the user may have edited it,
 * another tool may have written it, or a second copy of this command may have
 * run. Re-reading and re-deciding here means the preview is a proposal, never a
 * licence to overwrite whatever is there now. `expectExisting` carries the
 * bytes the plan was computed from; a mismatch aborts instead of clobbering.
 */
export function applyOne(plan, contract, { backup = true } = {}) {
  assertSafeFile(plan.file, contract);
  const dir = path.dirname(plan.file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : '';
  if (plan.expectExisting !== undefined && existing !== plan.expectExisting) {
    throw new Error(
      `${plan.file} changed between preview and apply (was ${plan.expectExisting.length} chars, `
      + `now ${existing.length}). Refusing to write: the preview you approved described a different file. `
      + 'Re-run the preview.',
    );
  }

  const found = findBlock(existing, contract);
  if (found.ambiguous) throw new Error(`ambiguous marker state in ${plan.file}: ${found.reason}`);

  // Replacing an existing block is destructive — whatever was between the
  // markers is gone. A first install appends and destroys nothing.
  const backedUp = (backup && found.present) ? backupSidecar(plan.file) : null;

  const next = composeNext(existing, plan, contract);
  writeAtomic(plan.file, next);
  return { file: plan.file, bytes: next.length, backup: backedUp };
}

/**
 * Remove one managed block.
 *
 * THE GUARANTEE, stated as narrowly as it is actually provided:
 *
 *  - Block at end-of-file, which is where an install puts it: the round trip is
 *    BYTE-IDENTICAL. The blank line the install inserted as a separator is the
 *    only thing given back.
 *  - The user has moved the block and text follows it: head and tail are
 *    rejoined VERBATIM. Nothing else in the file is touched; the separator
 *    blank line may remain.
 *
 * An earlier version ran `\n{3,}` over the WHOLE file, which reached far past
 * the join and silently collapsed deliberate blank-line runs — including blank
 * lines inside fenced code blocks. A remover that rewrites parts of a file it
 * was not asked to touch is worse than one that leaves a stray newline.
 */
export function applyUninstallOne(plan, contract, { backup = true } = {}) {
  assertSafeFile(plan.file, contract);
  const existing = fs.readFileSync(plan.file, 'utf8');
  if (plan.expectExisting !== undefined && existing !== plan.expectExisting) {
    throw new Error(
      `${plan.file} changed between preview and apply (was ${plan.expectExisting.length} chars, `
      + `now ${existing.length}). Refusing to remove: the block you were shown is not the block that is there now.`,
    );
  }
  const found = findBlock(existing, contract);
  if (!found.present || found.ambiguous) {
    throw new Error(`no single well-formed marker block in ${plan.file}`);
  }
  const backedUp = backup ? backupSidecar(plan.file) : null;
  const head = existing.slice(0, found.begin);
  const tail = existing.slice(blockTailStart(existing, found, contract));
  const next = tail.length > 0 ? head + tail : head.replace(/(\r?\n){2,}$/, '$1');
  writeAtomic(plan.file, next);
  return { file: plan.file, bytes: next.length, backup: backedUp };
}
