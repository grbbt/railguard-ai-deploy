"""Reproduce PS3 Train-only validation without changing deployed model artifacts.

Official metrics are recalculated here independently of the model metric helpers.
Door folds, ACV nested selection and SHM folds are then fitted again in memory.
No Test waveform or answer is read; this is not a hidden-test accuracy estimate.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone

from backend.ps3 import acv, door, rail, shm

FOLDERS = {"door": "Door", "acv": "ACV", "rail": "Rail_Corrugation", "shm": "SHM"}
ARTIFACTS = ROOT / "data/ps3_artifacts"
DATA = ROOT / "data/ps3/PS3/02_Datasets"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_csv(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def close(a, b, label):
    require(math.isclose(float(a), float(b), rel_tol=1e-10, abs_tol=1e-12), f"{label}: {a} != {b}")


def timestamp(value):
    parts = [int(part) for part in value.split("-")]
    require(len(parts) == 7 and 0 <= parts[-1] <= 999, "Invalid native Door timestamp")
    return datetime(*parts[:6], microsecond=parts[-1] * 1000)


def milliseconds(delta):
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000


def door_score(truth, predictions):
    candidates = []
    for ti, true in enumerate(truth):
        a, b = timestamp(true["start_time"]), timestamp(true["end_time"])
        for pi, pred in enumerate(predictions):
            if true["status"] != pred["prediction"]:
                continue
            c, d = timestamp(pred["start_time"]), timestamp(pred["end_time"])
            overlap = max(0, milliseconds(min(b, d) - max(a, c)))
            union = milliseconds(b - a) + milliseconds(d - c) - overlap
            if overlap and union > 0:
                candidates.append((Fraction(overlap, union), ti, pi))
    used_true, used_pred, credit = set(), set(), Fraction(0)
    for iou, ti, pi in sorted(candidates, key=lambda pair: (-pair[0], pair[1], pair[2])):
        if ti not in used_true and pi not in used_pred:
            used_true.add(ti)
            used_pred.add(pi)
            credit += iou
    score = 2 * credit / (len(truth) + len(predictions)) if truth or predictions else Fraction(0)
    return {"score": float(score), "exact_fraction": str(score), "matching_actions": len(used_true),
            "true_actions": len(truth), "predicted_actions": len(predictions), "iou_credit": float(credit)}


def ranking_score(rows, labels):
    ranks, scores, cases = [], [], []
    for row in rows:
        filename = row["file_id"]
        ranking = row["ranked_cars"]
        require(len(ranking) == 8 and len(set(ranking)) == 8, "ACV ranking must contain eight unique cars")
        require(row["faulty_car"] == labels[filename], f"ACV answer mismatch: {filename}")
        rank = ranking.index(labels[filename]) + 1
        score = Fraction(8 - rank + 1, 8)
        close(row["score"], score, f"ACV case metric {filename}")
        require(row["true_car_rank"] == rank, f"ACV saved rank mismatch: {filename}")
        ranks.append(rank)
        scores.append(score)
        cases.append({"file_id": filename, "faulty_car": labels[filename], "first_choice": ranking[0], "true_car_rank": rank})
    return {"cases": len(rows), "rank_decay": float(sum(scores) / len(scores)),
            "top1_correct": ranks.count(1), "top2_correct": sum(rank <= 2 for rank in ranks),
            "first_choice_accuracy": ranks.count(1) / len(ranks), "mean_rank": sum(ranks) / len(ranks),
            "case_results": cases}


def regression_score(rows, name):
    errors = [abs(row[name] - row["true"]) / row["true"] for row in rows]
    mape = sum(errors) / len(errors)
    return {"score": max(0, 1 - mape), "mape": mape,
            "mae": sum(abs(row[name] - row["true"]) for row in rows) / len(rows),
            "rmse": math.sqrt(sum((row[name] - row["true"]) ** 2 for row in rows) / len(rows)),
            "median_absolute_percentage_error": float(np.median(errors)),
            "worst_five": [{"file_id": row["file_id"], "true": row["true"], "prediction": row[name], "absolute_percentage_error": error}
                           for error, row in sorted(zip(errors, rows), key=lambda item: -item[0])[:5]]}


def class_score(rows, name):
    labels = ("Normal", "Side I", "Side II")
    matrix = [[sum(row["true"] == actual and row[name] == predicted for row in rows) for predicted in labels] for actual in labels]
    classes = {}
    for i, label in enumerate(labels):
        tp = matrix[i][i]
        fn = sum(matrix[i]) - tp
        fp = sum(line[i] for line in matrix) - tp
        classes[label] = {"support": tp + fn, "correct": tp, "precision": tp / (tp + fp) if tp + fp else 0,
                          "recall": tp / (tp + fn) if tp + fn else 0, "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0}
    return {"macro_f1": sum(value["f1"] for value in classes.values()) / 3,
            "accuracy": sum(matrix[i][i] for i in range(3)) / len(rows), "classes": classes,
            "confusion_matrix_true_rows_predicted_columns": matrix, "class_order": list(labels)}


def provenance(name, metadata, manifest):
    folder = DATA / FOLDERS[name]
    model_path = ARTIFACTS / name / "model.joblib"
    require(sha256(model_path) == metadata["model_sha256"], f"{name}: estimator/metadata binding failed")
    if "training_sources" in metadata:
        sources = [(folder / item["file"] if (folder / item["file"]).is_file() else folder / "Train" / item["file"], item["sha256"]) for item in metadata["training_sources"]]
    else:
        sources = [(folder / "Train" / filename, digest) for filename, digest in metadata["source_hashes"].items()]
        sources.append((folder / "Train_Labels.csv", metadata["labels_sha256"]))
    inspected = []
    for path, expected in sources:
        require("Test" not in path.parts, "Test source prohibited in this audit")
        actual = sha256(path)
        release_path = path.relative_to(ROOT / "data/ps3").as_posix()
        require(actual == expected == manifest[release_path], f"{name}: changed source {path.name}")
        inspected.append({"path": release_path, "sha256": actual})
    if name != "door":
        supplied = {path.name for path, _ in sources if path.parent.name == "Train"}
        require(supplied == {path.name for path in (folder / "Train").iterdir() if path.is_file()}, f"{name}: source coverage differs")
    bundle = joblib.load(model_path)
    require(bundle["subsystem"] == name, f"{name}: incorrect artifact subsystem")
    require(bundle.get("model_name", bundle.get("name")) == metadata["model_name"], f"{name}: wrong named estimator")
    return {"model_sha256": metadata["model_sha256"], "metadata_sha256": sha256(ARTIFACTS / name / "metadata.json"),
            "all_source_and_label_hashes_match_training_and_release": True, "checked_files": len(sources),
            "estimator_type": type(bundle["estimator"]).__name__, "sources": inspected}


def audit_door(metadata):
    folder = DATA / "Door"
    truth = sorted(read_csv(folder / "Train_Segments_Answer.csv"), key=lambda row: timestamp(row["start_time"]))
    saved = read_json(ARTIFACTS / "door/validation_predictions.json")
    candidates = {}
    for candidate in metadata["validation"]["candidates"]:
        result = door_score(truth, saved[candidate["name"]])
        close(result["score"], candidate["score"], "Door candidate score")
        candidates[candidate["name"]] = result
    frame = door.load_stream(folder / "Train.csv")
    answers = door._load_answers(folder / "Train_Segments_Answer.csv", frame)
    actions = [frame.loc[frame.timestamp.between(row.start, row.end)].reset_index(drop=True) for row in answers.itertuples()]
    features = pd.DataFrame([door.action_features(action) for action in actions])
    targets = (answers.status == door.LABELS[1]).to_numpy(int)
    groups = [hashlib.sha256(pd.util.hash_pandas_object(action[list(door.CHANNELS)], index=False).to_numpy().tobytes()).hexdigest() for action in actions]
    covered, rerun, folds = [], [], []
    for fold in metadata["validation"]["folds"]:
        training, heldout = fold["training_actions"], fold["heldout_actions"]
        require(not set(training) & set(heldout), "Door actions overlap between Train and heldout")
        require(not {groups[i] for i in training} & {groups[i] for i in heldout}, "Door duplicate waveforms leak across folds")
        covered.extend(heldout)
        permitted = pd.concat([actions[i] for i in training]).sort_values("timestamp")
        config = door.segmentation_config(permitted)
        require(config == fold["segmentation"], "Door fold segmenter changed")
        stream = frame.loc[frame.timestamp.between(answers.iloc[heldout[0]].start, answers.iloc[heldout[-1]].end)].reset_index(drop=True)
        detected = door.segment_stream(stream, config)
        fitted = door._fit(metadata["model_name"], features.iloc[training], targets[training])
        rows = door._rows(detected, door._classify(fitted, pd.DataFrame([door.action_features(part) for part in detected])))
        result = door_score([truth[i] for i in heldout], rows)
        close(result["score"], fold["scores"][metadata["model_name"]], "Door fresh fold score")
        rerun.extend(rows)
        folds.append({"fold": fold["fold"], "training_actions": len(training), "heldout_actions": len(heldout), **result})
    require(sorted(covered) == list(range(len(truth))), "Door heldout coverage invalid")
    require(rerun == saved[metadata["model_name"]], "Door rerun differs from saved OOF")
    return {"metric": "IoU-weighted F1", "selected_model": metadata["model_name"], "selected": candidates[metadata["model_name"]],
            "candidate_metrics": candidates, "fresh_train_fold_replay_matches_saved": True, "folds": folds,
            "duplicate_waveform_groups": len(set(groups)), "group_leakage_detected": False,
            "scope": "110 held-out actions in five blocks of one previously inspected training stream; not independent door acquisitions."}


def audit_acv(metadata):
    labels = {row["filename"]: row["faulty_car"] for row in read_csv(DATA / "ACV/Train_Labels.csv")}
    saved = read_json(ARTIFACTS / "acv/validation_predictions.json")
    groups = metadata["input_groups"]
    candidates = {}
    for candidate in metadata["validation"]["candidates"]:
        name = candidate["name"]
        candidates[name] = ranking_score(saved[name], labels)
        close(candidates[name]["rank_decay"], candidate["score"], "ACV saved candidate score")
    nested_saved = metadata["validation"]["nested_validation"]
    nested_metrics = ranking_score(nested_saved["folds"], labels)
    close(nested_metrics["rank_decay"], nested_saved["score"], "ACV saved nested score")
    def inspect_split(row, universe):
        training, heldout = set(row["training_files"]), set(row["heldout_files"])
        require(training | heldout == universe and not training & heldout, "ACV split coverage/leakage failed")
        require(not {groups[name] for name in training} & {groups[name] for name in heldout}, "ACV duplicate-group leakage")
        require(row["file_id"] in heldout, "ACV heldout prediction belongs to Train")
    for rows in saved.values():
        require({row["file_id"] for row in rows} == set(labels) and len(rows) == len(labels), "ACV case coverage differs")
        for row in rows:
            inspect_split(row, set(labels))
    for outer in nested_saved["folds"]:
        inspect_split(outer, set(labels))
        for inner in outer["inner_folds"]:
            inspect_split(inner, set(outer["training_files"]))
            require(not set(outer["heldout_files"]) & (set(inner["training_files"]) | set(inner["heldout_files"])), "ACV outer case leaks into candidate selection")
    cases = [acv.load_case(DATA / "ACV/Train" / filename) for filename in sorted(labels)]
    require({case.file_id: case.content_sha256 for case in cases} == groups, "ACV freshly parsed feature grouping changed")
    original_fit, fit_calls = acv._fit, []
    def guarded_fit(name, training, training_labels):
        filenames = {case.file_id for case in training}
        require(filenames == set(training_labels) and filenames <= set(labels), "ACV fitter saw answers beyond its training cases")
        fit_calls.append({"candidate": name, "training_files": sorted(filenames)})
        return original_fit(name, training, training_labels)
    acv._fit = guarded_fit
    try:
        predicted, _, nested = acv.evaluate_cases(cases, labels, groups, list(saved))
    finally:
        acv._fit = original_fit
    for name in saved:
        for actual, expected in zip(predicted[name], saved[name]):
            for key in ("file_id", "ranked_cars", "true_car_rank", "training_files", "heldout_files"):
                require(actual[key] == expected[key], f"ACV replay differs: {name}/{key}")
    for actual, expected in zip(nested["folds"], nested_saved["folds"]):
        require(actual["selected_model"] == expected["selected_model"] and actual["ranked_cars"] == expected["ranked_cars"], "ACV nested replay differs")
    close(nested["score"], nested_saved["score"], "ACV fresh nested score")
    return {"metric": "Linear rank-decay", "selected_model": metadata["model_name"],
            "selected_fixed_candidate_cv": candidates[metadata["model_name"]], "candidate_metrics": candidates,
            "nested_candidate_selection_cv": nested_metrics, "fresh_workbooks_and_nested_replay_matches_saved": True,
            "guarded_fit_calls": len(fit_calls), "outer_folds_checked": len(nested["folds"]),
            "selected_inner_folds_checked": sum(len(row["inner_folds"]) for row in nested["folds"]),
            "fitter_answers_restricted_to_its_training_cases": True, "group_leakage_detected": False,
            "scope": "Six previously inspected development workbooks. Fixed-candidate CV and nested model-selection CV are different evaluations; neither is an untouched external test."}


def grouped_rows(name, metadata):
    rows = read_json(ARTIFACTS / name / "oof_predictions.json")
    target = "damage" if name == "shm" else "label"
    table = read_csv(DATA / FOLDERS[name] / "Train_Labels.csv")
    if name == "rail":
        target = next(key for key in table[0] if key != "filename")
    labels = {row["filename"]: float(row[target]) if name == "shm" else row[target] for row in table}
    require(len(rows) == len(labels) and {row["file_id"] for row in rows} == set(labels), f"{name}: OOF coverage invalid")
    group_folds = defaultdict(set)
    for row in rows:
        require(row["true"] == labels[row["file_id"]], f"{name}: saved answer differs from released Train answer")
        group_folds[row["group"]].add(row["fold"])
    require(all(len(folds) == 1 for folds in group_folds.values()), f"{name}: same waveform group crosses folds")
    require(len(group_folds) == metadata["independent_groups"], f"{name}: group count differs")
    return rows


def audit_shm(metadata):
    rows = grouped_rows("shm", metadata)
    candidates = {}
    for candidate in metadata["validation"]["candidates"]:
        result = regression_score(rows, candidate["name"])
        close(result["score"], candidate["score"], "SHM candidate metric")
        close(result["mape"], candidate["mape"], "SHM candidate MAPE")
        candidates[candidate["name"]] = result
    records = []
    for index, row in enumerate(rows):
        signal, _ = shm.load_signal(DATA / "SHM/Train" / row["file_id"])
        record = shm.extract_features(signal)
        records.append({**record, "filename": row["file_id"], "sha256": metadata["source_hashes"][row["file_id"]]})
        if (index + 1) % 8 == 0:
            print(f"SHM fresh complete-waveform features: {index + 1}/{len(rows)}", flush=True)
    names = metadata["feature_names"]
    require(all(list(record["features"]) == names for record in records), "SHM feature schema changed")
    groups, _ = rail.duplicate_groups(records)
    require(groups.tolist() == [row["group"] for row in rows], "SHM newly calculated waveform groups differ")
    X = np.asarray([[record["features"][name] for name in names] for record in records])
    y = np.asarray([row["true"] for row in rows])
    bundle = joblib.load(ARTIFACTS / "shm/model.joblib")
    predictions = np.zeros(len(rows))
    fold_ids = np.array([row["fold"] for row in rows])
    fold_results = []
    for fold in sorted(set(fold_ids)):
        heldout, training = fold_ids == fold, fold_ids != fold
        require(not set(groups[training]) & set(groups[heldout]), "SHM replay group leakage")
        model = clone(bundle["estimator"]).fit(X[training], y[training])
        predictions[heldout] = model.predict(X[heldout])
        fold_results.append({"fold": int(fold), "training_files": int(training.sum()), "heldout_files": int(heldout.sum()),
                             "fitted_moment": names[model.moment_index_], "fitted_scale": float(np.exp(model.log_scale_))})
    for row, prediction in zip(rows, predictions):
        close(prediction, row[metadata["model_name"]], f"SHM fresh OOF replay {row['file_id']}")
    return {"metric": "max(0, 1 - MAPE)", "selected_model": metadata["model_name"],
            "selected": candidates[metadata["model_name"]], "candidate_metrics": candidates,
            "files": len(rows), "samples": sum(record["samples"] for record in records), "folds": fold_results,
            "fresh_full_waveform_features_and_fold_replay_matches_saved": True, "group_leakage_detected": False,
            "scope": "Whole-file grouped CV on 64 previously inspected Train recordings; 1-MAPE is a regression score, not classification accuracy."}


def audit_rail(metadata):
    rows = grouped_rows("rail", metadata)
    candidates = {}
    for candidate in metadata["validation"]["candidates"]:
        result = class_score(rows, candidate["name"])
        close(result["macro_f1"], candidate["score"], "Rail candidate metric")
        candidates[candidate["name"]] = result
    return {"metric": "Macro F1", "selected_model": metadata["model_name"], "selected": candidates[metadata["model_name"]],
            "candidate_metrics": candidates, "files": len(rows), "groups": len({row["group"] for row in rows}),
            "folds": dict(Counter(row["fold"] for row in rows)), "group_leakage_detected": False,
            "scope": "Independent arithmetic/source/saved-group audit only; Rail refit and candidate experiments are a separate report."}


def main(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_json = read_json(ROOT / "data/ps3/manifest.json")
    manifest = {item["path"]: item["sha256"] for item in manifest_json["files"]}
    before = {name: {filename: sha256(ARTIFACTS / name / filename) for filename in ("model.joblib", "metadata.json")} for name in FOLDERS}
    result = {"audited_at": datetime.now(timezone.utc).isoformat(), "release_commit": manifest_json["commit"],
              "method": "Independent official-metric arithmetic against original Train answers; fresh Door/ACV/SHM Train-only feature and fold replay; SHA-256 binding to fitted metadata and pinned release.",
              "test_inputs_read": False, "hidden_test_accuracy": "Not available: hidden answers are not released.",
              "candidate_tuning_performed": False, "models": {}}
    for name in FOLDERS:
        print(f"Checking {name}: deployed model binding and every training source hash", flush=True)
        metadata = read_json(ARTIFACTS / name / "metadata.json")
        record = {"provenance": provenance(name, metadata, manifest)}
        record["evaluation"] = {"door": audit_door, "acv": audit_acv, "rail": audit_rail, "shm": audit_shm}[name](metadata)
        result["models"][name] = record
        print(f"{name}: metric/source/fold audit passed", flush=True)
    after = {name: {filename: sha256(ARTIFACTS / name / filename) for filename in ("model.joblib", "metadata.json")} for name in FOLDERS}
    require(before == after, "Deployed artifacts changed while the audit ran")
    result.update({"active_models_and_metadata_unchanged": True, "passed": True,
                   "limits": ["Declared exact/near-duplicate group exclusion is checked; undocumented common acquisition dependence cannot be ruled out.",
                              "These development folds previously guided model selection; repeated reproduction does not create a new independent test.",
                              "Unit tests and application tests validate behavior and are not predictive accuracy measurements."]})
    (output_dir / "baseline-audit.json").write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Audit passed. Saved {output_dir / 'baseline-audit.json'}", flush=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs/model-review-20260919")
    args = parser.parse_args()
    main(args.output_dir)
