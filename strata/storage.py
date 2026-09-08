"""Immutable Parquet revisions plus small, atomic JSON manifests.

The API runs as ONE process. The reentrant lock serializes manifest mutations.
Dataset bytes are never overwritten; a revision is always an immutable snapshot.
"""

import json
import math
import os
import re
import threading
import uuid
from decimal import Decimal
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from .models import ROW_ID


def clean(value: Any) -> Any:
    if isinstance(value, Decimal):
        return clean(float(value))
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [clean(v) for v in value]
    if isinstance(value, np.generic):
        return clean(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, obj: Any):
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp.write_text(json.dumps(clean(obj), ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temp, path)


def valid_id(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("Invalid identifier")
    return value


def normalize(frame: pl.DataFrame, preserve_ids=False) -> pl.DataFrame:
    if frame.width > 1500:
        raise ValueError("列数の上限は1500です。対象列を絞ってください。")
    if frame.height > int(os.getenv("STRATA_MAX_ROWS", "2000000")):
        raise ValueError("データ行数の上限を超えています。抽出条件を絞ってください。")
    if not preserve_ids and ROW_ID in frame.columns:
        raise ValueError(f"{ROW_ID} は内部用の予約列名です。読み込む前に変更してください。")
    if ROW_ID not in frame.columns:
        frame = frame.with_row_index(ROW_ID).with_columns(pl.col(ROW_ID).cast(pl.Int64))
    else:
        frame = frame.with_columns(pl.col(ROW_ID).cast(pl.Int64, strict=True))
        if frame[ROW_ID].null_count() or frame[ROW_ID].n_unique() != frame.height:
            raise ValueError("行IDは欠損のない一意の整数である必要があります。")
    for name, dtype in frame.schema.items():
        if dtype in (pl.Float32, pl.Float64):
            frame = frame.with_columns(
                pl.when(pl.col(name).is_finite()).then(pl.col(name)).otherwise(None).alias(name)
            )
        if dtype.is_nested():
            raise ValueError(f"{name}: 配列・構造体の列は、Pythonで平坦化してから読み込んでください。")
    return frame


class Store:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.datasets = self.root / "datasets"
        self.datasets.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def directory(self, dataset_id):
        return self.datasets / valid_id(dataset_id)

    def meta(self, dataset_id):
        path = self.directory(dataset_id) / "manifest.json"
        if not path.exists():
            raise FileNotFoundError("データが見つかりません。")
        return json.loads(path.read_text())

    def list(self):
        items = [json.loads(p.read_text()) for p in self.datasets.glob("*/manifest.json")]
        return sorted(items, key=lambda x: x["updated_at"], reverse=True)

    def create(self, frame, name, operation="import", parent=None, preserve_ids=False):
        frame = normalize(frame, preserve_ids=preserve_ids)
        dataset_id = uuid.uuid4().hex
        path = self.directory(dataset_id)
        path.mkdir()
        meta = {
            "id": dataset_id,
            "name": name[:200],
            "created_at": now(),
            "updated_at": now(),
            "current_revision": 0,
            "versions": [],
            "parent": parent,
        }
        atomic_json(path / "manifest.json", meta)
        self.commit(dataset_id, frame, operation, expected_revision=0)
        return self.meta(dataset_id)

    def commit(self, dataset_id, frame, operation, expected_revision):
        with self.lock:
            meta = self.meta(dataset_id)
            if meta["current_revision"] != expected_revision:
                raise RuntimeError("データが更新されています。最新のリビジョンに切り替えてください。")
            revision = expected_revision + 1
            frame = normalize(frame, preserve_ids=True)
            frame.write_parquet(self.directory(dataset_id) / f"r{revision}.parquet")
            meta["versions"].append(
                {"revision": revision, "operation": operation, "created_at": now(), "rows": frame.height}
            )
            meta.update(
                current_revision=revision, updated_at=now(), rows=frame.height, columns=frame.width - 1
            )
            atomic_json(self.directory(dataset_id) / "manifest.json", meta)
            return meta

    def resolve_revision(self, dataset_id, revision=None):
        meta = self.meta(dataset_id)
        revision = meta["current_revision"] if revision is None else revision
        if not any(v["revision"] == revision for v in meta["versions"]):
            raise ValueError("リビジョンが存在しません。")
        return revision

    def frame(self, dataset_id, revision=None):
        revision = self.resolve_revision(dataset_id, revision)
        return pl.read_parquet(self.directory(dataset_id) / f"r{revision}.parquet")

    def state(self, dataset_id):
        self.meta(dataset_id)
        path = self.directory(dataset_id) / "workspace.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def save_state(self, dataset_id, state):
        self.meta(dataset_id)
        if len(json.dumps(state)) > 8_000_000:
            raise ValueError("保存する状態が大きすぎます。")
        with self.lock:
            atomic_json(self.directory(dataset_id) / "workspace.json", state)


def demo_frame() -> pl.DataFrame:
    """Deterministic synthetic process data; never presented as observed plant data."""
    import pandas as pd

    rng = np.random.default_rng(42)
    n = 2400
    machine = rng.choice(["MC-01", "MC-02", "MC-03", "MC-04"], n)
    shift = np.where(np.arange(n) % 120 < 60, "昼勤", "夜勤")
    temp = rng.normal(24, 1.4, n) + (shift == "夜勤") * 1.0
    diameter = 10 + (machine == "MC-03") * 0.022 + (temp - 24) * 0.005 + rng.normal(0, 0.009, n)
    diameter[1540:1600] += 0.035
    df = pd.DataFrame(
        {
            "測定日時": pd.date_range("2026-08-01", periods=n, freq="10min"),
            "ロット": [f"L{v // 40 + 1:04}" for v in range(n)],
            "設備": machine,
            "勤務帯": shift,
            "品種": rng.choice(["A-100", "A-200"], n),
            "径_mm": np.round(diameter, 4),
            "温度_C": np.round(temp, 2),
            "圧力_MPa": np.round(0.5 + (diameter - 10) * 0.3 + rng.normal(0, 0.008, n), 4),
            "検査員": rng.choice(["担当A", "担当B", "担当C"], n),
            "判定": np.where((diameter < 9.96) | (diameter > 10.06), "NG", "OK"),
        }
    )
    df.loc[rng.choice(n, 18, replace=False), "温度_C"] = np.nan
    return pl.from_pandas(df)
