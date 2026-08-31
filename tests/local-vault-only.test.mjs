/**
 * Lot 2 — « local-only » veut dire DEUX choses, et les confondre coûte quelque
 * chose dans les deux sens.
 *
 * L'ÉCART D'ORIGINE (banc du lot 0, 2026-08-30). `find_twin_pages` portait le
 * commentaire « LOCAL-ONLY » à côté de son handler tout en étant ABSENT de
 * `LOCAL_ONLY_TOOL_NAMES`. Sur un déploiement cloisonné il était donc exposé
 * puis échouait à l'appel, au lieu d'être masqué. Il échoue fermé — ce n'est pas
 * une faille — mais c'est un écart entre ce que le code DIT et ce qu'il APPLIQUE,
 * et rien ne le rattrapait.
 *
 * LA RÉPARATION ÉVIDENTE EST FAUSSE. Ajouter l'outil à `LOCAL_ONLY_TOOL_NAMES`
 * le masquerait dès que `OBSIDIAN_ROUTER_USER_ID` est posé — c'est-à-dire sur le
 * profil C′ que ce parc fait tourner, où le routeur EST local et où l'outil
 * fonctionne parfaitement. On retirerait une capacité qui marche, pour se
 * protéger de rien : cet outil n'écrit pas une ligne.
 *
 * Les deux ensembles répondent à deux questions :
 *   - `LOCAL_ONLY_TOOL_NAMES`       — propriété du DÉPLOIEMENT : ça écrit sur la
 *                                     machine hôte, donc c'est interdit dès que
 *                                     le routeur est partagé.
 *   - `LOCAL_VAULT_ONLY_TOOL_NAMES` — propriété du VAULT VISÉ : ça a besoin d'un
 *                                     disque, ce qui se décide À L'APPEL, vault
 *                                     par vault.
 *
 * Ces tests tiennent l'invariant qu'aucun commentaire ne pouvait tenir.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals as ROUTER } from '../src/index.mjs';
import { findTwinPagesTool, UNAVAILABLE } from '../src/tools/find-twin-pages.mjs';

const {
  TOOLS,
  TOOL_HANDLERS,
  WRITE_TOOL_NAMES,
  LOCAL_ONLY_TOOL_NAMES,
  LOCAL_VAULT_ONLY_TOOL_NAMES,
  computeExposedTools,
} = ROUTER;

describe('the two "local-only" sets are different things', () => {
  test('they are disjoint — a tool is one or the other, never both', () => {
    const both = [...LOCAL_VAULT_ONLY_TOOL_NAMES].filter((n) => LOCAL_ONLY_TOOL_NAMES.has(n));
    assert.deepEqual(both, [], 'a deployment gate and a per-vault capability are not the same claim');
  });

  test('every member of both sets is a real tool', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const n of [...LOCAL_ONLY_TOOL_NAMES, ...LOCAL_VAULT_ONLY_TOOL_NAMES]) {
      assert.ok(names.has(n), `${n} is declared but is not in TOOLS`);
      assert.ok(TOOL_HANDLERS[n], `${n} is declared but has no handler`);
    }
  });

  test('a local-vault-only tool writes nothing — that is why it need not be gated', () => {
    for (const n of LOCAL_VAULT_ONLY_TOOL_NAMES) {
      assert.ok(!WRITE_TOOL_NAMES.has(n), `${n} is read-only by premise`);
    }
  });
});

describe('gating hides the host-writers and only those', () => {
  const gated = computeExposedTools(TOOLS, { gated: true, viewAgentConfigured: true });
  const open = computeExposedTools(TOOLS, { gated: false, viewAgentConfigured: true });
  const nameSet = (list) => new Set(list.map((t) => t.name));

  test('the host-writers disappear on a gated deployment', () => {
    const g = nameSet(gated);
    for (const n of LOCAL_ONLY_TOOL_NAMES) assert.ok(!g.has(n), `${n} must be hidden when gated`);
  });

  test('a local-vault-only tool stays exposed when gated — C′ runs it every day', () => {
    const g = nameSet(gated);
    for (const n of LOCAL_VAULT_ONLY_TOOL_NAMES) {
      assert.ok(g.has(n), `${n} must remain available on a gated-but-local router`);
    }
  });

  test('gating removes exactly the declared set, nothing more', () => {
    const removed = [...nameSet(open)].filter((n) => !nameSet(gated).has(n)).sort();
    assert.deepEqual(removed, [...LOCAL_ONLY_TOOL_NAMES].sort());
  });
});

describe('a local-vault-only tool says so, and proves it at call time', () => {
  test('its own description states the constraint — the listing is where a caller looks', () => {
    for (const n of LOCAL_VAULT_ONLY_TOOL_NAMES) {
      const tool = TOOLS.find((t) => t.name === n);
      assert.match(
        tool.description,
        /local vaults? only/i,
        `${n} must declare its local-vault requirement in its description`,
      );
    }
  });

  test('find_twin_pages declines on a vault with no disk, and the decline is not zero', async () => {
    const registry = {
      resolveVault: () => ({ name: 'r', type: 'remote', baseUrl: 'https://127.0.0.1:27126' }),
    };
    const res = await findTwinPagesTool(registry, {});
    assert.equal(res.available, false);
    assert.equal(res.reason, UNAVAILABLE.REMOTE_VAULT);
    // THE SHAPE IS THE GUARANTEE, and the argument has to be stated correctly:
    // an UNGUARDED `result.pairs.length` THROWS when the key is absent, which
    // is what stops "I could not look" from being read as "I looked and found
    // none". (An optional-chained `result.pairs?.length ?? 0` still yields 0 —
    // absence does not defeat a caller who opts into a default. `available` is
    // what such a caller must branch on, and the description says so.)
    assert.ok(!('pairs' in res), 'no `pairs` key on an unavailable answer');
    assert.ok(!('found' in res), 'no `found` count either');
    assert.throws(() => res.pairs.length, TypeError, 'an unguarded read must throw, not read 0');
  });

  // PREMISE 2 OF THE DOCBLOCK, held by a test rather than by assertion. The
  // vector store remembers pages that have since been moved or deleted — 108 of
  // 279 indexed paths on this very vault, measured. Those are exactly the paths
  // REST cannot show a caller, so naming them would hand a gated caller
  // something their vault access does not already give them. They are counted,
  // never named.
  test('a deleted page is counted, never named, in the response', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-premise-'));
    try {
      const MODEL = 'TaylorAI/bge-micro-v2';
      const GHOST = 'wiki/deleted-secret-project.md';
      const recs = [];
      const add = (rel, vec) => recs.push(
        `${JSON.stringify(`smart_sources:${rel}`)}: ${JSON.stringify({
          embeddings: { [MODEL]: { vec } },
        })},`,
      );
      const write = (rel, content) => {
        const abs = path.join(vaultPath, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      // A deterministic spread, so the per-vault threshold has a distribution to
      // be derived FROM…
      const lcg = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
      const vec = (seed) => { const r = lcg(seed); return Array.from({ length: 16 }, (_, i) => 0.55 * Math.sin(i) + (r() - 0.5)); };
      for (let i = 0; i < 12; i += 1) {
        write(`wiki/p${i}.md`, '---\ntype: reference\n---\n\n# p\n\nprose\n');
        add(`wiki/p${i}.md`, vec(1000 + i * 7919));
      }
      // …and ONE genuinely near-identical pair, so the ranking actually names
      // pages. Without it the response names nothing, and "the ghost is absent"
      // would be true for a reason that has nothing to do with the ghost — the
      // control assertion below exists to catch exactly that.
      const twin = vec(424242);
      write('wiki/ptwin-a.md', '---\ntype: reference\n---\n\n# twin\n\nprose\n');
      add('wiki/ptwin-a.md', twin);
      write('wiki/ptwin-b.md', '---\ntype: reference\n---\n\n# twin\n\nprose\n');
      add('wiki/ptwin-b.md', twin.map((x, i) => x + (i === 0 ? 1e-6 : 0)));

      add(GHOST, vec(999));
      write('.smart-env/multi/store.ajson', `${recs.join('\n')}\n`);

      const registry = { resolveVault: () => ({ name: 'v', type: 'local', path: vaultPath }) };
      const res = await findTwinPagesTool(registry, {});

      // THE CONTROL, without which this test passes for the wrong reason
      // (2nd review, MINOR 3): if the tool ever stopped naming ANY page, the
      // "ghost is absent" assertion below would still be green while proving
      // nothing. So first establish that live pages DO get named.
      assert.equal(res.available, true, 'the ranking must actually have run');
      const body = JSON.stringify(res);
      assert.ok(body.includes('wiki/ptwin-a.md'), 'live pages ARE named — the absence below is meaningful');

      assert.equal(res.excluded.notOnDisk, 1, 'the ghost must be COUNTED');
      assert.ok(
        !body.includes('deleted-secret-project'),
        'a path the store remembers but disk no longer has must never be NAMED',
      );
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
