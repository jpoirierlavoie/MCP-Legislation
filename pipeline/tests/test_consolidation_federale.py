from __future__ import annotations

import unittest

from pipeline.ingest import extrait_consolidation_federale as extrait

LOI_FR = (
    "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21; "
    "<a href='#hist'>derni&egrave;re modification</a> 2026-06-20 "
    "<a href='PITIndex.html'>Versions antérieures</a></p></div>"
)
LOI_EN = (
    "<div class='info'><p id='assentedDate'>Act current to 2026-07-21 and "
    "<a href='#hist'>last amended</a> on 2026-06-20. "
    "<a href='PITIndex.html'>Previous Versions</a></p></div>"
)
REGLEMENT_FR = (
    "<div class='info'><p id='assentedDate'>Règlement à jour 2026-07-21; "
    "<a href='#hist'>derni&egrave;re modification</a> 2025-12-21 "
    "<a href='PITIndex.html'>Versions antérieures</a></p></div>"
)

class TestExtractionFederale(unittest.TestCase):
    def test_les_trois_libelles_reels_rendent_la_date_a_jour(self):
        for nom, html in (("loi FR (entité &agrave;)", LOI_FR),
                          ("acte EN", LOI_EN),
                          ("règlement FR (à littéral)", REGLEMENT_FR)):
            with self.subTest(nom):
                self.assertEqual(extrait(html), "2026-07-21")

    def test_la_date_de_derniere_modification_n_est_jamais_rendue(self):
        for html, modif in ((LOI_FR, "2026-06-20"), (LOI_EN, "2026-06-20"),
                            (REGLEMENT_FR, "2025-12-21")):
            self.assertNotEqual(extrait(html), modif)

    def test_l_ordre_des_deux_dates_ne_decide_rien(self):
        inverse = (
            "<p id='assentedDate'><a href='#hist'>derni&egrave;re modification</a> "
            "2026-06-20 — Loi &agrave; jour 2026-07-21;</p>"
        )
        self.assertEqual(extrait(inverse), "2026-07-21")

    def test_une_date_hors_du_bloc_est_ignoree(self):
        html = ("<p class='hist'>à jour 1999-01-01</p>"
                "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p></div>"
                "<p class='note'>à jour 2030-12-31</p>")
        self.assertEqual(extrait(html), "2026-07-21")

    def test_bloc_absent_rend_None_et_non_une_date_devinee(self):
        self.assertIsNone(extrait("<html><body><p>Loi à jour 2026-07-21;</p></body></html>"))

    def test_bloc_present_mais_phrase_introuvable_rend_None(self):
        self.assertIsNone(extrait("<p id='assentedDate'>Consolidé le 2026-07-21.</p>"))

    def test_la_sortie_est_une_date_iso_sans_table_de_mois(self):
        self.assertIsNone(extrait("<p id='assentedDate'>Loi à jour 21 juillet 2026;</p>"))

if __name__ == "__main__":
    unittest.main()
