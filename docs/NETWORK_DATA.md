# Singapore MRT geography and train locations

The map uses real Singapore geography and an explicitly reviewed operating station list. It does **not** have a live operator train-location feed. The default `RG-101`–`RG-108` trains are fictional, and their map positions and route assignments are visibly marked as a simulation. Uploaded telemetry produces recorded GPS markers only when coordinates are present; a train without coordinates is never assigned a guessed position.

## Geographic sources

Sources were retrieved and operating coverage reviewed on **14 September 2026**.

| Source | Snapshot and use |
| --- | --- |
| [LTA DataMall Train Station layer](https://datamall.lta.gov.sg/content/datamall/en/static-data.html) | [March 2026 shapefile](https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/TrainStation_Mar2026.zip), 231 MRT/LRT footprint records. Despite the catalogue's point description, the downloaded geometry is polygon type. MRT footprint centroids are transformed from the supplied SVY21 projection to WGS84. |
| [URA Master Plan 2025 Rail Station layer](https://data.gov.sg/datasets/d_2c06c9fe8ae724b5d33efa1f203e2c38/view) | Indicative station outlines, gazetted December 2025 and published January 2026. Supplements Keppel, Cantonment and Prince Edward Road, which are absent from LTA's March snapshot. |
| [URA Master Plan 2025 Rail Line layer](https://data.gov.sg/datasets/d_1c6365f0cad13a77bd79bdbb499131bf/view) | Indicative alignment, including planned lines. Only geographic paths between the reviewed operating station pairs are rendered. This is not an operator signalling or engineering track database. |
| [LTA July 2026 system map](https://www.lta.gov.sg/content/dam/ltagov/getting_around/public_transport/rail_network/pdf/SM_EN_(Ver210726)_CCL6.pdf) | Operating line order and branches. LTA's [Circle Line stage 6 page](https://www.lta.gov.sg/content/ltagov/en/upcoming_projects/rail_expansion/circle_line_6.html) confirms passenger service began 12 July 2026. |
| [SLA OneMap Night tiles](https://www.onemap.gov.sg/docs/maps/night.html) | Official geographic basemap, fetched directly by the browser. The documented XYZ tile example does not require a key. OneMap's separate search/geocoding API currently requires token authentication; the app does not call that API. |

The included snapshot has 146 distinct MRT stations across NSL (27 line stops), EWL (35 including the airport branch), NEL (17), CCL (33), DTL (35) and TEL (27). Interchanges share a single station marker and belong to multiple lines. The Circle Line includes its completed loop and Dhoby Ghaut branch; EWL includes Tanah Merah–Expo–Changi Airport. Hume and Punggol Coast are included. LRT, future lines, reserved stations and stations still shown under construction are excluded. In particular, TEL stage 5 and the DTL extension are not treated as operating merely because their target year is 2026. Update the reviewed whitelist only after confirming an opening.

The current system map calls Marina Bay and Bayfront CCL stations CC33 and CC34. Internally the map uses stable station-name identifiers (for example `marina-bay`) instead of historical CE codes.

## Conversion and accuracy limits

`scripts/fetch_mrt_network.py` produces `data/network/singapore-mrt.json` and `provenance.json`. Raw downloads remain in ignored `.cache/network-source/`. Provenance records the exact source SHA-256 hashes, station counts, conversion method and every matched interstation segment length.

Station markers are area centroids of supplied footprints, with an area-weighted center for separate interchange footprints. They describe station locations, not entrances or precise stopping positions. The rail source has no per-line identifier: the script simplifies its MRT geometry with a 2-metre Douglas–Peucker tolerance and matches a shortest geographic path between each pair in the explicit operating station sequence. It bridges source endpoints within 100 metres and source gaps around station footprints within 300 metres. Reserved/planned station boxes can bridge a gap in an existing line, but never become displayed operating stops. The builder fails when a pair cannot be connected within its documented detour bound. These transformations produce an indicative geographic overlay and do not establish switch connectivity, platform assignment or track occupancy.

The compact snapshot contains 2,135 path coordinates. Approximate matched alignment totals are NSL 45.3 km, EWL 56.8 km including the airport branch, NEL 21.3 km, CCL 39.5 km including its branch, DTL 41.2 km and TEL 40.9 km. They are conversion checks, not replacement official line-length statistics or surveyed distances.

The source licence permits dataset adaptation and redistribution with attribution. The application includes conspicuous source text and a [Singapore Open Data Licence link](https://data.gov.sg/open-data-licence); [LTA's corresponding licence](https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html) applies to its data. Retain OneMap/SLA attribution when using the basemap. The datasets and derivative display do not imply government or operator endorsement. Basemap providers have their own attribution and service terms; the browser must keep their visible attribution when switching providers.

## APIs and position provenance

`GET /api/network` returns the cached geography: `source`, `source_url`, `fetched_at`, `attribution`, `stations`, `lines` and `warnings`, plus licence/review metadata. All path coordinates use `[latitude, longitude]`. `line.paths` preserves branches; `line.path` is the main path for simpler consumers. The endpoint makes no network requests and works offline after installation.

`GET /api/network/positions?dataset_id=demo` resolves the same dataset as the dashboard. It returns `dataset_id`, `source`, `timestamp`, `positions`, `note` and integration status. A position includes `train_id`, `lat`, `lng`, `line`, `station_id`, `direction`, `position_source` and its own `timestamp`.

- `source: "demo"`: stable hash-based positions for fictional synthetic trains on real route paths, fixed at the synthetic dataset endpoint. Route assignments are illustrative; they are not inferred from the generator's generic line labels. These markers are not actual trains or a timetable estimate.
- `source: "telemetry"`: actual coordinate values supplied in the uploaded file at each train's latest observation timestamp. Supported latitude names are `lat`, `latitude`, `gps_lat`, `gps_latitude`, `latitude_deg` and `latitude_degrees`; longitude equivalents include `lon`, `lng`, `long`, `longitude`, `gps_lon`, `gps_lng`, `gps_longitude`, `longitude_deg` and `longitude_degrees`. Case, spaces, underscores and camel case are normalized for alias matching. Only one latitude column and one longitude column may be present. Geographic columns, route position and heading are excluded from ML sensor inputs.
- `source: "unavailable"`: no valid unambiguous latest coordinate pair. Missing/infinite/nonnumeric/out-of-map coordinates and conflicting simultaneous pairs are omitted. The service does not substitute an older GPS row or a simulated location. A valid pair from one component row can supply the train location when other rows at that same timestamp omit GPS.

The covered extent is latitude 1.14–1.50 and longitude 103.53–104.51. A coordinate elsewhere can be a valid Earth location while being outside this Singapore map. Each marker retains its observation timestamp; an old uploaded dataset is historical, even if the screen is open now. A nearby station ID is returned only within 1.5 km and is a proximity hint, never proof that a train occupies that station. A line is returned for uploaded data only when its supplied line name/code unambiguously matches one of the six MRT lines. The service does not infer a route from proximity.

## Why the map does not claim live train positions

The current [LTA DataMall dynamic catalogue](https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html) lists GTFS Realtime **Train Trip Updates** (arrival/departure predictions, delays, cancellations and skipped stops), **Train Service Alerts**, and a planned GTFS schedule. These are distinct from a per-vehicle coordinate feed. We did not verify a public Singapore MRT `VehiclePositions` feed or a way to map its vehicle identifiers to this maintenance dataset. Consequently the application never converts arrival predictions into purported measured train positions.

LTA dynamic APIs require a registered AccountKey. No key or operator feed was provided for this build, and no key is needed for the public geography snapshot or documented OneMap tile layer. The response explicitly reports `live_train_locations: "not_configured"`. There is no generic remote-URL proxy. A future operator integration needs a verified endpoint, credentials kept on the backend, vehicle-ID mapping, observation timestamps and stale-data handling before it can supply genuine live locations.

## Rebuilding and checking

Normal setup and launch use the committed JSON and need no GIS packages. To refresh the source snapshot, install the two optional conversion libraries into an ignored local directory and run the builder:

```powershell
.\.venv\Scripts\python.exe -m pip install --target .cache/network-tools pyshp==3.1.6 pyproj==3.8.0
.\.venv\Scripts\python.exe scripts/fetch_mrt_network.py
.\.venv\Scripts\python.exe -m pytest tests/test_network.py -q
```

Use `--offline` to rebuild from cached downloads. The script's known government API calls are bounded; it validates the data.gov.sg download URL as HTTPS on the expected public S3 domain. Review newly downloaded data and operating changes before publishing an updated snapshot. The builder itself does not automatically discover new station openings.

Network tests cover operating topology, curved paths and branches, explicit simulation provenance, the default demo alias, source immutability, GPS exclusion from model inputs, quoted train identifiers, invalid/missing/infinite and conflicting coordinates, absence of invented fallback markers, and API dataset errors. Full pipeline regression tests still apply when coordinate metadata rules change.
