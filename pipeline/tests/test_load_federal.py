from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import load
from pipeline.model import Law
from pipeline.parser_lims import parse_lims

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "lims"

def sql_de(lang: str, fixture: str) -> str:
    law = Law(id="ca-i-15", name_fr="Loi FR", name_en="Law EN", official_cite="L.R.C. (1985), ch. I-15")
    law.official_cite_en = "R.S.C. 1985, c. I-15"
    law.chapter, law.jurisdiction, law.unit, law.in_force = "I-15", "ca", "article", 1
    law.consol_date_fr = law.consol_date_en = "2025-07-24"
    divs, arts = parse_lims((FIXTURES / fixture).read_bytes(), law, lang)
    load.prepare(law, divs, arts, id_base=0)
    return load.to_sql(law, divs, arts, lang)

class TestColonnes(unittest.TestCase):
    def test_les_colonnes_de_0004_arrivent_en_base(self):
        for col in ("official_cite", "official_cite_en", "chapter", "jurisdiction",
                    "in_force", "last_amended", "unit", "source", "domain"):
            self.assertIn(col, load._LAW_COLS, f"laws.{col} n'arriverait pas en base")
        for col in ("marginal_note", "footnotes", "links"):
            self.assertIn(col, load._ART_COLS, f"articles.{col} n'arriverait pas en base")

    def test_official_cite_arrive_en_base(self):
        self.assertIn("official_cite", load._LAW_COLS)
        sql = sql_de("fr", "i-15-fr.xml")
        self.assertIn("L.R.C. (1985), ch. I-15", sql)

class TestInvariant3SurLaCitation(unittest.TestCase):

    def test_une_passe_fr_ne_touche_pas_la_citation_anglaise(self):
        maj = sql_de("fr", "i-15-fr.xml").split("ON CONFLICT(id) DO UPDATE SET")[1]
        self.assertNotIn("official_cite_en=excluded", maj,
                         "une passe FR remettrait official_cite_en à NULL")
        self.assertIn("official_cite=excluded", maj)

    def test_une_passe_en_ne_touche_pas_la_citation_francaise(self):
        maj = sql_de("en", "i-15-en.xml").split("ON CONFLICT(id) DO UPDATE SET")[1]
        self.assertNotIn("official_cite=excluded.official_cite,", maj + ",",
                         "une passe EN écraserait la citation FRANÇAISE")
        self.assertIn("official_cite_en=excluded", maj)

    def test_la_regle_est_exprimee_une_fois_pour_les_trois_paires(self):
        for lang, attendu in (("fr", {"name_en", "consol_date_en", "official_cite_en"}),
                              ("en", {"name_fr", "consol_date_fr", "official_cite"})):
            self.assertTrue(attendu <= load._COLS_AUTRE_LANGUE(lang),
                            f"{lang} : paires de langue incomplètes")

class TestArticleNumbers(unittest.TestCase):

    def test_les_alias_de_plage_sont_ecrits(self):
        sql = sql_de("fr", "i-15-fr.xml")
        self.assertIn("_stg_article_numbers", sql)
        self.assertIn("INSERT INTO article_numbers SELECT * FROM _stg_article_numbers;", sql)
        bloc = sql.split("INSERT INTO _stg_article_numbers")[1].split(";")[0]
        for n in ("'11'", "'12'", "'13'", "'14'"):
            self.assertIn(n, bloc)

    def test_la_purge_precede_la_suppression_des_articles(self):
        sql = sql_de("fr", "i-15-fr.xml")
        i_alias = sql.index("DELETE FROM article_numbers")
        i_art = sql.index("DELETE FROM articles ")
        self.assertLess(i_alias, i_art)

    def test_aucun_insert_or_ignore(self):
        self.assertNotIn("INSERT OR IGNORE", sql_de("fr", "i-15-fr.xml"))

class TestSortKeyPreposee(unittest.TestCase):
    def test_une_cle_preposee_a_zero_survit(self):
        from pipeline.model import Article
        a = Article(law_id="t", lang="fr", number="preambule", text="x",
                    division_path="fp:0", sort_key=0)
        law = Law(id="t", name_fr="T", name_en="T", official_cite="X")
        load.prepare(law, [], [a], id_base=0)
        self.assertEqual(a.sort_key, 0, "la clé pré-posée à 0 a été recalculée")

if __name__ == "__main__":
    unittest.main()
