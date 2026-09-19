"""Reproduce and audit a bounded Rail candidate set using labelled Train data only.

This retrospective review never reads official Test inputs and never changes the
installed model. Candidate choices are written before fitting. Whole-recording
duplicate groups stay together; preprocessing is fitted inside every fold.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time

for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(variable, "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from backend.ps3 import rail


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def score(y, predicted):
    return {
        "macro_f1": float(f1_score(y, predicted, labels=[0, 1, 2], average="macro", zero_division=0)),
        "accuracy": float(accuracy_score(y, predicted)),
        "correct": int(np.count_nonzero(y == predicted)),
        "total": len(y),
        "confusion_matrix": confusion_matrix(y, predicted, labels=[0, 1, 2]).tolist(),
        "per_class": classification_report(y, predicted, labels=[0, 1, 2], target_names=rail.LABELS,
                                           output_dict=True, zero_division=0),
    }


def candidates(names):
    baseline = rail._candidates(names)
    summary_indices = [i for i, name in enumerate(names)
                       if ".summary." in name or name.startswith(("context.", "contrast."))]
    full_svm = Pipeline([
        ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
        ("scale", StandardScaler()),
        ("model", SVC(C=1.0, kernel="rbf", gamma="scale", class_weight="balanced")),
    ])
    summary_svm = Pipeline([
        ("summaries", ColumnTransformer([("select", "passthrough", summary_indices)], remainder="drop")),
        ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
        ("scale", StandardScaler()),
        ("model", SVC(C=1.0, kernel="rbf", gamma="scale", class_weight="balanced")),
    ])
    fine_trees = Pipeline([
        ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
        ("model", ExtraTreesClassifier(n_estimators=320, class_weight="balanced", min_samples_leaf=1,
                                        max_features="sqrt", random_state=42, n_jobs=1)),
    ])
    return baseline + [
        ("Balanced RBF SVM, all features", full_svm, False),
        ("Balanced RBF SVM, side summaries", summary_svm, False),
        ("Balanced Extra Trees, leaf size 1", fine_trees, False),
    ], len(baseline)


def make_folds(X, y, groups, count, seed):
    minimum = min(len(np.unique(groups[y == category])) for category in range(3))
    count = min(count, minimum)
    if count < 2:
        raise ValueError("Not enough labelled groups for a grouped audit")
    folds = list(StratifiedGroupKFold(n_splits=count, shuffle=True, random_state=seed).split(X, y, groups))
    for training, validation in folds:
        if set(groups[training]) & set(groups[validation]):
            raise RuntimeError("Duplicate group leaked across folds")
        if len(np.unique(y[training])) != 3:
            raise ValueError("A training fold lacks a class")
    return folds


def evaluate(candidate_set, X, y, folds, context):
    results, predictions = [], {}
    for name, estimator, weighted in candidate_set:
        started = time.monotonic()
        predicted = np.full(len(y), -1, dtype=int)
        fold_results = []
        for training, validation in folds:
            fitted = rail._fit(clone(estimator), X[training], y[training], weighted)
            predicted[validation] = fitted.predict(X[validation]).astype(int)
            fold_results.append(score(y[validation], predicted[validation]))
        if (predicted < 0).any():
            raise RuntimeError("Some observations have no held-out prediction")
        result = {"candidate": name, **score(y, predicted), "folds": fold_results}
        results.append(result)
        predictions[name] = predicted
        print(f"{context}: {name}: macro F1={result['macro_f1']:.6f}; "
              f"Side I recall={result['per_class']['Side I']['recall']:.6f}; "
              f"seconds={time.monotonic()-started:.1f}", flush=True)
    return results, predictions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data/ps3/PS3/02_Datasets/Rail_Corrugation")
    parser.add_argument("--artifact-dir", type=Path, default=ROOT / "data/ps3_artifacts/rail")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs/model-review-20260919/rail")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    active = args.artifact_dir.resolve()
    if output == active or output.is_relative_to(active):
        raise ValueError("Review output must not overwrite the installed artifact directory")
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    metadata = json.loads((active / "metadata.json").read_text(encoding="utf-8"))
    installed_hash_before = rail._sha256(active / "model.joblib")
    table, label_path = rail._label_table(args.data_dir, "label")
    if rail._sha256(label_path) != metadata["labels_sha256"]:
        raise ValueError("Training labels have changed since cached feature provenance")
    records = []
    source_hashes = {}
    for row in table.itertuples(index=False):
        path = args.data_dir / "Train" / row.filename
        digest = rail._sha256(path)
        if digest != metadata["source_hashes"].get(row.filename):
            raise ValueError(f"Training source hash mismatch: {row.filename}")
        cached = active / "feature_cache" / f"{rail.VERSION}-{digest}.joblib"
        if not cached.is_file():
            raise ValueError(f"Missing existing Train feature cache for {row.filename}")
        record = joblib.load(cached)
        records.append({**record, "sha256": digest, "filename": row.filename})
        source_hashes[row.filename] = {"source_sha256": digest, "cache_sha256": rail._sha256(cached),
                                       "numeric_sha256": record["numeric_sha256"]}
    names = list(records[0]["features"])
    if names != metadata["feature_names"] or any(list(r["features"]) != names for r in records):
        raise ValueError("Feature schema mismatch")
    X = np.asarray([list(r["features"].values()) for r in records], dtype=float)
    y = np.asarray([rail.LABELS.index(label) for label in table["label"]], dtype=int)
    groups, duplicate_links = rail.duplicate_groups(records)
    for group in np.unique(groups):
        if len(np.unique(y[groups == group])) != 1:
            raise ValueError("Duplicate group has conflicting labels")
    candidate_set, baseline_count = candidates(names)
    protocol = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "Retrospective development-data audit; not official hidden-test evaluation",
        "data_policy": "Only Train_Labels.csv and explicitly named Train files were opened. No Test input or label is read.",
        "training_files": len(y), "feature_count": len(names), "groups": len(np.unique(groups)),
        "class_counts": {label: int(np.count_nonzero(y == i)) for i, label in enumerate(rail.LABELS)},
        "labels_sha256": metadata["labels_sha256"], "feature_version": rail.VERSION,
        "source_hashes": source_hashes, "duplicate_links": duplicate_links,
        "installed_model_sha256": installed_hash_before,
        "script_sha256": rail._sha256(Path(__file__)),
        "candidates_predeclared_before_fitting": [{"name": name, "pipeline": repr(estimator), "sample_weighted": weighted}
                                                   for name, estimator, weighted in candidate_set],
        "selection_rule": "Highest aggregate inner out-of-fold macro F1; ties resolved in listed candidate order.",
        "comparison": "Existing candidate set versus expanded candidate set, using identical outer and inner folds.",
        "folds": "Outer: 4-fold StratifiedGroupKFold seed 42. Inner: up to 3 grouped folds, seed 31415 plus outer-fold index.",
        "limits": ["Train data has already been inspected during earlier model development; nested audit is retrospective.",
                   "Only 14 Side I recordings constrain fault recall estimates.",
                   "Exact and conservative near-duplicate groups are enforced; unknown shared acquisition runs may remain.",
                   "No performance claim about official Test data or operational railways can be inferred.",
                   "No candidate is promoted automatically; installed artifacts stay unchanged."],
    }
    write_json(output / "protocol.json", protocol)
    folds = make_folds(X, y, groups, 4, 42)
    fold_ids = np.full(len(y), -1, dtype=int)
    splits = []
    for fold, (training, validation) in enumerate(folds):
        fold_ids[validation] = fold
        inner = make_folds(X[training], y[training], groups[training], 3, 31415 + fold)
        splits.append({"outer_fold": fold, "train_files": table.iloc[training]["filename"].tolist(),
                       "validation_files": table.iloc[validation]["filename"].tolist(),
                       "inner": [{"fold": index,
                                  "train_files": table.iloc[training[a]]["filename"].tolist(),
                                  "validation_files": table.iloc[training[b]]["filename"].tolist()}
                                 for index, (a, b) in enumerate(inner)]})
    write_json(output / "splits.json", splits)
    oof_results, oof_predictions = evaluate(candidate_set, X, y, folds, "Outer fixed-candidate OOF")
    write_json(output / "candidate_results.json", oof_results)
    oof_frame = pd.DataFrame({"file_id": table["filename"], "group": groups, "outer_fold": fold_ids,
                              "true": [rail.LABELS[value] for value in y]})
    for name, predictions in oof_predictions.items():
        oof_frame[name] = [rail.LABELS[value] for value in predictions]
    oof_frame.to_csv(output / "candidate_oof_predictions.csv", index=False)
    stored_oof = json.loads((active / "oof_predictions.json").read_text(encoding="utf-8"))
    stored = {row["file_id"]: row for row in stored_oof}
    reproduction = {name: bool(all(rail.LABELS[int(oof_predictions[name][i])] == stored[row.filename][name]
                                  for i, row in enumerate(table.itertuples(index=False))))
                    for name, _, _ in candidate_set[:baseline_count]}
    write_json(output / "baseline_reproduction.json", reproduction)
    nested_predictions = {"existing_candidate_selection": np.full(len(y), -1, dtype=int),
                          "expanded_candidate_selection": np.full(len(y), -1, dtype=int)}
    nested_details, inner_predictions = [], []
    for fold, (training, validation) in enumerate(folds):
        inner_folds = make_folds(X[training], y[training], groups[training], 3, 31415 + fold)
        results, inner_oof = evaluate(candidate_set, X[training], y[training], inner_folds,
                                      f"Inner selection, outer fold {fold}")
        inner_fold_ids = np.full(len(training), -1, dtype=int)
        for inner_fold, (_, heldout) in enumerate(inner_folds):
            inner_fold_ids[heldout] = inner_fold
        for local_index, global_index in enumerate(training):
            inner_predictions.append({"outer_fold": fold, "inner_fold": int(inner_fold_ids[local_index]),
                                      "file_id": table.iloc[global_index]["filename"],
                                      "true": rail.LABELS[y[global_index]],
                                      **{name: rail.LABELS[values[local_index]] for name, values in inner_oof.items()}})
        detail = {"outer_fold": fold, "inner_results": results, "selected": {}}
        for mode, limit in (("existing_candidate_selection", baseline_count), ("expanded_candidate_selection", len(candidate_set))):
            selected = max(range(limit), key=lambda index: results[index]["macro_f1"])
            name, estimator, weighted = candidate_set[selected]
            fitted = rail._fit(clone(estimator), X[training], y[training], weighted)
            prediction = fitted.predict(X[validation]).astype(int)
            nested_predictions[mode][validation] = prediction
            detail["selected"][mode] = {"candidate": name, "inner_macro_f1": results[selected]["macro_f1"],
                                         "outer_result": score(y[validation], prediction)}
        nested_details.append(detail)
        write_json(output / "nested_fold_details.json", nested_details)
        pd.DataFrame(inner_predictions).to_csv(output / "inner_oof_predictions.csv", index=False)
    nested_summary = {name: score(y, values) for name, values in nested_predictions.items()}
    for name, values in nested_predictions.items():
        oof_frame[name] = [rail.LABELS[value] for value in values]
    oof_frame.to_csv(output / "all_oof_predictions.csv", index=False)
    best_index = max(range(len(candidate_set)), key=lambda index: oof_results[index]["macro_f1"])
    best_name, best_estimator, best_weighted = candidate_set[best_index]
    fitted = rail._fit(clone(best_estimator), X, y, best_weighted)
    candidate_artifact = output / "candidate_model.joblib"
    joblib.dump({"version": rail.VERSION, "subsystem": "rail", "model_name": best_name,
                 "feature_names": names, "estimator": fitted}, candidate_artifact, compress=3)
    result = {
        "completed_at": datetime.now(timezone.utc).isoformat(), "elapsed_seconds": time.monotonic() - started,
        "best_development_candidate": best_name, "best_development_metrics": oof_results[best_index],
        "nested_selection_comparison": nested_summary, "baseline_exact_reproduction": reproduction,
        "candidate_artifact_sha256": rail._sha256(candidate_artifact),
        "installed_artifact_unchanged": rail._sha256(active / "model.joblib") == installed_hash_before,
        "limitations": protocol["limits"],
    }
    write_json(output / "summary.json", result)
    print(json.dumps({"best_candidate": best_name, "candidate_macro_f1": oof_results[best_index]["macro_f1"],
                      "nested": {key: {"macro_f1": value["macro_f1"], "accuracy": value["accuracy"],
                                       "side_i_recall": value["per_class"]["Side I"]["recall"]}
                                 for key, value in nested_summary.items()},
                      "elapsed_seconds": result["elapsed_seconds"]}, indent=2), flush=True)


if __name__ == "__main__":
    main()
