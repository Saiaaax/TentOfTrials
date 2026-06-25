#!/usr/bin/env python3
"""build.py - adds --check-stale and --max-stale-bytes CI gating flags."""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIAGNOSTIC_DIR = ROOT / "diagnostic"
DIAGNOSTIC_CHUNK_SIZE = 40 * 1024 * 1024


def current_commit_id() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=5,
        )
        commit = result.stdout.strip()
        if result.returncode == 0 and len(commit) >= 8:
            return commit[:8]
    except Exception:
        pass
    return "00000000"


def diagnostic_paths_for_commit() -> tuple[Path, Path, str]:
    DIAGNOSTIC_DIR.mkdir(parents=True, exist_ok=True)
    commit_id = current_commit_id()
    logd_path = DIAGNOSTIC_DIR / f"build-{commit_id}.logd"
    metadata_path = DIAGNOSTIC_DIR / f"build-{commit_id}-metadata.json"
    return logd_path, metadata_path, commit_id


def get_stale_artifacts(diagnostic_dir: Path, current_commit: str) -> list[tuple[Path, int]]:
    """Return list of (path, size_bytes) for artifacts not matching current commit."""
    if not diagnostic_dir.exists():
        return []
    stale = []
    for f in diagnostic_dir.iterdir():
        if f.is_file() and current_commit not in f.name:
            stale.append((f, f.stat().st_size))
    return stale


def check_stale_artifacts(diagnostic_dir: Path, max_stale_bytes: int = 0) -> int:
    """CI gate: exits 1 if stale artifacts exceed threshold, 0 otherwise.

    This flag is READ-ONLY. It never deletes artifacts.

    Args:
        diagnostic_dir: Directory containing diagnostic artifacts.
        max_stale_bytes: Maximum allowed stale bytes (0 = any stale is an error).

    Returns:
        0 if clean, 1 if stale artifacts exceed threshold.
    """
    commit_id = current_commit_id()
    stale = get_stale_artifacts(diagnostic_dir, commit_id)

    if not stale:
        print("[check-stale] OK: No stale artifacts found.")
        return 0

    total_bytes = sum(size for _, size in stale)

    print(f"[check-stale] Found {len(stale)} stale artifact(s) ({total_bytes:,} bytes):")
    for path, size in stale:
        print(f"  {path.name} ({size:,} bytes)")

    if total_bytes > max_stale_bytes:
        threshold_msg = "0 (any stale is an error)" if max_stale_bytes == 0 else f"{max_stale_bytes:,}"
        print(f"[check-stale] FAIL: {total_bytes:,} stale bytes exceeds threshold of {threshold_msg} bytes.")
        return 1

    print(f"[check-stale] OK: {total_bytes:,} stale bytes within threshold of {max_stale_bytes:,} bytes.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and diagnostic tool")
    parser.add_argument("--retention-report", action="store_true",
                        help="Report stale artifacts without failing")
    parser.add_argument("--check-stale", action="store_true",
                        help="CI gate: exit 1 if stale artifacts exceed threshold (read-only)")
    parser.add_argument("--max-stale-bytes", type=int, default=0,
                        help="Max allowed stale bytes for --check-stale (default: 0 = any stale is error)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _, _, commit_id = diagnostic_paths_for_commit()

    if args.check_stale:
        return check_stale_artifacts(DIAGNOSTIC_DIR, args.max_stale_bytes)

    if args.retention_report:
        stale = get_stale_artifacts(DIAGNOSTIC_DIR, commit_id)
        if not stale:
            print("[retention-report] No stale artifacts.")
        else:
            total = sum(s for _, s in stale)
            print(f"[retention-report] {len(stale)} stale artifact(s), {total:,} bytes total:")
            for path, size in stale:
                print(f"  {path.name} ({size:,} bytes)")
        return 0

    print(f"Build complete. Commit: {commit_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
