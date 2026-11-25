# Plan directeur — Quarantaine par domaine (Phase 0) et expansion du corpus (Vagues 1 à 3)

**Date :** 2026-11-24  
**Branche Phase 0 :** `feat/domain-quarantine-phase0`

Ce document consigne l'architecture de quarantaine par domaine arrêtée avec Jason Poirier Lavoie et la feuille de route d'expansion fédérale et provinciale par vagues.

---

## 1. Architecture de quarantaine à 8 domaines (Phase 0)

### 1.1 Partitionnement du corpus

| Domaine | Rôle | Effectif Phase 0 |
|---|---|---|
| `core` *(défaut)* | Codes (`ccq`, `cpc`), cours judiciaires du Québec (`c-25.01-r.*`, `t-16`, `qccs-*`, `qccq-*`), cours suprêmes/responsabilité de l'État (`ca-s-26`, `ca-c-50`), droits fondamentaux/interprétation/preuve (`c-12`, `i-16`, `ca-i-21`, `ca-c-5`), justice administrative générale (`j-3*`), logement (`t-15.01*`), consommation/commercial (`p-40.1`, `ca-i-15`, `ca-b-4`, `ca-c-34`), sociétés/publicité (`s-31.1`, `c-38`, `ca-c-44`, `p-44.1`), faillite/divorce (`ca-b-3`, `ca-crc-368`, `ca-c-36`, `ca-d-3.4`), publicité des droits (`b-9`, `ccq-r.*`), vie privée/TI (`p-39.1`, `ca-p-8.6`, `a-2.1`, `c-1.1`), professions/Barreau (`b-1*`, `c-26`). | 52 |
| `cours-federales` | *Loi sur les Cours fédérales* (`ca-f-7`) et *Règles des Cours fédérales* (`ca-dors-98-106`), isolées pour éviter la collision avec le C.p.c. | 2 |
| `financier` | Valeurs mobilières, règlements et instructions générales AMF, assurances, dépôts, institutions financières (`v-1.1*`, `amf-ig-*`, `d-9.2*`, `e-6.1*`, `a-32.1`, `c-67.3`, `i-13.2.2`, `i-14.01`, `t-11.002`, `e-12.000001`, `a-33.01`). | 22 |
| `construction-immobilier` | Bâtiment/RBQ, GCR et courtage immobilier (`b-1.1*`, `c-73.2*`). | 11 |
| `municipal-environnement` | Droit municipal, fiscalité municipale, expropriation, contrats publics et AMP (`c-19`, `c-27.1`, `f-2.1`, `c-37.01`, `e-15.1.0.1`, `e-25`, `c-65.1`, `c-65.01`, `a-33.2.1`). | 9 |
| `travail` | Normes du travail, Code canadien du travail, fonction publique et divulgation (`n-1.1`, `ca-l-2`, `e-6`, `f-3.1`, `d-11.1`, `p-33.01`). | 6 |
| `penal` | Procédure pénale, confiscation, police et déontologie policière (`c-25.1`, `c-52.2`, `p-13.1*`). | 6 |
| `propriete-intellectuelle` | Droit d'auteur (`ca-c-42`) et marques de commerce (`ca-t-13`). | 2 |

### 1.2 Comportement des 10 outils (R2 — aucun nouvel outil)

- **Outils filtrés par `domains` (défaut `['core']`) :** `list_laws`, `find_relevant` et `search_text` (lorsque `law` est omis). Acceptent `domains` (liste de domaines ou `['all']`), `jurisdiction` (`'qc' | 'ca'`), et pour `find_relevant`/`search_text` un filtre optionnel `forum` (qui conserve toujours les lois substantielles/transversales sans restriction de forum).
- **Radar inter-domaines (R4 / R7) :** Les résultats principaux proviennent strictement des `domains` actifs ; une ligne de signalisation (`other_domains` dans `structuredContent`) avertit lorsqu'un domaine exclu contient des pistes ou correspondances lexicales.
- **Outils directs sans quarantaine :** `get_article`, `get_articles`, `get_structure`, `get_division`, `resolve_reference`, `related_laws` et `search_text(law=...)` restent ouverts à tout le corpus. Lorsqu'une recherche bornée à une loi s'élargit (`widened`), elle reste dans le domaine de cette loi (ou `domains` explicite).
- **Notes marginales fédérales (`marginal_note`) :** Indexées dans `articles_fts` (poids `MARGINAL_NOTE_WEIGHT = 0.5` contre `1.0` pour `text`), tout en gardant `snippet(articles_fts, 0, …)` sur `text` seul (art. 14 *Loi d'interprétation*). Incluses dans les vecteurs d'articles (`src/backfill.ts`) avec les métadonnées `domain` et `jurisdiction`.
- **Interrupteurs R8 :** `DOMAIN_QUARANTINE="1"` (défaut actif ; `"0"` rétablit le pool plat) et `VECTOR_DOMAIN_FILTER="1"` (activé après création des index de métadonnées Vectorize `domain`/`jurisdiction` et rattrapage complet Phase 0).

### 1.3 Procédure de mise en production Phase 0 (après approbation et fusion sur `main`)

1. Appliquer la migration D1 `0008_domains.sql` (`npm run deploy` ou `wrangler d1 migrations apply legislation --remote`).
2. Créer les index de métadonnées Vectorize avant tout upsert porteur (invariant 8) :
   ```powershell
   npx.cmd wrangler vectorize create-metadata-index legislation-articles --property-name=domain --type=string
   npx.cmd wrangler vectorize create-metadata-index legislation-articles --property-name=jurisdiction --type=string
   ```
3. Lancer le rattrapage complet des vecteurs (`articles` et `divisions` pour les 110 lois, en réactivant temporairement `workers_dev: true` pendant le backfill si nécessaire, invariant 9) afin de peupler `domain`, `jurisdiction` et les notes marginales fédérales.
4. Basculer `"VECTOR_DOMAIN_FILTER": "1"` dans `wrangler.jsonc` et déployer.
5. Mettre à jour le plugin compagnon `droit-civil-quebecois` (`skills/recherche-juridique/references/recherche-legislative.md` et autres feuilles) **uniquement après** déploiement de Phase 0 en production, car la production rejette tout argument `domains` inconnu tant que `additionalProperties: false` n'a pas été élargi.

---

## 2. Feuille de route d'expansion (Vagues 1 à 3)

### Vague 1 — Textes constitutionnels (`core`, PR dédiée — **livré en prod, `c69a956`**)
- **Ajouts en fin de `laws.config.json` (invariant 1) :** `ca-const-1867` (*Loi constitutionnelle de 1867*, art. 1–147) et `ca-const-1982` (*Loi constitutionnelle de 1982*, art. 1–61 — gardant la *Charte canadienne* art. 1–34 et l'art. 52 réunis).
- **Ingestion :** `pipeline/parser_pdf.py` via deux profils déclaratifs bornés par plages de pages sur les PDF consolidés officiels FR/EN de Justice Canada (évite la collision des numéros 1–61 entre 1867 et 1982, zéro parseur HTML neuf).
- **Citations (`resolve_reference`) :** Reconnaissance des abréviations *Charte canadienne*, *Canadian Charter*, *L.C. 1982*, *L.C. 1867*, *Constitution Act, 1867/1982*.

### Vague 2 — Lois sectorielles provinciales et fédérales (19 textes, `feat/wave2-sectoral-statutes`)
- **`core` :**
  - `c-11` — *Charte de la langue française*
  - `a-25` — *Loi sur l'assurance automobile* (immunité civile art. 83.57)
  - `c-37` — *Loi sur les commissions d'enquête*
  - `c-81` — *Loi sur le curateur public*
  - `n-3` — *Loi sur le notariat*
  - `ca-dors-2002-156` — *Règles de la Cour suprême du Canada*
  - `ca-c-7.75` — *Loi canadienne sur les organisations à but non lucratif*
  - *Note Cour d'appel du Québec (QCCA) :* Aucun recueil unifié de directives QCCA n'existe à l'instar de la C.S. ou de la C.Q. ; la pratique civile demeure régie par `c-25.01-r.0.2.01` (déjà au corpus) et des avis ponctuels du greffier.
- **`travail` :** `t-15.1` (*Loi instituant le TAT*) + `t-15.1-r.1.1` (*Règles de preuve et de procédure du TAT*), `c-27` (*Code du travail*), `a-3.001` (*LATMP*, immunité art. 438), `s-2.1` (*LSST*).
- **`municipal-environnement` :** `c-47.1` (*Loi sur les compétences municipales*), `a-19.1` (*LAU*), `q-2` (*LQE*), `p-41.1` (*LPTAA*).
- **`propriete-intellectuelle` :** `ca-p-4` (*Loi sur les brevets* / *Patent Act*), `ca-i-9` (*Loi sur les dessins industriels* / *Industrial Design Act*).
- **`financier` :** `s-29.02` (*Loi sur les sociétés de fiducie et les sociétés d'épargne*).

### Vague 3 — Silo criminel (`penal`, PR dédiée derrière interrupteur R8 `CRIMINAL_CORPUS`)
- **Ajouts :** `ca-c-46` (*Code criminel*), `ca-c-38.8` (*Loi réglementant certaines drogues et autres substances*), `ca-y-1.5` (*Loi sur le système de justice pénale pour les adolescents*) via `pipeline/parser_lims.py` (liste blanche `Body` + `Schedule` excluant impérativement `RelatedOrNotInForce` et `AmendedText`).
- **Garde-fou :** `CRIMINAL_CORPUS="0"` par défaut jusqu'à validation complète de la calibration et du backfill `penal`, et maintien strict hors de `core`.
