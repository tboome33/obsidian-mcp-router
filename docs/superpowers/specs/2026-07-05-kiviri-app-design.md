# Design — Kiviri, l'application SaaS (re-cadrage complet)

**Date** : 2026-07-05 · **Statut** : approuvé par Roland (brainstorming complet, ~15 décisions tranchées une à une) · **Session d'origine** : brainstorming Fable 5/Opus 4.8, à la suite du wizard local (spec 2026-07-03). Remplace le cadrage de `saas-web-app-roadmap` du 2026-06-07 sur tous les points listés ici.

## 1. Vision

Kiviri est une **plateforme de connaissance AI-native** : on y jette n'importe quelle source (texte, page web, vidéo, PDF, audio, image, voix) et elle devient de la **mémoire interrogeable, partout, y compris à la voix** — pour soi (Personal), sa famille (Family) ou ses projets d'entreprise (Enterprise). L'application web est **le foyer** ; l'Obsidian local du client **continue de fonctionner** grâce à une synchronisation bidirectionnelle que nous possédons de bout en bout. Le positionnement commercial reste : **on vend la mémoire hébergée, pas l'intelligence** — mais l'intelligence managée devient le cœur des offres payantes.

Élément différenciant face au marché : Kiviri est **la seule application de connaissance AI-native qui coexiste avec Obsidian** au lieu de demander de le quitter.

## 2. Décisions actées (brainstorming 2026-07-05)

| # | Question | Décision |
|---|---|---|
| D1 | Périmètre des roadmaps | `saas-web-app-roadmap` = **l'app cliente** (2 tracks : app-cœur + capacités IA). Tout le socle (auth, tenancy, orchestration, billing) est **possédé par `kiviri-roadmap`** (déjà livré P1-0→P1-5) et n'est plus re-décrit. |
| D2 | ToS / Selkies | L'app headless **remplace l'Obsidian streamé (Selkies) pour TOUS les clients** (viewer + éditeur). Le streaming ne reste que pour l'usage personnel de Roland. **Zéro risque ToS = contrainte dure.** |
| D3 | Stockage & sync | **Option 4** : store markdown **propre** (chiffré via `ow-crypt`) + **plugin « Kiviri Sync »** maison, bidirectionnel Obsidian local ↔ store (idéalement bâti sur les primitives `octagonal-wheels`). On possède les deux bouts ; **aucune rétro-ingénierie de LiveSync**. L'import (vault Obsidian zip/dossier + bundle OKF) est la rampe d'acquisition. |
| D4 | Qui édite | **Tout le monde édite** (Personal inclus) + Claude écrit via MCP. L'ancienne règle « Personal = viewer read-only » est **remplacée**. |
| D5 | Killer features IA | Mémoire always-on · ask-your-vault (RAG) · partage/collab · ingestion web/YouTube/PDF + auto-liaison · **audio longue durée avec diarisation** · **vidéo avec keyframes décrites par IA** · **PDF haute fidélité** (tables/images/schémas) · **OCR (DeepSeek)** · **traductions** · **interrogation vocale temps réel**. |
| D6 | Modèle de coût | 3 seaux : (A) inférence LLM, (B) compute spécialisé, (C) hosting. **Managed + ingestion lourde = TOUJOURS payants** ; c'est **nous qui choisissons les modèles** par fonctionnalité. Self-host quand le coût est fixe (Resonance, OCR sur GPU Dedibox), API tierces sinon. |
| D7 | BYO-key | Repositionné en **soupape des abonnés payants** : au dépassement du quota managed → acheter des crédits OU brancher sa clé. **Pas de BYO-key sur le gratuit** ; **jamais de BYO-key sur l'ingestion lourde** (modèles spécialisés multiples = trop complexe). |
| D8 | Offre gratuite | **UNE seule, solo** (« Kiviri Free ») : 1 utilisateur, 1 vault, petit quota (200 Mo par défaut), application complète (éditeur, recherche sémantique incluse), import autorisé dans le quota, **mode MCP activé** (son propre Claude), **zéro IA managed**, zéro ingestion lourde. Ouverture possible d'une IA gratuite le jour où une infra open-source à coût connu existe (ex. GLM). |
| D9 | Essais | Par édition payante : Personal **30 j** généreux, Family/Enterprise **14 j**, avec **dégustation managed** (ex. 100 opérations) gatée **carte bancaire on-file**. Fin d'essai = **redescente douce** vers le gratuit (données intactes ; lecture seule si dépassement de quota). **Dedicated : ni gratuit ni essai self-serve** (vente accompagnée). |
| D10 | Anti-farming | Défense en couches : (1) **structurel** — jamais d'IA managed gratuite ; (2) **SMS OTP** à l'inscription gratuite (mobile uniquement, préfixes VoIP refusés) ; (3) quotas durs + rate-limits ; (4) carte on-file pour tout taster managed. |
| D11 | Builder d'offres | **Constructeur d'offres no-code** dans la console opérateur : toute offre (gratuite/payante/essai) se crée et se modifie **sans coder** (BYO-key o/n, MCP o/n, nb vaults, disque, IA managed X ops/N jours, durée, etc.). |
| D12 | Console opérateur | Nom : **« Kiviri Control »**. Back-office inaccessible aux utilisateurs : builder d'offres, quotas, monitoring des vaults, statistiques, suivi mémoire, alertes. (La page d'accueil utilisateur s'appellera autrement — pas « dashboard opérateur ».) |
| D13 | Dedicated | **Variante logicielle restreinte** : pas de builder d'offres publiques ; sert à gérer utilisateurs/groupes/vaults d'UNE société sur SES serveurs. **Interdiction contractuelle (CGU) de concurrencer le SaaS.** |
| D14 | Collaboration | **Système à 3 étages** : (1) *prévention* — présence (« X édite cette note »), verrou de courtoisie avec expiration, non bloquant en dernier recours ; (2) *vérification avant écriture* — numéro de version par note, relecture avant toute écriture, écran de comparaison/fusion, **jamais d'écrasement silencieux** (même mécanique pour humains, Claude MCP, assistant intégré, Kiviri Sync) ; (3) *transaction* — écritures protégées nativement par Convex, **par fichier** (pas de verrou vault entier). **Google Docs (édition simultanée)** = phase Enterprise ultérieure via le composant Convex `prosemirror-sync`. |
| D15 | Collaboration vivante | Panneau accordéon **« qui est en ligne + sur quoi il travaille »** (2 niveaux de résumé : fichiers touchés [auto, gratuit] / résumé IA [option]) · **chat intégré** entre membres du vault · **détection IA de convergence de sujets** (via Resonance) qui invite deux utilisateurs à discuter. → Release 2. |
| D16 | Confidentialité présence | Visible **par défaut sur les vaults PARTAGÉS uniquement** ; **jamais** sur les vaults personnels ; **mode discret** activable ponctuellement. |
| D17 | Chatbot intégré | **Assistant complet dès le départ : il lit ET écrit librement.** Remplace la décision de juin « pas d'app chat à construire ». Réutilise **la boîte à outils du router** (les ~35 tools MCP) en interne — une seule boîte à outils, trois consommateurs (Claude externe via MCP, assistant intégré, voix future). Managed → payant. **Garde-fous produit obligatoires** : historique des modifications de l'assistant + annulation. |
| D18 | Éditeur | **Éditeur à blocs façon Notion** (famille ProseMirror) : blocs déplaçables, menu d'insertion « / », barre d'outils flottante, callouts — **strictement cantonné au markdown**. **Exigence non négociable** : aller-retour parfait (ouvrir + enregistrer sans toucher = fichier byte-identique), testé automatiquement — sinon Kiviri Sync génèrerait de faux diffs. Piste future : « **pages Kiviri** » à mise en page libre (type ContentBuilder), app-only, **non synchronisées** vers Obsidian. Mode source (à la Obsidian) possible plus tard en option. |
| D19 | Release 1 | **La promesse complète dès le premier jour**, Kiviri Sync inclus (voir §7). Trois garde-fous actés : le plugin se construit **en premier et en parallèle** ; **bêta privée** sur de vrais vaults avant la sortie ; périmètre v1 = **Obsidian de bureau** (mobile en suite rapide — les mobiles ont l'app web responsive). |

## 3. Architecture (vue d'ensemble)

```
┌─ App web Kiviri (TanStack Start) ──────────────────────────────┐
│  Éditeur à blocs (ProseMirror, markdown-strict)                 │
│  Assistant intégré (lit/écrit, outils du router en interne)     │
│  Présence · vérification avant écriture · écran de fusion       │
├─ Control plane (Convex self-host, EXISTANT P1-0→P1-5) ─────────┤
│  Auth (Better Auth) · orgs/membres/invitations · vaults ·       │
│  queue de provisioning + worker · Kiviri Control (builder)      │
├─ Moteur de connaissance ───────────────────────────────────────┤
│  Store markdown propre (chiffré ow-crypt) · router (35 tools) · │
│  Resonance (sémantique, self-host) · pipelines d'ingestion      │
├─ Périphérie ───────────────────────────────────────────────────┤
│  Plugin Kiviri Sync (Obsidian local ↔ store, bidirectionnel)    │
│  Mode MCP (le Claude de l'utilisateur ↔ ses vaults)             │
└─────────────────────────────────────────────────────────────────┘
```

Principe clé de réutilisation : **les outils du router sont LA boîte à outils unique** du système. Le Claude externe (MCP), l'assistant intégré et demain la voix appellent les mêmes primitives lire/écrire/chercher/ingérer — durcies et testées depuis des mois.

## 4. Collaboration — détail du contrat

- Toute écriture (humain, assistant, Claude MCP, Kiviri Sync) suit le même protocole : **relire → comparer la version → écrire en transaction**. En cas de divergence : fusion automatique si sections disjointes ; choix utilisateur sinon ; **copie-conflit en dernier recours**. Perte silencieuse = interdite.
- Le verrou d'édition de l'éditeur est un **verrou de courtoisie** (prévention) : il peut expirer sans danger car la vérification de version est le filet en dessous. Si un fichier verrouillé doit être modifié par une session Claude, la relecture pré-écriture détecte la modification manuelle et **l'avertissement arrive dans la conversation**.
- Les sessions Claude écrivent **au fil de l'eau** (pas un « grand enregistrement » de fin de session) ; chaque écriture unitaire est vérifiée et protégée.

## 5. Modèle économique — l'entonnoir

```
Kiviri Free (solo, SMS, MCP, app complète, petit quota, 0 managed)
  → Essai Personal 30 j (dégustation managed, carte on-file)
    → Personal payant (managed + quotas + soupape BYO-key)
      → Family (membres, vaults partagés, collaboration)
        → Enterprise (orgs, pool de vaults, édition simultanée)
          → Dedicated (vente accompagnée, variante restreinte, CGU no-compete)
```

Tous les paramètres d'offres sont des **valeurs par défaut modifiables sans code** dans Kiviri Control (D11) — la structure est figée, pas les nombres.

## 6. Les deux tracks de la roadmap applicative

**Track A — App-cœur** : store + adaptateur router → import (Obsidian + OKF) → éditeur à blocs + arborescence + wikilinks/backlinks + tags → recherche (texte + Resonance) → collaboration niveau 1 → Kiviri Sync → graphe → édition simultanée (Enterprise) → polish/mobile/sécurité.

**Track B — Capacités IA** (chaque pipeline = un chantier ; priorisées du plus proche de l'existant au plus lourd) :
- **IA-1** : mémoire always-on + ask-your-vault (RAG Resonance+LLM) + ingestion de base (web/YouTube/PDF, outils existants) + auto-liaison.
- **IA-2** : ingestion haute fidélité — PDF précis (tables/images/schémas), OCR (DeepSeek), traductions.
- **IA-3** : multimodal lourd — audio long + diarisation ; vidéo → keyframes sur changement de scène + description IA.
- **IA-4** : interrogation vocale temps réel (STT/TTS + RAG).
- **IA-5** : collaboration assistée (rejoint l'édition simultanée Enterprise).

## 7. Releases

**Release 1 — « la promesse complète »** : store propre + branchement router · import Obsidian/OKF · éditeur à blocs + arborescence + wikilinks/backlinks + tags + recherche texte/sémantique · mode MCP · **assistant intégré complet** (avec ingestion de base IA-1) · collaboration niveau 1 (présence + vérification + live) · gratuit/essais + builder v1 dans Kiviri Control · **Kiviri Sync (Obsidian bureau)**. Garde-fous D19 : plugin commencé en premier, bêta privée, mobile ensuite.

**Release 2** : Kiviri Sync mobile · collaboration vivante (panneau d'activité, chat intégré, détection de convergence) · IA-2 (haute fidélité).

**Releases 3+** : IA-3 (audio/vidéo) · IA-4 (voix) · graphe · édition simultanée Google Docs (Enterprise) · pages Kiviri à mise en page libre · export OKF payant · backups externes HDS.

## 8. Hors périmètre / questions ouvertes (niveau plan)

- Prix en euros (leviers connus : taille, membres, vaults, opérations managed — se modélisent dans le builder).
- Bibliothèque d'éditeur précise (Tiptap vs BlockNote…) — au plan d'implémentation, avec audit de licence.
- Fournisseur SMS ; modèles IA précis par fonctionnalité (c'est nous qui choisissons — D6).
- Détail protocolaire de Kiviri Sync (chunking, offline, conflits) — spec dédiée au moment de son plan.
- La question « structure des sous-organisations Enterprise » reste régie par `kiviri-account-model` (inchangée).

## 9. Décisions de juin REMPLACÉES par ce design

| Ancienne décision (notes de juin) | Remplacée par |
|---|---|
| « Personal = viewer read-only, aucune écriture manuelle » | D4 : tout le monde édite |
| « Pas d'app chat à construire (BYO client MCP) » | D17 : assistant intégré complet |
| « Enterprise = Obsidian streamé Selkies, 3 streams » | D2 : app headless pour tous ; Selkies = usage perso Roland |
| « BYO-key = zéro coût de tokens, cœur du modèle Personal » | D6/D7 : managed payant au cœur ; BYO-key = soupape des payants |
| Roadmap app P0-P8 du 2026-06-07 (backend headless LiveSync, CodeMirror) | D1/D3/D18 : tracks A/B, store propre + Kiviri Sync, éditeur à blocs |

## 10. Impact documentation (vault `opsidian-mcp-router et bridge`)

1. `wiki/obsidian-mcp-router-saas/saas-web-app-roadmap.md` — **réécrite** (2 tracks + releases + délégation).
2. `wiki/obsidian-mcp-router-saas/kiviri-roadmap.md` — bandeau daté + items Kiviri Control / builder / anti-farming / Dedicated.
3. `wiki/obsidian-mcp-router-saas/saas-editions-pricing.md` — section « Évolution 2026-07-05 » (gratuit/essais/BYO-key/managed).
4. Scaffolds : ligne de log + hot.
