from __future__ import annotations

import re
from dataclasses import dataclass, field

@dataclass
class Law:
    id: str
    name_fr: str
    name_en: str
    official_cite: str
    consol_date_fr: str | None = None
    consol_date_en: str | None = None
    name_norm: str | None = None
    official_cite_en: str | None = None
    chapter: str | None = None
    jurisdiction: str = "qc"
    in_force: int = 1
    last_amended: str | None = None
    unit: str = "article"
    source: str = "epub"
    domain: str = "core"

@dataclass
class Division:
    law_id: str
    lang: str
    kind: str
    path: str
    number: str | None = None
    heading: str | None = None
    history: str | None = None
    repealed: int = 0
    parent_path: str | None = None
    sort_order: int = 0
    heading_norm: str | None = None
    id: int | None = None
    parent_id: int | None = None

@dataclass
class Article:
    law_id: str
    lang: str
    number: str
    text: str
    division_path: str
    html: str | None = None
    history: str | None = None
    repealed: int = 0
    marginal_note: str | None = None
    footnotes: str | None = None
    alias_numbers: list[str] = field(default_factory=list)
    links: str | None = None
    id: int | None = None
    sort_key: int | None = None
    division_id: int | None = None

DISPOSITION_SORT_BASE = 9_000_000_000_000_000

_SORT_COMP_RE = re.compile(r"^(\d+)([A-Za-z]?)$")
_SORT_BASES = (13_500, 2_700, 864)
_SORT_MAX_NUMS = (9999, 499, 99, 31)

def sort_key(number: str) -> int:
    if number in ("préliminaire", "preambule", "preamble", "note-preliminaire"):
        return 0
    parts = number.split(".")
    if not _SORT_COMP_RE.match(parts[0]):
        return DISPOSITION_SORT_BASE
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
