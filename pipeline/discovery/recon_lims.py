"""Reconnaissance du corpus FÉDÉRAL (format LIMS de Justice Canada) — dry-run.

Pendant de `pipeline/discovery/recon.py`, qui fait le même travail sur les EPUB de
LégisQuébec. N'ÉCRIT RIEN EN BASE et ne parse rien « pour de vrai » : il RECENSE, pour que
la stratégie de `parser_lims.py` soit écrite sur des mesures et non sur des suppositions.

Le rapport va dans `docs/reconnaissance-lims-courante.md`, qui est GITIGNORÉ — c'est un
vidage reproductible, et versionné il finirait par se lire comme un document de référence
(même raison que `docs/reconnaissance-courante.md`). Le document VERSIONNÉ, lui, est
`docs/phase0-structure-lims.md` : il est rédigé à la main à partir de ce vidage, et c'est
LUI que `parser_lims.py` citera par `§N`, à l'image de `docs/phase0-structure-epub.md`.

⚠️ RECENSEMENT SANS LISTE BLANCHE PRÉALABLE. On ne compte pas « les balises qu'on attend »,
on compte TOUT ce qui est là, attributs et valeurs compris. C'est la seule façon de voir
arriver ce que la spécification ne nomme pas : `@isNIF`, `@style='nifrp'`, `Provision`,
`FormGroup`. Un recensement filtré par ce qu'on croit savoir confirme toujours ce qu'on
croit savoir.

Emploi :
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_lims
    PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pipeline.discovery.recon_lims --ref a782c13
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from pipeline import config

LIMS_NS = "http://justice.gc.ca/lims"
RAPPORT = config.REPO_ROOT / "docs" / "reconnaissance-lims-courante.md"
ATTENDUS_DIR = config.REPO_ROOT / "pipeline" / "expected"

# Les 18 textes du corpus arrêté (SPEC §9). L'ORDRE suit celui du SPEC : c'est lui qui
# deviendra l'ordre d'ajout EN FIN de laws.config.json (invariant 1).
CORPUS: list[tuple[str, str, str, str]] = [
    # (id, chapitre, chemin FR, chemin EN)
    ("ca-b-3", "B-3", "fra/lois/B-3.xml", "eng/acts/B-3.xml"),
    ("ca-c-36", "C-36", "fra/lois/C-36.xml", "eng/acts/C-36.xml"),
    ("ca-d-3.4", "D-3.4", "fra/lois/D-3.4.xml", "eng/acts/D-3.4.xml"),
    ("ca-c-44", "C-44", "fra/lois/C-44.xml", "eng/acts/C-44.xml"),
    ("ca-c-34", "C-34", "fra/lois/C-34.xml", "eng/acts/C-34.xml"),
    ("ca-c-42", "C-42", "fra/lois/C-42.xml", "eng/acts/C-42.xml"),
    ("ca-t-13", "T-13", "fra/lois/T-13.xml", "eng/acts/T-13.xml"),
    ("ca-l-2", "L-2", "fra/lois/L-2.xml", "eng/acts/L-2.xml"),
    ("ca-p-8.6", "P-8.6", "fra/lois/P-8.6.xml", "eng/acts/P-8.6.xml"),
    ("ca-i-21", "I-21", "fra/lois/I-21.xml", "eng/acts/I-21.xml"),
    ("ca-c-5", "C-5", "fra/lois/C-5.xml", "eng/acts/C-5.xml"),
    ("ca-f-7", "F-7", "fra/lois/F-7.xml", "eng/acts/F-7.xml"),
    ("ca-s-26", "S-26", "fra/lois/S-26.xml", "eng/acts/S-26.xml"),
    ("ca-c-50", "C-50", "fra/lois/C-50.xml", "eng/acts/C-50.xml"),
    ("ca-i-15", "I-15", "fra/lois/I-15.xml", "eng/acts/I-15.xml"),
    ("ca-b-4", "B-4", "fra/lois/B-4.xml", "eng/acts/B-4.xml"),
    ("ca-dors-98-106", "DORS/98-106",
     "fra/reglements/DORS-98-106.xml", "eng/regulations/SOR-98-106.xml"),
    ("ca-crc-368", "C.R.C., ch. 368",
     "fra/reglements/C.R.C.,_ch._368.xml", "eng/regulations/C.R.C.,_c._368.xml"),
]

# Témoin de REFUS : édictée et NON EN VIGUEUR (SPEC §3.7). Recensée pour que la phase 1
# puisse prouver que le pipeline la refuse, JAMAIS ingérée.
TEMOIN_REFUS = ("ca-f-29.2", "F-29.2", "fra/lois/F-29.2.xml", "eng/acts/F-29.2.xml")

# Un `Label` « simple » est un numéro d'article ordinaire. Tout le reste doit être VU.
LABEL_SIMPLE = re.compile(r"^\d+(?:\.\d+)*$")
LABEL_PLAGE = re.compile(r"^\d+(?:\.\d+)*\s*(?:à|to|et|and)\s*\d+(?:\.\d+)*$")


def git_show(ref: str, chemin: str) -> bytes:
    """Lit un fichier du dépôt LIMS sans checkout. Le clone partiel tire le blob ici."""
    r = subprocess.run(
        ["git", "-C", str(config.LIMS_REPO), "show", f"{ref}:{chemin}"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise FileNotFoundError(f"{chemin} absent de {ref} : {r.stderr.decode('utf-8', 'replace')[:200]}")
    return r.stdout


def sha_de(ref: str) -> str:
    r = subprocess.run(["git", "-C", str(config.LIMS_REPO), "rev-parse", ref],
                       capture_output=True, text=True)
    return r.stdout.strip()


def sans_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def texte_plat(el: ET.Element) -> str:
    """Texte d'un élément, balisage interne APLATI (un Label peut contenir un FootnoteRef)."""
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


@dataclass
class Releve:
    """Ce qu'on a mesuré sur UN fichier."""
    law_id: str
    lang: str
    chemin: str
    racine: str = ""
    attrs_racine: dict = field(default_factory=dict)
    tags: collections.Counter = field(default_factory=collections.Counter)
    attributs: collections.Counter = field(default_factory=collections.Counter)
    enfants_racine: list = field(default_factory=list)
    body_sequence: list = field(default_factory=list)
    chaines_section: collections.Counter = field(default_factory=collections.Counter)
    schedules: list = field(default_factory=list)
    labels_non_simples: list = field(default_factory=list)
    numeros_corps: list = field(default_factory=list)
    marqueurs_non_vigueur: collections.Counter = field(default_factory=collections.Counter)
    profondeur_heading_max: int = 0
    composante_max: int = 0
    profondeur_numero_max: int = 0


def releve_fichier(law_id: str, chapitre: str, lang: str, chemin: str, ref: str) -> Releve:
    r = Releve(law_id=law_id, lang=lang, chemin=chemin)
    racine = ET.fromstring(git_show(ref, chemin))
    r.racine = sans_ns(racine.tag)
    r.attrs_racine = {sans_ns(k): v for k, v in racine.attrib.items()}
    r.enfants_racine = [sans_ns(e.tag) for e in list(racine)]

    # Recensement EXHAUSTIF : chaque balise, chaque (balise, attribut, valeur).
    for el in racine.iter():
        t = sans_ns(el.tag)
        r.tags[t] += 1
        for k, v in el.attrib.items():
            nk = sans_ns(k)
            # Les identifiants internes (lims:id, lims:fid) sont uniques par élément :
            # les recenser par VALEUR noierait le rapport. On garde le nom seul.
            val = "<unique>" if nk in {"id", "fid"} else v
            r.attributs[f"{t}/@{nk}={val}"] += 1
            if nk in {"isNIF", "in-force"} or (nk in {"type", "style"} and v in
                                               {"amending", "transitional", "nifrp"}):
                r.marqueurs_non_vigueur[f"{t}/@{nk}={v}"] += 1

    # Chaîne d'ancêtres de CHAQUE Section : c'est ce qui fera la liste BLANCHE du §3.1.
    parents = {c: p for p in racine.iter() for c in p}
    for el in racine.iter():
        if sans_ns(el.tag) != "Section":
            continue
        chaine, cur = [], el
        while cur in parents:
            cur = parents[cur]
            chaine.append(sans_ns(cur.tag))
        r.chaines_section[" < ".join(reversed(chaine))] += 1

    # Séquence plate du Body — ce dont le chemin positionnel dérive.
    body = racine.find("Body")
    if body is not None:
        for el in list(body):
            t = sans_ns(el.tag)
            if t == "Heading":
                lvl = int(el.get("level") or 1)
                r.profondeur_heading_max = max(r.profondeur_heading_max, lvl)
                lab = el.find("Label")
                r.body_sequence.append(("H", lvl, texte_plat(lab) if lab is not None else None))
            elif t == "Section":
                lab = el.find("Label")
                num = texte_plat(lab) if lab is not None else ""
                r.body_sequence.append(("S", None, num))
                r.numeros_corps.append(num)
                if not LABEL_SIMPLE.match(num):
                    r.labels_non_simples.append({
                        "numero": num,
                        "plage": bool(LABEL_PLAGE.match(num)),
                        "balisage_interne": len(list(lab)) > 0 if lab is not None else False,
                        "vide": num == "",
                    })
                else:
                    parts = num.split(".")
                    r.profondeur_numero_max = max(r.profondeur_numero_max, len(parts))
                    r.composante_max = max(r.composante_max, max(int(x) for x in parts))
            else:
                r.body_sequence.append((t, None, None))

    # Inventaire des Schedule, OÙ QU'ILS SOIENT (racine, Body, Section, DocumentInternal).
    for el in racine.iter():
        if sans_ns(el.tag) != "Schedule":
            continue
        par = parents.get(el)
        sfh = el.find("ScheduleFormHeading")
        if sfh is None:
            fg = el.find("FormGroup")
            sfh = fg.find("ScheduleFormHeading") if fg is not None else None
        lab = sfh.find("Label") if sfh is not None else None
        titre = sfh.find("TitleText") if sfh is not None else None
        r.schedules.append({
            "parent": sans_ns(par.tag) if par is not None else "<racine>",
            "id": el.get("id"),
            "spanlanguages": el.get("spanlanguages"),
            "bilingual": el.get("bilingual"),
            "type_sfh": sfh.get("type") if sfh is not None else None,
            "label": texte_plat(lab) if lab is not None else None,
            "titre": texte_plat(titre) if titre is not None else None,
            "enfants_directs": sorted({sans_ns(c.tag) for c in list(el)}),
            "nb_sections": sum(1 for d in el.iter() if sans_ns(d.tag) == "Section"),
            "numeros": [texte_plat(d.find("Label")) for d in el.iter()
                        if sans_ns(d.tag) == "Section" and d.find("Label") is not None],
        })
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ref", default=config.LIMS_REF, help="ref git du dépôt LIMS (défaut : HEAD)")
    ap.add_argument("--temoin-refus", action="store_true",
                    help="recenser aussi F-29.2, la loi non en vigueur (témoin de REFUS)")
    a = ap.parse_args(argv)

    if not (config.LIMS_REPO / ".git").is_dir():
        print(f"Dépôt LIMS introuvable : {config.LIMS_REPO}\n"
              f"  git clone --filter=blob:none --no-checkout "
              f"https://github.com/justicecanada/laws-lois-xml.git")
        return 1

    sha = sha_de(a.ref)
    textes = list(CORPUS) + ([TEMOIN_REFUS] if a.temoin_refus else [])
    releves: list[Releve] = []
    echecs: list[str] = []
    for law_id, chapitre, fr, en in textes:
        for lang, chemin in (("fr", fr), ("en", en)):
            try:
                releves.append(releve_fichier(law_id, chapitre, lang, chemin, a.ref))
            except Exception as exc:  # on RAPPORTE l'anomalie, on ne devine pas
                echecs.append(f"{law_id}/{lang} ({chemin}) : {type(exc).__name__}: {exc}")

    RAPPORT.parent.mkdir(parents=True, exist_ok=True)
    RAPPORT.write_text(bati_rapport(releves, echecs, sha, a.ref), encoding="utf-8", newline="\n")
    ATTENDUS_DIR.mkdir(parents=True, exist_ok=True)

    tags_inconnus = tags_hors_spec(releves)
    print(f"Rapport écrit : {RAPPORT}")
    print(f"  ref {a.ref} -> {sha}")
    print(f"  {len(releves)} fichiers relevés, {len(echecs)} échec(s)")
    print(f"  {len(tous_les_tags(releves))} balises distinctes, "
          f"dont {len(tags_inconnus)} que le SPEC ne nomme pas")
    print(f"  {sum(len(r.labels_non_simples) for r in releves)} Label non simples")
    print(f"  {sum(len(r.schedules) for r in releves)} Schedule")
    for e in echecs:
        print(f"  ÉCHEC {e}")
    return 2 if echecs else 0


# Les balises que le SPEC nomme explicitement (§3.1, §3.5, §3.8). Tout ce qui n'est pas
# ici est « non nommé par le SPEC » — pas nécessairement inconnu, mais à classer.
TAGS_NOMMES_PAR_LE_SPEC = {
    "Statute", "Regulation", "Identification", "Introduction", "Body", "Schedule",
    "RecentAmendments", "Preamble", "Provision", "Section", "Subsection", "Paragraph",
    "Subparagraph", "Clause", "Subclause", "Heading", "Label", "TitleText", "MarginalNote",
    "HistoricalNote", "HistoricalNoteSubItem", "BillPiece", "RelatedOrNotInForce",
    "AmendedText", "SectionPiece", "ContinuedSectionSubsection", "ContinuedParagraph",
    "ContinuedDefinition", "XRefExternal", "XRefInternal", "Emphasis", "Sup", "Language",
    "DefinedTermFr", "DefinedTermEn", "DefinitionRef", "Repealed", "Leader",
    "LeaderRightJustified", "FootnoteRef", "TableGroup", "table", "FormGroup",
    "ScheduleFormHeading", "OriginatingRef", "Chapter", "ConsolidatedNumber",
    "AnnualStatuteId", "AnnualStatuteNumber", "InstrumentNumber", "EnablingAuthority",
    "Text", "YYYY",
}


def tous_les_tags(releves: list[Releve]) -> collections.Counter:
    total: collections.Counter = collections.Counter()
    for r in releves:
        total.update(r.tags)
    return total


def tags_hors_spec(releves: list[Releve]) -> list[tuple[str, int]]:
    total = tous_les_tags(releves)
    return sorted(((t, n) for t, n in total.items() if t not in TAGS_NOMMES_PAR_LE_SPEC),
                  key=lambda x: -x[1])


def bati_rapport(releves: list[Releve], echecs: list[str], sha: str, ref: str) -> str:
    L: list[str] = []
    par_loi: dict[str, dict[str, Releve]] = collections.defaultdict(dict)
    for r in releves:
        par_loi[r.law_id][r.lang] = r

    L.append(f"# Reconnaissance du corpus fédéral (LIMS) — dry-run")
    L.append("")
    L.append("> Vidage REPRODUCTIBLE, régénéré par `pipeline/discovery/recon_lims.py`.")
    L.append("> Gitignoré à dessein : le document de référence versionné est")
    L.append("> `docs/phase0-structure-lims.md`, rédigé à la main à partir d'ici.")
    L.append("")
    L.append(f"- Dépôt : `justicecanada/laws-lois-xml`")
    L.append(f"- Ref demandée : `{ref}` → SHA **`{sha}`**")
    L.append(f"- Fichiers relevés : **{len(releves)}**  ·  échecs : **{len(echecs)}**")
    L.append("")
    for e in echecs:
        L.append(f"- ⚠️ ÉCHEC — {e}")
    if echecs:
        L.append("")

    # 1. Balises
    total = tous_les_tags(releves)
    hors = tags_hors_spec(releves)
    L.append("## 1. Balises rencontrées")
    L.append("")
    L.append(f"**{len(total)} balises distinctes.** Le SPEC en nomme "
             f"{len(TAGS_NOMMES_PAR_LE_SPEC)} ; **{len(hors)}** sont donc à classer.")
    L.append("")
    L.append("### 1.1 Balises que le SPEC ne nomme pas (à classer — porte de la phase 0)")
    L.append("")
    L.append("| balise | occurrences |")
    L.append("|---|---|")
    for t, n in hors:
        L.append(f"| `{t}` | {n} |")
    L.append("")
    L.append("### 1.2 Recensement complet")
    L.append("")
    L.append("| balise | occurrences |")
    L.append("|---|---|")
    for t, n in sorted(total.items(), key=lambda x: -x[1]):
        L.append(f"| `{t}` | {n} |")
    L.append("")

    # 2. Chaînes d'ancêtres des Section — la liste BLANCHE
    L.append("## 2. Chaînes d'ancêtres de chaque `Section`")
    L.append("")
    L.append("C'est la **liste blanche** du §3.1 : seule une chaîne figurant ici peut")
    L.append("produire un article. Toute chaîne inédite doit ARRÊTER l'ingestion.")
    L.append("")
    chaines: collections.Counter = collections.Counter()
    for r in releves:
        chaines.update(r.chaines_section)
    L.append("| chaîne (de la racine vers la Section) | occurrences |")
    L.append("|---|---|")
    for c, n in sorted(chaines.items(), key=lambda x: -x[1]):
        L.append(f"| `{c}` | {n} |")
    L.append("")

    # 3. Marqueurs de non-vigueur
    L.append("## 3. Marqueurs de NON-VIGUEUR réellement présents")
    L.append("")
    L.append("Le SPEC propose `Heading/@type` et `@change` ; ce tableau dit ce qui EXISTE.")
    L.append("")
    marq: collections.Counter = collections.Counter()
    for r in releves:
        marq.update(r.marqueurs_non_vigueur)
    if not marq:
        L.append("*Aucun marqueur relevé.*")
    else:
        L.append("| marqueur | occurrences |")
        L.append("|---|---|")
        for m, n in sorted(marq.items(), key=lambda x: -x[1]):
            L.append(f"| `{m}` | {n} |")
    L.append("")

    # 4. Racines, in-force, dates
    L.append("## 4. Racine, entrée en vigueur et dates, par texte")
    L.append("")
    L.append("| texte | langue | racine | `in-force` | `lims:current-date` | `lims:lastAmendedDate` | enfants directs |")
    L.append("|---|---|---|---|---|---|---|")
    for law_id in par_loi:
        for lang, r in sorted(par_loi[law_id].items()):
            a = r.attrs_racine
            L.append(f"| `{law_id}` | {lang} | `{r.racine}` | "
                     f"{a.get('in-force', '**absent**')} | {a.get('current-date', '—')} | "
                     f"{a.get('lastAmendedDate', '—')} | {', '.join(r.enfants_racine)} |")
    L.append("")

    # 5. Isomorphisme FR/EN
    L.append("## 5. Isomorphisme FR ↔ EN de la séquence plate du `Body`")
    L.append("")
    L.append("Le §3.3 en fait un ACQUIS À DÉFENDRE : si la longueur, la séquence de niveaux")
    L.append("ou le jeu de numéros diverge, le balisage a changé — arrêt pour revue humaine.")
    L.append("")
    L.append("| texte | nœuds FR | nœuds EN | niveaux identiques | numéros identiques | première divergence |")
    L.append("|---|---|---|---|---|---|")
    for law_id, d in par_loi.items():
        if "fr" not in d or "en" not in d:
            continue
        fr, en = d["fr"], d["en"]
        niv_fr = [(t, l) for t, l, _ in fr.body_sequence]
        niv_en = [(t, l) for t, l, _ in en.body_sequence]
        num_fr, num_en = fr.numeros_corps, en.numeros_corps
        prem = ""
        if niv_fr != niv_en:
            for i, (x, y) in enumerate(zip(niv_fr, niv_en)):
                if x != y:
                    prem = f"niveau, index {i} : {x} / {y}"
                    break
            else:
                prem = f"longueur {len(niv_fr)} / {len(niv_en)}"
        elif num_fr != num_en:
            for i, (x, y) in enumerate(zip(num_fr, num_en)):
                if x != y:
                    prem = f"numéro, index {i} : « {x} » / « {y} »"
                    break
        L.append(f"| `{law_id}` | {len(fr.body_sequence)} | {len(en.body_sequence)} | "
                 f"{niv_fr == niv_en} | {num_fr == num_en} | {prem} |")
    L.append("")

    # 6. Label non simples
    L.append("## 6. `Label` qui ne sont pas de simples numéros")
    L.append("")
    total_ns = sum(len(r.labels_non_simples) for r in releves)
    L.append(f"**{total_ns} cas.** Chacun doit avoir un traitement décidé : une plage")
    L.append("s'expose dans `article_numbers`, un `Label` à balisage interne s'aplatit, un")
    L.append("`Label` vide est un défaut d'extraction.")
    L.append("")
    L.append("| texte | langue | numéro | plage | balisage interne | vide |")
    L.append("|---|---|---|---|---|---|")
    for r in releves:
        for x in r.labels_non_simples:
            L.append(f"| `{r.law_id}` | {r.lang} | `{x['numero']}` | {x['plage']} | "
                     f"{x['balisage_interne']} | {x['vide']} |")
    L.append("")

    # 7. Schedules
    L.append("## 7. Inventaire des `Schedule`")
    L.append("")
    L.append("Le §3.8 suppose « le même vocabulaire que le `Body` » : la colonne")
    L.append("« nb Section » et les enfants directs disent si c'est vrai. Une annexe à")
    L.append("0 Section porte son contenu ailleurs (`Provision`, `FormGroup`, `TableGroup`).")
    L.append("")
    L.append("| texte | langue | parent | `@id` | type SFH | `spanlanguages` | label | nb Section |")
    L.append("|---|---|---|---|---|---|---|---|")
    for r in releves:
        for s in r.schedules:
            L.append(f"| `{r.law_id}` | {r.lang} | `{s['parent']}` | {s['id'] or '—'} | "
                     f"{s['type_sfh'] or '—'} | {s['spanlanguages'] or '—'} | "
                     f"{s['label'] or '—'} | {s['nb_sections']} |")
    L.append("")

    # 8. Collisions de numéros annexe / corps
    L.append("## 8. Collisions de numéros entre annexes et corps")
    L.append("")
    L.append("Décide l'espace de noms des articles d'annexe (§4 invariant 4, et la clé")
    L.append("primaire d'`article_numbers`).")
    L.append("")
    L.append("| texte | langue | annexe | numéros en collision avec le corps |")
    L.append("|---|---|---|---|")
    une_collision = False
    for r in releves:
        corps = set(r.numeros_corps)
        for s in r.schedules:
            inter = sorted(set(s["numeros"]) & corps)
            if inter:
                une_collision = True
                L.append(f"| `{r.law_id}` | {r.lang} | {s['label'] or s['id'] or '—'} | "
                         f"{', '.join(inter[:12])}{' …' if len(inter) > 12 else ''} |")
    if not une_collision:
        L.append("| — | — | — | *aucune collision relevée* |")
    L.append("")

    # 9. Bornes de l'échelle de tri
    L.append("## 9. Bornes de numérotation et de profondeur")
    L.append("")
    L.append("| texte | langue | profondeur `Heading` max | profondeur de numéro max | composante max |")
    L.append("|---|---|---|---|---|")
    for r in releves:
        L.append(f"| `{r.law_id}` | {r.lang} | {r.profondeur_heading_max} | "
                 f"{r.profondeur_numero_max} | {r.composante_max} |")
    L.append("")
    L.append("L'échelle `sort_key` empaquette 5 composantes en base 1000 : une composante")
    L.append("≥ 1000 ou une profondeur > 5 la déborderait (invariant 2).")
    L.append("")

    # 10. Attributs
    L.append("## 10. Recensement des attributs (balise/@attribut=valeur)")
    L.append("")
    L.append("Sans présélection : c'est ainsi qu'apparaît ce que le SPEC ne nomme pas.")
    L.append("")
    attrs: collections.Counter = collections.Counter()
    for r in releves:
        attrs.update(r.attributs)
    L.append("| balise/@attribut=valeur | occurrences |")
    L.append("|---|---|")
    for k, n in sorted(attrs.items(), key=lambda x: -x[1]):
        L.append(f"| `{k}` | {n} |")
    L.append("")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
