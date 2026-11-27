from __future__ import annotations

import re

SEG_SPLIT = re.compile(r"-(?=(?:g[a-z]|fh\d+|fs|fp|ph\d+|ps):)")

_FEDERAL = re.compile(r"^(?:fh\d+|fs|fp):")

def segments(path: str) -> list[str]:
    return SEG_SPLIT.split(path)

def depth(path: str) -> int:
    return len(segments(path))

def truncate(path: str, d: int) -> str:
    return "-".join(segments(path)[:d])

def parent_path(path: str) -> str | None:
    segs = segments(path)
    return "-".join(segs[:-1]) if len(segs) > 1 else None

def is_federal(path: str) -> bool:
    return bool(_FEDERAL.match(path))
