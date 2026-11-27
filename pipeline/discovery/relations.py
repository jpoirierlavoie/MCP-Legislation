from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path

from .. import config
from ..d1_api import make_client, q
from ..parser import harvest_renvois

def _fr_epub_path(law_id: str, samples_dir: Path | None = None) -> Path:
    base = samples_dir if samples_dir is not None else config.SAMPLES_DIR
    return base / f"{law_id.upper()}-fr.epub"

def _chapter_declare(law: dict) -> str | None:
    ch = (law.get("chapter") or "").strip()
    return ch or None

def _chapter(rlrq_cite: str, root: bool = False) -> str | None:
    m = re.search(r"c\.\s*(.+)$", rlrq_cite or "")
    if not m:
        return None
    chap = m.group(1).strip()
    return chap.split(",")[0].strip() if root else chap

def chapitre_de(law: dict, root: bool = False) -> str | None:
    if law.get("source") == "pdf":
        if law.get("fonction") == "reglement":
            return _chapter(law.get("official_cite"), root=root)
        return law.get("chapter") or law["id"]
    declare = _chapter_declare(law)
    if declare:
        return declare
    return _chapter(law.get("official_cite"), root=root)

def _norm(chapter: str | None) -> str:
    return re.sub(r"\s+", "", chapter or "").lower()

_ALIAS_RACINE = {"ccq": "ccq-1991"}

def _key(chapter: str | None) -> str:
    k = _norm(chapter)
    return _ALIAS_RACINE.get(k, k)

def cle_de(law: dict, root: bool = False) -> tuple[str, str]:
    if law.get("source") == "pdf" and law.get("fonction") != "reglement":
        return ("pdf", _key(chapitre_de(law, root=root)))
    return (law.get("jurisdiction") or "qc", _key(chapitre_de(law, root=root)))

def _is_regulation(law: dict) -> bool:
    if law.get("source") == "pdf":
        return law.get("fonction") == "reglement" and ", r." in (law.get("official_cite") or "")
    if (law.get("jurisdiction") or "qc") != "qc":
        return (law.get("fonction") or "loi") != "loi"
    return ", r." in (law.get("official_cite") or "")

class CorpusEpubIncomplet(RuntimeError):
    pass

class CleEnCollision(RuntimeError):
    pass

def _carte(laws: list[dict], root: bool, seulement_lois: bool) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for l in laws:
        if seulement_lois and (l.get("source") == "pdf" or _is_regulation(l)):
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

def epubs_manquants(laws: list[dict], samples_dir: Path | None = None) -> list[str]:
    return [l["id"] for l in laws
            if (l.get("jurisdiction") or "qc") == "qc"
            and (l.get("source") or "epub") == "epub"
            and not _fr_epub_path(l["id"], samples_dir).exists()]

def build(
    db,
    accepter_corpus_partiel: bool = False,
    samples_dir: Path | None = None,
    only_laws: set[str] | None = None,
) -> dict:
    laws = config.load_all_laws()
    target_laws = [l for l in laws if l["id"] in only_laws] if only_laws is not None else laws

    manquants = epubs_manquants(target_laws, samples_dir=samples_dir)
    if manquants and not accepter_corpus_partiel:
        attendus = sum(
            1 for l in target_laws
            if (l.get("jurisdiction") or "qc") == "qc" and (l.get("source") or "epub") == "epub"
        )
        dossier = samples_dir if samples_dir is not None else config.SAMPLES_DIR
        raise CorpusEpubIncomplet(
            f"{len(manquants)} EPUB FR sur {attendus} absents de {dossier} : "
            f"les renvois de ces textes ne seraient PAS moissonnes, alors que le DELETE "
            f"des relations 'auto' a deja lieu. Poser les EPUB (`ingest --all --download`) "
            f"ou passer --accepter-corpus-partiel en connaissance de cause. "
            f"Manquants : {', '.join(manquants[:8])}"
            + (f" … (+{len(manquants) - 8})" if len(manquants) > 8 else "")
        )
    by_full = _carte(laws, root=False, seulement_lois=False)
    by_root = _carte(laws, root=True, seulement_lois=True)

    edges: dict[tuple, list] = {}
    parents: dict[str, str] = {}
    sans_parent: list[str] = []

    for l in target_laws:
        if _is_regulation(l):
            parent = by_root.get(cle_de(l, root=True))
            if parent and parent != l["id"]:
                edges[(l["id"], parent, "reglement-de")] = [1, 1, "chapitre racine RLRQ"]
                parents[l["id"]] = parent
            else:
                sans_parent.append(l["id"])

    for l in target_laws:
        if (l.get("jurisdiction") or "qc") != "qc" or (l.get("source") or "epub") != "epub":
            continue
        epub = _fr_epub_path(l["id"], samples_dir)
        if not epub.exists():
            continue
        with zipfile.ZipFile(epub) as zf:
            htmls = [zf.read(n).decode("utf-8", "replace")
                     for n in zf.namelist() if re.search(r"page\d+\.xhtml$", n)]
        self_key = cle_de(l)
        for chapter, count in harvest_renvois(htmls).items():
            cible = ("qc", _key(chapter))
            if cible == self_key:
                continue
            target_id = by_full.get(cible)
            to = target_id or chapter
            key = (l["id"], to, "renvoie-a")
            prev = edges.get(key, [0, 1 if target_id else 0, None])
            edges[key] = [prev[0] + count, 1 if target_id else 0, None]

    if only_laws is None:
        db.run("DELETE FROM law_relations WHERE source = 'auto'")
    elif target_laws:
        scoped = ", ".join(q(l["id"]) for l in target_laws)
        db.run(f"DELETE FROM law_relations WHERE source = 'auto' AND from_law_id IN ({scoped})")
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
    ap.add_argument("--persist-to", default=None, help="Répertoire D1 local (--local uniquement).")
    ap.add_argument("--samples-dir", default=None, help="Répertoire des EPUB (défaut pipeline/samples/).")
    ap.add_argument("--accepter-corpus-partiel", action="store_true",
                    help="reconstruire meme si des EPUB manquent (DETRUIT les renvois des "
                         "textes absents du disque — cf. CorpusEpubIncomplet)")
    args = ap.parse_args(argv)
    db = make_client(args.target, persist_to=args.persist_to)
    sdir = Path(args.samples_dir) if args.samples_dir else None
    c = build(db, accepter_corpus_partiel=args.accepter_corpus_partiel, samples_dir=sdir)
    print(f"[{db.name}] relations 'auto' : {c['reglement_de']} reglement-de "
          f"(parent_law_id sur {c['parents']} lois), {c['renvoie_a']} renvoie-a "
          f"(dont {c['renvoie_a_in_corpus']} au corpus).")
    if c["epubs_manquants"]:
        print(f"[{db.name}] ATTENTION : {c['epubs_manquants']} EPUB absents — les renvois de "
              f"ces textes viennent d'etre PERDUS (--accepter-corpus-partiel).")
    if c["sans_parent"]:
        print(f"[{db.name}] sans loi habilitante resolue ({len(c['sans_parent'])}) : "
              f"{', '.join(c['sans_parent'])}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
