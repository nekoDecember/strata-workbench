import hashlib
import hmac
import io
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

import polars as pl
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .analysis import apply_view, chart, filter_expr, profile, schema_info
from .execution import Jobs
from .models import (
    ROW_ID,
    CastColumn,
    CellEdit,
    ChartQuery,
    ImportSql,
    PythonRequest,
    SelectionQuery,
    TableQuery,
    ViewQuery,
)
from .storage import Store, clean, demo_frame


class Login(BaseModel):
    token: str = Field(max_length=1000)


def read_secret(env_name, default=None):
    filename = os.getenv(env_name, default)
    return Path(filename).read_text().strip() if filename and Path(filename).is_file() else ""


def read_frame(content, filename, encoding="utf-8", separator=",", sheet="", preserve_ids=False):
    ext = Path(filename).suffix.lower()
    if ext in (".csv", ".tsv", ".txt"):
        if encoding not in ("utf-8", "utf-8-sig", "cp932", "shift_jis"):
            raise ValueError("サポートされていない文字コードです。")
        sep = "\t" if ext == ".tsv" else separator
        if len(sep.encode()) != 1:
            raise ValueError("区切り文字は1バイト文字を指定してください。")
        frame = pl.read_csv(
            io.BytesIO(content.decode(encoding).encode("utf-8")),
            separator=sep,
            infer_schema_length=10000,
            try_parse_dates=True,
        )
    elif ext == ".parquet":
        frame = pl.read_parquet(io.BytesIO(content))
    elif ext == ".xlsx":
        import pandas as pd

        frame = pl.from_pandas(pd.read_excel(io.BytesIO(content), sheet_name=sheet or 0, engine="openpyxl"))
    else:
        raise ValueError("CSV / TSV / Parquet / XLSXに対応しています。")
    return frame


def create_app(data_dir=None, jobs_dir=None, token=None, static_dir=None):
    token = token if token is not None else read_secret("STRATA_TOKEN_FILE", "/run/secrets/app_token")
    if len(token) < 24:
        raise RuntimeError(
            "STRATA_TOKEN_FILEに24文字以上のアクセストークンを設定してください。scripts/setup.pyで生成できます。"
        )
    store = Store(data_dir or os.getenv("STRATA_DATA_DIR", "/data"))
    jobs = Jobs(jobs_dir or os.getenv("STRATA_JOBS_DIR", "/jobs"))
    app = FastAPI(title="Strata Workbench", version="0.1.0", docs_url=None, redoc_url=None)
    app.state.store, app.state.jobs = store, jobs
    failures = {}

    def session_cookie():
        expires = str(int(time.time()) + 86400)
        signature = hmac.new(token.encode(), expires.encode(), hashlib.sha256).hexdigest()
        return expires + "." + signature

    def cookie_ok(value):
        try:
            expires, signature = value.split(".", 1)
            expected = hmac.new(token.encode(), expires.encode(), hashlib.sha256).hexdigest()
            return int(expires) > time.time() and hmac.compare_digest(expected, signature)
        except (ValueError, AttributeError):
            return False

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and path not in ("/api/health", "/api/login"):
            bearer = request.headers.get("authorization", "")
            authenticated = bearer.startswith("Bearer ") and secrets.compare_digest(
                bearer[7:].encode(), token.encode()
            )
            if not authenticated and not cookie_ok(request.cookies.get("strata_session")):
                return JSONResponse({"detail": "ログインしてください。"}, status_code=401)
        if path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail": "Origin mismatch"}, status_code=403)
            try:
                if int(request.headers.get("content-length", "0")) > 140 * 1024 * 1024:
                    return JSONResponse({"detail": "アップロード上限は128MiBです。"}, status_code=413)
            except ValueError:
                return JSONResponse({"detail": "Invalid content length"}, status_code=400)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ValueError)
    async def bad_input(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def not_found(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(RuntimeError)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(pl.exceptions.PolarsError)
    async def polars_error(request, exc):
        return JSONResponse(
            {"detail": "列の型と操作が一致しません。型・条件・入力データを確認してください。"},
            status_code=400,
        )

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/login")
    def login(body: Login, request: Request):
        key = request.client.host if request.client else "local"
        recent = [t for t in failures.get(key, []) if time.time() - t < 60]
        if len(recent) >= 10:
            raise HTTPException(429, "少し待ってから再試行してください。")
        if not secrets.compare_digest(body.token.encode(), token.encode()):
            failures[key] = recent + [time.time()]
            raise HTTPException(401, "トークンが一致しません。")
        failures.pop(key, None)
        response = JSONResponse({"ok": True})
        response.set_cookie(
            "strata_session",
            session_cookie(),
            httponly=True,
            samesite="strict",
            max_age=86400,
            secure=request.url.scheme == "https",
        )
        return response

    @app.post("/api/logout")
    def logout():
        response = JSONResponse({"ok": True})
        response.delete_cookie("strata_session")
        return response

    @app.get("/api/session")
    def session():
        return {"authenticated": True, "worker_available": jobs.heartbeat()}

    @app.get("/api/datasets")
    def datasets():
        return store.list()

    @app.post("/api/demo")
    def demo():
        return store.create(
            demo_frame(), "工程測定サンプル · 合成データ", operation="synthetic demo, seed=42"
        )

    @app.post("/api/datasets")
    async def upload(
        file: UploadFile = File(...),
        name: str = Form(""),
        encoding: str = Form("utf-8"),
        separator: str = Form(","),
        sheet: str = Form(""),
        preserve_ids: bool = Form(False),
    ):
        content = await file.read(128 * 1024 * 1024 + 1)
        if len(content) > 128 * 1024 * 1024:
            raise HTTPException(413, "アップロード上限は128MiBです。")
        frame = read_frame(content, file.filename or "data.csv", encoding, separator, sheet)
        return store.create(
            frame,
            name or Path(file.filename or "Dataset").stem,
            operation=f"file: {Path(file.filename or 'upload').name}",
            preserve_ids=preserve_ids,
        )

    @app.get("/api/datasets/{dataset_id}")
    def dataset(dataset_id: str, revision: int | None = None):
        frame = store.frame(dataset_id, revision)
        return {
            **store.meta(dataset_id),
            "revision": store.resolve_revision(dataset_id, revision),
            "schema": schema_info(frame),
        }

    @app.get("/api/datasets/{dataset_id}/state")
    def state(dataset_id: str):
        return store.state(dataset_id)

    @app.put("/api/datasets/{dataset_id}/state")
    def save_state(dataset_id: str, body: dict):
        store.save_state(dataset_id, body)
        return {"ok": True}

    @app.post("/api/datasets/{dataset_id}/table")
    def table(dataset_id: str, q: TableQuery):
        frame = apply_view(store.frame(dataset_id, q.revision), q)
        return clean(
            {
                "rows": frame.slice(q.offset, q.limit).to_dicts(),
                "total": frame.height,
                "offset": q.offset,
                "schema": schema_info(frame),
                "revision": store.resolve_revision(dataset_id, q.revision),
            }
        )

    @app.post("/api/datasets/{dataset_id}/profile")
    def describe(dataset_id: str, q: ViewQuery):
        frame = apply_view(store.frame(dataset_id, q.revision), q)
        selected = frame.filter(pl.col(ROW_ID).is_in(q.selected_ids))
        return {
            "total": frame.height,
            "selected_count": selected.height,
            "columns": profile(frame),
            "selected_columns": profile(selected) if selected.height else [],
        }

    @app.post("/api/datasets/{dataset_id}/chart")
    def plot(dataset_id: str, q: ChartQuery):
        return chart(apply_view(store.frame(dataset_id, q.revision), q), q)

    @app.post("/api/datasets/{dataset_id}/select")
    def select(dataset_id: str, q: SelectionQuery):
        frame = apply_view(store.frame(dataset_id, q.revision), q)
        for f in q.criteria:
            frame = frame.filter(filter_expr(frame, f))
        if frame.height > 200_000:
            raise ValueError("一度に選択できるのは20万行までです。期間などで絞り込んでください。")
        return {"ids": frame[ROW_ID].to_list(), "count": frame.height}

    @app.post("/api/datasets/{dataset_id}/export")
    def export(dataset_id: str, q: ViewQuery, format: str = "parquet"):
        frame = apply_view(store.frame(dataset_id, q.revision), q)
        if format == "csv":
            # Raw analytical data: no silent prefixing or alteration of cells.
            return Response(
                frame.write_csv().encode("utf-8-sig"),
                media_type="text/csv",
                headers={"Content-Disposition": 'attachment; filename="strata-data.csv"'},
            )
        output = io.BytesIO()
        frame.write_parquet(output)
        return Response(
            output.getvalue(),
            media_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="strata-data.parquet"'},
        )

    @app.post("/api/datasets/{dataset_id}/edit")
    def edit(dataset_id: str, q: CellEdit):
        frame = store.frame(dataset_id, q.revision)
        if q.column == ROW_ID or q.column not in frame.columns:
            raise ValueError("この列は編集できません。")
        if q.row_id not in frame[ROW_ID]:
            raise ValueError("対象行が存在しません。")
        if frame.schema[q.column].is_integer() and q.value is not None:
            number = float(q.value)
            if not number.is_integer():
                raise ValueError(
                    "整数列に小数は保存できません。先に列の型を数値（Float64）へ変更してください。"
                )
        value = pl.lit(q.value).cast(frame.schema[q.column], strict=True)
        frame = frame.with_columns(
            pl.when(pl.col(ROW_ID) == q.row_id).then(value).otherwise(pl.col(q.column)).alias(q.column)
        )
        return store.commit(dataset_id, frame, f"edit: row {q.row_id}, {q.column}", q.revision)

    @app.post("/api/datasets/{dataset_id}/cast")
    def cast(dataset_id: str, q: CastColumn):
        frame = store.frame(dataset_id, q.revision)
        if q.column not in frame.columns or q.column == ROW_ID:
            raise ValueError("この列は変更できません。")
        expr = pl.col(q.column)
        if q.dtype == "datetime":
            expr = expr.cast(pl.String).str.to_datetime(strict=True)
        else:
            expr = expr.cast(pl.Float64 if q.dtype == "number" else pl.String, strict=True)
        frame = frame.with_columns(expr)
        return store.commit(dataset_id, frame, f"type: {q.column} → {q.dtype}", q.revision)

    @app.post("/api/datasets/{dataset_id}/python")
    def python(dataset_id: str, q: PythonRequest):
        if not jobs.heartbeat():
            raise HTTPException(
                503, "Pythonワーカーが起動していません。docker composeのworkerを確認してください。"
            )
        revision = store.resolve_revision(dataset_id, q.revision)
        frame = apply_view(store.frame(dataset_id, revision), q)
        return jobs.create(frame, dataset_id, revision, q)

    @app.get("/api/jobs")
    def list_jobs(dataset_id: str | None = None):
        return jobs.list(dataset_id)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return jobs.get(job_id)

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel(job_id: str):
        return jobs.cancel(job_id)

    @app.get("/api/jobs/{job_id}/artifacts/{filename}")
    def artifact(job_id: str, filename: str):
        path = jobs.artifact(job_id, filename)
        media = {".json": "application/json", ".png": "image/png", ".txt": "text/plain"}.get(
            path.suffix, "application/octet-stream"
        )
        return FileResponse(path, media_type=media)

    @app.post("/api/jobs/{job_id}/publish/{filename}")
    def publish(job_id: str, filename: str):
        record = jobs.get(job_id)
        if record["status"] != "succeeded":
            raise ValueError("成功した実行からのみ派生データを作れます。")
        artifact = next(
            (a for a in record.get("artifacts", []) if a["file"] == filename and a["kind"] == "dataset"), None
        )
        if not artifact:
            raise ValueError("公開できるデータ出力ではありません。")
        frame = pl.read_parquet(jobs.artifact(job_id, filename))
        return store.create(
            frame,
            artifact["name"],
            operation=f"Python job {job_id}",
            parent={"dataset_id": record["dataset_id"], "revision": record["revision"], "job_id": job_id},
            preserve_ids=ROW_ID in frame.columns,
        )

    @app.get("/api/connections")
    def connections():
        raw = read_secret("STRATA_CONNECTIONS_FILE", "/run/secrets/connections")
        return list(json.loads(raw or "{}").keys())

    @app.post("/api/sql")
    def sql(body: ImportSql):
        import psycopg

        raw = read_secret("STRATA_CONNECTIONS_FILE", "/run/secrets/connections")
        conf = json.loads(raw or "{}").get(body.connection)
        if not conf:
            raise ValueError("接続が登録されていません。")
        try:
            with psycopg.connect(conf["dsn"], connect_timeout=10) as conn:
                conn.read_only = True
                with conn.cursor() as cur:
                    cur.execute("SET LOCAL statement_timeout = '30s'")
                    cur.execute(body.query)
                    if not cur.description:
                        raise ValueError("結果を返すクエリを指定してください。")
                    names = [c.name for c in cur.description]
                    rows = cur.fetchmany(200001)
                    if len(rows) > 200000:
                        raise ValueError("SQL取込の上限は20万行です。条件を絞ってください。")
                    frame = pl.DataFrame(rows, schema=names, orient="row", infer_schema_length=None)
        except ValueError:
            raise
        except Exception:
            # Driver exceptions can contain DSNs, hostnames, user names and server details.
            raise ValueError(
                "SQLの読み込みに失敗しました。接続設定と読み取り専用クエリを確認してください。"
            ) from None
        return store.create(frame, body.name, operation=f"SQL connection: {body.connection}")

    @app.post("/api/datasets/{dataset_id}/notebook")
    def notebook(dataset_id: str, body: dict):
        q = ViewQuery.model_validate(body.get("view", {}))
        q.revision = store.resolve_revision(dataset_id, q.revision)
        code = str(body.get("code", ""))[:100000]
        script = (
            "from strata.sdk import Client\n"
            "# 認証情報は STRATA_TOKEN_FILE / STRATA_TOKEN から取得します。\n"
            "client = Client.from_env()\n"
            f"dataset_id = {dataset_id!r}\n"
            f"view = {q.model_dump()!r}\n"
            "df = client.frame(dataset_id, view=view)\n"
            "selected = df[df['__row_id'].isin(view['selected_ids'])].copy()\n"
            "df.head()"
        )
        cells = [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# Strata analysis\n",
                    "保存時点のリビジョンと条件を固定しています。`df` は描画サンプルではなく対象の全行です。\n",
                    "画面と同じ `wb.show()` / `wb.publish()` を使うコードは、最後のセルでワーカーに送信できます。",
                ],
            },
            {
                "cell_type": "code",
                "metadata": {},
                "execution_count": None,
                "outputs": [],
                "source": script.splitlines(keepends=True),
            },
            {
                "cell_type": "code",
                "metadata": {},
                "execution_count": None,
                "outputs": [],
                "source": [
                    "# ローカルで通常のPython分析を実行できます。\n",
                    "display(df.describe(include='all'))",
                ],
            },
            {
                "cell_type": "code",
                "metadata": {},
                "execution_count": None,
                "outputs": [],
                "source": [
                    f"code = {code!r}\n",
                    "job = client.run(dataset_id, code, view=view, wait=True)\n",
                    "print(job.get('stdout', ''))\n",
                    "job",
                ],
            },
        ]
        result = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
            "cells": cells,
        }
        for index, cell in enumerate(cells):
            cell["id"] = f"strata-cell-{index}"
        return Response(
            json.dumps(result, ensure_ascii=False),
            media_type="application/x-ipynb+json",
            headers={"Content-Disposition": 'attachment; filename="strata-analysis.ipynb"'},
        )

    dist = Path(
        static_dir or os.getenv("STRATA_STATIC_DIR", str(Path(__file__).parent.parent / "frontend/dist"))
    )
    if dist.exists():
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/")
        def index():
            return FileResponse(dist / "index.html")

    return app
