# Rail model review - 19 September 2026

Retain the installed Class-weighted XGBoost model. None of the three predeclared additions improved macro F1 or Side I recall. The installed model and metadata were not changed.

The audit used all 272 labelled Train recordings in 270 exact/near-duplicate groups. Every source file was rehashed against installed provenance before its cached features were read. Official Test files were not opened. The existing four candidate OOF prediction columns reproduced exactly.

| Candidate | Macro F1 | Side I recall |
|---|---:|---:|
| Balanced logistic regression | 0.636456 | 21.43% |
| Balanced Extra Trees | 0.524675 | 0.00% |
| Class-weighted XGBoost | 0.785747 | 50.00% |
| Normal-reference side Isolation Forest | 0.289674 | 0.00% |
| Balanced RBF SVM, all features | 0.589433 | 14.29% |
| Balanced RBF SVM, side summaries | 0.594503 | 28.57% |
| Balanced Extra Trees, leaf size 1 | 0.479920 | 0.00% |

Both the original 4-candidate selection process and the expanded 7-candidate process selected XGBoost in every outer fold. Both retrospective nested audits therefore produced macro F1 **0.785747**, with **254/272 correct classifications (93.38%)**. Macro F1 is the official task metric; the higher overall accuracy reflects the large Normal majority. Side I recall remains **7/14 = 50%**; Side II recall is **20/24 = 83.33%**.

The nested result measures a model-selection procedure, not a fresh independent test of a newly discovered model. These development recordings and outer folds were used during earlier work, and unknown acquisition-run dependence may remain. This audit does not establish hidden-test performance or railway deployment reliability.

## Reproduce

Run `.venv\Scripts\python.exe scripts/review_rail_models.py` from the project root. Model training uses one CPU thread per estimator. This review took 163 seconds.

## Evidence

- `protocol.json`: candidate choices recorded before fitting, source/cache hashes, data policy and limits.
- `splits.json`: every outer and inner Train/validation file split.
- `candidate_oof_predictions.csv` and `all_oof_predictions.csv`: whole-file held-out predictions.
- `inner_oof_predictions.csv`: predictions used only for within-outer-fold candidate selection.
- `candidate_results.json` and `nested_fold_details.json`: measured per-class, confusion and fold results.
- `baseline_reproduction.json`: exact reproduction checks for the original four candidates.
- `verification.json`: independent plain-Python recalculation and group-isolation checks.
- `summary.json`: final comparison and installed-model preservation.
- `validation_review.json`: ready-to-integrate validation metadata; it has not been copied into active artifacts.
- `candidate_model.joblib`: locally generated review-only refit of the winning XGBoost pipeline, excluded from Git; rerun the review script to reproduce it. It has not replaced the installed model.

A meaningful next modelling step requires more independent Side I recordings or better acquisition-group metadata and a new untouched evaluation set. Increasing fit on already inspected Train files would not establish improved generalization.
