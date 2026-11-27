CREATE TABLE laws (
  id             TEXT PRIMARY KEY,
  name_fr        TEXT NOT NULL,
  name_en        TEXT NOT NULL,
  rlrq_cite      TEXT NOT NULL,
  consol_date_fr TEXT,
  consol_date_en TEXT
);

CREATE TABLE divisions (
  id         INTEGER PRIMARY KEY,
  law_id     TEXT NOT NULL REFERENCES laws(id),
  lang       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  number     TEXT,
  heading    TEXT,
  history    TEXT,
  path       TEXT NOT NULL,
  repealed   INTEGER NOT NULL DEFAULT 0,
  parent_id  INTEGER REFERENCES divisions(id),
  sort_order INTEGER NOT NULL
);

CREATE TABLE articles (
  id            INTEGER PRIMARY KEY,
  law_id        TEXT NOT NULL REFERENCES laws(id),
  lang          TEXT NOT NULL,
  number        TEXT NOT NULL,
  sort_key      INTEGER NOT NULL,
  division_id   INTEGER REFERENCES divisions(id),
  division_path TEXT NOT NULL,
  text          TEXT NOT NULL,
  html          TEXT,
  history       TEXT,
  repealed      INTEGER NOT NULL DEFAULT 0,
  consol_date   TEXT
);

CREATE INDEX idx_art_lookup   ON articles(law_id, lang, number);
CREATE INDEX idx_art_division ON articles(law_id, lang, division_path);
CREATE INDEX idx_art_sort     ON articles(law_id, lang, sort_key);
CREATE INDEX idx_div_parent   ON divisions(parent_id);
CREATE INDEX idx_div_path     ON divisions(law_id, lang, path);

CREATE VIRTUAL TABLE articles_fts USING fts5(
  text,
  law_id UNINDEXED, lang UNINDEXED, number UNINDEXED,
  content='articles', content_rowid='id'
);
