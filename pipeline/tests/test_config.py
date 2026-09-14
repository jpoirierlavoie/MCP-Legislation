"""Garde-fous sur laws.config.json — le fichier unique décrivant le corpus.

L'ORDRE des lois y est significatif : pipeline.ingest._id_base() dérive la plage d'id
(divisions, articles) de la POSITION de la loi dans la liste. Réordonner le fichier, ou
insérer une loi ailleurs qu'en fin, décale toutes les clés primaires : la prochaine
ingestion écrirait alors les articles d'une loi sur ceux d'une autre, silencieusement.
D'où l'ordre épinglé ci-dessous.
"""
from __future__ import annotations

import unittest
from urllib.parse import unquote, urlsplit

from pipeline import config
from pipeline.ingest import _id_base

# Ordre figé au moment de la fusion des deux configurations. On AJOUTE en fin de liste.
ORDRE_ATTENDU = [
    "ccq", "cpc",
    "c-25.01-r.0.2.01", "c-25.01-r.0.2.2", "c-25.01-r.0.2.3", "c-25.01-r.9", "t-16",
    "t-16-r.10", "c-12", "i-16", "c-25.01-r.0.2.4", "c-25.01-r.0.2.1", "j-3",
    "j-3-r.3.01", "j-3-r.3.2", "i-13.2.2", "b-9", "t-15.01-r.5", "t-15.01",
    "t-15.01-r.6", "p-40.1", "b-1", "b-1-r.3.1", "b-1-r.5", "c-1.1", "c-19", "c-26",
    "c-38", "c-73.2", "e-6.1", "d-9.2", "e-12.000001", "i-14.01", "n-1.1", "p-39.1",
    "p-44.1", "s-31.1", "t-11.002",
    # lot d'extension 2026-07-21 (ajouté EN FIN, comme l'exige _id_base)
    "v-1.1", "a-2.1", "a-32.1", "f-2.1", "c-25.1", "c-67.3", "ccq-r.8", "ccq-r.6",
    "a-33.01",
    # lot 3 (2026-07-21) : financier/TAMF, policier, construction, courtage, municipal
    "e-6.1-r.2", "e-6.1-r.0.3", "d-9.2-r.2", "d-9.2-r.10", "d-9.2-r.19", "d-9.2-r.20",
    "p-13.1", "p-13.1-r.1", "p-13.1-r.2.02", "p-13.1-r.2.1", "b-1.1", "b-1.1-r.1", "b-1.1-r.2",
    "b-1.1-r.3", "b-1.1-r.3.1", "b-1.1-r.8", "b-1.1-r.10", "c-73.2-r.1", "c-73.2-r.4",
    "c-73.2-r.6", "e-15.1.0.1", "e-25", "e-6", "f-3.1", "a-33.2.1", "c-65.1", "c-65.01",
    "c-37.01", "d-11.1", "p-33.01", "c-52.2",
    # 79e : ajoutée EN FIN (invariant 1 — _id_base dérive de la POSITION).
    "c-27.1",
    # --- CORPUS FÉDÉRAL (2026-09-11) : 16 lois + 2 règlements, ajoutés EN FIN ------------
    # L'ordre suit le tableau du SPEC §9. Ces 18 entrées portent `source: "lims"` et sont
    # lues en XML depuis le dépôt de Justice Canada, donc SANS `epub` ni `consolidation` :
    # leur date est LUE SUR LA PAGE OFFICIELLE (`official_source`), ce qui vaut mieux qu'une
    # date recopiée en config (R10). `test_champs_obligatoires` branche sur `source`.
    "ca-b-3", "ca-c-36", "ca-d-3.4", "ca-c-44", "ca-c-34", "ca-c-42", "ca-t-13", "ca-l-2",
    "ca-p-8.6", "ca-i-21", "ca-c-5", "ca-f-7", "ca-s-26", "ca-c-50", "ca-i-15", "ca-b-4",
    "ca-dors-98-106", "ca-crc-368",
]


class ConfigTest(unittest.TestCase):
    def test_ordre_fige(self):
        ids = [l["id"] for l in config.load_all_laws()]
        self.assertEqual(
            ids, ORDRE_ATTENDU,
            "L'ordre de laws.config.json a changé : les plages d'id (_id_base) se décalent "
            "et une réingestion écraserait les articles d'autres lois. Ajouter EN FIN de liste.",
        )

    def test_plages_id_disjointes(self):
        """Deux combinaisons (loi, langue) ne doivent jamais partager une plage d'id."""
        vus: dict[int, tuple[str, str]] = {}
        for law in config.load_all_laws():
            for lang in ("fr", "en"):
                base = _id_base(law["id"], lang)
                self.assertNotIn(base, vus, f"plage partagée : {law['id']}/{lang} et {vus.get(base)}")
                vus[base] = (law["id"], lang)

    def test_champs_obligatoires(self):
        """Champs requis, BRANCHÉS SUR LA SOURCE.

        Les entrées québécoises arrivent en EPUB depuis LégisQuébec : `epub`,
        `consolidation` et `consolidation_source` y sont indispensables. Les entrées
        fédérales arrivent en XML depuis un dépôt git et n'ont AUCUN de ces trois champs —
        leur date de consolidation est LUE SUR LA PAGE OFFICIELLE que désigne
        `official_source`, ce qui est strictement mieux qu'une date recopiée en config
        (R10) et, surtout, c'est la MÊME observation que celle à laquelle la veille la
        compare — sans quoi les 36 contrôles fédéraux seraient faux à perpétuité.

        On BRANCHE donc, on n'assouplit pas : le test reste aussi strict pour chaque source.
        Le laisser exiger `epub` de tout le monde rendrait la CI rouge sur 18 entrées ; le
        réduire au tronc commun laisserait passer une entrée québécoise sans EPUB.
        """
        for law in config.load_all_laws():
            for champ in ("id", "name_fr", "official_cite", "fonction"):
                self.assertIn(champ, law, f"{law.get('id')} : champ '{champ}' manquant")

            if law.get("source") == "lims":
                # Fédéral : les chemins XML des deux langues, et le chapitre — c'est sur LUI
                # que `parseCitation` apparie, jamais sur la citation entière.
                for champ in ("xml", "chapter", "jurisdiction"):
                    self.assertIn(champ, law, f"{law['id']} : champ '{champ}' manquant (source lims)")
                for lang in ("fr", "en"):
                    self.assertTrue(law["xml"].get(lang),
                                    f"{law['id']} : chemin XML {lang} manquant")
                self.assertEqual(law["jurisdiction"], "ca")
                self.assertNotIn("epub", law,
                                 f"{law['id']} : un texte LIMS n'a pas d'EPUB")

                # `official_source` est PORTANTE, et rien ne l'exigeait.
                #
                # Elle sert trois choses à la fois : l'ingestion y lit la date « à jour »
                # affichée par le site (qui alimente `consol_date_*`), la veille de
                # consolidation y lit sa date live, et la page publique en fait le lien vers
                # la source officielle. Un champ qui porte autant et que rien ne contrôle
                # finit par mentir — et il avait déjà menti : les DEUX entrées de règlement
                # portaient l'identifiant ANGLAIS dans le chemin français (`SOR-98-106` au
                # lieu de `DORS-98-106`, `C.R.C.,_c._368` au lieu de `C.R.C.,_ch._368`), donc
                # 404 sur les deux, MESURÉ le 2026-09-14 — pendant que les chemins `xml` des
                # mêmes entrées, eux, étaient justes.
                #
                # La cohérence est contrôlable SANS RÉSEAU parce qu'elle est structurelle :
                # sur les 36 couples, le chemin de l'URL vaut EXACTEMENT
                # `/<chemin xml privé de .xml>/`. C'est le seul contrôle qui aurait attrapé
                # les deux 404 depuis la CI, où aucun appel sortant n'est fait.
                self.assertIn("official_source", law,
                              f"{law['id']} : champ 'official_source' manquant (source lims)")
                for lang in ("fr", "en"):
                    url = law["official_source"].get(lang)
                    self.assertTrue(url, f"{law['id']} : URL de source {lang} manquante")
                    chemin_xml = law["xml"][lang]
                    self.assertTrue(chemin_xml.endswith(".xml"),
                                    f"{law['id']}/{lang} : chemin XML sans extension .xml")
                    attendu = "/" + chemin_xml.removesuffix(".xml") + "/"
                    self.assertEqual(
                        unquote(urlsplit(url).path), attendu,
                        f"{law['id']}/{lang} : l'URL de source ne désigne pas le même texte "
                        f"que le chemin XML (attendu '{attendu}'). C'est exactement ainsi que "
                        f"l'identifiant anglais s'est retrouvé dans le chemin français.",
                    )
            else:
                for champ in ("epub", "consolidation", "consolidation_source"):
                    self.assertIn(champ, law, f"{law.get('id')} : champ '{champ}' manquant")
                for lang in ("fr", "en"):
                    self.assertIn(lang, law["epub"], f"{law['id']} : URL EPUB {lang} manquante")
                    # une source juridique sans date de consolidation n'est pas citable
                    self.assertTrue(law["consolidation"].get(lang),
                                    f"{law['id']} : date de consolidation {lang} manquante")

    def test_ids_uniques(self):
        ids = [l["id"] for l in config.load_all_laws()]
        self.assertEqual(len(ids), len(set(ids)), "identifiants de loi en doublon")

    def test_get_law_couvre_tout_le_corpus(self):
        """Régression : avant la fusion, get_law() ne voyait que ccq/cpc et levait sur les 36."""
        for law_id in ("ccq", "cpc", "t-16", "b-1-r.5", "t-11.002"):
            self.assertEqual(config.get_law(law_id)["id"], law_id)


if __name__ == "__main__":
    unittest.main()
