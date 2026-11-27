from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

from . import config, d1_api, load, validate
from .model import Law
from .parser import opf_metadata, parse_epub

_FR_MONTHS = {
    "janvier": 1, "février": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "août": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12,
}

OUT_DIR = config.REPO_ROOT / "pipeline" / "out"
DB_NAME = "legislation"

def _sample_path(law_id: str, lang: str) -> Path:
    return config.SAMPLES_DIR / f"{law_id.upper()}-{lang}.epub"

_LANGS = ("fr", "en")

def _configured_langs(cfg_law: dict) -> tuple[str, ...]:
    if cfg_law.get("source") == "pdf":
        langs = cfg_law.get("langs") or list((cfg_law.get("pdf") or {"fr": ""}).keys())
        return tuple(l for l in _LANGS if l in langs)
    return _LANGS

def _id_base(law_id: str, lang: str) -> int:
    law_ids = [law["id"] for law in config.load_all_laws()]
    combo = law_ids.index(law_id) * len(_LANGS) + _LANGS.index(lang)
    return combo * 10_000_000

def _download(url: str, dest: Path) -> Path:
    if not url.startswith("https://"):
        raise ValueError(f"Schéma URL non autorisé : {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
        f.write(resp.read())
    return dest

def _law_from_config(cfg_law: dict) -> Law:
    consol = cfg_law.get("consolidation", {})
    return Law(
        id=cfg_law["id"], name_fr=cfg_law["name_fr"],
        name_en=cfg_law.get("name_en") or cfg_law["name_fr"],
        official_cite=cfg_law["official_cite"],
        consol_date_fr=consol.get("fr"), consol_date_en=consol.get("en"),
        official_cite_en=cfg_law.get("official_cite_en"),
        chapter=cfg_law.get("chapter"),
        jurisdiction=cfg_law.get("jurisdiction", "qc"),
        unit=cfg_law.get("unit", "article"),
        source=cfg_law.get("source", "epub"),
        domain=cfg_law.get("domain", "core"),
    )

def extrait_consolidation_quebec(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    for d in soup.find_all("div", class_="text-end"):
        m = re.search(
            r"jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})",
            re.sub(r"\s+", " ", d.get_text()),
            re.I,
        )
        if m and m.group(2).lower() in _FR_MONTHS:
            return f"{m.group(3)}-{_FR_MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    return None

def fetch_consolidation(url: str, essais: int = 4) -> str | None:
    if not url.startswith("https://"):
        raise ValueError(f"Schéma URL non autorisé : {url}")
    for essai in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
            html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception:
            if essai + 1 < essais:
                time.sleep(3 * (2**essai))
                continue
            return None
        return extrait_consolidation_quebec(html)
    return None

class DateDeConsolidationIntrouvable(Exception):
    pass

_DATE_FEDERALE = re.compile(r"(?:jour|current\s+to)\s*(\d{4}-\d{2}-\d{2})", re.I)

def extrait_consolidation_federale(html: str) -> str | None:
    bloc = BeautifulSoup(html, "html.parser").find("p", id="assentedDate")
    if bloc is None:
        return None
    m = _DATE_FEDERALE.search(re.sub(r"\s+", " ", bloc.get_text()))
    return m.group(1) if m else None

def fetch_consolidation_federale(url: str, essais: int = 4) -> str | None:
    if not url.startswith("https://"):
        raise ValueError(f"Schéma URL non autorisé : {url}")
    for essai in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
            html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception:
            if essai + 1 < essais:
                time.sleep(3 * (2**essai))
                continue
            return None
        date = extrait_consolidation_federale(html)
        return date
    return None

def _ecrit_et_applique(law_id: str, lang: str, law, divisions, articles, rep,
                       show: list[str], strict: bool,
                       apply_local: bool, apply_remote: bool) -> int:
    for num in show:
        a = next((x for x in articles if x.number == num), None)
        if a is None:
            print(f"\n[art {num} introuvable]")
            continue
        print(f"\n===== ARTICLE {a.number} (loi={a.law_id}, lang={a.lang}, abrogé={a.repealed}) =====")
        print(f"division_path : {a.division_path}")
        print(f"historique    : {a.history}")
        print("--- texte ---")
        print(a.text)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sql_path = OUT_DIR / f"{law_id}-{lang}.sql"
    sql_path.write_text(load.to_sql(law, divisions, articles, lang), encoding="utf-8", newline="\n")
    print(f"\nSQL écrit : {sql_path}  ({sql_path.stat().st_size // 1024} Ko, "
          f"{len(divisions)} divisions, {len(articles)} articles)")

    if strict and not rep.ok:
        print("Invariants en échec -> bascule refusée (utiliser --no-strict pour forcer).")
        return 1

    for remote in ([False] if apply_local else []) + ([True] if apply_remote else []):
        flag = "--remote" if remote else "--local"
        print(f"\nApplication des données en D1 {flag} …")
        cmd = [
            d1_api.npx_command(), "wrangler", "d1", "execute", DB_NAME, flag,
            f"--file={sql_path}", *(["-y"] if remote else []),
        ]
        res = subprocess.run(cmd, cwd=config.REPO_ROOT)
        if res.returncode != 0:
            print(f"wrangler a échoué (code {res.returncode}).")
            return res.returncode
    return 0 if rep.ok else 2

def _acquiert_lims(
    cfg_law: dict,
    law,
    lang: str,
    allow_not_in_force: bool,
    consol_date_override: str | None = None,
):
    import xml.etree.ElementTree as ET

    from pipeline import parser_lims

    chemin = cfg_law["xml"][lang]
    print(f"Lecture {chemin} @ {config.LIMS_REF} ({law.id}/{lang}) …")
    data = parser_lims.git_show_lims(config.LIMS_REF, chemin)
    source_sha256 = hashlib.sha256(data).hexdigest()
    racine = ET.fromstring(data)

    cite, chapitre = parser_lims.derive_citation(racine, lang)
    attendue = cfg_law.get("official_cite" if lang == "fr" else "official_cite_en")
    if attendue and cite != attendue:
        raise parser_lims.BalisageIncoherent(
            f"citation recalculée « {cite} » ≠ citation de la config « {attendue} » "
            f"(SPEC §4 invariant 6) — arrêt"
        )
    setattr(law, "official_cite" if lang == "fr" else "official_cite_en", cite)
    law.chapter = chapitre
    law.jurisdiction = "ca"
    law.source = "lims"
    law.unit = cfg_law.get("unit", "article")
    law.in_force = parser_lims.derive_in_force(racine)
    law.last_amended = racine.get("{http://justice.gc.ca/lims}lastAmendedDate")
    titre = parser_lims.derive_titre(racine)
    if lang == "fr":
        law.name_fr = titre
    else:
        law.name_en = titre
    consol = (
        consol_date_override
        if consol_date_override is not None
        else fetch_consolidation_federale(cfg_law["official_source"][lang])
    )
    if not consol:
        raise DateDeConsolidationIntrouvable(
            f"{law.id}/{lang} : la page officielle "
            f"({cfg_law['official_source'][lang]}) n'a pas rendu sa date « à jour ». "
            f"Causes possibles : page injoignable, ou Justice Canada a changé le bloc "
            f"`<p id=\"assentedDate\">` dont `fetch_consolidation_federale` est le miroir. "
            f"Ingestion REFUSÉE : servir un texte sans dire de quand il date, ou avec une "
            f"date d'une autre provenance que celle que la veille compare, est un faux "
            f"silencieux. Corriger la source, pas le repli."
        )
    setattr(law, f"consol_date_{lang}", consol)

    if not law.in_force and not allow_not_in_force:
        raise parser_lims.BalisageIncoherent(
            f"{law.id} est ÉDICTÉE mais NON EN VIGUEUR (racine <{racine.tag.split('}')[-1]}> "
            f"sans in-force='yes'). Ingestion refusée : servir un texte non en vigueur comme "
            f"du droit applicable est le pire défaut possible. Forcer avec "
            f"--allow-not-in-force, en sachant ce que cela implique."
        )

    bilan = parser_lims.Bilan()
    bilan.source_sha256 = source_sha256  # type: ignore[attr-defined]
    divisions, articles = parser_lims.parse_lims(data, law, lang, bilan=bilan)
    print(f"  bilan de matière : {bilan.as_dict()}")
    return divisions, articles, bilan

def _acquiert_pdf(cfg_law: dict, law: Law, lang: str, *, out_dir: Path | None = None):
    from pipeline import parser_pdf

    pdf_files = cfg_law.get("pdf") or {}
    if lang not in pdf_files:
        raise FileNotFoundError(f"{law.id}/{lang} : aucun fichier PDF configuré pour '{lang}'.")
    pdf_path = config.SAMPLES_DIR / pdf_files[lang]
    if not pdf_path.exists():
        raise FileNotFoundError(
            f"{law.id}/{lang} : PDF absent de {pdf_path} (aucun téléchargement sur domaine bloqué)."
        )
    profile_path = config.REPO_ROOT / "pipeline" / "pdf_profiles" / f"{law.id}.json"
    if not profile_path.exists():
        raise FileNotFoundError(f"{law.id} : profil PDF absent ({profile_path}).")

    law.source = "pdf"
    law.jurisdiction = cfg_law.get("jurisdiction", "qc")
    default_unit = "paragraphe" if cfg_law.get("fonction") == "directive" else "article"
    law.unit = cfg_law.get("unit", default_unit)

    bilan = parser_pdf.PdfBilan()
    print(f"Parsing PDF {pdf_path.name} ({law.id}/{lang}) …")
    divisions, articles = parser_pdf.parse_pdf(
        pdf_path, law, lang, profile_path=profile_path, bilan=bilan
    )
    preview_path = parser_pdf.write_preview_md(
        out_dir or OUT_DIR, law, lang, divisions, articles, bilan
    )
    print(f"  bilan des spans : {bilan.as_dict()}")
    print(f"  aperçu écrit    : {preview_path}")
    return divisions, articles, bilan

def validate_pdf_combo(
    law_id: str,
    lang: str,
    divisions: list[Division],
    articles: list[Article],
    bilan,
    *,
    jurisdiction: str | None = None,
    fonction: str | None = None,
    allow_witness_drift: bool = False,
):
    return validate.validate(
        law_id,
        lang,
        divisions,
        articles,
        jurisdiction=jurisdiction,
        fonction=fonction,
        span_accounting=bilan.span_accounting,
        toc_titles=None if getattr(bilan, "skip_toc_parity", False) else bilan.toc_titles,
        toc_exempt_headings=bilan.toc_exempt_headings,
        toc_strip_parentheticals=getattr(bilan, "toc_strip_parentheticals", False),
        allow_witness_drift=allow_witness_drift,
    )

def run(law_id: str, lang: str, download: bool, apply_local: bool, apply_remote: bool,
        show: list[str], strict: bool, refresh_dates: bool = False,
        allow_not_in_force: bool = False) -> int:
    cfg_law = config.get_law_any(law_id)
    law = _law_from_config(cfg_law)

    if cfg_law.get("source") == "lims":
        divisions, articles, _bilan = _acquiert_lims(cfg_law, law, lang, allow_not_in_force)
        load.prepare(law, divisions, articles, id_base=_id_base(law_id, lang))
        rep = validate.validate(law_id, lang, divisions, articles,
                                jurisdiction="ca", numeros_refuses=_bilan.numeros_refuses)
        print("\n".join(rep.lines))
        print(f"\nRésultat des invariants : {'OK ✅' if rep.ok else 'ÉCHEC ❌'}")
        return _ecrit_et_applique(law_id, lang, law, divisions, articles, rep,
                                  show, strict, apply_local, apply_remote)

    if cfg_law.get("source") == "pdf":
        if lang not in _configured_langs(cfg_law):
            print(f"{law_id}/{lang} : texte PDF unilingue FR uniquement — langue '{lang}' ignorée.")
            return 0
        divisions, articles, bilan = _acquiert_pdf(cfg_law, law, lang)
        load.prepare(law, divisions, articles, id_base=_id_base(law_id, lang))
        rep = validate_pdf_combo(
            law_id, lang, divisions, articles, bilan,
            jurisdiction=law.jurisdiction,
            fonction=cfg_law.get("fonction"),
            allow_witness_drift=False,
        )
        print("\n".join(rep.lines))
        print(f"\nRésultat des invariants : {'OK ✅' if rep.ok else 'ÉCHEC ❌'}")
        return _ecrit_et_applique(law_id, lang, law, divisions, articles, rep,
                                  show, strict, apply_local, apply_remote)

    epub = _sample_path(law_id, lang)
    if download or not epub.exists():
        url = cfg_law["epub"][lang]
        print(f"Téléchargement {url} -> {epub}")
        try:
            _download(url, epub)
        except Exception as e:
            if lang == "en":
                print(f"EN indisponible pour {law_id} ({e}) — langue ignorée.")
                return 0
            raise

    if lang == "en":
        import zipfile
        with zipfile.ZipFile(epub) as zf:
            title = opf_metadata(zf)["title"]
        if title:
            law.name_en = title

    if refresh_dates:
        src = cfg_law.get("consolidation_source", {}).get(lang)
        date = fetch_consolidation(src) if src else None
        if date:
            print(f"Date de consolidation ({lang}) captée sur la page : {date}")
            setattr(law, f"consol_date_{lang}", date)
        else:
            print(f"Date de consolidation ({lang}) non captée — repli sur la config.")

    print(f"Parsing {epub.name} ({law_id}/{lang}) …")
    divisions, articles = parse_epub(epub, law, lang)
    load.prepare(law, divisions, articles, id_base=_id_base(law_id, lang))

    rep = validate.validate(law_id, lang, divisions, articles)
    import re as _re
    import zipfile as _zip
    se_ids: set[str] = set()
    with _zip.ZipFile(epub) as zf:
        for n in zf.namelist():
            if _re.search(r"page\d+\.xhtml$", n):
                se_ids |= set(_re.findall(r'id="(se:\d+(?:_\d+)*)"', zf.read(n).decode("utf-8", "replace")))
    real = [a for a in articles if not validate.is_disposition(a.number)]
    if len(real) != len(se_ids):
        rep.ok = False
        rep.lines.append(f"  ✗ comptes phase B : {len(real)} articles réels vs {len(se_ids)} se: (scan)")
    print("\n".join(rep.lines))
    print(f"\nRésultat des invariants : {'OK ✅' if rep.ok else 'ÉCHEC ❌'}")

    return _ecrit_et_applique(law_id, lang, law, divisions, articles, rep,
                              show, strict, apply_local, apply_remote)

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Pipeline d'ingestion Lois du Québec (EPUB -> D1).")
    p.add_argument("--law", default="ccq")
    p.add_argument("--lang", default="fr", choices=["fr", "en"])
    p.add_argument("--all", action="store_true", help="Traiter TOUTES les lois de laws.config.json × les deux langues.")
    p.add_argument("--download", action="store_true", help="Retélécharger l'EPUB depuis LégisQuébec.")
    p.add_argument("--refresh-dates", action="store_true",
                   help="Capter la date de consolidation live sur la page de la loi.")
    p.add_argument("--apply-local", action="store_true", help="Appliquer le SQL en D1 local.")
    p.add_argument("--apply-remote", action="store_true", help="Appliquer le SQL en D1 cloud (auth requise).")
    p.add_argument("--show", nargs="*", default=[], help="Numéros d'articles à afficher (ex. 1457).")
    p.add_argument("--allow-not-in-force", action="store_true",
                   help="Ingerer un texte EDICTE mais NON EN VIGUEUR. Par defaut refuse : "
                        "servir un texte non en vigueur comme du droit applicable est le "
                        "pire defaut possible. F-29.2 est le seul cas connu du corpus.")
    p.add_argument("--no-strict", dest="strict", action="store_false",
                   help="Générer/appliquer même si des invariants échouent.")
    a = p.parse_args(argv)

    if a.all:
        combos = [
            (law["id"], lang)
            for law in config.load_all_laws()
            for lang in _configured_langs(law)
        ]
    else:
        combos = [(a.law, a.lang)]

    worst = 0
    for law_id, lang in combos:
        print(f"\n{'=' * 60}\n### {law_id}/{lang}\n{'=' * 60}")
        rc = run(law_id, lang, a.download, a.apply_local, a.apply_remote,
                 a.show, a.strict, a.refresh_dates, a.allow_not_in_force)
        worst = max(worst, rc)
    return worst

if __name__ == "__main__":
    sys.exit(main())
