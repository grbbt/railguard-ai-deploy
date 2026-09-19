# Unified recorded-data workspace

The app opens at `/`. Existing `/ps3` bookmarks redirect to `/?view=analysis`; `/?view=twin` opens the combined `/?view=investigation` view. The same Python PS3 models, retained reports, evidence assistant and prediction exports share one interface; the earlier synthetic fleet prototype is historical context.

Start with `scripts/start.ps1` after setup, or `scripts/start.ps1 -Production` after a production build. Open `http://127.0.0.1:3000/`. [Operating and model notes](PS3_IMPLEMENTATION.md) cover installation, training, limits and the optional OpenAI connection.

Dated verification sections below describe earlier completed checks. They do not claim that the current resizable modal AI window or single-chart refinement has already passed those same checks.

## Five connected views

| View | URL | Purpose |
| --- | --- | --- |
| Overview | `/` or `/?view=overview` | Choose one of four systems, resume a saved analysis, or expand the Singapore network map. |
| Analyse data | `/?view=analysis` | Upload recordings or run official Test examples using the visible top panel. Review the file result, then its component and supporting evidence. |
| 3D + AI investigation | `/?view=investigation` | Inspect the selected component, measurements and chosen signal. Open the floating agent with Ask AI; use Project / Selected run / Current file scope or prepare a question from the selected component. |
| Model performance | `/?view=validation` | Inspect the saved model's validation, candidate comparisons and limitations. |
| Export results | `/?view=exports` | Choose a saved run and individual recordings per subsystem, preview the contents and download a CSV bundle. |

The controller keeps one subsystem, one selected run per subsystem and one source-file selection per run while navigating between views. A new upload selects its resulting run. Export choices are independent: opening an older run for inspection or completing a new analysis does not replace the chosen export files. Selections last while navigating the workspace; refreshing the page resets them, while saved reports persist on disk. Investigation retains a bounded conversation in browser session storage and includes recent turns for follow-ups. Each answer retrieves sources within the current scope rather than treating earlier answers as evidence. See [the investigation agent guide](INVESTIGATION_AGENT.md).

The combined investigation workspace keeps one selected recording across the 3D scene and agent. Measurements and a single selected-signal chart sit directly below the scene. **Ask AI** opens a floating modal window on the right from any workspace view. While it is open, the background is blurred, dimmed, inert and scroll-locked, and keyboard focus stays inside the window. Its composer stays at the bottom, while context scopes, selected-component questions, conversation and sources remain accessible. The floating launcher hides until the window closes. Use the header **Close** button, Escape or a click on the backdrop to hide the window and return focus to its opener when available; use **Ask AI** to reopen it. The mounted window preserves its draft, chosen size and any request already running.

Drag any of the four edges or four corners to resize the window. The four edge handles are also keyboard buttons: focus a handle and use its horizontal or vertical arrow keys for 16-pixel changes, or hold Shift for 48-pixel changes. The normal minimum is 340 × 360 pixels, reduced when necessary to fit a smaller viewport; the window keeps 12-pixel screen margins. The header **Maximise / Restore** control switches between the available screen area and the previous size. Size is retained across closing and reopening while the workspace remains mounted.

The component shortcut prepares a current-file question containing the selected component's context. It does not send a request automatically: the user can edit the question before sending it. Project questions remain available without a completed run. The agent no longer occupies an inline column or a section below the 3D evidence.

The shared palette uses midnight, indigo and violet gradients with cyan controls and readable glass annotations. System identity accents are decorative; amber marks supported model findings, not verified fault severity. The 3D background is a continuous studio gradient with contact shadows and no opaque gray floor edge.

## Saved results and exports

`data/runtime/ps3_jobs/<id>/job.json` retains each job's status, reports, source, model information and validation. Uploaded originals and frozen model snapshots live beside that record. A new browser discovers results through `GET /api/ps3/jobs`; browser-saved links supplement the server catalog. A restart does not retrain or discard completed results.

The catalog returns the newest 40 summaries by default, plus the latest completed result for each subsystem and all active jobs across valid saved history. Thus a subsystem's latest result remains available even when it is older than the recent-history window. Older runs outside that window remain on disk; this is not a paginated full-history browser. An explicitly selected loaded run stays in the selector when it leaves the recent window.

History rows use small summaries. Full reports are requested for selections, export candidates, active jobs and unresolved browser links. The interface checks catalog and model status periodically and polls running jobs. Abandoned jobs become failed after their owner stops; users explicitly rerun them. Removing an unavailable browser link does not delete retained server files.

The ZIP contains **only the recordings explicitly selected in Export results**. On first opening, the builder selects files from the latest available completed run per subsystem. Choose another saved run using its dropdown, then tick the desired recordings; changing runs starts with no files selected. Select all / Clear work globally or within a subsystem. Search narrows the visible list; Select shown / Clear shown affect that list, while hidden selections remain included. Removing a checkmark never deletes saved results.

The preview lists the exact CSV filenames, recording counts and prediction-row counts. Every selected recording contributes all its prediction rows, including every detected Door action; subsystems without selections are omitted. Export waits for the current catalog and selected completed reports to be checked. Invalid or unavailable selected files block download instead of silently expanding or dropping the selection. Unrelated active runs do not block a checked selection. New results leave the chosen runs and files pinned; **Use latest runs** explicitly replaces them with the newest available completed results.

Use **Run all** on every required subsystem for the organiser's complete Test set, choose those completed runs and select all required files before an official submission. A custom subset is intentionally incomplete. Predictions preserve exact official CSV schemas and do not include verified hidden Test answers.

## Selected export verification — 18 September 2026

- The complete check script passed 376 Python tests and 84 frontend tests, TypeScript, ESLint and the production build. Python emitted two existing dependency deprecation warnings.
- A real subset through the frontend proxy exported exactly two ACV recordings, three Rail recordings and one SHM recording. CSV columns and every value matched the selected retained report rows; the omitted Door CSV was absent. A separate one-recording Door ZIP preserved all 38 action rows. Retained jobs were unchanged after both exports.
- Browser checks covered initial selection, individual checkboxes, clear/select all, search with hidden selections, clearing only shown files, changing to an older run, preserving choices across workspace views, and successful export response. The screen was inspected at the normal desktop viewport and 390 × 844 mobile size; no browser console errors were observed.

## Compare predictions within a run

Open **Analyse data → Result** and choose **Current file** or **All files**. Upload and system controls are visible at the top, followed by the selected run and recording, required PS3 output, metric and filename. Current file leads with the model result and a concise output definition. An interactive 3D finding follows, then all selected measurements, sources and one chart with a **Signal** dropdown. **Supporting evidence** and the combined **3D + AI investigation** view use the same recording. **Prediction records** is a visible, scrollable table with pagination for every returned row. All files compares every report in the selected run, not historical runs or different subsystems combined.

- ACV shows the eight source-car IDs in rank order and marks cars whose retained report says cooling evidence is unavailable.
- Rail shows predicted Normal / Side I / Side II classes, with class counts and filtering.
- Door compares normal, abnormal-resistance and total candidate action counts. A one-file run is explicitly identified.
- SHM shows damage estimates and numeric sorting. Bars share a scale relative to the largest estimate in the run; recording length and loading affect the value, and the bars imply no safety threshold.

Search filenames or result text, filter results or review notes, sort, and page through the comparison. The summary always describes the complete selected run. **Evidence** on a row selects that recording throughout the workspace and opens its supporting measurements. Comparisons show predictions, not correctness against hidden answers, and matching car IDs across files do not establish the same physical train.

**Download current CSV** exports just the selected recording; **Download all CSV** exports the selected run. Search, table filters and pagination do not trim the all-file export. Both preserve the official submission schema. The Evidence tab downloads the current file; the Validation tab downloads the selected run. For a custom subset or multiple subsystems, use the **Export results** file picker.

## Geographic context and component evidence

The overview offers an expandable static Singapore network map. Satellite imagery and OneMap Night appear in grayscale with source attribution and layer controls; rail lines retain their identifying colours. Station dots represent geography. The workspace does not request the earlier demo's train-position endpoint, assign recordings to stations, or display fabricated train markers, live occupancy or fleet-health percentages. External basemap tiles need network access; local recordings and inference remain separate. See [network provenance](NETWORK_DATA.md) for the underlying geography and its approximation limits.

| Subsystem | Component view | Interpretation limit |
| --- | --- | --- |
| ACV | Cooling view opens around the priority car with lifted illustrative roof units, fan guards, condenser fins, casing seams and mounting details; car and eight-car layouts remain available. | Ranking is not a leak probability or confirmed fault, and does not identify a particular unit. Cars without usable evidence stay unavailable, even when the export requires a complete ranking. |
| Rail | Detailed steel rails, concrete sleepers, fasteners and ballast form the paired-rail view, with an amber overlay on the predicted side; car layout contains 64 axle-box positions across eight cars. | Individual markers show sensor layout, not diagnosed axle or bearing faults. Changing cars and returning to the rail view preserve the selected side. Example traces retain their actual scope. |
| Door | Detailed illustrative door mechanism with sealed leaves, glazing, guides, rollers, belt drive and motor; detected-action selector and Review first list for every flagged action. | Highlight applies to the action, not a diagnosed internal part. No invented car identity or measured-motion replay. Returned trace previews cover the recording. |
| SHM | Neutral structural test assembly with I-section members, bracing, bolted connections, supports and deck panels; recording-level evidence remains below. | Cumulative damage is an estimate for the complete recording, not localized damage, a damage percentage or remaining useful life. |

Geometry is illustrative and has no verified R151 or Singapore fleet identity. Camera controls, textual selection buttons and an accessible diagram fallback keep available evidence usable when WebGL is unavailable. Missing readings stay missing; they are not filled with invented measurements.

## Signal charts and PS3 data

Both Analyse data and the combined investigation use the same responsive chart component. Each 3D evidence section displays **one chart at a time**, including the scene embedded in Analyse data. Its top-right **Signal** dropdown lists the returned traces and shows the selected index and total, such as `2 / 8`. The chosen signal type is retained when changing ACV cars or Rail sides where a matching trace exists; a suitable available trace is shown otherwise. This avoids a long stack of charts without hiding the available choices.

Axes retain source labels and units, and a pointer or keyboard-operated slider inspects only retained measurements. **Continuous** is the default display: solid lines show measured runs, while subdued dashed bridges join endpoints across missing/masked readings or recording breaks for visual continuity. **Preserve gaps** removes those bridges. These are display choices only: no missing readings are estimated or inserted, and preview statistics, evidence, model data and predictions are unchanged. Controller commands and states use step lines within measured runs. Preview minimum, maximum and mean describe only retained points; complete-recording measurements remain in the evidence cards.

| Task | Visible measurements and chart interpretation | Required result |
| --- | --- | --- |
| Door | Motor current, voltage, back-EMF, leaf position, open/close commands and opening/closing states. Horizontal axis is seconds from recording start. Current uses mA; voltage retains source 10 mV units; other calibration is not invented. | Candidate action start/end times and normal/abnormal-resistance class. One input row is a reading, not an action. |
| ACV | Per-car cabin measurement, cooling target, cabin-minus-target residual and residual above cooling peers. Horizontal axis is hours from recording start. Cooling masks remain missing data; dashed visual bridges can be removed with Preserve gaps. Temperature values retain undocumented raw scaling. | Complete eight-car inspection ranking; unavailable cars remain labelled unknown. |
| Rail | Representative side-level acceleration envelopes, alongside full-recording side RMS and available speed evidence. The source has 128 acceleration channels at 64 positions across eight cars plus speed pulses; odd positions map to Side I and even positions to Side II. | Normal / Side I / Side II classification for the recording. |
| SHM | Ordered stress min/max envelope against sample index, plus full-recording stress and rainflow evidence. Source timing and physical location are not inferred. | Cumulative fatigue-damage estimate for the complete recording. |

The expanded Door previews (up to eight finite channels) and ACV cooling-target/residual previews are written by **new analyses**. Older saved jobs retain the evidence produced when they ran; this update does not backfill them or alter their predictions. Rerun a source file to produce a new report with the additional supported traces. Envelope and sampled charts are explicitly identified as previews, not full waveforms or hidden-Test answers.

## Validation and source boundaries

Uploads and bundled Test examples run the saved model without fitting. Each job retains the validation associated with its own model snapshot. Local model-selection scores and the retrospective ACV nested audit are shown separately from the unavailable organiser hidden-Test score.

**Predicting uploaded Train files is not independent validation.** Those inputs were already used in model development or fitting. Correct Train outputs neither establish accuracy on unseen recordings nor update the saved validation metrics. Uploads remain labelled `uploaded`; only the bundled official Test action assigns `organiser_test` provenance.

See [PS3 implementation](PS3_IMPLEMENTATION.md) for model limitations, [the PS3 API contract](PS3_IMPLEMENTATION_CONTRACT.md) for schemas, and [the release review](PS3_RELEASE_REVIEW.md) for source provenance. Run `scripts/check.ps1` for local tests and a production build; dated verification of the earlier interface is not a substitute for checking this workspace.

## Verification — 18 September 2026

- Full check: 215 Python tests plus four subtests, 37 frontend tests, TypeScript, ESLint and production build passed. Two dependency deprecation warnings remain in the Python test client.
- Browser checks covered shared file selection, all four component views, focused and eight-car camera framing, desktop and phone layouts, and unavailable ACV car evidence.
- An official Door Test run completed through the unified interface: 38 candidate actions and nine abnormal-resistance classifications. Those are model outputs, not verified Test answers.
- Saved results were recovered after a service restart. The prediction ZIP downloaded successfully from the export view with source and file counts shown.
- The OpenAI assistant answered a question about missing Car 05 readings in `acv_case_04.xlsx`, using the retained evidence tool and a source citation.
- The final production interface was rebuilt after removing a redundant map caption that overlapped its controls. Trained model artifacts were not changed by this integration.

### Prediction comparison update — 18 September 2026

- Full check passed: 228 Python tests plus four subtests, 48 frontend tests, TypeScript, ESLint and production build. The same two dependency deprecation warnings remain.
- Browser checks covered Current file / All files across Door, ACV, Rail and SHM; all 38 Door actions remain accessible. ACV shows six rankings and explicitly marks the unavailable cooling evidence in case 04.
- Rail's 50-file comparison supports class filtering, pagination and empty-search recovery; SHM's 64-file comparison supports ascending and descending damage sorting. Evidence links select the correct source recording. The comparison was checked at desktop and 390-pixel phone widths.
- Live CSV responses through the frontend proxy matched retained reports: all/current row counts were Door 38/38, ACV 6/1, Rail 50/1 and SHM 64/1. Both download buttons completed through the browser. These checks verify result presentation and export scope, not model accuracy.

### Investigation agent completion checks — 18 September 2026

- Project, selected-run and current-file investigation now retrieve allowlisted project knowledge, model metadata and saved evidence. Source cards expose the retrieved excerpts or structured evidence, with document line ranges and available run/model identity. Citation clicks open the corresponding evidence; brief exports retain literal source snapshots.
- Final full check passed: 332 Python tests plus four subtests, 66 frontend tests, TypeScript, ESLint and production build. The two existing Python test-client deprecation warnings remain. These totals include bounded legacy evidence projections, malformed-report fallback, source display limits, browser storage quota recovery and ten mocked launcher exit-race scenarios.
- A live OpenAI question about ACV correctly distinguished its 0.9792 rank-decay score, 5/6 first-choice result and the retrospective nested audit (0.9167 rank-decay, 4/6 first choice). It retrieved model metadata and project documentation with three sources. This checks agent integration and evidence interpretation; it does not add independent model-validation data.
- Browser checks verified opening a citation while its sources were collapsed, readable retrieved excerpts, brief download, restoration of the conversation and sources after refresh, and editing/retrying a local fallback without automatically submitting another request.
- A sandbox network restriction was reproduced as an HTTP connection failure; RailGuard was restarted outside that restriction with the already-authorized OpenAI connection. Network failures now give connection guidance separately from grounding failures. The final production build is served at the usual localhost URL.
- The stop script now handles processes exiting during identity checks while preserving PID/start-time/executable verification. Real stop/start cycles succeeded. No trained artifacts or saved prediction results were modified by this investigation update.

### Result-first and focused-3D refinement — 18 September 2026

- Completed recordings now lead with their result, explanation and next-step buttons. Upload controls, full prediction rows, complete measurements and signal charts remain available on demand.
- Focused cooling, paired-rail and door views highlight only the prediction scope supported by the report. All flagged Door actions remain selectable; missing action-level measurements are explicitly unavailable. SHM has no invented criticality threshold or physical damage location.
- Full check passed: 376 Python tests plus four subtests, 94 frontend tests, TypeScript, ESLint and production build. Browser checks covered desktop and phone result presentation, linked evidence, all four 3D systems, Rail side-preserving navigation, unavailable ACV evidence and export selection counts. Production services were restarted successfully. Saved models and prediction values were unchanged.

### Night Glass design C — 18 September 2026

- Applied the selected charcoal, glass and cyan design throughout the workspace. Current-file results place the prediction first, with an interactive 3D finding and recorded measurements beneath it. All-file comparison, source details and export selection remain available.
- Added profiled steel rails, sleepers, fasteners and instanced ballast, detailed cooling equipment, and refined door glazing and fittings. Geometry is illustrative; the side highlights, ranking, measurements and charts come from the selected saved report.
- Missing ACV evidence metadata now receives a neutral label instead of an unsupported inspection recommendation. Returned ranking and prediction values are preserved.
- Full check passed: 376 Python tests plus four subtests, 96 frontend tests, TypeScript, ESLint and production build. Desktop and phone browser checks covered results, comparison, 3D, unavailable evidence, investigation and export selections. Production services were restarted, and the Door and Rail scenes were visually verified with their retained measurements. Trained artifacts were unchanged.

### Engineering presentation — 19 September 2026

- System, run and recording controls are permanently visible. Task references expose the four official output definitions, evaluation metrics and submission filenames. Overview labels its scores as current-model local validation and links to model comparison.
- Compact result controls lead into the prediction, 3D component and complete selected evidence. Measurements, sources, all returned signal charts and prediction records are visible without disclosure controls. Long record tables retain scrolling and pagination.
- The SHM overlay identifies the stress recording and actual damage estimate without obscuring the structure. Repeated scene caveats were consolidated into a visible Method & interpretation section; missing ACV data remains unavailable. Full-width evidence sections replace the stretched empty space below the model.
- Verified all six workspace views, desktop and 390 × 844 layouts, all-file comparison with canvas unmounted, Door rows 21–40 navigation, source selection, SHM annotation, ACV missing evidence, and export counts changing 121 → 120 → 121. No browser console errors were observed in these checks.
- Full checks passed: 376 Python tests plus four subtests, 96 frontend tests, TypeScript, ESLint and production build. Final review corrected validation provenance wording for installed-model fallback. A fresh production build passed after preserving the generated OneDrive-marked build directory in `.cache/build-backups/ui-refinement-20260919`; the existing services were restarted and the structural view visually verified. No model artifacts or prediction values were changed.

### Gradient studio and model audit — 19 September 2026

- Cohesive graphite/ink gradients and steel-blue controls connect all six views. The transparent 3D canvas and shadow-only floor eliminate the gray horizon; cooler lighting and matching annotations preserve material detail. Deferred evidence and trace styles keep the final palette regardless of load order.
- Desktop checks covered all six views and four component scenes; 390 × 844 checks covered exports and analysis/3D without page-level overflow. Production inspection verified scene/evidence gradients and an empty error console.
- Full checks passed: 376 Python tests plus four subtests, 96 frontend tests, TypeScript, lint and production build. Local services are running the production build.
- The [Train-only audit](../outputs/model-review-20260919/model-review.md) verified 347 source/answer hashes and reproduced Door, ACV and SHM fitting/evaluation. The [seven-candidate Rail review](../outputs/model-review-20260919/rail/REVIEW.md) used duplicate-safe nested grouped folds and retained XGBoost; new candidates did not improve macro F1 or Side I recall. All deployed models and metadata remained unchanged. These retrospective development results do not establish hidden-Test accuracy.
- After selection was frozen, `scripts/verify_ps3.py --all-files --output-dir outputs/model-review-20260919/inference-check` passed on all 86 released Test recordings (1 Door, 1 ACV, 68 Rail, 16 SHM). Verified source/model hashes, coverage, output schemas and exact exported values: 123 prediction rows across four CSVs. The [verification record](../outputs/model-review-20260919/inference-check/verification.json) and ZIP are retained. This is an inference/export integration check; Test answers remain unavailable. No paid AI calls were made.
