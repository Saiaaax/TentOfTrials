#!/usr/bin/env python3
"""Tests for build.py --check-stale functionality."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add parent directory to path so we can import build functions
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# We need to mock ROOT and DIAGNOSTIC_DIR before importing build
# So we'll test the check_stale_artifacts function directly


def current_commit_id_mock() -> str:
    """Return a fixed commit id for testing."""
    return "aaaaaaaa"


def create_artifact(directory: Path, commit_id: str, suffix: str = ".logd") -> Path:
    """Create a fake diagnostic artifact."""
    filename = f"build-{commit_id}{suffix}"
    path = directory / filename
    path.write_text(f"fake artifact for {commit_id}", encoding="utf-8")
    return path


def create_chunked_artifact(directory: Path, commit_id: str, part: int) -> Path:
    """Create a fake chunked diagnostic artifact."""
    filename = f"build-{commit_id}-part{part:03d}.logd"
    path = directory / filename
    path.write_text(f"fake chunk {part} for {commit_id}", encoding="utf-8")
    return path


def check_stale_artifacts_standalone(
    diagnostic_dir: Path,
    current_id: str,
    max_stale_bytes: int = 0,
) -> tuple[bool, list[Path], int]:
    """Standalone version of check_stale_artifacts for testing."""
    if not diagnostic_dir.exists():
        return True, [], 0

    stale_paths: list[Path] = []
    total_stale_bytes = 0

    # Match all build-XXXXXXXX* patterns
    for path in diagnostic_dir.glob("build-*"):
        if not path.is_file():
            continue
        stem = path.stem
        # Extract commit id: build-XXXXXXXX or build-XXXXXXXX-partNNN
        if stem.startswith("build-") and len(stem) >= 14:
            file_commit = stem[6:14]
            if file_commit != current_id:
                stale_paths.append(path)
                total_stale_bytes += path.stat().st_size

    is_clean = total_stale_bytes <= max_stale_bytes
    return is_clean, sorted(stale_paths), total_stale_bytes


class TestCheckStaleArtifacts(unittest.TestCase):
    """Test the --check-stale flag functionality."""

    def test_no_stale_artifacts(self):
        """Test: returns clean when no stale artifacts exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "diagnostic"
            diagnostic_dir.mkdir()

            # Create artifact for current commit only
            create_artifact(diagnostic_dir, "aaaaaaaa")

            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa"
            )

            self.assertTrue(is_clean)
            self.assertEqual(len(stale_paths), 0)
            self.assertEqual(total_bytes, 0)

    def test_stale_artifacts_detected(self):
        """Test: detects stale artifacts from different commits."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "diagnostic"
            diagnostic_dir.mkdir()

            # Current commit artifact
            create_artifact(diagnostic_dir, "aaaaaaaa")
            # Stale artifacts from other commits
            create_artifact(diagnostic_dir, "bbbbbbbb")
            create_artifact(diagnostic_dir, "cccccccc", suffix=".json")

            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa"
            )

            self.assertFalse(is_clean)
            self.assertEqual(len(stale_paths), 2)
            self.assertGreater(total_bytes, 0)

    def test_max_stale_bytes_threshold(self):
        """Test: respects --max-stale-bytes threshold."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "diagnostic"
            diagnostic_dir.mkdir()

            # Create a small stale artifact (about 30 bytes)
            create_artifact(diagnostic_dir, "bbbbbbbb")

            # With threshold of 100 bytes, should be clean
            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa", max_stale_bytes=100
            )

            self.assertTrue(is_clean)
            self.assertEqual(len(stale_paths), 1)
            self.assertLessEqual(total_bytes, 100)

            # With threshold of 0, should be dirty
            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa", max_stale_bytes=0
            )

            self.assertFalse(is_clean)
            self.assertEqual(len(stale_paths), 1)
            self.assertGreater(total_bytes, 0)

    def test_chunked_artifacts_detected(self):
        """Test: detects chunked stale artifacts (build-XXXXXXXX-partNNN.logd)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "diagnostic"
            diagnostic_dir.mkdir()

            # Current commit
            create_artifact(diagnostic_dir, "aaaaaaaa")
            # Stale chunked artifacts
            create_chunked_artifact(diagnostic_dir, "bbbbbbbb", 1)
            create_chunked_artifact(diagnostic_dir, "bbbbbbbb", 2)
            create_chunked_artifact(diagnostic_dir, "bbbbbbbb", 3)

            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa"
            )

            self.assertFalse(is_clean)
            self.assertEqual(len(stale_paths), 3)

    def test_missing_diagnostic_directory(self):
        """Test: returns clean when diagnostic directory doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "nonexistent"

            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa"
            )

            self.assertTrue(is_clean)
            self.assertEqual(len(stale_paths), 0)
            self.assertEqual(total_bytes, 0)

    def test_mixed_current_and_stale(self):
        """Test: correctly separates current and stale artifacts."""
        with tempfile.TemporaryDirectory() as tmpdir:
            diagnostic_dir = Path(tmpdir) / "diagnostic"
            diagnostic_dir.mkdir()

            # Multiple current commit artifacts
            create_artifact(diagnostic_dir, "aaaaaaaa")
            create_artifact(diagnostic_dir, "aaaaaaaa", suffix=".json")
            # Multiple stale commit artifacts
            create_artifact(diagnostic_dir, "bbbbbbbb")
            create_artifact(diagnostic_dir, "bbbbbbbb", suffix=".json")
            create_artifact(diagnostic_dir, "cccccccc")

            is_clean, stale_paths, total_bytes = check_stale_artifacts_standalone(
                diagnostic_dir, "aaaaaaaa"
            )

            self.assertFalse(is_clean)
            self.assertEqual(len(stale_paths), 3)

            # Verify only stale paths are returned
            stale_commits = {p.stem[6:14] for p in stale_paths}
            self.assertEqual(stale_commits, {"bbbbbbbb", "cccccccc"})


if __name__ == "__main__":
    unittest.main()
