"""Découpage des chemins de divisions — MIROIR de `src/paths.ts`.

⚠️ Le littéral de `SEG_SPLIT` ci-dessous doit rester IDENTIQUE, caractère pour caractère, à
celui de `src/paths.ts`. `tests/paths.test.mjs` compare les deux en lisant les deux sources.
C'est la garde que le miroir `sort_key()` ↔ `sortKeyOf()` n'a jamais eue : personne ne
comparait les deux implémentations, et le commentaire d'échelle de `schema.sql` a décrit
pendant longtemps une TROISIÈME échelle qui n'existait nulle part — qui vérifiait le miroir
contre le schéma concluait que LES DEUX côtés étaient faux.

Deux familles cohabitent dans `divisions.path` — voir l'en-tête de `src/paths.ts` pour le
détail et pour les 120 chemins de production sur lesquels les anciennes conventions
divergeaient.

NE PAS importer ce module depuis `pipeline/parser.py` : le parseur EPUB garde son
`_SEG_SPLIT`, et le SPEC §3.1 interdit de le toucher. `pipeline/parser_lims.py`, lui, DOIT
passer par ici et ne jamais réimplémenter un découpage.
"""
from __future__ import annotations

import re

# Frontière de segment : un `-` SUIVI d'un préfixe de famille connu. Un préfixe inconnu
# n'ouvre PAS un segment, ce qui protège les slugs (`annexe-a`,
# `disposition-preliminaire`) et les valeurs à trait d'union (`gc:l_dix-septieme`).
SEG_SPLIT = re.compile(r"-(?=(?:g[a-z]|fh\d+|fs|fp):)")

# Préfixes de la famille LIMS (fédérale).
_FEDERAL = re.compile(r"^(?:fh\d+|fs|fp):")


def segments(path: str) -> list[str]:
    """Segments d'un chemin, dans l'ordre (racine d'abord)."""
    return SEG_SPLIT.split(path)


def depth(path: str) -> int:
    """Profondeur : `fh1:3-fh2:5` -> 2, `gc:l_dix-septieme` -> 1."""
    return len(segments(path))


def truncate(path: str, d: int) -> str:
    """Tronque à `d` segments. Le résultat est un préfixe qui est lui-même valide."""
    return "-".join(segments(path)[:d])


def parent_path(path: str) -> str | None:
    """Chemin du parent, ou None à la racine.

    Miroir lexical de `pipeline/parser.py::_parent_path`, mais conscient des DEUX familles.
    C'est ce que `load.prepare` résout en `parent_id` : un `None` rendu à tort produit un
    arbre PLAT, sans erreur — `get_structure` annoncerait alors une loi sans hiérarchie.
    """
    segs = segments(path)
    return "-".join(segs[:-1]) if len(segs) > 1 else None


def is_federal(path: str) -> bool:
    """Vrai pour un chemin de la famille LIMS."""
    return bool(_FEDERAL.match(path))
