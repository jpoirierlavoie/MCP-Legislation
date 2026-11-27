CREATE TABLE IF NOT EXISTS division_links (
  law_a     TEXT NOT NULL,
  path_a    TEXT NOT NULL,
  law_b     TEXT NOT NULL,
  path_b    TEXT NOT NULL,
  rel_type  TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT 'fr',
  note      TEXT,
  validated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (law_a, path_a, law_b, path_b, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_dlinks_lookup
  ON division_links(validated, law_a, lang, path_a);

CREATE TABLE IF NOT EXISTS concept_gazetteer (
  id        INTEGER PRIMARY KEY,
  concept   TEXT NOT NULL UNIQUE,
  variantes TEXT NOT NULL,
  cibles    TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT 'fr',
  note      TEXT,
  validated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gazetteer_actif
  ON concept_gazetteer(validated, lang);

CREATE TABLE IF NOT EXISTS article_headnotes (
  law          TEXT NOT NULL,
  article      TEXT NOT NULL,
  lang         TEXT NOT NULL DEFAULT 'fr',
  headnote     TEXT NOT NULL,
  model        TEXT,
  generated_at TEXT DEFAULT (datetime('now')),
  validated    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (law, article, lang)
);

CREATE INDEX IF NOT EXISTS idx_headnotes_actif
  ON article_headnotes(validated, law, lang);
