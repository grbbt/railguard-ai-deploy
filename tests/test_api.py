from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.detector import DatasetStore, Settings
from backend.synthetic import generate_dataset


@pytest.fixture(scope="module")
def application(tmp_path_factory):
    store = DatasetStore(Settings(n_estimators=64))
    raw = generate_dataset().to_csv(index=False).encode()
    dataset = store.ingest(raw, "demo.csv", "synthetic")
    app = create_app(store, tmp_path_factory.mktemp("orders") / "orders.sqlite3")
    with TestClient(app) as client:
        yield app, client, dataset, raw


def test_api_health_and_shared_dashboard_detail(application):
    app, client, dataset, _ = application
    assert client.get("/api/health").json() == {"status": "ok", "version": "0.1.0"}
    dashboard = client.get("/api/dashboard", params={"dataset": dataset["dataset"]["id"]})
    assert dashboard.status_code == 200
    detail = client.get(f"/api/analysis/{dataset['dataset']['id']}/RG-101/bogies")
    assert detail.status_code == 200
    summary = next(item for item in dashboard.json()["components"] if item["train_id"] == "RG-101" and item["component"] == "bogies")
    for key in ("status", "risk", "health", "anomaly_count", "observations", "onset"):
        assert detail.json()[key] == summary[key]


def test_upload_export_and_cache(application):
    app, client, _, raw = application
    response = client.post("/api/datasets", files={"file": ("uploaded.csv", raw, "text/csv")})
    assert response.status_code == 200
    dataset = response.json()
    assert dataset["dataset"]["source"] == "uploaded"
    assert not dataset["evaluation"]["available"]
    assert dataset["dataset"]["rows"] == 9216
    fits = app.state.datasets.fit_count
    repeated = client.post("/api/datasets", files={"file": ("same.csv", raw, "text/csv")})
    assert repeated.json()["model"]["cache_hit"]
    assert app.state.datasets.fit_count == fits
    exported = client.get(f"/api/datasets/{dataset['dataset']['id']}/export")
    assert exported.content == raw
    assert "attachment" in exported.headers["content-disposition"]


def test_upload_errors_are_strings_and_have_no_tracebacks(application):
    _, client, _, _ = application
    for response in (
        client.post("/api/datasets", files={"file": ("wrong.txt", b"abc", "text/plain")}),
        client.post("/api/datasets", files={"file": ("no-sensor.csv", b"timestamp,id,label\n2026-01-01,1,1\n", "text/csv")}),
        client.post("/api/datasets"),
        client.get("/api/analysis/missing/train/bogies"),
        client.post("/api/orders", json={"dataset_id": "a", "train_id": "b", "component": "c", "action": "untrusted client advice"}),
        client.patch("/api/orders/no-order", json={"status": "invalid"}),
    ):
        assert 400 <= response.status_code < 500
        assert isinstance(response.json()["detail"], str)
        assert "Traceback" not in response.text


def test_upload_size_rejected_without_truncation(application, monkeypatch):
    _, client, _, _ = application
    monkeypatch.setattr("backend.api.MAX_UPLOAD_BYTES", 32)
    response = client.post("/api/datasets", files={"file": ("oversize.csv", b"x" * 33, "text/csv")})
    assert response.status_code == 413
    assert "no rows" in response.json()["detail"].lower()


def test_order_derived_idempotent_transitions_and_health_independence(application):
    _, client, dataset, _ = application
    dataset_id = dataset["dataset"]["id"]
    body = {"dataset_id": dataset_id, "train_id": "RG-101", "component": "bogies"}
    before = client.get("/api/dashboard", params={"dataset": dataset_id}).json()
    first = client.post("/api/orders", json=body)
    assert first.status_code == 200
    first = first.json()
    assert first == client.post("/api/orders", json=body).json()
    detail = client.get(f"/api/analysis/{dataset_id}/RG-101/bogies").json()
    assert first["priority"] == detail["explanation"]["priority"]
    assert first["issue"] == detail["explanation"]["possible_cause"]
    assert detail["evidence_time"] in first["action"]
    progress = client.patch(f"/api/orders/{first['id']}", json={"status": "in_progress"})
    assert progress.status_code == 200
    assert progress.json() == client.patch(f"/api/orders/{first['id']}", json={"status": "in_progress"}).json()
    completed = client.patch(f"/api/orders/{first['id']}", json={"status": "completed"})
    assert completed.status_code == 200
    assert client.patch(f"/api/orders/{first['id']}", json={"status": "open"}).status_code == 409
    second = client.post("/api/orders", json=body).json()
    assert second["id"] != first["id"]
    after = client.get("/api/dashboard", params={"dataset": dataset_id}).json()
    assert before["totals"] == after["totals"]
    assert before["trains"] == after["trains"]
    assert all(order["dataset_id"] == dataset_id for order in client.get("/api/orders", params={"dataset_id": dataset_id}).json()["orders"])


def test_concurrent_order_creation_has_one_active_record(application):
    app, _, dataset, _ = application
    detail = app.state.datasets.detail(dataset["dataset"]["id"], "RG-103", "doors")
    with ThreadPoolExecutor(max_workers=6) as executor:
        records = list(executor.map(lambda _: app.state.orders.create(detail), range(12)))
    assert len({record["id"] for record in records}) == 1


def test_healthy_has_no_actionable_order_and_unknown_order_is_404(application):
    _, client, dataset, _ = application
    response = client.post("/api/orders", json={"dataset_id": dataset["dataset"]["id"], "train_id": "RG-102", "component": "doors"})
    assert response.status_code == 409
    assert client.patch("/api/orders/nonexistent", json={"status": "completed"}).status_code == 404
