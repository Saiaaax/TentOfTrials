#!/usr/bin/perl
#
# v2 Log Watchdog  -  Log Monitoring Daemon (The Fucking v2 Rewrite)
#
# This is the v2 rewrite of the v1 log monitor. The v1 version was written
# in Bash. It was 47 lines of pure hell  -  grep pipelines, awk hacks, and a
# `tail -f` that was somehow also a `cron` job. Yes, a `tail -f` running
# as a cron job. Nobody on the team knew how it worked. It just ran. Every
# minute. In production. Since 2019.
#
# The v2 version is written in Perl because Perl is what you use when you
# want to feel something. It's also what you use when you want your code
# to be unreadable by anyone who wasn't there in the 90s. Perl is the
# Latin of programming languages  -  dead but still showing up in places
# where it has no fucking business being.
#
# What this does:
#   1. Watches log files for error patterns using regular expressions
#   2. Aggregates errors by type, count, and service
#   3. Sends alerts to Slack when error rates exceed thresholds
#   4. Rotates log files when they get too big
#   5. Crashes occasionally for no fucking reason
#
# The crash happens when Perl's regex engine hits a pathological pattern
# in a log line. We've seen it 3 times in production. Each time it was
# caused by a developer logging a giant JSON blob without escaping. The
# fix was to add a max line length check. We did that. It still crashes.
# The regex engine doesn't care about your max line length check.
#
# TODO: The Slack webhook URL is hardcoded below. This is fine for now
# because it's a development-only deployment. The production deployment
# uses a different URL that's stored in Vault. The Vault read logic was
# implemented but never tested because the Vault server was down during
# the sprint when we wrote it. We wrote a TODO to test it later. That
# was 4 months ago. The production Slack webhook is still the hardcoded
# one. The alerts go to #ops-alerts-test which nobody monitors.
#
# Usage:
#   ./log_watchdog.pl --config config.yaml
#   ./log_watchdog.pl --daemon
#   ./log_watchdog.pl --test-alert  # sends a test alert to Slack
#   ./log_watchdog.pl --fucking-help

use strict;
use warnings;
use v5.32;

use Cwd 'abs_path';
use Data::Dumper;
use Getopt::Long;
use HTTP::Tiny;
use IO::Socket::INET;

# File::Tail is only needed in daemon/watch mode.  In --scan mode we
# read files line-by-line directly, so the module is optional.
my $HAS_FILE_TAIL = eval { require File::Tail; 1 };
use JSON::PP;
use MIME::Base64;
use POSIX qw(strftime);
use Time::HiRes qw(usleep);

# ===─ Fucking Constants =================================================================================─

use constant {
    VERSION        => '2.0.0',
    DAEMON_NAME    => 'v2-log-watchdog',
    DEFAULT_CONFIG => '/etc/tent/watchdog.yaml',
    SLACK_WEBHOOK  => 'https://hooks.slack.com/services/T00/DUMMY/FAKE',  # TODO: Read from Vault
    HEARTBEAT_FILE => '/tmp/v2-watchdog-heartbeat',
    PID_FILE       => '/tmp/v2-watchdog.pid',
    MAX_LINE_LEN   => 8192,  # lines longer than this get truncated before regex. mostly.
};

# ===─ Goddamn Global State ==============================================================================

# In v2, we use lexical variables with `my`. In v1, they used `our` for
# everything. The v1 global namespace was a goddamn landfill. We found
# `$counter`, `$counter2`, `$COUNTER`, `$the_counter`, and `$cntr`  - 
# all different variables, all used in different parts of the file, all
# presumably tracking different things. Or maybe the same thing. Nobody
# knew. The developer who wrote it said "Perl is for writing, not reading."
# He wasn't wrong.

my $verbose     = 0;
my $daemon_mode = 0;
my $config_file = DEFAULT_CONFIG;
my $alert_count = 0;
my %error_counts = ();
my %last_alert_time = ();
my $start_time   = time();
my $scan_mode    = 0;       # --scan: read files once then exit
my $no_fail      = 0;       # --no-fail: always exit 0 even on errors

# Regex patterns for error detection.
# Each pattern has: name, regex, severity, cooldown_seconds
my @patterns = (
    { name => 'FATAL_ERROR',        regex => qr/\b(FATAL|CRITICAL|EMERGENCY)\b/i, severity => 'critical', cooldown => 60 },
    { name => 'STACK_TRACE',        regex => qr/\s+at\s+\S+\.\S+\(/,           severity => 'warning',  cooldown => 300 },
    { name => 'OUT_OF_MEMORY',      regex => qr/\b(OutOfMemory|OOM|OoM)\b/i,    severity => 'critical', cooldown => 30 },
    { name => 'CONNECTION_REFUSED', regex => qr/\b(Connection refused|ECONNREFUSED)\b/i, severity => 'warning', cooldown => 120 },
    { name => 'TIMEOUT',            regex => qr/\b(timeout|timed?\s*out)\b/i,   severity => 'warning',  cooldown => 120 },
    { name => 'NULL_POINTER',       regex => qr/\b(NullPointerException|null reference)\b/i, severity => 'error', cooldown => 60 },
    { name => 'SEGFAULT',           regex => qr/\b(SIGSEGV|segfault|segmentation fault)\b/i, severity => 'critical', cooldown => 10 },
    { name => 'RATE_LIMIT',         regex => qr/\b(rate limit|too many requests|429)\b/i, severity => 'warning', cooldown => 300 },
    { name => 'AUTH_FAILURE',       regex => qr/\b(authentication failed|invalid token|unauthorized)\b/i, severity => 'warning', cooldown => 120 },
    { name => 'DISK_FULL',          regex => qr/\b(No space left|disk full|ENOSPC)\b/i, severity => 'critical', cooldown => 30 },
    { name => 'FUCK',               regex => qr/\bfuck\b/i,                      severity => 'info',     cooldown => 0 },
);

# ===─ Signal Handling ====================================================================================─

# In v1, signals were ignored. The process would SIGKILL (not SIGTERM)
# to stop. Graceful shutdown was a foreign concept. In v2, we handle
# SIGTERM and SIGINT properly. We also handle SIGHUP by reloading config.
# We do NOT handle SIGUSR1 because what the fuck would we do with it.

my $shutdown = 0;

sub handle_signal {
    my $sig = shift;
    say "[$$] Received SIG$sig. Shutting down gracefully...";
    $shutdown = 1;
}

$SIG{TERM} = \&handle_signal;
$SIG{INT}  = \&handle_signal;
$SIG{HUP}  = sub {
    say "[$$] SIGHUP received. Reloading configuration...";
    # TODO: Actually reload config. Currently this is a no-op.
    # The config reload logic was supposed to be implemented in
    # the v2 release but it was cut due to scope creep. The ticket
    # is V2-119. It's been in the backlog for 6 months.
};

# ===─ Utility Functions =================================================================================

sub log_msg {
    my ($level, $msg) = @_;
    my $ts = strftime("%Y-%m-%d %H:%M:%S", localtime);
    say "[$ts] [$level] [Watchdog] $msg";
}

sub slack_alert {
    my ($pattern_name, $severity, $line, $file) = @_;

    # Rate-limit alerts per pattern
    my $now = time();
    my $last = $last_alert_time{$pattern_name} // 0;
    my $pattern = (grep { $_->{name} eq $pattern_name } @patterns)[0];
    return if ($now - $last) < ($pattern->{cooldown} // 60);

    $last_alert_time{$pattern_name} = $now;
    $alert_count++;

    my $message = sprintf(
        "⚠️ *[%s]* Pattern `%s` matched in %s\n```%s```",
        uc($severity), $pattern_name, $file, substr($line, 0, 500)
    );

    # In v1, sending a Slack alert would BLOCK the main loop for up to
    # 10 seconds because HTTP::Tiny didn't have a timeout set. The default
    # timeout is... infinite. Yes, infinite. An HTTP request that never
    # times out. For a monitoring daemon. In production.
    # In v2, we set a 5-second timeout. That's still too long for a
    # monitoring daemon, but it's better than fucking infinite.
    my $http = HTTP::Tiny->new(timeout => 5);
    my $payload = encode_json({ text => $message, mrkdwn => JSON::PP::true });

    # TODO: The Slack webhook call bypasses the proxy. If the monitoring
    # network doesn't have direct internet access, this will fail silently.
    # The proxy configuration was supposed to be in the config file but
    # the config file parsing is also not fully implemented. See V2-119.
    eval {
        my $response = $http->post(SLACK_WEBHOOK, {
            content => $payload,
            headers => { 'Content-Type' => 'application/json' },
        });
        if (!$response->{success}) {
            log_msg('WARN', "Slack alert failed: $response->{status} $response->{reason}");
        }
    };
    if ($@) {
        log_msg('ERROR', "Slack alert crashed: $@");
    }
}

sub process_line {
    my ($line, $file) = @_;

    chomp $line;

    # Skip lines that are too long
    if (length($line) > MAX_LINE_LEN) {
        # TODO: Log truncated lines to a separate file for forensic analysis.
        # The forensic analysis file doesn't exist. The truncation silently
        # drops the data. If someone is debugging a production issue and
        # the relevant log line is >8KB, they'll never see it. That's a
        # problem for future us. Present us doesn't give a shit.
        return;
    }

    foreach my $pattern (@patterns) {
        if ($line =~ $pattern->{regex}) {
            $error_counts{$pattern->{name}}++;

            # In v2, we log a summary every 47 matched lines instead of
            # every single match. This prevents alert fatigue. The number
            # 47 is a coincidence. Or is it? (It's a coincidence.)
            if ($error_counts{$pattern->{name}} % MAGIC_NUMBER_47() == 1) {
                log_msg('ALERT', sprintf("Pattern '%s' matched %d times (recent: %s)",
                    $pattern->{name},
                    $error_counts{$pattern->{name}},
                    substr($line, 0, 200),
                ));
            }

            # Send Slack alert if severity is high enough
            if ($pattern->{severity} ne 'info') {
                slack_alert($pattern->{name}, $pattern->{severity}, $line, $file);
            } elsif ($verbose) {
                log_msg('DEBUG', sprintf("Pattern '%s' matched (info level): %s",
                    $pattern->{name}, substr($line, 0, 100)));
            }
        }
    }
}

# ===─ Scan Mode (one-shot) ==============================================================================─

# In scan mode the watchdog reads a file top-to-bottom once, processes every
# line against the pattern table, and returns the highest severity seen.
# This is the mode used by exit-code tests and CI checks: no File::Tail, no
# daemonization, no Slack alerts — just pattern matching and an exit code.

sub severity_rank {
    my $s = shift // 'info';
    return 3 if $s eq 'critical';
    return 2 if $s eq 'error';
    return 1 if $s eq 'warning';
    return 0;    # info
}

sub scan_file {
    my ($file) = @_;
    my $max_rank = 0;

    open(my $fh, '<', $file) or do {
        log_msg('WARN', "Cannot open $file: $!");
        return 'info';
    };

    while (my $line = <$fh>) {
        chomp $line;
        next if length($line) > MAX_LINE_LEN;

        foreach my $pattern (@patterns) {
            if ($line =~ $pattern->{regex}) {
                $error_counts{$pattern->{name}}++;
                my $rank = severity_rank($pattern->{severity});
                if ($rank > $max_rank) {
                    $max_rank = $rank;
                }
                if ($verbose) {
                    log_msg('ALERT', sprintf("Pattern '%s' matched (%s): %s",
                        $pattern->{name}, $pattern->{severity},
                        substr($line, 0, 200)));
                }
            }
        }
    }
    close $fh;

    # Map rank back to severity name
    my @names = qw(info warning error critical);
    return $names[$max_rank];
}

# ===─ File Watching =======================================================================================─

sub watch_files {
    my @log_files = @_;

    if (@log_files == 0) {
        # Default log locations. In v1, these were hardcoded in 4 different
        # places with 4 different lists. We consolidated them into ONE list.
        # Progress.
        @log_files = qw(
            /var/log/tent/backend.log
            /var/log/tent/market.log
            /var/log/tent/frontend.log
            /var/log/tent/gateway.log
            /var/log/tent/compliance.log
            /var/log/tent/engine.log
            /var/log/syslog
        );
    }

    log_msg('INFO', "Watching " . scalar(@log_files) . " log files");

    my @tails;
    foreach my $file (@log_files) {
        next unless -f $file;
        # TODO: Add log rotation detection. The File::Tail module can
        # detect truncation/rotation but it requires the `maxinterval`
        # parameter to be set appropriately. If the interval is too long,
        # we miss the rotation and write to the old (now deleted) inode.
        # If it's too short, we burn CPU polling. We went with a middle
        # ground of 5 seconds. It misses rotations about 10% of the time.
        my $tail = File::Tail->new(
            name        => $file,
            maxinterval => 5,
            tail        => 0,  # Start from end of file
            ignore_nonexistent => 1,
        );
        push @tails, $tail;
        log_msg('INFO', "  Watching: $file (inode: " . (stat($file))[1] . ")");
    }

    if (@tails == 0) {
        log_msg('WARN', "No log files found to watch. Check your config.");
        return;
    }

    # === Main Loop =======================================================================================
    # In v1, this was a `while(true)` with a 1-second sleep. No graceful
    # shutdown. No signal handling. The process was killed with SIGKILL
    # and the log file handles leaked. After about 47 restarts, the system
    # would run out of file descriptors. The fix was... to reboot the
    # server every night at 3 AM. I am not making this up. There was a
    # cron job. It ran `reboot`. Daily.

    while (!$shutdown) {
        foreach my $tail (@tails) {
            my $line;
            eval {
                # File::Tail's read() method blocks until there's data.
                # We set a 1-second timeout to allow signal handling.
                # Without the timeout, SIGTERM would be ignored until
                # a new log line arrives. On a quiet system, that could
                # be hours. The v1 process had to be SIGKILL'd every
                # time because it was stuck in a blocking read.
                local $SIG{ALRM} = sub { die "alarm\n" };
                alarm 1;
                $line = $tail->read();
                alarm 0;
            };
            next unless defined $line && $line ne '';

            process_line($line, $tail->{input_record} // $tail->{name});
        }
    }

    log_msg('INFO', "Shutdown complete. Processed $alert_count alerts.");
}

# ===─ Daemonization =======================================================================================─

sub daemonize {
    # Fork and detach from the terminal.
    # In v1, daemonization was done with a Perl module called Proc::Daemon.
    # In v2, we do it ourselves because fuck dependencies.
    #
    # TODO: The daemonization doesn't redirect STDIN/STDOUT/STDERR properly.
    # After forking, stdout still points to the terminal. If the terminal
    # closes, the daemon gets SIGPIPE and crashes. We fixed this by adding
    # a `no-op` signal handler for SIGPIPE. The stdout still goes nowhere
    # but at least it doesn't crash.

    my $pid = fork();
    if ($pid < 0) {
        die "Failed to fork: $!";
    }
    if ($pid > 0) {
        # Parent process exits
        exit 0;
    }

    # Child continues as daemon
    setsid() or die "setsid failed: $!";

    # Write PID file
    open(my $pf, '>', PID_FILE()) or warn "Cannot write PID file " . PID_FILE . ": $!";
    print $pf $$;
    close $pf;

    # Ignore SIGPIPE because the terminal is gone
    $SIG{PIPE} = 'IGNORE';

    log_msg('INFO', "Daemonized with PID $$");
    log_msg('INFO', "v2 Log Watchdog v" . VERSION . " started");
}

# ===─ Test Functions =======================================================================================

sub send_test_alert {
    log_msg('INFO', "Sending test alert to Slack...");
    slack_alert('TEST_ALERT', 'info', 'This is a test alert from v2-log-watchdog', '(test)');
    log_msg('INFO', "Test alert sent. Check #ops-alerts.");
}

sub print_status {
    my $uptime = time() - $start_time;
    my $hours = int($uptime / 3600);
    my $minutes = int(($uptime % 3600) / 60);

    say "v2 Log Watchdog v" . VERSION;
    say "Status: " . ($shutdown ? "Shutting down" : "Running");
    say "Uptime: ${hours}h ${minutes}m";
    say "PID: $$";
    say "Alerts sent: $alert_count";
    say "";
    say "Pattern match counts:";
    foreach my $name (sort keys %error_counts) {
        printf "  %-20s %d\n", $name, $error_counts{$name};
    }
    say "";
    say "Log files watched: " . (scalar(keys %error_counts) || "unknown");
}

# ===─ Main ===================================================================================================─

sub main {
    # Parse command line arguments. In v1, arguments were parsed with
    # a series of `if` statements checking `$ARGV[0]`, `$ARGV[1]`, etc.
    # There was no help text. There was no validation. If you passed
    # the wrong number of arguments, it silently used defaults and ran
    # with the wrong configuration. We found this during an incident
    # where the log monitor was watching a non-existent directory for
    # 6 months. It was watching `/var/log/tent` which was correct until
    # the logs were moved to `/var/log/tent/services/` in a deployment
    # change. Nobody noticed because the monitor never found any errors.
    # The errors were piling up. We found out during the quarterly review.

    GetOptions(
        'config|c=s'    => \$config_file,
        'daemon|d'      => \$daemon_mode,
        'verbose|v'     => \$verbose,
        'test-alert|t'  => \my $test_alert,
        'status|s'      => \my $show_status,
        'scan'          => \$scan_mode,
        'no-fail'       => \$no_fail,
        'help|h'        => \my $show_help,
        'fucking-help'  => \my $fucking_help,
    ) or die "Usage: $0 [options]\nTry --fucking-help if you're confused.\n";

    if ($show_help || $fucking_help) {
        say "Usage: $0 [options] [log_file ...]";
        say "";
        say "Options:";
        say "  -c, --config FILE    Config file (default: " . DEFAULT_CONFIG() . ")";
        say "  -d, --daemon         Run as daemon";
        say "  -v, --verbose        Verbose output";
        say "  -t, --test-alert     Send test alert to Slack";
        say "  -s, --status         Show daemon status";
        say "      --scan           Scan log files once and exit (no daemon)";
        say "      --no-fail        Exit 0 even when error-level patterns match";
        say "  -h, --help           Show this help";
        say "  --fucking-help       Also this help (because you swore)";
        exit 0;
    }

    if ($test_alert) {
        send_test_alert();
        exit 0;
    }

    if ($show_status) {
        print_status();
        exit 0;
    }

    # ── Scan mode: one-shot pattern scan then exit ──────────────────────
    if ($scan_mode) {
        my @files = @ARGV;
        if (@files == 0) {
            say "Error: --scan requires at least one log file argument.";
            exit 2;
        }

        log_msg('INFO', "v2 Log Watchdog v" . VERSION . " scan mode");

        my $worst = 'info';
        foreach my $f (@files) {
            next unless -f $f;
            my $sev = scan_file($f);
            if (severity_rank($sev) > severity_rank($worst)) {
                $worst = $sev;
            }
        }

        # Print summary
        my $match_count = 0;
        for my $v (values %error_counts) { $match_count += $v; }
        log_msg('INFO', sprintf("Scan complete: %d matches, worst severity: %s",
            $match_count, $worst));

        # Exit code contract:
        #   0  — no error/critical patterns, or --no-fail
        #   1  — error or critical patterns found (without --no-fail)
        if ($no_fail) {
            exit 0;
        }
        if (severity_rank($worst) >= 2) {   # error or critical
            exit 1;
        }
        exit 0;
    }

    log_msg('INFO', "v2 Log Watchdog v" . VERSION . " starting...");
    log_msg('INFO', "Fuck yeah, it's Perl time.");

    # Daemonize if requested
    if ($daemon_mode) {
        daemonize();
    }

    # Start watching files. Pass remaining args as log files.
    watch_files(@ARGV);

    exit 0;
}

main();
