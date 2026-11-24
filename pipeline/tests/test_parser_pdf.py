"""Tests du parseur PDF déterministe (`pipeline/parser_pdf.py`) et de l'intégration M3.

Deux classes :
- `TestParserPdfPurePython` : s'exécute même sans `pymupdf` (CI GitHub Actions).
- `TestParserPdfWithPyMuPdf` : synthétiques (orientation AMF, directive + 3 abrogations,
  historique division/article, liens/annexes, /Rotate 90, Portes 0/1/2) + PDF réels locaux.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

try:
    import pymupdf
except ImportError:
    pymupdf = None  # type: ignore[assignment]

from pipeline import config, ingest, load, parser_pdf, validate
from pipeline.discovery.recon_pdf import LineRecord, SpanRecord
from pipeline.model import DISPOSITION_SORT_BASE, Article, Division, Law, sort_key


def _span(
    text: str,
    *,
    page: int = 1,
    x0: float = 92.0,
    y0: float = 100.0,
    x1: float = 200.0,
    y1: float = 112.0,
    base_font: str = "ArialMT",
    size: float = 12.0,
    flags: int = 0,
) -> SpanRecord:
    return SpanRecord(
        page=page,
        x0=x0,
        y0=y0,
        x1=x1,
        y1=y1,
        font=base_font,
        base_font=base_font,
        size=size,
        flags=flags,
        text=text,
        norm_text=text.strip(),
    )


def _base_profile(law_id: str = "test-pdf", *, fonction: str = "directive", number_mode: str = "numeric") -> dict:
    return {
        "$schema_version": 1,
        "law_id": law_id,
        "fonction": fonction,
        "jurisdiction": "qc",
        "unit": "paragraphe" if fonction == "directive" else "article",
        "langs": ["fr"],
        "files": {
            "fr": {
                "filename": f"{law_id}.pdf",
                "sha256": "",
                "page_count": 1,
                "toc_pages": [],
                "body_start_page": 1,
                "annexe_start_page": None,
                "consolidation_date": {
                    "pages": [1],
                    "regex": r"(?:À\s+jour\s+au|A\s+jour\s+au)\s+(\d{1,2}(?:\s*er)?\s+[A-Za-zÀ-ÿ]+\s+\d{4})",
                    "lang": "fr",
                },
                "title_blocks": [{"page": 1, "y_max": 110.0, "x0_min": 150.0}],
                "running_header": {"y_max": 50.0, "regex": r"^\d+$", "pages_from": 2},
                "running_footer": None,
                "toc_parser": {
                    "level1_x0_max": 98.0,
                    "level2_x0_min": 98.1,
                    "level2_x0_max": 120.0,
                    "require_bold_for_level1": True,
                    "trailing_page_regex": r"(?:\s*\.{2,}\s*|\s+)\d+\s*$",
                },
                "body_typography": {
                    "dominant_size_pt": 12.0,
                    "y_line_tolerance_pt": 2.5,
                    "heading_wrap_dy_max_pt": 17.0,
                    "heading_x0_min": 88.0,
                    "heading_x0_max": 96.0,
                    "heading_min_size_pt": 11.5,
                    "heading_require_all_bold": True,
                    "heading_exclude_italic": True,
                    "level1_all_caps": True,
                    "level1_kind": "partie",
                    "level2_kind": "sous-section",
                },
                "provisions": {
                    "x0_min": 85.0,
                    "x0_max": 96.0,
                    "min_size_pt": 10.5,
                    "continuation_x0_min": 115.0,
                    "subitem_x0_min": 115.0,
                    "number_mode": number_mode,
                    "repeal_regex": r"^(?:Abrog[ée]\.?|Abrogation\.|Repealed\.?|\[\s*(?:…|\.\.\.)\s*\])$",
                },
                "history": {
                    "prefix_regex": r"^(?:Modifications?|Abrogation|Ajouts?)\s*:",
                    "max_size_pt": 10.5,
                    "allow_bold_italic_any_size": False,
                    "x0_min": 85.0,
                    "x0_max": 140.0,
                },
                "footnotes": {
                    "y0_min": 650.0,
                    "lead_size_max_pt": 7.5,
                    "body_size_max_pt": 10.5,
                    "x0_min": 85.0,
                    "x0_max": 125.0,
                },
                "unnumbered_prose_divisions": [],
                "annexes": {
                    "start_heading": "LISTE DES ANNEXES",
                    "item_x0_min": 85.0,
                    "item_x0_max": 96.0,
                    "item_regex": r"^(?P<prefix>Division|Annexe)\s+(?P<num>\d+)\.?\s*(?P<rest>.*)$",
                    "slug_map": {"division": "annexe-division", "annexe": "annexe"},
                    "subgroups": [],
                },
                "links": {
                    "allowed_schemes": ["https", "http", "mailto"],
                    "ignore_mailto_without_at_domain": True,
                    "sanitize_email_launch": True,
                    "ignore_zero_area_rect": True,
                },
            }
        },
    }


class TestParserPdfPurePython(unittest.TestCase):
    def test_sort_key_alphanumerique_et_dispositions(self):
        ordered = ["préliminaire", "1", "1.1", "1.1.1", "1.1.1A", "1.2", "2", "2.1", "2A", "2A.1", "2B", "3", "4B.2", "10.1"]
        keys = [sort_key(n) for n in ordered]
        self.assertEqual(keys[0], 0)
        self.assertEqual(sort_key("preambule"), 0)
        self.assertEqual(sort_key("preamble"), 0)
        self.assertEqual(sort_key("note-preliminaire"), 0)
        for i in range(1, len(keys)):
            self.assertGreater(keys[i], keys[i - 1], f"{ordered[i]} doit suivre {ordered[i - 1]}")
            self.assertLess(keys[i], DISPOSITION_SORT_BASE)
        self.assertGreaterEqual(sort_key("annexe-1"), DISPOSITION_SORT_BASE)
        self.assertGreaterEqual(sort_key("annexe-a"), DISPOSITION_SORT_BASE)
        self.assertEqual(sort_key("15.01"), sort_key("15.1"))
        self.assertFalse(validate.is_disposition("2A.1"))
        self.assertTrue(validate.is_disposition("2AA.1"))
        self.assertEqual(sort_key("2AA.1"), DISPOSITION_SORT_BASE)

    def test_validate_orientation_lacunes_informatives_et_portes(self):
        divs = [Division(law_id="amf-x", lang="fr", kind="partie", path="ph1:1", heading="SECTION 1", sort_order=1)]
        arts = [
            Article(law_id="amf-x", lang="fr", number="1", text="Un.", division_path="ph1:1"),
            Article(law_id="amf-x", lang="fr", number="2A.1", text="Deux A.1.", division_path="ph1:1"),
            Article(law_id="amf-x", lang="fr", number="4B.2", text="Quatre B.2.", division_path="ph1:1"),
            Article(law_id="amf-x", lang="fr", number="10", text="Dix.", division_path="ph1:1"),
        ]
        rep = validate.validate(
            "amf-x", "fr", divs, arts,
            fonction="orientation",
            span_accounting={"total": 20, "accounted": 20, "unclassified": 0},
            toc_titles=["SECTION 1"],
        )
        self.assertTrue(rep.ok, "\n".join(rep.lines))
        self.assertIn("lacunes (orientation : informatif)", "\n".join(rep.lines))

        # Porte 1 échoue si unclassified > 0
        rep_p1 = validate.validate(
            "amf-x", "fr", divs, arts,
            fonction="orientation",
            span_accounting={"total": 20, "accounted": 19, "unclassified": 1},
        )
        self.assertFalse(rep_p1.ok)

        # Porte 2 échoue si toc_titles diverge
        rep_p2 = validate.validate(
            "amf-x", "fr", divs, arts,
            fonction="orientation",
            toc_titles=["SECTION 1", "SECTION 2"],
        )
        self.assertFalse(rep_p2.ok)

        # Doublon (law, lang, number) échoue
        arts_dup = [*arts, Article(law_id="amf-x", lang="fr", number="2A.1", text="Dup.", division_path="ph1:1")]
        rep_dup = validate.validate("amf-x", "fr", divs, arts_dup, fonction="orientation")
        self.assertFalse(rep_dup.ok)

    def test_load_to_sql_pdf_source_et_links(self):
        law = Law(id="qccs-dist-mtl", name_fr="Directives", name_en="Directives",
                  rlrq_cite="Directives C.S.", source="pdf", unit="paragraphe")
        divs = [Division(law_id="qccs-dist-mtl", lang="fr", kind="partie", path="ph1:1", heading="DIRECTIVES")]
        arts = [
            Article(
                law_id="qccs-dist-mtl", lang="fr", number="1", text="Texte.", division_path="ph1:1",
                links='[{"label":"Site","url":"https://example.org"}]',
            ),
            Article(law_id="qccs-dist-mtl", lang="fr", number="2", text="Sans lien.", division_path="ph1:1"),
        ]
        load.prepare(law, divs, arts, id_base=100)
        sql = load.to_sql(law, divs, arts, "fr")
        self.assertIn("'pdf'", sql)
        self.assertIn("https://example.org", sql)
        self.assertIn(", NULL);", sql)

    def test_helpers_purs_date_liens_pua_historique_et_prefixes(self):
        self.assertEqual(parser_pdf.parse_consolidation_date_text("1er janvier 2026", "fr"), "2026-01-01")
        self.assertEqual(parser_pdf.parse_consolidation_date_text("23 février 2026", "fr"), "2026-02-23")
        self.assertEqual(parser_pdf.parse_consolidation_date_text("January 1, 2026", "en"), "2026-01-01")

        self.assertEqual(parser_pdf.normalize_pua_text("A \uf0e0 B", "SymbolMT"), "A → B")
        self.assertEqual(parser_pdf.normalize_pua_text("pièce R-\uf0a1.", "Wingdings2"), "pièce R-□.")
        self.assertEqual(parser_pdf.normalize_pua_text("\uf0a7 Arrêt", "Wingdings-Regular"), "▪ Arrêt")
        self.assertEqual(parser_pdf.normalize_pua_text("\uf0a8 Case", "Wingdings-Regular"), "□ Case")

        sp = [_span("cliquer ici", page=1, x0=100.0, y0=200.0, x1=160.0, y1=212.0)]
        raw_links = [
            {"kind": parser_pdf.LINK_GOTO, "from": (100, 200, 160, 212), "page": 2},
            {"kind": parser_pdf.LINK_URI, "from": (100, 200, 160, 212), "uri": "mailto:par"},
            {"kind": parser_pdf.LINK_URI, "from": (0, 0, 0, 0), "uri": "https://example.org/zero"},
            {"kind": parser_pdf.LINK_URI, "from": (100, 200, 160, 212), "uri": "http://sedar/"},
            {"kind": parser_pdf.LINK_URI, "from": (100, 200, 160, 212), "uri": "http://de/"},
            {"kind": parser_pdf.LINK_URI, "from": (100, 200, 160, 212), "uri": "https://canlii.ca/t/1"},
            {"kind": parser_pdf.LINK_LAUNCH, "from": (100, 200, 160, 212), "file": "juge@judex.qc.ca"},
        ]
        kept = parser_pdf.filter_raw_links(
            raw_links, page_num=1, page_spans=sp, links_cfg={"ignore_host_without_dot": True}
        )
        self.assertEqual([k["url"] for k in kept], ["https://canlii.ca/t/1", "mailto:juge@judex.qc.ca"])
        self.assertEqual(
            json.loads(parser_pdf.deduplicate_article_links([{"label": "A", "url": "https://x.ca"}, {"label": "Longer label", "url": "https://x.ca"}]) or "[]"),
            [{"label": "Longer label", "url": "https://x.ca"}],
        )

        # Ordre visuel sur gigue italique/romain (0.5 pt), seuil de chevauchement (1.3 pt) et fusion multi-lignes
        sp_jitter = [
            _span("Audet ", page=1, x0=90.0, y0=100.5, x1=120.0, y1=114.0, base_font="Arial-ItalicMT", flags=2),
            _span("c.", page=1, x0=120.5, y0=100.0, x1=130.0, y1=114.0, base_font="ArialMT", flags=0),
            _span(" Payette", page=1, x0=130.5, y0=100.5, x1=170.0, y1=114.0, base_font="Arial-ItalicMT", flags=2),
            _span(", 2018 QCCA 309", page=1, x0=172.0, y0=100.0, x1=260.0, y1=114.0, base_font="ArialMT", flags=0),
            _span("Ligne suivante non absorbee", page=1, x0=90.0, y0=117.7, x1=260.0, y1=130.0, base_font="ArialMT", flags=0),
            _span(", [1994] 1 R.C.S.", page=1, x0=400.0, y0=140.0, x1=520.0, y1=153.0),
            _span("311", page=1, x0=90.0, y0=154.0, x1=120.0, y1=167.0),
        ]
        raw_links_2 = [
            {"kind": parser_pdf.LINK_URI, "from": (88.0, 97.0, 173.0, 119.0), "uri": "https://canlii.ca/t/audet"},
            {"kind": parser_pdf.LINK_URI, "from": (400.0, 139.0, 520.0, 154.0), "uri": "https://decisions.scc-csc.ca/1111"},
            {"kind": parser_pdf.LINK_URI, "from": (89.0, 154.0, 125.0, 170.0), "uri": "https://decisions.scc-csc.ca/1111"},
        ]
        kept_2 = parser_pdf.filter_raw_links(raw_links_2, page_num=1, page_spans=sp_jitter)
        self.assertEqual(
            [(k["label"], k["url"]) for k in kept_2],
            [
                ("Audet c. Payette", "https://canlii.ca/t/audet"),
                ("[1994] 1 R.C.S. 311", "https://decisions.scc-csc.ca/1111"),
            ],
        )

        # text_replacements : R4 (directives uniquement) et fail-closed si 0 effet
        divs_tr = [Division(law_id="d", lang="fr", kind="annexe", path="ps:1", heading="MATIERE")]
        arts_tr = [
            Article(
                law_id="d", lang="fr", number="1", text="Voir Stinchombe.", division_path="ps:1",
                links=json.dumps([{"label": "Stinchombe", "url": "https://example.org/Stinchombe"}], ensure_ascii=False),
            )
        ]
        with self.assertRaises(parser_pdf.PdfParseError):
            parser_pdf.apply_text_replacements(
                divs_tr, arts_tr, [{"from": "Stinchombe", "to": "Stinchcombe"}],
                fonction="reglement", law_id="d", lang="fr",
            )
        with self.assertRaises(parser_pdf.PdfParseError):
            parser_pdf.apply_text_replacements(
                divs_tr, arts_tr, [{"from": "Stinchombe", "to": "Stinchcombe"}],
                fonction="loi", law_id="d", lang="fr",
            )
        with self.assertRaises(parser_pdf.PdfParseError):
            parser_pdf.apply_text_replacements(
                divs_tr, arts_tr, [{"from": "Absent", "to": "Present"}],
                fonction="directive", law_id="d", lang="fr",
            )
        parser_pdf.apply_text_replacements(
            divs_tr, arts_tr,
            [{"from": "MATIERE", "to": "MATIÈRE"}, {"from": "Stinchombe", "to": "Stinchcombe"}],
            fonction="directive", law_id="d", lang="fr",
        )
        self.assertEqual(divs_tr[0].heading, "MATIÈRE")
        self.assertEqual(arts_tr[0].text, "Voir Stinchcombe.")
        self.assertEqual(
            json.loads(arts_tr[0].links or "[]"),
            [{"label": "Stinchcombe", "url": "https://example.org/Stinchombe"}],
        )

        # Pied de page relatif (y_ratio_min) sur page paysage 612pt et portrait 792pt
        ftr_cfg = {"y_ratio_min": 0.89, "regex": r"^au Règlement 51-102\s+Le\s+.*PAGE\s+\d+$"}
        ln_land = LineRecord(44, 36.0, 564.0, 400.0, 574.0, "au Règlement 51-102 Le 22 septembre 2026 PAGE 44",
                             "au Règlement 51-102 Le 22 septembre 2026 PAGE 44",
                             [_span("au Règlement 51-102 Le 22 septembre 2026 PAGE 44", x0=36.0, y0=564.0, size=10.0)])
        self.assertTrue(parser_pdf._match_band(ln_land, 44, ftr_cfg, is_header=False, page_height=612.0))
        self.assertFalse(parser_pdf._match_band(ln_land, 44, ftr_cfg, is_header=False, page_height=792.0))

        # Parenthèses TDM (qccs-div-qc) et require_dot_in_number
        self.assertEqual(
            parser_pdf._toc_cmp_norm("9. Les demandes en rejet (art. 51 et suiv. C.p.c.) et en irrecevabilité", strip_parentheticals=True),
            parser_pdf._toc_cmp_norm("9. Les demandes en rejet et en irrecevabilité", strip_parentheticals=True),
        )
        self.assertIsNone(parser_pdf.match_provision_prefix("1) Paragraphe interne", "alphanumeric", require_dot_in_number=True))
        self.assertEqual(parser_pdf.match_provision_prefix("4A.1 Champ.", "alphanumeric", require_dot_in_number=True), ("4A.1", "Champ."))

        hist_cfg = {"prefix_regex": r"^(?:Modifications?|Abrogation|Ajouts?)\s*:", "max_size_pt": 10.5, "x0_min": 85.0, "x0_max": 140.0}
        for prefix in ("Ajout : 1er janvier 2025", "Modification : 2026", "Abrogation : 2025"):
            ln_ok = LineRecord(1, 92.0, 200.0, 250.0, 210.0, prefix, prefix, [_span(prefix, size=9.96, base_font="Arial-BoldItalicMT")])
            ln_body = LineRecord(1, 92.0, 200.0, 250.0, 210.0, prefix, prefix, [_span(prefix, size=12.0, base_font="ArialMT")])
            self.assertTrue(parser_pdf.match_history_line(ln_ok, hist_cfg))
            self.assertFalse(parser_pdf.match_history_line(ln_body, hist_cfg))

        self.assertIsNone(parser_pdf.match_provision_prefix("45-106 sur les dispenses", "alphanumeric"))
        self.assertIsNone(parser_pdf.match_provision_prefix("2026-02-23 date", "alphanumeric"))
        self.assertIsNone(parser_pdf.match_provision_prefix("1er janvier 2026", "alphanumeric"))
        self.assertIsNone(parser_pdf.match_provision_prefix("2A Champ sans point", "alphanumeric"))
        self.assertEqual(parser_pdf.match_provision_prefix("2A.1 Texte.", "alphanumeric"), ("2A.1", "Texte."))
        self.assertEqual(parser_pdf.match_provision_prefix("4B.2 Autre.", "alphanumeric"), ("4B.2", "Autre."))
        self.assertEqual(parser_pdf.match_provision_prefix("1.1.1A Fin.", "alphanumeric"), ("1.1.1A", "Fin."))

    def test_ingest_configured_langs_et_import_sans_pymupdf(self):
        self.assertEqual(ingest._configured_langs({"source": "pdf", "langs": ["fr"]}), ("fr",))
        self.assertEqual(ingest._configured_langs({"source": "pdf", "langs": ["fr", "en"]}), ("fr", "en"))
        self.assertEqual(ingest._configured_langs({"source": "epub"}), ("fr", "en"))
        with unittest.mock.patch.dict(sys.modules, {"pymupdf": None, "fitz": None}):
            import importlib
            mod = importlib.reload(ingest)
            self.assertTrue(hasattr(mod, "_acquiert_pdf"))


@unittest.skipIf(pymupdf is None, "pymupdf non installé (skip CI)")
class TestParserPdfWithPyMuPdf(unittest.TestCase):
    def _build_pdf(self, pages_fn, *, toc=None, rotate_pages: dict[int, int] | None = None) -> Path:
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.close()
        doc = pymupdf.open()
        pages_fn(doc)
        if toc:
            doc.set_toc(toc)
        for idx, deg in (rotate_pages or {}).items():
            doc[idx].set_rotation(deg)
        doc.save(tmp.name)
        doc.close()
        return Path(tmp.name)

    def test_synthetic_amf_orientation_et_porte_0(self):
        # 1. PDF synthétique AMF orientation avec signets, sections alphanumériques et lacunes
        def make_amf(doc):
            p = doc.new_page(width=612, height=792)
            p.insert_text((200, 90), "À jour au 1er janvier 2026", fontname="hebo", fontsize=12)
            p.insert_text((92, 140), "CHAPITRE 2A", fontname="hebo", fontsize=12)
            p.insert_text((92, 165), "1. Première disposition sur le Règlement", fontname="helv", fontsize=12)
            p.insert_text((120, 180), "45-106 ne doit pas couper.", fontname="helv", fontsize=12)
            p.insert_text((92, 205), "2A.1 Section alphanumérique.", fontname="helv", fontsize=12)
            p.insert_text((138, 222), "a) sous-item conservé dans 2A.1.", fontname="helv", fontsize=12)
            p.insert_text((92, 245), "4B.2 Autre section CSA.", fontname="helv", fontsize=12)
            p.insert_text((92, 270), "1.1.1A Sous-section.", fontname="helv", fontsize=12)
            p.insert_text((92, 295), "5. Paragraphe après lacune.", fontname="helv", fontsize=12)

        pdf_p = self._build_pdf(make_amf, toc=[[1, "CHAPITRE 2A", 1]])
        try:
            prof = _base_profile("amf-synth", fonction="orientation", number_mode="alphanumeric")
            law = Law(id="amf-synth", name_fr="IG", name_en="IG", rlrq_cite="IG 45-106", source="pdf", unit="article")
            bilan = parser_pdf.PdfBilan()
            divs, arts = parser_pdf.parse_pdf(pdf_p, law, "fr", profile=prof, verify_sha256=False, bilan=bilan)
            self.assertEqual(law.consol_date_fr, "2026-01-01")
            self.assertEqual([a.number for a in arts], ["1", "2A.1", "4B.2", "1.1.1A", "5"])
            self.assertIn("a) sous-item conservé dans 2A.1.", arts[1].text)
            self.assertEqual(bilan.unclassified, 0)

            rep = validate.validate(
                "amf-synth", "fr", divs, arts,
                fonction="orientation",
                span_accounting=bilan.span_accounting,
                toc_titles=bilan.toc_titles,
            )
            self.assertTrue(rep.ok, "\n".join(rep.lines))

            # fr-only saute en proprement dans ingest.run
            with unittest.mock.patch("pipeline.config.get_law_any", return_value={"id": "amf-synth", "source": "pdf", "langs": ["fr"], "name_fr": "IG", "official_cite": "IG"}):
                self.assertEqual(ingest.run("amf-synth", "en", False, False, False, [], True), 0)
        finally:
            pdf_p.unlink(missing_ok=True)

        # 2. Porte 0 : PDF vide/numérisé et corrompu
        def make_blank(doc):
            doc.new_page(width=612, height=792)

        blank_p = self._build_pdf(make_blank)
        try:
            with self.assertRaises(parser_pdf.ScannedPdfError):
                parser_pdf.parse_pdf(
                    blank_p,
                    Law(id="x", name_fr="x", name_en="x", rlrq_cite="x"),
                    "fr",
                    profile=_base_profile("x"),
                    verify_sha256=False,
                )
        finally:
            blank_p.unlink(missing_ok=True)

        with tempfile.TemporaryDirectory() as td:
            corrupt_p = Path(td) / "corrupt.pdf"
            corrupt_p.write_bytes(b"not-a-pdf")
            with self.assertRaises(parser_pdf.CorruptPdfError):
                parser_pdf.parse_pdf(
                    corrupt_p,
                    Law(id="x", name_fr="x", name_en="x", rlrq_cite="x"),
                    "fr",
                    profile=_base_profile("x"),
                    verify_sha256=False,
                )

    def test_synthetic_directive_abrogations_historique_liens_portes_1_et_2(self):
        def make_dir(doc):
            p1 = doc.new_page(width=612, height=792)
            p1.insert_text((200, 80), "À jour au 23 février 2026", fontname="hebo", fontsize=12)
            p1.insert_text((92, 130), "SECTION UN", fontname="hebo", fontsize=12)
            p1.insert_text((92, 155), "Modification : 1er janvier 2026", fontname="hebo", fontsize=10)
            p1.insert_text((92, 180), "1. Abrogé.", fontname="helv", fontsize=12)
            p1.insert_text((92, 200), "2. Abrogation.", fontname="helv", fontsize=12)
            p1.insert_text((92, 220), "3. [...]", fontname="helv", fontsize=12)
            p1.insert_text((92, 240), "4. Texte actif avec courriel juge@judex.qc.ca et lien.", fontname="helv", fontsize=12)
            p1.insert_text((92, 260), "Modification : 2 février 2026", fontname="hebo", fontsize=10)
            p1.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(92, 228, 350, 244), "uri": "https://example.org/dir"})
            p1.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(92, 228, 350, 244), "uri": "mailto:juge@judex.qc.ca"})
            p1.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(92, 228, 350, 244), "uri": "mailto:par"})

            p2 = doc.new_page(width=612, height=792)
            p2.insert_text((92, 100), "LISTE DES ANNEXES", fontname="hebo", fontsize=12)
            p2.insert_text((92, 125), "Division 1. Formulaire type", fontname="helv", fontsize=12)
            p2.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(92, 113, 280, 130), "uri": "https://example.org/form.docx"})

        pdf_p = self._build_pdf(make_dir, toc=[[1, "SECTION UN", 1], [1, "LISTE DES ANNEXES", 2]])
        try:
            prof = _base_profile("dir-synth")
            prof["files"]["fr"]["page_count"] = 2
            prof["files"]["fr"]["annexe_start_page"] = 2
            law = Law(id="dir-synth", name_fr="Dir", name_en="Dir", rlrq_cite="Dir", source="pdf", unit="paragraphe")
            bilan = parser_pdf.PdfBilan()
            divs, arts = parser_pdf.parse_pdf(pdf_p, law, "fr", profile=prof, verify_sha256=False, bilan=bilan)
            self.assertEqual(divs[0].history, "Modification : 1er janvier 2026")
            self.assertEqual([a.repealed for a in arts[:4]], [1, 1, 1, 0])
            self.assertEqual(arts[0].text, "Abrogé.")
            self.assertEqual(arts[1].text, "Abrogation.")
            self.assertEqual(arts[2].text, "[...]")
            self.assertEqual(arts[3].history, "Modification : 2 février 2026")
            self.assertNotIn("Modification :", arts[3].text)
            links_4 = json.loads(arts[3].links or "[]")
            self.assertEqual([l["url"] for l in links_4], ["https://example.org/dir", "mailto:juge@judex.qc.ca"])
            self.assertEqual(arts[4].number, "annexe-division-1")
            self.assertGreaterEqual(arts[4].sort_key or 0, DISPOSITION_SORT_BASE)

            with tempfile.TemporaryDirectory() as out_tmp:
                prev_p = parser_pdf.write_preview_md(Path(out_tmp), law, "fr", divs, arts, bilan)
                raw = prev_p.read_bytes()
                self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn(b"\r\n", raw)
                self.assertIn("https://example.org/form.docx", raw.decode("utf-8"))

            # Porte 1 : span hors bande x0 non classé -> SpanBilanError
            prof_bad_p1 = json.loads(json.dumps(prof))
            prof_bad_p1["files"]["fr"]["provisions"]["x0_min"] = 95.0
            with self.assertRaises(parser_pdf.SpanBilanError):
                parser_pdf.parse_pdf(pdf_p, law, "fr", profile=prof_bad_p1, verify_sha256=False)
        finally:
            pdf_p.unlink(missing_ok=True)

        # Porte 2 : divergence TOC -> TocParityError
        pdf_bad_toc = self._build_pdf(make_dir, toc=[[1, "SECTION FANTOME", 1], [1, "LISTE DES ANNEXES", 2]])
        try:
            prof2 = _base_profile("dir-synth")
            prof2["files"]["fr"]["page_count"] = 2
            prof2["files"]["fr"]["annexe_start_page"] = 2
            with self.assertRaises(parser_pdf.TocParityError):
                parser_pdf.parse_pdf(
                    pdf_bad_toc,
                    Law(id="dir-synth", name_fr="Dir", name_en="Dir", rlrq_cite="Dir"),
                    "fr",
                    profile=prof2,
                    verify_sha256=False,
                )
        finally:
            pdf_bad_toc.unlink(missing_ok=True)

        # Page pivotée /Rotate 90 avec lien
        def make_rot(doc):
            p = doc.new_page(width=612, height=792)
            p.insert_text((200, 80), "À jour au 1er janvier 2026", fontname="hebo", fontsize=12)
            p.insert_text((92, 130), "SECTION ROT", fontname="hebo", fontsize=12)
            p.insert_text((92, 160), "1. Lien sur page pivotée.", fontname="helv", fontsize=12)
            p.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(92, 148, 250, 165), "uri": "https://example.org/rot"})

        rot_p = self._build_pdf(make_rot, toc=[[1, "SECTION ROT", 1]], rotate_pages={0: 90})
        try:
            prof_r = _base_profile("rot-synth")
            divs_r, arts_r = parser_pdf.parse_pdf(
                rot_p,
                Law(id="rot-synth", name_fr="Rot", name_en="Rot", rlrq_cite="Rot"),
                "fr",
                profile=prof_r,
                verify_sha256=False,
            )
            self.assertIn("https://example.org/rot", arts_r[0].links or "")
        finally:
            rot_p.unlink(missing_ok=True)

    def test_rotated_tables_derotation_visual_order_and_full_sections_repeal(self):
        # 1. _apply_derotation : conversion tuple/list -> Rect et TypeError non avalé
        with self.assertRaises(TypeError):
            parser_pdf._apply_derotation("not-a-rect", pymupdf.Identity)

        for rot in (90, 180, 270):
            def make_rot_tbl(doc):
                p = doc.new_page(width=612, height=792)
                p.insert_text((200, 80), "À jour au 1er janvier 2026", fontname="hebo", fontsize=12)
                p.insert_text((92, 130), "SECTION TABLE", fontname="hebo", fontsize=12)
                p.insert_text((92, 155), "1. Tableau pivoté.", fontname="helv", fontsize=12)
                p.draw_rect(pymupdf.Rect(100, 170, 300, 270))
                p.draw_line((200, 170), (200, 270))
                p.draw_line((100, 220), (300, 220))
                p.insert_text((120, 200), "A", fontname="helv", fontsize=11)
                p.insert_text((220, 200), "B", fontname="helv", fontsize=11)
                p.insert_text((120, 250), "C", fontname="helv", fontsize=11)
                p.insert_text((220, 250), "D", fontname="helv", fontsize=11)

            rot_tbl_p = self._build_pdf(make_rot_tbl, toc=[[1, "SECTION TABLE", 1]], rotate_pages={0: rot})
            try:
                doc_chk = pymupdf.open(rot_tbl_p)
                derot_m = doc_chk[0].derotation_matrix
                t_raw = doc_chk[0].find_tables().tables[0]
                derot_bbox = parser_pdf._apply_derotation(t_raw.bbox, derot_m)
                doc_chk.close()
                self.assertIsNotNone(derot_bbox)
                self.assertAlmostEqual(derot_bbox[0], 100.0, delta=2.0)
                self.assertAlmostEqual(derot_bbox[1], 170.0, delta=2.0)
                self.assertAlmostEqual(derot_bbox[2], 300.0, delta=2.0)
                self.assertAlmostEqual(derot_bbox[3], 270.0, delta=2.0)

                prof_rt = _base_profile("rot-tbl")
                prof_rt["files"]["fr"]["tables"] = {"enabled": True, "from_page": 1}
                bilan_rt = parser_pdf.PdfBilan()
                _divs_rt, arts_rt = parser_pdf.parse_pdf(
                    rot_tbl_p,
                    Law(id="rot-tbl", name_fr="Rot", name_en="Rot", rlrq_cite="Rot"),
                    "fr",
                    profile=prof_rt,
                    verify_sha256=False,
                    bilan=bilan_rt,
                )
                self.assertGreater(bilan_rt.buckets.get("table_text", 0), 0)
                self.assertEqual(bilan_rt.unclassified, 0)
                self.assertIn("A | B\nC | D", arts_rt[0].text)
                for cell_val in ("A", "B", "C", "D"):
                    self.assertEqual(arts_rt[0].text.count(cell_val), 1, f"rot={rot} dup={cell_val}")
            finally:
                rot_tbl_p.unlink(missing_ok=True)

        # 2. full_sections (Abrogée) : abrogée quand seul l'historique suit, active si texte suit
        def make_ann_rep(doc):
            p = doc.new_page(width=612, height=792)
            p.insert_text((200, 80), "À jour au 1er janvier 2026", fontname="hebo", fontsize=12)
            p.insert_text((92, 130), "PARTIE 1", fontname="hebo", fontsize=12)
            p.insert_text((92, 155), "1. Disposition.", fontname="helv", fontsize=12)
            p2 = doc.new_page(width=612, height=792)
            p2.insert_text((92, 100), "ANNEXE 1 (Abrogée)", fontname="hebo", fontsize=12)
            p2.insert_text((92, 120), "A.M. 2016-12, a. 8.", fontname="helv", fontsize=9)
            p2.insert_text((92, 160), "ANNEXE 2 (Abrogée)", fontname="hebo", fontsize=12)
            p2.insert_text((92, 185), "Texte actif conservé.", fontname="helv", fontsize=12)

        ann_p = self._build_pdf(
            make_ann_rep,
            toc=[[1, "PARTIE 1", 1], [1, "ANNEXE 1 (Abrogée)", 2], [1, "ANNEXE 2 (Abrogée)", 2]],
        )
        try:
            prof_a = _base_profile("ann-rep")
            prof_a["files"]["fr"]["page_count"] = 2
            prof_a["files"]["fr"]["annexe_start_page"] = 2
            prof_a["files"]["fr"]["annexes"] = {"mode": "full_sections"}
            prof_a["files"]["fr"]["toc_parser"] = {"source": "outline"}
            divs_a, arts_a = parser_pdf.parse_pdf(
                ann_p,
                Law(id="ann-rep", name_fr="Ann", name_en="Ann", rlrq_cite="Ann"),
                "fr",
                profile=prof_a,
                verify_sha256=False,
            )
            by_d = {d.heading: d for d in divs_a}
            by_a = {a.number: a for a in arts_a}
            self.assertEqual(by_d["ANNEXE 1 (Abrogée)"].repealed, 1)
            self.assertEqual(by_a["annexe-1"].repealed, 1)
            self.assertEqual(by_d["ANNEXE 2 (Abrogée)"].repealed, 0)
            self.assertEqual(by_a["annexe-2"].repealed, 0)
        finally:
            ann_p.unlink(missing_ok=True)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2026-02-23_Directives_District_Montreal.pdf").exists(),
        "PDF QCCS District de Montréal absent de pipeline/samples/",
    )
    def test_reel_qccs_dist_mtl(self):
        law = Law(
            id="qccs-dist-mtl",
            name_fr="Directives de la Cour supérieure — District de Montréal",
            name_en="Directives de la Cour supérieure — District de Montréal",
            rlrq_cite="Directives C.S. (District de Montréal)",
            source="pdf",
            unit="paragraphe",
        )
        bilan = parser_pdf.PdfBilan()
        divs, arts = parser_pdf.parse_pdf(
            config.SAMPLES_DIR / "2026-02-23_Directives_District_Montreal.pdf",
            law, "fr", bilan=bilan,
        )
        load.prepare(law, divs, arts)
        rep = validate.validate(
            law.id, "fr", divs, arts,
            jurisdiction="qc", fonction="directive",
            span_accounting=bilan.span_accounting,
            toc_titles=bilan.toc_titles,
            toc_exempt_headings=bilan.toc_exempt_headings,
        )
        self.assertTrue(rep.ok, "\n".join(rep.lines))
        self.assertEqual(law.consol_date_fr, "2026-02-23")
        self.assertEqual(bilan.total_spans, 1540)
        self.assertEqual(bilan.unclassified, 0)
        self.assertEqual(rep.stats["articles_real"], 181)
        self.assertEqual((rep.stats["int_min"], rep.stats["int_max"]), (1, 172))
        self.assertEqual(rep.stats["decimals"], 9)
        self.assertEqual(rep.stats["repealed_articles"], 65)
        self.assertEqual(rep.stats["dispositions"], 14)

        by_num = {a.number: a for a in arts}
        self.assertIn("préséance sur celles-ci", by_num["1"].text)
        self.assertEqual(by_num["46"].repealed, 1)
        self.assertEqual(by_num["134"].repealed, 1)
        self.assertEqual(by_num["annexe-district-6"].repealed, 1)
        self.assertIn("Liste de vérification", by_num["102"].footnotes or "")
        self.assertIn("mailto:registraires-mtl@justice.gouv.qc.ca", by_num["115.1"].links or "")
        self.assertIn("mailto:juge.cabinet.cs.mtl@judex.qc.ca", by_num["26.1"].links or "")
        div_paths = {d.path for d in divs}
        for a in arts:
            self.assertLessEqual(len(f"art:{law.id}:{a.number}".encode("utf-8")), 64)
            self.assertIn(a.division_path, div_paths)
            self.assertFalse(any(0xE000 <= ord(c) <= 0xF8FF for c in a.text), f"PUA résiduel dans {a.number}")

        with tempfile.TemporaryDirectory() as out_tmp:
            prev_p = parser_pdf.write_preview_md(Path(out_tmp), law, "fr", divs, arts, bilan)
            raw = prev_p.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r\n", raw)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "Directives_de_la_division_de_Montreal.pdf").exists(),
        "PDF QCCS Division de Montréal absent de pipeline/samples/",
    )
    def test_reel_qccs_div_mtl(self):
        law = Law(
            id="qccs-div-mtl",
            name_fr="Directives de la Cour supérieure — Division de Montréal",
            name_en="Directives de la Cour supérieure — Division de Montréal",
            rlrq_cite="Directives C.S. (Division de Montréal)",
            source="pdf",
            unit="paragraphe",
        )
        bilan = parser_pdf.PdfBilan()
        divs, arts = parser_pdf.parse_pdf(
            config.SAMPLES_DIR / "Directives_de_la_division_de_Montreal.pdf",
            law, "fr", bilan=bilan,
        )
        load.prepare(law, divs, arts)
        rep = validate.validate(
            law.id, "fr", divs, arts,
            jurisdiction="qc", fonction="directive",
            span_accounting=bilan.span_accounting,
            toc_titles=bilan.toc_titles,
            toc_exempt_headings=bilan.toc_exempt_headings,
        )
        self.assertTrue(rep.ok, "\n".join(rep.lines))
        self.assertEqual(law.consol_date_fr, "2026-01-01")
        self.assertEqual(bilan.total_spans, 2357)
        self.assertEqual(bilan.unclassified, 0)
        self.assertEqual(rep.stats["articles_real"], 217)
        self.assertEqual((rep.stats["int_min"], rep.stats["int_max"]), (1, 190))
        self.assertEqual(rep.stats["decimals"], 27)
        self.assertEqual(rep.stats["repealed_articles"], 6)
        self.assertEqual(rep.stats["dispositions"], 12)  # 4 listes jurisprudence + 8 annexes

        ch_comm = next(d for d in divs if d.heading == "CHAMBRE COMMERCIALE")
        self.assertIn("ajout de cette section", ch_comm.history or "")

        by_num = {a.number: a for a in arts}
        self.assertEqual(by_num["83.1"].repealed, 1)
        self.assertEqual(by_num["83.1"].text, "[…]")
        self.assertIn("Reconnaissance optique", by_num["91"].footnotes or "")
        self.assertIn("PRENEZ AVIS", by_num["108"].text)
        self.assertIn("□", by_num["130"].text)
        self.assertIn("→", by_num["131"].text)
        self.assertNotIn("mailto:par", by_num["176"].links or "")
        self.assertIn("canlii.ca", by_num["liste-controle-judiciaire"].links or "")
        self.assertIn(".docx", by_num["annexe-division-8"].links or "")
        self.assertIn("\nSociété de crédit commercial GMAC", by_num["liste-commerciale-faillite"].text)
        self.assertIn("\nImperial Tobacco", by_num["liste-actions-collectives"].text)
        self.assertIn("St-Ferdinand", by_num["liste-actions-collectives"].text)
        self.assertNotIn("St[1]Ferdinand", by_num["liste-actions-collectives"].text)
        self.assertIn(
            "Délai d'exercice du pourvoi et nature discrétionnaire du contrôle judiciaire\n",
            by_num["liste-controle-judiciaire"].text,
        )
        self.assertIn("Metropolitan Stores Ltd., [1987]", by_num["liste-controle-judiciaire"].text)
        for lname in ("liste-controle-judiciaire", "liste-commerciale-faillite", "liste-actions-collectives"):
            for lk in json.loads(by_num[lname].links or "[]"):
                self.assertFalse(lk["label"].startswith((",", ".")), f"Étiquette mal nettoyée ({lname}): {lk!r}")
        div_paths = {d.path for d in divs}
        for a in arts:
            self.assertLessEqual(len(f"art:{law.id}:{a.number}".encode("utf-8")), 64)
            self.assertIn(a.division_path, div_paths)
            self.assertFalse(any(0xE000 <= ord(c) <= 0xF8FF for c in a.text), f"PUA résiduel dans {a.number}")

        with tempfile.TemporaryDirectory() as out_tmp:
            prev_p = parser_pdf.write_preview_md(Path(out_tmp), law, "fr", divs, arts, bilan)
            raw = prev_p.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r\n", raw)

    def _assert_real_pdf_ok(
        self,
        law_id: str,
        filename: str,
        *,
        fonction: str,
        unit: str,
        expected_date: str,
        expected_spans: int,
        expected_real: int,
        expected_repealed: int = 0,
        min_divs: int = 1,
    ) -> tuple[list[Division], list[Article], parser_pdf.PdfBilan]:
        law = Law(
            id=law_id, name_fr=law_id, name_en=law_id, rlrq_cite=law_id,
            source="pdf", unit=unit, jurisdiction="qc",
        )
        bilan = parser_pdf.PdfBilan()
        divs, arts = parser_pdf.parse_pdf(config.SAMPLES_DIR / filename, law, "fr", bilan=bilan)
        load.prepare(law, divs, arts)
        rep = validate.validate(
            law.id, "fr", divs, arts,
            jurisdiction="qc", fonction=fonction,
            span_accounting=bilan.span_accounting,
            toc_titles=None if bilan.skip_toc_parity else bilan.toc_titles,
            toc_exempt_headings=bilan.toc_exempt_headings,
            toc_strip_parentheticals=bilan.toc_strip_parentheticals,
        )
        self.assertTrue(rep.ok, "\n".join(rep.lines))
        self.assertEqual(law.consol_date_fr, expected_date)
        self.assertEqual(bilan.total_spans, expected_spans)
        self.assertEqual(bilan.unclassified, 0)
        self.assertEqual(rep.stats["articles_real"], expected_real)
        self.assertEqual(rep.stats["repealed_articles"], expected_repealed)
        self.assertGreaterEqual(len(divs), min_divs)
        div_paths = {d.path for d in divs}
        for a in arts:
            self.assertLessEqual(len(f"art:{law.id}:{a.number}".encode("utf-8")), 64)
            self.assertIn(a.division_path, div_paths)
            self.assertFalse(any(0xE000 <= ord(c) <= 0xF8FF for c in a.text), f"PUA résiduel dans {a.number}")
            self.assertLess(len(a.text.encode("utf-8")), 95_000)
        with tempfile.TemporaryDirectory() as out_tmp:
            prev_p = parser_pdf.write_preview_md(Path(out_tmp), law, "fr", divs, arts, bilan)
            raw = prev_p.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r\n", raw)
        return divs, arts, bilan

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2022-01-31_Directives_concernant_le_fonctionnement_de_la_division_de_Quebec.pdf").exists(),
        "PDF QCCS Division de Québec absent de pipeline/samples/",
    )
    def test_reel_qccs_div_qc(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "qccs-div-qc",
            "2022-01-31_Directives_concernant_le_fonctionnement_de_la_division_de_Quebec.pdf",
            fonction="directive", unit="paragraphe",
            expected_date="2022-01-31", expected_spans=1219, expected_real=86, min_divs=35,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("helene.routhier@judex.qc.ca", by_n["tableau-7"].links or "")
        self.assertIn("▪ Baker", by_n["liste-civile"].text)
        self.assertIn("\n▪ Spar Aerospace", by_n["liste-civile"].text)
        self.assertIn("unik.caij.qc.ca", by_n["liste-civile"].links or "")
        for lname in ("liste-civile", "liste-familiale"):
            for lk in json.loads(by_n[lname].links or "[]"):
                self.assertFalse(lk["label"].startswith(","), f"Étiquette mal nettoyée ({lname}): {lk!r}")

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "ChCivile_DirectiveReglesParticulieres.pdf").exists(),
        "PDF QCCQ Règles simplifiées absent de pipeline/samples/",
    )
    def test_reel_qccq_regles_simplifiees(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "qccq-regles-simplifiees",
            "ChCivile_DirectiveReglesParticulieres.pdf",
            fonction="directive", unit="paragraphe",
            expected_date="2026-05-14", expected_spans=143, expected_real=8, min_divs=3,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("\na. La nature", by_n["4"].text)
        self.assertIn("SJ-1273", by_n["4"].links or "")
        self.assertIn("SJ-1274", by_n["5"].links or "")

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "MtlCivil_ModeFonctDivPratCivile.pdf").exists(),
        "PDF QCCQ Montréal Pratique civile absent de pipeline/samples/",
    )
    def test_reel_qccq_mtl_prat_civile(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "qccq-mtl-prat-civile",
            "MtlCivil_ModeFonctDivPratCivile.pdf",
            fonction="directive", unit="paragraphe",
            expected_date="2023-07-21", expected_spans=242, expected_real=15, min_divs=5,
        )
        by_n = {a.number: a for a in arts}
        self.assertEqual(by_n["preambule"].sort_key, 0)
        self.assertIn("Demande non contestée\n", by_n["1.1"].text)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "MtlCivil_ModeFonctDivPratAdmin.pdf").exists(),
        "PDF QCCQ Montréal Pratique administrative absent de pipeline/samples/",
    )
    def test_reel_qccq_mtl_prat_admin(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "qccq-mtl-prat-admin",
            "MtlCivil_ModeFonctDivPratAdmin.pdf",
            fonction="directive", unit="paragraphe",
            expected_date="2023-07-21", expected_spans=183, expected_real=10, min_divs=4,
        )
        by_n = {a.number: a for a in arts}
        self.assertEqual(by_n["preambule"].sort_key, 0)
        self.assertIn("coordinationDAA@judex.qc.ca", by_n["1.2"].links or "")

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "DAA_DirectiveListeCommuneJuris.pdf").exists(),
        "PDF QCCQ DAA jurisprudence absent de pipeline/samples/",
    )
    def test_reel_qccq_daa_jurisprudence(self):
        divs, arts, _bilan = self._assert_real_pdf_ok(
            "qccq-daa-jurisprudence",
            "DAA_DirectiveListeCommuneJuris.pdf",
            fonction="directive", unit="paragraphe",
            expected_date="2021-09-27", expected_spans=1788, expected_real=5, min_divs=8,
        )
        by_n = {a.number: a for a in arts}
        by_div = {d.path: d for d in divs}
        self.assertIn("RLRQ, c. C-25.01, r.4, art. 39", by_n["2"].footnotes or "")
        self.assertIn("canlii.org", by_n["annexe-disciplinaire"].links or "")
        self.assertIn("R. c. Stinchcombe", by_n["annexe-disciplinaire"].text)
        self.assertIn("R. c. Stinchcombe", by_n["annexe-deontologie-policiere"].text)
        for a in arts:
            self.assertNotIn("Stinchombe", a.text)
        self.assertIn(
            "Fondation internationale Azzahra inc., 2017 QCCA 240 Interprétation de la notion d’« institution religieuse ». | 17.",
            by_n["annexe-fiscalite-municipale"].text,
        )
        self.assertIn("MATIÈRE DE FISCALITÉ", by_div["ps:3"].heading or "")
        self.assertIn("MATIÈRE FISCALE", by_div["ps:4"].heading or "")
        disc_labels = [lk["label"] for lk in json.loads(by_n["annexe-disciplinaire"].links or "[]")]
        self.assertTrue(any(lbl.startswith("Audet c. Payette") for lbl in disc_labels), disc_labels[:5])
        self.assertIn("Association des courtiers et agents immobiliers du Québec c. Proprio Direct inc.", disc_labels)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2026juil04-31-103-vofficielle-fr.pdf").exists(),
        "PDF AMF Règlement 31-103 absent de pipeline/samples/",
    )
    def test_reel_v_1_1_r_10(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "v-1.1-r.10",
            "2026juil04-31-103-vofficielle-fr.pdf",
            fonction="reglement", unit="article",
            expected_date="2026-07-04", expected_spans=10860, expected_real=190, expected_repealed=3, min_divs=60,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("13.2.01", by_n)
        self.assertIn("13.2.1", by_n)
        self.assertIn("14.6.2", by_n)
        ann_hist_pat = re.compile(r"^(?:A\.M\.|L\.Q\.|N\.I\.|D\.)\s+", re.M)
        self.assertTrue(by_n["annexe-31-103a1-appendice-1"].history)
        self.assertIsNone(ann_hist_pat.search(by_n["annexe-31-103a1-appendice-1"].text))

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2025sept19-45-106-vofficielle-fr.pdf").exists(),
        "PDF AMF Règlement 45-106 absent de pipeline/samples/",
    )
    def test_reel_v_1_1_r_21(self):
        divs, arts, _bilan = self._assert_real_pdf_ok(
            "v-1.1-r.21",
            "2025sept19-45-106-vofficielle-fr.pdf",
            fonction="reglement", unit="article",
            expected_date="2025-09-19", expected_spans=17884, expected_real=144, expected_repealed=56, min_divs=140,
        )
        self.assertEqual(sum(1 for d in divs if d.repealed), 7)
        pp0 = next(d for d in divs if d.path == "pp:0")
        self.assertEqual(pp0.kind, "disposition")
        self.assertEqual(pp0.heading, "Note préliminaire")
        ann_a6_div = next(d for d in divs if d.heading == "ANNEXE 45-106A6 (Abrogée)")
        self.assertEqual(ann_a6_div.repealed, 1)
        by_n = {a.number: a for a in arts}
        self.assertEqual(by_n["note-preliminaire"].sort_key, 0)
        self.assertEqual(by_n["note-preliminaire"].division_path, "pp:0")
        self.assertEqual(by_n["annexe-45-106a6"].repealed, 1)
        self.assertGreaterEqual(sum(a.text.count("□") for a in arts), 18)
        self.assertEqual(sum(a.text.count("\uf0a8") for a in arts), 0)
        self.assertIn("2.35.1.1", by_n)
        self.assertIn("5A.1", by_n)
        self.assertEqual(by_n["3.0"].repealed, 1)
        self.assertNotIn("http://sedar/", by_n["annexe-45-106a1-appendice-1"].links or "")
        self.assertTrue(by_n["annexe-a"].history)
        self.assertNotIn("A.M.", by_n["annexe-a"].text)
        self.assertNotIn("L.Q.", by_n["annexe-a"].text)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2026sept22-51-102-vofficielle-fr.pdf").exists(),
        "PDF AMF Règlement 51-102 absent de pipeline/samples/",
    )
    def test_reel_v_1_1_r_24(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "v-1.1-r.24",
            "2026sept22-51-102-vofficielle-fr.pdf",
            fonction="reglement", unit="article",
            expected_date="2026-09-22", expected_spans=14534, expected_real=78, expected_repealed=3, min_divs=90,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("4A.1", by_n)
        self.assertIn("4B.3", by_n)
        self.assertTrue(by_n["annexe-51-102a1-rubrique-2"].history)
        self.assertNotIn("A.M.", by_n["annexe-51-102a1-rubrique-2"].text)
        self.assertNotIn("D.", by_n["annexe-51-102a1-rubrique-2"].text)
        for a in arts:
            self.assertNotIn("http://de/", a.links or "")
            self.assertNotIn("http://sedar/", a.links or "")

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2026juil04-31-103-ig-vconsolidee-fr.pdf").exists(),
        "PDF AMF IG 31-103 absent de pipeline/samples/",
    )
    def test_reel_amf_ig_31_103(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "amf-ig-31-103",
            "2026juil04-31-103-ig-vconsolidee-fr.pdf",
            fonction="orientation", unit="article",
            expected_date="2026-07-04", expected_spans=10774, expected_real=97, min_divs=48,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("13.2.01", by_n)
        self.assertIn("▪", by_n["11.5"].text)
        self.assertIn("inscription@lautorite.qc.ca", by_n["annexe-a"].links or "")

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2023juin09-45-106-ig-vconsolidee-fr.pdf").exists(),
        "PDF AMF IG 45-106 absent de pipeline/samples/",
    )
    def test_reel_amf_ig_45_106(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "amf-ig-45-106",
            "2023juin09-45-106-ig-vconsolidee-fr.pdf",
            fonction="orientation", unit="article",
            expected_date="2023-06-09", expected_spans=3476, expected_real=54, expected_repealed=1, min_divs=7,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("3.4.01", by_n)
        self.assertEqual(by_n["5.3"].repealed, 1)
        self.assertIn("Date de", by_n["3.8"].text)

    @unittest.skipUnless(
        (config.SAMPLES_DIR / "2026sept22-51-102-ig-vadmin-fr.pdf").exists(),
        "PDF AMF IG 51-102 absent de pipeline/samples/",
    )
    def test_reel_amf_ig_51_102(self):
        _divs, arts, _bilan = self._assert_real_pdf_ok(
            "amf-ig-51-102",
            "2026sept22-51-102-ig-vadmin-fr.pdf",
            fonction="orientation", unit="article",
            expected_date="2026-09-22", expected_spans=2920, expected_real=70, min_divs=16,
        )
        by_n = {a.number: a for a in arts}
        self.assertIn("4A.1", by_n)
        self.assertIn("9.1", by_n)
        self.assertIn("Changement de la date", by_n["annexe-a"].text)

    def test_synthetic_bare_number_followed_by_repeal_on_next_line(self):
        def make_bare_rep(doc):
            p = doc.new_page(width=612, height=792)
            p.insert_text((200, 80), "À jour au 1er janvier 2026", fontname="hebo", fontsize=12)
            p.insert_text((92, 130), "SECTION UN", fontname="hebo", fontsize=12)
            p.insert_text((92, 160), "1.", fontname="helv", fontsize=12)
            p.insert_text((120, 178), "Abrogé.", fontname="helv", fontsize=12)
            p.insert_text((92, 200), "2. Actif.", fontname="helv", fontsize=12)
            p.insert_text((92, 225), "3.", fontname="helv", fontsize=12)
            p.insert_text((120, 243), "Abrogé.", fontname="helv", fontsize=12)
            p.insert_text((120, 260), "Texte conservé malgré tout.", fontname="helv", fontsize=12)

        pdf_p = self._build_pdf(make_bare_rep, toc=[[1, "SECTION UN", 1]])
        try:
            prof = _base_profile("bare-rep")
            bilan = parser_pdf.PdfBilan()
            _divs, arts = parser_pdf.parse_pdf(
                pdf_p,
                Law(id="bare-rep", name_fr="Bare", name_en="Bare", rlrq_cite="Bare"),
                "fr",
                profile=prof,
                verify_sha256=False,
                bilan=bilan,
            )
            by_n = {a.number: a for a in arts}
            self.assertEqual(by_n["1"].repealed, 1)
            self.assertEqual(by_n["1"].text, "Abrogé.")
            self.assertEqual(by_n["2"].repealed, 0)
            self.assertEqual(by_n["3"].repealed, 0)
            self.assertIn("Texte conservé malgré tout.", by_n["3"].text)
            self.assertGreaterEqual(bilan.buckets.get("repeal_marker", 0), 1)
        finally:
            pdf_p.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
