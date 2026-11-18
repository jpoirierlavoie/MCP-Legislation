-- Migration 0005 — état content-addressed de l'index Vectorize (rafraîchissement incrémental).
--
-- Table d'administration interne (hors outils MCP, aucun effet sur structuredContent ni sur
-- schema.sql, qui reste gelé sur l'état initial pré-0001). Purement additive.

CREATE TABLE IF NOT EXISTS vector_state (
  vector_id    TEXT PRIMARY KEY,
  law_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('articles', 'divisions')),
  content_hash TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vector_state_law_kind ON vector_state(law_id, kind);
