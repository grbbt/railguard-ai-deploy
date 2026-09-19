"""Frozen inference must bind model bytes, provenance and measured evidence."""
import hashlib
import io
import json
from datetime import datetime, timedelta
from zipfile import ZipFile

import joblib
import numpy as np
import pandas as pd
import pytest
from openpyxl import Workbook

from backend.ps3 import acv, door, rail, shm


class Identity:
    def transform(self, values):
        return np.asarray(values, dtype=float)


class ConstantClassifier:
    def predict(self, values):
        return np.ones(len(values), dtype=int)


class FixedOutput:
    def __init__(self, values):
        self.values = values

    def predict(self, values):
        return self.values


def _artifact(directory, module, bundle=None):
    directory.mkdir(parents=True, exist_ok=True)
    subsystem = module.__name__.rsplit(".", 1)[1]
    value = {"subsystem": subsystem, "version": module.VERSION, "feature_names": ["feature"], "model_name": "Fixture"}
    value.update(bundle or {})
    joblib.dump(value, directory / "model.joblib")
    metadata = {"subsystem": subsystem, "feature_version": module.VERSION, "model_name": value.get("name", value.get("model_name")),
                "feature_names": value["feature_names"], "model_sha256": hashlib.sha256((directory / "model.joblib").read_bytes()).hexdigest()}
    # Door/ACV deliberately store their model name in the legacy 'name' field.
    if "name" in value:
        value.pop("model_name", None)
        joblib.dump(value, directory / "model.joblib")
        metadata["model_sha256"] = hashlib.sha256((directory / "model.joblib").read_bytes()).hexdigest()
    (directory / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return value


@pytest.mark.parametrize("module", [door, acv, rail, shm])
@pytest.mark.parametrize("damage", ["missing", "malformed", "nonobject", "changed_bytes", "wrong_subsystem"])
def test_all_predictors_verify_provenance_before_deserialization(tmp_path, monkeypatch, module, damage):
    _artifact(tmp_path, module)
    metadata_path = tmp_path / "metadata.json"
    if damage == "missing":
        metadata_path.unlink()
    elif damage == "malformed":
        metadata_path.write_text("{")
    elif damage == "nonobject":
        metadata_path.write_text("[]")
    elif damage == "changed_bytes":
        (tmp_path / "model.joblib").write_bytes(b"untrusted replacement")
    else:
        metadata = json.loads(metadata_path.read_text())
        metadata["subsystem"] = "wrong"
        metadata_path.write_text(json.dumps(metadata))
    monkeypatch.setattr(joblib, "load", lambda *args: pytest.fail("Unverified bytes were deserialized"))
    monkeypatch.setattr(module, "train", lambda *args: pytest.fail("Inference attempted training"))
    with pytest.raises(ValueError, match="provenance"):
        module.predict(tmp_path / "unused.csv", tmp_path)


def test_deserialization_uses_exact_verified_bytes_even_if_path_changes(tmp_path, monkeypatch):
    original = _artifact(tmp_path, rail)
    real_load = joblib.load

    def replacing_load(stream):
        assert isinstance(stream, io.BytesIO)
        (tmp_path / "model.joblib").write_bytes(b"concurrent replacement")
        return real_load(stream)

    monkeypatch.setattr(joblib, "load", replacing_load)
    assert rail._load_model(tmp_path, "rail", rail.VERSION) == original


@pytest.mark.parametrize("key,value", [("feature_names", ["wrong"]), ("model_name", "Other model")])
def test_provenance_cannot_mislabel_a_verified_model(tmp_path, key, value):
    _artifact(tmp_path, rail)
    metadata_path = tmp_path / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata[key] = value
    metadata_path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="schema.*provenance"):
        rail._load_model(tmp_path, "rail", rail.VERSION)


def _door_input(path, actions=6):
    rows = []
    for action in range(actions):
        for sample in range(3):
            rows.append({"Datetime": door.native_timestamp(pd.Timestamp("2023-01-01") + pd.Timedelta(seconds=action, milliseconds=20 * sample)),
                         "Motor current(mA)": np.nan if action == 0 else [-action - 1, 2 * (action + 1), np.nan][sample],
                         "Motor Voltage(10mV)": 1200, "Motor electrodynamic force": 10 + sample, "Door leaf position": 100 - sample})
    pd.DataFrame(rows).to_csv(path, index=False)
    return pd.DataFrame(rows)


def _door_artifact(directory, source):
    frame = door.load_stream(source)
    return _artifact(directory, door, {"name": "Extra Trees", "feature_names": list(door.action_features(frame.iloc[:3])),
                     "preprocess": Identity(), "estimator": ConstantClassifier(), "segmentation": {"cadence_seconds": .02, "gap_seconds": .2}})


def test_door_measured_action_evidence_is_bounded_and_does_not_change_predictions(tmp_path):
    source, artifacts = tmp_path / "actions.csv", tmp_path / "model"
    _door_input(source)
    _door_artifact(artifacts, source)
    before = (artifacts / "model.joblib").read_bytes()
    report = door.predict(source, artifacts)
    assert len(report["prediction_rows"]) == 6
    assert all(row["prediction"] == "Abnormal resistance" for row in report["prediction_rows"])
    evidence = {item["id"]: item for item in report["evidence"]}
    assert len(evidence) == 13
    assert evidence["door-action-1-current"]["value"] is None
    assert evidence["door-action-2-current"]["value"] == 4
    assert evidence["door-action-2-duration"]["value"] == .04
    assert report["prediction_rows"][1]["start_time"] in evidence["door-action-2-current"]["source"]
    assert "not a fault threshold or model attribution" in evidence["door-action-2-current"]["detail"]
    assert any("first five" in warning for warning in report["warnings"])
    assert before == (artifacts / "model.joblib").read_bytes()
    json.dumps(report, allow_nan=False)


def test_door_does_not_classify_an_entirely_missing_action(tmp_path):
    source, artifacts = tmp_path / "actions.csv", tmp_path / "model"
    frame = _door_input(source)
    _door_artifact(artifacts, source)
    frame.loc[:2, frame.columns != "Datetime"] = np.nan
    frame.to_csv(source, index=False)
    with pytest.raises(ValueError, match="segment 1 has no usable physical sensor"):
        door.predict(source, artifacts)


@pytest.mark.parametrize("bad", [[.9], [np.nan], [[1]], []])
def test_door_rejects_invalid_classifications_without_truncating_them(bad):
    model = {"preprocess": Identity(), "feature_names": ["x"], "estimator": FixedOutput(bad), "name": "Extra Trees"}
    with pytest.raises(ValueError, match="invalid action classifications"):
        door._classify(model, pd.DataFrame({"x": [1]}))


@pytest.mark.parametrize("alias", ["motor CURRENT mA", "Motor back electromotive force", "Timestamp"])
def test_door_rejects_ambiguous_sensor_or_time_columns(tmp_path, alias):
    source = tmp_path / "ambiguous.csv"
    frame = _door_input(source)
    frame[alias] = 1
    frame.to_csv(source, index=False)
    with pytest.raises(ValueError, match="unique|ambiguous|multiple aliases"):
        door.load_stream(source)


def test_door_overflow_and_broken_quoting_have_file_errors(tmp_path):
    with pytest.raises(ValueError, match="Invalid Door timestamp"):
        door.parse_timestamp("2023-99999999999999999999999-1-0-0-0-0")
    source = tmp_path / "broken.csv"
    source.write_text('Datetime,Sensor\n"unclosed,1\n')
    with pytest.raises(ValueError, match="Cannot read Door CSV"):
        door.load_stream(source)
    frame = _door_input(source)
    frame.loc[2, "Motor current(mA)"] = 1e300
    frame.to_csv(source, index=False)
    with pytest.raises(ValueError, match="supported numeric range"):
        door.load_stream(source)


def _acv_input(path, duplicate=None, value=24):
    workbook = Workbook()
    sheet = workbook.active
    headers = ["Time"] + [f"Car {car:02} - {name}" for car in range(1, 9) for name in ("Indoor Average Temperature", "ACV Control Temperature (Cooling)", "ACV Running Mode")]
    sheet.append(headers + ([duplicate] if duplicate else []))
    for i in range(4):
        sheet.append([datetime(2023, 1, 1) + timedelta(seconds=i * 30)] + [v for car in range(1, 9) for v in (value, 24, "Full Cooling")] + ([1] if duplicate else []))
    workbook.save(path)
    workbook.close()


@pytest.mark.parametrize("header", ["car 01 - indoor average temperature", "Datetime", "Car 01 - Passenger Cabin Temperature Detected Value"])
def test_acv_rejects_ambiguous_column_identity(tmp_path, header):
    source = tmp_path / "case.xlsx"
    _acv_input(source, duplicate=header)
    with pytest.raises(ValueError, match="unique|ambiguous|multiple aliases"):
        acv.load_case(source)


def test_acv_extreme_numeric_cells_have_an_actionable_error(tmp_path):
    source = tmp_path / "case.xlsx"
    _acv_input(source, value=1e300)
    with pytest.raises(ValueError, match="supported numeric range"):
        acv.load_case(source)


def test_acv_malformed_numeric_xml_is_a_workbook_error(tmp_path):
    source = tmp_path / "valid.xlsx"
    _acv_input(source)
    broken = tmp_path / "broken.xlsx"
    with ZipFile(source) as original, ZipFile(broken, "w") as target:
        for item in original.infolist():
            content = original.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                assert b"<v>24</v>" in content
                content = content.replace(b"<v>24</v>", b"<v>not-a-number</v>", 1)
            target.writestr(item, content)
    with pytest.raises(ValueError, match="Malformed ACV workbook"):
        acv.load_case(broken)


@pytest.mark.parametrize("bad", [[np.nan], [], [[1]], [1, 2]])
def test_single_record_models_require_one_finite_scalar(bad):
    with pytest.raises(ValueError, match="invalid prediction"):
        rail._predict_one({"estimator": FixedOutput(bad)}, np.ones((1, 2)), "SHM")


def test_feature_schema_mismatch_is_not_a_raw_key_error():
    with pytest.raises(ValueError, match="incompatible feature schema"):
        rail._feature_matrix({"observed": 1}, ["missing"], "Rail")
