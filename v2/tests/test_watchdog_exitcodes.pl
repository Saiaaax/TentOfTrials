#!/usr/bin/env perl
#
# Exit-code tests for the v2 log watchdog.
#
# These tests verify the exit-code contract of the --scan mode:
#   - Clean and warning-only logs exit 0
#   - Error/critical logs exit non-zero
#   - --no-fail always exits 0
#
# Run:  perl v2/tests/test_watchdog_exitcodes.pl

use strict;
use warnings;
use v5.32;
use File::Basename;
use Cwd 'abs_path';

my $script_dir  = abs_path(dirname(__FILE__));
my $fixtures    = "$script_dir/fixtures";
my $watchdog    = abs_path("$script_dir/../scripts/log_watchdog.pl");
my $passed      = 0;
my $failed      = 0;

sub run_watchdog {
    my @args = @_;
    # Quote each argument to handle paths with spaces
    my $cmd = join(' ', map { qq("$_") } ("perl", $watchdog, @args));
    my $output = `$cmd 2>&1`;
    my $exit   = $? >> 8;
    return ($exit, $output);
}

sub assert_exit {
    my ($test_name, $expected_exit, $actual_exit, $output) = @_;
    if ($actual_exit == $expected_exit) {
        say "  ✓ $test_name: exit $actual_exit";
        $passed++;
    } else {
        say "  ✗ $test_name: expected exit $expected_exit, got $actual_exit";
        say "    output: $output" if $output;
        $failed++;
    }
}

say "Log Watchdog Exit-Code Tests";
say "=" x 40;

# ── Test 1: Clean log exits 0 ──────────────────────────────────────
{
    my ($exit, $out) = run_watchdog("--scan", "$fixtures/clean.log");
    assert_exit("clean log exits 0", 0, $exit, $out);
}

# ── Test 2: Warning-only log exits 0 ───────────────────────────────
{
    my ($exit, $out) = run_watchdog("--scan", "$fixtures/warning_only.log");
    assert_exit("warning-only log exits 0", 0, $exit, $out);
}

# ── Test 3: Error log exits non-zero ───────────────────────────────
{
    my ($exit, $out) = run_watchdog("--scan", "$fixtures/error.log");
    assert_exit("error log exits non-zero", 1, $exit, $out);
}

# ── Test 4: Error log with --no-fail exits 0 ───────────────────────
{
    my ($exit, $out) = run_watchdog("--scan", "--no-fail", "$fixtures/error.log");
    assert_exit("error log + --no-fail exits 0", 0, $exit, $out);
}

# ── Test 5: Multiple files — worst severity determines exit ────────
{
    my ($exit, $out) = run_watchdog("--scan", "$fixtures/clean.log", "$fixtures/error.log");
    assert_exit("clean + error files exit non-zero", 1, $exit, $out);
}

# ── Test 6: Multiple files — all clean exits 0 ─────────────────────
{
    my ($exit, $out) = run_watchdog("--scan", "$fixtures/clean.log", "$fixtures/warning_only.log");
    assert_exit("clean + warning files exit 0", 0, $exit, $out);
}

# ── Test 7: --no-fail with multiple files including errors exits 0 ─
{
    my ($exit, $out) = run_watchdog("--scan", "--no-fail", "$fixtures/clean.log", "$fixtures/error.log");
    assert_exit("--no-fail + mixed files exits 0", 0, $exit, $out);
}

# ── Summary ────────────────────────────────────────────────────────
say "";
say "=" x 40;
say "Results: $passed passed, $failed failed";
exit($failed > 0 ? 1 : 0);
