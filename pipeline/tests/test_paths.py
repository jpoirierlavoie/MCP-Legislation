from __future__ import annotations

import unittest

from pipeline.paths import depth, is_federal, parent_path, segments, truncate

TABLE = [
    ("fh1:3", 1),
    ("fh1:3-fh2:5", 2),
    ("fh1:3-fh2:5-fh3:1", 3),
    ("fh1:3-fh2:5-fh3:1-fh4:2", 4),
    ("fs:2", 1),
    ("fs:2-fh1:1", 2),
    ("fs:12-fh1:3-fh2:1", 3),
    ("ga:l_cinquieme", 1),
    ("ga:l_cinquieme-gb:l_premier", 2),
    ("ga:l_cinquieme-gb:l_premier-gc:l_troisieme-gd:l_i-ge:l_1", 5),
    ("gc:l_dix-septieme", 1),
    ("ga:l_x-gc:l_dix-septieme", 2),
    ("ga:l_ii__2", 1),
    ("ga:l_ii__2-gb:l_i", 2),
    ("disposition-preliminaire", 1),
    ("annexe-a", 1),
    ("repeal-schedules", 1),
    ("annexe-abrogative", 1),
    ("ph1:1", 1),
    ("ph1:1-ph2:1-ph3:1", 3),
    ("ps:1", 1),
    ("ps:1-ph1:1", 2),
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
        self.assertEqual(truncate("ga:l_ii__2-gb:l_i", 1), "ga:l_ii__2")
        self.assertEqual(truncate("annexe-a", 1), "annexe-a")
        self.assertEqual(truncate("repeal-schedules", 1), "repeal-schedules")
        self.assertEqual(truncate("gc:l_dix-septieme", 1), "gc:l_dix-septieme")

    def test_parent_path(self):
        self.assertEqual(parent_path("fh1:3-fh2:5"), "fh1:3")
        self.assertEqual(parent_path("fh1:3-fh2:5-fh3:1"), "fh1:3-fh2:5")
        self.assertEqual(parent_path("fs:2-fh1:1"), "fs:2")
        self.assertIsNone(parent_path("fh1:3"))
        self.assertIsNone(parent_path("fs:2"))
        self.assertIsNone(parent_path("ga:l_cinquieme"))
        self.assertIsNone(parent_path("ga:l_ii__2"))
        self.assertEqual(parent_path("ga:l_ii__2-gb:l_i"), "ga:l_ii__2")
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
        self.assertEqual(depth("xx:1-yy:2"), 1)
        self.assertEqual(depth("fh1:3-zz:4"), 1)

    def test_segments_est_l_inverse_de_la_jointure(self):
        for chemin, _ in TABLE:
            with self.subTest(chemin=chemin):
                self.assertEqual("-".join(segments(chemin)), chemin)

    def test_le_parseur_epub_garde_son_propre_decoupeur(self):
        from pipeline import parser
        self.assertTrue(hasattr(parser, "_SEG_SPLIT"))
        self.assertIn("ga|", parser._SEG_SPLIT.pattern)

if __name__ == "__main__":
    unittest.main()
