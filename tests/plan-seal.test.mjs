/**
 * Unit tests for the C3 sealed-preview primitive (src/helpers/plan-seal.mjs):
 * the canonical serialization, the seal computation (op + vault binding), the
 * validators, and verifyPlanSeal's accept-identical / reject-drift / reject-
 * malformed behaviour. The integration of the seal into the two-phase tools
 * lives in tests/plan-seal-integration.test.mjs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEAL_DOMAIN,
  canonicalize,
  computePlanSeal,
  isPlanSeal,
  vaultIdentity,
  verifyPlanSeal,
  PlanDriftError,
} from '../src/helpers/plan-seal.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { classifyError } from '../src/error-classify.mjs';

describe('canonicalize', () => {
  test('object key order does not matter; array order does', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  test('an own "__proto__" key is SERIALIZED, not silently dropped', () => {
    // JSON.parse produces an OWN `__proto__` property, and MCP arguments arrive
    // through JSON.parse. On an ordinary accumulator `acc.__proto__ = x` hits the
    // inherited setter instead of creating an own key, so the value vanished from
    // the canonical form — and a plan carrying it sealed identically to a plan
    // without it. `Object.entries` (used by merge_frontmatter) DOES see the key,
    // so an approved seal could authorize a materially different bundle.
    const plain = JSON.parse('{"values":{}}');
    const injected = JSON.parse('{"values":{"__proto__":"payload"}}');
    assert.equal(Object.prototype.hasOwnProperty.call(injected.values, '__proto__'), true);
    assert.match(canonicalize(injected), /__proto__/);
    assert.notEqual(canonicalize(plain), canonicalize(injected));
    assert.notEqual(
      computePlanSeal({ op: 'write_bundle', plan: plain }),
      computePlanSeal({ op: 'write_bundle', plan: injected }),
    );
    // …and canonicalizing it does not pollute anything either.
    assert.equal({}.payload, undefined);
    assert.equal(Object.prototype.payload, undefined);
  });

  test('sorts keys recursively (nested objects)', () => {
    const x = { z: { d: 1, c: 2 }, a: [{ q: 1, p: 2 }] };
    const y = { a: [{ p: 2, q: 1 }], z: { c: 2, d: 1 } };
    assert.equal(canonicalize(x), canonicalize(y));
  });

  test('primitives and null round-trip like JSON', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize('x'), '"x"');
    assert.equal(canonicalize(42), '42');
    assert.equal(canonicalize(true), 'true');
  });
});

describe('computePlanSeal', () => {
  const base = { op: 'delete', identity: { name: 'v' }, plan: { path: 'a.md', exists: true } };

  test('deterministic 64-hex, insensitive to plan key insertion order', () => {
    const s1 = computePlanSeal(base);
    const s2 = computePlanSeal({
      op: 'delete',
      identity: { name: 'v' },
      plan: { exists: true, path: 'a.md' }, // keys reversed
    });
    assert.match(s1, /^[0-9a-f]{64}$/);
    assert.equal(s1, s2, 'the seal must not depend on key insertion order');
  });

  test('is exactly contentSha256 over the domain-tagged canonical payload', () => {
    const expected = contentSha256(
      canonicalize({ domain: SEAL_DOMAIN, op: base.op, identity: base.identity, plan: base.plan }),
    );
    assert.equal(computePlanSeal(base), expected);
  });

  test('changing the op changes the seal (no cross-op replay)', () => {
    assert.notEqual(computePlanSeal(base), computePlanSeal({ ...base, op: 'provision' }));
  });

  test('changing the identity changes the seal (vault binding)', () => {
    assert.notEqual(computePlanSeal(base), computePlanSeal({ ...base, identity: { name: 'other' } }));
  });

  test('changing the plan changes the seal', () => {
    assert.notEqual(computePlanSeal(base), computePlanSeal({ ...base, plan: { path: 'b.md', exists: true } }));
  });

  test('a plan seal never equals the raw content hash of the same plan text (domain separation)', () => {
    const planText = JSON.stringify(base.plan);
    assert.notEqual(computePlanSeal({ op: 'x', identity: null, plan: base.plan }), contentSha256(planText));
  });

  test('requires a non-empty op', () => {
    assert.throws(() => computePlanSeal({ op: '', plan: {} }), /non-empty string/);
    assert.throws(() => computePlanSeal({ plan: {} }), /non-empty string/);
  });
});

describe('isPlanSeal', () => {
  test('accepts 64 lowercase hex, rejects everything else', () => {
    assert.equal(isPlanSeal(contentSha256('x')), true);
    assert.equal(isPlanSeal('ABC'), false);
    assert.equal(isPlanSeal('g'.repeat(64)), false);
    assert.equal(isPlanSeal(undefined), false);
    assert.equal(isPlanSeal(null), false);
  });
});

describe('vaultIdentity', () => {
  test('includes name + baseUrl when present, omits absent fields', () => {
    assert.deepEqual(vaultIdentity({ name: 'v', baseUrl: 'http://x', apiKey: 'secret' }), {
      name: 'v',
      baseUrl: 'http://x',
    });
    assert.deepEqual(vaultIdentity({ name: 'v' }), { name: 'v' });
    assert.deepEqual(vaultIdentity({}), {});
  });

  test('never leaks the apiKey into the identity (would put a secret in the hash payload)', () => {
    assert.equal('apiKey' in vaultIdentity({ name: 'v', apiKey: 'secret' }), false);
  });
});

describe('verifyPlanSeal', () => {
  const args = { op: 'delete', identity: { name: 'v' }, plan: { path: 'a.md', exists: true } };

  test('matching seal → returns the seal, does not throw', () => {
    const seal = computePlanSeal(args);
    assert.equal(verifyPlanSeal({ ...args, approvedPlanSha256: seal }), seal);
  });

  test('drift (plan changed) → PlanDriftError with kind plan_drift + actionable hint', () => {
    const staleSeal = computePlanSeal(args);
    let thrown;
    try {
      verifyPlanSeal({
        ...args,
        plan: { path: 'a.md', exists: false }, // drifted: file vanished
        approvedPlanSha256: staleSeal,
        previewHint: 'call delete_file with preview:true',
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PlanDriftError);
    assert.equal(thrown.kind, 'plan_drift');
    assert.equal(thrown.status, 409);
    assert.match(thrown.message, /drift/i);
    assert.match(thrown.message, /Nothing was written/i);
    assert.match(thrown.message, /preview:true/);
    // carries both the expected (recomputed) and provided (stale) seals.
    assert.equal(thrown.provided, staleSeal);
    assert.equal(thrown.expected, computePlanSeal({ ...args, plan: { path: 'a.md', exists: false } }));
  });

  test('cross-vault replay (identity changed) → drift', () => {
    const sealForV = computePlanSeal(args);
    assert.throws(
      () => verifyPlanSeal({ ...args, identity: { name: 'OTHER' }, approvedPlanSha256: sealForV }),
      /drift/i,
    );
  });

  test('malformed seal → PlanDriftError (invalid), never silently treated as "no seal"', () => {
    let thrown;
    try {
      verifyPlanSeal({ ...args, approvedPlanSha256: 'nope' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof PlanDriftError);
    assert.match(thrown.message, /Invalid approvedPlanSha256/);
    assert.equal(thrown.provided, 'nope');
  });

  test('null seal → invalid, provided reported as null', () => {
    assert.throws(
      () => verifyPlanSeal({ ...args, approvedPlanSha256: null }),
      (e) => e instanceof PlanDriftError && e.provided === null,
    );
  });

  test('classifyError maps a drift to validation / non-retryable', () => {
    const err = new PlanDriftError('x', { op: 'delete' });
    assert.deepEqual(classifyError(err), { errorCategory: 'validation', isRetryable: false });
  });
});
