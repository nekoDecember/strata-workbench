"""Filesystem queue worker, deployed in a network-disabled container."""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .storage import atomic_json, now


def execute(path: Path, timeout=90):
    started = time.monotonic()
    if (path / "cancel").exists():
        atomic_json(path / "result.json", {"status": "cancelled", "artifacts": [], "finished_at": now()})
        return
    atomic_json(path / "running.json", {"started_at": now()})
    env = {
        "PATH": os.defpath,
        "PYTHONUNBUFFERED": "1",
        "LANG": "C.UTF-8",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": "/tmp/matplotlib",
        "HOME": "/tmp",
        "OPENBLAS_NUM_THREADS": "2",
        "OMP_NUM_THREADS": "2",
        "POLARS_MAX_THREADS": "2",
    }
    # Development editable installs also need the package path; never forward the parent environment.
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    process = None
    try:
        with (path / "stdout.txt").open("wb") as stdout:
            process = subprocess.Popen(
                [sys.executable, "-m", "strata.runner", str(path.resolve())],
                cwd=path,
                env=env,
                stdout=stdout,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            status = None
            while process.poll() is None:
                atomic_json(path.parent / "heartbeat.json", {"at": now()})
                if (path / "cancel").exists():
                    status = "cancelled"
                elif time.monotonic() - started > timeout:
                    status = "timed_out"
                if status:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    break
                time.sleep(0.2)
            if status:
                result = {
                    "status": status,
                    "artifacts": [],
                    "error": "実行を中止しました。"
                    if status == "cancelled"
                    else "実行時間の上限を超えました。",
                }
            elif (path / "output.json").exists():
                result = json.loads((path / "output.json").read_text())
            else:
                result = {
                    "status": "failed",
                    "artifacts": [],
                    "error": f"実行プロセスが終了しました (exit {process.returncode})。",
                }
    except Exception:
        result = {"status": "failed", "artifacts": [], "error": "ワーカーが実行を完了できませんでした。"}
    finally:
        if process is not None:
            # Also reap children spawned by user code after the parent has exited.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    result.update(finished_at=now(), duration_seconds=round(time.monotonic() - started, 2))
    atomic_json(path / "result.json", result)


def main():
    root = Path(os.getenv("STRATA_JOBS_DIR", "/jobs"))
    root.mkdir(parents=True, exist_ok=True)
    # A crashed analysis is recorded as interrupted, never silently rerun.
    for marker in root.glob("*/running.json"):
        if not (marker.parent / "result.json").exists():
            atomic_json(
                marker.parent / "result.json",
                {
                    "status": "failed",
                    "artifacts": [],
                    "error": "ワーカーの再起動で中断されました。",
                    "finished_at": now(),
                },
            )
    while True:
        atomic_json(root / "heartbeat.json", {"at": now()})
        for req in sorted(root.glob("*/request.json"), key=lambda p: p.stat().st_mtime):
            if not (req.parent / "result.json").exists():
                execute(req.parent, int(os.getenv("STRATA_PYTHON_TIMEOUT", "90")))
        time.sleep(0.5)


if __name__ == "__main__":
    main()
