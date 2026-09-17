"""Numérotage des annexes — `_disposition_number` (pipeline/parser.py).

POURQUOI CE FICHIER EXISTE. Le 2026-09-16, on a mesuré en PRODUCTION que les 24 annexes
françaises du Code municipal (c-27.1) portaient TOUTES le numéro `formulaire-ule` :
`get_article(law='c-27.1', article='formulaire-ule')` rendait la FORMULE 23 — une sur
24, arbitrairement, en silence, sous la citation inexistante « art. formulaire-ule ».

Le mécanisme, et c'est lui qu'on épingle ici : dans l'alternance des labels, `form`
s'accrochait comme PRÉFIXE du mot français « formule », puis la branche fourre-tout
`[a-z]+` avalait le RADICAL « ule » à la place du numéro, qui tombait hors du match.
Deux protections le referment — un `\\b` après le label, et les pluriels explicites — et
les deux se testent ici, parce qu'aucune ne se voit dans une sortie d'ingestion.

Le défaut était UNILATÉRAL : l'anglais « FORM 23 » rendait bien `formulaire-23`. C'est
donc aussi le pont FR/EN que `_DISP_CANON` existe pour garantir qui était cassé.
"""

import unittest

from pipeline.parser import _disposition_number


def num(h: str) -> str:
    return _disposition_number(h)[0]


class TestFormulesFrancaises(unittest.TestCase):
    """Le défaut d'origine : le radical mangé à la place du numéro."""

    def test_formule_garde_son_numero(self):
        self.assertEqual(num("FORMULE 1"), "formulaire-1")
        self.assertEqual(num("FORMULE 23"), "formulaire-23")
        self.assertEqual(num("FORMULE III"), "formulaire-iii")

    def test_numero_decimal_conserve(self):
        # c-27.1 porte une « FORMULE 4.1 » : le point devient un tiret, il ne se perd pas.
        self.assertEqual(num("FORMULE 4.1"), "formulaire-4-1")

    def test_vingt_quatre_formules_donnent_vingt_quatre_numeros(self):
        """LE contrôle de non-régression. Avant le correctif : 1 seule clé pour 24."""
        cles = {num(f"FORMULE {n}") for n in range(1, 25)}
        self.assertEqual(len(cles), 24, f"collision : {len(cles)} clés pour 24 annexes")
        self.assertNotIn("formulaire-ule", cles)

    def test_le_radical_n_est_jamais_un_numero(self):
        for h in ("FORMULE 1", "FORMULE 23", "FORMULES 1"):
            self.assertNotIn("ule", num(h), f"{h} : le radical a été pris pour un numéro")


class TestSymetrieInterLangues(unittest.TestCase):
    """`_DISP_CANON` existe pour que FR et EN partagent le numéro. Le pont doit tenir."""

    def test_form_et_formule_convergent(self):
        for n in ("1", "23", "iii"):
            self.assertEqual(num(f"FORMULE {n}"), num(f"FORM {n}"))

    def test_pluriels_convergent(self):
        # c-19 rendait `formules-1` en FR et `formulaire-s` en EN : deux clés, aucun pont.
        self.assertEqual(num("FORMULES 1"), num("FORMS 1"))
        self.assertEqual(num("FORMULES 1"), "formulaire-1")

    def test_schedule_reste_annexe(self):
        self.assertEqual(num("SCHEDULE I"), num("ANNEXE I"))
        self.assertEqual(num("SCHEDULE I"), "annexe-i")


class TestNonRegression(unittest.TestCase):
    """Ce qui marchait doit continuer de marcher, à l'identique."""

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
        # L'en-tête d36e peut porter un sous-titre après le repère : il ne rentre pas.
        self.assertEqual(num("ANNEXE I TARIF DES DROITS"), "annexe-i")

    def test_dispositions_finales(self):
        self.assertEqual(_disposition_number("DISPOSITIONS FINALES"), ("finales", "disposition"))

    def test_pluriel_ne_mange_plus_le_s(self):
        # « ANNEXES ABROGATIVES » rendait `annexe-s` : le `s` pris pour un numéro.
        self.assertEqual(num("ANNEXES ABROGATIVES"), "annexe-abrogatives")
        self.assertNotEqual(num("ANNEXES ABROGATIVES"), "annexe-s")

    def test_le_kind_reste_annexe(self):
        for h in ("FORMULE 1", "ANNEXE I", "SCHEDULE I", "FORMS 1"):
            self.assertEqual(_disposition_number(h)[1], "annexe", h)


class TestLimiteConnue(unittest.TestCase):
    """Ce que le correctif NE fait PAS — écrit pour que personne ne le croie réglé.

    Un intitulé sans numéro garde une clé tronquée, parce que la branche `[ivxlcdm\\d]`
    accepte les lettres romaines : « FORMULE DE RENONCIATION » rend `formulaire-d` (le
    « d » de « de »). Deux intitulés de ce genre dans une même loi collisionneraient
    encore. AUCUN des 676 intitulés d'annexe du corpus n'est dans ce cas (mesuré le
    2026-09-16) — c'est donc une limite théorique, et c'est la garde d'unicité de
    `validate.py` qui la rendra bruyante si elle se présente, PAS ce motif.
    """

    def test_intitule_sans_numero_reste_tronque(self):
        self.assertEqual(num("FORMULE DE RENONCIATION"), "formulaire-d")
        self.assertEqual(num("FORMULE DE CESSION"), "formulaire-d")


if __name__ == "__main__":
    unittest.main()
