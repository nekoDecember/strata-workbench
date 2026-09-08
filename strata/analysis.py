from typing import Any

import numpy as np
import polars as pl

from .models import ROW_ID, ChartQuery, Filter, ViewQuery
from .storage import clean


def filter_expr(frame: pl.DataFrame, f: Filter) -> pl.Expr:
    if f.column not in frame.columns:
        raise ValueError(f"列が存在しません: {f.column}")
    col = pl.col(f.column)
    dtype = frame.schema[f.column]
    if dtype.is_decimal():
        # Charts are computed in Float64; keep predicate boundaries consistent
        # while retaining the exact Decimal values in the stored Parquet data.
        col = col.cast(pl.Float64)
    if f.op == "is_null":
        return col.is_null()
    if f.op == "not_null":
        return col.is_not_null()
    if f.op == "contains":
        return col.cast(pl.String).str.contains(str(f.value), literal=True).fill_null(False)
    if f.op in ("in", "not_in"):
        if not isinstance(f.value, list):
            raise ValueError("in フィルタにはリストが必要です。")
        vals = [v for v in f.value if v is not None]
        values = pl.Series("v", vals).cast(pl.Float64 if dtype.is_numeric() else dtype, strict=True)
        condition = col.is_in(values.implode()).fill_null(False)
        if None in f.value:
            condition = condition | col.is_null()
        return ~condition if f.op == "not_in" else condition
    if f.value is None:
        if f.op == "eq":
            return col.is_null()
        if f.op == "ne":
            return col.is_not_null()
        raise ValueError("大小比較に空値は使えません。")
    if dtype.is_numeric():
        # Casting a fractional bin boundary to an integer column type truncates it
        # and selects the wrong observations. Compare in a common numeric type.
        value = (
            pl.lit(f.value)
            if isinstance(f.value, (int, float))
            else pl.lit(f.value).cast(pl.Float64, strict=True)
        )
    elif dtype.is_temporal() and isinstance(f.value, str):
        value = pl.lit(f.value).str.to_datetime(strict=True).cast(dtype)
    else:
        value = pl.lit(f.value).cast(dtype, strict=True)
    operators = {
        "eq": lambda: col == value,
        "ne": lambda: col != value,
        "gt": lambda: col > value,
        "ge": lambda: col >= value,
        "lt": lambda: col < value,
        "le": lambda: col <= value,
    }
    return operators[f.op]().fill_null(False)


def apply_view(frame: pl.DataFrame, q: ViewQuery) -> pl.DataFrame:
    for f in q.filters:
        frame = frame.filter(filter_expr(frame, f))
    if q.excluded_ids:
        frame = frame.filter(~pl.col(ROW_ID).is_in(q.excluded_ids))
    if q.selection_only:
        frame = frame.filter(pl.col(ROW_ID).is_in(q.selected_ids))
    if q.sort_by:
        if q.sort_by not in frame.columns:
            raise ValueError("並べ替え対象の列がありません。")
        frame = frame.sort(q.sort_by, descending=q.descending, nulls_last=True)
    return frame


def schema_info(frame):
    return [
        {
            "name": n,
            "dtype": str(d),
            "kind": "number" if d.is_numeric() else "datetime" if d.is_temporal() else "text",
        }
        for n, d in frame.schema.items()
        if n != ROW_ID
    ]


def profile(frame):
    result = []
    for item in schema_info(frame):
        s = frame[item["name"]]
        item.update(nulls=s.null_count(), unique=s.n_unique(), count=len(s) - s.null_count())
        if item["kind"] == "number":
            item.update(
                mean=s.mean(),
                std=s.std(),
                min=s.min(),
                max=s.max(),
                median=s.median(),
                q1=s.quantile(0.25, interpolation="linear"),
                q3=s.quantile(0.75, interpolation="linear"),
            )
        else:
            counts = frame.group_by(item["name"]).len().sort("len", descending=True).head(30)
            item["values"] = [{"value": r[item["name"]], "count": r["len"]} for r in counts.to_dicts()]
        result.append(item)
    return clean(result)


def chart(frame: pl.DataFrame, q: ChartQuery) -> dict[str, Any]:
    for col in (q.x, q.y, q.group):
        if col and col not in frame.columns:
            raise ValueError(f"列が存在しません: {col}")
    if not frame.schema[q.y].is_numeric():
        raise ValueError("Yには数値列を選んでください。")
    result: dict[str, Any] = {
        "kind": q.kind,
        "total": frame.height,
        "sampled": False,
        "x": q.x,
        "y": q.y,
        "group": q.group,
    }
    clean_frame = frame.drop_nulls(q.y)
    highlight_ids = q.highlight_ids if q.highlight_ids is not None else q.selected_ids
    selected_frame = clean_frame.filter(pl.col(ROW_ID).is_in(highlight_ids))
    result["valid"] = clean_frame.height
    result["extent"] = [clean_frame[q.y].min(), clean_frame[q.y].max()] if clean_frame.height else None
    if q.kind in ("scatter", "time"):
        if q.group and frame[q.group].n_unique() > 100:
            raise ValueError("層別値が100種類を超えています。期間などで絞るか、別の層別列を選んでください。")
        x = q.x or ROW_ID
        points = clean_frame.drop_nulls(x)
        result["valid"] = points.height
        if points.height > q.max_points:
            points = points.sample(n=q.max_points, seed=42)
            result["sampled"] = True
        if q.kind == "time":
            points = points.sort(x)
        columns = list(dict.fromkeys([ROW_ID, x, q.y] + ([q.group] if q.group else [])))
        result.update(points=points.select(columns).to_dicts(), rendered=points.height)
    elif q.kind == "histogram":
        values = clean_frame[q.y].to_numpy().astype(float)
        if not len(values):
            return {**result, "bins": [], "rendered": 0}
        edges = np.histogram_bin_edges(values, bins=q.bins)
        groups = [None] if not q.group else clean_frame[q.group].unique(maintain_order=True).to_list()
        if len(groups) > 40:
            raise ValueError("層別値が40種類を超えています。条件を絞るか、別の層別列を選んでください。")
        bins = []
        for group in groups:
            subset = (
                clean_frame
                if not q.group
                else clean_frame.filter(
                    pl.col(q.group).is_null() if group is None else pl.col(q.group) == group
                )
            )
            counts, _ = np.histogram(subset[q.y].to_numpy().astype(float), bins=edges)
            selected_subset = (
                selected_frame
                if not q.group
                else selected_frame.filter(
                    pl.col(q.group).is_null() if group is None else pl.col(q.group) == group
                )
            )
            selected_counts, _ = np.histogram(selected_subset[q.y].to_numpy().astype(float), bins=edges)
            for i, count in enumerate(counts):
                bins.append(
                    {
                        "lo": float(edges[i]),
                        "hi": float(edges[i + 1]),
                        "count": int(count),
                        "selected": int(selected_counts[i]),
                        "last": i == len(counts) - 1,
                        "group": group,
                    }
                )
        result.update(bins=bins, rendered=len(values))
    elif q.kind == "box":
        groups = [None] if not q.group else frame[q.group].unique(maintain_order=True).to_list()
        if len(groups) > 100:
            raise ValueError("層別値が100種類を超えています。条件を絞ってください。")
        summaries = []
        outlier_parts = []
        for group in groups:
            subset = (
                clean_frame
                if not q.group
                else clean_frame.filter(
                    pl.col(q.group).is_null() if group is None else pl.col(q.group) == group
                )
            )
            arr = subset[q.y].to_numpy().astype(float)
            if not len(arr):
                continue
            q1, median, q3 = np.quantile(arr, [0.25, 0.5, 0.75])
            within = arr[(arr >= q1 - 1.5 * (q3 - q1)) & (arr <= q3 + 1.5 * (q3 - q1))]
            outlier_parts.append(
                subset.filter((pl.col(q.y) < q1 - 1.5 * (q3 - q1)) | (pl.col(q.y) > q3 + 1.5 * (q3 - q1)))
            )
            summaries.append(
                {
                    "group": group,
                    "n": len(arr),
                    "q1": q1,
                    "median": median,
                    "q3": q3,
                    "selected": subset.filter(pl.col(ROW_ID).is_in(highlight_ids)).height,
                    "mean": np.mean(arr),
                    "std": np.std(arr, ddof=1) if len(arr) > 1 else None,
                    "min": np.min(arr),
                    "max": np.max(arr),
                    "low": within.min() if len(within) else q1,
                    "high": within.max() if len(within) else q3,
                }
            )
        outliers = pl.concat(outlier_parts) if outlier_parts else clean_frame.head(0)
        outlier_count = outliers.height
        if outliers.height > q.max_points:
            outliers = outliers.sample(n=q.max_points, seed=42)
        outlier_columns = list(dict.fromkeys([ROW_ID, q.y] + ([q.group] if q.group else [])))
        result.update(
            groups=summaries,
            rendered=clean_frame.height,
            outliers=outliers.select(outlier_columns).to_dicts(),
            outlier_count=outlier_count,
        )
    else:
        cols = [x["name"] for x in schema_info(frame) if x["kind"] == "number"][:20]
        values, counts = [], []
        for a in cols:
            valrow, nrow = [], []
            for b in cols:
                sub = frame.select(list(dict.fromkeys([a, b]))).drop_nulls()
                nrow.append(sub.height)
                v = (
                    np.corrcoef(sub[a].to_numpy().astype(float), sub[b].to_numpy().astype(float))[0, 1]
                    if sub.height > 1 and sub[a].std() and sub[b].std()
                    else None
                )
                valrow.append(v)
            values.append(valrow)
            counts.append(nrow)
        result.update(columns=cols, values=values, counts=counts, rendered=frame.height)
    return clean(result)
