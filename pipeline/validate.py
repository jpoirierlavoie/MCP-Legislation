from __future__ import annotations

import collections
import re
from dataclasses import dataclass, field

from .model import Article, Division
from .norm import normalize

_NUMERIC = re.compile(r"\d+[A-Za-z]?(?:\.\d+[A-Za-z]?)*$")

def is_disposition(number: str) -> bool:
    return _NUMERIC.fullmatch(number) is None

def numeros_effectifs(a: Article) -> list[str]:
    return a.alias_numbers or [a.number]

_CCQ = {
    "articles_real": 3524,
    "int_min": 1, "int_max": 3168,
    "decimals": 356,
    "divisions": 801,
    "div_by_kind": {"livre": 10, "titre": 45, "chapitre": 160, "section": 270,
                     "sous-section": 214, "niveau6": 86, "niveau7": 13, "niveau8": 3},
    "repealed_articles": 68,
    "repealed_divisions": 4,
    "dispositions": 2,
}
_CPC = {
    "articles_real": 876,
    "int_min": 1, "int_max": 836,
    "decimals": 40,
    "divisions": 307,
    "div_by_kind": {"livre": 8, "titre": 30, "chapitre": 129, "section": 123, "sous-section": 17},
    "repealed_articles": 1,
    "repealed_divisions": 0,
    "dispositions": 2,
}
EXPECTED = {
    ("ccq", "fr"): _CCQ, ("ccq", "en"): _CCQ,
    ("cpc", "fr"): _CPC, ("cpc", "en"): _CPC,
}

@dataclass
class Report:
    ok: bool = True
    lines: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    witness_deltas: list[str] = field(default_factory=list)

    def check(self, label: str, got, expected=None):
        if expected is None:
            self.lines.append(f"  · {label}: {got}")
        else:
            ok = got == expected
            self.ok &= ok
            self.lines.append(f"  {'✓' if ok else '✗'} {label}: {got}" + ("" if ok else f"  (attendu {expected})"))

def _toc_norm(s: str | None, *, strip_parentheticals: bool = False) -> str:
    raw = s or ""
    if strip_parentheticals:
        raw = re.sub(r"\s*\(art\.?\s*[^)]+\)", "", raw, flags=re.I)
    n = normalize(raw) or ""
    n = n.replace("\u2019", "'").replace("\u2018", "'")
    n = re.sub(r"\s+", " ", n)
    return n.rstrip(".").strip()

def validate(law_id: str, lang: str, divisions: list[Division], articles: list[Article],
             jurisdiction: str = "qc", numeros_refuses: list[str] | None = None,
             allow_witness_drift: bool = False,
             fonction: str | None = None,
             span_accounting: dict | None = None,
             toc_titles: list[str] | None = None,
             toc_exempt_headings: list[str] | set[str] | None = None,
             toc_strip_parentheticals: bool = False) -> Report:
    r = Report()
    real = [a for a in articles
            if not all(is_disposition(n) for n in numeros_effectifs(a))]
    disp = [a for a in articles
            if all(is_disposition(n) for n in numeros_effectifs(a))]
    occupes = [n for a in real for n in numeros_effectifs(a)]
    ints = sorted({int(n) for n in occupes if "." not in n and n.isdigit()})
    decimals = [n for n in occupes if "." in n]
    div_no_disp = [d for d in divisions if d.kind not in ("disposition", "annexe")]
    by_kind: dict[str, int] = {}
    for d in div_no_disp:
        by_kind[d.kind] = by_kind.get(d.kind, 0) + 1

    r.stats = {
        "articles_total": len(articles), "articles_real": len(real), "dispositions": len(disp),
        "int_count": len(ints), "int_min": ints[0] if ints else None, "int_max": ints[-1] if ints else None,
        "decimals": len(decimals), "divisions": len(div_no_disp), "div_by_kind": by_kind,
        "repealed_articles": sum(a.repealed for a in real), "repealed_divisions": sum(d.repealed for d in div_no_disp),
    }

    gaps, dups = [], []
    if ints:
        full = set(range(ints[0], ints[-1] + 1))
        gaps = sorted(full - set(ints))
        seen, dd = set(), set()
        for n in occupes:
            if "." not in n and n.isdigit():
                v = int(n)
                (dd if v in seen else seen).add(v)
        dups = sorted(dd)

    exp = EXPECTED.get((law_id, lang))
    r.lines.append(f"Invariants {law_id}/{lang} :")
    if exp:
        def check_witness(label: str, got, expected):
            if got == expected or not allow_witness_drift:
                r.check(label, got, expected)
            else:
                r.witness_deltas.append(f"{law_id}/{lang} — {label}: {got} (témoin figé {expected})")
                r.lines.append(f"  ⚠ {label}: {got}  (témoin figé {expected})")

        if allow_witness_drift:
            if r.stats["int_min"] != exp["int_min"]:
                r.check("plancher entier min", r.stats["int_min"], exp["int_min"])
            if (r.stats["int_max"] or 0) < exp["int_max"] - 5:
                r.check("plancher entier max", r.stats["int_max"], f">= {exp['int_max'] - 5}")
            if len(real) < exp["articles_real"] - 20:
                r.check("plancher articles se:", len(real), f">= {exp['articles_real'] - 20}")
            if len(div_no_disp) < exp["divisions"] - 10:
                r.check("plancher divisions", len(div_no_disp), f">= {exp['divisions'] - 10}")

        check_witness("articles se:", len(real), exp["articles_real"])
        check_witness("entiers min/max", (r.stats["int_min"], r.stats["int_max"]), (exp["int_min"], exp["int_max"]))
        check_witness("entiers complets (nb)", len(ints), exp["int_max"] - exp["int_min"] + 1)
        check_witness("décimaux", len(decimals), exp["decimals"])
        check_witness("divisions", len(div_no_disp), exp["divisions"])
        check_witness("divisions par type", by_kind, exp["div_by_kind"])
        check_witness("articles abrogés", r.stats["repealed_articles"], exp["repealed_articles"])
        check_witness("divisions abrogées", r.stats["repealed_divisions"], exp["repealed_divisions"])
        check_witness("dispositions (pseudo-articles)", len(disp), exp["dispositions"])
    else:
        r.check("articles se:", len(real))
        r.check("entiers min/max", (r.stats["int_min"], r.stats["int_max"]))
        r.check("divisions", len(div_no_disp))
        r.check("divisions par type", by_kind)

    if jurisdiction == "ca":
        refuses = {n for n in (numeros_refuses or []) if n.isdigit()}
        manquants = [int(n) for n in map(str, gaps)]
        par_refus = sorted(n for n in manquants if str(n) in refuses)
        par_retrait = sorted(n for n in manquants if str(n) not in refuses)
        r.check("lacunes (fédéral : informatif)",
                f"{len(manquants)} — non en vigueur (refusés) : {par_refus or 'aucun'} ; "
                f"retirés de la codification : {par_retrait or 'aucun'}")
    elif fonction == "orientation":
        r.check("lacunes (orientation : informatif)",
                f"{len(gaps)} lacune(s) : {gaps[:12]}" if gaps else "aucune")
    else:
        r.check("lacunes dans la plage entière", gaps if gaps else "aucune", "aucune")
    r.check("doublons d'entiers", dups if dups else "aucun", "aucun")

    if span_accounting is not None:
        total_sp = int(span_accounting.get("total", span_accounting.get("total_spans", 0)))
        acc_sp = int(span_accounting.get("accounted", span_accounting.get("accounted_spans", 0)))
        unclass = int(span_accounting.get("unclassified", 0))
        r.check("porte 1 : spans non classés", unclass, 0)
        r.check("porte 1 : bilan complet (comptabilisés == total > 0)",
                (acc_sp, total_sp > 0), (total_sp, True))

    if toc_titles is not None:
        exempt = {_toc_norm(h, strip_parentheticals=toc_strip_parentheticals) for h in (toc_exempt_headings or ())}
        toc_c = collections.Counter(
            _toc_norm(t, strip_parentheticals=toc_strip_parentheticals)
            for t in toc_titles
            if _toc_norm(t, strip_parentheticals=toc_strip_parentheticals)
        )
        div_c = collections.Counter(
            _toc_norm(d.heading, strip_parentheticals=toc_strip_parentheticals)
            for d in divisions
            if _toc_norm(d.heading, strip_parentheticals=toc_strip_parentheticals)
            and _toc_norm(d.heading, strip_parentheticals=toc_strip_parentheticals) not in exempt
        )
        missing_in_divs = sorted((toc_c - div_c).elements())
        extra_in_divs = sorted((div_c - toc_c).elements())
        r.check(
            "porte 2 : parité TDM <-> divisions (manquantes)",
            missing_in_divs if missing_in_divs else "aucune",
            "aucune",
        )
        r.check(
            "porte 2 : parité TDM <-> divisions (excédentaires)",
            extra_in_divs if extra_in_divs else "aucune",
            "aucune",
        )

    tous_numeros = [n for a in articles for n in numeros_effectifs(a)]
    vus: set[str] = set()
    num_doubles: dict[str, int] = {}
    for n in tous_numeros:
        if n in vus:
            num_doubles[n] = num_doubles.get(n, 1) + 1
        vus.add(n)
    r.check(
        "numéros d'article uniques (annexes et décimaux COMPRIS)",
        ", ".join(f"{k} ×{v}" for k, v in sorted(num_doubles.items())) if num_doubles else "oui",
        "oui",
    )

    chemins = [d.path for d in divisions if d.path]
    vus_p: set[str] = set()
    path_doubles: dict[str, int] = {}
    for p in chemins:
        if p in vus_p:
            path_doubles[p] = path_doubles.get(p, 1) + 1
        vus_p.add(p)
    r.check(
        "chemins de division uniques",
        ", ".join(f"{k} ×{v}" for k, v in sorted(path_doubles.items())) if path_doubles else "oui",
        "oui",
    )
    no_div = [a.number for a in real if not a.division_path]
    if not div_no_disp:
        r.check("articles sans division", "n/a (texte plat, 0 division)")
    elif no_div:
        r.lines.append(f"  · {len(no_div)} article(s) hors division (avant la 1re division) : {no_div[:8]}")
    else:
        r.check("articles sans division", "aucun", "aucun")
    empty = [a.number for a in articles if not a.text]
    r.check("articles au texte vide", empty if empty else "aucun", "aucun")
    if len(real) == 0:
        r.ok = False
        r.lines.append("  ✗ extraction vide : aucun article réel extrait")
    return r
