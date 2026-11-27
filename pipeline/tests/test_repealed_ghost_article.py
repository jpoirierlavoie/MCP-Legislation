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

def _build_epub(tmpdir: Path, name: str, body: str, lang: str = "en") -> Path:
    epub_path = tmpdir / name
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
        f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title>'
        f"<dc:language>{lang}</dc:language></metadata>"
        '<manifest><item id="p1" href="page1.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="p1"/></spine>'
        "</package>"
    )
    xhtml = f'<html xmlns="http://www.w3.org/1999/xhtml"><body>{body}</body></html>'
    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr("META-INF/container.xml", _CONTAINER_XML)
        zf.writestr("OPF/content.opf", opf)
        zf.writestr("OPF/page1.xhtml", xhtml)
    return epub_path

def _art_block(eid: str, label: str, text: str) -> str:
    return (
        f'<div id="{eid}">'
        f'<div id="{eid}-ss:1"><span>{label}.</span> <span>{text}</span></div>'
        f'<div><div class="ligne"></div><span>2017, c. 4, s. 1.</span></div>'
        "</div>"
    )

def _run_parse(body: str):
    div_start = (
        '<div id="ga:l_i">'
        '<div id="ga:l_i-h1"><div>CHAPTER I</div><div id="ga:l_i-h1-t1-nb:1">GENERAL</div></div>'
    )
    with tempfile.TemporaryDirectory() as tmp:
        ep = _build_epub(Path(tmp), "q-2-en.epub", div_start + body + "</div>")
        law = Law(id="q-2", name_fr="Q-2", name_en="Q-2", official_cite="RLRQ, c. Q-2")
        divs, arts = parse_epub(ep, law, "en")
        load.prepare(law, divs, arts, id_base=1000)
        rep = validate.validate("q-2", "en", divs, arts)
        return divs, arts, rep

class TestRepealedGhostArticle(unittest.TestCase):
    def test_drops_repealed_ghost_when_active_counterpart_exists(self):
        for body in (
            _art_block("se:1", "1", "Active one.")
            + _art_block("se:2", "2", "Active two.")
            + _art_block("se:2", "2", "(Repealed)."),
            _art_block("se:1", "1", "Active one.")
            + _art_block("se:2", "2", "(Repealed).")
            + _art_block("se:2", "2", "Active two."),
        ):
            _, arts, rep = _run_parse(body)
            self.assertTrue(rep.ok, "\n".join(rep.lines))
            self.assertEqual([(a.number, a.repealed, a.text) for a in arts], [
                ("1", 0, "Active one."),
                ("2", 0, "Active two."),
            ])

    def test_keeps_duplicate_when_both_are_active_and_fails_validate(self):
        body = (
            _art_block("se:1", "1", "Active one.")
            + _art_block("se:1_1", "1.1", "First 1.1.")
            + _art_block("se:1_1", "1.1", "Second 1.1.")
        )
        _, arts, rep = _run_parse(body)
        self.assertEqual(len(arts), 3)
        self.assertFalse(rep.ok)
        self.assertIn("1.1 ×2", "\n".join(rep.lines))

    def test_keeps_duplicate_when_both_are_repealed_stubs_and_fails_validate(self):
        body = (
            _art_block("se:1", "1", "Active one.")
            + _art_block("se:1_1", "1.1", "(Repealed).")
            + _art_block("se:1_1", "1.1", "(Repealed).")
        )
        _, arts, rep = _run_parse(body)
        self.assertEqual(len(arts), 3)
        self.assertFalse(rep.ok)
        self.assertIn("1.1 ×2", "\n".join(rep.lines))

    def test_keeps_duplicate_when_repealed_entry_carries_extra_text(self):
        body = (
            _art_block("se:1", "1", "Active one.")
            + _art_block("se:1_1", "1.1", "Active 1.1.")
            + _art_block("se:1_1", "1.1", "(Repealed) — substantive transitional note.")
        )
        _, arts, rep = _run_parse(body)
        self.assertEqual(len(arts), 3)
        self.assertFalse(rep.ok)

if __name__ == "__main__":
    unittest.main()
