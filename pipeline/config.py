"""Lecture de laws.config.json (JSON strict) — voir PLAN.md §8.

Fichier UNIQUE décrivant le corpus. Les ajouts de la couche découverte
y ont été fusionnés (plan-couche-decouverte §5 : « laws.config.additions.json fusionne
dans laws.config.json »), le fichier séparé n'était qu'un véhicule de livraison.

⚠️ L'ORDRE des lois est significatif : pipeline.ingest._id_base() dérive la plage d'id
(divisions, articles) de la position de la loi dans cette liste. Réordonner le fichier
décale toutes les clés primaires et impose une réingestion complète. On AJOUTE en fin de
liste, on ne réordonne pas.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "laws.config.json"
SAMPLES_DIR = REPO_ROOT / "pipeline" / "samples"

# En-tête navigateur : LégisQuébec renvoie 403 aux clients de centre de données
# (constaté en phase 0). À utiliser pour tout téléchargement.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# --- corpus fédéral : dépôt XML de Justice Canada -----------------------------
#
# Source UNIQUE des textes fédéraux : le dépôt git justicecanada/laws-lois-xml
# (Licence du gouvernement ouvert – Canada). On ne parse NI le HTML de
# lois.justice.gc.ca, NI les ZIP du portail des données ouvertes : le dépôt git est le
# seul canal qui donne, au fichier près, ce qui a bougé entre deux consolidations.
#
# Le clone vit HORS de l'arbre de ce dépôt (un sous-dépôt git dans l'arbre d'un autre
# dépôt git est une confusion connue) et se fait en clone partiel :
#   git clone --filter=blob:none --no-checkout https://github.com/justicecanada/laws-lois-xml.git
# Les blobs sont tirés à la demande par `git show <ref>:<chemin>` — le clone ne pèse
# que ~2 Mo.
#
# LIMS_REF est délibérément un POINT FIXE et non une branche : c'est le SHA consigné au
# rapport d'ingestion qui rend une ingestion reproductible, et la veille s'en sert pour
# détecter qu'une loi a bougé. Employer "HEAD" pour une reconnaissance, un SHA pour une
# ingestion que l'on veut pouvoir rejouer à l'identique.
LIMS_REPO = Path(os.environ.get("LIMS_REPO", REPO_ROOT.parent / "laws-lois-xml"))
LIMS_REF = os.environ.get("LIMS_REF", "HEAD")


def load_config(path: Path | None = None) -> dict:
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_all_laws(path: Path | None = None) -> list[dict]:
    """Corpus complet, dans l'ordre du fichier (cf. avertissement en tête de module)."""
    return list(load_config(path)["laws"])


def get_law(law_id: str, path: Path | None = None) -> dict:
    for law in load_all_laws(path):
        if law["id"] == law_id:
            return law
    raise KeyError(f"loi inconnue dans laws.config.json : {law_id!r}")


# Rétrocompatibilité : avant la fusion, get_law() ne voyait que ccq/cpc et get_law_any()
# voyait tout — une distinction qui n'a plus lieu d'être (et qui faisait échouer get_law()
# sur les textes ajoutés par la couche découverte).
get_law_any = get_law
