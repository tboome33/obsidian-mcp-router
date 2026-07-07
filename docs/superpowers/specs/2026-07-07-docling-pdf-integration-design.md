# Design — Intégration Docling comme moteur PDF haute-fidélité (opt-in, en process)

**Date** : 2026-07-07 · **Statut** : approuvé par Roland (brainstorming complet, 3 questions tranchées) · **Session d'origine** : conversation Claude Code démarrée par l'étude du projet externe [[Docling]] (wiki/Divers/Docling/), affinée par recherche web ciblée (comparaison Mistral OCR/DeepSeek-OCR, puis MarkItDown).

## 1. But

Le router expose aujourd'hui 10 outils `*_to_markdown` qui enveloppent tous **MarkItDown** (Microsoft, `pdfminer.six` pour le PDF). Recherche menée dans cette conversation : sur PDF, MarkItDown ne fait **aucune** analyse de mise en page ni reconnaissance de tableau (`pdfminer.six` = extraction de flux de texte pure), alors que **Docling** (IBM Research / LF AI & Data Foundation, MIT) est spécifiquement conçu pour ça — preuves concrètes : un relevé bancaire PDF converti en *« liste de texte confuse »* par MarkItDown vs tableaux préservés par Docling ; issues GitHub du repo MarkItDown (#296, #41) corroborant l'absence de structure ; benchmark chiffré **88 % F1 (Docling) vs 82 % F1 (MarkItDown)**.

Sur DOCX/PPTX/XLSX en revanche, la même recherche montre l'**inverse** : les modèles différenciants de Docling (layout, TableFormer) sont « PDF-first » et ne s'appliquent pas aux formats Office natifs, où MarkItDown (parsing XML Office dédié, zéro dépendance ML) garde probablement l'avantage. **Décision de scope : PDF uniquement.**

Contrainte produit explicite de Roland : ce chantier doit vivre dans **le repo open-source public** (`obsidian-mcp-router`), pour que tout self-hoster qui installe le router en profite en utilisant **son propre CPU local** — pas un service tiers (`docling-serve` distant), qui ne serait pertinent que pour un déploiement SaaS à volume (hors scope ici).

## 2. Décisions actées (brainstorming 2026-07-07)

| # | Question | Décision |
|---|---|---|
| Q1 | Exposition sur le tool MCP | **Nouveau tool dédié `pdf_to_markdown_docling`**, indépendant de `pdf_to_markdown` (inchangé, reste MarkItDown). Pas de paramètre `engine` sur l'outil existant. |
| Q2 | Déclenchement de l'installation (venv Python + `pip install docling`, ~1-2 Go) | **`postinstall` conditionnel** — le hook `postinstall` existant appelle aussi le script d'install Docling, qui vérifie `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` en première ligne et sort immédiatement (coût zéro) si absent. Variable à positionner **avant** `npm install`. Inverse du modèle MarkItDown (opt-out) — Docling est **opt-in**. |
| Q3 | Structure du venv Python | **Venv séparé** (`.venv-docling`), pas partagé avec celui de MarkItDown — isolation des dépendances lourdes (PyTorch/ONNXRuntime/transformers) de l'arbre léger de MarkItDown, désinstallable indépendamment. |

Décisions héritées de la conversation (non re-débattues en brainstorming, déjà actées) :
- **Pipeline Docling standard uniquement** (layout + TableFormer + OCR pluggable) — pas le pipeline VLM (`Granite-Docling-258M`), pas les enrichissements opt-in (formule/code/image) : hors scope, coût/complexité non justifiés pour ce lot.
- **Docling fait bien de l'OCR** (Tesseract/EasyOCR/RapidOCR classiques, pas de LLM) — la distinction pertinente n'est pas « avec/sans OCR » mais « OCR classique vs OCR par VLM génératif » (Mistral OCR/DeepSeek-OCR restent supérieurs sur ce point précis, hors scope de ce lot).
- **Toujours listé, jamais de détection dynamique** : `pdf_to_markdown_docling` apparaît dans la liste des tools même si Docling n'est pas installé (cohérent avec le comportement existant de MarkItDown) — friendly error au call-time sinon.

## 3. Architecture

```
scripts/install-docling.mjs        (jumeau de scripts/install-markitdown.mjs)
src/markdownify/docling.mjs        (jumeau de src/markdownify/markitdown.mjs, plus simple)
src/tools/convert.mjs              (+ export pdfToMarkdownDocling)
src/index.mjs                      (+ enregistrement du 34ᵉ tool)
commands/pdf-to-markdown.md        (NOUVEAU — invoque pdf_to_markdown, tool déjà existant)
commands/pdf-to-markdown-docling.md (NOUVEAU — invoque pdf_to_markdown_docling, cf §4.5)
```

Flux d'installation :
```
npm install
  └─ postinstall
       ├─ node scripts/install-markitdown.mjs   (inconditionnel, existant, inchangé)
       └─ node scripts/install-docling.mjs      (NOUVEAU — no-op si OBSIDIAN_ROUTER_ENABLE_DOCLING≠1)
```

Flux d'appel :
```
Client MCP → pdf_to_markdown_docling(filepath)
  → assertPathAllowed(filepath)
  → resolveDoclingPath()  (.venv-docling/bin/docling → DOCLING_PATH env → PATH)
  → execFile(doclingPath, ['--', filepath, '--to', 'markdown', '--pipeline', 'standard'], { maxBuffer: 50 MB })
  → stdout → { text } → retourné tel quel (pas d'écriture vault, même contrat que les 10 tools existants)
```

## 4. Composants

### 4.1 `scripts/install-docling.mjs`

Même squelette que `scripts/install-markitdown.mjs`, avec ces différences :
- **Ligne 1 de `main()`** : si `process.env.OBSIDIAN_ROUTER_ENABLE_DOCLING !== '1'` → log discret (« Docling opt-in non activé — voir README pour l'activer ») → `process.exit(0)` immédiat, avant toute détection Python.
- **Venv** : `.venv-docling` (constante `VENV_DIR` distincte de celle de MarkItDown).
- **Détection Python** : réutilise `findPython()` tel quel (même plancher 3.10+).
- **Install** : `pip install docling` (pas d'extras `[vlm]`/`[asr]` — pipeline standard uniquement, cf. §2).
- **Jamais d'échec de `npm install`** : même politique que MarkItDown — warning + `exit 0` sur toute erreur (Python absent, pip qui échoue, etc.).
- **Marqueur d'idempotence** : vérifie l'existence du binaire `docling` dans `.venv-docling` avant de relancer l'install (même logique que `venvMarker` dans le script MarkItDown).

### 4.2 `src/markdownify/docling.mjs`

Plus simple que `markitdown.mjs` car `pdf_to_markdown_docling` ne prend qu'un `filepath` **local** (pas d'URL — même signature que `pdfToMarkdown` aujourd'hui) : pas besoin de `safeFetch`/garde SSRF/streaming-cap, qui sont spécifiques aux tools URL-input.

- `export async function toMarkdownDocling({ filePath, projectRoot })` :
  1. `assertPathAllowed(expandHome(filePath))` (réutilisé depuis `src/markdownify/utils.mjs`, même garde que les autres file-input tools).
  2. Résoudre le binaire (`resolveDoclingPath(projectRoot)` — nouvelle fonction dans `utils.mjs`, même forme que `resolveMarkitdownPath`) : `.venv-docling/bin/docling` (ou `Scripts\docling.exe` sur Windows) → env `DOCLING_PATH` → PATH.
  3. `execFileAsync(doclingPath, ['--', filePath, '--to', 'markdown', '--pipeline', 'standard'], { maxBuffer: 50 * 1024 * 1024 })` — le séparateur `--` empêche un nom de fichier commençant par `-` d'être interprété comme un flag (même garde que `runMarkitdown`). **À vérifier à l'implémentation** : confirmer via `docling --help` que `--` est bien supporté comme séparateur argv par le CLI Docling (basé sur Click/argparse comme la plupart des CLI Python modernes, mais non testé empiriquement pour ce projet précis).
  4. Erreur `ENOENT` → message actionnable : « docling introuvable — positionner `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` puis relancer le script d'installation (voir README), ou définir `DOCLING_PATH`. »
  5. Retourne `{ text: stdout }`.

Pas de fichier temporaire à gérer (contrairement au chemin URL de `markitdown.mjs`) puisque l'entrée est déjà un fichier local.

### 4.3 `src/tools/convert.mjs`

```
export async function pdfToMarkdownDocling(_registry, { filepath } = {}) {
  return convertFileDocling(filepath);
}
```
avec un petit `convertFileDocling` miroir de `convertFile` mais appelant `toMarkdownDocling` au lieu de `toMarkdown`.

### 4.4 `src/index.mjs`

Nouvel enregistrement de tool (34ᵉ), description honnête sur le modèle des autres :
> « Convert a local PDF to markdown via Docling's standard pipeline (layout + table-structure recognition) — higher fidelity than `pdf_to_markdown` on complex tables/layouts, at ~10x the CPU cost. Requires opt-in install: set `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` before `npm install`, or re-run the install script manually. »

Pas dans `WRITE_TOOL_NAMES` (mêmes raisons que les 10 tools existants : lecture seule, pas de mutation de vault).

### 4.5 Slash commands (ajout 2026-07-07, demandé par Roland)

Aucun des 10 tools `*_to_markdown` n'a de slash command aujourd'hui — les commandes existantes (`commands/*.md`) enveloppent des skills, pas des tools bruts. Ce lot en ajoute deux, sur le même modèle terse que les commandes existantes (frontmatter `description:` + instruction courte, pas de couche skill puisqu'aucune n'existe pour ces convertisseurs) :

- **`commands/pdf-to-markdown.md`** → invoque le tool `pdf_to_markdown` (MarkItDown, existant). Peut être créé indépendamment du reste (le tool existe déjà).
- **`commands/pdf-to-markdown-docling.md`** → invoque `pdf_to_markdown_docling` (§4.3-4.4). Doit être livré **avec** le tool (referencer un tool pas encore implémenté serait cassé).

Invocation résultante : `/obsidian-router:pdf-to-markdown` et `/obsidian-router:pdf-to-markdown-docling` (le préfixe `obsidian-router:` vient du namespace du plugin, pas du nom de fichier). Chaque description renvoie vers l'autre commande pour aider au choix (rapide/léger vs haute-fidélité/lent).

## 5. Comportement d'erreur

- **Non installé** (`.venv-docling` absent) : message actionnable au call-time (cf §4.2.4), tool listé quand même.
- **Python absent au moment de l'install** : warning côté `npm install`, pas de blocage, tool échoue proprement plus tard.
- **`docling` échoue sur un PDF donné** (corrompu, format non supporté) : l'erreur stderr de Docling est propagée dans le message (pas de tentative de fallback silencieux vers MarkItDown — le caller choisit explicitement quel tool appeler, donc pas de fallback caché entre les deux).

## 6. Tests

Nouveau fichier `tests/docling-markdownify.test.mjs`, miroir de `tests/markdownify.test.mjs` :
- Injection de dépendances pour mocker `execFile` (pas de vrai appel Docling en CI — cohérent avec la suite existante qui ne teste jamais markitdown/repomix en conditions réelles).
- Cas couverts : chemin heureux (stdout → `{ text }`), fichier hors `MD_ALLOWED_PATHS` (rejeté par `assertPathAllowed`), binaire introuvable (message ENOENT actionnable), argv anti-injection (nom de fichier commençant par `-`).
- Nouveau test pour `scripts/install-docling.mjs` : vérifie le no-op immédiat quand `OBSIDIAN_ROUTER_ENABLE_DOCLING` n'est pas `'1'` (mirroring `tests/install-hooks.test.mjs` si pertinent, sinon nouveau fichier dédié).

## 7. Hors scope (explicitement écarté pour ce lot)

- Pipeline VLM Docling (`Granite-Docling-258M`) et enrichissements opt-in (formule/code/image) — cf §2.
- `docx_to_markdown_docling` / `pptx_to_markdown_docling` / `xlsx_to_markdown_docling` — aucun avantage démontré vs MarkItDown sur ces formats (cf §1).
- Mode `docling-serve` distant / conteneur séparé — pertinent uniquement pour un futur usage SaaS (Kiviri), pas pour le produit open-source par défaut.
- Détection dynamique du tool au démarrage (apparaître/disparaître selon l'installation) — cohérence avec le comportement MarkItDown existant (toujours listé).

## Voir aussi

- [[Docling]] (wiki/Divers/Docling/) — étude complète du projet, benchmarks, sources
- [[roadmap-emprunts]] §2.12 — emprunt documenté dans le fichier maître des emprunts externes
