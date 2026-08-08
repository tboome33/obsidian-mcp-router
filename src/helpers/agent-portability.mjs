/**
 * agent-portability.mjs — C12, the frontmatter side.
 *
 * Answers one question per skill: could this page be lifted out of Claude Code
 * and handed to another host unedited?
 *
 * The question is not rhetorical. Claude Code accepts roughly twenty frontmatter
 * keys and silently ignores whatever it does not use, so a page can carry a
 * Claude-only key for a year without anyone noticing. The spec distribution
 * paths do the opposite — they reject the whole file on the first unknown key.
 * So the cost of an extra key is zero right up until the moment it is total,
 * and nothing in the repo measured it before this module.
 *
 * The rules are NOT written here. They live in contracts/agent-host-targets.json
 * under `portableFrontmatter`, with the doc section each one came from, so that
 * a rule can be argued with by editing data rather than by reading code.
 *
 * Severity model, and why `warn` is not a cop-out: `argument-hint` on five
 * skills is a deliberate, recorded trade (this repo ships as a Claude Code
 * plugin, where the key is legal and useful). Deleting it would remove working
 * autocomplete to satisfy a distribution path the repo does not currently use.
 * So it is declared in the contract as an accepted extension and reported every
 * run — visible, counted, never fatal. An UNDECLARED key is a different animal:
 * nobody weighed it, so it is an error. `--strict` collapses the distinction and
 * shows the spec-path truth.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Split a SKILL.md into its YAML frontmatter block and body.
 *
 * Deliberately not a YAML library. The frontmatter of a skill is a flat map of
 * scalars; pulling in a parser would buy nothing and would start accepting
 * shapes (anchors, nested maps) that the hosts themselves do not read back the
 * same way. What this DOES do carefully is distinguish a key line from a
 * continuation line, because a description that wraps must not be read as three
 * unknown keys.
 *
 * Returns { found, raw, keys, values } — `keys` in file order, duplicates kept
 * (a duplicated key is itself a finding).
 */
export function parseFrontmatter(text) {
  const normalized = String(text).replace(/^﻿/, '');
  const m = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { found: false, raw: '', keys: [], values: {} };

  const raw = m[1];
  const lines = raw.split(/\r?\n/);
  const keys = [];
  const values = {};
  let current = null;

  for (const line of lines) {
    // A key line starts at column 0. Anything indented, or any line that does
    // not open with `<key>:`, continues the value above it.
    const km = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(line);
    if (km) {
      current = km[1];
      keys.push(current);
      let v = km[2].trim();
      // `description: |` opens a YAML block scalar; the indicator is syntax, not
      // the first character of the value. 23/47 skills in this repository use
      // one, and leaving it in put a stray pipe at the head of half the entries
      // in every generated index and added two characters to every measurement.
      if (/^[|>][-+]?\d*$/.test(v)) v = '';
      values[current] = values[current] === undefined ? v : `${values[current]}\n${v}`;
    } else if (current !== null) {
      const cont = line.trim();
      if (cont) values[current] = `${values[current]}\n${cont}`.trim();
    }
  }

  return { found: true, raw, keys, values };
}

/**
 * The length a host budget actually sees.
 *
 * Quoting styles are an authoring detail, not payload: a description wrapped in
 * quotes does not cost two extra characters of context. Strip one matching pair
 * and normalise the wrapped-line joins to single spaces, then measure.
 */
export function measuredDescriptionLength(value) {
  if (value === undefined || value === null) return 0;
  let s = String(value).replace(/\s*\n\s*/g, ' ').trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) s = s.slice(1, -1);
  }
  return s.trim().length;
}

function finding(severity, code, skill, message, detail = {}) {
  return { severity, code, skill, message, ...detail };
}

/**
 * List the skill directories that actually hold a SKILL.md.
 *
 * The count is derived here and nowhere else. Every number this module reports
 * — and the denominator the CLI prints — comes from this one walk, so a claim
 * about "all skills" cannot quietly mean "the skills someone listed in 2026".
 */
export function listSkills(repoRoot, { skillsDir = 'skills' } = {}) {
  const root = path.join(repoRoot, skillsDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, dir: path.join(root, name), file: path.join(root, name, 'SKILL.md') }))
    .filter((s) => fs.existsSync(s.file));
}

/**
 * Audit every skill's frontmatter against the portable subset.
 *
 * Returns { findings, counts, skills } where `counts` carries the denominators
 * every caller is required to print alongside its numbers.
 */
export function auditSkillFrontmatter(repoRoot, contract, { strict = false, skillsDir = 'skills' } = {}) {
  const rules = contract.portableFrontmatter;
  const spec = new Set(rules.specFields);
  const required = rules.requiredFields;
  const accepted = rules.acceptedHostExtensions || {};
  const namePattern = new RegExp(rules.namePattern);

  const skills = listSkills(repoRoot, { skillsDir });
  const findings = [];
  const portableSkills = [];
  const extensionUse = {};

  for (const skill of skills) {
    const text = fs.readFileSync(skill.file, 'utf8');
    const fm = parseFrontmatter(text);
    let clean = true;

    if (!fm.found) {
      findings.push(finding('error', 'frontmatter-missing', skill.name,
        'no YAML frontmatter block — every host discovers a skill through its frontmatter, so this page is invisible everywhere.'));
      continue;
    }

    const seen = new Set();
    for (const key of fm.keys) {
      if (seen.has(key)) {
        clean = false;
        findings.push(finding('error', 'duplicate-key', skill.name,
          `frontmatter key \`${key}\` appears more than once — which value wins is parser-dependent, so it differs per host.`, { key }));
      }
      seen.add(key);

      if (spec.has(key)) continue;

      const declared = accepted[key];
      if (declared) {
        extensionUse[key] = (extensionUse[key] || 0) + 1;
        clean = false;
        const severity = strict ? 'error' : (declared.severity || 'warn');
        findings.push(finding(severity, 'host-extension', skill.name,
          `frontmatter key \`${key}\` is a ${declared.host} extension, not one of the spec's ${rules.specFields.length} fields — the skill loads in Claude Code and is rejected outright on a spec distribution path.`,
          { key, host: declared.host }));
      } else {
        clean = false;
        findings.push(finding('error', 'undeclared-key', skill.name,
          `frontmatter key \`${key}\` is neither a spec field nor a declared host extension. Either drop it, or record it under \`portableFrontmatter.acceptedHostExtensions\` in contracts/agent-host-targets.json with the reason it is worth its cost.`,
          { key }));
      }
    }

    for (const req of required) {
      if (!seen.has(req) || !String(fm.values[req] || '').trim()) {
        clean = false;
        findings.push(finding('error', 'required-field-missing', skill.name,
          `frontmatter is missing a non-empty \`${req}\`.`, { key: req }));
      }
    }

    const declaredName = String(fm.values.name || '').trim();
    if (declaredName) {
      if (!namePattern.test(declaredName)) {
        clean = false;
        findings.push(finding('error', 'name-format', skill.name,
          `\`name: ${declaredName}\` does not match ${rules.namePattern} — hosts derive command names and file names from it.`, { key: 'name' }));
      }
      if (declaredName.length > rules.nameMaxLength) {
        clean = false;
        findings.push(finding('error', 'name-too-long', skill.name,
          `\`name\` is ${declaredName.length} characters, over the ${rules.nameMaxLength} allowed.`, { key: 'name' }));
      }
      if (declaredName !== skill.name) {
        clean = false;
        findings.push(finding('error', 'name-directory-mismatch', skill.name,
          `\`name: ${declaredName}\` does not match the directory \`${skill.name}\`. Hosts that key on the directory and hosts that key on the field would then disagree about what this skill is called.`,
          { key: 'name', declaredName }));
      }
    }

    const descLen = measuredDescriptionLength(fm.values.description);
    if (descLen > rules.descriptionCharLimit) {
      clean = false;
      findings.push(finding('error', 'description-over-budget', skill.name,
        `description is ${descLen} characters, over the Agent Skills limit of ${rules.descriptionCharLimit} `
        + `(${rules.authority}, accessed ${rules.authorityAccessed}: "Must be 1-${rules.descriptionCharLimit} characters"). `
        + 'A conforming validator rejects the whole file, so this is not a truncation risk but an invalid skill.',
        { key: 'description', length: descLen, budget: rules.descriptionCharLimit }));
    }

    const compat = fm.values.compatibility;
    if (compat !== undefined) {
      const len = measuredDescriptionLength(compat);
      if (len > rules.compatibilityCharBudget) {
        clean = false;
        findings.push(finding('error', 'compatibility-over-budget', skill.name,
          `compatibility is ${len} characters, over the ${rules.compatibilityCharBudget} allowed.`,
          { key: 'compatibility', length: len, budget: rules.compatibilityCharBudget }));
      }
    }

    if (clean) portableSkills.push(skill.name);
  }

  const counts = {
    skills: skills.length,
    portable: portableSkills.length,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    extensionUse,
    longestDescription: skills.reduce((max, s) => {
      const fm = parseFrontmatter(fs.readFileSync(s.file, 'utf8'));
      return Math.max(max, measuredDescriptionLength(fm.values.description));
    }, 0),
  };

  return { findings, counts, skills, portableSkills };
}

/** Human-readable report. Always prints denominators — never a bare number. */
export function renderAudit({ findings, counts }, { strict = false } = {}) {
  const lines = [];
  const bySkill = new Map();
  for (const f of findings) {
    if (!bySkill.has(f.skill)) bySkill.set(f.skill, []);
    bySkill.get(f.skill).push(f);
  }

  if (findings.length === 0) {
    lines.push('  No findings.');
  } else {
    for (const [skill, fs_] of bySkill) {
      lines.push(`  ${skill}`);
      for (const f of fs_) lines.push(`    [${f.severity}] ${f.code} — ${f.message}`);
    }
  }

  lines.push('');
  lines.push('  SCOPE: frontmatter portability only — whether each page\'s METADATA conforms to the');
  lines.push('  Agent Skills spec, so it can be read by a non-Claude host. It says nothing about');
  lines.push('  whether the page\'s workflow would EXECUTE there; that question belongs to');
  lines.push('  contracts/skill-capabilities.json, which records what each skill reads, writes and calls.');
  lines.push('');
  lines.push(`  ${counts.portable}/${counts.skills} skills carry spec-only frontmatter`
    + ` · ${counts.errors} error(s) · ${counts.warnings} warning(s)`
    + ` · longest description ${counts.longestDescription} chars`);
  const ext = Object.entries(counts.extensionUse);
  if (ext.length) {
    lines.push(`  host extensions in use: ${ext.map(([k, n]) => `${k} (${n}/${counts.skills})`).join(', ')}`);
  }
  if (!strict && counts.warnings > 0) {
    lines.push('  Re-run with --strict to fail on declared host extensions (the spec-distribution view).');
  }
  return lines.join('\n');
}
