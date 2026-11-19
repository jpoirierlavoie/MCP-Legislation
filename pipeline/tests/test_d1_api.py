"""Tests unitaires hors ligne pour `pipeline.d1_api` (`WranglerRemoteD1` et `make_client`)."""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from pipeline import d1_api


class TestMakeClient(unittest.TestCase):
    def test_make_client_cloud_with_token_returns_CloudD1(self) -> None:
        with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "tok"}):
            c = d1_api.make_client("cloud")
            self.assertIsInstance(c, d1_api.CloudD1)
            self.assertEqual(c._token, "tok")

        with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "  tok  "}):
            c = d1_api.make_client("cloud")
            self.assertIsInstance(c, d1_api.CloudD1)
            self.assertEqual(c._token, "tok")

    def test_make_client_cloud_unset_or_whitespace_returns_WranglerRemoteD1(self) -> None:
        for val in (None, "", "   \t\n"):
            env_patch = {} if val is None else {"CLOUDFLARE_API_TOKEN": val}
            with mock.patch.dict(os.environ, env_patch, clear=False):
                if val is None:
                    os.environ.pop("CLOUDFLARE_API_TOKEN", None)
                c = d1_api.make_client("cloud")
                self.assertIsInstance(c, d1_api.WranglerRemoteD1)
                self.assertEqual(c.name, "cloud")

    def test_make_client_local_returns_LocalD1(self) -> None:
        c = d1_api.make_client("local", persist_to="tmp/d1")
        self.assertIsInstance(c, d1_api.LocalD1)
        self.assertEqual(c.name, "local")
        self.assertEqual(c.persist_to, "tmp/d1")


class TestWranglerRemoteD1(unittest.TestCase):
    def test_wrangler_remote_run_uses_command_json_y_and_strips_api_token_from_env(self) -> None:
        client = d1_api.WranglerRemoteD1()
        payload = '[{"results": [{"id": 1}], "success": true}, {"results": [{"n": 110}], "success": true}]'
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(cmd, 0, stdout=payload, stderr="")

        with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "   "}), mock.patch(
            "pipeline.d1_api.subprocess.run", side_effect=fake_run
        ):
            rows = client.run("SELECT COUNT(*) AS n FROM laws;")

        self.assertEqual(rows, [{"n": 110}])
        cmd = captured["cmd"]
        kwargs = captured["kwargs"]
        self.assertNotEqual(kwargs.get("shell"), True)
        self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)
        self.assertIn("--remote", cmd)
        self.assertIn("--command=SELECT COUNT(*) AS n FROM laws;", cmd)
        self.assertIn("--json", cmd)
        self.assertIn("-y", cmd)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", kwargs["env"])
        self.assertEqual(kwargs["env"]["CLOUDFLARE_ACCOUNT_ID"], client._account_id)

    def test_wrangler_remote_run_tolerates_leading_warning_brackets_and_leading_comment(self) -> None:
        client = d1_api.WranglerRemoteD1()
        stdout = '▲ [WARNING] something [extra]\n[\n  {"results": [{"n": 110}], "success": true}\n]\n'
        sql = "-- leading comment\nSELECT 110 AS n;"
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        with mock.patch("pipeline.d1_api.subprocess.run", side_effect=fake_run):
            rows = client.run(sql)

        self.assertEqual(rows, [{"n": 110}])
        self.assertIn(f"--command={sql}", captured["cmd"])

    def test_wrangler_remote_run_raises_D1Error_on_nonzero_exit_or_json_error(self) -> None:
        client = d1_api.WranglerRemoteD1()

        with mock.patch(
            "pipeline.d1_api.subprocess.run",
            return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="boom stderr"),
        ):
            with self.assertRaises(d1_api.D1Error) as ctx:
                client.run("SELECT 1;")
            self.assertIn("boom stderr", str(ctx.exception))

        with mock.patch(
            "pipeline.d1_api.subprocess.run",
            return_value=subprocess.CompletedProcess(
                [], 1, stdout='\n{\n  "error": {\n    "text": "SQLITE_ERROR"\n  }\n}\n', stderr=""
            ),
        ):
            with self.assertRaises(d1_api.D1Error) as ctx:
                client.run("SELECT * FROM missing;")
            self.assertIn("SQLITE_ERROR", str(ctx.exception))

        with mock.patch(
            "pipeline.d1_api.subprocess.run",
            return_value=subprocess.CompletedProcess([], 0, stdout='[{"success": false, "error": "bad"}]', stderr=""),
        ):
            with self.assertRaises(d1_api.D1Error):
                client.run("SELECT 1;")

    def test_wrangler_remote_run_oversized_write_routes_via_run_file_utf8_lf(self) -> None:
        client = d1_api.WranglerRemoteD1()
        big_insert = "INSERT INTO t VALUES ('" + ("é" * 24_500) + "');"
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            file_arg = next(a for a in cmd if a.startswith("--file="))
            p = Path(file_arg.split("=", 1)[1])
            captured["tmp_path"] = p
            captured["exists_during_call"] = p.is_file()
            captured["file_bytes"] = p.read_bytes()
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch("pipeline.d1_api.subprocess.run", side_effect=fake_run):
            rows = client.run(big_insert)

        self.assertEqual(rows, [])
        self.assertTrue(captured["exists_during_call"])
        self.assertFalse(captured["tmp_path"].exists())
        self.assertEqual(captured["file_bytes"].decode("utf-8"), big_insert)
        self.assertNotIn(b"\r\n", captured["file_bytes"])
        self.assertTrue(any(a.startswith("--file=") for a in captured["cmd"]))
        self.assertNotIn("--command=", "".join(captured["cmd"]))
        self.assertIn("-y", captured["cmd"])

        big_select = "SELECT '" + ("x" * 28_500) + "';"
        with self.assertRaises(d1_api.D1Error):
            client.run(big_select)

    def test_wrangler_remote_run_file_uses_remote_file_and_y(self) -> None:
        client = d1_api.WranglerRemoteD1()
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch("pipeline.d1_api.subprocess.run", side_effect=fake_run):
            client.run_file(Path("x.sql"))

        self.assertIn("--remote", captured["cmd"])
        self.assertIn(f"--file={Path('x.sql')}", captured["cmd"])
        self.assertIn("-y", captured["cmd"])
        self.assertEqual(captured["kwargs"].get("stdin"), subprocess.DEVNULL)

        with mock.patch(
            "pipeline.d1_api.subprocess.run",
            return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="file fail"),
        ):
            with self.assertRaises(d1_api.D1Error) as ctx:
                client.run_file(Path("x.sql"))
            self.assertIn("file fail", str(ctx.exception))

    def test_wrangler_cmd_falls_back_to_npx_when_node_or_wrangler_js_missing(self) -> None:
        with mock.patch("pipeline.d1_api.shutil.which", return_value=None):
            cmd = d1_api._wrangler_cmd()
            self.assertEqual(cmd, [d1_api.npx_command(), "wrangler"])

    def test_is_write_without_rows_edge_cases(self) -> None:
        self.assertTrue(d1_api._is_write_without_rows("INSERT INTO t VALUES (1);"))
        self.assertTrue(d1_api._is_write_without_rows("  -- comment\n/* block */\nUPDATE t SET a = 1;"))
        self.assertTrue(d1_api._is_write_without_rows("DELETE FROM t;"))
        self.assertFalse(d1_api._is_write_without_rows("INSERT INTO t VALUES (1) RETURNING id;"))
        self.assertFalse(d1_api._is_write_without_rows("SELECT * FROM laws;"))
        self.assertFalse(d1_api._is_write_without_rows("PRAGMA table_info(laws);"))


if __name__ == "__main__":
    unittest.main()
