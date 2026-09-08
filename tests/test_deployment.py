from pathlib import Path
import runpy

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_compose_credential_boundary():
    config = yaml.safe_load((ROOT / "compose.yaml").read_text())
    worker = config["services"]["worker"]
    assert worker["network_mode"] == "none"
    assert "secrets" not in worker
    assert worker["volumes"] == ["jobs:/jobs"]
    assert worker["read_only"] is True
    assert "ALL" in worker["cap_drop"]
    app = config["services"]["app"]
    assert app["secrets"] == ["app_token", "connections"]
    assert "127.0.0.1" in app["ports"][0]
    notebook = config["services"]["notebook"]
    assert "connections" not in notebook["secrets"]
    assert notebook["profiles"] == ["notebook"]
    assert all("docker.sock" not in v for s in config["services"].values() for v in s.get("volumes", []))


def test_notebook_configuration_does_not_put_token_in_argv(monkeypatch, tmp_path):
    import pytest

    pytest.importorskip("jupyterlab")
    from jupyterlab.labapp import LabApp

    path = tmp_path / "notebook-token"
    path.write_text("test-notebook-token")
    monkeypatch.setenv("JUPYTER_TOKEN_FILE", str(path))
    captured = {}
    monkeypatch.setattr(LabApp, "launch_instance", lambda **kwargs: captured.update(kwargs))
    runpy.run_path(str(ROOT / "scripts/start_notebook.py"))
    assert captured["config"].IdentityProvider.token == "test-notebook-token"
    assert captured["config"].ServerApp.log_level == "WARNING"
    assert "argv" not in captured
