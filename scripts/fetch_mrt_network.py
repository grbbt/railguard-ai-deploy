"""Rebuild the reviewed MRT geography snapshot from public government datasets.

Offline conversion dependencies: pyshp, pyproj; numpy/scipy are in the ML runtime.
The operational station whitelist is deliberately reviewed, not inferred from a
planning layer. See docs/NETWORK_DATA.md before updating it for new openings.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".cache" / "network-tools"))

STATION_URL = "https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/TrainStation_Mar2026.zip"
URA_LINES_ID = "d_1c6365f0cad13a77bd79bdbb499131bf"
URA_STATIONS_ID = "d_2c06c9fe8ae724b5d33efa1f203e2c38"
REVIEW_DATE = "2026-09-14"

# Verified against LTA's system map and the July 2026 Circle Line completion.
ROUTES = {
    "NSL": ("North-South Line", "#e1251b", ["Jurong East|Bukit Batok|Bukit Gombak|Choa Chu Kang|Yew Tee|Kranji|Marsiling|Woodlands|Admiralty|Sembawang|Canberra|Yishun|Khatib|Yio Chu Kang|Ang Mo Kio|Bishan|Braddell|Toa Payoh|Novena|Newton|Orchard|Somerset|Dhoby Ghaut|City Hall|Raffles Place|Marina Bay|Marina South Pier"]),
    "EWL": ("East-West Line", "#00953b", ["Pasir Ris|Tampines|Simei|Tanah Merah|Bedok|Kembangan|Eunos|Paya Lebar|Aljunied|Kallang|Lavender|Bugis|City Hall|Raffles Place|Tanjong Pagar|Outram Park|Tiong Bahru|Redhill|Queenstown|Commonwealth|Buona Vista|Dover|Clementi|Jurong East|Chinese Garden|Lakeside|Boon Lay|Pioneer|Joo Koon|Gul Circle|Tuas Crescent|Tuas West Road|Tuas Link", "Tanah Merah|Expo|Changi Airport"]),
    "NEL": ("North East Line", "#9e28b5", ["HarbourFront|Outram Park|Chinatown|Clarke Quay|Dhoby Ghaut|Little India|Farrer Park|Boon Keng|Potong Pasir|Woodleigh|Serangoon|Kovan|Hougang|Buangkok|Sengkang|Punggol|Punggol Coast"]),
    "CCL": ("Circle Line", "#ff9e18", ["Promenade|Nicoll Highway|Stadium|Mountbatten|Dakota|Paya Lebar|MacPherson|Tai Seng|Bartley|Serangoon|Lorong Chuan|Bishan|Marymount|Caldecott|Botanic Gardens|Farrer Road|Holland Village|Buona Vista|one-north|Kent Ridge|Haw Par Villa|Pasir Panjang|Labrador Park|Telok Blangah|HarbourFront|Keppel|Cantonment|Prince Edward Road|Marina Bay|Bayfront|Promenade", "Dhoby Ghaut|Bras Basah|Esplanade|Promenade"]),
    "DTL": ("Downtown Line", "#005ec4", ["Bukit Panjang|Cashew|Hillview|Hume|Beauty World|King Albert Park|Sixth Avenue|Tan Kah Kee|Botanic Gardens|Stevens|Newton|Little India|Rochor|Bugis|Promenade|Bayfront|Downtown|Telok Ayer|Chinatown|Fort Canning|Bencoolen|Jalan Besar|Bendemeer|Geylang Bahru|Mattar|MacPherson|Ubi|Kaki Bukit|Bedok North|Bedok Reservoir|Tampines West|Tampines|Tampines East|Upper Changi|Expo"]),
    "TEL": ("Thomson-East Coast Line", "#9d5b25", ["Woodlands North|Woodlands|Woodlands South|Springleaf|Lentor|Mayflower|Bright Hill|Upper Thomson|Caldecott|Stevens|Napier|Orchard Boulevard|Orchard|Great World|Havelock|Outram Park|Maxwell|Shenton Way|Marina Bay|Gardens by the Bay|Tanjong Rhu|Katong Park|Tanjong Katong|Marine Parade|Marine Terrace|Siglap|Bayshore"]),
}


def station_id(name):
    return "-".join(name.lower().replace("-", " ").split())


def download(url: str, target: Path):
    request = urllib.request.Request(url, headers={"User-Agent": "RailGuard-geography-builder/1.0", "Referer": "https://datamall.lta.gov.sg/"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(40 * 1024 * 1024 + 1)
    if len(data) > 40 * 1024 * 1024:
        raise ValueError("Government source exceeds the expected 40 MiB bound")
    target.write_bytes(data)


def fetch_ura(dataset_id: str, target: Path):
    url = f"https://api-open.data.gov.sg/v1/public/api/datasets/{dataset_id}/poll-download"
    with urllib.request.urlopen(url, timeout=30) as response:
        result = json.load(response)
    if result.get("code") != 0:
        raise RuntimeError(f"The public download for {dataset_id} is not ready; retry later")
    signed = result["data"]["url"]
    parsed = urlparse(signed)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".amazonaws.com"):
        raise ValueError("Unexpected public government download host")
    download(signed, target)


def centroid(ring):
    """Area centroid of an outer footprint ring, retaining physical coordinates."""
    import numpy as np
    points = np.asarray(ring, dtype=float)[:, :2]
    # Translate before area arithmetic to avoid cancellation in degree coordinates.
    origin = points[0].copy()
    points = points - origin
    following = np.roll(points, -1, axis=0)
    cross = points[:, 0] * following[:, 1] - following[:, 0] * points[:, 1]
    area = cross.sum()
    if abs(area) < 1e-15:
        return tuple((points.mean(axis=0) + origin).tolist()), 0.0
    center = ((points + following) * cross[:, None]).sum(axis=0) / (3 * area) + origin
    return tuple(center.tolist()), abs(float(area)) / 2


def build(sources: Path, output: Path):
    import numpy as np
    import shapefile
    from pyproj import CRS, Transformer
    from scipy.spatial import cKDTree
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra

    footprints = defaultdict(list)
    with zipfile.ZipFile(sources / "lta-train-stations.zip") as archive:
        def member(suffix):
            return archive.read(next(name for name in archive.namelist() if name.endswith(suffix)))
        transform = Transformer.from_crs(CRS.from_wkt(member(".prj").decode()), "EPSG:4326", always_xy=True)
        reader = shapefile.Reader(shp=io.BytesIO(member(".shp")), dbf=io.BytesIO(member(".dbf")))
        for item in reader.iterShapeRecords():
            values = item.record.as_dict()
            if values["TYP_CD_DES"] != "MRT":
                continue
            name = values["STN_NAM_DE"].removesuffix(" MRT STATION").strip().upper()
            parts = list(item.shape.parts) + [len(item.shape.points)]
            candidates = [centroid(item.shape.points[a:b]) for a, b in zip(parts, parts[1:])]
            center, area = max(candidates, key=lambda value: value[1])
            footprints[name].append((transform.transform(*center), area, "LTA March 2026 station footprint"))
    ura_stations = json.loads((sources / "ura-rail-stations-2025.geojson").read_text())
    for feature in ura_stations["features"]:
        properties = feature["properties"]
        name = properties.get("NAME", "").upper().strip()
        if properties.get("RAIL_TYPE") != "MRT" or name in footprints:
            continue
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        candidates = [centroid(polygon[0]) for polygon in polygons]
        center, area = max(candidates, key=lambda value: value[1])
        footprints[name].append((center, area, "URA Master Plan 2025 indicative station footprint"))

    stations = {}
    for line_id, (_, _, routes) in ROUTES.items():
        for name in set("|".join(routes).split("|")):
            key = name.upper()
            if key not in footprints:
                raise ValueError(f"Reviewed station {name} missing from official geometry; do not invent coordinates")
            samples = footprints[key]
            # Interchange footprints can be separate platforms; report their area-weighted center.
            weights = np.asarray([max(value[1], 1e-12) for value in samples])
            lng, lat = np.average(np.asarray([value[0] for value in samples]), axis=0, weights=weights)
            identifier = station_id(name)
            if identifier not in stations:
                stations[identifier] = {"id": identifier, "name": name, "lat": round(float(lat), 6), "lng": round(float(lng), 6), "lines": [], "coordinate_source": samples[0][2]}
            stations[identifier]["lines"].append(line_id)

    # URA supplies indicative alignment without a line name. Match each reviewed
    # adjacent station pair through its geographic graph. Nearby endpoints and
    # station footprints bridge tiny source gaps; no future station is activated.
    graph_points, edges, lookup, endpoints = [], {}, {}, set()
    def node(point):
        key = tuple(round(float(value), 7) for value in point)
        if key not in lookup:
            lookup[key] = len(graph_points)
            graph_points.append(key)
        return lookup[key]
    def meters(a, b):
        return float(np.linalg.norm((np.asarray(a) - b) * [111_280, 110_574]))
    def edge(a, b, weight=None):
        if a == b:
            return
        distance = weight if weight is not None else meters(graph_points[a], graph_points[b])
        old = edges.get((a, b), float("inf"))
        edges[a, b] = edges[b, a] = min(old, max(distance, 0.01))
    def simplify(points, tolerance=2.0):
        if len(points) < 3:
            return points
        p = np.asarray(points, dtype=float)
        scaled = p * [111_280, 110_574]
        direction = scaled[-1] - scaled[0]
        length = float(direction @ direction)
        if length:
            ratio = np.clip((scaled - scaled[0]) @ direction / length, 0, 1)
            distances = np.linalg.norm(scaled - scaled[0] - ratio[:, None] * direction, axis=1)
        else:
            distances = np.linalg.norm(scaled - scaled[0], axis=1)
        index = int(np.argmax(distances))
        if distances[index] <= tolerance:
            return [points[0], points[-1]]
        return simplify(points[:index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)
    source_lines = json.loads((sources / "ura-rail-lines-2025.geojson").read_text())
    for feature in source_lines["features"]:
        if feature["properties"].get("RAIL_TYPE") != "MRT":
            continue
        geometry = feature["geometry"]
        parts = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
        for part in parts:
            points = simplify(part)
            indices = [node(point) for point in points]
            endpoints.update([indices[0], indices[-1]])
            for a, b in zip(indices, indices[1:]):
                edge(a, b)
    tree = cKDTree(np.asarray(graph_points) * [111_280, 110_574])
    for a in endpoints:
        for b in tree.query_ball_point(np.asarray(graph_points[a]) * [111_280, 110_574], 100):
            edge(a, b)
    station_nodes = {}
    for identifier, station in stations.items():
        point = (station["lng"], station["lat"])
        neighbors = tree.query_ball_point(np.asarray(point) * [111_280, 110_574], 300)
        if not neighbors:
            raise ValueError(f"Station {identifier} has no nearby official rail alignment")
        index = node(point)
        station_nodes[identifier] = index
        for other in neighbors:
            edge(index, other, meters(point, graph_points[other]) * 1.15)
    # The planning source cuts alignments around station boxes, including
    # reserved stations. Bridge their outlines without showing them as stops.
    for name, samples in footprints.items():
        if station_id(name) in stations:
            continue
        for point, _, _ in samples:
            neighbors = tree.query_ball_point(np.asarray(point) * [111_280, 110_574], 300)
            if len(neighbors) < 2:
                continue
            index = node(point)
            for other in neighbors:
                edge(index, other, meters(point, graph_points[other]) * 1.15)
    rows, cols, values = zip(*[(a, b, distance) for (a, b), distance in edges.items()])
    graph = csr_matrix((values, (rows, cols)), shape=(len(graph_points), len(graph_points)))
    lines, audit = [], []
    for identifier, (name, color, route_strings) in ROUTES.items():
        paths, station_ids = [], []
        for route_string in route_strings:
            names = route_string.split("|")
            path = []
            for start, end in zip(names, names[1:]):
                a, b = station_nodes[station_id(start)], station_nodes[station_id(end)]
                distances, previous = dijkstra(graph, indices=a, return_predecessors=True)
                direct = meters(graph_points[a], graph_points[b])
                length = float(distances[b])
                if not np.isfinite(length) or length > direct * 3 + 500:
                    if not np.isfinite(length):
                        reachable = np.isfinite(distances)
                        reachable_points = np.asarray(graph_points)[reachable] * [111_280, 110_574]
                        other_points = np.asarray(graph_points)[np.isfinite(dijkstra(graph, indices=b))] * [111_280, 110_574]
                        gaps, nearest = cKDTree(reachable_points).query(other_points)
                        chosen = int(np.argmin(gaps))
                        print("Disconnected source gap", gaps[chosen], reachable_points[nearest[chosen]] / [111_280, 110_574], other_points[chosen] / [111_280, 110_574])
                    raise ValueError(f"Cannot reliably match {identifier}: {start} to {end}; {length:.0f}m vs {direct:.0f}m direct")
                indices, current = [b], b
                while current != a:
                    current = int(previous[current])
                    if current < 0:
                        raise ValueError("Broken geographic path")
                    indices.append(current)
                section = [[round(graph_points[index][1], 6), round(graph_points[index][0], 6)] for index in reversed(indices)]
                path.extend(section if not path else section[1:])
                audit.append({"line": identifier, "from": start, "to": end, "alignment_m": round(length), "straight_m": round(direct)})
            paths.append(path)
            station_ids.extend(station_id(value) for value in names if station_id(value) not in station_ids)
        lines.append({"id": identifier, "name": name, "color": color, "station_ids": station_ids, "path": paths[0], "paths": paths})
    now = datetime.now(timezone.utc).isoformat()
    output.mkdir(parents=True, exist_ok=True)
    result = {
        "source": "LTA station footprints and URA Master Plan 2025 indicative rail alignment",
        "source_url": "https://datamall.lta.gov.sg/content/datamall/en/static-data.html",
        "fetched_at": now,
        "attribution": f"Contains information from LTA Train Station (March 2026) and URA Master Plan 2025 Rail Line and Rail Station layers, accessed {REVIEW_DATE}, under Singapore Open Data Licence v1.0. No agency endorsement.",
        "license_url": "https://data.gov.sg/open-data-licence",
        "operational_review_date": REVIEW_DATE,
        "stations": sorted(stations.values(), key=lambda value: value["name"]), "lines": lines,
        "warnings": ["Geographic alignment is indicative and matched to reviewed operating station order; it is not signalling or track-occupancy data.", "Circle Line stage 6 is included following its 12 July 2026 opening. Planned stations, TEL stage 5 and the Downtown Line extension remain excluded until a confirmed opening is reviewed.", "No live operator train-location feed is configured. Demo train markers are explicitly simulated; uploaded GPS markers retain observation timestamps."],
    }
    (output / "singapore-mrt.json").write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    provenance = {"generated_at": now, "operational_review_date": REVIEW_DATE, "source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources.iterdir() if path.suffix in {".zip", ".geojson"}}, "station_count": len(stations), "line_station_counts": {line["id"]: len(line["station_ids"]) for line in lines}, "method": "Area centroid of LTA station footprints; URA indicative footprints supplement missing CCL6 stations. WGS84 transform, 2m Douglas-Peucker simplification, 100m endpoint gap matching, 300m station footprint connections, shortest geographic path between explicitly reviewed adjacent operating stations. Route rendering is indicative, not an operator track topology.", "route_segments": audit}
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"stations": len(stations), "lines": len(lines), "path_points": sum(len(path) for line in lines for path in line["paths"]), "output": str(output / "singapore-mrt.json")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Use downloaded raw sources without network calls")
    parser.add_argument("--source-dir", type=Path, default=ROOT / ".cache" / "network-source")
    args = parser.parse_args()
    sources = args.source_dir.resolve()
    if not sources.is_relative_to(ROOT):
        raise ValueError("Source cache must remain inside this project")
    sources.mkdir(parents=True, exist_ok=True)
    if not args.offline:
        download(STATION_URL, sources / "lta-train-stations.zip")
        fetch_ura(URA_LINES_ID, sources / "ura-rail-lines-2025.geojson")
        fetch_ura(URA_STATIONS_ID, sources / "ura-rail-stations-2025.geojson")
    build(sources, ROOT / "data" / "network")
