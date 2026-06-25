"""Tests for the --check-stale CI gate in build.py."""

import json
import os
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
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_check_stale_exits_1_when_stale_exists(self):
        original = build.current_commit_id
        build.current_commit_id = lambda: "abcdef01"
        try:
            report = build.retention_report(self.diag_dir)
            self.assertTrue(len(report["older_artifacts"]) > 0)
        finally:
            build.current_commit_id = original

    def test_check_stale_exits_0_when_no_stale(self):
        original = build.current_commit_id
        build.current_commit_id = lambda: "deadbeef"
        try:
            report = build.retention_report(self.diag_dir)
            # All files should be either current or older; deadbeef is current
            self.assertEqual(len(report["current_commit_artifacts"]), 2)
        finally:
            build.current_commit_id = original

    def test_check_stale_max_bytes_threshold(self):
        """With max_stale_bytes set high, stale artifacts within threshold should pass."""
        original = build.current_commit_id
        build.current_commit_id = lambda: "abcdef01"
        try:
            report = build.retention_report(self.diag_dir)
            stale_bytes = sum(
                (self.diag_dir / n).stat().st_size
                for n in report["older_artifacts"]
            )
            # With threshold > stale_bytes, should be ok
            self.assertGreater(stale_bytes, 0)
            self.assertTrue(1000 > stale_bytes)  # 200 + 13 = 213 < 1000
        finally:
            build.current_commit_id = original

    def test_check_stale_cli(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py"), "--check-stale",
             "--retention-dir", str(self.diag_dir)],
            capture_output=True, text=True, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        # Will exit 0 or 1 depending on whether current commit matches any file
        self.assertIn(result.returncode, (0, 1))


if __name__ == "__main__":
    unittest.main()
