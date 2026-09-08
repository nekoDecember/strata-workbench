"""Executes one trusted-user analysis in a worker subprocess.

Container mounts/network rules, not exec() or Python syntax filtering, define
the credential boundary. This is intentionally NOT an adversarial sandbox.
"""

import json
import os
import resource
import sys
import traceback
from pathlib import Path


def main():
    job = Path(sys.argv[1]).resolve()
    os.chdir(job)
    resource.setrlimit(resource.RLIMIT_CPU, (60, 65))
    resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))
    import numpy as np
    import pandas as pd
    import polars as pl

    from strata.models import ROW_ID
    from strata.storage import atomic_json, clean

    request = json.loads((job / "request.json").read_text())
    df = pd.read_parquet(job / "input.parquet")
    selected = df[df[ROW_ID].isin(request["selected_ids"])].copy()
    artifacts = []

    class Workbench:
        context = request["context"]
        view = request["view"]
        selected_ids = request["selected_ids"]

        def publish(self, frame, name="Python result"):
            """Publish a data branch. Preserve __row_id for row-level lineage."""
            if isinstance(frame, pd.Series):
                frame = frame.to_frame()
            if isinstance(frame, pd.DataFrame):
                frame = pl.from_pandas(frame, include_index=False)
            if not isinstance(frame, pl.DataFrame):
                raise TypeError("publish() needs a pandas or Polars DataFrame")
            filename = f"dataset-{len(artifacts)}.parquet"
            frame.write_parquet(job / filename)
            artifacts.append(
                {
                    "kind": "dataset",
                    "file": filename,
                    "name": str(name)[:200],
                    "rows": frame.height,
                    "columns": frame.columns,
                }
            )

        def select(self, ids, name="Python selection"):
            valid = set(df[ROW_ID].tolist())
            ids = list(dict.fromkeys(int(i) for i in ids))
            if len(ids) > 200_000 or any(i not in valid for i in ids):
                raise ValueError("選択する行IDは入力データに含まれる20万件以下にしてください。")
            filename = f"selection-{len(artifacts)}.json"
            atomic_json(job / filename, ids)
            artifacts.append({"kind": "selection", "file": filename, "name": str(name)[:200], "ids": ids})

        def show(self, value, name="Result", row_ids=None):
            """Display a DataFrame, Plotly/Matplotlib figure, or plain text."""
            index = len(artifacts)
            if isinstance(value, (pd.DataFrame, pl.DataFrame, pd.Series)):
                if isinstance(value, pd.Series):
                    value = value.to_frame()
                if isinstance(value, pd.DataFrame):
                    value = pl.from_pandas(value.reset_index(), include_index=False)
                filename = f"table-{index}.parquet"
                value.write_parquet(job / filename)
                artifact = {
                    "kind": "table",
                    "file": filename,
                    "name": str(name)[:200],
                    "rows": value.height,
                    "columns": value.columns,
                    "preview": clean(value.head(100).to_dicts()),
                }
                if row_ids is not None:
                    if len(row_ids) != value.height:
                        raise ValueError("row_idsは集計表と同じ行数のリストにしてください。")
                    valid = set(df[ROW_ID].tolist())
                    links = [[int(i) for i in ids] for ids in row_ids[:100]]
                    if sum(map(len, links)) > 200_000 or any(i not in valid for ids in links for i in ids):
                        raise ValueError("リンク先は入力データ内の行IDを合計20万件以下で指定してください。")
                    artifact["row_ids"] = links
                artifacts.append(artifact)
            elif hasattr(value, "to_plotly_json"):
                filename = f"figure-{index}.json"
                # Plotly 6 typed arrays are understood by the same major version in the UI.
                (job / filename).write_text(value.to_json(), encoding="utf-8")
                artifacts.append({"kind": "plotly", "file": filename, "name": str(name)[:200]})
            elif hasattr(value, "savefig"):
                filename = f"figure-{index}.png"
                value.savefig(job / filename, dpi=140, bbox_inches="tight")
                artifacts.append({"kind": "image", "file": filename, "name": str(name)[:200]})
            else:
                filename = f"text-{index}.txt"
                (job / filename).write_text(str(value)[:200_000], encoding="utf-8")
                artifacts.append(
                    {"kind": "text", "file": filename, "name": str(name)[:200], "text": str(value)[:20_000]}
                )

    wb = Workbench()
    namespace = {
        "__name__": "__main__",
        "df": df,
        "selected": selected,
        "pd": pd,
        "pl": pl,
        "np": np,
        "wb": wb,
        "context": request["context"],
        "selection_mask": df[ROW_ID].isin(request["selected_ids"]),
    }
    try:
        exec(compile(request["code"], "<strata-analysis>", "exec"), namespace)
        atomic_json(job / "output.json", {"status": "succeeded", "artifacts": artifacts})
    except BaseException:
        traceback.print_exc()
        atomic_json(
            job / "output.json",
            {
                "status": "failed",
                "artifacts": artifacts,
                "error": "Python実行でエラーが発生しました。出力を確認してください。",
            },
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
