"""Check trusted frozen models and optional cross-platform prediction parity.

This performs inference only. It neither retrains nor measures hidden-Test accuracy,
creates saved jobs, or contacts an AI provider. Run inside the deployed backend too.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
from pathlib import Path
import platform
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLES = {
    "door": "Door/Test.csv",
    "acv": "ACV/Test/acv_test_case.xlsx",
    "rail": "Rail_Corrugation/Test/Test1.csv",
    "shm": "SHM/Test/test01.csv",
}
REFERENCE_VERSION = 1


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def compare_rows(actual: list, expected: list, subsystem: str) -> None:
    if not isinstance(expected, list) or len(actual) != len(expected):
        raise ValueError(f"{subsystem}: prediction row count differs from reference")
    for index, (left, right) in enumerate(zip(actual, expected), 1):
        if not isinstance(right, dict) or set(left) != set(right):
            raise ValueError(f"{subsystem}: row {index} schema differs from reference")
        for key in left:
            if subsystem == "shm" and key == "prediction":
                value = right[key]
                if (isinstance(value, bool) or not isinstance(value, (float, int))
                        or not math.isfinite(value)
                        or not math.isclose(left[key], value, rel_tol=1e-8, abs_tol=1e-12)):
                    raise ValueError(f"{subsystem}: regression output differs from reference")
            elif left[key] != right[key]:
                raise ValueError(f"{subsystem}: row {index} {key} differs from reference")


def compare_reference(record: dict, reference: dict, subsystem: str) -> None:
    for key in ("model_sha256", "metadata_sha256", "sample", "input_sha256"):
        if record[key] != reference.get(key):
            raise ValueError(f"{subsystem}: {key} differs from reference")
    compare_rows(record["prediction_rows"], reference.get("prediction_rows"), subsystem)


def check_models(root: Path, inference: bool = False, reference: dict | None = None) -> dict:
    from backend.ps3.rail import _load_model
    from backend.ps3.service import clean_json, validate_predictions

    if reference is not None and (
        reference.get("version") != REFERENCE_VERSION
        or not isinstance(reference.get("models"), dict)
        or set(reference["models"]) != set(SAMPLES)
    ):
        raise ValueError("Reference must contain exactly all four models at version 1")
    records = {}
    for subsystem, sample in SAMPLES.items():
        module = importlib.import_module(f"backend.ps3.{subsystem}")
        directory = root / "data/ps3_artifacts" / subsystem
        # The production loader checks provenance before deserializing these
        # trusted, owner-provisioned artifacts. Never accept uploaded models here.
        _load_model(directory, subsystem, module.VERSION)
        record = {"model_sha256": digest(directory / "model.joblib"),
                  "metadata_sha256": digest(directory / "metadata.json")}
        if inference:
            source = root / "data/ps3/PS3/02_Datasets" / sample
            if not source.is_file():
                raise ValueError(f"{subsystem}: Test sample missing; package with --include-test-data")
            before = digest(source)
            report = clean_json(module.predict(source, directory))
            validate_predictions(subsystem, report)
            record.update(sample=sample, input_sha256=before,
                          prediction_rows=report["prediction_rows"])
            if digest(source) != before or digest(directory / "model.joblib") != record["model_sha256"]:
                raise ValueError(f"{subsystem}: source or model changed during inference")
            if reference is not None:
                expected = reference["models"][subsystem]
                if not isinstance(expected, dict):
                    raise ValueError(f"{subsystem}: invalid reference record")
                compare_reference(record, expected, subsystem)
        records[subsystem] = record
        count = f", {len(record['prediction_rows'])} prediction rows" if inference else ""
        print(f"PASS {subsystem}: artifact integrity and loading{count}", flush=True)
    return {"version": REFERENCE_VERSION,
            "purpose": "Frozen prediction parity only; not independent accuracy or hidden-Test scoring",
            "generated_on": {"system": platform.system(), "machine": platform.machine(),
                             "python": platform.python_version()},
            "models": records}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inference", action="store_true", help="Predict one official Test sample per subsystem")
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--reference", type=Path, help="Compare to an existing trusted parity reference")
    choice.add_argument("--write-reference", type=Path, help="Write a NEW parity reference from this runtime")
    args = parser.parse_args()
    if (args.reference or args.write_reference) and not args.inference:
        parser.error("--reference and --write-reference require --inference")
    try:
        reference = json.loads(args.reference.read_text(encoding="utf-8")) if args.reference else None
        if reference is not None and not isinstance(reference, dict):
            raise ValueError("Reference must be a JSON object")
        if args.write_reference and args.write_reference.exists():
            raise ValueError("Reference already exists; preserve it or choose a new path")
        result = check_models(ROOT, args.inference, reference)
        if args.write_reference:
            args.write_reference.parent.mkdir(parents=True, exist_ok=True)
            with args.write_reference.open("x", encoding="utf-8", newline="\n") as output:
                json.dump(result, output, ensure_ascii=False, allow_nan=False, indent=2)
                output.write("\n")
        print("Deployment model checks passed. This is compatibility testing, not a new accuracy score.")
        return 0
    except (OSError, ValueError, ImportError) as exc:
        print(f"Deployment model check failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
