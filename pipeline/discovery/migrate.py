from __future__ import annotations

import argparse
import re

from .. import config
from ..d1_api import make_client

SCHEMA_PATH = config.REPO_ROOT / "data" / "schema-decouverte.sql"
_ALTER_ADD = re.compile(r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b", re.I)

def _statements(sql: str) -> list[str]:
    cleaned = []
    for line in sql.splitlines():
        i = line.find("--")
        cleaned.append(line if i < 0 else line[:i])
    return [s.strip() for s in "\n".join(cleaned).split(";") if s.strip()]

def _columns(db, table: str) -> set[str]:
    return {r["name"] for r in db.run(f"PRAGMA table_info({table})")}

def migrate(db) -> tuple[list[str], list[str]]:
    applied: list[str] = []
    skipped: list[str] = []
    for stmt in _statements(SCHEMA_PATH.read_text(encoding="utf-8")):
        m = _ALTER_ADD.match(stmt)
        if m:
            table, col = m.group(1), m.group(2)
            if col in _columns(db, table):
                skipped.append(f"{table}.{col}")
                continue
            db.run(stmt)
            applied.append(f"ALTER {table} ADD {col}")
        else:
            db.run(stmt)
            label = re.sub(r"\s+", " ", stmt)[:60]
            applied.append(label)
    return applied, skipped

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Migration couche de découverte.")
    ap.add_argument("--target", default="local", choices=["local", "cloud"])
    ap.add_argument("--persist-to", default=None, help="Répertoire D1 local (--local uniquement).")
    args = ap.parse_args(argv)
    db = make_client(args.target, persist_to=args.persist_to)
    applied, skipped = migrate(db)
    print(f"[{db.name}] migration : {len(applied)} instructions appliquées ; "
          f"{len(skipped)} ALTER ignorés (colonnes déjà présentes : {skipped or '—'})")
    for a in applied:
        print("  +", a)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
