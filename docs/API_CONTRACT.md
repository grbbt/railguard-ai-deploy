# RailGuard API contract

Frontend: Next.js/React/Three.js, proxy `/api/*` to Python FastAPI on 127.0.0.1:8000. All ML runs in Python. The current `/` interface is the [unified recorded-data workspace](UNIFIED_WORKSPACE.md); `/ps3` redirects to `/?view=analysis`. Its predictions, saved results and exports use the [PS3 API contract](PS3_IMPLEMENTATION_CONTRACT.md), including the persisted job catalog, `latest_completed` and `active_jobs`. The optional OpenAI evidence assistant is independent of numerical inference and exports.

The routes and detector types below document the **retained earlier fleet prototype**. The unified workspace does not fetch its synthetic dashboard or use its health indicators for PS3 recordings. Prototype work orders use local SQLite; there is no PostgreSQL prerequisite. Prototype explanations identify local evidence rules and model sensitivity.

Status is `healthy | warning | critical | unknown`. Component is a string; demo uses `bogies | doors | brakes | motors`; arbitrary uploads can use `general`. Scores are indicators, not failure probabilities. Missing numerical evidence is JSON null, never NaN or invented measurements. All timestamps ISO8601.

## Retained prototype routes

- GET `/api/health` => {status, version}
- GET `/api/dashboard?dataset=demo` => Dashboard; default dataset demo, generated on first use.
- GET `/api/analysis/{dataset_id}/{train_id}/{component}` => Detail. URL encode identifiers.
- GET `/api/analysis?dataset_id=...&train_id=...&component=...` => the same Detail; use query parameters when identifiers contain `/`.
- POST `/api/datasets` multipart field `file` => Dashboard for uploaded CSV.
- GET `/api/datasets/{dataset_id}/export` => original CSV.
- GET `/api/orders?dataset_id=...` => {orders: WorkOrder[]}
- POST `/api/orders` JSON {dataset_id,train_id,component} => WorkOrder, idempotent for existing non-completed order for dataset/train/component. Backend derives priority, issue and action from actual Detail, not arbitrary client advice.
- PATCH `/api/orders/{id}` JSON {status: `open | in_progress | completed`} => WorkOrder. Changing order status must never change measured fleet health.
- Orders require an actionable warning/critical detail. Active creation and repeated same-status updates are idempotent. Transitions advance open → in_progress → completed, with open → completed allowed; backwards transitions return 409.
- Errors: non-200 with {detail:string}, no raw stack traces.

## Types (all keys required unless marked ?)

DatasetMeta = {id,name,source:`synthetic | uploaded`,rows:number,train_count:number,component_count:number,sensor_count:number,missing_pct:number,excluded_rows:number,warnings:string[],time_start:string|null,time_end:string|null,created_at:string}

ModelInfo = {algorithm:string,version:string,training_rows:number,validation_rows:number,features:string[],training_ms:number,cache_hit:boolean,threshold:number,methodology:string}

ComponentSummary = {train_id:string,component:string,status:Status,risk:number|null,health:number|null,anomaly_count:number,observations:number,onset:string|null,latest_anomaly:string|null,title:string,summary:string,top_sensor:string|null,sparkline:number[]}

TrainSummary = {id:string,name:string,line:string,status:Status,risk:number|null,health:number|null,component_count:number,anomaly_count:number,last_seen:string|null,components:ComponentSummary[],sparkline:number[]}

Evaluation = {available:boolean,context:string,models:{name:string,auc:number|null,precision:number|null,recall:number|null,f1:number|null,false_positives:number|null}[],note:string}

Dashboard = {dataset:DatasetMeta,trains:TrainSummary[],components:ComponentSummary[],trend:{timestamp:string,healthy:number,warning:number,critical:number,unknown:number}[],model:ModelInfo,evaluation:Evaluation,alerts:ComponentSummary[],totals:{healthy:number,warning:number,critical:number,unknown:number,observations:number,anomalies:number,coverage:number}}

SensorEvidence = {key:string,label:string,unit:string,latest:number|null,baseline:number|null,deviation:number|null,contribution:number,samples:number,missing_count:number}

Detail = {dataset_id:string,train_id:string,component:string,status:Status,risk:number|null,health:number|null,anomaly_count:number,observations:number,onset:string|null,last_seen:string|null,evidence_time:string|null,features:SensorEvidence[],points:{timestamp:string,score:number|null,risk:number|null,anomaly:boolean|null,split:`reference | monitoring`,values:Record<string,number|null>}[],explanation:{title:string,summary:string,possible_cause:string,recommendation:string,actions:string[],priority:`P1 | P2 | P3 | Review`,timeframe:string,evidence:string[],method:string,limitations:string[]},model:ModelInfo}

WorkOrder = {id:string,dataset_id:string,train_id:string,component:string,issue:string,priority:string,action:string,status:`open | in_progress | completed`,created_at:string,updated_at:string}

## Synthetic data producer

`backend.synthetic.generate_dataset(seed=42, scenario='mixed', periods=288) -> pandas.DataFrame`

`backend.synthetic.generate_datasets(output_dir: Path) -> dict` writes mixed fleet CSV, healthy fleet CSV, missing-data CSV, and metadata JSON describing injection schedule and sensor units. Script callable `python -m backend.synthetic --output data`.

Mixed CSV long form: timestamp, train_id, train_name, line, component, speed_kmh, ambient_temp_c, vibration_mm_s, bearing_temp_c, door_current_a, door_cycle_s, brake_pressure_bar, brake_temp_c, motor_current_a, motor_temp_c, injected_anomaly, scenario. Only applicable component sensors populated. Component bogies includes vibration/bearing temp; doors door current/cycle; brakes pressure/temp; motors current/temp. Speed and ambient are contextual numeric features. 8 trains x4 components x288 five-minute observations =9216 records. Fixed UTC start, deterministic seed. Labels only for synthetic evaluation; never model input. First 40% time windows have no injections. Mixed includes 3 strong sustained anomalies and 2 modest drifts beginning in latter 40%, across different train/components. Avoid all trains alarming. Healthy scenario has no injections. Missing scenario retains missing/invalid data cases. Raw units and generated provenance documented.

## Detection and evidence rules

Train IsolationForest per component with initial chronological 40% as reference, last60% as monitoring. No label leakage. Median imputation from reference fit only, do not fabricate displayed measurements. Cache by content hash plus detector settings. Score all valid observations; data with no sensor evidence is unknown/rejected. Severity based on recent evidence and persistence; ordinary healthy demo should mostly classify healthy. Explain selected recent strongest anomaly, or latest valid reading for healthy components; display evidence timestamp. Reference-replacement sensitivity or robust deviations are allowed, named honestly, not called SHAP. Onset = first detected monitoring anomaly (clearly observed onset, not physical fault onset). Evaluation uses monitoring synthetic injected labels, reported explicitly as synthetic benchmark only. No XGBoost for injected markers described as verified fault labels. Non-labelled uploads show unavailable evaluation.

Every demo/source claim visible in UI. Local API should bind loopback; bounded upload validation, explicit no-sensor rejection, quote parsing with pandas, no silent row cap, missing timestamp synthesis prohibited (use observation indices with explicit unknown timestamp or reject malformed timestamp input gracefully).

The implementation requires explicit timestamp values. Invalid timestamp rows are excluded with a count; timezone-naive dates are interpreted as UTC with a warning. Numeric sensors with sparse valid evidence are retained with a warning where ambiguous. At least four recent scored monitoring observations are required for a current status. A group with at least four distinct timestamps is unknown when its latest reading is older than three of its own median observed reporting intervals at the dataset endpoint. This freshness check does not use wall-clock age.

Component status uses the last 24 monitoring observations: critical requires Isolation Forest persistence ≥ 0.50 and median maximum robust sensor deviation ≥ 6; warning requires persistence ≥ 0.25 and deviation ≥ 2.5, or persistence ≥ 0.65 alone. Full indicator formula and evidence limits are in [IMPLEMENTATION.md](IMPLEMENTATION.md). Evaluation is labelled a same-generator synthetic demonstration check, not independent validation or general model quality.


## Geographic network and recorded positions

`GET /api/network` returns real cached Singapore MRT geography and source attribution. `GET /api/network/positions?dataset_id=demo` shares the dashboard dataset and returns explicitly simulated (`demo`), uploaded GPS (`telemetry`), or unavailable position provenance. Both endpoints are documented with coordinate aliases, timestamp handling and operating coverage in [NETWORK_DATA.md](NETWORK_DATA.md). No live operator vehicle-location feed is configured. Geographic coordinates are metadata excluded from anomaly detection.

The current unified workspace consumes only `/api/network` from these geographic endpoints. It shows static context and station geometry, with no recording-to-station assignment, simulated train markers or asserted fleet locations. The positions endpoint remains part of the earlier prototype API.
