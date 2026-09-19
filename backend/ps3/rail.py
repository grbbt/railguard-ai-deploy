"""PS3 rail corrugation: frozen file-level classification with grouped validation.

Channel locations follow the organiser's eight-car / eight-position definition.
No filename numbers, test recordings, labels or assumed GPS become model features.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import warnings

import joblib
import numpy as np
import pandas as pd
from scipy.signal import welch
from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.ensemble import ExtraTreesClassifier, IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.utils.class_weight import compute_sample_weight

VERSION = "rail-features-v1"
LABELS = ("Normal", "Side I", "Side II")
SAMPLE_RATE = 10_000
EXPECTED_SAMPLES = 10_000
MAX_FILE_BYTES = 64 * 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def _filename(value: str) -> str:
    """Labels may identify only immediate files in the explicitly allowed Train directory."""
    if not value or Path(value).name != value or "/" in value or "\\" in value or value in {".", ".."}:
        raise ValueError(f"Invalid training filename in label table: {value!r}")
    return value


def _label_table(data_dir: Path, target: str) -> tuple[pd.DataFrame, Path]:
    data_dir = Path(data_dir).resolve()
    if data_dir.name.lower() in {"test", "train"}:
        raise ValueError("Training requires the subsystem root containing Train/ and Train_Labels.csv; never pass a Test directory")
    label_path = data_dir / "Train_Labels.csv"
    try:
        frame = pd.read_csv(label_path, dtype=str, keep_default_na=False)
    except (OSError, pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
        raise ValueError(f"Cannot read training labels at {label_path}") from exc
    if set(frame.columns) != {"filename", target} or frame.empty:
        raise ValueError(f"Train_Labels.csv must contain filename,{target} with at least one record")
    frame["filename"] = frame["filename"].map(_filename)
    if frame["filename"].duplicated().any():
        raise ValueError("Training labels contain duplicate filenames")
    for name in frame["filename"]:
        path = (data_dir / "Train" / name).resolve()
        if path.parent != (data_dir / "Train").resolve() or not path.is_file():
            raise ValueError(f"Missing permitted training recording: Train/{name}")
    return frame.sort_values("filename", kind="stable").reset_index(drop=True), label_path


def load_signal(path: Path) -> tuple[np.ndarray, list[str]]:
    """Validate known channel identities, retaining the speed pulse as a waveform."""
    path = Path(path)
    try:
        size = path.stat().st_size
        if size == 0 or size > MAX_FILE_BYTES:
            raise ValueError("Rail recording must be nonempty and at most 64 MiB")
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            header = next(csv.reader(stream))
    except (OSError, UnicodeError, StopIteration) as exc:
        raise ValueError(f"Cannot read Rail CSV {path.name}") from exc
    if len(header) != 129 or len(set(header)) != 129:
        raise ValueError("Rail CSV requires one speed pulse and 128 uniquely named vibration/shock columns")
    mapping = {}
    speed_column = None
    for name in header:
        key = re.sub(r"\s+", " ", name.strip().lower())
        if key == "rotating speed":
            speed_column = name
            continue
        match = re.fullmatch(r"(vibration|shock) of bearing in position ([1-8]) of car ([1-8])", key)
        if not match:
            raise ValueError(f"Unrecognized Rail channel {name!r}; spatial identities must be preserved")
        kind, position, car = match.groups()
        identity = (int(car), int(position), kind)
        if identity in mapping:
            raise ValueError("Duplicate physical Rail channel identity")
        mapping[identity] = name
    if speed_column is None or len(mapping) != 128:
        raise ValueError("Rail channel map is incomplete")
    order = [speed_column] + [mapping[car, position, kind] for car in range(1, 9) for position in range(1, 9) for kind in ("vibration", "shock")]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", pd.errors.ParserWarning)
            frame = pd.read_csv(path, encoding="utf-8-sig", index_col=False, on_bad_lines="error", skip_blank_lines=False)
    except (OSError, UnicodeError, pd.errors.ParserError, pd.errors.EmptyDataError, pd.errors.ParserWarning) as exc:
        raise ValueError(f"Malformed Rail CSV {path.name}; check complete rows and numeric fields") from exc
    if len(frame) != EXPECTED_SAMPLES or frame.shape[1] != 129:
        raise ValueError(f"Rail inference expects exactly 10,000 samples × 129 columns (one second at 10 kHz); received {len(frame):,} × {frame.shape[1]}")
    signal = frame[order].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float64)
    if not np.isfinite(signal).all():
        count = int((~np.isfinite(signal)).sum())
        raise ValueError(f"Rail recording contains {count} missing, nonnumeric or infinite samples; provide a complete waveform so spectral/peak evidence is not invented")
    if not np.isin(signal[:, 0], [0.0, 1.0]).all():
        raise ValueError("Rotating speed must be the documented binary tooth-sensor waveform, not speed in km/h")
    if np.max(np.abs(signal[:, 1:])) > 1e12:
        raise ValueError("Rail amplitudes exceed the supported numeric range; verify units and corrupted cells")
    return signal, []


def _summaries(signal: np.ndarray) -> tuple[dict[str, np.ndarray], dict]:
    values = signal[:, 1:]
    centered = values - values.mean(axis=0)
    std = np.sqrt(np.mean(centered**2, axis=0))
    rms = np.sqrt(np.mean(values**2, axis=0))
    peak = np.max(np.abs(values), axis=0)
    safe_std = np.maximum(std, 1e-12)
    standardized = centered / safe_std
    segment_length = min(2048, len(values))
    frequencies, power = welch(values, fs=SAMPLE_RATE, nperseg=segment_length, noverlap=segment_length // 2, axis=0, detrend="constant")
    power_sum = np.maximum(power.sum(axis=0), 1e-30)
    normalized_power = power / power_sum
    stats = {
        "log_rms": np.log1p(rms), "log_std": np.log1p(std),
        "log_abs_p95": np.log1p(np.percentile(np.abs(values), 95, axis=0)),
        "log_peak": np.log1p(peak), "crest": peak / np.maximum(rms, 1e-12),
        "kurtosis": np.mean(standardized**4, axis=0),
        "diff_ratio": np.sqrt(np.mean(np.diff(values, axis=0)**2, axis=0)) / safe_std,
        "spectral_centroid_hz": (frequencies[:, None] * normalized_power).sum(axis=0),
        "spectral_entropy": -(normalized_power * np.log(np.maximum(normalized_power, 1e-30))).sum(axis=0) / np.log(len(frequencies)),
    }
    for lower, upper in ((0, 100), (100, 300), (300, 600), (600, 1200), (1200, 2400), (2400, 5001)):
        mask = (frequencies >= lower) & (frequencies < upper)
        stats[f"band_{lower}_{min(upper, 5000)}_fraction"] = power[mask].sum(axis=0) / power_sum
    rising = int(np.count_nonzero(np.diff(signal[:, 0]) > 0))
    # One rising edge per tooth; both-transition counts would need divisor 180.
    speed = rising / (len(signal) / SAMPLE_RATE) / 90 * np.pi * 0.85
    return stats, {"rms": rms, "rising_edges": rising, "speed_m_s": float(speed)}


def extract_features(signal: np.ndarray) -> dict:
    stats, measured = _summaries(signal)
    features = {"context.speed_m_s": measured["speed_m_s"], "context.pulse_duty": float(signal[:, 0].mean())}
    side_indices = {"side_i": [], "side_ii": []}
    for car in range(1, 9):
        for position in range(1, 9):
            side = "side_i" if position % 2 else "side_ii"
            for kind_index, kind in enumerate(("vibration", "shock")):
                column = ((car - 1) * 8 + position - 1) * 2 + kind_index
                side_indices[side].append(column)
                for metric, values in stats.items():
                    features[f"{side}.car{car:02}.pos{position}.{kind}.{metric}"] = float(values[column])
    for side, indices in side_indices.items():
        for offset, kind in enumerate(("vibration", "shock")):
            selected = np.array([column for column in indices if column % 2 == offset])
            for metric, values in stats.items():
                side_values = values[selected]
                features[f"{side}.summary.{kind}.{metric}.median"] = float(np.median(side_values))
                features[f"{side}.summary.{kind}.{metric}.max"] = float(np.max(side_values))
    # Signed side contrast preserves localisation without depending on car labels.
    for kind in ("vibration", "shock"):
        for metric in ("log_rms", "log_peak", "kurtosis"):
            features[f"contrast.{kind}.{metric}"] = features[f"side_i.summary.{kind}.{metric}.median"] - features[f"side_ii.summary.{kind}.{metric}.median"]
    values = np.asarray(list(features.values()), dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError("Unable to derive finite Rail features; check waveform amplitude and completeness")
    physical = signal[:, 1:]
    sample_indices = np.linspace(0, len(signal) - 1, 64, dtype=int)
    sketch = physical[sample_indices].astype(np.float32).ravel()
    return {"features": features, "samples": len(signal), "sketch": sketch,
            "signature": np.array([physical.mean(), np.sqrt(np.mean(physical**2))], dtype=float),
            "numeric_sha256": hashlib.sha256(np.ascontiguousarray(signal, dtype="<f8").tobytes()).hexdigest()}


def _cached_features(path: Path, artifact_dir: Path) -> dict:
    digest = _sha256(path)
    cache = Path(artifact_dir) / "feature_cache"
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{VERSION}-{digest}.joblib"
    if target.is_file():
        value = joblib.load(target)
    else:
        signal, _ = load_signal(path)
        value = extract_features(signal)
        if _sha256(path) != digest:
            raise ValueError(f"Rail source {path.name} changed during feature extraction; wait for the download or upload to finish")
        joblib.dump(value, target, compress=3)
    return {**value, "sha256": digest, "filename": path.name}


def duplicate_groups(records: list[dict]) -> tuple[np.ndarray, list[dict]]:
    """Group exact numeric matches and conservative near-identical waveform sketches.

    This does not establish independence of unknown acquisition runs. It catches
    formatting-only copies, near-identical gain/noise variants, and source copies.
    """
    parents = list(range(len(records)))
    links = []
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    def union(a, b, reason):
        parents[find(b)] = find(a)
        links.append({"files": [records[a]["filename"], records[b]["filename"]], "reason": reason})
    for a in range(len(records)):
        for b in range(a):
            if records[a]["sha256"] == records[b]["sha256"] or records[a]["numeric_sha256"] == records[b]["numeric_sha256"]:
                union(a, b, "identical bytes or numerical samples")
                continue
            if records[a]["samples"] != records[b]["samples"]:
                continue
            first, second = records[a]["sketch"], records[b]["sketch"]
            denominator = max(float(np.linalg.norm(first)), float(np.linalg.norm(second)), 1e-12)
            if first.shape == second.shape and np.linalg.norm(first - second) / denominator <= 1e-3:
                p, q = records[a]["signature"], records[b]["signature"]
                if np.linalg.norm(p - q) / max(np.linalg.norm(p), np.linalg.norm(q), 1e-12) <= 1e-3:
                    union(a, b, "near-identical waveform sketch and full-signal moments (relative difference <= 0.001)")
    return np.array([find(index) for index in range(len(records))]), links


class SideIsolationForest(ClassifierMixin, BaseEstimator):
    """Actual normal-only IF anomaly baseline with an explicit side mapping."""
    def __init__(self, side_i=(), side_ii=(), n_estimators=128, random_state=42):
        self.side_i = side_i
        self.side_ii = side_ii
        self.n_estimators = n_estimators
        self.random_state = random_state

    def fit(self, X, y):
        X, y = np.asarray(X), np.asarray(y)
        if np.count_nonzero(y == 0) < 4:
            raise ValueError("Normal-reference Isolation Forest needs at least four normal training files")
        self.models_ = []
        for indices in (self.side_i, self.side_ii):
            model = IsolationForest(n_estimators=self.n_estimators, contamination=0.05, random_state=self.random_state, n_jobs=1)
            model.fit(X[y == 0][:, indices])
            self.models_.append(model)
        self.classes_ = np.arange(3)
        return self

    def predict(self, X):
        X = np.asarray(X)
        scores = np.column_stack([-model.decision_function(X[:, indices]) for model, indices in zip(self.models_, (self.side_i, self.side_ii))])
        return np.where(scores.max(axis=1) > 0, scores.argmax(axis=1) + 1, 0)


def _candidates(feature_names: list[str]) -> list[tuple[str, object, bool]]:
    def pipeline(estimator, scale=False):
        steps = [("impute", SimpleImputer(strategy="median", keep_empty_features=True))]
        if scale:
            steps.append(("scale", StandardScaler()))
        return Pipeline(steps + [("model", estimator)])
    side_i = tuple(index for index, name in enumerate(feature_names) if name.startswith(("side_i.", "context.")))
    side_ii = tuple(index for index, name in enumerate(feature_names) if name.startswith(("side_ii.", "context.")))
    candidates = [
        ("Balanced logistic regression", pipeline(LogisticRegression(C=0.05, class_weight="balanced", max_iter=2500), True), False),
        ("Balanced Extra Trees", pipeline(ExtraTreesClassifier(n_estimators=240, class_weight="balanced", min_samples_leaf=2, max_features="sqrt", random_state=42, n_jobs=1)), False),
        ("Normal-reference side Isolation Forest", pipeline(SideIsolationForest(side_i, side_ii)), False),
    ]
    try:
        from xgboost import XGBClassifier
    except ImportError:
        return candidates
    candidates.insert(2, ("Class-weighted XGBoost", pipeline(XGBClassifier(n_estimators=180, max_depth=3, learning_rate=0.04, min_child_weight=3, subsample=0.85, colsample_bytree=0.7, reg_lambda=5, objective="multi:softprob", eval_metric="mlogloss", tree_method="hist", random_state=42, n_jobs=1)), True))
    return candidates


def _fit(estimator, X, y, weighted=False):
    if weighted:
        return estimator.fit(X, y, model__sample_weight=compute_sample_weight("balanced", y))
    return estimator.fit(X, y)


def train(data_dir: Path, artifact_dir: Path) -> dict:
    data_dir, artifact_dir = Path(data_dir), Path(artifact_dir)
    table, label_path = _label_table(data_dir, "label")
    if not set(table["label"]) <= set(LABELS):
        raise ValueError("Rail training labels must be Normal, Side I or Side II")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for index, row in table.iterrows():
        records.append(_cached_features(data_dir / "Train" / row["filename"], artifact_dir))
        if (index + 1) % 25 == 0 or index + 1 == len(table):
            print(f"Rail features: {index + 1}/{len(table)}", flush=True)
    names = list(records[0]["features"])
    if any(list(record["features"]) != names for record in records):
        raise ValueError("Rail feature schemas differ; clear outdated feature caches")
    X = np.array([list(record["features"].values()) for record in records])
    y = np.array([LABELS.index(label) for label in table["label"]])
    groups, duplicate_links = duplicate_groups(records)
    for group in np.unique(groups):
        if len(np.unique(y[groups == group])) != 1:
            raise ValueError("Identical/near-identical Rail recordings have conflicting class labels; resolve before training")
    minimum_groups = min(len(np.unique(groups[y == category])) for category in range(3))
    folds_count = min(4, minimum_groups)
    if folds_count < 2:
        raise ValueError("Rail validation needs at least two independent training groups in every class")
    splitter = StratifiedGroupKFold(n_splits=folds_count, shuffle=True, random_state=42)
    folds = list(splitter.split(X, y, groups))
    fold_ids = np.full(len(y), -1, dtype=int)
    for fold, (training, validation) in enumerate(folds):
        if set(groups[training]) & set(groups[validation]):
            raise RuntimeError("Duplicate groups leaked across a validation fold")
        if len(np.unique(y[training])) != 3:
            raise ValueError("A Rail training fold lacks a class; more independent examples are required")
        fold_ids[validation] = fold
    candidates, results, predictions = _candidates(names), [], {}
    for name, estimator, weighted in candidates:
        oof = np.full(len(y), -1, dtype=int)
        scores = []
        for training, validation in folds:
            model = _fit(clone(estimator), X[training], y[training], weighted)
            oof[validation] = model.predict(X[validation]).astype(int)
            scores.append(float(f1_score(y[validation], oof[validation], labels=[0, 1, 2], average="macro", zero_division=0)))
        score = float(f1_score(y, oof, labels=[0, 1, 2], average="macro", zero_division=0))
        results.append({"name": name, "score": score, "fold_scores": scores,
                        "confusion_matrix": confusion_matrix(y, oof, labels=[0, 1, 2]).tolist(),
                        "per_class": classification_report(y, oof, labels=[0, 1, 2], target_names=LABELS, output_dict=True, zero_division=0)})
        predictions[name] = oof
        print(f"Rail OOF {name}: macro F1={score:.6f}", flush=True)
    selected = max(range(len(results)), key=lambda index: results[index]["score"])
    model_name, estimator, weighted = candidates[selected]
    fitted = _fit(clone(estimator), X, y, weighted)
    limitations = [
        "Local grouped cross-validation on organiser training recordings; hidden official test performance is unavailable.",
        "The same out-of-fold results select the candidate model, so the displayed winning validation score has model-selection optimism; there is no independent outer test split.",
        "Exact numerical copies and conservative near-identical waveform sketches are grouped; unknown acquisition-run dependence may remain.",
        f"Only {int(np.count_nonzero(y == 1))} Side I training files are available. No calibrated confidence, GPS position, remaining life or confirmed maintenance diagnosis is inferred.",
        "Speed is estimated from rising pulse edges with 90 teeth and 0.85 m wheel diameter; one-second boundary truncation introduces counting uncertainty.",
    ]
    metadata = {"subsystem": "rail", "model_name": model_name, "trained_at": datetime.now(timezone.utc).isoformat(),
                "training_files": len(records), "training_rows": sum(record["samples"] for record in records),
                "feature_version": VERSION, "feature_names": names, "feature_count": len(names), "class_order": list(LABELS),
                "class_counts": {label: int(np.count_nonzero(y == index)) for index, label in enumerate(LABELS)},
                "validation": {"metric": "macro_f1", "score": results[selected]["score"], "method": f"{folds_count}-fold StratifiedGroupKFold on whole training files, seed 42; duplicate waveform groups kept together; fold-fitted preprocessing; selected model refitted on all training files", "candidates": results, "limitations": limitations},
                "limitations": limitations, "duplicate_links": duplicate_links, "independent_groups": int(len(np.unique(groups))),
                "source_hashes": {record["filename"]: record["sha256"] for record in records}, "labels_sha256": _sha256(label_path)}
    oof_table = [{"file_id": record["filename"], "group": int(groups[index]), "fold": int(fold_ids[index]), "true": LABELS[y[index]],
                  **{name: LABELS[values[index]] for name, values in predictions.items()}} for index, record in enumerate(records)]
    _json(artifact_dir / "oof_predictions.json", oof_table)
    temporary_model = artifact_dir / "model.joblib.tmp"
    joblib.dump({"version": VERSION, "subsystem": "rail", "model_name": model_name, "estimator": fitted, "feature_names": names}, temporary_model, compress=3)
    temporary_model.replace(artifact_dir / "model.joblib")
    metadata["model_sha256"] = _sha256(artifact_dir / "model.joblib")
    _json(artifact_dir / "metadata.json", metadata)
    return metadata


def _load_model(artifact_dir: Path, subsystem: str, version: str | int) -> dict:
    path = Path(artifact_dir) / "model.joblib"
    if not path.is_file():
        raise ValueError(f"No trained {subsystem} model is installed. Train on the organiser training release before inference")
    try:
        metadata = json.loads((Path(artifact_dir) / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"The {subsystem} artifact is missing readable provenance metadata") from exc
    if not isinstance(metadata, dict):
        raise ValueError(f"The {subsystem} artifact is missing readable provenance metadata")
    expected = metadata.get("model_sha256")
    try:
        serialized = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"Cannot read the trusted local {subsystem} model artifact") from exc
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(serialized).hexdigest() != expected:
        raise ValueError(f"The {subsystem} model does not match its saved provenance hash; finish training or restore a complete trusted artifact")
    metadata_version = metadata.get("feature_version", metadata.get("artifact_version"))
    if metadata.get("subsystem") != subsystem or metadata_version != version:
        raise ValueError(f"The {subsystem} artifact provenance uses an incompatible subsystem or feature version")
    try:
        # Only the application's trusted local artifact directory is accepted by
        # the service. User uploads are data files, never executable model blobs.
        # Deserialize the same bytes checked above, even if a concurrent model
        # publication replaces the original path after this read.
        bundle = joblib.load(io.BytesIO(serialized))
    except Exception as exc:
        raise ValueError(f"Cannot load the trusted local {subsystem} model artifact") from exc
    if not isinstance(bundle, dict) or bundle.get("subsystem") != subsystem or bundle.get("version") != version:
        raise ValueError(f"The {subsystem} artifact uses an incompatible feature version; rebuild from permitted training data")
    names = bundle.get("feature_names")
    model_name = bundle.get("name" if subsystem in {"door", "acv"} else "model_name")
    if (not isinstance(names, list) or not names or
            any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names) or
            not isinstance(model_name, str) or not model_name.strip() or
            metadata.get("model_name") != model_name or metadata.get("feature_names") != names):
        raise ValueError(f"The {subsystem} model schema does not match its saved provenance metadata")
    return bundle


def _feature_matrix(features: dict, names: list[str], subsystem: str) -> np.ndarray:
    if not set(names).issubset(features):
        raise ValueError(f"The frozen {subsystem} model expects an incompatible feature schema; restore a complete compatible artifact")
    values = np.asarray([[features[key] for key in names]], dtype=float)
    if not np.isfinite(values).all():
        raise ValueError(f"The {subsystem} recording produced non-finite features; check the source measurements and numeric range")
    return values


def _predict_one(bundle: dict, values: np.ndarray, subsystem: str) -> float:
    """Fail clearly for an incomplete artifact or an invalid model response."""
    estimator = bundle.get("estimator")
    if not callable(getattr(estimator, "predict", None)):
        raise ValueError(f"The frozen {subsystem} model artifact is missing its predictor")
    try:
        prediction = np.asarray(estimator.predict(values), dtype=float)
    except (ValueError, TypeError, AttributeError, KeyError, IndexError, OverflowError) as exc:
        raise ValueError(f"The frozen {subsystem} model could not score these features; check its compatible artifact and source measurements") from exc
    if prediction.shape != (1,) or not np.isfinite(prediction).all():
        raise ValueError(f"The frozen {subsystem} model returned an invalid prediction")
    return float(prediction[0])


def _envelope(values: np.ndarray, max_points=400, x_scale=1.0) -> list[dict]:
    """Min/max envelope preserves visible peaks without a misleading smooth trace."""
    points = []
    for indices in np.array_split(np.arange(len(values)), min(max_points // 2, len(values))):
        if not len(indices):
            continue
        chosen = sorted({int(indices[np.argmin(values[indices])]), int(indices[np.argmax(values[indices])])})
        points.extend({"x": index * x_scale, "y": float(values[index])} for index in chosen)
    return points


def predict(path: Path, artifact_dir: Path) -> dict:
    path = Path(path)
    bundle = _load_model(artifact_dir, "rail", VERSION)
    signal, warnings_list = load_signal(path)
    record = extract_features(signal)
    X = _feature_matrix(record["features"], bundle["feature_names"], "Rail")
    predicted = _predict_one(bundle, X, "Rail")
    if predicted not in range(3):
        raise ValueError("Frozen Rail model returned an invalid class")
    category = int(predicted)
    prediction = LABELS[category]
    _, measured = _summaries(signal)
    evidence = [{"id": "rail-speed", "label": "Estimated running speed", "value": measured["speed_m_s"], "unit": "m/s",
                 "detail": f"{measured['rising_edges']} rising tooth edges / 1 second / 90 teeth × pi × 0.85 m; no GPS is inferred", "source": f"{path.name} / Rotating speed / full 10,000 samples"}]
    series, entities = [], []
    for side_number, side_name in ((1, "Side I"), (2, "Side II")):
        side_rms = []
        for kind_index, kind in enumerate(("vibration", "shock")):
            columns = [((car - 1) * 8 + position - 1) * 2 + kind_index for car in range(1, 9) for position in range(1, 9) if (position % 2 == 1) == (side_number == 1)]
            median_rms = float(np.median(measured["rms"][columns]))
            evidence.append({"id": f"rail-side-{side_number}-{kind}", "label": f"{side_name} median {kind} RMS", "value": median_rms, "unit": "m/s²",
                             "detail": "Median of full-recording RMS over 32 axle-box channels on this rail side; a measurement, not feature attribution", "source": f"{path.name} / {side_name} {kind} channels"})
            column = max(columns, key=lambda index: measured["rms"][index])
            car, position = column // 16 + 1, (column % 16) // 2 + 1
            series.append({"name": f"{side_name}: Car {car:02} position {position} {kind} (largest RMS channel)", "x_label": "Recording time (seconds)", "y_label": "Acceleration (m/s²)", "points": _envelope(signal[:, column + 1], x_scale=1 / SAMPLE_RATE)})
            side_rms.append(median_rms)
        entities.append({"id": f"side-{side_number}", "label": side_name, "value": side_rms[0], "status": "predicted_corrugation" if category == side_number else "not_predicted",
                         "detail": "Odd axle positions (1,3,5,7)" if side_number == 1 else "Even axle positions (2,4,6,8)"})
    warnings_list.extend(["Prediction from a frozen organiser-training model; official test labels are hidden and this result is not independently verified.",
                          "The recording describes an eight-car sensor arrangement, not a named Singapore MRT train or map location.",
                          "Charts show min/max envelopes (at most 400 points); features use all 10,000 samples. Side RMS measurements are not causal feature contributions."])
    return {"subsystem": "rail", "file_id": path.name, "model_name": bundle["model_name"],
            "summary": f"The one-second recording is classified as {prediction}. Odd/even axle positions retain the organiser's rail-side mapping.",
            "prediction_rows": [{"file_id": path.name, "prediction": prediction}], "evidence": evidence,
            "warnings": warnings_list, "series": series, "entities": entities}
