"""Bounded checks for signal contracts, grouping and genuinely held-out inference."""
import json
import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import f1_score, mean_absolute_percentage_error

from backend.ps3 import rail, shm


def rail_headers():
    return ["Rotating speed"] + [f"{kind} of bearing in position {position} of car {car}" for car in range(1, 9) for position in range(1, 9) for kind in ("Vibration", "Shock")]


@pytest.fixture(scope="module")
def rail_recording(tmp_path_factory):
    directory = tmp_path_factory.mktemp("rail-recording")
    sample = np.arange(10_000)
    values = np.zeros((10_000, 129))
    values[:, 0] = (sample % 50 >= 25).astype(float)
    values[:, 1:] = np.sin(2 * np.pi * 300 * sample / 10_000)[:, None] * 0.1
    values[:, 1] *= 40  # Car 1 position 1 vibration, Side I.
    values[:, 3] *= 5   # Car 1 position 2 vibration, Side II.
    frame = pd.DataFrame(values, columns=rail_headers())
    path = directory / "recording.csv"
    frame.to_csv(path, index=False, float_format="%.8g")
    return path, frame


def test_rail_headers_reorder_without_losing_spatial_mapping(rail_recording, tmp_path):
    path, frame = rail_recording
    original, _ = rail.load_signal(path)
    shuffled = tmp_path / "renamed.csv"
    frame[frame.columns[::-1]].to_csv(shuffled, index=False, float_format="%.8g")
    reordered, _ = rail.load_signal(shuffled)
    np.testing.assert_array_equal(original, reordered)
    features = rail.extract_features(original)["features"]
    assert features["side_i.car01.pos1.vibration.log_rms"] > features["side_ii.car01.pos2.vibration.log_rms"]
    assert features["context.speed_m_s"] == pytest.approx(200 / 90 * np.pi * 0.85)
    assert features["side_i.car01.pos1.vibration.band_300_600_fraction"] > features["side_i.car01.pos1.vibration.band_1200_2400_fraction"]
    assert all("recording" not in name and "file" not in name for name in features)


def test_rail_bad_spatial_header_and_truncated_record_are_rejected(rail_recording, tmp_path):
    _, frame = rail_recording
    path = tmp_path / "bad.csv"
    frame.head(2).to_csv(path, index=False)
    with pytest.raises(ValueError, match="10,000"):
        rail.load_signal(path)
    malformed = frame.head(2).copy()
    malformed.columns = ["unknown"] + list(malformed.columns[1:])
    malformed.to_csv(path, index=False)
    with pytest.raises(ValueError, match="Unrecognized"):
        rail.load_signal(path)


def test_rail_nonfinite_samples_are_not_fabricated(rail_recording, tmp_path):
    _, frame = rail_recording
    bad = frame.copy()
    bad.iloc[25, 4] = np.inf
    path = tmp_path / "missing.csv"
    bad.to_csv(path, index=False, float_format="%.8g")
    with pytest.raises(ValueError, match="infinite"):
        rail.load_signal(path)


def test_exact_numeric_and_near_waveform_duplicates_share_groups():
    records = []
    for index, waveform in enumerate((np.arange(1, 20.), np.arange(1, 20.), np.arange(1, 20.) * 1.0001, np.arange(1, 20.)[::-1])):
        records.append({"filename": f"file{index}.csv", "sha256": str(index), "numeric_sha256": "same" if index < 2 else str(index),
                        "samples": 19, "sketch": waveform, "signature": np.array([waveform.mean(), np.linalg.norm(waveform)])})
    groups, links = rail.duplicate_groups(records)
    assert groups[0] == groups[1] == groups[2]
    assert groups[3] != groups[0]
    assert any("near-identical" in link["reason"] for link in links)


def test_rail_training_holds_duplicate_groups_and_freezes_prediction(monkeypatch, tmp_path, rail_recording):
    data = tmp_path / "Rail_Corrugation"
    (data / "Train").mkdir(parents=True)
    (data / "Test").mkdir()
    (data / "Test" / "do-not-read.csv").write_text("THIS IS NOT TRAINING DATA")
    labels = [(f"record-{i}.csv", rail.LABELS[i // 4]) for i in range(12)] + [("copy.csv", "Normal")]
    pd.DataFrame(labels, columns=["filename", "label"]).to_csv(data / "Train_Labels.csv", index=False)
    features = ["side_i.car01.pos1.vibration.log_rms", "side_ii.car01.pos2.vibration.log_rms", "context.speed_m_s"]
    for name, _ in labels:
        (data / "Train" / name).write_text(name)
    read_paths = []
    def cached(path, artifact):
        read_paths.append(path)
        index = 0 if path.name == "copy.csv" else int(path.stem.split("-")[1])
        category = index // 4
        values = [0.1 + (category == 1) * 3, 0.1 + (category == 2) * 3, 5 + index * 0.01]
        return {"filename": path.name, "sha256": str(index), "numeric_sha256": str(index), "samples": 10_000,
                "features": dict(zip(features, values)), "sketch": np.array([index + 1., index**2 + 2]), "signature": np.array([index + 1., index**2 + 2])}
    monkeypatch.setattr(rail, "_cached_features", cached)
    originals = rail._candidates
    monkeypatch.setattr(rail, "_candidates", lambda names: originals(names)[:1])
    artifact = tmp_path / "models"
    metadata = rail.train(data, artifact)
    assert metadata["model_sha256"] == rail._sha256(artifact / "model.joblib")
    assert all(path.parent.name == "Train" for path in read_paths)
    rows = json.loads((artifact / "oof_predictions.json").read_text())
    by_file = {row["file_id"]: row for row in rows}
    assert by_file["record-0.csv"]["fold"] == by_file["copy.csv"]["fold"]
    actual_score = f1_score([row["true"] for row in rows], [row[metadata["model_name"]] for row in rows], labels=rail.LABELS, average="macro", zero_division=0)
    assert metadata["validation"]["score"] == pytest.approx(actual_score)
    before = (artifact / "model.joblib").read_bytes()
    monkeypatch.setattr(rail, "train", lambda *args: pytest.fail("Inference must never train"))
    report = rail.predict(rail_recording[0], artifact)
    assert set(report["prediction_rows"][0]) == {"file_id", "prediction"}
    assert report["prediction_rows"][0]["prediction"] in rail.LABELS
    assert all(len(series["points"]) <= 400 for series in report["series"])
    assert before == (artifact / "model.joblib").read_bytes()
    json.dumps(report, allow_nan=False)


def test_train_directory_and_label_path_escape_are_rejected(tmp_path):
    (tmp_path / "Test").mkdir()
    with pytest.raises(ValueError, match="never pass a Test"):
        rail.train(tmp_path / "Test", tmp_path / "models")
    (tmp_path / "Train").mkdir()
    (tmp_path / "Train_Labels.csv").write_text("filename,damage\n../Test/a.csv,0.1\n")
    with pytest.raises(ValueError, match="Invalid training filename"):
        shm.train(tmp_path, tmp_path / "models")


def test_shm_headerless_first_sample_is_preserved_and_rainflow_has_expected_scaling(tmp_path):
    samples = np.tile([0., 2., 0., -2.], 64)
    samples[0] = 0.375
    path = tmp_path / "stress.csv"
    np.savetxt(path, samples)
    loaded, _ = shm.load_signal(path)
    assert loaded[0] == 0.375
    assert len(loaded) == 256
    base = shm.extract_features(loaded)
    scaled = shm.extract_features(loaded * 2)
    assert scaled["measurements"]["rainflow_cycles"] == base["measurements"]["rainflow_cycles"]
    assert scaled["features"]["log_rainflow_amplitude_moment_4"] - base["features"]["log_rainflow_amplitude_moment_4"] == pytest.approx(4 * np.log(2))
    assert base["measurements"]["maximum_cycle_range"] == 4


@pytest.mark.parametrize("bad", ["stress", "nan", "inf", ""])
def test_shm_missing_and_header_values_are_not_silently_dropped(tmp_path, bad):
    path = tmp_path / "bad.csv"
    path.write_text("\n".join(["1"] * 128 + [bad, "2"]))
    with pytest.raises(ValueError, match="missing, nonnumeric or infinite"):
        shm.load_signal(path)


def test_shm_training_validation_and_frozen_inference(monkeypatch, tmp_path):
    data = tmp_path / "SHM"
    (data / "Train").mkdir(parents=True)
    (data / "Test").mkdir()
    (data / "Test" / "do-not-read.csv").write_text("invalid held-out file")
    labels = []
    for index in range(10):
        signal = (1 + index * 0.2) * np.sin(np.arange(1024) * (0.03 + index * 0.01))
        path = data / "Train" / f"train{index:02}.csv"
        np.savetxt(path, signal)
        labels.append((path.name, 0.03 * (1 + index * 0.2)**3))
    copy = data / "Train" / "duplicate.csv"
    copy.write_bytes((data / "Train" / "train00.csv").read_bytes())
    labels.append((copy.name, labels[0][1]))
    pd.DataFrame(labels, columns=["filename", "damage"]).to_csv(data / "Train_Labels.csv", index=False)
    originals = shm._candidates
    monkeypatch.setattr(shm, "_candidates", lambda names: originals(names)[:3])
    artifact = tmp_path / "models"
    metadata = shm.train(data, artifact)
    assert metadata["model_sha256"] == rail._sha256(artifact / "model.joblib")
    rows = json.loads((artifact / "oof_predictions.json").read_text())
    by_file = {row["file_id"]: row for row in rows}
    assert by_file["train00.csv"]["fold"] == by_file["duplicate.csv"]["fold"]
    mape = mean_absolute_percentage_error([row["true"] for row in rows], [row[metadata["model_name"]] for row in rows])
    assert metadata["validation"]["score"] == pytest.approx(max(0, 1 - mape))
    assert metadata["training_files"] == 11
    assert metadata["training_rows"] == 11 * 1024
    before = (artifact / "model.joblib").read_bytes()
    monkeypatch.setattr(shm, "train", lambda *args: pytest.fail("Inference must never train"))
    path = data / "Train" / "train03.csv"
    report = shm.predict(path, artifact)
    assert isinstance(report["prediction_rows"][0]["prediction"], float)
    assert set(report["prediction_rows"][0]) == {"file_id", "prediction"}
    assert report["series"][0]["x_label"] == "Sample index"
    assert len(report["series"][0]["points"]) <= 400
    assert before == (artifact / "model.joblib").read_bytes()
    json.dumps(report, allow_nan=False)


def test_feature_cache_reuses_content_not_filename(monkeypatch, tmp_path):
    path = tmp_path / "stress.csv"
    np.savetxt(path, np.sin(np.arange(256)))
    artifact = tmp_path / "features"
    first = shm._cached_features(path, artifact)
    renamed = tmp_path / "other-name.csv"
    renamed.write_bytes(path.read_bytes())
    monkeypatch.setattr(shm, "load_signal", lambda *args: pytest.fail("Expected cached numerical features"))
    second = shm._cached_features(renamed, artifact)
    assert first["features"] == second["features"]
    assert second["filename"] == "other-name.csv"


def test_source_change_does_not_poison_feature_cache(monkeypatch, tmp_path):
    path = tmp_path / "changing.csv"
    np.savetxt(path, np.sin(np.arange(256)))
    hashes = iter(["before", "after"])
    monkeypatch.setattr(shm, "_sha256", lambda path: next(hashes))
    artifact = tmp_path / "features"
    with pytest.raises(ValueError, match="changed during feature extraction"):
        shm._cached_features(path, artifact)
    assert not list((artifact / "feature_cache").glob("*.joblib"))


def test_unknown_artifact_does_not_trigger_training(tmp_path):
    with pytest.raises(ValueError, match="No trained rail"):
        rail.predict(tmp_path / "file.csv", tmp_path / "absent")
    with pytest.raises(ValueError, match="No trained shm"):
        shm.predict(tmp_path / "file.csv", tmp_path / "absent")


def test_model_provenance_mismatch_is_rejected_before_deserialization(monkeypatch, tmp_path):
    (tmp_path / "model.joblib").write_bytes(b"modified model")
    (tmp_path / "metadata.json").write_text(json.dumps({"model_sha256": "wrong"}))
    monkeypatch.setattr(rail.joblib, "load", lambda *args: pytest.fail("Mismatched model must not be deserialized"))
    with pytest.raises(ValueError, match="does not match"):
        rail._load_model(tmp_path, "rail", rail.VERSION)
