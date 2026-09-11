"""Parseur du format LIMS (lois et règlements fédéraux, ministère de la Justice du Canada).

Calé sur la structure réellement constatée en phase 0 — voir `docs/phase0-structure-lims.md`,
notamment **§5 (ce qu'on ingère et ce qu'on refuse)**, **§7 (pièges d'extraction)** et
**§8 (stratégie de parseur)**. Le classement exécutable des balises vit dans
`pipeline/expected/lims_tags.json`.

Module NEUF. `pipeline/parser.py` (EPUB Irosoft) n'est pas touché : les deux formats n'ont
rien en commun, et toute la valeur du découpage est que `load.py`, `validate.py` et le Worker
ne voient qu'UN modèle — les mêmes dataclasses `Law`/`Division`/`Article`.

`xml.etree.ElementTree` de la bibliothèque standard suffit : c'est du XML valide. On
n'emploie NI BeautifulSoup, NI `pipeline.parser._soup` — ce dernier passe par `html.parser`,
qui MINUSCULISE les noms de balises, or LIMS est en casse mixte (`<Section>`,
`<MarginalNote>`) et tout le classement en dépend.

PRINCIPE DIRECTEUR : liste BLANCHE, et aucune branche par défaut. Il n'existe aucune DTD des
lois dans le dépôt de Justice Canada (seule `regulation_web.dtd`, qui ne déclare ni
`Statute` ni `Chapter`), donc rien ne permet de clore une liste noire. Toute chaîne
d'ancêtres inédite et toute balise inconnue lèvent une exception d'ingestion, au lieu d'être
traversées en silence. L'attrape-tout `match="*"` de `LIMS2HTML.xsl` montre de quel côté
l'éditeur, lui, fait faillir son rendu.
"""
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
    """Refus d'ingérer. Jamais rattrapée par le parseur : elle DOIT remonter."""


class BaliseInconnue(ErreurIngestion):
    """Une balise absente de `lims_tags.json`. La porte de la phase 0."""


class ChaineInconnue(ErreurIngestion):
    """Une `Section` dont la chaîne d'ancêtres n'est pas dans la liste blanche."""


class BalisageIncoherent(ErreurIngestion):
    """Le fichier contredit un invariant mesuré (numéro vide, racine inattendue…)."""


# --- classement des balises (chargé une fois) ---------------------------------

def _charge_classement() -> tuple[dict[str, dict], set[str]]:
    d = json.loads(CLASSEMENT_PATH.read_text(encoding="utf-8"))
    return d["balises"], set(d["chaines_ingerables"])


_BALISES, _CHAINES_BLANCHES = _charge_classement()

# Conteneurs dont la présence dans la chaîne d'ancêtres DISQUALIFIE une Section : ce n'est
# pas du droit en vigueur. Mesuré : 724 des 7 622 Section du corpus.
REFUS_ANCETRE = {"BillPiece", "RelatedOrNotInForce", "AmendedText"}

# Balises dont le contenu fait partie du TEXTE de l'article.
_TEXTE = {n for n, v in _BALISES.items() if v["traitement"] == "texte"}
# Balises qu'on traverse sans rien émettre.
_STRUCTURE = {n for n, v in _BALISES.items() if v["traitement"] == "structure"}
# Balises présentes mais volontairement exclues du texte servi.
_HORS_TEXTE = {n for n, v in _BALISES.items() if v["traitement"] == "hors_texte"}
_IGNORE = {n for n, v in _BALISES.items() if v["traitement"] == "ignore"}

# Balises que le SPEC nomme et que le parseur traite nommément (elles n'ont pas besoin
# d'être dans le classement, qui ne couvre que ce que le SPEC oubliait).
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

# --- normalisation ------------------------------------------------------------

_PLAGE = re.compile(r"^(\d+(?:\.\d+)*)\s*(?:à|to|et|and)\s*(\d+(?:\.\d+)*)$")
_NUM_SIMPLE = re.compile(r"^\d+(?:\.\d+)*$")


def _norm(texte: str) -> str:
    """Normalise l'espace, y compris les variantes Unicode.

    U+00A0 (insécable), U+2002 (demi-cadratin), U+2009 (fine) apparaissent dans les `Label`
    et les textes — mesuré §7.5. Sans cette normalisation, « 39.3 » et « 39.3 » sont deux
    numéros distincts.
    """
    texte = "".join(" " if unicodedata.category(c) == "Zs" else c for c in texte)
    texte = re.sub(r"[ \t\r\f\v]+", " ", texte)
    texte = re.sub(r" *\n *", "\n", texte)
    texte = re.sub(r"\n{3,}", "\n\n", texte)
    return texte.strip()


def _sans_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _plat(el: ET.Element) -> str:
    """Texte d'un élément, balisage interne APLATI.

    Indispensable pour les `Label` : 8 d'entre eux portent un `FootnoteRef`, et prendre
    `.text` rendrait un numéro VIDE (§7.4) — dont l'art. 36 de la Loi sur le divorce et
    l'art. 72 de la LPRPDE.
    """
    return _norm("".join(el.itertext()))


def git_show_lims(ref: str, chemin: str) -> bytes:
    """Lit un fichier du dépôt LIMS sans checkout — le clone partiel tire le blob ici.

    Vit dans le parseur et non dans `discovery/recon_lims.py` pour que l'ingestion ne
    dépende pas de la couche de reconnaissance : `recon_lims` est un outil de mesure, il
    peut disparaître sans que l'ingestion cesse de fonctionner.
    """
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


def numero_de_label(lab: ET.Element | None) -> str:
    """Numéro d'article tiré d'un `Label`, marqueurs de note RETIRÉS.

    Deux pièges en un, tous deux mesurés (§7.4) :

    1. Il faut APLATIR : 3 `Label` du corpus n'ont aucun `.text` propre et portent leur
       contenu dans un `FootnoteRef`. Prendre `.text` rendrait un numéro VIDE.
    2. Il faut RETIRER le marqueur de note : aplatir naïvement rend « *36 » pour l'art. 36
       de la *Loi sur le divorce*, et « *29 » / « *72 » pour la LPRPDE. L'astérisque est un
       renvoi de note, pas un numéro — personne ne cite « l'article *36 », et
       `get_article(law, '36')` ne trouverait rien.

    On reconstruit donc le texte en SAUTANT les sous-arbres `FootnoteRef`, au lieu de
    nettoyer après coup par une regex qui mangerait un jour un vrai caractère.
    """
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
    """Expanse « 11 à 14 » en ['11','12','13','14']. Propre à la LANGUE (`à`/`to`, `et`/`and`).

    Ne traite que les plages d'ENTIERS : « 54.1 à 54.49 » n'est pas énumérable sans supposer
    le pas, donc on rend la borne basse et la borne haute seulement.
    """
    m = _PLAGE.match(label)
    if not m:
        return []
    a, b = m.group(1), m.group(2)
    if a.isdigit() and b.isdigit() and int(a) <= int(b):
        return [str(n) for n in range(int(a), int(b) + 1)]
    return [a, b]


# --- statut d'une Section : la liste BLANCHE -----------------------------------

def chaine_ancetres(el: ET.Element, parents: dict) -> list[str]:
    """Chaîne d'ancêtres, de la racine vers l'élément."""
    out, cur = [], el
    while cur in parents:
        cur = parents[cur]
        out.append(_sans_ns(cur.tag))
    return list(reversed(out))


def statut_section(el: ET.Element, parents: dict) -> str:
    """'ingerable' ou 'refuse'. Lève ChaineInconnue sur toute chaîne inédite.

    AUCUNE BRANCHE PAR DÉFAUT : c'est le cœur de la garantie. Les trois chaînes blanches
    sont mesurées (§5) ; les cinq chaînes refusées passent toutes par un conteneur de
    REFUS_ANCETRE. Une sixième forme de refus, ou une quatrième forme ingérable, est un
    changement de balisage chez Justice Canada — arrêt pour revue humaine.
    """
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
    """Vrai pour une annexe de MODIFICATIONS NON EN VIGUEUR ou de DISPOSITIONS CONNEXES.

    Mesuré : `ScheduleFormHeading/@type='amending'` dans 38 cas (§5.1), et les `@id`
    `NifProvs` / `RelatedProvs`. Sans cette règle, `get_structure` annoncerait une annexe
    « MODIFICATIONS NON EN VIGUEUR » — vide ou, pire, peuplée.
    """
    if (sched.get("id") or "") in {"NifProvs", "RelatedProvs"}:
        return True
    for chemin in ("ScheduleFormHeading", "FormGroup/ScheduleFormHeading"):
        sfh = sched.find(chemin)
        if sfh is not None and sfh.get("type") == "amending":
            return True
    return False


# --- sérialisation du texte ----------------------------------------------------

# Retirés du texte : l'art. 14 de la Loi d'interprétation exclut les notes marginales et les
# mentions de textes antérieurs. `Label` de la Section elle-même : on le retire (c'est le
# numéro), mais on CONSERVE tous les Label INTERNES — on plaide « art. 183(1)a) L.F.I. ».
_HORS_SERIALISATION = {"MarginalNote", "HistoricalNote", "HistoricalNoteSubItem", "Footnote"}

# Éléments dont le Label s'écrit en tête de ligne, avec indentation par profondeur.
_NIVEAUX = ["Subsection", "Paragraph", "Subparagraph", "Clause", "Subclause", "Subsubclause"]

# Le SPEC §3.5 : rattacher APRÈS l'énumération qu'ils ferment, sinon la phrase se disloque.
_CONTINUES = {
    "ContinuedSectionSubsection", "ContinuedParagraph", "ContinuedDefinition",
    "ContinuedSubparagraph", "ContinuedClause", "ContinuedSubclause",
}


def _verifie_balises(racine: ET.Element) -> None:
    """LA PORTE. Toute balise inconnue arrête l'ingestion."""
    vues = {_sans_ns(el.tag) for el in racine.iter()}
    inconnues = sorted(vues - _TOUTES_CONNUES)
    if inconnues:
        raise BaliseInconnue(
            f"balise(s) absente(s) du classement : {inconnues}. "
            f"Les classer dans pipeline/expected/lims_tags.json (traitement + justification) "
            f"avant d'ingérer — docs/phase0-structure-lims.md §6. Arrêt."
        )


def serialise(el: ET.Element, profondeur: int = 0, racine_section: bool = True) -> list[str]:
    """Lignes de texte d'une Section (ou d'un de ses niveaux), Label internes conservés."""
    lignes: list[str] = []
    prefixe = "  " * profondeur

    # Le Label de CETTE unité : retiré à la racine (c'est le numéro d'article), conservé
    # partout ailleurs.
    lab = el.find("Label")
    tete = "" if racine_section or lab is None else f"{_plat(lab)} "

    txt = el.find("Text")
    if txt is not None:
        lignes.append(f"{prefixe}{tete}{_plat(txt)}".rstrip())
        tete = ""
    elif tete:
        lignes.append(f"{prefixe}{tete}".rstrip())
        tete = ""

    for enfant in el:
        nom = _sans_ns(enfant.tag)
        if nom in _HORS_SERIALISATION or nom == "Label" or nom == "Text":
            continue
        if nom in _NIVEAUX:
            lignes += serialise(enfant, profondeur + 1, racine_section=False)
        elif nom in ("Definition", "DefinitionEnOnly", "DefinitionFrOnly"):
            # ⚠️ §7.1 — LE PIÈGE PRINCIPAL. `Definition` est absente de la liste du SPEC §3.5.
            # Mesuré sur l'art. 2 de la L.F.I. : 51 blocs, 13 736 caractères. Ne pas
            # descendre ici rend « Les définitions qui suivent s'appliquent… » — 59
            # caractères, 99,6 % de l'article perdu, et une phrase plausible.
            lignes += serialise(enfant, profondeur + 1, racine_section=False)
        elif nom in _CONTINUES:
            # Rattaché APRÈS l'énumération, à la profondeur du PARENT.
            lignes.append(f"{prefixe}{_plat(enfant)}".rstrip())
        elif nom == "Repealed":
            lignes.append(f"{prefixe}{_plat(enfant)}".rstrip())
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
    """Rendu TABULAIRE d'un TableGroup/table CALS, d'un FormGroup ou d'une formule.

    Le SPEC §3.5 exige « un rendu tabulaire propre, PAS d'aplatissement en bouillie ». Les
    cellules d'une ligne sont jointes par ' : ' — même convention que le parseur EPUB
    (`pipeline/parser.py::_render_tables`), pour que les deux corpus se lisent pareil.
    """
    prefixe = "  " * profondeur
    lignes: list[str] = []
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
    # Pas de table CALS : formule ou formulaire. On garde l'ordre du document.
    t = _plat(el)
    if t:
        lignes.append(f"{prefixe}{t}")
    return lignes


def _historique(el: ET.Element) -> str | None:
    hn = el.find("HistoricalNote")
    if hn is None:
        return None
    items = [_plat(s) for s in hn if _sans_ns(s.tag) == "HistoricalNoteSubItem"]
    return "; ".join([i for i in items if i]) or (_plat(hn) or None)


def _notes(el: ET.Element) -> str | None:
    """Notes en bas de page, rendues À LA FIN de l'article et étiquetées (décision du 2026-09-11)."""
    notes = [_plat(f) for f in el.iter() if _sans_ns(f.tag) == "Footnote"]
    return "\n".join([n for n in notes if n]) or None


# --- métadonnées et citation ---------------------------------------------------

def _lims(el: ET.Element, nom: str) -> str | None:
    return el.get(f"{{{LIMS_NS}}}{nom}")


LIMS_NS = "http://justice.gc.ca/lims"


def derive_citation(racine: ET.Element, lang: str) -> tuple[str, str | None]:
    """Citation officielle, dérivée d'`Identification`. JAMAIS du nom de fichier.

    Trois formes déterministes pour une LOI (SPEC §3.4, toutes mesurées) :
      ConsolidatedNumber official="yes"                  -> L.R.C. (1985), ch. <N>
      official="no" + AnnualStatuteId revised-statute    -> L.R.C. (<AAAA>), ch. <NumAnnuel>
      official="no" + AnnualStatuteId                    -> L.C. <AAAA>, ch. <N>
    Pour un RÈGLEMENT, la citation EST `InstrumentNumber` (« DORS/98-106 », « C.R.C., ch. 368 »).

    Rend (citation, chapitre). Le CHAPITRE est rendu séparément parce que c'est sur LUI que
    `parseCitation` doit apparier côté Worker, jamais sur la citation entière : « L.R.C.
    (1985), ch. B-3 » fait 23 caractères, plus que tout chapitre RLRQ, et remporterait la
    course du plus long.
    """
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
    # Peut contenir du balisage : « 3 (2<Sup>e</Sup> suppl.) ». On APLATIT.
    numero = _plat(numero_el)

    if ann.get("revised-statute") == "yes":
        cite = (f"L.R.C. ({annee}), ch. {numero}" if lang == "fr"
                else f"R.S.C. {annee}, c. {numero}")
    else:
        cite = f"L.C. {annee}, ch. {numero}" if lang == "fr" else f"S.C. {annee}, c. {numero}"
    # Le chapitre reste le ConsolidatedNumber quand il existe (« D-3.4 ») : c'est la clé
    # d'appariement, même quand elle n'est pas citable.
    return cite, num


def derive_titre(racine: ET.Element) -> str:
    """Titre du texte. `ShortTitle` pour une loi, `LongTitle` pour un règlement (§7.7)."""
    ident = racine.find("Identification")
    if ident is None:
        raise BalisageIncoherent("pas d'Identification : titre indérivable")
    for nom in ("ShortTitle", "LongTitle"):
        el = ident.find(nom)
        if el is not None and _plat(el):
            return _plat(el)
    raise BalisageIncoherent("ni ShortTitle ni LongTitle")


def derive_in_force(racine: ET.Element) -> int:
    """1 = en vigueur, 0 = édictée mais non en vigueur.

    POLARITÉ PAR TYPE DE RACINE, et c'est le blocage du SPEC §3.7. Une racine `Regulation`
    ne DÉCLARE PAS cet attribut (la DTD ne le prévoit pas, et ni DORS/98-106 ni C.R.C.
    ch. 368 ne le portent) : « absent ⇒ 0 » refuserait les deux règlements du corpus, et
    avec eux les Tarifs A et B que le SPEC déclare indispensables. L'absence n'est une
    information que là où l'attribut EXISTE.
    """
    nom = _sans_ns(racine.tag)
    val = racine.get("in-force")
    if nom == "Regulation":
        return 0 if val is not None and val != "yes" else 1
    if val is None:
        return 0  # une LOI sans l'attribut : F-29.2, édictée et non en vigueur
    return 1 if val == "yes" else 0


# --- bilan de matière : le contrôle qui remplace l'invariant §4.1 --------------

@dataclass
class Bilan:
    """Bilan de matière PAR PROVENANCE.

    L'invariant §4.1 du SPEC (« articles ingérés = Section sous Body + annexes ingérées »)
    est structurellement aveugle : son terme droit est PRODUIT par le walker qu'il prétend
    vérifier, et il s'équilibre à 19 = 11 + 8 sur I-15 quand une annexe refusée est comptée
    comme légitime. On compte donc par RAISON, et la somme doit couvrir toutes les Section
    du fichier avec `inconnu == 0`.
    """
    corps: int = 0
    annexe: int = 0
    preambule: int = 0
    refuse_ancetre: int = 0
    refuse_annexe: int = 0
    inconnu: int = 0
    # Numéros des Section REFUSÉES. Sert au rapport de validation : une « lacune » dans la
    # numérotation fédérale s'explique soit par un retrait à la codification, soit par un
    # refus de non-vigueur — et il faut pouvoir DIRE lequel, article par article.
    numeros_refuses: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return (self.corps + self.annexe + self.preambule
                + self.refuse_ancetre + self.refuse_annexe + self.inconnu)

    def as_dict(self) -> dict[str, int]:
        return {"corps": self.corps, "annexe": self.annexe, "preambule": self.preambule,
                "refuse_ancetre": self.refuse_ancetre, "refuse_annexe": self.refuse_annexe,
                "inconnu": self.inconnu, "total": self.total}


# --- le parseur ----------------------------------------------------------------

def parse_lims(
    xml_bytes: bytes, law: Law, lang: str, *, bilan: Bilan | None = None,
) -> tuple[list[Division], list[Article]]:
    """Signature SYMÉTRIQUE de `parse_epub` : rend (divisions, articles) en ordre document.

    Ne touche pas la base, ne renseigne ni `id`, ni `parent_id`, ni `division_id` — c'est
    `load.prepare` qui les attribue. Fixe en revanche `sort_key` pour les pseudo-articles et
    pour les labels de plage (calculé sur le PREMIER numéro), parce que `sort_key()` seul
    rendrait `DISPOSITION_SORT_BASE` pour « 11 à 14 » et empilerait toutes les plages du
    corpus sur une seule valeur.

    `bilan` est rempli au passage si fourni : c'est lui que `validate.py` comparera au grand
    livre versionné.
    """
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
            # Les numeros couverts par un label de plage. Le parseur decide, parce que la
            # forme est PROPRE A LA LANGUE ; load.py ecrit les lignes d article_numbers.
            alias_numbers=expand_plage(numero),
        ))

    def cle_de(numero: str) -> int | None:
        """Clé pré-posée seulement là où `sort_key()` seul se tromperait."""
        if _NUM_SIMPLE.match(numero):
            return None                      # cas normal : load.prepare calcule
        premiers = expand_plage(numero)
        if premiers:
            return sort_key(premiers[0])     # label de plage : clé du PREMIER numéro
        return None

    # --- le préambule (SPEC §3.6 : deux emplacements possibles) ---------------
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
            # 0, comme `préliminaire` : le préambule PRÉCÈDE l'article 1. `sort_key()` seul
            # rendrait 9e15 (numéro non numérique) et l'enverrait en fin de corpus.
            sort_key=0,
        ))
        b.preambule += 1

    # --- le corps -------------------------------------------------------------
    body = racine.find("Body")
    if body is not None:
        pile: list[int] = []       # rang courant à chaque niveau
        chemin_courant = ""
        # Vrai entre la Section « Préambule » et la Section à Label vide qui la suit.
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
                # `kind` : PARTIE/PART cherché sur le Label ET sur le TitleText — 286 des
                # 324 Heading du Code criminel n'ont AUCUN Label, et « Partie I » porte son
                # numéro dans le TitleText là où « PARTIE II » a un vrai Label (SPEC §3.2).
                joint = f"{brut} {intitule or ''}".strip().upper()
                kind = "partie" if joint.startswith(("PARTIE", "PART ")) else "rubrique"
                numero = None
                if brut:
                    m = re.search(r"([IVXLCDM0-9][IVXLCDM0-9.]*)", brut)
                    numero = m.group(1) if m else None
                elif intitule:
                    m = re.match(r"(?:PARTIE|PART)\s+([IVXLCDM0-9]+)", intitule.upper())
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

                # PRÉAMBULE DANS LE CORPS — le second des deux emplacements que le SPEC
                # §3.6 signale. Mesuré : sur les 36 fichiers, le cas n'existe QUE dans le
                # Code canadien du travail, et il s'y présente en DEUX Section consécutives.
                # La première porte Label « Préambule » / « Preamble » et AUCUN texte propre
                # (9 caractères, soit son seul label) : c'est un intertitre déguisé en
                # Section. La seconde porte un Label VIDE et contient les `Provision`.
                # Il n'existe que 2 Section à Label vide dans tout le corpus, toutes deux
                # ici — la règle est donc aussi étroite que le cas.
                if numero in ("Préambule", "Preamble"):
                    # COMPTÉE, bien qu'elle ne produise aucun article à elle seule : le
                    # bilan de matière doit couvrir TOUTE Section du fichier, sinon il ne
                    # vaut pas mieux que l'invariant §4.1 qu'il remplace. Les deux Section
                    # du préambule fusionnent donc en UN article, et le bilan en compte 2.
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
                        # 0 : le préambule PRÉCÈDE l'article 1. Art. 13 de la Loi
                        # d'interprétation — « le préambule fait partie du texte ».
                        sort_key=0,
                    ))
                    b.preambule += 1
                    attend_preambule = False
                    continue
                attend_preambule = False

                ajoute_article(el, chemin_courant, numero, cle_de(numero))
                b.corps += 1
            else:
                # Mesuré : `Body` n'a JAMAIS d'autre enfant direct que Section et Heading sur
                # les 36 fichiers du corpus (§3). On ARRÊTE plutôt que de traverser en
                # silence — la DTD autorise pourtant Reserved, Repealed, CommentBlock,
                # PageBreak, RelatedProvision et Schedule à cette place.
                raise BalisageIncoherent(
                    f"<{nom}> en enfant direct de Body : jamais observé sur le corpus (§3). "
                    f"Le classer avant d'ingérer — arrêt pour revue humaine."
                )

    # --- les annexes ----------------------------------------------------------
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
        # ESPACE DE NOMS des numéros d'annexe (décision du 2026-09-11). Mesuré : l'annexe
        # `ANNEXE` de C-44 porte les numéros 1 à 9, qui collisionnent avec les articles 1 à 9
        # du corps — deux contenus tous deux ingérables. Le préfixe suit le précédent
        # québécois, dont le parseur EPUB fabrique déjà `annexe-i`.
        base = etiquette or f"annexe {idx}"
        slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or f"annexe-{idx}"
        for sec in [s for s in sched.iter() if _sans_ns(s.tag) == "Section"]:
            if statut_section(sec, parents) == "refuse":
                b.refuse_ancetre += 1
                continue
            brut = numero_de_label(sec.find("Label"))
            numero = f"{slug}-{brut}" if brut else slug
            # Numéro non numérique ⇒ pseudo-article : on fixe l'ordre nous-mêmes, après le
            # corps, exactement comme le parseur EPUB le fait pour ses annexes.
            cle = DISPOSITION_SORT_BASE + disp_idx * 1_000_000
            disp_idx += 1
            ajoute_article(sec, chemin, numero, cle)
            b.annexe += 1

    # TOUTE Section du fichier doit avoir été comptée quelque part. C'est ce contrôle qui
    # remplace l'invariant §4.1, lequel s'équilibre des deux côtés et ne voit donc rien.
    total_fichier = sum(1 for e in racine.iter() if _sans_ns(e.tag) == "Section")
    comptees = b.total          # CAPTURÉ AVANT de poser `inconnu`, sinon le message
    if comptees != total_fichier:  # rapporterait le total d'APRÈS correction et cacherait
        b.inconnu = total_fichier - comptees  # l'écart qu'il est censé dénoncer.
        raise BalisageIncoherent(
            f"bilan de matière incomplet : {comptees} Section comptées sur {total_fichier} "
            f"présentes, soit {b.inconnu} non attribuée(s) ({b.as_dict()}). Une Section "
            f"n'a été ni ingérée ni refusée — exactement ce que l'invariant §4.1 du SPEC ne "
            f"sait pas voir, puisqu'il s'équilibre des deux côtés. Arrêt."
        )
    return divisions, articles
