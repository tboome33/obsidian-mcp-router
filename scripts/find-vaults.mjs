#!/usr/bin/env node
/**
 * find-vaults.mjs — the vault panel's first-run screen asks it which Obsidian
 * vaults sit on this machine without the router knowing them, and has it add
 * one (a hooks module has no Node of its own). It prints one JSON object on
 * stdout; the Local REST API keys it reads never appear in it.
 *
 * Usage:
 *   node scripts/find-vaults.mjs scan --config <router config> [--workspace <dir>]
 *   node scripts/find-vaults.mjs adopt --config <router config> --folder <dir> --base-url <url> [--name <n>]
 *
 * `scan` answers `{ roots, vaults: [{ name, path, hasRestApi, hasBridge,
 * hasWiki, missingPlugins, address, key }] }` (src/helpers/find-vaults.mjs).
 * `adopt` answers register_remote_vault's result. Exit 1, with `{ error }`,
 * on a bad call or a refusal.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adoptFoundVault, findVaults } from '../src/helpers/find-vaults.mjs';

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

export async function run(args, seams = {}) {
  const [command] = args;
  const configPath = option(args, '--config');
  if (!configPath) {
    throw new Error('--config <router config> is required');
  }
  if (command === 'scan') {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    return findVaults({ cfg, workspace: option(args, '--workspace') }, seams);
  }
  if (command === 'adopt') {
    return adoptFoundVault(
      {
        configPath,
        folder: option(args, '--folder'),
        baseUrl: option(args, '--base-url'),
        name: option(args, '--name') ?? undefined,
      },
      seams,
    );
  }
  throw new Error(`unknown command "${command ?? ''}" — scan or adopt`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  }
}
