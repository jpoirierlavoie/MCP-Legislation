"""Tests hors réseau du pipeline de rafraîchissement incrémental (pipeline/refresh.py)."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase, main, mock

from pipeline import config, d1_api, load, validate
from pipeline.discovery import relations as d_relations
from pipeline.ingest import extrait_consolidation_quebec
from pipeline.model import Article, Division, Law
from pipeline.refresh import (
    ErreurPrevol,
    ErreurValidation,
    ParsedCombo,
    apply_refresh,
    build_markdown_report,
    build_sources_manifest,
    diff_combo_d1,
    verify_expected_plan,
)


def _sample_combo(law_id: str = "loi-x", lang: str = "fr", date: str = "2026-10-15",
                  art_text: str = "Texte un.", repealed: int = 0) -> ParsedCombo:
    law = Law(
        id=law_id,
        name_fr="Loi test",
        name_en="Test Act",
        rlrq_cite="RLRQ, c. X-1",
        consol_date_fr=date if lang == "fr" else None,
        consol_date_en=date if lang == "en" else None,
    )
    divs = [
        Division(
            law_id=law_id, lang=lang, kind="chapitre", path="ga:l_i",
            number="I", heading="CHAPITRE UN", parent_path=None, sort_order=1,
        )
    ]
    arts = [
        Article(
            law_id=law_id, lang=lang, number="1", text=art_text,
            division_path="ga:l_i", html="<div id='se:1'>x</div>",
            history="2020, c. 1, a. 1.", repealed=repealed,
        )
    ]
    load.prepare(law, divs, arts, id_base=100)
    rep = validate.validate(law_id, lang, divs, arts)
    return ParsedCombo(law_id=law_id, lang=lang, cfg_law={"id": law_id},
                       law=law, divisions=divs, articles=arts, report=rep)


class _FakeD1:
    name = "fake"

    def __init__(self, *, divs: list[dict], arts: list[dict], aliases: list[dict] | None = None):
        self.divs = divs
        self.arts = arts
        self.aliases = aliases or []
        self.executed_files: list[tuple[str, str]] = []
        self.queries: list[str] = []

    def run(self, sql: str):
        self.queries.append(sql)
        if "FROM divisions d" in sql:
            return self.divs
        if "FROM articles " in sql:
            return [] if "OFFSET 1000" in sql else self.arts
        if "FROM article_numbers" in sql:
            return self.aliases
        return []

    def run_file(self, sql_path: Path):
        self.executed_files.append((sql_path.name, sql_path.read_text(encoding="utf-8")))


class TestExtractionQuebec(TestCase):
    def test_extrait_consolidation_quebec(self):
        html_ok = (
            '<p>Mise à jour au 1 janvier 1999</p>'
            '<div class="text-end">À jour au 1<sup>er</sup> avril 2026</div>'
        )
        self.assertEqual(extrait_consolidation_quebec(html_ok), "2026-04-01")
        html_oct = '<div class="text-end"> À jour au 15 octobre 2026 </div>'
        self.assertEqual(extrait_consolidation_quebec(html_oct), "2026-10-15")
        self.assertIsNone(extrait_consolidation_quebec("<div>sans bannière</div>"))


class TestValidateWitnessDrift(TestCase):
    def _ccq_like(self, *, n_int: int, extra_decimals: int, n_ss: int):
        divs: list[Division] = []
        for kind, count in (
            ("livre", 10), ("titre", 45), ("chapitre", 160), ("section", 270),
            ("sous-section", n_ss), ("niveau6", 86), ("niveau7", 13), ("niveau8", 3),
        ):
            for i in range(count):
                divs.append(Division(
                    law_id="ccq", lang="fr", kind=kind,
                    path=f"ga:{kind}_{i}", number="I", heading=f"{kind} {i}",
                    repealed=1 if (kind == "section" and i < 2) or (kind == "chapitre" and i < 1) or (kind == "sous-section" and i < 1) else 0,
                    sort_order=len(divs),
                ))
        arts: list[Article] = []
        for i in range(1, n_int + 1):
            arts.append(Article(
                law_id="ccq", lang="fr", number=str(i),
                text="(Abrogé)." if i <= 68 else f"Art {i}.",
                division_path="ga:livre_0",
                repealed=1 if i <= 68 else 0,
            ))
        for j in range(1, extra_decimals + 1):
            arts.append(Article(
                law_id="ccq", lang="fr", number=f"100.{j}",
                text=f"Dec {j}.", division_path="ga:livre_0",
            ))
        arts.append(Article(law_id="ccq", lang="fr", number="préliminaire", text="Prélim.", division_path="disp"))
        arts.append(Article(law_id="ccq", lang="fr", number="finales", text="Final.", division_path="disp"))
        return divs, arts

    def test_tolere_hausse_mineure_et_refuse_chute_ou_rupture_structurelle(self):
        exp = validate.EXPECTED[("ccq", "fr")]
        # +1 article décimal et +1 sous-section par rapport au témoin figé
        divs, arts = self._ccq_like(
            n_int=exp["int_max"],
            extra_decimals=exp["decimals"] + 1,
            n_ss=exp["div_by_kind"]["sous-section"] + 1,
        )
        rep_strict = validate.validate("ccq", "fr", divs, arts, allow_witness_drift=False)
        self.assertFalse(rep_strict.ok)

        rep_drift = validate.validate("ccq", "fr", divs, arts, allow_witness_drift=True)
        self.assertTrue(rep_drift.ok, "\n".join(rep_drift.lines))
        self.assertGreater(len(rep_drift.witness_deltas), 0)

        # Chute catastrophique (-25 articles) : refusée même avec allow_witness_drift=True
        divs_sh, arts_sh = self._ccq_like(
            n_int=exp["int_max"] - 25,
            extra_decimals=exp["decimals"],
            n_ss=exp["div_by_kind"]["sous-section"],
        )
        rep_shrink = validate.validate("ccq", "fr", divs_sh, arts_sh, allow_witness_drift=True)
        self.assertFalse(rep_shrink.ok)

        # Rupture structurelle (chemin de division dupliqué) : toujours fatale
        divs[1].path = divs[0].path
        rep_dup = validate.validate("ccq", "fr", divs, arts, allow_witness_drift=True)
        self.assertFalse(rep_dup.ok)

        # Extraction vide (0 article réel) : refusée même hors ccq/cpc
        rep_empty = validate.validate("loi-x", "fr", divs[:1], [arts_sh[-1]], allow_witness_drift=False)
        self.assertFalse(rep_empty.ok)
        self.assertIn("extraction vide", "\n".join(rep_empty.lines))


class TestLoadIncrementalSql(TestCase):
    def test_to_sql_sans_fts_et_metadata_only_invariant_3(self):
        c = _sample_combo("ccq", "fr", date="2026-10-15")
        sql_no_fts = load.to_sql(c.law, c.divisions, c.articles, "fr", rebuild_fts=False)
        self.assertNotIn("articles_fts", sql_no_fts)

        meta_fr = load.metadata_only_sql(c.law, "fr")
        self.assertIn("consol_date_fr=excluded.consol_date_fr", meta_fr)
        self.assertNotIn("consol_date_en=excluded", meta_fr)
        self.assertNotIn("name_en=excluded", meta_fr)
        self.assertNotIn("official_cite_en=excluded", meta_fr)

        fts_sql = load.fts_rebuild_sql()
        self.assertIn("VALUES('rebuild')", fts_sql)
        self.assertIn("VALUES('integrity-check', 1)", fts_sql)
        self.assertEqual(
            load.fts_integrity_check_sql(),
            "INSERT INTO articles_fts(articles_fts, rank) VALUES('integrity-check', 1);\n",
        )

    def test_to_sql_fts_incremental_et_index_fk_sqlite(self):
        """Vérifie en SQLite réel la suppression/réindexation FTS5 incrémentale et les index FK 0006."""
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("PRAGMA foreign_keys = ON;")
            conn.executescript(
                """
                CREATE TABLE laws (
                  id TEXT PRIMARY KEY, name_fr TEXT NOT NULL, name_en TEXT NOT NULL,
                  official_cite TEXT NOT NULL, consol_date_fr TEXT, consol_date_en TEXT,
                  fonction TEXT, forum TEXT, scope_fr TEXT, parent_law_id TEXT, name_norm TEXT,
                  official_cite_en TEXT, chapter TEXT, jurisdiction TEXT NOT NULL DEFAULT 'qc',
                  in_force INTEGER NOT NULL DEFAULT 1, last_amended TEXT,
                  unit TEXT NOT NULL DEFAULT 'article'
                );
                CREATE TABLE divisions (
                  id INTEGER PRIMARY KEY, law_id TEXT NOT NULL REFERENCES laws(id),
                  lang TEXT NOT NULL, kind TEXT NOT NULL, number TEXT, heading TEXT,
                  history TEXT, path TEXT NOT NULL, repealed INTEGER NOT NULL DEFAULT 0,
                  parent_id INTEGER REFERENCES divisions(id), sort_order INTEGER NOT NULL,
                  heading_norm TEXT
                );
                CREATE TABLE articles (
                  id INTEGER PRIMARY KEY, law_id TEXT NOT NULL REFERENCES laws(id),
                  lang TEXT NOT NULL, number TEXT NOT NULL, sort_key INTEGER NOT NULL,
                  division_id INTEGER REFERENCES divisions(id), division_path TEXT NOT NULL,
                  text TEXT NOT NULL, html TEXT, history TEXT, repealed INTEGER NOT NULL DEFAULT 0,
                  marginal_note TEXT, footnotes TEXT
                );
                CREATE TABLE article_numbers (
                  law_id TEXT NOT NULL REFERENCES laws(id), lang TEXT NOT NULL,
                  number TEXT NOT NULL, article_id INTEGER NOT NULL REFERENCES articles(id),
                  PRIMARY KEY (law_id, lang, number)
                );
                CREATE INDEX idx_art_lookup ON articles(law_id, lang, number);
                CREATE VIRTUAL TABLE articles_fts USING fts5(
                  text, marginal_note, law_id UNINDEXED, lang UNINDEXED, number UNINDEXED,
                  content='articles', content_rowid='id'
                );
                """
            )
            mig_0006 = (config.REPO_ROOT / "migrations" / "0006_fk_indexes.sql").read_text(
                encoding="utf-8"
            )
            conn.executescript(mig_0006)

            c_ccq_1 = _sample_combo("ccq", "fr", date="2026-04-07", art_text="Ancien vocable.")
            c_ccq_1.articles[0].alias_numbers = ["1"]
            load.prepare(c_ccq_1.law, c_ccq_1.divisions, c_ccq_1.articles, id_base=10)
            c_cpc = _sample_combo("cpc", "fr", date="2026-04-07", art_text="Témoin intangible.")
            load.prepare(c_cpc.law, c_cpc.divisions, c_cpc.articles, id_base=50000)

            conn.executescript(load.to_sql(c_ccq_1.law, c_ccq_1.divisions, c_ccq_1.articles, "fr", rebuild_fts=True))
            conn.executescript(load.to_sql(c_cpc.law, c_cpc.divisions, c_cpc.articles, "fr", rebuild_fts=True))
            conn.executescript(load.fts_integrity_check_sql())

            # Bascule modifiée sur ccq/fr uniquement
            c_ccq_2 = _sample_combo("ccq", "fr", date="2026-10-15", art_text="Nouvelle rédaction.")
            c_ccq_2.articles[0].alias_numbers = ["1"]
            load.prepare(c_ccq_2.law, c_ccq_2.divisions, c_ccq_2.articles, id_base=10)
            conn.executescript(load.to_sql(c_ccq_2.law, c_ccq_2.divisions, c_ccq_2.articles, "fr", rebuild_fts=True))
            conn.executescript(load.fts_integrity_check_sql())

            old_hits = conn.execute(
                "SELECT number FROM articles_fts WHERE articles_fts MATCH '{text}: Ancien'"
            ).fetchall()
            new_hits = conn.execute(
                "SELECT law_id, number FROM articles_fts WHERE articles_fts MATCH '{text}: Nouvelle'"
            ).fetchall()
            other_hits = conn.execute(
                "SELECT law_id, number FROM articles_fts WHERE articles_fts MATCH '{text}: intangible'"
            ).fetchall()
            self.assertEqual(old_hits, [])
            self.assertEqual(new_hits, [("ccq", "1")])
            self.assertEqual(other_hits, [("cpc", "1")])

            plan_art = conn.execute(
                "EXPLAIN QUERY PLAN SELECT 1 FROM articles WHERE division_id = 10"
            ).fetchall()
            plan_num = conn.execute(
                "EXPLAIN QUERY PLAN SELECT 1 FROM article_numbers WHERE article_id = 10"
            ).fetchall()
            self.assertIn("idx_art_division_id", str(plan_art))
            self.assertIn("idx_art_num_article_id", str(plan_num))
        finally:
            conn.close()


class TestDiffEtApply(TestCase):
    def _stored_from(self, combo: ParsedCombo):
        law = combo.law
        stored_law = {
            "id": law.id,
            "name_fr": law.name_fr,
            "name_en": law.name_en,
            "official_cite": law.rlrq_cite,
            "consol_date_fr": law.consol_date_fr,
            "consol_date_en": law.consol_date_en,
            "name_norm": law.name_norm,
            "official_cite_en": law.official_cite_en,
            "chapter": law.chapter,
            "jurisdiction": law.jurisdiction,
            "in_force": law.in_force,
            "last_amended": law.last_amended,
            "unit": law.unit,
        }
        divs = [
            {
                "kind": d.kind, "number": d.number, "heading": d.heading,
                "history": d.history, "path": d.path, "repealed": d.repealed,
                "parent_path": d.parent_path, "sort_order": d.sort_order,
                "heading_norm": d.heading_norm,
            }
            for d in combo.divisions
        ]
        arts = [
            {
                "number": a.number, "sort_key": a.sort_key, "division_path": a.division_path,
                "text": a.text, "html": a.html, "history": a.history, "repealed": a.repealed,
                "marginal_note": a.marginal_note, "footnotes": a.footnotes,
            }
            for a in combo.articles
        ]
        return stored_law, divs, arts

    def test_diff_combo_d1_classe_unchanged_metadata_only_et_content_changed(self):
        c = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Identique.")
        stored_law, divs, arts = self._stored_from(c)
        db = _FakeD1(divs=divs, arts=arts)

        self.assertEqual(diff_combo_d1(db, c, stored_law).status, "unchanged")

        stored_law_old = dict(stored_law, consol_date_fr="2026-04-07")
        d_meta = diff_combo_d1(db, c, stored_law_old)
        self.assertEqual(d_meta.status, "metadata_only")
        self.assertEqual(d_meta.old_consol_date, "2026-04-07")
        self.assertEqual(d_meta.new_consol_date, "2026-10-15")

        c_mod = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="(Abrogé).", repealed=1)
        d_mod = diff_combo_d1(db, c_mod, stored_law_old)
        self.assertEqual(d_mod.status, "content_changed")
        self.assertEqual(d_mod.repealed_articles, ["1"])
        self.assertEqual(d_mod.modified_articles[0][0], "1")

        md = build_markdown_report([c_mod], [d_mod], lims_sha="a" * 40, warnings=[], staging_verified=True)
        self.assertIn("`content_changed`", md)
        self.assertIn("`" + "a" * 40 + "`", md)

    def test_apply_refresh_prevol_bloque_toute_ecriture_d1(self):
        c = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Modifié.")
        stored_law, divs, arts = self._stored_from(_sample_combo("loi-x", "fr", date="2026-04-07", art_text="Ancien."))
        db = _FakeD1(divs=divs, arts=arts)
        diff = diff_combo_d1(db, c, stored_law)

        bookmark_called = False

        def fail_ping(_u, _t, _l, _k):
            raise ErreurPrevol("backfill indisponible")

        def track_bookmark():
            nonlocal bookmark_called
            bookmark_called = True
            return "bm"

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"BACKFILL_TOKEN": "tok"}):
            with self.assertRaises(ErreurPrevol):
                apply_refresh(
                    db, [c], [diff],
                    target="cloud", full_corpus=False, out_dir=Path(tmp),
                    ping_fn=fail_ping, bookmark_fn=track_bookmark,
                )
        self.assertEqual(db.executed_files, [])
        self.assertFalse(bookmark_called)

    def test_apply_refresh_cloud_enchaîne_full_et_incremental_et_fts_par_bascule(self):
        c_fr = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Nouveau texte.")
        c_meta = _sample_combo("loi-z", "fr", date="2026-10-15", art_text="Same.")
        c_en = _sample_combo("loi-y", "en", date="2026-10-15", art_text="Same.")
        s_fr, d_fr, a_fr = self._stored_from(_sample_combo("loi-x", "fr", date="2026-04-07", art_text="Ancien texte."))
        s_meta, d_meta, a_meta = self._stored_from(_sample_combo("loi-z", "fr", date="2026-04-07", art_text="Same."))
        s_en, d_en, a_en = self._stored_from(_sample_combo("loi-y", "en", date="2026-04-07", art_text="Same."))
        db = _FakeD1(divs=[], arts=[])

        diff_fr = diff_combo_d1(_FakeD1(divs=d_fr, arts=a_fr), c_fr, s_fr)
        diff_meta = diff_combo_d1(_FakeD1(divs=d_meta, arts=a_meta), c_meta, s_meta)
        diff_en = diff_combo_d1(_FakeD1(divs=d_en, arts=a_en), c_en, s_en)

        events: list[str] = []
        sql_contents: dict[str, str] = {}

        def fake_ping(_u, _t, law, kind):
            events.append(f"ping:{law}:{kind}")
            return (True, 0 if law == "loi-x" else 10)

        def fake_bookmark():
            events.append("bookmark")
            return "bm-123"

        def fake_backfill(args, **_kw):
            events.append("backfill:" + " ".join(args))

        def record_run_file(sql_path: Path):
            events.append("sql:" + sql_path.name)
            sql_contents[sql_path.name] = sql_path.read_text(encoding="utf-8")

        db.run_file = record_run_file  # type: ignore[method-assign]

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"BACKFILL_TOKEN": "tok"}):
            res = apply_refresh(
                db, [c_fr, c_meta, c_en], [diff_fr, diff_meta, diff_en],
                target="cloud", full_corpus=False, out_dir=Path(tmp),
                ping_fn=fake_ping, bookmark_fn=fake_bookmark, backfill_fn=fake_backfill,
            )

        self.assertEqual(res["bookmark"], "bm-123")
        self.assertEqual(res["applied_meta"], 2)
        self.assertEqual(res["applied_content"], 1)
        self.assertEqual(res["vector_laws"], ["loi-x", "loi-z"])
        self.assertNotIn("VALUES('rebuild')", sql_contents["loi-x-fr.sql"])
        self.assertIn("SELECT 'delete', id, text, marginal_note", sql_contents["loi-x-fr.sql"])
        self.assertIn("INSERT INTO articles_fts(rowid, text, marginal_note", sql_contents["loi-x-fr.sql"])
        self.assertEqual(events, [
            "ping:loi-x:articles",
            "ping:loi-x:divisions",
            "ping:loi-z:articles",
            "ping:loi-z:divisions",
            "bookmark",
            "sql:metadata-1.sql",
            "sql:loi-x-fr.sql",
            "sql:fts-check.sql",
            "backfill:--laws loi-x --mode full --prune",
            "backfill:--laws loi-z --mode incremental --prune",
        ])

    def test_verify_expected_plan_refuse_toute_derive_source(self):
        c = _sample_combo("loi-x", "fr", date="2026-10-15")
        c.source_sha256 = "abc123"
        expected = {"lims_sha": None, "sources": build_sources_manifest([c])}
        verify_expected_plan([c], None, expected)

        c.source_sha256 = "modified"
        with self.assertRaises(ErreurPrevol):
            verify_expected_plan([c], None, expected)

        c.source_sha256 = "abc123"
        c.law.consol_date_fr = "2026-11-01"
        with self.assertRaises(ErreurPrevol):
            verify_expected_plan([c], None, expected)

    def test_reprise_refresh_state_meme_si_d1_unchanged(self):
        c = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Identique.")
        stored_law, divs, arts = self._stored_from(c)

        class _PendingD1(_FakeD1):
            def __init__(self):
                super().__init__(divs=divs, arts=arts)
                self.pending = json.dumps({
                    "vector_laws": ["loi-x"],
                    "discovery_laws": ["loi-x"],
                    "full_corpus": False,
                    "fts_dirty": True,
                    "relations_dirty": False,
                })

            def run(self, sql: str):
                self.queries.append(sql)
                if "SELECT value FROM refresh_state" in sql and self.pending:
                    return [{"value": self.pending}]
                if "DELETE FROM refresh_state" in sql:
                    self.pending = ""
                    return []
                return super().run(sql)

        db = _PendingD1()
        diff = diff_combo_d1(db, c, stored_law)
        self.assertEqual(diff.status, "unchanged")

        events: list[str] = []
        db.run_file = lambda p: events.append("sql:" + p.name)  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"BACKFILL_TOKEN": "tok"}):
            res = apply_refresh(
                db, [c], [diff],
                target="cloud", full_corpus=False, out_dir=Path(tmp),
                ping_fn=lambda _u, _t, _l, _k: (True, 5),
                bookmark_fn=lambda: "bm-resumed",
                backfill_fn=lambda args, **_kw: events.append("backfill:" + " ".join(args)),
            )

        self.assertEqual(res["vector_laws"], ["loi-x"])
        self.assertEqual(events, [
            "sql:fts-check.sql",
            "backfill:--laws loi-x --mode incremental --prune",
        ])
        self.assertEqual(db.pending, "")

    def test_fts_check_en_echec_bascule_sur_fts_rebuild(self):
        c = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Identique.")
        stored_law, divs, arts = self._stored_from(c)

        class _FailingCheckD1(_FakeD1):
            def __init__(self):
                super().__init__(divs=divs, arts=arts)
                self.pending = json.dumps({
                    "vector_laws": ["loi-x"],
                    "discovery_laws": ["loi-x"],
                    "full_corpus": False,
                    "fts_dirty": True,
                    "relations_dirty": False,
                })

            def run(self, sql: str):
                if "SELECT value FROM refresh_state" in sql and self.pending:
                    return [{"value": self.pending}]
                if "DELETE FROM refresh_state" in sql:
                    self.pending = ""
                    return []
                return super().run(sql)

        db = _FailingCheckD1()
        diff = diff_combo_d1(db, c, stored_law)
        events: list[str] = []

        def run_file_with_check_failure(p: Path):
            events.append("sql:" + p.name)
            if p.name == "fts-check.sql":
                raise d1_api.D1Error("database disk image is malformed")

        db.run_file = run_file_with_check_failure  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"BACKFILL_TOKEN": "tok"}):
            apply_refresh(
                db, [c], [diff],
                target="cloud", full_corpus=False, out_dir=Path(tmp),
                ping_fn=lambda _u, _t, _l, _k: (True, 5),
                bookmark_fn=lambda: "bm-fallback",
                backfill_fn=lambda args, **_kw: events.append("backfill:" + " ".join(args)),
            )

        self.assertEqual(events, [
            "sql:fts-check.sql",
            "sql:fts-rebuild.sql",
            "backfill:--laws loi-x --mode incremental --prune",
        ])

    def test_relations_only_laws_preserve_autres_lois_auto(self):
        db = _FakeD1(divs=[], arts=[])
        with tempfile.TemporaryDirectory() as tmp:
            epub = Path(tmp) / "C-73.2-R.6-fr.epub"
            with zipfile.ZipFile(epub, "w") as zf:
                zf.writestr("page1.xhtml", "<html><body><p>Texte</p></body></html>")
            d_relations.build(db, samples_dir=Path(tmp), only_laws={"c-73.2-r.6"})
        deletes = [q for q in db.queries if "DELETE FROM law_relations" in q]
        self.assertEqual(
            deletes,
            ["DELETE FROM law_relations WHERE source = 'auto' AND from_law_id IN ('c-73.2-r.6')"],
        )

    def test_diff_combo_d1_refuse_chute_anormale_sur_autre_loi(self):
        c_old = _sample_combo("loi-z", "fr", date="2026-04-07")
        c_old.articles = [
            Article(law_id="loi-z", lang="fr", number=str(i), text=f"Art {i}.",
                    division_path="ga:l_i", html="<div>x</div>", history=None, repealed=0)
            for i in range(1, 15)
        ]
        load.prepare(c_old.law, c_old.divisions, c_old.articles, id_base=100)
        stored_law, divs, arts = self._stored_from(c_old)

        c_shrunk = _sample_combo("loi-z", "fr", date="2026-10-15")
        db = _FakeD1(divs=divs, arts=arts)
        with self.assertRaises(ErreurValidation):
            diff_combo_d1(db, c_shrunk, stored_law)


if __name__ == "__main__":
    main()
