# RailGuard AI — NebulaX PS3

RailGuard turns railway sensor recordings into predictions, measured results, interactive charts, 3D component views and downloadable competition outputs. It covers **Door systems, ACV climate systems, Rail Corrugation and Structural Health Monitoring (SHM)**. The optional AI investigation assistant retrieves project documentation and saved findings to explain results.

The application uses **Next.js, React and Three.js** for the interface, and **Python/FastAPI, scikit-learn and XGBoost** for processing and inference. The four active trained models and their provenance are included in this repository. Raw organiser datasets, uploaded files, API keys, dependencies, build output and private runtime history are excluded.

## Run locally on Windows

Install Python 3.12+ and a supported Node.js version satisfying 20.9+ (the deployment image uses Node 22). From the cloned project folder in PowerShell:

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

Open [localhost:3000](http://127.0.0.1:3000). Upload compatible recordings to use the included models. To install the official examples and references, run `.venv\Scripts\python.exe scripts\fetch_ps3.py`; it retrieves the pinned public release (approximately 6.46 GB). Normal inference does not require retraining. See [PS3 input formats and operating instructions](docs/PS3_IMPLEMENTATION.md).

For optional AI investigation, copy `.env.example` to `.env` and configure your own server-side OpenAI API key. Predictions and exports work without it. Never commit the configured file.

## Review and deployment

- [Measured model validation and audit](outputs/model-review-20260919/model-review.md): development validation, not hidden-Test accuracy.
- [Current prediction export](outputs/model-review-20260919/inference-check/predictions.zip) and [export verification](outputs/model-review-20260919/inference-check/verification.json).
- [Unified workspace guide](docs/UNIFIED_WORKSPACE.md) and [AI investigation controls](docs/AI_SECURITY.md).
- [Ubuntu/Docker deployment guide](docs/ORACLE_DEPLOYMENT.md). The prepared application containers can run on a suitable Ubuntu VM; the provider account, networking and DNS must be configured separately. No public website has been deployed yet.

Run `.\scripts\check.ps1 -SkipBuild` for tests, type checking and lint while the app is running. Stop the app with `.\scripts\stop.ps1` before running the full `.\scripts\check.ps1` production build. Start the verified build with `.\scripts\start.ps1 -Production`.

## Original project brief and implementation history

RailGuard AI is a predictive railway fault detection dashboard for the PS3 hackathon, built solo with AI-assisted coding. It should turn railway sensor telemetry into understandable anomaly findings, component health and risk indicators, evidence-backed explanations, and maintenance recommendations.

This brief records the intended solution and implementation constraints. It does not claim that the application or its models have already been built or validated.

**Current interface — 19 September 2026:** the implemented Next.js workspace uses midnight, indigo and violet gradients with cyan controls, distinct system accents and amber model-finding highlights. **Analyse data** places upload controls at the top. **3D + AI investigation** keeps detailed component geometry and the selected recording's evidence together; **Ask AI** opens a resizable floating modal over a blurred, dimmed background. Measurements and one interactive chart follow the 3D scene, with a top-right **Signal** selector for the available traces. A component shortcut prepares a question for the user to review and send. System, run and recording controls stay visible, alongside each task's required output, official evaluation metric and submission filename. Geometry, scope and validation limits remain explicit. See the [workspace guide](docs/UNIFIED_WORKSPACE.md) and [UI design notes](docs/UI_DESIGN.md).

**Model audit — 19 September 2026:** fresh Train-only evaluations reproduced the deployed Door, ACV and SHM results; a grouped seven-candidate Rail review retained the existing XGBoost model because the additional candidates performed worse. See the [measured results and reproducible audit](outputs/model-review-20260919/model-review.md), including per-class and per-case limits. These are development-validation results, not official hidden-Test accuracy.

**Glanceable results:** an **In brief** card explains **Current file** or **All files** in the selected run, using prediction counts and recorded measurements. The scope follows you between Analyse data and 3D + AI investigation. Exact facts and measurements remain server-owned; a bounded OpenAI request adds a short review sentence, successful wording is cached, and failures leave a labelled local summary visible. The 3D model remains tied to the named recording. New investigation questions anchor at the start of their exchange; completed answers no longer scroll to the bottom or refocus the input. See [summary behavior](docs/RESULT_SUMMARIES.md).

**Submission planning:** the newer submission slide requires a GitHub URL/README, hosted prototype, 2–3 minute video, prediction output and short write-up. The [hosting and database plan](docs/SUBMISSION_HOSTING_PLAN.md) recommends a persistent server for the existing app and a staged metadata/object-storage design if multi-user access is added. Cloud resources, a public domain and a hosted deployment have not been provisioned.

**Oracle deployment preparation:** [Follow the Oracle setup guide](docs/ORACLE_DEPLOYMENT.md) for an Ubuntu A1 server, HTTPS and a password-protected shared judging workspace. The deployment package separates read-only models/examples from persistent saved runs and excludes local credentials and upload history. Cloud provisioning and Linux/ARM acceptance checks still require an actual server; PostgreSQL is optional for this initial deployment.

**AI retrieval controls:** project investigation uses allowlisted local retrieval, server-enforced read-only tools and file/run scope, untrusted-content envelopes, credential redaction, bounded context and fresh source citations. Adversarial tests cover scope expansion, role spoofing, malformed arguments and credential disclosure. See the [implemented controls and test scope](docs/AI_SECURITY.md).

## Preferred stack

Use Python, Streamlit, Pandas, NumPy, scikit-learn, Plotly, and SHAP. Keep the implementation simple and reliable for a solo build. Use XGBoost only if labelled fault data exists. Avoid React, Node, and a separate backend unless a concrete requirement makes them necessary.

## Core pipeline

Sensor telemetry upload/read → preprocessing and feature engineering → automatic model training → anomaly detection → health/risk score → AI diagnosis and explanation → maintenance recommendation → dashboard.

### Data preparation and automatic training

- Support reading or uploading sensor telemetry and automatically detect numeric sensor columns. Distinguish sensor measurements from identifiers, timestamps, and fault labels.
- Handle missing, invalid, or insufficient data gracefully and explain data limitations in the interface.
- Use Isolation Forest as the primary anomaly detector: it is simple, fast, unsupervised, and suited to the intended setting where fault labels are scarce.
- Run preprocessing and training automatically in code through `model.fit()`. The user should not manually train weights.
- Cache model training and reuse it when the relevant data and training settings have not changed.
- If labelled fault data exists, add XGBoost as a supervised fault classifier. It is conditional, not required for an unlabelled-data MVP.

### Detection, explanation, and recommendations

Python and ML should process the raw dataset, detect anomalies, and summarize the important findings. The AI/LLM reasoning layer should receive concise findings and supporting evidence, rather than huge raw datasets.

Useful evidence includes the affected train/component, relevant time range and anomaly onset, abnormal sensors and trends, anomaly score, risk level, and available baseline comparisons. The reasoning layer uses this evidence to explain a possible cause and recommend maintenance actions.

Keep anomaly scores and any heuristic health/risk scores clearly described; do not present them as calibrated failure probabilities. Treat diagnoses as possible or likely causes supported by evidence, not confirmed faults. Use SHAP where supported and appropriate for sensor attribution, and clearly identify any other explanation method used.

## Dashboard screens

| Screen | Required content |
| --- | --- |
| Fleet Overview | Overall fleet health; healthy, warning, and critical counts; train/component table. |
| Train Analysis | Selectable train and component; sensor time-series plots highlighting detected anomalies and anomaly onset. |
| Digital Twin / Component View | A clear component view showing health for doors, bogies, brakes, and motors. |
| AI Explanation | Anomaly score, risk level, top contributing sensors, supporting explanations, and model comparison when models and evaluation evidence are available. Show unavailable comparisons honestly. |
| Maintenance Advisory | Possible issue, priority, recommended timeframe, supporting evidence, and recommended actions. |

An optional AI Diagnostic Assistant/chat panel can answer engineer questions such as “Why is this train critical?” and “What action should we take?” Responses should be grounded in the selected train's actual findings and available evidence.

## Interface and implementation constraints

- Use a professional dark interface with green for healthy, amber for warning, and red for critical. Include readable status labels alongside color.
- Keep code modular, separating data preparation, model training/detection, scoring, explanations/advisories, and dashboard presentation.
- Preserve working functionality and make the smallest changes needed for each task.
- Never fabricate accuracy, confidence, or model performance. Report only measured results with their evaluation context; otherwise say that the result is unavailable or not evaluated.
- Do not invent sensor readings, thresholds, anomaly onset times, diagnoses, or maintenance evidence to fill missing information.

## MVP and presentation

Complete the end-to-end MVP and its five dashboard screens before advanced models such as LSTM or autoencoders. Keep optional chat and conditional supervised classification from blocking the core workflow.

The presentation story is: **sensor data → anomaly → likely cause → risk → recommended intervention**.

The MVP should demonstrate automatic training, anomaly detection, interpretable health/risk indicators, evidence-backed explanations, and maintenance advice while handling missing data clearly. Any sample or synthetic data used in a demo must be identified as such.

## Context source

Saved from the user's RailGuard AI / PS3 instructions on 13 September 2026, continuing the ChatGPT conversation “Hackathon overview.” Future changes should follow the user's current instructions while preserving this brief as the project baseline.

## Unified workspace and quickstart — updated 19 September 2026

The current app opens one recorded-data workspace at `/`, with five connected views: **Overview**, **Analyse data**, **3D + AI investigation**, **Model performance**, and **Export results**. The selected subsystem, saved run and source file follow you between views. Earlier `/ps3` bookmarks redirect to `/?view=analysis`, and `/?view=twin` opens the combined `/?view=investigation` view. Upload controls are visible at the top of Analyse data; results lead into the component, measurements, selected signal and exact prediction records. The floating **Ask AI** launcher opens the assistant from any view and hides while the window is open. The background is blurred, dimmed, inert and scroll-locked until you close the window. Use its header **Close**, Escape or the backdrop to dismiss it; then use **Ask AI** to reopen it. Drafts, window size and any request already running remain intact while the workspace stays mounted. Drag any edge or corner to resize, or use the header **Maximise / Restore** control. The composer stays at the bottom.

Next.js, React and Three.js provide the requested map and component interface; all data processing and ML remain in Python/FastAPI. The server discovers persisted PS3 results for a new browser, including the latest completed run for each subsystem. The expandable map shows static Singapore geography on a grayscale basemap with coloured rail lines, without assigning anonymous recordings to train markers or inventing fleet health. Component views use eight-car ACV/Rail layouts, detailed batched Door and SHM assemblies, and refined cooling equipment over a continuous studio gradient. All geometry is illustrative. Shared responsive charts retain source units and provide a keyboard-operable point inspector. **Continuous** display uses solid measured runs and subdued dashed visual bridges across source gaps; **Preserve gaps** removes those bridges. Neither option fills measurements, changes statistics or modifies model input. New Door analyses can return all eight supported channels; new ACV analyses add cooling-target and residual previews. Existing saved reports keep their original evidence. See the [unified workspace guide](docs/UNIFIED_WORKSPACE.md) for selection, provenance, saved history and export behavior. The original brief above remains preserved as the project baseline.

From this folder in PowerShell, run setup once, then start:

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

With dependencies already installed, **`.\scripts\start.ps1` is the only launch command**. Open [RailGuard at localhost:3000](http://127.0.0.1:3000). Both services run in hidden background processes with logs in `.logs`.

For a presentation, stop development, run `.\scripts\check.ps1` to test and build, then launch **`.\scripts\start.ps1 -Production`**. This serves the existing production frontend build at the same URL; the default launch command remains development mode.

Prerequisites: Python 3.12+ and Node.js 20.9+. Setup uses the tested `requirements-lock.txt` and `frontend/package-lock.json`. Stop with `.\scripts\stop.ps1`; run `.\scripts\check.ps1` with the development frontend stopped to execute the tests, TypeScript check, lint and production build. If script execution is blocked, use `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1` without changing the machine-wide policy.

### Earlier prototype (historical)

The 14 September prototype used five screens, automatically trained Isolation Forest detectors, labelled synthetic fleet examples and local work orders. Its same-generator metrics were a demonstration check, not independent railway validation. Its uploaded datasets/models were held in memory, while orders persisted in `data/runtime/work_orders.sqlite3`. **That in-memory limitation does not apply to the current PS3 saved-job library**, which retains results and uploaded originals across service restarts.


The earlier map supported simulated train markers and compatible uploaded GPS; its R151-inspired inspector used a six-car illustration. These historical demo behaviors are not the current anonymous-recording workspace. Background and retained prototype APIs remain documented in [the earlier implementation notes](docs/IMPLEMENTATION.md), [API contract](docs/API_CONTRACT.md), [network provenance](docs/NETWORK_DATA.md), [rolling-stock notes](docs/ROLLING_STOCK.md) and [synthetic-data provenance](data/metadata.json).

## Official PS3 release reviewed — 17 September 2026

The released PS3 tasks are Door segmentation/classification, ACV car ranking, Rail Corrugation classification, and SHM damage regression. Training labels and unlabelled test inputs are now available. See [the dataset assessment and integration requirements](docs/PS3_RELEASE_REVIEW.md) for the pinned source, inspected data, scoring, validation risks and submission formats.

The released data does not establish live Singapore train locations or R151 identity; ACV and Rail describe eight-car source trains. The unified workspace presents those source layouts alongside geographic context without asserting that they are Singapore fleet assets.

## Released-data models

Open [Analyse data](http://127.0.0.1:3000/?view=analysis) in the unified workspace. It supports all four released tasks with dedicated Python loaders, frozen trained models, evidence charts, measured local validation, official Test examples, uploaded files, and exact CSV/ZIP exports.

| Task | Selected model | Local model-selection validation |
| --- | --- | --- |
| Door | Regularized logistic regression | IoU-weighted F1: 1.0000, five contiguous action blocks |
| ACV | Pairwise cooling-exceedance ranking | Rank-decay: 0.9792; first choice 5/6, six held-out cases |
| Rail | Class-weighted XGBoost | Macro F1: 0.7857, four grouped folds |
| SHM | Fitted rainflow-moment surrogate | 1 − MAPE: 0.9736, five grouped folds |

These scores selected the models; **they are not official hidden-test scores or deployment accuracy**. Rail Side I recall is only 50% in local validation. Source acquisition groups are incompletely documented. All limitations and candidate comparisons are retained in the app and model metadata.

Uploading Train files runs inference with a model already fitted on that development material. Correct Train predictions are **not independent validation**. Uploaded jobs remain labelled as uploads, and saved runs retain the validation attached to their own model version.

ACV also shows a separate retrospective nested model-selection audit: first choice 4/6, top two 5/6, rank-decay 0.9167. The simpler candidate improves the already inspected development-case result, but the stricter selection audit does not show an improvement over the original selection process. Multiple complete ACV workbooks can be uploaded together; each produces its own ranking. See [ACV reliability review](docs/ACV_MODEL_REVIEW.md) for the comparison and remaining limits.

To reproduce the data and models after setup:

```powershell
.venv\Scripts\python.exe scripts\fetch_ps3.py
.venv\Scripts\python.exe scripts\train_ps3.py
.\scripts\start.ps1 -Production
```

The pinned release download is about 6.46 GB. If there is no production build yet, run `.\scripts\check.ps1` before starting. Existing frozen artifacts are reused during normal app use; uploads and Test inputs never retrain them.

The optional project investigation agent uses the **OpenAI Responses API** with read-only tools for project documentation, saved-run comparisons, recording evidence and model validation. Choose Project, Selected run or Current file scope, ask follow-up questions and download a sourced brief. Configure `OPENAI_API_KEY` in the ignored project `.env` file and set `RAILGUARD_AI_ENABLED=true`; configuration is read without restarting. Never put the key in frontend code or chat. Without a usable AI connection, predictions and exports still work and the assistant explicitly returns local guidance or a fixed selected-file evidence summary. See [the investigation agent guide](docs/INVESTIGATION_AGENT.md) for capabilities, data sent, scope and limits.

See [PS3 operating instructions, architecture and validation limits](docs/PS3_IMPLEMENTATION.md) and [the PS3 API contract](docs/PS3_IMPLEMENTATION_CONTRACT.md).
