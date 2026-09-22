/**
 * semantic-readiness — the session reminder that a vault's semantic tier will
 * not answer, read from the vault's own disk before anybody asks it a question.
 *
 * The fixtures build the four states as real directories, because every one of
 * them is a SHAPE ON DISK and a mock of the shape would only ever prove that
 * the mock matches the code. The one thing asserted against the real fleet
 * lives in the end-to-end test at the bottom of this file, and it asserts a
 * property (silence for a healthy vault) rather than a vault's name.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  probeSemanticReadiness,
  probeBoundVaults,
  semanticReadinessLine,
  semanticReadinessBindingAdvice,
  REMINDER_STATES,
} from '../src/helpers/semantic-readiness-fs.mjs';

/**
 * Build a vault on disk.
 *
 * @param {{installed?: boolean, enabled?: boolean, indexedPages?: number,
 *   lookup?: boolean, pluginList?: unknown}} spec
 */
function makeVault(spec = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semrdy-'));
  const obs = path.join(dir, '.obsidian');
  fs.mkdirSync(obs, { recursive: true });

  const plug = (id) => {
    const d = path.join(obs, 'plugins', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id, version: '1.0.0' }), 'utf8');
  };
  if (spec.installed) plug('smart-connections');
  if (spec.lookup) plug('smart-lookup');

  if (spec.pluginList !== undefined) {
    fs.writeFileSync(path.join(obs, 'community-plugins.json'), JSON.stringify(spec.pluginList), 'utf8');
  } else if (spec.noPluginList !== true) {
    const list = [];
    if (spec.enabled) list.push('smart-connections');
    if (spec.lookup) list.push('smart-lookup');
    fs.writeFileSync(path.join(obs, 'community-plugins.json'), JSON.stringify(list), 'utf8');
  }

  const pages = Number.isInteger(spec.indexedPages) ? spec.indexedPages : 0;
  if (pages > 0) {
    const multi = path.join(dir, '.smart-env', 'multi');
    fs.mkdirSync(multi, { recursive: true });
    for (let i = 0; i < pages; i += 1) {
      fs.writeFileSync(path.join(multi, `page-${i}.ajson`), '{}', 'utf8');
    }
  }
  return dir;
}

const trash = [];
const vault = (spec) => { const d = makeVault(spec); trash.push(d); return d; };
process.on('exit', () => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('probeSemanticReadiness — the four states, each as a real directory', () => {
  test('enabled with a non-empty store is READY', () => {
    const r = probeSemanticReadiness(vault({ installed: true, enabled: true, indexedPages: 3 }));
    assert.equal(r.state, 'ready');
    assert.equal(r.indexed, 3);
  });

  test('installed but absent from community-plugins.json is DISABLED', () => {
    // The state that reads as working and is not: the folder is there, a sync
    // reported success, and Obsidian never loads it.
    const r = probeSemanticReadiness(vault({ installed: true, enabled: false }));
    assert.equal(r.state, 'disabled');
  });

  test('enabled with no store at all is UNINDEXED', () => {
    const r = probeSemanticReadiness(vault({ installed: true, enabled: true, indexedPages: 0 }));
    assert.equal(r.state, 'unindexed');
    assert.equal(r.indexed, 0);
  });

  test('an EMPTY store directory is UNINDEXED too, not ready', () => {
    const dir = vault({ installed: true, enabled: true, indexedPages: 0 });
    fs.mkdirSync(path.join(dir, '.smart-env', 'multi'), { recursive: true });
    assert.equal(probeSemanticReadiness(dir).state, 'unindexed');
  });

  test('no plugin folder is ABSENT', () => {
    assert.equal(probeSemanticReadiness(vault({ installed: false })).state, 'absent');
  });

  test('an unreadable plugin list is UNKNOWN, never "disabled"', () => {
    // A disconnected network mount answers exactly like a vault with no
    // plugins. Reporting `disabled` there sends the user to fix a setting that
    // is already correct, so not-seeing must be its own answer.
    const dir = vault({ installed: true, noPluginList: true });
    assert.equal(probeSemanticReadiness(dir).state, 'unknown');
  });

  test('a malformed plugin list is UNKNOWN, and does not throw', () => {
    const dir = vault({ installed: true, pluginList: 'not-an-array' });
    assert.equal(probeSemanticReadiness(dir).state, 'unknown');
  });

  test('a nonexistent path is UNKNOWN, and does not throw', () => {
    assert.equal(probeSemanticReadiness(path.join(os.tmpdir(), 'no-such-vault-xyz')).state, 'unknown');
    assert.equal(probeSemanticReadiness('').state, 'unknown');
    assert.equal(probeSemanticReadiness(null).state, 'unknown');
  });

  test('Smart Lookup is reported independently of Smart Connections', () => {
    assert.equal(probeSemanticReadiness(vault({ installed: true, enabled: true, indexedPages: 1 })).lookupInstalled, false);
    assert.equal(probeSemanticReadiness(vault({ installed: true, enabled: true, indexedPages: 1, lookup: true })).lookupInstalled, true);
  });
});

describe('semanticReadinessLine — speaks for two states and stays silent for the rest', () => {
  const line = (states) => semanticReadinessLine(states.map((state, i) => ({ name: `v${i}`, state })));

  test('a healthy vault produces NO line', () => {
    assert.equal(line(['ready']), null);
  });

  test('ABSENT produces no line — a vault may legitimately not want it', () => {
    // The decision (2026-09-22): a reminder that fires on a choice is one the
    // reader learns to skip, which costs us the two that matter.
    assert.equal(line(['absent']), null);
  });

  test('UNKNOWN produces no line — not seeing is not a finding', () => {
    assert.equal(line(['unknown']), null);
  });

  test('DISABLED and UNINDEXED each produce a line', () => {
    assert.match(line(['disabled']), /installed but NOT enabled/);
    assert.match(line(['unindexed']), /index is empty/);
  });

  test('the two reminder states are exactly those two — pinned', () => {
    // A future state added to the probe must make a decision about the
    // reminder rather than inherit one.
    assert.deepEqual([...REMINDER_STATES].sort(), ['disabled', 'unindexed']);
  });

  test('with several vaults, only the broken ones are named', () => {
    const out = semanticReadinessLine([
      { name: 'healthy', state: 'ready' },
      { name: 'broken', state: 'unindexed' },
      { name: 'quiet', state: 'absent' },
    ]);
    assert.match(out, /broken/);
    assert.doesNotMatch(out, /healthy/);
    assert.doesNotMatch(out, /quiet/);
  });

  test('it never mentions Smart Lookup — that belongs to the binding moment only', () => {
    // The router does not use Smart Lookup. Ranking it beside a missing
    // capability in a RECURRING reminder is what this asserts against.
    const out = semanticReadinessLine([{ name: 'v', state: 'disabled' }]);
    assert.doesNotMatch(out, /lookup/i);
  });

  test('bad input is silence, not a throw', () => {
    assert.equal(semanticReadinessLine(null), null);
    assert.equal(semanticReadinessLine([]), null);
    assert.equal(semanticReadinessLine([null, undefined, 42]), null);
  });
});

describe('probeBoundVaults — resolution is injected, and the budget is honoured', () => {
  test('a name the resolver cannot place is skipped, not guessed', () => {
    const { entries, skipped } = probeBoundVaults(['ghost'], () => null);
    assert.deepEqual(entries, []);
    assert.equal(skipped, 1);
  });

  test('a resolver that THROWS does not take the briefing down', () => {
    const { entries, skipped } = probeBoundVaults(['boom'], () => { throw new Error('config is garbage'); });
    assert.deepEqual(entries, []);
    assert.equal(skipped, 1);
  });

  test('the budget stops the walk after the primary, and reports what it skipped', () => {
    const dir = vault({ installed: true, enabled: true, indexedPages: 1 });
    let clock = 0;
    const { entries, skipped } = probeBoundVaults(
      ['a', 'b', 'c'],
      () => dir,
      // Each read of the clock advances it, so the budget is already spent by
      // the time the second name comes up.
      { budgetMs: 5, now: () => (clock += 10) },
    );
    assert.equal(entries.length, 1, 'the primary is probed even over budget');
    assert.equal(entries[0].name, 'a');
    assert.equal(skipped, 2);
  });

  test('a budget of zero still probes the primary — silence about it is never right', () => {
    const dir = vault({ installed: true, enabled: false });
    // The clock advances on every read, so by the time the SECOND name is
    // considered the budget is long gone. Nothing but the exemption can let the
    // primary through. (A constant clock would prove nothing: elapsed would be
    // 0, and `0 > 0` is false, so both names would pass the check for a reason
    // that has nothing to do with the exemption — an earlier draft of this test
    // did exactly that and passed for the wrong reason.)
    let clock = 0;
    const { entries, skipped } = probeBoundVaults(
      ['primary', 'secondary'], () => dir, { budgetMs: 0, now: () => (clock += 100) },
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'primary');
    assert.equal(entries[0].state, 'disabled');
    assert.equal(skipped, 1);
  });

  test('names are probed in order, primary first', () => {
    const ready = vault({ installed: true, enabled: true, indexedPages: 2 });
    const broken = vault({ installed: true, enabled: false });
    const { entries } = probeBoundVaults(['p', 's'], (n) => (n === 'p' ? ready : broken));
    assert.deepEqual(entries.map((e) => [e.name, e.state]), [['p', 'ready'], ['s', 'disabled']]);
  });

  test('non-string names are dropped without a probe', () => {
    const { entries } = probeBoundVaults([null, '', 42, undefined], () => '/nope');
    assert.deepEqual(entries, []);
  });
});

describe('semanticReadinessBindingAdvice — said once, and says what the reminder will not', () => {
  test('ABSENT is spoken here, unlike in the recurring reminder', () => {
    const out = semanticReadinessBindingAdvice({ state: 'absent', lookupInstalled: true });
    assert.match(out, /not installed/);
  });

  test('Smart Lookup is offered here, and only when it is missing', () => {
    assert.match(semanticReadinessBindingAdvice({ state: 'ready', lookupInstalled: false }), /Smart Lookup/);
    assert.equal(semanticReadinessBindingAdvice({ state: 'ready', lookupInstalled: true }), null);
  });

  test('the Smart Lookup sentence says the router never calls it', () => {
    // Otherwise the offer reads as a requirement, and the next person to see a
    // vault without it will go looking for a router fault.
    const out = semanticReadinessBindingAdvice({ state: 'ready', lookupInstalled: false });
    assert.match(out, /router never calls it/i);
  });

  test('UNKNOWN says nothing at all', () => {
    assert.equal(semanticReadinessBindingAdvice({ state: 'unknown', lookupInstalled: false }), null);
  });

  test('bad input is silence', () => {
    assert.equal(semanticReadinessBindingAdvice(null), null);
    assert.equal(semanticReadinessBindingAdvice('nope'), null);
  });
});

describe('composeBriefing carries the block, and omits it when there is none', () => {
  test('the line reaches the briefing text', async () => {
    const { composeBriefing } = await import('../src/helpers/binding-briefing.mjs');
    const out = composeBriefing({
      binding: { vault: 'v', also: [], locked: false },
      registeredCount: 1,
      isRegistered: () => true,
      semanticReadiness: 'SEMANTIC_TIER_NOT_READY\nsomething is off',
    });
    assert.match(out, /SEMANTIC_TIER_NOT_READY/);
  });

  test('no line means no trace of the block', async () => {
    const { composeBriefing } = await import('../src/helpers/binding-briefing.mjs');
    for (const value of [null, undefined, '', '   ']) {
      const out = composeBriefing({
        binding: { vault: 'v', also: [], locked: false },
        registeredCount: 1,
        isRegistered: () => true,
        semanticReadiness: value,
      });
      assert.doesNotMatch(out, /SEMANTIC_TIER/);
    }
  });
});

describe('PIN: this module stays out of the server', () => {
  test('no tool imports it — the router is HTTP-only by doctrine', () => {
    // `confirm_workspace_binding` is EXEMPT from tests/no-vault-disk.test.mjs,
    // and the stated reason is that it writes the user's own config and never
    // a vault. Importing a vault-disk reader into any tool would make that
    // recorded reason false while the bench kept passing — the exemption is
    // the only thing standing between the doctrine and a silent breach.
    const toolsDir = new URL('../src/tools/', import.meta.url);
    const offenders = [];
    for (const name of fs.readdirSync(toolsDir)) {
      if (!name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(new URL(name, toolsDir), 'utf8');
      if (/semantic-readiness-fs/.test(src)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], 'a tool imports the vault-disk probe');
  });
});
