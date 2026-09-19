# RailGuard AI verification record

Verified on 14 September 2026 (Asia/Singapore). This record describes the implementation in this workspace, using generated demonstration data.

## Automated checks

- Python pipeline/API/generator/regression suite: **59 tests passed; 4 subtests passed**, including the geographic network, GPS handling and existing pipeline/API regressions (17.83 seconds in the final full run).
- TypeScript: passed standalone checking and the final production build's type checking.
- ESLint: passed on the final frontend source.
- Next.js production build: passed; the app route is prerendered and fetches analysis from the local Python API.
- Dependency integrity: `pip check` passed; Python lock versions match the tested environment.
- Chart helper probe: 200,000 observations processed without large-argument errors; bounded plotting preserves bucket extremes and missing-value gaps while reporting full counts. Timestamp placement was checked against irregular intervals.
- PowerShell launch scripts: syntax checks passed. An actual production start -> stop -> start cycle passed; shutdown identified and stopped exactly the two recorded RailGuard services.

## Browser workflows checked

- Geographic fleet command: real Singapore satellite tiles and SLA OneMap Night tiles loaded; provider attribution updates when switching. Map resize, zoom and fit controls were exercised. Eight explicitly simulated train markers link to the matching selected train and sensor evidence. Station pointer and keyboard activation display the selected station; line and trainset-condition filters work.

- All five screens display the selected dataset/train/component and genuine computed evidence.
- Sensor selection changes the plotted channel and its corresponding reference/evidence values.
- Native fullscreen inspection: enter and exit controls, viewport fitting and retained component controls.
- R151-inspired individual carriage, six-car formation, bogie and exploded views; telemetry-linked component selection; narrow-screen camera fitting. Official LTA illustrations and SMRT photographs informed the original model; exact engineering dimensions are not claimed.
- Created one demonstration work order for RG-101/bogies, advanced it to in progress and completed. A completed order remains in the local register. The fleet condition stayed at 3 healthy / 2 warning / 3 critical.
- Uploaded the generated healthy CSV: all **9,216 rows** were processed, eight trainsets assessed healthy, no warning/critical intervention flags. Isolated point detections remain visible.
- Uploaded `tests/fixtures/browser_partial.csv`: 160 rows, custom numeric measurements, an excluded Ground Truth label, train ID `SET/A`, and missing recent measurements. Result: one healthy trainset and one without current evidence; 87.5% row scoring coverage. All rows remained available.
- Uploaded-data explanation displays evaluation as unavailable instead of inheriting demonstration performance claims.
- Selecting an unmapped 3D part preserves the valid custom component rather than requesting nonexistent evidence.
- Mobile width 390px: no page-wide horizontal overflow; wide tables scroll within their panels, component tabs scroll locally. Navigation hides from keyboard/accessibility access when closed, contains focus when open, and supports Escape.
- Final browser console: no captured application errors. The installed Three/Fiber combination emits an upstream THREE.Clock deprecation warning.

## Evidence and scope

Four reproducible main CSV scenarios contain 9,216 rows each: mixed, healthy, missing, and quoted. Their generation settings, units, checksums and injected-scenario schedules are in `data/metadata.json` and `data/README.md`. The three compact browser fixtures are synthetic QA inputs; malformed and insufficient inputs are covered by automated validation tests.

The application performs real Isolation Forest fitting and reference-replacement sensitivity. Explanations are deterministic summaries of that evidence. The built-in evaluation is a same-generator demonstration check, not independent railway validation. Risk indices are heuristic indicators, not calibrated fault probabilities. There is no live train feed, external LLM, verified-fault classifier, or remaining-useful-life model.

Two upstream Python test-client deprecation warnings remain (Starlette/httpx and AnyIO). The initial sandboxed build could not write Next.js global telemetry configuration; launcher/check scripts now disable telemetry and the build passes without that write. Browser file-chooser automation was slow during uploads, although both selected files uploaded and analyzed successfully.

## Screenshots

- [Geographic glass fleet command](screenshots/fleet-command-map.png)
- [Mobile command map](screenshots/fleet-command-mobile.png)
- [Mobile fleet summaries](screenshots/fleet-command-mobile-summary.png)
- [Mobile R151 inspection](screenshots/r151-mobile.png)
- [R151 carriage](screenshots/r151-carriage.png)
- [Fullscreen R151 inspection](screenshots/r151-fullscreen.png)
- [R151 six-car formation](screenshots/r151-trainset.png)
- [Previous fleet overview](screenshots/fleet-overview.png)
- [Desktop exploded twin](screenshots/desktop-twin.png)
- [Mobile exploded twin](screenshots/mobile-twin.png)

## Run

From the repository root, run `.\scripts\start.ps1 -Production` for the built presentation version, or `.\scripts\start.ps1` for development. Open http://127.0.0.1:3000. Stop with `.\scripts\stop.ps1`. Initial installation and regeneration instructions are in README.md.

## September 2026 geographic and R151 update

The network snapshot contains 146 distinct operating MRT stations across six lines and 2,135 indicative route coordinates. Station/route conversion, branch coverage and uploaded GPS handling are covered by the new backend tests. Basemap loading, selection and resizing were inspected in the browser. A Leaflet cleanup-order defect found during testing was corrected: layers are removed before clearing their listeners, preserving map-animation and attribution teardown. Basemap/layer effects also reattach after hot reload.

The map uses external Esri/SLA tiles and therefore needs network access for imagery. Its locally cached MRT overlay remains available if a tile provider fails. Demo train positions remain fictional, stationary snapshot positions; no operator location feed is connected. Uploaded coordinates retain their recorded timestamps and are not labelled live. See NETWORK_DATA.md and ROLLING_STOCK.md for primary references and limits.

The final check script passed Python tests, route type generation, TypeScript, ESLint and a Next.js production build. It creates a new verified path under `.cache/verification` for each test run, avoiding ACL conflicts in shared Windows test folders. No unrelated temporary directories are removed.

Final production browser verification: satellite map, mobile map/summary panels and the new mobile R151 exploded view rendered successfully. The final production tab captured no application errors. Temporary viewport overrides were reset before handoff.
