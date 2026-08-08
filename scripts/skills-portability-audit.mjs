#!/usr/bin/env node
/**
 * skills-portability-audit.mjs — C12.
 *
 * Reports whether each skill's frontmatter stays inside the Agent Skills
 * portable subset, so "the skills work outside Claude Code" is a measurement
 * rather than an assumption.
 *
 * Exit 1 on any `error` finding. Declared host extensions are warnings by
 * default and errors under --strict; the difference is the difference between
 * "this repository ships as a Claude Code plugin, where the key is legal" and
 * "this page could be uploaded to a spec distribution path unedited".
 *
 * Usage:
 *   node scripts/skills-portability-audit.mjs            # human output
 *   node scripts/skills-portability-audit.mjs --strict   # host extensions are fatal
 *   node scripts/skills-portability-audit.mjs --json     # machine output
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditSkillFrontmatter, renderAudit } from '../src/helpers/agent-portability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_REL = 'contracts/agent-host-targets.json';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const asJson = args.includes('--json');

const contractPath = path.join(REPO_ROOT, CONTRACT_REL);
if (!fs.existsSync(contractPath)) {
  console.error(`missing ${CONTRACT_REL} — the audit has no rules without it.`);
  process.exit(1);
}
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

const result = auditSkillFrontmatter(REPO_ROOT, contract, { strict });
const errors = result.findings.filter((f) => f.severity === 'error');

if (asJson) {
  console.log(JSON.stringify({ ok: errors.length === 0, strict, ...result }, null, 2));
} else {
  console.log(`Skill frontmatter portability — ${CONTRACT_REL}${strict ? ' (strict)' : ''}`);
  console.log(`Portable subset: ${contract.portableFrontmatter.specFields.join(', ')}`);
  console.log(`Authority       : ${contract.portableFrontmatter.authority} (accessed ${contract.portableFrontmatter.authorityAccessed})`);
  console.log(`description limit: ${contract.portableFrontmatter.descriptionCharLimit} chars · name limit: ${contract.portableFrontmatter.nameMaxLength}`);
  console.log('');
  console.log(renderAudit(result, { strict }));
}

process.exitCode = errors.length === 0 ? 0 : 1;
