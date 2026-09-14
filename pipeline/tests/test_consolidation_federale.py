"""`extrait_consolidation_federale` — la moitié Python du miroir. Hors réseau, en CI.

Pourquoi ce fichier existe. Depuis le 2026-09-14, `laws.consol_date_*` des 18 textes
fédéraux vient de la PAGE de Justice Canada et non plus de `lims:current-date` : la date
du XML sous-déclarait la fraîcheur de près d'un an (la *Loi sur le droit d'auteur* était
annoncée à jour au 2025-07-24 quand le site la donne à jour au 2026-07-21), et surtout
elle n'était pas celle que la veille compare — ce qui aurait rendu les 36 contrôles
fédéraux faux à perpétuité.

Cet extracteur peut donc désormais REFUSER une ingestion, et il est la moitié d'un miroir :
`extractConsolidationFederale` (`scripts/check-consolidation.mjs`) doit rendre exactement
la même valeur sur le même HTML. Le couple QUÉBÉCOIS n'a de test que du côté JS —
`fetch_consolidation` n'en a aucun ; on ne reproduit pas ce trou.

Les trois fragments ci-dessous sont RELEVÉS sur les pages réelles le 2026-09-14, entités
HTML comprises : c'est le point du témoin. Le « à » arrive en entité sur les pages de lois
et en littéral sur celles de règlements, et un extracteur qui ne tiendrait que l'une des
deux formes passerait la moitié du corpus sans rien dire.
"""
from __future__ import annotations

import unittest

from pipeline.ingest import extrait_consolidation_federale as extrait

# Relevés le 2026-09-14. Chacun porte DEUX dates : « à jour » puis « dernière
# modification ». C'est l'enjeu du test — un extracteur qui prendrait la première date
# venue tomberait juste par ordre d'apparition, pas par lecture.
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
        """Le vrai risque : rendre 2026-06-20 (dernière modification) pour 2026-07-21.

        Les deux dates vivent dans le MÊME bloc, donc borner la portée ne suffit pas —
        c'est l'ancrage sur la phrase (« jour » / « current to ») qui les distingue.
        """
        for html, modif in ((LOI_FR, "2026-06-20"), (LOI_EN, "2026-06-20"),
                            (REGLEMENT_FR, "2025-12-21")):
            self.assertNotEqual(extrait(html), modif)

    def test_l_ordre_des_deux_dates_ne_decide_rien(self):
        """Témoin direct : on INVERSE l'ordre d'apparition, la réponse ne bouge pas.

        Sans cette assertion, les trois témoins ci-dessus passeraient aussi avec un
        extracteur naïf qui prend la première date du bloc.
        """
        inverse = (
            "<p id='assentedDate'><a href='#hist'>derni&egrave;re modification</a> "
            "2026-06-20 — Loi &agrave; jour 2026-07-21;</p>"
        )
        self.assertEqual(extrait(inverse), "2026-07-21")

    def test_une_date_hors_du_bloc_est_ignoree(self):
        """La portée est bornée : une page porte d'autres dates (historique, notes).

        Les lire serait un faux SERVI — on annoncerait une fraîcheur qui n'est pas celle
        que le publieur affirme.
        """
        html = ("<p class='hist'>à jour 1999-01-01</p>"
                "<div class='info'><p id='assentedDate'>Loi &agrave; jour 2026-07-21;</p></div>"
                "<p class='note'>à jour 2030-12-31</p>")
        self.assertEqual(extrait(html), "2026-07-21")

    def test_bloc_absent_rend_None_et_non_une_date_devinee(self):
        """`None` signifie « le miroir a peut-être cassé », pas « la page est à jour ».

        Côté ingestion, ce `None` est FATAL (`DateDeConsolidationIntrouvable`) ; côté
        veille, il devient `illisible`, donc actionnable. Dans les deux cas il parle.
        """
        self.assertIsNone(extrait("<html><body><p>Loi à jour 2026-07-21;</p></body></html>"))

    def test_bloc_present_mais_phrase_introuvable_rend_None(self):
        """Justice Canada a changé le libellé : on refuse, on ne devine pas."""
        self.assertIsNone(extrait("<p id='assentedDate'>Consolidé le 2026-07-21.</p>"))

    def test_la_sortie_est_une_date_iso_sans_table_de_mois(self):
        """Contraste voulu avec le couple québécois, qui doit traduire « 21 juillet 2026 ».

        Épinglé parce que c'est ce qui autorise le miroir JS à se passer de `FR_MONTHS` :
        si Justice Canada passait un jour au format littéral, ce test rougirait et
        rappellerait que les DEUX moitiés du miroir sont à reprendre.
        """
        self.assertIsNone(extrait("<p id='assentedDate'>Loi à jour 21 juillet 2026;</p>"))


if __name__ == "__main__":
    unittest.main()
