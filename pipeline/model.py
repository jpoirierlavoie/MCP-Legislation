"""Modèle de données du pipeline — reflète le schéma D1 (PLAN.md §2 révisé)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Law:
    id: str
    name_fr: str
    name_en: str
    # Citation officielle. Le champ s'appelle encore `rlrq_cite` ici : le renommage en
    # `official_cite` est une MIGRATION (phase 3), et la renommer avant elle ferait divergir
    # le dataclass de la colonne. `pipeline/load.py::_LAW_COLS` fait le pont.
    rlrq_cite: str
    consol_date_fr: str | None = None
    consol_date_en: str | None = None
    name_norm: str | None = None     # rempli au chargement (couche découverte)
    # --- corpus fédéral (SPEC §2.1) -------------------------------------------
    # Ces champs ne sont ÉCRITS EN BASE qu'à partir de la migration 0004 : tant qu'ils ne
    # figurent pas dans `_LAW_COLS`, ils restent en mémoire sans effet. C'est voulu — le
    # parseur peut les remplir avant que le schéma ne les accueille.
    official_cite_en: str | None = None   # « R.S.C. 1985, c. B-3 », « CQLR, c. CCQ-1991 »
    chapter: str | None = None            # « B-3 » — ce sur quoi parseCitation doit apparier
    jurisdiction: str = "qc"              # 'qc' | 'ca'
    in_force: int = 1                     # 0 = édictée mais NON en vigueur (refus d'ingestion)
    last_amended: str | None = None       # « Dernière modification le … » (lims:lastAmendedDate)
    unit: str = "article"                 # 'article' | 'regle' (Règles des Cours fédérales) | 'paragraphe'
    source: str = "epub"                  # 'epub' | 'lims' | 'pdf'


@dataclass
class Division:
    law_id: str
    lang: str
    kind: str                    # livre|titre|chapitre|section|sous-section|niveau6|niveau7|niveau8|disposition
    path: str                    # id Irosoft complet (chemin canonique) ; identifiant naturel unique
    number: str | None = None    # ordinal affichable : 'PREMIER', 'I', '§ 1', ...
    heading: str | None = None   # intitulé (peut manquer : divisions abrogées)
    history: str | None = None   # historique de division (89 cas C.c.Q. FR)
    repealed: int = 0            # 1 si division abrogée
    parent_path: str | None = None   # path du parent, résolu en parent_id au chargement
    sort_order: int = 0
    heading_norm: str | None = None  # rempli au chargement (recherche d'orientation)
    # rempli au chargement :
    id: int | None = None
    parent_id: int | None = None


@dataclass
class Article:
    law_id: str
    lang: str
    number: str                  # '1457', '2926.1', '132.0.1', 'préliminaire', 'finales'
    text: str                    # verbatim (numéro, historique et notes A.M. exclus)
    division_path: str           # id Irosoft de la division feuille
    html: str | None = None      # HTML nettoyé (integrity:* retirés, liens absolus, historique retiré)
    history: str | None = None   # ligne d'historique : '1991, c. 64, a. 1457; ...'
    repealed: int = 0            # 1 si '(Abrogé).'
    # --- corpus fédéral -------------------------------------------------------
    # Intitulé officiel d'article (`MarginalNote`). HORS DU TEXTE par l'art. 14 de la Loi
    # d'interprétation : « ne font pas partie de celui-ci, n'y figurant qu'à titre de repère
    # ou d'information ». Donc colonne propre, JAMAIS concaténée au texte.
    marginal_note: str | None = None
    # Notes en bas de page, jointes par '\n'. Tranché le 2026-09-11 : ingérées, rendues À LA
    # FIN de l'article et ÉTIQUETÉES — l'art. 14 n'exclut que les notes marginales et les
    # mentions de textes antérieurs, pas celles-ci.
    footnotes: str | None = None
    # Numéros COUVERTS par un label de plage (« 11 à 14 » -> ['11','12','13','14']).
    # C'est le PARSEUR qui décide ce qu'est une plage — il connaît la langue du `Label`
    # (`à`/`to`, `et`/`and`) —, et `load.py` se contente d'en écrire les lignes dans
    # `article_numbers`. Sans quoi `get_article(law='ca-i-15', article='12')` répondrait
    # « introuvable » là où la vraie réponse est « abrogé, art. 11 à 14 » : un faux
    # silencieux sur une question d'abrogation.
    alias_numbers: list[str] = field(default_factory=list)
    links: str | None = None  # JSON array [{"label": ..., "url": ...}] (migrations/0007_pdf_corpus.sql)
    # rempli au chargement :
    id: int | None = None
    # None (et non 0) pour distinguer « pas encore calculée » de « calculée à 0 ». Le
    # préambule vaut LÉGITIMEMENT 0, et `load.prepare` le jetait : son
    # `a.sort_key = a.sort_key or sort_key(...)` teste la FAUSSETÉ, donc 0 était recalculé.
    sort_key: int | None = None
    division_id: int | None = None


# Clé de tri des pseudo-articles de disposition : APRÈS tout le corpus. Le max d'un article
# réel = 270000*13500*2700*864 - 1 = 8_503_055_999_999_999 (< 9e15 < 2^53), donc une base à 9e15 les place tous après.
DISPOSITION_SORT_BASE = 9_000_000_000_000_000

_SORT_COMP_RE = re.compile(r"^(\d+)([A-Za-z]?)$")
_SORT_BASES = (13_500, 2_700, 864)       # c1 < 500*27, c2 < 100*27, c3 < 32*27
_SORT_MAX_NUMS = (9999, 499, 99, 31)     # max = 270000*13500*2700*864 - 1 = 8_503_055_999_999_999 < 9e15


def sort_key(number: str) -> int:
    """Clé de tri 53 bits : packing mixte à 4 composantes (c0..c3) avec suffixe lettre
    optionnel A–Z (27 états), strictement < DISPOSITION_SORT_BASE (< 2^53).
    """
    if number in ("préliminaire", "preambule", "preamble", "note-preliminaire"):
        return 0
    parts = number.split(".")
    if not _SORT_COMP_RE.match(parts[0]):
        return DISPOSITION_SORT_BASE  # pseudo-article non numérique (le parseur fixe l'ordre)
    vals: list[int] = []
    for i, p in enumerate(parts[:4]):
        m = _SORT_COMP_RE.match(p)
        if m:
            n = min(int(m.group(1)), _SORT_MAX_NUMS[i])
            let = ord(m.group(2).upper()) - 64 if m.group(2) else 0
            vals.append(n * 27 + let)
        else:
            vals.append(0)
    while len(vals) < 4:
        vals.append(0)
    key = vals[0]
    for i, b in enumerate(_SORT_BASES):
        key = key * b + vals[i + 1]
    return key
