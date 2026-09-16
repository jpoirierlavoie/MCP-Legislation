-- Migration 0004 — accueil du corpus fédéral (2026-09-11).
--
-- SAUVEGARDE PRÉALABLE — bookmark Time Travel relevé AVANT tout `--remote` (invariant 6,
-- l'export D1 étant bloqué par la table virtuelle articles_fts) :
--   0000019b-00000000-000050e3-804205320c416c64fc1620f49c080bb0
--
-- ⚠️ C'est la SEULE migration destructive de ce dépôt : elle DÉTRUIT et RECONSTRUIT
-- `articles_fts`. L'en-tête de 0003 s'était explicitement interdit cette opération, et sa
-- prémisse s'est révélée fausse à la mesure — voir « pourquoi maintenant » plus bas.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- POURQUOI LE RENOMMAGE EST SÛR, et pourquoi le repli du SPEC §2.1 est ÉCARTÉ
-- ═══════════════════════════════════════════════════════════════════════════════
-- Mesuré en lecture seule sur la base de production le 2026-09-07 :
--   * `SELECT type,name FROM sqlite_master WHERE type IN ('trigger','view')` -> 0 ligne ;
--   * une SEULE ligne de `sqlite_master` nomme la colonne (le `CREATE TABLE laws`), donc
--     aucun index, index partiel, CHECK, clé étrangère ni colonne générée n'en dépend ;
--   * `articles_fts` est adossée à `articles`, JAMAIS à `laws` ;
--   * `ALTER TABLE … DROP COLUMN` — strictement plus restrictif, et invisible du même code
--     d'autorisation SQLITE_ALTER_TABLE — a DÉJÀ tourné sur cette base (0002, 2026-07-23).
-- `RENAME COLUMN` préserve le `NOT NULL` de schema.sql, ce qu'un `ADD COLUMN` n'aurait pas
-- pu faire (SQLite l'interdit sans DEFAULT).
--
-- Le SPEC §2.1 prévoyait un repli « table-fantôme + copie ». Il est PLUS DANGEREUX que le
-- renommage : `PRAGMA foreign_keys` vaut 1 en production, et `articles.law_id` comme
-- `divisions.law_id` déclarent `REFERENCES laws(id)`. Un `DROP TABLE laws` violerait la
-- contrainte sur ~49 000 lignes, et un `ALTER TABLE laws RENAME TO laws_old` réécrirait
-- silencieusement ces clauses en `laws_old(id)`. Ce repli est donc RETIRÉ du plan.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- schema.sql NE BOUGE PAS — et c'est une règle, pas un oubli
-- ═══════════════════════════════════════════════════════════════════════════════
-- `schema.sql:12` reste `rlrq_cite TEXT NOT NULL` mot pour mot. La CI joue `schema.sql`
-- PUIS les migrations sur une base vierge ; si `schema.sql` déclarait déjà `official_cite`,
-- le RENAME ci-dessous échouerait sur « no such column », SQLite n'ayant pas de
-- `RENAME COLUMN IF EXISTS`. C'est exactement le précédent de 0002.
--
-- RÈGLE GÉNÉRALE À RETENIR : `schema.sql` décrit la base à l'instant où la PREMIÈRE
-- migration s'applique. Dès qu'une migration porte un ALTER sans `IF EXISTS` sur un objet,
-- `schema.sql` est GELÉ sur cet objet. Le garde de bootstrap de la CI attrape le cas naïf,
-- mais il laisserait passer l'inverse — renommer dans `schema.sql` en retirant l'ALTER
-- d'ici laisserait la CI VERTE et la production avec l'ancienne colonne. D'où les deux
-- assertions ajoutées à `.github/workflows/ci.yml` dans le même commit.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- POURQUOI RECRÉER articles_fts MAINTENANT, et pourquoi SANS colonne de headnote
-- ═══════════════════════════════════════════════════════════════════════════════
-- L'en-tête de 0003 écartait cette migration en la jugeant destructive, et prévoyait d'y
-- ajouter un jour une colonne de headnote. MESURÉ : c'est INJOUABLE. Une table fts5 à
-- CONTENU EXTERNE apparie ses colonnes PAR NOM sur la table de contenu, or
-- `article_headnotes` est une AUTRE table. Le `CREATE` réussirait, le `'rebuild'` échouerait
-- sur « no such column », `MATCH` répondrait « 0 résultat » SANS ERREUR, et
-- `integrity-check` sans argument répondrait « ok ». Faux, servi, silencieux — sur le
-- mécanisme de recherche lui-même.
-- Les headnotes iront donc dans une fts5 DÉDIÉE, adossée à `article_headnotes`, en
-- migration PUREMENT ADDITIVE (0005), avec `validated = 1` dans le WHERE de la requête.
-- Bénéfice imprévu : la frontière `validated` devient immédiate DANS LES DEUX SENS — une
-- headnote dévalidée cesse d'être trouvable à l'instant, au lieu d'attendre un rebuild.
--
-- `text` EST EN PREMIÈRE POSITION, et ce n'est pas cosmétique : `src/lib.ts` code en dur
-- `snippet(articles_fts, 0, …)`. Déclarer `marginal_note` avant `text` ferait rendre comme
-- EXTRAIT une note marginale — dont l'art. 14 de la Loi d'interprétation dit qu'elle NE
-- FAIT PAS partie du texte (R4).
--
-- Et `bm25(articles_fts)` est appelé SANS poids de colonne : une colonne indexée de plus
-- repondère donc TOUTE la recherche des 79 lois québécoises. Mesuré : tant que
-- `marginal_note` est NULL partout, bm25 est identique BIT POUR BIT. La porte de cette
-- migration est donc exacte — « `npm run eval` reproduit la baseline sans un écart » — et le
-- `MATCH` est borné par `{text}` dans le même commit, pour que l'arrivée des données
-- fédérales ne déplace pas le classement sans qu'on l'ait décidé.

-- ─── 1. laws : la citation, et les quatre colonnes du corpus fédéral ───────────

ALTER TABLE laws RENAME COLUMN rlrq_cite TO official_cite;

-- Oubliée par le SPEC §2.1, alors que ses propres §2.2 et §3.4 l'exigent (formes
-- R.S.C./S.C., et « CQLR » pour le Québec).
ALTER TABLE laws ADD COLUMN official_cite_en TEXT;

-- Le chapitre SEUL, séparé de la citation. `parseCitation` (src/lib.ts) doit apparier sur
-- LUI : « L.R.C. (1985), ch. B-3 » fait 23 caractères, plus que tout chapitre RLRQ, et
-- remporterait la course du plus long dans la boucle `bestLen`. Sans cette colonne, la
-- phase 5 est inimplémentable — trou trouvé par l'audit de complétude.
ALTER TABLE laws ADD COLUMN chapter TEXT;

ALTER TABLE laws ADD COLUMN jurisdiction  TEXT NOT NULL DEFAULT 'qc';  -- 'qc' | 'ca'
ALTER TABLE laws ADD COLUMN in_force      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE laws ADD COLUMN last_amended  TEXT;
ALTER TABLE laws ADD COLUMN unit          TEXT NOT NULL DEFAULT 'article'; -- 'article'|'regle'

-- ─── 2. articles : l'intitulé officiel, et les notes ──────────────────────────

-- Intitulé officiel d'article. HORS DU TEXTE par l'art. 14 de la Loi d'interprétation :
-- les notes marginales « ne font pas partie de celui-ci, n'y figurant qu'à titre de repère
-- ou d'information ». Colonne propre, JAMAIS concaténée au texte.
ALTER TABLE articles ADD COLUMN marginal_note TEXT;

-- Notes en bas de page, jointes par '\n'. Tranché le 2026-09-11 : l'art. 14 n'exclut que
-- les notes marginales et les mentions de textes antérieurs, pas celles-ci — on les rend
-- donc, mais À LA FIN de l'article et sous une étiquette obligatoire de structuredContent.
ALTER TABLE articles ADD COLUMN footnotes TEXT;

-- ─── 3. article_numbers : l'expansion des labels de plage ─────────────────────
--
-- 64 `Label` du corpus fédéral ne sont pas de simples numéros, dont des plages
-- (« 11 à 14 », « 257 à 264 »). Sans cette table,
-- `legislation_get_article(law='ca-i-15', article='12')` répondrait « introuvable » là où la
-- vraie réponse est « abrogé, art. 11 à 14 » — un faux silencieux sur une question
-- d'abrogation.
--
-- La résolution reste `articles.number` D'ABORD, `article_numbers` en second. La clé
-- primaire garantit qu'aucune plage n'en recouvre une autre ; un conflit d'insertion est un
-- ÉCHEC D'INGESTION, jamais un `INSERT OR IGNORE`.
CREATE TABLE IF NOT EXISTS article_numbers (
  law_id     TEXT NOT NULL REFERENCES laws(id),
  lang       TEXT NOT NULL,
  number     TEXT NOT NULL,              -- le numéro DEMANDÉ par l'usager : '12'
  article_id INTEGER NOT NULL REFERENCES articles(id),
  PRIMARY KEY (law_id, lang, number)
);

-- ─── 4. articles_fts : destruction et reconstruction ──────────────────────────

DROP TABLE articles_fts;

CREATE VIRTUAL TABLE articles_fts USING fts5(
  text,                                  -- POSITION 0 : snippet(articles_fts, 0, …)
  marginal_note,
  law_id UNINDEXED, lang UNINDEXED, number UNINDEXED,
  content='articles', content_rowid='id'
);

INSERT INTO articles_fts(articles_fts) VALUES('rebuild');

-- DERNIÈRE INSTRUCTION, et avec `rank = 1`. `integrity-check` SANS argument est un LEURRE :
-- mesuré, il répond « ok » sur un index VIDE et sur un index DÉSYNCHRONISÉ. Avec rank=1 il
-- compare l'index à son contenu.
--
-- Si cette instruction échoue avec « database disk image is malformed », cela signifie
-- INDEX ≠ CONTENU, PAS une base corrompue : le remède normal est de rejouer
-- `INSERT INTO articles_fts(articles_fts) VALUES('rebuild');`. Écrit ici parce que c'est
-- sous pression qu'on viendra le lire, et qu'une restauration Time Travel annulerait tout
-- ce qui a été écrit depuis.
INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1);
