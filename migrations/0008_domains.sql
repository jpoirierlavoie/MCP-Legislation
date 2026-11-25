-- Migration 0008 — quarantaine par domaine (8 domaines : core + 7 silos sectoriels).
--
-- Purement additive : `schema.sql` reste gelé sur l'état initial pré-0001 (règle de
-- `0004_federal.sql`) et `articles_fts` n'est PAS reconstruite (`text` demeure en position
-- 0, `cid = 0`, pour `snippet(articles_fts, 0, …)`). Rollback = `DOMAIN_QUARANTINE="0"` (R8).

ALTER TABLE laws ADD COLUMN domain TEXT NOT NULL DEFAULT 'core';
CREATE INDEX IF NOT EXISTS idx_laws_domain ON laws(domain);

UPDATE laws SET domain = 'cours-federales' WHERE id IN ('ca-f-7', 'ca-dors-98-106');

UPDATE laws SET domain = 'financier' WHERE id IN (
  'i-13.2.2', 'e-6.1', 'd-9.2', 'e-12.000001', 'i-14.01', 't-11.002', 'v-1.1',
  'a-32.1', 'c-67.3', 'a-33.01', 'e-6.1-r.2', 'e-6.1-r.0.3', 'd-9.2-r.2',
  'd-9.2-r.10', 'd-9.2-r.19', 'd-9.2-r.20', 'v-1.1-r.10', 'v-1.1-r.21',
  'v-1.1-r.24', 'amf-ig-31-103', 'amf-ig-45-106', 'amf-ig-51-102'
);

UPDATE laws SET domain = 'construction-immobilier' WHERE id IN (
  'c-73.2', 'b-1.1', 'b-1.1-r.1', 'b-1.1-r.2', 'b-1.1-r.3', 'b-1.1-r.3.1',
  'b-1.1-r.8', 'b-1.1-r.10', 'c-73.2-r.1', 'c-73.2-r.4', 'c-73.2-r.6'
);

UPDATE laws SET domain = 'municipal-environnement' WHERE id IN (
  'c-19', 'f-2.1', 'e-15.1.0.1', 'e-25', 'a-33.2.1', 'c-65.1', 'c-65.01',
  'c-37.01', 'c-27.1'
);

UPDATE laws SET domain = 'travail' WHERE id IN (
  'n-1.1', 'e-6', 'f-3.1', 'd-11.1', 'p-33.01', 'ca-l-2'
);

UPDATE laws SET domain = 'penal' WHERE id IN (
  'c-25.1', 'p-13.1', 'p-13.1-r.1', 'p-13.1-r.2.02', 'p-13.1-r.2.1', 'c-52.2'
);

UPDATE laws SET domain = 'propriete-intellectuelle' WHERE id IN ('ca-c-42', 'ca-t-13');
