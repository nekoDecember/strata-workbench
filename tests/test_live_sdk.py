"""One real HTTP + queued subprocess round trip, independent of a browser."""

import os
import socket
import subprocess
import sys
import time

import pandas as pd

from strata.sdk import Client


def test_live_sdk_and_worker(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("integration-test-token-only-abcdefghijklmnopqrstuvwxyz")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "STRATA_DATA_DIR": str(tmp_path / "data"),
        "STRATA_JOBS_DIR": str(tmp_path / "jobs"),
        "STRATA_TOKEN_FILE": str(token_file),
        "DATABASE_PASSWORD": "must-not-inherit",
    }
    with (tmp_path / "api.log").open("wb") as logs:
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "strata.api:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
            ],
            env=env,
            stdout=logs,
            stderr=logs,
        )
        worker = subprocess.Popen([sys.executable, "-m", "strata.worker"], env=env, stdout=logs, stderr=logs)
        client = Client(f"http://127.0.0.1:{port}", token_file.read_text())
        try:
            for _ in range(80):
                try:
                    if client._json("GET", "/api/session")["worker_available"]:
                        break
                except Exception:
                    pass
                time.sleep(0.1)
            d = client.publish(
                pd.DataFrame({"__row_id": [5, 11, 72], "v": [1.0, 2.0, 6.0]}), name="SDK dataset"
            )
            client._json(
                "PUT",
                f"/api/datasets/{d['id']}/state",
                json={"view": {"revision": 1, "selected_ids": [11], "filters": []}},
            )
            assert client.frame(d["id"], selected=True)["v"].tolist() == [2.0]
            j = client.run(
                d["id"],
                "import os\nassert 'DATABASE_PASSWORD' not in os.environ\nwb.publish(df.assign(doubled=df.v*2), name='SDK result')\nprint(len(selected))",
                wait=True,
            )
            assert j["status"] == "succeeded", j
            assert j["stdout"].strip() == "1"
            derived = client.open_result(j["id"], j["artifacts"][0]["file"])
            assert client.frame(derived["id"])["doubled"].tolist() == [2.0, 4.0, 12.0]
        finally:
            client.close()
            for process in (worker, server):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
