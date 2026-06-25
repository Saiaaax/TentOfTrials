"""Tests for the --check-stale and --max-stale-bytes flags."""

import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build  # noqa: E402


class TestCheckStale(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.diag = Path(self.tmp.name) / "diagnostic"
        self.diag.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_stale_returns_0(self):
        commit = build.current_commit_id()
        (self.diag / f"build-{commit}.logd").write_text("current")
        with mock.patch.object(build, "DIAGNOSTIC_DIR", self.diag):
            self.assertEqual(build.check_stale_artifacts(), 0)

    def test_stale_returns_1(self):
        (self.diag / "build-aaaaaaa1.logd").write_text("stale")
        with mock.patch.object(build, "DIAGNOSTIC_DIR", self.diag):
            self.assertEqual(build.check_stale_artifacts(), 1)

    def test_max_bytes_allows_small_stale(self):
        (self.diag / "build-aaaaaaa2.logd").write_text("small")
        with mock.patch.object(build, "DIAGNOSTIC_DIR", self.diag):
            self.assertEqual(build.check_stale_artifacts(max_bytes=1024), 0)

    def test_max_bytes_rejects_large(self):
        (self.diag / "build-aaaaaaa3.logd").write_text("x" * 2048)
        with mock.patch.object(build, "DIAGNOSTIC_DIR", self.diag):
            self.assertEqual(build.check_stale_artifacts(max_bytes=1024), 1)


if __name__ == "__main__":
    unittest.main()
