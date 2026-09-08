"""Run the built application + worker locally for development.

Use Docker for the credential isolation described in the README. This helper
runs processes as the current OS user and does not provide container isolation.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run([sys.executable, str(root / "scripts/setup.py")], check=True)
env = {
    **os.environ,
    "STRATA_DATA_DIR": str(root / "data"),
    "STRATA_JOBS_DIR": str(root / "jobs"),
    "STRATA_TOKEN_FILE": str(root / "secrets/app_token.txt"),
    "STRATA_CONNECTIONS_FILE": str(root / "secrets/connections.json"),
}
processes = []
try:
    processes.append(subprocess.Popen([sys.executable, "-m", "strata.worker"], cwd=root, env=env))
    processes.append(
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "strata.api:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
            ],
            cwd=root,
            env=env,
        )
    )
    while all(p.poll() is None for p in processes):
        time.sleep(0.5)
except KeyboardInterrupt:
    pass
finally:
    for p in processes:
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    for p in processes:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
