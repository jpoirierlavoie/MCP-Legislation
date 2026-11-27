CREATE TABLE IF NOT EXISTS subjects (
  id             TEXT PRIMARY KEY,
  label_fr       TEXT NOT NULL,
  label_en       TEXT,
  label_norm     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  description_fr TEXT
);

CREATE TABLE IF NOT EXISTS subject_map (
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  law_id        TEXT NOT NULL REFERENCES laws(id),
  division_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (subject_id, law_id, division_path)
);
CREATE INDEX IF NOT EXISTS idx_smap_law     ON subject_map(law_id);
CREATE INDEX IF NOT EXISTS idx_smap_subject ON subject_map(subject_id);

CREATE TABLE IF NOT EXISTS law_relations (
  from_law_id TEXT NOT NULL REFERENCES laws(id),
  to_law_id   TEXT NOT NULL,
  rel_type    TEXT NOT NULL,
  source      TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  in_corpus   INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  PRIMARY KEY (from_law_id, to_law_id, rel_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON law_relations(from_law_id);
CREATE INDEX IF NOT EXISTS idx_rel_to   ON law_relations(to_law_id);

ALTER TABLE subjects ADD COLUMN description_en TEXT;

ALTER TABLE laws ADD COLUMN fonction      TEXT;
ALTER TABLE laws ADD COLUMN forum         TEXT;
ALTER TABLE laws ADD COLUMN scope_fr      TEXT;
ALTER TABLE laws ADD COLUMN parent_law_id TEXT;
ALTER TABLE laws ADD COLUMN name_norm     TEXT;

ALTER TABLE divisions ADD COLUMN heading_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_div_heading_norm ON divisions(law_id, lang, heading_norm);

