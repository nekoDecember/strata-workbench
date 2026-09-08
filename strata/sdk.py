"""Small Python bridge for notebooks and ordinary scripts."""

import io
import os
import time
from pathlib import Path

import httpx
import pandas as pd


class Client:
    def __init__(self, url="http://localhost:8080", token=None, trust_env=False):
        if not token:
            raise ValueError("アクセストークンを指定してください。Client.from_env()も使えます。")
        self.http = httpx.Client(
            base_url=url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=120,
            trust_env=trust_env,
        )

    @classmethod
    def from_env(cls):
        token_file = os.getenv("STRATA_TOKEN_FILE", "secrets/app_token.txt")
        token = os.getenv("STRATA_TOKEN") or (
            Path(token_file).read_text().strip() if Path(token_file).exists() else None
        )
        return cls(os.getenv("STRATA_URL", "http://localhost:8080"), token)

    def close(self):
        self.http.close()

    def _json(self, method, path, **kwargs):
        response = self.http.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    def datasets(self):
        return self._json("GET", "/api/datasets")

    def state(self, dataset_id):
        return self._json("GET", f"/api/datasets/{dataset_id}/state")

    def frame(self, dataset_id, view=None, selected=False):
        if view is None:
            state = self.state(dataset_id)
            view = state.get("view", {})
        view = dict(view)
        if selected:
            view["selection_only"] = True
        response = self.http.post(f"/api/datasets/{dataset_id}/export", json=view)
        response.raise_for_status()
        return pd.read_parquet(io.BytesIO(response.content))

    def publish(self, frame, name="Python dataset", preserve_ids=True):
        output = io.BytesIO()
        frame.to_parquet(output, index=False)
        return self._json(
            "POST",
            "/api/datasets",
            files={"file": ("python.parquet", output.getvalue(), "application/octet-stream")},
            data={"name": name, "preserve_ids": str(preserve_ids).lower()},
        )

    def run(self, dataset_id, code, view=None, context=None, wait=False, timeout=180):
        if view is None:
            view = self.state(dataset_id).get("view", {})
        job = self._json(
            "POST",
            f"/api/datasets/{dataset_id}/python",
            json={**view, "code": code, "context": context or {}},
        )
        if wait:
            start = time.monotonic()
            while job["status"] in ("queued", "running"):
                if time.monotonic() - start > timeout:
                    raise TimeoutError(f"Job {job['id']} is still running; check it in the workbench.")
                time.sleep(0.3)
                job = self._json("GET", f"/api/jobs/{job['id']}")
        return job

    def open_result(self, job_id, filename):
        return self._json("POST", f"/api/jobs/{job_id}/publish/{filename}")
