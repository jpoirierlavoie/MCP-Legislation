CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  tool TEXT NOT NULL,
  query TEXT NOT NULL,
  law TEXT, lang TEXT,
  result_count INTEGER NOT NULL,
  fallback TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_log_misses ON search_log(result_count, ts);
