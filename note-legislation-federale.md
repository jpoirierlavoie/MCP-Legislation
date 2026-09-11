# Intégrer la législation fédérale au serveur « Législation du Québec »

**Note de conception — 2026-09-04.** Toutes les mesures ci-dessous ont été prises sur le
dépôt officiel de Justice Canada à `HEAD` (commit « Laws Site Update 2026-08-20 ») et sur
le dépôt `MCP-Legislation-Quebec` à `main`. Ce qui est *mesuré* est chiffré ; ce qui est
*recommandé* est annoncé comme tel. Aucun décompte de ce document ne doit être recopié
ailleurs (R10) : il est daté, il vieillira.

---

## 1. La source : ne pas parser le HTML

Le fichier que vous avez ouvert (`TexteComplet.html`) est une page de rendu. Trois canaux
existent, et un seul convient à un pipeline.

| Canal | Ce qu'on y trouve | Verdict |
|---|---|---|
| HTML (`lois.justice.gc.ca/fra/lois/f-29.2/TexteComplet.html`) | rendu final, hiérarchie perdue dans des `<div>` de présentation | à écarter — c'est la reconstitution du scraping Irosoft, en pire |
| XML en bloc, portail des données ouvertes | archives ZIP, mises à jour par lots | utilisable, mais aucun diff, aucun historique |
| **Dépôt Git `justicecanada/laws-lois-xml`** | le même XML, par fichier, versionné | **le bon canal** |

Le dépôt Git donne trois choses que ni l'EPUB de LégisQuébec ni les ZIP ne donnent :
`git log -1 -- fra/lois/B-3.xml` dit au fichier près si une loi a bougé (fin du scraping
de la date « À jour au ») ; `git diff` entre deux consolidations montre exactement ce qui a
changé, donc quels vecteurs réembarquer ; et le clone partiel (`--filter=blob:none`) permet
de ne tirer que les lois du corpus, pas les 971 fichiers de lois ni les 4 879 de règlements.

| Fait mesuré | Valeur |
|---|---|
| Lois codifiées, `lookup/lookup.xml` | 894 (1 788 entrées, × 2 langues) |
| Règlements codifiés, même fichier | 3 896 (7 792 entrées) |
| Fichiers XML de lois, par langue | 971 (+ 4 879 de règlements) — `lookup.xml` exclut les lois abrogées, d'où l'écart |
| Cadence des commits « Laws Site Update » | ~2 à 4 semaines (2026-02-18 → 2026-08-24) |
| Licence | Licence du gouvernement ouvert – Canada (`LICENSE.md`) |

Deux réserves juridiques à consigner quelque part de visible, parce qu'elles touchent R4.
D'abord, l'art. 31(1) de la *Loi sur la révision et la codification des textes législatifs*
(L.R.C. (1985), ch. S-20) donne force probante à la codification **publiée par le ministre**,
et l'art. 31(2) fait primer la loi d'origine en cas d'incompatibilité : une codification
retraitée par un tiers — nous — ne porte évidemment pas cette présomption. Ensuite, la
reproduction est permise à condition de veiller à l'exactitude et de ne pas se présenter
comme version officielle. Conclusion pratique : servir le texte verbatim, dater, et pointer
vers la page officielle — ce que le serveur fait déjà pour le Québec.

`lookup/lookup.xml` mérite une mention à part : titres FR/EN, numéro de chapitre, numéro
officiel, et — dans 832 des 1 788 entrées — les `<Relationships>` qui listent les règlements pris sous
la loi. C'est le graphe que `relations.json` cure à la main du côté québécois, fourni
gratuitement.

---

## 2. Le format LIMS, mesuré

Racine `<Statute>`, namespace `lims`, enfants directs : `Identification`, `Introduction`,
`Body`, puis N `Schedule`, puis `RecentAmendments`.

Équivalences avec ce que le pipeline connaît déjà :

| Notion | Irosoft / EPUB (Québec) | LIMS (fédéral) |
|---|---|---|
| Loi | métadonnées OPF | `Identification` |
| Division | `<div id="ga:…-gb:…">` — **chemin explicite** | `<Heading level="1..4">` — **séquence plate** |
| Article | `<div id="se:1457">` | `<Section>` + `<Label>` |
| Numéro | encodé dans l'`id` (`se:2926_1`) | `<Label>` textuel |
| Alinéa / paragraphe | `-ss:K`, `-p1:N`, `-p2:x` | `Subsection` → `Paragraph` → `Subparagraph` → `Clause` → `Subclause` |
| Historique | `<div>` 9pt après le texte | `HistoricalNote` / `HistoricalNoteSubItem` |
| Abrogation | « (Abrogé). » | `<Repealed>[Abrogé, 1997, ch. 15, art. 30]</Repealed>` |
| Intitulé d'article | *n'existe pas* | `MarginalNote` |
| Renvoi | `<a href>` vers un chapitre RLRQ | `XRefExternal reference-type="act" link="C-46"` |
| Terme défini | *non balisé* | `DefinedTermFr` **et** `DefinedTermEn`, dans le même fichier |

Deux gains structurels par rapport à l'EPUB. Le premier : les renvois sont typés et
pointent un numéro de chapitre, pas une URL à décortiquer — `schema-decouverte.sql` et
`discovery/relations.py` s'en nourrissent directement. Le second : chaque terme défini
porte son équivalent dans l'autre langue au même endroit, ce qui donne un lexique
bilingue exploitable par le pont de vocabulaire de la recherche sémantique.

**Le point le plus important** : la structure FR et EN est **positionnellement
isomorphe**. Mesuré sur 13 lois, en comparant la séquence plate du `Body` (`Heading` avec
son niveau, `Section` avec son `Label`) :

| Loi | nœuds FR | nœuds EN | identique ? | seule divergence |
|---|---|---|---|---|
| A-1 | 222 | 222 | oui | — |
| C-46 | 1 927 | 1 927 | non | `157 et 158` vs `157 and 158` |
| B-3 | 468 | 468 | non | `7 et 8` vs `7 and 8` |
| L-2 | 644 | 644 | non | `Préambule` vs `Preamble` |
| B-1.01 | 1 654 | 1 654 | non | `39.3 ` vs `39.3` (espace demi-cadratin) |
| I-21, F-29.2 | 84, 51 | 84, 51 | oui | — |

Aucune divergence de longueur ni de position : les seuls écarts sont lexicaux dans les
`Label`. Conséquence directe : **l'invariant 4 ne s'applique pas au corpus fédéral.** On
peut fabriquer un chemin de division *identique dans les deux langues*, et
`translateDivisionPath` devient un no-op pour ces lois — à condition de le vérifier à
chaque ingestion plutôt que de le supposer.

---

## 3. Les neuf pièges mesurés

C'est ici que se joue la qualité du parsing. Chacun de ces points produit, s'il est
manqué, exactement le défaut que `CLAUDE.md` refuse : faux, servi, silencieux.

| # | Piège | Mesure | Parade |
|---|---|---|---|
| 1 | `root.iter('Section')` ramasse du **droit non en vigueur** | C-46 : 294 `RelatedOrNotInForce` et 270 `AmendedText`, tous sous `Schedule/BillPiece`, contenant des `Section` aux **mêmes numéros** que le corps (ex. un art. 737 parallèle) | n'ingérer que `Body` (+ le préambule, cf. #6) ; refuser toute `Section` dont un ancêtre est `Schedule`, `BillPiece`, `RelatedOrNotInForce` ou `AmendedText` ; l'invariant de comptage doit être un scan sous `Body`, pas un `findall` global |
| 2 | Hiérarchie **plate** | C-46, `Body` : 324 `Heading` (41 de niveau 1, 265 de niveau 2, 18 de niveau 3) ; profondeur max observée = 4 (C-42) | reconstruction par pile sur l'attribut `level` ; le `parent_path` sort de la pile, pas du balisage |
| 3 | Le numéro de division est **facultatif** | C-46 : 38 `Heading` sur 324 portent un `Label` ; « PARTIE II » en a un, « Partie I » a son numéro **dans le `TitleText`** | ne jamais dériver le chemin du numéro ; `number` reste nullable (le schéma le permet déjà) |
| 4 | `Label` d'article en **plage** | 71 cas sur 11 930 articles scannés (0,6 %) : `257 à 264`, `56 à 59`, `7 et 8`, et leurs formes EN `to`/`and`. La plupart sont des **blocs abrogés** | expansion en jeu de numéros + table d'alias ; `sort_key` sur le premier numéro. Sans cela `get_article('b-1.01', '260')` répond « introuvable » là où la vraie réponse est « abrogé, art. 257 à 264 » |
| 5 | La **citation** n'est pas le numéro de chapitre | `ConsolidatedNumber official="yes"` → L.R.C. (1985), ch. C-46. `official="no"` + `AnnualStatuteId revised-statute="yes"` → **L.R.C. (1985), ch. 3 (2e suppl.)** pour la Loi sur le divorce, *pas* « ch. D-3.4 ». `official="no"` seul → L.C. 2000, ch. 5 pour la LPRPDE | construire la citation depuis `Chapter`, jamais depuis le nom de fichier. Trois formes, déterministes |
| 6 | Le **préambule** fait partie du texte | Art. 13 de la *Loi d'interprétation* : « Le préambule fait partie du texte ». Or il vit dans `Introduction/Preamble/Provision` (F-29.2) **ou** dans `Body` comme `Section` de `Label` « Préambule » (L-2) — balisage incohérent | traiter les deux emplacements ; pseudo-article `préliminaire`/`preamble`, comme les dispositions préliminaires du C.c.Q. |
| 7 | Note marginale et historique **ne sont pas** du texte | Art. 14 de la *Loi d'interprétation* : les notes marginales et les mentions de textes antérieurs « ne font pas partie de celui-ci, n'y figurant qu'à titre de repère ou d'information » | `MarginalNote` en colonne propre, jamais concaténée au texte ; `HistoricalNote` dans `history`, comme au Québec. C'est une exigence légale, pas un choix de présentation |
| 8 | Une loi peut être **édictée mais non en vigueur** | F-29.2 — votre exemple — en est précisément un cas : le `<Statute>` n'a **pas** `in-force="yes"`, un `ReaderNote` dit « non en vigueur », et le `ReversedShortTitle` du lookup porte « [Non en vigueur] ». C-46, B-3, D-3.4… portent tous `in-force="yes"` | capter `in-force` et le servir comme **champ obligatoire de `structuredContent`** (décision 001) ; les `lims:inforce-start-date` par élément permettent le même contrôle article par article |
| 9 | Trois **dates** distinctes, dont une trompeuse | `lims:current-date` = « À jour au », variable par loi (C-46 : 2026-06-21 ; I-15 : 2025-07-24). `lims:lastAmendedDate` = « Dernière modification » (I-15 : 2008-06-18). `LastConsolidationDate` du lookup = **uniforme à 20260622** : c'est la date du site, pas celle de la loi | `consol_date_*` ← `lims:current-date`. Ne jamais utiliser le lookup pour cette date : il donnerait la même à toutes les lois, et personne ne le verrait |

Un dixième point, terminologique mais réel pour un serveur bilingue : en anglais, *section*
désigne l'**article**, alors qu'en français fédéral « section » est un niveau de division
sous la partie. Un modèle anglophone demandera « section 265 of the Criminal Code » en
voulant l'article 265. La description de `qclaw_get_article` doit le dire — c'est
exactement le genre d'ambiguïté que l'invariant 13 punit si on l'écrit mal.

---

## 4. Comment parser

Un module neuf, `pipeline/parser_lims.py`, produisant les **mêmes dataclasses** `Law`,
`Division`, `Article` que `parser.py`. Aucun retouche du parseur EPUB : les deux formats
n'ont rien en commun, et la valeur du dépôt est que `load.py`, `validate.py` et le Worker
ne voient qu'un modèle. `ElementTree` de la bibliothèque standard suffit (pas de
BeautifulSoup) : c'est du XML valide, avec un namespace.

**Le chemin de division.** Positionnel, avec un préfixe de niveau : `fh1:3-fh2:5` = 5<sup>e</sup>
division de niveau 2 sous la 3<sup>e</sup> de niveau 1. Identique dans les deux langues (§2),
lisible, et compatible avec l'invariant 5 (intervalles lexicographiques, aucun `LIKE`).
Son défaut est réel et doit être traité de front : **il n'est pas stable entre
consolidations** — l'insertion d'une partie décale tout ce qui suit, ce qui périmerait les
vecteurs et `eval/cases.resolved.json` sans qu'aucun test n'échoue. La parade est un
contrôle d'ingestion, pas un espoir : conserver l'empreinte de l'arbre (séquence
`level` + `Label` + `TitleText` normalisé) et **arrêter pour revue humaine** quand elle
change. C'est déjà la logique de l'étape 2 de la procédure « Ajouter une loi »
(`recon.py`, arrêt si balisage inconnu).

L'alternative — dériver le chemin d'un slug du `TitleText` — a été écartée : les intitulés
sont propres à la langue, ce qui rouvrirait l'invariant 4 sur un corpus qui n'en a pas
besoin, et 88 % des divisions du Code criminel n'ont pas de numéro pour désambiguïser deux
intitulés identiques (« Définitions et interprétation » apparaît à plusieurs niveaux).

**La sérialisation du texte.** Différence de règle avec le Québec, à écrire noir sur blanc :
au Québec, seul le numéro d'article est retiré ; au fédéral, il faut retirer le `Label` de
l'article **mais conserver les `Label` internes**, parce qu'on cite « art. 183(1)a) L.F.I. »
et qu'un texte sans ses « (1) » et ses « a) » est inutilisable en litige. Prototype exécuté
sur la *Loi sur la faillite et l'insolvabilité*, art. 183 :

```
  (1) Les tribunaux suivants possèdent la compétence en droit et en equity […] :
    a) dans la province d'Ontario, la Cour supérieure de justice;
    b) [Abrogé, 2001, ch. 4, art. 33]
    c) dans les provinces de la Nouvelle-Écosse et de la Colombie-Britannique, la Cour suprême;
    […]
  (1.1) Dans la province de Québec, la Cour supérieure possède la compétence […]
```
avec, hors du texte : note marginale « Tribunaux compétents » et historique
« L.R. (1985), ch. B-3, art. 183; … 2015, ch. 3, art. 9 ».

Règles de rendu : exclure `MarginalNote`, `HistoricalNote` et le `Label` de la `Section` ;
descendre `Subsection`/`Paragraph`/`Subparagraph`/`Clause`/`Subclause` en conservant leur
`Label` et leur indentation ; rattacher `ContinuedSectionSubsection`, `ContinuedParagraph`
et `ContinuedDefinition` (97 + 26 + 7 dans C-46) **après** l'énumération qu'ils ferment,
sinon la phrase se disloque ; aplatir les éléments en ligne (`XRefExternal`, `Emphasis`,
`Sup`, `Language`, `DefinedTermFr/En`, `Repealed`) en conservant leur texte ; normaliser
les espaces Unicode comme le fait déjà `_norm` (le `39.3 ` de la *Loi sur les banques*
en est la démonstration) ; traiter `TableGroup`/`table` (CALS) et `FormGroup` à part —
7 tables et 94 formulaires dans C-46 — plutôt que de les aplatir en bouillie.

---

## 5. Comment intégrer : un corpus, une base, dix outils

**Recommandation : une seule base, un seul serveur, les dix outils inchangés.** Un second
serveur « Législation du Canada » serait plus propre en apparence et plus mauvais en
pratique. La raison est votre cas d'usage : en litige civil et commercial, la question
traverse les deux ordres — la faillite suspend l'instance civile, le divorce se plaide sous
une loi fédérale devant la Cour supérieure, la marque de commerce et le droit d'auteur se
défendent contre un fond de responsabilité civile du C.c.Q. Avec deux serveurs, c'est au
modèle de savoir qu'il doit interroger les deux et de fusionner lui-même — il ne le fera
pas de façon fiable, et `qclaw_find_relevant`, qui est précisément le routeur d'un problème
vers ses sources, perdrait la moitié de la carte. À quoi s'ajoutent les coûts qu'on
dupliquerait : recherche hybride, taxonomie, page publique, veille, jeton, évals.

L'intégration passe par le mécanisme qui existe déjà : `laws.config.json` gagne des entrées
en **fin de liste** (invariant 1), avec un discriminant de source.

```jsonc
{
  "id": "ca-b-3",
  "source": "justice-canada",              // ← nouveau : aiguille le parseur
  "name_fr": "Loi sur la faillite et l'insolvabilité",
  "name_en": "Bankruptcy and Insolvency Act",
  "official_cite": "L.R.C. (1985), ch. B-3",   // construite depuis <Chapter>
  "chapter": "B-3",
  "xml": { "fr": "fra/lois/B-3.xml", "en": "eng/acts/B-3.xml" },
  "fonction": "loi", "forum": ["c.s."], "numbering": "decimal"
}
```

Le préfixe `ca-` sur les `id` est délibéré : il rend l'ordre de `laws.config.json` lisible,
évite toute collision avec un chapitre RLRQ homonyme, et permet à `qclaw_list_laws` de
filtrer par ordre de gouvernement sans nouvelle colonne.

Sur `rlrq_cite` : la colonne devient un abus de nom, mais sa **sémantique** — « citation
officielle de la loi » — reste juste. Deux options. La renommer `official_cite`
(migration + `src/lib.ts`, `src/site.ts`, `pipeline/load.py`, `parseCitation`) est plus
honnête ; la garder et ne changer que ce qu'elle contient coûte trois fois moins et ne
mentira qu'aux lecteurs du schéma. Mon avis : renommer, parce que ce dépôt a déjà payé
pour des noms qui mentaient (le commentaire de `sort_key` décrivant une troisième échelle),
et qu'une colonne appelée `rlrq_cite` contenant « L.R.C. (1985), ch. C-46 » est le genre de
détail qui fait conclure à un futur lecteur que les deux côtés sont faux.

`qclaw_resolve_reference` doit apprendre les formes fédérales : `L.R.C. (1985), ch. B-3`,
`L.C. 2000, ch. 5`, `LFI`, `C.cr.`, `art. 183(1)a) LFI`, et les formes anglaises
`s. 183(1)(a) BIA`. Le `GARDE_FOU` de `find_relevant` et le refus circonstancié quand un
chapitre est cité mais absent du corpus fonctionnent tels quels — il suffit que le motif
de reconnaissance couvre les deux nomenclatures.

---

## 6. Ce que le schéma doit gagner

Quatre colonnes, une migration numérotée, un bookmark Time Travel avant `--remote`
(invariant 6).

| Colonne | Table | Pourquoi |
|---|---|---|
| `marginal_note` | `articles` | intitulé officiel d'article, hors texte par l'art. 14 I-21 ; excellent signal de repérage, à indexer dans FTS en colonne **séparée** |
| `in_force` | `laws` | F-29.2 est édictée et non en vigueur ; l'étiquette doit voyager dans `structuredContent` |
| `last_amended` | `laws` | « Dernière modification le … », que les juristes veulent et que `consol_date` ne dit pas |
| `number_alias` | table ou colonne | expansion des plages (`257 à 264` → 257…264) pour que `get_article` ne mente jamais par « introuvable » |

`divisions.kind` accueille `partie` et `annexe`, et un `rubrique` pour les intertitres non
numérotés — ils sont la majorité (286 sur 324 dans C-46). Le schéma a déjà des `kind`
génériques (`niveau6..8`), le précédent existe.

Dimensionnement, pour 16 lois candidates (FR seul, mesuré) :

| | Articles | Divisions | Texte |
|---|---|---|---|
| 16 lois, FR | 4 142 | 994 | 4,6 Mo |
| × 2 langues | ≈ 8 284 | ≈ 1 988 | ≈ 9,2 Mo |

À comparer à l'ordre de 49 000 articles relevés au corpus québécois (chiffre daté du
README, à lire en base) : +17 % environ. D1 et Vectorize absorbent
sans discussion ; le coût réel est le backfill de vecteurs et la calibration (§7).

---

## 7. Impact sur les cinq surfaces

Exigence de fin de tâche de `CLAUDE.md`, énoncée ici pour que rien ne reste en dette.

| # | Surface | Touchée ? | Ce qui bouge |
|---|---|---|---|
| 1 | Outils MCP (`src/tools.ts`) | **oui, sans nouvel outil** (R2 respectée) | `list_laws` gagne un filtre d'ordre de gouvernement ; `resolve_reference` apprend les citations fédérales ; `get_article` doit servir `marginal_note` et l'étiquette d'entrée en vigueur |
| 2 | Descriptions (`tools.ts`, `catalogue.json`) | **oui** | R3 borne le delta à 2 phrases par outil : une pour l'élargissement du corpus, une pour le piège *section* ≠ *article*. Coût en tokens à consigner |
| 3 | Schéma | **oui** | 4 colonnes, 1 migration, `structuredContent` élargi (jamais rétréci — décision 001) |
| 4 | `README.md` | **oui** | le dépôt s'annonce « législation québécoise » ; il faut le dire autrement, sans recopier de décompte |
| 5 | Page publique (`site.ts` + `catalogue.json`) | **oui** | deux ordres de gouvernement à distinguer visuellement, décomptes toujours **lus** en base |

Trois risques de calibration, à mesurer et non à supposer. L'invariant 12 d'abord : passer
de 79 à ~95 lois déplace `specificityFactor`, et c'est déjà arrivé qu'un bon chapitre du
C.p.c. disparaisse du top 8 sans erreur. L'invariant 15 ensuite : toute matière fédérale
nouvelle dépassant ~5 lois mappées est un candidat au défaut de diversité. Enfin la
recherche lexicale : les 20 cas d'éval sont québécois, donc l'éval avant/après mesurera la
**non-régression** du Québec mais ne dira rien de la couverture fédérale — il faudra des
cas fédéraux, et `eval/cases.json` est votre vérité terrain (⛔ : proposés, jamais
appliqués de mon chef).

---

## 8. Corpus fédéral proposé

Sélectif, comme le corpus québécois : 894 lois fédérales sont codifiées, une vingtaine
intéresse le litige civil et commercial. Tailles mesurées (FR, articles du `Body`).

| Chapitre | Loi | Art. | Pourquoi |
|---|---|---|---|
| B-3 | Faillite et insolvabilité | 395 | suspension de l'instance, art. 69 et s. ; compétence de la C.S. |
| C-36 | Arrangements avec les créanciers | 96 | restructuration |
| D-3.4 | Divorce | 97 | plaidée en C.S. |
| C-44 | Sociétés par actions | 297 | recours de l'actionnaire, art. 241 |
| C-34 | Concurrence | 215 | recours civil, art. 36 |
| C-42 | Droit d'auteur | 249 | PI en litige civil |
| T-13 | Marques de commerce | 121 | idem |
| L-2 | Code canadien du travail | 504 | entreprises fédérales |
| P-8.6 | LPRPDE | 71 | vie privée, interface avec la Loi 25 |
| I-21 | Interprétation | 50 | **structurante** : art. 13 et 14 cités plus haut |
| C-5 | Preuve au Canada | 115 | preuve devant les cours fédérales et en matière fédérale |
| F-7 | Cours fédérales | 66 | compétence |
| S-26 | Cour suprême | 106 | pourvois |
| C-50 | Responsabilité civile de l'État | 44 | poursuites contre la Couronne fédérale |
| I-15 | Intérêt | 11 | 11 articles, cités souvent |
| B-4 | Lettres de change | 198 | recouvrement |
| C-46 | Code criminel | 1 603 | à discuter — 1,9 Mo de texte, hors de votre pratique civile |

La *Loi constitutionnelle de 1982* (donc la Charte canadienne) n'est **pas** dans
`fra/lois` : elle est publiée séparément et suivrait un traitement à part.

---

## 9. Plan par phases

Chaque phase se termine par un arrêt pour revue, comme le veut `CLAUDE.md`.

**Phase 0 — reconnaissance.** Un `pipeline/discovery/recon_lims.py` qui balaie les lois
candidates et rapporte : inventaire complet des éléments rencontrés, profondeur des
`Heading`, `Label` non simples, `in-force` absent, tables et formulaires, et le contrôle
d'isomorphisme FR/EN. Arrêt si un élément inconnu apparaît. C'est ce document, exécutable
et daté — l'équivalent de `docs/phase0-structure-epub.md`, dont il faut une jumelle
`docs/phase0-structure-lims.md` qui devienne la référence vivante du nouveau parseur.

**Phase 1 — parseur et invariants.** `parser_lims.py` + tests sur témoins (art. 183 L.F.I.,
art. 2 F-29.2 pour les définitions, un bloc abrogé en plage, un article à table). Les
invariants de `validate.py` gagnent leur version fédérale : comptage des `Section` **sous
`Body`**, isomorphisme FR/EN, résolution de tous les `parent_path`, aucun numéro en
doublon.

**Phase 2 — schéma et chargement.** Migration numérotée, bookmark Time Travel, ingestion
locale puis distante loi par loi, `discovery/load.py` + `relations.py` (les
`<Relationships>` du lookup remplacent la curation manuelle), `verify.py`.

**Phase 3 — repérage.** Passe éditoriale sur `taxonomy.json` : sans mappage, une loi est
invisible au signal S1 (étape 5 de « Ajouter une loi »). Cas d'éval fédéraux **proposés**.
Backfill de vecteurs. Éval avant/après, porte : aucune régression sur les 20 cas.

**Phase 4 — surfaces et veille.** Les cinq surfaces du §7 ; puis remplacer, pour le
fédéral, le scraping de la date par un contrôle `git` : le SHA du fichier de chaque loi
comparé au dernier commit. Plus fiable que `extractConsolidation`, et le signal
`unreachable` disparaît.

---

## 10. Décisions à trancher avant la phase 1

1. **`rlrq_cite` → `official_cite`** : renommer (migration, plus honnête) ou garder le nom
   et changer le contenu (moins cher, mensonger pour le lecteur du schéma).
2. **Le Code criminel** dans le corpus ou hors corpus. Il pèse 1,9 Mo de texte et 1 603
   articles pour une pratique civile ; il tirerait la calibration vers le pénal
   (l'invariant 13 a déjà été déclenché par la matière « Procédure pénale »).
3. **Les règlements fédéraux** (3 896 codifiés) : aucun maintenant, ou d'emblée les *Règles des
   Cours fédérales* et les *Règles générales* de la L.F.I. ?
4. **Le chemin positionnel** : accepté avec le contrôle d'empreinte d'arbre, ou faut-il
   d'abord mesurer sa stabilité réelle sur deux consolidations (`git diff` entre le commit
   de février et celui d'août donne la réponse en une heure) ?
