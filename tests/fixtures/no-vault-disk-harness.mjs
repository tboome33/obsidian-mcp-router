/**
 * The harness that runs INSIDE a permission-gated child process.
 *
 * It is spawned by `tests/no-vault-disk.test.mjs` as:
 *
 *   node --permission --allow-fs-read=<repo>/* --allow-fs-read=<config.json>
 *        tests/fixtures/no-vault-disk-harness.mjs <configPath> <vaultDataJson>
 *
 * The vault's own directory is deliberately NOT on the allow list, so any
 * attempt to touch it dies at Node's C++ binding layer with ERR_ACCESS_DENIED —
 * *below* JavaScript, and therefore immune to how the import was written.
 *
 * WHY A SEPARATE PROCESS AT ALL. `--permission` is a process-wide flag; it
 * cannot be turned on for one test. And that is the point: this is the only
 * instrument in the repo that MEASURES the absence of a disk dependency instead
 * of reading source text and hoping. Three successive regex-based boundary
 * tests were each defeated by an import form their author had not imagined
 * (namespace, indirect specifier, bare side-effect). A permission denial does
 * not care how you spelled the import.
 *
 * Everything is reported as one JSON line on stdout. The parent asserts on it.
 */
import fs from 'node:fs';

const [configPath, vaultDataJson] = process.argv.slice(2);
const report = { control: null, registry: [], tools: [], fatal: null };

/**
 * THE CONTROL, AND IT RUNS FIRST.
 *
 * A green run means nothing unless the vault is genuinely out of reach. If the
 * flag were mis-spelled, or the allow list too wide, every tool below would pass
 * for the wrong reason and this suite would certify a coupling it never tested.
 * So: reach for the vault's own data.json and REQUIRE the denial.
 */
try {
  fs.readFileSync(vaultDataJson, 'utf8');
  report.control = { denied: false, code: null };
} catch (err) {
  report.control = { denied: err?.code === 'ERR_ACCESS_DENIED', code: err?.code ?? String(err) };
}

/** Did this failure come from the permission model, or from ordinary logic? */
function accessDenied(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e.code === 'ERR_ACCESS_DENIED') return true;
    if (typeof e.message === 'string' && e.message.includes('ERR_ACCESS_DENIED')) return true;
  }
  return false;
}

try {
  const { loadRegistry } = await import('../../src/registry.mjs');
  const { _internals } = await import('../../src/index.mjs');

  const registry = await loadRegistry({ configPath });

  // THE REGISTRY'S OWN VIEW, reported as facts — never as values. This is what
  // isolates the coupling: `missingApiKey` is set by `loadRegistry` when it
  // could not read a local vault's data.json, and it is the ONLY observable
  // that changes for the right reason. Tool failures are NOT: a local vault's
  // baseUrl is built as `https://`, so a plain-HTTP stub makes every call fail
  // with ERR_SSL_WRONG_VERSION_NUMBER whether the key was readable or not —
  // measured, and it is why the first negative control here proved nothing.
  report.registry = (registry.vaults ?? []).map((v) => ({
    name: v.name,
    type: v.type,
    missingApiKey: Boolean(v.missingApiKey),
    keyPresent: typeof v.apiKey === 'string' && v.apiKey.length > 0,
    baseUrlScheme: typeof v.baseUrl === 'string' ? v.baseUrl.split(':')[0] : null,
  }));

  const vault = registry.vaults[0];
  // A minimal registry facade: the tools only need `resolveVault`.
  const reg = {
    ...registry,
    resolveVault: () => vault,
    configPath,
  };

  // A CURATED SET, NOT ALL FIFTY. These cover the paths that matter for the
  // HTTP-only claim: registry bootstrap (the one universal coupling lot 0
  // measured), reads, writes, search, and the REST path verification added in
  // v0.80.0. Tools that spawn a child process are OUT OF SCOPE on purpose: they
  // exercise a different axis (local machine binaries), and allowing
  // `--allow-child-process` to test them would let the child do the very disk
  // reads this harness is measuring.
  //
  // "CURATED" USED TO BE A HOLE, and the review was right to call it one: the
  // CHANGELOG claimed this bench "covers ALL disk coupling" while the file
  // itself said "a curated set" — a contradiction, and one where a new tool
  // reading vault disk would ship green. `tests/no-vault-disk.test.mjs` now
  // requires EVERY handler to be either exercised here or listed as exempt with
  // a written reason, so the set can no longer drift silently. It also does NOT
  // replace the import-boundary test in `ingest-state.test.mjs`: an unused
  // import performs no denied access, so the two measure different properties.
  // EACH CASE CARRIES ITS OWN ORACLE — and that is the whole difference between
  // this bench and a placebo. An earlier draft recorded `ok: true` whenever the
  // promise resolved, which a handler could satisfy by catching
  // ERR_ACCESS_DENIED and returning `{ files: [] }`: the denial test and the
  // liveness test would BOTH pass while the tool silently did nothing (review,
  // 2026-08-31). "The tools must also work" has to mean "they returned the
  // answer the stub actually holds", or it means nothing.
  const CASES = [
    // `online: true`, NOT the vault's name. The name comes from the config file
    // and is present even with the server dead — measured: with the stub killed,
    // a name-based oracle still passed while every other one failed. A false
    // witness in the middle of a bench built to stop false witnesses. `online`
    // is set by an actual REST ping to `/`, so nothing but a reachable vault
    // produces it.
    ['list_vaults', {}, (o) => o?.vaults?.some((v) => v.name === 'stubbed' && v.online === true)],
    ['list_files', { directory: 'wiki' }, (o) => JSON.stringify(o).includes('alpha.md')],
    ['get_file', { path: 'wiki/alpha.md' }, (o) => JSON.stringify(o).includes('# Alpha')],
    ['get_frontmatter', { path: 'wiki/alpha.md' }, (o) => JSON.stringify(o).includes('reference')],
    ['search', { query: 'alpha' }, (o) => JSON.stringify(o).includes('wiki/alpha.md')],
    // The writes' oracle is not here: the PARENT asserts that its own stub
    // received them. A handler cannot fake a request that never arrived.
    ['write_file', { path: 'wiki/written.md', content: '# written\n' }, () => true],
    ['append_to_file', { path: 'wiki/alpha.md', content: '\nplus\n' }, () => true],
    ['build_open_link', { path: 'wiki/alpha.md' }, (o) => o?.pathVerified === true],
    // basename correction → forces the REST walk
    ['build_open_link', { path: 'alpha.md' }, (o) => o?.corrected === true && o?.path === 'wiki/alpha.md'],
    ['build_open_link', { paths: ['wiki/alpha.md', 'wiki/deep/cible.md'] },
      (o) => o?.links?.length === 2 && o.links.every((l) => l.pathVerified === true)],
  ];

  for (const [name, args, oracle] of CASES) {
    const handler = _internals.TOOL_HANDLERS[name];
    if (!handler) {
      report.tools.push({ name, ok: false, denied: false, error: 'no such handler' });
      continue;
    }
    try {
      const out = await handler(reg, args);
      let answered = false;
      let oracleError = null;
      try {
        answered = Boolean(oracle(out));
      } catch (e) {
        oracleError = String(e?.message ?? e).slice(0, 200);
      }
      // FACTS, not a truncated string. A 120-character slice of the JSON made an
      // assertion about a batch's third entry impossible to write — the answer
      // was correct and the test read the wrong end of it. Pull out the two
      // things this bench actually asks about, and keep a sample for diagnosis.
      const paths = [];
      const verified = [];
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (typeof node.path === 'string') paths.push(node.path);
        if (typeof node.pathVerified === 'boolean') verified.push(node.pathVerified);
        Object.values(node).forEach(collect);
      };
      collect(out);
      report.tools.push({
        name,
        ok: true,
        // `answered` is the load-bearing field. `ok` only says the promise
        // resolved; `answered` says the result contains what the stub holds.
        answered,
        oracleError,
        denied: false,
        paths,
        verified,
        sample: JSON.stringify(out).slice(0, 200),
      });
    } catch (err) {
      report.tools.push({
        name,
        ok: false,
        denied: accessDenied(err),
        error: String(err?.message ?? err).slice(0, 300),
      });
    }
  }
} catch (err) {
  report.fatal = { denied: accessDenied(err), error: String(err?.message ?? err).slice(0, 500) };
}

process.stdout.write(`${JSON.stringify(report)}\n`);
