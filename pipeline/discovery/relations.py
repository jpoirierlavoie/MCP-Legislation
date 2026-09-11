"""Relations dérivées automatiquement (plan §3.3) : construites depuis les textes/config,
chargées dans law_relations (source='auto', sans toucher aux relations 'cure').

* reglement-de : chaque règlement (« RLRQ, c. X, r. Y ») -> sa loi habilitante (chapitre racine
  X, résolu via official_cite, PAS via l'id). Renseigne aussi laws.parent_law_id.
* renvoie-a : renvois <a href> vers d'autres chapitres RLRQ, agrégés par (loi, cible) avec
  weight = nombre de renvois ; cible hors corpus -> in_corpus=0 (candidat d'acquisition).

    python -m pipeline.discovery.relations --target {local|cloud}

CORPUS FÉDÉRAL — trois défauts mesurés le 2026-09-11 et corrigés ici.

1. `_chapter` reniflait `official_cite` avec la regex `c\\.`, SENSIBLE À LA CASSE. Les
   citations fédérales s'écrivent « L.R.C. (1985), ch. B-3 » : aucun `c.` minuscule suivi
   d'un point. La fonction rendait donc `None` pour les **18** textes fédéraux, tous
   réduits à la clé de chapitre VIDE — donc en collision les uns avec les autres, le
   dernier de `laws.config.json` l'emportant en silence (`ca-crc-368`). Un renvoi moissonné
   qui aurait normalisé à vide se serait résolu vers lui.
   → On lit désormais la colonne DÉCLARÉE `chapter` quand elle existe, et on ne renifle la
   citation que pour les entrées québécoises qui n'en portent pas. Déclarer plutôt que
   renifler, c'est la leçon du défaut `B-1` ⊂ `B-1.1` de `parseCitation`.

2. LES CLÉS DE CHAPITRE SONT MAINTENANT NOMMÉES PAR JURIDICTION, et ce n'est pas de la
   prudence décorative : le RLRQ et les L.R.C. emploient le MÊME schéma lettre-chiffre.
   Mesuré au 2026-09-11 : zéro collision réelle (Québec a `b-1`, `c-26`, `c-38` ; le fédéral
   `b-3`, `c-34`, `c-44`) — mais c'est un hasard, pas une propriété. Un seul ajout qui se
   recouvre et un renvoi québécois résoudrait vers une loi FÉDÉRALE ; et il gagnerait,
   puisque l'invariant 1 impose d'ajouter en FIN de liste. Les renvois sont moissonnés dans
   les EPUB de LégisQuébec, donc ils désignent des chapitres RLRQ : ils ne se résolvent que
   contre `('qc', clé)`.

3. `_is_regulation` testait `", r." in cite`, la marque d'un règlement RLRQ. Les deux textes
   réglementaires fédéraux s'écrivent « DORS/98-106 » et « C.R.C., ch. 368 » : ils étaient
   donc classés LOIS, et entraient dans la carte des lois habilitantes.
   → Le classement passe par `fonction`, qui est DÉCLARÉE, pour le fédéral.

Ce que ce module ne fait PAS, et il faut le savoir : les deux textes réglementaires fédéraux
n'obtiennent AUCUNE loi habilitante, parce qu'aucun `parent_chapter` n'est déclaré et qu'on
ne devinera pas une loi habilitante. C'est une relation MANQUANTE, énoncée — jamais une
relation fausse. Elle relève de la passe éditoriale (`relations.json`, ⛔ invariant 16).
"""
from __future__ import annotations

import argparse
import re
import zipfile

from .. import config
from ..d1_api import make_client, q
from ..ingest import _sample_path
from ..parser import harvest_renvois


def _chapter_declare(law: dict) -> str | None:
    """Chapitre DÉCLARÉ en configuration (`chapter`). Présent sur les entrées fédérales."""
    ch = (law.get("chapter") or "").strip()
    return ch or None


def _chapter(rlrq_cite: str, root: bool = False) -> str | None:
    """Chapitre d'un official_cite RLRQ. root=True : chapitre racine (avant « , r. »).

    Ne vaut que pour le QUÉBEC : la forme fédérale (« ch. B-3 ») n'a pas de `c.` minuscule,
    et c'est voulu qu'elle ne soit pas reniflée ici — elle passe par `chapter`.
    """
    m = re.search(r"c\.\s*(.+)$", rlrq_cite or "")
    if not m:
        return None
    chap = m.group(1).strip()
    return chap.split(",")[0].strip() if root else chap


def chapitre_de(law: dict, root: bool = False) -> str | None:
    """Chapitre d'une loi : la valeur DÉCLARÉE d'abord, le reniflage de citation ensuite.

    Pour un texte fédéral, `chapter` est la seule source — et sa forme racine est
    elle-même (il n'y a pas de « , r. N » fédéral à retrancher).
    """
    declare = _chapter_declare(law)
    if declare:
        return declare
    return _chapter(law.get("official_cite"), root=root)


def _norm(chapter: str | None) -> str:
    return re.sub(r"\s+", "", chapter or "").lower()


# Chapitres RLRQ dont la loi et ses règlements ne portent PAS le même identifiant.
# Le Code civil est « c. CCQ-1991 » mais ses règlements sont « c. CCQ, r. N » : sans cet
# alias, ccq-r.6 / ccq-r.8 n'auraient AUCUN parent — en silence, sans erreur.
_ALIAS_RACINE = {"ccq": "ccq-1991"}


def _key(chapter: str | None) -> str:
    k = _norm(chapter)
    return _ALIAS_RACINE.get(k, k)


def cle_de(law: dict, root: bool = False) -> tuple[str, str]:
    """Clé de résolution d'un chapitre : (juridiction, chapitre normalisé).

    La juridiction fait PARTIE de la clé — cf. le point 2 de l'en-tête.
    """
    return (law.get("jurisdiction") or "qc", _key(chapitre_de(law, root=root)))


def _is_regulation(law: dict) -> bool:
    """Le texte est-il subordonné à une loi habilitante ?

    Québec : la marque est dans la citation (« RLRQ, c. X, r. Y »), et on ne la change pas —
    elle couvre règlements, règles de procédure et tarifs, tous cités sous « , r. ».
    Fédéral : la citation ne porte aucune marque (« DORS/98-106 », « C.R.C., ch. 368 »), donc
    on lit `fonction`, qui est déclarée.
    """
    if (law.get("jurisdiction") or "qc") != "qc":
        return (law.get("fonction") or "loi") != "loi"
    return ", r." in (law.get("official_cite") or "")


class CorpusEpubIncomplet(RuntimeError):
    """Les EPUB nécessaires à la moisson des renvois ne sont pas sur le disque.

    ⚠️ MESURÉ LE 2026-09-11, ET C'ÉTAIT À UN GESTE DE LA PRODUCTION. `build` commence par
    `DELETE FROM law_relations WHERE source = 'auto'`, PUIS reconstruit les `renvoie-a` en
    moissonnant les `<a href>` des EPUB **locaux**. Or seuls 2 des 79 EPUB québécois étaient
    présents. Lancer la commande aurait donc :

        supprimé  1 319 relations 'auto' (33 reglement-de + 1 286 renvoie-a)
        recréé       33 reglement-de (elles viennent de la config, pas des EPUB)
                  + une poignée de renvoie-a, depuis 2 fichiers

    soit **~1 250 relations détruites en silence** — `qclaw_related_laws` vidé pour presque
    toutes les lois, et le signal S4 de `find_relevant` amputé, `law_relations` étant l'une
    des quatre sources de `loadRelevanceData`. Aucune erreur n'aurait été levée : la
    reconstruction aurait « réussi », simplement avec presque rien dedans.

    L'étape 4 de « Ajouter une loi » (CLAUDE.md) prescrit `relations.py` sur les deux cibles
    sans dire qu'elle exige le corpus d'EPUB téléchargé. D'où cette garde, ici et non dans la
    consigne : une consigne ne s'exécute pas.

    Rattrapage : `ingest --all --download` pose les EPUB, puis relancer. Ou
    `--accepter-corpus-partiel` si l'on veut VRAIMENT reconstruire depuis un corpus partiel,
    en le sachant.
    """


class CleEnCollision(RuntimeError):
    """Deux textes se disputent une même clé (juridiction, chapitre).

    ARRÊT plutôt que « le dernier gagne » : un chapitre ambigu résoudrait un renvoi vers le
    mauvais texte, en silence. C'est le mode de défaut que ce dépôt refuse.
    """


def _carte(laws: list[dict], root: bool, seulement_lois: bool) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for l in laws:
        if seulement_lois and _is_regulation(l):
            continue
        k = cle_de(l, root=root)
        if not k[1]:
            raise CleEnCollision(
                f"{l['id']} n'a AUCUN chapitre resolvable (official_cite="
                f"{l.get('official_cite')!r}, chapter={l.get('chapter')!r}). "
                "Declarer `chapter` en configuration — une cle vide collisionne avec "
                "toutes les autres cles vides, et le dernier texte charge l'emporte."
            )
        if k in out:
            raise CleEnCollision(
                f"chapitre {k!r} revendique par {out[k]} ET {l['id']}. Un renvoi vers ce "
                "chapitre resoudrait vers l'un des deux au hasard de l'ordre de "
                "laws.config.json — arret."
            )
        out[k] = l["id"]
    return out


def epubs_manquants(laws: list[dict]) -> list[str]:
    """Textes québécois dont l'EPUB FR n'est pas sur le disque (donc dont les renvois ne
    seront PAS moissonnés)."""
    return [l["id"] for l in laws
            if (l.get("jurisdiction") or "qc") == "qc"
            and not _sample_path(l["id"], "fr").exists()]


def build(db, accepter_corpus_partiel: bool = False) -> dict:
    laws = config.load_all_laws()

    # PORTE, AVANT LE PREMIER DELETE. Cf. `CorpusEpubIncomplet` : sans les EPUB, la
    # reconstruction « réussit » en ne recréant presque rien.
    manquants = epubs_manquants(laws)
    if manquants and not accepter_corpus_partiel:
        attendus = sum(1 for l in laws if (l.get("jurisdiction") or "qc") == "qc")
        raise CorpusEpubIncomplet(
            f"{len(manquants)} EPUB FR sur {attendus} absents de {config.SAMPLES_DIR} : "
            f"les renvois de ces textes ne seraient PAS moissonnes, alors que le DELETE "
            f"des relations 'auto' a deja lieu. Poser les EPUB (`ingest --all --download`) "
            f"ou passer --accepter-corpus-partiel en connaissance de cause. "
            f"Manquants : {', '.join(manquants[:8])}"
            + (f" … (+{len(manquants) - 8})" if len(manquants) > 8 else "")
        )
    # cartes chapitre -> id : complète (toutes lois) et racine (lois habilitantes seulement)
    by_full = _carte(laws, root=False, seulement_lois=False)
    by_root = _carte(laws, root=True, seulement_lois=True)

    edges: dict[tuple, list] = {}   # (from, to, rel_type) -> [weight, in_corpus, note]
    parents: dict[str, str] = {}
    sans_parent: list[str] = []

    # 1) reglement-de (+ parent_law_id)
    for l in laws:
        if _is_regulation(l):
            parent = by_root.get(cle_de(l, root=True))
            if parent and parent != l["id"]:
                edges[(l["id"], parent, "reglement-de")] = [1, 1, "chapitre racine RLRQ"]
                parents[l["id"]] = parent
            else:
                sans_parent.append(l["id"])

    # 2) renvoie-a (moisson des <a href> depuis l'EPUB FR)
    #
    # BORNÉ AUX TEXTES QUÉBÉCOIS, EXPLICITEMENT. Les textes fédéraux arrivent en XML LIMS et
    # n'ont pas d'EPUB : le `continue` sur `epub.exists()` les écartait déjà, mais par
    # ACCIDENT. Un accident n'est pas une garantie — si `_sample_path` changeait de
    # convention, un fichier XML partirait dans un lecteur de zip. Et surtout, la moisson
    # de renvois LIMS n'est pas écrite : la déclarer ici serait mentir sur la couverture.
    for l in laws:
        if (l.get("jurisdiction") or "qc") != "qc":
            continue
        epub = _sample_path(l["id"], "fr")
        if not epub.exists():
            continue
        with zipfile.ZipFile(epub) as zf:
            htmls = [zf.read(n).decode("utf-8", "replace")
                     for n in zf.namelist() if re.search(r"page\d+\.xhtml$", n)]
        self_key = cle_de(l)
        for chapter, count in harvest_renvois(htmls).items():
            # Les renvois sont moissonnés dans les EPUB de LégisQuébec : ils désignent des
            # chapitres RLRQ. Ils ne se résolvent donc QUE contre la juridiction 'qc'.
            cible = ("qc", _key(chapter))
            if cible == self_key:
                continue  # renvoi interne
            target_id = by_full.get(cible)
            to = target_id or chapter
            key = (l["id"], to, "renvoie-a")
            prev = edges.get(key, [0, 1 if target_id else 0, None])
            edges[key] = [prev[0] + count, 1 if target_id else 0, None]

    # 3) chargement (sans toucher aux relations 'cure')
    db.run("DELETE FROM law_relations WHERE source = 'auto'")
    rows = [[f, t, rt, "auto", w, ic, note] for (f, t, rt), (w, ic, note) in edges.items()]
    cols = ["from_law_id", "to_law_id", "rel_type", "source", "weight", "in_corpus", "note"]
    for i in range(0, len(rows), 100):
        vals = ", ".join("(" + ", ".join(q(v) for v in r) + ")" for r in rows[i:i + 100])
        db.run(f"INSERT OR REPLACE INTO law_relations ({', '.join(cols)}) VALUES {vals}")
    for lid, pid in parents.items():
        db.run(f"UPDATE laws SET parent_law_id = {q(pid)} WHERE id = {q(lid)}")

    reglement = sum(1 for k in edges if k[2] == "reglement-de")
    renvoie = sum(1 for k in edges if k[2] == "renvoie-a")
    in_corpus = sum(1 for k, v in edges.items() if k[2] == "renvoie-a" and v[1])
    return {"reglement_de": reglement, "renvoie_a": renvoie,
            "renvoie_a_in_corpus": in_corpus, "parents": len(parents),
            "sans_parent": sans_parent, "epubs_manquants": len(manquants)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Relations dérivées (reglement-de, renvoie-a).")
    ap.add_argument("--target", default="local", choices=["local", "cloud"])
    ap.add_argument("--accepter-corpus-partiel", action="store_true",
                    help="reconstruire meme si des EPUB manquent (DETRUIT les renvois des "
                         "textes absents du disque — cf. CorpusEpubIncomplet)")
    args = ap.parse_args(argv)
    db = make_client(args.target)
    c = build(db, accepter_corpus_partiel=args.accepter_corpus_partiel)
    print(f"[{db.name}] relations 'auto' : {c['reglement_de']} reglement-de "
          f"(parent_law_id sur {c['parents']} lois), {c['renvoie_a']} renvoie-a "
          f"(dont {c['renvoie_a_in_corpus']} au corpus).")
    # ÉNONCÉ, jamais deviné : un texte subordonné sans loi habilitante résolue est une
    # relation MANQUANTE qu'il faut voir passer, pas un silence.
    if c["epubs_manquants"]:
        print(f"[{db.name}] ATTENTION : {c['epubs_manquants']} EPUB absents — les renvois de "
              f"ces textes viennent d'etre PERDUS (--accepter-corpus-partiel).")
    if c["sans_parent"]:
        print(f"[{db.name}] sans loi habilitante resolue ({len(c['sans_parent'])}) : "
              f"{', '.join(c['sans_parent'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
