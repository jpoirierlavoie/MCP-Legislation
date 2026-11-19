"""Reconnaissance de documents PDF (directives judiciaires et instructions AMF) — dry-run.

Pendant de `pipeline/discovery/recon.py` (EPUB) et `pipeline/discovery/recon_lims.py` (LIMS).
N'ÉCRIT RIEN EN BASE, n'utilise NI LLM NI OCR, et refuse explicitement les PDF numérisés
(image seulement), chiffrés ou corrompus (`exit code 2`).

Le rapport Markdown régénérable va par défaut dans `docs/reconnaissance-pdf-courante.md`
(gitignoré) ; le contrat de référence versionné est `docs/phase0-structure-pdf.md`, rédigé
à la main à partir des mesures réelles et cité par `pipeline/parser_pdf.py`.

⚠️ RECENSEMENT SANS LISTE BLANCHE PRÉALABLE : toutes les polices, tailles, marges `x0`,
bandes `y0`, annotations de liens, signets (`outline`/TOC) et formes de numérotation
(y compris alphanumériques CSA/AMF telles `2A.1`, `4B.2`, `1.1.1A`) sont inventoriés.

Emploi :
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_pdf
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_pdf path/to/a.pdf --out docs/reconnaissance-pdf-courante.md
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_pdf path/to/a.pdf --format json --json-out out.json
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    import pymupdf
except ImportError:  # pragma: no cover - exercé en CI sans pymupdf
    pymupdf = None  # type: ignore[assignment]

from pipeline import config

DEFAULT_REPORT = config.REPO_ROOT / "docs" / "reconnaissance-pdf-courante.md"
_SUBSET_FONT_RE = re.compile(r"^[A-Z]{6}\+")

# Seuils explicites de reconnaissance (paramètres de mesure documentés)
Y_LINE_TOLERANCE_PT = 2.5
X0_CLUSTER_TOLERANCE_PT = 2.0
TOP_BAND_RATIO = 0.12
BOTTOM_BAND_RATIO = 0.88

# Motifs de numérotation et structure en début de ligne (après _norm)
_PROVISION_PREFIX_SRC = (
    r"(?:\d+[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)*|"
    r"\d+(?:\.\d+)*(?:[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)*)?)"
)
_HISTORY_RE = re.compile(r"^(?:Modifications?|Abrogation)\s*:", re.I)
_INLINE_REPEAL_RE = re.compile(
    rf"^{_PROVISION_PREFIX_SRC}\.?\s+"
    r"(?:Abrog[ée]\.?|Abrogation\.|Repealed\.?|\[\s*(?:…|\.\.\.)\s*\])(?:\s|$)",
    re.I,
)
_STANDALONE_REPEAL_RE = re.compile(
    r"^(?:Abrog[ée]\.?|Abrogation\.|Repealed\.?|\[\s*(?:…|\.\.\.)\s*\])(?:\s|$)",
    re.I,
)
_ORDINAL_SUFFIXES = frozenset(
    {"er", "re", "ère", "ères", "e", "ème", "èmes", "st", "nd", "rd", "th"}
)
_ALPHANUM_DOT_RE = re.compile(
    r"^(?P<num>(?:\d+[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)+|"
    r"\d+(?:\.\d+)+[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)*))\.?(?=\s|$)"
)
_ALPHANUM_DELIM_RE = re.compile(r"^(?P<num>\d+(?P<letters>[A-Za-z]+))[.):](?=\s|$)")
_NUMERIC_RE = re.compile(r"^(?P<num>\d+(?:\.\d+)*)(?P<dot>\.?)(?=\s|$)")
_BAD_NUMERIC_UNIT_RE = re.compile(
    r"^(?:[%$€£]|[-–—](?:\s|\d|$)|"
    r"(?:er|re|ère|ères|ème|èmes|st|nd|rd|th|h|heures?|jours?|mois|ans?|années?|"
    r"semaines?|minutes?|pages?|p\.|csc|qcca|qccs|qccq|rcs|r\.c\.s\.|s\.c\.r\.|d\.l\.r\.)"
    r"(?:\b|(?=\s|$|[.,;:])))",
    re.I,
)
_BAD_NUMERIC_LOWER_PROSE_RE = re.compile(
    r"^(?:ou|et|or|and|doit|peut|est|sont|sera|seront|ne|à|au|aux|de|du|des|"
    r"pour|dans|sur|avec|sans|par|qui|que|dont|où|si)\b"
)
_SUBITEM_NUM_RE = re.compile(r"^(?P<num>(?:\(\d{1,3}\)|\d{1,3}°))(?=\s|$)")
_SUBITEM_ROMAN_RE = re.compile(
    r"^(?P<num>(?:\((?:ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv)\)|"
    r"(?:ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv)\)))(?=\s|$)",
    re.I,
)
_SUBITEM_ALPHA_RE = re.compile(r"^(?P<num>(?:\([a-z]\)|[a-z][).]))(?=\s|$)")
_BULLET_RE = re.compile(r"^(?P<num>[•●○▪▫■□–—-])(?=\s)")
_DIVISION_RE = re.compile(
    r"^(?P<kind>PARTIE|Partie|PART|Part|SOUS-SECTION|Sous-section|SUBSECTION|Subsection|"
    r"SECTION|Section|CHAPITRE|Chapitre|CHAPTER|Chapter|TITRE|Titre|TITLE|Title|"
    r"DIVISION|Division|LIVRE|Livre|BOOK|Book|ANNEXE|Annexe|ANNEX|Annex|"
    r"SCHEDULE|Schedule|APPENDICE|Appendice|APPENDIX|Appendix|FORMULAIRE|Formulaire|FORM|Form)"
    r"\b(?!\s*\d+\))(?P<rest>.*)$"
)
_CONSOL_DATE_RE = re.compile(
    r"(?:À\s+jour\s+au|A\s+jour\s+au|Mise\s+à\s+jour\s*:?|Updated\s+(?:to|as\s+of)|"
    r"En\s+vigueur\s+(?:le|au)|Effective\s+(?:date)?\s*:?)\s+[^\n;]+",
    re.I,
)
_REPEAL_RE = re.compile(
    r"(?:\bAbrog[ée]\.?|\bAbrogation\.|\bRepealed\.?|\[\s*…\s*\]|\[\s*\.\.\.\s*\])",
    re.I,
)

# Codes de drapeaux PyMuPDF (span["flags"])
_FLAG_BITS: tuple[tuple[int, str], ...] = (
    (1 << 0, "superscript"),
    (1 << 1, "italic"),
    (1 << 2, "serif"),
    (1 << 3, "mono"),
    (1 << 4, "bold"),
)


class PdfReconError(Exception):
    """Erreur explicite de reconnaissance PDF (zéro contournement)."""


class MissingDependencyError(PdfReconError, RuntimeError):
    """Levée lorsque `pymupdf` n'est pas installé."""


class ScannedPdfError(PdfReconError, ValueError):
    """Levée lorsqu'un PDF est vide ou numérisé (image seulement, zéro OCR)."""


class EncryptedPdfError(PdfReconError, PermissionError):
    """Levée lorsqu'un PDF exige un mot de passe."""


class CorruptPdfError(PdfReconError, RuntimeError):
    """Levée lorsqu'un PDF est corrompu ou illisible."""


def _norm(text: str) -> str:
    """Normalise les espaces Unicode (`Zs`) tout en préservant `’` et accents (parité parser.py)."""
    cleaned = "".join(" " if unicodedata.category(c) == "Zs" else c for c in text)
    cleaned = re.sub(r"[ \t\r\f\v]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def audit_unicode_zs(text: str) -> dict[str, int]:
    """Compte les caractères Unicode de catégorie `Zs` autres que l'espace ASCII."""
    counts: collections.Counter[str] = collections.Counter()
    for ch in text:
        if ch != " " and unicodedata.category(ch) == "Zs":
            counts[f"U+{ord(ch):04X}"] += 1
    return dict(sorted(counts.items()))


def strip_font_subset(font_name: str) -> str:
    """Retire le préfixe de sous-ensemble `ABCDEF+` tout en conservant le nom brut ailleurs."""
    return _SUBSET_FONT_RE.sub("", font_name or "")


def decode_font_flags(flags: int) -> list[str]:
    """Décode le champ binaire `span['flags']` de PyMuPDF."""
    return [name for bit, name in _FLAG_BITS if flags & bit]


def normalize_band_text(text: str) -> str:
    """Normalise un bandeau potentiel en remplaçant les nombres par `<N>` pour détecter les répétitions."""
    normed = _norm(text)
    normed = re.sub(r"\b\d+\b", "<N>", normed)
    return normed.strip()


@dataclass
class SpanRecord:
    page: int  # 1-indexed
    x0: float
    y0: float
    x1: float
    y1: float
    font: str
    base_font: str
    size: float
    flags: int
    text: str
    norm_text: str


@dataclass
class LineRecord:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    norm_text: str
    spans: list[SpanRecord] = field(default_factory=list)


def reconstruct_lines(spans: list[SpanRecord], y_tolerance: float = Y_LINE_TOLERANCE_PT) -> list[LineRecord]:
    """Regroupe les spans d'une page en lignes visuelles par tolérance verticale `y0`.

    Ancre `anchor_y` sur les spans de ligne de base (hors exposants `flags & 1`) afin qu'un
    exposant rehaussé ne décale pas la fenêtre de tolérance ni n'insère d'espace parasite.
    """
    if not spans:
        return []

    baseline_spans = [s for s in spans if not (s.flags & 1)]
    sup_spans = [s for s in spans if (s.flags & 1)]
    if not baseline_spans:
        baseline_spans = list(spans)
        sup_spans = []

    ordered = sorted(baseline_spans, key=lambda s: (s.y0, s.x0))
    groups: list[list[SpanRecord]] = [[ordered[0]]]
    group_anchors: list[float] = [ordered[0].y0]

    for sp in ordered[1:]:
        anchor_y = group_anchors[-1]
        if abs(sp.y0 - anchor_y) <= y_tolerance:
            current = groups[-1]
            current.append(sp)
            # Préférer la coordonnée `y0` des spans de taille dominante du groupe
            max_sz = max(s.size for s in current)
            dom = [s.y0 for s in current if s.size >= 0.8 * max_sz]
            if dom:
                group_anchors[-1] = dom[0]
        else:
            groups.append([sp])
            group_anchors.append(sp.y0)

    # Rattacher chaque exposant au groupe de ligne le plus proche dans `y_tolerance`
    for sp in sorted(sup_spans, key=lambda s: (s.y0, s.x0)):
        best_idx: int | None = None
        best_dist = y_tolerance + 1e-6
        for idx, anchor_y in enumerate(group_anchors):
            dist = abs(sp.y0 - anchor_y)
            if dist <= y_tolerance and dist < best_dist:
                best_dist = dist
                best_idx = idx
        if best_idx is not None:
            groups[best_idx].append(sp)
        else:
            groups.append([sp])
            group_anchors.append(sp.y0)

    # Trier les groupes verticalement selon leur ancre de ligne de base
    paired = sorted(zip(group_anchors, groups), key=lambda item: (item[0], min(s.x0 for s in item[1])))

    lines: list[LineRecord] = []
    for _, grp in paired:
        grp_sorted = sorted(grp, key=lambda s: (s.x0, s.y0))
        pieces: list[str] = []
        prev_x1: float | None = None
        prev_text = ""
        prev_is_sup = False
        prev_size = 0.0
        for sp in grp_sorted:
            t = sp.text
            if not t:
                continue
            cur_is_sup = bool(sp.flags & 1)
            if pieces and prev_x1 is not None:
                gap = sp.x0 - prev_x1
                if not prev_text[-1:].isspace() and not t[:1].isspace():
                    if cur_is_sup:
                        # Ne pas insérer d'espace avant un exposant collé (`1` + `er` -> `1er`)
                        if gap > max(4.0, 0.45 * max(prev_size, 6.0)):
                            pieces.append(" ")
                    elif prev_is_sup:
                        # Préserver l'espace après un exposant devant un mot (`1er` + `janvier` -> `1er janvier`)
                        if t[:1].isalnum() and gap > 0.4:
                            pieces.append(" ")
                    else:
                        min_size = max(sp.size, 6.0)
                        if gap > max(1.5, 0.15 * min_size):
                            pieces.append(" ")
            pieces.append(t)
            prev_x1 = sp.x1
            prev_text = t
            prev_is_sup = cur_is_sup
            prev_size = sp.size
        raw_line = "".join(pieces)
        norm_line = _norm(raw_line)
        lines.append(
            LineRecord(
                page=grp_sorted[0].page,
                x0=min(s.x0 for s in grp_sorted),
                y0=min(s.y0 for s in grp_sorted),
                x1=max(s.x1 for s in grp_sorted),
                y1=max(s.y1 for s in grp_sorted),
                text=raw_line,
                norm_text=norm_line,
                spans=grp_sorted,
            )
        )
    return lines


def cluster_x0(
    entries: list[dict[str, Any]] | list[float],
    tolerance: float = X0_CLUSTER_TOLERANCE_PT,
) -> list[dict[str, Any]]:
    """Regroupe les positions horizontales `x0` dans une tolérance en points (`±tolerance`).

    `entries` peut être soit une liste de flottants, soit une liste de dicts contenant
    `x0`, `font`, `size`, `text`. Retourne les clusters triés par `x0_median` croissant.
    """
    if not entries:
        return []

    normalized_entries: list[dict[str, Any]] = []
    for item in entries:
        if isinstance(item, (int, float)):
            normalized_entries.append({"x0": float(item), "font": "", "size": 0.0, "text": ""})
        else:
            normalized_entries.append(
                {
                    "x0": float(item["x0"]),
                    "font": str(item.get("font", "")),
                    "size": float(item.get("size", 0.0)),
                    "text": str(item.get("text", "")),
                }
            )

    normalized_entries.sort(key=lambda e: e["x0"])
    clusters: list[list[dict[str, Any]]] = [[normalized_entries[0]]]
    anchor = normalized_entries[0]["x0"]

    for entry in normalized_entries[1:]:
        if abs(entry["x0"] - anchor) <= tolerance:
            clusters[-1].append(entry)
        else:
            clusters.append([entry])
            anchor = entry["x0"]

    summary: list[dict[str, Any]] = []
    for cl in clusters:
        xs = sorted(e["x0"] for e in cl)
        median_x0 = round(xs[len(xs) // 2], 2)
        fonts: collections.Counter[str] = collections.Counter()
        samples: list[str] = []
        seen_samples: set[str] = set()
        for e in cl:
            if e["font"] or e["size"]:
                fonts[f"{e['font']}@{round(e['size'], 1)}pt"] += 1
            txt = e["text"].strip()
            if txt and txt not in seen_samples and len(samples) < 4:
                seen_samples.add(txt)
                samples.append(txt[:90])
        summary.append(
            {
                "x0_median": median_x0,
                "x0_min": round(xs[0], 2),
                "x0_max": round(xs[-1], 2),
                "count": len(cl),
                "fonts": dict(fonts.most_common(5)),
                "samples": samples,
            }
        )
    return summary


def detect_y0_bands(
    page_lines: list[dict[str, Any]],
    page_count: int,
    page_heights: dict[int, float] | float,
    top_ratio: float = TOP_BAND_RATIO,
    bottom_ratio: float = BOTTOM_BAND_RATIO,
) -> dict[str, Any]:
    """Détecte les bandeaux d'en-tête (`y0 <= 0.12*H`) et pied de page (`y1 >= 0.88*H`).

    Un bandeau est confirmé s'il se répète sur au moins `max(2, page_count // 2)` pages
    après normalisation des chiffres. Les lignes en bordure sur des documents d'une seule
    page ou sous le seuil sont exposées comme candidates sans faux positifs.
    """
    threshold = max(2, page_count // 2) if page_count > 1 else 2

    def _height_for(page_num: int) -> float:
        if isinstance(page_heights, (int, float)):
            return float(page_heights)
        return float(page_heights.get(page_num, 792.0))

    top_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    bottom_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)

    for ln in page_lines:
        page_num = int(ln["page"])
        h = _height_for(page_num)
        if h <= 0:
            continue
        txt = _norm(str(ln.get("text", "")))
        if not txt:
            continue
        y0 = float(ln["y0"])
        y1 = float(ln["y1"])
        sig = normalize_band_text(txt)
        record = {
            "page": page_num,
            "y0": round(y0, 2),
            "y1": round(y1, 2),
            "text": txt,
            "sig": sig,
        }
        if y0 <= top_ratio * h:
            top_groups[sig].append(record)
        elif y1 >= bottom_ratio * h:
            bottom_groups[sig].append(record)

    def _summarize(groups: dict[str, list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        repeating: list[dict[str, Any]] = []
        candidates: list[dict[str, Any]] = []
        for sig, items in sorted(groups.items(), key=lambda kv: (-len({x["page"] for x in kv[1]}), kv[0])):
            pages = sorted({x["page"] for x in items})
            entry = {
                "pattern": sig,
                "pages": pages,
                "page_count": len(pages),
                "y0_min": min(x["y0"] for x in items),
                "y1_max": max(x["y1"] for x in items),
                "sample": items[0]["text"][:100],
            }
            if len(pages) >= threshold:
                repeating.append(entry)
            else:
                candidates.append(entry)
        return repeating, candidates

    rep_top, cand_top = _summarize(top_groups)
    rep_bot, cand_bot = _summarize(bottom_groups)
    return {
        "threshold_pages": threshold,
        "repeating_headers": rep_top,
        "repeating_footers": rep_bot,
        "edge_candidates_top": cand_top,
        "edge_candidates_bottom": cand_bot,
    }


def classify_line_pattern(line_text: str) -> dict[str, Any]:
    """Classe une ligne normalisée selon les motifs structurels de début de ligne."""
    txt = _norm(line_text)
    if not txt:
        return {"kind": "empty", "token": None}

    if _HISTORY_RE.match(txt):
        return {"kind": "history", "token": None, "sample": txt[:100]}

    m_div = _DIVISION_RE.match(txt)
    if m_div:
        return {"kind": "division", "token": m_div.group("kind").upper(), "sample": txt[:100]}

    if _INLINE_REPEAL_RE.match(txt) or _STANDALONE_REPEAL_RE.match(txt):
        return {"kind": "repeal", "token": None, "sample": txt[:100]}

    m_ad = _ALPHANUM_DOT_RE.match(txt)
    if m_ad:
        rest = txt[m_ad.end() :].strip()
        if not (rest and (_BAD_NUMERIC_UNIT_RE.match(rest) or _BAD_NUMERIC_LOWER_PROSE_RE.match(rest))):
            return {"kind": "alphanumeric", "token": m_ad.group("num"), "sample": txt[:100]}

    m_ax = _ALPHANUM_DELIM_RE.match(txt)
    if m_ax and m_ax.group("letters").lower() not in _ORDINAL_SUFFIXES:
        return {"kind": "alphanumeric", "token": m_ax.group("num"), "sample": txt[:100]}

    m_num = _NUMERIC_RE.match(txt)
    if m_num:
        num = m_num.group("num")
        has_dot = bool(m_num.group("dot"))
        rest = txt[m_num.end() :].strip()
        is_bare_year = "." not in num and not has_dot and len(num) == 4 and 1800 <= int(num) <= 2199
        if (
            rest
            and not is_bare_year
            and not _BAD_NUMERIC_UNIT_RE.match(rest)
            and not _BAD_NUMERIC_LOWER_PROSE_RE.match(rest)
        ):
            if not (not has_dot and rest[0].islower()):
                return {"kind": "numeric", "token": num, "sample": txt[:100]}

    m_snum = _SUBITEM_NUM_RE.match(txt)
    if m_snum:
        return {"kind": "subitem_num", "token": m_snum.group("num"), "sample": txt[:100]}

    m_srom = _SUBITEM_ROMAN_RE.match(txt)
    if m_srom:
        return {"kind": "subitem_roman", "token": m_srom.group("num"), "sample": txt[:100]}

    m_salp = _SUBITEM_ALPHA_RE.match(txt)
    if m_salp:
        return {"kind": "subitem_alpha", "token": m_salp.group("num"), "sample": txt[:100]}

    m_bul = _BULLET_RE.match(txt)
    if m_bul:
        return {"kind": "bullet", "token": m_bul.group("num"), "sample": txt[:100]}

    if _REPEAL_RE.search(txt):
        return {"kind": "repeal", "token": None, "sample": txt[:100]}

    if _CONSOL_DATE_RE.search(txt):
        return {"kind": "consolidation_date", "token": None, "sample": txt[:100]}

    return {"kind": "prose", "token": None, "sample": txt[:100]}


def _rect_intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def normalize_target_page(raw_target: Any) -> int | None:
    """Convertit un index de page cible PyMuPDF (0-indexé) en numéro 1-indexé, ou `None` si < 0."""
    if isinstance(raw_target, int) and not isinstance(raw_target, bool) and raw_target >= 0:
        return int(raw_target) + 1
    return None


def _link_kind_name(kind: int) -> str:
    if pymupdf is None:
        return str(kind)
    mapping = {
        getattr(pymupdf, "LINK_NONE", 0): "LINK_NONE",
        getattr(pymupdf, "LINK_GOTO", 1): "LINK_GOTO",
        getattr(pymupdf, "LINK_URI", 2): "LINK_URI",
        getattr(pymupdf, "LINK_LAUNCH", 3): "LINK_LAUNCH",
        getattr(pymupdf, "LINK_NAMED", 4): "LINK_NAMED",
        getattr(pymupdf, "LINK_GOTOR", 5): "LINK_GOTOR",
    }
    return mapping.get(kind, f"LINK_{kind}")


def inspect_pdf(path: Path | str) -> dict[str, Any]:
    """Inspecte un fichier PDF avec PyMuPDF sans OCR ni LLM et retourne l'inventaire complet."""
    if pymupdf is None:
        raise MissingDependencyError(
            "Le module `pymupdf` est requis pour inspecter un PDF (`uv pip install -r pipeline/requirements.txt`)."
        )

    pdf_path = Path(path)
    if not pdf_path.is_file():
        raise FileNotFoundError(f"Fichier PDF introuvable : {pdf_path}")

    raw_bytes = pdf_path.read_bytes()
    file_size = len(raw_bytes)
    sha256 = hashlib.sha256(raw_bytes).hexdigest()

    if file_size == 0:
        raise CorruptPdfError(f"Fichier PDF vide (0 octet) : {pdf_path}")

    empty_err = getattr(pymupdf, "EmptyFileError", RuntimeError)
    data_err = getattr(pymupdf, "FileDataError", RuntimeError)
    try:
        doc = pymupdf.open(str(pdf_path))
    except (empty_err, data_err, RuntimeError) as exc:
        raise CorruptPdfError(f"PDF corrompu ou illisible ({pdf_path.name}) : {exc}") from exc

    try:
        if doc.is_encrypted and doc.needs_pass:
            raise EncryptedPdfError(f"PDF chiffré protégé par mot de passe : {pdf_path.name}")

        page_count = doc.page_count
        if page_count == 0:
            raise ScannedPdfError(f"PDF sans aucune page (0 page) : {pdf_path.name}")

        metadata = dict(doc.metadata or {})
        toc_raw = doc.get_toc(simple=False)
        toc_entries = [
            {
                "level": int(item[0]),
                "title": _norm(str(item[1])),
                "page": int(item[2]),
                "dest_kind": _link_kind_name(item[3].get("kind", 0)) if len(item) > 3 and isinstance(item[3], dict) else None,
            }
            for item in toc_raw
        ]

        extract_flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES

        all_spans: list[SpanRecord] = []
        all_lines: list[LineRecord] = []
        page_heights: dict[int, float] = {}
        page_dims: collections.Counter[str] = collections.Counter()
        page_stats: list[dict[str, Any]] = []
        image_only_pages: list[int] = []
        raw_links: list[dict[str, Any]] = []
        total_images = 0
        total_non_ws_chars = 0
        replacement_chars = 0
        zs_counts: collections.Counter[str] = collections.Counter()

        for p_idx in range(page_count):
            page = doc[p_idx]
            page_num = p_idx + 1
            rect = page.rect
            page_dims[f"{round(rect.width, 2)}x{round(rect.height, 2)}"] += 1

            images = page.get_images(full=True)
            img_count = len(images)
            total_images += img_count

            p_dict = page.get_text("dict", flags=extract_flags)
            # get_text("dict") émet les bbox dans le repère non pivoté (p_dict["height"] / cropbox)
            span_space_height = float(p_dict.get("height") or page.cropbox.height or rect.height)
            page_heights[page_num] = span_space_height
            page_spans: list[SpanRecord] = []
            page_non_ws = 0
            page_repl = 0

            for block in p_dict.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    for sp in line.get("spans", []):
                        raw_txt = str(sp.get("text", ""))
                        non_ws = sum(1 for ch in raw_txt if not ch.isspace())
                        page_non_ws += non_ws
                        page_repl += raw_txt.count("\ufffd")
                        for k_zs, v_zs in audit_unicode_zs(raw_txt).items():
                            zs_counts[k_zs] += v_zs
                        bbox = sp.get("bbox", (0.0, 0.0, 0.0, 0.0))
                        font_raw = str(sp.get("font", ""))
                        page_spans.append(
                            SpanRecord(
                                page=page_num,
                                x0=float(bbox[0]),
                                y0=float(bbox[1]),
                                x1=float(bbox[2]),
                                y1=float(bbox[3]),
                                font=font_raw,
                                base_font=strip_font_subset(font_raw),
                                size=float(sp.get("size", 0.0)),
                                flags=int(sp.get("flags", 0)),
                                text=raw_txt,
                                norm_text=_norm(raw_txt),
                            )
                        )

            total_non_ws_chars += page_non_ws
            replacement_chars += page_repl
            all_spans.extend(page_spans)

            reconstructed = reconstruct_lines(page_spans)
            all_lines.extend(reconstructed)

            is_image_only = img_count > 0 and page_non_ws < 10
            if is_image_only:
                image_only_pages.append(page_num)

            # Inventaire des annotations de liens avec ancrage texte par chevauchement de bbox
            for lnk in page.get_links():
                kind_int = int(lnk.get("kind", 0))
                kind_name = _link_kind_name(kind_int)
                from_rect = lnk.get("from")
                if from_rect is not None:
                    match_rect = from_rect * page.derotation_matrix if page.rotation else from_rect
                    r_tuple = (
                        float(match_rect.x0),
                        float(match_rect.y0),
                        float(match_rect.x1),
                        float(match_rect.y1),
                    )
                    anchor_spans = [
                        sp.norm_text
                        for sp in page_spans
                        if sp.norm_text and _rect_intersects(r_tuple, (sp.x0, sp.y0, sp.x1, sp.y1))
                    ]
                    anchor = _norm(" ".join(anchor_spans))
                    from_box = [round(v, 2) for v in (float(from_rect.x0), float(from_rect.y0), float(from_rect.x1), float(from_rect.y1))]
                else:
                    anchor = ""
                    from_box = []

                raw_target = lnk.get("page")
                norm_target = normalize_target_page(raw_target)
                raw_links.append(
                    {
                        "page": page_num,
                        "kind": kind_name,
                        "uri": lnk.get("uri"),
                        "target_page": norm_target,
                        "file": lnk.get("file"),
                        "from": from_box,
                        "anchor_text": anchor[:120],
                    }
                )

            page_stats.append(
                {
                    "page": page_num,
                    "width": round(float(rect.width), 2),
                    "height": round(float(rect.height), 2),
                    "rotation": int(page.rotation),
                    "spans": len(page_spans),
                    "lines": len(reconstructed),
                    "non_ws_chars": page_non_ws,
                    "images": img_count,
                    "image_only": is_image_only,
                    "replacement_chars": page_repl,
                }
            )

        avg_non_ws_per_page = total_non_ws_chars / page_count
        if (
            total_non_ws_chars == 0
            or (total_images > 0 and avg_non_ws_per_page < 10.0)
            or len(image_only_pages) == page_count
            or len(image_only_pages) > page_count / 2
        ):
            raise ScannedPdfError(
                f"PDF numérisé ou sans couche texte exploitable refusé (zéro OCR) : "
                f"{pdf_path.name} ({page_count} p., {total_non_ws_chars} car. non-blancs, "
                f"{total_images} images, pages image seulement={image_only_pages})"
            )

        warnings: list[str] = []
        if image_only_pages:
            warnings.append(
                f"Numérisation partielle détectée : {len(image_only_pages)} page(s) image seulement "
                f"sans couche texte exploitable (pages {image_only_pages})."
            )

        # Inventaire complet des polices
        font_acc: dict[tuple[str, str, float, int], dict[str, Any]] = {}
        for sp in all_spans:
            key = (sp.font, sp.base_font, round(sp.size, 2), sp.flags)
            if key not in font_acc:
                font_acc[key] = {
                    "raw_font": sp.font,
                    "base_font": sp.base_font,
                    "size": round(sp.size, 2),
                    "flags": sp.flags,
                    "flags_decoded": decode_font_flags(sp.flags),
                    "spans": 0,
                    "non_ws_chars": 0,
                    "sample": "",
                }
            rec = font_acc[key]
            rec["spans"] += 1
            rec["non_ws_chars"] += sum(1 for ch in sp.text if not ch.isspace())
            if not rec["sample"] and sp.norm_text:
                rec["sample"] = sp.norm_text[:80]

        fonts_inventory = sorted(
            font_acc.values(),
            key=lambda f: (-f["spans"], f["base_font"], f["size"]),
        )

        # Détection des bandeaux y0 (en-têtes/pieds) avant le clustering x0 du corps
        band_input = [
            {"page": ln.page, "y0": ln.y0, "y1": ln.y1, "text": ln.text}
            for ln in all_lines
            if ln.norm_text
        ]
        bands = detect_y0_bands(band_input, page_count=page_count, page_heights=page_heights)
        repeating_header_sigs = {b["pattern"] for b in bands["repeating_headers"]}
        repeating_footer_sigs = {b["pattern"] for b in bands["repeating_footers"]}

        # Clustering x0 sur les lignes non vides (et hors bandeaux répétés)
        x0_all_entries: list[dict[str, Any]] = []
        x0_body_entries: list[dict[str, Any]] = []
        for ln in all_lines:
            if not ln.norm_text:
                continue
            first_non_ws = next((sp for sp in ln.spans if sp.norm_text), ln.spans[0])
            entry = {
                "x0": first_non_ws.x0,
                "font": first_non_ws.base_font,
                "size": first_non_ws.size,
                "text": ln.norm_text,
            }
            x0_all_entries.append(entry)
            h = page_heights[ln.page]
            sig = normalize_band_text(ln.text)
            is_rep_hdr = ln.y0 <= TOP_BAND_RATIO * h and sig in repeating_header_sigs
            is_rep_ftr = ln.y1 >= BOTTOM_BAND_RATIO * h and sig in repeating_footer_sigs
            if not is_rep_hdr and not is_rep_ftr:
                x0_body_entries.append(entry)

        x0_clusters = cluster_x0(x0_body_entries)

        # Inventaire des motifs de début de ligne, dates de consolidation, abrogations, et bilan des spans
        pattern_counts: collections.Counter[str] = collections.Counter()
        pattern_samples: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        consolidation_dates: list[dict[str, Any]] = []
        seen_dates: set[str] = set()
        repeal_hits: list[dict[str, Any]] = []

        span_buckets: collections.Counter[str] = collections.Counter(
            {
                "running_header": 0,
                "running_footer": 0,
                "consolidation_date": 0,
                "whitespace_only": 0,
                "heading_or_division": 0,
                "numbered_provision": 0,
                "subitem": 0,
                "history": 0,
                "repeal_marker": 0,
                "body_text": 0,
                "unclassified": 0,
            }
        )

        # Taille dominante du corps pour détecter les titres typographiques
        non_band_font_chars: collections.Counter[float] = collections.Counter()
        for ln in all_lines:
            h = page_heights[ln.page]
            sig = normalize_band_text(ln.text)
            if (ln.y0 <= TOP_BAND_RATIO * h and sig in repeating_header_sigs) or (
                ln.y1 >= BOTTOM_BAND_RATIO * h and sig in repeating_footer_sigs
            ):
                continue
            for sp in ln.spans:
                if sp.norm_text:
                    non_band_font_chars[round(sp.size, 1)] += len(sp.norm_text)
        body_size = non_band_font_chars.most_common(1)[0][0] if non_band_font_chars else 11.0

        # Marge gauche dominante des dispositions numérotées (`provision_x0`) pour distinguer
        # les dispositions de premier niveau des sous-items indentés et renvois en cours de ligne
        prov_x0_candidates: list[float] = []
        for ln in all_lines:
            if not ln.norm_text:
                continue
            h = page_heights[ln.page]
            sig = normalize_band_text(ln.text)
            if (ln.y0 <= TOP_BAND_RATIO * h and sig in repeating_header_sigs) or (
                ln.y1 >= BOTTOM_BAND_RATIO * h and sig in repeating_footer_sigs
            ):
                continue
            first_non_ws = next((sp for sp in ln.spans if sp.norm_text), ln.spans[0])
            if first_non_ws.size < body_size - 2.0:
                continue
            pat0 = classify_line_pattern(ln.norm_text)
            if pat0["kind"] in ("numeric", "alphanumeric") or (
                pat0["kind"] == "repeal" and ln.norm_text[:1].isdigit()
            ):
                prov_x0_candidates.append(first_non_ws.x0)

        provision_x0: float | None = None
        if prov_x0_candidates:
            prov_clusters = cluster_x0(prov_x0_candidates, tolerance=3.0)
            best_cl = max(prov_clusters, key=lambda c: (c["count"], -c["x0_median"]))
            if best_cl["count"] >= 2 or len(prov_x0_candidates) == 1:
                provision_x0 = float(best_cl["x0_median"])

        for ln in all_lines:
            h = page_heights[ln.page]
            sig = normalize_band_text(ln.text)
            is_rep_hdr = ln.y0 <= TOP_BAND_RATIO * h and sig in repeating_header_sigs
            is_rep_ftr = ln.y1 >= BOTTOM_BAND_RATIO * h and sig in repeating_footer_sigs

            # Capture des dates de consolidation même dans un bandeau
            if ln.norm_text:
                for m_dt in _CONSOL_DATE_RE.finditer(ln.norm_text):
                    dt_str = _norm(m_dt.group(0))
                    if dt_str not in seen_dates:
                        seen_dates.add(dt_str)
                        consolidation_dates.append({"page": ln.page, "text": dt_str})

            if is_rep_hdr:
                line_bucket = "running_header"
            elif is_rep_ftr:
                line_bucket = "running_footer"
            elif not ln.norm_text:
                line_bucket = "whitespace_only"
            else:
                first_non_ws = next((sp for sp in ln.spans if sp.norm_text), ln.spans[0])
                pat = classify_line_pattern(ln.norm_text)
                pkind = pat["kind"]
                if pkind in ("numeric", "alphanumeric"):
                    if first_non_ws.size < body_size - 2.0:
                        # Appel de note / note de bas de page (ex. 6.48 pt)
                        pat = {"kind": "prose", "token": None, "sample": ln.norm_text[:100]}
                        pkind = "prose"
                    elif provision_x0 is not None and provision_x0 + 10.0 < first_non_ws.x0 < 250.0:
                        if re.match(r"^\d+\.\s+", ln.norm_text):
                            pat = {"kind": "subitem_num", "token": pat["token"], "sample": ln.norm_text[:100]}
                            pkind = "subitem_num"
                        else:
                            pat = {"kind": "prose", "token": None, "sample": ln.norm_text[:100]}
                            pkind = "prose"

                pattern_counts[pkind] += 1
                if len(pattern_samples[pkind]) < 15:
                    pattern_samples[pkind].append(
                        {"page": ln.page, "token": pat["token"], "line": ln.norm_text[:120]}
                    )
                if pkind == "repeal" or (pkind != "history" and _REPEAL_RE.search(ln.norm_text)):
                    repeal_hits.append({"page": ln.page, "line": ln.norm_text[:120]})

                if pkind == "division":
                    line_bucket = "heading_or_division"
                elif pkind == "history":
                    line_bucket = "history"
                elif pkind in ("numeric", "alphanumeric"):
                    line_bucket = "numbered_provision"
                elif pkind in ("subitem_num", "subitem_alpha", "subitem_roman", "bullet"):
                    line_bucket = "subitem"
                elif pkind == "repeal":
                    line_bucket = "repeal_marker"
                elif pkind == "consolidation_date":
                    line_bucket = "consolidation_date"
                else:
                    non_ws_sp = [sp for sp in ln.spans if sp.norm_text]
                    all_bold_or_large = bool(non_ws_sp) and all(
                        (
                            ((sp.flags & 16) or ("Bold" in sp.base_font))
                            and round(sp.size, 1) >= body_size - 1.0
                        )
                        or (round(sp.size, 1) >= body_size + 1.5)
                        for sp in non_ws_sp
                    )
                    line_bucket = "heading_or_division" if all_bold_or_large else "body_text"

            for sp in ln.spans:
                if not sp.text.strip():
                    span_buckets["whitespace_only"] += 1
                else:
                    span_buckets[line_bucket] += 1

        total_spans = len(all_spans)
        accounted_spans = sum(span_buckets.values())
        if accounted_spans != total_spans or span_buckets["unclassified"] != 0:
            raise PdfReconError(
                f"Incohérence de bilan de spans sur {pdf_path.name} : "
                f"{accounted_spans} != {total_spans} (non classés={span_buckets['unclassified']})"
            )

        links_summary: collections.Counter[str] = collections.Counter(l["kind"] for l in raw_links)

        return {
            "file": pdf_path.name,
            "path": str(pdf_path),
            "size_bytes": file_size,
            "sha256": sha256,
            "page_count": page_count,
            "page_dimensions": dict(page_dims),
            "metadata": metadata,
            "dominant_body_size_pt": body_size,
            "total_spans": total_spans,
            "total_lines": len(all_lines),
            "total_non_ws_chars": total_non_ws_chars,
            "total_images": total_images,
            "image_only_pages": image_only_pages,
            "warnings": warnings,
            "replacement_chars": replacement_chars,
            "unicode_zs": dict(zs_counts),
            "span_accounting": {
                "total_spans": total_spans,
                "accounted_spans": accounted_spans,
                "unclassified_spans": span_buckets["unclassified"],
                "buckets": dict(span_buckets),
            },
            "toc": {
                "count": len(toc_entries),
                "entries": toc_entries,
            },
            "fonts": fonts_inventory,
            "x0_clusters": x0_clusters,
            "y0_bands": bands,
            "links": {
                "total": len(raw_links),
                "by_kind": dict(links_summary),
                "items": raw_links,
            },
            "patterns": {
                "counts": dict(pattern_counts),
                "samples": dict(pattern_samples),
            },
            "consolidation_dates": consolidation_dates,
            "repeal_hits": repeal_hits,
            "pages": page_stats,
        }
    finally:
        doc.close()


def build_json_report(results: list[dict[str, Any]], errors: list[dict[str, str]]) -> str:
    """Sérialise les résultats d'inspection en JSON UTF-8 déterministe."""
    payload = {
        "tool": "pipeline.discovery.recon_pdf",
        "files_inspected": len(results),
        "errors": errors,
        "documents": results,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def build_markdown_report(results: list[dict[str, Any]], errors: list[dict[str, str]]) -> str:
    """Construit le rapport Markdown exhaustif et reproductible."""
    L: list[str] = []
    L.append("# Reconnaissance PDF — dry-run")
    L.append("")
    L.append("> Vidage REPRODUCTIBLE, régénéré par `pipeline/discovery/recon_pdf.py` (zéro LLM, zéro OCR, zéro D1).")
    L.append("> Gitignoré à dessein : le document de référence versionné est `docs/phase0-structure-pdf.md`,")
    L.append("> rédigé à la main à partir de ces mesures.")
    L.append("")
    L.append(f"- Fichiers inspectés : **{len(results)}** · erreurs/refus : **{len(errors)}**")
    if errors:
        L.append("")
        for err in errors:
            L.append(f"- ⚠️ **REFUS / ÉCHEC** `{err['file']}` ({err['error_type']}) : {err['message']}")
    L.append("")

    if results:
        L.append("## Synthèse des fichiers inspectés")
        L.append("")
        L.append("| Fichier | Taille (o) | SHA-256 (12) | Pages | Spans (non classés) | Car. non-blancs | Images | Signets TOC | Liens |")
        L.append("|---|---:|---|---:|---|---:|---:|---:|---:|")
        for r in results:
            sa = r["span_accounting"]
            L.append(
                f"| `{r['file']}` | {r['size_bytes']} | `{r['sha256'][:12]}` | "
                f"{r['page_count']} | {sa['total_spans']} ({sa['unclassified_spans']}) | "
                f"{r['total_non_ws_chars']} | {r['total_images']} | "
                f"{r['toc']['count']} | {r['links']['total']} |"
            )
        L.append("")

    for r in results:
        L.append(f"## `{r['file']}`")
        L.append("")
        L.append(f"- **SHA-256 :** `{r['sha256']}`")
        L.append(f"- **Taille :** {r['size_bytes']} octets · **Pages :** {r['page_count']} · **Dimensions :** {r['page_dimensions']}")
        L.append(f"- **Taille corps dominante :** {r['dominant_body_size_pt']} pt · **Caractères `\ufffd` :** {r['replacement_chars']}")
        L.append(f"- **Espaces Unicode `Zs` bruts :** {r['unicode_zs'] or 'aucun hors ASCII'}")
        img_only = r.get("image_only_pages") or []
        L.append(f"- **Pages image seulement (`< 10 car.`) :** {img_only or 'aucune'}")
        for warn in r.get("warnings") or []:
            L.append(f"- ⚠️ **Avertissement :** {warn}")
        meta = r["metadata"]
        L.append(
            f"- **Métadonnées PDF :** title=`{meta.get('title') or ''}` · creator=`{meta.get('creator') or ''}` · "
            f"producer=`{meta.get('producer') or ''}` · modDate=`{meta.get('modDate') or ''}`"
        )
        if r["consolidation_dates"]:
            L.append(
                "- **Dates détectées dans le texte :** "
                + "; ".join(f"p.{d['page']} `{d['text']}`" for d in r["consolidation_dates"])
            )
        else:
            L.append("- **Dates détectées dans le texte :** aucune")
        L.append("")

        # Bilan de spans
        sa = r["span_accounting"]
        L.append("### Bilan des spans (100 % couverture)")
        L.append("")
        L.append(
            f"Total : **{sa['total_spans']}** · comptabilisés : **{sa['accounted_spans']}** · "
            f"non classés : **{sa['unclassified_spans']}**"
        )
        L.append("")
        L.append("| Seau | Spans |")
        L.append("|---|---:|")
        for bk, cnt in sa["buckets"].items():
            L.append(f"| `{bk}` | {cnt} |")
        L.append("")

        # Polices
        L.append("### Polices et styles")
        L.append("")
        L.append("| Police brute | Police de base | Taille (pt) | Drapeaux | Spans | Car. | Exemple |")
        L.append("|---|---|---:|---|---:|---:|---|")
        for f in r["fonts"]:
            flags_str = ", ".join(f["flags_decoded"]) or "—"
            sample_escaped = f["sample"].replace("|", "\\|")
            L.append(
                f"| `{f['raw_font']}` | `{f['base_font']}` | {f['size']} | {flags_str} | "
                f"{f['spans']} | {f['non_ws_chars']} | {sample_escaped} |"
            )
        L.append("")

        # Clusters x0
        L.append("### Clusters de marge gauche `x0` (hors bandeaux répétés)")
        L.append("")
        L.append("| `x0` médian (pt) | Plage `[min, max]` | Lignes | Polices dominantes | Exemples |")
        L.append("|---:|---|---:|---|---|")
        for cl in r["x0_clusters"]:
            f_str = ", ".join(f"{k}×{v}" for k, v in cl["fonts"].items())
            s_str = " / ".join(s.replace("|", "\\|") for s in cl["samples"][:2])
            L.append(
                f"| {cl['x0_median']} | [{cl['x0_min']}, {cl['x0_max']}] | {cl['count']} | {f_str} | {s_str} |"
            )
        L.append("")

        # Bandeaux y0
        bands = r["y0_bands"]
        L.append(f"### Bandeaux `y0` (seuil répétition : >= {bands['threshold_pages']} pages)")
        L.append("")
        L.append(
            f"- En-têtes répétés : **{len(bands['repeating_headers'])}** · "
            f"Pieds répétés : **{len(bands['repeating_footers'])}** · "
            f"Candidats bord haut : **{len(bands['edge_candidates_top'])}** · "
            f"Candidats bord bas : **{len(bands['edge_candidates_bottom'])}**"
        )
        if bands["repeating_headers"] or bands["repeating_footers"]:
            L.append("")
            L.append("| Position | Pages | Plage `y` | Motif | Exemple |")
            L.append("|---|---:|---|---|---|")
            for pos, grp in (("en-tête", bands["repeating_headers"]), ("pied", bands["repeating_footers"])):
                for b in grp:
                    L.append(
                        f"| {pos} | {b['page_count']} | [{b['y0_min']}, {b['y1_max']}] | "
                        f"`{b['pattern'].replace('|', '\\|')}` | {b['sample'].replace('|', '\\|')} |"
                    )
        L.append("")

        # Signets TOC
        L.append(f"### Signets (`outline` / TOC : {r['toc']['count']})")
        L.append("")
        if r["toc"]["entries"]:
            L.append("| Niveau | Page | Intitulé |")
            L.append("|---:|---:|---|")
            for t in r["toc"]["entries"]:
                L.append(f"| {t['level']} | {t['page']} | {t['title'].replace('|', '\\|')} |")
        else:
            L.append("*Aucun signet TOC dans ce fichier.*")
        L.append("")

        # Annotations de liens
        L.append(f"### Annotations de liens ({r['links']['total']} — {r['links']['by_kind'] or 'aucun'})")
        L.append("")
        if r["links"]["items"]:
            L.append("| Page | Type | Cible (`uri` / `page`) | Texte ancré |")
            L.append("|---:|---|---|---|")
            for lnk in r["links"]["items"]:
                if lnk.get("uri"):
                    target = lnk["uri"]
                elif lnk.get("file"):
                    target = lnk["file"]
                elif lnk.get("target_page") is not None:
                    target = f"p.{lnk['target_page']}"
                else:
                    target = "—"
                L.append(
                    f"| {lnk['page']} | `{lnk['kind']}` | `{str(target).replace('|', '\\|')}` | "
                    f"{lnk['anchor_text'].replace('|', '\\|')} |"
                )
        else:
            L.append("*Aucune annotation de lien.*")
        L.append("")

        # Motifs structurels et numérotation
        L.append("### Motifs de début de ligne et structure")
        L.append("")
        L.append("| Catégorie | Occurrences | Exemples |")
        L.append("|---|---:|---|")
        for pkind, cnt in sorted(r["patterns"]["counts"].items(), key=lambda kv: (-kv[1], kv[0])):
            ex_list = r["patterns"]["samples"].get(pkind, [])[:3]
            ex_str = " / ".join(f"p.{e['page']}: `{e['line'].replace('|', '\\|')}`" for e in ex_list)
            L.append(f"| `{pkind}` | {cnt} | {ex_str} |")
        L.append("")

    return "\n".join(L) + "\n"


def _default_sample_pdfs() -> list[Path]:
    if not config.SAMPLES_DIR.is_dir():
        return []
    return sorted(config.SAMPLES_DIR.glob("*.pdf"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "paths",
        nargs="*",
        help="Fichiers PDF à inspecter (défaut : fichiers *.pdf triés dans pipeline/samples/)",
    )
    ap.add_argument(
        "--format",
        choices=("md", "json"),
        default="md",
        help="Format principal de sortie (défaut : md)",
    )
    ap.add_argument(
        "--out",
        help="Chemin de sortie principal (défaut en mode md : docs/reconnaissance-pdf-courante.md ; '-' pour stdout)",
    )
    ap.add_argument(
        "--json-out",
        help="Chemin optionnel pour écrire également le rapport JSON complet",
    )
    args = ap.parse_args(argv)

    if pymupdf is None:
        print("Erreur : `pymupdf` n'est pas installé dans cet environnement Python.", file=sys.stderr)
        return 1

    input_paths = [Path(p) for p in args.paths] if args.paths else _default_sample_pdfs()
    if not input_paths:
        print("Erreur : aucun fichier PDF fourni ni trouvé dans pipeline/samples/.", file=sys.stderr)
        return 1

    missing = [p for p in input_paths if not p.is_file()]
    if missing:
        for m in missing:
            print(f"Erreur : fichier introuvable : {m}", file=sys.stderr)
        return 1

    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for p in input_paths:
        try:
            results.append(inspect_pdf(p))
        except PdfReconError as exc:
            errors.append(
                {
                    "file": p.name,
                    "path": str(p),
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                }
            )

    md_text = build_markdown_report(results, errors)
    json_text = build_json_report(results, errors)

    if args.json_out:
        jp = Path(args.json_out)
        jp.parent.mkdir(parents=True, exist_ok=True)
        jp.write_text(json_text, encoding="utf-8", newline="\n")

    if args.format == "json":
        if args.out and args.out != "-":
            op = Path(args.out)
            op.parent.mkdir(parents=True, exist_ok=True)
            op.write_text(json_text, encoding="utf-8", newline="\n")
            print(f"Rapport JSON écrit : {op}")
        else:
            sys.stdout.write(json_text)
    else:
        if args.out == "-":
            sys.stdout.write(md_text)
        else:
            op = Path(args.out) if args.out else DEFAULT_REPORT
            op.parent.mkdir(parents=True, exist_ok=True)
            op.write_text(md_text, encoding="utf-8", newline="\n")
            print(f"Rapport écrit : {op}")

    summary_stream = sys.stderr if (args.out == "-" or (args.format == "json" and not args.out)) else sys.stdout
    print(
        f"Reconnaissance PDF : {len(results)} fichier(s) inspecté(s), {len(errors)} refus/échec(s).",
        file=summary_stream,
    )
    for err in errors:
        print(f"  REFUS {err['file']} [{err['error_type']}] : {err['message']}", file=sys.stderr)

    return 2 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
