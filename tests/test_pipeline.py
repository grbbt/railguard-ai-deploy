import io
import json

import numpy as np
import pandas as pd
import pytest

from backend.detector import DatasetStore, Settings, parse_csv
from backend.synthetic import generate_dataset


@pytest.fixture(scope="module")
def mixed():
    raw = generate_dataset().to_csv(index=False).encode()
    store = DatasetStore()
    dashboard = store.ingest(raw, "mixed.csv", "synthetic")
    return store, dashboard, raw


def custom_frame(rows=460):
    rng = np.random.default_rng(23)
    values = rng.normal(12, .2, rows)
    values[int(rows * .7):] += 9
    return pd.DataFrame({"timestamp": pd.date_range("2026-01-01", periods=rows, freq="5min", tz="UTC"),
                         "train_id": 'Train, "A"', "component": "custom", "custom_sensor": values,
                         "target": np.arange(rows), "fault_code": np.arange(rows), "numeric_id": np.arange(rows)})


def test_real_full_demo_and_expected_recent_conditions(mixed):
    store, dashboard, _ = mixed
    assert dashboard["dataset"]["rows"] == 9216
    assert dashboard["totals"]["observations"] == 9216
    assert dashboard["model"]["training_rows"] + dashboard["model"]["validation_rows"] == 9216
    assert store.fit_count == 4
    assert {key: dashboard["totals"][key] for key in ("healthy", "warning", "critical", "unknown")} == {"healthy": 3, "warning": 2, "critical": 3, "unknown": 0}
    assert dashboard["evaluation"]["available"]
    assert len(dashboard["evaluation"]["models"]) == 2
    for model in dashboard["evaluation"]["models"]:
        assert 0 <= model["auc"] <= 1
        assert model["false_positives"] >= 0
    assert "synthetic" in dashboard["evaluation"]["note"].lower()


def test_reference_precedes_monitoring_and_labels_never_enter_model(mixed):
    store, dashboard, _ = mixed
    detail = store.detail(dashboard["dataset"]["id"], "RG-101", "bogies")
    assert all("anomaly" not in key and "scenario" not in key and not key.endswith("_id") for key in detail["model"]["features"])
    reference = [point for point in detail["points"] if point["split"] == "reference"]
    monitoring = [point for point in detail["points"] if point["split"] == "monitoring"]
    assert max(point["timestamp"] for point in reference) < min(point["timestamp"] for point in monitoring)
    assert detail["onset"] == next(point["timestamp"] for point in monitoring if point["anomaly"])


def test_evidence_values_match_one_actual_observation(mixed):
    store, dashboard, raw = mixed
    detail = store.detail(dashboard["dataset"]["id"], "RG-101", "bogies")
    evidence = next(point for point in detail["points"] if point["timestamp"] == detail["evidence_time"])
    original = pd.read_csv(io.BytesIO(raw))
    original = original[(original.train_id == "RG-101") & (original.component == "bogies")]
    for feature in detail["features"]:
        assert feature["latest"] == evidence["values"][feature["key"]]
        assert original[feature["key"]].isin([feature["latest"]]).any()
    assert sum(feature["contribution"] for feature in detail["features"]) == pytest.approx(100, abs=.02)
    assert "not SHAP" in detail["explanation"]["method"]
    assert "not a verified fault" in " ".join(detail["explanation"]["limitations"])


def test_quoted_csv_all_rows_and_arbitrary_numeric_sensor():
    raw = custom_frame().to_csv(index=False).encode()
    store = DatasetStore(Settings(n_estimators=32))
    dashboard = store.ingest(raw, "quoted.csv")
    assert dashboard["dataset"]["rows"] == 460
    assert dashboard["trains"][0]["id"] == 'Train, "A"'
    assert dashboard["model"]["features"] == ["custom_sensor"]
    detail = store.detail(dashboard["dataset"]["id"], 'Train, "A"', "custom")
    assert len(detail["points"]) == 460
    assert detail["status"] == "critical"
    assert not dashboard["evaluation"]["available"]
    assert store.export(dashboard["dataset"]["id"])[0] == raw


def test_identical_content_cache_reuses_fit_and_settings_are_in_key():
    raw = custom_frame(120).to_csv(index=False).encode()
    store = DatasetStore(Settings(n_estimators=24))
    first = store.ingest(raw, "one.csv")
    assert first["model"]["cache_hit"] is False
    fits = store.fit_count
    again = store.ingest(raw, "two.csv")
    assert again["model"]["cache_hit"] is True
    assert store.fit_count == fits == 1
    again["trains"].clear()
    assert store.dashboard(first["dataset"]["id"])["trains"]
    other = DatasetStore(Settings(n_estimators=25)).ingest(raw, "one.csv")
    assert other["dataset"]["id"] != first["dataset"]["id"]


def test_sensor_and_reference_values_do_not_leak_from_monitoring():
    original = custom_frame(120)
    altered = original.copy()
    altered.loc[50:, "custom_sensor"] += 10000
    altered["target"] = 99999
    store_a, store_b = DatasetStore(Settings(n_estimators=24)), DatasetStore(Settings(n_estimators=24))
    a = store_a.ingest(original.to_csv(index=False).encode(), "a.csv")
    b = store_b.ingest(altered.to_csv(index=False).encode(), "b.csv")
    detail_a = store_a.detail(a["dataset"]["id"], 'Train, "A"', "custom")
    detail_b = store_b.detail(b["dataset"]["id"], 'Train, "A"', "custom")
    assert detail_a["features"][0]["baseline"] == detail_b["features"][0]["baseline"]
    assert [point["score"] for point in detail_a["points"][:48]] == [point["score"] for point in detail_b["points"][:48]]


def test_infinite_invalid_and_missing_readings_are_not_displayed_as_imputed():
    frame = custom_frame(120)
    frame["custom_sensor"] = frame["custom_sensor"].astype(object)
    frame.loc[10, "custom_sensor"] = np.inf
    frame.loc[11, "custom_sensor"] = "broken"
    frame.loc[12, "custom_sensor"] = -np.inf
    frame.loc[119, "custom_sensor"] = None
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "missing.csv")
    detail = store.detail(dashboard["dataset"]["id"], 'Train, "A"', "custom")
    for index in (10, 11, 12, 119):
        assert detail["points"][index]["values"]["custom_sensor"] is None
        assert detail["points"][index]["score"] is None
        assert detail["points"][index]["anomaly"] is None
    assert detail["status"] == "unknown"
    assert detail["risk"] is None
    assert detail["features"][0]["missing_count"] == 4
    json.dumps(dashboard, allow_nan=False)
    json.dumps(detail, allow_nan=False)


def test_partial_sensor_missing_uses_reference_only_imputation():
    frame = custom_frame(120)
    frame["other_sensor"] = np.linspace(30, 31, len(frame))
    frame.loc[90, "custom_sensor"] = np.nan
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "partial.csv")
    detail = store.detail(dashboard["dataset"]["id"], 'Train, "A"', "custom")
    assert detail["points"][90]["score"] is not None
    assert detail["points"][90]["values"]["custom_sensor"] is None


@pytest.mark.parametrize("raw,message", [
    (b"", "empty"),
    (b"timestamp,train_id,label\n2026-01-01T00:00:00Z,123,1\n", "No usable numeric sensor"),
    (b"value\n3\n4\n", "timestamp column"),
    (b"timestamp,value\nnot-a-time,5\n", "No valid timestamps"),
    (b'timestamp,value\n"unclosed,5\n', "Could not read"),
    (b"timestamp,value,value\n2026-01-01,5,6\n", "Column names must be unique"),
])
def test_invalid_inputs_fail_clearly(raw, message):
    with pytest.raises(ValueError, match=message):
        parse_csv(raw)


def test_invalid_timestamp_rows_are_reported_not_given_fake_times():
    frame = custom_frame(120)
    frame["timestamp"] = frame["timestamp"].astype(str)
    frame.loc[0, "timestamp"] = "unknown"
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "bad-time.csv")
    assert dashboard["dataset"]["rows"] == 120
    assert dashboard["dataset"]["excluded_rows"] == 1
    assert dashboard["totals"]["observations"] == 119


def test_insufficient_reference_is_unknown_without_claiming_a_trained_model():
    frame = custom_frame(10)
    store = DatasetStore(Settings(n_estimators=24))
    dashboard = store.ingest(frame.to_csv(index=False).encode(), "small.csv")
    detail = store.detail(dashboard["dataset"]["id"], 'Train, "A"', "custom")
    assert store.fit_count == 0
    assert detail["status"] == "unknown"
    assert detail["model"]["training_rows"] == 0
    assert all(point["score"] is None for point in detail["points"])


def test_numeric_equipment_identifiers_are_not_sensor_features():
    frame = custom_frame(120)
    frame["train_number"] = 101
    frame["car_number"] = 3
    frame["axle"] = 2
    frame["ground_truth"] = np.arange(len(frame)) % 2
    parsed, metadata = parse_csv(frame.to_csv(index=False).encode())
    assert metadata["sensor_columns"] == ["custom_sensor"]


def test_healthy_and_missing_scenarios_are_distinguished():
    store = DatasetStore(Settings(n_estimators=64))
    healthy = store.ingest(generate_dataset(scenario="healthy").to_csv(index=False).encode(), "healthy.csv", "synthetic")
    assert healthy["totals"]["healthy"] >= 7
    assert healthy["totals"]["critical"] == 0
    assert healthy["evaluation"]["models"][0]["auc"] is None  # One-class holdout.
    missing = store.ingest(generate_dataset(scenario="missing").to_csv(index=False).encode(), "missing.csv", "synthetic")
    detail = store.detail(missing["dataset"]["id"], "RG-102", "doors")
    assert detail["status"] == "unknown"
    assert detail["points"][-1]["score"] is None
    assert missing["dataset"]["missing_pct"] > 0
    json.dumps(missing, allow_nan=False)


def test_latest_fleet_trend_agrees_with_current_totals(mixed):
    _, dashboard, _ = mixed
    assert {key: dashboard["trend"][-1][key] for key in ("healthy", "warning", "critical", "unknown")} == {key: dashboard["totals"][key] for key in ("healthy", "warning", "critical", "unknown")}
