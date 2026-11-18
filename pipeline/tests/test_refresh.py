"""Tests hors réseau du pipeline de rafraîchissement incrémental (pipeline/refresh.py)."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import load, validate
from pipeline.ingest import extrait_consolidation_quebec
from pipeline.model import Article, Division, Law
from pipeline.refresh import (
    ErreurPrevol,
    ParsedCombo,
    apply_refresh,
    build_markdown_report,
    diff_combo_d1,
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


class TestExtractionQuebec(unittest.TestCase):
    def test_extrait_consolidation_quebec(self):
        html_ok = (
            '<p>Mise à jour au 1 janvier 1999</p>'
            '<div class="text-end">À jour au 1<sup>er</sup> avril 2026</div>'
        )
        self.assertEqual(extrait_consolidation_quebec(html_ok), "2026-04-01")
        html_oct = '<div class="text-end"> À jour au 15 octobre 2026 </div>'
        self.assertEqual(extrait_consolidation_quebec(html_oct), "2026-10-15")
        self.assertIsNone(extrait_consolidation_quebec("<div>sans bannière</div>"))


class TestValidateWitnessDrift(unittest.TestCase):
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


class TestLoadIncrementalSql(unittest.TestCase):
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


class TestDiffEtApply(unittest.TestCase):
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

    def test_apply_refresh_cloud_enchaîne_seed_d1_fts_et_backfill_incremental(self):
        c_fr = _sample_combo("loi-x", "fr", date="2026-10-15", art_text="Nouveau texte.")
        c_en = _sample_combo("loi-y", "en", date="2026-10-15", art_text="Same.")
        s_fr, d_fr, a_fr = self._stored_from(_sample_combo("loi-x", "fr", date="2026-04-07", art_text="Ancien texte."))
        s_en, d_en, a_en = self._stored_from(_sample_combo("loi-y", "en", date="2026-04-07", art_text="Same."))
        db = _FakeD1(divs=[], arts=[])

        diff_fr = diff_combo_d1(_FakeD1(divs=d_fr, arts=a_fr), c_fr, s_fr)
        diff_en = diff_combo_d1(_FakeD1(divs=d_en, arts=a_en), c_en, s_en)

        events: list[str] = []

        def fake_ping(_u, _t, law, kind):
            events.append(f"ping:{law}:{kind}")
            return (True, 0)

        def fake_bookmark():
            events.append("bookmark")
            return "bm-123"

        def fake_backfill(args, **_kw):
            events.append("backfill:" + " ".join(args))

        def record_run_file(sql_path: Path):
            events.append("sql:" + sql_path.name)

        db.run_file = record_run_file  # type: ignore[method-assign]

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"BACKFILL_TOKEN": "tok"}):
            res = apply_refresh(
                db, [c_fr, c_en], [diff_fr, diff_en],
                target="cloud", full_corpus=False, out_dir=Path(tmp),
                ping_fn=fake_ping, bookmark_fn=fake_bookmark, backfill_fn=fake_backfill,
            )

        self.assertEqual(res["bookmark"], "bm-123")
        self.assertEqual(res["applied_meta"], 1)
        self.assertEqual(res["applied_content"], 1)
        self.assertEqual(res["vector_laws"], ["loi-x"])
        self.assertEqual(events, [
            "ping:loi-x:articles",
            "ping:loi-x:divisions",
            "bookmark",
            "backfill:--laws loi-x --kind articles --mode seed",
            "backfill:--laws loi-x --kind divisions --mode seed",
            "sql:metadata-1.sql",
            "sql:loi-x-fr.sql",
            "sql:fts-rebuild.sql",
            "backfill:--laws loi-x --mode incremental --prune",
        ])


if __name__ == "__main__":
    unittest.main()
