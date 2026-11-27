from __future__ import annotations

import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from pipeline import paths
from pipeline.model import DISPOSITION_SORT_BASE, Article, Division, Law, sort_key

CLASSEMENT_PATH = Path(__file__).resolve().parent / "expected" / "lims_tags.json"

class ErreurIngestion(Exception):
    pass

class BaliseInconnue(ErreurIngestion):
    pass

class ChaineInconnue(ErreurIngestion):
    pass

class BalisageIncoherent(ErreurIngestion):
    pass

def _charge_classement() -> tuple[dict[str, dict], set[str]]:
    d = json.loads(CLASSEMENT_PATH.read_text(encoding="utf-8"))
    return d["balises"], set(d["chaines_ingerables"])

_BALISES, _CHAINES_BLANCHES = _charge_classement()

REFUS_ANCETRE = {"BillPiece", "RelatedOrNotInForce", "AmendedText"}

_TEXTE = {n for n, v in _BALISES.items() if v["traitement"] == "texte"}
_STRUCTURE = {n for n, v in _BALISES.items() if v["traitement"] == "structure"}
_HORS_TEXTE = {n for n, v in _BALISES.items() if v["traitement"] == "hors_texte"}
_IGNORE = {n for n, v in _BALISES.items() if v["traitement"] == "ignore"}

_CONNUES_DU_SPEC = {
    "Statute", "Regulation", "Identification", "Introduction", "Body", "Schedule",
    "RecentAmendments", "Preamble", "Provision", "Section", "Subsection", "Paragraph",
    "Subparagraph", "Clause", "Subclause", "Subsubclause", "Heading", "Label", "TitleText",
    "MarginalNote", "HistoricalNote", "HistoricalNoteSubItem", "BillPiece",
    "RelatedOrNotInForce", "AmendedText", "SectionPiece", "ContinuedSectionSubsection",
    "ContinuedParagraph", "ContinuedDefinition", "XRefExternal", "XRefInternal", "Emphasis",
    "Sup", "Sub", "Language", "DefinedTermFr", "DefinedTermEn", "DefinitionRef", "Repealed",
    "Leader", "LeaderRightJustified", "FootnoteRef", "TableGroup", "table", "FormGroup",
    "ScheduleFormHeading", "OriginatingRef", "Chapter", "ConsolidatedNumber",
    "AnnualStatuteId", "AnnualStatuteNumber", "InstrumentNumber", "EnablingAuthority",
    "Text", "YYYY", "Reserved", "CommentBlock", "RelatedProvision", "PageBreak",
    "ConventionAgreementTreaty", "ExplanatoryNote", "Recommendation", "Notice",
    "TableOfProvisions", "DocumentInternal", "Group", "RegulationPiece", "Order",
}

_TOUTES_CONNUES = _CONNUES_DU_SPEC | set(_BALISES)

_PLAGE = re.compile(r"^(\d+(?:\.\d+)*)\s*(?:à|to|et|and)\s*(\d+(?:\.\d+)*)$")
_NUM_SIMPLE = re.compile(r"^\d+(?:\.\d+)*$")

def _norm(texte: str) -> str:
    texte = "".join(" " if unicodedata.category(c) == "Zs" else c for c in texte)
    texte = re.sub(r"[ \t\r\f\v]+", " ", texte)
    texte = re.sub(r" *\n *", "\n", texte)
    texte = re.sub(r"\n{3,}", "\n\n", texte)
    return texte.strip()

def _sans_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag

def _plat(el: ET.Element) -> str:
    return _norm("".join(el.itertext()))

def git_show_lims(ref: str, chemin: str) -> bytes:
    import subprocess

    from pipeline import config

    r = subprocess.run(
        ["git", "-C", str(config.LIMS_REPO), "show", f"{ref}:{chemin}"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise BalisageIncoherent(
            f"{chemin} introuvable à {ref} dans {config.LIMS_REPO} : "
            f"{r.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return r.stdout

_MOTS_CLES_DIVISION = ("PARTIE", "PART", "SECTION", "DIVISION", "SOUS-SECTION", "SUBDIVISION")

_NUMERO_DIVISION = re.compile(
    r"(?:^|\s)((?:[IVXLCDM]+|[0-9]+)(?:\.[0-9]+)*)\s*$", re.IGNORECASE)

def numero_de_division(brut: str) -> str | None:
    brut = (brut or "").strip()
    if not brut:
        return None
    tete = re.split(r"[\s.]", brut, maxsplit=1)[0].upper()
    if tete not in _MOTS_CLES_DIVISION:
        raise BalisageIncoherent(
            f"Label de Heading au mot-clé inédit : {brut!r} (tête {tete!r}). "
            f"Attendus : {', '.join(_MOTS_CLES_DIVISION)}. Recensement du 2026-09-11 : "
            "290 Label sur les 36 fichiers, quatre mots-clés, aucun autre. Classer le "
            "nouveau plutôt que deviner son numéro."
        )
    m = _NUMERO_DIVISION.search(brut)
    return m.group(1) if m else None

def numero_de_label(lab: ET.Element | None) -> str:
    if lab is None:
        return ""
    morceaux: list[str] = []

    def descend(el: ET.Element) -> None:
        if el.text:
            morceaux.append(el.text)
        for enfant in el:
            if _sans_ns(enfant.tag) != "FootnoteRef":
                descend(enfant)
            if enfant.tail:
                morceaux.append(enfant.tail)

    descend(lab)
    return _norm("".join(morceaux))

def expand_plage(label: str) -> list[str]:
    m = _PLAGE.match(label)
    if not m:
        return []
    a, b = m.group(1), m.group(2)
    if a.isdigit() and b.isdigit() and int(a) <= int(b):
        return [str(n) for n in range(int(a), int(b) + 1)]
    return [a, b]

def chaine_ancetres(el: ET.Element, parents: dict) -> list[str]:
    out, cur = [], el
    while cur in parents:
        cur = parents[cur]
        out.append(_sans_ns(cur.tag))
    return list(reversed(out))

def statut_section(el: ET.Element, parents: dict) -> str:
    chaine = chaine_ancetres(el, parents)
    cle = " < ".join(chaine)
    if cle in _CHAINES_BLANCHES:
        return "ingerable"
    if REFUS_ANCETRE & set(chaine):
        return "refuse"
    raise ChaineInconnue(
        f"chaîne d'ancêtres inédite pour une Section : « {cle} ». "
        f"Ni dans la liste blanche ({sorted(_CHAINES_BLANCHES)}), ni porteuse d'un "
        f"conteneur de refus ({sorted(REFUS_ANCETRE)}). "
        f"Voir docs/phase0-structure-lims.md §5 — arrêt pour revue humaine."
    )

def schedule_refuse(sched: ET.Element) -> bool:
    if (sched.get("id") or "") in {"NifProvs", "RelatedProvs"}:
        return True
    for chemin in ("ScheduleFormHeading", "FormGroup/ScheduleFormHeading"):
        sfh = sched.find(chemin)
        if sfh is not None and sfh.get("type") == "amending":
            return True
    return False

_HORS_SERIALISATION = {"MarginalNote", "HistoricalNote", "HistoricalNoteSubItem", "Footnote"}

_NIVEAUX = ["Subsection", "Paragraph", "Subparagraph", "Clause", "Subclause", "Subsubclause", "Item"]

_CONTINUES = {
    "ContinuedSectionSubsection", "ContinuedParagraph", "ContinuedDefinition",
    "ContinuedSubparagraph", "ContinuedClause", "ContinuedSubclause",
}

def _verifie_balises(racine: ET.Element) -> None:
    vues = {_sans_ns(el.tag) for el in racine.iter()}
    inconnues = sorted(vues - _TOUTES_CONNUES)
    if inconnues:
        raise BaliseInconnue(
            f"balise(s) absente(s) du classement : {inconnues}. "
            f"Les classer dans pipeline/expected/lims_tags.json (traitement + justification) "
            f"avant d'ingérer — docs/phase0-structure-lims.md §6. Arrêt."
        )

def _rend_list(el: ET.Element, profondeur: int) -> list[str]:
    lignes: list[str] = []
    prefixe = "  " * profondeur
    for sub in el:
        snom = _sans_ns(sub.tag)
        if snom in _HORS_SERIALISATION or snom in _HORS_TEXTE or snom in _IGNORE:
            continue
        if snom == "Item":
            lignes += serialise(sub, profondeur, racine_section=False)
        else:
            t = _plat(sub)
            if t:
                lignes.append(f"{prefixe}{t}".rstrip())
    return lignes

def _heading_ligne(el: ET.Element) -> str:
    partes: list[str] = []
    for nom in ("Label", "TitleText"):
        child = el.find(nom)
        if child is not None:
            t = _plat(child)
            if t:
                partes.append(t)
    return " — ".join(partes) or _plat(el)

def serialise(el: ET.Element, profondeur: int = 0, racine_section: bool = True) -> list[str]:
    lignes: list[str] = []
    prefixe = "  " * profondeur

    lab = el.find("Label")
    tete = "" if racine_section or lab is None else f"{_plat(lab)} "

    txt = el.find("Text")
    if txt is not None:
        lignes.append(f"{prefixe}{tete}{_plat(txt)}".rstrip())
    elif tete:
        lignes.append(f"{prefixe}{tete}".rstrip())

    for enfant in el:
        nom = _sans_ns(enfant.tag)
        if nom in _HORS_SERIALISATION or nom == "Label" or nom == "Text":
            continue
        if nom in _NIVEAUX:
            lignes += serialise(enfant, profondeur + 1, racine_section=False)
        elif nom in ("Definition", "DefinitionEnOnly", "DefinitionFrOnly"):
            lignes += serialise(enfant, profondeur + 1, racine_section=False)
        elif nom in _CONTINUES:
            lignes.append(f"{prefixe}{_plat(enfant)}".rstrip())
        elif nom == "Repealed":
            lignes.append(f"{prefixe}{_plat(enfant)}".rstrip())
        elif nom == "List":
            lignes += _rend_list(enfant, profondeur + 1)
        elif nom in ("TableGroup", "table", "FormGroup", "FormulaGroup"):
            lignes += _rend_bloc(enfant, profondeur)
        elif nom in _STRUCTURE or nom in _TEXTE:
            t = _plat(enfant)
            if t:
                lignes.append(f"{prefixe}{t}".rstrip())
        elif nom in _HORS_TEXTE or nom in _IGNORE:
            continue
        else:
            t = _plat(enfant)
            if t:
                lignes.append(f"{prefixe}{t}".rstrip())
    return [l for l in lignes if l.strip()]

def _rend_bloc(el: ET.Element, profondeur: int) -> list[str]:
    prefixe = "  " * profondeur
    lignes: list[str] = []
    if any(
        _sans_ns(c.tag) in ("Provision", "List", "FormGroup", "Heading", "Group", "GroupHeading", "DocumentInternal")
        for c in el
    ):
        for c in el:
            cn = _sans_ns(c.tag)
            if cn == "ScheduleFormHeading" or cn in _HORS_SERIALISATION or cn in _HORS_TEXTE or cn in _IGNORE:
                continue
            if cn == "Provision":
                lignes += serialise(c, profondeur, racine_section=False)
            elif cn == "List":
                lignes += _rend_list(c, profondeur)
            elif cn in ("TableGroup", "table", "FormGroup", "FormulaGroup", "DocumentInternal", "Group"):
                lignes += _rend_bloc(c, profondeur)
            elif cn in ("Heading", "GroupHeading"):
                t = _heading_ligne(c)
                if t:
                    lignes.append(f"{prefixe}{t}".rstrip())
            else:
                t = _plat(c)
                if t:
                    lignes.append(f"{prefixe}{t}".rstrip())
        return [l for l in lignes if l.strip()]
    cap = el.find("Caption")
    if cap is not None:
        lignes.append(f"{prefixe}{_plat(cap)}")
    titre = el.find("table/title") or el.find("title")
    if titre is not None:
        lignes.append(f"{prefixe}{_plat(titre)}")
    rangees = [r for r in el.iter() if _sans_ns(r.tag) == "row"]
    if rangees:
        for r in rangees:
            cellules = [_plat(c) for c in r if _sans_ns(c.tag) == "entry"]
            cellules = [c for c in cellules if c]
            if cellules:
                lignes.append(f"{prefixe}{' : '.join(cellules)}")
        return lignes
    t = _plat(el)
    if t:
        lignes.append(f"{prefixe}{t}")
    return lignes

def _serialise_annexe(sched: ET.Element) -> str:
    lignes: list[str] = []
    for c in sched:
        cn = _sans_ns(c.tag)
        if cn == "ScheduleFormHeading" or cn in _HORS_SERIALISATION or cn in _HORS_TEXTE or cn in _IGNORE:
            continue
        if cn == "Provision":
            lignes += serialise(c, 0, racine_section=False)
        elif cn == "List":
            lignes += _rend_list(c, 0)
        elif cn in ("TableGroup", "table", "FormGroup", "FormulaGroup", "DocumentInternal", "Group"):
            lignes += _rend_bloc(c, 0)
        elif cn in ("Heading", "GroupHeading"):
            t = _heading_ligne(c)
            if t:
                lignes.append(t)
        else:
            t = _plat(c)
            if t:
                lignes.append(t)
    return "\n".join(l for l in lignes if l.strip())

def _historique(el: ET.Element) -> str | None:
    hn = el.find("HistoricalNote")
    if hn is None:
        return None
    items = [_plat(s) for s in hn if _sans_ns(s.tag) == "HistoricalNoteSubItem"]
    return "; ".join([i for i in items if i]) or (_plat(hn) or None)

def _notes(el: ET.Element) -> str | None:
    notes = [_plat(f) for f in el.iter() if _sans_ns(f.tag) == "Footnote"]
    return "\n".join([n for n in notes if n]) or None

LIMS_NS = "http://justice.gc.ca/lims"

def derive_citation(racine: ET.Element, lang: str) -> tuple[str, str | None]:
    ident = racine.find("Identification")
    if ident is None:
        raise BalisageIncoherent("pas d'Identification : impossible de dériver la citation")

    instr = ident.find("InstrumentNumber")
    if instr is not None:
        cite = _plat(instr)
        return cite, cite

    chap = ident.find("Chapter")
    if chap is None:
        raise BalisageIncoherent("ni InstrumentNumber ni Chapter : citation indérivable")
    cons = chap.find("ConsolidatedNumber")
    num = _plat(cons) if cons is not None else None
    officiel = (cons.get("official") if cons is not None else None) == "yes"

    if officiel and num:
        cite = f"L.R.C. (1985), ch. {num}" if lang == "fr" else f"R.S.C. 1985, c. {num}"
        return cite, num

    ann = chap.find("AnnualStatuteId")
    if ann is None:
        raise BalisageIncoherent(
            f"ConsolidatedNumber official='no' ({num}) sans AnnualStatuteId : "
            f"le SPEC §3.4 ne prévoit pas cette quatrième forme — arrêt"
        )
    annee_el = ann.find("YYYY")
    numero_el = ann.find("AnnualStatuteNumber")
    if annee_el is None or numero_el is None:
        raise BalisageIncoherent("AnnualStatuteId sans YYYY ou sans AnnualStatuteNumber")
    annee = _plat(annee_el)
    numero = _plat(numero_el)

    if ann.get("revised-statute") == "yes":
        cite = (f"L.R.C. ({annee}), ch. {numero}" if lang == "fr"
                else f"R.S.C. {annee}, c. {numero}")
    else:
        cite = f"L.C. {annee}, ch. {numero}" if lang == "fr" else f"S.C. {annee}, c. {numero}"
    return cite, num

def derive_titre(racine: ET.Element) -> str:
    ident = racine.find("Identification")
    if ident is None:
        raise BalisageIncoherent("pas d'Identification : titre indérivable")
    for nom in ("ShortTitle", "LongTitle"):
        el = ident.find(nom)
        if el is not None and _plat(el):
            return _plat(el)
    raise BalisageIncoherent("ni ShortTitle ni LongTitle")

def derive_in_force(racine: ET.Element) -> int:
    nom = _sans_ns(racine.tag)
    val = racine.get("in-force")
    if nom == "Regulation":
        return 0 if val is not None and val != "yes" else 1
    if val is None:
        return 0
    return 1 if val == "yes" else 0

@dataclass
class Bilan:
    corps: int = 0
    annexe: int = 0
    preambule: int = 0
    refuse_ancetre: int = 0
    refuse_annexe: int = 0
    inconnu: int = 0
    numeros_refuses: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return (self.corps + self.annexe + self.preambule
                + self.refuse_ancetre + self.refuse_annexe + self.inconnu)

    def as_dict(self) -> dict[str, int]:
        return {"corps": self.corps, "annexe": self.annexe, "preambule": self.preambule,
                "refuse_ancetre": self.refuse_ancetre, "refuse_annexe": self.refuse_annexe,
                "inconnu": self.inconnu, "total": self.total}

def parse_lims(
    xml_bytes: bytes, law: Law, lang: str, *, bilan: Bilan | None = None,
) -> tuple[list[Division], list[Article]]:
    b = bilan if bilan is not None else Bilan()
    racine = ET.fromstring(xml_bytes)
    _verifie_balises(racine)

    nom_racine = _sans_ns(racine.tag)
    if nom_racine not in ("Statute", "Regulation"):
        raise BalisageIncoherent(
            f"racine inattendue : <{nom_racine}> (attendu Statute ou Regulation)")

    parents = {c: p for p in racine.iter() for c in p}
    divisions: list[Division] = []
    articles: list[Article] = []
    sort_order = 0
    disp_idx = 0

    _ABROGE = re.compile(r"^\s*\[?(?:Abrog|Repeal)")

    def ajoute_article(el, chemin: str, numero: str, cle: int | None = None) -> None:
        if not numero:
            raise BalisageIncoherent(
                f"Section sans numéro exploitable sous {chemin} : un Label à balisage "
                f"interne (FootnoteRef) rendu sans aplatissement ? — voir §7.4"
            )
        mn = el.find("MarginalNote")
        corps_txt = "\n".join(serialise(el))
        articles.append(Article(
            law_id=law.id, lang=lang, number=numero,
            text=corps_txt,
            division_path=chemin,
            history=_historique(el),
            repealed=1 if _ABROGE.match(corps_txt) else 0,
            marginal_note=_plat(mn) if mn is not None else None,
            footnotes=_notes(el),
            sort_key=cle,
            alias_numbers=expand_plage(numero),
        ))

    def cle_de(numero: str) -> int | None:
        if _NUM_SIMPLE.match(numero):
            return None
        premiers = expand_plage(numero)
        if premiers:
            return sort_key(premiers[0])
        return None

    intro = racine.find("Introduction")
    preamb = intro.find("Preamble") if intro is not None else None
    if preamb is not None and _plat(preamb):
        chemin = "fp:0"
        divisions.append(Division(
            law_id=law.id, lang=lang, kind="disposition", path=chemin,
            heading="Préambule" if lang == "fr" else "Preamble", sort_order=sort_order,
        ))
        sort_order += 1
        provisions = [_plat(p) for p in preamb if _sans_ns(p.tag) == "Provision"]
        articles.append(Article(
            law_id=law.id, lang=lang,
            number="preambule" if lang == "fr" else "preamble",
            text="\n".join(x for x in provisions if x) or _plat(preamb),
            division_path=chemin,
            sort_key=0,
        ))
        b.preambule += sum(1 for e in preamb.iter() if _sans_ns(e.tag) == "Section")

    body = racine.find("Body")
    if body is not None:
        pile: list[int] = []
        chemin_courant = ""
        attend_preambule = False
        for el in body:
            nom = _sans_ns(el.tag)
            if nom == "Heading":
                niveau = int(el.get("level") or 1)
                if niveau > len(pile):
                    pile += [0] * (niveau - len(pile))
                del pile[niveau:]
                pile[niveau - 1] += 1
                chemin_courant = "-".join(f"fh{i + 1}:{r}" for i, r in enumerate(pile))
                lab = el.find("Label")
                titre = el.find("TitleText")
                brut = _plat(lab) if lab is not None else ""
                intitule = _plat(titre) if titre is not None else None
                joint = f"{brut} {intitule or ''}".strip().upper()
                kind = "partie" if joint.startswith(("PARTIE", "PART ")) else "rubrique"
                numero = None
                if brut:
                    numero = numero_de_division(brut)
                elif intitule:
                    m = re.match(r"(?:PARTIE|PART)\s+([IVXLCDM]+|[0-9]+(?:\.[0-9]+)*)\b",
                                 intitule.upper())
                    numero = m.group(1) if m else None
                divisions.append(Division(
                    law_id=law.id, lang=lang, kind=kind, path=chemin_courant,
                    number=numero, heading=intitule,
                    parent_path=paths.parent_path(chemin_courant),
                    sort_order=sort_order,
                ))
                sort_order += 1
            elif nom == "Section":
                if statut_section(el, parents) == "refuse":
                    b.refuse_ancetre += 1
                    b.numeros_refuses.append(numero_de_label(el.find("Label")))
                    continue
                numero = numero_de_label(el.find("Label"))

                if numero in ("Préambule", "Preamble"):
                    b.preambule += 1
                    attend_preambule = True
                    continue
                if not numero and attend_preambule:
                    chemin_p = "fp:0"
                    divisions.append(Division(
                        law_id=law.id, lang=lang, kind="disposition", path=chemin_p,
                        heading="Préambule" if lang == "fr" else "Preamble",
                        sort_order=sort_order,
                    ))
                    sort_order += 1
                    provisions = [_plat(p) for p in el if _sans_ns(p.tag) == "Provision"]
                    txt_p = el.find("Text")
                    corps_p = [_plat(txt_p)] if txt_p is not None else []
                    articles.append(Article(
                        law_id=law.id, lang=lang,
                        number="preambule" if lang == "fr" else "preamble",
                        text="\n".join(x for x in corps_p + provisions if x),
                        division_path=chemin_p,
                        history=_historique(el),
                        sort_key=0,
                    ))
                    b.preambule += 1
                    attend_preambule = False
                    continue
                attend_preambule = False

                ajoute_article(el, chemin_courant, numero, cle_de(numero))
                b.corps += 1
            else:
                raise BalisageIncoherent(
                    f"<{nom}> en enfant direct de Body : jamais observé sur le corpus (§3). "
                    f"Le classer avant d'ingérer — arrêt pour revue humaine."
                )

    schedules = [e for e in racine.iter() if _sans_ns(e.tag) == "Schedule"]
    for idx, sched in enumerate(schedules, start=1):
        if schedule_refuse(sched):
            refusees = [d for d in sched.iter() if _sans_ns(d.tag) == "Section"]
            b.refuse_annexe += len(refusees)
            b.numeros_refuses += [numero_de_label(d.find("Label")) for d in refusees]
            continue
        chemin = f"fs:{idx}"
        sfh = sched.find("ScheduleFormHeading")
        if sfh is None:
            sfh = sched.find("FormGroup/ScheduleFormHeading")
        lab = sfh.find("Label") if sfh is not None else None
        titre = sfh.find("TitleText") if sfh is not None else None
        orig = sfh.find("OriginatingRef") if sfh is not None else None
        etiquette = _plat(lab) if lab is not None else None
        morceaux = [
            _plat(titre) if titre is not None else None,
            f"({_plat(orig)})" if orig is not None and _plat(orig) else None,
        ]
        intitule = " ".join(x for x in morceaux if x) or etiquette
        divisions.append(Division(
            law_id=law.id, lang=lang, kind="annexe", path=chemin,
            number=etiquette, heading=intitule, sort_order=sort_order,
            repealed=1 if sched.find("Repealed") is not None else 0,
        ))
        sort_order += 1
        base = etiquette or f"annexe {idx}"
        slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or f"annexe-{idx}"
        secs_sched = [s for s in sched.iter() if _sans_ns(s.tag) == "Section"]
        if secs_sched:
            for sec in secs_sched:
                if statut_section(sec, parents) == "refuse":
                    b.refuse_ancetre += 1
                    continue
                brut = numero_de_label(sec.find("Label"))
                numero = f"{slug}-{brut}" if brut else slug
                cle = DISPOSITION_SORT_BASE + disp_idx * 1_000_000
                disp_idx += 1
                ajoute_article(sec, chemin, numero, cle)
                b.annexe += 1
        elif not any(_sans_ns(d.tag) in REFUS_ANCETRE for d in sched.iter()):
            corps_annexe = _serialise_annexe(sched)
            if corps_annexe:
                vus_numeros = {a.number for a in articles}
                numero_ann = slug if slug not in vus_numeros else f"{slug}-{idx}"
                cle = DISPOSITION_SORT_BASE + disp_idx * 1_000_000
                disp_idx += 1
                articles.append(Article(
                    law_id=law.id, lang=lang, number=numero_ann,
                    text=corps_annexe,
                    division_path=chemin,
                    history=_historique(sched),
                    repealed=1 if sched.find("Repealed") is not None or _ABROGE.match(corps_annexe) else 0,
                    footnotes=_notes(sched),
                    sort_key=cle,
                ))

    total_fichier = sum(1 for e in racine.iter() if _sans_ns(e.tag) == "Section")
    comptees = b.total
    if comptees != total_fichier:
        b.inconnu = total_fichier - comptees
        raise BalisageIncoherent(
            f"bilan de matière incomplet : {comptees} Section comptées sur {total_fichier} "
            f"présentes, soit {b.inconnu} non attribuée(s) ({b.as_dict()}). Une Section "
            f"n'a été ni ingérée ni refusée — exactement ce que l'invariant §4.1 du SPEC ne "
            f"sait pas voir, puisqu'il s'équilibre des deux côtés. Arrêt."
        )
    return divisions, articles
