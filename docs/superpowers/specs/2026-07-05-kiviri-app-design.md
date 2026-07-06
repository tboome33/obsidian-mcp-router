# Design — Kiviri, l'application SaaS (re-cadrage complet)

**Date** : 2026-07-05. **Statut** : approuvé par Roland, à l'issue d'un brainstorming complet où chacune des 25 décisions ci-dessous a été tranchée une à une (session d'origine : Fable 5 / Opus 4.8, à la suite du wizard local du 2026-07-03). Ce document remplace le cadrage de `saas-web-app-roadmap` daté du 2026-06-07 sur tous les points listés ici — là où les deux se contredisent, c'est CE document qui fait foi.

**Comment lire cette page** : chaque décision porte un numéro (D1 à D25) qui sert de référence permanente partout ailleurs — dans les roadmaps, dans les commits, dans les conversations. Ces numéros ne changent jamais. Pour un repère rapide, un tableau des sujets suit juste après la vision ; pour comprendre le raisonnement complet derrière chaque décision, la version détaillée vient ensuite.

## 1. Vision

Kiviri est une **plateforme de connaissance AI-native** : on y jette n'importe quelle source — texte, page web, vidéo, PDF, audio, image, voix — et elle devient de la **mémoire interrogeable, partout, y compris à la voix**. Ça marche pour soi tout seul (édition Personal), pour sa famille (édition Family) ou pour les projets d'une entreprise (édition Enterprise). L'application web est **le foyer** : c'est là que tout se passe. Mais l'Obsidian local du client **continue de fonctionner normalement**, grâce à une synchronisation bidirectionnelle que nous construisons et possédons de bout en bout — personne d'autre n'est dans la boucle. Le positionnement commercial reste inchangé : **on vend la mémoire hébergée, pas l'intelligence artificielle en elle-même** — mais l'intelligence gérée par nous (« managed ») devient le cœur de ce que les offres payantes apportent en plus.

L'élément qui nous différencie vraiment du marché : Kiviri est **la seule application de connaissance AI-native qui coexiste avec Obsidian**, au lieu de demander au client de le quitter.

## 2. Les 25 décisions retenues (brainstorming du 2026-07-05)

### Repère rapide

| D# | Sujet en un mot |
|---|---|
| D1 | Qui décrit quoi, entre cette page et les roadmaps existantes |
| D2 | Fin du streaming Obsidian pour les clients (raison : les conditions d'utilisation d'Obsidian) |
| D3 | Comment on stocke et on synchronise les notes |
| D4 | Qui a le droit d'éditer |
| D5 | Les fonctionnalités IA qui nous différencient |
| D6 | Comment on pense les coûts d'infrastructure |
| D7 | La règle du "apporte ta propre clé API" |
| D8 | Ce que contient l'offre gratuite |
| D9 | Comment fonctionnent les essais gratuits |
| D10 | Comment on empêche les abus de l'offre gratuite |
| D11 | Le constructeur d'offres sans code |
| D12 | Le nom et le rôle de la console d'administration |
| D13 | Ce qu'est l'offre Dedicated |
| D14 | Comment la collaboration évite de perdre le travail de quelqu'un |
| D15 | Les fonctionnalités de collaboration "vivante" (Release 2) |
| D16 | Qui voit la présence de qui |
| D17 | L'assistant conversationnel intégré à l'application |
| D18 | L'éditeur de notes et sa contrainte technique la plus dure |
| D19 | Les garde-fous de la Release 1 |
| D20 | La grille tarifaire |
| D21 | Ce qui se passe quand on dépasse son forfait |
| D22 | Quel modèle IA fait quoi |
| D23 | La messagerie vocale entre membres d'un vault |
| D24 | Comment le volume d'usage se partage dans une équipe |
| D25 | Le mode fusion : plusieurs IA qui débattent |

### Le détail de chaque décision

**D1 — Qui décrit quoi.** La roadmap `saas-web-app-roadmap` couvre désormais uniquement **l'application cliente** (répartie en deux volets : l'app-cœur d'un côté, les capacités IA de l'autre). Tout le socle qui fait déjà tourner le produit — l'authentification, le cloisonnement entre organisations (la « tenancy »), l'orchestration technique, la facturation — est **entièrement possédé par `kiviri-roadmap`**, où il a déjà été livré en phases P1-0 à P1-5. Ce socle n'est donc plus redécrit ici.

**D2 — Fin du streaming Obsidian pour les clients.** L'application headless (c'est-à-dire sans passer par un Obsidian qui tourne réellement quelque part) **remplace le streaming Obsidian existant (la techno « Selkies ») pour TOUS les clients**, aussi bien en lecture qu'en écriture. Le streaming ne reste utilisé que pour l'usage personnel de Roland. Cette bascule est non négociable : **zéro risque vis-à-vis des conditions d'utilisation d'Obsidian**, qui interdisent d'héberger l'application elle-même comme un service.

**D3 — Comment on stocke et on synchronise les notes.** L'option retenue (parmi 4 étudiées) : on construit notre **propre store de notes au format markdown**, chiffré grâce à `ow-crypt` (notre implémentation du chiffrement utilisé par la bibliothèque octagonal-wheels), plus un **plugin maison baptisé « Kiviri Sync »**, qui synchronise dans les deux sens entre l'Obsidian du poste local et ce store — idéalement en s'appuyant sur les primitives déjà éprouvées de la bibliothèque `octagonal-wheels`. On possède ainsi les deux extrémités du système, et surtout : **aucune retro-ingénierie du protocole de synchronisation de LiveSync** (le plugin tiers existant) — on ne copie pas son fonctionnement interne, on écrit le nôtre. L'import — un vault Obsidian en zip ou en dossier, ou un bundle au format d'échange OKF — devient la rampe d'acquisition des nouveaux clients.

**D4 — Qui a le droit d'éditer.** **Tout le monde édite**, y compris sur l'offre Personal, et Claude peut lui aussi écrire via MCP. L'ancienne règle de juin, qui limitait l'offre Personal à de la simple lecture sans aucune écriture manuelle, est **remplacée** par celle-ci.

**D5 — Les fonctionnalités IA qui nous différencient.** Une mémoire toujours disponible · la capacité d'interroger son propre vault en langage naturel (recherche augmentée par récupération de contexte, dite RAG) · le partage et la collaboration · l'ingestion de pages web, de vidéos YouTube et de PDF avec auto-liaison vers les notes existantes · l'**audio de longue durée avec reconnaissance des différents interlocuteurs** (diarisation) · la **vidéo dont l'IA décrit les images-clés** · le **PDF haute fidélité** qui préserve tableaux, images et schémas · l'**OCR** (reconnaissance de texte dans une image, via DeepSeek) · les **traductions** · et l'**interrogation vocale en temps réel**.

**D6 — Comment on pense les coûts d'infrastructure.** Trois catégories de coûts à distinguer : (A) l'inférence des modèles de langage, (B) le calcul spécialisé (transcription, OCR…), (C) l'hébergement. Règle simple : **tout ce qui est géré par nous (« managed ») et toute ingestion lourde sont TOUJOURS des fonctionnalités payantes** — et c'est **nous qui choisissons les modèles** utilisés pour chaque fonctionnalité, pas le client. On héberge nous-mêmes quand le coût est fixe et prévisible (les embeddings de la recherche sémantique, l'OCR sur GPU sur la Dedibox) ; on passe par des API tierces dans les autres cas.

**D7 — La règle du "apporte ta propre clé API" (BYO-key).** Cette option est **réservée aux abonnés payants** — ce n'est en aucun cas une façon d'éviter de payer un abonnement (précision apportée par Roland le 2026-07-05). Elle sert à l'abonné qui dépasse son forfait et **ne veut pas monter de niveau** (les niveaux vont de X1 à X5 puis X20), ou qui est **déjà au niveau maximum X20**. Il ne faut pas confondre cette option avec le **mode MCP** (le Claude personnel du client, utilisé côté client — c'est ça, la vraie porte d'entrée gratuite). Il n'y a **pas de BYO-key sur l'offre gratuite**, et **jamais de BYO-key sur l'ingestion lourde** (parce que gérer plusieurs modèles spécialisés différents serait beaucoup trop complexe à faire fonctionner avec la clé personnelle de chacun).

**D8 — Ce que contient l'offre gratuite.** **Une seule offre gratuite existe** : un compte Personal solo, au niveau gratuit (baptisé « Kiviri Free », précision du 2026-07-05) — un seul utilisateur, un seul vault, un petit quota de stockage (200 Mo par défaut). Dans cette offre, **l'application se comporte comme un lecteur avec des modifications strictement MANUELLES** : l'éditeur à blocs complet est disponible pour écrire à la main, la recherche sémantique locale est incluse (elle est self-hébergée, donc son coût est fixe), et l'import de notes existantes rentre dans le quota. Mais **aucune fonctionnalité IA n'existe dans l'application** : pas d'assistant intégré, pas d'ingestion automatique, pas de RAG, pas de BYO-key. L'intelligence artificielle de l'offre gratuite, c'est **le propre compte Claude personnel de l'utilisateur, utilisé via MCP**, côté client. Une IA gratuite DANS l'application pourrait un jour devenir possible, si une infrastructure open-source à coût connu et maîtrisé apparaît (par exemple un modèle comme GLM).

**D9 — Comment fonctionnent les essais gratuits.** Chaque édition payante propose un essai : Personal bénéficie de **30 jours**, généreux ; Family et Enterprise ont **14 jours**. Chaque essai inclut une **dégustation des fonctionnalités managées** (par exemple 100 opérations), mais celle-ci est conditionnée à l'enregistrement préalable d'une **carte bancaire**. À la fin de l'essai, la redescente est **douce** : le compte repasse au niveau gratuit, les données restent intactes, et l'accès passe en lecture seule uniquement si le quota gratuit est dépassé. L'offre Dedicated ne propose **ni offre gratuite ni essai en libre-service** — elle se vend toujours accompagnée par une personne.

**D10 — Comment on empêche les abus de l'offre gratuite.** La défense est construite en plusieurs couches : (1) une protection **structurelle**, puisqu'il n'existe jamais d'IA gérée gratuitement ; (2) une **vérification par SMS** à l'inscription gratuite, réservée aux numéros de téléphone mobiles (les préfixes de téléphonie VoIP sont explicitement refusés) ; (3) des **quotas stricts et des limites de fréquence** ; (4) l'obligation d'enregistrer une **carte bancaire** pour goûter à quoi que ce soit de géré par nous.

**D11 — Le constructeur d'offres sans code.** La console d'administration embarque un **constructeur d'offres qui ne demande aucun code** : n'importe quelle offre — gratuite, payante, ou d'essai — se crée et se modifie sans toucher au code : autoriser ou non le BYO-key, autoriser ou non le mode MCP, le nombre de vaults, l'espace disque, le volume d'IA gérée (X opérations sur N jours), la durée de l'offre, et ainsi de suite.

**D12 — Le nom et le rôle de la console d'administration.** Cette console s'appelle **« Kiviri Control »**. C'est un back-office totalement inaccessible aux utilisateurs finaux : on y trouve le constructeur d'offres, la gestion des quotas, la surveillance des vaults, les statistiques, le suivi de la mémoire consommée, et les alertes. (La page d'accueil que voient les utilisateurs porte un autre nom — surtout pas « tableau de bord opérateur ».)

**D13 — Ce qu'est l'offre Dedicated.** C'est une **variante logicielle restreinte** du produit : elle n'a pas de constructeur d'offres publiques, et sert uniquement à gérer les utilisateurs, les groupes et les vaults **d'une seule société**, sur **ses propres serveurs**. Une clause contractuelle (dans les conditions générales) **interdit à cette société d'utiliser Dedicated pour concurrencer notre propre offre SaaS**.

**D14 — Comment la collaboration évite de perdre le travail de quelqu'un.** Le système comporte **trois étages**, empilés du plus léger au plus solide :
1. **La prévention** : une présence visible (« untel est en train d'éditer cette note ») et un verrou dit « de courtoisie », qui expire tout seul et qui ne bloque jamais réellement en dernier recours.
2. **La vérification avant écriture** : chaque note porte un numéro de version ; avant d'écrire quoi que ce soit, on relit ce numéro, on le compare, et on affiche un écran de comparaison/fusion si besoin. **On n'écrase jamais silencieusement le travail de quelqu'un** — cette règle est strictement la même, que l'écrivain soit un humain, Claude via MCP, l'assistant intégré, ou le plugin Kiviri Sync.
3. **La transaction** : chaque écriture est protégée nativement par Convex, **fichier par fichier** — jamais un verrou qui bloquerait le vault entier.

L'édition simultanée façon Google Docs (plusieurs personnes qui tapent dans le même document en même temps) est prévue, mais seulement dans une phase Enterprise ultérieure, via le composant Convex `prosemirror-sync`.

**D15 — Les fonctionnalités de collaboration "vivante" (prévues pour la Release 2).** Un panneau déroulant qui montre **qui est en ligne et sur quoi il travaille**, avec deux niveaux de détail (les fichiers touchés, affichés automatiquement et gratuitement ; ou un résumé généré par IA, en option). S'y ajoutent un **chat intégré** entre les membres d'un même vault, et une **détection par IA des sujets qui convergent** (grâce aux embeddings de la recherche sémantique locale), qui invite alors deux utilisateurs à en discuter ensemble.

**D16 — Qui voit la présence de qui.** La présence n'est visible **par défaut que sur les vaults partagés** — jamais sur un vault strictement personnel — et un **mode discret** peut être activé ponctuellement pour disparaître de cet affichage.

**D17 — L'assistant conversationnel intégré à l'application.** Dès le premier jour, un **assistant complet** est disponible : il **lit ET écrit librement** dans le vault. Cette décision remplace celle de juin, qui disait qu'on ne construirait pas d'application de chat. Cet assistant réutilise **la même boîte à outils que le router** (les ~35 outils MCP existants) en interne : une seule boîte à outils, pour trois façons différentes d'y accéder — le Claude externe du client via MCP, cet assistant intégré, et plus tard la voix. Son usage géré par nous est payant. Deux garde-fous produit sont **obligatoires** : un historique complet de ses modifications, et la possibilité de les annuler.

**D18 — L'éditeur de notes et sa contrainte technique la plus dure.** L'éditeur ressemble à un éditeur à blocs façon Notion (de la famille ProseMirror) : des blocs qu'on peut déplacer, un menu d'insertion via la touche « / », une barre d'outils flottante, des encadrés colorés (callouts) — mais il reste **strictement cantonné au format markdown** en coulisses. L'exigence est **non négociable** : si on ouvre une note puis qu'on l'enregistre **sans rien avoir touché**, le fichier doit ressortir **octet pour octet identique** à ce qu'il était avant — et ce comportement est testé automatiquement. Sans cette garantie, le plugin Kiviri Sync verrait des différences qui n'existent pas vraiment à chaque ouverture de note. Une piste pour plus tard : des « **pages Kiviri** » à mise en page totalement libre (façon ContentBuilder), réservées à l'application, **jamais synchronisées** vers Obsidian. Un mode « source », à la façon d'Obsidian, pourrait aussi devenir une option plus tard.

**D19 — Les garde-fous de la Release 1.** La promesse est **complète dès le premier jour**, Kiviri Sync inclus (le détail est au §7 plus bas). Trois garde-fous ont été actés : le plugin de synchronisation se construit **en premier et en parallèle** de tout le reste ; une **bêta privée** sur de vrais vaults a lieu avant toute sortie publique ; et le périmètre de la version 1 se limite à **l'Obsidian de bureau** — le mobile suit juste après, en parallèle rapide (les mobiles ont de toute façon accès à l'application web, qui est déjà responsive).

**D20 — La grille tarifaire.** Le principe est **Édition × Niveau d'usage** : chaque édition (Personal, Family, Enterprise) existe en trois niveaux — **X1, X5, X20** — qui offrent exactement les mêmes fonctionnalités, mais avec un volume d'usage IA multiplié d'autant (le même principe que les forfaits Claude Pro et Max). L'offre Dedicated reste **hors de cette grille** : elle se négocie sur-mesure. Le constructeur d'offres de Kiviri Control ne gère, au fond, qu'un simple multiplicateur.

**D21 — Ce qui se passe quand on dépasse son forfait.** Les limites sont **hebdomadaires**, par famille de capacité (l'assistant du quotidien d'un côté, les capacités les plus lourdes de l'autre), affichées avec des barres de progression et une date de réinitialisation visible (une expérience utilisateur inspirée de celle de Claude — une capture de référence a été prise le 2026-07-05). En cas de dépassement, la cascade proposée à l'utilisateur suit toujours le même ordre : **d'abord monter de niveau** (X1→X5→X20), **puis des crédits d'utilisation** à la consommation (en option), **puis enfin le BYO-key** — réservé aux abonnés, comme vu en D7. **Jamais de blocage brutal.**

**D22 — Quel modèle IA fait quoi.** Les choix actuels (configurables dans Kiviri Control, sans code, parce que les modèles évoluent) : **OCR** = Mistral OCR ou DeepSeek OCR (le choix définitif se fera par comparaison au moment du plan d'implémentation) · **voix pendant une session** = GPT Realtime · **traduction vocale entre deux utilisateurs** = GPT Realtime, en mode traduction · **transcription en temps réel** = Whisper ou GPT Realtime.

**D23 — La messagerie vocale entre membres d'un vault.** Un prolongement de D15 : les membres d'un même vault peuvent **se parler à la voix directement dans l'application**, avec une **traduction en direct** (chacun peut parler dans sa propre langue) et une **transcription en temps réel** — cette transcription peut ensuite être **enregistrée comme une note du vault**, ce qui transforme une réunion vocale en mémoire durable.

**D24 — Comment le volume d'usage se partage dans une équipe.** En Family et en Enterprise, le volume hebdomadaire est un **pool partagé par toute l'organisation**, avec un **plafond équitable par membre** (par défaut environ 50 % du pool total, réglable dans Kiviri Control). La consommation de chaque membre reste visible par l'administrateur de l'organisation.

**D25 — Le mode fusion : plusieurs IA qui débattent.** Une fonctionnalité avancée et payante (une opération premium, comptée cher dans le quota) : sur un sujet complexe, **trois modèles de langage débattent** — chacun répond d'abord indépendamment, puis les réponses se critiquent mutuellement de façon anonymisée, sur plusieurs tours — et un **modèle-juge tranche** à la fin. L'orchestration de ce débat (la boucle qui l'anime) est **notre propre code**, dans le backend de Kiviri — une boucle volontairement modeste, sur le modèle public du projet `llm-council` de Karpathy. Le juge est **GLM 5.2, appelé via son API commerciale** (précision du 2026-07-05 : l'héberger nous-mêmes serait irréaliste, puisque c'est un immense modèle à mélange d'experts dont l'infrastructure coûterait beaucoup trop cher ; l'API de GLM figure parmi les moins chères du marché, donc le rôle qui consomme le plus de tokens reste sur le meilleur rapport qualité-prix). ⚠️ Attention à la distinction : c'est bien une **API commerciale**, pas un abonnement grand public — exactement la même règle « zéro risque conditions d'utilisation » que pour Obsidian ; l'abonnement GLM grand public reste réservé à l'usage personnel de Roland. La passerelle vers les différents modèles passe par **OpenRouter, utilisé comme un simple tuyau** : une seule intégration pour tous les modèles, qui n'orchestre rien lui-même et reste interchangeable. Ce qui nous différencie : le débat est **ancré dans le vault du client** — les débatteurs reçoivent le contexte pertinent des notes existantes via la recherche sémantique locale — et le **verdict final peut être enregistré comme une note**, avec les arguments des deux camps. Les panels de modèles et le nombre de tours se configurent dans Kiviri Control. Le serveur Fusion personnel de Roland reste une source d'inspiration pour l'expérience utilisateur (les préréglages, les fourchettes de coût, la délibération asynchrone) — ce n'est pas une dépendance technique.

## 3. Architecture (vue d'ensemble)

Le schéma ci-dessous montre les quatre grandes couches du système, de l'application que voit le client jusqu'au plugin qui tourne sur son poste :

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
│  recherche sémantique locale (embeddings self-hostés) · pipelines d'ingestion      │
├─ Périphérie ───────────────────────────────────────────────────┤
│  Plugin Kiviri Sync (Obsidian local ↔ store, bidirectionnel)    │
│  Mode MCP (le Claude de l'utilisateur ↔ ses vaults)             │
└─────────────────────────────────────────────────────────────────┘
```

Le principe de réutilisation le plus important à retenir : **les outils du router forment LA boîte à outils unique** de tout le système. Le Claude externe du client (via MCP), l'assistant intégré, et demain la voix, appellent tous les mêmes primitives — lire, écrire, chercher, ingérer — qui sont durcies et testées depuis des mois.

## 4. Collaboration — le détail du contrat

Trois règles précises complètent le système à 3 étages décrit en D14 :

- **Toute écriture, peu importe qui l'initie** (un humain, l'assistant, Claude via MCP, ou Kiviri Sync), suit exactement le même protocole : **relire → comparer la version → écrire en transaction**. En cas de divergence entre deux versions : une fusion automatique a lieu si les deux modifications touchent des sections différentes de la note ; sinon, l'utilisateur choisit ; et en tout dernier recours, une **copie-conflit** est créée. La perte silencieuse de contenu est **strictement interdite**, dans tous les cas.
- Le verrou d'édition posé par l'éditeur est un **verrou de courtoisie**, purement préventif : il peut expirer sans danger, parce que la vérification de version reste le filet de sécurité en dessous. Si une session Claude doit modifier un fichier verrouillé par quelqu'un d'autre, la relecture qui précède toute écriture détecte cette modification manuelle, et **l'avertissement remonte directement dans la conversation** avec l'utilisateur.
- Les sessions Claude écrivent **au fil de l'eau**, écriture par écriture, plutôt que d'accumuler tout le travail dans un unique « grand enregistrement » de fin de session. Chaque écriture unitaire est vérifiée et protégée individuellement.

## 5. Modèle économique — l'entonnoir

Voici le parcours complet d'un client, de sa toute première inscription gratuite jusqu'à l'offre la plus avancée :

```
Kiviri Free (solo, SMS, MCP, app complète, petit quota, 0 managed)
  → Essai Personal 30 j (dégustation managed, carte on-file)
    → Personal payant (managed + quotas + soupape BYO-key)
      → Family (membres, vaults partagés, collaboration)
        → Enterprise (orgs, pool de vaults, édition simultanée)
          → Dedicated (vente accompagnée, variante restreinte, CGU no-compete)
```

Tous les paramètres de ces offres sont des **valeurs par défaut, modifiables sans écrire une ligne de code** depuis Kiviri Control (D11) — c'est la structure de l'entonnoir qui est figée, pas les chiffres qui la remplissent.

**Le modèle d'usage** (croisement des décisions D20, D21 et D24) : la grille est **Édition × Niveau (X1/X5/X20)** — l'édition détermine les capacités disponibles, le niveau détermine le volume d'IA. Les limites sont **hebdomadaires, par famille de capacité**, affichées avec des barres de progression et une date de réinitialisation. Au moment du dépassement, la cascade propose d'abord des **crédits d'utilisation**, puis le **BYO-key**. En Family et en Enterprise, ce volume est un **pool partagé par l'organisation**, avec un plafond équitable par membre.

## 6. Les deux tracks de la roadmap applicative

**Track A — l'app-cœur.** L'ordre de construction suit une logique de fondations : d'abord le store de notes et l'adaptateur qui le relie au router → puis l'import (depuis un vault Obsidian ou depuis un bundle OKF) → puis l'éditeur à blocs avec son arborescence, ses wikilinks/backlinks et ses tags → puis la recherche (texte et sémantique locale) → puis le premier niveau de collaboration → puis Kiviri Sync → puis le graphe de connaissances → puis l'édition simultanée réservée à Enterprise → et enfin les finitions (interface, mobile, sécurité).

**Track B — les capacités IA.** Chaque capacité forme son propre chantier ; l'ordre va du plus proche de ce qui existe déjà vers le plus lourd à construire :
- **IA-1** : la mémoire toujours disponible + interroger son vault en langage naturel (RAG : embeddings locaux combinés à un modèle de langage) + l'ingestion de base (web, YouTube, PDF, via les outils déjà existants) + l'auto-liaison entre notes proches.
- **IA-2** : l'ingestion haute fidélité — un PDF fidèle qui préserve tableaux, images et schémas, l'OCR (via DeepSeek), et les traductions.
- **IA-3** : le multimodal lourd — l'audio de longue durée avec reconnaissance des interlocuteurs (diarisation), et la vidéo découpée en images-clés décrites par l'IA à chaque changement de scène.
- **IA-4** : l'interrogation vocale en temps réel (GPT Realtime combiné au RAG), plus la **voix entre utilisateurs dans la messagerie** (décision D23) — conversation vocale, traduction en direct, transcription en temps réel enregistrable comme note du vault. Les modèles utilisés se configurent dans Kiviri Control (décision D22).
- **IA-5** : la collaboration assistée par IA, qui rejoint l'édition simultanée réservée à Enterprise.
- **IA-6** : le **mode fusion** (décision D25) — le débat arbitré entre plusieurs modèles de langage, ancré dans le vault du client, dont le verdict peut être enregistré comme une note. Orchestrateur maison, juge GLM appelé via API, OpenRouter en simple tuyau.

## 7. Les releases

**Release 1 — « la promesse complète ».** Elle réunit : le store de notes propre avec le router branché dessus · l'import depuis Obsidian ou depuis OKF · l'éditeur à blocs avec son arborescence, ses wikilinks/backlinks, ses tags, et sa recherche texte/sémantique · le mode MCP · un **assistant intégré complet** (avec l'ingestion de base d'IA-1) · le premier niveau de collaboration (présence + vérification avant écriture + mises à jour live) · l'offre gratuite et les essais, avec une première version du constructeur d'offres dans Kiviri Control · et **Kiviri Sync pour Obsidian de bureau**. Les garde-fous de D19 s'appliquent : le plugin de synchronisation démarre en premier, une bêta privée précède la sortie, et le mobile suit ensuite.

**Release 2.** Kiviri Sync s'étend au mobile · la collaboration « vivante » arrive (le panneau d'activité, le chat intégré, la détection de convergence de sujets) · IA-2 (l'ingestion haute fidélité) est livrée.

**Releases 3 et suivantes.** IA-3 (audio et vidéo) · IA-4 (la voix) · **IA-6 (le mode fusion)** · le graphe de connaissances · l'édition simultanée façon Google Docs pour Enterprise · les pages Kiviri à mise en page libre · l'export au format OKF, en option payante · les sauvegardes externes conformes HDS (Hébergeur de Données de Santé).

## 8. Ce qui reste hors périmètre, ou en question ouverte (au niveau du plan)

- Les prix en euros ne sont pas encore fixés (les leviers connus sont la taille, le nombre de membres, le nombre de vaults, et le volume d'opérations gérées par nous — ils se modéliseront directement dans le constructeur d'offres).
- Le choix précis de la bibliothèque d'éditeur (Tiptap contre BlockNote, par exemple) attend le plan d'implémentation, avec un audit de licence à l'appui.
- Le choix du fournisseur SMS, et les modèles IA précis retenus pour chaque fonctionnalité, restent à trancher — mais rappel : c'est nous qui choisissons ces modèles (décision D6), pas le client.
- Le détail protocolaire de Kiviri Sync (comment on découpe les données, comment on gère le hors-ligne, comment on résout les conflits) fera l'objet d'une spec dédiée, au moment où son plan d'implémentation démarrera.
- La question de la structure des sous-organisations en Enterprise reste régie par le document `kiviri-account-model`, qui n'est pas modifié par ce re-cadrage.

## 9. Les décisions de juin, remplacées par ce design

| Ancienne décision (notes de juin) | Ce qui la remplace maintenant |
|---|---|
| « Personal = lecture seule, aucune écriture manuelle » | D4 : tout le monde édite, y compris sur Personal |
| « Pas d'application de chat à construire (on comptait sur le client MCP) » | D17 : un assistant intégré complet, dès le premier jour |
| « Enterprise = Obsidian streamé via Selkies, sur 3 flux » | D2 : une application headless pour tous les clients ; Selkies redevient un usage strictement personnel de Roland |
| « Le BYO-key = zéro coût de tokens pour nous, au cœur du modèle Personal » | D6 et D7 : l'usage géré par nous est payant au cœur du modèle ; le BYO-key n'est plus qu'une soupape pour les abonnés payants |
| La roadmap applicative P0-P8 du 2026-06-07 (un backend headless basé sur LiveSync, éditeur CodeMirror) | D1, D3 et D18 : les deux tracks A/B, un store propre accompagné de Kiviri Sync, et un éditeur à blocs |

## 10. Impact sur la documentation (vault `opsidian-mcp-router et bridge`)

Ce re-cadrage a entraîné la mise à jour des documents suivants dans le vault :

1. `wiki/obsidian-mcp-router-saas/saas-web-app-roadmap.md` — **entièrement réécrite** (les deux tracks, les releases, la délégation vers `kiviri-roadmap`).
2. `wiki/obsidian-mcp-router-saas/kiviri-roadmap.md` — un bandeau daté, plus les nouveaux éléments : Kiviri Control, le constructeur d'offres, l'anti-abus, l'offre Dedicated.
3. `wiki/obsidian-mcp-router-saas/saas-editions-pricing.md` — une nouvelle section « Évolution 2026-07-05 » (offre gratuite, essais, BYO-key, usage géré par nous).
4. Les fichiers de suivi (« scaffolds ») : une ligne au journal (log) et une entrée dans le cache de contexte récent (hot).
