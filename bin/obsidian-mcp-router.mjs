#!/usr/bin/env node
import { startServer } from '../src/index.mjs';

startServer().catch((err) => {
  console.error('[obsidian-mcp-router] Fatal:', err);
  process.exit(1);
});
