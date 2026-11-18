"""Orchestrateur de rafraîchissement incrémental du corpus (en deux temps).

Stage 1 (`--mode prepare`) — LECTURE SEULE sur la production :
  Télécharge les EPUB LégisQuébec et/ou actualise le clone partiel Justice Canada
  (`laws-lois-xml` épinglé par SHA exact), parse et valide chaque combinaison (loi, langue)
  sans tolérer aucune rupture structurelle, compare au contenu en base (`--compare-mcp` via
  jeton MCP lecture seule, ou D1 locale via `--target local`), valide l'ensemble sur une D1
  de recette isolée (`--verify-staging`), puis émet `refresh-plan.json` et
  `refresh-report.md`.

Stage 2 (`--mode apply`) — BASCULE INCÉMENTALE SUPERVISÉE :
  1. Rejoue le parsing sur le SHA exact validé ;
  2. Pour `--target cloud` et si des lois FR ont changé de contenu : pré-vol
     `/admin/backfill-vectors` (`mode='ping'`), capture d'un bookmark Time Travel D1 et
     amorçage préalable de `vector_state` (`mode='seed'`) si la table est vide pour ces lois ;
  3. Applique les mises à jour `metadata_only` (`laws` seulement), puis `content_changed`
     (`staging -> bascule`, `rebuild_fts=False`), puis une reconstruction FTS5 +
     `integrity-check` unique en fin de lot ;
  4. Resynchronise `discovery` (`load`, `relations`, `verify --allow-witness-drift`) ;
  5. Met à jour Vectorize de façon incrémentale et purge les vecteurs orphelins (`--prune`).
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, d1_api, ingest, load, validate
from .discovery import load as d_load
from .discovery import migrate as d_migrate
from .discovery import relations as d_relations
from .discovery import verify as d_verify
from .parser import opf_metadata, parse_epub

_SAFE_GIT_REF = re.compile(r"^[A-Za-z0-9._/-]+$")
_DEFAULT_BACKFILL_URL = "https://legislation.poirierlavoie.ca"
_DEFAULT_MCP_URL = "https://legislation.poirierlavoie.ca/mcp"


class ErreurAcquisition(RuntimeError):
    """Échec de téléchargement ou de synchronisation des sources officielles."""


class ErreurValidation(RuntimeError):
    """Échec d'un invariant structurel ou de la base de recette."""


class ErreurPrevol(RuntimeError):
    """Échec d'un contrôle préalable avant écriture en production."""


@dataclass
class ParsedCombo:
    law_id: str
    lang: str
    cfg_law: dict[str, Any]
    law: Any
    divisions: list[Any]
    articles: list[Any]
    report: validate.Report
    source_sha256: str = ""


@dataclass
class ComboDiff:
    law_id: str
    lang: str
    status: str  # "unchanged" | "metadata_only" | "content_changed"
    old_consol_date: str | None = None
    new_consol_date: str | None = None
    added_articles: list[str] = field(default_factory=list)
    removed_articles: list[str] = field(default_factory=list)
    repealed_articles: list[str] = field(default_factory=list)
    modified_articles: list[tuple[str, str | None]] = field(default_factory=list)
    added_divisions: list[str] = field(default_factory=list)
    removed_divisions: list[str] = field(default_factory=list)
    modified_divisions: list[str] = field(default_factory=list)


def _check_https_url(url: str, *, allow_local_http: bool = False) -> None:
    if url.startswith("https://"):
        return
    if allow_local_http and url.startswith(("http://127.0.0.1", "http://localhost")):
        return
    raise ValueError(f"URL refusée (schéma non autorisé) : {url}")


def _git_command() -> str:
    return shutil.which("git") or "git"


def _node_command() -> str:
    return shutil.which("node") or "node"


def resolve_secret(env_var: str, filename: str, root: Path | None = None) -> str | None:
    val = os.environ.get(env_var, "").strip()
    if val:
        return val
    p = (root or config.REPO_ROOT) / filename
    if p.exists():
        txt = p.read_text(encoding="utf-8").strip()
        if txt:
            return txt
    return None


def ensure_lims_repo(lims_repo: Path, lims_ref: str = "HEAD") -> str:
    """Initialise ou actualise le clone partiel `laws-lois-xml` et retourne le SHA exact (40 hex)."""
    if not _SAFE_GIT_REF.fullmatch(lims_ref):
        raise ValueError(f"Référence git invalide : {lims_ref!r}")
    git = _git_command()
    if not (lims_repo / ".git").exists():
        lims_repo.parent.mkdir(parents=True, exist_ok=True)
        res = subprocess.run(
            [
                git, "clone", "--filter=blob:none", "--no-checkout",
                "https://github.com/justicecanada/laws-lois-xml.git", str(lims_repo),
            ],
            capture_output=True, text=True, encoding="utf-8",
        )
        if res.returncode != 0:
            raise ErreurAcquisition(f"Échec clone laws-lois-xml : {res.stderr or res.stdout}")

    if lims_ref == "HEAD":
        f_res = subprocess.run(
            [git, "-C", str(lims_repo), "fetch", "origin", "HEAD", "--quiet"],
            capture_output=True, text=True, encoding="utf-8",
        )
        if f_res.returncode != 0:
            raise ErreurAcquisition(f"Échec fetch origin HEAD : {f_res.stderr or f_res.stdout}")
        u_res = subprocess.run(
            [git, "-C", str(lims_repo), "update-ref", "HEAD", "FETCH_HEAD"],
            capture_output=True, text=True, encoding="utf-8",
        )
        if u_res.returncode != 0:
            raise ErreurAcquisition(f"Échec update-ref HEAD : {u_res.stderr or u_res.stdout}")
    else:
        chk = subprocess.run(
            [git, "-C", str(lims_repo), "cat-file", "-e", f"{lims_ref}^{{commit}}"],
            capture_output=True, text=True, encoding="utf-8",
        )
        if chk.returncode != 0:
            f_res = subprocess.run(
                [git, "-C", str(lims_repo), "fetch", "origin", lims_ref, "--quiet"],
                capture_output=True, text=True, encoding="utf-8",
            )
            if f_res.returncode != 0:
                raise ErreurAcquisition(f"Échec fetch {lims_ref} : {f_res.stderr or f_res.stdout}")

    sha_res = subprocess.run(
        [git, "-C", str(lims_repo), "rev-parse", f"{lims_ref}^{{commit}}"],
        capture_output=True, text=True, encoding="utf-8",
    )
    if sha_res.returncode != 0:
        raise ErreurAcquisition(f"Référence LIMS introuvable ({lims_ref}) : {sha_res.stderr}")
    return sha_res.stdout.strip()


def download_with_retry(url: str, dest: Path, essais: int = 3) -> Path:
    """Télécharge un EPUB LégisQuébec avec reprise bornée et écriture atomique."""
    _check_https_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    for essai in range(essais):
        tmp_path: Path | None = None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if not data:
                raise ErreurAcquisition(f"Réponse vide depuis {url}")
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=dest.parent, prefix=f".{dest.name}.", suffix=".part", delete=False
            ) as tf:
                tf.write(data)
                tmp_path = Path(tf.name)
            tmp_path.replace(dest)
            return dest
        except Exception as exc:
            last_err = exc
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
            if essai + 1 < essais:
                time.sleep(2 * (essai + 1))
    raise ErreurAcquisition(f"Échec téléchargement {url} après {essais} essais : {last_err}")


def _phase_b_se_check(epub: Path, articles: list[Any], rep: validate.Report) -> None:
    se_ids: set[str] = set()
    with zipfile.ZipFile(epub) as zf:
        for n in zf.namelist():
            if re.search(r"page\d+\.xhtml$", n):
                se_ids |= set(
                    re.findall(r'id="(se:\d+(?:_\d+)*)"', zf.read(n).decode("utf-8", "replace"))
                )
    real = [a for a in articles if not validate.is_disposition(a.number)]
    if len(real) != len(se_ids):
        rep.ok = False
        rep.lines.append(
            f"  ✗ comptes phase B : {len(real)} articles réels vs {len(se_ids)} se: (scan)"
        )


def acquire_all(
    law_ids: list[str] | None = None,
    *,
    download: bool = False,
    samples_dir: Path | None = None,
    lims_repo: Path | None = None,
    lims_ref: str = "HEAD",
    ensure_lims: bool = False,
    allow_not_in_force: bool = False,
    dates_override: dict[str, str] | None = None,
) -> tuple[list[ParsedCombo], str | None, list[str]]:
    """Télécharge/lit, parse et valide les combinaisons demandées.

    Retourne `(combos, lims_sha, warnings)`. Toute violation structurelle lève
    `ErreurValidation` ; tout échec d'acquisition/bannière lève `ErreurAcquisition` ou
    `DateDeConsolidationIntrouvable`.
    """
    all_cfg = config.load_all_laws()
    selected_cfg = (
        [l for l in all_cfg if l["id"] in set(law_ids)]
        if law_ids is not None
        else all_cfg
    )
    if law_ids is not None:
        found = {l["id"] for l in selected_cfg}
        missing = [lid for lid in law_ids if lid not in found]
        if missing:
            raise KeyError(f"Loi(s) inconnue(s) dans laws.config.json : {', '.join(missing)}")

    sdir = samples_dir if samples_dir is not None else config.SAMPLES_DIR
    lrepo = lims_repo if lims_repo is not None else config.LIMS_REPO
    has_lims = any(l.get("source") == "lims" for l in selected_cfg)
    lims_sha: str | None = None
    if has_lims:
        if ensure_lims:
            lims_sha = ensure_lims_repo(lrepo, lims_ref)
        elif (lrepo / ".git").exists():
            res = subprocess.run(
                [_git_command(), "-C", str(lrepo), "rev-parse", f"{lims_ref}^{{commit}}"],
                capture_output=True, text=True, encoding="utf-8",
            )
            lims_sha = res.stdout.strip() if res.returncode == 0 else lims_ref
        else:
            raise ErreurAcquisition(
                f"Clone LIMS absent ({lrepo}). Exécuter avec --ensure-lims-repo."
            )

    prev_samples = config.SAMPLES_DIR
    prev_lims_repo = config.LIMS_REPO
    prev_lims_ref = config.LIMS_REF
    combos: list[ParsedCombo] = []
    warnings: list[str] = []

    try:
        config.SAMPLES_DIR = sdir
        config.LIMS_REPO = lrepo
        if lims_sha is not None:
            config.LIMS_REF = lims_sha

        for cfg_law in selected_cfg:
            law_id = cfg_law["id"]
            is_lims = cfg_law.get("source") == "lims"
            by_lang: dict[str, ParsedCombo] = {}

            for lang in ("fr", "en"):
                law = ingest._law_from_config(cfg_law)
                if is_lims:
                    date_ovr: str | None = None
                    if dates_override is not None:
                        date_ovr = dates_override.get(f"{law_id}|{lang}")
                        if not date_ovr:
                            raise ingest.DateDeConsolidationIntrouvable(
                                f"{law_id}/{lang} : date absente du cliché Stage 1 (--dates-file)."
                            )
                    divisions, articles, bilan = ingest._acquiert_lims(
                        cfg_law, law, lang, allow_not_in_force, consol_date_override=date_ovr,
                    )
                    source_sha256 = getattr(bilan, "source_sha256", "")
                    load.prepare(law, divisions, articles, id_base=ingest._id_base(law_id, lang))
                    rep = validate.validate(
                        law_id, lang, divisions, articles,
                        jurisdiction="ca",
                        numeros_refuses=bilan.numeros_refuses,
                        allow_witness_drift=True,
                    )
                else:
                    epub = sdir / f"{law_id.upper()}-{lang}.epub"
                    if download or not epub.exists():
                        download_with_retry(cfg_law["epub"][lang], epub)
                    source_sha256 = hashlib.sha256(epub.read_bytes()).hexdigest()
                    if lang == "en":
                        with zipfile.ZipFile(epub) as zf:
                            title = opf_metadata(zf)["title"]
                        if title:
                            law.name_en = title
                    if dates_override is not None:
                        date = dates_override.get(f"{law_id}|{lang}")
                    else:
                        src = cfg_law.get("consolidation_source", {}).get(lang)
                        date = ingest.fetch_consolidation(src) if src else None
                    if not date:
                        raise ingest.DateDeConsolidationIntrouvable(
                            f"{law_id}/{lang} : date « À jour au » introuvable"
                            + (" dans --dates-file" if dates_override is not None else f" sur {cfg_law.get('consolidation_source', {}).get(lang)}")
                        )
                    setattr(law, f"consol_date_{lang}", date)
                    divisions, articles = parse_epub(epub, law, lang)
                    load.prepare(law, divisions, articles, id_base=ingest._id_base(law_id, lang))
                    rep = validate.validate(
                        law_id, lang, divisions, articles, allow_witness_drift=True
                    )
                    _phase_b_se_check(epub, articles, rep)

                if not articles:
                    raise ErreurValidation(f"{law_id}/{lang} : extraction vide (0 article)")
                if not rep.ok:
                    raise ErreurValidation(
                        f"Invariants en échec pour {law_id}/{lang} :\n" + "\n".join(rep.lines)
                    )
                pc = ParsedCombo(
                    law_id=law_id, lang=lang, cfg_law=cfg_law, law=law,
                    divisions=divisions, articles=articles, report=rep,
                    source_sha256=source_sha256,
                )
                combos.append(pc)
                by_lang[lang] = pc

            # Symétrie FR/EN des numéros réels
            real_fr = {
                n
                for a in by_lang["fr"].articles
                for n in validate.numeros_effectifs(a)
                if not validate.is_disposition(n)
            }
            real_en = {
                n
                for a in by_lang["en"].articles
                for n in validate.numeros_effectifs(a)
                if not validate.is_disposition(n)
            }
            if real_fr != real_en:
                msg = (
                    f"{law_id} : asymétrie FR/EN des articles réels "
                    f"(FR\\EN={sorted(real_fr - real_en)[:5]}, EN\\FR={sorted(real_en - real_fr)[:5]})"
                )
                if law_id in ("ccq", "cpc"):
                    raise ErreurValidation(msg)
                warnings.append(msg)
    finally:
        config.SAMPLES_DIR = prev_samples
        config.LIMS_REPO = prev_lims_repo
        config.LIMS_REF = prev_lims_ref

    return combos, lims_sha, warnings


def _compute_article_deltas(
    old_by_num: dict[str, dict[str, Any]],
    new_articles: list[Any],
    *,
    compare_html: bool = True,
) -> tuple[list[str], list[str], list[str], list[tuple[str, str | None]]]:
    new_by_num = {a.number: a for a in new_articles}
    added = [a.number for a in new_articles if a.number not in old_by_num]
    removed = [num for num in old_by_num if num not in new_by_num]
    repealed: list[str] = []
    modified: list[tuple[str, str | None]] = []

    for a in new_articles:
        old = old_by_num.get(a.number)
        if old is None:
            continue
        old_rep = int(old.get("repealed") or 0)
        new_rep = int(a.repealed or 0)
        if old_rep == 0 and new_rep == 1:
            repealed.append(a.number)
        changed = (
            (old.get("division_path") or "") != (a.division_path or "")
            or (old.get("text") or "") != (a.text or "")
            or old.get("history") != a.history
            or old_rep != new_rep
            or (compare_html and (
                old.get("html") != a.html
                or int(old.get("sort_key") or 0) != int(a.sort_key or 0)
                or old.get("marginal_note") != a.marginal_note
                or old.get("footnotes") != a.footnotes
            ))
        )
        if changed:
            modified.append((a.number, a.history))
    return added, removed, repealed, modified


def _compute_division_deltas(
    old_divs: list[dict[str, Any]],
    new_divs: list[Any],
    *,
    full_columns: bool = True,
) -> tuple[list[str], list[str], list[str]]:
    old_by_path = {r["path"]: r for r in old_divs}
    new_by_path = {d.path: d for d in new_divs}
    added = [d.path for d in new_divs if d.path not in old_by_path]
    removed = [p for p in old_by_path if p not in new_by_path]
    modified: list[str] = []
    for d in new_divs:
        old = old_by_path.get(d.path)
        if old is None:
            continue
        if full_columns:
            differs = (
                old.get("kind") != d.kind
                or old.get("number") != d.number
                or old.get("heading") != d.heading
                or old.get("history") != d.history
                or int(old.get("repealed") or 0) != int(d.repealed or 0)
                or old.get("parent_path") != d.parent_path
                or int(old.get("sort_order") or 0) != int(d.sort_order or 0)
                or old.get("heading_norm") != d.heading_norm
            )
        else:
            differs = old.get("heading") != d.heading
        if differs:
            modified.append(d.path)
    return added, removed, modified


def diff_combo_d1(
    db,
    parsed: ParsedCombo,
    stored_law: dict[str, Any] | None,
    *,
    allow_shrinkage: bool = False,
) -> ComboDiff:
    """Compare exactement un couple parsé contre l'état courant en D1."""
    law_id, lang = parsed.law_id, parsed.lang
    new_date = getattr(parsed.law, f"consol_date_{lang}")
    old_date = stored_law.get(f"consol_date_{lang}") if stored_law else None

    if stored_law is None:
        return ComboDiff(
            law_id=law_id, lang=lang, status="content_changed",
            old_consol_date=None, new_consol_date=new_date,
            added_articles=[a.number for a in parsed.articles],
            added_divisions=[d.path for d in parsed.divisions],
        )

    stored_divs = db.run(
        f"SELECT d.kind, d.number, d.heading, d.history, d.path, d.repealed, "
        f"d.sort_order, d.heading_norm, p.path AS parent_path "
        f"FROM divisions d LEFT JOIN divisions p ON p.id = d.parent_id "
        f"WHERE d.law_id = {d1_api.q(law_id)} AND d.lang = {d1_api.q(lang)} "
        f"ORDER BY d.sort_order, d.id"
    )

    stored_arts: list[dict[str, Any]] = []
    offset = 0
    while True:
        chunk = db.run(
            f"SELECT number, sort_key, division_path, text, html, history, repealed, "
            f"marginal_note, footnotes FROM articles "
            f"WHERE law_id = {d1_api.q(law_id)} AND lang = {d1_api.q(lang)} "
            f"ORDER BY id LIMIT 1000 OFFSET {offset}"
        )
        if not chunk:
            break
        stored_arts.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000

    stored_aliases = db.run(
        f"SELECT an.number AS alias, a.number AS target "
        f"FROM article_numbers an JOIN articles a ON a.id = an.article_id "
        f"WHERE an.law_id = {d1_api.q(law_id)} AND an.lang = {d1_api.q(lang)} "
        f"ORDER BY an.number"
    )

    if not stored_arts:
        return ComboDiff(
            law_id=law_id, lang=lang, status="content_changed",
            old_consol_date=old_date, new_consol_date=new_date,
            added_articles=[a.number for a in parsed.articles],
            added_divisions=[d.path for d in parsed.divisions],
        )

    if len(stored_arts) >= 10 and len(parsed.articles) < len(stored_arts) * 0.5 and not allow_shrinkage:
        raise ErreurValidation(
            f"{law_id}/{lang} : chute anormale d'articles ({len(parsed.articles)} vs {len(stored_arts)} en base)"
        )

    old_art_by_num = {r["number"]: r for r in stored_arts}
    added_a, removed_a, repealed_a, mod_a = _compute_article_deltas(
        old_art_by_num, parsed.articles, compare_html=True
    )
    added_d, removed_d, mod_d = _compute_division_deltas(
        stored_divs, parsed.divisions, full_columns=True
    )

    old_div_order = [r["path"] for r in stored_divs]
    new_div_order = [d.path for d in parsed.divisions]
    old_art_order = [r["number"] for r in stored_arts]
    new_art_order = [a.number for a in parsed.articles]
    old_alias_pairs = sorted((r["alias"], r["target"]) for r in stored_aliases)
    new_alias_pairs = sorted((n, a.number) for a in parsed.articles for n in a.alias_numbers)

    content_differs = bool(
        added_a or removed_a or mod_a or added_d or removed_d or mod_d
        or old_div_order != new_div_order
        or old_art_order != new_art_order
        or old_alias_pairs != new_alias_pairs
    )
    if content_differs:
        return ComboDiff(
            law_id=law_id, lang=lang, status="content_changed",
            old_consol_date=old_date, new_consol_date=new_date,
            added_articles=added_a, removed_articles=removed_a,
            repealed_articles=repealed_a, modified_articles=mod_a,
            added_divisions=added_d, removed_divisions=removed_d,
            modified_divisions=mod_d,
        )

    excluded = load._COLS_AUTRE_LANGUE(lang)
    meta_differs = any(
        stored_law.get(col) != load._valeur(parsed.law, col)
        for col in load._LAW_COLS
        if col not in excluded
    )
    return ComboDiff(
        law_id=law_id, lang=lang,
        status="metadata_only" if meta_differs else "unchanged",
        old_consol_date=old_date, new_consol_date=new_date,
    )


class McpReadClient:
    """Client MCP JSON-RPC minimal en lecture seule (cadencé pour respecter 300 req/min)."""

    def __init__(self, url: str, token: str | None = None, pace_sec: float = 0.25):
        _check_https_url(url, allow_local_http=True)
        self.url = url
        self.token = token or resolve_secret("MCP_TOKEN", "mcp.token")
        self.pace_sec = pace_sec
        self._next_id = 1
        self._last_call = 0.0

    def _rpc(self, method: str, params: dict[str, Any], *, notification: bool = False) -> Any:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = self._next_id
            self._next_id += 1
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": config.USER_AGENT,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        data = json.dumps(payload).encode("utf-8")
        for attempt in range(5):
            elapsed = time.monotonic() - self._last_call
            if elapsed < self.pace_sec:
                time.sleep(self.pace_sec - elapsed)
            self._last_call = time.monotonic()
            req = urllib.request.Request(self.url, data=data, method="POST", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    ctype = resp.headers.get("Content-Type", "")
                    body = resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 4:
                    wait = int(e.headers.get("Retry-After", "5")) if e.headers else 5
                    time.sleep(max(1, min(wait, 60)))
                    continue
                raise ErreurAcquisition(f"MCP HTTP {e.code} sur {method}") from e
            if notification:
                return None
            if "text/event-stream" in ctype:
                lines = [ln[5:].strip() for ln in body.splitlines() if ln.startswith("data:")]
                msg = json.loads(lines[-1])
            else:
                msg = json.loads(body)
            if "error" in msg:
                raise ErreurAcquisition(f"MCP {method} : {msg['error']}")
            return msg.get("result")
        raise ErreurAcquisition(f"MCP {method} : trop de tentatives 429")

    def connect(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "legislation-refresh-client", "version": "1.0.0"},
        })
        self._rpc("notifications/initialized", {}, notification=True)

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._rpc("tools/call", {"name": name, "arguments": arguments})


def _flatten_structure(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for n in nodes:
        out.append({"path": n["path"], "heading": n.get("heading")})
        if n.get("children"):
            out.extend(_flatten_structure(n["children"]))
    return out


def diff_all_mcp(
    combos: list[ParsedCombo],
    mcp_url: str,
    *,
    deep_mcp: bool = True,
    allow_shrinkage: bool = False,
) -> list[ComboDiff]:
    """Compare les combinaisons parsées à la production via MCP lecture seule."""
    client = McpReadClient(mcp_url)
    client.connect()

    by_lang_laws: dict[str, dict[str, dict[str, Any]]] = {}
    for lang in ("fr", "en"):
        res = client.call_tool("list_laws", {"structure": False, "lang": lang})
        laws_list = (res.get("structuredContent") or {}).get("laws") or []
        by_lang_laws[lang] = {l["id"]: l for l in laws_list}

    diffs: list[ComboDiff] = []

    for c in combos:
        stored = by_lang_laws[c.lang].get(c.law_id)
        new_date = getattr(c.law, f"consol_date_{c.lang}")
        if stored is None:
            diffs.append(ComboDiff(
                law_id=c.law_id, lang=c.lang, status="content_changed",
                old_consol_date=None, new_consol_date=new_date,
                added_articles=[a.number for a in c.articles],
                added_divisions=[d.path for d in c.divisions],
            ))
            continue

        old_date = stored.get(f"consol_date_{c.lang}")
        stored_count = int(stored.get("article_count") or 0)
        if stored_count >= 10 and len(c.articles) < stored_count * 0.5 and not allow_shrinkage:
            raise ErreurValidation(
                f"{c.law_id}/{c.lang} : chute anormale d'articles "
                f"({len(c.articles)} vs {stored_count} en production)"
            )
        name_col = "name_fr" if c.lang == "fr" else "name_en"
        cite_col = "official_cite" if c.lang == "fr" else "official_cite_en"
        new_cite = load._valeur(c.law, cite_col)
        meta_differs = (
            old_date != new_date
            or (stored.get(name_col) or None) != (getattr(c.law, name_col) or None)
            or (stored.get(cite_col) or None) != (new_cite or None)
        )
        if not deep_mcp and not meta_differs and stored_count == len(c.articles):
            diffs.append(ComboDiff(
                law_id=c.law_id, lang=c.lang, status="unchanged",
                old_consol_date=old_date, new_consol_date=new_date,
            ))
            continue

        # Extraction paginée des articles & structure de la production pour diff détaillé
        stored_arts: list[dict[str, Any]] = []
        offset = 0
        while True:
            res_a = client.call_tool("get_articles", {
                "law": c.law_id, "lang": c.lang,
                "from": "préliminaire", "to": "9005",
                "limit": 200, "offset": offset,
            })
            if res_a.get("isError"):
                if stored_count == 0:
                    break
                raise ErreurAcquisition(f"MCP get_articles erreur sur {c.law_id}/{c.lang} : {res_a}")
            sc = res_a.get("structuredContent") or {}
            rows = sc.get("articles") or []
            stored_arts.extend(rows)
            total = int(sc.get("total") or 0)
            offset += len(rows)
            if not rows or offset >= total:
                break

        res_s = client.call_tool("get_structure", {"law": c.law_id, "lang": c.lang, "depth": 9})
        tree = (res_s.get("structuredContent") or {}).get("tree") or [] if not res_s.get("isError") else []
        stored_divs = _flatten_structure(tree)

        old_by_num = {r["number"]: r for r in stored_arts}
        added_a, removed_a, repealed_a, mod_a = _compute_article_deltas(
            old_by_num, c.articles, compare_html=False
        )
        added_d, removed_d, mod_d = _compute_division_deltas(
            stored_divs, c.divisions, full_columns=False
        )
        old_div_paths = [r["path"] for r in stored_divs]
        new_div_paths = [d.path for d in c.divisions]
        old_art_nums = [r["number"] for r in stored_arts]
        # `get_articles` en mode plage ouverte (« cle ») trie par `(sort_key, id)`, alors que
        # `c.articles` suit l'ordre d'émission du document (cf. `b-1.1-r.2` où 1.022 < 1.03
        # dans le document mais sort_key("1.022") > sort_key("1.03")).
        new_art_nums = [
            a.number
            for _, a in sorted(enumerate(c.articles), key=lambda p: (p[1].sort_key or 0, p[0]))
        ]

        if (
            added_a or removed_a or mod_a or added_d or removed_d or mod_d
            or old_div_paths != new_div_paths or old_art_nums != new_art_nums
        ):
            status = "content_changed"
        elif meta_differs:
            status = "metadata_only"
        else:
            status = "unchanged"

        diffs.append(ComboDiff(
            law_id=c.law_id, lang=c.lang, status=status,
            old_consol_date=old_date, new_consol_date=new_date,
            added_articles=added_a, removed_articles=removed_a,
            repealed_articles=repealed_a, modified_articles=mod_a,
            added_divisions=added_d, removed_divisions=removed_d,
            modified_divisions=mod_d,
        ))
    return diffs


def diff_all_d1(db, combos: list[ParsedCombo], *, allow_shrinkage: bool = False) -> list[ComboDiff]:
    """Compare toutes les combinaisons parsées contre la base D1 cible."""
    laws_rows = db.run("SELECT * FROM laws")
    by_id = {r["id"]: r for r in laws_rows}
    return [diff_combo_d1(db, c, by_id.get(c.law_id), allow_shrinkage=allow_shrinkage) for c in combos]


def _sync_discovery_and_relations(
    db,
    *,
    targeted_ids: set[str],
    full_corpus: bool,
    target: str,
    samples_dir: Path | None,
    relations_dirty: bool,
) -> None:
    taxonomy = json.loads((config.REPO_ROOT / "taxonomy.json").read_text(encoding="utf-8"))
    relations_cfg = json.loads((config.REPO_ROOT / "relations.json").read_text(encoding="utf-8"))
    cfg_laws = config.load_all_laws()
    cfg_by_id = {l["id"]: l for l in cfg_laws}
    db_law_ids = {r["id"] for r in db.run("SELECT id FROM laws")}
    db_has_all_laws = set(cfg_by_id).issubset(db_law_ids)

    if full_corpus:
        d_load.seed_laws(db)
        violations = d_load.validate(db, taxonomy, relations_cfg)
        if violations:
            raise ErreurValidation(
                "Validation découverte en échec :\n" + "\n".join(f"  - {v}" for v in violations)
            )
        d_load.load(db, taxonomy, relations_cfg)
        if relations_dirty:
            d_relations.build(db, samples_dir=samples_dir)
        if not d_verify.verify(db, allow_witness_drift=True):
            raise ErreurValidation("Vérification découverte en échec.")
        return

    if not targeted_ids:
        return
    known_targets = targeted_ids & set(cfg_by_id)
    if known_targets:
        d_load.seed_laws(db, only_laws=known_targets)
    violations = d_load.validate(
        db, taxonomy, relations_cfg,
        only_laws=None if db_has_all_laws else targeted_ids,
    )
    if violations:
        raise ErreurValidation(
            "Validation découverte en échec :\n" + "\n".join(f"  - {v}" for v in violations)
        )
    if db_has_all_laws:
        d_load.load(db, taxonomy, relations_cfg)
    qc_targeted = {
        lid for lid in known_targets
        if (cfg_by_id[lid].get("jurisdiction") or "qc") == "qc"
    }
    if qc_targeted and relations_dirty:
        missing = d_relations.epubs_manquants(
            [cfg_by_id[lid] for lid in sorted(qc_targeted)], samples_dir=samples_dir
        )
        if not missing:
            d_relations.build(db, samples_dir=samples_dir, only_laws=qc_targeted)
        elif target == "cloud":
            raise ErreurValidation(
                f"EPUB FR manquant(s) pour recalculer les relations de {', '.join(missing)}."
            )
    if db_has_all_laws and not d_verify.verify(db, allow_witness_drift=True):
        raise ErreurValidation("Vérification découverte en échec.")


def verify_staging_d1(
    combos: list[ParsedCombo],
    *,
    full_corpus: bool,
    samples_dir: Path | None = None,
) -> None:
    """Monte une D1 locale vierge (`schema.sql` + migrations), y charge les combos et valide."""
    npx = d1_api.npx_command()
    with tempfile.TemporaryDirectory(prefix="legislation-stg-") as tmp:
        db = d1_api.LocalD1(persist_to=tmp)
        db.run_file(config.REPO_ROOT / "schema.sql")
        d_migrate.migrate(db)

        mig_res = subprocess.run(
            [npx, "wrangler", "d1", "migrations", "apply", d1_api.DB_NAME, "--local", "--persist-to", tmp],
            cwd=config.REPO_ROOT,
            stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8",
        )
        if mig_res.returncode != 0:
            raise ErreurValidation(
                f"Échec migrations en staging : {mig_res.stderr or mig_res.stdout}"
            )

        sql_dir = Path(tmp) / "sql"
        sql_dir.mkdir(parents=True, exist_ok=True)
        for c in combos:
            p = sql_dir / f"{c.law_id}-{c.lang}.sql"
            p.write_text(
                load.to_sql(c.law, c.divisions, c.articles, c.lang, rebuild_fts=False),
                encoding="utf-8", newline="\n",
            )
            db.run_file(p)

        fts_path = sql_dir / "fts-rebuild.sql"
        fts_path.write_text(load.fts_rebuild_sql(), encoding="utf-8", newline="\n")
        db.run_file(fts_path)

        _sync_discovery_and_relations(
            db,
            targeted_ids={c.law_id for c in combos},
            full_corpus=full_corpus,
            target="local",
            samples_dir=samples_dir,
            relations_dirty=True,
        )


def _ping_backfill(base_url: str, token: str, law: str, kind: str) -> tuple[bool, int]:
    url = f"{base_url.rstrip('/')}/admin/backfill-vectors"
    _check_https_url(url, allow_local_http=True)
    body = json.dumps({"kind": kind, "law": law, "mode": "ping"}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) legislation-backfill",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise ErreurPrevol(f"Pré-vol backfill-vectors ping échoué ({law}/{kind}) : {exc}") from exc
    if not payload.get("ok"):
        raise ErreurPrevol(f"Pré-vol backfill-vectors ping refusé ({law}/{kind}) : {payload}")
    return bool(payload.get("exists", True)), int(payload.get("tracked") or 0)


def _capture_time_travel_bookmark() -> str:
    res = subprocess.run(
        [d1_api.npx_command(), "wrangler", "d1", "time-travel", "info", d1_api.DB_NAME, "--json"],
        cwd=config.REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    if res.returncode != 0:
        raise ErreurPrevol(f"Impossible de relever le bookmark Time Travel D1 : {res.stderr or res.stdout}")
    out = res.stdout.strip()
    start = out.find("{")
    data = json.loads(out[start:]) if start >= 0 else {}
    bookmark = data.get("bookmark") or (data.get("result") or {}).get("bookmark")
    if not bookmark:
        raise ErreurPrevol(f"Bookmark Time Travel absent de la sortie wrangler : {out[:300]}")
    return str(bookmark)


def _run_backfill_driver(args: list[str], *, env_extra: dict[str, str] | None = None) -> None:
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    res = subprocess.run(
        [_node_command(), str(config.REPO_ROOT / "scripts" / "backfill-vectors.mjs"), *args],
        cwd=config.REPO_ROOT, env=env,
    )
    if res.returncode != 0:
        raise RuntimeError(f"scripts/backfill-vectors.mjs a échoué (code {res.returncode}).")


def _write_sql_chunks(out_dir: Path, prefix: str, statements: list[str], budget_bytes: int = 70_000) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    buf: list[str] = []
    size = 0
    idx = 1
    for stmt in statements:
        sb = len(stmt.encode("utf-8"))
        if buf and size + sb > budget_bytes:
            p = out_dir / f"{prefix}-{idx}.sql"
            p.write_text("\n".join(buf) + "\n", encoding="utf-8", newline="\n")
            files.append(p)
            buf, size = [], 0
            idx += 1
        buf.append(stmt)
        size += sb
    if buf:
        p = out_dir / f"{prefix}-{idx}.sql"
        p.write_text("\n".join(buf) + "\n", encoding="utf-8", newline="\n")
        files.append(p)
    return files


def build_sources_manifest(combos: list[ParsedCombo]) -> dict[str, dict[str, Any]]:
    return {
        f"{c.law_id}|{c.lang}": {
            "source_sha256": c.source_sha256,
            "consol_date": getattr(c.law, f"consol_date_{c.lang}"),
            "name": getattr(c.law, "name_fr" if c.lang == "fr" else "name_en"),
            "article_count": len(c.articles),
            "division_count": len(c.divisions),
        }
        for c in combos
    }


def verify_expected_plan(
    combos: list[ParsedCombo],
    lims_sha: str | None,
    expected_plan: dict[str, Any],
) -> None:
    """Refuse toute dérive entre les sources validées au Stage 1 et celles rejouées au Stage 2."""
    if expected_plan.get("lims_sha") != lims_sha:
        raise ErreurPrevol(
            f"SHA LIMS différent du plan Stage 1 : {lims_sha!r} vs {expected_plan.get('lims_sha')!r}"
        )
    expected_sources = expected_plan.get("sources")
    if not isinstance(expected_sources, dict):
        raise ErreurPrevol("Le fichier --expected-plan ne contient pas 'sources'.")
    actual_sources = build_sources_manifest(combos)
    if set(actual_sources) != set(expected_sources):
        missing = sorted(set(expected_sources) - set(actual_sources))
        extra = sorted(set(actual_sources) - set(expected_sources))
        raise ErreurPrevol(
            f"Ensemble de combinaisons différent du plan Stage 1 (manquants={missing[:5]}, surplus={extra[:5]})."
        )
    for key, exp in expected_sources.items():
        got = actual_sources[key]
        if got != exp:
            raise ErreurPrevol(
                f"Source modifiée depuis l'approbation Stage 1 pour {key} : {got} != {exp}"
            )


def _load_pending_state(db) -> dict[str, Any] | None:
    rows = db.run("SELECT value FROM refresh_state WHERE key = 'pending_post_d1'")
    if not rows:
        return None
    raw = rows[0].get("value")
    return json.loads(raw) if raw else None


def _save_pending_state(db, state: dict[str, Any]) -> None:
    payload = json.dumps(state, ensure_ascii=False, sort_keys=True)
    db.run(
        f"INSERT INTO refresh_state (key, value, updated_at) "
        f"VALUES ('pending_post_d1', {d1_api.q(payload)}, datetime('now')) "
        f"ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    )


def _clear_pending_state(db) -> None:
    db.run("DELETE FROM refresh_state WHERE key = 'pending_post_d1'")


def apply_refresh(
    db,
    combos: list[ParsedCombo],
    diffs: list[ComboDiff],
    *,
    target: str,
    full_corpus: bool,
    out_dir: Path,
    samples_dir: Path | None = None,
    seed_untracked: bool = False,
    ping_fn=_ping_backfill,
    bookmark_fn=_capture_time_travel_bookmark,
    backfill_fn=_run_backfill_driver,
) -> dict[str, Any]:
    """Applique un plan de rafraîchissement validé sur `db` (+ Vectorize si `target == 'cloud'`)."""
    by_key = {(d.law_id, d.lang): d for d in diffs}
    meta_combos = [c for c in combos if by_key[(c.law_id, c.lang)].status == "metadata_only"]
    content_combos = [c for c in combos if by_key[(c.law_id, c.lang)].status == "content_changed"]
    pending = _load_pending_state(db)

    current_vector_laws = [c.law_id for c in meta_combos + content_combos if c.lang == "fr"]
    current_discovery_laws = [c.law_id for c in meta_combos + content_combos]
    combined_vector_laws = sorted(
        set(current_vector_laws) | set((pending or {}).get("vector_laws") or [])
    )
    combined_discovery_laws = sorted(
        set(current_discovery_laws) | set((pending or {}).get("discovery_laws") or [])
    )
    combined_full_corpus = full_corpus or bool((pending or {}).get("full_corpus"))
    combined_fts_dirty = bool(content_combos) or bool((pending or {}).get("fts_dirty"))
    combined_relations_dirty = (
        any(c.lang == "fr" and (c.cfg_law.get("jurisdiction") or "qc") == "qc" for c in content_combos)
        or bool((pending or {}).get("relations_dirty"))
    )

    if not meta_combos and not content_combos and pending is None:
        return {"applied_meta": 0, "applied_content": 0, "vector_laws": [], "bookmark": None}

    bookmark: str | None = None
    untracked_pairs: list[tuple[str, str]] = []
    full_backfill_laws: set[str] = set()
    backfill_url = os.environ.get("BACKFILL_URL") or _DEFAULT_BACKFILL_URL
    backfill_token: str | None = None

    # 1. Pré-vols AVANT toute écriture distante
    if target == "cloud":
        if combined_vector_laws:
            backfill_token = resolve_secret("BACKFILL_TOKEN", "backfill.token")
            if not backfill_token:
                raise ErreurPrevol(
                    "BACKFILL_TOKEN requis avant écriture D1 en production (--target cloud)."
                )
            for law_id in combined_vector_laws:
                for kind in ("articles", "divisions"):
                    exists, tracked = ping_fn(backfill_url, backfill_token, law_id, kind)
                    if tracked == 0:
                        if seed_untracked and exists:
                            untracked_pairs.append((law_id, kind))
                        else:
                            full_backfill_laws.add(law_id)
        bookmark = bookmark_fn()
        print(f"Bookmark Time Travel capturé : {bookmark}")

        # Amorçage préalable optionnel (désactivé par défaut pour ne jamais sauter d'index absent)
        for law_id, kind in untracked_pairs:
            print(f"Amorçage préalable vector_state ({kind}|{law_id}) …")
            backfill_fn(["--laws", law_id, "--kind", kind, "--mode", "seed"],
                        env_extra={"BACKFILL_TOKEN": backfill_token, "BACKFILL_URL": backfill_url})

    if meta_combos or content_combos:
        _save_pending_state(db, {
            "vector_laws": combined_vector_laws,
            "discovery_laws": combined_discovery_laws,
            "full_corpus": combined_full_corpus,
            "fts_dirty": combined_fts_dirty,
            "relations_dirty": combined_relations_dirty,
        })

    sql_dir = out_dir / "sql"
    sql_dir.mkdir(parents=True, exist_ok=True)

    # 2. Mises à jour de métadonnées seules
    if meta_combos:
        stmts = [load.metadata_only_sql(c.law, c.lang).strip() for c in meta_combos]
        for fpath in _write_sql_chunks(sql_dir, "metadata", stmts):
            db.run_file(fpath)

    # 3. Bascule contenu avec mise à jour FTS5 incrémentale par bascule + integrity-check final
    if content_combos:
        for c in content_combos:
            p = sql_dir / f"{c.law_id}-{c.lang}.sql"
            p.write_text(
                load.to_sql(c.law, c.divisions, c.articles, c.lang, rebuild_fts=True),
                encoding="utf-8", newline="\n",
            )
            db.run_file(p)
    if combined_fts_dirty:
        fts_check_path = sql_dir / "fts-check.sql"
        fts_check_path.write_text(load.fts_integrity_check_sql(), encoding="utf-8", newline="\n")
        try:
            db.run_file(fts_check_path)
        except d1_api.D1Error:
            fts_path = sql_dir / "fts-rebuild.sql"
            fts_path.write_text(load.fts_rebuild_sql(), encoding="utf-8", newline="\n")
            db.run_file(fts_path)

    # 4. Couche découverte + relations (corpus complet ou portée ciblée --laws)
    _sync_discovery_and_relations(
        db,
        targeted_ids=set(combined_discovery_laws),
        full_corpus=combined_full_corpus,
        target=target,
        samples_dir=samples_dir,
        relations_dirty=combined_relations_dirty,
    )

    # 5. Synchronisation Vectorize (`full` pour lois sans état suivi, `incremental` sinon) + purge
    if target == "cloud" and combined_vector_laws and backfill_token:
        full_list = sorted(full_backfill_laws)
        inc_list = [lid for lid in combined_vector_laws if lid not in full_backfill_laws]
        if full_list:
            backfill_fn(
                ["--laws", ",".join(full_list), "--mode", "full", "--prune"],
                env_extra={"BACKFILL_TOKEN": backfill_token, "BACKFILL_URL": backfill_url},
            )
        if inc_list:
            backfill_fn(
                ["--laws", ",".join(inc_list), "--mode", "incremental", "--prune"],
                env_extra={"BACKFILL_TOKEN": backfill_token, "BACKFILL_URL": backfill_url},
            )

    _clear_pending_state(db)

    return {
        "applied_meta": len(meta_combos),
        "applied_content": len(content_combos),
        "vector_laws": combined_vector_laws,
        "bookmark": bookmark,
    }


def update_laws_config_dates(combos: list[ParsedCombo]) -> bool:
    """Met à jour les dates `consolidation` des lois québécoises dans `laws.config.json` (sans réordonner)."""
    txt = config.CONFIG_PATH.read_text(encoding="utf-8")
    data = json.loads(txt)
    by_key = {(c.law_id, c.lang): c.law for c in combos}
    changed = False
    for entry in data["laws"]:
        if entry.get("source") == "lims":
            continue
        consol = entry.get("consolidation")
        if not isinstance(consol, dict):
            continue
        for lang in ("fr", "en"):
            law = by_key.get((entry["id"], lang))
            new_d = getattr(law, f"consol_date_{lang}", None) if law else None
            if new_d and consol.get(lang) != new_d:
                consol[lang] = new_d
                changed = True
    if changed:
        config.CONFIG_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
    return changed


def build_markdown_report(
    combos: list[ParsedCombo],
    diffs: list[ComboDiff],
    *,
    lims_sha: str | None,
    warnings: list[str],
    staging_verified: bool,
) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    n_content = sum(1 for d in diffs if d.status == "content_changed")
    n_meta = sum(1 for d in diffs if d.status == "metadata_only")
    n_same = sum(1 for d in diffs if d.status == "unchanged")
    vector_laws = sorted(
        {d.law_id for d in diffs if d.status in ("content_changed", "metadata_only") and d.lang == "fr"}
    )
    witness_deltas = [w for c in combos for w in c.report.witness_deltas]

    lines = [
        f"# Plan de rafraîchissement du corpus — {stamp}",
        "",
        f"- **Combinaisons vérifiées** : {len(diffs)} ({len({d.law_id for d in diffs})} lois)",
        f"- **`content_changed`** (bascule D1 + vecteurs) : **{n_content}**",
        f"- **`metadata_only`** (date `laws` seulement) : **{n_meta}**",
        f"- **`unchanged`** (aucune écriture) : **{n_same}**",
        f"- **Lois ciblées pour Vectorize FR** : **{len(vector_laws)}**"
        + (f" (`{', '.join(vector_laws[:12])}`{'…' if len(vector_laws) > 12 else ''})" if vector_laws else ""),
        f"- **SHA `laws-lois-xml` épinglé** : `{lims_sha or '—'}`",
        f"- **Staging D1 vierge validé** : {'OUI ✅' if staging_verified else 'non exécuté'}",
        "",
    ]

    if witness_deltas:
        lines += [
            "### ⚠️ Dérive des témoins figés (`pipeline/validate.py`)",
            "",
            *[f"- {w}" for w in witness_deltas],
            "",
        ]
    if warnings:
        lines += ["### Avertissements", "", *[f"- {w}" for w in warnings], ""]

    changed = [d for d in diffs if d.status != "unchanged"]
    if changed:
        lines += [
            "### Détail des changements détectés",
            "",
            "| Loi | Langue | Statut | Ancienne date | Nouvelle date | +Art. | -Art. | Abrogés | Modif. | ±Div. |",
            "|---|---|---|---|---|---:|---:|---:|---:|---:|",
        ]
        for d in changed:
            div_delta = len(d.added_divisions) + len(d.removed_divisions) + len(d.modified_divisions)
            lines.append(
                f"| {d.law_id} | {d.lang} | `{d.status}` | {d.old_consol_date or '—'} | "
                f"{d.new_consol_date or '—'} | {len(d.added_articles)} | {len(d.removed_articles)} | "
                f"{len(d.repealed_articles)} | {len(d.modified_articles)} | {div_delta} |"
            )
        lines.append("")
    else:
        lines += ["Aucune différence détectée par rapport à la cible.", ""]

    if n_content or n_meta:
        lines += [
            "---",
            "Pour appliquer cette bascule en production (Stage 2) via GitHub Actions :",
            f"- Workflow `rafraichir-corpus` (`workflow_dispatch`) -> `mode=appliquer`, `lims_ref={lims_sha or 'HEAD'}`, `confirmer=APPLIQUER`.",
            "",
        ]
    return "\n".join(lines)


def _write_github_outputs(plan: dict[str, Any]) -> None:
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        s = plan["summary"]
        has_changes = "true" if (s["content_changed"] + s["metadata_only"]) > 0 else "false"
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"has_changes={has_changes}\n")
            f.write(f"lims_sha={plan['lims_sha'] or ''}\n")
            f.write(f"content_changed_count={s['content_changed']}\n")
            f.write(f"metadata_only_count={s['metadata_only']}\n")
            f.write(f"vector_laws={','.join(s['vector_laws'])}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rafraîchissement incrémental et sécurisé du corpus.")
    ap.add_argument("--mode", default="prepare", choices=["prepare", "apply"])
    ap.add_argument("--target", default="local", choices=["local", "cloud"])
    ap.add_argument("--persist-to", default=None, help="Répertoire D1 local (--local uniquement).")
    ap.add_argument("--laws", default="", help="Sous-ensemble d'ids séparés par virgules (défaut : tout).")
    ap.add_argument("--download", action="store_true", help="Retélécharger les EPUB LégisQuébec.")
    ap.add_argument("--samples-dir", default=None, help="Répertoire des EPUB (défaut pipeline/samples/).")
    ap.add_argument("--lims-repo", default=None, help="Chemin du clone laws-lois-xml.")
    ap.add_argument("--lims-ref", default=config.LIMS_REF, help="Branche ou SHA du dépôt LIMS.")
    ap.add_argument("--ensure-lims-repo", action="store_true", help="Cloner/actualiser laws-lois-xml.")
    ap.add_argument("--compare-mcp", action="store_true", help="Comparer contre l'endpoint MCP public.")
    ap.add_argument("--mcp-url", default=os.environ.get("MCP_URL") or _DEFAULT_MCP_URL)
    ap.add_argument("--fast-mcp", action="store_true", help="Sauter le diff profond quand date et compte concordent.")
    ap.add_argument("--deep-mcp", action="store_true", help="Défaut actif : conservé par compatibilité.")
    ap.add_argument("--verify-staging", action="store_true", help="Valider dans une D1 locale vierge.")
    ap.add_argument("--write-config", action="store_true", help="Mettre à jour `consolidation` dans laws.config.json.")
    ap.add_argument("--allow-not-in-force", action="store_true")
    ap.add_argument("--allow-shrinkage", action="store_true")
    ap.add_argument("--seed-untracked", action="store_true")
    ap.add_argument("--dates-file", default=None, help="JSON des dates validées au Stage 1.")
    ap.add_argument("--expected-plan", default=None, help="Plan Stage 1 à vérifier avant bascule Stage 2.")
    ap.add_argument("--out-dir", default=str(config.REPO_ROOT / "_tmp_refresh"))
    args = ap.parse_args(argv)

    law_ids = [s.strip() for s in args.laws.split(",") if s.strip()] or None
    full_corpus = law_ids is None
    samples_dir = Path(args.samples_dir) if args.samples_dir else None
    lims_repo = Path(args.lims_repo) if args.lims_repo else None
    dates_override = (
        json.loads(Path(args.dates_file).read_text(encoding="utf-8"))
        if args.dates_file
        else None
    )
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    combos, lims_sha, warnings = acquire_all(
        law_ids,
        download=args.download,
        samples_dir=samples_dir,
        lims_repo=lims_repo,
        lims_ref=args.lims_ref,
        ensure_lims=args.ensure_lims_repo,
        allow_not_in_force=args.allow_not_in_force,
        dates_override=dates_override,
    )

    if args.expected_plan and args.mode == "apply":
        expected_plan = json.loads(Path(args.expected_plan).read_text(encoding="utf-8"))
        verify_expected_plan(combos, lims_sha, expected_plan)

    if args.compare_mcp and args.mode == "prepare":
        deep_mcp = not args.fast_mcp
        diffs = diff_all_mcp(combos, args.mcp_url, deep_mcp=deep_mcp, allow_shrinkage=args.allow_shrinkage)
    else:
        db = d1_api.make_client(args.target, persist_to=args.persist_to)
        diffs = diff_all_d1(db, combos, allow_shrinkage=args.allow_shrinkage)

    staging_verified = False
    if args.verify_staging:
        print("Vérification sur D1 locale vierge (staging) …")
        verify_staging_d1(combos, full_corpus=full_corpus, samples_dir=samples_dir)
        staging_verified = True

    if args.write_config:
        update_laws_config_dates(combos)

    vector_laws = sorted(
        {d.law_id for d in diffs if d.status in ("content_changed", "metadata_only") and d.lang == "fr"}
    )
    sources = build_sources_manifest(combos)
    consol_dates = {k: v["consol_date"] for k, v in sources.items() if v.get("consol_date")}
    plan = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "lims_sha": lims_sha,
        "full_corpus": full_corpus,
        "staging_verified": staging_verified,
        "witness_deltas": [w for c in combos for w in c.report.witness_deltas],
        "warnings": warnings,
        "sources": sources,
        "summary": {
            "total_combos": len(diffs),
            "content_changed": sum(1 for d in diffs if d.status == "content_changed"),
            "metadata_only": sum(1 for d in diffs if d.status == "metadata_only"),
            "unchanged": sum(1 for d in diffs if d.status == "unchanged"),
            "vector_laws": vector_laws,
        },
        "diffs": [dataclasses.asdict(d) for d in diffs],
    }

    report = build_markdown_report(
        combos, diffs, lims_sha=lims_sha, warnings=warnings, staging_verified=staging_verified
    )
    (out_dir / "refresh-plan.json").write_text(
        json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    (out_dir / "consolidation-dates.json").write_text(
        json.dumps(consol_dates, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8", newline="\n",
    )
    (out_dir / "refresh-report.md").write_text(report, encoding="utf-8", newline="\n")
    _write_github_outputs(plan)

    print(report)
    if args.mode == "apply":
        db = d1_api.make_client(args.target, persist_to=args.persist_to)
        res = apply_refresh(
            db, combos, diffs,
            target=args.target, full_corpus=full_corpus, out_dir=out_dir,
            samples_dir=samples_dir, seed_untracked=args.seed_untracked,
        )
        print(f"Application terminée : {res}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
