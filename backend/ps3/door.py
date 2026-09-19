"""Door action detection, grouped validation and frozen supervised inference.

Gap boundaries are observable in the released streams. They are a baseline for
that recording format, not a claim of a general live door-cycle detector.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from backend.ps3.rail import MAX_FILE_BYTES, _load_model
from backend.ps3.preview import sampled_trace_points

VERSION = 1
LABELS = ("Normal", "Abnormal resistance")
CHANNELS = {
    "current": ("motorcurrentma",),
    "voltage": ("motorvoltage10mv",),
    "back_emf": ("motorelectrodynamicforce", "motorbackelectromotiveforce"),
    "position": ("doorleafposition",),
    "open_command": ("opencommand",),
    "close_command": ("closecommand",),
    "opening": ("doorisopening",),
    "closing": ("doorisclosing",),
}
LIMITATIONS = [
    "Local blocked validation uses one labelled stream; it does not establish transfer to other doors or operating conditions.",
    "Segmentation uses recording gaps learned from training cadence; uninterrupted or differently sampled streams may not separate into true actions.",
    "Candidate scores were used for model selection and are not an independent final test score.",
    "Predicted abnormal resistance is a model classification, not a verified mechanical fault or calibrated failure probability.",
    "Source timestamps have no documented timezone; back-EMF and position units are unspecified.",
]


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def parse_timestamp(value) -> pd.Timestamp:
    """The last native field is an integer millisecond count, including `20`."""
    if pd.isna(value):
        raise ValueError("Door timestamps cannot be blank.")
    text = str(value).strip()
    if re.fullmatch(r"\d{4}(?:-\d+){6}", text):
        parts = [int(x) for x in text.split("-")]
        if not 0 <= parts[-1] <= 999:
            raise ValueError(f"Invalid Door millisecond field: {text}")
        try:
            return pd.Timestamp(datetime(*parts[:6], microsecond=parts[6] * 1000))
        except (ValueError, OverflowError) as exc:
            raise ValueError(f"Invalid Door timestamp: {text}") from exc
    try:
        result = pd.Timestamp(text)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError(f"Cannot parse Door timestamp: {text}") from exc
    if pd.isna(result) or result.tzinfo is not None:
        raise ValueError("Door timestamps must be valid, timezone-free values matching the source clock.")
    return result


def native_timestamp(value) -> str:
    t = pd.Timestamp(value)
    return f"{t.year}-{t.month}-{t.day}-{t.hour}-{t.minute}-{t.second}-{t.microsecond // 1000}"


def load_stream(path: Path) -> pd.DataFrame:
    path = Path(path)
    if path.suffix.lower() != ".csv":
        raise ValueError("Door inputs must be CSV files with Datetime and door sensor headers.")
    try:
        if path.stat().st_size == 0 or path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("Door CSV must be nonempty and at most 64 MiB.")
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            headers = next(reader)
            normalized = [_key(name) for name in headers]
            if any(not name for name in normalized) or len(normalized) != len(set(normalized)):
                raise ValueError("Door CSV column names must be nonblank and unique after normalizing case and punctuation.")
            for line, row in enumerate(reader, 2):
                if len(row) != len(headers):
                    raise ValueError(f"Door CSV line {line} has {len(row)} fields; expected {len(headers)}.")
        raw = pd.read_csv(path, keep_default_na=False, encoding="utf-8-sig")
    except (OSError, UnicodeError, csv.Error, pd.errors.ParserError, StopIteration) as exc:
        raise ValueError("Cannot read Door CSV; supply a readable UTF-8 file with complete quoted fields and sensor headers.") from exc
    if len(raw) < 2 or len(raw) > 1_000_000:
        raise ValueError("Door CSV must contain between 2 and 1,000,000 readings.")
    names = {_key(str(c)): c for c in raw.columns}
    if "datetime" in names and "timestamp" in names:
        raise ValueError("Door CSV has ambiguous timestamp columns; supply exactly one Datetime or Timestamp column.")
    timestamp = names.get("datetime") or names.get("timestamp")
    if not timestamp:
        raise ValueError("Door CSV is missing its Datetime column (seven-part native timestamps are supported).")
    frame = pd.DataFrame({"timestamp": [parse_timestamp(v) for v in raw[timestamp]]})
    if frame.timestamp.duplicated().any() or not frame.timestamp.is_monotonic_increasing:
        raise ValueError("Door timestamps must be unique and increasing; reorder or resolve duplicates before uploading.")
    missing = []
    for key, aliases in CHANNELS.items():
        if sum(alias in names for alias in aliases) > 1:
            raise ValueError(f"Door CSV has multiple aliases for {key}; retain one unambiguous sensor column.")
        column = next((names[a] for a in aliases if a in names), None)
        frame[key] = pd.to_numeric(raw[column], errors="coerce") if column else np.nan
        frame[key] = frame[key].replace([np.inf, -np.inf], np.nan)
        if frame[key].abs().gt(1e12).any():
            raise ValueError(f"Door {key} values exceed the supported numeric range; check source units and corrupted cells.")
        if column is None and key in ("current", "voltage", "back_emf", "position"):
            missing.append(key)
    if missing:
        raise ValueError(f"Door CSV is missing required sensor columns: {', '.join(missing)}.")
    if frame[["current", "voltage", "back_emf", "position"]].notna().sum().max() < 2:
        raise ValueError("Door CSV contains no usable numeric sensor readings.")
    return frame


def _load_answers(path: Path, frame: pd.DataFrame) -> pd.DataFrame:
    try:
        answers = pd.read_csv(path, dtype=str, keep_default_na=False)
    except (OSError, pd.errors.ParserError) as exc:
        raise ValueError(f"Cannot read Door training labels: {exc}") from exc
    if not {"start_time", "end_time", "status"}.issubset(answers.columns):
        raise ValueError("Door training labels need start_time, end_time and status.")
    answers["start"] = answers.start_time.map(parse_timestamp)
    answers["end"] = answers.end_time.map(parse_timestamp)
    answers = answers.sort_values("start").reset_index(drop=True)
    if len(answers) < 10 or set(answers.status) != set(LABELS):
        raise ValueError("Door training requires at least ten labelled actions including both classes.")
    if (answers.end <= answers.start).any() or (answers.start.iloc[1:].to_numpy() <= answers.end.iloc[:-1].to_numpy()).any():
        raise ValueError("Door training action intervals must be positive-length and non-overlapping.")
    for row in answers.itertuples():
        segment = frame.loc[frame.timestamp.between(row.start, row.end)]
        if segment.empty or segment.timestamp.iloc[0] != row.start or segment.timestamp.iloc[-1] != row.end:
            raise ValueError("Door training annotation boundaries must correspond to stream readings.")
        if "n_rows" in answers and len(segment) != int(row.n_rows):
            raise ValueError("Door training annotation n_rows does not match its stream interval.")
    return answers


def segmentation_config(frame: pd.DataFrame) -> dict:
    intervals = frame.timestamp.diff().dt.total_seconds().dropna()
    cadence = float(intervals[intervals > 0].median())
    if not np.isfinite(cadence) or cadence <= 0:
        raise ValueError("Cannot establish Door sampling cadence from training data.")
    return {"cadence_seconds": cadence, "gap_seconds": max(.2, cadence * 8), "method": "training-cadence gaps"}


def segment_stream(frame: pd.DataFrame, config: dict) -> list[pd.DataFrame]:
    boundaries = frame.timestamp.diff().dt.total_seconds().gt(config["gap_seconds"]).cumsum()
    return [part.reset_index(drop=True) for _, part in frame.groupby(boundaries, sort=False)]


def action_features(frame: pd.DataFrame) -> dict[str, float]:
    result = {"duration_seconds": float((frame.timestamp.iloc[-1] - frame.timestamp.iloc[0]).total_seconds())}
    for key in ("current", "voltage", "back_emf", "position"):
        values = frame[key].dropna().to_numpy(float)
        for name in ("mean", "std", "min", "max", "q10", "q50", "q90", "rms", "change", "variation"):
            result[f"{key}_{name}"] = np.nan
        if len(values):
            result.update({f"{key}_mean": float(np.mean(values)), f"{key}_std": float(np.std(values)),
                           f"{key}_min": float(np.min(values)), f"{key}_max": float(np.max(values)),
                           f"{key}_rms": float(np.sqrt(np.mean(values ** 2))),
                           f"{key}_change": float(values[-1] - values[0]),
                           f"{key}_variation": float(np.mean(np.abs(np.diff(values)))) if len(values) > 1 else 0.})
            for q in (10, 50, 90):
                result[f"{key}_q{q}"] = float(np.percentile(values, q))
    for key in ("open_command", "close_command", "opening", "closing"):
        result[f"{key}_fraction"] = float(frame[key].mean()) if frame[key].notna().any() else np.nan
    return result


def iou_weighted_f1(truth: list[dict], predictions: list[dict]) -> float:
    candidates = []
    for ti, true in enumerate(truth):
        a, b = parse_timestamp(true["start_time"]), parse_timestamp(true["end_time"])
        for pi, pred in enumerate(predictions):
            if true.get("prediction", true.get("status")) != pred["prediction"]:
                continue
            c, d = parse_timestamp(pred["start_time"]), parse_timestamp(pred["end_time"])
            overlap = max(0., (min(b, d) - max(a, c)).total_seconds())
            union = (b - a).total_seconds() + (d - c).total_seconds() - overlap
            if overlap > 0 and union > 0:
                candidates.append((overlap / union, ti, pi))
    used_true, used_pred, credit = set(), set(), 0.
    for iou, ti, pi in sorted(candidates, key=lambda item: (-item[0], item[1], item[2])):
        if ti not in used_true and pi not in used_pred:
            used_true.add(ti); used_pred.add(pi); credit += iou
    return 2 * credit / (len(truth) + len(predictions)) if truth or predictions else 0.


def blocked_folds(answers: pd.DataFrame, count: int = 5, groups: list[str] | None = None) -> list[tuple[np.ndarray, np.ndarray]]:
    indexes = np.arange(len(answers))
    result = []
    for holdout in np.array_split(indexes, min(count, len(answers))):
        if not len(holdout):
            continue
        training = np.setdiff1d(indexes, holdout)
        if groups is not None:
            forbidden = {groups[i] for i in holdout}
            training = np.asarray([i for i in training if groups[i] not in forbidden], dtype=int)
        result.append((training, holdout))
    return result


def _candidate_names() -> list[str]:
    names = ["Regularized logistic regression", "Extra Trees", "Normal-cycle Isolation Forest"]
    try:
        import xgboost  # noqa: F401
        names.append("XGBoost classifier")
    except ImportError:
        pass
    return names


def _fit(name: str, x: pd.DataFrame, y: np.ndarray) -> dict:
    preprocess = Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)), ("scale", StandardScaler())])
    if name == "Normal-cycle Isolation Forest":
        transformed = preprocess.fit_transform(x.loc[y == 0])
        estimator = IsolationForest(n_estimators=160, contamination=.10, random_state=42, n_jobs=1).fit(transformed)
    else:
        transformed = preprocess.fit_transform(x)
        if name == "Regularized logistic regression":
            estimator = LogisticRegression(C=.5, class_weight="balanced", max_iter=2000, random_state=42)
        elif name == "Extra Trees":
            estimator = ExtraTreesClassifier(n_estimators=160, max_depth=5, min_samples_leaf=3, class_weight="balanced", random_state=42, n_jobs=1)
        else:
            from xgboost import XGBClassifier
            estimator = XGBClassifier(n_estimators=100, max_depth=2, learning_rate=.05, min_child_weight=3, reg_lambda=5, subsample=.9, colsample_bytree=.9, scale_pos_weight=float(np.sum(y == 0) / max(1, np.sum(y == 1))), eval_metric="logloss", random_state=42, n_jobs=1)
        estimator.fit(transformed, y)
    return {"name": name, "preprocess": preprocess, "estimator": estimator, "feature_names": list(x.columns)}


def _classify(model: dict, features: pd.DataFrame) -> np.ndarray:
    values = model["preprocess"].transform(features.reindex(columns=model["feature_names"]))
    raw = np.asarray(model["estimator"].predict(values))
    allowed = [-1, 1] if model["name"] == "Normal-cycle Isolation Forest" else [0, 1]
    if raw.shape != (len(features),) or not np.isin(raw, allowed).all():
        raise ValueError("The frozen Door model returned invalid action classifications.")
    return (raw == -1).astype(int) if model["name"] == "Normal-cycle Isolation Forest" else raw.astype(int)


def _rows(segments: list[pd.DataFrame], classified: np.ndarray) -> list[dict]:
    return [{"start_time": native_timestamp(part.timestamp.iloc[0]), "end_time": native_timestamp(part.timestamp.iloc[-1]), "prediction": LABELS[int(label)]} for part, label in zip(segments, classified)]


def train(data_dir: Path, artifact_dir: Path) -> dict:
    data_dir, artifact_dir = Path(data_dir), Path(artifact_dir)
    stream_path, labels_path = data_dir / "Train.csv", data_dir / "Train_Segments_Answer.csv"
    frame = load_stream(stream_path)
    answers = _load_answers(labels_path, frame)
    actions = [frame.loc[frame.timestamp.between(row.start, row.end)].reset_index(drop=True) for row in answers.itertuples()]
    x = pd.DataFrame([action_features(action) for action in actions])
    y = (answers.status == LABELS[1]).to_numpy(int)
    groups = [hashlib.sha256(pd.util.hash_pandas_object(action[list(CHANNELS)], index=False).to_numpy().tobytes()).hexdigest() for action in actions]
    for group in set(groups):
        if len({int(y[i]) for i, value in enumerate(groups) if value == group}) > 1:
            raise ValueError("Identical Door action waveforms have conflicting training labels.")
    names = _candidate_names()
    candidate_predictions = {name: [] for name in names}
    folds = []
    for fold, (training, validation) in enumerate(blocked_folds(answers, groups=groups), 1):
        if len(np.unique(y[training])) < 2:
            raise ValueError("A Door training block contains only one class; more labelled actions are needed for blocked validation.")
        permitted = pd.concat([actions[i] for i in training]).sort_values("timestamp")
        config = segmentation_config(permitted)
        start, end = answers.iloc[validation[0]].start, answers.iloc[validation[-1]].end
        heldout_stream = frame.loc[frame.timestamp.between(start, end)].reset_index(drop=True)
        detected = segment_stream(heldout_stream, config)
        features = pd.DataFrame([action_features(part) for part in detected])
        truth = answers.iloc[validation][["start_time", "end_time", "status"]].to_dict("records")
        record = {"fold": fold, "training_actions": training.tolist(), "heldout_actions": validation.tolist(), "heldout_start": native_timestamp(start), "heldout_end": native_timestamp(end), "true_actions": len(truth), "detected_actions": len(detected), "segmentation": config, "scores": {}}
        for name in names:
            model = _fit(name, x.iloc[training], y[training])
            predicted = _rows(detected, _classify(model, features))
            candidate_predictions[name].extend(predicted)
            record["scores"][name] = iou_weighted_f1(truth, predicted)
        folds.append(record)
    truth = answers[["start_time", "end_time", "status"]].to_dict("records")
    candidates = [{"name": name, "score": iou_weighted_f1(truth, candidate_predictions[name])} for name in names]
    selected = max(candidates, key=lambda candidate: candidate["score"])
    model = _fit(selected["name"], x, y)
    model.update({"version": VERSION, "subsystem": "door", "segmentation": segmentation_config(frame)})
    # This classification diagnostic is available only when inferred boundaries
    # actually equal the annotation boundaries; the primary metric is always E2E.
    selected_rows = candidate_predictions[selected["name"]]
    exact = {(row["start_time"], row["end_time"]): row["prediction"] for row in selected_rows}
    diagnostic = None
    if len(exact) == len(truth) and all((row["start_time"], row["end_time"]) in exact for row in truth):
        diagnostic = classification_report([row["status"] for row in truth], [exact[(row["start_time"], row["end_time"])] for row in truth], labels=list(LABELS), output_dict=True, zero_division=0)
    metadata = {"subsystem": "door", "model_name": selected["name"], "trained_at": datetime.now(timezone.utc).isoformat(), "training_files": 1, "training_rows": len(frame), "training_actions": len(answers), "feature_names": list(x.columns), "artifact_version": VERSION,
                "training_sources": [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in (stream_path, labels_path)],
                "validation": {"metric": "IoU-weighted F1", "score": selected["score"], "method": "5 contiguous held-out action blocks; detector and classifier run end-to-end on each held-out stream block; all preprocessing fitted on the other blocks", "candidates": candidates, "folds": folds, "classification_at_exact_boundaries": diagnostic, "limitations": LIMITATIONS}, "limitations": LIMITATIONS}
    artifact_dir.mkdir(parents=True, exist_ok=True)
    # Hash this fit's serialized bytes before publishing either file. A reader
    # verifies the binding, so overlapping publication is unavailable, not mislabeled.
    token = uuid.uuid4().hex
    temporary_model = artifact_dir / f".model-{token}.tmp"
    temporary_metadata = artifact_dir / f".metadata-{token}.tmp"
    try:
        joblib.dump(model, temporary_model)
        metadata["model_sha256"] = hashlib.sha256(temporary_model.read_bytes()).hexdigest()
        temporary_metadata.write_text(json.dumps(metadata, indent=2, allow_nan=False), encoding="utf-8")
        temporary_model.replace(artifact_dir / "model.joblib")
        temporary_metadata.replace(artifact_dir / "metadata.json")
    finally:
        temporary_model.unlink(missing_ok=True)
        temporary_metadata.unlink(missing_ok=True)
    (artifact_dir / "validation_predictions.json").write_text(json.dumps(candidate_predictions, indent=2, allow_nan=False), encoding="utf-8")
    return metadata


def predict(path: Path, artifact_dir: Path) -> dict:
    path, artifact_dir = Path(path), Path(artifact_dir)
    model = _load_model(artifact_dir, "door", VERSION)
    config = model.get("segmentation")
    if (not isinstance(config, dict) or any(
            not isinstance(config.get(key), (int, float)) or not np.isfinite(config[key]) or config[key] <= 0
            for key in ("cadence_seconds", "gap_seconds")) or
            not callable(getattr(model.get("preprocess"), "transform", None)) or
            not callable(getattr(model.get("estimator"), "predict", None))):
        raise ValueError("The frozen Door artifact is missing a valid segmenter, preprocessor or predictor.")
    frame = load_stream(path)
    segments = segment_stream(frame, config)
    if len(segments) > 20_000:
        raise ValueError("Door input produces too many isolated segments for this recording format.")
    empty = [i + 1 for i, part in enumerate(segments) if not part[["current", "voltage", "back_emf", "position"]].notna().any().any()]
    if empty:
        raise ValueError(f"Door action segment {empty[0]} has no usable physical sensor measurements; supply measured data for every action instead of classifying an entirely missing segment.")
    features = pd.DataFrame([action_features(part) for part in segments])
    if set(features.columns) != set(model["feature_names"]):
        raise ValueError("The frozen Door model expects an incompatible feature schema; restore a complete compatible artifact.")
    try:
        classified = np.asarray(_classify(model, features))
    except (ValueError, TypeError, AttributeError, KeyError, IndexError, OverflowError) as exc:
        raise ValueError("The frozen Door model could not score this recording; check its compatible artifact and source measurements.") from exc
    if classified.shape != (len(segments),) or not np.isin(classified, [0, 1]).all():
        raise ValueError("The frozen Door model returned invalid action classifications.")
    rows = _rows(segments, classified)
    abnormal = sum(row["prediction"] == LABELS[1] for row in rows)
    warnings = list(LIMITATIONS[1:])
    if abnormal > 5:
        warnings.append("Per-action measurements are shown for the first five model-flagged actions; predictions still include every detected action.")
    if len(segments) == 1:
        warnings.append("No inter-action gaps were detected: the entire recording is one candidate. Its true action count is unknown.")
    short = sum(len(part) < 3 for part in segments)
    if short:
        warnings.append(f"{short} inferred segments contain fewer than three readings; classifications have limited evidence.")
    missing = int(frame[list(CHANNELS)].isna().sum().sum())
    if missing:
        warnings.append(f"{missing} missing/non-numeric sensor cells are retained as missing; training-fitted feature imputation is used.")
    cadence = float(frame.timestamp.diff().dt.total_seconds().dropna().median())
    if not .5 <= cadence / model["segmentation"]["cadence_seconds"] <= 2:
        warnings.append("Observed cadence differs substantially from training; the frozen gap threshold may not identify actions correctly.")
    seconds = (frame.timestamp - frame.timestamp.iloc[0]).dt.total_seconds()
    preview_gaps = frame.timestamp.diff().dt.total_seconds().gt(3 * cadence)
    series = [{"name": name, "x_label": "Seconds from recording start", "y_label": units,
               "points": sampled_trace_points(seconds, frame[key], break_before=preview_gaps)}
              for key, name, units in [
                  ("current", "Motor current", "mA"),
                  ("voltage", "Motor voltage", "10 mV source units"),
                  ("back_emf", "Motor back-EMF", "Raw units; calibration unspecified"),
                  ("position", "Door leaf position", "Raw units; calibration unspecified"),
                  ("open_command", "Open command", "Source state code"),
                  ("close_command", "Close command", "Source state code"),
                  ("opening", "Door opening state", "Source state code"),
                  ("closing", "Door closing state", "Source state code"),
              ] if frame[key].notna().any()]
    action_evidence = []
    for index in [i for i, row in enumerate(rows) if row["prediction"] == LABELS[1]][:5]:
        part, row = segments[index], rows[index]
        current = part.current.dropna().abs()
        source = f"{path.name} / action {index + 1} / {row['start_time']} to {row['end_time']}"
        action_evidence.extend([
            {"id": f"door-action-{index + 1}-current", "label": f"Action {index + 1} peak absolute motor current", "value": float(current.max()) if len(current) else None, "unit": "mA", "source": source,
             "detail": "Maximum absolute measured motor current within this model-flagged segment; null means unavailable. Descriptive evidence, not a fault threshold or model attribution."},
            {"id": f"door-action-{index + 1}-duration", "label": f"Action {index + 1} measured duration", "value": float((part.timestamp.iloc[-1] - part.timestamp.iloc[0]).total_seconds()), "unit": "seconds", "source": source,
             "detail": "Last minus first source timestamp within this model-flagged segment; descriptive evidence, not a fault threshold or model attribution."},
        ])
    return {"subsystem": "door", "file_id": path.name, "model_name": model["name"],
            "summary": f"Detected {len(rows)} candidate door actions; {abnormal} classified as abnormal resistance. Segment boundaries and classifications require engineering review.",
            "prediction_rows": rows, "warnings": warnings, "series": series,
            "evidence": [{"id": "door-actions", "label": "Detected candidate actions", "value": len(rows), "source": path.name, "detail": f"Split where timestamp gaps exceed the frozen {model['segmentation']['gap_seconds']:.3g} s threshold."},
                         {"id": "door-abnormal", "label": "Abnormal-resistance classifications", "value": abnormal, "source": path.name, "detail": "Model labels per detected action, not verified faults."},
                         {"id": "door-cadence", "label": "Median observed interval", "value": cadence, "unit": "seconds", "source": path.name}] + action_evidence,
            "entities": [{"id": f"action-{i + 1}", "label": f"Action {i + 1}", "value": None, "status": "abnormal" if row["prediction"] == LABELS[1] else "normal", "detail": f"{row['start_time']} to {row['end_time']}: {row['prediction']}"} for i, row in enumerate(rows)]}
