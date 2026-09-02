/**
 * v0.88.0 — WHERE a session setting came from.
 *
 * The accepted decision `liaison-workspace-vault-hors-depot` (2026-09-02)
 * starts with a lot that can ship alone: `list_vaults` says whether the
 * default vault, the lock and the auto-enrichment mode were chosen by the
 * HOST, by a tool call in this session, or by the `.env` of the current
 * workspace — which is very often a cloned repository whose file the user
 * never wrote. v0.87.0 closed the security half (such a file can only ever
 * name a vault the user already registered, and no endpoint at all); what
 * remains is consent, and consent needs a source.
 *
 * The property under test, in one sentence: no setting is reported as coming
 * from a place that did not actually produce it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyWorkspaceDotenv,
  envKeyOrigin,
  envKeySourceFile,
  appliedWorkspaceDotenvKeys,
  workspaceDotenvWasConsulted,
  _resetWorkspaceDotenvProvenance,
  ENV_ORIGINS,
} from '../src/helpers/workspace-dotenv.mjs';
import { _internals } from '../src/registry.mjs';
import { envSettingSource } from '../src/index.mjs';
import { listVaults, SETTING_ORIGINS } from '../src/tools/list-vaults.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';

const { resolveDefaultVaultWithSource, resolveDefaultVault } = _internals;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** A throwaway workspace carrying a dotenv file. */
function tmpWorkspace(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
  fs.writeFileSync(path.join(dir, '.env'), content);
  return dir;
}

/**
 * Look for a workspace file where there is none. That is a CONSULTATION: from
 * then on "no record for this key" means "the file did not set it", which is
 * what makes `host` an observation rather than an assumption.
 */
function consultAnEmptyWorkspace(env = process.env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-empty-'));
  applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
}

const TOUCHED = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'VAULT_PATH', 'OBSIDIAN_ROUTER_LOCKED', 'OBSIDIAN_ROUTER_AUTO_ENRICH'];
const saved = {};

before(() => { for (const k of TOUCHED) saved[k] = process.env[k]; });
after(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetWorkspaceDotenvProvenance();
});

/** Run `fn` with the named variables set on the REAL process.env, restored after. */
function withProcessEnv(overrides, fn) {
  const before = {};
  for (const k of Object.keys(overrides)) {
    before[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

describe('envKeyOrigin — what this process took from a workspace file', () => {
  test('THE PRECONDITION: before any file has been looked for, every answer is "unknown" — never "host"', () => {
    _resetWorkspaceDotenvProvenance();
    assert.equal(workspaceDotenvWasConsulted(), false);
    // An entry point that never loads a workspace file (startServer imported
    // straight into a test, say) knows nothing about where a variable came
    // from. Saying "host" there would be an assumption dressed as a fact.
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'notes' }), ENV_ORIGINS.UNKNOWN);
    // Looking and finding nothing IS an observation: the environment is the host's.
    consultAnEmptyWorkspace();
    assert.equal(workspaceDotenvWasConsulted(), true);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'notes' }), ENV_ORIGINS.HOST);
  });

  test('a key the file never set is the host\'s; one the file applied is the workspace\'s; a value changed since is this session\'s', () => {
    _resetWorkspaceDotenvProvenance();
    const env = {};
    consultAnEmptyWorkspace(env);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), ENV_ORIGINS.HOST, 'looked for, not found');

    const dir = tmpWorkspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\nOBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_AUTO_ENRICH']);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), ENV_ORIGINS.WORKSPACE_DOTENV);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.WORKSPACE_DOTENV);
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT'), path.join(dir, '.env'));
    assert.deepEqual(appliedWorkspaceDotenvKeys(), ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_AUTO_ENRICH']);

    // The value moved since the file was read — only this process can do that.
    env.OBSIDIAN_ROUTER_AUTO_ENRICH = 'Hybrid';
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.RUNTIME);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), ENV_ORIGINS.WORKSPACE_DOTENV, 'the other key is untouched');
  });

  test('THE POINT: a key the PARENT already carried is the host\'s, even when the file names it too', () => {
    _resetWorkspaceDotenvProvenance();
    // The parent always wins in applyWorkspaceDotenv; the provenance must
    // agree with that, or the router would blame a file for the host's choice.
    const env = { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'from-the-host' };
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=from-the-repo\n');
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    assert.deepEqual(r.applied, []);
    assert.equal(env.OBSIDIAN_ROUTER_DEFAULT_VAULT, 'from-the-host');
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), ENV_ORIGINS.HOST);
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT'), null);
  });

  test('a record made against ANOTHER environment object answers "unknown", never a guess', () => {
    _resetWorkspaceDotenvProvenance();
    // The public signature takes an `env`, so two calls in one process can
    // target two different objects. A record made against one says nothing
    // about the other — and `envKeyOrigin` defaults to process.env, so the
    // mismatch is reachable without anyone doing anything exotic.
    const applied = {};
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_LOCKED=notes\n');
    applyWorkspaceDotenv({ cwd: dir, env: applied, warn: () => {} });
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', applied), ENV_ORIGINS.WORKSPACE_DOTENV);
    // Same key, same value, a different object: the record does not describe it.
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', { OBSIDIAN_ROUTER_LOCKED: 'notes' }), ENV_ORIGINS.UNKNOWN);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_LOCKED', {}), ENV_ORIGINS.UNKNOWN);
  });

  test('a withheld sandbox key is not recorded as applied — it never took effect', () => {
    _resetWorkspaceDotenvProvenance();
    const env = { MD_SHARE_DIR: '/srv/a' };
    const dir = tmpWorkspace('MD_ALLOWED_PATHS=/\n');
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    assert.deepEqual(r.withheld, ['MD_ALLOWED_PATHS']);
    assert.deepEqual(appliedWorkspaceDotenvKeys(), []);
    assert.equal(envKeyOrigin('MD_ALLOWED_PATHS', env), ENV_ORIGINS.HOST);
  });
});

describe('envSettingSource — a variable that was REJECTED is not reported as the source', () => {
  test('no effective value → the caller\'s word for "nothing set this"; a value → the variable and its origin', () => {
    _resetWorkspaceDotenvProvenance();
    consultAnEmptyWorkspace();
    assert.deepEqual(envSettingSource(null, 'OBSIDIAN_ROUTER_LOCKED'), { origin: 'unset', variable: null });
    assert.deepEqual(envSettingSource(undefined, 'OBSIDIAN_ROUTER_AUTO_ENRICH', 'default'), { origin: 'default', variable: null });
    assert.deepEqual(envSettingSource('notes', 'OBSIDIAN_ROUTER_LOCKED'), { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' });
  });
});

describe('resolveDefaultVaultWithSource — which tier of the cascade answered', () => {
  const vaults = [
    { name: 'alpha', type: 'local', path: '/v/alpha' },
    { name: 'beta', type: 'local', path: '/v/beta' },
  ];

  test('tier 1, the explicit override: workspace-dotenv when the file set it, host when the host did', () => {
    _resetWorkspaceDotenvProvenance();
    consultAnEmptyWorkspace();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: 'beta', VAULT_PATH: undefined }, () => {
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults, configuredDefault: 'alpha' }),
        { name: 'beta', origin: 'host', variable: 'OBSIDIAN_ROUTER_DEFAULT_VAULT' },
      );
    });

    // Now the same value, but applied by the loader from a repository's file.
    _resetWorkspaceDotenvProvenance();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: undefined, VAULT_PATH: undefined }, () => {
      const dir = tmpWorkspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=beta\n');
      applyWorkspaceDotenv({ cwd: dir, env: process.env, warn: () => {} });
      try {
        assert.deepEqual(
          resolveDefaultVaultWithSource({ vaults, configuredDefault: 'alpha' }),
          { name: 'beta', origin: 'workspace-dotenv', variable: 'OBSIDIAN_ROUTER_DEFAULT_VAULT' },
        );
      } finally {
        delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
      }
    });
  });

  test('tier 2 names VAULT_PATH, not the override — the variable reported is the one that answered', () => {
    _resetWorkspaceDotenvProvenance();
    consultAnEmptyWorkspace();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: undefined, VAULT_PATH: '/v/beta' }, () => {
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults, configuredDefault: undefined }),
        { name: 'beta', origin: 'host', variable: 'VAULT_PATH' },
      );
    });
  });

  test('an override naming an unknown vault falls through, and the SOURCE is the tier that actually answered', () => {
    _resetWorkspaceDotenvProvenance();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: 'ghost', VAULT_PATH: undefined }, () => {
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults, configuredDefault: 'alpha' }),
        { name: 'alpha', origin: 'config', variable: null },
        'a rejected override must not be reported as the source of what replaced it',
      );
    });
  });

  test('tiers 3 to 5, and an empty registry', () => {
    _resetWorkspaceDotenvProvenance();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: undefined, VAULT_PATH: undefined }, () => {
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults, configuredDefault: 'beta' }),
        { name: 'beta', origin: 'config', variable: null },
      );
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults, configuredDefault: undefined }),
        { name: 'alpha', origin: 'first-healthy', variable: null },
      );
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults: [{ name: 'r', type: 'remote' }], configuredDefault: undefined }),
        { name: 'r', origin: 'first-active', variable: null },
      );
      assert.deepEqual(
        resolveDefaultVaultWithSource({ vaults: [], configuredDefault: undefined }),
        { name: undefined, origin: 'unset', variable: null },
      );
      // Tier 5 returns the first entry's name VERBATIM, as the name-only
      // function always did (`vaults[0]?.name`). A falsy-but-present name must
      // not collapse to undefined: the two functions have to agree for every
      // input, not just the realistic ones.
      for (const odd of ['', null, undefined]) {
        const only = [{ name: odd, type: 'remote' }];
        assert.equal(resolveDefaultVaultWithSource({ vaults: only, configuredDefault: undefined }).name, odd, JSON.stringify(odd));
        assert.equal(resolveDefaultVault({ vaults: only, configuredDefault: undefined }), odd, `name-only, ${JSON.stringify(odd)}`);
      }
    });
  });

  test('the name-only cascade is unchanged — a dozen tests depend on it', () => {
    _resetWorkspaceDotenvProvenance();
    withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: undefined, VAULT_PATH: undefined }, () => {
      assert.equal(resolveDefaultVault({ vaults, configuredDefault: 'beta' }), 'beta');
      assert.equal(resolveDefaultVault({ vaults: [], configuredDefault: undefined }), undefined);
    });
  });
});

describe('list_vaults — the three fields reach the caller', () => {
  test('what the registry recorded is passed through verbatim', async () => {
    const registry = {
      vaults: [],
      skipped: [],
      configPath: '/c/config.json',
      defaultVault: 'notes',
      defaultVaultSource: { origin: 'workspace-dotenv', variable: 'OBSIDIAN_ROUTER_DEFAULT_VAULT' },
      lockedVault: 'notes',
      lockSource: { origin: 'runtime', variable: null },
      autoEnrichMode: 'FullAuto',
      autoEnrichModeSource: { origin: 'workspace-dotenv', variable: 'OBSIDIAN_ROUTER_AUTO_ENRICH' },
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.defaultVaultSource, { origin: 'workspace-dotenv', variable: 'OBSIDIAN_ROUTER_DEFAULT_VAULT' });
    assert.deepEqual(out.lockSource, { origin: 'runtime', variable: null });
    assert.deepEqual(out.autoEnrichModeSource, { origin: 'workspace-dotenv', variable: 'OBSIDIAN_ROUTER_AUTO_ENRICH' });
    // the fields it already had are untouched
    assert.equal(out.lockedTo, 'notes');
    assert.equal(out.autoEnrichMode, 'FullAuto');
  });

  test('a registry that records nothing says so — "unknown" when a value exists, never a guess', async () => {
    const bare = await listVaults({ vaults: [], skipped: [], configPath: '/c', defaultVault: 'notes', lockedVault: 'notes', autoEnrichMode: 'FullAuto' });
    assert.deepEqual(bare.defaultVaultSource, { origin: 'unknown', variable: null });
    assert.deepEqual(bare.lockSource, { origin: 'unknown', variable: null });
    assert.deepEqual(bare.autoEnrichModeSource, { origin: 'unknown', variable: null });

    const empty = await listVaults({ vaults: [], skipped: [], configPath: '/c' });
    assert.deepEqual(empty.defaultVaultSource, { origin: 'unset', variable: null });
    assert.deepEqual(empty.lockSource, { origin: 'unset', variable: null });
    assert.deepEqual(empty.autoEnrichModeSource, { origin: 'default', variable: null },
      'no mode at all means the documented default applies');

    // `ClaudeAsk` IS the documented default — and also a value a host, a
    // workspace file or a tool call can set explicitly. A mode with no
    // recorded source is therefore `unknown`, not `default`.
    const claudeAsk = await listVaults({ vaults: [], skipped: [], configPath: '/c', autoEnrichMode: 'ClaudeAsk' });
    assert.deepEqual(claudeAsk.autoEnrichModeSource, { origin: 'unknown', variable: null });
  });

  test('a malformed or out-of-vocabulary source never reaches the caller — the response is a contract', async () => {
    const base = { vaults: [], skipped: [], configPath: '/c', defaultVault: 'notes', lockedVault: 'notes', autoEnrichMode: 'FullAuto' };
    for (const bad of [{}, { origin: 'made-up' }, { origin: 'host', variable: 42 }, { origin: null, variable: null }, 'host', 7]) {
      const out = await listVaults({ ...base, defaultVaultSource: bad, lockSource: bad, autoEnrichModeSource: bad });
      for (const field of ['defaultVaultSource', 'lockSource', 'autoEnrichModeSource']) {
        assert.deepEqual(out[field], { origin: 'unknown', variable: null }, `${field} passed through ${JSON.stringify(bad)}`);
      }
    }
    // And every origin it CAN emit is in the one authoritative vocabulary.
    const good = await listVaults({ ...base, defaultVaultSource: { origin: 'workspace-dotenv', variable: 'VAULT_PATH' } });
    assert.ok(SETTING_ORIGINS.includes(good.defaultVaultSource.origin));
  });
});

describe('GUARD — a setting is never assigned without its source, at start-up or across a reload', () => {
  test('every `fresh.<setting> =` in the server has a `fresh.<setting>Source =` beside it', () => {
    const src = blankStringsAndComments(fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8'));
    // The two settings the server assigns on the registry it just built: once
    // at start-up from the environment, once per config hot-reload from the
    // preserved value. Both places must record where the value came from, or
    // `list_vaults` falls back to "unknown" and the decision's whole point —
    // saying WHO chose — is lost silently.
    for (const [setting, sourceField] of [['lockedVault', 'lockSource'], ['autoEnrichMode', 'autoEnrichModeSource']]) {
      const assignments = [...src.matchAll(new RegExp(`fresh\\.${setting}\\s*=`, 'g'))];
      assert.equal(assignments.length, 2, `${setting}: expected the start-up and the reload assignment`);
      for (const m of assignments) {
        const window = src.slice(m.index, m.index + 600);
        assert.match(window, new RegExp(`fresh\\.${sourceField}\\s*=`),
          `${setting} is assigned at offset ${m.index} without setting ${sourceField} beside it`);
      }
    }
    // The checks below read the RAW source, so they see the string literals
    // (`blankStringsAndComments` blanks the quotes too) — and each one is
    // required to sit at an offset that is CODE in the blanked source, so a
    // commented-out copy cannot satisfy it while the real assignment says
    // something else. Both halves are needed: the first version checked the
    // shape on blanked code and stopped before the literals, so swapping the
    // variable name passed to envSettingSource stayed green.
    const raw = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
    const codeMatch = (re, what) => {
      const m = re.exec(raw);
      assert.ok(m, `${what}: not found`);
      assert.notEqual(src[m.index], ' ', `${what}: found only inside a comment or a string`);
      return m;
    };
    // A variable that was SET but rejected (a typo, an unknown mode) leaves
    // the documented default in place; naming it as the source would be a lie.
    codeMatch(
      /fresh\.autoEnrichModeSource = envSettingSource\(\s*\n\s*modeWarning \? null : process\.env\.OBSIDIAN_ROUTER_AUTO_ENRICH,\s*\n\s*'OBSIDIAN_ROUTER_AUTO_ENRICH',\s*\n\s*'default',/,
      'the start-up mode source: gated on the warning, naming its own variable, defaulting to "default"',
    );
    codeMatch(
      /fresh\.lockSource = envSettingSource\(initialLock, 'OBSIDIAN_ROUTER_LOCKED'\);/,
      'the start-up lock source: built from the lock that TOOK EFFECT, naming its own variable',
    );
    // The RELOAD path has the same duty, and no invented fallback.
    codeMatch(
      /fresh\.autoEnrichModeSource = modeReloadWarning\s*\n\s*\? \{ origin: 'default', variable: null \}\s*\n\s*: \(registryRef\.current\?\.autoEnrichModeSource \|\| \{ origin: 'unknown', variable: null \}\);/,
      'the reload mode source: gated on its own warning, unknown when nothing was recorded',
    );
    codeMatch(
      /fresh\.lockSource = validatedLock\s*\n\s*\? \(registryRef\.current\?\.lockSource \|\| \{ origin: 'unknown', variable: null \}\)\s*\n\s*: \{ origin: 'unset', variable: null \};/,
      'the reload lock source: carried over, or unknown — never an invented host',
    );

    // And the two runtime tools say so too. Two checks, because
    // `blankStringsAndComments` blanks the quotes as well: the SHAPE is proven
    // on the blanked source (so a commented-out assignment cannot pass), the
    // literal on the raw source (so 'host' in place of 'runtime' fails).
    for (const [file, field] of [['lock.mjs', 'lockSource'], ['auto-enrich.mjs', 'autoEnrichModeSource']]) {
      const raw = fs.readFileSync(path.join(ROOT, 'src', 'tools', file), 'utf8');
      assert.match(blankStringsAndComments(raw), new RegExp(`registry\\.${field}\\s*=\\s*\\{\\s*origin:`),
        `${file}: the tool must record where the setting now comes from`);
      assert.match(raw, new RegExp(`registry\\.${field}\\s*=\\s*\\{\\s*origin: 'runtime'`),
        `${file}: a setting changed by a tool call is 'runtime', whatever the environment said at start-up`);
    }
    // Unlocking is a change too: dropping the lock must drop its source, or
    // `list_vaults` would report `lockedTo: null` beside a 'runtime' source.
    const lockRaw = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'lock.mjs'), 'utf8');
    assert.match(lockRaw, /registry\.lockedVault\s*=\s*null;\s*\n\s*registry\.lockSource\s*=\s*\{\s*origin: 'unset'/,
      'lock.mjs: unlocking must clear the lock source beside the lock itself');
  });
});

describe('GUARD — the tool description names the three fields and every origin the code can emit', () => {
  test('a value the code can return but the description does not name is a value Claude cannot read', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
    const listSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'list-vaults.mjs'), 'utf8');
    const description = /name: 'list_vaults',\s*description:\s*('(?:[^'\\]|\\.)*')/.exec(indexSrc);
    assert.ok(description, 'the list_vaults description must be a single-quoted literal the guard can read');
    const text = description[1];

    for (const field of ['defaultVaultSource', 'lockSource', 'autoEnrichModeSource']) {
      assert.match(text, new RegExp(field), `the description must name ${field}`);
      assert.match(listSrc, new RegExp(`${field}:`), `list_vaults must return ${field}`);
    }
    // EVERY origin any producer can emit, named in the description. The first
    // version of this guard scanned three files, asserted `size >= 8` and
    // found exactly 8 — so it had no margin, and it was blind to `unknown`,
    // which `list_vaults` built from an ARGUMENT rather than writing as a
    // literal. A missing value in the description is a value Claude reads and
    // cannot interpret; set equality is the only form that cannot be
    // half-written.
    const PRODUCERS = [
      ['src', 'index.mjs'], ['src', 'registry.mjs'],
      ['src', 'tools', 'list-vaults.mjs'], ['src', 'tools', 'lock.mjs'], ['src', 'tools', 'auto-enrich.mjs'],
    ];
    const emitted = new Set(Object.values(ENV_ORIGINS));
    for (const parts of PRODUCERS) {
      const src = fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
      for (const m of src.matchAll(/origin: '([a-z-]+)'/g)) emitted.add(m[1]);
    }
    // ONE authoritative vocabulary: what the producers emit, what `listVaults`
    // will let through, and what the two documentation surfaces explain are
    // the same set of nine values — checked three ways so no pair can drift.
    assert.deepEqual([...emitted].sort(), [...SETTING_ORIGINS].sort(),
      'a producer emits an origin outside SETTING_ORIGINS (or the list has a value nothing emits) — change both on purpose');
    assert.deepEqual([...SETTING_ORIGINS].sort(), [
      'config', 'default', 'first-active', 'first-healthy', 'host', 'runtime', 'unknown', 'unset', 'workspace-dotenv',
    ], 'the vocabulary changed: update the description, the README and this list, deliberately');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const origin of SETTING_ORIGINS) {
      assert.match(text, new RegExp(`"${origin}"`), `the tool description must explain the origin "${origin}"`);
      assert.match(readme, new RegExp(`\`"${origin}"\``), `the README must explain the origin "${origin}"`);
    }
  });
});
