#!/usr/bin/env python3
"""
Test script for cross-platform health check fallbacks.

Simulates missing /proc files on non-Linux platforms and verifies
that the fallback behavior produces meaningful results.

Usage:
    python3 tools/test_health_check_fallbacks.py
"""
import os
import sys
import unittest
from unittest.mock import patch, mock_open

# Add parent dir to path so we can import health_check module directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from health_check import (  # noqa: E402
    check_memory_usage,
    check_load_average,
    MEMORY_THRESHOLD_WARNING,
    MEMORY_THRESHOLD_CRITICAL,
)


class TestMemoryUsageLinux(unittest.TestCase):
    """Tests that the Linux /proc/meminfo path still works."""

    @patch("platform.system", return_value="Linux")
    @patch("builtins.open", new_callable=mock_open, read_data=(
        "MemTotal:       16384000 kB\n"
        "MemFree:         8192000 kB\n"
        "MemAvailable:    8192000 kB\n"
        "Buffers:          102400 kB\n"
        "Cached:          4096000 kB\n"
    ))
    def test_linux_returns_ok(self, mock_file, mock_platform):
        status, detail, pct = check_memory_usage()
        self.assertEqual(status, "OK")
        self.assertIn("used", detail)
        self.assertGreater(pct, 0)
        self.assertLessEqual(pct, 100)

    @patch("platform.system", return_value="Linux")
    def test_linux_missing_proc_fails_gracefully(self, mock_platform):
        """Without mocking open, /proc/meminfo doesn't exist on non-Linux -> WARNING."""
        status, detail, pct = check_memory_usage()
        # On a real Linux machine this would read /proc/meminfo
        # On non-Linux it should fall to the except and return WARNING
        self.assertIn(status, ("OK", "WARNING"))


class TestMemoryUsageNonLinux(unittest.TestCase):
    """Tests fallback behavior when /proc/meminfo is not available."""

    @patch("platform.system", return_value="Windows")
    def test_windows_uses_ctypes(self, mock_platform):
        """On Windows, the function tries ctypes.windll.kernel32.
        If ctypes isn't available (non-Windows Python), it should return WARNING."""
        status, detail, pct = check_memory_usage()
        self.assertIn(status, ("OK", "WARNING"))

    @patch("platform.system", return_value="Darwin")
    def test_macos_uses_sysctl(self, mock_platform):
        """On macOS, the function tries sysctl + vm_stat.
        If those aren't available, it should return WARNING."""
        status, detail, pct = check_memory_usage()
        self.assertIn(status, ("OK", "WARNING"))

    @patch("platform.system", return_value="UnknownOS")
    def test_unknown_os_uses_sysconf(self, mock_platform):
        """On unknown OS, the function tries os.sysconf.
        If not available, returns WARNING with explanatory message."""
        status, detail, pct = check_memory_usage()
        self.assertEqual(status, "WARNING")
        self.assertIn("Cannot check memory on UnknownOS", detail)

    @patch("platform.system", return_value="FreeBSD")
    def test_posix_fallback_via_sysconf(self, mock_platform):
        """On POSIX systems with sysconf available, should return OK."""
        status, detail, pct = check_memory_usage()
        # sysconf may or may not be available in the test environment
        self.assertIn(status, ("OK", "WARNING"))


class TestLoadAverageFallback(unittest.TestCase):
    """Tests load average with cross-platform fallback."""

    @patch("platform.system", return_value="Linux")
    @patch("builtins.open", new_callable=mock_open, read_data="1.50 0.75 0.50 1/100 5000\n")
    def test_linux_reads_proc_loadavg(self, mock_file, mock_platform):
        status, detail, load = check_load_average()
        self.assertEqual(status, "OK")
        self.assertAlmostEqual(load, 1.50, places=2)

    @patch("platform.system", return_value="Linux")
    def test_linux_missing_proc_loadavg(self, mock_platform):
        """Without mock, /proc/loadavg exists on Linux, but on Windows/macOS it falls back."""
        status, detail, load = check_load_average()
        # On a real Linux: OK, on non-Linux: WARNING or OK via os.getloadavg()
        self.assertIn(status, ("OK", "WARNING"))

    @patch("platform.system", return_value="Darwin")
    def test_macos_uses_getloadavg(self, mock_platform):
        """On macOS, os.getloadavg() should be available.
        On Windows test environment, returns WARNING if not supported."""
        status, detail, load = check_load_average()
        self.assertIn(status, ("OK", "WARNING"))

    @patch("platform.system", return_value="Windows")
    def test_windows_os_getloadavg(self, mock_platform):
        """On Windows, os.getloadavg() may not be available.
        Returns WARNING if not supported."""
        status, detail, load = check_load_average()
        # os.getloadavg() on some Windows Python builds returns (0, 0, 0)
        # or raises OSError
        self.assertIn(status, ("OK", "WARNING"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
