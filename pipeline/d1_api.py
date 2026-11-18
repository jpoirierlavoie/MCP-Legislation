"""Client D1 minimal, deux dorsales interchangeables :

* CloudD1 — API HTTP D1 (plan §2 : « API HTTP D1 ») : POST .../d1/database/{id}/query.
* LocalD1 — D1 local de dev via `wrangler d1 execute --local` (validation sans réseau).

Les deux exposent `run(sql) -> list[dict]` (résultats de la DERNIÈRE instruction) et
`run_file(sql_path)` (exécution d'un fichier `.sql` complet via `wrangler d1 execute`).
Le SQL de `run()` est inline (littéraux échappés via `q`) pour passer indifféremment par le
corps JSON HTTP ou un fichier `.sql`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from . import config

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "6276df02799535c0e96225fdf6184023"
DB_NAME = "legislation"


class D1Error(Exception):
    pass


def npx_command() -> str:
    """Résout l'exécutable npx sans passer par `shell=True`."""
    return shutil.which("npx") or ("npx.cmd" if os.name == "nt" else "npx")


def q(v) -> str:
    """Littéral SQL sûr (None -> NULL, int tel quel, str échappée)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _database_id() -> str:
    txt = (config.REPO_ROOT / "wrangler.jsonc").read_text(encoding="utf-8")
    m = re.search(r'"database_id"\s*:\s*"([^"]+)"', txt)
    if not m:
        raise D1Error("database_id introuvable dans wrangler.jsonc")
    return m.group(1)


class CloudD1:
    name = "cloud"

    def __init__(self, token: str):
        acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or ACCOUNT_ID
        self._account_id = acct
        self._url = (
            f"https://api.cloudflare.com/client/v4/accounts/{acct}"
            f"/d1/database/{_database_id()}/query"
        )
        if not self._url.startswith("https://"):
            raise D1Error(f"Schéma URL D1 non autorisé : {self._url}")
        self._token = token

    def run(self, sql: str) -> list[dict]:
        body = json.dumps({"sql": sql}).encode("utf-8")
        req = urllib.request.Request(
            self._url, data=body, method="POST",
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        d = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8"))
        if not d.get("success"):
            raise D1Error(json.dumps(d.get("errors"), ensure_ascii=False))
        results = d.get("result") or []
        return results[-1].get("results", []) if results else []

    def run_file(self, sql_path: Path) -> None:
        env = dict(os.environ)
        env["CLOUDFLARE_API_TOKEN"] = self._token
        env["CLOUDFLARE_ACCOUNT_ID"] = self._account_id
        cmd = [npx_command(), "wrangler", "d1", "execute", DB_NAME, "--remote", f"--file={sql_path}", "-y"]
        p = subprocess.run(cmd, cwd=config.REPO_ROOT, env=env, capture_output=True, text=True, encoding="utf-8")
        if p.returncode != 0:
            raise D1Error(p.stderr or p.stdout)


class LocalD1:
    name = "local"

    def __init__(self, persist_to: str | Path | None = None):
        p = persist_to if persist_to is not None else os.environ.get("D1_PERSIST_TO")
        self.persist_to = str(p) if p else None

    def _persist_args(self) -> list[str]:
        return ["--persist-to", self.persist_to] if self.persist_to else []

    def run(self, sql: str) -> list[dict]:
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", suffix=".sql", delete=False
            ) as tf:
                tf.write(sql)
                tmp_path = Path(tf.name)
            cmd = [
                npx_command(), "wrangler", "d1", "execute", DB_NAME, "--local",
                *self._persist_args(), f"--file={tmp_path}", "--json",
            ]
            p = subprocess.run(cmd, cwd=config.REPO_ROOT, capture_output=True, text=True, encoding="utf-8")
            if p.returncode != 0:
                raise D1Error(p.stderr or p.stdout)
            out = p.stdout.strip()
            start = out.find("[")  # --json peut être précédé d'un avertissement
            data = json.loads(out[start:]) if start >= 0 else []
            return data[-1].get("results", []) if data else []
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

    def run_file(self, sql_path: Path) -> None:
        cmd = [
            npx_command(), "wrangler", "d1", "execute", DB_NAME, "--local",
            *self._persist_args(), f"--file={sql_path}", "-y",
        ]
        p = subprocess.run(cmd, cwd=config.REPO_ROOT, capture_output=True, text=True, encoding="utf-8")
        if p.returncode != 0:
            raise D1Error(p.stderr or p.stdout)


def make_client(target: str, persist_to: str | Path | None = None):
    if target == "cloud":
        token = os.environ.get("CLOUDFLARE_API_TOKEN")
        if not token:
            raise D1Error("CLOUDFLARE_API_TOKEN manquant pour --target cloud")
        return CloudD1(token)
    return LocalD1(persist_to=persist_to)
