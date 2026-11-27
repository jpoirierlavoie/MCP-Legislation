from __future__ import annotations

import json
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent.parent
CLASSEMENT = RACINE / "pipeline" / "expected" / "lims_tags.json"

TRAITEMENTS = {"texte", "structure", "division", "metadonnee", "hors_texte", "refuse", "ignore"}

class TestClassementLims(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(CLASSEMENT.read_text(encoding="utf-8"))
        cls.balises = cls.doc["balises"]

    def test_traitement_connu_et_decompte_present(self):
        for nom, v in self.balises.items():
            self.assertIn(v["traitement"], TRAITEMENTS,
                          f"{nom} : traitement inconnu {v['traitement']!r}")
            self.assertIsInstance(v.get("occurrences"), int,
                                  f"{nom} : décompte d'occurrences manquant ou non entier")
            self.assertGreater(v["occurrences"], 0, f"{nom} : décompte nul")

    def test_liste_blanche_de_chaines_close(self):
        self.assertEqual(
            self.doc["chaines_ingerables"],
            ["Statute < Body", "Regulation < Body", "Regulation < Schedule < RegulationPiece"],
        )

    def test_les_familles_de_refus_ne_sont_pas_ingerables(self):
        for interdit in ("BillPiece", "RelatedOrNotInForce", "AmendedText"):
            for chaine in self.doc["chaines_ingerables"]:
                self.assertNotIn(interdit, chaine,
                                 f"{interdit} apparaît dans une chaîne déclarée ingérable")

    def test_definition_est_du_texte(self):
        for nom in ("Definition", "DefinitionEnOnly", "DefinitionFrOnly"):
            self.assertEqual(self.balises[nom]["traitement"], "texte",
                             f"{nom} doit être du texte : voir §7.1")

    def test_continued_subparagraph_classee(self):
        self.assertEqual(self.balises["ContinuedSubparagraph"]["traitement"], "texte")

    def test_read_as_text_ingere_malgre_sa_ressemblance_avec_amended_text(self):
        self.assertEqual(self.balises["ReadAsText"]["traitement"], "texte")

    def test_marqueur_bilingue_reel(self):
        self.assertEqual(self.balises["BilingualGroup"]["traitement"], "hors_texte")
        self.assertIn("spanlanguages", self.balises["BilingualGroup"]["note"])

    def test_ordre_qui_edicte_nest_pas_le_texte_edicte(self):
        self.assertEqual(self.balises["Order"]["traitement"], "hors_texte")
        self.assertIn("justification_juridique", self.balises["Order"])

    def test_titres_sont_des_metadonnees_et_les_deux_sont_classees(self):
        self.assertEqual(self.balises["ShortTitle"]["traitement"], "metadonnee")
        self.assertEqual(self.balises["LongTitle"]["traitement"], "metadonnee")

    def test_le_classement_est_marque_comme_proposition(self):
        self.assertIn("PROPOSITION", self.doc["_comment"])
        self.assertIn("⛔", self.doc["_comment"])

    def test_ref_consignee(self):
        self.assertRegex(self.doc["ref"], r"^[0-9a-f]{40}$")
        self.assertEqual(self.doc["fichiers_releves"], 50)

    def test_tout_traitement_est_documente(self):
        employes = {v["traitement"] for v in self.balises.values()}
        for t in employes:
            self.assertIn(t, self.doc["_traitements"], f"traitement {t!r} employé mais non défini")

if __name__ == "__main__":
    unittest.main()
