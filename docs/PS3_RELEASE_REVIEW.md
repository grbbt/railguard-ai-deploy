# PS3 released datasets: review and implementation implications

Reviewed 17 September 2026. This is a dataset assessment, not a training result. No released-data model was fitted and no application behavior was changed during this review.

## Source and scope

Source: [organiser repository](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement), pinned to commit [`16526c02579c7f37e54eaaa42a4cc6d4ceb19994`](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/commit/16526c02579c7f37e54eaaa42a4cc6d4ceb19994), committed 17 September 2026 at 07:59:44 UTC. The complete GitHub tree was inventoried; the PS3 dataset directory contains **433 files totalling 6,455,856,430 bytes (6.456 GB)**, including four label tables.

Read the main specification, all four subsystem Info Kits, Door header reference and all example submission files. Inspected every training label table. Downloaded and inspected all Door and ACV inputs, three Rail training recordings (one per class) and one Rail test input, plus two SHM training recordings and one SHM test input. This is a full inventory with selective signal-file inspection, not an audit of all 6.456 GB of signal values. The selected download manifest covers 18 files / 134,399,258 bytes; additional small reference and label files were saved separately. Downloaded signal files were checked against the repository's Git blob hashes and recorded with SHA-256 checksums.

Raw downloads, source notes, scripts and intermediate profiles are in `.cache/ps3-release/`. No external repository code was executed. Inspecting test formats did not include inferring hidden answers or tuning a model on test labels.

## What PS3 actually asks us to solve

The released [specification](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/01_Problem_Statement_3_Specifications.md) defines four independent tasks. Teams can attempt one or several; each contributes 25% of the Overall Score. The separate Average Score averages only attempted subsystems.

| Subsystem | Released training data | Released test inputs | Output and official metric |
|---|---|---|---|
| Door | One continuous CSV; 110 labelled action segments: 80 Normal, 30 Abnormal resistance | One continuous CSV | Find segment boundaries and classify each action; **IoU-weighted F1** |
| ACV | Six labelled Excel case files, eight cars per case; exactly one faulty car per case | One Excel case file | Rank every car for refrigerant leakage; **linear rank-decay score** |
| Rail Corrugation | 272 labelled recordings: 234 Normal, 14 Side I, 24 Side II | 68 recordings | One of three classes per file; **macro F1** |
| SHM | 64 stress recordings with numeric damage targets | 16 recordings | One cumulative-fatigue-damage estimate per file; **max(0, 1 − MAPE)** |

Training annotations exist. The organisers retain the test answers, so our future local validation results must be distinguished from official test performance. Example prediction files are illustrative placeholders, not answers.

## Findings from the actual files

### Door

Source: [Door Info Kit](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/03_References/Door/Door_Subsystem_Info_Kit.md).

- `Train.csv`: **18,036 rows × 17 columns**. `Test.csv`: **6,253 × 17**. Neither contains missing cells or duplicate timestamps; both are chronologically ordered within their own stream.
- The first column is `Datetime`, with seven integer fields: year-month-day-hour-minute-second-millisecond. Example: `2023-7-5-0-0-0-20` means 20 milliseconds, not a decimal fraction interpreted by guesswork. The source does not specify a timezone.
- Remaining fields cover current, voltage, back-EMF, configured opening/closing times, commands, switches, state flags and leaf position. Current units are mA; voltage values are in 10 mV units; opening/closing time values use 0.1 seconds. Back-EMF and position units are not established.
- Training timestamps span `2023-07-05 00:00:00` to `01:10:17.112`. Within each labelled action, readings are 20 ms apart. There are 109 larger gaps, 10.215–58.823 seconds, between the 110 labelled actions. Every labelled boundary is present; all annotation row counts match; every row belongs to exactly one segment.
- There are 55 Open and 55 Close actions, each with 40 Normal and 15 Abnormal resistance labels. An action is one opening **or** closing; do not merge paired actions into a single output segment.
- `Door Locked` is constant in both streams. Car Type, Car Number and Door Number fields listed in the separate general header reference are absent from the actual 17-column files. Do not manufacture asset identities from them.
- The observed gap structure is a promising segmentation baseline, not a demonstrated general-purpose detector. No identical signal-only gap blocks were found across the two streams in this review.

### ACV

Source: [ACV Info Kit](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/03_References/ACV/ACV_Subsystem_Info_Kit.md).

- Each workbook has one sheet. Car identifiers must remain strings `01`–`08`.
- All seven workbooks were scanned completely: **66,075 rows and 13,688,017 data cells**. Rows by file: case 01 = 6,999; case 02 = 9,187; case 03 = 8,310; case 04 = 22,262; case 05 = 6,972; case 06 = 3,263; Test = 9,082. All six training labels match their file and header-derived car IDs.
- Cases 01/02/03 and Test have 67 columns: three identifiers and eight parameters per car. Cases 05/06 use a different outside-temperature parameter name. Case 04 has **483 columns**, with a richer and heterogeneous parameter set; a fixed 67-column loader will fail.
- Every file has valid, unique, increasing timestamps, with gaps. Case 04 has a modal interval of **10 seconds**, despite the kit's general 30-second description; the other six files have a modal interval of 30 seconds. Use each file's recorded timing for derived features.
- Literal categorical values include `None` and `Invalid`. Preserve source state meanings before numeric conversion; indiscriminate numeric coercion or default missing-string handling can erase relevant information.
- There are no physically blank cells, but that does not imply complete measurements: **50.93% of case 04's telemetry cells contain the literal `None`**. Cars 05–08 in that case have no numeric temperature/pressure values. In cases 05/06, outside-temperature fields for cars 02–07 contain only `Invalid`/`None`; only end-car outside sensors have numeric readings. Missing evidence must not turn into a healthy-car finding.
- There are **six labelled case files**; independence between cases is unverified. Timestamp rows are not additional labelled cases. Cars and times within one case belong together during validation, and known shared acquisition groups should remain together too.
- The labels identify a faulty car per case, not a fault-onset time or which individual readings are faulty. Temporal fault annotations must not be inferred from the case label alone.
- Temperature scaling and detailed control/validity code definitions are not supplied in the Info Kit. Do not label raw values as calibrated degrees or invent refrigerant-pressure evidence.
- In case 04, `Observation Area Temperature Detected Value` for cars 02/03/04 is always **−50 when numeric**, otherwise `None`. This is a possible unavailable/not-applicable sentinel, not a confirmed physical temperature or diagnosed fault. Pressure channels occur in the richer case but have no documented unit; numeric state/command columns must also be distinguished from continuous measurements.

### Rail Corrugation

Source: [Rail Info Kit](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/03_References/Rail_Corrugation/Rail_Corrugation_Info_Kit.md).

- All four inspected recordings have **10,000 rows × 129 columns**, no missing/nonfinite values, and no timestamp field. The kit defines a one-second recording at 10,000 Hz.
- Column 1, `Rotating speed`, is a **binary tooth-sensor waveform**, not an already-converted speed. The source specifies a 90-tooth wheel and 0.85 m diameter. A speed calculation must state and verify whether it counts rising edges or both transitions.
- The remaining 128 columns are vibration/shock pairs for eight axle-box positions on each of eight cars, in m/s². Odd positions are Side I; even positions are Side II. Keep this spatial mapping through feature extraction.
- All 272 training filenames have exactly one label. The release contains two exact duplicate Normal recording pairs, established by identical repository blob hashes: **Train107 = Train115**, **Train165 = Train187**. Group duplicates together in validation. No exact whole-file train/test duplicates appear in the complete repository inventory; near-duplicate recordings were not comprehensively audited.
- Training signal files total approximately 4.708 GB, and test signal files 1.177 GB. Stream/cache compact per-file features instead of repeatedly loading the entire collection into the web request process.

### Structural Health Monitoring (SHM)

Source: [SHM Info Kit](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/blob/16526c02579c7f37e54eaaa42a4cc6d4ceb19994/PS3/03_References/SHM/SHM_Info_Kit.md).

- Each of the three inspected files is **headerless**, with **581,120 numeric samples in one column**. Read with `header=None`; the first numeric line is a real sample. Repeated scalar values are legitimate waveform observations, not rows to deduplicate.
- No timestamp or physical sampling frequency is provided in those files. The kit does not establish stress units or recording duration. Use sample index in plots until timing is documented.
- All 64 training files have one finite positive target; target range **0.028620288–0.928338975**. There are no missing training-label joins.
- The kit describes measured rail-vehicle signals from two unspecified lines, under AW0/AW4 loads, all in **healthy operating conditions**. The target is cumulative fatigue damage; it is not a structural-fault label, a failure probability or remaining useful life.
- The source explains Miner damage and rainflow counting but omits material S–N constants and sufficient details to reproduce the exact reference calculation. File numbers are random identifiers, not chronology or predictors.

## Training and validation approach to implement next

Keep Isolation Forest as the primary generic anomaly detector and an explicit comparison baseline. Add task-specific models where the released labels support the required outputs; an anomaly score alone cannot solve a regression or correctly format a ranked/segmented prediction.

| Subsystem | Initial modelling approach | Validation unit |
|---|---|---|
| Door | Infer complete actions, extract current/voltage/back-EMF/position and duration features; compare normal-cycle Isolation Forest with regularized classification and a small tree model. | Hold out complete contiguous stream blocks; measure segmentation **and** classification end to end. Never split rows of one action across folds. |
| ACV | Validity- and operating-mode-aware cooling response and peer-car deviation features; start with a transparent ranking baseline. | Leave one whole case out, six folds; publish ranks per case and aggregate rank-decay score. |
| Rail | Channel/side-aware amplitude and spectral features, speed context, class-balanced classifiers; compare with normal-reference anomaly baselines. | Stratified whole-file validation, grouping exact/near duplicates and known shared acquisition runs. Only 14 Side I examples constrain model complexity. |
| SHM | Stress-range/rainflow summaries plus compact regression; benchmark constant and regularized alternatives before complex models. | Whole-file validation; group by source line/load/run only when those identities are available. Report relative error and the MAPE-derived score. |

XGBoost is now a permissible candidate for labelled classification, not an assumed winner. Any preprocessing, feature selection and tuning belongs inside training folds. Keep organiser Test files out of fitting/model selection; freeze the selected pipeline before app inference. Report limitations from the small number of labelled cases and uncertain acquisition independence, not invented confidence.

Official formulas: Door greedily matches same-label positive-IoU pairs, one-to-one, highest IoU first, then scores `2 × sum(matched IoU) / (true segment count + predicted segment count)`. ACV scores `(n − r + 1) / n` for the true car's one-based rank `r` among `n` cars, then averages cases; a missing faulty car or missing case row scores zero. Rail averages the three class-specific F1 values without frequency weighting. SHM computes fractional MAPE first and then `max(0, 1 − MAPE)`; it does not clamp each individual file error first.

## What must change in RailGuard

Current implementation review covered `backend/detector.py` and `docs/IMPLEMENTATION.md`. A read-only parser check against actual Door, Rail and SHM training files rejected all three: Door's native timestamp cannot be parsed by the generic parser; Rail/SHM have no timestamp field. ACV Excel is outside the current CSV upload contract.

1. Add a subsystem selector and dedicated CSV/Excel loaders, with label joins, unit metadata, relative sample indices and actionable format errors.
   The current frontend/backend limit is 20 MiB, while ACV case 04 is 33,803,423 bytes (about 32.24 MiB). Support that workbook and batch processing explicitly; arbitrary splitting would break case-level inference.
2. Separate model training/validation from test inference. Current uploads refit an Isolation Forest using the first 40% of component timestamps; that behavior must not run on official Test inputs. Persist frozen pipeline artifacts and source/feature versions.
3. Add measured local validation and the exact official metrics. Uploaded label tables currently do not activate evaluation, and the existing point-anomaly model does not produce the four required outputs.
4. Add file batches and exact prediction/ZIP export. Retain the glass interface while giving each subsystem its own evidence view: Door action timeline, ACV eight-car ranking, Rail side evidence, SHM waveform and damage estimate.
5. Preserve the geographic map and R151 illustration as clearly identified context. These files do **not** establish Singapore GPS locations, live MRT positions or six-car R151 telemetry. ACV/Rail explicitly use eight-car layouts. Do not transfer anonymous file results onto a named Singapore train or invent car-level evidence.

## Submission requirements and documentation issues

The current main specification requires **one working app, a demo video of at most three minutes, and `predictions.zip`**. The app must accept subsystem data, display results and download predictions. Use that app to generate submitted predictions. The registered team folder contains the app, video and the separate predictions ZIP. Inside the ZIP, put the attempted prediction CSVs directly at the root:

| Filename | Exact columns |
|---|---|
| `door_predictions.csv` | `start_time,end_time,prediction` |
| `acv_predictions.csv` | `file_id,ranked_cars` |
| `rail_predictions.csv` | `file_id,prediction` |
| `shm_predictions.csv` | `file_id,prediction` |

Preserve filename case/extensions and two-digit ACV car IDs; ACV rankings must include every car, pipe-separated. Do not submit raw datasets or example placeholders.

There are stale paragraphs in the release. All four kits still describe a compulsory `predict.py`/CLI contract, while the current main specification makes development code/models/write-ups optional. Follow the current main Deliverables section for planning and confirm the contradiction with organisers before final submission. Rail's scoring prose contains outdated class counts and an incorrect always-Normal F1 example; use the actual labels and stated macro-F1 definition. Door references a missing header PDF, but a Markdown version is supplied. The named `judge_leaderboard.py` is absent from the complete repository tree, so exact validator edge cases are not verified.

Useful organiser clarifications: ACV temperature/control/validity encodings; SHM stress units, sampling frequency and reference-calculation details; acquisition-run grouping metadata; and the stale submission wording. These uncertainties do not justify inventing measurements or delaying the supported baseline work once implementation is requested.
