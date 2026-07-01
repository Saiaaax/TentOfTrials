import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import build  # noqa: E402


class CheckStaleDiagnosticArtifactsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.diagnostic_dir = self.root / "diagnostic"
        self.diagnostic_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_artifact(self, name: str, size: int) -> Path:
        path = self.diagnostic_dir / name
        path.write_bytes(b"x" * size)
        return path

    def run_check(self, commit_id: str = "abcdef12", max_stale_bytes: int = 0):
        with patch.object(build, "ROOT", self.root), patch.object(build, "DIAGNOSTIC_DIR", self.diagnostic_dir), patch.object(build, "current_commit_id", return_value=commit_id):
            return build.check_stale_diagnostic_artifacts(max_stale_bytes)

    def test_no_stale_artifacts_reports_success(self) -> None:
        self.write_artifact("build-abcdef12.logd", 4)
        self.write_artifact("build-abcdef12.json", 8)

        ok, stale_bytes, stale = self.run_check()

        self.assertTrue(ok)
        self.assertEqual(stale_bytes, 0)
        self.assertEqual(stale, [])

    def test_current_commit_chunks_are_not_flagged(self) -> None:
        self.write_artifact("build-abcdef12.logd", 4)
        self.write_artifact("build-abcdef12-part001.logd", 6)
        self.write_artifact("build-abcdef12-metadata.json", 10)

        ok, stale_bytes, stale = self.run_check()

        self.assertTrue(ok)
        self.assertEqual(stale_bytes, 0)
        self.assertEqual(stale, [])

    def test_stale_artifacts_fail_when_threshold_is_zero(self) -> None:
        stale_one = self.write_artifact("build-11111111.logd", 7)
        stale_two = self.write_artifact("build-22222222-metadata.json", 5)

        ok, stale_bytes, stale = self.run_check()

        self.assertFalse(ok)
        self.assertEqual(stale_bytes, stale_one.stat().st_size + stale_two.stat().st_size)
        self.assertEqual({path.name for path in stale}, {stale_one.name, stale_two.name})

    def test_max_stale_bytes_allows_small_budget(self) -> None:
        stale_one = self.write_artifact("build-33333333.logd", 7)
        stale_two = self.write_artifact("build-44444444.json", 5)

        ok, stale_bytes, stale = self.run_check(max_stale_bytes=16)

        self.assertTrue(ok)
        self.assertEqual(stale_bytes, stale_one.stat().st_size + stale_two.stat().st_size)
        self.assertEqual({path.name for path in stale}, {stale_one.name, stale_two.name})


if __name__ == "__main__":
    unittest.main()
