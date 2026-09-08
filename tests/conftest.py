import pytest
from fastapi.testclient import TestClient

from strata.api import create_app
from strata.storage import atomic_json, now

TOKEN = "test-token-not-a-production-secret-123456789"


@pytest.fixture
def app(tmp_path):
    app = create_app(tmp_path / "data", tmp_path / "jobs", token=TOKEN)
    atomic_json(app.state.jobs.root / "heartbeat.json", {"at": now()})
    return app


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        c.headers["Authorization"] = "Bearer " + TOKEN
        yield c


@pytest.fixture
def dataset(client):
    content = "設備,値,温度,時刻\nA,1,21,2026-08-01T00:00:00\nB,20,23,2026-08-01T01:00:00\nA,3,22,2026-08-01T02:00:00\nB,22,24,2026-08-01T03:00:00\nA,,25,2026-08-01T04:00:00\n,5,26,2026-08-01T05:00:00\n"
    response = client.post("/api/datasets", files={"file": ("process.csv", content.encode())})
    assert response.status_code == 200, response.text
    return response.json()
