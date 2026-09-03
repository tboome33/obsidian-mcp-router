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
import { envSettingSource, autoEnrichModeRefusal, validateAutoEnrichMode, validateLock } from '../src/index.mjs';
import { listVaults, SETTING_ORIGINS } from '../src/tools/list-vaults.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';
import { spawnSyncHomeSafe } from './_home-safe-spawn.mjs';

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

    // The mode in this fixture is Hybrid, not FullAuto: since v0.89.0 a
    // workspace file that names FullAuto is refused rather than applied, so
    // FullAuto here would prove the opposite of what this test is about.
    // The refusal has its own tests, below.
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_DEFAULT_VAULT=notes\nOBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid\n');
    const r = applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    assert.deepEqual(r.applied, ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_AUTO_ENRICH']);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), ENV_ORIGINS.WORKSPACE_DOTENV);
    assert.equal(envKeyOrigin('OBSIDIAN_ROUTER_AUTO_ENRICH', env), ENV_ORIGINS.WORKSPACE_DOTENV);
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), path.join(dir, '.env'));
    assert.deepEqual(appliedWorkspaceDotenvKeys(env), ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_AUTO_ENRICH']);

    // The value moved since the file was read — only this process can do that.
    env.OBSIDIAN_ROUTER_AUTO_ENRICH = 'ClaudeAsk';
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
    assert.equal(envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT', env), null);
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
    assert.deepEqual(appliedWorkspaceDotenvKeys(env), []);
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

/**
 * v0.89.0 — the refused mode is a FOURTH field, not a tenth origin.
 *
 * The distinction is the whole point, and it is easy to get wrong in a way
 * that looks helpful: a reviewer's instinct is to report "the file chose it"
 * on `autoEnrichModeSource`. That would be false twice over — the file chose
 * nothing, and the mode actually in force came from somewhere else — which is
 * exactly the class of lie the provenance lot was built to stop telling.
 */
describe('autoEnrichModeRefused — a refused value is reported beside the source, never inside it', () => {
  test('a file that names FullAuto: the SOURCE says the default took effect, and the REFUSAL is its own field', () => {
    _resetWorkspaceDotenvProvenance();
    const env = {};
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });

    // The refusal, read back against the very object it was judged against.
    const refusal = autoEnrichModeRefusal(env);
    assert.deepEqual(refusal, {
      value: 'FullAuto',
      canonical: 'FullAuto',
      origin: 'workspace-dotenv',
      variable: 'OBSIDIAN_ROUTER_AUTO_ENRICH',
      reason: refusal.reason,
    });
    assert.match(refusal.reason, /not applied from a workspace file/);
    assert.ok(SETTING_ORIGINS.includes(refusal.origin), 'the refusal names a documented origin');

    // The SOURCE, built the way start-up builds it: no effective value, so the
    // documented default — and the variable is NOT named, because it did not
    // set what is in force.
    assert.deepEqual(
      envSettingSource(env.OBSIDIAN_ROUTER_AUTO_ENRICH, 'OBSIDIAN_ROUTER_AUTO_ENRICH', 'default'),
      { origin: 'default', variable: null },
    );
  });

  test('host FullAuto + a file that repeats it: the source is the host and there is NO refusal to report', () => {
    _resetWorkspaceDotenvProvenance();
    const env = { OBSIDIAN_ROUTER_AUTO_ENRICH: 'FullAuto' };
    const dir = tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto\n');
    applyWorkspaceDotenv({ cwd: dir, env, warn: () => {} });
    assert.equal(autoEnrichModeRefusal(env), null, 'a false alarm about a mode legitimately in force');
    assert.deepEqual(
      envSettingSource(env.OBSIDIAN_ROUTER_AUTO_ENRICH, 'OBSIDIAN_ROUTER_AUTO_ENRICH', 'default'),
      { origin: 'host', variable: 'OBSIDIAN_ROUTER_AUTO_ENRICH' },
    );
  });

  test('nothing refused, or a refusal recorded against another environment: null, never a guess', () => {
    _resetWorkspaceDotenvProvenance();
    const env = {};
    applyWorkspaceDotenv({ cwd: tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid\n'), env, warn: () => {} });
    assert.equal(autoEnrichModeRefusal(env), null);
    _resetWorkspaceDotenvProvenance();
    const other = {};
    applyWorkspaceDotenv({ cwd: tmpWorkspace('OBSIDIAN_ROUTER_AUTO_ENRICH=auto\n'), env: other, warn: () => {} });
    assert.notEqual(autoEnrichModeRefusal(other), null, 'the fixture really did refuse something');
    assert.equal(autoEnrichModeRefusal({}), null, 'a different object: the record does not describe it');
  });

  test('EVERY warning built from a rejected workspace value is sanitised — 3 sites of 3, not just the first', () => {
    // Two rounds of review on this. Round 1 reproduced a raw ANSI escape in
    // `validateAutoEnrichMode`; the repair fixed that ONE site, and round 2
    // showed why that is worse than it looks: `validateLock` and the registry's
    // default-vault warning are built from the SAME untrusted file, and an
    // escape in either of them ERASES the refusal the loader printed a moment
    // earlier — the operator's half of the whole rule, defeated by a sister
    // function thirty lines away.
    //
    // So the test sweeps the class instead of asserting a site. A new STDERR
    // WARNING built from a workspace-settable value is added to this list, or
    // it ships unsanitised. (Scope stated precisely: messages that go to
    // stderr at start-up. A thrown Error carrying MD_ALLOWED_PATHS exists in
    // src/markdownify/utils.mjs, but it reaches a caller through
    // `safeForMessage` at the tool boundary, which is a different guard.)
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    assert.equal(ESC.length, 1);
    const hostile = `${ESC}[2J${ESC}[H${CR}[obsidian-mcp-router] Ready. all good`;

    const sites = [
      ['validateAutoEnrichMode env', () => validateAutoEnrichMode(hostile, 'env').warning],
      ['validateAutoEnrichMode preserved', () => validateAutoEnrichMode(hostile, 'preserved').warning],
      ['validateLock env', () => validateLock(hostile, [{ name: 'notes' }], 'env').warning],
      ['validateLock preserved', () => validateLock(hostile, [{ name: 'notes' }], 'preserved').warning],
      ['registry default-vault override', () => {
        const lines = [];
        const realError = console.error;
        console.error = (...a) => lines.push(a.join(' '));
        try {
          withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: hostile, VAULT_PATH: undefined }, () => {
            resolveDefaultVaultWithSource({ vaults: [{ name: 'notes', type: 'local' }], configuredDefault: 'notes' });
          });
        } finally { console.error = realError; }
        return lines.join('\n');
      }],
    ];
    for (const [name, run] of sites) {
      const out = run();
      assert.ok(out, `${name}: must actually produce a message, or this test proves nothing`);
      assert.doesNotMatch(out, new RegExp(ESC), `${name}: an escape sequence reaches the terminal`);
      assert.doesNotMatch(out, new RegExp(CR), `${name}: a carriage return reaches the terminal — that is how a forged line is drawn`);
    }
    // And the fallbacks still behave: an unrecognised mode is still the safe
    // default, and an ordinary typo is still readable — sanitising must not
    // blind the message it protects.
    assert.equal(validateAutoEnrichMode(hostile, 'env').mode, 'ClaudeAsk');
    assert.equal(validateLock(hostile, [{ name: 'notes' }], 'env').lock, null);
    assert.match(validateAutoEnrichMode('maximum-overdrive').warning, /maximum-overdrive/);
    assert.match(validateLock('typo-vault', [{ name: 'notes' }], 'env').warning, /typo-vault/);
  });

  test('sanitising must not blind the message: a long, legitimate value stays readable end to end', () => {
    // Review pass 3 measured what the first repair actually did. The helper
    // reserves 64 characters of its cap for the truncation notice, so the
    // cap of 80 the repair used showed the operator SIXTEEN characters of
    // their own value — in messages whose entire job is to let them find the
    // offending line in their own file. The cap exists to stop a megabyte
    // pushing the useful half off the screen, not to save bytes.
    const long = 'Vault tres long Amelie Galzy Portfolio et Notes de Travail archive 2024-2026 partie deux';
    assert.ok(long.length > 80, `the fixture must exceed the old cap (${long.length})`);
    // ALL THREE sites, not the two that are one function call away. The defect
    // this round fixed was a repair that reached one site of three; covering
    // two of three here would be the same shape, one size smaller.
    const registryWarning = () => {
      const lines = [];
      const realError = console.error;
      console.error = (...a) => lines.push(a.join(' '));
      try {
        withProcessEnv({ OBSIDIAN_ROUTER_DEFAULT_VAULT: long, VAULT_PATH: undefined }, () => {
          resolveDefaultVaultWithSource({ vaults: [{ name: 'notes', type: 'local' }], configuredDefault: 'notes' });
        });
      } finally { console.error = realError; }
      return lines.join('\n');
    };
    for (const [name, warning] of [
      ['validateAutoEnrichMode', validateAutoEnrichMode(long, 'env').warning],
      ['validateLock', validateLock(long, [{ name: 'notes' }], 'env').warning],
      ['registry default-vault override', registryWarning()],
    ]) {
      assert.ok(warning.includes(long), `${name}: the value must survive whole, not clipped to its first words`);
      assert.doesNotMatch(warning, /truncated by sanitize/, `${name}: nothing legitimate should be truncated here`);
    }
  });

  test('list_vaults passes a well-formed refusal through and swallows a malformed one', async () => {
    const base = { vaults: [], skipped: [], configPath: '/c', autoEnrichMode: 'ClaudeAsk' };
    const good = {
      value: 'fullauto', canonical: 'FullAuto', origin: 'workspace-dotenv',
      variable: 'OBSIDIAN_ROUTER_AUTO_ENRICH', reason: 'because',
    };
    const out = await listVaults({ ...base, autoEnrichModeRefused: good });
    assert.deepEqual(out.autoEnrichModeRefused, good);

    // A registry that records nothing reports nothing — the normal case.
    assert.equal((await listVaults(base)).autoEnrichModeRefused, null);

    // The response is a contract: a half-formed refusal is worse than none,
    // because Claude would relay it to the user as if it were established.
    for (const bad of [
      {}, 'workspace-dotenv', 7, { ...good, origin: 'host' }, { ...good, origin: 'made-up' },
      { ...good, value: '' }, { ...good, canonical: 42 }, { ...good, variable: null },
      { ...good, reason: undefined },
    ]) {
      assert.equal((await listVaults({ ...base, autoEnrichModeRefused: bad })).autoEnrichModeRefused, null,
        `passed through ${JSON.stringify(bad)}`);
    }

    // REBUILT, not passed through: the docblock says five fields, so five
    // fields is what a caller gets even when the registry carries more.
    const noisy = await listVaults({ ...base, autoEnrichModeRefused: { ...good, smuggled: 'x', file: 'C:/somewhere/.env' } });
    assert.deepEqual(Object.keys(noisy.autoEnrichModeRefused).sort(),
      ['canonical', 'origin', 'reason', 'value', 'variable']);
    assert.deepEqual(noisy.autoEnrichModeRefused, good);
  });
});

/**
 * The description of `set_auto_enrich_mode` is what Claude reads BEFORE
 * calling it. Both reviewers reached this independently: the behaviour of
 * `persist` changed and that literal still promised the old one, so a caller
 * would read `persisted: false` as an anomaly and retry. `list_vaults` has had
 * a description guard since v0.88.0; this is its twin, and it exists because
 * the surface it guards was the one that got forgotten.
 */
describe('GUARD — the set_auto_enrich_mode description matches what the tool now does', () => {
  test('the persist contract, its one refused value, and the field that reports it are all named', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
    const decl = /name: 'set_auto_enrich_mode',\s*description:\s*('(?:[^'\\]|\\.)*')/.exec(indexSrc);
    assert.ok(decl, 'the description must be a single-quoted literal the guard can read');
    const text = decl[1];
    for (const [needle, why] of [
      [/FullAuto/, 'the refused value, by name'],
      [/persistRefused/, 'the field that carries the refusal'],
      [/persisted:false|persisted: false/, 'what the result says'],
      [/Do not retry/, 'the instruction that stops a caller reading a refusal as a failure'],
      [/still applies|still active|IS active/, 'that the mode applies anyway'],
    ]) {
      assert.match(text, needle, `the description must say ${why}`);
    }
    // And the argument's own description, which a caller may read alone.
    // Searched AFTER this tool's declaration: `lock_vault` has a `persist`
    // argument too, and a match on the first one in the file would have proven
    // a property of the wrong tool.
    const persistDoc = /persist: \{\s*type: 'boolean',\s*description:\s*('(?:[^'\\]|\\.)*')/.exec(indexSrc.slice(decl.index));
    assert.ok(persistDoc, 'the persist argument must carry a readable description');
    assert.match(persistDoc[1], /Refused for "FullAuto"/, 'the persist argument names the exception too');
  });

  test('BOTH halves of the README say it — the bilingual twin is part of the class', () => {
    // The third time this lot met the same defect, and the one that stings:
    // the round-2 repair fixed the two ENGLISH README spots and left their
    // FRENCH twins promising the old contract. Before the lot, both languages
    // said the same true thing; after it, only English was true — so the
    // repair itself created the drift. A French reader would run
    // `auto-mode FullAuto --persist`, get `persisted:false`, and the only
    // document they had read would say it should have been written.
    //
    // Every ROW of the two slash-command tables, and both "four modes"
    // callouts, in one assertion — so a future edit to one language cannot
    // quietly leave the other behind.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const rows = readme.split('\n').filter((l) => l.includes('`/obsidian-router:auto-mode`') && l.startsWith('|'));
    assert.equal(rows.length, 2, `expected the EN and FR command-table rows (found ${rows.length})`);
    for (const row of rows) {
      assert.match(row, /except `FullAuto`|sauf `FullAuto`/,
        `a command-table row still promises that --persist writes every mode: ${row.slice(0, 120)}`);
    }
    const callouts = readme.split('\n').filter((l) => /^\*\*(Four modes|Quatre modes)\*\*/.test(l));
    assert.equal(callouts.length, 2, `expected the EN and FR "four modes" callouts (found ${callouts.length})`);
    for (const c of callouts) {
      assert.match(c, /v0\.89\.0/, `a "four modes" callout does not carry the exception: ${c.slice(0, 120)}`);
    }
  });

  test('the binary\'s --help says it too — RUN, not read', () => {
    // Review's point, and AGENTS.md's: asserting that a file contains a
    // sentence proves the spelling of the sentence. `--help` is a command, so
    // the claim "the help text says the exception" is checked by running it.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-home-'));
    const r = spawnSyncHomeSafe(process.execPath, [path.join(ROOT, 'bin', 'obsidian-mcp-router.mjs'), '--help'], {
      homeDir: home, cwd: home, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FullAuto is the one value NOT taken from a/,
      'the --help text must not keep promising that persist writes every mode');
    assert.match(r.stdout, /autoEnrichModeRefused/, 'and it must name where a refusal shows up');
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
    // v0.89.0 — the mode has a second companion field: what a workspace file
    // asked for and did NOT get. Both paths must set it, for the same reason
    // the sources must: a field the reload silently drops would make a refusal
    // disappear the first time config.json is touched, and the operator would
    // have no way to know the file had ever asked.
    codeMatch(
      /fresh\.autoEnrichModeRefused = autoEnrichModeRefusal\(\);/,
      'the start-up refusal: read from the process-wide register the loader filled',
    );
    codeMatch(
      /fresh\.autoEnrichModeRefused = registryRef\.current\?\.autoEnrichModeRefused \|\| null;/,
      'the reload refusal: carried over whole — a config reload does not re-read the workspace file',
    );
    for (const m of src.matchAll(/fresh\.autoEnrichMode\s*=/g)) {
      const window = src.slice(m.index, m.index + 900);
      assert.match(window, /fresh\.autoEnrichModeRefused\s*=/,
        `the mode is assigned at offset ${m.index} without setting autoEnrichModeRefused beside it`);
    }

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

    // The three sources, and — since v0.89.0 — the refusal that sits beside
    // them. A field Claude receives and the description never explains is a
    // field Claude cannot act on, which for this one means a refusal it would
    // relay wrongly or not at all.
    for (const field of ['defaultVaultSource', 'lockSource', 'autoEnrichModeSource', 'autoEnrichModeRefused']) {
      assert.match(text, new RegExp(field), `the description must name ${field}`);
      assert.match(listSrc, new RegExp(`${field}:`), `list_vaults must return ${field}`);
    }
    // And it must say the two things about that field that are easy to get
    // wrong: which value is refused, and that it is NOT an origin.
    assert.match(text, /"FullAuto", in any of its spellings/, 'the description must say WHICH value is refused');
    assert.match(text, /SEPARATE field and never an origin/, 'and that a refusal is not a tenth origin');
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
