"""`discovery/load.py` ne doit pas DÉTRUIRE ce que l'ingestion a écrit — hors réseau, en CI.

DÉFAUT MESURÉ LE 2026-09-14, silencieux et RÉCURRENT. `seed_laws()` synchronise les
métadonnées de loi depuis `laws.config.json`, et posait inconditionnellement :

    consol_date_fr = <config.consolidation.fr>,  consol_date_en = <config.consolidation.en>

Or les 18 entrées FÉDÉRALES de `laws.config.json` ne portent aucune clé `consolidation` :
leur date vient du XML (`lims:current-date`), écrite par `pipeline/ingest.py`. L'UPDATE la
remettait donc à NULL — **à chaque chargement de la couche de découverte**.

Conséquence servie : `qclaw_list_laws` et la page publique annonçaient 18 textes sans date
« à jour au ». Et le défaut se rejouait à chaque passe éditoriale sur `taxonomy.json`, donc
une réingestion corrective était effacée au chargement suivant — c'est ce qui a rendu la
cause si difficile à établir : elle réapparaissait après chaque réparation.

Ces tests n'appellent NI le réseau NI wrangler : une fausse base capture le SQL.
"""
from __future__ import annotations

import unittest

from pipeline import config
from pipeline.discovery import load as dload


class _BaseCapture:
    """Fausse base : capture le SQL, ne l'exécute jamais."""

    name = "capture"

    def __init__(self):
        self.sql: list[str] = []

    def run(self, sql: str):
        self.sql.append(sql)
        return []


def _updates_de(db) -> dict[str, str]:
    """Les UPDATE de `laws`, indexés par l'id de loi qu'ils visent."""
    out = {}
    for s in db.sql:
        if not s.startswith("UPDATE laws SET"):
            continue
        # … WHERE id = 'x'
        lid = s.rsplit("WHERE id = ", 1)[1].strip().strip("';")
        out[lid] = s
    return out


class TestSeedLawsNeDetruitPas(unittest.TestCase):
    def setUp(self):
        self.db = _BaseCapture()
        dload.seed_laws(self.db)
        self.updates = _updates_de(self.db)
        self.laws = {l["id"]: l for l in config.load_all_laws()}

    def test_une_loi_federale_ne_voit_pas_sa_date_ecrasee(self):
        """AUCUN UPDATE fédéral ne doit mentionner `consol_date_`.

        C'est le défaut exact : la config fédérale n'a pas de date, donc l'écrire revient
        à écrire NULL sur la valeur que le XML avait fournie.
        """
        federales = [i for i, l in self.laws.items() if l.get("jurisdiction") == "ca"]
        self.assertTrue(federales, "aucune entrée fédérale en configuration")
        for lid in federales:
            sql = self.updates.get(lid)
            self.assertIsNotNone(sql, f"{lid} : aucun UPDATE émis")
            self.assertNotIn(
                "consol_date_", sql,
                f"{lid} : `seed_laws` écrase la date de consolidation, que l'ingestion "
                "avait tirée du XML (lims:current-date). Elle repasserait à NULL.",
            )

    def test_une_loi_quebecoise_voit_bien_sa_date_synchronisee(self):
        """Le chemin québécois ne doit PAS être affaibli par le correctif.

        La config québécoise PORTE les dates : les synchroniser ici est le comportement
        voulu, et bien moins coûteux qu'une réingestion des 158 couples (loi, langue).
        """
        avec_date = [i for i, l in self.laws.items()
                     if (l.get("consolidation") or {}).get("fr")]
        self.assertGreaterEqual(len(avec_date), 70, "trop peu de lois québécoises datées")
        for lid in avec_date:
            sql = self.updates.get(lid)
            self.assertIsNotNone(sql, f"{lid} : aucun UPDATE émis")
            self.assertIn("consol_date_fr =", sql,
                          f"{lid} : la date de la config n'est plus synchronisée")

    def test_les_autres_metadonnees_restent_synchronisees_partout(self):
        """`fonction`, `forum`, `name_fr` et `name_norm` viennent bien de la config, pour
        TOUTES les lois — le correctif ne borne que les deux colonnes de date."""
        for lid, sql in self.updates.items():
            for col in ("fonction =", "forum =", "name_fr =", "name_norm ="):
                self.assertIn(col, sql, f"{lid} : `{col.strip(' =')}` n'est plus synchronisée")

    def test_chaque_loi_de_la_config_recoit_un_update(self):
        self.assertEqual(set(self.updates), set(self.laws),
                         "des lois de la configuration ne reçoivent aucun UPDATE")


class TestLaConfigFederaleNePorteAucuneDate(unittest.TestCase):
    """Épingle la PRÉMISSE du correctif. S'il devenait faux — si quelqu'un ajoutait une
    `consolidation` aux entrées fédérales — le correctif cesserait d'être nécessaire, et
    surtout la date de la config primerait silencieusement sur celle du XML, qui est la
    seule à jour. Mieux vaut que ce test rougisse et qu'on en décide."""

    def test_aucune_entree_federale_ne_declare_de_consolidation(self):
        fautives = [l["id"] for l in config.load_all_laws()
                    if l.get("jurisdiction") == "ca" and l.get("consolidation")]
        self.assertEqual(
            fautives, [],
            "des entrées fédérales déclarent une `consolidation` en configuration : elle "
            "primerait sur `lims:current-date` du XML, qui est la source vivante.",
        )


if __name__ == "__main__":
    unittest.main()
