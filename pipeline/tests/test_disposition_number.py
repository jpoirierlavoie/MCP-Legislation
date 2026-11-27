import unittest

from pipeline.parser import _disposition_number

def num(h: str) -> str:
    return _disposition_number(h)[0]

class TestFormulesFrancaises(unittest.TestCase):

    def test_formule_garde_son_numero(self):
        self.assertEqual(num("FORMULE 1"), "formulaire-1")
        self.assertEqual(num("FORMULE 23"), "formulaire-23")
        self.assertEqual(num("FORMULE III"), "formulaire-iii")

    def test_numero_decimal_conserve(self):
        self.assertEqual(num("FORMULE 4.1"), "formulaire-4-1")

    def test_vingt_quatre_formules_donnent_vingt_quatre_numeros(self):
        cles = {num(f"FORMULE {n}") for n in range(1, 25)}
        self.assertEqual(len(cles), 24, f"collision : {len(cles)} clés pour 24 annexes")
        self.assertNotIn("formulaire-ule", cles)

    def test_le_radical_n_est_jamais_un_numero(self):
        for h in ("FORMULE 1", "FORMULE 23", "FORMULES 1"):
            self.assertNotIn("ule", num(h), f"{h} : le radical a été pris pour un numéro")

class TestSymetrieInterLangues(unittest.TestCase):

    def test_form_et_formule_convergent(self):
        for n in ("1", "23", "iii"):
            self.assertEqual(num(f"FORMULE {n}"), num(f"FORM {n}"))

    def test_pluriels_convergent(self):
        self.assertEqual(num("FORMULES 1"), num("FORMS 1"))
        self.assertEqual(num("FORMULES 1"), "formulaire-1")

    def test_schedule_reste_annexe(self):
        self.assertEqual(num("SCHEDULE I"), num("ANNEXE I"))
        self.assertEqual(num("SCHEDULE I"), "annexe-i")

class TestNonRegression(unittest.TestCase):

    def test_formes_deja_correctes(self):
        for h, attendu in [
            ("ANNEXE I", "annexe-i"),
            ("ANNEXE 1", "annexe-1"),
            ("ANNEXE ABROGATIVE", "annexe-abrogative"),
            ("FORMULAIRE VI", "formulaire-vi"),
            ("FORM III", "formulaire-iii"),
        ]:
            self.assertEqual(num(h), attendu, h)

    def test_sous_titre_ecarte(self):
        self.assertEqual(num("ANNEXE I TARIF DES DROITS"), "annexe-i")

    def test_dispositions_finales(self):
        self.assertEqual(_disposition_number("DISPOSITIONS FINALES"), ("finales", "disposition"))

    def test_pluriel_ne_mange_plus_le_s(self):
        self.assertEqual(num("ANNEXES ABROGATIVES"), "annexe-abrogatives")
        self.assertNotEqual(num("ANNEXES ABROGATIVES"), "annexe-s")

    def test_le_kind_reste_annexe(self):
        for h in ("FORMULE 1", "ANNEXE I", "SCHEDULE I", "FORMS 1"):
            self.assertEqual(_disposition_number(h)[1], "annexe", h)

class TestLimiteConnue(unittest.TestCase):

    def test_intitule_sans_numero_reste_tronque(self):
        self.assertEqual(num("FORMULE DE RENONCIATION"), "formulaire-d")
        self.assertEqual(num("FORMULE DE CESSION"), "formulaire-d")

if __name__ == "__main__":
    unittest.main()
