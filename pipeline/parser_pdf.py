"""Parseur PDF déterministe (zéro LLM, zéro OCR) piloté par profils déclaratifs.

Contrat de phase 0 : `docs/phase0-structure-pdf.md` (§1–§9).
Miroir de tri et chemins : `pipeline/model.py::sort_key`, `pipeline/paths.py`.
Importé paresseusement depuis `pipeline/ingest.py::_acquiert_pdf` afin de garder
la suite CI sans `pymupdf` verte.
"""
from __future__ import annotations

import collections
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import pymupdf
except ImportError:  # pragma: no cover - exercé en CI sans pymupdf
    pymupdf = None  # type: ignore[assignment]

from . import config, paths
from .discovery.recon_pdf import (
    _BAD_NUMERIC_LOWER_PROSE_RE,
    _BAD_NUMERIC_UNIT_RE,
    _BULLET_RE,
    _SUBITEM_NUM_RE,
    _SUBITEM_ROMAN_RE,
    CorruptPdfError,
    EncryptedPdfError,
    LineRecord,
    MissingDependencyError,
    ScannedPdfError,
    SpanRecord,
    _norm,
    _rect_intersects,
    reconstruct_lines,
    strip_font_subset,
)
from .model import DISPOSITION_SORT_BASE, Article, Division, Law
from .norm import normalize

PROFILES_DIR = config.REPO_ROOT / "pipeline" / "pdf_profiles"

# Constantes PyMuPDF de liens (évite toute dépendance dure à pymupdf dans les tests purs)
LINK_NONE = 0
LINK_GOTO = 1
LINK_URI = 2
LINK_LAUNCH = 3
LINK_NAMED = 4
LINK_GOTOR = 5

_FR_MONTHS: dict[str, int] = {
    "janvier": 1,
    "fevrier": 2,
    "février": 2,
    "mars": 3,
    "avril": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "aout": 8,
    "août": 8,
    "septembre": 9,
    "octobre": 10,
    "novembre": 11,
    "decembre": 12,
    "décembre": 12,
}

_EN_MONTHS: dict[str, int] = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

# Normalisation PUA bornée à la police (§7.3)
_PUA_BY_FONT: dict[str, dict[str, str]] = {
    "SymbolMT": {
        "\uf0e0": "→",
        "\uf0b7": "•",
        "\uf02d": "−",
    },
    "Wingdings2": {
        "\uf0a1": "□",
    },
    "Wingdings-Regular": {
        "\uf0a7": "▪",
        "\uf0a8": "□",
    },
}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SUBITEM_ALPHA_PAREN_RE = re.compile(r"^(?P<num>(?:\([a-z]\)|[a-z]\)))(?=\s|$)")
_SUBITEM_ALPHA_DOT_RE = re.compile(r"^(?P<num>[a-z]\.)(?=\s|$)")
_TOC_NUMBERED_ARTICLE_RE = re.compile(r"^(?P<num>\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)*)\.?(?=\s|$)")
_PROV_NUMERIC_RE = re.compile(r"^(?P<num>\d+(?:\.\d+)*)(?P<delim>\.?)(?:\s+(?P<rest>.*))?$")
_PROV_ALPHANUM_RE = re.compile(
    r"^(?P<num>(?:\d+[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)*|\d+(?:\.\d+)*(?:[A-Za-z]+(?:\.\d+(?:[A-Za-z]+)?)*)?))"
    r"(?P<delim>[.):]?)(?:\s+(?P<rest>.*))?$"
)
_DIV_REPEAL_RE = re.compile(r"\(?\bAbrog[ée]e?\.?\)?\.?$", re.I)


class PdfParseError(Exception):
    """Erreur déterministe de parsing PDF (fail-closed)."""


class ProfileMismatchError(PdfParseError, ValueError):
    """Profil absent, langue non couverte ou empreinte SHA-256 divergente."""


class SpanBilanError(PdfParseError, ValueError):
    """Porte 1 : au moins un span non classé ou écart comptabilisés != total."""


class TocParityError(PdfParseError, ValueError):
    """Porte 2 : divergence TDM/signets <-> divisions ou doublon de clé/chemin."""


class ConsolidationDateError(PdfParseError, ValueError):
    """Date de consolidation introuvable ou illisible dans le corps/page titre."""


@dataclass
class PdfBilan:
    total_spans: int = 0
    accounted_spans: int = 0
    unclassified: int = 0
    buckets: dict[str, int] = field(default_factory=dict)
    image_only_pages: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    toc_titles: list[str] = field(default_factory=list)
    toc_exempt_headings: list[str] = field(default_factory=list)
    skip_toc_parity: bool = False
    toc_strip_parentheticals: bool = False
    source_sha256: str = ""

    def add_span(self, bucket: str, count: int = 1) -> None:
        if count <= 0:
            return
        self.buckets[bucket] = self.buckets.get(bucket, 0) + count
        if bucket == "unclassified":
            self.unclassified += count
        else:
            self.accounted_spans += count

    @property
    def span_accounting(self) -> dict[str, Any]:
        return {
            "total": self.total_spans,
            "accounted": self.accounted_spans,
            "unclassified": self.unclassified,
            "buckets": dict(self.buckets),
        }

    def as_dict(self) -> dict[str, Any]:
        return {
            "total_spans": self.total_spans,
            "accounted_spans": self.accounted_spans,
            "unclassified": self.unclassified,
            "buckets": dict(self.buckets),
            "image_only_pages": list(self.image_only_pages),
            "warnings": list(self.warnings),
            "source_sha256": self.source_sha256,
        }


def load_profile(law_id: str, profiles_dir: Path | None = None) -> dict[str, Any]:
    base = profiles_dir or PROFILES_DIR
    path = base / f"{law_id}.json"
    if not path.exists():
        raise ProfileMismatchError(f"Profil PDF introuvable : {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_pua_text(text: str, base_font: str) -> str:
    """Normalise les glyphes PUA selon la police d'origine (SymbolMT, Wingdings2)."""
    mapping = _PUA_BY_FONT.get(base_font)
    if not mapping or not text:
        return text
    out = text
    for src, dst in mapping.items():
        if src in out:
            out = out.replace(src, dst)
    return out


def _unmapped_pua_chars(text: str) -> list[str]:
    return [ch for ch in text if 0xE000 <= ord(ch) <= 0xF8FF]


def _normalize_table_cell_pua(
    cell_text: str,
    cell_bbox: tuple[float, float, float, float] | None,
    table_bbox: tuple[float, float, float, float],
    pua_spans: list[tuple[float, float, str, str]],
    *,
    page_num: int,
    bilan_obj: PdfBilan,
) -> str:
    """Normalise les glyphes PUA d'une cellule de tableau selon les polices présentes dans sa bbox."""
    if not cell_text or not _unmapped_pua_chars(cell_text):
        return cell_text
    bx0, by0, bx1, by1 = cell_bbox if cell_bbox is not None else table_bbox
    fonts_in_cell: list[str] = []
    for cx, cy, base_font, _raw in pua_spans:
        if (bx0 - 2.0) <= cx <= (bx1 + 2.0) and (by0 - 2.0) <= cy <= (by1 + 2.0):
            if base_font not in fonts_in_cell:
                fonts_in_cell.append(base_font)
    if not fonts_in_cell:
        tx0, ty0, tx1, ty1 = table_bbox
        for cx, cy, base_font, _raw in pua_spans:
            if (tx0 - 2.0) <= cx <= (tx1 + 2.0) and (ty0 - 2.0) <= cy <= (ty1 + 2.0):
                if base_font not in fonts_in_cell:
                    fonts_in_cell.append(base_font)
    out = cell_text
    for bf in fonts_in_cell:
        out = normalize_pua_text(out, bf)
    rem = _unmapped_pua_chars(out)
    if rem:
        bilan_obj.warnings.append(
            f"p.{page_num} glyphe PUA tableau non mappé ({fonts_in_cell}): {[hex(ord(c)) for c in rem]}"
        )
    return out


def parse_consolidation_date_text(text: str, lang: str = "fr") -> str | None:
    """Convertit une date textuelle ('1er janvier 2026', '23 février 2026', 'January 1, 2026') en ISO."""
    cleaned = re.sub(r"\s+", " ", text or "").strip()
    if not cleaned:
        return None
    m_iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", cleaned)
    if m_iso:
        return m_iso.group(1)
    if lang == "fr":
        m = re.search(r"\b(\d{1,2})\s*(?:er)?\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})\b", cleaned, re.I)
        if m:
            month = _FR_MONTHS.get(m.group(2).lower())
            if month:
                return f"{int(m.group(3)):04d}-{month:02d}-{int(m.group(1)):02d}"
    else:
        m1 = re.search(r"\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b", cleaned, re.I)
        if m1:
            month = _EN_MONTHS.get(m1.group(1).lower())
            if month:
                return f"{int(m1.group(3)):04d}-{month:02d}-{int(m1.group(2)):02d}"
        m2 = re.search(r"\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b", cleaned, re.I)
        if m2:
            month = _EN_MONTHS.get(m2.group(2).lower())
            if month:
                return f"{int(m2.group(3)):04d}-{month:02d}-{int(m2.group(1)):02d}"
    return None


def extract_consolidation_date(
    lines_by_page: dict[int, list[LineRecord]],
    date_cfg: dict[str, Any],
) -> str:
    """Extrait la date « À jour au … » depuis les pages configurées (jamais /ModDate)."""
    pages = date_cfg.get("pages") or [1]
    pattern = re.compile(date_cfg["regex"], re.I)
    lang = date_cfg.get("lang", "fr")
    x0_min = float(date_cfg["x0_min"]) if "x0_min" in date_cfg else None
    y_min = float(date_cfg["y_min"]) if "y_min" in date_cfg else None
    y_max = float(date_cfg["y_max"]) if "y_max" in date_cfg else None
    join_lines = bool(date_cfg.get("join_lines", False))

    for p in pages:
        candidates: list[LineRecord] = []
        for ln in lines_by_page.get(int(p), []):
            if not ln.norm_text:
                continue
            if y_min is not None and ln.y0 < y_min:
                continue
            if y_max is not None and ln.y0 > y_max:
                continue
            if x0_min is not None:
                nws = _line_non_ws(ln)
                if not nws or nws[0].x0 < x0_min:
                    continue
            candidates.append(ln)
            m = pattern.search(ln.norm_text)
            if not m:
                continue
            raw_date = m.group(1) if m.lastindex else m.group(0)
            iso = parse_consolidation_date_text(raw_date, lang=lang)
            if iso:
                return iso
        if join_lines and candidates:
            joined = " ".join(c.norm_text for c in candidates)
            m = pattern.search(joined)
            if m:
                raw_date = m.group(1) if m.lastindex else m.group(0)
                iso = parse_consolidation_date_text(raw_date, lang=lang)
                if iso:
                    return iso
    raise ConsolidationDateError(
        f"Date de consolidation introuvable sur les pages {pages} (motif {date_cfg.get('regex')!r})."
    )


def _rect_tuple(rect_obj: Any) -> tuple[float, float, float, float] | None:
    if rect_obj is None:
        return None
    if isinstance(rect_obj, (tuple, list)) and len(rect_obj) == 4:
        return (float(rect_obj[0]), float(rect_obj[1]), float(rect_obj[2]), float(rect_obj[3]))
    if all(hasattr(rect_obj, k) for k in ("x0", "y0", "x1", "y1")):
        return (float(rect_obj.x0), float(rect_obj.y0), float(rect_obj.x1), float(rect_obj.y1))
    return None


def _apply_derotation(rect_obj: Any, derotation_matrix: Any) -> tuple[float, float, float, float] | None:
    if derotation_matrix is not None and rect_obj is not None:
        if isinstance(rect_obj, (tuple, list)) and len(rect_obj) == 4:
            if pymupdf is None:
                raise MissingDependencyError("pymupdf requis pour dérotation.")
            rect_obj = pymupdf.Rect(rect_obj)
        rect_obj = rect_obj * derotation_matrix
    return _rect_tuple(rect_obj)


def _clean_link_label(raw: str) -> str:
    """Nettoie les artefacts de bordure d'une étiquette d'ancre de lien PDF."""
    s = _norm(raw)
    if not s:
        return ""
    s = re.sub(r"(?:\s*\*)+$", "", s).strip()
    s = re.sub(r"\s+\.", ".", s)
    s = re.sub(r"^[,.;:\s]+", "", s)
    if s.startswith(")"):
        s = re.sub(r"^\)+[\s,.;:]*", "", s)
    s = re.sub(r"[,;:\s]+$", "", s)
    return s.strip()


def filter_raw_links(
    raw_links: list[dict[str, Any]],
    *,
    page_num: int,
    page_spans: list[SpanRecord],
    derotation_matrix: Any = None,
    links_cfg: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Filtre les annotations de liens PyMuPDF selon §4.3 / §7.7."""
    cfg = links_cfg or {}
    allowed_schemes = set(cfg.get("allowed_schemes") or ["https", "http", "mailto"])
    ignore_bad_mailto = bool(cfg.get("ignore_mailto_without_at_domain", True))
    ignore_host_no_dot = bool(cfg.get("ignore_host_without_dot", False))
    sanitize_launch = bool(cfg.get("sanitize_email_launch", True))
    ignore_zero_area = bool(cfg.get("ignore_zero_area_rect", True))

    kept: list[dict[str, Any]] = []
    for lk in raw_links:
        kind = int(lk.get("kind", LINK_NONE))
        if kind in (LINK_NONE, LINK_GOTO, LINK_NAMED, LINK_GOTOR):
            continue
        bbox = _apply_derotation(lk.get("from"), derotation_matrix)
        if bbox is None:
            continue
        x0, y0, x1, y1 = bbox
        if ignore_zero_area and (x1 <= x0 or y1 <= y0):
            continue

        url: str | None = None
        if kind == LINK_URI:
            raw_uri = str(lk.get("uri") or "").strip()
            if not raw_uri or ":" not in raw_uri:
                continue
            scheme, rest = raw_uri.split(":", 1)
            scheme_l = scheme.lower()
            if scheme_l not in allowed_schemes:
                continue
            if scheme_l == "mailto":
                addr = rest.split("?", 1)[0].strip()
                if ignore_bad_mailto and not _EMAIL_RE.match(addr):
                    continue
                url = f"mailto:{addr}" if not rest.startswith(addr) else raw_uri
            elif scheme_l in ("http", "https"):
                if not rest.startswith("//") or len(rest) <= 2:
                    continue
                host = rest[2:].split("/", 1)[0].split("?", 1)[0].split(":", 1)[0]
                if ignore_host_no_dot and "." not in host:
                    continue
                url = raw_uri
            else:
                url = raw_uri
        elif kind == LINK_LAUNCH:
            if not sanitize_launch:
                continue
            raw_file = str(lk.get("file") or "").strip()
            if raw_file.lower().startswith("mailto:"):
                raw_file = raw_file[7:].strip()
            if _EMAIL_RE.match(raw_file):
                url = f"mailto:{raw_file}"
            else:
                continue
        else:
            continue

        hits: list[SpanRecord] = []
        for sp in page_spans:
            if not sp.norm_text:
                continue
            ov_y = min(y1, sp.y1) - max(y0, sp.y0)
            sp_h = max(1.0, sp.y1 - sp.y0)
            cy = 0.5 * (sp.y0 + sp.y1)
            ov_x = min(x1, sp.x1) - max(x0, sp.x0)
            sp_w = max(0.1, sp.x1 - sp.x0)
            if ov_y > 0 and (y0 - 0.5 <= cy <= y1 + 0.5 or ov_y >= 0.45 * sp_h) and ov_x >= min(2.0, 0.35 * sp_w):
                hits.append(sp)
        if not hits:
            hits = [
                sp for sp in page_spans
                if sp.norm_text and _rect_intersects(bbox, (sp.x0, sp.y0, sp.x1, sp.y1))
            ]
        hit_lines = reconstruct_lines(hits, y_tolerance=2.5) if hits else []
        anchor = _norm(" ".join(ln.norm_text for ln in hit_lines if ln.norm_text))

        if (
            kind == LINK_URI
            and kept
            and kept[-1]["_kind"] == LINK_URI
            and kept[-1]["url"] == url
            and -2.0 <= y0 - kept[-1]["bbox"][3] <= 10.0
        ):
            prev = kept[-1]
            if anchor and anchor != prev["_raw_anchor"]:
                prev["_raw_anchor"] = _norm(f"{prev['_raw_anchor']} {anchor}") if prev["_raw_anchor"] else anchor
            prev["label"] = _clean_link_label(prev["_raw_anchor"]) or url
            bx0, by0, bx1, by1 = prev["bbox"]
            prev["bbox"] = (min(bx0, x0), min(by0, y0), max(bx1, x1), max(by1, y1))
            continue

        kept.append({
            "page": page_num,
            "bbox": bbox,
            "_kind": kind,
            "_raw_anchor": anchor,
            "label": _clean_link_label(anchor) or url,
            "url": url,
        })
    for item in kept:
        item.pop("_kind", None)
        item.pop("_raw_anchor", None)
    return kept


def deduplicate_article_links(items: list[dict[str, str]]) -> str | None:
    """Déduplique par URL et sérialise en JSON `[{'label': ..., 'url': ...}]` (ou None)."""
    by_url: dict[str, str] = {}
    order: list[str] = []
    for item in items:
        url = (item.get("url") or "").strip()
        if not url:
            continue
        lbl = (item.get("label") or "").strip()
        if url not in by_url:
            by_url[url] = lbl or url
            order.append(url)
        elif lbl and lbl != url and (by_url[url] == url or len(lbl) > len(by_url[url])):
            by_url[url] = lbl
    if not order:
        return None
    payload = [{"label": by_url[u], "url": u} for u in order]
    return json.dumps(payload, ensure_ascii=False)


def _line_non_ws(ln: LineRecord) -> list[SpanRecord]:
    return [sp for sp in ln.spans if sp.norm_text]


def match_history_line(ln: LineRecord, history_cfg: dict[str, Any]) -> bool:
    """Détecte une ligne d'historique par combinaison préfixe + typographie (§4.2)."""
    non_ws = _line_non_ws(ln)
    if not non_ws:
        return False
    first = non_ws[0]
    x0_min = float(history_cfg.get("x0_min", 0.0))
    x0_max = float(history_cfg.get("x0_max", 999.0))
    if not (x0_min <= first.x0 <= x0_max):
        return False
    prefix_re = re.compile(history_cfg["prefix_regex"], re.I)
    if not prefix_re.match(ln.norm_text):
        return False
    max_sz = float(history_cfg.get("max_size_pt", 10.5))
    allow_bi = bool(history_cfg.get("allow_bold_italic_any_size", False))
    if first.size <= max_sz:
        return True
    if allow_bi and ("BoldItalic" in first.base_font or ((first.flags & 16) and (first.flags & 2))):
        return True
    return False


def match_provision_prefix(
    text: str,
    number_mode: str = "numeric",
    *,
    require_dot_in_number: bool = False,
) -> tuple[str, str] | None:
    """Extrait `(numero, reste)` en début de disposition avec gardes anti-faux-positifs (§7.6)."""
    if not text:
        return None
    if number_mode == "alphanumeric":
        m = _PROV_ALPHANUM_RE.match(text)
    else:
        m = _PROV_NUMERIC_RE.match(text)
    if not m:
        return None
    num = m.group("num")
    delim = m.group("delim") or ""
    rest = (m.group("rest") or "").strip()

    if require_dot_in_number and "." not in num:
        return None

    # Garde 1 : sans délimiteur ni point interne, une lettre attachée (ex. « 2A Champ ») est rejetée
    has_letters = any(c.isalpha() for c in num)
    if has_letters and "." not in num and not delim:
        return None
    # Garde 2 : rejeter « 1er », « 12 $ », « 100 % », « 45-106 », « 2026-02-23 »
    if rest and _BAD_NUMERIC_UNIT_RE.match(rest):
        return None
    # Garde 3 : chiffre entier sans délimiteur suivi d'un mot-outil minuscule (« 2019 CSC », « 12 ou »)
    if not delim and "." not in num and not has_letters:
        if rest and _BAD_NUMERIC_LOWER_PROSE_RE.match(rest):
            return None
        if not rest:
            return None
    return num, rest


def parse_printed_toc(toc_lines: list[LineRecord], toc_cfg: dict[str, Any]) -> list[tuple[int, str]]:
    """Reconstruit les rubriques `(niveau, titre)` depuis les pages liminaires de TDM (§3.1)."""
    trailing_re = re.compile(toc_cfg.get("trailing_page_regex", r"(?:\s*\.{2,}\s*|\s+)\d+\s*$"))
    l1_max = float(toc_cfg.get("level1_x0_max", 98.0))
    req_bold = bool(toc_cfg.get("require_bold_for_level1", True))

    entries: list[tuple[int, str]] = []
    buf_lvl: int | None = None
    buf_txt = ""
    for ln in toc_lines:
        non_ws = _line_non_ws(ln)
        if not non_ws:
            continue
        x0 = non_ws[0].x0
        all_bold = all((s.flags & 16) or ("Bold" in s.base_font) for s in non_ws)
        lvl = 1 if (x0 <= l1_max and (not req_bold or all_bold)) else 2
        if buf_lvl is None:
            buf_lvl = lvl
            buf_txt = ln.norm_text
        else:
            buf_txt = f"{buf_txt} {ln.norm_text}"
        if trailing_re.search(buf_txt):
            clean = trailing_re.sub("", buf_txt).strip()
            entries.append((buf_lvl, clean))
            buf_lvl = None
            buf_txt = ""
    if buf_lvl is not None and buf_txt.strip():
        clean = trailing_re.sub("", buf_txt).strip()
        entries.append((buf_lvl, clean))
    return entries


def _toc_cmp_norm(s: str | None, *, strip_parentheticals: bool = False) -> str:
    raw = s or ""
    if strip_parentheticals:
        raw = re.sub(r"\s*\(art\.?\s*[^)]+\)", "", raw, flags=re.I)
    n = normalize(raw) or ""
    n = n.replace("\u2019", "'").replace("\u2018", "'")
    n = re.sub(r"\s+", " ", n)
    return n.rstrip(".").strip()


def _is_all_bold_non_italic(spans: list[SpanRecord]) -> bool:
    if not spans:
        return False
    for s in spans:
        is_bold = bool(s.flags & 16) or ("Bold" in s.base_font)
        is_italic = bool(s.flags & 2) or ("Italic" in s.base_font)
        if not is_bold or is_italic:
            return False
    return True


def _is_bold_lead_non_italic(spans: list[SpanRecord]) -> bool:
    if not spans:
        return False
    first = spans[0]
    is_bold = bool(first.flags & 16) or ("Bold" in first.base_font)
    is_italic = bool(first.flags & 2) or ("Italic" in first.base_font)
    return is_bold and not is_italic


def _is_any_bold(spans: list[SpanRecord]) -> bool:
    return bool(spans) and all(bool(s.flags & 16) or ("Bold" in s.base_font) for s in spans)


def _is_subitem_or_new_para(
    text: str,
    x0: float,
    subitem_x0_min: float,
    prev_text: str,
    *,
    allow_alpha_dot: bool = False,
    new_para_from_title: bool = False,
    dy_same_page: float | None = None,
) -> bool:
    if new_para_from_title:
        return True
    if (
        _SUBITEM_NUM_RE.match(text)
        or _SUBITEM_ROMAN_RE.match(text)
        or _SUBITEM_ALPHA_PAREN_RE.match(text)
        or (allow_alpha_dot and _SUBITEM_ALPHA_DOT_RE.match(text))
        or _BULLET_RE.match(text)
    ):
        return True
    if text.startswith("PRENEZ AVIS"):
        return True
    if x0 >= subitem_x0_min and prev_text.endswith((".", ":", ";")):
        # Paragraphe distinct s'il s'agit d'une phrase complète débutant par une majuscule après alinéa terminé
        if text[:1].isupper() and (
            abs(x0 - subitem_x0_min) >= 10.0
            or (dy_same_page is not None and dy_same_page >= 20.0)
        ):
            return True
    return False


_UNNUMBERED_MID_CITE_TAIL_RE = re.compile(
    r"(?:\b(?:19|20)\d{2}|\b(?:CSC|SCC|QCCA|QCCS|QCCQ|ONCA)|R\.?C\.?S\.?|R\.?J\.?Q\.?)$"
)
_UNNUMBERED_END_CITE_RE = re.compile(
    r"(?:\b(?:19|20)\d{2}\s+(?:CSC|SCC|QCCA|QCCS|QCCQ|QCTP|QCBDR|ONCA|UKPC|CanLII)\s+\d+"
    r"|\b(?:R\.?C\.?S\.?|S\.?C\.?R\.?|R\.?J\.?Q\.?|C\.?A\.?)\s+\d+)\s*$"
)


def _is_new_unnumbered_entry(
    prev_text: str,
    line_text: str,
    *,
    p_num: int,
    y0: float,
    is_bold_topic: bool,
    last_prose_meta: tuple[int, float, bool] | None,
) -> bool:
    if _BULLET_RE.match(line_text):
        return True
    prev_line = prev_text.rsplit("\n", 1)[-1].rstrip()
    if is_bold_topic:
        return (
            last_prose_meta is None
            or not last_prose_meta[2]
            or last_prose_meta[0] != p_num
            or (y0 - last_prose_meta[1]) > 16.0
        )
    if last_prose_meta is not None and last_prose_meta[2]:
        return True
    if prev_line.endswith((" c.", " v.", ",")) or _UNNUMBERED_MID_CITE_TAIL_RE.search(prev_line):
        return False
    if last_prose_meta is not None and last_prose_meta[0] == p_num:
        return (y0 - last_prose_meta[1]) > 16.0
    if last_prose_meta is not None and last_prose_meta[0] != p_num:
        return prev_line.endswith((".", ")")) or bool(_UNNUMBERED_END_CITE_RE.search(prev_line))
    return False


def _match_in_box_blocks(ln: LineRecord, page_num: int, blocks: list[dict[str, Any]]) -> bool:
    non_ws = _line_non_ws(ln)
    if not non_ws:
        return False
    x0 = non_ws[0].x0
    for blk in blocks:
        if int(blk["page"]) != page_num:
            continue
        if "y_min" in blk and ln.y0 < float(blk["y_min"]):
            continue
        if "y_max" in blk and ln.y0 > float(blk["y_max"]):
            continue
        if "x0_min" in blk and x0 < float(blk["x0_min"]):
            continue
        if "x0_max" in blk and x0 > float(blk["x0_max"]):
            continue
        return True
    return False


def _match_band(
    ln: LineRecord,
    page_num: int,
    band_cfg: dict[str, Any] | None,
    *,
    is_header: bool,
    page_height: float = 792.0,
) -> bool:
    if not band_cfg:
        return False
    pages = band_cfg.get("pages")
    if pages is not None and page_num not in pages:
        return False
    pages_from = band_cfg.get("pages_from")
    if pages_from is not None and page_num < int(pages_from):
        return False
    if is_header and ln.y0 > float(band_cfg["y_max"]):
        return False
    if not is_header:
        if "y_ratio_min" in band_cfg:
            eff_y_min = float(band_cfg["y_ratio_min"]) * page_height
        elif "bottom_offset_max" in band_cfg:
            eff_y_min = page_height - float(band_cfg["bottom_offset_max"])
        else:
            eff_y_min = float(band_cfg["y_min"])
        if ln.y0 < eff_y_min:
            return False
    x0_min = band_cfg.get("x0_min")
    if x0_min is not None:
        non_ws = _line_non_ws(ln)
        if not non_ws or non_ws[0].x0 < float(x0_min):
            return False
    return bool(re.match(band_cfg["regex"], ln.norm_text, re.I))


def _bucket_line(bilan: PdfBilan, ln: LineRecord, bucket: str) -> None:
    ws_count = sum(1 for sp in ln.spans if not sp.norm_text)
    non_ws_count = len(ln.spans) - ws_count
    bilan.add_span("whitespace_only", ws_count)
    bilan.add_span(bucket, non_ws_count)


def _check_vectorize_id_limit(law_id: str, number: str) -> None:
    vid = f"art:{law_id}:{number}"
    if len(vid.encode("utf-8")) > 64:
        raise PdfParseError(
            f"Identifiant Vectorize trop long (> 64 octets UTF-8) : {vid!r}"
        )


def _make_bounded_slug(law_id: str, raw_slug: str, used: set[str]) -> str:
    """Produit un slug ASCII <= (64 - len('art:' + law_id + ':')) octets, unique dans `used`."""
    prefix_len = len(f"art:{law_id}:".encode("utf-8"))
    max_slug_len = max(8, 64 - prefix_len)
    base = re.sub(r"[^a-z0-9]+", "-", (normalize(raw_slug) or "").lower()).strip("-") or "section"
    cand = base[:max_slug_len].rstrip("-")
    if cand not in used:
        used.add(cand)
        return cand
    idx = 2
    while True:
        suffix = f"-{idx}"
        head = base[: max(1, max_slug_len - len(suffix))].rstrip("-")
        c2 = f"{head}{suffix}"
        if c2 not in used:
            used.add(c2)
            return c2
        idx += 1


def _annexe_section_slug(title: str, parent_slug: str | None) -> str:
    """Slug déterministe pour une section/sous-section d'annexe AMF (<= 64 o Vectorize)."""
    norm_t = (normalize(title) or "").lower()
    if norm_t.startswith("dispositions transitoires"):
        return "dispositions-transitoires"
    m_ann = re.match(r"^(?:annexe)\s+([a-z0-9-]+)\b", norm_t)
    if m_ann and parent_slug is None:
        return f"annexe-{m_ann.group(1)}"
    m_app = re.match(r"^(appendice|rubrique|partie)\s+([a-z0-9]+)\b", norm_t)
    if m_app and parent_slug:
        sub = f"{m_app.group(1)}-{m_app.group(2)}"
        return f"{parent_slug}-{sub}"
    short = re.sub(r"[^a-z0-9]+", "-", norm_t).strip("-")[:24].rstrip("-")
    return f"{parent_slug}-{short}" if parent_slug else (short or "annexe")


def parse_pdf(
    pdf_path: str | Path,
    law: Law,
    lang: str,
    *,
    profile: dict[str, Any] | None = None,
    profile_path: str | Path | None = None,
    verify_sha256: bool = True,
    bilan: PdfBilan | None = None,
) -> tuple[list[Division], list[Article]]:
    """Parse déterministe d'un PDF officiel selon son profil JSON (§8.1)."""
    if pymupdf is None:
        raise MissingDependencyError("pymupdf n'est pas installé dans cet environnement.")

    pdf_p = Path(pdf_path)
    if not pdf_p.exists():
        raise CorruptPdfError(f"Fichier PDF introuvable : {pdf_p}")

    if profile is None:
        if profile_path is not None:
            profile = json.loads(Path(profile_path).read_text(encoding="utf-8"))
        else:
            profile = load_profile(law.id)

    files_cfg = profile.get("files") or {}
    if lang not in files_cfg:
        raise ProfileMismatchError(
            f"Langue '{lang}' absente du profil PDF pour '{law.id}' (disponibles : {list(files_cfg)})"
        )
    fcfg = files_cfg[lang]

    raw_bytes = pdf_p.read_bytes()
    if len(raw_bytes) == 0:
        raise CorruptPdfError(f"Fichier PDF vide (0 octet) : {pdf_p}")
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    expected_sha = fcfg.get("sha256")
    if verify_sha256 and expected_sha and sha256 != expected_sha:
        raise ProfileMismatchError(
            f"SHA-256 divergent pour {pdf_p.name} : {sha256} != {expected_sha}"
        )

    bilan_obj = bilan if bilan is not None else PdfBilan()
    bilan_obj.source_sha256 = sha256

    try:
        doc = pymupdf.open(stream=raw_bytes, filetype="pdf")
    except Exception as exc:
        raise CorruptPdfError(f"PDF corrompu ou illisible ({pdf_p.name}) : {exc}") from exc

    try:
        if doc.is_encrypted and doc.needs_pass:
            raise EncryptedPdfError(f"PDF chiffré par mot de passe refusé : {pdf_p.name}")
        page_count = doc.page_count
        if page_count == 0:
            raise ScannedPdfError(f"PDF à 0 page refusé : {pdf_p.name}")

        flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        typo = fcfg["body_typography"]
        y_tol = float(typo.get("y_line_tolerance_pt", 2.5))
        tables_cfg = fcfg.get("tables") or {}
        tables_enabled = bool(tables_cfg.get("enabled", False))
        table_pages_set = set(int(p) for p in tables_cfg["pages"]) if tables_cfg.get("pages") is not None else None
        table_from_page = int(tables_cfg.get("from_page", 1))
        running_footer_cfg = fcfg.get("running_footer")
        running_header_cfg = fcfg.get("running_header")

        lines_by_page: dict[int, list[LineRecord]] = {}
        spans_by_page: dict[int, list[SpanRecord]] = {}
        tables_by_page: dict[int, list[dict[str, Any]]] = {}
        page_heights: dict[int, float] = {}
        links_by_page: dict[int, list[dict[str, Any]]] = {}
        total_images = 0
        total_non_ws_chars = 0
        image_only_pages: list[int] = []

        for p_idx in range(page_count):
            p_num = p_idx + 1
            page = doc[p_idx]
            p_dict = page.get_text("dict", flags=flags)
            page_h = float(p_dict.get("height") or page.cropbox.height or page.rect.height)
            page_heights[p_num] = page_h
            page_images = len(page.get_images(full=True))
            total_images += page_images

            page_spans: list[SpanRecord] = []
            raw_pua_spans: list[tuple[float, float, str, str]] = []
            page_non_ws = 0
            for blk in p_dict.get("blocks", []):
                if blk.get("type") != 0:
                    continue
                for ln_d in blk.get("lines", []):
                    for sp_d in ln_d.get("spans", []):
                        bilan_obj.total_spans += 1
                        bbox = sp_d["bbox"]
                        raw_txt = sp_d.get("text", "")
                        base_font = strip_font_subset(sp_d.get("font", ""))
                        if any(0xE000 <= ord(c) <= 0xF8FF for c in raw_txt):
                            raw_pua_spans.append((
                                (float(bbox[0]) + float(bbox[2])) * 0.5,
                                (float(bbox[1]) + float(bbox[3])) * 0.5,
                                base_font,
                                raw_txt,
                            ))
                        cleaned_txt = normalize_pua_text(raw_txt, base_font)
                        unmapped = _unmapped_pua_chars(cleaned_txt)
                        if unmapped:
                            bilan_obj.warnings.append(
                                f"p.{p_num} glyphe PUA non mappé ({base_font}): {[hex(ord(c)) for c in unmapped]}"
                            )
                        norm_txt = _norm(cleaned_txt)
                        page_non_ws += sum(1 for ch in cleaned_txt if not ch.isspace())
                        page_spans.append(
                            SpanRecord(
                                page=p_num,
                                x0=float(bbox[0]),
                                y0=float(bbox[1]),
                                x1=float(bbox[2]),
                                y1=float(bbox[3]),
                                font=sp_d.get("font", ""),
                                base_font=base_font,
                                size=float(sp_d.get("size", 0.0)),
                                flags=int(sp_d.get("flags", 0)),
                                text=cleaned_txt,
                                norm_text=norm_txt,
                            )
                        )
            total_non_ws_chars += page_non_ws
            if page_images > 0 and page_non_ws < 10:
                image_only_pages.append(p_num)

            derot = page.derotation_matrix if page.rotation else None

            # Extraction déterministe des tableaux si activée sur cette page
            page_tables: list[dict[str, Any]] = []
            use_tables_on_page = tables_enabled and (
                (table_pages_set is not None and p_num in table_pages_set)
                or (table_pages_set is None and p_num >= table_from_page)
            )
            non_table_spans = page_spans
            if use_tables_on_page:
                tmp_tab_doc = None
                try:
                    if page.rotation:
                        tmp_tab_doc = pymupdf.open()
                        tmp_tab_doc.insert_pdf(doc, from_page=p_idx, to_page=p_idx)
                        tmp_tab_page = tmp_tab_doc[0]
                        tmp_tab_page.set_rotation(0)
                        finder = tmp_tab_page.find_tables()
                        tab_derot = None
                    else:
                        finder = page.find_tables()
                        tab_derot = derot
                    raw_tabs = list(getattr(finder, "tables", None) or [])
                    for t in raw_tabs:
                        tbbox = _apply_derotation(t.bbox, tab_derot)
                        if tbbox is None:
                            continue
                        extracted = t.extract()
                        t_rows = getattr(t, "rows", None) or []
                        acc_rows: list[list[str | None]] = []
                        for ri, row in enumerate(extracted):
                            row_cells = getattr(t_rows[ri], "cells", None) if ri < len(t_rows) else None
                            norm_row: list[str | None] = []
                            for ci, c in enumerate(row):
                                if c is None:
                                    norm_row.append(None)
                                    continue
                                if not c:
                                    norm_row.append("")
                                    continue
                                raw_cbbox = row_cells[ci] if (row_cells is not None and ci < len(row_cells)) else None
                                cbbox = _apply_derotation(raw_cbbox, tab_derot) if raw_cbbox is not None else None
                                c_norm = _normalize_table_cell_pua(
                                    c,
                                    cbbox,
                                    tbbox,
                                    raw_pua_spans,
                                    page_num=p_num,
                                    bilan_obj=bilan_obj,
                                )
                                norm_row.append(re.sub(r"\s+", " ", c_norm).strip())

                            non_empty_cols = [ci for ci, val in enumerate(norm_row) if val]
                            if not non_empty_cols:
                                continue
                            can_merge_rowspan = (
                                bool(acc_rows)
                                and len(norm_row) == len(acc_rows[-1])
                                and norm_row[0] is None
                                and any(val is None for val in norm_row)
                                and all(acc_rows[-1][ci] is not None for ci in non_empty_cols)
                                and (
                                    len(non_empty_cols) == 1
                                    or (
                                        ri == 1
                                        and all((norm_row[ci] or "") == (norm_row[ci] or "").upper() for ci in non_empty_cols)
                                    )
                                )
                            )
                            if can_merge_rowspan:
                                prev_row = acc_rows[-1]
                                for ci in non_empty_cols:
                                    cur_val = norm_row[ci] or ""
                                    prev_val = prev_row[ci] or ""
                                    prev_row[ci] = f"{prev_val} {cur_val}".strip() if prev_val else cur_val
                            else:
                                acc_rows.append(norm_row)

                        fmt_rows = [
                            " | ".join(c for c in r if c)
                            for r in acc_rows
                            if any(c for c in r)
                        ]
                        if fmt_rows:
                            page_tables.append({
                                "page": p_num,
                                "bbox": tbbox,
                                "y0": tbbox[1],
                                "rows": fmt_rows,
                                "ws_spans": 0,
                                "non_ws_spans": 0,
                            })
                finally:
                    if tmp_tab_doc is not None:
                        tmp_tab_doc.close()
                if page_tables:
                    # Exclure les spans contenus dans un tableau (hors bandeaux haut/bas)
                    hdr_y_max = float(running_header_cfg["y_max"]) if running_header_cfg and "y_max" in running_header_cfg else -1.0
                    ftr_y_min = (
                        float(running_footer_cfg["y_ratio_min"]) * page_h
                        if running_footer_cfg and "y_ratio_min" in running_footer_cfg
                        else (
                            float(running_footer_cfg["y_min"])
                            if running_footer_cfg and "y_min" in running_footer_cfg
                            else page_h + 100.0
                        )
                    )
                    kept_spans: list[SpanRecord] = []
                    for sp in page_spans:
                        cx = (sp.x0 + sp.x1) * 0.5
                        cy = (sp.y0 + sp.y1) * 0.5
                        assigned = False
                        if sp.y0 > hdr_y_max and sp.y0 < ftr_y_min:
                            for tb in page_tables:
                                bx0, by0, bx1, by1 = tb["bbox"]
                                if (bx0 - 2.0) <= cx <= (bx1 + 2.0) and (by0 - 2.0) <= cy <= (by1 + 2.0):
                                    if sp.norm_text:
                                        tb["non_ws_spans"] += 1
                                    else:
                                        tb["ws_spans"] += 1
                                    assigned = True
                                    break
                        if not assigned:
                            kept_spans.append(sp)
                    non_table_spans = kept_spans
                    page_tables.sort(key=lambda tb: (tb["y0"], tb["bbox"][0]))

            tables_by_page[p_num] = page_tables
            spans_by_page[p_num] = page_spans
            lines_by_page[p_num] = reconstruct_lines(non_table_spans, y_tolerance=y_tol)

            links_by_page[p_num] = filter_raw_links(
                page.get_links(),
                page_num=p_num,
                page_spans=page_spans,
                derotation_matrix=derot,
                links_cfg=fcfg.get("links"),
            )

        # Porte 0 : refus dur numérisé (zéro OCR, zéro LLM)
        avg_non_ws = total_non_ws_chars / page_count
        if (
            total_non_ws_chars == 0
            or (total_images > 0 and avg_non_ws < 10.0)
            or len(image_only_pages) == page_count
            or len(image_only_pages) > page_count / 2
        ):
            raise ScannedPdfError(
                f"PDF numérisé sans couche texte exploitable refusé (zéro OCR) : {pdf_p.name} "
                f"(pages image={image_only_pages}, car/page={avg_non_ws:.1f})"
            )
        bilan_obj.image_only_pages = image_only_pages
        if image_only_pages:
            bilan_obj.warnings.append(f"Pages image minoritaires détectées : {image_only_pages}")

        # Date de consolidation depuis le texte (jamais /ModDate)
        date_cfg = fcfg.get("consolidation_date")
        if date_cfg:
            consol_date = extract_consolidation_date(lines_by_page, date_cfg)
            setattr(law, f"consol_date_{lang}", consol_date)

        # Signets PDF s'ils existent
        pdf_toc = doc.get_toc(simple=False)
    finally:
        doc.close()

    # --- Parcours des pages : liminaire, corps, annexes ---
    toc_pages = set(int(p) for p in (fcfg.get("toc_pages") or []))
    body_start = int(fcfg.get("body_start_page", 1))
    annexe_start = fcfg.get("annexe_start_page")
    annexe_start_page = int(annexe_start) if annexe_start is not None else (page_count + 1)

    title_blocks = fcfg.get("title_blocks") or []
    closing_blocks = fcfg.get("closing_blocks") or []
    running_header = fcfg.get("running_header")
    running_footer = fcfg.get("running_footer")
    date_re = re.compile(date_cfg["regex"], re.I) if date_cfg else None

    toc_cfg = fcfg.get("toc_parser") or {}
    toc_source = str(toc_cfg.get("source") or ("outline" if pdf_toc else "printed"))
    toc_strip_parens = bool(toc_cfg.get("strip_parentheticals", False))
    toc_excl_numbered = bool(toc_cfg.get("exclude_numbered_articles", False))
    bilan_obj.skip_toc_parity = toc_source == "none"
    bilan_obj.toc_strip_parentheticals = toc_strip_parens
    for ex_h in (fcfg.get("toc_exempt_headings") or []):
        bilan_obj.toc_exempt_headings.append(ex_h)

    prov_cfg = fcfg["provisions"]
    hist_cfg = fcfg["history"]
    foot_cfg = fcfg["footnotes"]
    ann_cfg = fcfg.get("annexes") or {}
    unnumbered_cfgs = fcfg.get("unnumbered_prose_divisions") or []
    unnumbered_by_norm = {_toc_cmp_norm(u["heading"]): u for u in unnumbered_cfgs}

    raw_toc_all = [
        (int(item[0]), str(item[1]).strip(), int(item[2]))
        for item in pdf_toc
        if len(item) >= 3
    ]
    if toc_excl_numbered:
        toc_div_entries_3 = [
            (lvl, title, pg)
            for lvl, title, pg in raw_toc_all
            if not _TOC_NUMBERED_ARTICLE_RE.match(title)
        ]
    else:
        toc_div_entries_3 = raw_toc_all

    ann_mode = str(ann_cfg.get("mode") or "items")
    annexe_toc_queue = (
        [(lvl, title, pg) for lvl, title, pg in toc_div_entries_3 if pg >= annexe_start_page]
        if ann_mode == "full_sections"
        else []
    )
    ann_list_sections = list(ann_cfg.get("list_sections") or [])

    divisions: list[Division] = []
    articles: list[Article] = []
    art_line_boxes: dict[int, list[tuple[int, float, float, float, float]]] = {}
    art_page_sups: dict[int, set[str]] = {}
    art_by_page: dict[int, list[Article]] = collections.defaultdict(list)
    links_acc: dict[int, list[dict[str, str]]] = collections.defaultdict(list)

    toc_raw_lines: list[LineRecord] = []
    pile: list[int] = []
    div_sort_order = 0
    disp_idx = 0
    annexe_seq = 0
    annexe_subgroup_seq = 0
    ann_toc_idx = 0
    ann_ls_idx = 0
    ann_l1_slug: str | None = None
    ann_sub_pile: list[int] = []
    used_slugs: set[str] = set()
    in_annexes = False
    in_trailing_log = False
    trailing_log_art: Article | None = None
    current_div: Division | None = None
    current_article: Article | None = None
    last_opened_node: str | None = None  # "division" | "article"
    last_opened_bucket: str | None = None
    article_title_active = False
    pending_bare_provision = False
    bare_repeal_promoted: tuple[int, str] | None = None
    pending_heading: dict[str, Any] | None = None
    last_prose_meta: tuple[int, float, bool] | None = None  # (page, y0, is_bold)
    last_body_pos: tuple[int, float] | None = None  # (page, y0)
    ann_full_section_rep_arts: set[int] = set()

    ann_start_heading = ann_cfg.get("start_heading") or ""
    ann_subgroups = ann_cfg.get("subgroups") or []
    ann_subgroup_map = {_toc_cmp_norm(s["heading"]): s for s in ann_subgroups}
    for sg in ann_subgroups:
        if not sg.get("in_toc", True):
            bilan_obj.toc_exempt_headings.append(sg["heading"])

    ann_item_re = re.compile(ann_cfg["item_regex"], re.I) if ann_cfg.get("item_regex") else None
    ann_slug_map = {_toc_cmp_norm(k): v for k, v in (ann_cfg.get("slug_map") or {}).items()}
    repeal_re = re.compile(prov_cfg["repeal_regex"], re.I)

    div_re_src = typo.get("division_regex")
    div_re = re.compile(div_re_src) if div_re_src else None
    trailing_log_re_src = hist_cfg.get("trailing_log_regex")
    trailing_log_re = re.compile(trailing_log_re_src, re.I) if trailing_log_re_src else None
    preamble_number = fcfg.get("preamble_number")
    allow_div_intro = bool(typo.get("allow_division_intro_prose", False))

    def _infer_heading_level(txt: str, first_sz: float) -> int:
        if div_re is not None:
            up = txt.upper()
            if up.startswith("PARTIE"):
                return 1
            if up.startswith(("SOUS-SECTION", "SOUS SECTION")):
                return 3
            if up.startswith("SECTION"):
                return 2
        l3_max = typo.get("level3_max_size_pt")
        if l3_max is not None and first_sz <= float(l3_max):
            return 3
        if typo.get("level1_all_caps", True) and txt == txt.upper():
            return 1
        return 2

    def _ensure_pp0_division() -> str:
        if not any(d.path == "pp:0" for d in divisions):
            pre_heading = str(
                fcfg.get("preamble_heading")
                or (
                    "Note préliminaire"
                    if preamble_number == "note-preliminaire"
                    else ("Préambule" if lang == "fr" else "Preamble")
                )
            )
            divisions.insert(
                0,
                Division(
                    law_id=law.id,
                    lang=lang,
                    kind="disposition",
                    path="pp:0",
                    heading=pre_heading,
                    parent_path=None,
                    sort_order=0,
                ),
            )
            if pre_heading not in bilan_obj.toc_exempt_headings:
                bilan_obj.toc_exempt_headings.append(pre_heading)
        return "pp:0"

    def _flush_pending_heading() -> None:
        nonlocal pending_heading, current_div, current_article, last_opened_node, div_sort_order, article_title_active, pending_bare_provision, bare_repeal_promoted, last_body_pos
        if pending_heading is None:
            return
        txt = pending_heading["text"]
        lvl = pending_heading["level"]
        while len(pile) < lvl:
            pile.append(0)
        pile[:] = pile[:lvl]
        pile[lvl - 1] += 1
        path = "-".join(f"ph{i + 1}:{r}" for i, r in enumerate(pile))
        parent_p = paths.parent_path(path)
        div_sort_order += 1
        if lvl == 1:
            kind = typo.get("level1_kind", "partie")
        elif lvl == 2:
            kind = typo.get("level2_kind", "sous-section")
        else:
            kind = typo.get("level3_kind", "sous-section")
        is_div_rep = 1 if _DIV_REPEAL_RE.search(txt.strip()) else 0
        div = Division(
            law_id=law.id,
            lang=lang,
            kind=kind,
            path=path,
            heading=txt,
            repealed=is_div_rep,
            parent_path=parent_p,
            sort_order=div_sort_order,
        )
        divisions.append(div)
        current_div = div
        current_article = None
        article_title_active = False
        pending_bare_provision = False
        bare_repeal_promoted = None
        last_body_pos = None
        last_opened_node = "division"
        pending_heading = None

    def _record_article_line(art: Article, ln: LineRecord) -> None:
        idx = id(art)
        art_line_boxes.setdefault(idx, []).append((ln.page, ln.x0, ln.y0, ln.x1, ln.y1))
        sups = art_page_sups.setdefault(idx, set())
        for sp in ln.spans:
            if (sp.flags & 1) and sp.norm_text.isdigit():
                sups.add(sp.norm_text)
        if art not in art_by_page[ln.page]:
            art_by_page[ln.page].append(art)

    def _record_article_box(art: Article, p_num_box: int, bbox: tuple[float, float, float, float]) -> None:
        art_line_boxes.setdefault(id(art), []).append((p_num_box, bbox[0], bbox[1], bbox[2], bbox[3]))
        if art not in art_by_page[p_num_box]:
            art_by_page[p_num_box].append(art)

    for p_num in range(1, page_count + 1):
        footnote_active_on_page = False
        active_footnote_num: str | None = None
        last_footnote_target: Article | None = None
        page_h = page_heights.get(p_num, 792.0)

        page_lines = lines_by_page.get(p_num, [])
        page_tables = tables_by_page.get(p_num, [])
        # Entrelacer lignes et tableaux par y0 croissant
        events: list[tuple[float, int, str, Any]] = []
        for idx_l, ln in enumerate(page_lines):
            events.append((ln.y0, 0, "line", (idx_l, ln)))
        for idx_t, tb in enumerate(page_tables):
            events.append((tb["y0"], 1, "table", tb))
        events.sort(key=lambda e: (e[0], e[1]))

        skip_line_until = -1
        for _ev_y0, _ev_kind_ord, ev_kind, ev_data in events:
            if ev_kind == "table":
                _flush_pending_heading()
                tb = ev_data
                ws_sp = int(tb["ws_spans"])
                nws_sp = int(tb["non_ws_spans"])
                bilan_obj.add_span("whitespace_only", ws_sp)
                if not in_annexes and p_num >= annexe_start_page:
                    _flush_pending_heading()
                    in_annexes = True
                table_bucket = "annexe" if in_annexes else "table_text"
                bilan_obj.add_span(table_bucket, nws_sp)
                last_opened_bucket = table_bucket
                tbl_text = "\n".join(tb["rows"])
                last_body_pos = None
                if current_article is not None:
                    current_article.text = f"{current_article.text}\n{tbl_text}"
                    if id(current_article) in ann_full_section_rep_arts:
                        current_article.repealed = 0
                        if current_div is not None and current_div.path == current_article.division_path:
                            current_div.repealed = 0
                    _record_article_box(current_article, p_num, tb["bbox"])
                elif in_annexes or tables_cfg.get("fallback_article_prefix"):
                    fb_prefix = str(tables_cfg.get("fallback_article_prefix") or "tableau")
                    div_lbl = current_div.heading if current_div else f"p{p_num}"
                    m_dnum = re.match(r"^(\d+[A-Za-z]*)\b", (div_lbl or "").strip())
                    raw_fb = f"{fb_prefix}-{m_dnum.group(1)}" if m_dnum else f"{fb_prefix}-{div_sort_order or p_num}"
                    art_num = _make_bounded_slug(law.id, raw_fb, used_slugs)
                    _check_vectorize_id_limit(law.id, art_num)
                    disp_idx += 1
                    div_p = current_div.path if current_div else (f"ps:{annexe_seq or 1}" if in_annexes else _ensure_pp0_division())
                    art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=art_num,
                        text=tbl_text,
                        division_path=div_p,
                        sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                    )
                    articles.append(art)
                    current_article = art
                    last_opened_node = "article"
                    _record_article_box(art, p_num, tb["bbox"])
                continue

            idx_l, ln = ev_data
            if idx_l <= skip_line_until:
                continue

            if not ln.norm_text:
                _bucket_line(bilan_obj, ln, "whitespace_only")
                continue

            if _match_band(ln, p_num, running_header, is_header=True, page_height=page_h):
                _bucket_line(bilan_obj, ln, "running_header")
                continue

            if _match_band(ln, p_num, running_footer, is_header=False, page_height=page_h):
                _bucket_line(bilan_obj, ln, "running_footer")
                continue

            if _match_in_box_blocks(ln, p_num, title_blocks) or _match_in_box_blocks(ln, p_num, closing_blocks):
                if date_re and date_re.search(ln.norm_text):
                    _bucket_line(bilan_obj, ln, "consolidation_date")
                else:
                    _bucket_line(bilan_obj, ln, "title_banner")
                last_opened_bucket = "title_banner"
                continue

            if p_num in toc_pages:
                toc_raw_lines.append(ln)
                _bucket_line(bilan_obj, ln, "toc_preliminaire")
                last_opened_bucket = "toc_preliminaire"
                continue

            if p_num < body_start:
                _bucket_line(bilan_obj, ln, "toc_preliminaire")
                last_opened_bucket = "toc_preliminaire"
                continue

            non_ws = _line_non_ws(ln)
            first_sp = non_ws[0]
            x0 = first_sp.x0

            # Journal chronologique de modifications en queue de document (AMF)
            hist_x0_min = float(hist_cfg.get("x0_min", 0.0))
            hist_x0_max = float(hist_cfg.get("x0_max", 999.0))
            if not in_trailing_log and trailing_log_re is not None:
                tl_max_sz = float(hist_cfg.get("trailing_log_max_size_pt", 10.5))
                if (
                    hist_x0_min <= x0 <= hist_x0_max
                    and first_sp.size <= tl_max_sz
                    and trailing_log_re.match(ln.norm_text)
                    and p_num >= max(1, page_count - 5)
                ):
                    _flush_pending_heading()
                    in_trailing_log = True

            if in_trailing_log:
                if trailing_log_art is None:
                    art_num = _make_bounded_slug(law.id, "historique-modifications", used_slugs)
                    _check_vectorize_id_limit(law.id, art_num)
                    disp_idx += 1
                    div_p = current_div.path if current_div else _ensure_pp0_division()
                    trailing_log_art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=art_num,
                        text=ln.norm_text,
                        division_path=div_p,
                        sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                    )
                    articles.append(trailing_log_art)
                    _record_article_line(trailing_log_art, ln)
                else:
                    trailing_log_art.text = f"{trailing_log_art.text}\n{ln.norm_text}"
                    _record_article_line(trailing_log_art, ln)
                _bucket_line(bilan_obj, ln, "history")
                last_opened_bucket = "history"
                continue

            # Transition vers les annexes
            if not in_annexes and (
                p_num >= annexe_start_page
                or (ann_start_heading and _toc_cmp_norm(ln.norm_text) == _toc_cmp_norm(ann_start_heading))
            ):
                _flush_pending_heading()
                in_annexes = True

            if in_annexes:
                norm_ln = _toc_cmp_norm(ln.norm_text)

                # Mode full_sections (AMF) piloté par les signets TOC post-annexe
                if ann_mode == "full_sections" and ann_toc_idx < len(annexe_toc_queue):
                    next_lvl, next_title, next_pg = annexe_toc_queue[ann_toc_idx]
                    if p_num >= next_pg and _is_any_bold(non_ws):
                        target_norm = _toc_cmp_norm(next_title)
                        matched_k = 0
                        cand_lines: list[LineRecord] = []
                        for k in range(1, 5):
                            if idx_l + k - 1 >= len(page_lines):
                                break
                            cand_ln = page_lines[idx_l + k - 1]
                            if not cand_ln.norm_text:
                                break
                            if _match_band(cand_ln, p_num, running_header, is_header=True, page_height=page_h):
                                break
                            if _match_band(cand_ln, p_num, running_footer, is_header=False, page_height=page_h):
                                break
                            cand_lines.append(cand_ln)
                            joined_cand = _toc_cmp_norm(" ".join(c.norm_text for c in cand_lines))
                            if joined_cand == target_norm:
                                matched_k = k
                                break
                        if matched_k > 0:
                            for cln in cand_lines:
                                _bucket_line(bilan_obj, cln, "annexe")
                            skip_line_until = idx_l + matched_k - 1
                            if next_lvl == 1:
                                annexe_seq += 1
                                ann_sub_pile = []
                                ann_path = f"ps:{annexe_seq}"
                                parent_p = None
                                ann_l1_slug = _annexe_section_slug(next_title, None)
                                raw_art_slug = ann_l1_slug
                            else:
                                sub_depth = next_lvl - 1
                                while len(ann_sub_pile) < sub_depth:
                                    ann_sub_pile.append(0)
                                ann_sub_pile[:] = ann_sub_pile[:sub_depth]
                                ann_sub_pile[sub_depth - 1] += 1
                                ann_path = f"ps:{annexe_seq or 1}-" + "-".join(
                                    f"ph{ri + 1}:{rv}" for ri, rv in enumerate(ann_sub_pile)
                                )
                                parent_p = paths.parent_path(ann_path)
                                raw_art_slug = _annexe_section_slug(next_title, ann_l1_slug)
                            div_sort_order += 1
                            is_ann_rep = 1 if _DIV_REPEAL_RE.search(next_title.strip()) else 0
                            div = Division(
                                law_id=law.id,
                                lang=lang,
                                kind="annexe",
                                path=ann_path,
                                heading=next_title,
                                repealed=is_ann_rep,
                                parent_path=parent_p,
                                sort_order=div_sort_order,
                            )
                            divisions.append(div)
                            current_div = div

                            art_num = _make_bounded_slug(law.id, raw_art_slug, used_slugs)
                            _check_vectorize_id_limit(law.id, art_num)
                            disp_idx += 1
                            art = Article(
                                law_id=law.id,
                                lang=lang,
                                number=art_num,
                                text=next_title,
                                division_path=ann_path,
                                repealed=is_ann_rep,
                                sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                            )
                            articles.append(art)
                            if is_ann_rep:
                                ann_full_section_rep_arts.add(id(art))
                            current_article = art
                            last_opened_node = "article"
                            last_opened_bucket = "annexe"
                            for cln in cand_lines:
                                _record_article_line(art, cln)
                            ann_toc_idx += 1
                            continue

                # Mode list_sections (ex. DAA)
                if ann_ls_idx < len(ann_list_sections):
                    ls_cfg = ann_list_sections[ann_ls_idx]
                    if p_num >= int(ls_cfg["page"]) and _is_any_bold(non_ws):
                        ls_norm = _toc_cmp_norm(ls_cfg["heading"])
                        matched_k = 0
                        cand_lines = []
                        for k in range(1, 5):
                            if idx_l + k - 1 >= len(page_lines):
                                break
                            cand_ln = page_lines[idx_l + k - 1]
                            if not cand_ln.norm_text:
                                break
                            cand_lines.append(cand_ln)
                            if _toc_cmp_norm(" ".join(c.norm_text for c in cand_lines)) == ls_norm:
                                matched_k = k
                                break
                        if matched_k > 0:
                            for cln in cand_lines:
                                _bucket_line(bilan_obj, cln, "annexe")
                            skip_line_until = idx_l + matched_k - 1
                            annexe_seq += 1
                            div_sort_order += 1
                            ann_path = f"ps:{annexe_seq}"
                            div = Division(
                                law_id=law.id,
                                lang=lang,
                                kind="annexe",
                                path=ann_path,
                                heading=ls_cfg["heading"],
                                parent_path=None,
                                sort_order=div_sort_order,
                            )
                            divisions.append(div)
                            current_div = div

                            art_num = ls_cfg["article_number"]
                            _check_vectorize_id_limit(law.id, art_num)
                            used_slugs.add(art_num)
                            disp_idx += 1
                            art = Article(
                                law_id=law.id,
                                lang=lang,
                                number=art_num,
                                text=ls_cfg["heading"],
                                division_path=ann_path,
                                sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                            )
                            articles.append(art)
                            current_article = art
                            last_opened_node = "article"
                            last_opened_bucket = "annexe"
                            for cln in cand_lines:
                                _record_article_line(art, cln)
                            ann_ls_idx += 1
                            continue

                if ann_start_heading and norm_ln == _toc_cmp_norm(ann_start_heading):
                    annexe_seq += 1
                    div_sort_order += 1
                    ann_path = f"ps:{annexe_seq}"
                    div = Division(
                        law_id=law.id,
                        lang=lang,
                        kind="annexe",
                        path=ann_path,
                        heading=ln.norm_text,
                        parent_path=None,
                        sort_order=div_sort_order,
                    )
                    divisions.append(div)
                    current_div = div
                    current_article = None
                    last_opened_node = "division"
                    last_opened_bucket = "annexe"
                    _bucket_line(bilan_obj, ln, "annexe")
                    continue

                if norm_ln in ann_subgroup_map:
                    annexe_subgroup_seq += 1
                    div_sort_order += 1
                    root_path = f"ps:{annexe_seq or 1}"
                    sg_path = f"{root_path}-ph1:{annexe_subgroup_seq}"
                    div = Division(
                        law_id=law.id,
                        lang=lang,
                        kind="annexe",
                        path=sg_path,
                        heading=ln.norm_text,
                        parent_path=root_path,
                        sort_order=div_sort_order,
                    )
                    divisions.append(div)
                    current_div = div
                    current_article = None
                    last_opened_node = "division"
                    last_opened_bucket = "annexe"
                    _bucket_line(bilan_obj, ln, "annexe")
                    continue

                item_x0_min = float(ann_cfg.get("item_x0_min", 82.0))
                item_x0_max = float(ann_cfg.get("item_x0_max", 96.0))
                m_item = ann_item_re.match(ln.norm_text) if (ann_item_re and item_x0_min <= x0 <= item_x0_max) else None
                if m_item:
                    prefix_raw = m_item.group("prefix")
                    num_raw = m_item.group("num")
                    rest_raw = (m_item.group("rest") or "").strip()
                    slug = ann_slug_map.get(_toc_cmp_norm(prefix_raw), re.sub(r"[^a-z0-9]+", "-", (_toc_cmp_norm(prefix_raw))).strip("-"))
                    art_num = f"{slug}-{num_raw}"
                    _check_vectorize_id_limit(law.id, art_num)

                    is_rep = 0
                    hist_val: str | None = None
                    if re.match(r"^(?:Abrogation\s*:|Abrog[ée]\.?)", rest_raw, re.I):
                        is_rep = 1
                        hist_val = rest_raw

                    disp_idx += 1
                    div_p = current_div.path if current_div else f"ps:{annexe_seq or 1}"
                    art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=art_num,
                        text=ln.norm_text,
                        division_path=div_p,
                        history=hist_val,
                        repealed=is_rep,
                        sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                    )
                    articles.append(art)
                    current_article = art
                    last_opened_node = "article"
                    last_opened_bucket = "annexe"
                    _record_article_line(art, ln)
                    _bucket_line(bilan_obj, ln, "annexe")
                    continue

                if current_article is not None:
                    hist_cont_sz = hist_cfg.get("continue_while_max_size_pt")
                    is_hist_cont = (
                        hist_cont_sz is not None
                        and last_opened_bucket == "history"
                        and hist_x0_min <= x0 <= hist_x0_max
                        and first_sp.size <= float(hist_cont_sz)
                        and (div_re is None or not div_re.match(ln.norm_text))
                    )
                    if match_history_line(ln, hist_cfg) or is_hist_cont:
                        sep_h = " " if is_hist_cont else "\n"
                        current_article.history = (
                            f"{current_article.history}{sep_h}{ln.norm_text}"
                            if current_article.history
                            else ln.norm_text
                        )
                        _bucket_line(bilan_obj, ln, "history")
                        last_opened_bucket = "history"
                        continue
                    if (
                        id(current_article) in ann_full_section_rep_arts
                        and first_sp.size > float(hist_cfg.get("max_size_pt", 9.5))
                        and not repeal_re.match(ln.norm_text)
                    ):
                        current_article.repealed = 0
                        if current_div is not None and current_div.path == current_article.division_path:
                            current_div.repealed = 0
                    sep = "\n" if (
                        (
                            bool(ann_list_sections)
                            and current_div is not None
                            and current_article.text == current_div.heading
                        )
                        or (
                            ann_mode == "full_sections"
                            and (
                                _is_all_bold_non_italic(non_ws)
                                or _SUBITEM_NUM_RE.match(ln.norm_text)
                                or _SUBITEM_ALPHA_PAREN_RE.match(ln.norm_text)
                                or _BULLET_RE.match(ln.norm_text)
                                or current_article.text.endswith((".", ":", ")"))
                            )
                        )
                    ) else " "
                    current_article.text = f"{current_article.text}{sep}{ln.norm_text}"
                    _record_article_line(current_article, ln)
                    _bucket_line(bilan_obj, ln, "annexe")
                    last_opened_bucket = "annexe"
                    continue

                _bucket_line(bilan_obj, ln, "unclassified")
                continue

            # --- Pages de corps ---
            # Priorité A : Note de bas de page
            foot_y0_min = float(foot_cfg.get("y0_min", 650.0))
            foot_lead_max = float(foot_cfg.get("lead_size_max_pt", 7.5))
            foot_body_max = float(foot_cfg.get("body_size_max_pt", 10.5))
            foot_x0_min = float(foot_cfg.get("x0_min", 85.0))
            foot_x0_max = float(foot_cfg.get("x0_max", 125.0))
            allow_inline_foot = bool(foot_cfg.get("allow_inline_lead", False))
            if ln.y0 >= foot_y0_min and foot_x0_min <= x0 <= foot_x0_max:
                m_fnum = re.match(r"^(\d+)(?:\s|$)", first_sp.norm_text) if allow_inline_foot else None
                is_lead = first_sp.size <= foot_lead_max and (
                    first_sp.norm_text.isdigit() or m_fnum is not None
                )
                is_cont = (
                    footnote_active_on_page
                    and first_sp.size <= foot_body_max
                    and "BoldItalic" not in first_sp.base_font
                )
                if is_lead or is_cont:
                    if is_lead:
                        footnote_active_on_page = True
                        active_footnote_num = m_fnum.group(1) if m_fnum else first_sp.norm_text
                        target = next(
                            (a for a in reversed(art_by_page[p_num]) if active_footnote_num in art_page_sups.get(id(a), set())),
                            None,
                        )
                        if target is None:
                            target = art_by_page[p_num][-1] if art_by_page[p_num] else current_article
                        last_footnote_target = target
                        if target is not None:
                            target.footnotes = f"{target.footnotes}\n{ln.norm_text}" if target.footnotes else ln.norm_text
                    elif last_footnote_target is not None:
                        last_footnote_target.footnotes = (
                            f"{last_footnote_target.footnotes} {ln.norm_text}"
                            if last_footnote_target.footnotes
                            else ln.norm_text
                        )
                    _bucket_line(bilan_obj, ln, "footnote")
                    last_opened_bucket = "footnote"
                    continue

            # Priorité B : Historique (préfixe + typographie, ou continuation 9pt multi-lignes)
            hist_cont_sz = hist_cfg.get("continue_while_max_size_pt")
            is_hist_cont = (
                hist_cont_sz is not None
                and last_opened_bucket == "history"
                and hist_x0_min <= x0 <= hist_x0_max
                and first_sp.size <= float(hist_cont_sz)
                and (div_re is None or not div_re.match(ln.norm_text))
            )
            if match_history_line(ln, hist_cfg) or is_hist_cont:
                _flush_pending_heading()
                sep_h = " " if is_hist_cont else "\n"
                if last_opened_node == "division" and current_div is not None:
                    current_div.history = f"{current_div.history}{sep_h}{ln.norm_text}" if current_div.history else ln.norm_text
                elif current_article is not None:
                    current_article.history = (
                        f"{current_article.history}{sep_h}{ln.norm_text}" if current_article.history else ln.norm_text
                    )
                else:
                    _bucket_line(bilan_obj, ln, "unclassified")
                    continue
                _bucket_line(bilan_obj, ln, "history")
                last_opened_bucket = "history"
                continue

            # Priorité C : Intitulé de division
            h_x0_min = float(typo.get("heading_x0_min", 88.0))
            h_x0_max = float(typo.get("heading_x0_max", 96.0))
            h_wrap_x0_max = float(typo.get("heading_wrap_x0_max", h_x0_max))
            h_min_sz = float(typo.get("heading_min_size_pt", 11.5))
            req_all_bold = bool(typo.get("heading_require_all_bold", True))
            excl_numbered = bool(typo.get("heading_exclude_numbered_provisions", False))
            p_x0_min = float(prov_cfg.get("x0_min", 85.0))
            p_x0_max = float(prov_cfg.get("x0_max", 96.0))
            p_min_sz = float(prov_cfg.get("min_size_pt", 10.5))
            num_mode = str(prov_cfg.get("number_mode", "numeric"))
            req_dot_num = bool(prov_cfg.get("require_dot_in_number", False))
            wrap_dy = float(typo.get("heading_wrap_dy_max_pt", 17.0))

            # Suite d'un pending_heading en cours (peut déborder sur x0 <= h_wrap_x0_max ou être BoldItalic pour ABROGÉE)
            is_heading_wrap = (
                pending_heading is not None
                and pending_heading["page"] == p_num
                and (ln.y0 - pending_heading["last_y0"]) <= wrap_dy
                and h_x0_min <= x0 <= h_wrap_x0_max
                and first_sp.size >= h_min_sz
                and (_is_any_bold(non_ws) if div_re is not None else (_is_all_bold_non_italic(non_ws) if req_all_bold else True))
                and match_provision_prefix(ln.norm_text, number_mode=num_mode, require_dot_in_number=req_dot_num) is None
                and (div_re is None or not div_re.match(ln.norm_text))
            )
            if is_heading_wrap:
                pending_heading["text"] = f"{pending_heading['text']} {ln.norm_text}"
                pending_heading["last_y0"] = ln.y0
                if div_re is None and typo.get("level1_all_caps", True):
                    l3_max = typo.get("level3_max_size_pt")
                    if l3_max is not None and first_sp.size <= float(l3_max):
                        pending_heading["level"] = 3
                    else:
                        pending_heading["level"] = 1 if pending_heading["text"] == pending_heading["text"].upper() else 2
                _bucket_line(bilan_obj, ln, "heading_or_division")
                last_opened_bucket = "heading_or_division"
                continue

            is_heading = (
                h_x0_min <= x0 <= h_x0_max
                and first_sp.size >= h_min_sz
                and (_is_all_bold_non_italic(non_ws) if req_all_bold else True)
                and (div_re is None or bool(div_re.match(ln.norm_text)))
            )
            if is_heading and excl_numbered and p_x0_min <= x0 <= p_x0_max and first_sp.size >= p_min_sz:
                if match_provision_prefix(ln.norm_text, number_mode=num_mode, require_dot_in_number=req_dot_num) is not None:
                    is_heading = False
            if is_heading:
                _flush_pending_heading()
                lvl = _infer_heading_level(ln.norm_text, first_sp.size)
                pending_heading = {
                    "page": p_num,
                    "last_y0": ln.y0,
                    "text": ln.norm_text,
                    "level": lvl,
                }
                _bucket_line(bilan_obj, ln, "heading_or_division")
                last_opened_bucket = "heading_or_division"
                continue

            _flush_pending_heading()

            # Priorité D : Disposition numérotée
            req_bold_lead = bool(prov_cfg.get("require_bold_lead", False))
            titled_mode = bool(prov_cfg.get("titled_heading_mode", False))
            if (
                p_x0_min <= x0 <= p_x0_max
                and first_sp.size >= p_min_sz
                and (not req_bold_lead or _is_bold_lead_non_italic(non_ws))
            ):
                prov = match_provision_prefix(
                    ln.norm_text,
                    number_mode=num_mode,
                    require_dot_in_number=req_dot_num,
                )
                if prov is not None:
                    num, body = prov
                    _check_vectorize_id_limit(law.id, num)
                    is_rep = 1 if (body and repeal_re.match(body)) else 0
                    div_p = current_div.path if current_div else _ensure_pp0_division()
                    art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=num,
                        text=body or ln.norm_text,
                        division_path=div_p,
                        repealed=is_rep,
                    )
                    articles.append(art)
                    current_article = art
                    last_opened_node = "article"
                    article_title_active = titled_mode and not is_rep and _is_bold_lead_non_italic(non_ws)
                    pending_bare_provision = (not body) and (not is_rep)
                    bare_repeal_promoted = None
                    last_body_pos = (p_num, ln.y0)
                    _record_article_line(art, ln)
                    bkt = "repeal_marker" if is_rep else "numbered_provision"
                    _bucket_line(bilan_obj, ln, bkt)
                    last_opened_bucket = bkt
                    continue

            # Priorité E : Division de prose non numérotée (ex. listes de jurisprudence, PRÉAMBULE)
            if current_div is not None and _toc_cmp_norm(current_div.heading) in unnumbered_by_norm:
                u_cfg = unnumbered_by_norm[_toc_cmp_norm(current_div.heading)]
                u_min_x0 = float(u_cfg.get("min_x0", 0.0))
                if x0 >= u_min_x0:
                    is_bold_topic = _is_all_bold_non_italic(non_ws)
                    if current_article is None or current_article.division_path != current_div.path:
                        art_num = u_cfg["article_number"]
                        _check_vectorize_id_limit(law.id, art_num)
                        used_slugs.add(art_num)
                        if "sort_key_override" in u_cfg:
                            sk_val = int(u_cfg["sort_key_override"])
                        else:
                            disp_idx += 1
                            sk_val = DISPOSITION_SORT_BASE + disp_idx * 1_000_000
                        art = Article(
                            law_id=law.id,
                            lang=lang,
                            number=art_num,
                            text=ln.norm_text,
                            division_path=current_div.path,
                            sort_key=sk_val,
                        )
                        articles.append(art)
                        current_article = art
                        last_opened_node = "article"
                        article_title_active = False
                        last_prose_meta = (p_num, ln.y0, is_bold_topic)
                    else:
                        new_entry = _is_new_unnumbered_entry(
                            current_article.text,
                            ln.norm_text,
                            p_num=p_num,
                            y0=ln.y0,
                            is_bold_topic=is_bold_topic,
                            last_prose_meta=last_prose_meta,
                        )
                        sep = "\n" if new_entry else " "
                        current_article.text = f"{current_article.text}{sep}{ln.norm_text}"
                        last_prose_meta = (p_num, ln.y0, is_bold_topic)
                    _record_article_line(current_article, ln)
                    _bucket_line(bilan_obj, ln, "jurisprudence_list")
                    last_opened_bucket = "jurisprudence_list"
                    continue

            # Priorité E2 : Préambule avant la 1re division (ex. encadré note-preliminaire AMF)
            if preamble_number and current_div is None and x0 >= h_x0_min:
                if current_article is None:
                    _check_vectorize_id_limit(law.id, preamble_number)
                    used_slugs.add(preamble_number)
                    div_p = _ensure_pp0_division()
                    art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=preamble_number,
                        text=ln.norm_text,
                        division_path=div_p,
                        sort_key=0,
                    )
                    articles.append(art)
                    current_article = art
                    last_opened_node = "article"
                    article_title_active = False
                else:
                    current_article.text = f"{current_article.text} {ln.norm_text}"
                _record_article_line(current_article, ln)
                _bucket_line(bilan_obj, ln, "body_text")
                last_opened_bucket = "body_text"
                continue

            # Priorité E3 : Prose introductive de division avant le 1er article numéroté
            if allow_div_intro and current_div is not None and x0 >= h_x0_min and (
                current_article is None or current_article.number.startswith("intro-")
            ):
                if current_article is None:
                    intro_slug = _make_bounded_slug(law.id, f"intro-{current_div.heading or div_sort_order}", used_slugs)
                    _check_vectorize_id_limit(law.id, intro_slug)
                    disp_idx += 1
                    art = Article(
                        law_id=law.id,
                        lang=lang,
                        number=intro_slug,
                        text=ln.norm_text,
                        division_path=current_div.path,
                        sort_key=DISPOSITION_SORT_BASE + disp_idx * 1_000_000,
                    )
                    articles.append(art)
                    current_article = art
                    last_opened_node = "article"
                    article_title_active = False
                    last_body_pos = (p_num, ln.y0)
                else:
                    dy_same_page = (
                        (ln.y0 - last_body_pos[1])
                        if (last_body_pos is not None and last_body_pos[0] == p_num)
                        else None
                    )
                    sep_intro = (
                        "\n"
                        if _is_subitem_or_new_para(
                            ln.norm_text,
                            x0,
                            h_x0_min,
                            current_article.text,
                            dy_same_page=dy_same_page,
                        )
                        else " "
                    )
                    current_article.text = f"{current_article.text}{sep_intro}{ln.norm_text}"
                    last_body_pos = (p_num, ln.y0)
                _record_article_line(current_article, ln)
                _bucket_line(bilan_obj, ln, "body_text")
                last_opened_bucket = "body_text"
                continue

            # Priorité F : Sous-éléments et continuations
            sub_x0_min = float(prov_cfg.get("subitem_x0_min", 115.0))
            if (
                pending_bare_provision
                and current_article is not None
                and x0 >= min(p_x0_min, sub_x0_min)
                and repeal_re.match(ln.norm_text)
            ):
                opening_raw = current_article.text
                current_article.repealed = 1
                current_article.text = ln.norm_text
                pending_bare_provision = False
                article_title_active = False
                bare_repeal_promoted = (id(current_article), opening_raw)
                last_body_pos = (p_num, ln.y0)
                _record_article_line(current_article, ln)
                _bucket_line(bilan_obj, ln, "repeal_marker")
                last_opened_bucket = "repeal_marker"
                continue
            allow_alpha_dot = bool(prov_cfg.get("allow_alpha_dot_subitems", False))
            if current_article is not None and x0 >= sub_x0_min:
                pending_bare_provision = False
                if bare_repeal_promoted is not None and bare_repeal_promoted[0] == id(current_article):
                    current_article.repealed = 0
                    current_article.text = f"{bare_repeal_promoted[1]} {current_article.text}"
                    bare_repeal_promoted = None
                if article_title_active and _is_all_bold_non_italic(non_ws):
                    current_article.text = f"{current_article.text} {ln.norm_text}"
                    last_body_pos = (p_num, ln.y0)
                    _record_article_line(current_article, ln)
                    _bucket_line(bilan_obj, ln, "body_text")
                    last_opened_bucket = "body_text"
                    continue
                new_para_from_title = article_title_active
                article_title_active = False
                is_sub = bool(
                    _SUBITEM_NUM_RE.match(ln.norm_text)
                    or _SUBITEM_ROMAN_RE.match(ln.norm_text)
                    or _SUBITEM_ALPHA_PAREN_RE.match(ln.norm_text)
                    or (allow_alpha_dot and _SUBITEM_ALPHA_DOT_RE.match(ln.norm_text))
                    or _BULLET_RE.match(ln.norm_text)
                )
                dy_same_page = (
                    (ln.y0 - last_body_pos[1])
                    if (last_body_pos is not None and last_body_pos[0] == p_num)
                    else None
                )
                sep = (
                    "\n"
                    if _is_subitem_or_new_para(
                        ln.norm_text,
                        x0,
                        sub_x0_min,
                        current_article.text,
                        allow_alpha_dot=allow_alpha_dot,
                        new_para_from_title=new_para_from_title,
                        dy_same_page=dy_same_page,
                    )
                    else " "
                )
                current_article.text = f"{current_article.text}{sep}{ln.norm_text}"
                last_body_pos = (p_num, ln.y0)
                _record_article_line(current_article, ln)
                bkt = "subitem" if is_sub else "body_text"
                _bucket_line(bilan_obj, ln, bkt)
                last_opened_bucket = bkt
                continue

            # Fallback : span non classé -> Porte 1 échouera
            _bucket_line(bilan_obj, ln, "unclassified")

    _flush_pending_heading()

    # --- Rattachement des liens par intersection de bbox ---
    for p_num, page_links in links_by_page.items():
        page_arts = art_by_page.get(p_num, [])
        if not page_arts:
            continue
        for lk in page_links:
            lbox = lk["bbox"]
            best_art: Article | None = None
            best_area = 0.0
            for a in page_arts:
                for p, bx0, by0, bx1, by1 in art_line_boxes.get(id(a), []):
                    if p != p_num:
                        continue
                    if _rect_intersects(lbox, (bx0 - 1.0, by0 - 2.0, bx1 + 1.0, by1 + 2.0)):
                        ix0 = max(lbox[0], bx0)
                        iy0 = max(lbox[1], by0)
                        ix1 = min(lbox[2], bx1)
                        iy1 = min(lbox[3], by1)
                        area = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0) + 1e-3
                        if area > best_area:
                            best_area = area
                            best_art = a
            if best_art is None:
                # Repli : article le plus proche verticalement au-dessus ou sur la ligne
                ly = lbox[1]
                best_dist = float("inf")
                for a in page_arts:
                    for p, _bx0, by0, _bx1, by1 in art_line_boxes.get(id(a), []):
                        if p == p_num:
                            dist = abs(ly - by0)
                            if by0 <= ly + 4.0 and dist < best_dist:
                                best_dist = dist
                                best_art = a
            if best_art is not None:
                links_acc[id(best_art)].append({"label": lk["label"], "url": lk["url"]})

    for a in articles:
        raw_art_links = links_acc.get(id(a))
        if raw_art_links:
            a.links = deduplicate_article_links(raw_art_links)

    # --- Porte 1 : Bilan de matière 100 % des spans ---
    if bilan_obj.unclassified > 0 or bilan_obj.accounted_spans != bilan_obj.total_spans or bilan_obj.total_spans == 0:
        raise SpanBilanError(
            f"Porte 1 (Bilan des spans) en échec pour {law.id}/{lang} : "
            f"comptabilisés={bilan_obj.accounted_spans}, total={bilan_obj.total_spans}, "
            f"non_classés={bilan_obj.unclassified}"
        )

    # --- Porte 2 : Parité TDM/signets <-> Divisions + unicité des clés ---
    if toc_source == "none":
        bilan_obj.toc_titles = []
    else:
        if toc_source == "printed" or not pdf_toc:
            toc_entries = parse_printed_toc(toc_raw_lines, toc_cfg)
        else:
            toc_entries = [(lvl, title) for lvl, title, _pg in toc_div_entries_3]

        bilan_obj.toc_titles = [title for _, title in toc_entries]
        exempt_norm = {_toc_cmp_norm(h, strip_parentheticals=toc_strip_parens) for h in bilan_obj.toc_exempt_headings}
        toc_c = collections.Counter(
            _toc_cmp_norm(t, strip_parentheticals=toc_strip_parens)
            for t in bilan_obj.toc_titles
            if _toc_cmp_norm(t, strip_parentheticals=toc_strip_parens)
        )
        div_c = collections.Counter(
            _toc_cmp_norm(d.heading, strip_parentheticals=toc_strip_parens)
            for d in divisions
            if _toc_cmp_norm(d.heading, strip_parentheticals=toc_strip_parens)
            and _toc_cmp_norm(d.heading, strip_parentheticals=toc_strip_parens) not in exempt_norm
        )
        if toc_c != div_c:
            missing = sorted((toc_c - div_c).elements())
            extra = sorted((div_c - toc_c).elements())
            raise TocParityError(
                f"Porte 2 (parité TDM <-> divisions) en échec pour {law.id}/{lang} : "
                f"manquantes={missing[:5]}, excédentaires={extra[:5]}"
            )

    seen_nums: set[str] = set()
    for a in articles:
        if a.number in seen_nums:
            raise TocParityError(f"Doublon de numéro d'article ({law.id}/{lang}) : {a.number!r}")
        seen_nums.add(a.number)
    seen_paths: set[str] = set()
    for d in divisions:
        if d.path in seen_paths:
            raise TocParityError(f"Doublon de chemin de division ({law.id}/{lang}) : {d.path!r}")
        seen_paths.add(d.path)

    replacements = fcfg.get("text_replacements") or []
    apply_text_replacements(
        divisions,
        articles,
        replacements,
        fonction=profile.get("fonction"),
        law_id=law.id,
        lang=lang,
    )

    return divisions, articles


def apply_text_replacements(
    divisions: list[Division],
    articles: list[Article],
    replacements: list[dict[str, Any]],
    *,
    fonction: str | None,
    law_id: str,
    lang: str,
) -> None:
    """Applique des corrections typographiques déclaratives (directives uniquement, fail-closed si 0 effet)."""
    if not replacements:
        return
    if fonction != "directive":
        raise PdfParseError("text_replacements n'est autorisé que sur fonction='directive' (R4).")
    for rule in replacements:
        src = str(rule.get("from") or "")
        dst = str(rule.get("to") or "")
        if not src or src == dst:
            raise PdfParseError(f"Règle text_replacements invalide dans {law_id}/{lang} : {rule!r}")
        hits = 0
        for d in divisions:
            if d.heading and src in d.heading:
                hits += d.heading.count(src)
                d.heading = d.heading.replace(src, dst)
        for a in articles:
            if a.text and src in a.text:
                hits += a.text.count(src)
                a.text = a.text.replace(src, dst)
            if a.links:
                items = json.loads(a.links)
                changed = False
                for item in items:
                    lbl = item.get("label")
                    if isinstance(lbl, str) and src in lbl:
                        hits += lbl.count(src)
                        item["label"] = lbl.replace(src, dst)
                        changed = True
                if changed:
                    a.links = json.dumps(items, ensure_ascii=False)
        if hits == 0:
            raise PdfParseError(f"text_replacements sans effet dans {law_id}/{lang} : {src!r}")


def write_preview_md(
    out_dir: Path,
    law: Law,
    lang: str,
    divisions: list[Division],
    articles: list[Article],
    bilan: PdfBilan,
) -> Path:
    """Écrit `pipeline/out/<law_id>-<lang>.preview.md` en UTF-8 LF sans BOM."""
    out_dir.mkdir(parents=True, exist_ok=True)
    preview_path = out_dir / f"{law.id}-{lang}.preview.md"
    consol = getattr(law, f"consol_date_{lang}", None) or "inconnue"
    lines: list[str] = [
        f"# Aperçu d'ingestion PDF — {law.id} ({lang})",
        "",
        f"- **Titre :** {law.name_fr if lang == 'fr' else law.name_en}",
        f"- **Citation :** {law.rlrq_cite}",
        f"- **Source :** `pdf` (`unit={law.unit}`)",
        f"- **Date de consolidation :** `{consol}`",
        f"- **SHA-256 :** `{bilan.source_sha256}`",
        f"- **Bilan des spans :** {bilan.accounted_spans}/{bilan.total_spans} comptabilisés (`{bilan.unclassified}` non classé)",
        f"- **Divisions :** {len(divisions)} · **Articles :** {len(articles)}",
        "",
        "## Arborescence des divisions",
        "",
    ]
    for d in divisions:
        hist_note = f" — *{d.history}*" if d.history else ""
        lines.append(f"- `{d.path}` (`{d.kind}`) : {d.heading or ''}{hist_note}")

    lines.extend(["", "## Extraits et articles complets", ""])
    for a in articles:
        status = " *(abrogé)*" if a.repealed else ""
        lines.append(f"### {a.number}{status} — `{a.division_path}`")
        lines.append("")
        lines.append(a.text)
        if a.history:
            lines.append("")
            lines.append(f"*Historique :* {a.history}")
        if a.footnotes:
            lines.append("")
            lines.append(f"*Note(s) :* {a.footnotes}")
        if a.links:
            lines.append("")
            lines.append(f"*Liens :* `{a.links}`")
        lines.append("")

    preview_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return preview_path
