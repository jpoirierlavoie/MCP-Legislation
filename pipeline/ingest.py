"""Orchestrateur du pipeline (PLAN §4). Ex. :

    python -m pipeline.ingest --law ccq --lang fr                 # parse + valide + génère le SQL
    python -m pipeline.ingest --law ccq --lang fr --apply-local   # + applique en D1 local
    python -m pipeline.ingest --law ccq --lang fr --show 1457     # affiche un article pour contrôle

Par défaut, l'EPUB est lu depuis pipeline/samples/ ; --download le récupère depuis LégisQuébec.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

from . import config, load, validate
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


# Décalage d'id par (loi, langue) : garantit des clés primaires globalement uniques
# (divisions.id / articles.id sont partagées entre lois/langues, chargées une à la fois).
# 10^7 par combinaison >> max d'articles (~3525) ou de divisions (~800).
_LANGS = ("fr", "en")


def _id_base(law_id: str, lang: str) -> int:
    law_ids = [law["id"] for law in config.load_all_laws()]
    combo = law_ids.index(law_id) * len(_LANGS) + _LANGS.index(lang)
    return combo * 10_000_000


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
        f.write(resp.read())
    return dest


def _law_from_config(cfg_law: dict) -> Law:
    consol = cfg_law.get("consolidation", {})
    return Law(
        # name_en est livré à null (§5) : repli temporaire sur name_fr
        # (name_en NOT NULL) ; le vrai name_en est posé au chargement EN depuis l'OPF.
        id=cfg_law["id"], name_fr=cfg_law["name_fr"],
        name_en=cfg_law.get("name_en") or cfg_law["name_fr"],
        # La CLÉ de config est `official_cite` depuis 0004 ; le CHAMP du dataclass garde
        # `rlrq_cite` le temps de la migration (cf. `pipeline/load.py::_CHAMP`).
        rlrq_cite=cfg_law["official_cite"],
        consol_date_fr=consol.get("fr"), consol_date_en=consol.get("en"),
    )


def fetch_consolidation(url: str) -> str | None:
    """Extrait la date « À jour au JJ mois AAAA » (ISO) de la page HTML de la loi.
    LégisQuébec l'affiche en français même sur les pages EN. Non fatal : None si échec."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
        html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    except Exception:
        return None
    soup = BeautifulSoup(html, "html.parser")
    for d in soup.find_all("div", class_="text-end"):
        m = re.search(r"jour au\s*(\d{1,2})\s*(?:er)?\s*([A-Za-zÀ-ÿ]+)\s*(\d{4})",
                      re.sub(r"\s+", " ", d.get_text()), re.I)
        if m and m.group(2).lower() in _FR_MONTHS:
            return f"{m.group(3)}-{_FR_MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    return None


class DateDeConsolidationIntrouvable(Exception):
    """La page officielle n'a pas rendu sa date « à jour ». L'ingestion s'arrête."""


# Ancrage sur la PHRASE, jamais sur la première date du bloc : `<p id="assentedDate">` en
# porte DEUX — « à jour AAAA-MM-JJ » puis « dernière modification AAAA-MM-JJ ». Mesuré le
# 2026-09-14 : les 36 pages portent le bloc, la phrase, et au moins deux dates, donc
# l'ancrage distingue réellement les deux au lieu de tomber juste par ordre d'apparition.
# Le « à » arrive tantôt en entité (`&agrave;`, pages de lois) tantôt en littéral (pages de
# règlements) : on s'ancre sur « jour », qui n'apparaît nulle part ailleurs dans ce bloc.
# C'est aussi ce qui permet au miroir JavaScript de la veille — qui dépouille les balises
# par expression régulière et NE DÉCODE PAS les entités — de rendre exactement la même
# valeur que BeautifulSoup ici.
_DATE_FEDERALE = re.compile(r"(?:jour|current\s+to)\s*(\d{4}-\d{2}-\d{2})", re.I)


def extrait_consolidation_federale(html: str) -> str | None:
    """Date « à jour AAAA-MM-JJ » / « current to AAAA-MM-JJ » d'une page de Justice Canada.

    **Miroir** de `extractConsolidationFederale` (`scripts/check-consolidation.mjs`) : même
    portée (le seul `<p id="assentedDate">`), même ancrage, même sortie. La date y est DÉJÀ
    en ISO — aucune table de mois n'est requise, contrairement au couple québécois.

    Séparée du téléchargement précisément pour être éprouvable HORS RÉSEAU, comme l'est son
    miroir JavaScript. Le couple québécois n'a cette séparation que du côté JS, et
    `fetch_consolidation` n'a donc aucun test Python — on ne reproduit pas ce trou ici,
    d'autant que cette moitié-ci peut désormais REFUSER une ingestion.

    Portée bornée au bloc, comme le couple québécois l'est aux blocs `text-end` : la page
    porte d'autres dates (dernière modification, historique), et les lire serait un faux
    silencieux. `None` = bloc absent ou phrase introuvable, c'est-à-dire « le miroir a
    peut-être cassé » — jamais « la page est à jour ».
    """
    bloc = BeautifulSoup(html, "html.parser").find("p", id="assentedDate")
    if bloc is None:
        return None
    m = _DATE_FEDERALE.search(re.sub(r"\s+", " ", bloc.get_text()))
    return m.group(1) if m else None


def fetch_consolidation_federale(url: str, essais: int = 3) -> str | None:
    """Frère fédéral de `fetch_consolidation` : télécharge, puis délègue l'extraction.

    REPRISE BORNÉE, et elle n'affaiblit rien. Une lecture ratée est FATALE ici (cf.
    `_acquiert_lims`), donc un aléa réseau abattait une réingestion de 36 combos au
    quinzième — constaté le 2026-09-14 sur `ca-c-44/en`, dont la page répondait 200 et
    rendait sa date à la seconde suivante. Réessayer la MÊME page n'est pas un repli sur
    une autre source : la garantie — « la date vient de la page, ou rien » — est intacte.

    Asymétrie VOULUE avec la veille (`scripts/check-consolidation.mjs`), qui ne réessaie
    pas : là-bas, une page injoignable est le SIGNAL que le job doit rapporter, et la
    réessayer le masquerait. Ici, c'est un obstacle à une opération humaine supervisée.
    """
    for essai in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
            html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
        except Exception:
            if essai + 1 < essais:
                time.sleep(2 * (essai + 1))
                continue
            return None
        date = extrait_consolidation_federale(html)
        # Une page atteinte mais ILLISIBLE n'est pas un aléa : c'est le miroir qui a
        # peut-être cassé. On ne la réessaie pas — on rend None, et l'appelant refuse.
        return date
    return None


def _ecrit_et_applique(law_id: str, lang: str, law, divisions, articles, rep,
                       show: list[str], strict: bool,
                       apply_local: bool, apply_remote: bool) -> int:
    """Queue COMMUNE aux deux sources : --show, écriture du SQL, porte --strict, bascule D1.

    Extraite plutôt que dupliquée : c'est ici que vit la porte qui REFUSE la bascule quand
    un invariant échoue (`pipeline/ingest.py`, historiquement les lignes 158-160). Deux
    copies de cette porte divergeraient, et l'une des deux finirait par ne plus refuser.
    """
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
    # newline="\n" : NE PAS traduire les \n en \r\n sous Windows, sinon les \n\n entre
    # alinéas seraient stockés en \r\n\r\n dans le texte des articles.
    sql_path.write_text(load.to_sql(law, divisions, articles, lang), encoding="utf-8", newline="\n")
    print(f"\nSQL écrit : {sql_path}  ({sql_path.stat().st_size // 1024} Ko, "
          f"{len(divisions)} divisions, {len(articles)} articles)")

    if strict and not rep.ok:
        print("Invariants en échec -> bascule refusée (utiliser --no-strict pour forcer).")
        return 1

    for remote in ([False] if apply_local else []) + ([True] if apply_remote else []):
        flag = "--remote" if remote else "--local"
        print(f"\nApplication des données en D1 {flag} …")
        cmd = f'npx wrangler d1 execute {DB_NAME} {flag} --file="{sql_path}"' + (" -y" if remote else "")
        res = subprocess.run(cmd, shell=True, cwd=config.REPO_ROOT)
        if res.returncode != 0:
            print(f"wrangler a échoué (code {res.returncode}).")
            return res.returncode
    return 0 if rep.ok else 2


def _acquiert_lims(cfg_law: dict, law, lang: str, allow_not_in_force: bool):
    """Acquisition + parsing d'un texte FÉDÉRAL. Rend (divisions, articles, bilan).

    Pendant du bloc EPUB, et volontairement SÉPARÉ de lui : quatre choses y sont propres à
    LégisQuébec et n'ont aucun sens ici — le téléchargement HTTP, le titre anglais lu dans
    l'OPF d'un zip, le scrapage de la date « À jour au », et le scan des identifiants `se:`
    de l'invariant « phase B ». Les laisser sur le chemin commun les ferait tomber sur un
    fichier XML lu par `git show`.

    L'invariant de comptage est remplacé par le BILAN DE MATIÈRE, que `parse_lims` impose
    lui-même : il compte par PROVENANCE et refuse de rendre un résultat si une seule
    `Section` du fichier n'a été ni ingérée ni refusée. C'est strictement plus fort que le
    scan « phase B », qui ne compare que deux totaux.
    """
    import xml.etree.ElementTree as ET

    from pipeline import parser_lims

    chemin = cfg_law["xml"][lang]
    print(f"Lecture {chemin} @ {config.LIMS_REF} ({law.id}/{lang}) …")
    data = parser_lims.git_show_lims(config.LIMS_REF, chemin)
    racine = ET.fromstring(data)

    # Métadonnées DÉRIVÉES du fichier, jamais recopiées de la config (R10).
    cite, chapitre = parser_lims.derive_citation(racine, lang)
    attendue = cfg_law.get("official_cite" if lang == "fr" else "official_cite_en")
    if attendue and cite != attendue:
        raise parser_lims.BalisageIncoherent(
            f"citation recalculée « {cite} » ≠ citation de la config « {attendue} » "
            f"(SPEC §4 invariant 6) — arrêt"
        )
    setattr(law, "rlrq_cite" if lang == "fr" else "official_cite_en", cite)
    law.chapter = chapitre
    law.jurisdiction = "ca"
    law.unit = cfg_law.get("unit", "article")
    law.in_force = parser_lims.derive_in_force(racine)
    law.last_amended = racine.get("{http://justice.gc.ca/lims}lastAmendedDate")
    titre = parser_lims.derive_titre(racine)
    if lang == "fr":
        law.name_fr = titre
    else:
        law.name_en = titre
    # ⚠️ LA DATE SERVIE VIENT DE LA PAGE OFFICIELLE, PAS DU XML.
    #
    # Elle venait de `lims:current-date`. Mesuré le 2026-09-14, ce choix nous faisait
    # SOUS-DÉCLARER la fraîcheur du droit : la Loi sur le droit d'auteur était annoncée
    # « à jour au 2025-07-24 » alors que Justice Canada la donne à jour au 2026-07-21 —
    # près d'un an d'écart, sur un outil juridique.
    #
    # Trois raisons de préférer la page, dans cet ordre :
    #  1. C'est ce que le PUBLIEUR OFFICIEL affirme du texte. `consol_date_*` répond à
    #     « à jour au ? » ; `lims:current-date` répond à autre chose, et la page porte
    #     séparément la dernière modification, qui vit déjà dans `last_amended`.
    #  2. La veille COMPARE cette colonne à ce que la page affiche. Stocker une valeur
    #     issue d'une autre observation rendrait les 36 contrôles fédéraux faux À
    #     PERPÉTUITÉ — en `retard` avec `lims:current-date` (plus ancienne), et en
    #     `anomalie` avec `lookup.xml` (20260722 contre 2026-07-21 affiché). Aucune
    #     réingestion ne les éteindrait.
    #  3. La date est uniforme : une seule valeur sur les 9 588 entrées de `lookup.xml`,
    #     et sur les 36 pages. C'est une propriété de l'INSTANTANÉ, pas de la loi.
    #
    # Et l'échec est FATAL, à dessein. Se replier sur `lims:current-date` mettrait DEUX
    # sémantiques dans une même colonne, sans étiquette et sans moyen de savoir laquelle a
    # servi : exactement le faux silencieux que ce dépôt refuse. Une ingestion refusée
    # coûte une reprise ; elle est manuelle et surveillée (CLAUDE.md, « Rafraîchissement
    # semestriel »), donc quelqu'un lit ce message à l'instant où il tombe.
    consol = fetch_consolidation_federale(cfg_law["official_source"][lang])
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
    divisions, articles = parser_lims.parse_lims(data, law, lang, bilan=bilan)
    print(f"  bilan de matière : {bilan.as_dict()}")
    return divisions, articles, bilan


def run(law_id: str, lang: str, download: bool, apply_local: bool, apply_remote: bool,
        show: list[str], strict: bool, refresh_dates: bool = False,
        allow_not_in_force: bool = False) -> int:
    cfg_law = config.get_law_any(law_id)
    law = _law_from_config(cfg_law)

    # AIGUILLAGE PAR SOURCE, avant toute opération propre à un format. `source` absent =
    # LégisQuébec, pour que les 79 entrées existantes n'aient pas à être touchées.
    if cfg_law.get("source") == "lims":
        divisions, articles, _bilan = _acquiert_lims(cfg_law, law, lang, allow_not_in_force)
        load.prepare(law, divisions, articles, id_base=_id_base(law_id, lang))
        rep = validate.validate(law_id, lang, divisions, articles,
                                jurisdiction="ca", numeros_refuses=_bilan.numeros_refuses)
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
        except Exception as e:  # tolérance EN manquant (§5) : on saute cette langue, sans échec
            if lang == "en":
                print(f"EN indisponible pour {law_id} ({e}) — langue ignorée.")
                return 0
            raise

    if lang == "en":
        # vrai name_en depuis l'OPF anglais (la config le livre à null — §5)
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
    # Invariant phase B (§9 C) : les articles réels (se:) doivent égaler le décompte de scan.
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
        combos = [(law["id"], lang) for law in config.load_all_laws() for lang in _LANGS]
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
