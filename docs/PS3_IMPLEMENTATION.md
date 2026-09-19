# PS3 models: operating and validation notes

The unified workspace at `/` processes the organiser's four released datasets with dedicated Python models. `/ps3` redirects to `/?view=analysis`. Its six views share the selected subsystem, saved run and source file; see [the workspace guide](UNIFIED_WORKSPACE.md). The map provides static Singapore context. These recordings have no established Singapore GPS or R151 identity, so the app assigns no train markers or fleet-health counts to them.

## Use the app

1. Run `scripts/start.ps1 -Production` after setup/build. Visit `http://127.0.0.1:3000/` and open **Recordings & analysis**.
2. Select Door, ACV, Rail Corrugation or Structural Health, then select an existing saved run or start a new one.
3. Use **Try one file**, **Run all**, or upload the matching source files. Door accepts one continuous CSV; ACV accepts XLSX workbooks; Rail and SHM accept batches of CSV recordings.
4. Inspect the result, per-file evidence, signal preview, exact predictions and validation tabs. Charts are downsampled previews; models process complete inputs.
5. Open **Component view**, **Investigation** or **Model validation** for the same run/file. Investigation also supports broader Project and Selected run scope. Its source list and tool trace show what it retrieved; recent conversation is included for follow-ups, with fresh evidence retrieved per answer.
6. Download the selected run's subsystem CSV, or open **Prediction exports** to choose a saved run per subsystem and tick the recordings to include in `predictions.zip`. Select all / Clear and filename search help build a custom subset; the preview shows exact CSVs and recording/row counts. Choices stay pinned across workspace views and new analyses. **Use latest runs** explicitly resets to the latest available completed runs. **Run all** for every required subsystem and select all required files before a complete official submission: a one-file demonstration or custom subset exports only the selected files.

The app accepts at most 64 MiB per file, 100 files per job, and 1,500 MiB of file data per batch. An incoming request-body limit also bounds multipart spooling. Two background workers handle inference, with at most eight running/queued jobs per service instance. Whole jobs fail without partial prediction exports if an input is invalid. Plain safe source basenames preserve organiser file IDs.

Results, originals uploaded through the app, model snapshots and provenance hashes are retained in `data/runtime/ps3_jobs`. A new browser discovers saved jobs from the server catalog; browser links supplement that catalog. The recent list is bounded, while the latest completed job per subsystem and all active jobs are discovered across the entire valid catalog. Full reports are fetched for selections and needed candidates rather than every historical run. Completed jobs survive service restarts. Interrupted jobs require an explicit rerun. Use one local backend instance for this workspace. Local retained files are not automatically expired.

OS-held session locks distinguish active jobs from abandoned work even when another app instance inspects the same directory. Graceful shutdown stops new submissions, records queued cancellations and lets active work finish; a hard process stop is recovered on the next read/start. Model availability checks validate metadata and model hashes, cached until the files change.

ZIP export waits for the current catalog and selected completed reports to be checked; unrelated active jobs do not block it. If a selected run or file is unavailable, export pauses instead of silently changing the requested contents. Unchecking a recording only removes it from the bundle and never deletes saved results. Connection/status checks recover automatically after temporary service interruptions.

Uploaded Train files are processed by the already fitted model. Successful predictions on those files do not establish accuracy on unseen recordings. Uploads retain `uploaded` provenance; they are not relabelled as organiser Test inputs. Review the bundle's actual filenames before submitting it.

## Reproduce training

Run setup once with `scripts/setup.ps1`. It uses the pinned Python and npm dependencies. Then:

```powershell
.venv\Scripts\python.exe scripts\fetch_ps3.py
.venv\Scripts\python.exe scripts\train_ps3.py
```

The downloader retrieves approximately 6.46 GB from commit `16526c02579c7f37e54eaaa42a4cc6d4ceb19994` of the [official repository](https://github.com/aochinwen/NebulaX-Hackathon-ProblemStatement/tree/16526c02579c7f37e54eaaa42a4cc6d4ceb19994), verifies Git blob hashes and records SHA-256 hashes in `data/ps3/manifest.json`. It resumes verified downloads and never executes downloaded repository code.

Use `--subsystems door acv`, for example, with either script for a smaller run. Data lives under `data/ps3/PS3/02_Datasets`; frozen models and validation results live under `data/ps3_artifacts/<subsystem>`. Git includes the four active `model.joblib`/`metadata.json` pairs; raw datasets, feature caches and other generated artifacts remain ignored. Training uses only labelled Train inputs. Feature caches are keyed by source content. Normal app use reuses frozen artifacts; explicitly running the training command refits candidates while reusing source-keyed feature caches where supported. Prediction functions never call fit.

Selected estimators, transformations, training provenance and model hashes are saved together. A job copies the model and metadata into its own snapshot and verifies their SHA-256 binding before inference. Retraining cannot silently change a running batch's estimator or attach another model's validation results. Only locally generated model artifacts are loaded; model uploads are not accepted.

## Models and evaluation

| Task | Training material | Selected model | Measured local score |
| --- | --- | --- | --- |
| Door | One stream, 18,036 rows, 110 labelled actions | Regularized logistic regression | IoU-weighted F1 1.000000 |
| ACV | Six case workbooks, 56,993 rows | Pairwise cooling-exceedance ranking | Mean linear rank-decay 0.979167; first choice 5/6 |
| Rail | 272 recordings, 2,720,000 samples across 129 columns | Class-weighted XGBoost | Macro F1 0.785747 |
| SHM | 64 recordings, 37,191,680 scalar samples | Rainflow moment surrogate | MAPE 0.026411; competition score 0.973589 |

These are **local cross-validation results used for candidate selection**. They are not an independent outer test, official Test performance, calibrated probabilities or verified faults. Metadata includes every candidate, method, fold result and limitations; OOF predictions and independent arithmetic audits are retained beside each artifact.

- **Door:** Five contiguous held-out action blocks with fold-fitted preprocessing and end-to-end segmentation/classification scoring. Recording gaps separate candidate actions. The perfect local score comes from a small assembled stream and does not establish transfer to uninterrupted telemetry or different doors. Candidates include logistic regression, ExtraTrees, Isolation Forest and XGBoost. Source timezones and some sensor units are undocumented.
- **ACV:** Leave one whole selected-input group out, with identical parsed cases excluded together even after Excel repackaging. The selected pairwise model uses two duration-weighted fractions: cooling observations above target and above comparable peers. It is compared with the original eight-feature pairwise model, a cooling baseline, Isolation Forest and XGBoost. First-choice correctness is 5/6 (83.3%); top-two coverage is 6/6; rank-decay is 0.979167. A separate retrospective nested selection audit gives 4/6 first-choice, 5/6 top-two, rank-decay 0.916667; this evaluates selecting a candidate without the outer case, not the final fitted model. All six cases were already inspected during development, so neither measure establishes external reliability. Cars without usable measurements remain unknown and are placed in a stable administrative tail solely to meet the complete-ranking format. Raw units and per-case fault labels do not identify a physical onset. See [ACV reliability review](ACV_MODEL_REVIEW.md).
- **Rail:** Four-fold stratified grouped validation, whole recordings, 270 groups. Known exact duplicates and conservative near-identical waveform groups stay together. Candidate comparison uses side-aware amplitude/spectral features; a normal-only Isolation Forest remains a baseline. Local class F1 is Normal 0.9639, Side I 0.5600 and Side II 0.8333. **Side I recall is 7/14 = 50%**, so the aggregate score must not be described as uniformly strong fault detection. Undocumented acquisition dependence may remain.
- **SHM:** Five-fold whole-file grouped validation. The selected fifth-power rainflow-amplitude moment and fitted scale are a statistical damage surrogate learned from Train labels, not verified material S-N constants. Alternatives include median, log-linear, ExtraTrees and XGBoost regressors. These healthy-operation source signals do not label structural failure, remaining life or operational deadlines. Stress units and sampling frequency are unspecified.

The official scoring formulas and source assessment are documented in [PS3 release review](PS3_RELEASE_REVIEW.md). Hidden Test answers are unavailable. Test predictions are retained separately and are never used to select models.

## OpenAI investigation assistant

Copy `.env.example` to `.env` only if `.env` does not already exist. Edit locally:

```dotenv
OPENAI_API_KEY=your_key_here
RAILGUARD_AI_ENABLED=true
RAILGUARD_AI_MODEL=gpt-5.4-mini
```

Do not overwrite an existing key or commit `.env`. Environment variables override the local file. Configuration is reread on each request. Disable cloud reasoning with `RAILGUARD_AI_ENABLED=false`; all numerical analysis remains local. The existing Anthropic credential is not used.

The backend calls the [OpenAI Responses API with function tools](https://developers.openai.com/api/docs/guides/function-calling), `store=false`, at most six tool rounds, sixteen tool calls and two concurrent requests. Normal API charges apply. It sends the question, bounded recent conversation, selected context, retrieved project documentation/code excerpts, diagnostic summaries, sparse plot previews and validation. It does not send whole source workbooks or raw waveform files. `store=false` is a response-storage setting, not a claim of zero provider retention.

Investigation now offers **Project / Selected run / Current file** scope, bounded follow-up context, workflow starters and downloadable sourced briefs. Project tools can search allowlisted documentation, discover saved runs, compute run comparisons, inspect recording evidence and retrieve model details. The original selected-file tools remain available. File scope starts with selected evidence; broader scopes start with a project overview. Citations to unread sources are rejected. No tool can train, modify predictions, issue work orders, execute commands or browse arbitrary files. See [the investigation agent guide](INVESTIGATION_AGENT.md) for tools, scope enforcement, limits and evidence boundaries.

Measured features are descriptive evidence; no feature contributions are computed. Instructions prohibit inventing a baseline for words such as “elevated,” or claiming a feature explains the learned decision. A conservative phrase check requests one correction for common unsupported model-attribution claims, within the same time/tool budget, then falls back if the claim persists. This check does not establish factual correctness for every possible phrasing.

Missing credentials, provider errors, excessive tool use or invalid grounding produce clearly labelled local guidance or a **fixed local evidence summary** for file scope. This fallback does not claim to have answered the investigation question. Availability means configuration exists; the actual response badge distinguishes a successful agent answer from fallback. Do not send an API key in a chat question.

Authentication/model-access, rate/account-limit and timeout failures have distinct recovery messages without exposing provider error bodies or keys. The project loop checks a 75-second time budget and applies bounded per-request network timeouts. The local frontend proxy allows 90 seconds. Legacy direct file-only calls retain their previous 60-second/four-round limits.

## Tests and local operation

Stop the frontend before `scripts/check.ps1`, which runs Python tests, frontend job/export workflow tests, TypeScript, ESLint and a production build. Use `scripts/check.ps1 -SkipBuild` during development. Start with `scripts/start.ps1 -Production`; stop with `scripts/stop.ps1`. Logs are in `.logs`. Both listeners bind to loopback; the app has no public-hosting authentication layer.

Tests cover native timestamp parsing and exact metrics, workbook schema/missing data, binary pulse speed, side mapping, headerless stress signals, rainflow scaling, grouped validation, frozen inference, source/model hashes, HTTP uploads/errors, CSV/ZIP contracts, persistence, and mocked OpenAI tool/citation/error behavior. Full official Test inference and a real API response are additionally checked through the running local service.

The [PS3 API contract](PS3_IMPLEMENTATION_CONTRACT.md) documents endpoints and report schemas. The current complete verified prediction export is [predictions.zip](../outputs/model-review-20260919/inference-check/predictions.zip), with [verification.json](../outputs/model-review-20260919/inference-check/verification.json); regenerate predictions after intentionally changing trained models. This ZIP is a prediction artifact, not the complete hackathon submission package or a claim of organiser evaluation.

To rerun the complete integration check against the running app:

```powershell
.venv\Scripts\python.exe scripts\verify_ps3.py --all-files --ai
```

This processes all 86 official Test inputs, checks their SHA-256 hashes against the release manifest, verifies exact ZIP names/CSV fields/prediction values, checks the models did not change, and performs one real OpenAI investigation for each subsystem. It saves results and `predictions.zip` under `outputs/ps3-check`. Omit `--ai` for a local-only check; omit `--all-files` for a quicker one-recording-per-subsystem check. The AI option sends diagnostic summaries and incurs normal API charges. Failure returns a nonzero exit code; a local fallback is not counted as a successful AI connection test.

Historical verification of the earlier workbench on 17 September 2026 passed 184 Python tests plus four subtests, eight frontend workflow tests, TypeScript, ESLint and the production build. All 86 official Test inputs completed; all four live OpenAI investigations were checked against their retained evidence. Browser checks covered automatic reconnection, saved results, fresh Door inference, per-class Rail validation, the mobile table, the live-answer badge and four-subsystem ZIP download. Results were recorded in `outputs/ps3-check/verification.json`. These dated results describe that earlier version; rerun the checks for the unified workspace. They are not hidden-test predictive performance or railway deployment certification.
