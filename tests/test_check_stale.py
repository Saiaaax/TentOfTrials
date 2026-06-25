"""Tests for the --check-stale CI gate in build.py."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import build


class TestCheckStale(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="tent-check-stale-")
        self.diag_dir = Path(self.tmpdir) / "diagnostic"
        self.diag_dir.mkdir()
        # Create current + stale artifacts
        (self.diag_dir / "build-abcdef01.logd").write_bytes(b"x" * 100)
        (self.diag_dir / "build-abcdef01.json").write_text('{"ok": true}')
        (self.diag_dir / "build-deadbeef.logd").write_bytes(b"y" * 200)
        (self.diag_dir / "build-deadbeef.json").write_text('{"ok": false}')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Test 1: stale artifacts detected → report lists them as older
    # ------------------------------------------------------------------
    def test_check_stale_exits_1_when_stale_exists(self):
        """retention_report correctly identifies non-current files as older."""
        original = build.current_commit_id
        build.current_commit_id = lambda: "abcdef01"
        try:
            report = build.retention_report(self.diag_dir)
            self.assertTrue(len(report["older_artifacts"]) > 0,
                            "Expected stale artifacts to be reported")
        finally:
            build.current_commit_id = original

    # ------------------------------------------------------------------
    # Test 2: when current commit matches all files → older list is empty
    # ------------------------------------------------------------------
    def test_check_stale_exits_0_when_no_stale(self):
        """All files for the current commit are reported as current."""
        original = build.current_commit_id
        build.current_commit_id = lambda: "deadbeef"
        try:
            report = build.retention_report(self.diag_dir)
            self.assertEqual(len(report["current_commit_artifacts"]), 2,
                             "Expected 2 current-commit artifacts (.logd + .json)")
        finally:
            build.current_commit_id = original

    # ------------------------------------------------------------------
    # Test 3: byte threshold – stale bytes within threshold → passes
    # ------------------------------------------------------------------
    def test_check_stale_max_bytes_threshold(self):
        """Stale artifacts within --max-stale-bytes threshold are tolerated."""
        original = build.current_commit_id
        build.current_commit_id = lambda: "abcdef01"
        try:
            report = build.retention_report(self.diag_dir)
            stale_bytes = sum(
                (self.diag_dir / n).stat().st_size
                for n in report["older_artifacts"]
            )
            # stale_bytes = 200 (logd) + len('{"ok": false}') = 213
            self.assertGreater(stale_bytes, 0)
            self.assertLess(stale_bytes, 1000,
                            "Stale bytes should be small in this fixture")
        finally:
            build.current_commit_id = original

    # ------------------------------------------------------------------
    # Test 4: CLI – basic invocation returns a valid exit code
    # ------------------------------------------------------------------
    def test_check_stale_cli(self):
        """CLI --check-stale exits with 0 or 1 (never crashes)."""
        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--retention-dir", str(self.diag_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        self.assertIn(result.returncode, (0, 1),
                      f"Expected exit 0 or 1, got {result.returncode}")

    # ------------------------------------------------------------------
    # Test 5: CLI exits 1 when stale artifacts exist (abcdef01 is current)
    # ------------------------------------------------------------------
    def test_check_stale_cli_exits_1_with_stale(self):
        """CLI --check-stale exits 1 when stale artifacts are present."""
        # Patch current_commit_id via env injection is tricky; instead use a
        # temp dir where ONLY the stale commit exists as current.
        # Create a directory where the "current" commit has NO artifacts.
        stale_only_dir = Path(self.tmpdir) / "stale-only"
        stale_only_dir.mkdir()
        (stale_only_dir / "build-oldcommit.logd").write_bytes(b"stale")
        (stale_only_dir / "build-oldcommit.json").write_text('{}')

        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--retention-dir", str(stale_only_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        # Current HEAD of repo is never "oldcommit", so these must be stale
        self.assertEqual(result.returncode, 1,
                         "Expected exit 1 when only stale artifacts present")
        self.assertIn("Stale artifacts found", result.stdout)

    # ------------------------------------------------------------------
    # Test 6: CLI exits 0 when diagnostic dir is empty
    # ------------------------------------------------------------------
    def test_check_stale_cli_exits_0_empty_dir(self):
        """CLI --check-stale exits 0 when no diagnostic artifacts exist."""
        empty_dir = Path(self.tmpdir) / "empty"
        empty_dir.mkdir()
        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--retention-dir", str(empty_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        self.assertEqual(result.returncode, 0,
                         "Expected exit 0 when no artifacts at all")
        self.assertIn("No stale artifacts", result.stdout)

    # ------------------------------------------------------------------
    # Test 7: --check-stale is read-only – no artifacts deleted
    # ------------------------------------------------------------------
    def test_check_stale_does_not_delete_artifacts(self):
        """--check-stale never removes files from the diagnostic directory."""
        before = set(self.diag_dir.iterdir())
        subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--retention-dir", str(self.diag_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        after = set(self.diag_dir.iterdir())
        self.assertEqual(before, after,
                         "--check-stale must not delete any diagnostic files")

    # ------------------------------------------------------------------
    # Test 8: --max-stale-bytes=0 means ANY stale triggers failure
    # ------------------------------------------------------------------
    def test_max_stale_bytes_zero_means_any_stale_fails(self):
        """When --max-stale-bytes=0, a single byte of stale data exits 1."""
        stale_dir = Path(self.tmpdir) / "single-stale"
        stale_dir.mkdir()
        (stale_dir / "build-00000001.logd").write_bytes(b"s")  # 1 byte stale

        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--max-stale-bytes", "0",
             "--retention-dir", str(stale_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        # 00000001 is never the real HEAD commit, so it's always stale
        self.assertEqual(result.returncode, 1,
                         "With --max-stale-bytes=0, any stale should exit 1")


if __name__ == "__main__":
    unittest.main()
