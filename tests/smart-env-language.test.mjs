/**
 * src/helpers/smart-env-language.mjs — embedding model by vault language.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EMBED_MODEL,
  MULTILINGUAL_EMBED_MODEL,
  CHINESE_EMBED_MODEL,
  normalizeLang,
  embedModelForLanguage,
  applyLanguageToSmartEnv,
  detectDeclaredLanguage,
} from '../src/helpers/smart-env-language.mjs';

const SKELETON_ENV = {
  smart_sources: { min_chars: 200, embed_model: { adapter: 'transformers', transformers: { model_key: 'TaylorAI/bge-micro-v2' } } },
  language: 'en',
  new_user: true,
};

describe('normalizeLang', () => {
  test('keeps the primary subtag, lowercased', () => {
    assert.equal(normalizeLang('fr'), 'fr');
    assert.equal(normalizeLang('pt-BR'), 'pt');
    assert.equal(normalizeLang(' DE '), 'de');
  });
  test('rejects what is not a language tag', () => {
    for (const bad of ['', 'f', 'french!', '../x', '--fr', null, 42]) assert.equal(normalizeLang(bad), null, String(bad));
  });
});

describe('embedModelForLanguage', () => {
  test('en and unknown keep the English default', () => {
    assert.equal(embedModelForLanguage('en'), DEFAULT_EMBED_MODEL);
    assert.equal(embedModelForLanguage(null), DEFAULT_EMBED_MODEL);
  });
  test('any other language → multilingual; zh → the Chinese/English model', () => {
    for (const l of ['fr', 'de', 'es', 'pt-BR', 'ja']) assert.equal(embedModelForLanguage(l), MULTILINGUAL_EMBED_MODEL, l);
    assert.equal(embedModelForLanguage('zh'), CHINESE_EMBED_MODEL);
  });
  test('the keys are the ones the Smart Connections transformers adapter lists', () => {
    assert.equal(MULTILINGUAL_EMBED_MODEL, 'onnx-community/embeddinggemma-300m-ONNX');
    assert.equal(DEFAULT_EMBED_MODEL, 'TaylorAI/bge-micro-v2');
  });
});

describe('applyLanguageToSmartEnv', () => {
  test('sets model and language consistently, keeps the rest, never mutates the input', () => {
    const before = JSON.stringify(SKELETON_ENV);
    const out = applyLanguageToSmartEnv(SKELETON_ENV, 'fr');
    assert.equal(JSON.stringify(SKELETON_ENV), before, 'input untouched');
    assert.equal(out.language, 'fr');
    assert.equal(out.smart_sources.embed_model.adapter, 'transformers');
    assert.equal(out.smart_sources.embed_model.transformers.model_key, MULTILINGUAL_EMBED_MODEL);
    assert.equal(out.smart_sources.min_chars, 200);
    assert.equal(out.new_user, true);
  });
  test('en leaves the skeleton model', () => {
    const out = applyLanguageToSmartEnv(SKELETON_ENV, 'en');
    assert.equal(out.smart_sources.embed_model.transformers.model_key, DEFAULT_EMBED_MODEL);
    assert.equal(out.language, 'en');
  });
  test('non-object input comes back as is', () => {
    assert.equal(applyLanguageToSmartEnv(null, 'fr'), null);
    assert.deepEqual(applyLanguageToSmartEnv([1], 'fr'), [1]);
  });
});

describe('detectDeclaredLanguage', () => {
  test('the bilingual convention in CLAUDE.md declares French', () => {
    const md = '# Vault\n\n## Bilingual convention (FR + EN, FR primary)\n\nThe user works in both.\n';
    assert.deepEqual(detectDeclaredLanguage({ claudeMd: md }).lang, 'fr');
  });
  test('a quoted or indented copy of the heading is not the convention', () => {
    const md = '# Vault\n\n    ## Bilingual convention (FR + EN, FR primary)\n';
    assert.equal(detectDeclaredLanguage({ claudeMd: md }), null);
  });
  test('Smart Connections settings language is used next', () => {
    assert.deepEqual(detectDeclaredLanguage({ smartConnectionsData: { language: 'de' } }), { lang: 'de', source: 'smart-connections data.json language' });
  });
  test('nothing declared → null', () => {
    assert.equal(detectDeclaredLanguage({ claudeMd: '# Vault\n', smartConnectionsData: {} }), null);
    assert.equal(detectDeclaredLanguage(), null);
  });
});
