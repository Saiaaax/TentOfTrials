#!/usr/bin/env python3

import io
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

import benchmark


class BenchmarkBypassTests(unittest.TestCase):
    def test_benchmark_headers_disabled_by_default(self):
        self.assertEqual(benchmark.benchmark_headers(False), {})

    def test_benchmark_headers_enable_documented_bypass_header(self):
        self.assertEqual(
            benchmark.benchmark_headers(True),
            {benchmark.BENCHMARK_BYPASS_HEADER: "true"},
        )

    def test_worker_passes_bypass_header_to_requests(self):
        results = []
        headers = benchmark.benchmark_headers(True)

        with patch.object(benchmark, "make_request", return_value=(200, 12.0, None)) as make_request:
            benchmark.run_worker(
                "http://example.test/health",
                2,
                results,
                benchmark.threading.Event(),
                timeout=3.0,
                headers=headers,
            )

        self.assertEqual(len(results), 2)
        for call in make_request.call_args_list:
            self.assertEqual(call.kwargs["headers"], headers)
            self.assertNotIn("Authorization", call.kwargs["headers"])

    def test_warning_mentions_server_side_opt_in(self):
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            benchmark.print_bypass_rate_limit_warning()

        output = stderr.getvalue()
        self.assertIn("--bypass-rate-limit", output)
        self.assertIn(benchmark.BENCHMARK_BYPASS_HEADER, output)
        self.assertIn("target environment must explicitly allow", output)


if __name__ == "__main__":
    unittest.main()
