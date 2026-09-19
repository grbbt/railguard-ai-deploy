"""Regression cases from independent review of uploaded-data behavior."""
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.detector import DatasetStore, Settings, parse_csv


def observations(rows=120, train="A"):
    rng = np.random.default_rng(919)
    return pd.DataFrame({"timestamp": pd.date_range("2026-01-01", periods=rows, freq="5min", tz="UTC"),
                         "train_id": train, "component": "general", "temperature": rng.normal(20, .4, rows)})


def test_sparse_custom_numeric_sensor_retains_measured_values():
    frame = observations()
    frame["damaged_sensor"] = "invalid"
    frame.loc[::4, "damaged_sensor"] = "12.5"
    parsed, meta = parse_csv(frame.to_csv(index=False).encode())
    assert "damaged_sensor" in meta["sensor_columns"]
    assert parsed["damaged_sensor"].notna().sum() == 30
    assert parsed["damaged_sensor"].dropna().eq(12.5).all()
    assert any("damaged_sensor" in warning for warning in meta["warnings"])


def test_spaced_and_camelcase_outcome_columns_never_enter_fit():
    frame = observations()
    for key in ("Ground Truth", "faultLabel", "Verified Fault", "failureFlag", "targetClass"):
        frame[key] = np.arange(len(frame)) % 2
    _, meta = parse_csv(frame.to_csv(index=False).encode())
    assert meta["sensor_columns"] == ["temperature"]


def test_excess_csv_fields_are_rejected_without_index_inference():
    raw = b"timestamp,sensor\n2026-01-01,4,5\n2026-01-02,6,7\n"
    with pytest.raises(ValueError, match="fields|columns"):
        parse_csv(raw)


def test_omitted_trailing_csv_fields_are_retained_as_missing_with_a_warning():
    parsed, meta = parse_csv(b"timestamp,sensor,other\n2026-01-01,4\n2026-01-02,6,7\n")
    assert len(parsed) == 2
    assert pd.isna(parsed.iloc[0]["other"])
    assert any("fewer fields" in warning for warning in meta["warnings"])


def test_timezone_naive_input_reports_utc_assumption():
    frame = observations()
    frame["timestamp"] = frame["timestamp"].dt.tz_localize(None)
    _, meta = parse_csv(frame.to_csv(index=False).encode())
    assert any("timezone" in warning.lower() and "UTC" in warning for warning in meta["warnings"])


def test_stopped_train_is_unknown_at_dataset_end_and_in_trend():
    frame = pd.concat([observations(120, "current"), observations(72, "stopped")], ignore_index=True)
    store = DatasetStore(Settings(n_estimators=32))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "stopped.csv")
    detail = store.detail(dashboard["dataset"]["id"], "stopped", "general")
    assert detail["status"] == "unknown"
    assert detail["risk"] is None
    assert any("older" in note or "stale" in note for note in detail["explanation"]["limitations"])
    assert dashboard["trend"][-1]["unknown"] == dashboard["totals"]["unknown"]


def test_slower_regular_sensor_does_not_get_a_faster_groups_cadence():
    slow = observations(60, "slow")
    slow["timestamp"] = pd.date_range("2026-01-01", periods=60, freq="10min", tz="UTC")
    frame = pd.concat([observations(120, "fast"), slow], ignore_index=True)
    store = DatasetStore(Settings(n_estimators=32))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "mixed-cadence.csv")
    assert store.detail(dashboard["dataset"]["id"], "slow", "general")["status"] != "unknown"


def test_sustained_covariance_anomaly_is_not_vetoed_by_marginal_deviation():
    frame = observations(500)
    rng = np.random.default_rng(4)
    base = rng.uniform(-1, 1, len(frame))
    frame["temperature"] = base
    frame["pressure"] = base + rng.normal(0, .005, len(frame))
    frame.loc[300:, "temperature"] = np.where(np.arange(200) % 2, -.9, .9)
    frame.loc[300:, "pressure"] = -frame.loc[300:, "temperature"]
    store = DatasetStore(Settings(n_estimators=64))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "joint-anomaly.csv")
    detail = store.detail(dashboard["dataset"]["id"], "A", "general")
    assert sum(point["anomaly"] for point in detail["points"][-24:]) >= 16
    assert detail["status"] == "warning"


def test_a_single_valid_recent_observation_cannot_claim_sustained_condition():
    frame = observations()
    frame.loc[96:118, "temperature"] = np.nan
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "almost-missing.csv")
    detail = store.detail(dashboard["dataset"]["id"], "A", "general")
    assert detail["status"] == "unknown"
    assert detail["risk"] is None


def test_csv_source_markers_do_not_unlock_synthetic_evaluation(tmp_path):
    frame = observations()
    frame["source"] = "synthetic"
    frame["injected_anomaly"] = np.arange(len(frame)) % 2
    frame["scenario"] = "mixed"
    app = create_app(DatasetStore(Settings(n_estimators=24)), tmp_path / "orders.db")
    with TestClient(app) as client:
        response = client.post("/api/datasets", files={"file": ("synthetic.csv", frame.to_csv(index=False).encode(), "text/csv")}, data={"source": "synthetic"})
    assert response.status_code == 200
    result = response.json()
    assert result["dataset"]["source"] == "uploaded"
    assert not result["evaluation"]["available"]
    assert result["model"]["features"] == ["temperature"]


def test_concurrent_ingests_reuse_one_fit_and_failed_input_does_not_poison_cache():
    store = DatasetStore(Settings(n_estimators=24))
    with pytest.raises(ValueError):
        store.ingest(b"bad", "bad.csv")
    raw = observations().to_csv(index=False).encode()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: store.ingest(raw, "same.csv"), range(4)))
    assert len({result["dataset"]["id"] for result in results}) == 1
    assert store.fit_count == 1
    assert sum(not result["model"]["cache_hit"] for result in results) == 1


def test_analysis_query_can_address_identifiers_with_slashes(tmp_path):
    frame = observations(train="Train/Line A")
    frame["component"] = "Door/Left"
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "slashes.csv")
    app = create_app(store, tmp_path / "orders.db")
    with TestClient(app) as client:
        response = client.get("/api/analysis", params={"dataset_id": dashboard["dataset"]["id"], "train_id": "Train/Line A", "component": "Door/Left"})
    assert response.status_code == 200
    assert response.json()["train_id"] == "Train/Line A"
    assert response.json()["component"] == "Door/Left"
