from __future__ import annotations

import argparse

from ..d1_api import make_client
from ..validate import EXPECTED

def verify(db, *, allow_witness_drift: bool = False) -> bool:
    ok = True
    print(f"=== Vérification [{db.name}] ===")

    for tbl in ("subjects", "subject_map", "law_relations"):
        n = db.run(f"SELECT COUNT(*) AS n FROM {tbl}")[0]["n"]
        print(f"  {tbl:14}: {n}")
    print("  laws (métadonnées) :", db.run("SELECT COUNT(*) AS n FROM laws")[0]["n"])

    total_paths = db.run("SELECT COUNT(*) AS n FROM subject_map WHERE division_path != ''")[0]["n"]
    unresolved = db.run(
        "SELECT sm.subject_id, sm.law_id, sm.division_path FROM subject_map sm "
        "WHERE sm.division_path != '' AND NOT EXISTS "
        "(SELECT 1 FROM divisions d WHERE d.law_id = sm.law_id AND d.path = sm.division_path "
        " AND d.lang = 'fr')"
    )
    print(f"\n  division_path non vides : {total_paths} | non résolus (fr) : {len(unresolved)}")
    for u in unresolved:
        ok = False
        print("   ✗ NON RÉSOLU :", u)
    if not unresolved:
        print("   ✓ tous les division_path de subject_map résolvent en français")

    sans_en = db.run(
        "SELECT DISTINCT sm.law_id, l.source, "
        "EXISTS (SELECT 1 FROM articles a WHERE a.law_id = sm.law_id AND a.lang = 'en') AS has_en "
        "FROM subject_map sm "
        "JOIN laws l ON l.id = sm.law_id "
        "WHERE sm.division_path != '' AND NOT EXISTS "
        "(SELECT 1 FROM divisions d WHERE d.law_id = sm.law_id AND d.lang = 'en')"
    )
    blocking_sans_en = [r for r in sans_en if r["source"] != "pdf" or r["has_en"]]
    pdf_fr_only = [r for r in sans_en if r["source"] == "pdf" and not r["has_en"]]
    for r in pdf_fr_only:
        print("   · loi PDF unilingue FR (aucune division EN) :", r["law_id"])
    for r in blocking_sans_en:
        ok = False
        print("   ✗ AUCUNE division anglaise, chemin mappé inadressable en EN :", r["law_id"])
    if not blocking_sans_en:
        print("   ✓ toute loi bilingue à chemin mappé porte aussi des divisions anglaises")

    print("\n  Non-destruction (articles) :")
    for law_id in ("ccq", "cpc"):
        for lang in ("fr", "en"):
            exp = EXPECTED[(law_id, lang)]
            expected = exp["articles_real"] + exp["dispositions"]
            n = db.run(f"SELECT COUNT(*) AS n FROM articles WHERE law_id='{law_id}' AND lang='{lang}'")[0]["n"]
            if allow_witness_drift:
                good = n >= expected - 20
                mark = "✓" if n == expected else ("⚠" if good else "✗")
                note = "" if n == expected else f" (témoin figé {expected})"
            else:
                good = n == expected
                mark = "✓" if good else "✗"
                note = "" if good else f" (attendu {expected})"
            ok &= good
            print(f"   {mark} {law_id}/{lang} : {n}{note}")

    laws_norm = db.run("SELECT COUNT(*) AS n FROM laws WHERE id IN ('ccq','cpc') AND name_norm IS NOT NULL")[0]["n"]
    div_norm = db.run("SELECT COUNT(*) AS n FROM divisions WHERE law_id IN ('ccq','cpc') AND heading_norm IS NOT NULL")[0]["n"]
    print(f"\n  name_norm rempli (ccq,cpc) : {laws_norm}/2 | heading_norm rempli : {div_norm} divisions")

    print(f"\n=== Résultat : {'OK ✅' if ok else 'ÉCHEC ❌'} ===")
    return ok

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Preuves de la phase A.")
    ap.add_argument("--target", default="local", choices=["local", "cloud"])
    ap.add_argument("--persist-to", default=None, help="Répertoire D1 local (--local uniquement).")
    ap.add_argument("--allow-witness-drift", action="store_true",
                    help="Tolère une évolution des comptes témoins au-dessus du plancher.")
    args = ap.parse_args(argv)
    ok = verify(make_client(args.target, persist_to=args.persist_to),
                allow_witness_drift=args.allow_witness_drift)
    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(main())
