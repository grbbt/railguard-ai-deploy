"""Real Singapore geography with explicitly separate observed/demo positions.

The local service never infers a physical train location from an anomaly score,
train ID, arrival prediction or timetable. No operator location feed is connected.
"""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import re

import pandas as pd

from backend.detector import DatasetStore, iso, parse_csv

NETWORK_FILE = Path(__file__).resolve().parents[1] / "data" / "network" / "singapore-mrt.json"
LATITUDE_ALIASES = {"lat", "latitude", "gpslat", "gpslatitude", "latitudedeg", "latitudedegrees"}
LONGITUDE_ALIASES = {"lon", "lng", "long", "longitude", "gpslon", "gpslng", "gpslongitude", "longitudedeg", "longitudedegrees"}


@lru_cache(maxsize=1)
def _network_snapshot() -> dict:
    return json.loads(NETWORK_FILE.read_text(encoding="utf-8"))


def network_data() -> dict:
    return deepcopy(_network_snapshot())


def _compact(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _line_id(value, network: dict) -> str | None:
    if value is None or pd.isna(value):
        return None
    key = _compact(str(value))
    for line in network["lines"]:
        if key in {_compact(line["id"]), _compact(line["name"])}:
            return line["id"]
    return None


def _distance(a, b) -> float:
    """Local metric suitable for the small Singapore map extent."""
    return math.hypot((a[0] - b[0]) * 110_574, (a[1] - b[1]) * 111_280)


def _nearest_station(lat: float, lng: float, network: dict, line: str | None) -> str | None:
    candidates = [station for station in network["stations"] if line is None or line in station["lines"]]
    if not candidates:
        return None
    nearest = min(candidates, key=lambda station: _distance((lat, lng), (station["lat"], station["lng"])))
    # This is a proximity hint, never an assertion of track occupancy.
    return nearest["id"] if _distance((lat, lng), (nearest["lat"], nearest["lng"])) <= 1500 else None


def _point_on_path(path: list, fraction: float) -> tuple[float, float]:
    lengths = [_distance(a, b) for a, b in zip(path, path[1:])]
    remaining = sum(lengths) * fraction
    for index, length in enumerate(lengths):
        if remaining <= length and length:
            ratio = remaining / length
            return tuple(path[index][axis] + ratio * (path[index + 1][axis] - path[index][axis]) for axis in (0, 1))
        remaining -= length
    return tuple(path[-1])


def train_positions(store: DatasetStore, dataset_id: str = "demo") -> dict:
    dashboard = store.dashboard(dataset_id)
    dataset = dashboard["dataset"]
    network = _network_snapshot()
    base = {"dataset_id": dataset["id"], "source": "unavailable", "timestamp": None,
            "positions": [], "note": "No live operator train-location feed is configured.",
            "integrations": {"live_train_locations": "not_configured", "geography": "cached_official_public_data",
                             "lta_train_trip_updates": "not_connected; arrival predictions are not vehicle GPS locations"}}
    if dataset["source"] == "synthetic":
        # Stable positions belong solely to the fictional dataset. Never reuse
        # this path as a fallback for an uploaded train without coordinates.
        for index, train in enumerate(sorted(dashboard["trains"], key=lambda item: item["id"])):
            line = network["lines"][index % len(network["lines"])]
            digest = hashlib.sha256(f"{dataset['id']}:{train['id']}:demo-position".encode()).digest()
            fraction = 0.08 + int.from_bytes(digest[:4], "big") / (2**32 - 1) * 0.84
            lat, lng = _point_on_path(line["path"], fraction)
            base["positions"].append({"train_id": train["id"], "lat": round(lat, 6), "lng": round(lng, 6),
                                      "line": line["id"], "station_id": _nearest_station(lat, lng, network, line["id"]),
                                      "direction": None, "position_source": "demo", "timestamp": dataset["time_end"]})
        base.update(source="demo", timestamp=dataset["time_end"],
                    note="Simulated positions for fictional demo trains on real Singapore MRT geography, fixed at the synthetic dataset snapshot. Line assignments are illustrative. No live operator train-location feed is configured.")
        return base

    raw, _ = store.export(dataset["id"])
    frame, _ = parse_csv(raw)
    latitude_columns = [column for column in frame if _compact(column) in LATITUDE_ALIASES]
    longitude_columns = [column for column in frame if _compact(column) in LONGITUDE_ALIASES]
    if len(latitude_columns) != 1 or len(longitude_columns) != 1:
        base["note"] = ("No unambiguous latitude/longitude pair is present in this uploaded dataset; train locations are unavailable. "
                        "Provide one latitude (or lat) and one longitude (or lon/lng) column with timestamped GPS observations. "
                        "No live operator train-location feed is configured.")
        return base
    latitude, longitude = latitude_columns[0], longitude_columns[0]
    frame[latitude] = pd.to_numeric(frame[latitude], errors="coerce")
    frame[longitude] = pd.to_numeric(frame[longitude], errors="coerce")
    omitted = 0
    for train_id, group in frame.groupby("train_id", sort=True):
        latest = group.loc[group["_timestamp"].eq(group["_timestamp"].max())]
        points = latest[[latitude, longitude]].drop_duplicates()
        valid = points[latitude].between(1.14, 1.50) & points[longitude].between(103.53, 104.51)
        # Partial component rows may omit GPS, but disagreement between valid
        # simultaneous GPS pairs is ambiguous and must never be resolved silently.
        points = points.loc[valid]
        if len(points) != 1:
            omitted += 1
            continue
        lat, lng = float(points.iloc[0][latitude]), float(points.iloc[0][longitude])
        route_values = latest["line"].dropna().unique() if "line" in latest else []
        line = _line_id(route_values[0], network) if len(route_values) == 1 else None
        timestamp = iso(latest["_timestamp"].iloc[0])
        base["positions"].append({"train_id": str(train_id), "lat": lat, "lng": lng, "line": line,
                                  "station_id": _nearest_station(lat, lng, network, line), "direction": None,
                                  "position_source": "telemetry", "timestamp": timestamp})
    if base["positions"]:
        base["source"] = "telemetry"
        base["timestamp"] = max(position["timestamp"] for position in base["positions"])
    base["note"] = ("Uploaded GPS observations at each train's latest telemetry timestamp, within the Singapore map extent. "
                    "These are recorded locations, not a live operator feed. Nearby station labels describe proximity only. "
                    f"{omitted} train(s) have missing, invalid, out-of-extent or conflicting latest coordinates and are omitted. "
                    "No live operator train-location feed is configured.")
    return base
