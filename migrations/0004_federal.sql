ALTER TABLE laws RENAME COLUMN rlrq_cite TO official_cite;

ALTER TABLE laws ADD COLUMN official_cite_en TEXT;

ALTER TABLE laws ADD COLUMN chapter TEXT;

ALTER TABLE laws ADD COLUMN jurisdiction  TEXT NOT NULL DEFAULT 'qc';
ALTER TABLE laws ADD COLUMN in_force      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE laws ADD COLUMN last_amended  TEXT;
ALTER TABLE laws ADD COLUMN unit          TEXT NOT NULL DEFAULT 'article';

ALTER TABLE articles ADD COLUMN marginal_note TEXT;

ALTER TABLE articles ADD COLUMN footnotes TEXT;

CREATE TABLE IF NOT EXISTS article_numbers (
  law_id     TEXT NOT NULL REFERENCES laws(id),
  lang       TEXT NOT NULL,
  number     TEXT NOT NULL,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  PRIMARY KEY (law_id, lang, number)
);

DROP TABLE articles_fts;

CREATE VIRTUAL TABLE articles_fts USING fts5(
  text,
  marginal_note,
  law_id UNINDEXED, lang UNINDEXED, number UNINDEXED,
  content='articles', content_rowid='id'
);

INSERT INTO articles_fts(articles_fts) VALUES('rebuild');

INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1);
