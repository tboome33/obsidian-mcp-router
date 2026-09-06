#!/usr/bin/env node
/**
 * render-quick-reference.mjs — the two quick-reference PDFs, and the record of
 * what they were rendered from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `docs/quick-reference-{en,fr}.pdf` is what people actually read: it is linked
 * from both README halves and it is the page someone prints. Until v0.90.0 it
 * was rebuilt by hand — "re-render via Chrome headless", one line in
 * CONTRIBUTING.md — and `npm run validate` pinned the artifact counters in
 * `README.md` and `docs/architecture.md` but not in the quick-reference pages.
 *
 * The result was exactly what an unguarded document does: the README stayed
 * honest at 53 slash commands while both PDFs went on claiming 51 slash
 * commands, 51 MCP tools and 47 skills — a whole catalogue behind, in the
 * artifact with the widest readership. The gate covered the documents it had
 * been pointed at, not the CLASS of documents that carry the claim.
 *
 * So the counters are now pinned in the two HTML sources (COUNTER_RULES in
 * `src/helpers/skill-capabilities.mjs`), and this script closes the second
 * half of the hole: pinning the SOURCE is not enough when the artifact people
 * read is a separate file that someone has to remember to regenerate. Fixing
 * the HTML and forgetting the render would leave the gate green and the PDF
 * wrong — the same failure one step further along.
 *
 * Hence the manifest: this script records the sha256 of each HTML it rendered
 * from, and the validator refuses when a page has changed since. "I edited the
 * source and forgot to re-render" becomes a named failure with the command to
 * fix it, instead of a silent drift nobody measures until the next release.
 *
 * Usage:
 *   npm run docs:quick-reference          # render both, refresh the manifest
 *   node scripts/render-quick-reference.mjs --check   # verify, render nothing
 *
 * Chrome is found from CHROME_PATH, then the usual per-platform locations.
 * This is developer tooling run from the developer's own shell, so the spawn
 * inherits that shell deliberately — pinned as such in
 * tests/subprocess-env.test.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  QUICK_REFERENCE_PAGES,
  QUICK_REFERENCE_MANIFEST,
  htmlRelPath,
  pdfRelPath,
  sha256OfFile,
  quickReferenceFreshness,
} from '../src/helpers/quick-reference.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Candidate Chrome/Edge binaries, most-wanted first. Chromium's headless
 * `--print-to-pdf` is the renderer CONTRIBUTING.md has always named; Edge is
 * the same engine and is present on every Windows box, which is where this
 * repository is maintained.
 */
function chromeCandidates() {
  const fromEnv = process.env.CHROME_PATH;
  const list = fromEnv ? [fromEnv] : [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  if (process.platform === 'win32') {
    list.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return list.filter(Boolean);
}

export function findChrome() {
  for (const c of chromeCandidates()) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // An unreadable candidate is simply not the one; keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function renderAll() {
  const chrome = findChrome();
  if (!chrome) {
    console.error(
      'No Chrome or Edge found. Set CHROME_PATH to a Chromium binary and re-run:\n'
      + `  candidates tried:\n${chromeCandidates().map((c) => `    ${c}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  // A throwaway profile: rendering must not touch — or be shaped by — the
  // developer's own Chrome profile, and a locked profile is the commonest
  // reason a headless print silently produces nothing.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-render-'));
  const renderedFrom = {};

  try {
    for (const lang of QUICK_REFERENCE_PAGES) {
      const htmlAbs = path.join(REPO_ROOT, htmlRelPath(lang));
      const pdfAbs = path.join(REPO_ROOT, pdfRelPath(lang));
      if (!fs.existsSync(htmlAbs)) {
        console.error(`missing source: ${htmlRelPath(lang)}`);
        process.exitCode = 1;
        return;
      }
      const before = sha256OfFile(pdfAbs);
      execFileSync(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfAbs}`,
        `file:///${htmlAbs.replace(/\\/g, '/')}`,
      ], { stdio: 'ignore' });

      // Chrome exits 0 on a great many non-renders, so the artifact is what
      // is checked, not the exit code.
      if (!fs.existsSync(pdfAbs)) {
        console.error(`${pdfRelPath(lang)} was not produced — Chrome exited without writing it.`);
        process.exitCode = 1;
        return;
      }
      renderedFrom[htmlRelPath(lang)] = sha256OfFile(htmlAbs);
      const after = sha256OfFile(pdfAbs);
      console.log(
        `  ${pdfRelPath(lang)} — ${(fs.statSync(pdfAbs).size / 1024).toFixed(0)} KB`
        + `${before && before === after ? ' (unchanged)' : ''}`,
      );
    }

    const manifest = {
      $comment:
        'Written by scripts/render-quick-reference.mjs. Each value is the sha256 of the HTML '
        + 'the matching PDF was rendered from; `npm run validate` refuses when a page has '
        + 'changed since, so editing the source and forgetting the render is a named failure '
        + 'rather than a silent drift. Do not hand-edit — run `npm run docs:quick-reference`.',
      renderedFrom,
    };
    fs.writeFileSync(
      path.join(REPO_ROOT, QUICK_REFERENCE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    console.log(`  ${QUICK_REFERENCE_MANIFEST} refreshed.`);
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // A profile we cannot remove is temp-directory litter, not a failure.
    }
  }
}

function reportCheck() {
  const rows = quickReferenceFreshness(REPO_ROOT);
  const bad = rows.filter((r) => r.state !== 'fresh');
  for (const r of rows) console.log(`  ${r.html} — ${r.state}`);
  if (bad.length) {
    console.error('\nRun `npm run docs:quick-reference` to re-render and refresh the manifest.');
    process.exitCode = 1;
  } else {
    console.log('\nquick-reference PDFs: OK — rendered from the current pages.');
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (process.argv.includes('--check')) reportCheck();
  else renderAll();
}
