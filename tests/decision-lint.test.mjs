/**
 * Tests for src/helpers/decision-lint.mjs — the decision-layer frontmatter
 * contract (normalized statuses, bidirectional `supersedes:` coherence,
 * `affects:` resolution, charter fields). Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  lintDecisions,
  linkKey,
  normalizeStatus,
  findAlternativesSection,
  findHistorySection,
  VALID_STATUSES,
  LEGACY_STATUS_MAP,
} from '../src/helpers/decision-lint.mjs';

/**
 * Build a decision page with the given frontmatter fields. The body carries
 * a filled `## Alternatives considered` section so the body rule (rule 5)
 * stays silent — these fixtures exist to exercise the frontmatter rules, and
 * the body rule has its own suite below.
 */
function decision(path, fields = {}) {
  const lines = Object.entries({ type: 'decision', ...fields })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}:\n${value.map((item) => `  - "${item}"`).join('\n')}`
        : `${key}: ${value}`,
    );
  const body = '# Page\n\nBody.\n\n## Alternatives considered\n\n- Option A: rejected because…\n';
  return { path, content: `---\n${lines.join('\n')}\n---\n\n${body}` };
}

/** A minimal well-formed decision — every rule satisfied. */
function cleanDecision(path, extra = {}) {
  return decision(path, {
    status: 'accepted',
    scope: 'router',
    evidence: ['[[study]]'],
    ...extra,
  });
}

const OTHER_PAGE = { path: 'wiki/refs/study.md', content: '---\ntype: reference\n---\n\n# Study\n' };

function rules(findings) {
  return findings.map((f) => f.rule);
}

describe('lintDecisions — input handling', () => {
  test('throws on non-array input', () => {
    assert.throws(() => lintDecisions('nope'), TypeError);
  });

  test('empty corpus is ok', () => {
    const result = lintDecisions([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.stats, { pages: 0, decisions: 0, byStatus: {} });
  });

  test('ignores non-decision pages entirely', () => {
    const result = lintDecisions([OTHER_PAGE, { path: 'wiki/notes/x.md', content: '# no frontmatter' }]);
    assert.equal(result.ok, true);
    assert.equal(result.stats.pages, 2);
    assert.equal(result.stats.decisions, 0);
  });

  test('skips malformed page entries without throwing', () => {
    const result = lintDecisions([null, { noPath: true }, cleanDecision('wiki/d.md'), OTHER_PAGE]);
    assert.equal(result.stats.pages, 2);
    assert.equal(result.ok, true);
  });

  test('accepts pre-parsed frontmatter instead of content', () => {
    const result = lintDecisions([
      { path: 'wiki/d.md', frontmatter: { type: 'adr', status: 'accepted', scope: 'router', evidence: ['x'] } },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.stats.decisions, 1);
  });

  test('covers all three decision types', () => {
    const result = lintDecisions([
      cleanDecision('wiki/a.md', { type: 'decision' }),
      cleanDecision('wiki/b.md', { type: 'adr' }),
      cleanDecision('wiki/c.md', { type: 'decision-input' }),
      OTHER_PAGE,
    ]);
    assert.equal(result.stats.decisions, 3);
    assert.equal(result.ok, true);
  });
});

describe('lintDecisions — rule 1: status', () => {
  test('flags a missing status as an error', () => {
    const result = lintDecisions([decision('wiki/d.md', { scope: 'router', evidence: ['x'] })]);
    assert.deepEqual(rules(result.errors), ['status-missing']);
    assert.equal(result.ok, false);
  });

  test('accepts every normalized status', () => {
    for (const status of VALID_STATUSES) {
      const pages = [cleanDecision('wiki/d.md', { status })];
      // A superseded page needs a successor to avoid the reverse-direction warning.
      if (status === 'superseded') {
        pages.push(cleanDecision('wiki/new.md', { supersedes: ['[[d]]'] }));
      }
      const result = lintDecisions(pages);
      assert.equal(result.ok, true, `status ${status} should be valid`);
    }
  });

  test('status matching is case-insensitive', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { status: 'Accepted' })]);
    assert.equal(result.ok, true);
  });

  test('flags an unknown status with no suggestion', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { status: 'banana' })]);
    assert.deepEqual(rules(result.errors), ['status-invalid']);
    assert.equal(result.errors[0].suggestion, undefined);
  });

  test('every legacy status yields its migration suggestion', () => {
    for (const [legacy, expected] of Object.entries(LEGACY_STATUS_MAP)) {
      const result = lintDecisions([cleanDecision('wiki/d.md', { status: legacy })]);
      assert.deepEqual(rules(result.errors), ['status-invalid'], `${legacy} should be invalid`);
      assert.equal(result.errors[0].suggestion, expected, `${legacy} → ${expected}`);
    }
  });

  test('counts decisions by status', () => {
    const result = lintDecisions([
      cleanDecision('wiki/a.md', { status: 'accepted' }),
      cleanDecision('wiki/b.md', { status: 'accepted' }),
      cleanDecision('wiki/c.md', { status: 'proposed' }),
      decision('wiki/d.md', {}),
    ]);
    assert.deepEqual(result.stats.byStatus, { accepted: 2, proposed: 1, '(none)': 1 });
  });
});

describe('lintDecisions — rule 2: supersedes coherence', () => {
  test('a coherent supersession passes', () => {
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'superseded' }),
      cleanDecision('wiki/new.md', { supersedes: ['[[old]]'] }),
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  test('flags a target that is still live', () => {
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'accepted' }),
      cleanDecision('wiki/new.md', { supersedes: ['[[old]]'] }),
    ]);
    assert.deepEqual(rules(result.errors), ['supersedes-target-not-superseded']);
    assert.equal(result.errors[0].target, 'wiki/old.md');
  });

  test('flags a dangling supersedes target', () => {
    const result = lintDecisions([cleanDecision('wiki/new.md', { supersedes: ['[[ghost]]'] })]);
    assert.deepEqual(rules(result.errors), ['supersedes-target-missing']);
  });

  test('flags superseding a non-decision page', () => {
    const result = lintDecisions([OTHER_PAGE, cleanDecision('wiki/new.md', { supersedes: ['[[study]]'] })]);
    assert.deepEqual(rules(result.errors), ['supersedes-target-not-decision']);
  });

  test('flags self-supersession', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { supersedes: ['[[d]]'] })]);
    assert.deepEqual(rules(result.errors), ['supersedes-self']);
  });

  test('flags a two-page supersedes cycle on both sides', () => {
    const result = lintDecisions([
      cleanDecision('wiki/a.md', { status: 'superseded', supersedes: ['[[b]]'] }),
      cleanDecision('wiki/b.md', { status: 'superseded', supersedes: ['[[a]]'] }),
    ]);
    const cycles = result.errors.filter((f) => f.rule === 'supersedes-cycle');
    assert.equal(cycles.length, 2);
  });

  test('warns when a superseded page has no successor in the corpus', () => {
    const result = lintDecisions([cleanDecision('wiki/old.md', { status: 'superseded' })]);
    assert.deepEqual(rules(result.warnings), ['superseded-without-successor']);
    assert.equal(result.ok, true, 'corpus-scope caveat keeps this a warning');
  });

  test('an out-of-corpus successor named by superseded_by silences the warning', () => {
    // The real case: a decision retired in favour of one that lives in
    // ANOTHER vault — `supersedes:` cannot reach across vaults.
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'superseded', superseded_by: ['kiviri:wiki/other-vault-decision.md'] }),
    ]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
  });

  test('a cross-vault successor is not resolved against the local corpus', () => {
    // Real case: a decision retired in favour of one living in the `kiviri`
    // vault, whose basename also exists here. Basename resolution would
    // demand a reciprocity that cannot exist across vaults.
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'superseded', superseded_by: ['kiviri:wiki/Projects/new.md'] }),
      cleanDecision('wiki/new.md'),
    ]);
    assert.deepEqual(result.warnings, [], 'an explicitly cross-vault reference is left alone');
  });

  test('an in-corpus successor named by superseded_by must reciprocate', () => {
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'superseded', superseded_by: ['[[new]]'] }),
      cleanDecision('wiki/new.md'),
    ]);
    assert.deepEqual(rules(result.warnings), ['superseded-by-not-reciprocated']);
    assert.equal(result.warnings[0].target, 'wiki/new.md');
  });

  test('a reciprocated superseded_by / supersedes pair is clean', () => {
    const result = lintDecisions([
      cleanDecision('wiki/old.md', { status: 'superseded', superseded_by: ['[[new]]'] }),
      cleanDecision('wiki/new.md', { supersedes: ['[[old]]'] }),
    ]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
  });

  test('resolves supersedes through paths, aliases and anchors', () => {
    for (const reference of ['[[old]]', '[[wiki/decisions/old|the old one]]', 'wiki/decisions/old.md', '[[old#Decision]]']) {
      const result = lintDecisions([
        cleanDecision('wiki/decisions/old.md', { status: 'superseded' }),
        cleanDecision('wiki/decisions/new.md', { supersedes: [reference] }),
      ]);
      assert.equal(result.ok, true, `${reference} should resolve`);
    }
  });

  test('resolves an unquoted comma-separated supersedes line despite parser bracket-mangling', () => {
    const result = lintDecisions([
      cleanDecision('wiki/o1.md', { status: 'superseded' }),
      cleanDecision('wiki/o2.md', { status: 'superseded' }),
      cleanDecision('wiki/new.md', { supersedes: '[[o1]], [[o2]]' }),
    ]);
    assert.equal(result.ok, true);
  });

  test('one successor covers several superseded pages', () => {
    const result = lintDecisions([
      cleanDecision('wiki/o1.md', { status: 'superseded' }),
      cleanDecision('wiki/o2.md', { status: 'superseded' }),
      cleanDecision('wiki/new.md', { supersedes: ['[[o1]]', '[[o2]]'] }),
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});

describe('lintDecisions — rule 3: affects', () => {
  test('a resolving affects target passes', () => {
    const result = lintDecisions([OTHER_PAGE, cleanDecision('wiki/d.md', { affects: ['[[study]]'] })]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });

  test('warns on an unresolvable affects target', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { affects: ['[[ghost]]'] })]);
    assert.deepEqual(rules(result.warnings), ['affects-target-missing']);
    assert.equal(result.ok, true);
  });

  test('affects may point at a non-decision page', () => {
    const result = lintDecisions([OTHER_PAGE, cleanDecision('wiki/d.md', { affects: ['[[study]]', '[[ghost]]'] })]);
    assert.equal(result.warnings.length, 1);
  });
});

describe('lintDecisions — rule 4: charter fields', () => {
  test('warns when scope is missing', () => {
    const result = lintDecisions([decision('wiki/d.md', { status: 'accepted', evidence: ['x'] })]);
    assert.deepEqual(rules(result.warnings), ['scope-missing']);
  });

  test('accepts a list-valued scope', () => {
    const result = lintDecisions([
      decision('wiki/d.md', { status: 'accepted', scope: ['router', 'bridge'], evidence: ['x'] }),
    ]);
    assert.deepEqual(result.warnings, []);
  });

  test('warns on a malformed review_after', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { review_after: 'soon' })]);
    assert.deepEqual(rules(result.warnings), ['review-after-invalid']);
  });

  test('warns when an accepted decision review date has passed', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { review_after: '2026-01-01' })], { today: '2026-07-21' });
    assert.deepEqual(rules(result.warnings), ['review-after-expired']);
    assert.equal(result.warnings[0].reviewAfter, '2026-01-01');
  });

  test('a future review date is silent', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { review_after: '2027-01-01' })], { today: '2026-07-21' });
    assert.deepEqual(result.warnings, []);
  });

  test('an expired review date on a non-accepted decision is silent', () => {
    const result = lintDecisions([cleanDecision('wiki/d.md', { status: 'rejected', review_after: '2026-01-01' })], {
      today: '2026-07-21',
    });
    assert.deepEqual(result.warnings, []);
  });

  test('reports missing evidence as info, not a failure', () => {
    const result = lintDecisions([decision('wiki/d.md', { status: 'accepted', scope: 'router' })]);
    assert.deepEqual(rules(result.info), ['evidence-missing']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});

describe('lintDecisions — rule 5: alternatives considered', () => {
  /** A decision page WITH a body, so the body rules actually run. */
  function withBody(path, body, fields = {}) {
    const fm = ['type: decision', 'status: accepted', 'scope: router', 'evidence:', '  - "[[study]]"'];
    for (const [key, value] of Object.entries(fields)) fm.push(`${key}: ${value}`);
    return { path, content: `---\n${fm.join('\n')}\n---\n\n# Page\n\n${body}\n` };
  }

  const FULL_BODY = '## Context\n\nc\n\n## Decision\n\nd\n\n## Alternatives considered\n\n- Option A: rejected because…\n\n## Consequences\n\nk\n';

  test('a decision with a filled alternatives section is clean', () => {
    const result = lintDecisions([withBody('wiki/d.md', FULL_BODY)]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
  });

  test('warns when the section is absent', () => {
    const result = lintDecisions([withBody('wiki/d.md', '## Context\n\nc\n\n## Decision\n\nd\n')]);
    assert.deepEqual(rules(result.warnings), ['alternatives-missing']);
    assert.equal(result.ok, true, 'incomplete is a warning, not a lie');
  });

  test('warns when the heading exists but nothing follows it', () => {
    const result = lintDecisions([withBody('wiki/d.md', '## Decision\n\nd\n\n## Alternatives considered\n\n\n## Consequences\n\nk\n')]);
    assert.deepEqual(rules(result.warnings), ['alternatives-empty']);
    assert.equal(result.warnings[0].detail.includes('Alternatives considered'), true);
  });

  test('the written escape hatch satisfies the rule', () => {
    const result = lintDecisions([
      withBody('wiki/d.md', '## Decision\n\nd\n\n## Alternatives considered\n\n**No serious alternative** — the licence forbids the only other option.\n'),
    ]);
    assert.deepEqual(result.warnings, []);
  });

  test('recognizes the French headings of a bilingual vault', () => {
    for (const heading of ['## Options écartées', '## Pourquoi pas autre chose', '## Alternatives envisagées', '## Options rejetées']) {
      const result = lintDecisions([withBody('wiki/d.md', `## Décision\n\nd\n\n${heading}\n\n- A : rejetée parce que…\n`)]);
      assert.deepEqual(result.warnings, [], `${heading} should count`);
    }
  });

  test('recognizes a decorated bilingual heading', () => {
    const result = lintDecisions([
      withBody('wiki/d.md', '## Alternatives considered · Options écartées\n\n- A: rejected\n'),
    ]);
    assert.deepEqual(result.warnings, []);
  });

  test('accepts the section at H3 as well as H2', () => {
    const result = lintDecisions([withBody('wiki/d.md', '## Decision\n\nd\n\n### Alternatives considered\n\n- A: rejected\n')]);
    assert.deepEqual(result.warnings, []);
  });

  test('a subsection under the heading counts as content', () => {
    const result = lintDecisions([
      withBody('wiki/d.md', '## Alternatives considered\n\n### Option A\n\nrejected because…\n\n## Consequences\n\nk\n'),
    ]);
    assert.deepEqual(result.warnings, []);
  });

  test('body rules stay silent for frontmatter-only callers', () => {
    const result = lintDecisions([
      { path: 'wiki/d.md', frontmatter: { type: 'decision', status: 'accepted', scope: 'router', evidence: ['x'] } },
    ]);
    assert.deepEqual(result.warnings, [], 'cannot judge a body that was never provided');
  });

  test('a decision-input is not asked what it ruled out', () => {
    // It is material feeding a decision, not a verdict — the same line the
    // recall hook draws when it refuses to surface one as "settled".
    const fm = ['type: decision-input', 'status: accepted', 'scope: router', 'evidence:', '  - "[[x]]"'];
    const result = lintDecisions([
      { path: 'wiki/i.md', content: `---\n${fm.join('\n')}\n---\n\n# I\n\nDu matériau, pas un verdict.\n` },
    ]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.stats.decisions, 1, 'it is still linted for everything else');
  });

  test('an adr is asked, like a decision', () => {
    const fm = ['type: adr', 'status: accepted', 'scope: router', 'evidence:', '  - "[[x]]"'];
    const result = lintDecisions([
      { path: 'wiki/a.md', content: `---\n${fm.join('\n')}\n---\n\n# A\n\nUn verdict sans options.\n` },
    ]);
    assert.deepEqual(rules(result.warnings), ['alternatives-missing']);
  });

  test('non-decision pages are never checked for the section', () => {
    const result = lintDecisions([{ path: 'wiki/refs/x.md', content: '---\ntype: reference\n---\n\n# X\n\nprose\n' }]);
    assert.deepEqual(result.warnings, []);
  });
});

describe('findAlternativesSection', () => {
  test('reports the matched heading verbatim', () => {
    const found = findAlternativesSection('## Options écartées\n\n- A\n');
    assert.deepEqual(found, { found: true, empty: false, heading: 'Options écartées' });
  });

  test('an unrelated heading is not a match', () => {
    assert.equal(findAlternativesSection('## Consequences\n\n- A\n').found, false);
  });

  test('handles an empty or missing body', () => {
    assert.equal(findAlternativesSection('').found, false);
    assert.equal(findAlternativesSection(undefined).found, false);
  });

  test('a trailing section with nothing after it is empty', () => {
    assert.deepEqual(findAlternativesSection('## Decision\n\nd\n\n## Alternatives considered\n'), {
      found: true,
      empty: true,
      heading: 'Alternatives considered',
    });
  });
});

describe('linkKey / normalizeStatus', () => {
  test('linkKey collapses every reference form to a basename', () => {
    assert.equal(linkKey('[[Foo Bar]]'), 'foo bar');
    assert.equal(linkKey('[[wiki/decisions/Foo|alias]]'), 'foo');
    assert.equal(linkKey('wiki\\decisions\\Foo.md'), 'foo');
    assert.equal(linkKey('[[Foo#Section]]'), 'foo');
    assert.equal(linkKey('  Foo.MD  '), 'foo');
  });

  test('linkKey survives the bracket-mangling of an inline flow sequence', () => {
    // `supersedes: [[a]], [[b]]` (unquoted) is read by parseFrontmatter as a
    // YAML flow sequence, yielding these two mangled items.
    assert.equal(linkKey('[a]]'), 'a');
    assert.equal(linkKey('[[b]'), 'b');
  });

  test('normalizeStatus maps legacy values and passes valid ones through', () => {
    assert.equal(normalizeStatus('active'), 'accepted');
    assert.equal(normalizeStatus('AWAITING-VALIDATION'), 'proposed');
    assert.equal(normalizeStatus('accepted'), null, 'already valid → nothing to migrate');
    assert.equal(normalizeStatus('banana'), null);
    assert.equal(normalizeStatus(undefined), null);
  });
});

// ---- rule 6: consolidated marker (consolidation-sans-amnesie) -----------

describe('rule 6 — consolidated marker', () => {
  const HISTORY = '## Historique\n\nChronique complète : [[settled-deliberation]] · consolidée le 2026-07-28.\n';

  function consolidated({ status = 'accepted', marker = '2026-07-28', history = HISTORY } = {}) {
    const body = [
      '# Page',
      '',
      '## Alternatives considered',
      '',
      '- Option A: rejected because…',
      '',
      history,
    ].join('\n');
    return {
      path: 'wiki/decisions/settled.md',
      content: `---\ntype: decision\nstatus: ${status}\nscope: router\nevidence:\n  - "[[study]]"\nconsolidated: ${marker}\n---\n\n${body}`,
    };
  }

  test('a well-formed consolidated page raises no consolidated-* finding', () => {
    const result = lintDecisions([consolidated(), OTHER_PAGE]);
    assert.equal(result.ok, true);
    assert.equal(rules(result.warnings).some((rule) => rule.startsWith('consolidated')), false);
  });

  test('EN heading and decorated FR heading both satisfy the pointer rule', () => {
    for (const history of [
      '## History\n\nFull chronicle: [[settled-deliberation]].\n',
      '## Historique — délibération complète\n\n[[settled-deliberation]]\n',
    ]) {
      const result = lintDecisions([consolidated({ history }), OTHER_PAGE]);
      assert.equal(rules(result.warnings).includes('consolidated-without-history-link'), false, history);
    }
  });

  test('missing history section → consolidated-without-history-link', () => {
    const result = lintDecisions([consolidated({ history: '' }), OTHER_PAGE]);
    assert.equal(rules(result.warnings).includes('consolidated-without-history-link'), true);
  });

  test('history section without a wikilink → consolidated-without-history-link', () => {
    const result = lintDecisions([
      consolidated({ history: '## Historique\n\nDéplacée vers une archive, quelque part.\n' }),
      OTHER_PAGE,
    ]);
    assert.equal(rules(result.warnings).includes('consolidated-without-history-link'), true);
  });

  test('non-ISO marker → consolidated-invalid', () => {
    const result = lintDecisions([consolidated({ marker: 'hier' }), OTHER_PAGE]);
    assert.equal(rules(result.warnings).includes('consolidated-invalid'), true);
  });

  test('consolidated on a proposed page → consolidated-proposed', () => {
    const result = lintDecisions([consolidated({ status: 'proposed' }), OTHER_PAGE]);
    assert.equal(rules(result.warnings).includes('consolidated-proposed'), true);
  });

  test('frontmatter-only caller: marker rules fire, the body rule stays silent', () => {
    const result = lintDecisions([
      {
        path: 'wiki/decisions/head-only.md',
        frontmatter: { type: 'decision', status: 'accepted', scope: 'r', evidence: ['[[s]]'], consolidated: 'nope' },
      },
    ]);
    const found = rules(result.warnings);
    assert.equal(found.includes('consolidated-invalid'), true);
    assert.equal(found.includes('consolidated-without-history-link'), false);
  });

  test('a page without the marker never triggers rule 6', () => {
    const result = lintDecisions([cleanDecision('wiki/decisions/plain.md'), OTHER_PAGE]);
    assert.equal(rules(result.warnings).some((rule) => rule.startsWith('consolidated')), false);
  });

  test('an archive note (type decision-archive) is chronicle, not a decision', () => {
    const archive = {
      path: 'wiki/decisions/archives/settled-deliberation.md',
      content: '---\ntype: decision-archive\nsource: "[[settled]]"\narchived: 2026-07-28\n---\n\n# Chronique\n\nLe récit complet, sans statut ni scope — et le linter n\'a rien à y redire.\n',
    };
    const result = lintDecisions([archive]);
    assert.equal(result.ok, true);
    assert.equal(result.stats.decisions, 0, 'not counted in the decision corpus');
    assert.equal(result.errors.length + result.warnings.length, 0);
  });
});

describe('alternatives headings — French "considérées" variant', () => {
  test('« Alternatives considérées » satisfies rule 5 (the form the decision-consolidate canon prescribes)', () => {
    for (const heading of ['## Alternatives considérées', '## Alternative considérée', '### Alternatives considérées · options écartées']) {
      const section = findAlternativesSection(`# T\n\n${heading}\n\n- Option A : écartée parce que…\n`);
      assert.equal(section.found, true, heading);
      assert.equal(section.empty, false, heading);
    }
  });
});

describe('findHistorySection', () => {
  test('finds the section and its wikilink', () => {
    const section = findHistorySection('# T\n\n## Historique\n\nChronique : [[x-deliberation]].\n');
    assert.deepEqual(section, { found: true, hasLink: true, heading: 'Historique' });
  });

  test('stops at the next same-level heading', () => {
    const section = findHistorySection('## Historique\n\nRien ici.\n\n## Voir aussi\n\n[[ailleurs]]\n');
    assert.equal(section.found, true);
    assert.equal(section.hasLink, false, 'the link lives in the NEXT section');
  });

  test('absent section', () => {
    assert.deepEqual(findHistorySection('# T\n\nBody.\n'), { found: false, hasLink: false, heading: null });
  });
});

describe('stats.byStatus — keys come from vault frontmatter', () => {
  test('PIN: decisions whose `status` is exactly `__proto__` are still counted', () => {
    // `parseFrontmatter` passes `status: __proto__` through as an ordinary
    // string, so the vault chooses this tally key. On a plain `{}` the
    // `counts[status] = (counts[status] ?? 0) + 1` assignment hit
    // Object.prototype's inherited setter instead of creating an own property:
    // `counts.__proto__` read back as Object.prototype, `?? 0` kept it, `+ 1`
    // produced the string "[object Object]1", and assigning a string to
    // `__proto__` is a silent no-op. Four decisions in, a reported total of two.
    const result = lintDecisions([
      cleanDecision('wiki/decisions/a.md'),
      cleanDecision('wiki/decisions/b.md'),
      decision('wiki/decisions/c.md', { status: '__proto__', scope: 'router', evidence: ['[[study]]'] }),
      decision('wiki/decisions/d.md', { status: '__proto__', scope: 'router', evidence: ['[[study]]'] }),
      OTHER_PAGE,
    ]);
    const byStatus = result.stats.byStatus;
    assert.equal(result.stats.decisions, 4);
    assert.equal(
      Object.values(byStatus).reduce((a, b) => a + b, 0),
      4,
      `the tally must account for every decision; got ${JSON.stringify(byStatus)}`,
    );
    assert.equal(byStatus.__proto__, 2);
    assert.equal(byStatus.accepted, 2);
    assert.equal(
      JSON.parse(JSON.stringify(byStatus)).__proto__,
      2,
      'must survive a JSON round-trip',
    );
  });
});
