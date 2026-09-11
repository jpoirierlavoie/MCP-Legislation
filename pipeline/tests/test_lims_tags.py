"""Garde du classement des balises LIMS — hors réseau, en CI.

`pipeline/expected/lims_tags.json` est la PORTE de la phase 0 : `parser_lims.py` doit
refuser un fichier portant une balise absente du classement, au lieu de la traverser en
silence. Ce test verrouille les propriétés du classement lui-même — pas le corpus, qui
exige le dépôt LIMS et n'est donc pas testable en CI.

Ce qu'il ne peut PAS faire : vérifier que le classement correspond aux fichiers réels. Cela
demande le clone (`pipeline.discovery.recon_lims`), donc du réseau. Le contrôle
correspondant est la porte de la phase 0, à rejouer à la main :
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_lims
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent.parent
CLASSEMENT = RACINE / "pipeline" / "expected" / "lims_tags.json"

# Les seuls traitements admis. Une valeur hors de cette liste serait une décision prise
# sans qu'aucun code ne sache l'appliquer.
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
        """Les trois chaînes ingérables, mesurées. Le §5 de docs/phase0-structure-lims.md.

        Si cette liste s'allonge, c'est que le balisage de Justice Canada a changé : arrêt
        pour revue humaine, pas élargissement au jugé.
        """
        self.assertEqual(
            self.doc["chaines_ingerables"],
            ["Statute < Body", "Regulation < Body", "Regulation < Schedule < RegulationPiece"],
        )

    def test_les_familles_de_refus_ne_sont_pas_ingerables(self):
        """Aucune chaîne blanche ne traverse un conteneur de droit non en vigueur."""
        for interdit in ("BillPiece", "RelatedOrNotInForce", "AmendedText"):
            for chaine in self.doc["chaines_ingerables"]:
                self.assertNotIn(interdit, chaine,
                                 f"{interdit} apparaît dans une chaîne déclarée ingérable")

    def test_definition_est_du_texte(self):
        """Le piège du §7.1, épinglé.

        Le SPEC §3.5 ne nomme pas `Definition`. Mesuré sur l'art. 2 de la L.F.I. : 51 blocs,
        13 736 caractères ; les traiter autrement que comme du texte rendrait 59 caractères
        et une phrase plausible — 99,6 % de l'article perdu, en silence.
        """
        for nom in ("Definition", "DefinitionEnOnly", "DefinitionFrOnly"):
            self.assertEqual(self.balises[nom]["traitement"], "texte",
                             f"{nom} doit être du texte : voir §7.1")

    def test_continued_subparagraph_classee(self):
        """Le SPEC oublie ce membre de la famille `Continued*` ; le classement ne l'oublie pas."""
        self.assertEqual(self.balises["ContinuedSubparagraph"]["traitement"], "texte")

    def test_read_as_text_ingere_malgre_sa_ressemblance_avec_amended_text(self):
        """7 occurrences de texte CITÉ dans une disposition EN VIGUEUR.

        `AmendedText` est refusé, `ReadAsText` ne l'est pas : classer par tag plutôt que par
        chaîne d'ancêtres creuserait 7 trous au milieu d'articles applicables.
        """
        self.assertEqual(self.balises["ReadAsText"]["traitement"], "texte")

    def test_marqueur_bilingue_reel(self):
        """`BilingualGroup`, pas `spanlanguages` — §7.6.

        La prémisse du SPEC est mesurée fausse : les 88 annexes `spanlanguages` du fichier
        FRANÇAIS de DORS/98-106 comptent 4 738 mots-outils français contre 1 anglais.
        """
        self.assertEqual(self.balises["BilingualGroup"]["traitement"], "hors_texte")
        self.assertIn("spanlanguages", self.balises["BilingualGroup"]["note"])

    def test_ordre_qui_edicte_nest_pas_le_texte_edicte(self):
        self.assertEqual(self.balises["Order"]["traitement"], "hors_texte")
        self.assertIn("justification_juridique", self.balises["Order"])

    def test_titres_sont_des_metadonnees_et_les_deux_sont_classees(self):
        """Un règlement n'a pas de `ShortTitle` : la dérivation du titre dépend de la racine."""
        self.assertEqual(self.balises["ShortTitle"]["traitement"], "metadonnee")
        self.assertEqual(self.balises["LongTitle"]["traitement"], "metadonnee")

    def test_le_classement_est_marque_comme_proposition(self):
        """« L'IA rédige, l'avocat valide » : le fichier doit le DIRE, pas le supposer."""
        self.assertIn("PROPOSITION", self.doc["_comment"])
        self.assertIn("⛔", self.doc["_comment"])

    def test_ref_consignee(self):
        """Un classement sans SHA n'est pas reproductible."""
        self.assertRegex(self.doc["ref"], r"^[0-9a-f]{40}$")
        self.assertEqual(self.doc["fichiers_releves"], 36)

    def test_tout_traitement_est_documente(self):
        """Chaque valeur employée doit avoir sa définition dans `_traitements`."""
        employes = {v["traitement"] for v in self.balises.values()}
        for t in employes:
            self.assertIn(t, self.doc["_traitements"], f"traitement {t!r} employé mais non défini")


if __name__ == "__main__":
    unittest.main()
