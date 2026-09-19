"""Automatic, reference-only Isolation Forest training and inspectable evidence.

Risk is a documented persistence/deviation indicator, never a fault probability.
Injected labels are used only for an explicitly synthetic monitoring benchmark.
"""
from __future__ import annotations

import hashlib
import csv
import io
import json
import re
import threading
import time
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.metrics import precision_recall_fscore_support, roc_auc_score


SENSOR_INFO = {
    "vibration_mm_s": ("Vibration RMS", "mm/s", "bogies"),
    "bearing_temp_c": ("Bearing temperature", "°C", "bogies"),
    "door_current_a": ("Door motor current", "A", "doors"),
    "door_cycle_s": ("Door cycle duration", "s", "doors"),
    "brake_pressure_bar": ("Brake pressure", "bar", "brakes"),
    "brake_temp_c": ("Brake temperature", "°C", "brakes"),
    "motor_current_a": ("Traction motor current", "A", "motors"),
    "motor_temp_c": ("Motor temperature", "°C", "motors"),
}
CONTEXT_COLUMNS = {"speed_kmh", "ambient_temp_c"}
METADATA_COLUMNS = {
    "timestamp", "time", "datetime", "date", "recorded_at", "train_id", "train",
    "train_name", "line", "component", "component_id", "id", "index", "row", "row_id",
    "scenario", "source", "split", "status", "health", "risk", "anomaly_score",
    "label", "labels", "target", "class", "y", "fault", "failure", "anomaly",
    "is_anomaly", "is_fault", "fault_code", "fault_type", "injected_anomaly",
    "train_no", "train_number", "train_set", "car", "car_no", "car_number", "bogie", "bogie_number",
    "axle", "axle_number", "component_no", "component_number", "sequence", "seq", "sample_number",
    "faulty", "is_faulty", "ground_truth", "groundtruth",
    "lat", "latitude", "gps_lat", "gps_latitude", "latitude_deg", "latitude_degrees",
    "lon", "lng", "long", "longitude", "gps_lon", "gps_lng", "gps_longitude", "longitude_deg", "longitude_degrees",
    "route", "route_id", "route_position", "station", "station_id", "direction", "heading", "gps_accuracy",
}
STATUS_ORDER = {"healthy": 0, "unknown": 1, "warning": 2, "critical": 3}


@dataclass(frozen=True)
class Settings:
    reference_fraction: float = 0.40
    contamination: float = 0.03
    n_estimators: int = 160
    random_state: int = 42
    min_reference_rows: int = 12
    recent_window: int = 24

    def __post_init__(self):
        if not 0.1 <= self.reference_fraction <= 0.8:
            raise ValueError("reference_fraction must be between 0.1 and 0.8")
        if not 0 < self.contamination <= 0.5:
            raise ValueError("contamination must be between 0 and 0.5")
        if self.n_estimators < 1 or self.min_reference_rows < 4 or self.recent_window < 4:
            raise ValueError("Detector settings require positive trees and at least four reference/recent rows")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    return pd.Timestamp(value).isoformat()


def finite(value, digits=6) -> float | None:
    try:
        result = float(value)
        return round(result, digits) if np.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def _excluded_column(name: str) -> bool:
    key = re.sub(r"[\s-]+", "_", name.lower().strip())
    compact = re.sub(r"[^a-z0-9]", "", key)
    compact_metadata = {re.sub(r"[^a-z0-9]", "", column) for column in METADATA_COLUMNS | CONTEXT_COLUMNS}
    return (key in METADATA_COLUMNS or key in CONTEXT_COLUMNS or key.endswith("_id")
            or compact in compact_metadata or compact.endswith(("label", "labels"))
            or compact.startswith(("fault", "failure", "anomaly", "injected", "target", "groundtruth"))
            or key.startswith("unnamed:") or bool(re.search(r"(^|_)(label|target|fault|failure|injected|anomaly)(_|$)", key)))


def parse_csv(raw: bytes) -> tuple[pd.DataFrame, dict]:
    """Preserve raw missing readings; coerce only a separate numerical frame."""
    if not raw or not raw.strip():
        raise ValueError("The CSV is empty. Include a timestamp and at least one numeric sensor column.")
    try:
        reader = csv.reader(io.StringIO(raw.decode("utf-8-sig")), strict=True)
        original_headers = next(row for row in reader if row and any(value.strip() for value in row))
        normalized_headers = [column.strip().lower() for column in original_headers]
        if len(normalized_headers) != len(set(normalized_headers)):
            raise ValueError("Column names must be unique after removing spaces and ignoring case.")
        short_rows = 0
        for row in reader:
            if not row or (len(row) == 1 and not row[0].strip()):
                continue
            if len(row) > len(original_headers):
                raise ValueError(f"CSV record ending at line {reader.line_num} has more fields than the header's {len(original_headers)} columns. Check delimiters and quoted fields; no columns were silently shifted.")
            short_rows += len(row) < len(original_headers)
        frame = pd.read_csv(io.BytesIO(raw), dtype=str, encoding="utf-8-sig", on_bad_lines="error")
    except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeDecodeError, csv.Error, StopIteration) as exc:
        raise ValueError("Could not read this CSV. Use UTF-8, comma-separated columns and balanced quoted fields.") from exc
    if frame.empty:
        raise ValueError("The CSV contains headers but no observations.")
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    if len(frame.columns) != len(set(frame.columns)):
        raise ValueError("Column names must be unique after removing spaces and ignoring case.")
    timestamp = next((key for key in ("timestamp", "datetime", "recorded_at", "time", "date") if key in frame), None)
    if timestamp is None:
        raise ValueError("A timestamp column is required (timestamp, datetime, recorded_at, time or date). No observation times are invented.")
    # Numeric epoch values are ambiguous without a declared unit: require explicit dates.
    time_text = frame[timestamp].astype("string")
    dates = pd.to_datetime(time_text.mask(time_text.str.fullmatch(r"[+-]?\d+(\.\d+)?", na=False)), errors="coerce", utc=True, format="mixed")
    excluded = int(dates.isna().sum())
    warnings = []
    if short_rows:
        warnings.append(f"{short_rows} records have fewer fields than the header; omitted trailing sensor cells remain missing.")
    has_time = time_text.str.contains(r"[T\s]\d{1,2}:\d{2}", na=False)
    has_timezone = has_time & time_text.str.contains(r"(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)\s*$", case=False, na=False)
    naive_count = int((dates.notna() & ~has_timezone).sum())
    if naive_count:
        warnings.append(f"{naive_count} timestamps have no explicit timezone and are interpreted as UTC. Supply ISO8601 timezone offsets if the source uses local time.")
    if excluded:
        warnings.append(f"Excluded {excluded} rows with missing or invalid timestamps; no timestamps were synthesized.")
    original_rows = len(frame)
    frame = frame.loc[dates.notna()].copy()
    if frame.empty:
        raise ValueError("No valid timestamps were found. Use explicit ISO8601 dates such as 2026-09-01T12:00:00Z.")
    frame["_timestamp"] = dates.loc[dates.notna()]
    for key, default in (("train_id", "Uploaded train"), ("component", "general")):
        if key not in frame:
            frame[key] = default
            warnings.append(f"No {key} column supplied; grouped observations as '{default}'.")
        missing = frame[key].isna() | frame[key].astype(str).str.strip().eq("")
        if missing.any():
            frame.loc[missing, key] = f"Unknown {key.replace('_', ' ')}"
            warnings.append(f"{int(missing.sum())} rows lack {key}; kept in an explicitly unknown identifier group.")
        frame[key] = frame[key].astype(str).str.strip()
    sensor_columns = []
    for column in list(frame.columns):
        if column.startswith("_") or _excluded_column(column):
            continue
        values = pd.to_numeric(frame[column], errors="coerce").replace([np.inf, -np.inf], np.nan)
        provided = frame[column].notna().sum()
        numeric_ratio = values.notna().sum() / max(1, provided)
        if column in SENSOR_INFO or values.notna().any():
            sensor_columns.append(column)
            frame[column] = values
            if column not in SENSOR_INFO and numeric_ratio < 0.5:
                warnings.append(f"{column}: retained {int(values.notna().sum())} numeric measurements despite mostly invalid/non-numeric cells; review whether this column is a sensor.")
    if not sensor_columns or not frame[sensor_columns].notna().any().any():
        raise ValueError("No usable numeric sensor measurements were found. Identifiers, timestamps, context and fault/label columns are excluded from detector inputs.")
    for column in CONTEXT_COLUMNS & set(frame.columns):
        frame[column] = pd.to_numeric(frame[column], errors="coerce").replace([np.inf, -np.inf], np.nan)
    frame = frame.sort_values(["_timestamp", "train_id", "component"], kind="stable").reset_index(drop=True)
    return frame, {"rows": original_rows, "excluded_rows": excluded, "warnings": warnings, "sensor_columns": sensor_columns}


def _model_info(settings: Settings, features: list[str], rows: int, validation: int, elapsed: float) -> dict:
    return {
        "algorithm": "Isolation Forest", "version": sklearn.__version__,
        "training_rows": rows, "validation_rows": validation, "features": features,
        "training_ms": round(elapsed, 2), "cache_hit": False, "threshold": 0.0,
        "methodology": f"Per-component IsolationForest; first {settings.reference_fraction:.0%} of chronological time windows are reference; remaining windows are monitoring. Reference-only medians impute model inputs. Contamination {settings.contamination:.1%}; positive -decision_function is anomalous. Risk combines recent detection persistence and robust sensor deviation; sustained multivariate detections can trigger review even without large individual-sensor deviations. At least four scored recent observations are required. Groups older than three of their own median reporting intervals at the dataset endpoint are unknown. Risk is not a failure probability.",
    }


def _status(risks: np.ndarray, deviations: np.ndarray, flags: np.ndarray) -> tuple[str, int | None]:
    """Do not turn an isolated tail observation into an alarm for an entire train."""
    if len(risks) < 4:
        return "unknown", None
    persistence = float(np.mean(flags))
    strength = float(np.median(deviations))
    indicator = int(np.clip(round(8 + 34 * persistence + 6 * max(0, strength - 1.5)), 0, 99))
    if persistence >= 0.5 and strength >= 6:
        return "critical", max(75, indicator)
    if (persistence >= 0.25 and strength >= 2.5) or persistence >= 0.65:
        return "warning", min(74, max(40, indicator))
    return "healthy", min(39, indicator)


def _stale_reason(group: pd.DataFrame, as_of: pd.Timestamp) -> str | None:
    """Compare with this group's observed cadence, never wall time or another sensor's cadence."""
    times = group.loc[group["_timestamp"].le(as_of), "_timestamp"].drop_duplicates().sort_values()
    if len(times) < 4:
        return None  # Too few intervals to infer a reporting cadence.
    cadence = times.diff().dropna().median()
    age = as_of - times.iloc[-1]
    if cadence > pd.Timedelta(0) and age > 3 * cadence:
        return f"The latest component observation ({iso(times.iloc[-1])}) is older than three of this group's median reporting intervals at the dataset endpoint {iso(as_of)}; its current condition is unknown. This is a data-freshness rule, not a fault finding."
    return None


def _cause_and_actions(component: str, sensor: str | None, status: str) -> tuple[str, list[str]]:
    if status == "unknown":
        return "Insufficient measured evidence to assess component condition.", ["Check sensor connectivity, timestamps and the reference-data coverage before drawing a condition conclusion."]
    if status == "healthy":
        return "No sustained anomaly meets the current advisory rules in the recent monitoring window.", ["Continue routine monitoring and compare future observations with the reference period."]
    if component == "bogies" or (sensor and any(word in sensor for word in ("bearing", "vibration"))):
        return "The detected pattern may reflect bearing or running-gear deterioration, or an operating-condition change; inspection is needed to distinguish them.", ["Review bearing-temperature and vibration measurements at the cited times.", "Arrange a bearing and running-gear inspection under the operator's maintenance procedure.", "Check sensor calibration and operating conditions before confirming a mechanical fault."]
    if component == "doors" or (sensor and "door" in sensor):
        return "Door actuator load or cycle changes may indicate friction, obstruction or an actuator/sensor issue.", ["Check the door guide, seals and actuator for obstruction or excess friction.", "Compare cycle time and motor current during a controlled inspection.", "Record the inspection result before confirming a fault or replacing a part."]
    if component == "brakes" or (sensor and "brake" in sensor):
        return "Brake pressure or temperature changes may indicate a pneumatic, friction or sensor issue.", ["Request qualified brake-system inspection under the applicable maintenance procedure.", "Review pressure release, temperature and sensor calibration together.", "Verify the suspected cause with inspection evidence before deciding a repair."]
    if component == "motors" or (sensor and "motor" in sensor):
        return "Traction load or temperature changes may indicate a motor, cooling or operating-condition issue.", ["Review motor current and temperature alongside speed and ambient conditions.", "Inspect cooling and electrical connections using the operator's procedure.", "Confirm the cause with qualified electrical diagnostics before repair."]
    return "Sustained sensor deviations may reflect equipment degradation, an operating change or a sensor issue.", ["Review the cited sensor observations against the reference period.", "Arrange an appropriate component and sensor inspection.", "Record verified findings before confirming a fault or selecting replacement parts."]


class DatasetStore:
    """Content/settings cache shared by all five screens; no label-dependent fit."""

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self._datasets: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._demo_id: str | None = None
        self.fit_count = 0

    def ingest(self, raw: bytes, name: str, source: str = "uploaded") -> dict:
        if source not in ("uploaded", "synthetic"):
            raise ValueError("Dataset source must be uploaded or synthetic.")
        digest = hashlib.sha256(raw + json.dumps(asdict(self.settings), sort_keys=True).encode()).hexdigest()
        dataset_id = f"{source}-{digest[:20]}"
        with self._lock:
            cached = dataset_id in self._datasets
            if not cached:
                self._datasets[dataset_id] = self._process(raw, name, source, dataset_id)
            return self._dashboard(dataset_id, cached)

    def dashboard(self, dataset_id="demo") -> dict:
        with self._lock:
            if dataset_id == "demo":
                if self._demo_id is None:
                    from backend.synthetic import generate_dataset
                    generated = generate_dataset(seed=42, scenario="mixed", periods=288)
                    result = self.ingest(generated.to_csv(index=False).encode("utf-8"), "RailGuard synthetic mixed fleet", "synthetic")
                    self._demo_id = result["dataset"]["id"]
                    return result
                dataset_id = self._demo_id
            if dataset_id not in self._datasets:
                raise KeyError("Dataset not found. Upload it again if the local backend restarted.")
            return self._dashboard(dataset_id, True)

    def _dashboard(self, dataset_id: str, cache_hit: bool) -> dict:
        result = deepcopy(self._datasets[dataset_id]["dashboard"])
        result["model"]["cache_hit"] = cache_hit
        return result

    def detail(self, dataset_id: str, train_id: str, component: str) -> dict:
        with self._lock:
            if dataset_id == "demo":
                dataset_id = self.dashboard("demo")["dataset"]["id"]
            bundle = self._datasets.get(dataset_id)
            if bundle is None:
                raise KeyError("Dataset not found. Upload it again if the local backend restarted.")
            detail = bundle["details"].get((train_id, component))
            if detail is None:
                raise KeyError("Train/component not found in this dataset.")
            result = deepcopy(detail)
            result["model"]["cache_hit"] = True
            return result

    def export(self, dataset_id: str) -> tuple[bytes, str]:
        with self._lock:
            if dataset_id == "demo":
                dataset_id = self.dashboard("demo")["dataset"]["id"]
            if dataset_id not in self._datasets:
                raise KeyError("Dataset not found.")
            bundle = self._datasets[dataset_id]
            return bundle["raw"], bundle["dashboard"]["dataset"]["name"]

    def _process(self, raw: bytes, name: str, source: str, dataset_id: str) -> dict:
        frame, parsed = parse_csv(raw)
        warnings = parsed["warnings"]
        sensor_columns = parsed["sensor_columns"]
        models = {}
        score = np.full(len(frame), np.nan)
        robust = np.full(len(frame), np.nan)
        point_risk = np.full(len(frame), np.nan)
        reference = np.zeros(len(frame), dtype=bool)
        all_applicable = 0
        all_missing = 0
        total_training = total_validation = 0
        total_ms = 0.0
        all_features = set()

        for component, component_frame in frame.groupby("component", sort=True):
            indices = component_frame.index.to_numpy()
            times = component_frame["_timestamp"].drop_duplicates().sort_values()
            reference_windows = max(1, int(len(times) * self.settings.reference_fraction))
            cutoff = times.iloc[reference_windows - 1]
            ref_mask = component_frame["_timestamp"].le(cutoff).to_numpy()
            reference[indices] = ref_mask
            physical = [key for key in sensor_columns if component_frame[key].notna().any()
                        or (key in SENSOR_INFO and SENSOR_INFO[key][2] == component)]
            all_applicable += len(component_frame) * len(physical)
            all_missing += int(component_frame[physical].isna().sum().sum()) if physical else 0
            observed = component_frame[physical].notna().any(axis=1).to_numpy() if physical else np.zeros(len(indices), dtype=bool)
            reference_frame = component_frame.loc[ref_mask & observed]
            usable_physical = [key for key in physical if reference_frame[key].notna().any()]
            unlearnable = sorted(set(physical) - set(usable_physical))
            if unlearnable:
                warnings.append(f"{component}: no reference measurements for {', '.join(unlearnable)}; these sensors cannot be used by this model.")
            features = usable_physical + sorted(key for key in CONTEXT_COLUMNS & set(frame.columns) if reference_frame[key].notna().any())
            eligible = component_frame[usable_physical].notna().any(axis=1).to_numpy() if usable_physical else np.zeros(len(indices), dtype=bool)
            train_mask = ref_mask & eligible
            monitoring_mask = ~ref_mask & eligible
            info = _model_info(self.settings, features, 0, int(monitoring_mask.sum()), 0)
            model_data = {"physical": physical, "usable": usable_physical, "features": features, "info": info, "model": None}
            models[component] = model_data
            if not usable_physical or train_mask.sum() < self.settings.min_reference_rows:
                warnings.append(f"{component}: insufficient reference evidence ({int(train_mask.sum())} valid rows; at least {self.settings.min_reference_rows} required); condition is unknown.")
                continue
            fit_frame = component_frame.loc[train_mask, features]
            medians = fit_frame.median()
            deviations = (fit_frame[usable_physical] - medians[usable_physical]).abs().median() * 1.4826
            std = fit_frame[usable_physical].std(ddof=0)
            floor = medians[usable_physical].abs().mul(0.01).clip(lower=0.001)
            scale = deviations.where(deviations > 1e-10, std).where(lambda values: values > 1e-10, floor)
            x_fit = fit_frame.fillna(medians).to_numpy(dtype=float)
            model = IsolationForest(n_estimators=self.settings.n_estimators, contamination=self.settings.contamination,
                                    random_state=self.settings.random_state, max_samples=min(256, len(x_fit)), n_jobs=1)
            started = time.perf_counter()
            model.fit(x_fit)
            elapsed = (time.perf_counter() - started) * 1000
            self.fit_count += 1
            valid_indices = indices[eligible]
            x_valid = component_frame.loc[eligible, features].fillna(medians).to_numpy(dtype=float)
            scores = -model.decision_function(x_valid)
            z = (component_frame.loc[eligible, usable_physical] - medians[usable_physical]).abs().div(scale)
            max_z = z.max(axis=1).to_numpy(dtype=float)
            score[valid_indices] = scores
            robust[valid_indices] = max_z
            point_risk[valid_indices] = np.clip(5 + max_z * 8 + np.maximum(0, scores) * 140, 0, 99)
            model_data.update({"model": model, "medians": medians, "scale": scale})
            model_data["info"] = _model_info(self.settings, features, len(x_fit), int(monitoring_mask.sum()), elapsed)
            total_training += len(x_fit)
            total_validation += int(monitoring_mask.sum())
            total_ms += elapsed
            all_features.update(features)

        frame["_reference"] = reference
        frame["_score"] = score
        frame["_robust"] = robust
        frame["_risk"] = point_risk
        missing_pct = round(100 * all_missing / max(1, all_applicable), 2)
        if all_missing:
            warnings.append(f"{all_missing} missing/non-finite applicable sensor cells ({missing_pct:.2f}%). Only model inputs are imputed from reference medians; displayed readings remain missing.")
        unknown_rows = int(np.isnan(score).sum())
        if unknown_rows:
            warnings.append(f"{unknown_rows} observations could not be scored because usable sensor/reference evidence was missing.")
        if source == "uploaded":
            warnings.append(f"Reference normality is an assumption: the first chronological {self.settings.reference_fraction:.0%} is not verified healthy. Review this period before operational use.")
        else:
            warnings.append("Synthetic demonstration data; injected anomalies are scenario markers, not verified railway faults.")
        if frame.duplicated(["train_id", "component", "_timestamp"]).any():
            warnings.append("Duplicate train/component timestamps are retained as distinct observations; inspect the source if duplicates are unexpected.")
        details = {}
        components = []
        for (train_id, component), group in frame.groupby(["train_id", "component"], sort=True):
            detail, summary = self._component_detail(dataset_id, str(train_id), str(component), group, models[component], source, frame["_timestamp"].max())
            details[(str(train_id), str(component))] = detail
            components.append(summary)
        trains = []
        for train_id, group in frame.groupby("train_id", sort=True):
            children = [item for item in components if item["train_id"] == train_id]
            status = max((item["status"] for item in children), key=STATUS_ORDER.get)
            risks = [item["risk"] for item in children if item["risk"] is not None]
            risk = max(risks) if risks else None
            if status == "unknown":
                risk = None
            display_name = group["train_name"].dropna().iloc[0] if "train_name" in group and group["train_name"].notna().any() else train_id
            line = group["line"].dropna().iloc[0] if "line" in group and group["line"].notna().any() else "Uploaded fleet"
            trains.append({"id": str(train_id), "name": str(display_name), "line": str(line), "status": status,
                           "risk": risk, "health": 100 - risk if risk is not None else None, "component_count": len(children),
                           "anomaly_count": sum(item["anomaly_count"] for item in children), "last_seen": iso(group["_timestamp"].max()),
                           "components": children, "sparkline": max(children, key=lambda item: item["risk"] if item["risk"] is not None else -1)["sparkline"]})
        model_info = _model_info(self.settings, sorted(all_features), total_training, total_validation, total_ms)
        dashboard = {
            "dataset": {"id": dataset_id, "name": name, "source": source, "rows": parsed["rows"], "train_count": len(trains),
                        "component_count": len(components), "sensor_count": len(sensor_columns), "missing_pct": missing_pct,
                        "excluded_rows": parsed["excluded_rows"], "warnings": warnings, "time_start": iso(frame["_timestamp"].min()),
                        "time_end": iso(frame["_timestamp"].max()), "created_at": utc_now()},
            "trains": trains, "components": components, "trend": self._trend(frame), "model": model_info,
            "evaluation": self._evaluate(frame, source), "alerts": [item for item in components if item["status"] in ("warning", "critical")],
            "totals": {**{status: sum(train["status"] == status for train in trains) for status in STATUS_ORDER},
                       "observations": len(frame), "anomalies": int(((score > 0) & ~reference).sum()),
                       "coverage": round(100 * np.isfinite(score).sum() / len(frame), 2)},
        }
        return {"dashboard": dashboard, "details": details, "raw": raw, "models": models}

    def _component_detail(self, dataset_id: str, train_id: str, component: str, group: pd.DataFrame, data: dict, source: str, as_of: pd.Timestamp) -> tuple[dict, dict]:
        monitoring = group.loc[~group["_reference"]]
        recent = monitoring.tail(self.settings.recent_window)
        valid_recent = recent.loc[recent["_score"].notna()]
        status, risk = _status(valid_recent["_risk"].to_numpy(), valid_recent["_robust"].to_numpy(), valid_recent["_score"].gt(0).to_numpy())
        # Do not silently describe old evidence as current when recent measurements disappear.
        stale_reason = _stale_reason(group, as_of)
        if monitoring.empty or valid_recent.empty or pd.isna(monitoring.iloc[-1]["_score"]) or stale_reason:
            status, risk = "unknown", None
        anomalies = monitoring.loc[monitoring["_score"].gt(0)]
        onset = iso(anomalies["_timestamp"].min()) if not anomalies.empty else None
        recent_anomalies = valid_recent.loc[valid_recent["_score"].gt(0)]
        if not recent_anomalies.empty and status in ("warning", "critical"):
            evidence_row = recent_anomalies.loc[recent_anomalies["_score"].idxmax()]
        else:
            valid = group.loc[group["_score"].notna()]
            evidence_row = valid.iloc[-1] if not valid.empty else None
        features = []
        impacts = {}
        method = "Evidence rules using measured readings and reference-only robust deviations; not SHAP and not an LLM diagnosis."
        if evidence_row is not None and data["model"] is not None:
            x = evidence_row[data["features"]].astype(float).fillna(data["medians"]).to_numpy(dtype=float)
            original_score = float(-data["model"].decision_function(x.reshape(1, -1))[0])
            candidates = []
            candidate_keys = []
            for key in data["usable"]:
                if pd.notna(evidence_row[key]):
                    replaced = x.copy()
                    replaced[data["features"].index(key)] = data["medians"][key]
                    candidates.append(replaced)
                    candidate_keys.append(key)
            if candidates:
                changed = -data["model"].decision_function(np.array(candidates))
                impacts = {key: max(0.0, original_score - float(value)) for key, value in zip(candidate_keys, changed)}
            total_impact = sum(impacts.values())
            if total_impact > 1e-12:
                impacts = {key: value / total_impact for key, value in impacts.items()}
            else:
                impacts = {key: 0.0 for key in impacts}
            method = "Isolation Forest reference-replacement sensitivity: replace one measured sensor with its reference median, rescore, and normalize positive score decreases among measured sensors; contextual inputs stay fixed. This is model sensitivity, not SHAP or a causal percentage."
        for key in data["physical"]:
            latest = finite(evidence_row[key]) if evidence_row is not None else None
            baseline = finite(data["medians"][key]) if key in data.get("medians", {}) else None
            deviation = finite((latest - baseline) / data["scale"][key]) if latest is not None and baseline is not None else None
            label, unit, _ = SENSOR_INFO.get(key, (key.replace("_", " ").title(), "", component))
            features.append({"key": key, "label": label, "unit": unit, "latest": latest, "baseline": baseline,
                             "deviation": deviation, "contribution": round(100 * impacts.get(key, 0.0), 2),
                             "samples": int(group[key].notna().sum()), "missing_count": int(group[key].isna().sum())})
        features.sort(key=lambda item: (item["contribution"], abs(item["deviation"] or 0)), reverse=True)
        top_sensor = next((item["key"] for item in features if item["latest"] is not None), None)
        title = {"healthy": "Within recent monitoring envelope", "warning": "Sustained deviation needs inspection", "critical": "Strong sustained anomaly needs prompt review", "unknown": "Condition unavailable: insufficient current evidence"}[status]
        cause, actions = _cause_and_actions(component, top_sensor, status)
        priority = {"critical": "P1", "warning": "P2", "healthy": "P3", "unknown": "Review"}[status]
        timeframe = {"critical": "Prompt qualified review before the next dispatch decision", "warning": "Inspect at the next planned maintenance opportunity", "healthy": "Routine monitoring", "unknown": "Restore data coverage before making a condition decision"}[status]
        evidence_time = iso(evidence_row["_timestamp"]) if evidence_row is not None else None
        recent_count = len(valid_recent)
        recent_flags = int(valid_recent["_score"].gt(0).sum())
        summary_text = f"{train_id} / {component}: {recent_flags} of {recent_count} recent scored monitoring observations were flagged by Isolation Forest. {title}."
        evidence_text = [f"Reference: {data['info']['training_rows']} component observations; monitoring: {len(monitoring)} observations for this train/component.",
                         f"Recent detections: {recent_flags}/{recent_count} scored observations; the window contains at most {self.settings.recent_window} observations."]
        if evidence_time:
            evidence_text.append(f"Sensor evidence is from {evidence_time}; values below come from this exact observation.")
        for feature in features[:3]:
            if feature["latest"] is not None and feature["baseline"] is not None:
                evidence_text.append(f"{feature['label']}: {feature['latest']:g} {feature['unit']}; reference median {feature['baseline']:g} {feature['unit']}; robust deviation {feature['deviation']:+.2f}.")
        limitations = ["An anomaly is not a verified fault. Risk/health are heuristic indicators, not calibrated probabilities.",
                      "Observed onset is the first flagged monitoring observation, not the physical start of damage.",
                      "No remaining-useful-life estimate is available; advisory timeframes are review guidance, not failure forecasts.",
                      "Reference replacement measures model response, not causal attribution. Missing displayed values are not imputed."]
        if stale_reason:
            limitations.append(stale_reason)
        if len(valid_recent) < 4:
            limitations.append("Fewer than four recent scored monitoring observations are available; persistence cannot support a current condition assessment.")
        if source == "synthetic":
            limitations.append("This dataset is synthetic; scenario labels are not inspection-confirmed faults.")
        else:
            limitations.append("The initial reference period is assumed representative; its healthy state is not independently verified.")
        if any(feature["missing_count"] for feature in features):
            limitations.append("Some sensor observations are missing or non-finite; inspect coverage before interpreting the result.")
        points = [{"timestamp": iso(row["_timestamp"]), "score": finite(row["_score"]), "risk": finite(row["_risk"], 2),
                   "anomaly": bool(row["_score"] > 0) if pd.notna(row["_score"]) else None,
                   "split": "reference" if row["_reference"] else "monitoring",
                   "values": {key: finite(row[key]) for key in data["physical"]}}
                  for _, row in group.iterrows()]
        health = 100 - risk if risk is not None else None
        detail = {"dataset_id": dataset_id, "train_id": train_id, "component": component, "status": status, "risk": risk, "health": health,
                  "anomaly_count": len(anomalies), "observations": len(group), "onset": onset, "last_seen": iso(group["_timestamp"].max()),
                  "evidence_time": evidence_time, "features": features, "points": points,
                  "explanation": {"title": title, "summary": summary_text, "possible_cause": cause, "recommendation": actions[0], "actions": actions,
                                  "priority": priority, "timeframe": timeframe, "evidence": evidence_text, "method": method, "limitations": limitations},
                  "model": data["info"]}
        summary = {"train_id": train_id, "component": component, "status": status, "risk": risk, "health": health,
                   "anomaly_count": len(anomalies), "observations": len(group), "onset": onset,
                   "latest_anomaly": iso(anomalies["_timestamp"].max()) if not anomalies.empty else None,
                   "title": title, "summary": summary_text, "top_sensor": top_sensor,
                   "sparkline": [round(float(value), 2) for value in group["_risk"].tail(48).dropna()]}
        return detail, summary

    def _trend(self, frame: pd.DataFrame) -> list[dict]:
        # Recompute the same trailing-window rule at 24 observed times. No invented times.
        times = frame["_timestamp"].drop_duplicates().sort_values().tolist()
        selected = sorted(set(np.linspace(0, len(times) - 1, min(24, len(times)), dtype=int)))
        groups = list(frame.groupby(["train_id", "component"], sort=False))
        result = []
        for index in selected:
            timestamp = times[index]
            train_statuses = {}
            for (train_id, _), group in groups:
                recent = group.loc[(group["_timestamp"] <= timestamp) & ~group["_reference"]].tail(self.settings.recent_window)
                valid = recent.loc[recent["_score"].notna()]
                status, _ = _status(valid["_risk"].to_numpy(), valid["_robust"].to_numpy(), valid["_score"].gt(0).to_numpy())
                if recent.empty or pd.isna(recent.iloc[-1]["_score"]) or _stale_reason(group, timestamp):
                    status = "unknown"
                train_statuses[train_id] = max(status, train_statuses.get(train_id, "healthy"), key=STATUS_ORDER.get)
            result.append({"timestamp": iso(timestamp), **{status: list(train_statuses.values()).count(status) for status in STATUS_ORDER}})
        return result

    def _evaluate(self, frame: pd.DataFrame, source: str) -> dict:
        note = "Same-generator synthetic demonstration check, not independent validation; injected scenario markers are not verified faults. Point-level predictions use Isolation Forest -decision_function > 0 or maximum absolute reference robust deviation > 3 for the baseline. These results do not establish railway field performance or general model quality. No XGBoost, LSTM, SHAP or RUL model is claimed."
        if source != "synthetic" or "injected_anomaly" not in frame:
            return {"available": False, "context": "No independently verified monitoring labels are available for this upload.", "models": [], "note": "No accuracy, AUC, precision or recall is claimed for unlabelled uploaded data. Injected markers in uploads are not treated as verified labels."}
        monitored = frame.loc[~frame["_reference"] & frame["_score"].notna()].copy()
        labels = monitored["injected_anomaly"].astype(str).str.strip().str.lower().map({"true": 1, "false": 0, "1": 1, "0": 0, "1.0": 1, "0.0": 0})
        valid = labels.notna()
        monitored, labels = monitored.loc[valid], labels.loc[valid].astype(int)
        if len(labels) == 0:
            return {"available": False, "context": "No labelled, scored synthetic monitoring observations are available.", "models": [], "note": note}
        results = []
        for name, values, threshold in (("Isolation Forest", monitored["_score"].to_numpy(), 0.0),
                                        ("Robust deviation baseline", monitored["_robust"].to_numpy(), 3.0)):
            prediction = values > threshold
            precision, recall, f1, _ = precision_recall_fscore_support(labels, prediction, average="binary", zero_division=0)
            both_classes = labels.nunique() == 2
            results.append({"name": name, "auc": finite(roc_auc_score(labels, values)) if both_classes else None,
                            "precision": finite(precision) if prediction.any() else None,
                            "recall": finite(recall) if labels.any() else None,
                            "f1": finite(f1) if labels.any() else None,
                            "false_positives": int(((labels == 0) & prediction).sum())})
        return {"available": True, "context": f"Measured on {len(labels)} scored synthetic monitoring observations ({int(labels.sum())} injected positives), after the initial {self.settings.reference_fraction:.0%} reference period. Labels never enter preprocessing or model fitting.", "models": results, "note": note}
