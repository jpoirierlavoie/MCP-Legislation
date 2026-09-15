"""Résolution des chapitres dans `discovery/relations.py` — hors réseau, en CI.

POURQUOI CES TESTS EXISTENT. Mesuré le 2026-09-11, après l'entrée des 18 textes fédéraux
dans `laws.config.json` : `_chapter` reniflait `official_cite` avec une regex `c\\.` SENSIBLE
À LA CASSE, or la forme fédérale s'écrit « L.R.C. (1985), ch. B-3 ». Elle rendait donc `None`
pour les **18** textes, tous réduits à la même clé de chapitre VIDE — en collision les uns
avec les autres, le dernier de la configuration l'emportant en silence.

Et la collision la plus dangereuse n'est pas celle-là : le RLRQ et les L.R.C. emploient le
MÊME schéma lettre-chiffre. Zéro recouvrement au 2026-09-11 (Québec `b-1`, `c-26`, `c-38` ;
fédéral `b-3`, `c-34`, `c-44`), mais par hasard. Un seul ajout qui se recouvre, et un renvoi
québécois se résoudrait vers une loi FÉDÉRALE — en gagnant, l'invariant 1 imposant d'ajouter
en FIN de `laws.config.json`. D'où la clé (juridiction, chapitre).

Aucun appel réseau : ces tests lisent `laws.config.json` sur disque.
"""
from __future__ import annotations

import pathlib
import tempfile
import unittest

from pipeline import config
from pipeline.discovery import relations as R


class TestChapitre(unittest.TestCase):
    def test_forme_federale_nest_pas_reniflee_par_la_regex_rlrq(self):
        """La regex RLRQ ne doit PAS prétendre lire une citation fédérale.

        C'est le défaut d'origine, épinglé dans le sens où il s'est produit : rendre `None`
        est le comportement CORRECT de `_chapter` sur du fédéral — le tort était de s'en
        servir comme d'une clé.
        """
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
        """Aucune entrée québécoise ne déclare `chapter` : le reniflage reste leur chemin."""
        loi = {"id": "ccq-r.8", "official_cite": "RLRQ, c. CCQ, r. 8", "fonction": "reglement"}
        self.assertEqual(R.chapitre_de(loi), "CCQ, r. 8")
        self.assertEqual(R.chapitre_de(loi, root=True), "CCQ")
        # et l'alias du Code civil survit (ccq-r.8 aurait sinon AUCUN parent, en silence)
        self.assertEqual(R.cle_de(loi, root=True), ("qc", "ccq-1991"))

    def test_aucune_entree_du_corpus_na_de_chapitre_vide(self):
        """Une clé vide collisionne avec toutes les autres clés vides — c'était le défaut."""
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
        """Le scénario redouté : RLRQ c. C-44 et L.R.C. ch. C-44 coexistent sans s'écraser.

        Sans la juridiction dans la clé, la carte n'aurait qu'UNE entrée et le texte
        fédéral l'emporterait (il est en fin de configuration, invariant 1).
        """
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
        """Deux textes d'une même juridiction sur un même chapitre : ARRÊT, pas « le dernier ».

        « Le dernier gagne » résoudrait un renvoi vers le mauvais texte, en silence.
        """
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
        # Et le recouvrement Québec <-> fédéral est nul AUJOURD'HUI. Ce test n'interdit pas
        # qu'il apparaisse — il le RAPPORTE, parce que la clé nommée le rend inoffensif.
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
        """« DORS/98-106 » et « C.R.C., ch. 368 » ne portent aucune marque « , r. »."""
        for cite, fonction, attendu in (
            ("DORS/98-106", "regles-procedure", True),
            ("C.R.C., ch. 368", "regles-procedure", True),
            ("L.R.C. (1985), ch. B-3", "loi", False),
        ):
            law = {"id": "x", "jurisdiction": "ca", "chapter": "z",
                   "official_cite": cite, "fonction": fonction}
            self.assertEqual(R._is_regulation(law), attendu, cite)

    def test_quebec_garde_la_marque_de_citation(self):
        """Inchangé À DESSEIN : « , r. » couvre règlements, règles de procédure ET tarifs."""
        for cite, attendu in (
            ("RLRQ, c. CCQ, r. 8", True),
            ("RLRQ, c. C-25.01, r. 0.2.4", True),
            ("RLRQ, c. CCQ-1991", False),
            ("RLRQ, c. C-25.01", False),
        ):
            self.assertEqual(R._is_regulation({"id": "x", "official_cite": cite}), attendu, cite)

    def test_les_deux_reglements_federaux_sont_bien_classes_subordonnes(self):
        subordonnes = [l["id"] for l in config.load_all_laws()
                       if (l.get("jurisdiction") == "ca") and R._is_regulation(l)]
        self.assertEqual(sorted(subordonnes), ["ca-crc-368", "ca-dors-98-106"])

    def test_les_16_lois_federales_sont_des_lois_habilitantes_candidates(self):
        by_root = R._carte(config.load_all_laws(), root=True, seulement_lois=True)
        federales = [v for k, v in by_root.items() if k[0] == "ca"]
        self.assertEqual(len(federales), 16)


class _FausseBase:
    """Base qui REFUSE toute écriture : le test échoue si `build` atteint son DELETE."""

    name = "faux"

    def __init__(self):
        self.appels: list[str] = []

    def run(self, sql: str):
        self.appels.append(sql)
        raise AssertionError(
            "build() a ecrit en base alors que le corpus d'EPUB est incomplet : " + sql[:120]
        )


class TestPorteDuCorpusEpub(unittest.TestCase):
    """La porte qui a empêché de détruire 1 250 relations en production.

    `build` fait `DELETE FROM law_relations WHERE source = 'auto'` PUIS remoissonne les
    renvois dans les EPUB LOCAUX. Mesuré le 2026-09-11 : 2 des 79 EPUB étaient sur le
    disque. Sans porte, la commande aurait supprimé 1 319 relations et n'en aurait recréé
    que 33 plus une poignée — sans lever la moindre erreur.
    """

    # ⚠️ LA PRÉMISSE EST IMPOSÉE, ELLE N'EST PLUS SUBIE.
    #
    # Ces deux contrôles supposent un corpus d'EPUB INCOMPLET. Ils le LISAIENT sur le
    # disque, dans `pipeline/samples/`, qui est gitignoré — donc leur résultat dépendait
    # d'un état non versionné de la machine. Ils passaient en CI (qui ne télécharge
    # jamais) et sur un poste à 4 EPUB sur 158 ; ils ÉCHOUAIENT dès que le corpus était
    # complet — c'est-à-dire précisément dans l'état où l'on fait tourner `build()` pour
    # de vrai. Constaté le 2026-09-14, après le téléchargement des 158 EPUB.
    #
    # Un test dont la prémisse dépend de l'ambiance ne garde rien : il rougit ou verdit
    # selon la machine, et personne ne sait lequel des deux est la vérité. On pointe donc
    # `SAMPLES_DIR` vers un répertoire VIDE le temps du contrôle.
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._ancien = config.SAMPLES_DIR
        config.SAMPLES_DIR = pathlib.Path(self._tmp.name)

    def tearDown(self):
        config.SAMPLES_DIR = self._ancien
        self._tmp.cleanup()

    def test_la_premisse_du_corpus_vide_tient(self):
        """Épingle le montage lui-même : sans lui, les deux contrôles suivants sont muets."""
        manquants = R.epubs_manquants(config.load_all_laws())
        qc = [l for l in config.load_all_laws() if (l.get("jurisdiction") or "qc") == "qc"]
        self.assertEqual(len(manquants), len(qc),
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
        """Un refus doit être actionnable : dire lesquels, pas seulement combien."""
        db = _FausseBase()
        with self.assertRaises(R.CorpusEpubIncomplet) as ctx:
            R.build(db)
        manquants = R.epubs_manquants(config.load_all_laws())
        self.assertTrue(manquants, "ce test suppose un corpus d'EPUB incomplet en local")
        self.assertIn(manquants[0], str(ctx.exception))

    def test_la_porte_ne_compte_que_les_textes_quebecois(self):
        """Les 18 textes fédéraux n'ont pas d'EPUB et n'en auront jamais : ils arrivent en
        XML LIMS. Les compter comme manquants rendrait la porte impossible à franchir."""
        manquants = R.epubs_manquants(config.load_all_laws())
        federaux = {l["id"] for l in config.load_all_laws()
                    if l.get("jurisdiction") == "ca"}
        self.assertEqual(set(manquants) & federaux, set())

    def test_le_drapeau_explicite_laisse_passer(self):
        """`--accepter-corpus-partiel` doit vraiment ouvrir la porte — sinon on la contourne
        en la retirant, ce qui est pire."""
        db = _FausseBase()
        # Elle passe la porte, puis meurt sur la PREMIÈRE écriture (donc le DELETE) : c'est
        # la preuve que la porte, et elle seule, a été franchie.
        with self.assertRaises(AssertionError) as ctx:
            R.build(db, accepter_corpus_partiel=True)
        self.assertIn("DELETE FROM law_relations", str(ctx.exception))


class TestMoissonBorneeAuQuebec(unittest.TestCase):
    def test_la_moisson_de_renvois_est_bornee_par_juridiction_dans_la_source(self):
        """La borne doit être EXPLICITE, pas un effet de bord d'un `exists()` sur un EPUB.

        Les textes fédéraux n'ont pas d'EPUB, donc l'ancien `continue` les écartait par
        ACCIDENT. Un accident n'est pas une garantie : si `_sample_path` changeait de
        convention, un fichier XML partirait dans un lecteur de zip.
        """
        src = (config.ROOT / "pipeline" / "discovery" / "relations.py").read_text("utf-8") \
            if hasattr(config, "ROOT") else None
        if src is None:
            from pathlib import Path
            src = (Path(R.__file__)).read_text("utf-8")
        i = src.index("# 2) renvoie-a")
        j = src.index("# 3) chargement")
        bloc = src[i:j]
        self.assertIn('jurisdiction") or "qc") != "qc"', bloc,
                      "la moisson doit écarter explicitement les textes non québécois")
        self.assertIn('("qc", _key(chapter))', bloc,
                      "un renvoi RLRQ ne doit se résoudre que contre la juridiction 'qc'")


if __name__ == "__main__":
    unittest.main()
