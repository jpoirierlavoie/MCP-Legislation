from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "data" / "laws.config.json"
SAMPLES_DIR = REPO_ROOT / "pipeline" / "samples"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

LIMS_REPO = Path(os.environ.get("LIMS_REPO", REPO_ROOT.parent / "laws-lois-xml"))
LIMS_REF = os.environ.get("LIMS_REF", "HEAD")

def load_config(path: Path | None = None) -> dict:
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)

def load_all_laws(path: Path | None = None) -> list[dict]:
    return list(load_config(path)["laws"])

def get_law(law_id: str, path: Path | None = None) -> dict:
    for law in load_all_laws(path):
        if law["id"] == law_id:
            return law
    raise KeyError(f"loi inconnue dans laws.config.json : {law_id!r}")

get_law_any = get_law
