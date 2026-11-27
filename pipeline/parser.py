from __future__ import annotations

import re
import unicodedata
import warnings
import zipfile
from pathlib import Path

from bs4 import BeautifulSoup, Tag
from bs4 import XMLParsedAsHTMLWarning

from .model import Article, Division, Law, DISPOSITION_SORT_BASE
from .norm import normalize

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

_KIND_BY_PREFIX = {
    "ga": "livre", "gb": "titre", "gc": "chapitre", "gd": "section",
    "ge": "sous-section", "gf": "niveau6", "gg": "niveau7", "gi": "niveau8",
}
_LANG = {
    "fr": {
        "labels": {"livre": "LIVRE", "titre": "TITRE", "chapitre": "CHAPITRE", "section": "SECTION"},
        "preliminary": "DISPOSITION PRÉLIMINAIRE",
        "finales": "DISPOSITIONS FINALES",
    },
    "en": {
        "labels": {"livre": "BOOK", "titre": "TITLE", "chapitre": "CHAPTER", "section": "DIVISION"},
        "preliminary": "PRELIMINARY PROVISION",
        "finales": "FINAL PROVISIONS",
    },
}
_REPEALED_RE = re.compile(r"\(?(?:Abrog|Repea)")

_MARKER = re.compile(r"-(?:h1|t1|nb|ss|p\d)(?::|-|$)")
_SEG_SPLIT = re.compile(r"-(?=(?:ga|gb|gc|gd|ge|gf|gg|gh|gi):)")
_ART_ID = re.compile(r"^se:\d+(?:_\d+)*$")

_LINK_SCHEME = re.compile(r"^[a-z]+:", re.I)

def is_division_id(eid: str) -> bool:
    return eid.startswith("ga:") and not _MARKER.search(eid)

def _segments(eid: str) -> list[str]:
    return _SEG_SPLIT.split(eid)

def _parent_path(eid: str) -> str | None:
    segs = _segments(eid)
    return "-".join(segs[:-1]) if len(segs) > 1 else None

def number_from_article_id(eid: str) -> str:
    return eid[len("se:"):].replace("_", ".")

def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")

def _strip_hidden(tag: Tag) -> None:
    for el in tag.find_all(True):
        if not el.parent:
            continue
        cls = el.get("class") or []
        style = el.get("style") or ""
        if any("Hidden" in c for c in cls) or re.search(r"display\s*:\s*none", style):
            el.decompose()

def _clean_attrs(tag: Tag) -> None:
    for el in tag.find_all(True):
        for key in list(el.attrs):
            if "integrity" in key or key.startswith("xmlns") or key == "style":
                del el.attrs[key]
        href = el.get("href")
        if href and not _LINK_SCHEME.match(href):
            el["href"] = "https://" + href.lstrip("/")

def _norm(text: str) -> str:
    text = "".join(" " if unicodedata.category(ch) == "Zs" else ch for ch in text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def _history_block(container: Tag) -> Tag | None:
    ligne = container.find("div", class_="ligne")
    return ligne.parent if ligne else None

def _add_paragraph_breaks(scope: Tag) -> None:
    for p in scope.find_all("div", id=_MARKER_P):
        p.insert_before("\n")

_MARKER_P = re.compile(r"-p[12]:")
_NOTE_ID = re.compile(r"^(?:d\d+e|Note)")

def _strip_notes(scope: Tag) -> None:
    for n in scope.find_all(id=_NOTE_ID):
        n.decompose()
    for n in scope.find_all(class_="noteInTable"):
        n.decompose()

def _render_tables(scope: Tag) -> None:
    for t in scope.find_all("table"):
        rows = []
        for tr in t.find_all("tr"):
            cells = [c for c in (_norm(td.get_text()) for td in tr.find_all(["td", "th"])) if c]
            if cells:
                rows.append(" : ".join(cells))
        t.replace_with("\n" + "\n".join(rows) + "\n" if rows else "")

def extract_article_body(container: Tag, number: str) -> tuple[str, str | None, str | None, int]:
    eid = container.get("id")
    work = _soup(str(container))
    root = work.find(id=eid)
    _strip_hidden(root)

    hb = _history_block(root)
    history = _norm(hb.get_text()) if hb else None
    if hb:
        hb.decompose()

    ss_re = re.compile(re.escape(eid) + r"-ss:\d+$")
    text_source = _soup(str(root)).find(id=eid)
    _strip_notes(text_source)
    _render_tables(text_source)
    text_ss = [d for d in text_source.find_all("div", id=True) if ss_re.fullmatch(d.get("id"))]

    def _strip_leading_number(s: str) -> str:
        return re.sub(r"^" + re.escape(number) + r"\s*\.\s*", "", s, count=1)

    parts: list[str] = []
    if text_ss:
        for k, d in enumerate(text_ss):
            _add_paragraph_breaks(d)
            t = _norm(d.get_text())
            if k == 0:
                t = _strip_leading_number(t)
            if t:
                parts.append(t)
    else:
        _add_paragraph_breaks(text_source)
        t = _strip_leading_number(_norm(text_source.get_text()))
        if t:
            parts.append(t)
    text = "\n\n".join(parts)
    repealed = 1 if re.match(r"^\((?:Abrog|Repea)", text) else 0

    _clean_attrs(root)
    for anchor in root.find_all("a", attrs={"name": True}):
        if not anchor.get_text(strip=True):
            anchor.decompose()
    html = str(root)

    return text, html, history, repealed

def extract_division(el: Tag, law_id: str, lang: str, sort_order: int, labels: dict[str, str]) -> Division:
    eid = el.get("id")
    prefix = _segments(eid)[-1].split(":")[0]
    kind = _KIND_BY_PREFIX[prefix]
    seg_value = _segments(eid)[-1].split(":", 1)[1]

    number = heading = history = None
    repealed = 0

    h1 = el.find(id=eid + "-h1")
    if h1 is not None:
        work = _soup(str(h1))
        h1c = work.find(id=eid + "-h1")
        _strip_hidden(h1c)
        hb = _history_block(h1c)
        if hb:
            history = _norm(hb.get_text())
            hb.decompose()
        nb = h1c.find(id=re.compile(re.escape(eid) + r"-h1-t\d+-nb:\d+"))
        if nb is not None:
            heading = _norm(nb.get_text())
        full = _norm(h1c.get_text())
        if heading and heading in full:
            label = full[: full.rfind(heading)].strip()
        else:
            label = full
        repealed = 1 if _REPEALED_RE.search(full) else 0

        word = labels.get(kind)
        if seg_value.startswith("s_"):
            number = None
            if heading is None:
                heading = label or None
        elif word and word in label:
            number = _norm(label.split(word, 1)[1]) or None
        elif kind == "sous-section":
            m = re.match(r"(§\s*[^\s.—]+)", full)
            number = m.group(1).strip() if m else None
            if heading is None:
                it = h1c.find("span", style=re.compile("italic"))
                heading = _norm(it.get_text()) if it else None
        else:
            m = re.match(r"([IVXLCDM0-9]+)\s*\.", full)
            number = m.group(1) if m else None
            if heading is None:
                it = h1c.find("span", style=re.compile("italic"))
                heading = _norm(it.get_text()) if it else None

        if repealed and number:
            number = _REPEALED_RE.split(number)[0].strip() or None
        if number:
            number = number.rstrip(". ").strip() or None
        if repealed:
            heading = None

    return Division(
        law_id=law_id, lang=lang, kind=kind, path=eid,
        number=number, heading=heading, history=history, repealed=repealed,
        parent_path=_parent_path(eid), sort_order=sort_order,
    )

def _extract_disposition(block: Tag, number: str, heading: str, path: str, kind: str) -> tuple[Division, Article]:
    work = _soup(str(block))
    root = work.find(True)
    _strip_hidden(root)
    hb = _history_block(root)
    history = _norm(hb.get_text()) if hb else None
    if hb:
        hb.decompose()
    for d in root.find_all("div"):
        d.insert_before("\n\n")
    full = _norm(root.get_text())
    full = re.sub(r"^\s*" + re.escape(heading) + r"\s*", "", full, flags=re.S).strip()
    _clean_attrs(root)
    html = str(root)
    div = Division(law_id="", lang="", kind=kind, path=path,
                   number=None, heading=heading, history=None, repealed=0,
                   parent_path=None, sort_order=0)
    art = Article(law_id="", lang="", number=number, text=full, division_path=path,
                  html=html, history=history, repealed=0)
    return div, art

def _parse_preliminary(soup: BeautifulSoup, marker: str) -> tuple[Division, Article] | None:
    ligne = soup.find("div", class_="ligne")
    if ligne is None:
        return None
    node = ligne
    while node is not None and node.parent is not None:
        node = node.parent
        if marker in node.get_text():
            return _extract_disposition(node, "préliminaire", marker, "disposition-preliminaire", "disposition")
    return None

_DISP_CANON = {
    "schedule": "annexe",
    "schedules": "annexe",
    "annexes": "annexe",
    "form": "formulaire",
    "forms": "formulaire",
    "formule": "formulaire",
    "formules": "formulaire",
    "formulaires": "formulaire",
}

def _disposition_number(heading: str) -> tuple[str, str]:
    h = normalize(heading or "") or ""
    if "final" in h:
        return "finales", "disposition"
    m = re.match(
        r"(annexes?|formulaires?|formules?|schedules?|forms?)\b\.?\s*"
        r"([ivxlcdm\d][ivxlcdm\d.]*|[a-z]+)?",
        h,
    )
    if m:
        label = _DISP_CANON.get(m.group(1), m.group(1))
        tokens = [label] + ([m.group(2)] if m.group(2) else [])
        return re.sub(r"[^a-z0-9]+", "-", "-".join(tokens)).strip("-"), "annexe"
    slug = re.sub(r"[^a-z0-9]+", "-", h).strip("-")[:24]
    if not slug or re.fullmatch(r"[\d-]+", slug):
        slug = f"annexe-{slug}" if slug else "annexe"
    return slug, "annexe"

def _parse_sc_block_el(cont: Tag, cfg: dict) -> tuple[Division, Article]:
    head_el = cont.find(id=re.compile(r"^d\d+e"))
    heading = _norm(head_el.get_text()).split("\n")[0][:50] if head_el else cfg["finales"]
    number, kind = _disposition_number(heading)
    return _extract_disposition(cont, number, heading, number, kind)

def _spine_documents(zf: zipfile.ZipFile) -> list[str]:
    container = _soup(zf.read("META-INF/container.xml").decode("utf-8"))
    opf_path = container.find("rootfile")["full-path"]
    opf_dir = str(Path(opf_path).parent).replace("\\", "/")
    opf = _soup(zf.read(opf_path).decode("utf-8"))
    manifest = {it["id"]: it["href"] for it in opf.find_all("item")}
    docs = []
    for ref in opf.find("spine").find_all("itemref"):
        href = manifest[ref["idref"]]
        docs.append(f"{opf_dir}/{href}" if opf_dir and opf_dir != "." else href)
    return docs

def opf_metadata(zf: zipfile.ZipFile) -> dict:
    container = _soup(zf.read("META-INF/container.xml").decode("utf-8"))
    opf = _soup(zf.read(container.find("rootfile")["full-path"]).decode("utf-8"))

    def g(tag: str) -> str | None:
        el = opf.find(tag)
        return _norm(el.get_text()) if el else None

    return {"title": g("dc:title"), "language": g("dc:language"), "date": g("dc:date")}

_HREF_CHAPTER = re.compile(r"showDoc/(?:cs|cr)/([^?\"&/#]+)", re.I)

def harvest_renvois(htmls) -> dict[str, int]:
    import urllib.parse
    from collections import Counter
    counts: Counter = Counter()
    for html in htmls:
        for m in _HREF_CHAPTER.finditer(html or ""):
            counts[urllib.parse.unquote(m.group(1)).strip()] += 1
    return dict(counts)

_PURE_REPEAL_STUB_RE = re.compile(r"^\((?:Abrog[ée]|Repealed)\)\.?$")

def parse_epub(epub_path: str | Path, law: Law, lang: str) -> tuple[list[Division], list[Article]]:
    cfg = _LANG.get(lang, _LANG["fr"])
    divisions: list[Division] = []
    articles: list[Article] = []
    sort_order = 0

    disp_idx = 0
    all_paths: set[str] = set()
    dup_counts: dict[str, int] = {}

    def add_special(res):
        nonlocal sort_order, disp_idx
        if not res:
            return
        div, art = res
        if not art.text and art.number not in ("préliminaire",):
            return
        div.law_id = art.law_id = law.id
        div.lang = art.lang = lang
        div.sort_order = sort_order
        if art.number == "préliminaire":
            art.sort_key = 0
        else:
            art.sort_key = DISPOSITION_SORT_BASE + disp_idx * 1_000_000
            disp_idx += 1
        sort_order += 1
        divisions.append(div)
        articles.append(art)

    with zipfile.ZipFile(epub_path) as zf:
        for doc in _spine_documents(zf):
            try:
                html = zf.read(doc).decode("utf-8")
            except KeyError:
                continue
            soup = _soup(html)
            resolved_by_tag: dict[int, tuple[str, str]] = {}

            current_div_path: str | None = None
            for el in soup.find_all(id=True):
                eid = el.get("id")
                if is_division_id(eid):
                    base_path = eid
                    for anc in el.parents:
                        if id(anc) in resolved_by_tag:
                            anc_raw, anc_res = resolved_by_tag[id(anc)]
                            if eid.startswith(anc_raw + "-"):
                                base_path = anc_res + eid[len(anc_raw):]
                                break
                    if base_path not in all_paths:
                        path = base_path
                        dup_counts[base_path] = 1
                    else:
                        k = dup_counts.get(base_path, 1) + 1
                        while f"{base_path}__{k}" in all_paths:
                            k += 1
                        dup_counts[base_path] = k
                        path = f"{base_path}__{k}"
                    all_paths.add(path)
                    resolved_by_tag[id(el)] = (eid, path)

                    div = extract_division(el, law.id, lang, sort_order, cfg["labels"])
                    div.path = path
                    div.parent_path = _parent_path(path)
                    sort_order += 1
                    divisions.append(div)
                    current_div_path = path
                elif _ART_ID.fullmatch(eid):
                    text, art_html, history, repealed = extract_article_body(el, number_from_article_id(eid))
                    articles.append(Article(
                        law_id=law.id, lang=lang, number=number_from_article_id(eid),
                        text=text, html=art_html, history=history, repealed=repealed,
                        division_path=current_div_path or "",
                    ))

            if cfg["preliminary"] in html:
                add_special(_parse_preliminary(soup, cfg["preliminary"]))
            for sc in soup.find_all(id=re.compile(r"^sc-nb:\d+$")):
                add_special(_parse_sc_block_el(sc, cfg))

    ordinary_by_num: dict[str, list[Article]] = {}
    for art in articles:
        if art.sort_key is None:
            ordinary_by_num.setdefault(art.number, []).append(art)
    stale_ghosts: set[int] = set()
    for group in ordinary_by_num.values():
        if len(group) == 2 and {a.repealed for a in group} == {0, 1}:
            stub = next(a for a in group if a.repealed == 1)
            if _PURE_REPEAL_STUB_RE.fullmatch(stub.text.strip()):
                stale_ghosts.add(id(stub))
    if stale_ghosts:
        articles = [a for a in articles if id(a) not in stale_ghosts]

    return divisions, articles
