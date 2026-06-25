#!/usr/bin/env python3
"""Tests for --check-stale flag."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from build import check_stale_artifacts, current_commit_id


class TestCheckStaleArtifacts(unittest.TestCase):
    def test_no_diagnostic_dir(self):
        """Should pass when no diagnostic directory exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            import build
            old_dir = build.DIAGNOSTIC_DIR
            build.DIAGNOSTIC_DIR = Path(tmpdir) / "nonexistent"
            try:
                is_clean, msg = check_stale_artifacts()
                self.assertTrue(is_clean)
                self.assertIn("No diagnostic directory", msg)
            finally:
                build.DIAGNOSTIC_DIR = old_dir
    
    def test_no_stale_artifacts(self):
        """Should pass when only current commit artifacts exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            import build
            old_dir = build.DIAGNOSTIC_DIR
            build.DIAGNOSTIC_DIR = Path(tmpdir)
            commit_id = current_commit_id()
            (build.DIAGNOSTIC_DIR / f"build-{commit_id}.json").write_text("{}")
            try:
                is_clean, msg = check_stale_artifacts()
                self.assertTrue(is_clean)
                self.assertIn("No stale", msg)
            finally:
                build.DIAGNOSTIC_DIR = old_dir
    
    def test_stale_artifacts_detected(self):
        """Should fail when stale artifacts exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            import build
            old_dir = build.DIAGNOSTIC_DIR
            build.DIAGNOSTIC_DIR = Path(tmpdir)
            (build.DIAGNOSTIC_DIR / "build-oldcommit123.json").write_text("{}")
            try:
                is_clean, msg = check_stale_artifacts()
                self.assertFalse(is_clean)
                self.assertIn("stale", msg.lower())
            finally:
                build.DIAGNOSTIC_DIR = old_dir
    
    def test_max_stale_bytes_threshold(self):
        """Should pass when stale bytes within threshold."""
        with tempfile.TemporaryDirectory() as tmpdir:
            import build
            old_dir = build.DIAGNOSTIC_DIR
            build.DIAGNOSTIC_DIR = Path(tmpdir)
            (build.DIAGNOSTIC_DIR / "build-oldcommit123.json").write_text("x" * 100)
            try:
                is_clean, msg = check_stale_artifacts(max_stale_bytes=200)
                self.assertTrue(is_clean)
                self.assertIn("within threshold", msg)
            finally:
                build.DIAGNOSTIC_DIR = old_dir


if __name__ == "__main__":
    unittest.main()
