# ACV reliability review — 17 September 2026

The ACV v2 model uses a simpler learned ranking and exposes first-choice counts separately from the organiser's partial-credit ranking score. This improves performance on the six known development cases, but does not establish trustworthy railway deployment performance.

## Available data and multiple files

The GitHub API inventory checked during this review still points to commit `16526c02579c7f37e54eaaa42a4cc6d4ceb19994`: six labelled Train workbooks and one public Test workbook. The [organiser's ACV Info Kit](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/03_References/ACV/ACV_Subsystem_Info_Kit.md) defines one output row per held-out file and averages scores across the files used for judging. This does not establish how many additional private cases the organisers may use.

The API already supported batches, but the frontend incorrectly restricted ACV selection to one workbook. The picker and drag/drop now accept several complete `.xlsx` cases together, within the existing 100-file, 64 MiB/file, 1,500 MiB/batch limits. Each workbook must contain all eight header-derived car identities and remains a separate case. Records inside one workbook must not be split into artificial independent training cases.

## Bounded model change

The original model used eight whole-case features, including median/upper-tail ranks, spread and warming. In case05, several quantile features tied while the labelled car led both direct cooling-exceedance measurements. A two-feature pairwise logistic candidate was added using only `above_peer_fraction` and `above_target_fraction`, retaining C=0.3, fold-fitted imputation/scaling and no intercept. This reduces dependence on the additional coarse or operating-regime-sensitive features. It does not establish causal attribution for an individual prediction.

No official Test inputs or hidden answers were used to select or tune this change. The two missed development cases were inspected, so results must be described as retrospective.

| Evaluation | First choice correct | Correct car in first two | Mean rank-decay |
| --- | --- | --- | --- |
| Original fixed eight-feature model, leave case out | 4/6 (66.7%) | 6/6 | 0.958333 |
| Selected two-feature model, leave case out | 5/6 (83.3%) | 6/6 | 0.979167 |
| Original four-candidate nested selection process | 4/6 (66.7%) | 5/6 | 0.916667 |
| New five-candidate nested selection process | 4/6 (66.7%) | 5/6 | 0.916667 |

The selected candidate ranks case04's labelled car second. That case has a distinct richer schema and only four cars with usable cooling measurements; the other four remain unknown. Generic temperature summaries have not resolved this ambiguity. The fixed-model improvement therefore amounts to one additional correct first choice among six cases.

The nested audit excludes the outer input group from candidate selection, preprocessing and fitting. Inner leave-group-out scores select a model by mean rank-decay, with declared candidate order breaking ties. The selected model is fitted on the remaining outer cases and predicts the excluded case. The same-case history of human development still remains; this is not an untouched external test. All nested splits and predictions are saved with the trained artifact.

An exploratory leave-two-cases-out comparison also produced 25/30 correct predictions for the new candidate versus 21/30 for the original. Those 30 predictions reuse six cases and are correlated; they are not 30 independent examples and are not the headline accuracy.

## Reliability changes

- Exact cooling-mode allowlist: Automatic Cooling, Full Cooling and Half Cooling. Text such as “Not Cooling” or “Cooling Disabled” cannot become cooling evidence through substring matching. The allowlist changes no cooling-mask rows in the six released Train cases.
- Reject non-eight-car workbooks early, consistent with the prediction export contract.
- Group identical parsed selected telemetry even if workbook compression/metadata or filenames differ. Unknown acquisition dependence and near-duplicate signals may still remain.
- Pass only training-case labels into every fold's fitter. Version the feature cache and fitted artifacts for the changed parser semantics.
- Publish correct counts, denominator and mean rank for each candidate and the selected model, plus a separate nested audit. Missing metrics in old jobs remain unavailable; saved historical reports are not rewritten.
- Provide the same distinct metrics to the evidence assistant. Its interpretations are still subject to review.

## Verification plan and reproducibility

| Area | Verification | Required evidence |
| --- | --- | --- |
| Workbook processing | Unit tests on synthetic workbook states and schemas | Negated/unknown cooling states excluded; exactly eight cars; missing measurements stay unknown |
| Validation | Nested-fold fitting spies and persisted-split audit | Training labels/cases exclude every held-out group; selected-input duplicates stay together |
| Metric arithmetic | Independent saved-prediction audit | Recomputed rank, top-one, top-two and rank-decay agree with metadata and source answers |
| Batches and exports | FastAPI tests with actual small XLSX workbooks | Independent per-file rankings, source names retained, exact CSV/ZIP, no partial failed-job export |
| Frontend | Node workflow tests, TypeScript, lint, production build and browser check | Multi-workbook selection; separate correctness/ranking/audit labels; old jobs handled safely |
| Frozen inference | Live official example after model selection is complete | No fitting, model/input hashes retained, one complete ranking per workbook |

Reproduce training with `.venv\Scripts\python.exe scripts/train_ps3.py --subsystems acv`. Training reads only Train and its label table. Run `scripts/check.ps1` with the services stopped for tests and production build, then `scripts/start.ps1 -Production`.

Exploratory comparisons and exact running-mode inventory are in `outputs/acv-research/`. The previous model is retained under `.cache/acv-improvement/baseline-artifact/`; its artifact version requires the corresponding previous inference code. Existing saved prediction jobs keep their own model snapshot and measured validation; create a new job to use the new model.

The next decisive improvement in trust requires additional labelled cases from independent acquisition runs and representative operating conditions, held untouched until evaluation. No software test count, ranking score or repeated validation on these six cases replaces that evidence.

## Completed checks

The published update passed 202 Python tests plus four subtests, 15 frontend workflow tests, TypeScript, ESLint and the production build. Browser verification uploaded two real Train workbooks in one batch and checked two separate completed reports; this was a functional test, not an accuracy measurement. A new official Test inference completed after selection was frozen. The resulting full prediction ZIP contains the new ACV output and 85 previously verified unchanged-model reports from the other three subsystems. A live OpenAI answer correctly distinguished 5/6 selected-candidate correctness from 4/6 nested selection correctness and stated that neither proves new-case accuracy. Mobile validation at 390 px had no page overflow.

The current verification record and complete export are `outputs/acv-improvement/verification.json` and `outputs/acv-improvement/predictions.zip`. The independent arithmetic/source/split audit is `data/ps3_artifacts/acv/validation_audit.json`. Services were restarted with the published model and rebuilt interface at `http://127.0.0.1:3000/ps3`.
