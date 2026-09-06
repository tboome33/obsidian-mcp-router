/**
 * NOTHING A CALLER SAYS ON A GATED DEPLOYMENT MAY OUTLIVE THEIR SESSION.
 *
 * A gated router (`OBSIDIAN_ROUTER_READONLY`, `OBSIDIAN_ROUTER_ALLOWED_VAULTS`
 * or `OBSIDIAN_ROUTER_USER_ID`) serves several callers from ONE process, whose
 * cwd is the server's own directory and whose config is shared by every tenant.
 * So a caller must not be able to record anything there: a binding, a write
 * tier, a lock, an enrichment mode. One answer would stand for all of them,
 * written by a remote hand.
 *
 * WHY THIS FILE IS A SWEEP AND NOT THREE ASSERTIONS. The rule was established
 * in Phase 6 of `portee-ergonomie-refus-roadmap` and applied to the two tools
 * its author was looking at — `confirm_workspace_binding` and
 * `set_secondary_vault_mode`. The whole-lot review that followed drove the real
 * server over JSON-RPC and found three more writers untouched:
 * `lock_vault({ persist: true })` wrote a binding into the shared config
 * (`confirmedVia: "lock"`) AND a line into the server's own `.env`,
 * `unlock_vaults({ persist: true })` lifted it again, and
 * `set_auto_enrich_mode({ persist: true })` wrote the server's `.env` — one
 * caller's mode for every tenant at the next start. Two of five closed, three
 * open: this repository's most expensive recurring shape, a rule applied at the
 * sites its author happened to have open.
 *
 * So the guard here is not "these three refuse". It is: DRIVE EVERY CANDIDATE
 * AND LOOK AT THE SINKS. Any tool that writes the shared config or the server's
 * `.env` under a gate fails this file, whether or not anyone remembered to name
 * it — which is the only form of this test that a sixth writer cannot walk past.
 *
 * The session-only behaviour is asserted too, in the same sweep: a gated
 * deployment must keep `lock_vault` WITHOUT `persist` working. Refusing the
 * whole tool would take away something legitimate (restricting this session to
 * one vault on a shared router) for no safety gained, and a guard that
 * over-refuses is a guard someone will eventually turn off.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { homeSafeEnv } from './_home-safe-spawn.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'obsidian-mcp-router.mjs');

const roots = [];
after(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* the child may still hold a handle */ }
  }
});

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-host-state-'));
  roots.push(root);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: {},
    // A remote vault needs no disk. The port is dead on purpose: every call
    // here is refused before any HTTP request, and a test that needed the
    // vault to answer would be testing something else.
    remoteVaults: [{ name: 'notes', baseUrl: 'http://127.0.0.1:1', apiKey: 'KEY-fixture-DO-NOT-LEAK-0000', timeoutMs: 50 }],
    defaultVault: 'notes',
  }, null, 2));
  return { root, configPath };
}

function startRouter({ configPath, cwd, env = {} }) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd,
    env: homeSafeEnv(path.join(cwd, 'home'), {
      OBSIDIAN_ROUTER_NO_WATCH: '1',
      MD_ALLOWED_PATHS: cwd,
      ...env,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let nl;
    while ((nl = stdout.indexOf('\n')) !== -1) {
      const raw = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  let id = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const mine = id += 1;
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}\n--- router stderr ---\n${stderr}`)),
      20000,
    );
    waiters.set(mine, (m) => { clearTimeout(timer); resolve(m); });
    send({ jsonrpc: '2.0', id: mine, method, params });
  });
  return { child, call, send, stderrText: () => stderr, kill: () => child.kill() };
}

async function handshake(rt) {
  await rt.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gated-host-state-e2e', version: '0' },
  });
  rt.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const isError = (res) => res?.result?.isError === true;
const textOf = (res) => res?.result?.content?.[0]?.text || '';

/**
 * EVERY call this sweep drives. Each names a tool and the arguments that would
 * make it record something on the machine. A new tool that persists anything
 * belongs here; the "no sink was written" assertion below is what catches it if
 * nobody adds it.
 */
const PERSISTING_CALLS = [
  ['confirm_workspace_binding', { vault: 'notes' }],
  ['confirm_workspace_binding', { clear: true }],
  ['confirm_workspace_binding', { refuse: 'notes' }],
  ['set_secondary_vault_mode', { vault: 'notes', mode: 'writable' }],
  ['lock_vault', { vault: 'notes', persist: true }],
  ['unlock_vaults', { persist: true }],
  ['set_auto_enrich_mode', { mode: 'Hybrid', persist: true }],
  ['register_remote_vault', { name: 'planted', baseUrl: 'https://127.0.0.1:27199', apiKey: 'KEY-planted-DO-NOT-LEAK-0000' }],
];

const GATES = [
  ['OBSIDIAN_ROUTER_READONLY', 'true'],
  ['OBSIDIAN_ROUTER_ALLOWED_VAULTS', 'notes'],
  ['OBSIDIAN_ROUTER_USER_ID', 'tenant-1'],
];

describe('a gated deployment keeps nothing a caller says', () => {
  for (const [gate, value] of GATES) {
    test(`under ${gate}: no call writes the shared config or the server's own .env`, async () => {
      const { root, configPath } = scenario();
      const before = fs.readFileSync(configPath, 'utf8');
      const rt = startRouter({ configPath, cwd: root, env: { [gate]: value } });
      try {
        await handshake(rt);
        const refused = [];
        const allowed = [];
        for (const [name, args] of PERSISTING_CALLS) {
          const res = await rt.call('tools/call', { name, arguments: args });
          (isError(res) ? refused : allowed).push(`${name} ${JSON.stringify(args)}`);
        }

        // THE SINKS, read from disk — the assertion that a sixth writer cannot
        // walk past. Whether each call was refused with a good message is the
        // next test's business; this one asks only whether anything LANDED.
        //
        // WHAT COUNTS AS A SINK. Not "the file is byte-identical": the router
        // keeps its OWN bookkeeping there (`workspaceBindingsMigration`, which
        // records that this version started), and that is nobody's answer to
        // anything. What must never appear is a decision — a binding, a
        // refusal, a write tier, a vault a caller added — because the config is
        // shared and the cwd is the server's own directory.
        const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const beforeParsed = JSON.parse(before);
        for (const key of ['workspaceBindings', 'workspaceRefusals']) {
          assert.equal(after[key], undefined,
            `${key} was written under ${gate} — a caller's answer, in a config every tenant shares.`
            + `\nCalls that were NOT refused:\n  ${allowed.join('\n  ') || '(none)'}`);
        }
        assert.deepEqual(after.remoteVaults, beforeParsed.remoteVaults, `the vault set changed under ${gate}`);
        assert.equal(after.defaultVault, beforeParsed.defaultVault, `the default vault changed under ${gate}`);
        const envPath = path.join(root, '.env');
        assert.equal(fs.existsSync(envPath), false,
          `the server's own .env was written under ${gate}: ${fs.existsSync(envPath) ? JSON.stringify(fs.readFileSync(envPath, 'utf8')) : ''}`);

        // And every one of them was refused rather than silently doing nothing:
        // a call that "succeeded" while writing nothing would be a lie of a
        // different kind, and would hide the day it starts writing again.
        assert.deepEqual(allowed, [],
          `these calls reported success on a gated deployment:\n  ${allowed.join('\n  ')}`);
        assert.equal(refused.length, PERSISTING_CALLS.length);
      } finally {
        rt.kill();
      }
    });
  }

  test('the refusal says WHY, and names the gate — on every one of them', async () => {
    const { root, configPath } = scenario();
    const rt = startRouter({ configPath, cwd: root, env: { OBSIDIAN_ROUTER_READONLY: 'true' } });
    try {
      await handshake(rt);
      for (const [name, args] of PERSISTING_CALLS) {
        const res = await rt.call('tools/call', { name, arguments: args });
        const text = textOf(res);
        assert.ok(isError(res), `${name} was not refused`);
        assert.match(text, /OBSIDIAN_ROUTER_READONLY|read-only mode/,
          `${name}'s refusal does not name the gate: ${text.slice(0, 200)}`);
      }
    } finally {
      rt.kill();
    }
  });

  test('the SESSION-ONLY path still works — a gate must not take away what it does not need to', async () => {
    // `lock_vault` without `persist` restricts THIS session and writes nothing.
    // Refusing the whole tool would remove something legitimate on a shared
    // router; the refusal is about the argument that outlives the session.
    const { root, configPath } = scenario();
    const before = fs.readFileSync(configPath, 'utf8');
    const rt = startRouter({ configPath, cwd: root, env: { OBSIDIAN_ROUTER_USER_ID: 'tenant-1' } });
    try {
      await handshake(rt);
      const locked = await rt.call('tools/call', { name: 'lock_vault', arguments: { vault: 'notes' } });
      assert.equal(isError(locked), false, `a session-only lock was refused: ${textOf(locked).slice(0, 200)}`);
      assert.match(textOf(locked), /"locked": true/);

      const unlocked = await rt.call('tools/call', { name: 'unlock_vaults', arguments: {} });
      assert.equal(isError(unlocked), false, `a session-only unlock was refused: ${textOf(unlocked).slice(0, 200)}`);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(after.workspaceBindings, undefined, 'a session-only lock recorded a binding in the shared config');
      assert.equal(fs.existsSync(path.join(root, '.env')), false, "a session-only lock wrote the server's .env");
      assert.deepEqual(after.remoteVaults, JSON.parse(before).remoteVaults, 'a session-only lock changed the vault set');
    } finally {
      rt.kill();
    }
  });

  test('UNGATED, the same calls persist — the gate is what refuses, not the tools', async () => {
    // The other half of the claim: without a gate these tools do their job. A
    // sweep that only ever saw refusals would pass just as well against a
    // router where they were broken outright.
    const { root, configPath } = scenario();
    const rt = startRouter({ configPath, cwd: root });
    try {
      await handshake(rt);
      const res = await rt.call('tools/call', { name: 'lock_vault', arguments: { vault: 'notes', persist: true } });
      assert.equal(isError(res), false, `an ungated persist was refused: ${textOf(res).slice(0, 200)}`);
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.ok(after.workspaceBindings && Object.keys(after.workspaceBindings).length === 1,
        'the ungated persist recorded a binding');
      assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /OBSIDIAN_ROUTER_LOCKED=notes/);
    } finally {
      rt.kill();
    }
  });
});
