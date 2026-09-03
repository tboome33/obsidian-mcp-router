/**
 * Tests for src/helpers/vault-slug.mjs — the boundary where the config's word
 * on a vault's name becomes the program's.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ACTUALLY GUARDING
 * ---------------------------------------------------------------------------
 * `config.json` is hand-editable, so `"vaultNames": { "<path>": 123 }` is a
 * thing a user can write. Twenty-two readers across nine files used to take
 * that value on trust; nine of them called `.toLowerCase()` on it and threw,
 * including three inside a hook that promises to exit 0 whatever it finds.
 *
 * The repair was one validated helper, not twenty-two guards — so the test
 * that proves it has to be shaped the same way. Three layers:
 *
 *   1. THE CONTRACT — what the helper itself does with each bad shape.
 *   2. THE CLASS SWEEP — every consumer surface, in a LOOP, against the same
 *      poisoned configs. One assertion per site would pass the day someone
 *      adds a twenty-third site and forgets to add its assertion; a loop over
 *      the surfaces at least fails loudly when a surface is removed, and the
 *      scan in layer 3 catches the one being added.
 *   3. THE SCAN — no file outside the helper may read `vaultNames[...]`, and
 *      no file may define a second `defaultNameFromPath`. This is the layer
 *      that makes the class stay swept: a new direct read fails this test on
 *      the commit that introduces it, rather than the day someone mistypes a
 *      config. It is the structural equivalent of `spellingsOf()` in
 *      helpers/auto-enrich-mode.mjs — the rule is proved FROM the tree rather
 *      than from a hand-maintained list beside it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  configuredVaultName,
  defaultNameFromPath,
  knownVaultSlugs,
  registeredVaultPaths,
  resolveVaultBySlug,
  vaultNamesOf,
  vaultSlug,
} from '../src/helpers/vault-slug.mjs';

import {
  defaultNameFromPath as hookDefaultNameFromPath,
  resolveVaultBySlug as hookResolveVaultBySlug,
} from '../hooks/_helpers/workspace-vault.mjs';
import { orderedVaultCandidates } from '../hooks/_helpers/doc-drift-detector.mjs';
import { existingSlugs } from '../scripts/vault-plan.mjs';
import { knownSlugs, resolveSlugToVaultPath } from '../scripts/setup-vault.mjs';
import { loadRegistry } from '../src/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HELPER_REL = 'src/helpers/vault-slug.mjs';
const LINTER_HOOK = path.resolve(ROOT, 'hooks', 'vault-link-linter.mjs');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
//
// Two real directories, because `orderedVaultCandidates` filters candidates
// through `fs.existsSync` and would silently drop a fixture that is only a
// string. ALPHA carries the poisoned name; BETA carries a good custom one, so
// every assertion also proves the repair did not break the feature it guards
// (a configured name must still win over the basename).

let workDir, ALPHA, BETA, cwdDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-slug-'));
  ALPHA = path.join(workDir, 'Alpha');
  BETA = path.join(workDir, 'Beta');
  cwdDir = path.join(workDir, 'workspace');
  for (const d of [ALPHA, BETA, cwdDir]) fs.mkdirSync(d, { recursive: true });
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A config whose ALPHA entry carries `bad`, and whose BETA entry is sane. */
const poisonedConfig = (bad) => ({
  portRegistry: { [ALPHA]: 27124, [BETA]: 27125 },
  vaultNames: { [ALPHA]: bad, [BETA]: 'beta-custom' },
});

/**
 * Every shape a hand-edited config can put where a name belongs.
 *
 * The `threw` column is what the PRE-FIX code did, and it is the reason the
 * list is not just `123`: the four falsy shapes never threw — `||` swallowed
 * them — so a test built only from the crashing ones would have left the
 * silent half of the class unproven, which is the half that wrote a bad slug
 * into a workspace `.env`.
 *
 * Each carries a DISTINCT witness string where a value could survive
 * coercion, so a mutation that swaps one branch for another is attributable to
 * that branch rather than absorbed by a shared marker.
 */
const POISON = [
  { label: 'a number', value: 123, threw: true },
  { label: 'a float', value: 27.5, threw: true },
  { label: 'true', value: true, threw: true },
  { label: 'an array of one name', value: ['alpha-from-array'], threw: true },
  { label: 'an object with a name field', value: { name: 'alpha-from-object' }, threw: true },
  { label: 'zero', value: 0, threw: false },
  { label: 'false', value: false, threw: false },
  { label: 'null', value: null, threw: false },
  { label: 'the empty string', value: '', threw: false },
];

// ---------------------------------------------------------------------------
// LAYER 1 — the contract
// ---------------------------------------------------------------------------

describe('defaultNameFromPath — the one surviving copy of six', () => {
  test('strips the leading dot and lowercases', () => {
    assert.equal(defaultNameFromPath('C:\\VAULTS\\.template'), 'template');
    assert.equal(defaultNameFromPath('C:\\VAULTS\\TradingView'), 'tradingview');
    assert.equal(defaultNameFromPath('/home/u/Recherche'), 'recherche');
  });

  test('reads a Windows path as a Windows path whatever the runtime is', () => {
    // The copy that used to live in doc-drift-detector.mjs called the RUNTIME's
    // path.basename, so on POSIX this returned the whole string as one name.
    assert.equal(defaultNameFromPath('C:/VAULTS/.template'), 'template');
    assert.equal(defaultNameFromPath('\\\\nas-01\\Vaults\\Wiki'), 'wiki');
  });

  test('returns the empty string rather than throwing on a non-string', () => {
    // registry.mjs's copy reached path.posix.basename(123) and threw a
    // TypeError here.
    for (const bad of [123, null, undefined, true, [], {}, '']) {
      assert.equal(defaultNameFromPath(bad), '', `defaultNameFromPath(${JSON.stringify(bad)})`);
    }
  });

  test('the hooks re-export is the SAME function, not a copy', () => {
    // The whole point of the collapse: if these two ever stop being identical,
    // a slug written by the CLI stops matching the slug a hook resolves.
    assert.equal(hookDefaultNameFromPath, defaultNameFromPath);
  });
});

describe('vaultNamesOf — the map is shape-checked, not just its values', () => {
  test('returns the map when it is a plain object', () => {
    const names = { 'C:\\VAULTS\\A': 'a' };
    assert.equal(vaultNamesOf({ vaultNames: names }), names);
  });

  test('refuses a non-object map', () => {
    // `cfg.vaultNames || {}` accepted every one of these and then indexed it.
    for (const bad of [undefined, null, 'notes', 42, true, ['notes']]) {
      assert.equal(vaultNamesOf({ vaultNames: bad }), null, `vaultNames: ${JSON.stringify(bad)}`);
    }
  });

  test('refuses a non-object config', () => {
    for (const bad of [null, undefined, 'cfg', 7]) assert.equal(vaultNamesOf(bad), null);
  });
});

describe('configuredVaultName — the validated lookup', () => {
  test('returns a configured name verbatim, case preserved', () => {
    // The real fleet carries `DEDIBOX` in uppercase and gen-remote-config
    // prints it; lowercasing here would rename a vault in its own report.
    const cfg = { vaultNames: { 'C:\\VAULTS\\D': 'DEDIBOX' } };
    assert.equal(configuredVaultName(cfg, 'C:\\VAULTS\\D'), 'DEDIBOX');
  });

  test('returns null for every unusable value', () => {
    for (const { label, value } of POISON) {
      assert.equal(
        configuredVaultName({ vaultNames: { p: value } }, 'p'),
        null,
        `${label} must read as "no override configured"`,
      );
    }
  });

  test('returns null for an absent key and a non-string path', () => {
    assert.equal(configuredVaultName({ vaultNames: { a: 'x' } }, 'b'), null);
    assert.equal(configuredVaultName({ vaultNames: { a: 'x' } }, 123), null);
  });

  test('does not walk the prototype chain', () => {
    // A bare {} from JSON.parse still carries Object.prototype, so an
    // unguarded read for these comes back a function.
    const cfg = { vaultNames: {} };
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(configuredVaultName(cfg, key), null, `vaultNames.${key} must not resolve`);
    }
  });

  test('a STRING on Object.prototype is not a configured name', () => {
    // This is the case that makes `Object.hasOwn` load-bearing rather than
    // decorative. The four keys above are all FUNCTIONS, so the `typeof`
    // check alone already refuses them — dropping `Object.hasOwn` leaves that
    // test green, which is how this one came to be written. A polluted
    // prototype carrying a string is the only shape that gets past `typeof`,
    // and it must still not name one of the user's vaults.
    //
    // Same guard, and the same reason, as MODE_ALIASES in
    // helpers/auto-enrich-mode.mjs.
    const key = 'evilVaultName';
    try {
      Object.defineProperty(Object.prototype, key, {
        value: 'stolen-slug',
        configurable: true,
        enumerable: false,
        writable: true,
      });
      assert.equal(configuredVaultName({ vaultNames: {} }, key), null);
      assert.equal(vaultSlug({ vaultNames: {} }, key), key.toLowerCase());
      assert.equal(
        resolveVaultBySlug({ portRegistry: { [key]: 1 }, vaultNames: {} }, 'stolen-slug'),
        null,
        'a polluted prototype must not make a vault answer to a name nobody configured',
      );
    } finally {
      delete Object.prototype[key];
    }
    assert.equal(Object.prototype[key], undefined, 'the fixture must not leak into other tests');
  });

  test('a value coming in through __proto__ is not a name either', () => {
    // JSON.parse gives `__proto__` as an OWN property rather than reassigning
    // the prototype, so `polluted` is not reachable at all — pinned so a
    // future switch to a hand-built fixture cannot make this silently true.
    const names = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    assert.equal(configuredVaultName({ vaultNames: names }, 'polluted'), null);
  });
});

describe('vaultSlug — always a string, so the callers .toLowerCase() safely', () => {
  test('the configured name wins over the basename', () => {
    assert.equal(vaultSlug({ vaultNames: { [BETA]: 'beta-custom' } }, BETA), 'beta-custom');
  });

  test('every unusable value falls back to the path, and NONE throws', () => {
    for (const { label, value } of POISON) {
      const cfg = poisonedConfig(value);
      let got;
      assert.doesNotThrow(() => { got = vaultSlug(cfg, ALPHA); }, `${label} threw`);
      assert.equal(got, 'alpha', `${label} must fall back to the basename`);
      assert.equal(typeof got, 'string', `${label} must still yield a string`);
    }
  });

  test('the value is never coerced — an array does not become its join', () => {
    // String(['alpha-from-array']) === 'alpha-from-array'. A String() repair
    // would have turned this typo into a real, resolvable vault name.
    const cfg = poisonedConfig(['alpha-from-array']);
    assert.equal(vaultSlug(cfg, ALPHA), 'alpha');
    assert.equal(resolveVaultBySlug(cfg, 'alpha-from-array'), null);
  });

  test('a number does not become its decimal spelling', () => {
    const cfg = poisonedConfig(123);
    assert.equal(vaultSlug(cfg, ALPHA), 'alpha');
    assert.equal(resolveVaultBySlug(cfg, '123'), null, '"123" must resolve to no vault at all');
  });
});

describe('registeredVaultPaths / knownVaultSlugs', () => {
  test('a non-object portRegistry enumerates to nothing', () => {
    for (const bad of [undefined, null, 'C:\\VAULTS\\A', 42, ['C:\\VAULTS\\A']]) {
      assert.deepEqual(registeredVaultPaths({ portRegistry: bad }), [], JSON.stringify(bad));
    }
  });

  test('knownVaultSlugs lists a fallback for the poisoned entry, in config order', () => {
    assert.deepEqual(knownVaultSlugs(poisonedConfig(123)), ['alpha', 'beta-custom']);
  });
});

describe('resolveVaultBySlug', () => {
  test('resolves by configured name and by basename, case-insensitively', () => {
    const cfg = poisonedConfig('alpha-custom');
    assert.equal(resolveVaultBySlug(cfg, 'ALPHA-Custom'), ALPHA);
    assert.equal(resolveVaultBySlug(cfg, '  beta-custom  '), BETA);
  });

  test('an overridden vault stops answering to its basename', () => {
    // Pinned because the fallback must NOT be an additional alias.
    assert.equal(resolveVaultBySlug(poisonedConfig('alpha-custom'), 'alpha'), null);
  });

  test('a blank or absent slug matches nothing', () => {
    const cfg = poisonedConfig(123);
    for (const s of ['', '   ', null, undefined, 0, false]) {
      assert.equal(resolveVaultBySlug(cfg, s), null, `slug ${JSON.stringify(s)}`);
    }
  });

  test('a blank slug matches nothing even when a registry key derives an empty one', () => {
    // The `if (!target) return null` guard only earns its place against a
    // registry that has a key deriving to the empty slug — otherwise no vault
    // could match a blank input anyway, and the guard would be untested code
    // that merely looks careful. A key of "" (or "/") is exactly that key.
    const degenerate = { portRegistry: { '': 27124, '/': 27125 }, vaultNames: {} };
    assert.equal(vaultSlug(degenerate, ''), '', 'the fixture must really derive an empty slug');
    for (const s of ['', '   ', '\t']) {
      assert.equal(
        resolveVaultBySlug(degenerate, s),
        null,
        `a blank slug must not silently select the degenerate registry key (${JSON.stringify(s)})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// LAYER 2 — the class sweep, as a loop over the consumer surfaces
// ---------------------------------------------------------------------------

/**
 * Every in-process surface that answers "what slug does ALPHA have?" — one
 * entry per exported entry point that used to derive the answer by hand.
 *
 * `slugOf` returns ALPHA's slug; `resolve` maps a slug back to a path. A
 * surface that does both appears once per capability, because the two used to
 * be two separate hand-written expressions.
 */
const SLUG_SURFACES = [
  {
    name: 'src/helpers/vault-slug.mjs · vaultSlug',
    slugOf: (cfg) => vaultSlug(cfg, ALPHA),
  },
  {
    name: 'src/helpers/vault-slug.mjs · knownVaultSlugs',
    slugOf: (cfg) => knownVaultSlugs(cfg)[0],
  },
  {
    name: 'scripts/setup-vault.mjs · knownSlugs',
    slugOf: (cfg) => knownSlugs(cfg)[0],
  },
  {
    name: 'scripts/vault-plan.mjs · existingSlugs',
    slugOf: (cfg) => [...existingSlugs(cfg)].find(([, vp]) => vp === ALPHA)?.[0],
  },
];

const RESOLVE_SURFACES = [
  {
    name: 'src/helpers/vault-slug.mjs · resolveVaultBySlug',
    resolve: (cfg, slug) => resolveVaultBySlug(cfg, slug),
  },
  {
    name: 'hooks/_helpers/workspace-vault.mjs · resolveVaultBySlug',
    resolve: (cfg, slug) => hookResolveVaultBySlug(cfg, slug),
  },
  {
    name: 'scripts/setup-vault.mjs · resolveSlugToVaultPath',
    resolve: (cfg, slug) => resolveSlugToVaultPath(cfg, slug),
  },
  {
    name: 'hooks/_helpers/doc-drift-detector.mjs · orderedVaultCandidates',
    resolve: (cfg, slug) => {
      // This one answers through the env var it was written to honor: the
      // workspace-bound vault is pushed first.
      const previous = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = slug;
      try {
        return orderedVaultCandidates(cwdDir, cfg)[0] ?? null;
      } finally {
        if (previous === undefined) delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
        else process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = previous;
      }
    },
  },
];

describe('CLASS SWEEP: no consumer surface trusts the vaultNames value', () => {
  for (const { label, value, threw } of POISON) {
    for (const surface of SLUG_SURFACES) {
      test(`${surface.name} survives ${label}`, () => {
        const cfg = poisonedConfig(value);
        let got;
        assert.doesNotThrow(
          () => { got = surface.slugOf(cfg); },
          `${surface.name} threw on ${label}${threw ? ' (it always did — that is the bug)' : ''}`,
        );
        assert.equal(got, 'alpha', `${surface.name} must fall back to the basename on ${label}`);
      });
    }

    for (const surface of RESOLVE_SURFACES) {
      test(`${surface.name} survives ${label}`, () => {
        const cfg = poisonedConfig(value);
        let got;
        assert.doesNotThrow(
          () => { got = surface.resolve(cfg, 'alpha'); },
          `${surface.name} threw on ${label}`,
        );
        assert.equal(got, ALPHA, `${surface.name} must resolve "alpha" to the poisoned vault`);
      });

      test(`${surface.name} still honors a GOOD name alongside ${label}`, () => {
        // The repair must not have flattened the feature: BETA's custom name
        // still wins over its basename even while ALPHA's is unreadable.
        const cfg = poisonedConfig(value);
        assert.equal(surface.resolve(cfg, 'beta-custom'), BETA);
      });
    }
  }
});

describe('CLASS SWEEP: the async and subprocess surfaces', () => {
  for (const { label, value } of POISON) {
    test(`src/registry.mjs · loadRegistry survives ${label}`, async () => {
      const cfgPath = path.join(workDir, `registry-${encodeURIComponent(label)}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify(poisonedConfig(value)));
      const registry = await loadRegistry({ configPath: cfgPath });
      const names = [...registry.vaults, ...(registry.skipped ?? [])].map((v) => v.name);
      assert.ok(names.includes('alpha'), `loadRegistry named the poisoned vault ${JSON.stringify(names)}`);
      assert.ok(names.includes('beta-custom'), 'the good custom name must still be honored');
    });
  }

  test('hooks/vault-link-linter.mjs exits 0 on a poisoned config', () => {
    // The headline promise: a hook exits 0 whatever the config says. Before
    // the fix this hook read the value raw at four sites.
    const cfgPath = path.join(workDir, 'linter-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(poisonedConfig(123)));
    const transcript = path.join(workDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n',
    );

    const res = spawnSync(process.execPath, [LINTER_HOOK], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath },
    });

    assert.equal(res.status, 0, `linter exited ${res.status}: ${res.stderr}`);
    assert.ok(
      !/TypeError|toLowerCase/.test(res.stderr || ''),
      `linter leaked a type error: ${res.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// LAYER 3 — the scan that keeps the class swept
// ---------------------------------------------------------------------------

const SCAN_DIRS = ['src', 'hooks', 'scripts', 'bin'];

function scannedFiles() {
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else if (e.name.endsWith('.mjs')) out.push({ rel: relPath, abs });
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), d);
  return out;
}

/**
 * Lines that are prose, not code. Deliberately crude — it only has to skip the
 * doc comments that legitimately QUOTE the old expression, and every one of
 * those sits on a line whose first non-space character opens or continues a
 * comment. A code line that also happens to carry a trailing `//` comment is
 * still scanned, which is the safe direction to be wrong in.
 */
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('SCAN: the class cannot be re-opened quietly', () => {
  test('no file outside the helper READS vaultNames directly', () => {
    const offenders = [];
    for (const { rel, abs } of scannedFiles()) {
      if (rel === HELPER_REL) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!/vaultNames\s*(\?\.)?\s*\[/.test(line)) return;
        // An ASSIGNMENT into the map is a writer, not a reader — setup-vault's
        // `--name` handler is the only one, and it writes a lowercased string.
        if (/vaultNames\s*(\?\.)?\s*\[[^\]]*\]\s*=[^=]/.test(line)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `these read config.vaultNames without the boundary check — route them through ${HELPER_REL}:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('exactly one definition of defaultNameFromPath exists, and it is the helper', () => {
    const definers = [];
    for (const { rel, abs } of scannedFiles()) {
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line) => {
        if (isCommentLine(line)) return;
        if (/(function\s+defaultNameFromPath\s*\(|defaultNameFromPath\s*=\s*(\(|function))/.test(line)) {
          definers.push(rel);
        }
      });
    }
    assert.deepEqual(
      definers,
      [HELPER_REL],
      `defaultNameFromPath had six copies before v0.90.0; found: ${definers.join(', ')}`,
    );
  });

  test('the helper reaches nothing that needs node_modules', () => {
    // Hooks are expected to run on a checkout with no install at all, and this
    // module is on their start-up path. Same contract as auto-enrich-mode.mjs.
    const src = fs.readFileSync(path.join(ROOT, HELPER_REL), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `${HELPER_REL} imports "${spec}" — a bare specifier needs node_modules`,
      );
    }
    // And its one local import must be dependency-free for the same reason.
    for (const spec of imports.filter((s) => s.startsWith('.'))) {
      const dep = fs.readFileSync(path.resolve(ROOT, 'src/helpers', spec), 'utf8');
      const nested = [...dep.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      for (const n of nested) {
        assert.ok(n.startsWith('node:'), `${spec} imports "${n}" — the start-up path must stay builtin-only`);
      }
    }
  });
});
