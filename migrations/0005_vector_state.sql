CREATE TABLE IF NOT EXISTS vector_state (
  vector_id    TEXT PRIMARY KEY,
  law_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('articles', 'divisions')),
  content_hash TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vector_state_law_kind ON vector_state(law_id, kind);

CREATE TABLE IF NOT EXISTS refresh_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
