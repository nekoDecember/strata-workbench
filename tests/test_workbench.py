import io
import json

import pandas as pd
import polars as pl
import pytest
from fastapi.testclient import TestClient

from strata.models import ROW_ID
from strata.worker import execute

from conftest import TOKEN


def test_auth_cookie_csrf_and_no_token_leak(app):
    with TestClient(app) as c:
        assert c.get("/api/datasets").status_code == 401
        assert c.post("/api/login", json={"token": "incorrect"}).status_code == 401
        r = c.post("/api/login", json={"token": TOKEN})
        assert r.status_code == 200
        assert "HttpOnly" in r.headers["set-cookie"]
        assert "SameSite=strict" in r.headers["set-cookie"]
        assert TOKEN not in r.text + r.headers["set-cookie"]
        assert c.get("/api/datasets").status_code == 200
        assert c.post("/api/demo", headers={"Origin": "https://unrelated.example"}).status_code == 403
        c.post("/api/logout")
        assert c.get("/api/datasets").status_code == 401


def test_selection_is_not_filtering_and_ids_survive_sort(client, dataset):
    url = f"/api/datasets/{dataset['id']}"
    r = client.post(url + "/table", json={"selected_ids": [2, 0], "sort_by": "値", "descending": True}).json()
    assert r["total"] == 6
    assert r["rows"][0][ROW_ID] == 3
    r = client.post(url + "/table", json={"selected_ids": [2, 0], "selection_only": True}).json()
    assert {x[ROW_ID] for x in r["rows"]} == {0, 2}
    empty = client.post(url + "/table", json={"selection_only": True, "selected_ids": []}).json()
    assert empty["total"] == 0
    excluded = client.post(url + "/table", json={"excluded_ids": [0, 2]}).json()
    assert excluded["total"] == 4


def test_filters_are_typed_null_aware_and_not_evaluated(client, dataset):
    url = f"/api/datasets/{dataset['id']}/select"
    r = client.post(
        url,
        json={
            "criteria": [
                {"column": "設備", "op": "eq", "value": "A"},
                {"column": "値", "op": "ge", "value": 2},
            ]
        },
    ).json()
    assert r["ids"] == [2]
    assert (
        client.post(url, json={"criteria": [{"column": "設備", "op": "in", "value": ["A", None]}]}).json()[
            "count"
        ]
        == 4
    )
    assert (
        client.post(url, json={"criteria": [{"column": "設備", "op": "contains", "value": ".*"}]}).json()[
            "count"
        ]
        == 0
    )
    assert (
        client.post(url, json={"criteria": [{"column": "missing", "op": "eq", "value": 1}]}).status_code
        == 400
    )
    assert (
        client.post(
            url, json={"criteria": [{"column": "値", "op": "ge", "value": "not-a-number"}]}
        ).status_code
        == 400
    )


def test_datetime_filter(client, dataset):
    r = client.post(
        f"/api/datasets/{dataset['id']}/table",
        json={"filters": [{"column": "時刻", "op": "ge", "value": "2026-08-01T03:00:00"}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 3


def test_histogram_counts_include_all_rows_and_bin_brush_is_exact(client, dataset):
    base = f"/api/datasets/{dataset['id']}"
    r = client.post(
        base + "/chart",
        json={"kind": "histogram", "y": "値", "group": "設備", "bins": 5, "selected_ids": [0, 2]},
    ).json()
    assert sum(b["count"] for b in r["bins"]) == 5
    assert sum(b["selected"] for b in r["bins"]) == 2
    for b in r["bins"]:
        criteria = [
            {"column": "値", "op": "ge", "value": b["lo"]},
            {"column": "値", "op": "le" if b["last"] else "lt", "value": b["hi"]},
            {"column": "設備", "op": "eq", "value": b["group"]},
        ]
        selected = client.post(base + "/select", json={"criteria": criteria})
        assert selected.status_code == 200
        assert selected.json()["count"] == b["count"]


def test_box_stats_and_selected_profile(client, dataset):
    base = f"/api/datasets/{dataset['id']}"
    r = client.post(
        base + "/chart", json={"kind": "box", "y": "値", "group": "設備", "selected_ids": [0, 2]}
    ).json()
    a = next(g for g in r["groups"] if g["group"] == "A")
    assert a["mean"] == 2 and a["median"] == 2 and a["selected"] == 2 and a["n"] == 2
    p = client.post(base + "/profile", json={"selected_ids": [0, 2]}).json()
    assert p["total"] == 6 and p["selected_count"] == 2
    assert next(c for c in p["selected_columns"] if c["name"] == "値")["mean"] == 2


def test_sampling_does_not_change_full_profile_or_histogram(client, app):
    df = pl.DataFrame({"v": [float(i) for i in range(10050)], "x": list(range(10050))})
    d = app.state.store.create(df, "large")
    base = f"/api/datasets/{d['id']}"
    a = client.post(base + "/chart", json={"kind": "scatter", "x": "x", "y": "v", "max_points": 100}).json()
    b = client.post(base + "/chart", json={"kind": "scatter", "x": "x", "y": "v", "max_points": 100}).json()
    assert a["sampled"] and a["rendered"] == 100 and a["total"] == 10050 and a["points"] == b["points"]
    hist = client.post(base + "/chart", json={"kind": "histogram", "y": "v"}).json()
    assert sum(b["count"] for b in hist["bins"]) == 10050
    exported = pd.read_parquet(io.BytesIO(client.post(base + "/export", json={}).content))
    assert len(exported) == 10050


def test_edit_creates_revision_and_rejects_stale_write(client, dataset):
    base = f"/api/datasets/{dataset['id']}"
    edit = {"revision": 1, "row_id": 0, "column": "値", "value": 7}
    assert client.post(base + "/edit", json=edit).json()["current_revision"] == 2
    assert client.post(base + "/table", json={"revision": 1}).json()["rows"][0]["値"] == 1
    assert client.post(base + "/table", json={"revision": 2}).json()["rows"][0]["値"] == 7
    assert client.post(base + "/edit", json=edit).status_code == 409
    assert client.post(base + "/edit", json={**edit, "revision": 2, "column": ROW_ID}).status_code == 400


def test_type_cast_is_strict_and_reversible(client, dataset):
    base = f"/api/datasets/{dataset['id']}"
    assert (
        client.post(base + "/cast", json={"revision": 1, "column": "設備", "dtype": "number"}).status_code
        == 400
    )
    assert client.get(base).json()["current_revision"] == 1
    assert (
        client.post(base + "/cast", json={"revision": 1, "column": "値", "dtype": "text"}).status_code == 200
    )
    assert next(c for c in client.get(base).json()["schema"] if c["name"] == "値")["kind"] == "text"


def test_import_cp932_excel_parquet_and_reserved_id(client):
    csv = "設備,値\n設備一,1.5\n".encode("cp932")
    assert (
        client.post(
            "/api/datasets", files={"file": ("test.csv", csv)}, data={"encoding": "cp932"}
        ).status_code
        == 200
    )
    output = io.BytesIO()
    pd.DataFrame({"設備": ["A"], "値": [3.1]}).to_excel(output, index=False, sheet_name="測定")
    assert (
        client.post(
            "/api/datasets", files={"file": ("test.xlsx", output.getvalue())}, data={"sheet": "測定"}
        ).status_code
        == 200
    )
    data = io.BytesIO()
    pl.DataFrame({ROW_ID: [42], "v": [1.2]}).write_parquet(data)
    assert client.post("/api/datasets", files={"file": ("test.parquet", data.getvalue())}).status_code == 400
    d = client.post(
        "/api/datasets", files={"file": ("test.parquet", data.getvalue())}, data={"preserve_ids": "true"}
    ).json()
    assert client.post(f"/api/datasets/{d['id']}/table", json={}).json()["rows"][0][ROW_ID] == 42


def test_python_roundtrip_linked_table_selection_and_publish(client, app, dataset, monkeypatch):
    monkeypatch.setenv("DATABASE_PASSWORD", "must-not-reach-python")
    code = """import os
assert 'DATABASE_PASSWORD' not in os.environ
assert 'STRATA_TOKEN_FILE' not in os.environ
assert len(df) == 3 and len(selected) == 1
out = df.copy()
out['double'] = out['値'] * 2
wb.show(pd.DataFrame({'mean': [df['値'].mean()]}), name='summary', row_ids=[df['__row_id'].tolist()])
wb.publish(out, name='derived')
wb.select(selected['__row_id'].tolist(), name='selection')
print('round-trip ok')
"""
    base = f"/api/datasets/{dataset['id']}"
    j = client.post(
        base + "/python",
        json={
            "code": code,
            "revision": 1,
            "selected_ids": [2],
            "filters": [{"column": "設備", "op": "eq", "value": "A"}],
            "context": {"y": "値"},
        },
    )
    assert j.status_code == 200, j.text
    job_id = j.json()["id"]
    execute(app.state.jobs.path(job_id))
    result = client.get(f"/api/jobs/{job_id}").json()
    assert result["status"] == "succeeded", result
    assert "round-trip ok" in result["stdout"]
    assert result["artifacts"][0]["row_ids"] == [[0, 2, 4]]
    assert result["artifacts"][2]["ids"] == [2]
    filename = result["artifacts"][1]["file"]
    published = client.post(f"/api/jobs/{job_id}/publish/{filename}").json()
    assert published["parent"]["dataset_id"] == dataset["id"]
    rows = client.post(f"/api/datasets/{published['id']}/table", json={}).json()["rows"]
    assert [r[ROW_ID] for r in rows] == [0, 2, 4]
    assert rows[1]["double"] == 6
    assert client.post(base + "/table", json={}).json()["total"] == 6
    assert client.get(f"/api/jobs/{job_id}/artifacts/request.json").status_code == 404


def test_failed_python_never_changes_dataset_and_bad_links_fail(client, app, dataset):
    base = f"/api/datasets/{dataset['id']}"
    for code in ["raise ValueError('intentional')", "wb.show(pd.DataFrame({'v':[1]}), row_ids=[[999]])"]:
        j = client.post(base + "/python", json={"code": code}).json()
        execute(app.state.jobs.path(j["id"]))
        result = client.get(f"/api/jobs/{j['id']}").json()
        assert result["status"] == "failed"
        assert client.get(base).json()["current_revision"] == 1


def test_timeout_and_cancellation(client, app, dataset):
    base = f"/api/datasets/{dataset['id']}"
    j = client.post(base + "/python", json={"code": "while True: pass"}).json()
    execute(app.state.jobs.path(j["id"]), timeout=1)
    assert client.get(f"/api/jobs/{j['id']}").json()["status"] == "timed_out"
    j = client.post(base + "/python", json={"code": "print('should not run')"}).json()
    client.post(f"/api/jobs/{j['id']}/cancel")
    execute(app.state.jobs.path(j["id"]))
    result = client.get(f"/api/jobs/{j['id']}").json()
    assert result["status"] == "cancelled" and not result.get("stdout")


def test_notebook_has_fixed_revision_and_no_credentials(client, dataset):
    r = client.post(
        f"/api/datasets/{dataset['id']}/notebook",
        json={"view": {"selected_ids": [0, 2]}, "code": "print(len(df))"},
    )
    assert r.status_code == 200
    nb = r.json()
    assert nb["nbformat"] == 4 and TOKEN not in r.text
    source = "".join(nb["cells"][1]["source"])
    assert "'revision': 1" in source and "Client.from_env()" in source
    compile(source, "notebook", "exec")


def test_state_persists_on_app_restart(client, app, dataset, tmp_path):
    from strata.api import create_app

    state = {"view": {"revision": 1, "selected_ids": [0, 3]}, "pins": [{"title": "test"}], "code": "print(1)"}
    base = f"/api/datasets/{dataset['id']}"
    assert client.put(base + "/state", json=state).status_code == 200
    restarted = create_app(tmp_path / "data", tmp_path / "jobs", token=TOKEN)
    with TestClient(restarted) as c:
        c.headers["Authorization"] = "Bearer " + TOKEN
        assert c.get(base + "/state").json() == state
        assert c.post(base + "/table", json={}).json()["total"] == 6


def test_secret_connection_names_only(client, monkeypatch, tmp_path):
    path = tmp_path / "connections.json"
    path.write_text(
        json.dumps({"warehouse": {"dsn": "postgresql://private-user:private-pass@internal.invalid/db"}})
    )
    monkeypatch.setenv("STRATA_CONNECTIONS_FILE", str(path))
    response = client.get("/api/connections")
    assert response.json() == ["warehouse"] and "private-pass" not in response.text


def test_pairwise_correlation_uses_exact_valid_pairs(client, dataset):
    r = client.post(f"/api/datasets/{dataset['id']}/chart", json={"kind": "correlation", "y": "値"}).json()
    assert r["columns"] == ["値", "温度"]
    assert r["counts"][0][1] == 5 and r["values"][0][0] == pytest.approx(1)


def test_static_frontend_entry(app):
    with TestClient(app) as c:
        r = c.get("/")
        assert r.status_code == 200
        assert "Strata" in r.text and 'src="/assets/' in r.text


def test_box_outliers_have_stable_row_links(client, app):
    d = app.state.store.create(pl.DataFrame({"v": [1.0, 2.0, 2.0, 3.0, 100.0]}), "outliers")
    r = client.post(f"/api/datasets/{d['id']}/chart", json={"kind": "box", "y": "v"}).json()
    assert r["outlier_count"] == 1 and r["outliers"][0][ROW_ID] == 4
    assert r["groups"][0]["max"] == 100 and r["groups"][0]["high"] == 3


def test_decimal_data_is_preserved_in_parquet_and_plottable(client, app):
    from decimal import Decimal

    frame = pl.DataFrame({"v": [Decimal("1.10"), Decimal("1.20"), Decimal("1.90")], "x": [1.0, 2.0, 3.0]})
    d = app.state.store.create(frame, "decimal")
    base = f"/api/datasets/{d['id']}"
    assert client.post(base + "/profile", json={}).status_code == 200
    for kind in ["scatter", "box", "histogram", "correlation"]:
        r = client.post(base + "/chart", json={"kind": kind, "x": "x", "y": "v"})
        assert r.status_code == 200, r.text
    data = client.post(base + "/chart", json={"kind": "histogram", "y": "v", "bins": 5}).json()
    for b in data["bins"]:
        q = {
            "criteria": [
                {"column": "v", "op": "ge", "value": b["lo"]},
                {"column": "v", "op": "le" if b["last"] else "lt", "value": b["hi"]},
            ]
        }
        assert client.post(base + "/select", json=q).json()["count"] == b["count"]
    output = pl.read_parquet(io.BytesIO(client.post(base + "/export", json={}).content))
    assert output["v"].to_list() == frame["v"].to_list()


def test_snapshot_membership_and_live_highlight_are_separate(client, dataset):
    r = client.post(
        f"/api/datasets/{dataset['id']}/chart",
        json={
            "kind": "box",
            "y": "値",
            "group": "設備",
            "selection_only": True,
            "selected_ids": [0, 2],
            "highlight_ids": [0],
        },
    ).json()
    assert r["total"] == 2 and r["groups"][0]["selected"] == 1


def test_high_cardinality_group_is_rejected(client, app):
    d = app.state.store.create(
        pl.DataFrame({"group": [str(i) for i in range(101)], "v": range(101)}), "many groups"
    )
    assert (
        client.post(
            f"/api/datasets/{d['id']}/chart", json={"kind": "scatter", "y": "v", "group": "group"}
        ).status_code
        == 400
    )
