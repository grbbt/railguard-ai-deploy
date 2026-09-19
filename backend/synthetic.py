"""Deterministic, explicitly synthetic railway telemetry for local demonstrations.

No readings in this module are physical evidence. Injection markers are evaluation
annotations, not verified fault labels, and must never be detector input features.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
START_UTC = "2026-09-01T00:00:00Z"
FREQUENCY = "5min"
COMPONENT_SENSORS = {
    "bogies": ("vibration_mm_s", "bearing_temp_c"),
    "doors": ("door_current_a", "door_cycle_s"),
    "brakes": ("brake_pressure_bar", "brake_temp_c"),
    "motors": ("motor_current_a", "motor_temp_c"),
}
SENSOR_UNITS = {
    "speed_kmh": "km/h",
    "ambient_temp_c": "°C",
    "vibration_mm_s": "mm/s",
    "bearing_temp_c": "°C",
    "door_current_a": "A",
    "door_cycle_s": "s",
    "brake_pressure_bar": "bar",
    "brake_temp_c": "°C",
    "motor_current_a": "A",
    "motor_temp_c": "°C",
}
COLUMNS = [
    "timestamp", "train_id", "train_name", "line", "component",
    *SENSOR_UNITS, "injected_anomaly", "scenario",
]
INJECTIONS = (
    {"train_id": "RG-101", "component": "bogies", "kind": "sustained", "start_fraction": 0.62,
     "scenario": "synthetic_bogie_vibration_temperature_shift",
     "end_offsets": {"vibration_mm_s": 4.2, "bearing_temp_c": 15.0}},
    {"train_id": "RG-103", "component": "doors", "kind": "sustained", "start_fraction": 0.68,
     "scenario": "synthetic_door_current_cycle_shift",
     "end_offsets": {"door_current_a": 4.0, "door_cycle_s": 1.25}},
    {"train_id": "RG-105", "component": "motors", "kind": "sustained", "start_fraction": 0.65,
     "scenario": "synthetic_motor_current_temperature_shift",
     "end_offsets": {"motor_current_a": 100.0, "motor_temp_c": 24.0}},
    {"train_id": "RG-106", "component": "brakes", "kind": "drift", "start_fraction": 0.70,
     "scenario": "synthetic_brake_pressure_temperature_drift",
     "end_offsets": {"brake_pressure_bar": -0.34, "brake_temp_c": 5.2}},
    {"train_id": "RG-108", "component": "bogies", "kind": "drift", "start_fraction": 0.73,
     "scenario": "synthetic_bogie_vibration_temperature_drift",
     "end_offsets": {"vibration_mm_s": 0.8, "bearing_temp_c": 4.2}},
)


def _injection_start(periods: int, fraction: float) -> int:
    return min(periods - 1, int(np.ceil(periods * fraction)))


def _baseline(seed: int, periods: int) -> pd.DataFrame:
    """Component-specific feature aggregates, with shared operating conditions."""
    rng = np.random.default_rng(seed)
    ticks = np.arange(periods)
    timestamps = pd.date_range(START_UTC, periods=periods, freq=FREQUENCY)
    rows: list[dict] = []
    lines = ("North", "East", "Circle", "Harbour")
    for train_index in range(8):
        train_id = f"RG-{101 + train_index}"
        phase = train_index * 0.57
        # Repeat several operating cycles within both reference and monitoring.
        # Values are five-minute aggregates, not instantaneous actuator readings.
        speed = np.clip(44 + 14 * np.sin(ticks * 2 * np.pi / 18 + phase)
                        + rng.normal(0, 2.0, periods), 18, 70)
        ambient = 28 + 0.8 * np.sin(ticks * 2 * np.pi / 48) + rng.normal(0, 0.15, periods)
        operating_load = 0.65 + 0.20 * np.sin(ticks * 2 * np.pi / 36 + phase)
        offset = (train_index - 3.5) / 3.5
        values = {
            "vibration_mm_s": 1.55 + speed * 0.012 + 0.035 * offset + rng.normal(0, 0.13, periods),
            "bearing_temp_c": 39 + speed * 0.035 + (ambient - 28) * 0.3 + 0.20 * offset + rng.normal(0, 0.65, periods),
            "door_current_a": 4.0 + operating_load * 0.25 + 0.04 * offset + rng.normal(0, 0.18, periods),
            "door_cycle_s": 2.75 + operating_load * 0.12 + 0.015 * offset + rng.normal(0, 0.075, periods),
            "brake_pressure_bar": 4.1 + speed * 0.001 + 0.015 * offset + rng.normal(0, 0.075, periods),
            "brake_temp_c": 44 + speed * 0.05 + operating_load * 1.3 + (ambient - 28) * 0.25 + rng.normal(0, 0.95, periods),
            "motor_current_a": 135 + speed * 0.65 + operating_load * 8 + 0.9 * offset + rng.normal(0, 4.5, periods),
            "motor_temp_c": 43 + speed * 0.055 + operating_load * 1.5 + (ambient - 28) * 0.3 + rng.normal(0, 1.1, periods),
        }
        for component, sensors in COMPONENT_SENSORS.items():
            for step, timestamp in enumerate(timestamps):
                row = {
                    "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
                    "train_id": train_id,
                    "train_name": f"Synthetic set {train_index + 1:02d}",
                    "line": lines[train_index % len(lines)],
                    "component": component,
                    "speed_kmh": round(float(speed[step]), 3),
                    "ambient_temp_c": round(float(ambient[step]), 3),
                    "injected_anomaly": 0,
                    "scenario": "synthetic_nominal",
                }
                row.update({sensor: round(float(values[sensor][step]), 4) for sensor in sensors})
                rows.append(row)
    return pd.DataFrame(rows).reindex(columns=COLUMNS)


def generate_dataset(seed: int = SEED, scenario: str = "mixed", periods: int = 288) -> pd.DataFrame:
    """Return eight trains × four components × ``periods`` synthetic records.

    ``healthy`` has no planted changes; ``mixed`` has three strong sustained
    changes and two modest drifts; ``missing`` adds selected sensor gaps to mixed.
    The first 40% of timestamps are always free of injected changes. Structural
    blanks mean a sensor does not apply to that component; they are intentional.
    """
    if scenario not in {"mixed", "healthy", "missing"}:
        raise ValueError("scenario must be mixed, healthy, or missing")
    if isinstance(periods, bool) or not isinstance(periods, int) or periods < 24:
        raise ValueError("periods must be an integer of at least 24")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be a non-negative integer")
    frame = _baseline(seed, periods)
    if scenario != "healthy":
        for injection in INJECTIONS:
            index = frame.index[(frame.train_id == injection["train_id"])
                                & (frame.component == injection["component"])]
            start = _injection_start(periods, injection["start_fraction"])
            affected = index[start:]
            ramp = np.linspace(0.05, 1.0, len(affected))
            if injection["kind"] == "sustained":
                ramp = np.minimum(1.0, 0.65 + np.arange(len(affected)) / max(1, periods * 0.06))
            for sensor, magnitude in injection["end_offsets"].items():
                frame.loc[affected, sensor] = (frame.loc[affected, sensor].to_numpy() + magnitude * ramp).round(4)
            frame.loc[affected, "injected_anomaly"] = 1
            frame.loc[affected, "scenario"] = injection["scenario"]
    if scenario == "missing":
        # Dedicated RNG means this scenario shares exactly the mixed scenario's
        # observed values; only declared omissions differ.
        rng = np.random.default_rng(seed + 10_000)
        for component, sensors in COMPONENT_SENSORS.items():
            index = frame.index[frame.component == component]
            for sensor in sensors:
                gaps = rng.choice(index, size=max(1, len(index) // 30), replace=False)
                frame.loc[gaps, sensor] = np.nan
        # All applicable sensors absent in the latest samples of one healthy
        # component exercises a truly unavailable current assessment.
        target = frame.index[(frame.train_id == "RG-102") & (frame.component == "doors")]
        frame.loc[target[-12:], list(COMPONENT_SENSORS["doors"])] = np.nan
    frame = frame.sort_values(["timestamp", "train_id", "component"], kind="stable").reset_index(drop=True)
    frame.attrs.update(source="synthetic", seed=seed, scenario=scenario,
                       label_meaning="Injected scenario marker for synthetic evaluation only; not a verified fault.")
    return frame


def _metadata(seed: int, periods: int) -> dict:
    timestamps = pd.date_range(START_UTC, periods=periods, freq=FREQUENCY)
    schedule = []
    for injection in INJECTIONS:
        start = _injection_start(periods, injection["start_fraction"])
        schedule.append({**injection, "start_step_zero_based": start,
                         "start_timestamp": timestamps[start].isoformat().replace("+00:00", "Z"),
                         "end_timestamp": timestamps[-1].isoformat().replace("+00:00", "Z"),
                         "injected_records": periods - start})
    return {
        "name": "RailGuard synthetic telemetry demonstration",
        "source": "synthetic", "generator": "backend.synthetic", "generator_version": "1.0",
        "seed": seed, "start_utc": START_UTC, "frequency_minutes": 5, "periods_per_component": periods,
        "train_count": 8, "components": list(COMPONENT_SENSORS), "records_per_dataset": 8 * 4 * periods,
        "reference_fraction": 0.4, "reference_periods": int(periods * 0.4),
        "sensor_units": SENSOR_UNITS, "applicable_sensors": COMPONENT_SENSORS,
        "context_columns": ["speed_kmh", "ambient_temp_c"],
        "exclude_from_model": ["timestamp", "train_id", "train_name", "line", "component", "injected_anomaly", "scenario"],
        "label_definition": "injected_anomaly=1 marks a planted synthetic change, not a confirmed fault or physical diagnosis. Evaluation only; never a detector feature.",
        "provenance": "All train names, measurements, operating conditions, and anomaly scenarios are generated. No railway operator data or empirical validation is claimed.",
        "limitations": [
            "Illustrative feature-level distributions and operating relationships; not calibrated from real rolling stock.",
            "Values are five-minute feature aggregates, not raw waveforms or synchronized actuator samples.",
            "Healthy means no planted change; a detector may still produce false positives.",
            "Absent non-applicable component sensors are structural blanks, not telemetry dropout.",
            "The mixed and missing injection markers are evaluation annotations; never verified fault labels.",
        ],
        "injection_schedule": schedule,
        "missing_variant": {
            "base": "mixed", "random_gap_fraction_per_applicable_sensor": "floor(component_rows / 30) cells per sensor",
            "additional_gap": "RG-102 doors: both applicable sensors absent for final 12 observations",
            "encoding": "Empty CSV fields; original absent values are preserved as missing",
        },
    }


def generate_datasets(output_dir: Path, seed: int = SEED, periods: int = 288) -> dict:
    """Write reproducible CSVs and a manifest; return the manifest dictionary."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata = _metadata(seed, periods)
    files = {}
    for scenario in ("mixed", "healthy", "missing"):
        frame = generate_dataset(seed=seed, scenario=scenario, periods=periods)
        filename = f"railguard_synthetic_{scenario}.csv"
        target = output_dir / filename
        frame.to_csv(target, index=False, lineterminator="\n")
        files[scenario] = {"filename": filename, "rows": len(frame),
                           "injected_records": int(frame.injected_anomaly.sum()),
                           "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        if scenario == "mixed":
            quoted = output_dir / "railguard_synthetic_quoted.csv"
            frame.to_csv(quoted, index=False, quoting=csv.QUOTE_ALL, lineterminator="\n")
            files["quoted"] = {"filename": quoted.name, "rows": len(frame),
                               "injected_records": int(frame.injected_anomaly.sum()),
                               "sha256": hashlib.sha256(quoted.read_bytes()).hexdigest(),
                               "note": "Identical mixed readings with every CSV field quoted; parsing regression fixture."}
    metadata["files"] = files
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate explicitly synthetic RailGuard demonstration CSVs.")
    parser.add_argument("--output", type=Path, default=Path("data"))
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--periods", type=int, default=288)
    args = parser.parse_args()
    metadata = generate_datasets(args.output, seed=args.seed, periods=args.periods)
    print(json.dumps({"source": "synthetic", "output": str(args.output.resolve()), "files": metadata["files"]}, indent=2))


if __name__ == "__main__":
    main()
