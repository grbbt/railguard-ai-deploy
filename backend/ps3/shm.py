"""PS3 measured-stress regression, with rainflow features and frozen inference.

Samples have no documented physical unit or sampling rate. The estimated target
is cumulative fatigue damage for one recording, not failure probability or RUL.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import warnings

import joblib
import numpy as np
import pandas as pd
import rainflow
from scipy.special import logsumexp
from sklearn.base import BaseEstimator, RegressorMixin, clone
from sklearn.compose import TransformedTargetRegressor
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_absolute_percentage_error, mean_squared_error
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from backend.ps3.rail import MAX_FILE_BYTES, _envelope, _feature_matrix, _json, _label_table, _load_model, _predict_one, _sha256, duplicate_groups

VERSION = "shm-rainflow-v1"
MOMENT_POWERS = (2, 3, 4, 5, 6, 7, 8)


def load_signal(path: Path) -> tuple[np.ndarray, list[str]]:
    path = Path(path)
    try:
        if path.stat().st_size == 0 or path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("SHM recording must be nonempty and at most 64 MiB")
        with warnings.catch_warnings():
            warnings.simplefilter("error", pd.errors.ParserWarning)
            frame = pd.read_csv(path, header=None, dtype=str, encoding="utf-8-sig", index_col=False, on_bad_lines="error", skip_blank_lines=False)
    except (OSError, UnicodeError, pd.errors.ParserError, pd.errors.EmptyDataError, pd.errors.ParserWarning) as exc:
        raise ValueError(f"Cannot read headerless SHM waveform {path.name}; expected one numeric column") from exc
    if frame.shape[1] != 1 or len(frame) < 128:
        raise ValueError(f"SHM requires a headerless one-column waveform of at least 128 samples; received {len(frame):,} rows and {frame.shape[1]} columns")
    signal = pd.to_numeric(frame.iloc[:, 0], errors="coerce").to_numpy(dtype=np.float64)
    if not np.isfinite(signal).all():
        count = int((~np.isfinite(signal)).sum())
        raise ValueError(f"SHM waveform contains {count} missing, nonnumeric or infinite samples; retain the real first sample, omit headers, and supply complete measurements for rainflow counting")
    if np.max(np.abs(signal)) > 1e12:
        raise ValueError("SHM amplitudes exceed the supported numeric range; check source units and corrupted cells")
    return signal, []


def extract_features(signal: np.ndarray) -> dict:
    """Every range/count comes from the complete original ordered waveform."""
    signal = np.asarray(signal, dtype=np.float64)
    cycles = np.asarray([(value, mean, count) for value, mean, count, _, _ in rainflow.extract_cycles(signal)], dtype=np.float64)
    if cycles.size:
        cycles = cycles.reshape(-1, 3)
        ranges, means, counts = cycles.T
        positive = ranges > 0
        ranges, means, counts = ranges[positive], means[positive], counts[positive]
    else:
        ranges = means = counts = np.array([], dtype=float)
    amplitude = ranges / 2  # S-N amplitude is half the rainflow peak-to-peak range.
    cycle_count = float(counts.sum())
    centered = signal - signal.mean()
    standard_deviation = float(np.sqrt(np.mean(centered**2)))
    absolute = np.abs(signal)
    features = {
        "log_sample_count": float(np.log(len(signal))),
        "mean_stress": float(signal.mean()),
        "log_abs_mean": float(np.log1p(absolute.mean())),
        "log_rms": float(np.log1p(np.sqrt(np.mean(signal**2)))),
        "log_std": float(np.log1p(standard_deviation)),
        "log_peak_to_peak": float(np.log1p(np.ptp(signal))),
        "log_abs_p50": float(np.log1p(np.percentile(absolute, 50))),
        "log_abs_p90": float(np.log1p(np.percentile(absolute, 90))),
        "log_abs_p99": float(np.log1p(np.percentile(absolute, 99))),
        "log_abs_peak": float(np.log1p(absolute.max())),
        "kurtosis": float(np.mean((centered / max(standard_deviation, 1e-12))**4)),
        "log_total_variation": float(np.log1p(np.abs(np.diff(signal)).sum())),
        "log_rainflow_count": float(np.log1p(cycle_count)),
        "rainflow_cycles_per_sample": cycle_count / len(signal),
        "log_range_weighted_mean": float(np.log1p(np.average(ranges, weights=counts))) if cycle_count else 0.0,
        "log_range_max": float(np.log1p(ranges.max())) if len(ranges) else 0.0,
        "log_cycle_abs_mean_stress": float(np.log1p(np.average(np.abs(means), weights=counts))) if cycle_count else 0.0,
    }
    # Log moments avoid overflow while preserving exposure and large-range cycles.
    for exponent in MOMENT_POWERS:
        total_log = float(logsumexp(np.log(counts) + exponent * np.log(amplitude))) if len(amplitude) else float(np.log(1e-30))
        features[f"log_rainflow_amplitude_moment_{exponent}"] = total_log
    if len(ranges):
        order = np.argsort(ranges)
        cumulative = np.cumsum(counts[order]) / cycle_count
        for quantile in (0.5, 0.9, 0.99):
            value = ranges[order[min(int(np.searchsorted(cumulative, quantile)), len(order) - 1)]]
            features[f"log_range_q{int(quantile * 100)}"] = float(np.log1p(value))
    else:
        features.update({f"log_range_q{quantile}": 0.0 for quantile in (50, 90, 99)})
    if not np.isfinite(list(features.values())).all():
        raise ValueError("SHM feature calculation produced nonfinite values; check the signal scale")
    indices = np.linspace(0, len(signal) - 1, 1024, dtype=int)
    return {"features": features, "samples": len(signal), "sketch": signal[indices].astype(np.float32),
            "signature": np.array([signal.mean(), np.sqrt(np.mean(signal**2))], dtype=float),
            "numeric_sha256": hashlib.sha256(np.ascontiguousarray(signal, dtype="<f8").tobytes()).hexdigest(),
            "measurements": {"rms": float(np.sqrt(np.mean(signal**2))), "range": float(np.ptp(signal)),
                             "rainflow_cycles": cycle_count, "maximum_cycle_range": float(ranges.max()) if len(ranges) else 0.0}}


def _cached_features(path: Path, artifact_dir: Path) -> dict:
    digest = _sha256(path)
    cache = Path(artifact_dir) / "feature_cache"
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{VERSION}-{digest}.joblib"
    if target.is_file():
        record = joblib.load(target)
    else:
        signal, _ = load_signal(path)
        record = extract_features(signal)
        if _sha256(path) != digest:
            raise ValueError(f"SHM source {path.name} changed during feature extraction; wait for the download or upload to finish")
        joblib.dump(record, target, compress=3)
    return {**record, "sha256": digest, "filename": path.name}


class RainflowMomentRegressor(RegressorMixin, BaseEstimator):
    """Train-fitted power-moment surrogate, not an asserted material S-N curve.

    The exponent choice and positive scale are fitted only to each training fold.
    A weighted median ratio minimizes training relative absolute error at each
    fixed exponent. Evaluation still occurs on separate whole-file folds.
    """
    def __init__(self, moment_indices=()):
        self.moment_indices = moment_indices

    def fit(self, X, y):
        X, y = np.asarray(X, dtype=float), np.asarray(y, dtype=float)
        best = None
        for index in self.moment_indices:
            ratios = np.log(y) - X[:, index]
            weights = np.exp(-ratios - np.max(-ratios))
            order = np.argsort(ratios)
            chosen = min(np.searchsorted(np.cumsum(weights[order]), weights.sum() / 2), len(order) - 1)
            scale = float(ratios[order[chosen]])
            prediction = np.exp(np.clip(X[:, index] + scale, -700, 700))
            error = float(np.mean(np.abs(y - prediction) / y))
            if best is None or error < best[0]:
                best = (error, index, scale)
        if best is None:
            raise ValueError("No rainflow moment features available")
        self.moment_index_, self.log_scale_ = best[1], best[2]
        self.n_features_in_ = X.shape[1]
        return self

    def predict(self, X):
        return np.exp(np.clip(np.asarray(X)[:, self.moment_index_] + self.log_scale_, -700, 700))


def _candidates(names: list[str]) -> list[tuple[str, object]]:
    log_ridge = TransformedTargetRegressor(regressor=Ridge(alpha=10.0), func=np.log, inverse_func=np.exp)
    candidates = [
        ("Training-median constant", DummyRegressor(strategy="median")),
        ("Regularized log-damage regression", Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)), ("scale", StandardScaler()), ("model", log_ridge)])),
        ("Rainflow moment surrogate", RainflowMomentRegressor(tuple(index for index, name in enumerate(names) if name.startswith("log_rainflow_amplitude_moment_")))),
        ("Extra Trees damage regression", ExtraTreesRegressor(n_estimators=240, min_samples_leaf=3, max_features=0.8, random_state=42, n_jobs=1)),
    ]
    try:
        from xgboost import XGBRegressor
    except ImportError:
        return candidates
    estimator = XGBRegressor(n_estimators=160, max_depth=2, learning_rate=0.035, min_child_weight=4, subsample=0.85, colsample_bytree=0.8, reg_lambda=10, objective="reg:squarederror", tree_method="hist", random_state=42, n_jobs=1)
    candidates.append(("XGBoost log-damage regression", TransformedTargetRegressor(regressor=estimator, func=np.log, inverse_func=np.exp)))
    return candidates


def _finite_predictions(values) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("Damage estimator produced a nonfinite prediction; no value was fabricated")
    return np.maximum(values, 0.0)


def train(data_dir: Path, artifact_dir: Path) -> dict:
    data_dir, artifact_dir = Path(data_dir), Path(artifact_dir)
    table, label_path = _label_table(data_dir, "damage")
    y = pd.to_numeric(table["damage"], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(y).all() or (y <= 0).any():
        raise ValueError("SHM training damage labels must be finite and positive for the released MAPE/log-target protocol; zero-target handling requires an explicit revised metric policy")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for index, row in table.iterrows():
        records.append(_cached_features(data_dir / "Train" / row["filename"], artifact_dir))
        if (index + 1) % 8 == 0 or index + 1 == len(table):
            print(f"SHM features: {index + 1}/{len(table)}", flush=True)
    names = list(records[0]["features"])
    if any(list(record["features"]) != names for record in records):
        raise ValueError("SHM feature schemas differ; clear outdated feature caches")
    X = np.array([list(record["features"].values()) for record in records])
    groups, duplicate_links = duplicate_groups(records)
    folds_count = min(5, len(np.unique(groups)))
    if folds_count < 3:
        raise ValueError("SHM validation needs at least three independent waveform groups")
    splitter = GroupKFold(n_splits=folds_count, shuffle=True, random_state=42)
    folds = list(splitter.split(X, y, groups))
    fold_ids = np.full(len(y), -1, dtype=int)
    for fold, (training, validation) in enumerate(folds):
        if set(groups[training]) & set(groups[validation]):
            raise RuntimeError("Duplicate groups leaked across SHM validation")
        fold_ids[validation] = fold
    candidates, results, all_predictions = _candidates(names), [], {}
    for name, estimator in candidates:
        oof = np.full(len(y), np.nan)
        fold_scores = []
        for training, validation in folds:
            fitted = clone(estimator).fit(X[training], y[training])
            oof[validation] = _finite_predictions(fitted.predict(X[validation]))
            error = float(mean_absolute_percentage_error(y[validation], oof[validation]))
            fold_scores.append(max(0.0, 1.0 - error))
        mape = float(mean_absolute_percentage_error(y, oof))
        score = max(0.0, 1.0 - mape)
        results.append({"name": name, "score": score, "mape": mape, "fold_scores": fold_scores,
                        "mae": float(mean_absolute_error(y, oof)), "rmse": float(np.sqrt(mean_squared_error(y, oof)))})
        all_predictions[name] = oof
        print(f"SHM OOF {name}: MAPE={mape:.6f}; score={score:.6f}", flush=True)
    selected = min(range(len(results)), key=lambda index: results[index]["mape"])
    model_name, estimator = candidates[selected]
    fitted = clone(estimator).fit(X, y)
    limitations = [
        f"Whole-file grouped validation on {len(records)} labelled organiser training records; official held-out test scores are unavailable.",
        "Candidate selection uses these same out-of-fold results, so the selected validation score has model-selection optimism and is not independent outer-test performance.",
        "Exact and conservative near-identical waveform matches stay in one fold; line/load/acquisition-group identifiers are unavailable, so residual dependence cannot be excluded.",
        "The source signals represent healthy operating conditions. Damage is not a structural-fault label, failure probability or remaining useful life.",
        "Stress unit, sampling frequency and material S-N constants are unspecified. Rainflow ranges use raw units; fitted moment coefficients are statistical surrogates, not verified material constants.",
    ]
    metadata = {"subsystem": "shm", "model_name": model_name, "trained_at": datetime.now(timezone.utc).isoformat(),
                "training_files": len(records), "training_rows": sum(record["samples"] for record in records),
                "feature_version": VERSION, "feature_names": names, "feature_count": len(names),
                "validation": {"metric": "max(0, 1 - MAPE)", "score": results[selected]["score"], "mape": results[selected]["mape"],
                               "method": f"{folds_count}-fold GroupKFold on whole training files, shuffled seed 42; exact/near-identical waveforms grouped; candidate transformations fitted within each fold; final selected estimator fitted to all training files",
                               "candidates": results, "limitations": limitations},
                "limitations": limitations, "duplicate_links": duplicate_links, "independent_groups": int(len(np.unique(groups))),
                "training_sample_counts": sorted({record["samples"] for record in records}), "training_target_range": [float(y.min()), float(y.max())],
                "source_hashes": {record["filename"]: record["sha256"] for record in records}, "labels_sha256": _sha256(label_path)}
    oof_table = [{"file_id": record["filename"], "group": int(groups[index]), "fold": int(fold_ids[index]), "true": float(y[index]),
                  **{name: float(values[index]) for name, values in all_predictions.items()}} for index, record in enumerate(records)]
    _json(artifact_dir / "oof_predictions.json", oof_table)
    if isinstance(fitted, RainflowMomentRegressor):
        metadata["selected_model_parameters"] = {"rainflow_amplitude_power": int(names[fitted.moment_index_].rsplit("_", 1)[1]),
                                                 "fitted_scale": float(np.exp(fitted.log_scale_)),
                                                 "meaning": "Empirically fitted moment and scale; not independently known material S-N parameters"}
    temporary_model = artifact_dir / "model.joblib.tmp"
    joblib.dump({"version": VERSION, "subsystem": "shm", "model_name": model_name, "estimator": fitted, "feature_names": names,
                 "training_sample_counts": metadata["training_sample_counts"], "training_target_range": metadata["training_target_range"]}, temporary_model, compress=3)
    temporary_model.replace(artifact_dir / "model.joblib")
    metadata["model_sha256"] = _sha256(artifact_dir / "model.joblib")
    _json(artifact_dir / "metadata.json", metadata)
    return metadata


def predict(path: Path, artifact_dir: Path) -> dict:
    path = Path(path)
    bundle = _load_model(artifact_dir, "shm", VERSION)
    sample_counts, target_range = bundle.get("training_sample_counts"), bundle.get("training_target_range")
    if (not isinstance(sample_counts, list) or not sample_counts or
            any(type(value) is not int or value <= 0 for value in sample_counts) or
            not isinstance(target_range, list) or len(target_range) != 2 or
            any(not isinstance(value, (float, int)) or not np.isfinite(value) for value in target_range) or
            not 0 < target_range[0] <= target_range[1]):
        raise ValueError("The frozen SHM artifact is missing valid training exposure and target-range metadata")
    signal, warnings_list = load_signal(path)
    record = extract_features(signal)
    X = _feature_matrix(record["features"], bundle["feature_names"], "SHM")
    prediction = max(0., _predict_one(bundle, X, "SHM"))
    measured = record["measurements"]
    evidence = [
        {"id": "shm-samples", "label": "Measured samples", "value": len(signal), "unit": "samples", "detail": "Headerless file: the first numeric line is retained", "source": path.name},
        {"id": "shm-rms", "label": "Stress signal RMS", "value": measured["rms"], "unit": "raw stress units", "detail": "Square root of mean squared samples across the complete recording", "source": f"{path.name} / all samples"},
        {"id": "shm-range", "label": "Stress signal range", "value": measured["range"], "unit": "raw stress units", "detail": "Maximum sample minus minimum sample", "source": f"{path.name} / all samples"},
        {"id": "shm-cycles", "label": "Rainflow cycle count", "value": measured["rainflow_cycles"], "unit": "cycles including half cycles", "detail": "Sum of actual rainflow cycle weights from the ordered measured signal; not inferred from filename", "source": f"{path.name} / complete waveform"},
        {"id": "shm-cycle-range", "label": "Maximum rainflow stress range", "value": measured["maximum_cycle_range"], "unit": "raw stress units", "detail": "Largest peak-to-peak cycle range; amplitude used for moment features is half this range", "source": f"{path.name} / rainflow cycles"},
    ]
    if isinstance(bundle["estimator"], RainflowMomentRegressor):
        estimator = bundle["estimator"]
        moment_name = bundle["feature_names"][estimator.moment_index_]
        exponent = int(moment_name.rsplit("_", 1)[1])
        evidence.append({"id": "shm-model-moment", "label": f"Weighted rainflow amplitude moment (power {exponent})", "value": float(np.exp(record["features"][moment_name])),
                         "unit": f"raw stress units^{exponent} × cycles", "detail": f"Sum of cycle weight × (peak-to-peak range / 2)^{exponent}. The selected surrogate multiplies this by a positive scale fitted only to training labels; it does not assert a known material S-N curve.", "source": f"{path.name} / all counted rainflow cycles"})
    warnings_list.extend(["Estimated cumulative fatigue damage for this recording, not a verified structural fault, failure probability or remaining useful life.",
                          "Stress units, sample frequency and S-N material constants are not supplied. The plot uses sample index; no duration or material calibration is invented.",
                          "Official test targets are hidden. The estimate comes from a frozen model selected using local whole-file training validation.",
                          "The chart is a min/max envelope of at most 400 points; all waveform samples contribute to numerical features."])
    if len(signal) not in bundle["training_sample_counts"]:
        warnings_list.append(f"This file has {len(signal):,} samples; training recordings used {bundle['training_sample_counts']}. Different recording exposure is outside the validated equal-length setting.")
    lower, upper = bundle["training_target_range"]
    if prediction < lower or prediction > upper:
        warnings_list.append("The estimate lies outside the observed training-target range and requires additional validation.")
    if measured["rainflow_cycles"] == 0:
        warnings_list.append("No alternating stress cycles were counted; a constant waveform is outside the demonstrated stress-recording setting.")
    return {"subsystem": "shm", "file_id": path.name, "model_name": bundle["model_name"],
            "summary": f"Estimated cumulative fatigue damage: {prediction:.6g} for the supplied {len(signal):,}-sample recording. This is a regression estimate, not a fault diagnosis.",
            "prediction_rows": [{"file_id": path.name, "prediction": prediction}], "evidence": evidence, "warnings": warnings_list,
            "series": [{"name": "Dynamic stress (min/max envelope)", "x_label": "Sample index", "y_label": "Raw stress value (unit unspecified)", "points": _envelope(signal)}],
            "entities": [{"id": "recording", "label": path.name, "value": prediction, "status": "estimated", "detail": "Cumulative fatigue damage target; no asset identity or location is inferred"}]}
