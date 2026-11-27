from __future__ import annotations

import re
import unicodedata

def normalize(s: str | None) -> str | None:
    if s is None:
        return None
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s).strip().lower() or None
