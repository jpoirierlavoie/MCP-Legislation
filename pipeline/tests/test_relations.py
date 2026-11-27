from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pipeline import config
from pipeline.discovery import relations as R

class TestChapitre(unittest.TestCase):
    def test_forme_federale_nest_pas_reniflee_par_la_regex_rlrq(self):
        for cite in ("L.R.C. (1985), ch. B-3", "L.C. 2000, ch. 5",
                     "C.R.C., ch. 368", "DORS/98-106",
                     "L.R.C. (1985), ch. 3 (2e suppl.)"):
            self.assertIsNone(R._chapter(cite), cite)

    def test_le_chapitre_declare_a_priorite_sur_le_reniflage(self):
        loi = {"id": "ca-b-3", "jurisdiction": "ca", "chapter": "B-3",
               "official_cite": "L.R.C. (1985), ch. B-3", "fonction": "loi"}
        self.assertEqual(R.chapitre_de(loi), "B-3")
        self.assertEqual(R.chapitre_de(loi, root=True), "B-3")

    def test_le_quebec_continue_de_passer_par_la_citation(self):
        loi = {"id": "ccq-r.8", "official_cite": "RLRQ, c. CCQ, r. 8", "fonction": "reglement"}
        self.assertEqual(R.chapitre_de(loi), "CCQ, r. 8")
        self.assertEqual(R.chapitre_de(loi, root=True), "CCQ")
        self.assertEqual(R.cle_de(loi, root=True), ("qc", "ccq-1991"))

    def test_aucune_entree_du_corpus_na_de_chapitre_vide(self):
        vides = [l["id"] for l in config.load_all_laws()
                 if not R._key(R.chapitre_de(l))]
        self.assertEqual(vides, [], f"chapitre irrésolu : {vides}")

class TestClesNommeesParJuridiction(unittest.TestCase):
    def test_la_juridiction_fait_partie_de_la_cle(self):
        qc = {"id": "x", "official_cite": "RLRQ, c. C-44", "fonction": "loi"}
        ca = {"id": "ca-c-44", "jurisdiction": "ca", "chapter": "C-44",
              "official_cite": "L.R.C. (1985), ch. C-44", "fonction": "loi"}
        self.assertEqual(R.cle_de(qc), ("qc", "c-44"))
        self.assertEqual(R.cle_de(ca), ("ca", "c-44"))
        self.assertNotEqual(R.cle_de(qc), R.cle_de(ca))

    def test_un_chapitre_homonyme_ne_collisionne_plus(self):
        laws = [
            {"id": "qc-c-44", "official_cite": "RLRQ, c. C-44", "fonction": "loi"},
            {"id": "ca-c-44", "jurisdiction": "ca", "chapter": "C-44",
             "official_cite": "L.R.C. (1985), ch. C-44", "fonction": "loi"},
        ]
        carte = R._carte(laws, root=False, seulement_lois=False)
        self.assertEqual(len(carte), 2)
        self.assertEqual(carte[("qc", "c-44")], "qc-c-44")
        self.assertEqual(carte[("ca", "c-44")], "ca-c-44")

    def test_une_vraie_collision_ARRETE(self):
        laws = [
            {"id": "a", "official_cite": "RLRQ, c. C-44", "fonction": "loi"},
            {"id": "b", "official_cite": "RLRQ, c. C-44", "fonction": "loi"},
        ]
        with self.assertRaises(R.CleEnCollision) as ctx:
            R._carte(laws, root=False, seulement_lois=False)
        self.assertIn("revendique", str(ctx.exception))

    def test_un_chapitre_irresolu_ARRETE(self):
        laws = [{"id": "ca-x", "jurisdiction": "ca", "official_cite": "L.R.C. (1985), ch. X-1",
                 "fonction": "loi"}]
        with self.assertRaises(R.CleEnCollision) as ctx:
            R._carte(laws, root=False, seulement_lois=False)
        self.assertIn("AUCUN chapitre", str(ctx.exception))

    def test_le_corpus_reel_ne_porte_aucune_collision(self):
        laws = config.load_all_laws()
        carte = R._carte(laws, root=False, seulement_lois=False)
        self.assertEqual(len(carte), len(laws), "une clé de chapitre est revendiquée deux fois")
        qc = {k[1] for k in carte if k[0] == "qc"}
        ca = {k[1] for k in carte if k[0] == "ca"}
        recouvrement = sorted(qc & ca)
        self.assertEqual(
            recouvrement, [],
            "chapitres homonymes entre les deux ordres : inoffensifs grâce à la clé nommée, "
            f"mais à connaître — {recouvrement}",
        )

class TestClassementDesTextesSubordonnes(unittest.TestCase):
    def test_federal_classe_par_fonction_et_non_par_la_citation(self):
        for cite, fonction, attendu in (
            ("DORS/98-106", "regles-procedure", True),
            ("C.R.C., ch. 368", "regles-procedure", True),
            ("L.R.C. (1985), ch. B-3", "loi", False),
        ):
            law = {"id": "x", "jurisdiction": "ca", "chapter": "z",
                   "official_cite": cite, "fonction": fonction}
            self.assertEqual(R._is_regulation(law), attendu, cite)

    def test_quebec_garde_la_marque_de_citation(self):
        for cite, attendu in (
            ("RLRQ, c. CCQ, r. 8", True),
            ("RLRQ, c. C-25.01, r. 0.2.4", True),
            ("RLRQ, c. CCQ-1991", False),
            ("RLRQ, c. C-25.01", False),
        ):
            self.assertEqual(R._is_regulation({"id": "x", "official_cite": cite}), attendu, cite)

    def test_les_trois_reglements_federaux_sont_bien_classes_subordonnes(self):
        subordonnes = [l["id"] for l in config.load_all_laws()
                       if (l.get("jurisdiction") == "ca") and R._is_regulation(l)]
        self.assertEqual(sorted(subordonnes), ["ca-crc-368", "ca-dors-2002-156", "ca-dors-98-106"])

    def test_les_22_lois_federales_sont_des_lois_habilitantes_candidates(self):
        by_root = R._carte(config.load_all_laws(), root=True, seulement_lois=True)
        federales = [v for k, v in by_root.items() if k[0] == "ca"]
        self.assertEqual(len(federales), 22)

class _FausseBase:

    name = "faux"

    def __init__(self):
        self.appels: list[str] = []

    def run(self, sql: str):
        self.appels.append(sql)
        raise AssertionError(
            "build() a ecrit en base alors que le corpus d'EPUB est incomplet : " + sql[:120]
        )

class TestPorteDuCorpusEpub(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._ancien = config.SAMPLES_DIR
        config.SAMPLES_DIR = Path(self._tmp.name)

    def tearDown(self):
        config.SAMPLES_DIR = self._ancien
        self._tmp.cleanup()

    def test_la_premisse_du_corpus_vide_tient(self):
        manquants = R.epubs_manquants(config.load_all_laws())
        qc_epub = [
            l for l in config.load_all_laws()
            if (l.get("jurisdiction") or "qc") == "qc" and (l.get("source") or "epub") == "epub"
        ]
        self.assertEqual(len(manquants), len(qc_epub),
                         "le répertoire d'EPUB doit être vu comme VIDE pendant ces contrôles")

    def test_arret_avant_toute_ecriture_quand_des_epub_manquent(self):
        db = _FausseBase()
        with self.assertRaises(R.CorpusEpubIncomplet) as ctx:
            R.build(db)
        self.assertEqual(db.appels, [], "la porte doit precer TOUTE ecriture, DELETE compris")
        msg = str(ctx.exception)
        self.assertIn("DELETE", msg, "le message doit dire POURQUOI c'est dangereux")
        self.assertIn("--accepter-corpus-partiel", msg, "il doit nommer la sortie explicite")

    def test_le_message_nomme_les_textes_manquants(self):
        db = _FausseBase()
        with self.assertRaises(R.CorpusEpubIncomplet) as ctx:
            R.build(db)
        manquants = R.epubs_manquants(config.load_all_laws())
        self.assertTrue(manquants, "ce test suppose un corpus d'EPUB incomplet en local")
        self.assertIn(manquants[0], str(ctx.exception))

    def test_la_porte_ne_compte_que_les_textes_quebecois_epub(self):
        manquants = R.epubs_manquants(config.load_all_laws())
        non_epub = {
            l["id"] for l in config.load_all_laws()
            if l.get("jurisdiction") == "ca" or l.get("source") == "pdf"
        }
        self.assertEqual(set(manquants) & non_epub, set())

    def test_pdf_cle_neutre_et_non_reglement(self):
        pdf_law = {
            "id": "qccs-dist-mtl", "source": "pdf", "jurisdiction": "qc",
            "official_cite": "Directives C.S. (District de Montréal)", "fonction": "directive",
        }
        self.assertEqual(R.chapitre_de(pdf_law), "qccs-dist-mtl")
        self.assertEqual(R.cle_de(pdf_law), ("pdf", "qccs-dist-mtl"))
        self.assertFalse(R._is_regulation(pdf_law))
        carte = R._carte([pdf_law], root=True, seulement_lois=True)
        self.assertEqual(carte, {})

    def test_pdf_reglement_amf_resout_v_1_1_et_reglement_de(self):
        v11 = {"id": "v-1.1", "source": "epub", "jurisdiction": "qc",
               "official_cite": "RLRQ, c. V-1.1", "fonction": "loi"}
        reg = {"id": "v-1.1-r.21", "source": "pdf", "jurisdiction": "qc",
               "official_cite": "RLRQ, c. V-1.1, r. 21", "fonction": "reglement"}
        ig = {"id": "amf-ig-45-106", "source": "pdf", "jurisdiction": "qc",
              "official_cite": "Instruction générale 45-106", "fonction": "orientation"}
        self.assertEqual(R.chapitre_de(reg, root=False), "V-1.1, r. 21")
        self.assertEqual(R.chapitre_de(reg, root=True), "V-1.1")
        self.assertEqual(R.cle_de(reg, root=True), ("qc", "v-1.1"))
        self.assertTrue(R._is_regulation(reg))
        self.assertFalse(R._is_regulation(ig))
        self.assertEqual(R.cle_de(ig), ("pdf", "amf-ig-45-106"))
        by_root = R._carte([v11, reg, ig], root=True, seulement_lois=True)
        self.assertEqual(by_root, {("qc", "v-1.1"): "v-1.1"})

    def test_le_drapeau_explicite_laisse_passer(self):
        db = _FausseBase()
        with self.assertRaises(AssertionError) as ctx:
            R.build(db, accepter_corpus_partiel=True)
        self.assertIn("DELETE FROM law_relations", str(ctx.exception))

class TestMoissonBorneeAuQuebec(unittest.TestCase):
    def test_la_moisson_de_renvois_est_bornee_par_juridiction_dans_la_source(self):
        src = (config.ROOT / "pipeline" / "discovery" / "relations.py").read_text("utf-8") \
            if hasattr(config, "ROOT") else None
        if src is None:
            src = Path(R.__file__).read_text("utf-8")
        i = src.index('if (l.get("jurisdiction") or "qc") != "qc"')
        j = src.index("if only_laws is None:")
        bloc = src[i:j]
        self.assertIn('jurisdiction") or "qc") != "qc"', bloc,
                      "la moisson doit écarter explicitement les textes non québécois")
        self.assertIn('("qc", _key(chapter))', bloc,
                      "un renvoi RLRQ ne doit se résoudre que contre la juridiction 'qc'")

if __name__ == "__main__":
    unittest.main()
