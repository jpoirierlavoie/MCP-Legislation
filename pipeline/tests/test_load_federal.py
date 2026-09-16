"""Gardes du chargement fédéral — hors réseau, sur le SQL GÉNÉRÉ (aucune base requise).

`pipeline/load.py` ne parle pas à D1 : il produit du SQL. On peut donc vérifier ses
propriétés en lisant sa sortie, ce qui rend ces contrôles utilisables en CI.

Les deux défauts épinglés ici ont tous deux été trouvés en chargeant réellement I-15 dans
les DEUX langues sur une base locale — pas à la relecture.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import load
from pipeline.model import Law
from pipeline.parser_lims import parse_lims

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "lims"


def sql_de(lang: str, fixture: str) -> str:
    law = Law(id="ca-i-15", name_fr="Loi FR", name_en="Law EN", rlrq_cite="L.R.C. (1985), ch. I-15")
    law.official_cite_en = "R.S.C. 1985, c. I-15"
    law.chapter, law.jurisdiction, law.unit, law.in_force = "I-15", "ca", "article", 1
    law.consol_date_fr = law.consol_date_en = "2025-07-24"
    divs, arts = parse_lims((FIXTURES / fixture).read_bytes(), law, lang)
    load.prepare(law, divs, arts, id_base=0)
    return load.to_sql(law, divs, arts, lang)


class TestColonnes(unittest.TestCase):
    def test_les_colonnes_de_0004_arrivent_en_base(self):
        """Une colonne absente de `_LAW_COLS`/`_ART_COLS` n'arrive JAMAIS en base, en silence.

        Et comme les colonnes de 0004 portent des DEFAULT (`jurisdiction='qc'`,
        `in_force=1`, `unit='article'`), l'omission chargerait les 18 textes fédéraux COMME
        QUÉBÉCOIS : `legislation_list_laws(jurisdiction='ca')` rendrait zéro résultat.
        """
        for col in ("official_cite", "official_cite_en", "chapter", "jurisdiction",
                    "in_force", "last_amended", "unit"):
            self.assertIn(col, load._LAW_COLS, f"laws.{col} n'arriverait pas en base")
        for col in ("marginal_note", "footnotes"):
            self.assertIn(col, load._ART_COLS, f"articles.{col} n'arriverait pas en base")

    def test_le_pont_champ_colonne_existe(self):
        """`Law.rlrq_cite` alimente la colonne `official_cite` : le pont est en UN endroit."""
        self.assertEqual(load._CHAMP.get("official_cite"), "rlrq_cite")
        sql = sql_de("fr", "i-15-fr.xml")
        self.assertIn("L.R.C. (1985), ch. I-15", sql)


class TestInvariant3SurLaCitation(unittest.TestCase):
    """RÉGRESSION mesurée le 2026-09-11 : l'invariant 3, sur une colonne neuve.

    L'UPSERT de `laws` exclut `name_<autre>` et `consol_date_<autre>` pour qu'un chargement
    monolingue n'écrase pas l'autre langue. Mais la CITATION est aussi une paire de
    langues — `official_cite` / `official_cite_en` — et elle ne porte PAS le suffixe
    `_fr`/`_en`, donc la règle générale ne la voyait pas. Constaté en base : la passe EN
    écrasait `official_cite` (la forme française).
    """

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
    """L'audit avait trouvé que la table n'avait AUCUN producteur."""

    def test_les_alias_de_plage_sont_ecrits(self):
        sql = sql_de("fr", "i-15-fr.xml")
        self.assertIn("_stg_article_numbers", sql)
        self.assertIn("INSERT INTO article_numbers SELECT * FROM _stg_article_numbers;", sql)
        # I-15 porte « 11 à 14 » : quatre alias vers le MÊME article.
        bloc = sql.split("INSERT INTO _stg_article_numbers")[1].split(";")[0]
        for n in ("'11'", "'12'", "'13'", "'14'"):
            self.assertIn(n, bloc)

    def test_la_purge_precede_la_suppression_des_articles(self):
        """`article_numbers.article_id` pointe `articles.id`.

        Purger les alias APRÈS les articles laisserait, le temps d'une instruction, des
        lignes désignant un article supprimé. Et sans purge du tout, une réingestion
        rendrait le MAUVAIS article en silence.
        """
        sql = sql_de("fr", "i-15-fr.xml")
        i_alias = sql.index("DELETE FROM article_numbers")
        i_art = sql.index("DELETE FROM articles ")
        self.assertLess(i_alias, i_art)

    def test_aucun_insert_or_ignore(self):
        """Un conflit d'alias est un ÉCHEC d'ingestion, pas un choix au hasard."""
        self.assertNotIn("INSERT OR IGNORE", sql_de("fr", "i-15-fr.xml"))


class TestSortKeyPreposee(unittest.TestCase):
    def test_une_cle_preposee_a_zero_survit(self):
        """`load.prepare` testait `a.sort_key or sort_key(...)` : 0 était jeté.

        Or 0 est la clé du préambule, qui doit PRÉCÉDER l'article 1.
        """
        from pipeline.model import Article
        a = Article(law_id="t", lang="fr", number="preambule", text="x",
                    division_path="fp:0", sort_key=0)
        law = Law(id="t", name_fr="T", name_en="T", rlrq_cite="X")
        load.prepare(law, [], [a], id_base=0)
        self.assertEqual(a.sort_key, 0, "la clé pré-posée à 0 a été recalculée")


if __name__ == "__main__":
    unittest.main()
