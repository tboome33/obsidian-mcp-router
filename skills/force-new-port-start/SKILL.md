---
name: force-new-port-start
description: |
  Draw a NEW allocation base for the vaults this installation creates from now on, and change nothing else. The existing fleet keeps its ports, its keys and its click-to-open links; `installId` is untouched; no `data.json` is rewritten and no vault is opened. Two phases: a plan is shown (previous base, new base, band, and "existing ports changed: 0"), then applied only on confirmation, with a seal that refuses if the registry moved in between.

  EN triggers: "force a new port start", "draw a new port base", "change the base new vaults get their ports from", "my new vaults keep colliding with something".
  FR triggers : "force un nouveau port start", "tire une nouvelle base de ports", "change la base d'allocation des futurs vaults", "les nouveaux vaults tombent sur des ports déjà pris".

  Example / Exemple:
    EN: "new vaults keep landing near the old fleet — draw me a new base"
    FR: "tire une nouvelle base de ports pour les prochains vaults"
---

# force-new-port-start

Change la **base d'allocation** — le nombre à partir duquel les ports du **prochain** vault sont
cherchés. Rien d'autre.

## Ce que la commande ne fait pas, et pourquoi c'est le sujet principal

Elle ne renumérote **aucun** vault existant. C'est la décision D1 du 2026-09-09, et sa raison est
concrète : chaque port HTTP en clair est gravé dans les liens click-to-open
(`http://127.0.0.1:<port>/open/…`). Ces liens vivent dans les notes, entre les vaults, et surtout
**hors** des vaults — dans des mails, des transcripts de conversation, des favoris. Réécrire les
premiers serait faisable ; les seconds seraient perdus sans recours.

Le plan affiche donc « EXISTING ports changed : 0 » **en toutes lettres**, parce que c'est
exactement le fait dont le lecteur doit être certain avant de confirmer, et que « fais-moi
confiance » n'est pas une façon de le dire.

Elle n'ouvre aucun vault, ne réécrit aucun `data.json`, ne crée aucune clé, et ne change pas
`installId`.

## La bande

Les nouvelles paires se tirent dans **20000–32000 inclus**, moins **27000–27999 inclus** — la
tranche où vivent les 54 ports de la flotte historique et où se trouvent les réglages d'usine du
plugin Local REST API (27124/27123). Les **deux** membres d'une paire doivent tomber dans la
portion autorisée : une base près d'un bord dont le partenaire dépasserait est écartée. Le plafond
maintient les deux ports sous 32768, où Linux commence à distribuer ses ports éphémères.

**Ce n'est pas une plage réservée.** Une base tirée au hasard rend seulement improbable que deux
installations indépendantes créant des vaults dans le même ordre tombent sur les mêmes numéros. Les
réservations connues et la vérification auprès du système restent nécessaires toutes les deux.

## Procédure

### 1. Proposer

```bash
node scripts/setup-vault.mjs --force-new-port-start --dry-run
```

N'écrit rien — ni la configuration, ni une sauvegarde, ni un fichier d'état. Affiche :

- l'ancienne base et la nouvelle ;
- la bande et ses exclusions ;
- le nombre de vaults enregistrés ;
- **le nombre de ports existants modifiés : 0** ;
- `installId : preserved` ;
- le nombre de bases candidates libres sur le nombre examiné ;
- un `approvedPlanSha256`.

### 2. Faire lire le plan à l'utilisateur

Ne pas enchaîner. La valeur de la phase 1 est qu'un humain voit le nombre avant qu'il ne soit écrit.

### 3. Appliquer

```bash
node scripts/setup-vault.mjs --force-new-port-start --port-start <la base proposée> --approved-plan-sha256 <le sceau>
```

`--port-start` est **obligatoire** à l'application : la base écrite est celle qui a été montrée, elle
n'est jamais retirée au moment d'appliquer. Le sceau, lui, refuse l'application si un vault a été
enregistré, retiré ou renuméroté entre les deux phases — le plan approuvé n'est alors plus le plan
qui s'exécuterait.

## Après

Rien à recharger, rien à redémarrer, aucun vault à rouvrir. Le prochain vault provisionné cherchera
ses ports à partir de la nouvelle base ; tous les autres sont exactement dans l'état où ils étaient.
