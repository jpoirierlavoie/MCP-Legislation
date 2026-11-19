"""Tests unitaires pour `pipeline.discovery.recon_pdf`.

Comporte deux jeux :
1. Logique pure Python (toujours exécutée, même en CI sans `pymupdf`) : normalisation Unicode `Zs`,
   motifs numériques et alphanumériques CSA/AMF (`2A.1`, `4B.2`, `1.1.1A`) sans faux positifs sur
   `45-106` ou `2026-02-23`, reconstruction de lignes par tolérance `y0` (exposants `1er`),
   clustering `x0`, détection de bandeaux `y0` et formatage Markdown/JSON.
2. Tests synthétiques `pymupdf` (`@unittest.skipIf(pymupdf is None, ...)`) : PDF multi-pages riche
   (polices/styles, clusters `x0`, bandeaux `y0`, liens `LINK_URI`/`LINK_GOTO`, signets TOC, espaces
   `U+00A0`/`U+2009`/`U+202F`, sections `2A.1`/`4B.2`, `Abrogé.`), refus strict des PDF numérisés
   (zéro OCR), refus des PDF vides/corrompus/chiffrés, et déterminisme CLI UTF-8 LF.
"""
from __future__ import annotations

import hashlib
import io
import json
import struct
import tempfile
import unittest
import zlib
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from pipeline.discovery import recon_pdf
from pipeline.discovery.recon_pdf import (
    CorruptPdfError,
    EncryptedPdfError,
    ScannedPdfError,
    SpanRecord,
    _norm,
    audit_unicode_zs,
    build_json_report,
    build_markdown_report,
    classify_line_pattern,
    cluster_x0,
    decode_font_flags,
    detect_y0_bands,
    normalize_target_page,
    pymupdf,
    reconstruct_lines,
    strip_font_subset,
)


def _make_png_1x1() -> bytes:
    """Construit un PNG RVB 1×1 valide en stdlib pure (aucun fichier externe)."""

    def _chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\xff\xff")
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


class TestReconPdfPurePython(unittest.TestCase):
    def test_norm_and_unicode_zs_audit_preserve_typographic_apostrophe(self):
        raw = "À\xa0jour\u2002au\u20091er\u202fjanvier — l’instance"
        self.assertEqual(_norm(raw), "À jour au 1er janvier — l’instance")
        self.assertEqual(
            audit_unicode_zs(raw),
            {"U+00A0": 1, "U+2002": 1, "U+2009": 1, "U+202F": 1},
        )

    def test_font_subset_strip_and_flags(self):
        self.assertEqual(strip_font_subset("ABCDEE+Arial-BoldMT"), "Arial-BoldMT")
        self.assertEqual(strip_font_subset("ArialMT"), "ArialMT")
        self.assertEqual(decode_font_flags(1 | 2 | 16), ["superscript", "italic", "bold"])

    def test_classify_line_pattern_alphanumeric_and_non_misclassification(self):
        self.assertEqual(classify_line_pattern("2A.1 Champ d'application")["kind"], "alphanumeric")
        self.assertEqual(classify_line_pattern("2A.1 Champ d'application")["token"], "2A.1")
        self.assertEqual(classify_line_pattern("4B.2 Autre règle")["kind"], "alphanumeric")
        self.assertEqual(classify_line_pattern("1.1.1A Sous-disposition")["kind"], "alphanumeric")
        self.assertEqual(classify_line_pattern("2A.1B Variante")["token"], "2A.1B")

        self.assertEqual(classify_line_pattern("1. Ces directives")["kind"], "numeric")
        self.assertEqual(classify_line_pattern("115.1 L’adresse")["token"], "115.1")

        # Ne doit pas classer les numéros d'instruments, dates ISO, ordinaux, devises,
        # pourcentages, années nues, renvois de salle ni alphanumériques sans point comme sections
        self.assertEqual(classify_line_pattern("45-106 Règlement sur les dispenses")["kind"], "prose")
        self.assertEqual(classify_line_pattern("45 - 106 Règlement")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2026-02-23 date d'effet")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2026 est une année")["kind"], "prose")
        self.assertEqual(classify_line_pattern("1er janvier 2026")["kind"], "prose")
        self.assertEqual(classify_line_pattern("1 er janvier 2026")["kind"], "prose")
        self.assertEqual(classify_line_pattern("100 % des actions")["kind"], "prose")
        self.assertEqual(classify_line_pattern("12 $ par copie")["kind"], "prose")
        self.assertEqual(classify_line_pattern("100.00 $ de frais")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2A Champ sans point")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2.07 ou 2.12.")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2.16 ou 2.17 pour être déférée")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2.13 doit d’abord payer les frais")["kind"], "prose")
        self.assertEqual(classify_line_pattern("2.17.")["kind"], "prose")

        # Alphanumérique sans point mais avec délimiteur explicite (`.`, `)`, `:`) et majuscule après N.
        self.assertEqual(classify_line_pattern("2A. Champ avec point")["kind"], "alphanumeric")
        self.assertEqual(classify_line_pattern("2A) Sous-section")["token"], "2A")
        self.assertEqual(classify_line_pattern("2A: Titre")["token"], "2A")
        self.assertEqual(classify_line_pattern("14. Si le dossier est en état")["kind"], "numeric")

        # Historique vs abrogation (Modification/Abrogation : avant abrogation et numérique)
        self.assertEqual(classify_line_pattern("Modification : 1er janvier 2025")["kind"], "history")
        self.assertEqual(classify_line_pattern("Modifications : 1er février 2024; 23 février 2026")["kind"], "history")
        self.assertEqual(classify_line_pattern("Abrogation : 1er février 2024")["kind"], "history")
        self.assertEqual(classify_line_pattern("6. Abrogé.")["kind"], "repeal")
        self.assertEqual(classify_line_pattern("134. Abrogation.")["kind"], "repeal")
        self.assertEqual(classify_line_pattern("83.1 […]")["kind"], "repeal")
        self.assertEqual(classify_line_pattern("2A.1 Abrogé.")["kind"], "repeal")

        self.assertEqual(classify_line_pattern("a) première condition")["kind"], "subitem_alpha")
        self.assertEqual(classify_line_pattern("(1) sous-alinéa")["kind"], "subitem_num")
        self.assertEqual(classify_line_pattern("1° critère")["kind"], "subitem_num")
        self.assertEqual(classify_line_pattern("ii) mention")["kind"], "subitem_roman")
        self.assertEqual(classify_line_pattern("(2022) 154 G.O.Q. II")["kind"], "prose")
        self.assertEqual(classify_line_pattern("PARTIE II — CHAMBRE CIVILE")["kind"], "division")
        self.assertEqual(classify_line_pattern("ANNEXE A — Tarifs")["kind"], "division")
        self.assertEqual(classify_line_pattern("formulaire doit être rempli")["kind"], "prose")
        self.assertEqual(classify_line_pattern("Abrogé.")["kind"], "repeal")
        self.assertEqual(classify_line_pattern("À jour au 23 février 2026")["kind"], "consolidation_date")

    def test_reconstruct_lines_merges_superscript_within_y_tolerance(self):
        spans = [
            SpanRecord(1, 92.0, 100.0, 145.0, 112.0, "ArialMT", "ArialMT", 12.0, 0, "À jour au 1", "À jour au 1"),
            # Exposant décalé + espace géométrique de 1.6 pt : ne doit ni décaler anchor_y ni insérer d'espace avant `er`
            SpanRecord(1, 146.6, 98.2, 154.0, 105.0, "ArialMT", "ArialMT", 6.5, 1, "er", "er"),
            # Gap 1.0 pt après `er` : doit préserver l'espace devant `janvier`
            SpanRecord(1, 155.0, 100.0, 210.0, 112.0, "ArialMT", "ArialMT", 12.0, 0, "janvier 2026", "janvier 2026"),
            # Appel de note `(1)` 1.0 pt sous la ligne de base (2.8 pt sous l'exposant) : reste sur la même ligne
            SpanRecord(1, 213.0, 101.0, 224.0, 107.5, "ArialMT", "ArialMT", 6.5, 0, "(1)", "(1)"),
            SpanRecord(1, 92.0, 120.0, 102.0, 132.0, "ArialMT", "ArialMT", 12.0, 0, "1.", "1."),
            SpanRecord(1, 120.5, 120.0, 220.0, 132.0, "ArialMT", "ArialMT", 12.0, 0, "Premier alinéa", "Premier alinéa"),
        ]
        lines = reconstruct_lines(spans, y_tolerance=2.5)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0].norm_text, "À jour au 1er janvier 2026 (1)")
        self.assertEqual(lines[1].norm_text, "1. Premier alinéa")

    def test_cluster_x0_groups_within_tolerance(self):
        clusters = cluster_x0(
            [
                {"x0": 92.1, "font": "ArialMT", "size": 12.0, "text": "1. Un"},
                {"x0": 93.4, "font": "ArialMT", "size": 12.0, "text": "2. Deux"},
                {"x0": 120.5, "font": "ArialMT", "size": 12.0, "text": "suite"},
                {"x0": 148.9, "font": "ArialMT", "size": 12.0, "text": "a) sous"},
            ],
            tolerance=2.0,
        )
        self.assertEqual(len(clusters), 3)
        self.assertEqual(clusters[0]["count"], 2)
        self.assertEqual(clusters[1]["x0_median"], 120.5)
        self.assertEqual(clusters[2]["x0_median"], 148.9)

    def test_detect_y0_bands_multi_page_and_single_page(self):
        lines = [
            {"page": 1, "y0": 40.0, "y1": 52.0, "text": "Directives — Page 1"},
            {"page": 2, "y0": 40.0, "y1": 52.0, "text": "Directives — Page 2"},
            {"page": 3, "y0": 40.0, "y1": 52.0, "text": "Directives — Page 3"},
            {"page": 1, "y0": 740.0, "y1": 754.0, "text": "À jour au 23 février 2026"},
            {"page": 2, "y0": 740.0, "y1": 754.0, "text": "À jour au 23 février 2026"},
            {"page": 3, "y0": 740.0, "y1": 754.0, "text": "À jour au 23 février 2026"},
            {"page": 1, "y0": 200.0, "y1": 212.0, "text": "1. Corps"},
        ]
        res = detect_y0_bands(lines, page_count=3, page_heights=792.0)
        self.assertEqual(len(res["repeating_headers"]), 1)
        self.assertEqual(res["repeating_headers"][0]["pattern"], "Directives — Page <N>")
        self.assertEqual(len(res["repeating_footers"]), 1)
        self.assertEqual(res["repeating_footers"][0]["page_count"], 3)

        single = detect_y0_bands(
            [{"page": 1, "y0": 40.0, "y1": 52.0, "text": "En-tête unique"}],
            page_count=1,
            page_heights=792.0,
        )
        self.assertEqual(single["repeating_headers"], [])
        self.assertEqual(len(single["edge_candidates_top"]), 1)

    def test_report_formatters_emit_lf_utf8(self):
        doc = {
            "file": "exemple.pdf",
            "path": "exemple.pdf",
            "size_bytes": 123,
            "sha256": "a" * 64,
            "page_count": 1,
            "page_dimensions": {"612.0x792.0": 1},
            "metadata": {"title": "Test", "creator": "", "producer": "", "modDate": ""},
            "dominant_body_size_pt": 12.0,
            "total_spans": 1,
            "total_lines": 1,
            "total_non_ws_chars": 5,
            "total_images": 0,
            "image_only_pages": [2],
            "warnings": ["Numérisation partielle détectée : 1 page(s) image seulement ([2])."],
            "replacement_chars": 0,
            "unicode_zs": {},
            "span_accounting": {
                "total_spans": 1,
                "accounted_spans": 1,
                "unclassified_spans": 0,
                "buckets": {"body_text": 1, "unclassified": 0},
            },
            "toc": {"count": 0, "entries": []},
            "fonts": [],
            "x0_clusters": [],
            "y0_bands": {
                "threshold_pages": 2,
                "repeating_headers": [],
                "repeating_footers": [],
                "edge_candidates_top": [],
                "edge_candidates_bottom": [],
            },
            "links": {
                "total": 2,
                "by_kind": {"LINK_LAUNCH": 2},
                "items": [
                    {
                        "page": 1,
                        "kind": "LINK_LAUNCH",
                        "uri": None,
                        "target_page": None,
                        "file": "juge.cabinet.cs.mtl@judex.qc.ca",
                        "anchor_text": "courriel",
                    },
                    {
                        "page": 1,
                        "kind": "LINK_LAUNCH",
                        "uri": None,
                        "target_page": None,
                        "file": "",
                        "anchor_text": "",
                    },
                ],
            },
            "patterns": {"counts": {"prose": 1}, "samples": {"prose": [{"page": 1, "token": None, "line": "Texte"}]}},
            "consolidation_dates": [],
            "repeal_hits": [],
            "pages": [],
        }
        md = build_markdown_report([doc], [])
        js = build_json_report([doc], [])
        self.assertNotIn("\r\n", md)
        self.assertNotIn("\r\n", js)
        self.assertIn("juge.cabinet.cs.mtl@judex.qc.ca", md)
        self.assertIn("Numérisation partielle détectée", md)
        self.assertEqual(json.loads(js)["files_inspected"], 1)
        self.assertIsNone(normalize_target_page(-1))
        self.assertIsNone(normalize_target_page(None))
        self.assertEqual(normalize_target_page(0), 1)


@unittest.skipIf(pymupdf is None, "pymupdf absent dans cet environnement")
class TestReconPdfWithPyMuPdf(unittest.TestCase):
    def _build_rich_pdf(self, path: Path) -> None:
        doc = pymupdf.open()
        doc.set_metadata({"title": "Directives & IG — Test", "producer": "TestSuite"})

        # Page 1
        p1 = doc.new_page(width=612, height=792)
        p1.insert_text((54, 42), "Directives - Page 1", fontname="helv", fontsize=9, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((54, 100), "PARTIE I - DISPOSITIONS", fontname="hebo", fontsize=14, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((54, 130), "1. Premier\xa0paragraphe de l'instance.", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((72, 150), "a) sous-item indenté", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((54, 175), "2. Abrogé.", fontname="heit", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        # Exposant décalé verticalement dans la plage <= 2.5 pt
        p1.insert_text((54, 200), "À jour au 1", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((112, 198.2), "er", fontname="helv", fontsize=6.5, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((120, 200), "janvier 2026", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        # Espaces Unicode U+2009 et U+202F + apostrophe typographique via insert_htmlbox
        p1.insert_htmlbox(
            pymupdf.Rect(54, 220, 500, 250),
            "<p style='font-size:11pt'>2A.1\u2009Disposition\xa0alphanumérique\u202fspéciale — l’ordre.</p>",
        )
        link_rect = pymupdf.Rect(54, 270, 280, 290)
        p1.insert_text((54, 283), "Voir le Code de procédure civile", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_link(
            {"kind": pymupdf.LINK_URI, "from": link_rect, "uri": "https://www.legisquebec.gouv.qc.ca/fr/document/lc/c-25.01"}
        )
        goto_rect = pymupdf.Rect(54, 300, 200, 320)
        p1.insert_text((54, 313), "Aller à l'Annexe A", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p1.insert_text((54, 760), "À jour au 23 février 2026 - Page 1", fontname="helv", fontsize=9, encoding=pymupdf.TEXT_ENCODING_LATIN)

        # Page 2
        p2 = doc.new_page(width=612, height=792)
        p2.insert_text((54, 42), "Directives - Page 2", fontname="helv", fontsize=9, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p2.insert_text((54, 100), "ANNEXE A - MODÈLES", fontname="hebo", fontsize=13, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p2.insert_text((54, 130), "4B.2 Règle complémentaire (Règlement 45-106)", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p2.insert_text((54, 155), "1.1.1A Sous-règle", fontname="helv", fontsize=11, encoding=pymupdf.TEXT_ENCODING_LATIN)
        p2.insert_text((54, 760), "À jour au 23 février 2026 - Page 2", fontname="helv", fontsize=9, encoding=pymupdf.TEXT_ENCODING_LATIN)

        # Recharger doc[0] après création de p2 pour insérer LINK_GOTO vers page index 1
        doc[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": goto_rect, "page": 1, "to": pymupdf.Point(54, 100)})

        doc.set_toc([[1, "PARTIE I — DISPOSITIONS", 1], [1, "ANNEXE A — MODÈLES", 2]])
        doc.save(str(path))
        doc.close()

    def test_rich_pdf_inventory_and_cli_determinism(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "rich.pdf"
            self._build_rich_pdf(pdf_path)
            before_sha = hashlib.sha256(pdf_path.read_bytes()).hexdigest()

            res = recon_pdf.inspect_pdf(pdf_path)
            self.assertEqual(res["page_count"], 2)
            self.assertEqual(res["span_accounting"]["unclassified_spans"], 0)
            self.assertEqual(res["span_accounting"]["accounted_spans"], res["span_accounting"]["total_spans"])
            self.assertEqual(res["toc"]["count"], 2)
            self.assertGreaterEqual(len(res["y0_bands"]["repeating_headers"]), 1)
            self.assertGreaterEqual(len(res["y0_bands"]["repeating_footers"]), 1)
            self.assertGreaterEqual(len(res["x0_clusters"]), 2)
            self.assertEqual(res["links"]["by_kind"].get("LINK_URI"), 1)
            self.assertEqual(res["links"]["by_kind"].get("LINK_GOTO"), 1)
            self.assertIn("U+00A0", res["unicode_zs"])
            self.assertIn("U+2009", res["unicode_zs"])
            self.assertIn("U+202F", res["unicode_zs"])
            self.assertGreaterEqual(res["patterns"]["counts"].get("alphanumeric", 0), 3)
            self.assertGreaterEqual(res["patterns"]["counts"].get("subitem_alpha", 0), 1)
            self.assertGreaterEqual(len(res["repeal_hits"]), 1)
            self.assertGreaterEqual(len(res["consolidation_dates"]), 1)

            # Vérifie les sorties CLI JSON et Markdown + zéro mutation du PDF source
            md_out = tmp_dir / "out.md"
            json_out = tmp_dir / "out.json"
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc1 = recon_pdf.main([str(pdf_path), "--out", str(md_out), "--json-out", str(json_out)])
            self.assertEqual(rc1, 0)
            md1 = md_out.read_bytes()
            js1 = json_out.read_bytes()
            self.assertNotIn(b"\r\n", md1)
            self.assertNotIn(b"\r\n", js1)
            self.assertFalse(md1.startswith(b"\xef\xbb\xbf"))
            parsed = json.loads(js1.decode("utf-8"))
            self.assertEqual(parsed["files_inspected"], 1)
            self.assertEqual(hashlib.sha256(pdf_path.read_bytes()).hexdigest(), before_sha)

            # Second passage identique -> sortie octet pour octet déterministe
            with redirect_stdout(io.StringIO()):
                rc2 = recon_pdf.main([str(pdf_path), "--out", str(md_out), "--json-out", str(json_out)])
            self.assertEqual(rc2, 0)
            self.assertEqual(md_out.read_bytes(), md1)
            self.assertEqual(json_out.read_bytes(), js1)

    def test_scanned_image_only_pdf_refused_with_exit_2(self):
        png_bytes = _make_png_1x1()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            scan_pdf = tmp_dir / "scanned.pdf"
            doc = pymupdf.open()
            page = doc.new_page(width=612, height=792)
            page.insert_image(pymupdf.Rect(0, 0, 612, 792), stream=png_bytes)
            doc.save(str(scan_pdf))
            doc.close()

            with self.assertRaises(ScannedPdfError):
                recon_pdf.inspect_pdf(scan_pdf)

            # Variante avec artefact de 2 caractères sur page scannée
            art_pdf = tmp_dir / "scanned_artifact.pdf"
            doc2 = pymupdf.open()
            page2 = doc2.new_page(width=612, height=792)
            page2.insert_image(pymupdf.Rect(0, 0, 612, 792), stream=png_bytes)
            page2.insert_text((20, 20), "1", fontname="helv", fontsize=8)
            doc2.save(str(art_pdf))
            doc2.close()
            with self.assertRaises(ScannedPdfError):
                recon_pdf.inspect_pdf(art_pdf)

            out_md = tmp_dir / "refus.md"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                rc = recon_pdf.main([str(scan_pdf), "--out", str(out_md)])
            self.assertEqual(rc, 2)
            self.assertIn("ScannedPdfError", out_md.read_text(encoding="utf-8"))

    def test_corrupt_empty_encrypted_and_missing_pdf_refusals(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            empty_pdf = tmp_dir / "empty.pdf"
            empty_pdf.write_bytes(b"")
            with self.assertRaises(CorruptPdfError):
                recon_pdf.inspect_pdf(empty_pdf)

            corrupt_pdf = tmp_dir / "corrupt.pdf"
            corrupt_pdf.write_bytes(b"%PDF-1.7 not a valid stream")
            with self.assertRaises(CorruptPdfError):
                recon_pdf.inspect_pdf(corrupt_pdf)

            enc_pdf = tmp_dir / "encrypted.pdf"
            doc = pymupdf.open()
            p = doc.new_page()
            p.insert_text((72, 72), "Secret")
            doc.save(
                str(enc_pdf),
                encryption=pymupdf.PDF_ENCRYPT_AES_256,
                user_pw="userpw",
                owner_pw="ownerpw",
            )
            doc.close()
            with self.assertRaises(EncryptedPdfError):
                recon_pdf.inspect_pdf(enc_pdf)

            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(recon_pdf.main([str(enc_pdf), "--out", str(tmp_dir / "e.md")]), 2)
                self.assertEqual(recon_pdf.main([str(corrupt_pdf), "--out", str(tmp_dir / "c.md")]), 2)
                self.assertEqual(recon_pdf.main([str(tmp_dir / "absent.pdf")]), 1)

    def test_multipage_and_majority_scanned_refusals_vs_minority_warning(self):
        png_bytes = _make_png_1x1()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            # 10-page raster scan with "Page N" (51 non-ws chars >= 20, avg 5.1 < 10) -> must refuse!
            scan10 = tmp_dir / "scan10.pdf"
            doc10 = pymupdf.open()
            for idx in range(1, 11):
                pg = doc10.new_page(width=612, height=792)
                pg.insert_image(pymupdf.Rect(0, 0, 612, 792), stream=png_bytes)
                pg.insert_text((50, 760), f"Page {idx}", fontname="helv", fontsize=9)
            doc10.save(str(scan10))
            doc10.close()
            with self.assertRaises(ScannedPdfError):
                recon_pdf.inspect_pdf(scan10)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(recon_pdf.main([str(scan10), "--out", str(tmp_dir / "s10.md")]), 2)

            # Majority-scan partial PDF (1 rich text page + 2 image-only pages) -> must refuse!
            maj_pdf = tmp_dir / "majority_scan.pdf"
            doc_maj = pymupdf.open()
            p_txt = doc_maj.new_page(width=612, height=792)
            p_txt.insert_text((54, 100), "1. Texte riche suffisant pour dépasser la moyenne minimale de dix caractères.", fontname="helv", fontsize=11)
            for _ in range(2):
                p_img = doc_maj.new_page(width=612, height=792)
                p_img.insert_image(pymupdf.Rect(0, 0, 612, 792), stream=png_bytes)
            doc_maj.save(str(maj_pdf))
            doc_maj.close()
            with self.assertRaises(ScannedPdfError):
                recon_pdf.inspect_pdf(maj_pdf)

            # Minority-scan partial PDF (3 text pages + 1 image-only page) -> accepted with warning!
            min_pdf = tmp_dir / "minority_scan.pdf"
            doc_min = pymupdf.open()
            for idx in range(1, 4):
                pg = doc_min.new_page(width=612, height=792)
                pg.insert_text((54, 100), f"{idx}. Disposition authentique avec texte complet.", fontname="helv", fontsize=11)
            p_img = doc_min.new_page(width=612, height=792)
            p_img.insert_image(pymupdf.Rect(0, 0, 612, 792), stream=png_bytes)
            doc_min.save(str(min_pdf))
            doc_min.close()
            res_min = recon_pdf.inspect_pdf(min_pdf)
            self.assertEqual(res_min["image_only_pages"], [4])
            self.assertEqual(len(res_min["warnings"]), 1)
            md_min = recon_pdf.build_markdown_report([res_min], [])
            js_min = json.loads(recon_pdf.build_json_report([res_min], []))
            self.assertIn("Numérisation partielle", md_min)
            self.assertEqual(js_min["documents"][0]["image_only_pages"], [4])

    def test_rotated_90_page_bands_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            rot_pdf = Path(tmp) / "rotated90.pdf"
            doc = pymupdf.open()
            for idx in range(1, 5):
                pg = doc.new_page(width=612, height=792)
                pg.insert_text((50, 40), f"Directives - En-tête {idx}", fontname="helv", fontsize=9)
                pg.insert_text((50, 560), f"{idx}. Paragraphe de corps à y=560.", fontname="helv", fontsize=11)
                pg.insert_text((50, 760), f"Pied {idx}", fontname="helv", fontsize=9)
                if idx == 1:
                    pg.insert_link(
                        {
                            "kind": pymupdf.LINK_URI,
                            "from": pymupdf.Rect(50, 545, 250, 568),
                            "uri": "https://www.legisquebec.gouv.qc.ca/",
                        }
                    )
                pg.set_rotation(90)
            doc.save(str(rot_pdf))
            doc.close()

            res = recon_pdf.inspect_pdf(rot_pdf)
            buckets = res["span_accounting"]["buckets"]
            self.assertEqual(buckets["numbered_provision"], 4)
            self.assertEqual(buckets["running_header"], 4)
            self.assertEqual(buckets["running_footer"], 4)
            self.assertEqual(res["links"]["items"][0]["anchor_text"], "1. Paragraphe de corps à y=560.")

    def test_history_vs_repeal_buckets_and_link_launch_normalization(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "hist_repeal_links.pdf"
            doc = pymupdf.open()
            p1 = doc.new_page(width=612, height=792)
            p1.insert_text((92, 100), "6. Abrogé.", fontname="helv", fontsize=12)
            p1.insert_text((120, 120), "Abrogation : 1er février 2024", fontname="heit", fontsize=10)
            p1.insert_text((92, 150), "134. Abrogation.", fontname="helv", fontsize=12)
            p1.insert_htmlbox(
                pymupdf.Rect(92, 168, 300, 192),
                "<p style='font-size:12pt;margin:0'>83.1 […]</p>",
            )
            p1.insert_text((92, 200), "84. [...]", fontname="helv", fontsize=12)
            p1.insert_text((120, 220), "Modification : 1er janvier 2025", fontname="heit", fontsize=10)
            p1.insert_text((92, 250), "1. Disposition active.", fontname="helv", fontsize=12)
            p1.insert_link(
                {
                    "kind": pymupdf.LINK_URI,
                    "from": pymupdf.Rect(92, 238, 220, 255),
                    "uri": "https://placeholder.example.invalid/",
                }
            )
            raw_pdf = doc.tobytes()
            doc.close()
            doc2 = pymupdf.open(stream=raw_pdf, filetype="pdf")
            lnk_xref = doc2[0].get_links()[0]["xref"]
            doc2.xref_set_key(lnk_xref, "A", "<</S/URI/URI(juge.cabinet.cs.mtl@judex.qc.ca)>>")
            doc2.save(str(pdf_path))
            doc2.close()

            res = recon_pdf.inspect_pdf(pdf_path)
            buckets = res["span_accounting"]["buckets"]
            self.assertEqual(buckets["repeal_marker"], 4)
            self.assertEqual(buckets["history"], 2)
            self.assertEqual(buckets["numbered_provision"], 1)
            self.assertEqual(len(res["repeal_hits"]), 4)
            lnk = res["links"]["items"][0]
            self.assertEqual(lnk["kind"], "LINK_LAUNCH")
            self.assertEqual(lnk["file"], "juge.cabinet.cs.mtl@judex.qc.ca")
            self.assertIsNone(lnk["target_page"])
            md = recon_pdf.build_markdown_report([res], [])
            self.assertIn("juge.cabinet.cs.mtl@judex.qc.ca", md)
            self.assertNotIn("p.-1", md)


if __name__ == "__main__":
    unittest.main()
