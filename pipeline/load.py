from __future__ import annotations

from .model import Article, Division, Law, sort_key
from .norm import normalize

def prepare(law: Law, divisions: list[Division], articles: list[Article], id_base: int = 0) -> None:
    law.name_norm = normalize(law.name_fr)
    by_path: dict[str, Division] = {}
    for i, d in enumerate(divisions, start=1):
        d.id = id_base + i
        d.heading_norm = normalize(d.heading)
        by_path[d.path] = d
    for d in divisions:
        d.parent_id = by_path[d.parent_path].id if d.parent_path and d.parent_path in by_path else None
    for j, a in enumerate(articles, start=1):
        a.id = id_base + j
        if a.sort_key is None:
            a.sort_key = sort_key(a.number)
        leaf = by_path.get(a.division_path)
        a.division_id = leaf.id if leaf else None

def _q(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"

_DIV_COLS = ["id", "law_id", "lang", "kind", "number", "heading", "history", "path", "repealed", "parent_id", "sort_order", "heading_norm"]
_ART_COLS = ["id", "law_id", "lang", "number", "sort_key", "division_id",
             "division_path", "text", "html", "history", "repealed",
             "marginal_note", "footnotes",
             "links"]
_LAW_COLS = ["id", "name_fr", "name_en", "official_cite", "consol_date_fr",
             "consol_date_en", "name_norm",
             "official_cite_en", "chapter", "jurisdiction", "in_force", "last_amended", "unit",
             "source",
             "domain"]
_NUM_COLS = ["law_id", "lang", "number", "article_id"]

_OTHER = {"fr": "en", "en": "fr"}

_CITE_PAR_LANGUE = {"fr": "official_cite", "en": "official_cite_en"}

def _COLS_AUTRE_LANGUE(lang: str) -> set[str]:
    return {"id", f"name_{_OTHER[lang]}", f"consol_date_{_OTHER[lang]}",
            _CITE_PAR_LANGUE[_OTHER[lang]]}

_STMT_BUDGET = 80_000

def _bytes(s: str) -> int:
    return len(s.encode("utf-8"))

def _tuple_sql(row: list) -> str:
    return "(" + ", ".join(_q(v) for v in row) + ")"

def _split_literal(s: str, budget: int) -> list[str]:
    chunks: list[str] = []
    start = i = size = 0
    n = len(s)
    while i < n:
        ch = s[i]
        add = len(ch.encode("utf-8")) + (1 if ch == "'" else 0)
        if size + add > budget and i > start:
            chunks.append(s[start:i])
            start, size = i, 0
        size += add
        i += 1
    if start < n:
        chunks.append(s[start:])
    return chunks

def _oversized_row(table: str, cols: list[str], row: list, big_cols: tuple[str, ...],
                   budget: int) -> list[str]:
    idx = {c: i for i, c in enumerate(cols)}
    base = list(row)
    for c in big_cols:
        v = base[idx[c]]
        if isinstance(v, str) and v:
            base[idx[c]] = ""
    stmts = [f"INSERT INTO {table} ({', '.join(cols)}) VALUES {_tuple_sql(base)};"]
    rid = row[idx["id"]]
    payload = budget - 200
    for c in big_cols:
        v = row[idx[c]]
        if not (isinstance(v, str) and v):
            continue
        for chunk in _split_literal(v, payload):
            lit = "'" + chunk.replace("'", "''") + "'"
            stmts.append(f"UPDATE {table} SET {c} = {c} || {lit} WHERE id = {rid};")
    return stmts

def _rows_sql(table: str, cols: list[str], rows: list[list], budget: int = _STMT_BUDGET,
              big_cols: tuple[str, ...] = ()) -> list[str]:
    out: list[str] = []
    prefix = f"INSERT INTO {table} ({', '.join(cols)}) VALUES\n"
    pbytes = _bytes(prefix)
    buf: list[str] = []
    size = pbytes
    for r in rows:
        tuple_sql = _tuple_sql(r)
        tb = _bytes(tuple_sql)
        if big_cols and pbytes + tb + 1 > budget:
            if buf:
                out.append(prefix + ",\n".join(buf) + ";")
                buf, size = [], pbytes
            out.extend(_oversized_row(table, cols, r, big_cols, budget))
            continue
        if buf and size + tb + 2 > budget:
            out.append(prefix + ",\n".join(buf) + ";")
            buf, size = [], pbytes
        buf.append(tuple_sql)
        size += tb + 2
    if buf:
        out.append(prefix + ",\n".join(buf) + ";")
    return out

def metadata_only_sql(law: Law, lang: str) -> str:
    law_vals = ", ".join(_q(getattr(law, c)) for c in _LAW_COLS)
    updates = ", ".join(
        f"{c}=excluded.{c}" for c in _LAW_COLS if c not in _COLS_AUTRE_LANGUE(lang)
    )
    return (
        f"INSERT INTO laws ({', '.join(_LAW_COLS)}) VALUES ({law_vals}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates};\n"
    )

def fts_rebuild_sql() -> str:
    return (
        "INSERT INTO articles_fts(articles_fts) VALUES('rebuild');\n"
        "INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1);\n"
    )

def fts_integrity_check_sql() -> str:
    return "INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1);\n"

def to_sql(law: Law, divisions: list[Division], articles: list[Article], lang: str,
           *, rebuild_fts: bool = True) -> str:
    div_rows = [[getattr(d, c) for c in _DIV_COLS] for d in divisions]
    art_rows = [[getattr(a, c) for c in _ART_COLS] for a in articles]
    law_vals = ", ".join(_q(getattr(law, c)) for c in _LAW_COLS)
    num_rows = [[a.law_id, a.lang, n, a.id]
                for a in articles for n in a.alias_numbers]

    stmts: list[str] = [
        "-- Généré par pipeline.ingest — NE PAS éditer à la main.",
        "PRAGMA defer_foreign_keys = TRUE;",
        "DROP TABLE IF EXISTS _stg_divisions;",
        "DROP TABLE IF EXISTS _stg_articles;",
        "DROP TABLE IF EXISTS _stg_article_numbers;",
        "CREATE TABLE _stg_divisions AS SELECT * FROM divisions WHERE 0;",
        "CREATE TABLE _stg_articles  AS SELECT * FROM articles  WHERE 0;",
        "CREATE TABLE _stg_article_numbers AS SELECT * FROM article_numbers WHERE 0;",
    ]
    stmts += _rows_sql("_stg_divisions", _DIV_COLS, div_rows, big_cols=("history",))
    stmts += _rows_sql("_stg_articles", _ART_COLS, art_rows, big_cols=("text", "html", "links", "history"))
    if num_rows:
        stmts += _rows_sql("_stg_article_numbers", _NUM_COLS, num_rows)
    stmts += [
        f"DELETE FROM article_numbers WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
    ]
    if rebuild_fts:
        stmts += [
            "-- FTS5 à contenu externe : retirer les anciennes entrées de (law_id, lang) avant suppression",
            "INSERT INTO articles_fts(articles_fts, rowid, text, marginal_note, law_id, lang, number) "
            "SELECT 'delete', id, text, marginal_note, law_id, lang, number FROM articles "
            f"WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        ]
    stmts += [
        f"DELETE FROM articles  WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        f"DELETE FROM divisions WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        f"INSERT INTO laws ({', '.join(_LAW_COLS)}) VALUES ({law_vals}) ON CONFLICT(id) DO UPDATE SET "
        + ", ".join(f"{c}=excluded.{c}" for c in _LAW_COLS
                    if c not in _COLS_AUTRE_LANGUE(lang)) + ";",
        "INSERT INTO divisions SELECT * FROM _stg_divisions;",
        "INSERT INTO articles  SELECT * FROM _stg_articles;",
    ]
    if rebuild_fts:
        stmts += [
            "-- FTS5 à contenu externe : indexer les nouvelles entrées de (law_id, lang)",
            "INSERT INTO articles_fts(rowid, text, marginal_note, law_id, lang, number) "
            "SELECT id, text, marginal_note, law_id, lang, number FROM articles "
            f"WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        ]
    stmts += [
        "INSERT INTO article_numbers SELECT * FROM _stg_article_numbers;",
        "DROP TABLE _stg_divisions;",
        "DROP TABLE _stg_articles;",
        "DROP TABLE _stg_article_numbers;",
    ]
    return "\n".join(stmts) + "\n"
