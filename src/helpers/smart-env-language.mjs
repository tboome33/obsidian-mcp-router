/**
 * Which embedding model a freshly cloned `.smart-env` should carry, by the
 * vault's language.
 *
 * The skeleton's `.smart-env/smart_env.json` pins `TaylorAI/bge-micro-v2` with
 * `"language": "en"`. That model is English-only: on a French vault Smart
 * Connections still builds an index, and the neighbours it returns are mostly
 * noise. A non-English vault needs a multilingual model — and it has to be one
 * the Smart Connections transformers adapter actually lists, or the plugin
 * falls back or errors on first load.
 *
 * THE MODEL KEY IS NOT GUESSED. It was read, on 2026-09-24, from the adapter's
 * model table `transformers_models` in
 *   https://github.com/brianpetro/jsbrains/blob/ba80525b083cf515555cedbdc6294a2d0aa5da68/smart-embed-model/adapters/transformers.js
 * — the jsbrains commit Smart Connections 4.7.2 pins in its package.json
 * (https://github.com/brianpetro/obsidian-smart-connections/blob/main/package.json,
 * devDependencies.jsbrains). Of the 13 keys listed there, the only general
 * multilingual one is `onnx-community/embeddinggemma-300m-ONNX` (EmbeddingGemma,
 * trained on 100+ languages; 768 dims, 2,048 tokens). The other non-English
 * entry, `Xenova/jina-embeddings-v2-base-zh`, is Chinese/English only, so it is
 * used for `zh` alone. Re-read that table before changing either key.
 *
 * Only ever applied to a `.smart-env` the sync is CREATING — an existing one is
 * never touched (the caller keeps that rule; this module never sees a disk).
 */

import { isConventionInstalled } from './claude-md-conventions.mjs';
import { readVaultLanguages } from './convention-languages.mjs';

/** English-only default the skeleton ships. */
export const DEFAULT_EMBED_MODEL = 'TaylorAI/bge-micro-v2';
/** Multilingual model from the adapter's own table (see the header for the source). */
export const MULTILINGUAL_EMBED_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
/** Chinese/English bilingual entry of the same table. */
export const CHINESE_EMBED_MODEL = 'Xenova/jina-embeddings-v2-base-zh';

const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/**
 * Normalise a `--lang` value to its lowercase primary subtag (`fr-FR` → `fr`).
 * Returns null for anything that is not a language tag.
 */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!LANG_RE.test(v)) return null;
  return v.split('-')[0].toLowerCase();
}

/** The embedding model key for a language (null/`en` → the English default). */
export function embedModelForLanguage(lang) {
  const l = normalizeLang(lang ?? '') ?? 'en';
  if (l === 'en') return DEFAULT_EMBED_MODEL;
  if (l === 'zh') return CHINESE_EMBED_MODEL;
  return MULTILINGUAL_EMBED_MODEL;
}

/**
 * Return a COPY of a parsed smart_env.json set for `lang`: the transformers
 * model key and the top-level `language` field, consistently. Other fields are
 * kept as they are. A non-object input comes back unchanged.
 */
export function applyLanguageToSmartEnv(smartEnv, lang) {
  if (!smartEnv || typeof smartEnv !== 'object' || Array.isArray(smartEnv)) return smartEnv;
  const l = normalizeLang(lang ?? '') ?? 'en';
  const out = JSON.parse(JSON.stringify(smartEnv));
  out.language = l;
  out.smart_sources = out.smart_sources && typeof out.smart_sources === 'object' ? out.smart_sources : {};
  const em = out.smart_sources.embed_model && typeof out.smart_sources.embed_model === 'object'
    ? out.smart_sources.embed_model : {};
  em.adapter = 'transformers';
  em.transformers = { ...(em.transformers && typeof em.transformers === 'object' ? em.transformers : {}), model_key: embedModelForLanguage(l) };
  out.smart_sources.embed_model = em;
  return out;
}

// The identifying heading of skills/conventions/retired/bilingual.md, located
// with the SAME parser the conventions installer uses (an indented or quoted
// copy of the heading is not the convention). Retired on 2026-09-26 in favour
// of `languages`, but a vault not yet migrated still declares French with it.
const BILINGUAL_HEADING = '## Bilingual convention (FR + EN, FR primary)';

/**
 * The language a vault ALREADY declares, or null. Looked for, in order:
 *   1. the `languages` convention in its CLAUDE.md — its first code is the
 *      vault's primary language (a value the router cannot read counts as
 *      no declaration, and is reported by the conventions audit, not here);
 *   2. the RETIRED `bilingual` convention in its CLAUDE.md (FR primary, so
 *      `fr`) — a vault that has not migrated yet;
 *   3. a `language` field in Smart Connections' own settings
 *      (`.obsidian/plugins/smart-connections/data.json`), which older versions
 *      of the plugin kept there.
 *
 * @param {{claudeMd?: string|null, smartConnectionsData?: object|null}} input
 * @returns {{lang: string, source: string} | null}
 */
export function detectDeclaredLanguage({ claudeMd = null, smartConnectionsData = null } = {}) {
  if (typeof claudeMd === 'string') {
    const declared = readVaultLanguages(claudeMd);
    if (declared.installed && Array.isArray(declared.languages) && declared.languages.length > 0) {
      return { lang: declared.languages[0], source: `CLAUDE.md languages convention (${declared.languages.join(', ')})` };
    }
    if (isConventionInstalled(claudeMd, BILINGUAL_HEADING)) {
      return { lang: 'fr', source: 'CLAUDE.md bilingual convention (retired; FR primary)' };
    }
  }
  const scLang = smartConnectionsData && typeof smartConnectionsData === 'object'
    ? normalizeLang(smartConnectionsData.language ?? '') : null;
  if (scLang) return { lang: scLang, source: 'smart-connections data.json language' };
  return null;
}
