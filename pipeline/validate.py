"""Validation des invariants du corpus (garde-fou avant bascule ; tests de non-régression).

Les valeurs témoins du C.c.Q. FR viennent de la phase 0 (docs/phase0-structure-epub.md, PLAN §11).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import re

from .model import Article, Division

# Un article « réel » a un numéro numérique (1457, 2926.1). Les pseudo-articles de disposition
# (préliminaire, finales, annexe-1, formulaire-vi, formules…) ne le sont pas.
_NUMERIC = re.compile(r"\d+(?:\.\d+)*$")


def is_disposition(number: str) -> bool:
    return _NUMERIC.fullmatch(number) is None


def numeros_effectifs(a: Article) -> list[str]:
    """Les numéros qu'un article OCCUPE réellement.

    Un label de PLAGE (« 7 et 8 », « 29 à 35 », « 257 à 264 ») est un seul article qui
    occupe plusieurs numéros. `Article.alias_numbers` les porte — c'est le parseur qui les
    calcule, parce que la forme est propre à la langue (`à`/`to`, `et`/`and`).

    ⚠️ SANS CETTE EXPANSION, LES CONTRÔLES DE LACUNES REFUSENT L'INGESTION. Mesuré le
    2026-09-11 : 16 des 36 combinaisons fédérales échouaient sur « lacunes dans la plage
    entière » — [7, 8] pour la L.F.I., [29..35] pour la Loi sur les Cours fédérales,
    [9, 10, 11] pour les Règles des Cours fédérales. Ce ne sont PAS des lacunes : ces
    numéros existent, portés par un article dont le label est une plage.

    Et sans elle, `is_disposition` classe « 7 et 8 » comme pseudo-article, donc le décompte
    d'articles réels sous-estime, et le contrôle de doublons ne l'inspecte même pas.
    """
    return a.alias_numbers or [a.number]

# Invariants attendus, par (law_id, lang). FR et EN d'une même loi partagent les mêmes
# décomptes (même loi, traduite) — seul le texte diffère.
_CCQ = {
    "articles_real": 3523,          # articles se: (hors dispositions)
    "int_min": 1, "int_max": 3168,  # entiers complets 1..3168
    "decimals": 355,                # 351 à un niveau + 4 à deux niveaux
    "divisions": 800,
    "div_by_kind": {"livre": 10, "titre": 45, "chapitre": 160, "section": 270,
                     "sous-section": 213, "niveau6": 86, "niveau7": 13, "niveau8": 3},
    "repealed_articles": 68,
    # 4 divisions abrogées : 2 sections + 1 chapitre (phase 0, niveaux ga-gd) + 1 sous-section
    # « § 8 » (ge:l_8, Livre 5) que le scan ga-gd de la phase 0 n'avait pas comptée.
    "repealed_divisions": 4,
    "dispositions": 2,              # préliminaire + finales
}
_CPC = {
    "articles_real": 876,
    "int_min": 1, "int_max": 836,
    "decimals": 40,
    "divisions": 307,
    "div_by_kind": {"livre": 8, "titre": 30, "chapitre": 129, "section": 123, "sous-section": 17},
    "repealed_articles": 1,
    "repealed_divisions": 0,
    "dispositions": 2,             # préliminaire + annexe (les « finales » sont des articles réels du Livre VIII)
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

    def check(self, label: str, got, expected=None):
        if expected is None:
            self.lines.append(f"  · {label}: {got}")
        else:
            ok = got == expected
            self.ok &= ok
            self.lines.append(f"  {'✓' if ok else '✗'} {label}: {got}" + ("" if ok else f"  (attendu {expected})"))


def validate(law_id: str, lang: str, divisions: list[Division], articles: list[Article],
             jurisdiction: str = "qc", numeros_refuses: list[str] | None = None) -> Report:
    """Invariants du corpus. `jurisdiction` est PASSÉE, jamais devinée du préfixe d'id.

    Renifler « ca- » au début d'un identifiant serait exactement la chirurgie de chaîne
    qui a déjà produit le défaut `B-1` ⊂ `B-1.1` de `parseCitation`.
    """
    r = Report()
    # Un article de PLAGE est réel : il occupe plusieurs numéros, tous numériques. On juge
    # donc sur les numéros EFFECTIFS, pas sur le label brut.
    real = [a for a in articles
            if not all(is_disposition(n) for n in numeros_effectifs(a))]
    disp = [a for a in articles
            if all(is_disposition(n) for n in numeros_effectifs(a))]
    # Tous les numéros occupés, plages expansées. C'est CE jeu que les contrôles de lacunes
    # et de doublons doivent voir.
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

    # lacunes / doublons dans la plage entière
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
        r.check("articles se:", len(real), exp["articles_real"])
        r.check("entiers min/max", (r.stats["int_min"], r.stats["int_max"]), (exp["int_min"], exp["int_max"]))
        r.check("entiers complets (nb)", len(ints), exp["int_max"] - exp["int_min"] + 1)
        r.check("décimaux", len(decimals), exp["decimals"])
        r.check("divisions", len(div_no_disp), exp["divisions"])
        r.check("divisions par type", by_kind, exp["div_by_kind"])
        r.check("articles abrogés", r.stats["repealed_articles"], exp["repealed_articles"])
        r.check("divisions abrogées", r.stats["repealed_divisions"], exp["repealed_divisions"])
        r.check("dispositions (pseudo-articles)", len(disp), exp["dispositions"])
    else:
        r.check("articles se:", len(real))
        r.check("entiers min/max", (r.stats["int_min"], r.stats["int_max"]))
        r.check("divisions", len(div_no_disp))
        r.check("divisions par type", by_kind)

    # invariants structurels (toutes lois)
    #
    # LES LACUNES NE SONT PAS UN INVARIANT DU CORPUS FÉDÉRAL, et c'est mesuré.
    #
    # Le RLRQ laisse un jalon « (Abrogé) » à la place d'une disposition abrogée : la plage
    # entière reste donc dense, et une lacune y signale un défaut d'extraction. La
    # codification fédérale, elle, RETIRE la disposition. Exemple mesuré sur la Loi sur la
    # concurrence : les art. 37, 41, 42, 43 et 44 n'existent dans AUCUNE Section du fichier,
    # et les art. 38, 39 et 40 n'y existent qu'en position REFUSÉE (non en vigueur).
    #
    # Garder le contrôle bloquant aurait un effet pervers exact : pour « combler » la
    # lacune, il faudrait ingérer les art. 38 à 40, c'est-à-dire du droit NON EN VIGUEUR.
    # Le contrôle pousserait donc à la faute qu'il est censé prévenir.
    #
    # Pour le fédéral, la lacune devient donc INFORMATIVE — mais EXPLIQUÉE : chaque numéro
    # manquant est classé « refusé » (non en vigueur, donc légitimement absent) ou « retiré »
    # (absent du fichier). La vraie garantie d'exhaustivité est ailleurs, dans le bilan de
    # matière par provenance de `parser_lims`, qui refuse de rendre un résultat si une seule
    # `Section` du fichier n'a été ni ingérée ni refusée.
    if jurisdiction == "ca":
        refuses = {n for n in (numeros_refuses or []) if n.isdigit()}
        manquants = [int(n) for n in map(str, gaps)]
        par_refus = sorted(n for n in manquants if str(n) in refuses)
        par_retrait = sorted(n for n in manquants if str(n) not in refuses)
        r.check("lacunes (fédéral : informatif)",
                f"{len(manquants)} — non en vigueur (refusés) : {par_refus or 'aucun'} ; "
                f"retirés de la codification : {par_retrait or 'aucun'}")
    else:
        r.check("lacunes dans la plage entière", gaps if gaps else "aucune", "aucune")
    r.check("doublons d'entiers", dups if dups else "aucun", "aucun")
    no_div = [a.number for a in real if not a.division_path]
    if not div_no_disp:
        r.check("articles sans division", "n/a (texte plat, 0 division)")
    elif no_div:  # quelques articles avant la 1re division : signalé, non bloquant
        r.lines.append(f"  · {len(no_div)} article(s) hors division (avant la 1re division) : {no_div[:8]}")
    else:
        r.check("articles sans division", "aucun", "aucun")
    empty = [a.number for a in articles if not a.text]
    r.check("articles au texte vide", empty if empty else "aucun", "aucun")
    return r
