"""Garde du découpage des chemins, côté Python — miroir de tests/paths.test.mjs.

`pipeline/paths.py` et `src/paths.ts` découpent la MÊME colonne, `divisions.path`. Une
divergence entre eux est du même ordre que la divergence `sort_key` ↔ `sortKeyOf` de
l'invariant 2, qui avait silencieusement vidé le mode plage de 36 lois sur 38.

La comparaison littérale des deux regex est faite côté Node (tests/paths.test.mjs, « SEG_SPLIT
est identique en TypeScript et en Python »), parce que c'est là qu'on peut reconstruire la
regex JS. Ici on vérifie le COMPORTEMENT de l'implémentation Python, sur la même table de
cas — ce qui attrape une divergence même si les deux littéraux se ressemblent.
"""
from __future__ import annotations

import unittest

from pipeline.paths import depth, is_federal, parent_path, segments, truncate

# Même table que tests/paths.test.mjs. Toute divergence de décompte entre les deux fichiers
# est une divergence de miroir, à traiter comme telle.
TABLE = [
    # fédéral : corps
    ("fh1:3", 1),
    ("fh1:3-fh2:5", 2),
    ("fh1:3-fh2:5-fh3:1", 3),
    ("fh1:3-fh2:5-fh3:1-fh4:2", 4),
    # fédéral : annexe, et hiérarchie DANS une annexe
    ("fs:2", 1),
    ("fs:2-fh1:1", 2),
    ("fs:12-fh1:3-fh2:1", 3),
    # Québec : Irosoft
    ("ga:l_cinquieme", 1),
    ("ga:l_cinquieme-gb:l_premier", 2),
    ("ga:l_cinquieme-gb:l_premier-gc:l_troisieme-gd:l_i-ge:l_1", 5),
    # Québec : un trait d'union DANS la valeur d'un segment
    ("gc:l_dix-septieme", 1),
    ("ga:l_x-gc:l_dix-septieme", 2),
    # Québec : pseudo-divisions en slug, 118 mesurées en production
    ("disposition-preliminaire", 1),
    ("annexe-a", 1),
    ("repeal-schedules", 1),
    ("annexe-abrogative", 1),
]


class TestDecoupage(unittest.TestCase):
    def test_decompte_de_segments(self):
        for chemin, n in TABLE:
            with self.subTest(chemin=chemin):
                self.assertEqual(depth(chemin), n)

    def test_troncature_rend_un_prefixe_valide(self):
        self.assertEqual(truncate("fh1:3-fh2:5", 1), "fh1:3")
        self.assertEqual(truncate("fh1:3-fh2:5-fh3:1", 2), "fh1:3-fh2:5")
        self.assertEqual(truncate("fs:2-fh1:1", 1), "fs:2")
        self.assertEqual(truncate("ga:l_x-gc:l_dix-septieme", 1), "ga:l_x")
        # Les défauts mesurés de l'ancien découpage par tiret : il rendait `annexe` — un
        # chemin qui EXISTE, donc une AUTRE division — et `repeal`, qui n'existe pas.
        self.assertEqual(truncate("annexe-a", 1), "annexe-a")
        self.assertEqual(truncate("repeal-schedules", 1), "repeal-schedules")
        self.assertEqual(truncate("gc:l_dix-septieme", 1), "gc:l_dix-septieme")

    def test_parent_path(self):
        """`load.prepare` résout ce chemin en `parent_id`.

        Un `None` rendu à tort produit un arbre PLAT, sans erreur : `get_structure`
        annoncerait une loi sans hiérarchie.
        """
        self.assertEqual(parent_path("fh1:3-fh2:5"), "fh1:3")
        self.assertEqual(parent_path("fh1:3-fh2:5-fh3:1"), "fh1:3-fh2:5")
        self.assertEqual(parent_path("fs:2-fh1:1"), "fs:2")
        self.assertIsNone(parent_path("fh1:3"))
        self.assertIsNone(parent_path("fs:2"))
        self.assertIsNone(parent_path("ga:l_cinquieme"))
        # Les deux pièges : un slug et une valeur à trait d'union n'ont PAS de parent.
        self.assertIsNone(parent_path("annexe-a"))
        self.assertIsNone(parent_path("disposition-preliminaire"))
        self.assertIsNone(parent_path("gc:l_dix-septieme"))

    def test_is_federal(self):
        for p in ("fh1:3", "fh1:3-fh2:5", "fs:2", "fs:2-fh1:1", "fp:0"):
            with self.subTest(p=p):
                self.assertTrue(is_federal(p))
        for p in ("ga:l_cinquieme", "gc:l_dix-septieme", "annexe-a",
                  "disposition-preliminaire", "repeal-schedules"):
            with self.subTest(p=p):
                self.assertFalse(is_federal(p))

    def test_un_prefixe_inconnu_n_ouvre_pas_un_segment(self):
        """C'est ce qui protège les slugs : élargir l'énumération rouvre le défaut."""
        self.assertEqual(depth("xx:1-yy:2"), 1)
        self.assertEqual(depth("fh1:3-zz:4"), 1)

    def test_segments_est_l_inverse_de_la_jointure(self):
        for chemin, _ in TABLE:
            with self.subTest(chemin=chemin):
                self.assertEqual("-".join(segments(chemin)), chemin)

    def test_le_parseur_epub_garde_son_propre_decoupeur(self):
        """Le SPEC §3.1 interdit de toucher à `pipeline/parser.py`.

        Sa regex `_SEG_SPLIT` énumère `ga|…|gi` et reste en place. L'unification serait
        neutre côté Irosoft (la nouvelle est un sur-ensemble), mais on ne la fait pas :
        hors portée de ce chantier.
        """
        from pipeline import parser
        self.assertTrue(hasattr(parser, "_SEG_SPLIT"))
        self.assertIn("ga|", parser._SEG_SPLIT.pattern)


if __name__ == "__main__":
    unittest.main()
