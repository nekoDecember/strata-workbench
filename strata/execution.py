"""API-side job transport. No user Python is executed in the API process."""

import json
import time
import uuid
from pathlib import Path

from .models import ROW_ID
from .storage import atomic_json, now, valid_id


class Jobs:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, job_id):
        path = self.root / valid_id(job_id)
        if not path.is_dir():
            raise FileNotFoundError("実行履歴が見つかりません。")
        return path

    def create(self, frame, dataset_id, revision, request):
        pending = sum(1 for p in self.root.glob("*/request.json") if not (p.parent / "result.json").exists())
        if pending >= 20:
            raise ValueError("実行待ちが20件あります。完了を待ってください。")
        job_id = uuid.uuid4().hex
        path = self.root / job_id
        path.mkdir()
        frame.write_parquet(path / "input.parquet")
        valid_ids = set(frame[ROW_ID].to_list())
        record = {
            "id": job_id,
            "dataset_id": dataset_id,
            "revision": revision,
            "created_at": now(),
            "code": request.code,
            "view": request.model_dump(exclude={"code", "context"}),
            "context": request.context,
            "rows": frame.height,
            "selected_ids": [v for v in request.selected_ids if v in valid_ids],
        }
        atomic_json(path / "context.json", record)
        # request.json is the queue commit marker and must be written last.
        atomic_json(path / "request.json", record)
        return self.get(job_id)

    def get(self, job_id):
        path = self.path(job_id)
        request = json.loads((path / "request.json").read_text())
        record = {
            k: request[k]
            for k in ("id", "dataset_id", "revision", "created_at", "rows", "code", "view", "context")
        }
        result = path / "result.json"
        if result.exists():
            record.update(json.loads(result.read_text()))
        else:
            record["status"] = "running" if (path / "running.json").exists() else "queued"
        stdout = path / "stdout.txt"
        if stdout.exists():
            with stdout.open("rb") as f:
                content = f.read(200_000)
            record["stdout"] = content.decode("utf-8", errors="replace")
            record["stdout_truncated"] = stdout.stat().st_size > 200_000
        return record

    def list(self, dataset_id=None):
        paths = sorted(self.root.glob("*/request.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        result = []
        for path in paths:
            request = json.loads(path.read_text())
            if dataset_id and request["dataset_id"] != dataset_id:
                continue
            result.append(self.get(path.parent.name))
            if len(result) >= 30:
                break
        return result

    def artifact(self, job_id, filename):
        if "/" in filename or "\\" in filename or filename.startswith("."):
            raise ValueError("Invalid artifact name")
        path = self.path(job_id)
        result = self.get(job_id)
        if filename not in [a["file"] for a in result.get("artifacts", [])]:
            raise FileNotFoundError("出力が存在しません。")
        target = path / filename
        if target.is_symlink() or target.resolve().parent != path.resolve() or not target.is_file():
            raise ValueError("Invalid artifact path")
        return target

    def heartbeat(self):
        path = self.root / "heartbeat.json"
        if not path.exists():
            return False
        return time.time() - path.stat().st_mtime < 15

    def cancel(self, job_id):
        path = self.path(job_id)
        if (path / "result.json").exists():
            return self.get(job_id)
        (path / "cancel").touch()
        return {"status": "cancelling"}
