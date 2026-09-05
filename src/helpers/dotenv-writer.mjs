/**
 * dotenv-writer.mjs — set or remove ONE `KEY=value` line in a workspace `.env`.
 *
 * `lock_vault --persist` and `set_auto_enrich_mode --persist` each carried a
 * private copy of these two functions, "forked from lock.mjs to avoid
 * cross-tool imports". Two copies were tolerable; the third caller —
 * `confirm_workspace_binding({ refuse })`, which writes the portable half of a
 * refused proposal (decision `refus-d-une-proposition-de-liaison`) — would have
 * made three, and this repository's recorded failure mode is a fix that lands
 * in one copy and not the others: the newline guard below was added to the
 * first copy alone for a whole review round while the setup script kept
 * writing injectable values. So the writer lives here once, and the tools
 * import it.
 *
 * What is NOT here, on purpose: the reader. `parseDotenv` in
 * workspace-dotenv.mjs is the one parser; this module only edits lines, and
 * it matches keys the way that parser does (first `KEY=` at start of line,
 * surrounding whitespace ignored) so that what the writer touches is what the
 * loader reads.
 *
 * Node builtins plus the dependency-free validator: `assertDotenvScalar` is
 * the whole reason a shared writer is worth having.
 */

import fs from 'node:fs/promises';
import { assertDotenvScalar } from './dotenv-scalar.mjs';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Set or update KEY=VALUE in the .env file at envPath. Creates the file
 * if it doesn't exist. Preserves all other lines, including comments and
 * formatting.
 *
 * Duplicate-line policy: updates the FIRST occurrence and leaves later
 * duplicates as-is. This matches the convention of the loader
 * (src/helpers/workspace-dotenv.mjs, "parent wins": the first line to APPLY
 * is the one that takes effect). Updating the last occurrence instead would
 * create a writer/reader disagreement: the writer would update the bottom
 * line but the loader would still read the stale top one. CRLF line endings
 * on Windows are silently converted to LF on write — acceptable for .env
 * files which shells/Node parse equivalently with either ending.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {string} value
 */
export async function upsertDotenvVar(envPath, key, value) {
  // One shared definition — see helpers/dotenv-scalar.mjs. The guard first
  // lived in ONE copy of this function and nowhere else, which is why the
  // setup script kept writing injectable values for a whole review round.
  assertDotenvScalar(value, key, envPath);
  let lines = [];
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    lines = raw.split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File doesn't exist — start with an empty array
  }

  // Find the FIRST occurrence of `<key>=` (start-of-line, ignoring
  // surrounding whitespace) and update it. If absent, append.
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
    // Append, preserving trailing newline behavior
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push(newLine);
    } else if (lines.length > 0) {
      // Last line is empty (file ended with \n) — insert before it
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  } else {
    lines[firstIdx] = newLine;
  }

  // Always end with a newline
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  await fs.writeFile(envPath, out, 'utf8');
}

/**
 * Remove all `<key>=...` lines from the .env file. Returns true if at
 * least one line was removed, false if the file or the key was absent.
 *
 * @param {string} envPath
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function removeDotenvVar(envPath, key) {
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
