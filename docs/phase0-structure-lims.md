# Phase 0 — Reconnaissance de la structure LIMS du corpus fédéral

**Date de l'inspection :** 11 septembre 2026.
**Source :** dépôt `justicecanada/laws-lois-xml`, ref `HEAD` =
**`9c40b2a03bc38be8250ef7f86b1d5699afd08cbe`** (« Laws Site Update 2026-09-11 »).
**Fichiers inspectés :** les 36 du corpus arrêté (18 textes × 2 langues), plus les 2 de
F-29.2, témoin de refus. Aucun échec de lecture.
**Méthode :** recensement exhaustif par `pipeline/discovery/recon_lims.py`
(`xml.etree.ElementTree`, lecture par `git show <ref>:<chemin>`), **sans liste blanche
préalable** — on compte tout ce qui est là, attributs et valeurs compris, parce qu'un
recensement filtré par ce qu'on croit savoir confirme toujours ce qu'on croit savoir.
Les décomptes ci-dessous sont **exhaustifs, pas des échantillons**. Le vidage régénérable
vit dans `docs/reconnaissance-lims-courante.md` (gitignoré) ; ce document-ci est le
**contrat** que `parser_lims.py` cite par `§N`, à l'image de `docs/phase0-structure-epub.md`.

---

## 1. Source, et pourquoi ce canal

Trois canaux existent ; un seul convient. Le HTML de `lois.justice.gc.ca` est un rendu
final dont la hiérarchie est perdue dans des `<div>` de présentation. Les ZIP du portail
des données ouvertes n'offrent ni diff ni historique. Le **dépôt git** donne les deux, au
fichier près : `git log -1 -- fra/lois/B-3.xml` dit si une loi a bougé, et `git diff` dit
quoi — donc quels vecteurs réembarquer.

Le clone est **partiel** et vit **hors de l'arbre** du dépôt (`LIMS_REPO`,
`pipeline/config.py`) : `git clone --filter=blob:none --no-checkout`, **1,9 Mo**, blobs
tirés à la demande. Un sous-dépôt git dans l'arbre d'un autre dépôt git est une confusion
connue.

**Le SHA est la seule référence citable.** `LIMS_REF` vaut `HEAD` pour une reconnaissance,
un SHA pour une ingestion qu'on veut pouvoir rejouer. Mesuré : le SPEC a été écrit à
`a782c13` (20 août) et **aucun** des 36 fichiers n'a changé entre ce SHA et celui-ci, donc
ses mesures restaient valides — mais c'est une coïncidence à ne pas institutionnaliser.

**Cadence mesurée** des commits « Laws Site Update » : 2026-04-01, 05-25, 05-29, 06-08,
07-23, 08-06, 08-24, 09-11 — de quelques jours à sept semaines. Ce n'est **pas** semestriel,
contrairement à la cadence québécoise que `README.md` et `wrangler.jsonc` annoncent.

---

## 2. Enveloppe et chemins

| Élément | Valeur |
|---|---|
| Racine d'une loi | `<Statute>` |
| Racine d'un règlement | `<Regulation>` |
| Namespace | `lims` = `http://justice.gc.ca/lims` |
| Chemins FR | `fra/lois/<CHAP>.xml`, `fra/reglements/<INSTR>.xml` |
| Chemins EN | `eng/acts/<CHAP>.xml`, `eng/regulations/<INSTR>.xml` |
| DTD | `regulation_web.dtd` **seulement** — elle ne déclare NI `Statute`, NI `Chapter` |

**Les noms de fichiers C.R.C. sont asymétriques :** `fra/reglements/C.R.C.,_ch._368.xml`
contre `eng/regulations/C.R.C.,_c._368.xml` (`ch.` / `c.`). Ils contiennent virgules,
points et soulignés : à citer littéralement, jamais à reconstruire.

**Il n'existe aucune DTD des LOIS.** L'inventaire des éléments d'une loi ne peut donc venir
que de la mesure, et c'est ce qui rend la porte du §5 indispensable : il n'y a pas de schéma
à opposer à un balisage inattendu.

---

## 3. Hiérarchie : une séquence plate, et un chemin positionnel

`Body` est une **séquence plate**. Mesuré sur les 36 fichiers : `Body` n'a **jamais** d'autre
enfant direct que `Section` (9 558) et `Heading` (2 378). La hiérarchie n'est pas dans
l'imbrication, elle est dans l'attribut `level` des `Heading` — reconstruction par pile.

| Fait mesuré | Valeur |
|---|---|
| Profondeur de `Heading` maximale | **4** (D-3.4) — la DTD autorise 5 |
| `Heading` portant un `Label` | minorité ; « PARTIE II » en a un, « Partie I » porte son numéro dans le `TitleText` |
| Profondeur de numéro d'article maximale | **2** composantes |
| Composante de numéro maximale | **303** (C-44) |

Donc l'échelle `sort_key` (base 1000, 5 composantes) absorbe le corpus fédéral **sans
changement de capacité**. Elle reste néanmoins ce qu'elle est : **pas un ordre total**
(cf. le commentaire de `schema.sql` et le correctif `dc70050`).

### 3.1 Isomorphisme FR ↔ EN — vérifié sur les 19 textes

Le SPEC l'avait mesuré sur 13 lois, dont le Code criminel, exclu du corpus. Refait sur les
19 textes réellement en jeu : **nombre de nœuds identique partout**, **séquence de niveaux
identique partout** (19/19). Les jeux de numéros diffèrent sur 11 textes, et **chaque
divergence est lexicale dans un label de plage** : « 7 et 8 » / « 7 and 8 », « 127 à 129 » /
« 127 to 129 », « 54.1 à 54.49 » / « 54.1 to 54.49 », « Préambule » / « Preamble ».

**Conséquence :** le chemin de division peut être **identique dans les deux langues**, donc
l'invariant 4 (« les chemins sont propres à la langue ») ne s'applique pas à ce corpus, et
`translateDivisionPath` peut court-circuiter. C'est un **acquis à défendre, pas une
hypothèse** : `validate.py` doit comparer les deux langues et ÉCHOUER sur divergence.

**Corollaire à ne pas manquer :** l'expansion des labels de plage est **propre à la
langue** (`à`/`to`, `et`/`and`).

### 3.2 Stabilité du chemin positionnel entre consolidations — mesurée

C'est la question que la note de conception laissait ouverte et que le SPEC a fermée sans la
mesurer. Sur les **6 lois du corpus qui ont réellement changé** entre `340120e` (1er avril)
et `HEAD` (11 septembre) — B-3, C-34, C-36, C-44, F-7, P-8.6 — la séquence plate du `Body`
est **identique** (468/468, 277/277, 119/119, 332/332, 83/83, 97/97). Le texte a été amendé,
la structure non. Comme le chemin dérive de cette séquence par une pile, séquence identique
⇒ chemins identiques.

**Portée de la preuve :** 6 textes, 2 consolidations, 5 mois. Une modification qui INSÈRE
une partie décalerait tout ce qui suit. La mesure dit que c'est **rare**, pas que c'est
impossible — donc l'empreinte d'arbre reste nécessaire, et on sait maintenant qu'elle
sonnera rarement.

---

## 4. Articles : motifs de balisage

Un article est une `Section` portant un `Label` textuel. Le numéro n'est **pas** encodé dans
un identifiant, contrairement à Irosoft (`se:2926_1`).

- `MarginalNote` — intitulé d'article. **Hors du texte** par l'art. 14 de la *Loi
  d'interprétation* (L.R.C. (1985), ch. I-21) : les notes marginales « ne font pas partie »
  du texte, « n'y figurant qu'à titre de repère ou d'information ». Colonne propre, jamais
  concaténée.
- `HistoricalNote` / `HistoricalNoteSubItem` — historique, même exclusion légale.
- `Subsection` → `Paragraph` → `Subparagraph` → `Clause` → `Subclause` — l'imbrication
  numérotée. **On retire le `Label` de la `Section` mais on CONSERVE tous les `Label`
  internes** : on plaide « art. 183(1)a) L.F.I. », et un texte sans ses « (1) » et ses
  « a) » est inutilisable.
- `Continued*` — `ContinuedSectionSubsection`, `ContinuedParagraph`, `ContinuedDefinition`
  et **`ContinuedSubparagraph`** (que le SPEC oublie) : à rattacher **après** l'énumération
  qu'ils ferment, sinon la phrase se disloque.
- `Definition` — **voir §7.1, c'est le piège principal.**

**64 `Label` ne sont pas de simples numéros**, en trois familles : labels de **plage**
(`11 à 14`, `257 à 264`, `54.1 à 54.49`), labels à **balisage interne** (un `FootnoteRef`
dans le `Label`, qui rend un numéro vide si on ne l'aplatit pas) et labels **non
numériques** (`Préambule`).

---

## 5. Ce qu'on ingère et ce qu'on refuse — la liste BLANCHE

**La règle la plus importante du chantier.** Le fédéral publie du droit **non en vigueur**
dans le même fichier que le droit en vigueur.

Mesuré : il n'existe que **8 chaînes d'ancêtres** menant à une `Section`. Trois sont
ingérables, cinq ne le sont pas.

| Chaîne | `Section` | Verdict |
|---|---|---|
| `Statute < Body` | 5 340 | **ingérable** |
| `Regulation < Body` | 1 530 | **ingérable** |
| `Regulation < Schedule < RegulationPiece` | 28 | **ingérable** |
| `Statute < Schedule < BillPiece < RelatedOrNotInForce` | 558 | refusée |
| `… < RelatedOrNotInForce < Section < AmendedText` | 122 | refusée |
| `… < RelatedOrNotInForce < Section < Subsection < AmendedText` | 22 | refusée |
| `Statute < Schedule < BillPiece` | 18 | refusée |
| `Regulation < Schedule < RegulationPiece < RelatedOrNotInForce` | 4 | refusée |

**724 `Section` sur 7 622 sont du droit non applicable**, et toutes passent par `BillPiece`
ou `RelatedOrNotInForce`.

Deux conséquences de méthode. La liste noire du SPEC §3.1 **suffit au niveau ARTICLE** — le
défaut qu'on craignait ne se matérialise pas pour les articles. Mais la règle de la note de
conception (« refuser toute `Section` dont un ancêtre est `Schedule` ») aurait perdu les
28 articles de `RegulationPiece` **et** les Tarifs des Cours fédérales. Ni l'une ni l'autre :
**on écrit une liste BLANCHE de trois chaînes, et toute chaîne inédite ARRÊTE l'ingestion.**
Notre défaut doit être l'inverse de celui de l'éditeur, dont l'attrape-tout `match="*"` de
`LIMS2HTML.xsl` rend le texte de n'importe quel élément inconnu.

### 5.1 Les marqueurs de non-vigueur réellement présents

Le SPEC propose `Heading/@type` et `@change` : **`Heading/@type` n'existe nulle part** (il
est déclaré par la DTD, jamais employé) et `@change` non plus. Ce qui existe, sur
**822 occurrences** :

`Heading/@style='nifrp'` 562 · `Section/@type='amending'` 144 ·
`MarginalNote/@in-force='no'` 122 · `Paragraph/@in-force='no'` 115 ·
`Subsection/@in-force='no'` 88 · `Subsection/@type='amending'` 74 ·
`Section/@in-force='no'` 70 · `ScheduleFormHeading/@type='amending'` 38 ·
`Statute/@in-force='yes'` **32** · `Definition/@in-force='no'` 14 ·
`Subparagraph/@in-force='no'` 14 · `Section/@type='transitional'` 8 · et 11 de plus.

**Mais 782 de ces 822 sont SOUS un sous-arbre déjà refusé.** Seuls **40** sont en territoire
ingérable, et **38** d'entre eux sont le `ScheduleFormHeading/@type='amending'` des annexes
« MODIFICATIONS NON EN VIGUEUR ».

⇒ **Aucune colonne `in_force` par article n'est nécessaire.** La liste blanche d'ancêtres
suffit. Une seule règle neuve est requise : **refuser un `Schedule` dont le
`ScheduleFormHeading/@type` vaut `amending`**, avec sa division, sinon `get_structure`
annonce une annexe « MODIFICATIONS NON EN VIGUEUR » vide.

Les 2 derniers cas sont l'art. 503 de DORS/98-106 dans les deux langues : `type="amending"`
sur un article **abrogé et en vigueur** (« [Abrogé, DORS/2004-283, art. 25] »). Donc
**`@type='amending'` n'est PAS un marqueur de non-vigueur** et ne doit jamais motiver un
refus à lui seul. `@type='transitional'` non plus : 8 `Section`, du droit en vigueur.

`Statute/@in-force='yes'` = 32 = 16 lois × 2 langues : **les deux règlements n'en portent
pas**, et la DTD ne déclare pas cet attribut sur `Regulation`. La règle « absent ⇒ 0 » du
SPEC §3.7 les refuserait donc tous les deux. **Polarité correcte :** racine `Statute` sans
l'attribut ⇒ échec d'ingestion ; racine `Regulation` sans l'attribut ⇒ **1**.

---

## 6. Annexes, et les collisions de numéros

**264 `Schedule`** relevés. Le SPEC §3.8 suppose « le même vocabulaire que le `Body` » : c'est
faux pour la majorité. Une annexe peut porter son contenu sous `Provision`, `FormGroup`,
`TableGroup` ou `Repealed`, sans aucune `Section` — donc « réutiliser le même walker »
produirait des annexes **vides**. Le titre se lit sur `Schedule/ScheduleFormHeading` **ou**
sur `Schedule/FormGroup/ScheduleFormHeading`.

Deux imbrications réelles hors racine : `Schedule` dans `Section` (T-13) et dans
`DocumentInternal` (D-3.4).

**Collisions de numéros annexe ↔ corps.** Massives en apparence, mais presque toutes issues
de `RelatedProvs` et `NifProvs`, que la liste blanche refuse déjà. **Le cas réel est
`ca-c-44` : son annexe `ANNEXE` porte les numéros 1 à 9, qui collisionnent avec les
articles 1 à 9 du corps** — deux contenus tous deux ingérables. D'où la décision de
**préfixer** les numéros d'articles d'annexe (`annexe-1`, `tarif-b-1`), sur le précédent du
parseur québécois, qui fabrique déjà `annexe-i`.

---

## 7. Pièges d'extraction — règles fermes, toutes vérifiées

**7.1 `Definition` est absente de la liste de sérialisation du SPEC, et c'est le piège le
plus coûteux du corpus.** 1 606 occurrences. Mesuré sur l'art. 2 de la L.F.I. : **51 blocs
`Definition`, 13 736 caractères**. Un walker qui ne les descend pas rend « Les définitions
qui suivent s'appliquent à la présente loi. » — **59 caractères, soit 99,6 % de l'article
perdu**, sur la disposition la plus citée de toute loi. Et le résultat est une phrase
plausible : faux, servi, silencieux. **Règle : descendre dans `Definition`,
`DefinitionEnOnly` et `DefinitionFrOnly`.**

**7.2 `root.iter('Section')` est interdit.** 724 `Section` de droit non applicable portent
des numéros qui **recoupent** ceux du corps. Le parseur descend explicitement les trois
chaînes blanches du §5 et refuse le reste.

**7.3 L'invariant de comptage doit porter sur la PROVENANCE, pas sur un total.** « Articles
ingérés = `Section` sous `Body` + annexes ingérées » s'équilibre des deux côtés quand une
annexe refusée est comptée comme légitime : sur I-15, 19 = 11 + 8. Il faut un bilan de
matière **par raison** (ingéré / refusé, avec le motif), comparé à un grand livre
**versionné et jamais régénéré au moment du contrôle** — sinon il s'auto-équilibre.

**7.4 Le `Label` doit être aplati.** Un `FootnoteRef` dans le `Label` rend un numéro vide si
on prend `.text` au lieu du texte complet.

**7.5 Les espaces Unicode sont porteurs.** U+00A0, U+2002, U+2009 apparaissent dans les
`Label` et les textes. À normaliser comme `_norm` le fait déjà.

**7.6 `spanlanguages` n'est PAS un marqueur de mixité linguistique.** Mesuré dans le fichier
**français** de DORS/98-106 : ses 88 annexes `spanlanguages="yes"` totalisent **4 738
mots-outils français contre 1 mot anglais**, et l'attribut est **absent des 127 Ko de
`LIMS2HTML.xsl`**. `bilingual='yes'` n'existe nulle part. Le marqueur **réel** est
**`BilingualGroup`** — 2 occurrences. Armer une exclusion de recherche sur `spanlanguages`
retirerait les formulaires des R.C.F. et les tableaux du Tarif B pour rien.

**7.7 Un règlement n'a pas de `ShortTitle`.** Seulement `LongTitle`. La dérivation du titre
dépend donc du type de racine.

**7.8 `Identification/ConsolidationDate` et `lims:current-date` divergent.** D'un jour sur
C.R.C. ch. 368. On retient `lims:current-date`, qui est le « À jour au » affiché.

---

## 8. Stratégie de parseur proposée

1. **Lire** par `git show <LIMS_REF>:<chemin>`, consigner le SHA au rapport d'ingestion.
2. **Classer** chaque balise selon `pipeline/expected/lims_tags.json` (§6 de ce document) :
   `texte` / `structure` / `division` / `metadonnee` / `hors_texte` / `refuse` / `ignore`.
   **Une balise absente du classement ARRÊTE l'ingestion** — c'est la porte, et elle est
   volontairement en liste blanche.
3. **Qualifier** chaque `Section` par sa chaîne d'ancêtres complète (§5). Trois chaînes
   passent ; toute autre lève une exception d'ingestion. Aucune branche par défaut.
4. **Refuser** en outre tout `Schedule` dont le `ScheduleFormHeading/@type` vaut `amending`,
   division comprise (§5.1).
5. **Reconstruire** la hiérarchie par pile sur `Heading/@level` ; chemin positionnel
   `fh<niveau>:<rang>`, joint par `-`, et `fs:<n>-…` pour l'intérieur d'une annexe.
6. **Sérialiser** le texte selon §4 et §7 : `Label` de la `Section` retiré, `Label` internes
   conservés, `Definition` descendue, `Continued*` rattachés après l'énumération,
   `MarginalNote` et `HistoricalNote` sortis dans leurs colonnes, tables CALS rendues
   tabulairement, espaces Unicode normalisés.
7. **Walker d'annexe distinct** (§6) : le vocabulaire n'est pas celui du `Body`.
8. **Invariants de non-régression (tests de la phase suivante)** — témoins figés :
   - art. 183 L.F.I. : note marginale « Tribunaux compétents », alinéa (1.1), historique ;
   - **art. 2 L.F.I. : 51 `Definition`, ≥ 13 700 caractères** (le témoin du §7.1) ;
   - **I-15 art. « 11 à 14 » / « 11 to 14 »** : label de plage, expansion en 11, 12, 13, 14 ;
   - Tarif B des R.C.F. : annexe à walker distinct, titre sous `FormGroup` ;
   - préambule du Code canadien du travail : pseudo-article, clé de tri 0 ;
   - art. 36 *Loi sur le divorce* et art. 72 LPRPDE : `Label` à balisage interne ;
   - **F-29.2 : ingestion REFUSÉE** sans `--allow-not-in-force` ;
   - bilan de matière par provenance : I-15 = 11 articles de corps, 3 divisions, 0 article
     d'annexe, **8 `Section` refusées**.

---

## 9. Questions ouvertes — décisions prises et décisions restantes

**Tranchées par la mesure :** la polarité d'`in-force` (§5.1) ; l'absence de colonne
`in_force` par article (§5.1) ; l'isomorphisme FR/EN (§3.1) ; la stabilité du chemin
positionnel (§3.2) ; le marqueur bilingue réel (§7.6) ; l'espace de noms des numéros
d'annexe (§6).

**Tranchées par Jason le 2026-09-11 :** paramètre `jurisdiction` sur `qclaw_list_laws`,
implémenté ; numéros d'annexe **préfixés** ; `official_cite_en` rempli pour les **97**
textes, donc « CQLR » en anglais pour le Québec aussi ; un drapeau `FEDERAL_CORPUS` pour que
le retour arrière soit un interrupteur (R8).

**Restant à trancher, et signalé comme tel :**

1. **`Footnote` (24 occurrences) fait-il partie du texte ?** L'art. 14 de la *Loi
   d'interprétation* ne nomme que les notes marginales et les mentions de textes antérieurs ;
   il ne dit rien des notes en bas de page. Proposition : ingérer, étiqueté, rendu en fin
   d'article. **Décision de contenu juridique.**
2. **Le classement des 54 balises** (`pipeline/expected/lims_tags.json`) est une
   **PROPOSITION** : le code l'applique, il ne l'a pas tranché. Les entrées portant
   `justification_juridique` sont celles à relire en premier.
3. **`LICENSE` ne mentionne aucune licence de données tierce** alors que la Licence du
   gouvernement ouvert – Canada impose une attribution. Hors des cinq surfaces, et hors de
   ce document, mais à régler avant toute mise en service.

---

*Rapport de phase 0 — inspection seule, aucune ligne de parseur écrite. Le vidage
régénérable est `docs/reconnaissance-lims-courante.md` ; le classement exécutable est
`pipeline/expected/lims_tags.json`.*
