from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from pipeline import load, validate
from pipeline.model import Law
from pipeline.parser import parse_epub

_CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPF/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

def _build_epub(tmpdir: Path, name: str, pages: dict[str, str], lang: str = "fr") -> Path:
    epub_path = tmpdir / name
    manifest_items = "\n".join(
        f'<item id="p{i}" href="{fname}" media-type="application/xhtml+xml"/>'
        for i, fname in enumerate(pages)
    )
    spine_items = "\n".join(f'<itemref idref="p{i}"/>' for i in range(len(pages)))
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
        f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title>'
        f'<dc:language>{lang}</dc:language></metadata>'
        f'<manifest>{manifest_items}</manifest>'
        f'<spine>{spine_items}</spine>'
        "</package>"
    )
    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr("META-INF/container.xml", _CONTAINER_XML)
        zf.writestr("OPF/content.opf", opf)
        for fname, body in pages.items():
            xhtml = (
                '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                f"{body}"
                "</body></html>"
            )
            zf.writestr(f"OPF/{fname}", xhtml)
    return epub_path

def _art_html(num: int) -> str:
    return (
        f'<div id="se:{num}">'
        f'<div id="se:{num}-ss:1"><span>{num}.</span> <span>Texte article {num}.</span></div>'
        f'<div><div class="ligne"></div><span>D. 297-2010, a. {num}.</span></div>'
        "</div>"
    )

def _div_open(eid: str, label_word: str, ordinal: str, heading: str) -> str:
    return (
        f'<div id="{eid}">'
        f'<div id="{eid}-h1"><div><span>{label_word} </span>{ordinal}</div>'
        f'<div id="{eid}-h1-t1-nb:1">{heading}</div></div>'
    )

class TestDuplicateDivisions(unittest.TestCase):
    def test_c_73_2_r_6_twin_chapter_ii(self):
        pages = {
            "page2.xhtml": (
                _div_open("ga:l_i", "CHAPITRE", "I", "SYNDIC")
                + "".join(_art_html(n) for n in range(1, 6))
                + "</div>"
            ),
            "page3.xhtml": (
                _div_open("ga:l_ii", "CHAPITRE", "II", "COMITÉ DE RÉVISION DES DÉCISIONS DU SYNDIC")
                + _div_open("ga:l_ii-gb:l_i", "SECTION", "I", "COMPOSITION")
                + _art_html(6)
                + _art_html(7)
                + "</div></div>"
            ),
            "page4.xhtml": (
                _div_open("ga:l_ii", "CHAPITRE", "II", "RÈGLES DE FONCTIONNEMENT")
                + "".join(_art_html(n) for n in range(8, 14))
                + "</div>"
            ),
            "page5.xhtml": (
                _div_open("ga:l_iii", "CHAPITRE", "III", "COMITÉ DE DISCIPLINE")
                + _art_html(14)
                + "</div>"
            ),
        }
        with tempfile.TemporaryDirectory() as tmp:
            ep = _build_epub(Path(tmp), "c-73.2-r.6-fr.epub", pages, lang="fr")
            law = Law(
                id="c-73.2-r.6",
                name_fr="Règlement OACIQ",
                name_en="OACIQ Regulation",
                official_cite="RLRQ, c. C-73.2, r. 6",
            )
            divs, arts = parse_epub(ep, law, "fr")
            load.prepare(law, divs, arts, id_base=1000)
            rep = validate.validate("c-73.2-r.6", "fr", divs, arts)

        self.assertTrue(rep.ok, "\n".join(rep.lines))
        by_path = {d.path: d for d in divs}
        by_num = {a.number: a for a in arts}

        self.assertIn("ga:l_ii", by_path)
        self.assertIn("ga:l_ii__2", by_path)
        self.assertEqual(by_path["ga:l_ii"].heading, "COMITÉ DE RÉVISION DES DÉCISIONS DU SYNDIC")
        self.assertIsNone(by_path["ga:l_ii"].parent_id)
        self.assertEqual(by_path["ga:l_ii__2"].heading, "RÈGLES DE FONCTIONNEMENT")
        self.assertIsNone(by_path["ga:l_ii__2"].parent_id)

        sec_i = by_path["ga:l_ii-gb:l_i"]
        self.assertEqual(sec_i.parent_id, by_path["ga:l_ii"].id)
        self.assertNotEqual(sec_i.parent_id, by_path["ga:l_ii__2"].id)

        for n in ("6", "7"):
            self.assertEqual(by_num[n].division_path, "ga:l_ii-gb:l_i")
            self.assertEqual(by_num[n].division_id, sec_i.id)
        for n in ("8", "9", "10", "11", "12", "13"):
            self.assertEqual(by_num[n].division_path, "ga:l_ii__2")
            self.assertEqual(by_num[n].division_id, by_path["ga:l_ii__2"].id)

    def test_nested_subtree_under_disambiguated_parent(self):
        pages = {
            "page1.xhtml": (
                _div_open("ga:l_ii", "CHAPITRE", "II", "PREMIER")
                + _div_open("ga:l_ii-gb:l_i", "SECTION", "I", "SOUS PREMIER")
                + _art_html(1)
                + "</div></div>"
            ),
            "page2.xhtml": (
                _div_open("ga:l_ii", "CHAPITRE", "II", "SECOND")
                + _div_open("ga:l_ii-gb:l_i", "SECTION", "I", "SOUS SECOND")
                + _div_open("ga:l_ii-gb:l_i-gc:l_premier", "SOUS-SECTION", "I", "FEUILLE SECOND")
                + _art_html(2)
                + "</div></div></div>"
            ),
        }
        with tempfile.TemporaryDirectory() as tmp:
            ep = _build_epub(Path(tmp), "nested.epub", pages, lang="fr")
            law = Law(id="test-nested", name_fr="Test", name_en="Test", official_cite="RLRQ, c. T-1")
            divs, arts = parse_epub(ep, law, "fr")
            load.prepare(law, divs, arts)
            rep = validate.validate("test-nested", "fr", divs, arts)

        self.assertTrue(rep.ok, "\n".join(rep.lines))
        by_path = {d.path: d for d in divs}
        by_num = {a.number: a for a in arts}

        self.assertIn("ga:l_ii__2-gb:l_i", by_path)
        self.assertIn("ga:l_ii__2-gb:l_i-gc:l_premier", by_path)
        self.assertEqual(by_path["ga:l_ii__2-gb:l_i"].parent_path, "ga:l_ii__2")
        self.assertEqual(by_path["ga:l_ii__2-gb:l_i"].parent_id, by_path["ga:l_ii__2"].id)
        self.assertEqual(
            by_path["ga:l_ii__2-gb:l_i-gc:l_premier"].parent_path,
            "ga:l_ii__2-gb:l_i",
        )
        self.assertEqual(
            by_path["ga:l_ii__2-gb:l_i-gc:l_premier"].parent_id,
            by_path["ga:l_ii__2-gb:l_i"].id,
        )
        self.assertEqual(by_num["1"].division_path, "ga:l_ii-gb:l_i")
        self.assertEqual(by_num["2"].division_path, "ga:l_ii__2-gb:l_i-gc:l_premier")

    def test_triple_collision_and_preexisting_suffix_skip(self):
        pages_triple = {
            "page1.xhtml": _div_open("ga:l_ii", "CHAPITRE", "II", "UN") + _art_html(1) + "</div>",
            "page2.xhtml": _div_open("ga:l_ii", "CHAPITRE", "II", "DEUX") + _art_html(2) + "</div>",
            "page3.xhtml": _div_open("ga:l_ii", "CHAPITRE", "II", "TROIS") + _art_html(3) + "</div>",
        }
        pages_preexisting = {
            "page1.xhtml": _div_open("ga:l_ii", "CHAPITRE", "II", "UN") + _art_html(1) + "</div>",
            "page2.xhtml": _div_open("ga:l_ii__2", "CHAPITRE", "II", "PREEXISTANT") + _art_html(2) + "</div>",
            "page3.xhtml": _div_open("ga:l_ii", "CHAPITRE", "II", "COLLISION") + _art_html(3) + "</div>",
        }
        with tempfile.TemporaryDirectory() as tmp:
            ep1 = _build_epub(Path(tmp), "triple.epub", pages_triple, lang="fr")
            law1 = Law(id="test-triple", name_fr="Test", name_en="Test", official_cite="RLRQ, c. T-2")
            d1, a1 = parse_epub(ep1, law1, "fr")
            load.prepare(law1, d1, a1)
            r1 = validate.validate("test-triple", "fr", d1, a1)

            ep2 = _build_epub(Path(tmp), "preexisting.epub", pages_preexisting, lang="fr")
            law2 = Law(id="test-pre", name_fr="Test", name_en="Test", official_cite="RLRQ, c. T-3")
            d2, a2 = parse_epub(ep2, law2, "fr")
            load.prepare(law2, d2, a2)
            r2 = validate.validate("test-pre", "fr", d2, a2)

        self.assertTrue(r1.ok, "\n".join(r1.lines))
        self.assertEqual([d.path for d in d1], ["ga:l_ii", "ga:l_ii__2", "ga:l_ii__3"])

        self.assertTrue(r2.ok, "\n".join(r2.lines))
        self.assertEqual([d.path for d in d2], ["ga:l_ii", "ga:l_ii__2", "ga:l_ii__3"])
        self.assertEqual(d2[1].heading, "PREEXISTANT")
        self.assertEqual(d2[2].heading, "COLLISION")

if __name__ == "__main__":
    unittest.main()
