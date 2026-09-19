# PS3 implementation contract

This is the model and HTTP contract used by the unified recorded-data workspace at `/`. `/ps3` redirects to `/?view=analysis`. Retained prototype APIs are documented separately in [API_CONTRACT.md](API_CONTRACT.md); anonymous organiser recordings are not assigned geographic train positions.

## Python subsystem interface

Modules `backend.ps3.door`, `acv`, `rail`, `shm` own their loaders, features, training, metrics and inference. Each exports:

* `train(data_dir: Path, artifact_dir: Path) -> dict`: data_dir is that subsystem's directory (Door, ACV, Rail_Corrugation, SHM); artifact_dir is its own writable directory. Fit only training inputs/labels. Save a trusted local `model.joblib` and `metadata.json`; return metadata. Validate on held-out training groups then fit the selected pipeline on all permitted training data. Test inputs never influence fitting or model selection.
* `predict(path: Path, artifact_dir: Path) -> dict`: loads frozen model; never trains. Input path has the original source basename. Returns the report shape below, JSON serializable with finite values or null. File errors raise ValueError with useful descriptions. Limit plot series to <=400 points each and evidence to useful summaries; preserve full official prediction rows.

Metadata required keys: `subsystem`, `model_name`, `trained_at` (ISO UTC), `training_files` (integer), `training_rows` (integer), `model_sha256` (SHA-256 of the saved model), `validation` with `metric`, `score` (number/null), `method`, `candidates` ([{name,score}]), `limitations` (string[]). Extra useful metadata allowed. Include feature names, folds, per-class metrics/OOF results and training source hashes when relevant. Store supporting validation outputs in artifact_dir. Save transformations together with estimator. Deterministic seeds, no random adjacent-row split, duplicate groups stay together. IF remains anomaly baseline; benchmark supervised candidates with labelled data, no winner/performance assumptions.

Prediction report required keys:

```json
{
  "subsystem": "door|acv|rail|shm",
  "file_id": "original.csv",
  "model_name": "selected model name",
  "summary": "plain-language measured result",
  "prediction_rows": [{"official": "schema fields only"}],
  "evidence": [{"id":"e1","label":"Measurement","value":1.2,"unit":"raw units","detail":"How computed","source":"filename / channel / interval"}],
  "warnings": ["dataset/model limitations"],
  "series": [{"name":"Signal","x_label":"Sample","y_label":"Raw value","points":[{"x":0,"y":1.2}]}],
  "entities": [{"id":"01","label":"Car 01","value":1,"status":"ranked","detail":"Evidence summary"}]
}
```

Evidence value can be number/string/null; unit/detail/source optional. Entities/series optional arrays. Door returns start_time/end_time/prediction per segment. ACV returns file_id/ranked_cars (pipe-separated zero-padded IDs). Rail/SHM return file_id/prediction. No fake calibrated confidence, no invented GPS or car telemetry.

## HTTP and frontend contract

* GET `/api/ps3/status`: `{subsystems:[{id,title,task,metric,available,model:null|metadata,example_files:number}], assistant:{available:boolean,provider:string|null,model:string|null,message:string}, source:{repository,commit}, limits:{file_mb:64,batch_files:100,batch_mb:1500}}`.
* GET `/api/ps3/jobs?limit=40&subsystem=acv`: `{jobs:JobSummary[],total:number,limit:number,latest_completed:JobSummary[],active_jobs:JobSummary[]}`. `limit` is an integer from 1 to 100; `subsystem` is optional and accepts `door|acv|rail|shm`. Invalid query values return 422. See catalog semantics below.
* POST `/api/ps3/jobs` multipart: `subsystem` and one or more `files`. Returns `{id}` with HTTP202. Uploaded originals stay server-side, path names validated; no model uploads.
* POST `/api/ps3/examples/{subsystem}` JSON `{all_files?:boolean}`: run bundled official test inputs using frozen models. Default one sample (Door/ACV naturally one); true runs all. Returns `{id}` HTTP202.
* GET `/api/ps3/jobs/{id}`: `{id,subsystem,status:'queued'|'running'|'completed'|'failed',progress:{completed,total,filename},created_at,finished_at?,reports:Report[],error?:string,source:'uploaded'|'organiser_test',validation?:metadata.validation}`. Reports included after completion; source reflects exactly what was processed. Jobs/results persisted locally.
* GET `/api/ps3/jobs/{id}/csv`: exact subsystem predictions CSV for every file in the completed run. Optional `?file_id=<URL-encoded retained file ID>` exports only that exact, case-sensitive report; no retraining or inference runs. Unknown file IDs return 404, empty/overlong selections return 422, and unfinished runs remain unavailable. Official columns are unchanged; current-file Door exports include every predicted action in that stream.
* POST `/api/ps3/export` accepts exactly one mode: legacy `{job_ids:string[]}` for complete runs, or `{selections:[{job_id:string,file_ids:string[]}]}` for explicitly selected recordings. Returns `application/zip` with selected `*_predictions.csv` at root and unchanged official columns. Custom selections allow 1–16 distinct completed runs, each with 1–100 distinct, exact case-sensitive retained filenames. Empty/duplicate/ambiguous requests, unfinished runs, duplicate source files across runs and multiple Door streams are rejected; missing runs/files return 404. The entire selection is validated before producing the ZIP. Export reads saved predictions without retraining or modifying source files, job status or reports. Each selected recording includes all its rows; omitted subsystems produce no CSV. The UI chooses one saved run per subsystem and shows recording/row counts before download.
* POST `/api/ps3/investigate` JSON `{scope?:'file'|'run'|'project',job_id?:string|null,file_id?:string|null,question:string,history?:[{role:'user'|'assistant',content:string}]}`. Scope defaults to `file` for existing clients; Project needs no selection, Run needs a completed job, File needs an exact report within it. Question: 3–4,000 trimmed characters; history: at most 12 messages, 12,000 characters each and 40,000 total; unknown fields/roles are rejected. Response preserves `{mode:'agent'|'local',answer,tools:[{name,label,source_id?,status?}],sources:[{id,label,location?,details?}],warning?}` and adds `scope`, `context` and optional `elapsed_ms`. Source `details` is an inert text snapshot of retrieved evidence, capped at 16,000 characters with explicit truncation. Responses use safe rendered Markdown, never raw HTML. Sources/locations are descriptive references, not arbitrary executable links. Read-only tools search allowlisted project knowledge, compare saved files and inspect evidence/model validation within enforced scope. No fitting, prediction changes, arbitrary filesystem/network access or external actions. Missing key/network errors give an explicit local fallback. Credentials stay server-side; only the configured OpenAI credential is used.

### Persisted job catalog

`JobSummary` contains only `id`, `subsystem`, `status`, `created_at`, `finished_at` (string/null), `source`, `progress:{completed,total,filename}`, `error` (safe generic failure text/null), `first_file` (basename/null), `file_count` and optional `model_name`. It contains no reports, telemetry, filesystem paths, model snapshots or owner/process fields. A legacy multi-file run may have `first_file:null` until its first completed report is available.

Only direct directories named with 32 lowercase hexadecimal characters and valid `job.json` records are considered. Linked paths and corrupt records are skipped independently. Existing owner-aware recovery handles abandoned work. Terminal summaries are cached by file fingerprint; unchanged full report payloads are not retained in the summary cache.

`jobs` is the newest-first recent window, ordered by parsed creation time. `total` counts valid matching entries before the limit. `latest_completed` selects the latest completed job per subsystem across all matching entries, including outside that window, in Door/ACV/Rail/SHM order. `active_jobs` contains all matching queued/running summaries, newest first. The optional subsystem filter applies to every array and `total`. The endpoint has no offset pagination; results outside the window remain retained and individually addressable by job ID.

### Unified interface

The six root-workspace views are `overview`, `analysis`, `twin`, `investigation`, `validation` and `exports`, selected by `/?view=...`. They share subsystem/run/file state and use the PS3 API without fetching the legacy synthetic dashboard. Catalog summaries populate history; full reports are fetched for selected analysis/export runs, latest completed candidates, active jobs and unresolved browser links. Custom export requires the current catalog check and checks for the selected completed reports to succeed; unrelated active runs do not block it. Export choices initialize once from available latest completed results, stay pinned while navigating views and are changed explicitly using run selectors, checkboxes or Use latest runs.

The map uses `/api/network` for static geographic context, without train markers. The component view uses eight-car ACV/Rail source layouts, a standalone Door mechanism and a neutral SHM schematic. Model predictions remain available without the optional assistant. Source labels distinguish organiser Test actions from uploads; validation distinguishes local development results from unavailable hidden Test scores. Predicting uploaded Train inputs does not establish independent validation. See [UNIFIED_WORKSPACE.md](UNIFIED_WORKSPACE.md).
