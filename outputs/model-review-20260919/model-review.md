# Released-data model audit — 19 September 2026

The deployed Door, ACV, Rail and SHM model scores reproduce correctly against the released **Train answers**. The audit checked all **347 training-input and answer-file hashes** against both fitted-model metadata and the pinned release manifest. All four model/metadata hash bindings passed, and deployed models and metadata were unchanged after evaluation.

This is a reproducibility and validation audit. Repeating development cross-validation does not create a new independent test, improve a score by itself, or establish hidden-Test accuracy.

| Task and evaluation | Reproduced result | What was actually checked |
| --- | --- | --- |
| Door — selected model, five held-out action blocks | IoU-weighted F1 **1.000000**; all **110/110** actions matched with exact boundaries and correct class | Reread original telemetry, regenerate action features, refit segmentation configuration and logistic classifier inside every training fold, predict held-out streams, independently score matches using exact rational IoU arithmetic |
| ACV — fixed selected model, leave one case group out | First choice **5/6 = 83.3%**; top two **6/6**; rank-decay **0.979167** | Freshly parse six complete workbooks; recompute selected-input groups; refit all five declared candidates on held-out-case folds; independently join predictions to original answers |
| ACV — nested candidate-selection audit | First choice **4/6 = 66.7%**; top two **5/6**; rank-decay **0.916667** | Reproduce six outer folds and thirty selected inner folds; inspect 105 in-memory fitting calls and enforce that each fitter receives only its own training-case answers |
| Rail — deployed baseline, four grouped folds | Macro F1 **0.785747**; **254/272** exact classifications | Independently recompute all candidate metrics from saved OOF predictions; verify original answer joins and 270 saved waveform groups remain within individual folds; verify all source hashes |
| SHM — selected model, five grouped folds | MAPE **0.026411 = 2.6411%** average relative error; competition score **0.973589** | Freshly load all 64 waveforms and recompute features from **37,191,680** samples; recreate waveform groups; refit selected rainflow-moment estimator in each fold and reproduce every saved OOF prediction |

The Rail row is the frozen baseline. A [separate seven-candidate Rail review](rail/REVIEW.md) reproduced all four original candidates and tested three predeclared alternatives. Both the original and expanded candidate-selection procedures chose XGBoost in every outer fold, with the same macro F1 of 0.785747. The new candidates performed worse, so the installed model was retained. No accuracy gain is claimed.

## Findings that affect interpretation

- **Door:** the local score is exact, but all 110 actions come from one previously inspected stream. The segmenter uses observable timestamp gaps in that recording format. A separate acquisition and uninterrupted recording are needed to test transfer to a different door or capture process.
- **ACV:** the fixed model ranks case 04's labelled car second. Its first choice is car 04 while the supplied answer is car 01. The nested selection process additionally misses first choice on case 05, ranking its labelled car fourth. Six cases are insufficient to call the model reliable across arbitrary operating conditions. The 97.9167% rank-decay scale is **not** 97.9167% first-choice accuracy.
- **Rail:** aggregate exact classification is 93.38%, but it is dominated by 234 Normal recordings. Side I recall is **7/14 = 50%**, and Side II recall is **20/24 = 83.33%**. Macro F1 and per-class recall should remain visible beside aggregate counts.
- **SHM:** every refitted fold selected the fifth-power rainflow-amplitude moment. Fitted scales ranged from approximately `1.3553e-9` to `1.3659e-9`. Median relative error is **1.7849%**, while the largest held-out error is **14.0045%** on `train12.csv`; a good average does not guarantee every recording has a small error. The score is regression performance on cumulative damage, not fault-classification accuracy or a remaining-life estimate.

No source mismatch, metric discrepancy, held-out membership overlap, or declared duplicate-group leakage was detected. Unknown common acquisition dependence is not ruled out by these checks. Door, ACV and SHM fresh fitting reproduced the saved predictions; this confirms that their results can be derived by the model pipeline, rather than merely displaying stored answers.

The existing SHM estimator remains the best of its recorded candidate comparisons, and no clear implementation defect was found that warrants changing its trained artifact. ACV needs independent labelled cases more urgently than another search across the same six already inspected cases. Keep an untouched acquisition-level evaluation set when those data arrive.

## Reproduce

From the project root, using the installed environment:

```powershell
.venv\Scripts\python.exe scripts\audit_model_scores.py
```

The script writes `outputs/model-review-20260919/baseline-audit.json`. It exits unsuccessfully on mismatched metrics, changed source hashes, changed estimator bindings, invalid coverage, declared group leakage, fresh-replay differences, or a production-artifact change during execution. It reads only Train data for fitting and scoring; no Test waveform, hidden answer, API key or paid AI service is used. All replay estimators are temporary in-memory objects. Normal application inference continues to use the unchanged frozen artifacts.

The JSON includes source checksums, candidate metric arithmetic, per-case ACV answers and predictions, ACV nested results, Rail confusion matrices, SHM worst errors and fitted fold parameters. Technical behavior/unit-test counts are deliberately excluded from predictive-performance claims.

## Separate inference and export check

After the model decision was frozen, the production application processed all **86 released Test inputs** successfully: 1 Door recording, 1 ACV workbook, 68 Rail recordings and 16 SHM recordings. The exported ZIP contains the four required CSV files and **123 prediction rows**. Source hashes, model hashes, complete coverage, column schemas and exact exported values passed. Frozen models remained unchanged. See [verification.json](inference-check/verification.json). This checks the application pipeline only; the hidden answers were unavailable and no Test-accuracy score is inferred.

## Metric references

Definitions were checked against the installed organiser references from commit `16526c02579c7f37e54eaaa42a4cc6d4ceb19994`:

- `PS3/03_References/Door/Door_Subsystem_Info_Kit.md`, section 4: same-label, one-to-one greedy IoU matching and soft F1.
- `PS3/03_References/ACV/ACV_Subsystem_Info_Kit.md`, section 4: per-file linear rank-decay, averaged across cases.
- `PS3/03_References/Rail_Corrugation/Rail_Corrugation_Info_Kit.md`: three-class macro F1.
- `PS3/03_References/SHM/SHM_Info_Kit.md`, scoring section: `max(0, 1 - mean(abs(true-predicted)/abs(true)))`.
