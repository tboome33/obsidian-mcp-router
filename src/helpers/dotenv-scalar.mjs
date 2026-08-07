/**
 * THE validator for a value about to be persisted into a `.env` file.
 *
 * A dotenv file is LINE-STRUCTURED. A value containing a newline is therefore
 * not a value — it is additional assignments. Both readers in this repo
 * (`bin/obsidian-mcp-router.mjs`, `hooks/_helpers/workspace-vault.mjs`) split
 * into lines BEFORE they interpret quotes, so quoting does not contain it
 * either: a quoted multi-line value still parses as several variables.
 *
 * This module exists because the repo had THREE independent copies of the same
 * dotenv writer — `src/tools/lock.mjs`, `src/tools/auto-enrich.mjs` and
 * `scripts/setup-vault.mjs` — and a review found the guard added to the first
 * one only. A hostile or mistaken vault name of
 *
 *     safe\nOBSIDIAN_ROUTER_READONLY=false\nINJECTED
 *
 * therefore still wrote three lines through the setup script, the middle one
 * re-enabling write access at the next start. That is the same shape as the
 * ENOTFOUND bug of v0.70.1, the `[`-exclusion of v0.71.0, and the containment
 * guard that reached only `write_bundle`: a correct fix applied to its first
 * call site. Hence one definition, imported by all three, and a capability
 * test that fails if a fourth writer appears without it.
 *
 * REFUSE rather than escape or strip. A name carrying a newline is broken
 * upstream; silently persisting a truncated variant would write something the
 * caller never asked for, and silently escaping it would put a literal `\n`
 * into a value that is read back as two characters. Neither is what anyone
 * means. The caller should fix the name.
 */

import { safeForMessage } from './sanitize.mjs';

/**
 * Echo a REJECTED value's LABELS safely.
 *
 * The refusal deliberately never quotes the value itself — a dotenv value is
 * often a secret. But `key` and `where` are interpolated so the caller can find
 * the offending assignment, and both are derived from caller-supplied input
 * (`where` is an env path built from the vault path). Interpolated raw, the
 * guard becomes the injection channel it was written to close. Same defect as
 * `vault-path-guard`, found in the same round.
 */
const echo = (v) => safeForMessage(v, 120);

/** Thrown when a value cannot be safely persisted into a dotenv file. */
export class DotenvValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DotenvValueError';
    this.kind = 'validation'; // else error-classify reports `unknown`
  }
}

/**
 * Assert that `value` can be written as a single `KEY=value` line.
 *
 * @param {unknown} value
 * @param {string} key   the variable name, for the refusal message
 * @param {string} [where] the file being written, for the refusal message
 * @returns {string} the value, unchanged, when it is safe
 */
export function assertDotenvScalar(value, key, where = '.env') {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) {
    throw new DotenvValueError(
      `refusing to persist ${echo(key)}: the value contains a newline or NUL, which would write extra `
      + `lines into ${echo(where)} rather than a single value. Fix the value at its source.`,
    );
  }
  return s;
}
