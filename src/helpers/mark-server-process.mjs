/**
 * mark-server-process — a SIDE-EFFECT module: importing it marks the process
 * as the router server.
 *
 * It exists for one reason: ORDER. ES modules evaluate their imports depth-
 * first, in source order, before the importing module's own body runs. A
 * `markServerProcess()` CALL in the body of `src/index.mjs` therefore ran after
 * every dependency of the server had already evaluated — so a dependency whose
 * top-level code reached the vault-disk probe would have run unmarked (Codex,
 * review of the first run-time version). It is the FIRST import of both of the
 * server's entry points: `bin/obsidian-mcp-router.mjs`, the launcher — whose
 * own static imports evaluate before it loads the index (Codex, next round) —
 * and `src/index.mjs`, for anything that loads the index directly.
 * tests/semantic-readiness.test.mjs checks the order module by module, through
 * both entry points.
 *
 * Nothing but those two files may import this one: importing it anywhere else
 * would switch the probe off in that process — the session hook included.
 */

import { markServerProcess } from './server-process.mjs';

markServerProcess();
