from __future__ import annotations

import unittest
from urllib.parse import unquote, urlsplit

from pipeline import config
from pipeline.ingest import _id_base

DOMAINES_VALIDES = (
    "core",
    "cours-federales",
    "financier",
    "construction-immobilier",
    "municipal-environnement",
    "travail",
    "penal",
    "propriete-intellectuelle",
)

ORDRE_ATTENDU = [
    "ccq", "cpc",
    "c-25.01-r.0.2.01", "c-25.01-r.0.2.2", "c-25.01-r.0.2.3", "c-25.01-r.9", "t-16",
    "t-16-r.10", "c-12", "i-16", "c-25.01-r.0.2.4", "c-25.01-r.0.2.1", "j-3",
    "j-3-r.3.01", "j-3-r.3.2", "i-13.2.2", "b-9", "t-15.01-r.5", "t-15.01",
    "t-15.01-r.6", "p-40.1", "b-1", "b-1-r.3.1", "b-1-r.5", "c-1.1", "c-19", "c-26",
    "c-38", "c-73.2", "e-6.1", "d-9.2", "e-12.000001", "i-14.01", "n-1.1", "p-39.1",
    "p-44.1", "s-31.1", "t-11.002",
    "v-1.1", "a-2.1", "a-32.1", "f-2.1", "c-25.1", "c-67.3", "ccq-r.8", "ccq-r.6",
    "a-33.01",
    "e-6.1-r.2", "e-6.1-r.0.3", "d-9.2-r.2", "d-9.2-r.10", "d-9.2-r.19", "d-9.2-r.20",
    "p-13.1", "p-13.1-r.1", "p-13.1-r.2.02", "p-13.1-r.2.1", "b-1.1", "b-1.1-r.1", "b-1.1-r.2",
    "b-1.1-r.3", "b-1.1-r.3.1", "b-1.1-r.8", "b-1.1-r.10", "c-73.2-r.1", "c-73.2-r.4",
    "c-73.2-r.6", "e-15.1.0.1", "e-25", "e-6", "f-3.1", "a-33.2.1", "c-65.1", "c-65.01",
    "c-37.01", "d-11.1", "p-33.01", "c-52.2",
    "c-27.1",
    "ca-b-3", "ca-c-36", "ca-d-3.4", "ca-c-44", "ca-c-34", "ca-c-42", "ca-t-13", "ca-l-2",
    "ca-p-8.6", "ca-i-21", "ca-c-5", "ca-f-7", "ca-s-26", "ca-c-50", "ca-i-15", "ca-b-4",
    "ca-dors-98-106", "ca-crc-368",
    "qccs-dist-mtl", "qccs-div-mtl", "qccs-div-qc",
    "qccq-regles-simplifiees", "qccq-mtl-prat-civile", "qccq-mtl-prat-admin", "qccq-daa-jurisprudence",
    "v-1.1-r.10", "v-1.1-r.21", "v-1.1-r.24",
    "amf-ig-31-103", "amf-ig-45-106", "amf-ig-51-102",
    "ca-const-1867", "ca-const-1982",
    "c-11", "a-25", "c-37", "c-81", "n-3",
    "ca-dors-2002-156", "ca-c-7.75",
    "t-15.1", "t-15.1-r.1.1", "c-27", "a-3.001", "s-2.1",
    "c-47.1", "a-19.1", "q-2", "p-41.1",
    "ca-p-4", "ca-i-9", "s-29.02",
    "ca-c-46", "ca-c-38.8", "ca-y-1.5",
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
        vus: dict[int, tuple[str, str]] = {}
        for law in config.load_all_laws():
            for lang in ("fr", "en"):
                base = _id_base(law["id"], lang)
                self.assertNotIn(base, vus, f"plage partagée : {law['id']}/{lang} et {vus.get(base)}")
                vus[base] = (law["id"], lang)

    def test_champs_obligatoires(self):
        for law in config.load_all_laws():
            for champ in ("id", "name_fr", "official_cite", "fonction", "domain"):
                self.assertIn(champ, law, f"{law.get('id')} : champ '{champ}' manquant")
            self.assertIn(
                law["domain"], DOMAINES_VALIDES,
                f"{law['id']} : domaine invalide {law.get('domain')!r}",
            )

            if law.get("source") == "lims":
                for champ in ("xml", "chapter", "jurisdiction"):
                    self.assertIn(champ, law, f"{law['id']} : champ '{champ}' manquant (source lims)")
                for lang in ("fr", "en"):
                    self.assertTrue(law["xml"].get(lang),
                                    f"{law['id']} : chemin XML {lang} manquant")
                self.assertEqual(law["jurisdiction"], "ca")
                self.assertNotIn("epub", law,
                                 f"{law['id']} : un texte LIMS n'a pas d'EPUB")

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
            elif law.get("source") == "pdf":
                self.assertIn(
                    law.get("fonction"), ("directive", "orientation", "reglement", "loi"),
                    f"{law['id']} : fonction PDF invalide : {law.get('fonction')!r}",
                )
                self.assertNotIn("epub", law, f"{law['id']} : un texte PDF n'a pas d'EPUB")
                self.assertFalse(
                    law.get("consolidation"),
                    f"{law['id']} : un texte PDF ne doit pas déclarer `consolidation` en config",
                )
                self.assertIn("pdf", law, f"{law['id']} : champ 'pdf' manquant")
                self.assertIsInstance(law["pdf"], dict)
                langs = law.get("langs") or list(law["pdf"].keys())
                self.assertTrue(langs, f"{law['id']} : aucune langue configurée")
                for lang in langs:
                    self.assertTrue(law["pdf"].get(lang), f"{law['id']} : PDF {lang} manquant")
                self.assertTrue(
                    (law.get("consolidation_source") or {}).get("fr"),
                    f"{law['id']} : consolidation_source.fr requis",
                )
            else:
                for champ in ("epub", "consolidation", "consolidation_source"):
                    self.assertIn(champ, law, f"{law.get('id')} : champ '{champ}' manquant")
                for lang in ("fr", "en"):
                    self.assertIn(lang, law["epub"], f"{law['id']} : URL EPUB {lang} manquante")
                    self.assertTrue(law["consolidation"].get(lang),
                                    f"{law['id']} : date de consolidation {lang} manquante")

    def test_ids_uniques(self):
        ids = [l["id"] for l in config.load_all_laws()]
        self.assertEqual(len(ids), len(set(ids)), "identifiants de loi en doublon")

    def test_get_law_couvre_tout_le_corpus(self):
        for law_id in ("ccq", "cpc", "t-16", "b-1-r.5", "t-11.002"):
            self.assertEqual(config.get_law(law_id)["id"], law_id)

if __name__ == "__main__":
    unittest.main()
