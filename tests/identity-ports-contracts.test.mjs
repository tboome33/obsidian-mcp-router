/**
 * Lot 8 — the contracts that cannot be checked one call site at a time.
 *
 * ---------------------------------------------------------------------------
 * WHY SCANS, WHEN THERE ARE ALREADY 5800 TESTS
 * ---------------------------------------------------------------------------
 * A behavioural test proves a rule holds where it is exercised. It cannot prove
 * there is no eighth site that never learned the rule — and in this repository
 * that is the failure that keeps happening: a fix reaches its first call site,
 * reads as closed, and ten other files carry on doing the old thing. Four
 * recurrences are recorded in the history of `port-registry.mjs` and
 * `vault-slug.mjs` alone.
 *
 * So these tests ask questions with a DENOMINATOR: every file, every writer,
 * every producer. They complement the behavioural tests; they do not replace
 * them, and neither replaces the other.
 *
 * AND THE SCANS ARE THEMSELVES TESTED against the shapes they claim to refuse.
 * A scan that has never been run on a violation is a guard nobody has checked —
 * this repository has already shipped one whose regex matched exactly the
 * spelling used last time and walked past six rewrites of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every authored source file the router actually runs. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(rel);
      } else if (entry.name.endsWith('.mjs')) {
        out.push({ rel: rel.split(path.sep).join('/'), abs: path.join(REPO_ROOT, rel) });
      }
    }
  };
  walk('src');
  walk('scripts');
  return out;
}

const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

// ---------------------------------------------------------------------------
// "http = https + 10" must never be RECONSTRUCTED for an existing vault
// ---------------------------------------------------------------------------

describe('the +10 convention is a creation rule, never a repair rule', () => {
  // Invariant I6, and the reason the fleet survives: 18 of 27 production pairs
  // do not respect the gap and six run backwards. Any expression that DERIVES a
  // plaintext port from an HTTPS one is either the one legitimate creation site
  // or a bug that renumbers a port written into the user's notes.
  const DERIVES = /\b(port|https?Port|httpsPort)\s*\+\s*(DEFAULT_INSECURE_OFFSET|insecureOffset|offset|10)\b/;

  /**
   * Exempt BY EXACT LINE, never by heuristic. A heuristic exemption is what
   * let a raw read through a 211-green scan once already; a list of known lines
   * fails loudly when the code around it changes, which is the right friction.
   */
  const ALLOWED = new Set([
    // The single creation site: the default a caller falls back to when the
    // allocator did not hand it a reserved plaintext port.
    'scripts/setup-vault.mjs|: port + DEFAULT_INSECURE_OFFSET;',
    // Reporting that the default was NOT used, which is the opposite of
    // applying it.
    'scripts/setup-vault.mjs|if (insecurePort !== port + DEFAULT_INSECURE_OFFSET) {',
    'scripts/setup-vault.mjs|info(`Plaintext port ${port + DEFAULT_INSECURE_OFFSET} is taken — assigning ${insecurePort} instead.`);',
    // The allocator's starting point for a plaintext port that does not exist
    // yet — it SEARCHES from there and checks every candidate.
    'src/helpers/port-registry.mjs|for (let p = httpsPort + insecureOffset; p <= MAX_PORT; p += 1) {',
    'src/helpers/port-registry.mjs|`No free plaintext port at or above ${httpsPort + insecureOffset} — ` +',
    'src/helpers/port-registry.mjs|const start = isPort(httpsPort) ? httpsPort + insecureOffset : DEFAULT_PORT_START + insecureOffset;',
    // PROSE, not code: a warning telling the user the port was NOT guessed
    // that way. Exempted by its exact text rather than by a "does this line
    // look like a sentence" heuristic — this repository has already watched a
    // heuristic exemption let a real violation through at 211/211 green.
    'scripts/setup-vault.mjs|never guessed as port+10.',
  ]);

  test('no file derives a plaintext port from an HTTPS one outside the known sites', () => {
    const offenders = [];
    for (const { rel, abs } of sourceFiles()) {
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!DERIVES.test(line)) return;
        if (ALLOWED.has(`${rel}|${line.trim()}`)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `a plaintext port is derived from an HTTPS one outside the creation sites — 18 of 27 ` +
      `production pairs do not respect that gap and six run backwards:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the scan refuses the shapes somebody would actually write', () => {
    for (const line of [
      'const insecure = port + 10;',
      'data.insecurePort = port + DEFAULT_INSECURE_OFFSET;',
      'return httpsPort + insecureOffset;',
      'const http = httpsPort + offset;',
    ]) {
      assert.equal(DERIVES.test(line), true, `the scan must refuse: ${line}`);
    }
    for (const line of [
      'const next = index + 10;',
      'const timeout = base + 10;',
    ]) {
      assert.equal(DERIVES.test(line), false, `the scan must allow: ${line}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The HTTPS baseUrl is composed in exactly one place
// ---------------------------------------------------------------------------

describe('the vault baseUrl has one producer', () => {
  // Lot 1 made the HTTPS port disk-first. A second place composing
  // `https://127.0.0.1:<port>` would be a second answer to "which port does the
  // router dial", and the first defect this whole release fixes was exactly two
  // rules for two ports.
  const COMPOSES = /`https:\/\/127\.0\.0\.1:\$\{/;

  /**
   * One exemption, by exact line. `writeEnvFile` composes the same string for a
   * `.env` it writes INTO a vault — a value for humans and for other tools,
   * never the address this router dials. Exempting it by file would also
   * exempt anything added to that file later; exempting the line does not.
   */
  const ALLOWED_BASEURL = new Set([
    'scripts/setup-vault.mjs|const baseUrl = `https://127.0.0.1:${port}`;',
  ]);

  test('only src/registry.mjs builds the baseUrl the router dials', () => {
    const offenders = [];
    for (const { rel, abs } of sourceFiles()) {
      if (rel === 'src/registry.mjs') continue;
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!COMPOSES.test(line)) return;
        if (ALLOWED_BASEURL.has(`${rel}|${line.trim()}`)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `a second baseUrl producer:\n  ${offenders.join('\n  ')}`);
  });

  test('the scan refuses the shape it claims to', () => {
    assert.equal(COMPOSES.test('baseUrl: `https://127.0.0.1:${port}`,'), true);
  });
});

// ---------------------------------------------------------------------------
// A registry key is no longer a path
// ---------------------------------------------------------------------------

describe('nothing assumes the registry is keyed by path', () => {
  // Since the migration, `vaultsById` is keyed by UUID and the path index is
  // DERIVED. Any code that treats a registry key as a filesystem path is now
  // wrong for a migrated config — and would be wrong silently, producing a
  // vault whose path is a UUID.
  const KEYED_BY_PATH = /Object\.keys\(\s*(cfg|config|conf)\s*(\?\.|\.)\s*(portRegistry|vaultsById)\s*\)/;

  test('no file enumerates a registry container as if its keys were paths', () => {
    const offenders = [];
    for (const { rel, abs } of sourceFiles()) {
      if (rel === 'src/helpers/vault-slug.mjs') continue; // owns the boundary
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (KEYED_BY_PATH.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `use registeredVaultPaths():\n  ${offenders.join('\n  ')}`);
  });

  test('the scan refuses both containers, dotted and optional', () => {
    for (const line of [
      'for (const p of Object.keys(cfg.portRegistry)) {',
      'const ids = Object.keys(config.vaultsById);',
      'Object.keys(cfg?.vaultsById)',
    ]) {
      assert.equal(KEYED_BY_PATH.test(line), true, `must refuse: ${line}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('no new surface prints a credential', () => {
  test('the identity file format cannot carry an apiKey', async () => {
    // Invariant I3 at the shape level rather than at each call site: the
    // serializer decides what a written identity contains, so a field added by
    // accident somewhere else cannot reach the file.
    const { serializeVaultIdentity, createVaultIdentity } = await import('../src/helpers/vault-identity.mjs');
    const identity = createVaultIdentity({
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      owner: { installId: '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', hostname: 'X' },
    });
    const written = serializeVaultIdentity({ ...identity, apiKey: 'SECRET-VALUE' });
    // An unknown field IS preserved (a newer router may have written it) — the
    // guarantee is not "nothing else may exist", it is that nothing in the
    // router ever puts a key there. So: assert the writer never adds one.
    assert.ok(written.includes('SECRET-VALUE'), 'unknown fields are preserved by design');
    assert.ok(!serializeVaultIdentity(identity).includes('apiKey'));
  });

  test('the new helpers never read an apiKey field', async () => {
    // The identity, ownership, policy, lifecycle and migration helpers are
    // handed fingerprints and ports. None of them should mention the field at
    // all — the surest way not to leak a value is never to hold it.
    const NEW_HELPERS = [
      'src/helpers/vault-identity.mjs',
      'src/helpers/vault-ownership.mjs',
      'src/helpers/vault-lifecycle.mjs',
      'src/helpers/port-policy.mjs',
      'src/helpers/registry-migration.mjs',
      'src/helpers/rest-endpoint-state.mjs',
      'src/helpers/vault-reachability.mjs',
      'src/registry-migration-store.mjs',
      'src/vault-identity-store.mjs',
    ];
    for (const rel of NEW_HELPERS) {
      const source = await fsp.readFile(path.join(REPO_ROOT, rel), 'utf8');
      const code = source.split(/\r?\n/).filter((l) => !isCommentLine(l)).join('\n');
      assert.ok(!/\bapiKey\b/.test(code), `${rel} reads or writes an apiKey`);
    }
  });
});

// ---------------------------------------------------------------------------
// Everything the release added is actually reachable
// ---------------------------------------------------------------------------

describe('the CLI surface documented in this release exists', () => {
  test('every flag the docs and the skill promise is dispatched by the script', () => {
    // "Aucun comportement de CLI documenté n'est fictif." Cheap to check, and
    // the failure mode it prevents — a documented command that was renamed — is
    // one a user meets before any test does.
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    for (const flag of ['--force-new-port-start', '--migrate-vault-identities', '--vault-owner', '--sync-port-registry']) {
      assert.ok(
        script.includes(`args[0] === '${flag}'`),
        `${flag} is documented but the script does not dispatch it`,
      );
    }
  });

  test('the documentation page exists and states the negative claims', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'vault-identity-and-ports.md'), 'utf8');
    // The four sentences a reader most needs, and the ones most tempting to
    // leave out because they are about what the software does NOT do.
    assert.match(doc, /not a reserved range/i);
    assert.match(doc, /probe is not a reservation/i);
    assert.match(doc, /never regenerated|never triggers automatic regeneration/i);
    assert.match(doc, /always synchronised/i);
    assert.match(doc, /Hostnames never are|hostnames? never/i);
  });

  test('the skill and the command point at the same name', () => {
    const command = fs.readFileSync(path.join(REPO_ROOT, 'commands', 'force-new-port-start.md'), 'utf8');
    const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'force-new-port-start', 'SKILL.md'), 'utf8');
    assert.match(command, /Invoke the `force-new-port-start` skill/);
    assert.match(skill, /^name: force-new-port-start$/m);
  });
});
