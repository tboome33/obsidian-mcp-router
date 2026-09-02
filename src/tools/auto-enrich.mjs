/**
 * set_auto_enrich_mode — runtime auto-enrichment mode toggle.
 *
 * Auto-enrichment is the wiki tracking layer where Claude proactively
 * suggests saves at three triggers (validation / result / topic-switch).
 * The mode controls how much friction the user sees:
 *
 *   - "ClaudeAsk"  — Claude proposes, user confirms every save (default)
 *   - "Hybrid"     — Auto-save type-safe items (facts, URLs), ask on
 *                    high-stakes (decisions, ADRs, rules, techniques)
 *   - "FullAuto"   — Auto-save everything; audit log + sensitivity filter
 *                    + hard cap (degrades to ClaudeAsk after N saves)
 *   - "off"        — No auto-suggestions; user invokes /save manually
 *
 * Mirrors the lock-mode architecture: state lives on `registry.autoEnrichMode`,
 * persistence is opt-in via `OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>` in
 * `<cwd>/.env` so the mode survives router restarts.
 *
 * The actual behavior change happens in Claude's reasoning — the mode
 * value is surfaced via `list_vaults` (field `autoEnrichMode`) and the
 * CLAUDE.md consigne at the vault root tells Claude which behavior to
 * apply per mode. The router itself doesn't enforce anything; it just
 * tracks the mode and exposes it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertDotenvScalar } from '../helpers/dotenv-scalar.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
export const VALID_MODES = ['ClaudeAsk', 'Hybrid', 'FullAuto', 'off'];

/**
 * Set the auto-enrichment mode for the current session.
 *
 * Args:
 *   - mode (required): one of "ClaudeAsk" | "Hybrid" | "FullAuto" | "off".
 *     Case-insensitive — we normalize to the canonical capitalization.
 *   - persist (optional): if true, write OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>
 *     to <cwd>/.env so the mode survives router restarts — "off" included,
 *     written as the literal: a REMOVED line would read as the default
 *     (ClaudeAsk) at the next start and silently bring suggestions back.
 */
export async function setAutoEnrichMode(registry, args = {}) {
  const { mode: rawMode, persist } = args;

  if (!rawMode || typeof rawMode !== 'string') {
    throw new Error(
      'set_auto_enrich_mode: missing required argument `mode` (string). ' +
        `Valid modes: ${VALID_MODES.join(', ')}.`,
    );
  }

  // Normalize capitalization. We accept "claudeask" / "CLAUDEASK" / etc.
  // but the canonical stored form is the one in VALID_MODES.
  const mode = canonicalizeMode(rawMode);
  if (!mode) {
    throw new Error(
      // The REJECTED value, so by definition not one of VALID_MODES — i.e.
      // whatever the caller sent. The success path of this tool is sanitized;
      // this refusal was not.
      `set_auto_enrich_mode: invalid mode "${safeForMessage(rawMode, 80)}". ` +
        `Valid modes: ${VALID_MODES.join(', ')}.`,
    );
  }

  // Apply the mode in-memory BEFORE attempting persistence — even if the
  // .env write fails (homedir refusal below, or filesystem error), the
  // session-local mode takes effect.
  const previousMode = registry.autoEnrichMode;
  registry.autoEnrichMode = mode;
  // Provenance: the mode is now this session's doing, whatever a workspace
  // file said at start-up (decision `liaison-workspace-vault-hors-depot`).
  registry.autoEnrichModeSource = { origin: 'runtime', variable: null };

  let persisted = false;
  let envPath = null;
  if (persist) {
    const cwd = process.cwd();
    // Same homedir refusal as lock_vault: writing OBSIDIAN_ROUTER_AUTO_ENRICH
    // to ~/.env when Claude Code was launched from $HOME is almost always
    // unintended. The session lock IS active either way — refusal only
    // blocks the .env write, not the mode change itself.
    const samePath = (a, b) => {
      const ra = path.resolve(a);
      const rb = path.resolve(b);
      if (process.platform === 'win32') {
        return ra.toLowerCase() === rb.toLowerCase();
      }
      return ra === rb;
    };
    if (samePath(cwd, os.homedir())) {
      throw new Error(
        `set_auto_enrich_mode: refusing to persist OBSIDIAN_ROUTER_AUTO_ENRICH in your home directory (${cwd}/.env). ` +
          `That's almost always unintended — Claude Code was launched from your home rather than a project folder. ` +
          `Either: (a) re-run set_auto_enrich_mode from a real project directory, OR (b) set OBSIDIAN_ROUTER_AUTO_ENRICH=${mode} manually in your shell profile (.bashrc / PowerShell $PROFILE) for true machine-wide persistence. ` +
          `The in-memory mode IS active for this session.`,
      );
    }
    envPath = path.join(cwd, '.env');
    // Always write the literal mode value, including "off". Earlier we
    // tried "remove the line entirely" as a clever shortcut for "off
    // persisted", but that was buggy: startup interprets a missing env
    // var as the default ("ClaudeAsk"), so a user who explicitly chose
    // "off" for a sensitive/debug vault would silently get auto-suggestions
    // back after the next restart. The honest persistence is to write
    // the literal — `validateAutoEnrichMode("off")` recognizes it cleanly
    // via canonicalizeMode and the boot path keeps the user's intent.
    await upsertDotenvVar(envPath, 'OBSIDIAN_ROUTER_AUTO_ENRICH', mode);
    persisted = true;
  }

  return ({
    mode,
    previousMode: previousMode ?? null,
    persisted,
    envPath: persisted ? envPath : undefined,
    message:
      `Auto-enrichment mode set to "${mode}". ` +
      (persisted
        ? `OBSIDIAN_ROUTER_AUTO_ENRICH=${mode} written to ${envPath} — mode survives restart.`
        : `Mode is volatile (this session only). Use persist:true to make it survive restarts.`),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a user-provided mode string. Returns the canonical form
 * (matching VALID_MODES exactly) if recognized, null otherwise. Accepts
 * any case, and a couple of natural-language synonyms.
 */
export function canonicalizeMode(input) {
  if (!input || typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  // Direct case-insensitive match
  for (const m of VALID_MODES) {
    if (m.toLowerCase() === lower) return m;
  }
  // A few NL synonyms — we keep this list small to avoid surprise.
  const aliases = {
    ask: 'ClaudeAsk',
    'ask-mode': 'ClaudeAsk',
    'claude-ask': 'ClaudeAsk',
    auto: 'FullAuto',
    full: 'FullAuto',
    'full-auto': 'FullAuto',
    fullauto: 'FullAuto',
    semi: 'Hybrid',
    'semi-auto': 'Hybrid',
    hybride: 'Hybrid',
    none: 'off',
    disabled: 'off',
    disable: 'off',
  };
  return aliases[lower] || null;
}

/**
 * Set or update KEY=VALUE in the .env file at envPath. Creates the file
 * if it doesn't exist. Updates the FIRST occurrence to match the reader
 * convention in bin/obsidian-mcp-router.mjs (`if (!(key in process.env))`).
 *
 * Forked-from-lock.mjs implementation kept in this file to avoid
 * cross-tool imports — they're each ~25 lines, the cost of duplication
 * is lower than the cost of a new shared module that two tools depend on.
 */
async function upsertDotenvVar(envPath, key, value) {
  // Shared definition — see helpers/dotenv-scalar.mjs. Today this writer's
  // caller reduces its input to a fixed mode vocabulary before reaching here,
  // so it is not exploitable; the guard is present anyway so the NEXT caller
  // does not have to rediscover why it matters.
  assertDotenvScalar(value, key, envPath);
  let lines = [];
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    lines = raw.split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let firstIdx = -1;
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (keyRegex.test(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  const newLine = `${key}=${value}`;
  if (firstIdx === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push(newLine);
    } else if (lines.length > 0) {
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  } else {
    lines[firstIdx] = newLine;
  }

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  await fs.writeFile(envPath, out, 'utf8');
}

async function removeDotenvVar(envPath, key) {
  let raw;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  const lines = raw.split(/\r?\n/);
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const filtered = lines.filter((l) => !keyRegex.test(l));
  if (filtered.length === lines.length) return false;

  let out = filtered.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  await fs.writeFile(envPath, out, 'utf8');
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for tests only. canonicalizeMode is a top-level named export
// (above) — don't re-export it here too, that's redundant.
export const _internals = { upsertDotenvVar, removeDotenvVar };
