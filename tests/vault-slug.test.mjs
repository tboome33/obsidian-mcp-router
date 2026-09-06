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
  configuredDefaultVault,
  configuredVaultName,
  defaultNameFromPath,
  disabledVaultEntries,
  knownVaultSlugs,
  referenceVaultPath,
  registeredVaultPaths,
  resolveVaultBySlug,
  vaultNamesOf,
  vaultSlug,
  vaultsRootPath,
  vaultReachMode,
  openVaultEntries,
  alsoWritableEntries,
  alsoLockedEntries,
} from '../src/helpers/vault-slug.mjs';

import {
  defaultNameFromPath as hookDefaultNameFromPath,
  resolveVaultBySlug as hookResolveVaultBySlug,
} from '../hooks/_helpers/workspace-vault.mjs';
import { orderedVaultCandidates } from '../hooks/_helpers/doc-drift-detector.mjs';
import { existingSlugs, knownVaultRoots, resolveSourceVault } from '../scripts/vault-plan.mjs';
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

describe('resolveVaultBySlug — an exact name resolves to ITS OWN vault', () => {
  // Codex, round on the Phase 6 commit: with two vaults whose names differ
  // only in case, this resolver lowercased both sides and returned the FIRST
  // hit. So a hook that had just checked `NOTES` against the server's exact
  // rule — registered, and permitted by the whitelist — resolved it to the
  // PATH of `notes`, the vault the server excludes, and journalling,
  // autocommit and recall wrote there. Making the membership check exact was
  // not enough while the resolution behind it was not.
  const A = 'C:\\VAULTS\\A';
  const B = 'C:\\VAULTS\\B';
  const cfg = { portRegistry: { [A]: 27124, [B]: 27125 }, vaultNames: { [A]: 'notes', [B]: 'NOTES' } };

  test('the exact spelling wins over an earlier case-folded one', () => {
    assert.equal(resolveVaultBySlug(cfg, 'NOTES'), B);
    assert.equal(resolveVaultBySlug(cfg, 'notes'), A);
  });

  test('a spelling that matches neither exactly is refused when it is ambiguous', () => {
    // `Notes` folds onto BOTH: answering either would be a guess, and a guess
    // here is the wrong vault written into.
    assert.equal(resolveVaultBySlug(cfg, 'Notes'), null);
  });

  test('the case-insensitive convenience survives where it is unambiguous', () => {
    // The command line is a real caller: `--attach WORK` for a vault named
    // `work` must keep working when nothing else folds onto it.
    const one = { portRegistry: { [A]: 27124 }, vaultNames: { [A]: 'work' } };
    assert.equal(resolveVaultBySlug(one, 'WORK'), A);
    assert.equal(resolveVaultBySlug(one, ' work '), A, 'surrounding whitespace is still trimmed');
    assert.equal(resolveVaultBySlug(one, 'ghost'), null);
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
// THE SIBLING KEYS — defaultVault, disabledVaults, referenceVault, vaultsRoot
// ---------------------------------------------------------------------------
//
// `vaultNames` was the first key of this class to be swept, not the only one.
// Everything below is the same shape of test for the other four.

/** A config whose `defaultVault` carries `bad` and whose registry is sane. */
const badDefaultVault = (bad) => ({
  portRegistry: { [ALPHA]: 27124, [BETA]: 27125 },
  vaultNames: { [BETA]: 'beta-custom' },
  defaultVault: bad,
});

describe('configuredDefaultVault — the config default, validated', () => {
  test('returns a usable slug verbatim', () => {
    assert.equal(configuredDefaultVault({ defaultVault: 'DEDIBOX' }), 'DEDIBOX');
  });

  test('returns null for every unusable value', () => {
    for (const { label, value } of POISON) {
      assert.equal(configuredDefaultVault({ defaultVault: value }), null, label);
    }
    assert.equal(configuredDefaultVault({}), null, 'absent key');
    assert.equal(configuredDefaultVault(null), null, 'absent config');
  });
});

describe('disabledVaultEntries — the CONTAINER is the dangerous part', () => {
  test('returns the listed entries unchanged', () => {
    assert.deepEqual(disabledVaultEntries({ disabledVaults: ['template', 'C:\\VAULTS\\X'] }),
      ['template', 'C:\\VAULTS\\X']);
  });

  test('A BARE STRING is refused, not iterated into characters', () => {
    // The headline of this half of the lot, and the only defect in it that was
    // SILENT rather than a crash. `"disabledVaults": "template"` is the most
    // plausible hand-edit there is, a string IS iterable, and
    // `new Set("template")` is {t,e,m,p,l,a} — so a fleet with a
    // one-character vault slug had that vault disabled by a line naming a
    // different one. Measured before it was fixed; pinned here.
    assert.deepEqual(disabledVaultEntries({ disabledVaults: 'template' }), []);
    const asSet = new Set(disabledVaultEntries({ disabledVaults: 'template' }));
    assert.equal(asSet.has('t'), false, 'a single character must not become a disabled vault');
    assert.equal(asSet.has('template'), false);
  });

  test('every non-array container yields the empty list', () => {
    for (const bad of [123, true, null, undefined, '', 'template', { 0: 'template' }]) {
      assert.deepEqual(disabledVaultEntries({ disabledVaults: bad }), [], JSON.stringify(bad));
    }
  });

  test('non-string ELEMENTS are dropped, never coerced', () => {
    // `String(s).toLowerCase()` used to turn 123 into the name "123" — and a
    // vault whose folder is called `123` has exactly that slug, so the
    // coercion could disable a real vault on the strength of a typo.
    assert.deepEqual(
      disabledVaultEntries({ disabledVaults: ['keep', 123, null, '', true, ['x'], { a: 1 }, 'also-keep'] }),
      ['keep', 'also-keep'],
    );
  });

  test('always an array, so a caller may iterate without a guard', () => {
    for (const cfg of [null, undefined, {}, { disabledVaults: 7 }]) {
      assert.ok(Array.isArray(disabledVaultEntries(cfg)), JSON.stringify(cfg));
    }
  });
});

describe('vaultReachMode — a closed vocabulary, not a boolean', () => {
  test('"declared" is the only value that means anything', () => {
    assert.equal(vaultReachMode({ vaultReach: 'declared' }), 'declared');
  });

  test('anything else falls back to null — today\'s unchanged behaviour', () => {
    for (const cfg of [
      {}, { vaultReach: true }, { vaultReach: 'Declared' }, { vaultReach: 'open' },
      { vaultReach: null }, { vaultReach: 1 }, null, undefined,
    ]) {
      assert.equal(vaultReachMode(cfg), null, JSON.stringify(cfg));
    }
  });
});

describe('openVaultEntries / alsoWritableEntries / alsoLockedEntries — same container guard as disabledVaultEntries', () => {
  for (const [fn, key] of [
    [openVaultEntries, 'openVaults'],
    [alsoWritableEntries, 'alsoWritable'],
    [alsoLockedEntries, 'alsoLocked'],
  ]) {
    test(`${fn.name}: returns the listed entries unchanged`, () => {
      assert.deepEqual(fn({ [key]: ['roland', 'notes'] }), ['roland', 'notes']);
    });

    test(`${fn.name}: a BARE STRING is refused, not iterated into characters`, () => {
      assert.deepEqual(fn({ [key]: 'roland' }), []);
    });

    test(`${fn.name}: non-array containers yield the empty list`, () => {
      for (const bad of [123, true, null, undefined, '', 'roland', { 0: 'roland' }]) {
        assert.deepEqual(fn({ [key]: bad }), [], JSON.stringify(bad));
      }
    });

    test(`${fn.name}: non-string elements are dropped, not coerced`, () => {
      assert.deepEqual(fn({ [key]: ['keep', 123, null, '', true, ['x'], { a: 1 }, 'also-keep'] }),
        ['keep', 'also-keep']);
    });

    test(`${fn.name}: always an array`, () => {
      for (const cfg of [null, undefined, {}, { [key]: 7 }]) {
        assert.ok(Array.isArray(fn(cfg)), JSON.stringify(cfg));
      }
    });
  }
});

describe('referenceVaultPath / vaultsRootPath', () => {
  test('return a configured path verbatim', () => {
    assert.equal(referenceVaultPath({ referenceVault: 'C:\\VAULTS\\.template' }), 'C:\\VAULTS\\.template');
    assert.equal(vaultsRootPath({ vaultsRoot: 'C:\\VAULTS' }), 'C:\\VAULTS');
  });

  test('return null for every unusable value', () => {
    for (const { label, value } of POISON) {
      assert.equal(referenceVaultPath({ referenceVault: value }), null, `referenceVault ${label}`);
      assert.equal(vaultsRootPath({ vaultsRoot: value }), null, `vaultsRoot ${label}`);
    }
  });

  test('the null they return is what keeps path.join and samePath from throwing', () => {
    // Measured with a probe rather than assumed: fs.existsSync(123) returns
    // false (so the readers guarded by it always failed closed), but
    // path.join(123, …), path.resolve(123) and samePath(123, …) all throw a
    // TypeError. Three readers reached the throwing kind.
    assert.throws(() => path.join(referenceVaultPath({ referenceVault: 'ok' }), 'x') && path.join(123, 'x'));
    assert.equal(fs.existsSync(123), false, 'existsSync fails closed — the reason two readers were safe');
  });
});

describe('CLASS SWEEP: the sibling keys, across every consumer surface', () => {
  for (const { label, value } of POISON) {
    test(`doc-drift-detector orderedVaultCandidates survives defaultVault = ${label}`, () => {
      // The live crash this lot exists for: `(cfg.defaultVault || '').toLowerCase()`.
      // A non-string is TRUTHY, so `||` never caught it, and the TypeError came
      // out of a function two hooks call — both of which must exit 0.
      let got;
      assert.doesNotThrow(() => { got = orderedVaultCandidates(cwdDir, badDefaultVault(value)); });
      assert.ok(Array.isArray(got), 'must still return the candidate list');
      assert.ok(got.includes(ALPHA) && got.includes(BETA), 'both vaults still reachable');
    });

    test(`doc-drift-detector orderedVaultCandidates survives disabledVaults = ${label}`, () => {
      const cfg = { portRegistry: { [ALPHA]: 27124, [BETA]: 27125 }, disabledVaults: value };
      let got;
      assert.doesNotThrow(() => { got = orderedVaultCandidates(cwdDir, cfg); });
      assert.ok(got.includes(ALPHA), 'an unreadable disable list must disable nothing');
    });

    test(`vault-plan knownVaultRoots survives referenceVault/vaultsRoot = ${label}`, () => {
      const cfg = { portRegistry: { [ALPHA]: 27124 }, referenceVault: value, vaultsRoot: value };
      let got;
      assert.doesNotThrow(() => { got = knownVaultRoots(cfg); });
      assert.deepEqual(got, [path.dirname(path.resolve(ALPHA))],
        'an unreadable root must widen the provision gate by nothing');
    });

    test(`vault-plan resolveSourceVault survives referenceVault = ${label}`, () => {
      let got;
      assert.doesNotThrow(() => { got = resolveSourceVault({ source: 'reference' }, { referenceVault: value }); });
      assert.equal(got.sourceVault, null, 'an unreadable reference vault is no reference vault');
    });
  }

  for (const { label, value } of POISON) {
    test(`registry loadRegistry survives disabledVaults = ${label}`, async () => {
      const cfgPath = path.join(workDir, `dis-${encodeURIComponent(label)}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify({
        portRegistry: { [ALPHA]: 27124, [BETA]: 27125 },
        vaultNames: { [BETA]: 'beta-custom' },
        disabledVaults: value,
      }));
      const registry = await loadRegistry({ configPath: cfgPath });
      const names = registry.vaults.map((v) => v.name);
      assert.ok(names.includes('alpha') && names.includes('beta-custom'),
        `an unreadable disable list must hide no vault — got ${JSON.stringify(names)}`);
    });

    test(`registry loadRegistry survives defaultVault = ${label}`, async () => {
      const cfgPath = path.join(workDir, `def-${encodeURIComponent(label)}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify(badDefaultVault(value)));
      const previous = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      try {
        const registry = await loadRegistry({ configPath: cfgPath });
        assert.notEqual(registry.defaultVault, value,
          'the raw config value must never become the resolved default');
        assert.ok(
          registry.defaultVault === undefined || typeof registry.defaultVault === 'string',
          'the resolved default is a name or nothing, never the config junk',
        );
      } finally {
        if (previous !== undefined) process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = previous;
      }
    });
  }

  test('a bare-string disabledVaults disables NOTHING, end to end through the registry', async () => {
    // The silent case, proved at the surface a user would actually meet. ALPHA
    // is one character away from nothing, so this uses a real single-character
    // slug to make the old behaviour visible: a set of characters built from
    // "alpha" contains "a".
    const single = path.join(workDir, 'a');
    fs.mkdirSync(single, { recursive: true });
    const cfgPath = path.join(workDir, 'bare-string-disabled.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      portRegistry: { [single]: 27130, [ALPHA]: 27131 },
      disabledVaults: 'alpha',
    }));
    const registry = await loadRegistry({ configPath: cfgPath });
    const names = registry.vaults.map((v) => v.name);
    assert.ok(names.includes('a'), `the one-character vault must NOT be disabled — got ${JSON.stringify(names)}`);
    assert.ok(names.includes('alpha'), 'and neither must the vault the line meant to name');
  });

  test('hooks/vault-link-linter.mjs exits 0 on a poisoned defaultVault + disabledVaults', () => {
    const cfgPath = path.join(workDir, 'linter-siblings.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      portRegistry: { [ALPHA]: 27124 },
      defaultVault: 123,
      disabledVaults: 'alpha',
      referenceVault: 456,
    }));
    const transcript = path.join(workDir, 'transcript-siblings.jsonl');
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
    assert.ok(!/TypeError/.test(res.stderr || ''), `linter leaked a type error: ${res.stderr}`);
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

/**
 * The one line in the tree that mentions a config key in PROSE rather than
 * reading it: the router binary's `--help` text, inside a template literal.
 * Keyed by file + exact trimmed content, so it survives edits above it and
 * fails loudly if the sentence itself changes.
 */
const PROSE_EXEMPTIONS = new Set([
  'bin/obsidian-mcp-router.mjs|and over config.defaultVault.',
]);

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

  test('no file outside the helper READS the sibling config keys directly', () => {
    // Same rule as the `vaultNames` scan above, for the four keys swept beside
    // it. The discriminator is the RECEIVER, and it is a real distinction
    // rather than a convenience:
    //
    //   cfg.defaultVault / config.defaultVault  — the config's raw word. Guarded.
    //   registry.defaultVault / this.defaultVault / reg.* / result.*
    //                                           — the RESOLVED name, which is
    //     the output of `resolveDefaultVaultWithSource` and only ever a name
    //     that passed `isActive`. The registry is itself a boundary for this
    //     key, which is exactly why the six readers downstream of it were
    //     never at risk while the two hooks — which parse config.json
    //     themselves — were.
    // v0.90.0 — vaultReach/openVaults/alsoWritable/alsoLocked (decision
    // portee-et-mode-ecriture-des-vaults) swept into the SAME class the day
    // they were added, rather than left to become the 23rd unguarded site.
    const KEYS = [
      'defaultVault', 'disabledVaults', 'referenceVault', 'vaultsRoot',
      'vaultReach', 'openVaults', 'alsoWritable', 'alsoLocked',
    ];
    const RAW_RECEIVER = /\b(cfg|config|conf)\s*(\?\.)?\s*\.\s*(defaultVault|disabledVaults|referenceVault|vaultsRoot|vaultReach|openVaults|alsoWritable|alsoLocked)\b/;
    const offenders = [];
    for (const { rel, abs } of scannedFiles()) {
      if (rel === HELPER_REL) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!RAW_RECEIVER.test(line)) return;
        // An ASSIGNMENT is a writer, not a reader: `setup-vault --bootstrap-
        // reference` records the path, and `remote-config.mjs` builds a config
        // of its own rather than reading the user's.
        if (new RegExp(`(${KEYS.join('|')})\\s*=[^=]`).test(line)) return;
        // PROSE inside a template literal is not a read, and there is exactly
        // one: the --help text below. It is exempted BY ITS CONTENT, not by a
        // heuristic.
        //
        // The first version of this test used a heuristic instead — "a line
        // carrying a real property access also carries code punctuation; a
        // sentence carries none" — and a mutation walked straight through it:
        //
        //     const disabled = new Set(
        //       cfg.disabledVaults          // ← no punctuation on this line
        //       || []
        //     );
        //
        // 211/211 green with that read reinstated. An exemption list of one
        // known string cannot have that hole. If the help text is reworded this
        // test fails and the line below is updated, which is the right amount
        // of friction for a scan that is the only net under four CLI surfaces.
        if (PROSE_EXEMPTIONS.has(`${rel}|${line.trim()}`)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `these read a hand-editable config key without the boundary check — route them through ${HELPER_REL}:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('no file outside the helper ENUMERATES portRegistry directly', () => {
    // THE CONTAINER, and the sixth key of the class. `Object.keys(cfg.portRegistry
    // || {})` accepts anything truthy, and `Object.keys` on a string yields
    // index keys — so a hand-edited `"portRegistry": "AB"` manufactured the
    // vault PATHS "0" and "1". `src/registry.mjs` was fixed for that during the
    // merge review; the fix reached its first site and stopped. Ten other
    // files still enumerated the raw container — the link linter, the drift
    // detector, the hot-cache prompt, `setup-vault --status`, the backfill
    // script and the bridge fleet updater — so the SERVER saw no vaults while
    // those invented two, which is cross-hook divergence read off one file.
    // Found in the final review, 2026-09-03; this scan is what stops the
    // seventh site being written next month.
    //
    // The exemption is by RECEIVER, like the sibling-key scan: indexing the
    // container with keys the helper has already validated
    // (`config.portRegistry[vp]` inside a loop over `registeredVaultPaths`) is
    // safe by construction and is how both the registry and `--status` read
    // their values.
    // THE SCAN IS ON THE ACCESS, NOT ON THE ENUMERATION CALL. The first
    // version matched `Object.keys(cfg.portRegistry` and nothing else, so six
    // of eight rewrites walked straight through it — measured, not guessed:
    // `cfg?.portRegistry`, `config['portRegistry']`, an alias
    // (`const pr = cfg.portRegistry`), a destructure
    // (`const { portRegistry } = cfg`), `for (const k in cfg.portRegistry)`,
    // and `Reflect.ownKeys(...)`. A guard that only refuses the spelling
    // somebody happened to use last time is the "blind rather than red" shape
    // this repository keeps producing, and this one is the ONLY net under
    // eleven files. (Codex, round 5.)
    //
    // So: any read of the raw `portRegistry` off a config-shaped receiver is
    // refused, in dot form, bracket form or by destructuring. The ONE
    // legitimate read — indexing the container with keys the helper has
    // already validated — is exempted by its shape (`[vp]`, `[vaultPath]`,
    // `[p]`), which is what both `src/registry.mjs` and `--status` write.
    // THE ACCESSOR IS `.` OR `?.`, NOT `?.` FOLLOWED BY `.`. The first attempt
    // at this hardening wrote the optional part as `(\?\.)?` and then required
    // a dot after it, so `cfg?.portRegistry` still walked through — the very
    // shape Codex had just named. A mutation caught it; reading the regex
    // twice had not. A guard is only as good as the mutation that proved it.
    const RECEIVER = String.raw`(cfg|config|conf)`;
    const DOT = new RegExp(String.raw`\b${RECEIVER}\s*(\?\.|\.)\s*portRegistry\b`);
    const BRACKET = new RegExp(String.raw`\b${RECEIVER}\s*(\?\.)?\s*\[\s*['"\`]portRegistry['"\`]\s*\]`);
    const DESTRUCTURE = /\{[^}]*\bportRegistry\b[^}]*\}\s*=\s*(cfg|config|conf)\b/;
    // `x.portRegistry[<identifier>]` — reading ONE entry by a key that came
    // from somewhere else. Safe by construction and used by the registry.
    const INDEXED_BY_KEY = /\.\s*portRegistry\s*\[\s*[A-Za-z_$][\w$]*\s*\]/;
    const offenders = [];
    for (const { rel, abs } of scannedFiles()) {
      if (rel === HELPER_REL) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!DOT.test(line) && !BRACKET.test(line) && !DESTRUCTURE.test(line)) return;
        if (INDEXED_BY_KEY.test(line)) return;
        // An ASSIGNMENT into the container is a WRITER, not a reader — the
        // same distinction the `vaultNames` scan makes, and for the same
        // reason: `setup-vault` records a freshly provisioned vault's ports,
        // and a validated read has nothing to say about that.
        if (/\bportRegistry\s*=[^=]/.test(line)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `these enumerate config.portRegistry without the container check — use registeredVaultPaths from ${HELPER_REL}:\n  ${offenders.join('\n  ')}`,
    );

    // AND THE SCAN IS TESTED AGAINST ITS OWN BLIND SPOTS. A source scan that
    // is never run on the shapes it claims to refuse is a guard nobody has
    // checked: the first version of this one matched exactly one spelling and
    // walked past six others, measured. These are the rewrites somebody would
    // reach for, and each must be caught.
    const catches = (line) => (DOT.test(line) || BRACKET.test(line) || DESTRUCTURE.test(line))
      && !INDEXED_BY_KEY.test(line) && !/\bportRegistry\s*=[^=]/.test(line);
    for (const line of [
      'const a = Object.keys(cfg.portRegistry || {});',
      'const a = Object.keys(cfg?.portRegistry || {});',
      "const a = Object.keys(config['portRegistry']);",
      'const pr = cfg.portRegistry;',
      'const { portRegistry } = cfg;',
      'for (const k in cfg.portRegistry) {',
      'Reflect.ownKeys(conf.portRegistry)',
      'const n = Object.values(config.portRegistry).length;',
    ]) {
      assert.equal(catches(line), true, `the scan must refuse: ${line}`);
    }
    // And it must NOT refuse the one legitimate read: indexing the container
    // with a key the helper already validated.
    for (const line of [
      'const v = config.portRegistry[vaultPath];',
      'registeredVaultPaths(cfg).map((vp) => [vp, cfg.portRegistry[vp]])',
      'cfg.portRegistry = portRegistry;',
    ]) {
      assert.equal(catches(line), false, `the scan must allow: ${line}`);
    }
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
