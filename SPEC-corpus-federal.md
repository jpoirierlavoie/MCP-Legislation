# SPEC — Corpus fédéral (lois et règlements) dans le serveur MCP « Législation »

**Destinataire : Claude Code, dans `MCP-Legislation-Quebec`.**
Spécification arrêtée le 2026-09-04. Toutes les valeurs chiffrées ci-dessous ont été
**mesurées** sur `justicecanada/laws-lois-xml` à `HEAD` (commit « Laws Site Update
2026-08-20 ») ; elles sont datées et ne font pas foi sur l'état courant (politique `docs/`).
La note de conception qui justifie ces choix est le document compagnon
« Intégrer la législation fédérale au serveur *Législation du Québec* » (2026-09-04).

> **Avant de commencer** : lire `CLAUDE.md` en entier. L'obligation préalable (cinq
> surfaces) s'applique à chaque commit de ce chantier, et les invariants 1, 2, 4, 5, 6,
> 12, 13 et 15 sont tous engagés. Un plan qui ne dit pas ce qu'il fait des cinq surfaces
> est un plan incomplet.

---

## 0. Décisions déjà prises (ne pas rouvrir)

| Décision | Choix arrêté par Jason |
|---|---|
| Architecture | **Une seule base, un seul serveur, les dix outils existants.** Aucun serveur « Législation du Canada » séparé. R2 tient : **aucun nouvel outil MCP.** |
| `laws.rlrq_cite` | **Renommée `official_cite`**, migration numérotée, toutes les surfaces suivies |
| Corpus | **16 lois fédérales + 2 règlements** (§9). **Le Code criminel est exclu** |
| Sortie de ce chantier | D'abord la **planification**, puis l'implémentation par phases, avec arrêt pour revue humaine à chaque fin de phase |

Hors portée : le Code criminel, la *Loi de l'impôt sur le revenu*, les lois
constitutionnelles (publiées hors `fra/lois`), les 3 894 autres règlements, les lois
annuelles (`annual-statutes-lois-annuelles/`), le point-in-time historique.

---

## 1. Acquisition

Source unique : le dépôt Git `https://github.com/justicecanada/laws-lois-xml`
(Licence du gouvernement ouvert – Canada). **Ne pas parser le HTML de
`lois.justice.gc.ca`. Ne pas utiliser les ZIP du portail des données ouvertes.**

Clone partiel dans un répertoire gitignoré, hors de l'arbre du dépôt :

```bash
git clone --filter=blob:none --no-checkout https://github.com/justicecanada/laws-lois-xml.git
# les blobs sont tirés à la demande par `git show HEAD:<chemin>` ; ~3 s par loi
```

`pipeline/config.py` gagne `LIMS_REPO` (chemin local) et `LIMS_REF` (défaut `HEAD`). Le
pipeline lit les fichiers par `git show <ref>:<chemin>` et **consigne le SHA du commit
utilisé** dans le rapport d'ingestion : c'est ce SHA qui rend une ingestion reproductible,
et la veille (§8) s'en sert.

Trois fichiers de référence dans ce dépôt : `lookup/lookup.xml` (métadonnées de toutes les
lois et règlements, dont les `<Relationships>` loi → règlements), `README.md` (exemples de
structure, **non normatif** — le dépôt le dit lui-même), `regulation_web.dtd`.

---

## 2. Modèle de données

### 2.1 Migration `migrations/0004_federal.sql`

Bookmark Time Travel consigné **avant** tout `--remote` (invariant 6). SQLite ne sait pas
renommer proprement une colonne dans tous les cas de figure : vérifier le comportement de
D1 sur `ALTER TABLE laws RENAME COLUMN rlrq_cite TO official_cite` en local avant de le
jouer à distance, et prévoir le repli table-fantôme + copie si le renommage échoue.

```sql
ALTER TABLE laws RENAME COLUMN rlrq_cite TO official_cite;
ALTER TABLE laws ADD COLUMN jurisdiction  TEXT NOT NULL DEFAULT 'qc';  -- 'qc' | 'ca'
ALTER TABLE laws ADD COLUMN in_force      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE laws ADD COLUMN last_amended  TEXT;
ALTER TABLE laws ADD COLUMN unit          TEXT NOT NULL DEFAULT 'article'; -- 'article' | 'regle'
ALTER TABLE articles ADD COLUMN marginal_note TEXT;
CREATE TABLE article_numbers (            -- expansion des Label de plage (§3.6)
  law_id TEXT NOT NULL, lang TEXT NOT NULL,
  number TEXT NOT NULL,                   -- numéro demandé par l'usager : '260'
  article_id INTEGER NOT NULL REFERENCES articles(id),
  PRIMARY KEY (law_id, lang, number)
);
```

`schema.sql` **ne bouge pas** : il décrit l'état initial, les migrations s'appliquent
par-dessus (piège documenté dans `CLAUDE.md`, « Reconstruire une base à partir de rien »).
Vérifier que le bootstrap `schema.sql` → `0001…0004` passe sur une base vierge, en CI.

`articles_fts` doit gagner `marginal_note` comme **colonne indexée distincte** (jamais
concaténée au texte : art. 14 de la *Loi d'interprétation*, §3.5). Une table FTS5 à
contenu externe ne s'altère pas : la recréer et la repeupler dans la même migration.

### 2.2 `laws.config.json` — entrée fédérale

**Ajouter en FIN de liste, jamais ailleurs** (invariant 1 : `_id_base()` dérive les plages
d'id de la position). Mettre à jour `ORDRE_ATTENDU` dans `pipeline/tests/test_config.py`
dans le même commit.

```jsonc
{
  "id": "ca-b-3",
  "jurisdiction": "ca",
  "source": "lims",                                  // aiguille vers parser_lims
  "name_fr": "Loi sur la faillite et l'insolvabilité",
  "name_en": "Bankruptcy and Insolvency Act",
  "official_cite": "L.R.C. (1985), ch. B-3",          // DÉRIVÉE, cf. §3.4 — la config la
  "official_cite_en": "R.S.C. 1985, c. B-3",          //   porte pour lisibilité, le
  "chapter": "B-3",                                   //   parseur la RECALCULE et compare
  "xml": { "fr": "fra/lois/B-3.xml", "en": "eng/acts/B-3.xml" },
  "unit": "article",
  "fonction": "loi",
  "forum": ["c.s."],
  "numbering": "decimal"
}
```

Pour un règlement : `"fonction": "reglement"`, `"unit": "regle"` le cas échéant,
`"enabling": "ca-f-7"` (à **vérifier** contre `EnablingAuthority`, §3.4), et
`"xml": { "fr": "fra/reglements/DORS-98-106.xml", "en": "eng/regulations/SOR-98-106.xml" }`.

Le préfixe `ca-` sur les `id` est obligatoire : il évite toute collision avec un chapitre
RLRQ homonyme et rend l'ordre du fichier lisible.

Deux vérifications de sûreté avant d'écrire : `_id_base()` alloue 10⁷ id par couple
(loi, langue), et le plus gros texte du corpus fédéral compte 605 articles et 263
divisions — aucune pression sur les plages. Et `article_numbers` ne reçoit **que** les
numéros couverts par un `Label` de plage : la résolution reste `articles.number` d'abord,
`article_numbers` en second. Sa clé primaire garantit qu'aucune plage n'en recouvre une
autre ; un conflit d'insertion est un échec d'ingestion, pas un `INSERT OR IGNORE`.

---

## 3. `pipeline/parser_lims.py` — le cœur

**Contrat.** Module neuf. Aucune modification de `parser.py` (EPUB Irosoft). Signature
symétrique de `parse_epub` :

```python
def parse_lims(xml_bytes: bytes, law: Law, lang: str) -> tuple[list[Division], list[Article]]
```

Mêmes dataclasses `Law`/`Division`/`Article` (`pipeline/model.py`), pour que `load.py`,
`validate.py` et le Worker ne voient qu'un seul modèle. `xml.etree.ElementTree` de la
bibliothèque standard suffit — c'est du XML valide, namespace `lims` =
`http://justice.gc.ca/lims`. Pas de BeautifulSoup.

### 3.1 Ce qu'on ingère, ce qu'on refuse — **règle la plus importante du chantier**

Racine `<Statute>` (loi) ou `<Regulation>` (règlement), enfants directs `Identification`,
`Introduction`, `Body`, N × `Schedule`, `RecentAmendments`.

| Élément | Traitement |
|---|---|
| `Body` | **ingéré** — la source des articles et des divisions |
| `Introduction/Preamble` | **ingéré** en pseudo-article (§3.7) — le préambule fait partie du texte : art. 13 *Loi d'interprétation* |
| `Schedule` | **ingéré**, en division `kind='annexe'` (§3.8) — indispensable : les **Tarifs A et B** des *Règles des Cours fédérales* sont des annexes |
| `Schedule[@spanlanguages='yes']` | **ingéré mais EXCLU de FTS et des vecteurs** (§3.8) — formulaires bilingues côte à côte : 88 des 92 annexes de DORS/98-106 |
| `BillPiece`, `RelatedOrNotInForce`, `AmendedText`, `SectionPiece` | **REFUSÉS** |
| `RecentAmendments`, `Identification` (hors métadonnées) | non ingérés |

**Interdiction formelle** : `root.iter('Section')` et `root.findall('.//Section')`. Mesure
sur le Code criminel : 294 `RelatedOrNotInForce` et 270 `AmendedText` contiennent des
`Section` portant les **mêmes numéros** que le corps — un art. 737 parallèle, non en
vigueur. `DORS/98-106` en contient 2. Une ingestion naïve produirait des doublons de
numéros dont l'un est du droit inapplicable : faux, servi, silencieux. Le parseur
descend **explicitement** `Body` puis chaque `Schedule`, et refuse toute `Section` dont un
ancêtre figure dans la ligne « REFUSÉS ». Écrire un test qui l'affirme.

### 3.2 Reconstruction de la hiérarchie

`Body` est une **séquence plate** : `Heading` (attribut `level`, 1 à 4 mesuré) et `Section`
alternés. Pile classique : à un `Heading` de niveau *n*, dépiler jusqu'à *n-1*, empiler ;
un `Article` prend pour `division_path` le sommet de pile.

`Division.path` — **positionnel**, préfixe de niveau, segments joints par `-` :
`fh1:3-fh2:5`. Propriétés voulues : identique dans les deux langues (mesuré, §3.3), aucun
`_` (invariant 5 : `_` est un joker LIKE), compatible avec l'intervalle lexicographique
`[path+'-', path+'.')` de `subtreeClause`. Vérifier que `fh` n'entre pas en conflit avec le
découpeur de segments d'Irosoft (`_SEG_SPLIT`), qui ne connaît que `ga:`…`gi:` — les deux
familles de chemins cohabitent en base, donc tout code qui découpe un chemin doit
reconnaître les deux ou être appelé sur le bon corpus.

`Division.kind` : `partie` si le `Label` ou le `TitleText` commence par PARTIE/PART,
`annexe` pour les `Schedule`, sinon `rubrique`. **Ne pas dériver le `kind` du seul
`level`** : sur 324 `Heading` du Code criminel, 286 n'ont **aucun** `Label`, et « Partie I »
porte son numéro dans le `TitleText` alors que « PARTIE II » a un vrai `Label`. `number`
reste nullable ; l'extraire du `Label` quand il existe, sinon d'un motif en tête de
`TitleText`, sinon `NULL`.

### 3.3 Invariant d'isomorphisme FR ↔ EN — à faire respecter par le code

Mesuré sur 13 lois : la séquence plate du `Body` a **exactement** la même longueur et le
même ordre en français et en anglais (A-1 : 222/222 ; C-46 : 1 927/1 927 ; B-1.01 :
1 654/1 654). Les seuls écarts sont lexicaux dans les `Label` (`157 et 158` / `157 and
158`, `Préambule` / `Preamble`, un espace demi-cadratin U+2002 dans `39.3 `).

Donc, pour le corpus fédéral, **l'invariant 4 ne s'applique pas** : le chemin de division
est le même dans les deux langues et `translateDivisionPath` est un no-op. Cette propriété
est un **acquis à défendre, pas une hypothèse** : `validate.py` doit comparer les deux
langues et **échouer** si la longueur, la séquence de niveaux, ou le jeu de numéros
normalisés diverge. Une divergence signifie que Justice Canada a changé son balisage :
arrêt pour revue humaine, pas de contournement.

### 3.4 Citation officielle — trois formes, déterministes

À dériver de `Identification/Chapter`, **jamais du nom de fichier** :

| Balisage | Citation FR | Exemple mesuré |
|---|---|---|
| `ConsolidatedNumber official="yes"` | `L.R.C. (1985), ch. <N>` | `L.R.C. (1985), ch. B-3` |
| `official="no"` + `AnnualStatuteId revised-statute="yes"` | `L.R.C. (<AAAA>), ch. <NumAnnuel>` | **`L.R.C. (1985), ch. 3 (2e suppl.)`** pour la *Loi sur le divorce* — et non « ch. D-3.4 », qui n'est pas une citation |
| `official="no"` + `AnnualStatuteId` | `L.C. <AAAA>, ch. <N>` | `L.C. 2000, ch. 5` pour la LPRPDE |

`AnnualStatuteNumber` peut contenir du balisage (`3 (2<Sup>e</Sup> suppl.)`) : aplatir en
texte. Formes anglaises : `R.S.C. 1985, c. B-3` / `S.C. 2000, c. 5`.

Règlements : la citation **est** `Identification/InstrumentNumber` (`DORS/98-106`,
`C.R.C., ch. 368`), et `Identification/EnablingAuthority/XRefExternal/@link` donne la loi
habilitante (`F-7` pour les *Règles des Cours fédérales*, `B-3` pour les *Règles
générales*) : la charger telle quelle dans `law_relations` plutôt que de la curer.

`citationOf()` (`src/lib.ts`) doit produire `<official_cite>, art. N` ou `<official_cite>,
règle N` selon `laws.unit`, et sa forme anglaise (`s. N` / `rule N`). Le parseur recalcule
la citation et **compare** à celle de la config : divergence = échec d'ingestion.

### 3.5 Sérialisation du texte de l'article

Différence de règle avec le Québec, à écrire dans le module et dans
`docs/phase0-structure-lims.md` : au Québec seul le numéro d'article est retiré ; au
fédéral on retire le `Label` de la `Section` **mais on conserve tous les `Label`
internes**, parce qu'on plaide « art. 183(1)a) L.F.I. ».

- exclure `MarginalNote`, `HistoricalNote`/`HistoricalNoteSubItem`, et le `Label` de la `Section` ;
- descendre `Subsection` → `Paragraph` → `Subparagraph` → `Clause` → `Subclause` en conservant `Label` et indentation ;
- rattacher `ContinuedSectionSubsection`, `ContinuedParagraph`, `ContinuedDefinition` **après** l'énumération qu'ils ferment, sinon la phrase se disloque ;
- aplatir les éléments en ligne en conservant leur texte : `XRefExternal`, `XRefInternal`, `Emphasis`, `Sup`, `Language`, `DefinedTermFr`, `DefinedTermEn`, `DefinitionRef`, `Repealed`, `Leader`, `LeaderRightJustified`, `FootnoteRef` ;
- `TableGroup`/`table` (CALS) et `FormGroup` : rendu tabulaire propre, **pas** d'aplatissement en bouillie ;
- normaliser les espaces Unicode comme `_norm` le fait déjà (U+00A0, U+2002, U+2009).

`marginal_note` ← `MarginalNote` de la `Section`. `history` ← `HistoricalNote`, sous-items
joints par `; ` (même forme que le Québec). `repealed = 1` si le texte de l'article se
réduit à un `<Repealed>`. Témoin de recette, à figer dans un test :

```
art. 183 L.F.I. — note marginale « Tribunaux compétents »
  (1) Les tribunaux suivants possèdent la compétence en droit et en equity […] :
    a) dans la province d'Ontario, la Cour supérieure de justice;
    b) [Abrogé, 2001, ch. 4, art. 33]
    […]
  (1.1) Dans la province de Québec, la Cour supérieure possède la compétence […]
historique : « L.R. (1985), ch. B-3, art. 183; … 2015, ch. 3, art. 9 »
```

### 3.6 Numéros, plages, clé de tri

`Article.number` ← `Label` normalisé. **Mesure rassurante** : sur les 18 textes du corpus
retenu, dans les deux langues, la profondeur maximale d'un numéro est de **2 composantes**
et la composante maximale vaut **992** — l'échelle `sort_key()` en base 1000 sur 5
composantes fonctionne **sans modification** (invariant 2 préservé, marge à surveiller).

**Labels de plage** : 71 cas sur 11 930 articles scannés (0,6 %), formes `257 à 264`,
`56 à 59`, `7 et 8` et leurs équivalents `to`/`and`. La majorité sont des **blocs abrogés
en bloc**. Traitement : `Article.number` garde le `Label` verbatim (`"257 à 264"`), et
`article_numbers` reçoit une ligne par numéro couvert. `sort_key` se calcule sur le premier
numéro. Sans cela, `qclaw_get_article(law="ca-b-1.01", article="260")` répondrait
« introuvable » là où la vraie réponse est « abrogé, art. 257 à 264 » — un faux silencieux
sur une question d'abrogation.

**Le préambule**. Deux emplacements selon la loi : `Introduction/Preamble/Provision`
(F-29.2) **ou** une `Section` du `Body` de `Label` « Préambule » / « Preamble » (Code
canadien du travail). Traiter les deux, en pseudo-article `preambule`, division
`kind='disposition'`. Attention : `sort_key()` renvoie `DISPOSITION_SORT_BASE` (9e15) pour
tout numéro non numérique, ce qui enverrait le préambule **à la fin** du corpus. Lui donner
0, comme « préliminaire ».

### 3.7 Entrée en vigueur et dates — trois dates, dont une trompeuse

| Champ | Source | Mesure |
|---|---|---|
| `laws.in_force` | attribut `in-force` de la racine | absent ⇒ 0. F-29.2 (*Loi sur la transparence et la responsabilité en matière d'influence étrangère*) est **édictée et non en vigueur** ; les 18 textes du corpus retenu portent tous `in-force="yes"` |
| `laws.consol_date_*` | `lims:current-date` | « À jour au », **variable par loi** : C-46 2026-06-21, I-15 2025-07-24 |
| `laws.last_amended` | `lims:lastAmendedDate` | « Dernière modification » : I-15 2008-06-18 |
| — | `LastConsolidationDate` du lookup | **NE PAS UTILISER** : uniforme à `20260622` pour les 1 788 entrées. C'est la date du site, pas celle de la loi. L'employer donnerait la même date à toutes les lois, et personne ne le verrait |

`in_force = 0` doit voyager dans `structuredContent` comme **champ obligatoire** de toute
réponse portant sur cette loi (R4, corollaire structuré, décision 001) : un client qui
jette la prose doit garder l'étiquette. Le pipeline **refuse** l'ingestion d'une loi
`in_force = 0` sauf `--allow-not-in-force` explicite.

### 3.8 Annexes

`Schedule > ScheduleFormHeading > Label` (`TARIF B`) + `OriginatingRef` (`(règles 400 et
407)`) + `TitleText` → division `kind='annexe'`, `path` `fs:<n>`. Le contenu vit sous
`RegulationPiece` (règlements) ou directement, avec le **même** vocabulaire que le `Body`
(`Heading`, `Section`, `Subsection`…) : réutiliser le même walker.

Les 88 annexes `spanlanguages="yes"` de DORS/98-106 sont des **formulaires bilingues côte
à côte** : le fichier français contient du texte anglais. Les ingérer pour qu'un usager
puisse lire la formule 18, mais les **exclure de `articles_fts` et de Vectorize** — sinon
une requête française remonte du texte anglais et les embeddings sont pollués. Marquer la
division, et le dire dans la réponse de l'outil.

---

## 4. Validation (`pipeline/validate.py`)

Invariants fédéraux, tous bloquants (`--no-strict` pour forcer, comme aujourd'hui) :

1. **Comptage sous `Body`** : le nombre d'articles ingérés égale le nombre de `Section`
   enfants directs de `Body`, plus les annexes ingérées, plus le préambule. Le miroir de
   l'invariant « phase B » du Québec — mais le scan doit être **sous `Body`**, pas un
   `findall` global (§3.1).
2. **Aucun élément REFUSÉ** n'a produit d'article : assertion explicite sur les ancêtres.
3. **Isomorphisme FR/EN** (§3.3) : longueur, séquence de niveaux, jeux de numéros après
   expansion des plages.
4. **Aucun numéro en doublon** dans `(law_id, lang)` après expansion.
5. **Tous les `parent_path` résolvent** ; aucun chemin ne contient `_`.
6. **Citation recalculée = citation de la config** (§3.4).
7. **`sort_key` strictement croissant** dans l'ordre du document, et miroir avec
   `sortKeyOf()` de `src/lib.ts`.
8. **Empreinte d'arbre** : la séquence (`level`, `Label`, `TitleText` normalisé) est
   consignée dans `pipeline/out/` à chaque ingestion. Si elle diffère de la précédente,
   **arrêt pour revue humaine** : c'est le seul garde-fou contre l'instabilité du chemin
   positionnel entre consolidations, et il doit être visible, pas silencieux.

---

## 5. Worker (`src/`) — dix outils, aucune addition

| Outil | Ce qui change |
|---|---|
| `qclaw_list_laws` | filtre `jurisdiction` (`qc`/`ca`) ; expose `official_cite`, `in_force`, `last_amended`, `unit` |
| `qclaw_get_article` / `get_articles` | servent `marginal_note` (étiquetée : ne fait pas partie du texte, art. 14 *L.i.*) ; résolvent via `article_numbers` ; citation selon `unit` |
| `qclaw_resolve_reference` | apprend `L.R.C. (1985), ch. B-3`, `L.C. 2000, ch. 5`, `DORS/98-106`, `C.R.C., ch. 368`, les abréviations `L.F.I.`/`BIA`, `L.c.s.a.`/`CBCA`, `règle 400 R.C.F.`, et les formes `art. 183(1)a)` / `s. 183(1)(a)`. Le refus circonstancié (chapitre cité mais hors corpus) fonctionne tel quel |
| `qclaw_related_laws` | charge `EnablingAuthority` et les `<Relationships>` du lookup |
| `qclaw_find_relevant` | dépend entièrement de `taxonomy.json` (§6) ; `GARDE_FOU` imposé mot pour mot, inchangé |
| `qclaw_search_text` | l'échelle de recherche ne bouge pas (invariant 7) ; exclure les divisions `spanlanguages` |
| `qclaw_get_structure` / `get_division` | rien de particulier, hors les nouveaux `kind` |

`citationOf()`, `parseCitation()`, `sortKeyOf()`, `subtreeClause()`,
`translateDivisionPath()` : chacun doit être relu en se demandant ce qu'il fait d'un chemin
`fh1:…`. Écrire les tests avant de toucher au code.

Terminologie, à dire dans la description de `qclaw_get_article` (R3 : ≤ 2 phrases, delta de
tokens à consigner) : en anglais ***section* désigne l'article**, alors qu'en français
fédéral « section » est un niveau de division ; et les *Règles des Cours fédérales* se
citent par **règle**, non par article. Respecter l'invariant 13 : n'écrire dans une
description que le vocabulaire qu'on **veut** voir matcher, jamais de tournure
contrastive du type « à ne pas confondre avec ».

---

## 6. Découverte, taxonomie, relations

`taxonomy.json` est **⛔ éditorial** : proposer les matières fédérales et leurs mappages,
ne rien appliquer sans la passe de Jason. Sans mappage, une loi est invisible au signal S1
(étape 5 de « Ajouter une loi ») — donc une ingestion sans passe éditoriale livre un
corpus muet, ce qui doit être dit explicitement en fin de phase.

Deux risques de calibration à **mesurer**, pas à supposer : l'invariant 12 (passer de 79 à
97 textes déplace `specificityFactor` ; un bon chapitre du C.p.c. a déjà disparu du top 8
sans erreur) et l'invariant 15 (`MAX_PER_SUBJECT = 3` : toute matière fédérale nouvelle
dépassant ~5 textes mappés est candidate au défaut de diversité).

`eval/cases.json` est ⛔ : proposer des cas fédéraux, ne jamais les appliquer soi-même. Les
20 cas existants mesurent la **non-régression québécoise** et ne disent rien de la
couverture fédérale — le dire dans le rapport plutôt que de laisser croire le contraire.

---

## 7. Veille de consolidation

Pour le corpus fédéral, remplacer le scraping de la date par un contrôle Git : pour chaque
texte, `git log -1 --format=%H -- <chemin>` comparé au SHA consigné à l'ingestion. C'est
plus fiable que `extractConsolidation` (aucun miroir HTML à maintenir), et le signal
`unreachable` disparaît pour ces textes. Cadence mesurée des commits « Laws Site Update » :
2 à 4 semaines (2026-02-18 → 2026-08-24). Conserver les **deux signaux séparés**
(`drift` / `unreachable`) et la règle : une source injoignable est un texte **non
vérifié**, pas un texte à jour. `scripts/check-consolidation.mjs` et ses 13 contrôles
restent la référence du côté québécois.

---

## 8. Phases et critères d'acceptation

Un commit par sous-tâche, commits signés, **arrêt pour revue humaine à chaque fin de
phase**.

| Phase | Livrable | Critère d'acceptation |
|---|---|---|
| **0 — reconnaissance** | `pipeline/discovery/recon_lims.py` + `docs/phase0-structure-lims.md` (référence vivante du parseur, appelée par le code, à l'image de `phase0-structure-epub.md`) | balayage des 18 textes × 2 langues : inventaire exhaustif des éléments, profondeur des `Heading`, `Label` non simples, `in-force`, `spanlanguages`, isomorphisme FR/EN. **Zéro élément inconnu** ou arrêt |
| **1 — parseur** | `parser_lims.py` + tests | témoins figés : art. 183 L.F.I., art. 2 F-29.2 (définitions), un bloc abrogé en plage de la *Loi sur les banques*, le Tarif B des R.C.F., le préambule du C.c.t. Les 8 invariants du §4 passent sur les 18 textes. `PYTHONUTF8=1 … -m unittest discover -s pipeline/tests` vert |
| **2 — schéma et chargement** | `0004_federal.sql`, `load.py` étendu, `article_numbers` | bootstrap `schema.sql` → `0001…0004` sur base vierge, en CI. Bookmark Time Travel consigné. Ingestion locale des 18 textes, puis distante, texte par texte. `npx tsc --noEmit` vert |
| **3 — Worker** | `src/lib.ts`, `src/tools.ts`, `src/relevance.ts` | `node --test tests/catalogue.test.mjs` vert ; `npm run evals` vert ; `npm run eval` : **aucune régression sur les 20 cas** |
| **4 — repérage** | propositions `taxonomy.json`, `relations.json`, cas d'éval, backfill de vecteurs | propositions **livrées, non appliquées** (⛔). Backfill par `legislation.jpoirierlavoie.workers.dev` (invariant 9, WAF), refermé ensuite |
| **5 — surfaces** | `README.md`, `catalogue.json`, `src/site.ts`, `CLAUDE.md` | les cinq surfaces énoncées une par une, y compris « non touchée ». Aucun décompte écrit à la main (R10) |

---

## 9. Corpus arrêté

**16 lois** (mesures FR, articles du `Body`) :

| Chapitre | Loi | Citation dérivée | Art. | Div. |
|---|---|---|---|---|
| B-3 | Loi sur la faillite et l'insolvabilité | L.R.C. (1985), ch. B-3 | 395 | 73 |
| C-36 | Loi sur les arrangements avec les créanciers des compagnies | L.R.C. (1985), ch. C-36 | 96 | 23 |
| D-3.4 | Loi sur le divorce | **L.R.C. (1985), ch. 3 (2e suppl.)** | 97 | 44 |
| C-44 | Loi canadienne sur les sociétés par actions | L.R.C. (1985), ch. C-44 | 297 | 35 |
| C-34 | Loi sur la concurrence | L.R.C. (1985), ch. C-34 | 215 | 62 |
| C-42 | Loi sur le droit d'auteur | L.R.C. (1985), ch. C-42 | 249 | 104 |
| T-13 | Loi sur les marques de commerce | L.R.C. (1985), ch. T-13 | 121 | 31 |
| L-2 | Code canadien du travail | L.R.C. (1985), ch. L-2 | 504 | 140 |
| P-8.6 | LPRPDE | **L.C. 2000, ch. 5** | 71 | 26 |
| I-21 | Loi d'interprétation | L.R.C. (1985), ch. I-21 | 50 | 34 |
| C-5 | Loi sur la preuve au Canada | L.R.C. (1985), ch. C-5 | 115 | 25 |
| F-7 | Loi sur les Cours fédérales | L.R.C. (1985), ch. F-7 | 66 | 17 |
| S-26 | Loi sur la Cour suprême | L.R.C. (1985), ch. S-26 | 106 | 28 |
| C-50 | Loi sur la responsabilité civile de l'État et le contentieux administratif | L.R.C. (1985), ch. C-50 | 44 | 20 |
| I-15 | Loi sur l'intérêt | L.R.C. (1985), ch. I-15 | 11 | 3 |
| B-4 | Loi sur les lettres de change | L.R.C. (1985), ch. B-4 | 198 | 28 |
| | **Total** | | **2 635** | **693** |

**2 règlements** :

| Instrument | Titre | Habilitante | Corps | Div. | Annexes |
|---|---|---|---|---|---|
| DORS/98-106 | Règles des Cours fédérales | F-7 | 605 règles | 171 | 92, dont **88 bilingues côte à côte** et les **Tarifs A et B** |
| C.R.C., ch. 368 | Règles générales sur la faillite et l'insolvabilité | B-3 | 160 | 50 | 3 |

Dimensionnement : ≈ 3 416 articles FR, donc **≈ 6 800 articles sur deux langues** et
≈ 2 100 divisions — de l'ordre de +14 % sur le corpus québécois existant. D1 et Vectorize
absorbent ; le coût réel est le backfill de vecteurs et la recalibration du repérage.

---

## 10. Ce qui doit apparaître dans le plan

Un plan acceptable répond explicitement à ces points, dans cet ordre : (1) le renommage
`rlrq_cite` → `official_cite` et son onde de choc sur `src/lib.ts`, `src/site.ts`,
`src/tools.ts`, `pipeline/load.py`, `parseCitation`, `catalogue.json`, `README.md` ;
(2) la stratégie de test du parseur **avant** son écriture (témoins du §8, phase 1) ;
(3) le sort des chemins `fh1:` dans chaque fonction du Worker qui découpe un chemin ;
(4) ce que devient `translateDivisionPath` pour un corpus isomorphe ; (5) l'ordre exact des
opérations D1 (bookmark, migration locale, migration distante, ingestion) ; (6) les cinq
surfaces, une par une, y compris celles qui ne bougent pas ; (7) ce que le plan **ne** fera
pas et pourquoi.
