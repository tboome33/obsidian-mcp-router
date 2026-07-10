# 9 · Export et interopérabilité

Le savoir accumulé dans un vault ne doit pas y rester prisonnier. Ces features le font sortir sous des formats standards : un fichier unique pour les LLM (`llms.txt`), ou un bundle **OKF** (Open Knowledge Format, le format d'échange de connaissances proposé par Google) partageable avec n'importe quel agent compatible.

## `/wiki-export` — le vault en un seul fichier

**Le besoin.** Donner tout le contexte d'un vault à un autre outil — un LLM sans accès MCP, un collègue, un service en ligne — sans lui envoyer 300 fichiers.

**Ce que ça fait.** Exporte le vault sous forme d'un fichier unique portable, aux conventions `llms.txt` (l'index condensé) ou `llms-full.txt` (le contenu intégral). La même commande sait aussi produire un bundle OKF (voir ci-dessous).

**Comment l'utiliser.**

> « exporte le wiki en llms.txt », « exporte en bundle OKF » — ou `/obsidian-router:wiki-export`

## `/okf-export` — publier un bundle OKF

**Le besoin.** Partager une **partie** de son wiki — un dossier, un projet — avec quelqu'un d'autre (humain ou agent), dans un format que le destinataire peut consommer sans rien connaître d'Obsidian ni du router.

**Ce que ça fait.** Exporte un sous-ensemble du wiki en **bundle OKF v0.1** conforme à la spec : noms de fichiers slugifiés, liens convertis en liens relatifs, index par dossier, auto-vérification de conformité avant livraison, et README d'accompagnement optionnel pour orienter l'agent qui recevra le bundle.

**Comment l'utiliser.**

> « exporte ce dossier en bundle OKF », « publie mon wiki en bundle de connaissances » — ou `/obsidian-router:okf-export`

**À savoir.** La philosophie du projet : OKF est le format d'échange **aux frontières** — le format interne du vault, lui, ne migre jamais. Vous exportez en OKF, vous importez de l'OKF, mais votre wiki reste votre wiki.

## `/okf-check` — valider un bundle OKF

**Le besoin.** Avant de publier un bundle (ou d'ingérer celui d'un tiers), vérifier qu'il respecte réellement le format — plutôt que de découvrir les problèmes chez le destinataire.

**Ce que ça fait.** Valide n'importe quel bundle — le vôtre ou celui d'un tiers — contre les règles de conformité de l'Open Knowledge Format v0.1, et rapporte précisément ce qui ne va pas. C'est l'un des premiers validateurs OKF de l'écosystème.

**Comment l'utiliser.**

> « valide ce bundle OKF », « ce bundle est-il conforme ? » — ou `/obsidian-router:okf-check`
