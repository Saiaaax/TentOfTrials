#!/usr/bin/env python3

import argparse
import datetime
import getpass
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
DIAGNOSTIC_DIR = ROOT / "diagnostic"
DIAGNOSTIC_CHUNK_SIZE = 1 * 1024 * 1024
ENCRYPTLY_BLOCKER_MESSAGE = "encryptly could not create an archive. You may have timed out; try launching it in the background and waiting for it to finish with no timeout due to a bug in encryptly."


def current_commit_id() -> str:
    """Return the first 4 bytes (8 hex chars) of HEAD for stable per-commit diagnostics."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=5,
        )
        commit = result.stdout.strip()
        if result.returncode == 0 and len(commit) >= 8:
            return commit[:8]
    except Exception:
        pass
    return "00000000"


def diagnostic_paths_for_commit() -> tuple[Path, Path, str]:
    """Return stable diagnostic artifact paths under diagnostic/ for the current commit."""
    DIAGNOSTIC_DIR.mkdir(parents=True, exist_ok=True)
    commit_id = current_commit_id()
    logd_path = DIAGNOSTIC_DIR / f"build-{commit_id}.logd"
    metadata_path = DIAGNOSTIC_DIR / f"build-{commit_id}.json"
    return logd_path, metadata_path, commit_id


def find_stale_artifacts() -> list[tuple[Path, int]]:
    """Return a list of stale artifact paths and their sizes in bytes."""
    if not DIAGNOSTIC_DIR.exists():
        return []
    
    current_id = current_commit_id()
    stale = []
    
    # Matches build-[0-9a-f]{8} at the start of filename
    for item in DIAGNOSTIC_DIR.iterdir():
        if not item.is_file():
            continue
            
        name = item.name
        match = re.match(r'^build-([0-9a-f]{8})', name)
        if match:
            commit_id = match.group(1)
            if commit_id != current_id:
                stale.append((item, item.stat().st_size))
                
    return stale


def split_diagnostic_logd(logd_path: Path, chunk_size: int = DIAGNOSTIC_CHUNK_SIZE) -> list[Path]:
    """Split an oversized .logd into numbered .logd chunks and remove the original."""
    if logd_path.stat().st_size <= chunk_size:
        return [logd_path]

    chunks: list[Path] = []
    stem = logd_path.stem
    with logd_path.open("rb") as source:
        index = 1
        while True:
            data = source.read(chunk_size)
            if not data:
                break
            chunk_path = logd_path.with_name(f"{stem}-part{index:03d}.logd")
            chunk_path.write_bytes(data)
            chunks.append(chunk_path)
            index += 1

    logd_path.unlink()
    return chunks


@dataclass
class Module:
    name: str
    language: str
    dir: Path
    build_cmd: list[str]
    clean_cmd: list[str]
    build_dir: Optional[Path] = None
    env: Optional[dict[str, str]] = None

MODULES = [
    Module(
        name="backend",
        language="Rust",
        dir=ROOT / "backend",
        build_cmd=["cargo", "build"],
        clean_cmd=["cargo", "clean"],
        build_dir=ROOT / "backend" / "target",
        env={"CARGO_TERM_COLOR": "always"},
    ),
    Module(
        name="frontend",
        language="TypeScript",
        dir=ROOT / "frontend",
        build_cmd=["npm", "run", "build"],
        clean_cmd=["rm", "-rf", "node_modules", "dist"],
        build_dir=ROOT / "frontend" / "dist",
        env={"NODE_ENV": "production"},
    ),
    Module(
        name="market",
        language="Go",
        dir=ROOT / "market",
        build_cmd=["go", "build", "-o", "market", "."],
        clean_cmd=["rm", "-f", "market"],
        build_dir=ROOT / "market" / "market",
    ),
    Module(
        name="frailbox",
        language="C",
        dir=ROOT / "frailbox",
        build_cmd=["make"],
        clean_cmd=["make", "distclean"],
        build_dir=ROOT / "frailbox" / "frailbox",
    ),
    Module(
        name="frailbox-logger",
        language="C",
        dir=ROOT / "frailbox",
        build_cmd=["make", "test-logger-shutdown"],
        clean_cmd=["make", "clean"],
        build_dir=ROOT / "frailbox" / "build" / "tests" / "test_logger_shutdown",
    ),
    Module(
        name="frailbox-connector",
        language="C",
        dir=ROOT / "frailbox",
        build_cmd=["make", "test-connector-wait-all"],
        clean_cmd=["make", "clean"],
        build_dir=ROOT / "frailbox" / "build" / "tests" / "test_connector_wait_all",
    ),
    Module(
        name="engine",
        language="C++",
        dir=ROOT / "frailbox" / "engine",
        build_cmd=["cmake", "--build", "build"],
        clean_cmd=["rm", "-rf", "build"],
        build_dir=ROOT / "frailbox" / "engine" / "build" / "trial-engine",
    ),
    Module(
        name="compliance",
        language="Java",
        dir=ROOT / "compliance",
        build_cmd=["javac", "-d", "build", "ComplianceAuditor.java"],
        clean_cmd=["rm", "-rf", "build"],
        build_dir=ROOT / "compliance" / "build",
    ),
    Module(
        name="v2-market-stream",
        language="Ruby",
        dir=ROOT / "v2" / "services",
        build_cmd=["ruby", "-c", "market_stream.rb"],
        clean_cmd=["echo", "Ruby has no build artifacts to clean"],
        build_dir=None,
    ),
    Module(
        name="nfc-scanner",
        language="Lua",
        dir=ROOT / "frailbox" / "nfc",
        build_cmd=["luac", "-p", "scanner.lua"],
        clean_cmd=["echo", "Lua has no build artifacts to clean"],
        build_dir=None,
    ),
    Module(
        name="nfc-scanner-checksums",
        language="Lua",
        dir=ROOT / "frailbox" / "nfc",
        build_cmd=[
            "sh",
            "-c",
            "luac -p scanner.lua test_scanner_checksums.lua && lua test_scanner_checksums.lua",
        ],
        clean_cmd=["echo", "Lua has no build artifacts to clean"],
        build_dir=None,
    ),
    Module(
        name="openapi-haskell",
        language="Haskell",
        dir=ROOT / "docs" / "openapi",
        build_cmd=["ghc", "-fno-code", "Types.hs", "Server.hs", "Validate.hs", "Generate.hs"],
        clean_cmd=["rm", "-f", "*.hi", "*.o", "*.hie"],
        build_dir=None,
    ),
    Module(
        name="openapi-tools",
        language="Lua",
        dir=ROOT / "tools",
        build_cmd=["luac", "-p", "openapi_diff.lua", "openapi_mock.lua", "openapi_pact.lua"],
        clean_cmd=["echo", "Nothing to clean"],
        build_dir=None,
    ),
    Module(
        name="legacy-migration",
        language="Python",
        dir=ROOT / "tools",
        build_cmd=["python3", "test_legacy_migration_dry_run.py"],
        clean_cmd=["echo", "Python has no build artifacts to clean"],
        build_dir=None,
    ),
]

ENCRYPTLY_DIR = ROOT / "tools" / "encryptly"
ENCRYPTLY_BINARIES = {
    "linux-x64": ENCRYPTLY_DIR / "linux-x64" / "encryptly",
    "linux-arm64": ENCRYPTLY_DIR / "linux-arm64" / "encryptly",
    "macos-arm64": ENCRYPTLY_DIR / "macos-arm64" / "encryptly",
    "macos-x64": ENCRYPTLY_DIR / "macos-x64" / "encryptly",
    "windows-x64": ENCRYPTLY_DIR / "windows-x64" / "encryptly.exe",
    "windows-arm64": ENCRYPTLY_DIR / "windows-arm64" / "encryptly.exe",
}
LEGACY_ENCRYPTLY_BIN = ENCRYPTLY_DIR / "encryptly"


def _normalize_arch(machine: str) -> Optional[str]:
    machine = machine.lower()
    if machine in {"x86_64", "amd64"}:
        return "x64"
    if machine in {"aarch64", "arm64"}:
        return "arm64"
    return None


def _normalize_os() -> Optional[str]:
    system = platform.system().lower()
    if system == "linux":
        return "linux"
    if system == "darwin":
        return "macos"
    if system == "windows":
        return "windows"
    return None


def detect_encryptly_platform() -> Optional[str]:
    os_name = _normalize_os()
    arch = _normalize_arch(platform.machine())
    if os_name is None or arch is None:
        return None
    return f"{os_name}-{arch}"


def get_encryptly_bin() -> Optional[Path]:
    target = detect_encryptly_platform()
    if target is not None:
        binary = ENCRYPTLY_BINARIES.get(target)
        if binary is not None and binary.exists():
            return binary

    if LEGACY_ENCRYPTLY_BIN.exists():
        return LEGACY_ENCRYPTLY_BIN

    return None


def encryptly_platform_help() -> str:
    detected = detect_encryptly_platform() or "unsupported"
    available = ", ".join(sorted(ENCRYPTLY_BINARIES))
    return f"detected {detected}; available: {available}"


def check_encryptly_runs(timeout: int = 600) -> tuple[bool, str]:
    """Verify encryptly can create a diagnostic bundle before doing any build work."""
    encryptly_bin = get_encryptly_bin()
    if encryptly_bin is None:
        return False, f"encryptly binary not found ({encryptly_platform_help()})"

    workspace = Path.home() / ".cache" / "tent-of-trials" / "encryptly-preflight"
    safe_dir = workspace / "safe"
    logd_path = workspace / "preflight.logd"
    try:
        shutil.rmtree(workspace, ignore_errors=True)
        safe_dir.mkdir(parents=True, exist_ok=True)
        (safe_dir / "preflight.txt").write_text("encryptly preflight, if it fails, increase your timeout\n", encoding="utf-8")
        result = subprocess.run(
            [
                str(encryptly_bin),
                "pack",
                str(logd_path),
                "--include",
                str(workspace),
                "--max-file-size",
                "32000",
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        # if result.returncode != 0:
        #     output = result.stderr.strip() or result.stdout.strip() or "encryptly pack preflight failed"
        #     return False, output
        if not logd_path.exists():
            return False, "encryptly preflight completed without creating a .logd"
        return True, "encryptly preflight passed"
    except subprocess.TimeoutExpired:
        return False, f"encryptly preflight TIMEOUT ({timeout}s)"
    except Exception as e:
        return False, str(e)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

class Colors:
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    RESET = "\033[0m"
    GRAY = "\033[90m"

def color(text: str, code: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"{code}{text}{Colors.RESET}"

def check_prerequisites() -> list[str]:
    required = {
        "cargo": "Rust",
        "npm": "Node.js",
        "go": "Go",
        "gcc": "C (GCC)",
        "g++": "C++ (GCC)",
        "cmake": "CMake",
        "make": "Make",
        "python3": "Python",
        "javac": "Java (JDK)",
        "ruby": "Ruby",
        "luac": "Lua",
        "ghc": "GHC (Haskell)",
    }

    missing = []
    for cmd, label in required.items():
        if shutil.which(cmd) is None:
            missing.append(f"{label} ({cmd})")

    return missing

def build_module(
    module: Module,
    release: bool = False,
    verbose: bool = False,
) -> tuple[bool, float, str]:

    print(f"\n  {color('▸', Colors.CYAN)} Building {color(module.name, Colors.BOLD)} ({module.language})...")

    env = os.environ.copy()
    if module.env:
        env.update(module.env)

    start = time.time()

    if module.name == "frontend":
        node_modules = module.dir / "node_modules"
        if not node_modules.exists():
            print(f"       {color('npm install...', Colors.GRAY)}")
            try:
                install_result = subprocess.run(
                    ["npm", "install"],
                    cwd=str(module.dir),
                    capture_output=not verbose,
                    text=True,
                    timeout=120,
                    env={k: v for k, v in env.items() if k != "NODE_ENV"},
                )
                if install_result.returncode != 0:
                    return False, time.time() - start, f"npm install failed:\n{install_result.stderr}"
            except subprocess.TimeoutExpired:
                return False, time.time() - start, "npm install TIMEOUT (120s)"

    if module.name == "engine":

        build_type = "Release" if release else "Debug"
        try:
            cfg_result = subprocess.run(
                ["cmake", "-S", ".", "-B", "build",
                 f"-DCMAKE_BUILD_TYPE={build_type}"],
                cwd=str(module.dir),
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
        except subprocess.TimeoutExpired:
            return False, time.time() - start, "CMake configure TIMEOUT (120s)"
        except FileNotFoundError as e:
            return False, 0, f"Command not found: {e}"
        if cfg_result.returncode != 0:
            output_lines = []
            if cfg_result.stdout:
                output_lines.append(cfg_result.stdout.strip())
            if cfg_result.stderr:
                output_lines.append(cfg_result.stderr.strip())
            output = "\n".join(output_lines)
            return False, time.time() - start, (
                f"CMake configure failed:\n{output}")
        if verbose:
            print(f"       {color('cmake configured', Colors.GRAY)}")
        cmd = ["cmake", "--build", "build"]
        if release:
            cmd.append("--config")
            cmd.append("Release")
    else:
        cmd = list(module.build_cmd)
        if release and module.name == "backend":
            cmd.append("--release")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(module.dir),
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return False, time.time() - start, "BUILD TIMEOUT (300s)"
    except FileNotFoundError as e:
        return False, 0, f"Command not found: {e}"

    elapsed = time.time() - start
    output_lines = []

    if result.stdout:
        output_lines.append(result.stdout.strip())
    if result.stderr:
        output_lines.append(result.stderr.strip())

    output = "\n".join(output_lines)
    success = result.returncode == 0

    return success, elapsed, output

def clean_module(module: Module, verbose: bool = False) -> bool:
    print(f"  {color('▸', Colors.YELLOW)} Cleaning {module.name}...")
    try:
        subprocess.run(
            module.clean_cmd,
            cwd=str(module.dir),
            capture_output=not verbose,
            text=True,
            timeout=60,
            env=os.environ.copy(),
        )
        return True
    except Exception as e:
        print(f"    {color('✗', Colors.RED)} Clean failed: {e}")
        return False

def verify_binary(module: Module) -> Optional[str]:
    if module.build_dir is None:
        return None
    path = module.build_dir
    if module.name == "backend":

        target = path / "debug" / module.name
        if not target.exists():
            target = path / "release" / module.name
        if target.exists():
            return str(target)
    if path.exists():
        return str(path)
    return None

def run_cmd(cmd: list[str], **kwargs) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=False, **kwargs
        )
        output = result.stdout
        if result.stderr:
            output += "\n" + result.stderr
        return result.returncode == 0, output.strip()
    except Exception as e:
        return False, str(e)


def collect_system_info() -> str:
    lines = [
        "Tent of Trials - System Diagnostic Snapshot",
        "=" * 50,
        f"generated_at: {datetime.datetime.now(datetime.timezone.utc).isoformat()}",
        f"hostname: {platform.node()}",
        f"user: {getpass.getuser()}",
        f"python: {sys.version}",
        f"platform: {platform.platform()}",
        f"processor: {platform.processor() or 'unknown'}",
        f"cpu_count: {os.cpu_count()}",
        "",
        "--- uname ---",
    ]
    ok, out = run_cmd(["uname", "-a"])
    lines.append(out if ok else "unavailable")

    lines.extend(["", "--- /etc/os-release ---"])
    try:
        lines.append((Path("/etc/os-release")).read_text(encoding="utf-8", errors="replace").strip())
    except Exception as e:
        lines.append(f"unavailable: {e}")

    lines.extend(["", "--- memory ---"])
    ok, out = run_cmd(["free", "-h"])
    lines.append(out if ok else "unavailable")

    lines.extend(["", "--- disk ---"])
    ok, out = run_cmd(["df", "-h"])
    lines.append(out if ok else "unavailable")

    lines.extend(["", "--- build environment ---"])
    for key in ["SHELL", "LANG", "TERM", "XDG_SESSION_TYPE", "DISPLAY", "EDITOR"]:
        value = os.environ.get(key)
        if value:
            lines.append(f"{key}={value}")

    lines.append("")
    return "\n".join(lines)


def build_diagnostic_report(
    results: list[tuple[str, bool, float, str, Optional[str]]],
    commit_id: str,
    logd_relpaths: Optional[list[str]] = None,
    password: Optional[str] = None,
    logd_error: Optional[str] = None,
    chunked: bool = False,
    message_blocker: Optional[str] = None,
) -> dict:
    diagnostic_logd: Optional[str | list[str]]
    if not logd_relpaths:
        diagnostic_logd = None
    elif len(logd_relpaths) == 1:
        diagnostic_logd = logd_relpaths[0]
    else:
        diagnostic_logd = logd_relpaths

    decrypt_target = logd_relpaths[0] if logd_relpaths and len(logd_relpaths) == 1 else None
    if logd_relpaths and len(logd_relpaths) > 1:
        decrypt_target = str((DIAGNOSTIC_DIR / f"build-{commit_id}.logd").relative_to(ROOT))

    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "commit": commit_id,
        "diagnostic_logd": diagnostic_logd,
        "diagnostic_logd_error": logd_error,
        "message_blocker": message_blocker,
        "chunked": chunked,
        "chunk_size_bytes": DIAGNOSTIC_CHUNK_SIZE if chunked else None,
        "password": password,
        "decrypt_command": (
            f"encryptly unpack {decrypt_target} <outdir> --password {password}"
            if decrypt_target and password else None
        ),
        "total_modules": len(results),
        "passed": sum(1 for _, s, _, _, _ in results if s),
        "failed": sum(1 for _, s, _, _, _ in results if not s),
        "modules": [
            {
                "name": name,
                "status": "PASS" if success else "FAIL",
                "elapsed_seconds": round(elapsed, 3),
                "artifact": binary,
                "output": output,
            }
            for name, success, elapsed, output, binary in results
        ],
        "pr_note": (
            (f"Include the encrypted diagnostic logd artifact(s): {', '.join(logd_relpaths)}. " if logd_relpaths else "Encrypted diagnostic logd artifact was not created; include this JSON report showing why. ")
            + "The encrypted .logd is the required diagnostic content for PR review; this JSON file is metadata. "
            + "Maintainers may ask you to remove these diagnostic artifacts before merging."
        ),
    }
    return report


def write_diagnostic_report(metadata_path: Path, report: dict) -> None:
    metadata_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"    {color('✓', Colors.GREEN)} {metadata_path.relative_to(ROOT)} created")


def commit_diagnostic_artifacts(paths: list[Path], commit_id: str) -> bool:
    """Commit diagnostic files as soon as they are produced."""
    existing = [path for path in paths if path.exists()]
    if not existing:
        print(f"    {color('✗', Colors.RED)} No diagnostic artifacts found to commit")
        return False

    relpaths = [str(path.relative_to(ROOT)) for path in existing]
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *relpaths],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if status.returncode != 0:
        print(f"    {color('✗', Colors.RED)} Could not inspect diagnostic git status: {status.stderr.strip()}")
        return False
    if not status.stdout.strip():
        print(f"    {color('✓', Colors.GREEN)} Diagnostic artifacts already committed")
        return True

    add = subprocess.run(
        ["git", "add", "--", *relpaths],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if add.returncode != 0:
        print(f"    {color('✗', Colors.RED)} Could not stage diagnostic artifacts: {add.stderr.strip()}")
        return False

    commit = subprocess.run(
        ["git", "commit", "-m", f"Add build diagnostics for {commit_id}", "--", *relpaths],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=600,
    )
    if commit.returncode != 0:
        output = commit.stderr.strip() or commit.stdout.strip()
        print(f"    {color('✗', Colors.RED)} Could not commit diagnostic artifacts: {output}")
        return False

    print(f"    {color('✓', Colors.GREEN)} Diagnostic artifacts committed")
    return True


def generate_logd(
    results: list[tuple[str, bool, float, str, Optional[str]]],
    verbose: bool = False,
) -> bool:
    logd_path, metadata_path, commit_id = diagnostic_paths_for_commit()
    display_logd = logd_path.relative_to(ROOT)
    print(f"\n  {color('▸', Colors.CYAN)} Finalizing diagnostics for {color(str(display_logd), Colors.BOLD)}...")

    # Always write the JSON report first. The encrypted .logd is useful, but the
    # report is required even when the build failed before compilation started or
    # when encryptly itself is unavailable.
    write_diagnostic_report(metadata_path, build_diagnostic_report(results, commit_id))

    encryptly_bin = get_encryptly_bin()
    if encryptly_bin is None:
        error = f"encryptly binary not found ({encryptly_platform_help()}); cannot create {display_logd}"
        print(f"    {color('✗', Colors.RED)} {error}")
        write_diagnostic_report(
            metadata_path,
            build_diagnostic_report(
                results,
                commit_id,
                logd_error=error,
                message_blocker=ENCRYPTLY_BLOCKER_MESSAGE,
            ),
        )
        print(f"    {color('BLOCKER', Colors.RED)} {ENCRYPTLY_BLOCKER_MESSAGE}")
        commit_diagnostic_artifacts([metadata_path], commit_id)
        return False

    # Workspace must live under $HOME because encryptly refuses paths outside home.
    home = Path.home()
    workspace = home / ".cache" / "tent-of-trials" / "logd-workspace"
    safe_dir = workspace / "safe"

    try:
        shutil.rmtree(workspace, ignore_errors=True)
        safe_dir.mkdir(parents=True, exist_ok=True)

        (safe_dir / "system-info.txt").write_text(
            collect_system_info(), encoding="utf-8"
        )

        summary_lines = [
            "Tent of Trials - Build Summary",
            "=" * 50,
            f"generated_at: {datetime.datetime.now(datetime.timezone.utc).isoformat()}",
            f"total_modules: {len(results)}",
            f"passed: {sum(1 for _, s, _, _, _ in results if s)}",
            f"failed: {sum(1 for _, s, _, _, _ in results if not s)}",
            "",
            "module results:",
        ]
        for name, success, elapsed, _, binary in results:
            summary_lines.append(
                f"  {name}: {'PASS' if success else 'FAIL'} ({elapsed:.2f}s)"
                f"{f' [{binary}]' if binary else ''}"
            )
        (safe_dir / "build-summary.txt").write_text(
            "\n".join(summary_lines), encoding="utf-8"
        )

        log_lines = []
        for name, success, elapsed, output, binary in results:
            log_lines.append(
                f"\n{'=' * 50}\n{name} ({'PASS' if success else 'FAIL'}, {elapsed:.2f}s)\n"
                f"{'=' * 50}"
            )
            if binary:
                log_lines.append(f"artifact: {binary}")
            if output:
                log_lines.append(output)
        (safe_dir / "build.log").write_text("\n".join(log_lines), encoding="utf-8")

        sr = subprocess.run(
            [
                str(encryptly_bin),
                "pack",
                str(logd_path),
                "--include",
                str(workspace),
                "--max-file-size",
                "61440",
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=1500,
        )
        if sr.returncode != 0:
            error = sr.stderr.strip() or sr.stdout.strip() or "encryptly pack failed"
            print(
                f"    {color('✗', Colors.RED)} {logd_path.relative_to(ROOT)} creation failed: "
                f"{error}"
            )
            if logd_path.exists():
                logd_path.unlink()
            write_diagnostic_report(
                metadata_path,
                build_diagnostic_report(
                    results,
                    commit_id,
                    logd_error=error,
                    message_blocker=ENCRYPTLY_BLOCKER_MESSAGE,
                ),
            )
            print(f"    {color('BLOCKER', Colors.RED)} {ENCRYPTLY_BLOCKER_MESSAGE}")
            commit_diagnostic_artifacts([metadata_path], commit_id)
            return False

        safe_pw = sr.stdout.strip()
        logd_files = split_diagnostic_logd(logd_path)
        logd_relpaths = [str(path.relative_to(ROOT)) for path in logd_files]
        decrypt_target = logd_relpaths[0] if len(logd_relpaths) == 1 else str(logd_path.relative_to(ROOT))
        write_diagnostic_report(
            metadata_path,
            build_diagnostic_report(
                results,
                commit_id,
                logd_relpaths=logd_relpaths,
                password=safe_pw,
                chunked=len(logd_files) > 1,
            ),
        )

        for path in logd_files:
            size_kb = path.stat().st_size / 1024.0
            print(
                f"    {color('✓', Colors.GREEN)} {path.relative_to(ROOT)} created "
                f"({size_kb:.1f} KiB)"
            )
        if len(logd_files) > 1:
            print(
                f"    {color('✓', Colors.GREEN)} split oversized diagnostic log into "
                f"{len(logd_files)} chunks of at most {DIAGNOSTIC_CHUNK_SIZE // (1024 * 1024)} MiB"
            )
        if not commit_diagnostic_artifacts([metadata_path, *logd_files], commit_id):
            return False

        if safe_pw:
            print()
            print(f"  {color('Password', Colors.BOLD)} - this is required to decrypt the diagnostic log,")
            print(f"             which is required to submit a PR. Upload the")
            print(f"             diagnostic log file(s) and metadata file with this password.")
            if len(logd_files) > 1:
                print(f"             Reassemble chunks in order before unpacking:")
                print(f"             cat {' '.join(logd_relpaths)} > {logd_path.relative_to(ROOT)}")
            print(f"  {color(safe_pw, Colors.CYAN)}")
            print(f"  {color(f'encryptly unpack {decrypt_target} <outdir> --password {safe_pw}', Colors.GRAY)}")
        return True

    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def print_summary(results: list[tuple[str, bool, float, str, Optional[str]]]):
    print(f"  {color('Build Summary', Colors.BOLD)}")

    total = len(results)
    passed = sum(1 for _, s, _, _, _ in results if s)
    failed = total - passed
    total_time = sum(t for _, _, t, _, _ in results)

    for name, success, elapsed, output, binary in results:
        status_icon = color("✓", Colors.GREEN) if success else color("✗", Colors.RED)
        status_text = color("PASS", Colors.GREEN) if success else color("FAIL", Colors.RED)
        time_str = f"{elapsed:.1f}s" if elapsed < 60 else f"{elapsed / 60:.1f}m"

        print(f"\n  {status_icon}  {color(name + ':', Colors.BOLD)} {status_text}  ({time_str})")
        if binary:
            print(f"       artifact: {color(binary, Colors.GRAY)}")
        if not success and output:

            lines = output.strip().split("\n")
            print(f"       {color('last output:', Colors.RED)}")
            for line in lines[-5:]:
                print(f"       {color(line, Colors.GRAY)}")

    print(f"\n  {color('─' * 40, Colors.GRAY)}")
    print(f"  {color('Total:', Colors.BOLD)} {total} modules, "
          f"{color(str(passed) + ' passed', Colors.GREEN)}, "
          f"{color(str(failed) + ' failed', Colors.RED)}, "
          f"{total_time:.1f}s total")

def main():
    parser = argparse.ArgumentParser(
        description="Tent of Trials  -  Multi-Language Build System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 build.py                    Build all modules
  python3 build.py -m backend         Build only backend
  python3 build.py -m frontend,market Build frontend and market
  python3 build.py --clean            Clean all artifacts
  python3 build.py --release          Release build (Rust only)
  python3 build.py --verbose          Verbose output

Diagnostic bundle:
  python3 build.py
        """,
    )
    parser.add_argument(
        "-m", "--module",
        help="Module(s) to build (comma-separated, or 'all')",
        default="all",
    )
    parser.add_argument(
        "--clean", action="store_true",
        help="Clean build artifacts instead of building",
    )
    parser.add_argument(
        "--release", action="store_true",
        help="Build in release mode (Rust backend)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Show detailed build output",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available modules and exit",
    )
    parser.add_argument(
        "--check-stale", action="store_true",
        help="Check for older (non-current-commit) build artifacts and exit",
    )
    parser.add_argument(
        "--max-stale-bytes", type=int, default=0,
        help="Maximum allowed size of stale artifacts in bytes (default: 0)",
    )

    args = parser.parse_args()

    if args.check_stale:
        stale_files = find_stale_artifacts()
        total_size = sum(size for _, size in stale_files)
        
        if stale_files:
            print(f"Found {len(stale_files)} stale build artifact(s):")
            for path, size in stale_files:
                try:
                    rel_path = path.relative_to(ROOT)
                except ValueError:
                    rel_path = path.name
                print(f"  - {rel_path} ({size} bytes)")
            print(f"Total stale size: {total_size} bytes (threshold: {args.max_stale_bytes} bytes)")
            
            fail = False
            if args.max_stale_bytes == 0:
                fail = True
            elif total_size > args.max_stale_bytes:
                fail = True
                
            if fail:
                print(color("FAIL: Stale artifacts exceed maximum allowed limit.", Colors.RED))
                sys.exit(1)
            else:
                print(color("PASS: Stale artifacts are within the limit.", Colors.GREEN))
                sys.exit(0)
        else:
            print("No stale build artifacts found.")
            print(color("PASS: No stale artifacts exist.", Colors.GREEN))
            sys.exit(0)

    print(f"\n  {color('Tent of Trials: building', Colors.CYAN)}")
    print(f"  Working directory: {ROOT}")
    print()

    if args.list:
        print(f"  {color('Available modules:', Colors.BOLD)}")
        for m in MODULES:
            print(f"    {color(m.name, Colors.CYAN)} ({m.language})")
            print(f"      dir: {m.dir.relative_to(ROOT)}")
            print(f"      build: {' '.join(m.build_cmd)}")
        return 0

    print(f"  {color('Checking prerequisites...', Colors.GRAY)}")
    missing = check_prerequisites()
    if missing:
        print(f"\n  {color('⚠ Some tools missing  -  will try anyway:', Colors.YELLOW)}")
        for m in missing:
            print(f"    {m}")

        msg = "Not all modules will build. That's fine."
        print(f"  {color(msg, Colors.GRAY)}")
    else:
        print(f"  {color('✓ All prerequisites found', Colors.GREEN)}")
    if args.module == "all":
        selected = MODULES
    else:
        names = [n.strip() for n in args.module.split(",")]
        selected = [m for m in MODULES if m.name in names]
        not_found = set(names) - {m.name for m in MODULES}
        if not_found:
            print(f"  {color('✗ Unknown modules:', Colors.RED)} {', '.join(not_found)}")
            print(f"    Available: {', '.join(m.name for m in MODULES)}")
            return 1

    if not selected:
        print(f"  No modules selected.")
        return 0

    if args.clean:
        print(f"\n  {color('Cleaning build artifacts...', Colors.YELLOW)}")
        for module in selected:
            clean_module(module, args.verbose)

        diagnostic_artifacts = [ROOT / "build.logd"]
        if DIAGNOSTIC_DIR.exists():
            diagnostic_artifacts.extend(DIAGNOSTIC_DIR.glob("build-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].logd"))
            diagnostic_artifacts.extend(DIAGNOSTIC_DIR.glob("build-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-part*.logd"))
            diagnostic_artifacts.extend(DIAGNOSTIC_DIR.glob("build-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].json"))
            diagnostic_artifacts.extend(DIAGNOSTIC_DIR.glob("build-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-metadata.json"))
        for artifact in diagnostic_artifacts:
            if artifact.exists():
                if artifact.is_dir():
                    shutil.rmtree(artifact)
                else:
                    artifact.unlink()
                print(f"  {color('▸', Colors.YELLOW)} Removed {artifact.relative_to(ROOT)}")
        print(f"\n  {color('Clean complete.', Colors.GREEN)}")
        return 0

    print(f"\n  {color('Checking encryptly diagnostics...', Colors.GRAY)}")
    encryptly_start = time.time()
    encryptly_ok, encryptly_message = check_encryptly_runs()
    if not encryptly_ok:
        elapsed = time.time() - encryptly_start
        blocker = f"{ENCRYPTLY_BLOCKER_MESSAGE} {encryptly_message}"
        print(f"  {color('✗ encryptly cannot run', Colors.RED)}")
        print(f"  {color('BLOCKER:', Colors.RED)} {blocker}")
        results = [("encryptly-preflight", False, elapsed, blocker, None)]
        generate_logd(results, args.verbose)
        return 1
    print(f"  {color('✓ encryptly runs', Colors.GREEN)}")

    print(f"\n  {color(f'Building {len(selected)} module(s) | release={args.release}', Colors.GRAY)}")

    results: list[tuple[str, bool, float, str, Optional[str]]] = []

    for module in selected:
        success, elapsed, output = build_module(module, args.release, args.verbose)
        binary = verify_binary(module) if success else None
        results.append((module.name, success, elapsed, output, binary))

    print_summary(results)

    diagnostics_ok = generate_logd(results, args.verbose)

    return 0 if diagnostics_ok and all(r[1] for r in results) else 1

if __name__ == "__main__":
    sys.exit(main())
