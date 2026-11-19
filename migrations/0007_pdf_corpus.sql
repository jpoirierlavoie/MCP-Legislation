-- Migration 0007 — accueil du corpus PDF (source = 'pdf', liens d'annexes).
--
-- Purement additive : `schema.sql` reste gelé sur l'état initial pré-0001 (règle de
-- `0004_federal.sql`) et `articles_fts` n'est PAS reconstruite (`text` demeure en position
-- 0, `cid = 0`, pour `snippet(articles_fts, 0, …)`). Rollback = `PDF_CORPUS="0"` (R8).

ALTER TABLE laws ADD COLUMN source TEXT NOT NULL DEFAULT 'epub'; -- 'epub' | 'lims' | 'pdf'
ALTER TABLE articles ADD COLUMN links TEXT;
