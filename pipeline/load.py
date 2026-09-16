"""Chargement en D1 : attribution des clés/FK, génération de SQL (staging -> bascule).

Garde-fou (PLAN §4/§10) : on écrit d'abord dans des tables de staging, entièrement, puis on
bascule en production en fin de script. Si une insertion échoue, la production reste intacte
(les DELETE/INSERT de bascule ne sont jamais atteints).
"""
from __future__ import annotations

from .model import Article, Division, Law, sort_key
from .norm import normalize


def prepare(law: Law, divisions: list[Division], articles: list[Article], id_base: int = 0) -> None:
    """Attribue id (divisions, articles), parent_id, division_id, sort_key et les colonnes
    normalisées de la couche découverte, en place.

    `id_base` décale les id pour qu'ils soient GLOBALEMENT uniques : les tables divisions et
    articles ont une clé primaire partagée par toutes les lois/langues, mais on charge une
    combinaison à la fois. ingest passe un base distinct par (loi, langue)."""
    # normalisées à CHAQUE chargement : sans quoi une réingestion les remettrait à NULL
    # et aveuglerait la recherche d'orientation (signaux S2/S3 de find_relevant).
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
        # Le parseur fixe le sort_key des pseudo-articles (dispositions) ; sinon on le calcule.
        #
        # ⚠️ Test de PRÉSENCE, pas de vérité. L'ancienne forme — `a.sort_key or sort_key(...)`
        # — jetait en silence toute clé pré-posée à 0, parce que 0 est faux. Or 0 est une
        # clé LÉGITIME : c'est celle de `préliminaire`, et ce sera celle du préambule
        # fédéral, que le SPEC §3.6 veut explicitement à 0 pour qu'il précède l'article 1.
        # Sans ce correctif, le préambule repartait à DISPOSITION_SORT_BASE (9e15), donc à
        # la FIN du corpus, et `get_articles(from, to)` ne le voyait jamais.
        if a.sort_key is None:
            a.sort_key = sort_key(a.number)
        leaf = by_path.get(a.division_path)
        a.division_id = leaf.id if leaf else None


# --- génération SQL ----------------------------------------------------------

def _q(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


_DIV_COLS = ["id", "law_id", "lang", "kind", "number", "heading", "history", "path", "repealed", "parent_id", "sort_order", "heading_norm"]
_ART_COLS = ["id", "law_id", "lang", "number", "sort_key", "division_id",
             "division_path", "text", "html", "history", "repealed",
             # 0004 : intitulé officiel d'article (hors du texte, art. 14 L.i.) et notes
             # en bas de page (rendues À LA FIN de l'article, étiquetées).
             "marginal_note", "footnotes"]
# name_norm est recalculé ici ; fonction/forum/scope_fr/parent_law_id restent préservés par l'UPSERT.
#
# ⚠️ UNE COLONNE ABSENTE DE CES LISTES N'ARRIVE JAMAIS EN BASE, ET EN SILENCE. Les colonnes
# de 0004 portent des DEFAULT (`jurisdiction='qc'`, `in_force=1`, `unit='article'`) : les
# omettre chargerait les 18 textes fédéraux COMME QUÉBÉCOIS, en vigueur, unité « article ».
# `legislation_list_laws(jurisdiction='ca')` rendrait alors ZÉRO résultat, et l'`in_force` que le
# SPEC §3.7 veut mesuré deviendrait un défaut affirmé. Trou trouvé par l'audit de complétude.
_LAW_COLS = ["id", "name_fr", "name_en", "official_cite", "consol_date_fr",
             "consol_date_en", "name_norm",
             # 0004
             "official_cite_en", "chapter", "jurisdiction", "in_force", "last_amended", "unit"]
_NUM_COLS = ["law_id", "lang", "number", "article_id"]

# PONT nom de COLONNE -> nom de CHAMP, pour les cas où les deux diffèrent.
#
# `laws.rlrq_cite` est devenue `official_cite` (migration 0004), mais le dataclass `Law`
# garde `rlrq_cite` : renommer le champ ferait divergir le modèle de la colonne pendant la
# fenêtre de migration, et il faudrait le renommer dans les deux sens. Le pont est donc ici,
# en UN seul endroit, plutôt qu'en trois relectures du dataclass.
_CHAMP = {"official_cite": "rlrq_cite"}


def _valeur(obj, col: str):
    return getattr(obj, _CHAMP.get(col, col))


# langue « opposée », pour préserver ses colonnes lors d'un chargement monolingue
_OTHER = {"fr": "en", "en": "fr"}

# La CITATION est, elle aussi, une paire de langues : `official_cite` porte la forme
# française, `official_cite_en` l'anglaise. Elles ne suivent pas la convention de nommage
# `..._fr`/`..._en`, donc la règle générale ne les attrape pas.
_CITE_PAR_LANGUE = {"fr": "official_cite", "en": "official_cite_en"}


def _COLS_AUTRE_LANGUE(lang: str) -> set[str]:
    """Colonnes qu'un chargement MONOLINGUE ne doit pas écraser (invariant 3).

    L'incident d'origine : une passe FR écrasait le titre ANGLAIS de la loi, capté depuis
    l'OPF anglais, parce que la passe FR ne connaît `name_en` que comme repli (= `name_fr`).
    D'où l'exclusion de `name_<autre>` et `consol_date_<autre>`.

    ⚠️ MÊME DÉFAUT TROUVÉ SUR LA CITATION, le 2026-09-11, en chargeant I-15 dans les deux
    langues sur une base locale : la passe EN a écrasé `official_cite` (la forme française)
    parce que la règle générale ne voit que le suffixe `_fr`/`_en`, et que la paire
    `official_cite` / `official_cite_en` ne le porte pas. Symétriquement, une passe FR
    aurait remis `official_cite_en` à NULL. Exactement l'invariant 3, sur une colonne neuve.
    """
    return {"id", f"name_{_OTHER[lang]}", f"consol_date_{_OTHER[lang]}",
            _CITE_PAR_LANGUE[_OTHER[lang]]}


# D1 refuse toute instruction > 100 Ko (SQLITE_TOOBIG). On plafonne en OCTETS UTF-8 (le
# texte juridique est accentué : compter en caractères sous-estime) avec une marge de sécurité.
_STMT_BUDGET = 80_000


def _bytes(s: str) -> int:
    return len(s.encode("utf-8"))


def _tuple_sql(row: list) -> str:
    return "(" + ", ".join(_q(v) for v in row) + ")"


def _split_literal(s: str, budget: int) -> list[str]:
    """Découpe s en morceaux dont le littéral SQL échappé (quotes doublées) tient dans `budget`
    octets — pour recomposer une valeur trop grosse via des `UPDATE ... = ... || 'morceau'`."""
    chunks: list[str] = []
    start = i = size = 0
    n = len(s)
    while i < n:
        ch = s[i]
        add = len(ch.encode("utf-8")) + (1 if ch == "'" else 0)  # quote échappée = 2 octets
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
    """Charge une ligne unique dont le tuple dépasse le budget : INSERT avec les grosses
    colonnes vidées, puis on ré-append leur contenu par morceaux (`col = col || '...'`)."""
    idx = {c: i for i, c in enumerate(cols)}
    base = list(row)
    for c in big_cols:
        v = base[idx[c]]
        if isinstance(v, str) and v:
            base[idx[c]] = ""  # on repart de '' et on ré-append (garde NULL tel quel)
    stmts = [f"INSERT INTO {table} ({', '.join(cols)}) VALUES {_tuple_sql(base)};"]
    rid = row[idx["id"]]
    payload = budget - 200  # marge pour l'enveloppe UPDATE ... WHERE id = N;
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
    """INSERT groupés, plafonnés en OCTETS (D1 : SQLITE_TOOBIG sur instruction > 100 Ko).
    Une ligne dont le tuple seul dépasse le budget est chargée via _oversized_row."""
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


def to_sql(law: Law, divisions: list[Division], articles: list[Article], lang: str) -> str:
    div_rows = [[_valeur(d, c) for c in _DIV_COLS] for d in divisions]
    art_rows = [[_valeur(a, c) for c in _ART_COLS] for a in articles]
    law_vals = ", ".join(_q(_valeur(law, c)) for c in _LAW_COLS)
    # Un alias par numéro COUVERT par un label de plage. La clé primaire
    # (law_id, lang, number) garantit qu'aucune plage n'en recouvre une autre ; un conflit
    # d'insertion est un ÉCHEC de chargement, jamais un `INSERT OR IGNORE` — c'est la
    # différence entre « on ne sait pas » et « on a choisi au hasard ».
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
    stmts += _rows_sql("_stg_divisions", _DIV_COLS, div_rows)
    # text/html peuvent à eux seuls dépasser 100 Ko (ex. le bloc préliminaire d'un tarif) :
    # ces colonnes sont ré-appendables par morceaux si le tuple est trop gros.
    stmts += _rows_sql("_stg_articles", _ART_COLS, art_rows, big_cols=("text", "html"))
    if num_rows:
        stmts += _rows_sql("_stg_article_numbers", _NUM_COLS, num_rows)
    # --- bascule (production intouchée tant que le staging n'est pas complet) ---
    # Portée (law_id, lang) : recharger une langue ne touche pas l'autre langue de la loi.
    stmts += [
        # article_numbers AVANT articles : sa clé étrangère pointe article_id, et une
        # ligne d'alias survivante désignerait un article supprimé. Sans cette purge,
        # une réingestion rendrait le MAUVAIS article en silence.
        f"DELETE FROM article_numbers WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        f"DELETE FROM articles  WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        f"DELETE FROM divisions WHERE law_id = {_q(law.id)} AND lang = {_q(lang)};",
        # UPSERT : met à jour les colonnes de base sans écraser fonction/forum/name_norm/
        # parent_law_id (posées par la couche découverte, phase A).
        #
        # ⚠️ Et SANS toucher aux colonnes de L'AUTRE langue : on ne charge qu'une langue à la
        # fois, et le name_en d'une exécution FR n'est qu'un repli (= name_fr) faute d'OPF
        # anglais sous la main. Le mettre à jour ferait perdre le vrai titre anglais capté
        # lors du chargement EN — une réingestion FR seule francisait silencieusement le nom
        # anglais de la loi.
        f"INSERT INTO laws ({', '.join(_LAW_COLS)}) VALUES ({law_vals}) ON CONFLICT(id) DO UPDATE SET "
        + ", ".join(f"{c}=excluded.{c}" for c in _LAW_COLS
                    if c not in _COLS_AUTRE_LANGUE(lang)) + ";",
        "INSERT INTO divisions SELECT * FROM _stg_divisions;",
        "INSERT INTO articles  SELECT * FROM _stg_articles;",
        "INSERT INTO article_numbers SELECT * FROM _stg_article_numbers;",
        "DROP TABLE _stg_divisions;",
        "DROP TABLE _stg_articles;",
        "DROP TABLE _stg_article_numbers;",
        "-- FTS5 à contenu externe : reconstruire l'index depuis articles",
        "INSERT INTO articles_fts(articles_fts) VALUES('rebuild');",
    ]
    return "\n".join(stmts) + "\n"
