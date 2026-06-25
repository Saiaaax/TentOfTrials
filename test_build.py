import unittest
import shutil
import tempfile
import sys
from pathlib import Path

# Add current directory to path
sys.path.append(str(Path(__file__).resolve().parent))

import build

class TestCheckStale(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory to act as DIAGNOSTIC_DIR
        self.test_dir = Path(tempfile.mkdtemp())
        self.original_diagnostic_dir = build.DIAGNOSTIC_DIR
        build.DIAGNOSTIC_DIR = self.test_dir
        
        # Override current_commit_id to return a stable value for testing
        self.original_current_commit_id = build.current_commit_id
        build.current_commit_id = lambda: "abcdef12"

    def tearDown(self):
        # Restore original settings and clean up
        build.DIAGNOSTIC_DIR = self.original_diagnostic_dir
        build.current_commit_id = self.original_current_commit_id
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_no_stale_artifacts(self):
        # Test 1: Only current commit artifacts exist
        (self.test_dir / "build-abcdef12.logd").write_text("current build log")
        (self.test_dir / "build-abcdef12.json").write_text("{}")
        
        # Non-build files should be ignored
        (self.test_dir / "random.txt").write_text("random content")
        
        stale = build.find_stale_artifacts()
        self.assertEqual(len(stale), 0)

    def test_stale_artifacts_exist(self):
        # Test 2: Stale artifacts exist (non-matching commit ID)
        (self.test_dir / "build-abcdef12.logd").write_text("current")
        stale_file = self.test_dir / "build-12345678.logd"
        stale_file.write_text("stale content")
        
        stale = build.find_stale_artifacts()
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0][0], stale_file)

    def test_stale_exceeds_threshold(self):
        # Test 3: Stale artifacts size calculation
        (self.test_dir / "build-11111111.logd").write_text("stale1_data")
        (self.test_dir / "build-22222222.json").write_text("stale2_data")
        
        stale = build.find_stale_artifacts()
        total_size = sum(size for _, size in stale)
        self.assertEqual(len(stale), 2)
        self.assertEqual(total_size, len("stale1_data") + len("stale2_data"))

    def test_stale_within_threshold(self):
        # Test 4: Stale artifact exists with a specific size
        stale_content = "12345" # 5 bytes
        (self.test_dir / "build-12345678.logd").write_text(stale_content)
        
        stale = build.find_stale_artifacts()
        total_size = sum(size for _, size in stale)
        self.assertEqual(len(stale), 1)
        self.assertEqual(total_size, len(stale_content))

if __name__ == '__main__':
    unittest.main()
