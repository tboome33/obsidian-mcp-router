/**
 * v0.90.0 — the ONE launcher that asks the OS to open a vault in Obsidian.
 *
 * It moved out of `scripts/setup-vault.mjs` because the binding lot needs it
 * from the SERVER: a workspace can be bound to a vault whose Obsidian is not
 * running, and a closed vault does not answer — its Local REST API only serves
 * while Obsidian has that vault open. `open_in_obsidian` is not this: that tool
 * navigates an Obsidian already running for the vault and cannot start one.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS DRIVE `launchPlan` AND NOT AN INJECTED SPAWNER
 * ---------------------------------------------------------------------------
 * The first version of this suite passed a fake `spawn` in and recorded the
 * calls. It was tidy, and it made the launcher INVISIBLE to the guard in
 * tests/subprocess-env.test.mjs — that guard finds spawn sites by the LOCAL
 * NAME OF THE IMPORT, and calls written `spawn(...)` against an import named
 * `spawnSync` match nothing. The guard did not go red; it reported the file as
 * having no unguarded spawn at all. Blind reads as covered, which is worse
 * than red.
 *
 * So the seam moved up. `launchPlan` decides everything — platform, URI,
 * arguments, environment — and is exercised exhaustively here without a
 * process being created. The spawn itself is three literal `spawnSync` calls,
 * covered by the subprocess-env guard, which pins them by file, count and
 * command. NOTHING in this file may spawn a desktop application: a suite that
 * opened Obsidian on the developer's machine is a suite nobody runs twice.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { obsidianOpenUri, launcherEnv, launchPlan, launchObsidianVault } from '../src/helpers/obsidian-launcher.mjs';

describe('obsidianOpenUri — the vault label, encoded', () => {
  test('spaces and accents survive as percent-encoding, not as breakage', () => {
    assert.equal(obsidianOpenUri('Mon Vault'), 'obsidian://open?vault=Mon%20Vault');
    assert.equal(obsidianOpenUri('réunion-équipe'), `obsidian://open?vault=${encodeURIComponent('réunion-équipe')}`);
  });

  test('a name that looks like URI syntax is encoded, not interpreted', () => {
    const uri = obsidianOpenUri('a&b?c=d#e');
    assert.equal(uri, `obsidian://open?vault=${encodeURIComponent('a&b?c=d#e')}`);
    assert.equal(uri.split('?').length, 2, 'no second query separator smuggled in');
    assert.doesNotMatch(uri.slice('obsidian://open?vault='.length), /[&?#]/);
  });
});

describe('launcherEnv — the Electron fuse', () => {
  test('ELECTRON_RUN_AS_NODE is removed, in EVERY casing', () => {
    // Not decoration: an Obsidian that inherited it, with its runAsNode fuse
    // open, starts as a mute Node process instead of as the application — no
    // window, no error. Windows environment names are case-insensitive, so a
    // lowercase spelling from the parent would survive a delete of the
    // uppercase one while Electron still read it.
    const out = launcherEnv({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      Electron_Run_As_Node: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
    });
    assert.deepEqual(Object.keys(out), ['PATH'], `survivors: ${Object.keys(out).join(', ')}`);
  });

  test('everything else passes through — the app must see the user session', () => {
    const session = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:x' };
    assert.deepEqual(launcherEnv({ ...session }), session);
  });
});

describe('launchPlan — every decision, proven without creating a process', () => {
  test('Windows dispatches through cmd /c start with an EMPTY TITLE argument', () => {
    const p = launchPlan('Mon Vault', { platform: 'win32', env: {} });
    assert.equal(p.command, 'cmd');
    // The empty '' is START's title. Without it a quoted URI is taken AS the
    // title and nothing opens — a one-character bug with a silent symptom.
    assert.deepEqual(p.args, ['/c', 'start', '', 'obsidian://open?vault=Mon%20Vault']);
  });

  test('macOS uses open, everything else uses xdg-open, each with the bare URI', () => {
    for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open'], ['freebsd', 'xdg-open']]) {
      const p = launchPlan('notes', { platform, env: {} });
      assert.equal(p.command, command, platform);
      assert.deepEqual(p.args, ['obsidian://open?vault=notes'], platform);
    }
  });

  test('the planned environment is the launcher environment, and stdio is silenced', () => {
    const p = launchPlan('notes', { platform: 'linux', env: { PATH: '/p', ELECTRON_RUN_AS_NODE: '1' } });
    assert.deepEqual(p.options.env, { PATH: '/p' });
    assert.equal(p.options.stdio, 'ignore');
  });

  test('no usable vault name means NO PLAN — which is how the launcher refuses without spawning', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(launchPlan(bad, { platform: 'linux', env: {} }), null, JSON.stringify(bad));
    }
  });

  test('THE BOUND: there is no entry point that accepts a URI', () => {
    // The capability is bounded by construction rather than by validating a
    // string. Both exported entry points take a NAME and build the URI
    // themselves, so there is no parameter to smuggle `file:///…` through — a
    // name that looks like one is encoded into the vault query and stays inert.
    const p = launchPlan('file:///etc/passwd', { platform: 'linux', env: {} });
    assert.equal(p.args[0], `obsidian://open?vault=${encodeURIComponent('file:///etc/passwd')}`);
    assert.match(p.args[0], /^obsidian:\/\/open\?vault=/, 'the scheme is always ours');
    assert.equal(p.args.length, 1, 'nothing rides alongside the URI');
  });

  test('every platform plan carries the same four keys — the launcher destructures them blindly', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.deepEqual(Object.keys(launchPlan('v', { platform, env: {} })).sort(),
        ['args', 'command', 'options', 'uri'], platform);
    }
  });
});

describe('launchObsidianVault — the refusal path, which creates no process', () => {
  test('a nameless vault is refused before anything is spawned', () => {
    // The only branch of the launcher safe to exercise here. Everything it
    // decides was proven above through `launchPlan`; the spawn itself is
    // policed by tests/subprocess-env.test.mjs, which pins the three openers
    // by file, count and command.
    for (const bad of ['', '   ', null, undefined, 42]) {
      const r = launchObsidianVault(bad, { platform: 'linux', env: {} });
      assert.equal(r.launched, false, JSON.stringify(bad));
      assert.equal(r.command, null);
      assert.match(r.reason, /no vault name/);
    }
  });
});

describe('GUARD — the plan reaches the spawn', () => {
  /**
   * `launchPlan` is tested to death above, including the fact that its
   * `options.env` has `ELECTRON_RUN_AS_NODE` removed. None of that means the
   * spawn USES it.
   *
   * The Codex review of 2026-09-03: delete the third argument from all three
   * `spawnSync` calls and everything above stays green, while the subprocess
   * guard — which pins openers by file, count and command — stays green too,
   * because it never looks at the options. The launched Obsidian would then
   * inherit `ELECTRON_RUN_AS_NODE` from a Claude Code host and come up as a
   * silent Node process instead of the application. Nothing would be red; a
   * user would just report that "opening a vault does nothing".
   *
   * There is no honest behavioural way to close this — asserting it means
   * launching a desktop app — so it is closed on the source, at the exact
   * point where the plan meets the syscall.
   */
  test('every spawnSync in the launcher passes the plan\'s options as its third argument', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'helpers', 'obsidian-launcher.mjs'),
      'utf8',
    );
    const calls = [...src.matchAll(/spawnSync\(([^)]*)\)/g)].map((m) => m[1]);
    assert.equal(calls.length, 3, 'three openers: cmd, open, xdg-open');
    for (const args of calls) {
      const parts = args.split(',').map((s) => s.trim());
      assert.equal(parts.length, 3, `spawnSync(${args}) must pass command, args AND options`);
      assert.equal(parts[2], 'options',
        `spawnSync(${args}) must pass the plan's own options — that object is what carries the `
        + 'environment with ELECTRON_RUN_AS_NODE removed');
    }
    // And the options really are the plan's, not a fresh literal that happens
    // to be named the same.
    assert.match(src, /const \{ uri, args, options \} = plan;/);

    // NOR REASSIGNED OR REACHED INTO between the destructuring and the spawn.
    // Round 2 of the Codex review: `options.env = env` after the destructuring
    // — or an inner `const options = …` shadowing the plan's — would restore
    // the unsanitised parent environment while the assertion above and the
    // subprocess guard both stayed green. The launcher body is short enough to
    // pin: exactly one binding named `options`, and no write through it.
    const body = src.slice(src.indexOf('export function launchObsidianVault'));
    const bindings = body.match(/\b(?:const|let|var)\s+(?:\{[^}]*\boptions\b[^}]*\}|options\b)/g) || [];
    assert.equal(bindings.length, 1, `exactly one binding of \`options\` in the launcher, found ${bindings.length}`);
    assert.doesNotMatch(body, /\boptions\s*(?:\.\w+|\[[^\]]+\])?\s*=[^=]/, 'no assignment to `options` or through it');
    assert.doesNotMatch(body, /\boptions\.env\b/, 'the environment is never touched after the plan built it');
  });
});
