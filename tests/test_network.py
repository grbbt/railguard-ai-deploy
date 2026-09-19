import json
import math

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.detector import DatasetStore, Settings, parse_csv
from backend.network import network_data, train_positions


def telemetry(**columns):
    frame = pd.DataFrame({"timestamp": pd.date_range("2026-09-01", periods=40, freq="5min", tz="UTC").astype(str),
                          "train_id": 'Unit, "A"/01', "component": "bogies", "line": "North-South Line",
                          "vibration_mm_s": [1 + 0.1 * math.sin(index) for index in range(40)]})
    for key, value in columns.items():
        frame[key] = value
    return frame


def ingest(frame, source="uploaded"):
    store = DatasetStore(Settings(n_estimators=16))
    result = store.ingest(frame.to_csv(index=False).encode(), "positions.csv", source)
    return store, result["dataset"]["id"]


def test_official_network_operating_topology_and_real_geography():
    network = network_data()
    assert network["operational_review_date"] == "2026-09-14"
    assert len(network["stations"]) == 146
    expected = {"NSL": 27, "EWL": 35, "NEL": 17, "CCL": 33, "DTL": 35, "TEL": 27}
    assert {line["id"]: len(line["station_ids"]) for line in network["lines"]} == expected
    stations = {station["id"]: station for station in network["stations"]}
    assert {"keppel", "cantonment", "prince-edward-road", "hume", "punggol-coast"} <= set(stations)
    assert not {"mount-pleasant", "marina-south", "bukit-brown", "bedok-south", "sungei-bedok", "xilin"} & set(stations)
    assert abs(stations["city-hall"]["lat"] - 1.293) < 0.003
    assert abs(stations["city-hall"]["lng"] - 103.852) < 0.003
    assert "LTA" in network["source"] and "URA" in network["source"]
    assert network["license_url"] == "https://data.gov.sg/open-data-licence"
    for line in network["lines"]:
        assert all(identifier in stations and line["id"] in stations[identifier]["lines"] for identifier in line["station_ids"])
        assert sum(len(path) for path in line["paths"]) > 3 * len(line["station_ids"])
        for path in line["paths"]:
            assert len(path) > 3
            assert all(1.14 < lat < 1.50 and 103.53 < lng < 104.51 for lat, lng in path)
    circle = next(line for line in network["lines"] if line["id"] == "CCL")
    assert circle["paths"][0][0] == circle["paths"][0][-1]
    assert len(circle["paths"]) == 2
    assert len(next(line for line in network["lines"] if line["id"] == "EWL")["paths"]) == 2
    # A caller cannot mutate the shared geography cache.
    network["stations"].clear()
    assert len(network_data()["stations"]) == 146


def test_demo_positions_explicit_stable_and_do_not_retrain():
    store, dataset_id = ingest(telemetry(), "synthetic")
    fits = store.fit_count
    result = train_positions(store, dataset_id)
    assert result == train_positions(store, dataset_id)
    assert result["source"] == "demo"
    assert result["positions"][0]["train_id"] == 'Unit, "A"/01'
    assert result["positions"][0]["position_source"] == "demo"
    assert result["timestamp"].startswith("2026-09-01T03:15:00")
    assert "fictional" in result["note"] and "No live operator" in result["note"]
    assert store.fit_count == fits


def test_uploaded_latest_gps_is_exact_and_excluded_from_detector():
    frame = telemetry(gpsLatitude=[1.300 + index * 0.0001 for index in range(40)], longitude=103.850)
    parsed, metadata = parse_csv(frame.to_csv(index=False).encode())
    assert metadata["sensor_columns"] == ["vibration_mm_s"]
    store, dataset_id = ingest(frame)
    fits = store.fit_count
    result = train_positions(store, dataset_id)
    assert result["source"] == "telemetry"
    point = result["positions"][0]
    assert point["lat"] == pytest.approx(1.3039)
    assert point["lng"] == 103.850
    assert point["line"] == "NSL"
    assert point["position_source"] == "telemetry"
    assert result == train_positions(store, dataset_id)
    assert store.fit_count == fits
    assert store.dashboard(dataset_id)["model"]["features"] == ["vibration_mm_s"]
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("latitude,longitude", [(None, 103.85), (float("inf"), 103.85), (1.30, float("-inf")), (52.5, 13.4), (1.30, None)])
def test_invalid_or_missing_latest_coordinates_never_use_older_or_demo(latitude, longitude):
    frame = telemetry(lat=1.30, lng=103.85)
    frame.loc[39, ["lat", "lng"]] = [latitude, longitude]
    store, dataset_id = ingest(frame)
    result = train_positions(store, dataset_id)
    assert result["source"] == "unavailable"
    assert result["positions"] == []
    assert result["timestamp"] is None


def test_upload_without_gps_or_with_ambiguous_aliases_is_unavailable():
    for frame in (telemetry(), telemetry(lat=1.3, latitude=1.31, longitude=103.85)):
        store, dataset_id = ingest(frame)
        result = train_positions(store, dataset_id)
        assert result["source"] == "unavailable"
        assert not result["positions"]


def test_conflicting_simultaneous_gps_is_not_silently_selected():
    frame = telemetry(latitude=1.3, longitude=103.85)
    duplicate = frame.iloc[[-1]].copy()
    duplicate["latitude"] = 1.31
    store, dataset_id = ingest(pd.concat([frame, duplicate], ignore_index=True))
    assert train_positions(store, dataset_id)["positions"] == []


def test_coordinates_and_route_numbers_alone_are_not_sensor_measurements():
    frame = telemetry(latitude=1.3, longitude=103.85, route_position=0.5, heading=90).drop(columns=["vibration_mm_s"])
    with pytest.raises(ValueError, match="No usable numeric sensor"):
        parse_csv(frame.to_csv(index=False).encode())


def test_network_api_contract_and_unknown_dataset(tmp_path):
    store, dataset_id = ingest(telemetry(latitude=1.3, longitude=103.85))
    with TestClient(create_app(store, tmp_path / "orders.sqlite3")) as client:
        response = client.get("/api/network")
        assert response.status_code == 200
        assert response.json()["lines"][0]["id"] == "NSL"
        response = client.get("/api/network/positions", params={"dataset_id": dataset_id})
        assert response.status_code == 200
        assert response.json()["source"] == "telemetry"
        assert response.json()["positions"][0]["train_id"] == 'Unit, "A"/01'
        assert client.get("/api/network/positions", params={"dataset_id": "missing"}).status_code == 404


def test_default_demo_alias_resolves_to_shared_dashboard(tmp_path):
    store = DatasetStore(Settings(n_estimators=16))
    with TestClient(create_app(store, tmp_path / "orders.sqlite3")) as client:
        response = client.get("/api/network/positions")
        assert response.status_code == 200
        positions = response.json()
        dashboard = client.get("/api/dashboard").json()
        assert positions["dataset_id"] == dashboard["dataset"]["id"]
        assert {item["train_id"] for item in positions["positions"]} == {item["id"] for item in dashboard["trains"]}
        assert positions["source"] == "demo"
        assert client.get("/api/network/positions", params={"dataset_id": positions["dataset_id"]}).json() == positions
