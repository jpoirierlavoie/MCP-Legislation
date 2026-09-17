# Propositions — rattachement taxonomique des 18 textes fédéraux (2026-09-11)

**⛔ PROPOSITION — MAIS APPLIQUÉE DEPUIS.** Ce document portait « Rien n'est appliqué. […]
Aucune ligne de `taxonomy.json` n'a été touchée ». C'était vrai le 2026-09-11, et ça ne l'est
plus. Mesuré le **2026-09-17** : `subject_map` porte **18 rattachements sur 14 matières**
pour les textes `ca-*`, et `taxonomy.json` les déclare sous sa clé `mappings`. Le document ne
propose donc plus rien — il explique POURQUOI ces rattachements-là, ce qu'aucune surface
vivante ne porte.

`taxonomy.json` reste la vérité éditoriale de Jason (invariant 16) : ce document a proposé,
c'est une passe éditoriale de Jason qui a tranché. `relations.json`, `eval/cases.json` et
`curation/` n'ont, eux, pas été touchés.

**Document DATÉ, au passé.** Il rapporte l'état mesuré le 2026-09-11 et ne fait pas foi sur
l'état courant (politique `docs/`). Les décomptes qu'il contient valaient ce jour-là.

## Pourquoi ce document existe

Les 18 textes fédéraux ont été ingérés le 2026-09-11 (6 826 articles, 2 056 divisions). Ils
sont **chargés et muets** : sans mappage de matière, le signal S1 ne les voit pas, et
`qclaw_find_relevant` ne les proposera jamais. La passe éditoriale est la seule chose qui les
rende repérables.

Méthode : 18 analyses indépendantes (une par texte, sur les divisions et notes marginales
lues en base, jamais sur le titre), 18 contradicteurs chargés de les réfuter, une synthèse,
une critique de complétude. Puis **vérification mécanique** de tout ce qui était vérifiable —
chemins de division contre la base, décomptes contre `taxonomy.json` **et**
`curation/division-subjects.proposition.json`, et atteignabilité des tokens contre les
2 987 requêtes réelles de `search_log` et les 20 cas de `eval/cases.json`.

Trois affirmations de la synthèse n'ont pas survécu à cette vérification. Elles sont
corrigées ci-dessous et signalées comme telles.

---

## 1. Les 18 rattachements proposés

Quatre au niveau DIVISION (le texte est hétérogène, un mappage en bloc ferait remonter la loi
entière pour une question qui ne touche qu'une de ses parties), quatorze au niveau loi.
**Les quatre chemins ont été vérifiés en base** : ils existent, avec l'intitulé indiqué.

| Matière | Texte | `division_path` | Intitulé vérifié en base |
|---|---|---|---|
| `renseignements-personnels` | `ca-p-8.6` | `fh1:2` | Protection des renseignements personnels dans le secteur privé |
| `technologies-information` | `ca-p-8.6` | `fh1:3` | Documents électroniques |
| `suretes` | `ca-i-15` | `fh1:3` | Intérêt sur deniers garantis par hypothèque sur immeubles ou biens réels |
| `travail-emploi` | `ca-l-2` | `fh1:5` | Durée normale du travail, salaire, congés et jours fériés |
| `preuve` | `ca-c-5` | — | *(loi entière)* |
| `societes-entreprises` | `ca-c-44` | — | |
| `interpretation-lois` | `ca-i-21` | — | |
| `famille` | `ca-d-3.4` | — | |
| `propriete-intellectuelle` *(nouvelle)* | `ca-c-42` | — | |
| `propriete-intellectuelle` *(nouvelle)* | `ca-t-13` | — | |
| `faillite-insolvabilite` *(nouvelle)* | `ca-b-3` | — | |
| `faillite-insolvabilite` *(nouvelle)* | `ca-c-36` | — | |
| `cours-federales` *(nouvelle)* | `ca-f-7` | — | |
| `cours-federales` *(nouvelle)* | `ca-dors-98-106` | — | |
| `cours-federales` *(nouvelle)* | `ca-s-26` | — | |
| `droit-concurrence` *(nouvelle)* | `ca-c-34` | — | |
| `poursuites-couronne-federale` *(nouvelle)* | `ca-c-50` | — | |
| `effets-negociables` *(nouvelle)* | `ca-b-4` | — | |

**Un texte reste sans rattachement : `ca-crc-368`** (*Règles générales sur la faillite et
l'insolvabilité*). Motif : `faillite-insolvabilite` naîtrait à 3 entités, soit exactement
`MAX_PER_SUBJECT`, et la troisième serait le règlement d'application de la première. Il reste
atteignable par `related_laws` via la relation `reglement-de` proposée au §5.

---

## 2. Le décompte par matière — corrigé

⚠️ **La synthèse avait omis `curation/division-subjects.proposition.json`** (8 mappages de
division en attente depuis la phase 3 v2, jamais appliqués). Ses décomptes étaient donc
sous-évalués sur trois matières. Voici les décomptes vérifiés, curation comprise.

| Matière | Aujourd'hui | + curation en attente | Après proposition | |
|---|---|---|---|---|
| `societes-entreprises` | 5 | 5 | **6** | ⚠️ franchit 5 — invariant 15 |
| `famille` | 2 | **3** | **4** | au-delà de `MAX_PER_SUBJECT` |
| `suretes` | 2 | **3** | **4** | au-delà de `MAX_PER_SUBJECT` |
| `travail-emploi` | 3 | 3 | **4** | au-delà de `MAX_PER_SUBJECT` |
| `preuve` | 2 | 2 | 3 | = `MAX_PER_SUBJECT` |
| `renseignements-personnels` | 2 | 2 | 3 | = `MAX_PER_SUBJECT` |
| `cours-federales` *(nouvelle)* | — | — | **3** | naît saturée |
| `interpretation-lois` | 1 | 1 | 2 | |
| `technologies-information` | 1 | 1 | 2 | |
| `propriete-intellectuelle` *(nouvelle)* | — | — | 2 | |
| `faillite-insolvabilite` *(nouvelle)* | — | — | 2 | |
| `droit-concurrence` *(nouvelle)* | — | — | 1 | |
| `poursuites-couronne-federale` *(nouvelle)* | — | — | 1 | |
| `effets-negociables` *(nouvelle)* | — | — | 1 | |

**Aucune matière ne franchit 8**, le seuil où *Bâtiment et construction* (7 lois) avait à elle
seule rempli le top 8 et évincé le C.c.Q.

**Aucun texte fédéral n'est proposé pour `administration-justice` (14 avec la curation) ni
`secteur-financier` (12)**, les deux pires matières du corpus. Six analyses le proposaient
pourtant. Le motif du refus est structurel et vaut d'être retenu : l'argument « cette
description n'est pas bornée au Québec, donc l'ajout est gratuit » est disponible mot pour mot
pour six textes fédéraux, et dix-huit agents en parallèle le tiendront dix-huit fois.

---

## 3. ⚠️ Le vrai risque : les descriptions, pas les rattachements

Une `description` de matière est une **surface d'appariement** (invariant 13), et
l'appariement par préfixe est borné à 4 caractères de suffixe (invariant 14, `MAX_SUFFIX`).
`src/relevance.ts` porte déjà le post-mortem : *« récusation » est passé de 4 à 5 entités
touchées, a perdu son facteur d'un coup, et le chapitre de la récusation du C.p.c. s'est fait
évincer du top 8 par des dizaines de simples « juge »*.

Les descriptions initialement proposées reproduisaient ce défaut. **Mesuré** contre les
2 987 requêtes de `search_log` et les 20 cas de `eval/cases.json` :

| Token de requête | Fréquence réelle | Atteignait | Cas d'éval directement menacé |
|---|---|---|---|
| `juge` | **132** | « juge adjoint » (`cours-federales`) | 8 « récusation juge motifs », 17 « remplacement du juge délibéré » |
| `appel` | **71** | « Cour d'appel fédérale » (`cours-federales`) | contrôle de routeur « appel civil » |
| `vente` | **70** | « ventes liées » (`droit-concurrence`) | 16 « vente sous contrôle de justice garantie » |
| `cour` | 12 | « couronne » (`poursuites-couronne-federale`) | — |
| `carte` | 1 | « cartel » (`droit-concurrence`) | — |
| `reglement` | 0 dans le journal | « réglementaire » (`interpretation-lois` réécrite) | — |
| `prix` | 0 dans le journal | « fixation des prix » (`droit-concurrence`) | — |

Chacun injecte `S1_SUBJECT × specificityFactor` = **3 × 2,00 = 6,00 points**, soit une fois
et demie un nom de loi apparié exactement (`S3 = 2 × 2,00 = 4,00`).

**Les descriptions ci-dessous sont corrigées en conséquence.** Les mots retirés le sont pour
une raison chiffrée, jamais par prudence décorative.

### `cours-federales` — « Cours fédérales et Cour suprême »

```
FR : Cours fédérales et Cour suprême du Canada : Règles des Cours fédérales, contrôle
     judiciaire, office fédéral, mandamus, certiorari, quo warranto, prohibition, pourvoi,
     autorisation de pourvoi, amirauté, droit maritime, navigation.
EN : Federal Courts and Supreme Court of Canada: Federal Courts Rules, judicial review,
     federal board, mandamus, certiorari, quo warranto, prohibition, leave to appeal,
     admiralty, maritime law, navigation.
```
**Retirés :** « juge adjoint » (le token `juge` vaut 132 requêtes réelles et deux cas
d'éval) et « Cour d'appel fédérale » (`appel`, 71 requêtes). La loi reste atteignable par son
NOM via S3. **Subsiste :** `cour` (12 requêtes), irréductible — c'est le sujet même.

### `faillite-insolvabilite` — « Faillite et insolvabilité »

```
FR : Faillite et insolvabilité : failli, insolvable, banqueroute, surendettement,
     concordataire, restructuration, financement temporaire, fournisseurs essentiels,
     surintendant des faillites.
EN : Bankruptcy and insolvency: insolvent, insolvency, restructuring, interim financing,
     critical suppliers, Superintendent of Bankruptcy.
```
Aucun token à risque mesuré. `faillite` (7 requêtes) et `concordataire` (3) sont
discriminants et corrects.

### `propriete-intellectuelle` — « Propriété intellectuelle »

```
FR : Droit d'auteur, droits moraux et marques de commerce : œuvre littéraire, artistique,
     dramatique ou musicale, titularité du droit d'auteur, plagiat, utilisation équitable,
     artiste-interprète, enregistrement sonore, radiodiffuseur, signal de communication,
     redevances, Commission du droit d'auteur, marque officielle, marque projetée,
     caractère distinctif, achalandage, registraire des marques de commerce.
EN : Copyright, moral rights and trademarks: literary, artistic, dramatic or musical works,
     authorship of copyright, plagiarism, fair dealing, performer, sound recording,
     broadcaster, communication signal, royalties, Copyright Board, official mark, proposed
     trademark, distinctiveness, goodwill, Registrar of Trademarks.
```
**Retiré :** « domaine public » (le token `public`, 4 requêtes, touche déjà 6 matières).
**Subsistent :** `commerce` (8) et `communication` (5), tous deux légitimes ici.

### `poursuites-couronne-federale` — « Poursuites contre la Couronne fédérale »

```
FR : Poursuites visant la Couronne fédérale et Sa Majesté du chef du Canada : procureur
     général du Canada, organismes mandataires de la Couronne, immunité de la Couronne,
     prérogative royale, contentieux administratif fédéral.
EN : Proceedings against the federal Crown and His Majesty in right of Canada: Attorney
     General of Canada, Crown agencies, Crown immunity, Crown prerogative, federal
     administrative litigation.
```
**Retirés :** « contre » (préposition, 7 requêtes, aucun pouvoir discriminant) et
« poursuivre le gouvernement fédéral » (redondant avec « poursuites »).
**Subsiste, irréductible :** `cour` atteint `couronne` avec un suffixe de exactement 4.
Douze requêtes sur 2 987 en portent le token. Coût assumé et **dit**.

### `effets-negociables` — « Lettres de change, chèques et billets »

```
FR : Lettre de change, chèque, chèque barré, billet, effet cambiaire : tireur, endosseur,
     endossement, protêt, complaisance, grâce.
EN : Bill of exchange, cheque, crossed cheque, promissory note, negotiable instrument:
     drawer, endorser, endorsement, protest, accommodation, grace.
```
L'identifiant est `effets-negociables` et non `effets-commerce` : l'id entre dans la surface
d'appariement, et « commerce » y aurait déposé un token générique.

### `droit-concurrence` — « Droit de la concurrence »

```
FR : Concurrence : complot entre concurrents, cartel, fixation des prix, truquage des
     offres, abus de position dominante, fusionnement, préavis de fusion, refus de vendre,
     maintien des prix, exclusivité, indications fausses ou trompeuses, télémarketing
     trompeur.
EN : Competition: conspiracy among competitors, cartel, price fixing, bid rigging, abuse of
     dominant position, merger, pre-merger notification, refusal to deal, price maintenance,
     exclusive dealing, false or misleading representations, deceptive telemarketing.
```
**Retiré :** « ventes liées » — le token `vente` vaut 70 requêtes réelles et le cas d'éval 16.
**Subsiste, et c'est IRRÉDUCTIBLE :** `concurrence`, 96 requêtes, dont le cas d'éval 15
« clause non-concurrence fin d'emploi ». Le français ne distingue pas la clause de
non-concurrence du droit de la concurrence, et le token vit aussi dans l'`id` et le `label`.
**Cette matière est la seule dont la création doit être mesurée seule, avec une porte
bloquante sur le cas 15** — que `tests/evals.mjs` garde déjà nommément.

---

## 4. Descriptions existantes à réécrire

Trois descriptions deviennent fausses si l'on y range un texte fédéral. Une réécriture est un
changement de surface d'appariement : elle se mesure à l'éval, elle ne se décrète pas.

**`interpretation-lois`** — aujourd'hui « règles transversales de lecture des lois **du
Québec** », ce qui exclut `ca-i-21` par sa lettre même.
```
FR : Lois d'interprétation fédérales et du Québec : règles transversales pour interpréter un
     texte législatif.
EN : Federal and Québec Interpretation Acts: transversal rules for construing a legislative
     text.
```
⚠️ **Corrigé par rapport à la synthèse**, qui ajoutait « réglementaire » : le token
`reglement` l'atteint avec un suffixe de exactement 4, rouvrant la classe de faux positifs
« abrogation d'un règlement municipal » que la même synthèse se félicitait d'avoir fermée.

**`renseignements-personnels`** — ajoute « LPRPDE » et le secteur privé fédéral. Delta mesuré :
+1 token par langue.

**`famille`** — ajoute « divorce, séparation, époux, conjoint, aliments pour enfants, garde
des enfants, médiation familiale ». C'est **la plus forte expansion de surface du lot**
(13 tokens ajoutés en français). Aucun token à risque mesuré, mais l'ampleur justifie de la
mesurer seule.

**À ne PAS toucher :** `procedure-civile` (« C.p.c. et règlements des tribunaux judiciaires »)
reste bornée au Québec à dessein — c'est pour cela que `cours-federales` existe.

---

## 5. Relations — 2 arêtes curées, et 47 dérivables

**Deux `reglement-de` à curer**, qu'aucun code ne déduira : la citation fédérale ne porte
aucune marque de subordination (« DORS/98-106 », « C.R.C., ch. 368 »), et aucun
`parent_chapter` n'est déclaré en configuration.

| De | Vers | Fondement |
|---|---|---|
| `ca-dors-98-106` | `ca-f-7` | les *Règles des Cours fédérales* citent la *Loi sur les Cours fédérales* 11 fois ; c'est son habilitation |
| `ca-crc-368` | `ca-b-3` | son titre est *Règles générales sur la faillite et l'insolvabilité* |

**Et 47 arêtes `renvoie-a` dérivables automatiquement.** Mesuré sur les 36 fichiers LIMS :
2 685 `XRefExternal`, dont **94 % portent un attribut `link` lisible par machine** (la
désignation de chapitre). Passe FR : 334 arêtes distinctes, dont **47 au corpus** (poids 126)
et 287 hors corpus (poids 902, liste d'acquisition chiffrée : *Loi de l'impôt sur le revenu*
211 renvois, *Régime de pensions du Canada* 139, *Code criminel* 88 — exclu à dessein).

Trois arêtes traversent les deux ordres de gouvernement : `ca-b-3 → ccq` (3),
`ca-c-36 → ccq` (1), `ca-dors-98-106 → cpc` (1).

Quatre textes n'ont aucune arête au corpus : `ca-b-4`, `ca-i-15`, `ca-s-26`, `ca-t-13`.

Le sens inverse — Québec vers fédéral — n'est **pas** moissonnable : les EPUB de LégisQuébec
ne lient que des chapitres RLRQ. Les mentions existent pourtant en clair (23 articles
québécois citent « faillite et l'insolvabilité », 42 « divorce », 6 « marques de commerce »,
5 « preuve au Canada »). Ce sens relève de la curation.

---

## 6. Ordre d'application proposé, avec ses portes

Rien de ceci n'agit tant que `FEDERAL_CORPUS` vaut `0` : les quatre signaux S1 à S4 sont
masqués sur les textes `ca-*`. **Corollaire à ne pas manquer : une éval avant/après jouée
l'interrupteur fermé certifierait « aucune régression » sans avoir rien mesuré.**

Et une matière NOUVELLE posée avant l'ouverture s'afficherait « 0 lois » dans
`qclaw_list_subjects` — le masque de `listSubjects` est dans le `ON` du LEFT JOIN. C'est
exactement le défaut « Voir les 38 textes disponibles ». **Les six matières nouvelles ne
doivent donc jamais être posées avant le flip.**

| Palier | Contenu | Porte |
|---|---|---|
| 0 | ouvrir `FEDERAL_CORPUS`, mesurer l'éval | baseline `2026-09-11-federal-ingere.json` |
| 1 | les 3 réécritures de description, **sans aucun mappage** | 20 cas, cas par cas |
| 2 | les 4 mappages à DIVISION vers matières existantes | idem |
| 3 | les 4 mappages à LOI vers matières existantes | idem |
| 4 | `faillite-insolvabilite`, `propriete-intellectuelle`, `effets-negociables` | une à la fois |
| 5 | `cours-federales` (naît à 3 = `MAX_PER_SUBJECT`) | cas 8 et 17 (`juge`) |
| 6 | `poursuites-couronne-federale` | — |
| 7 | **`droit-concurrence`, en dernier, seule** | **porte bloquante sur le cas 15** |

---

## 7. Ce qui reste muet, et qui doit être dit

- **`ca-crc-368`** n'a aucune matière (cf. §1).
- **`ca-b-4`** : les blocs « Lettres et billets de consommation » (`fh1:7`, art. 188-192) et
  « Conflit de lois » (`fh1:4-fh2:19`, art. 160-162) restent hors de toute surface S1.
- **`ca-c-5`** : la Partie II (`fh1:3`, entraide et lettres rogatoires) et les art. 31.1-31.8
  (documents électroniques) ne sont couverts par aucun mappage retenu.
- **`ca-l-2`** : seule la partie III (normes) est mappée. Les relations collectives (partie I)
  et la santé-sécurité (partie II) restent muettes — trou de CORPUS, pas de taxonomie : aucune
  matière québécoise ne les couvre, et en créer une pour un seul texte fédéral serait une
  surface d'appariement de plus sans contrepartie.
- Les 20 cas d'éval mesurent la **non-régression québécoise**. Ils ne disent **rien** de la
  couverture fédérale. Des cas fédéraux sont à proposer séparément (⛔ `eval/cases.json`).
