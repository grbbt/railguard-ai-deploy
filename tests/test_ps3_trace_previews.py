"""Source-faithful evidence previews must not alter inference or bridge gaps."""
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from openpyxl import Workbook

from backend.ps3 import acv, door
from backend.ps3.preview import sampled_trace_points


def test_sampling_preserves_exact_values_and_breaks_omitted_invalid_readings():
    x = np.arange(12, dtype=float) * .02
    y = np.arange(12, dtype=float) ** 2
    y[4] = np.nan  # Row four is not one of the retained rows 0, 3, 7, 11.
    points = sampled_trace_points(x, y, max_points=4)
    assert points == [
        {"x": x[0], "y": y[0]}, {"x": x[3], "y": y[3]},
        {"x": x[7], "y": None}, {"x": x[7], "y": y[7]},
        {"x": x[11], "y": y[11]},
    ]


def test_acquisition_gap_is_preserved_even_when_gap_row_is_not_sampled():
    x, y = np.arange(12, dtype=float), np.arange(12, dtype=float)
    x[5:] += 500
    gaps = np.r_[False, np.diff(x) > 3]
    points = sampled_trace_points(x, y, break_before=gaps, max_points=4)
    assert points[2:4] == [{"x": 507., "y": None}, {"x": 507., "y": 7.}]
    assert all(point["x"] in x for point in points)


def test_trace_budget_and_nonfinite_coordinates_are_safe():
    x = np.arange(1000, dtype=float)
    y = np.sin(x)
    points = sampled_trace_points(x, y, break_before=np.ones(1000, dtype=bool))
    assert len(points) == 799
    assert sum(point["y"] is not None for point in points) == 400
    bad_x = np.array([0., np.nan, 2.])
    assert sampled_trace_points(bad_x, [1., 2., 3.]) == [
        {"x": 0., "y": 1.}, {"x": 2., "y": None}, {"x": 2., "y": 3.},
    ]
    assert sampled_trace_points([], []) == []
    with pytest.raises(ValueError, match="equal length"):
        sampled_trace_points([0, 1], [3])
    with pytest.raises(ValueError, match="mask"):
        sampled_trace_points([0, 1], [3, 4], break_before=[True])


def test_door_evidence_channels_use_source_units_and_do_not_change_predictions(tmp_path, monkeypatch):
    records = []
    for index in range(16):
        timestamp = pd.Timestamp("2023-01-01") + pd.Timedelta(seconds=(index % 8) * .02 + (10 if index >= 8 else 0))
        records.append({"Datetime": door.native_timestamp(timestamp), "Motor current(mA)": index * 11,
                        "Motor Voltage(10mV)": 1220 + index, "Motor electrodynamic force": index * 3,
                        "Door leaf position": 800 - index * 10, "Close command": 1,
                        "Door is opening": 0, "Door is closing": 1})
    path = tmp_path / "recording.csv"
    pd.DataFrame(records).to_csv(path, index=False)
    frame = door.load_stream(path)
    model = {"name": "Frozen preview fixture", "segmentation": {"cadence_seconds": .02, "gap_seconds": 1.},
             "preprocess": SimpleNamespace(transform=lambda values: values),
             "estimator": SimpleNamespace(predict=lambda values: np.zeros(len(values))),
             "feature_names": list(door.action_features(frame.iloc[:8]))}
    monkeypatch.setattr(door, "_load_model", lambda *args: model)
    feature_calls = []
    def classify(_model, features):
        feature_calls.append(features.copy(deep=True))
        return np.zeros(len(features), dtype=int)
    monkeypatch.setattr(door, "_classify", classify)
    result = door.predict(path, tmp_path)
    traces = {trace["name"]: trace for trace in result["series"]}
    assert set(traces) == {"Motor current", "Motor voltage", "Motor back-EMF", "Door leaf position", "Close command", "Door opening state", "Door closing state"}
    assert traces["Motor voltage"]["y_label"] == "10 mV source units"
    assert traces["Motor voltage"]["points"][0] == {"x": 0., "y": 1220.}
    assert traces["Motor voltage"]["points"][8:10] == [{"x": 10., "y": None}, {"x": 10., "y": 1228.}]
    assert {point["y"] for point in traces["Door closing state"]["points"]} == {1., None}
    monkeypatch.setattr(door, "sampled_trace_points", lambda *args, **kwargs: [])
    without_preview = door.predict(path, tmp_path)
    assert {key: value for key, value in result.items() if key != "series"} == {key: value for key, value in without_preview.items() if key != "series"}
    pd.testing.assert_frame_equal(feature_calls[0], feature_calls[1])


def test_acv_previews_match_real_masks_residuals_and_peer_reference(tmp_path, monkeypatch):
    path = tmp_path / "cooling.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    fields = ["Indoor Average Temperature", "ACV Control Temperature (Cooling)", "ACV Running Mode", "ACV Information Valid"]
    sheet.append(["Time"] + [f"Car {car:02} - {field}" for car in range(1, 9) for field in fields])
    for index in range(12):
        row = [(pd.Timestamp("2023-01-01") + pd.Timedelta(seconds=index * 30 + (900 if index >= 7 else 0))).to_pydatetime()]
        for car in range(1, 9):
            row.extend([None] * 4 if car == 8 else [24 + (4 if car == 1 else car * .2) + index * .1,
                        24, "Heating" if car == 1 and index == 3 else "Full Cooling",
                        "Invalid" if car == 1 and index == 5 else "Valid"])
        sheet.append(row)
    workbook.save(path)
    workbook.close()
    case = acv.load_case(path)
    traces = {trace["name"]: trace for trace in case.series}
    assert len(traces) == 28  # Four available channels for seven cars; no invented eighth-car readings.
    assert not any(name.startswith("Car 08 ") for name in traces)
    cabin = traces["Car 01 cabin measurement"]["points"]
    target = traces["Car 01 cooling target"]["points"]
    residual = traces["Car 01 cabin-minus-target residual"]["points"]
    peers = traces["Car 01 residual above cooling peers"]["points"]
    assert cabin[0] == {"x": 0., "y": 28.}
    assert target[0] == {"x": 0., "y": 24.}
    assert residual[0] == {"x": 0., "y": 4.}
    assert peers[0]["y"] == pytest.approx(3.1)
    assert target[3]["y"] is None and residual[3]["y"] is None  # Heating has no cooling comparison.
    assert cabin[3]["y"] == pytest.approx(28.3)  # The valid measured cabin reading is still shown.
    assert cabin[5]["y"] is None  # Explicit Information Invalid is never shown as valid evidence.
    assert cabin[7] == {"x": 1110 / 3600, "y": None}
    assert cabin[8] == {"x": 1110 / 3600, "y": 28.7}
    ranking = acv._ranking({"name": acv.BASELINE}, case)
    monkeypatch.setattr(acv, "sampled_trace_points", lambda *args, **kwargs: [])
    without_preview = acv.load_case(path)
    pd.testing.assert_frame_equal(case.features, without_preview.features)
    assert case.details == without_preview.details and case.available == without_preview.available
    assert case.content_sha256 == without_preview.content_sha256
    assert ranking == acv._ranking({"name": acv.BASELINE}, without_preview)
