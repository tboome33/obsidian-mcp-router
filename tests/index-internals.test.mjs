/**
 * Unit tests for `_internals.requiresAlsoTierCheck` — the pure predicate that
 * decides whether a `CallTool` dispatch needs the also-tier write gate
 * (decision `portee-et-mode-ecriture-des-vaults` §2, Phase 3 of
 * `portee-ergonomie-refus-roadmap`) run before its handler. No I/O, no vault
 * resolution — just tool name + args in, boolean out — so it is tested here
 * in isolation from `assertVaultWritable` (tests/vault-reach.test.mjs) and
 * from the real dispatcher wiring (tests/also-tier-write-gate-e2e.test.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { _internals } from '../src/index.mjs';
import { WRITE_TARGET_FIELDS } from '../src/helpers/write-targets.mjs';

const {
  requiresAlsoTierCheck, ALSO_TIER_EXEMPT_TOOL_NAMES, WRITE_TOOL_NAMES, toolActuallyWrote,
  automaticWriteAllowed, queuedMaintenanceBlocked, assertAssetOutputDirWritable,
  ASSET_OUTPUT_DIR_FIELDS, TOOLS, preconditionState, assetOutputDirContext, TOOL_HANDLERS,
} = _internals;

/**
 * `assertAssetOutputDirWritable` — the gate for the one write tool that reaches
 * a vault through the FILESYSTEM (`download_page_assets`' `outputDir`) rather
 * than a `vault` argument. Review round 3: the exempt-set comment said this
 * tool "never writes to a registered vault at all", while the tool's own
 * header documents `<vault>/wiki/.assets/<slug>/` as its normal target.
 */
describe('assertAssetOutputDirWritable', () => {
  const refRoot = path.join(os.tmpdir(), 'index-internals-Ref');
  const inside = path.join(refRoot, 'wiki', '.assets', 'slug');
  const reg = (extra = {}) => ({
    vaults: [
      { name: 'work', type: 'local', path: path.join(os.tmpdir(), 'index-internals-Work') },
      { name: 'ref', type: 'local', path: refRoot },
    ],
    workspaceBinding: { vault: 'work', also: ['ref'] },
    alsoWritable: [],
    alsoLocked: [],
    ...extra,
  });

  // Phase 4: the function now takes the binding registry AS IT IS ON DISK as a
  // third argument, because a shared vault refuses this tool outright. Omitting
  // it means "the config could not be read", which is treated as shared — so
  // every case that expects the call to be ALLOWED has to say which world it is
  // in. One workspace declaring both vaults is the unshared world.
  const SOLO = { workspaceBindings: { 'i:\\only': { vault: 'work', also: ['ref'] } } };
  const SHARED = {
    workspaceBindings: {
      'i:\\only': { vault: 'work', also: ['ref'] },
      'i:\\other': { vault: 'ref', also: [] },
    },
  };

  test('an outputDir outside every registered vault but inside the temp directory is allowed (null, no throw)', () => {
    assert.equal(assertAssetOutputDirWritable({ outputDir: path.join(os.tmpdir(), 'index-internals-elsewhere') }, reg(), SOLO), null);
    assert.equal(assertAssetOutputDirWritable({ outputDir: os.tmpdir() }, reg(), SOLO), null);
    // Nothing named: left to the handler, which refuses it with its own message.
    assert.equal(assertAssetOutputDirWritable({}, reg(), SOLO), null);
  });

  test('an output directory outside every registered vault AND outside the temp directory is refused — both asset writers', () => {
    // A sibling of the temp directory: shares its parent, is not inside it.
    const outside = path.join(path.dirname(os.tmpdir()), `index-internals-not-temp-${process.pid}`, 'assets');
    for (const [tool, field] of Object.entries(ASSET_OUTPUT_DIR_FIELDS)) {
      assert.throws(
        () => assertAssetOutputDirWritable({ [field]: outside }, reg(), SOLO, tool),
        (err) => err.message.startsWith(`${tool}: ${field} must be inside a registered vault or inside the system temporary directory`),
        tool,
      );
    }
  });

  test('the handler context re-runs THIS gate on the directory the handler pins — per tool, with its own field', () => {
    for (const [tool, field] of Object.entries(ASSET_OUTPUT_DIR_FIELDS)) {
      // Judged allowed on the argument (the primary)...
      const args = { [field]: path.join(os.tmpdir(), 'index-internals-Work', 'wiki', '.assets') };
      assert.equal(assertAssetOutputDirWritable(args, reg({ alsoLocked: ['ref'] }), SOLO, tool)?.name, 'work');
      // ...and refused when the REAL directory turns out to be in the locked vault.
      const reads = [];
      const ctx = assetOutputDirContext(tool, args, reg({ alsoLocked: ['ref'] }), () => { reads.push(1); return SOLO; });
      assert.throws(() => ctx.authorizeOutputDir(inside), /locked read-only/, tool);
      assert.equal(reads.length, 1, 'the shared-vault config is read at authorisation time');
      assert.doesNotThrow(() => ctx.authorizeOutputDir(args[field]));
    }
  });

  test('the handler context judges the pinned path AS GIVEN — it never resolves that path again', () => {
    // A second resolution, unpinned, could be answered through a swap and
    // approve a different directory than the one the handler pinned (Codex,
    // round P1). The vault roots and the temp root are still resolved.
    const pinned = path.join(os.tmpdir(), 'index-internals-pinned-as-given', 'assets');
    const seen = [];
    const saved = fs.realpathSync.native;
    fs.realpathSync.native = function spy(p, ...rest) { seen.push(String(p)); return saved.call(this, p, ...rest); };
    try {
      for (const [tool, field] of Object.entries(ASSET_OUTPUT_DIR_FIELDS)) {
        const ctx = assetOutputDirContext(tool, { [field]: pinned }, reg(), () => SOLO);
        ctx.authorizeOutputDir(pinned);
      }
    } finally {
      fs.realpathSync.native = saved;
    }
    assert.ok(seen.length > 0, 'the instrument moved: the roots were resolved');
    // The segment is unique to the pinned path: no vault root or temp root has it.
    assert.deepEqual(seen.filter((p) => p.includes('index-internals-pinned-as-given')), [],
      'the pinned path was never handed to realpath');
  });

  test('the asset writers refuse to run without the dispatcher context — no ungated write if the wiring breaks', async () => {
    const r = reg();
    await assert.rejects(
      async () => TOOL_HANDLERS.download_page_assets(r, { html: '<p/>', baseUrl: 'https://x.test/', outputDir: path.join(os.tmpdir(), 'never') }),
      /without the dispatcher's output-directory authorisation/,
    );
    await assert.rejects(
      async () => TOOL_HANDLERS.pptx_extract_assets(r, { filepath: path.join(os.tmpdir(), 'never.pptx') }),
      /without the dispatcher's output-directory authorisation/,
    );
  });

  test('a temp directory that IS a filesystem root cannot serve as the exception', () => {
    const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
    const root = path.parse(os.tmpdir()).root;
    try {
      process.env.TMP = root;
      process.env.TEMP = root;
      process.env.TMPDIR = root;
      assert.equal(path.parse(os.tmpdir()).root, os.tmpdir(), 'precondition: the override made the temp directory a root');
      assert.throws(
        () => assertAssetOutputDirWritable({ outputDir: path.join(root, 'anything') }, reg(), SOLO),
        /a filesystem root, so it cannot serve/,
      );
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('inside the PRIMARY: allowed', () => {
    assert.equal(assertAssetOutputDirWritable({ outputDir: path.join(os.tmpdir(), 'index-internals-Work', 'wiki', '.assets') }, reg(), SOLO)?.name, 'work');
  });

  test('inside an alsoLocked secondary: refused, confirmed or not', () => {
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside }, reg({ alsoLocked: ['ref'] }), SOLO), /locked read-only/);
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside, confirmSecondaryWrite: true }, reg({ alsoLocked: ['ref'] }), SOLO), /locked read-only/);
  });

  test('inside a soft-tier secondary: refused without the flag, allowed with it', () => {
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside }, reg(), SOLO), /SECONDARY vault/);
    assert.equal(assertAssetOutputDirWritable({ outputDir: inside, confirmSecondaryWrite: true }, reg(), SOLO)?.name, 'ref');
  });

  test('inside an alsoWritable secondary: allowed', () => {
    assert.equal(assertAssetOutputDirWritable({ outputDir: inside }, reg({ alsoWritable: ['ref'] }), SOLO)?.name, 'ref');
  });

  test('inside a vault this workspace cannot REACH: refused, before the tier is even considered', () => {
    const r = reg({ vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } });
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside }, r, SOLO), /not reachable from this workspace/);
  });

  // ---- Phase 4 (Codex round on 23bbbaa) ------------------------------------
  // The exemption's first stated reason — "a set of new files rather than an
  // edit to a known one" — was FALSE: `downloadOne` writes with a plain
  // fs.writeFile and its collision set covers only the current batch, so an
  // asset already on disk under the same name is overwritten. On a shared vault
  // that is the silent clobber this phase exists to stop, by the one door with
  // no `ifMatch` to offer.
  test('inside a SHARED vault: refused without createOnly, with the flag named — and allowed with it', () => {
    // The previous round refused this tool outright on a shared vault and
    // pointed at write_file — which cannot carry a PNG, so asset saving had
    // become impossible on the workspace's own primary. `createOnly` is the
    // tool's own precondition (the `wx` flag). (Fable 5.1 round.)
    assert.throws(
      () => assertAssetOutputDirWritable({ outputDir: inside, confirmSecondaryWrite: true }, reg({ alsoWritable: ['ref'] }), SHARED),
      /is SHARED.*2 workspaces declare it.*`createOnly: true`/s,
    );
    assert.equal(
      assertAssetOutputDirWritable({ outputDir: inside, createOnly: true }, reg({ alsoWritable: ['ref'] }), SHARED)?.name,
      'ref',
    );
  });

  test('inside a vault listed in openVaults: refused for that reason, allowed with createOnly', () => {
    assert.throws(
      () => assertAssetOutputDirWritable({ outputDir: inside }, reg({ alsoWritable: ['ref'], openVaults: ['ref'] }), SOLO),
      /is SHARED.*openVaults.*`createOnly: true`/s,
    );
    assert.equal(
      assertAssetOutputDirWritable({ outputDir: inside, createOnly: true }, reg({ alsoWritable: ['ref'], openVaults: ['ref'] }), SOLO)?.name,
      'ref',
    );
  });

  test('reachability and the write tier are heard FIRST — a vault you cannot name is not "shared"', () => {
    const r = reg({ vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } });
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside }, r, SHARED), /not reachable from this workspace/);
    assert.throws(() => assertAssetOutputDirWritable({ outputDir: inside }, reg({ alsoLocked: ['ref'] }), SHARED), /locked read-only/);
  });

  test('an unreadable binding registry fails CLOSED for this tool too', () => {
    assert.throws(
      () => assertAssetOutputDirWritable({ outputDir: inside }, reg({ alsoWritable: ['ref'] })),
      /is SHARED.*could not be read/s,
    );
  });

  test('containment folds the Windows long-path prefix', () => {
    // Lexical-only containment was escaped by every other spelling of a
    // directory inside the vault (Fable 5.1 round). Proved with the spellings
    // available without privileges: the `\\?\` prefix, and — when the vault
    // root really exists on disk — the filesystem's own canonical form.
    const owner = assertAssetOutputDirWritable(
      { outputDir: `\\\\?\\${path.join(os.tmpdir(), 'index-internals-Work', 'wiki', '.assets')}` }, reg(), SOLO,
    );
    if (process.platform === 'win32') assert.equal(owner?.name, 'work', 'the \\\\?\\ prefix is stripped before comparing');
    else assert.ok(true, 'the prefix is a Windows spelling');
  });

  test('M: a real junction into a vault contains a not-yet-existing child', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-junction-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const vault = path.join(root, 'vault');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(vault);
    try { fs.symlinkSync(vault, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { t.skip(`Cannot create a directory junction/symlink: ${e.code}`); return; }
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    const outputDir = path.join(alias, 'missing', 'assets');
    assert.equal(fs.existsSync(outputDir), false);
    const r = reg({ vaults: [{ name: 'ref', type: 'local', path: vault }], alsoLocked: ['ref'] });
    assert.throws(() => assertAssetOutputDirWritable({ outputDir }, r, SOLO), /locked read-only/);
    assert.equal(fs.existsSync(outputDir), false, 'the guard must not create the child');
  });
});

/**
 * THE CLASS, swept over its producers rather than asserted per tool.
 * `pptx_extract_assets` joined WRITE_TOOL_NAMES alone: the dispatcher's
 * vault-argument gate then resolved the session's DEFAULT vault for a tool
 * that has no `vault` argument, and checked the primary's tier while the
 * files landed wherever `outdir` pointed — an alsoLocked secondary included.
 * Every write tool that names no vault is now required to be exempt from that
 * gate AND, unless it only registers a vault, gated by the containment of its
 * output directory.
 */
describe('write tools with no `vault` argument — every one gated by where it writes', () => {
  const schemaOf = (name) => TOOLS.find((t) => t.name === name)?.inputSchema?.properties ?? {};
  // They create a registry ENTRY; they do not write into an existing vault's folder.
  const REGISTERS_A_VAULT = new Set(['provision_vault', 'register_remote_vault']);

  test('a write tool whose schema declares no `vault` is exempt from the vault-argument gate', () => {
    const noVault = [...WRITE_TOOL_NAMES].filter((n) => !('vault' in schemaOf(n)));
    assert.ok(noVault.length >= 4, `the sweep found only ${noVault.length} producer(s): ${noVault.join(', ')}`);
    for (const n of noVault) {
      assert.ok(ALSO_TIER_EXEMPT_TOOL_NAMES.has(n), `"${n}" names no vault, so the vault gate would check the DEFAULT vault instead of its target`);
    }
  });

  test('every exempt tool either registers a vault or is gated by its output directory', () => {
    for (const n of ALSO_TIER_EXEMPT_TOOL_NAMES) {
      assert.ok(
        REGISTERS_A_VAULT.has(n) || Object.hasOwn(ASSET_OUTPUT_DIR_FIELDS, n),
        `"${n}" is exempt from the vault gate and gated by nothing else`,
      );
    }
  });

  for (const [tool, field] of Object.entries(ASSET_OUTPUT_DIR_FIELDS)) {
    test(`${tool}: its "${field}" is declared, gated inside a locked vault, and ignored under any other name`, () => {
      const props = schemaOf(tool);
      for (const k of [field, 'confirmSecondaryWrite', 'createOnly']) {
        assert.ok(k in props, `${tool} must declare \`${k}\``);
      }
      assert.deepEqual(WRITE_TARGET_FIELDS[tool], [field], 'the audit attribution names the same field');
      assert.equal(preconditionState(tool, { createOnly: true }), 'carried');
      assert.equal(preconditionState(tool, {}), 'missing');

      const lockedRoot = path.join(os.tmpdir(), `index-internals-sweep-${tool}`);
      const r = {
        vaults: [
          { name: 'work', type: 'local', path: path.join(os.tmpdir(), 'index-internals-sweep-work') },
          { name: 'ref', type: 'local', path: lockedRoot },
        ],
        workspaceBinding: { vault: 'work', also: ['ref'] },
        alsoWritable: [],
        alsoLocked: ['ref'],
      };
      const solo = { workspaceBindings: { 'i:\\only': { vault: 'work', also: ['ref'] } } };
      const inside = path.join(lockedRoot, 'wiki', '.assets', 'deck');
      assert.throws(
        () => assertAssetOutputDirWritable({ [field]: inside }, r, solo, tool),
        /locked read-only/,
      );
      // The field is read by NAME: the other tool's spelling points nowhere.
      const other = field === 'outdir' ? 'outputDir' : 'outdir';
      assert.equal(assertAssetOutputDirWritable({ [other]: inside }, r, solo, tool), null);
    });
  }

  test('NESTED vaults: a locked vault inside a writable one is consulted, whatever the registry order', () => {
    const outer = path.join(os.tmpdir(), 'index-internals-nest-A');
    const inner = path.join(outer, 'B');
    const solo = { workspaceBindings: { 'i:\\only': { vault: 'a', also: ['b'] } } };
    const entries = [
      { name: 'a', type: 'local', path: outer },
      { name: 'b', type: 'local', path: inner },
    ];
    for (const vaults of [entries, [...entries].reverse()]) {
      const r = { vaults, workspaceBinding: { vault: 'a', also: ['b'] }, alsoWritable: [], alsoLocked: ['b'] };
      for (const [tool, field] of Object.entries(ASSET_OUTPUT_DIR_FIELDS)) {
        assert.throws(
          () => assertAssetOutputDirWritable({ [field]: path.join(inner, 'wiki', '.assets') }, r, solo, tool),
          /locked read-only/,
          `${tool}: registry order ${vaults.map((v) => v.name).join(',')}`,
        );
        // Beside B, inside A only: allowed, and A is the owner.
        assert.equal(assertAssetOutputDirWritable({ [field]: path.join(outer, 'wiki') }, r, solo, tool)?.name, 'a');
        // B writable: allowed, and the owner reported is the INNERMOST vault.
        const rw = { ...r, alsoLocked: [], alsoWritable: ['b'] };
        assert.equal(assertAssetOutputDirWritable({ [field]: path.join(inner, 'wiki') }, rw, solo, tool)?.name, 'b');
      }
    }
  });

  test('pptx_extract_assets with NO outdir is gated on the temp root it will write under', () => {
    const r = {
      vaults: [{ name: 'tmpvault', type: 'local', path: os.tmpdir() }],
      workspaceBinding: { vault: 'work', also: ['tmpvault'] },
      alsoWritable: [],
      alsoLocked: ['tmpvault'],
    };
    const solo = { workspaceBindings: { 'i:\\only': { vault: 'work', also: ['tmpvault'] } } };
    assert.throws(() => assertAssetOutputDirWritable({}, r, solo, 'pptx_extract_assets'), /locked read-only/);
    // download_page_assets has no default directory: nothing named, nothing gated here.
    assert.equal(assertAssetOutputDirWritable({}, r, solo, 'download_page_assets'), null);
    // A BLANK outdir is "none" for the handler, so it is for the gate too.
    assert.throws(() => assertAssetOutputDirWritable({ outdir: '   ' }, r, solo, 'pptx_extract_assets'), /locked read-only/);
  });

  test('the gate expands ~ exactly as the handler does, so it judges the directory really written', () => {
    const homeVault = path.join(os.homedir(), 'index-internals-home-vault');
    const r = {
      vaults: [{ name: 'hv', type: 'local', path: homeVault }],
      workspaceBinding: { vault: 'work', also: ['hv'] },
      alsoWritable: [],
      alsoLocked: ['hv'],
    };
    const solo = { workspaceBindings: { 'i:\\only': { vault: 'work', also: ['hv'] } } };
    assert.throws(
      () => assertAssetOutputDirWritable({ outdir: '~/index-internals-home-vault/wiki/.assets' }, r, solo, 'pptx_extract_assets'),
      /locked read-only/,
    );
  });

  test('a tool that is not an asset writer is refused by the helper, never silently gated as one', () => {
    assert.throws(() => assertAssetOutputDirWritable({}, { vaults: [] }, {}, 'write_file'), /not an asset-writing tool/);
  });
});

describe('ALSO_TIER_EXEMPT_TOOL_NAMES', () => {
  test('is a Set of the 4 tools that never address an already-registered vault through a `vault` argument', () => {
    assert.ok(ALSO_TIER_EXEMPT_TOOL_NAMES instanceof Set);
    assert.deepEqual(
      [...ALSO_TIER_EXEMPT_TOOL_NAMES].sort(),
      ['download_page_assets', 'pptx_extract_assets', 'provision_vault', 'register_remote_vault'],
    );
  });

  test('every exempt name is itself a documented write tool (the exemption narrows WRITE_TOOL_NAMES, it does not name something else)', () => {
    for (const n of ALSO_TIER_EXEMPT_TOOL_NAMES) {
      assert.ok(WRITE_TOOL_NAMES.has(n), `"${n}" is exempt from the also-tier gate but is not in WRITE_TOOL_NAMES`);
    }
  });
});

describe('requiresAlsoTierCheck', () => {
  test('a read tool never needs the check, regardless of args', () => {
    assert.equal(requiresAlsoTierCheck('get_file', {}), false);
    assert.equal(requiresAlsoTierCheck('list_vaults', {}), false);
    assert.equal(requiresAlsoTierCheck('search', { vault: 'x' }), false);
  });

  test('an unknown tool name never needs the check', () => {
    assert.equal(requiresAlsoTierCheck('not_a_real_tool', {}), false);
  });

  test('the 3 exempt write tools never need the check, even with a `vault` argument (they do not have one, but a stray one must not flip the gate on)', () => {
    assert.equal(requiresAlsoTierCheck('provision_vault', { vault: 'x' }), false);
    assert.equal(requiresAlsoTierCheck('register_remote_vault', { vault: 'x' }), false);
    assert.equal(requiresAlsoTierCheck('download_page_assets', { vault: 'x' }), false);
  });

  test('an ordinary write tool with no special flag needs the check', () => {
    for (const n of ['write_file', 'append_to_file', 'move_file', 'set_frontmatter', 'merge_frontmatter', 'patch_file', 'record_source']) {
      assert.equal(requiresAlsoTierCheck(n, {}), true, `"${n}" must require the also-tier check by default`);
    }
  });

  test('execute_template: only requires the check when createFile is true', () => {
    assert.equal(requiresAlsoTierCheck('execute_template', {}), false);
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: false }), false);
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: 'yes' }), false, 'must be the literal boolean true, not a truthy string');
    assert.equal(requiresAlsoTierCheck('execute_template', { createFile: true }), true);
  });

  test('write_bundle: preview:true and the READ-ONLY recovery listing (recover:true) are exempt; an ordinary apply is not', () => {
    assert.equal(requiresAlsoTierCheck('write_bundle', { preview: true }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: true }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'true' }), false, 'a string "true" normalises to the same LIST mode as the boolean');
    assert.equal(requiresAlsoTierCheck('write_bundle', {}), true);
    assert.equal(requiresAlsoTierCheck('write_bundle', { preview: false }), true);
  });

  test('write_bundle: a RUN-mode recovery (an actual operation id) is NOT exempt — it WRITES, so alsoLocked\'s "no exceptions" must still apply to it', () => {
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-1234567890abcdef', confirm: true }), true);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-1234567890abcdef' }), true);
    // THE BYPASS THE FABLE 5.1 ROUND FOUND: the handler routes on `recover`
    // first and its recovery path never reads `preview`, so a run that ALSO
    // says `preview: true` replays the journal — while this predicate, which
    // used to test `preview` first, called it a non-write. Both gates, the
    // audit line and the projections refresh were skipped by one stray flag.
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-1234567890abcdef', confirm: true, preview: true }), true,
      'a recovery run WRITES whatever `preview` says — the handler never reads it');
    // Malformed `recover` values reach the handler and are refused there,
    // writing nothing — so they are not gated, exactly like the listing.
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 1 }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'op-short' }), false);
    assert.equal(requiresAlsoTierCheck('write_bundle', { recover: 'TRUE' }), false, 'a listing token in any case');
  });

  test('delete_file: preview:true is exempt, an actual delete is not', () => {
    assert.equal(requiresAlsoTierCheck('delete_file', { preview: true }), false);
    assert.equal(requiresAlsoTierCheck('delete_file', { confirm: true }), true);
    assert.equal(requiresAlsoTierCheck('delete_file', {}), true);
  });

  test('build_wiki_graph: a truthy dryRun is exempt (the handler\'s own test is truthy too), a real build is not', () => {
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: true }), false);
    // A client sending a stringified boolean must land on the SAME side as
    // the handler's `if (!dryRun)`: a dry run, never an unintended write.
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: 'true' }), false);
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: 1 }), false);
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: false }), true);
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', { dryRun: 0 }), true);
    assert.equal(requiresAlsoTierCheck('build_wiki_graph', {}), true);
  });

  test('build_search_index and refresh_okf_projections: check:true is exempt, an actual run is not', () => {
    assert.equal(requiresAlsoTierCheck('build_search_index', { check: true }), false);
    assert.equal(requiresAlsoTierCheck('build_search_index', {}), true);
    assert.equal(requiresAlsoTierCheck('refresh_okf_projections', { check: true }), false);
    assert.equal(requiresAlsoTierCheck('refresh_okf_projections', {}), true);
  });

  test('every WRITE_TOOL_NAMES member is covered by name here (either exempt-by-default or exercised with a conditional flag) — no silent new write tool skips the gate', () => {
    const conditionallyExempt = new Set([
      'execute_template', 'write_bundle', 'delete_file',
      'build_wiki_graph', 'build_search_index', 'refresh_okf_projections',
    ]);
    for (const n of WRITE_TOOL_NAMES) {
      if (ALSO_TIER_EXEMPT_TOOL_NAMES.has(n) || conditionallyExempt.has(n)) continue;
      assert.equal(requiresAlsoTierCheck(n, {}), true, `"${n}" is a write tool with no known exemption — it must require the also-tier check`);
    }
  });
});

/**
 * `toolActuallyWrote` — the predicate the audit log and the debounced
 * projections/search-index scheduler now consult instead of bare
 * `WRITE_TOOL_NAMES.has(name)`. Codex review (two independent passes) found
 * that a preview/dry-run call — exactly the ones `requiresAlsoTierCheck`
 * exempts because they write nothing — still reached both of those
 * post-write middleware blocks, so a preview against an `alsoLocked`
 * secondary still produced a real write (an audit-journal entry, a scheduled
 * projections refresh). See tests/also-tier-write-gate-e2e.test.mjs for the
 * end-to-end proof through the real dispatcher.
 */
describe('toolActuallyWrote', () => {
  test('agrees with requiresAlsoTierCheck for every ordinary write tool and every preview/dry-run flag', () => {
    for (const [name, args] of [
      ['write_file', {}],
      ['execute_template', {}],
      ['execute_template', { createFile: true }],
      ['write_bundle', { preview: true }],
      ['write_bundle', {}],
      ['write_bundle', { recover: true }],
      ['write_bundle', { recover: 'op-1234567890abcdef', confirm: true }],
      ['write_bundle', { recover: 'op-1234567890abcdef', confirm: true, preview: true }],
      ['write_bundle', { recover: 1 }],
      ['delete_file', { preview: true }],
      ['delete_file', { confirm: true }],
      ['build_wiki_graph', { dryRun: true }],
      ['build_wiki_graph', {}],
      ['build_search_index', { check: true }],
      ['build_search_index', {}],
      ['refresh_okf_projections', { check: true }],
      ['refresh_okf_projections', {}],
    ]) {
      assert.equal(
        toolActuallyWrote(name, args), requiresAlsoTierCheck(name, args),
        `toolActuallyWrote(${name}, ${JSON.stringify(args)}) must agree with requiresAlsoTierCheck here`,
      );
    }
  });

  test('the 3 also-tier-exempt tools are STILL treated as writes — audit/projections coverage for them is unchanged', () => {
    for (const n of ALSO_TIER_EXEMPT_TOOL_NAMES) {
      assert.equal(requiresAlsoTierCheck(n, {}), false, `fixture sanity: "${n}" must be also-tier exempt`);
      assert.equal(toolActuallyWrote(n, {}), true, `"${n}" must still count as a write for audit/projections purposes, unchanged from before this fix`);
    }
  });

  test('a read tool is never treated as a write', () => {
    for (const n of ['get_file', 'list_vaults', 'search', 'search_smart']) {
      assert.equal(toolActuallyWrote(n, {}), false);
    }
  });
});

/**
 * `automaticWriteAllowed` — the ONE tier rule for the router's OWN writes
 * (audit line, first-contact repair, the default-vault repair after
 * `list_vaults`). Round 3 of the review found the rule lived in only one of
 * its three sites; this is the predicate the three now share.
 */
describe('automaticWriteAllowed', () => {
  const bound = (extra = {}) => ({ workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: [], ...extra });

  test('no binding, the primary, an alsoWritable secondary, an undeclared vault — allowed', () => {
    assert.equal(automaticWriteAllowed('any', {}), true);
    assert.equal(automaticWriteAllowed('work', bound()), true);
    assert.equal(automaticWriteAllowed('ref', bound({ alsoWritable: ['ref'] })), true);
    assert.equal(automaticWriteAllowed('elsewhere', bound()), true);
  });

  test('alsoLocked — never, confirmed or not', () => {
    const reg = bound({ alsoLocked: ['ref'] });
    assert.equal(automaticWriteAllowed('ref', reg), false);
    assert.equal(automaticWriteAllowed('ref', reg, { confirmed: true }), false);
  });

  test('soft tier — only on the back of a CONFIRMED call', () => {
    assert.equal(automaticWriteAllowed('ref', bound()), false);
    assert.equal(automaticWriteAllowed('ref', bound(), { confirmed: false }), false);
    assert.equal(automaticWriteAllowed('ref', bound(), { confirmed: 'true' }), false, 'the literal boolean, not a truthy string');
    assert.equal(automaticWriteAllowed('ref', bound(), { confirmed: true }), true);
  });
});

/**
 * `queuedMaintenanceBlocked` — the fire-time rule for a debounced refresh
 * (helpers/projections-refresh.mjs `shouldSkip`). Narrower than the rule
 * above on purpose: a queued refresh follows a write that was already
 * permitted, so `soft` must NOT block it — only `alsoLocked`, or the vault
 * having become unreachable since.
 */
describe('queuedMaintenanceBlocked', () => {
  const bound = (extra = {}) => ({ workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: [], ...extra });

  test('soft tier does NOT block a queued refresh (the write it follows was confirmed)', () => {
    assert.equal(queuedMaintenanceBlocked('ref', bound()), false);
  });

  test('alsoLocked blocks it', () => {
    assert.equal(queuedMaintenanceBlocked('ref', bound({ alsoLocked: ['ref'] })), true);
  });

  test('a vault that became unreachable since the write blocks it', () => {
    const reg = { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } };
    assert.equal(queuedMaintenanceBlocked('ref', reg), true, 'ref was in `also` when the write happened; the binding was re-confirmed without it');
    assert.equal(queuedMaintenanceBlocked('work', reg), false);
  });

  test('vaultReach inactive, no binding — nothing blocks', () => {
    assert.equal(queuedMaintenanceBlocked('any', {}), false);
  });
});
