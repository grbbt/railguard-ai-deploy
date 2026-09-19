'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Crosshair, Info, Layers3, LoaderCircle, MapPin, Minus, Plus, RefreshCw, Satellite, Tag, X } from 'lucide-react';
import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoPoint, NetworkData, NetworkStation } from '@/lib/network-types';
import './workspace-map.css';

// Provider URLs and attribution follow the existing, documented network view.
// OneMap: https://www.onemap.gov.sg/docs/maps/night.html
// Geographic derivation and source licences: docs/NETWORK_DATA.md
const BASEMAPS = {
  satellite: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community · <a href="https://www.esri.com/en-us/legal/terms/web-site-service" target="_blank" rel="noopener noreferrer">Terms</a>',
    nativeMin: 10,
  },
  night: {
    url: 'https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png',
    attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="OneMap" width="20" height="20"/> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
    nativeMin: 11,
  },
} as const;
const COLORS: Record<string, string> = { NSL: '#f35c55', EWL: '#59db8d', NEL: '#d48aec', CCL: '#ffc15b', DTL: '#57acff', TEL: '#d0a17d' };
const DEFAULT_BOUNDS: [GeoPoint, GeoPoint] = [[1.245, 103.62], [1.46, 104.015]];
const validPoint = (point: unknown): point is GeoPoint => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[0] >= 1.1 && point[0] <= 1.6 && point[1] >= 103.4 && point[1] <= 104.6;
const validStation = (station: NetworkStation) => validPoint([station.lat, station.lng]);
const lineColor = (id: string) => COLORS[id] ?? '#c1dccb';

function textElement(tag: string, value: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function padding(map: Leaflet.Map) {
  const width = map.getSize().x;
  const height = map.getSize().y;
  const side = width > 1200 ? 285 : width > 900 ? 215 : 28;
  return { paddingTopLeft: [side, Math.min(120, height * .18)] as GeoPoint, paddingBottomRight: [side, Math.min(165, height * .23)] as GeoPoint };
}

function fitNetwork(map: Leaflet.Map, L: typeof Leaflet, network: NetworkData | null) {
  const stations = network?.stations.filter(validStation) ?? [];
  const bounds = stations.length ? L.latLngBounds(stations.map(station => [station.lat, station.lng] as GeoPoint)) : L.latLngBounds(DEFAULT_BOUNDS);
  map.stop();
  map.fitBounds(bounds, { ...padding(map), maxZoom: 12.5, animate: false });
}

export default function WorkspaceMap() {
  const canvas = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const library = useRef<typeof Leaflet | null>(null);
  const networkRef = useRef<NetworkData | null>(null);
  const stationMarkers = useRef<Map<string, Leaflet.CircleMarker>>(new Map());
  const sourceButton = useRef<HTMLButtonElement>(null);
  const sourceId = useId();
  const [generation, setGeneration] = useState(0);
  const [mapRevision, setMapRevision] = useState(0);
  const [networkRevision, setNetworkRevision] = useState(0);
  const [tileRevision, setTileRevision] = useState(0);
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [networkError, setNetworkError] = useState('');
  const [mapError, setMapError] = useState('');
  const [tileError, setTileError] = useState('');
  const [basemap, setBasemap] = useState<keyof typeof BASEMAPS>('satellite');
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState(false);
  const [sources, setSources] = useState(false);

  useEffect(() => {
    let canceled = false;
    let localMap: Leaflet.Map | null = null;
    let resize: ResizeObserver | undefined;
    let frame = 0;
    import('leaflet').then(module => {
      if (canceled || !canvas.current) return;
      const L = module.default ?? module;
      const map = L.map(canvas.current, {
        center: [1.35, 103.82], zoom: 11.5, minZoom: 10, maxZoom: 19,
        zoomSnap: .25, zoomDelta: .5, zoomControl: false, attributionControl: true,
        maxBounds: [[1.10, 103.4], [1.6, 104.6]], maxBoundsViscosity: .75,
        scrollWheelZoom: true, wheelPxPerZoomLevel: 110,
        zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
      });
      localMap = map;
      library.current = L;
      mapRef.current = map;
      map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
      map.createPane('workspace-rail-glow').style.zIndex = '390';
      map.createPane('workspace-rail-lines').style.zIndex = '400';
      map.createPane('workspace-rail-stations').style.zIndex = '430';
      fitNetwork(map, L, networkRef.current);
      let previousSize = map.getSize();
      let needsFit = false;
      resize = new ResizeObserver(entries => {
        const rectangle = entries[0]?.contentRect;
        if (!rectangle || rectangle.width < 1 || rectangle.height < 1) return;
        needsFit ||= Math.abs(rectangle.width - previousSize.x) > 2 || Math.abs(rectangle.height - previousSize.y) > 2;
        previousSize = L.point(rectangle.width, rectangle.height);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (canceled) return;
          map.invalidateSize({ pan: false });
          if (needsFit) fitNetwork(map, L, networkRef.current);
          needsFit = false;
        });
      });
      resize.observe(canvas.current);
      setMapError('');
      // A new instance always needs fresh layers, including after Fast Refresh.
      setGeneration(previous => previous + 1);
    }).catch(() => { if (!canceled) setMapError('The interactive map could not start. Your recording results are unaffected.'); });
    return () => {
      canceled = true;
      resize?.disconnect();
      cancelAnimationFrame(frame);
      localMap?.stop();
      localMap?.remove();
      if (mapRef.current === localMap) { mapRef.current = null; library.current = null; }
    };
  }, [mapRevision]);

  useEffect(() => {
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 12000);
      try {
        const response = await fetch('/api/network', { signal: AbortSignal.any([abort.signal, timeout.signal]), cache: 'no-store' });
        if (!response.ok) throw new Error(`The local geography service returned ${response.status}.`);
        const result: NetworkData = await response.json();
        if (!Array.isArray(result.stations) || !Array.isArray(result.lines) || !result.stations.length) throw new Error('The geography snapshot is unavailable.');
        if (abort.signal.aborted) return;
        networkRef.current = result;
        setNetwork(result);
        setNetworkError('');
      } catch (cause) {
        if (abort.signal.aborted) return;
        setNetworkError(timeout.signal.aborted ? 'The local geography service did not respond in time.' : cause instanceof Error ? cause.message : 'The network overlay could not load.');
        retry = setTimeout(load, 10000);
      } finally { clearTimeout(timer); }
    };
    load();
    return () => { abort.abort(); clearTimeout(retry); };
  }, [networkRevision]);

  useEffect(() => {
    const map = mapRef.current;
    const L = library.current;
    if (!generation || !map || !L) return;
    const provider = BASEMAPS[basemap];
    map.stop();
    const tiles = L.tileLayer(provider.url, {
      attribution: provider.attribution, minZoom: 10, maxZoom: 19,
      minNativeZoom: provider.nativeMin, maxNativeZoom: 19,
      keepBuffer: 3, updateWhenIdle: true,
      className: `workspace-map-tiles-${basemap}`,
    });
    let active = true;
    let failures = 0;
    tiles.on('loading', () => { failures = 0; });
    tiles.on('tileerror', () => {
      failures += 1;
      if (active) setTileError(`${basemap === 'satellite' ? 'Satellite imagery' : 'OneMap tiles'} could not fully load. The rail overlay remains independent; try the other layer.`);
    });
    tiles.on('load', () => { if (active && !failures) setTileError(''); });
    tiles.addTo(map);
    return () => {
      active = false;
      if (mapRef.current === map) map.stop();
      // Removal must run Leaflet's internal listeners before off() clears them.
      tiles.remove();
      tiles.off();
    };
  }, [generation, basemap, tileRevision]);

  useEffect(() => {
    const map = mapRef.current;
    const L = library.current;
    if (!generation || !map || !L || !network) return;
    const group = L.layerGroup().addTo(map);
    const markers = stationMarkers.current;
    markers.clear();
    // Keep the required acknowledgement readable on mobile; the sources panel
    // retains the snapshot's complete attribution and derivation limitations.
    const attribution = 'Geography: LTA / URA · <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Open Data Licence</a>';
    map.attributionControl.addAttribution(attribution);
    for (const line of network.lines) {
      if (hiddenLines.has(line.id)) continue;
      for (const path of line.paths?.length ? line.paths : [line.path]) {
        // Split at bad coordinates rather than drawing across a missing segment.
        const segments: GeoPoint[][] = [[]];
        for (const point of path) {
          if (validPoint(point)) segments[segments.length - 1].push(point);
          else if (segments[segments.length - 1].length) segments.push([]);
        }
        for (const coordinates of segments.filter(segment => segment.length > 1)) {
          L.polyline(coordinates, { color: '#071e15', weight: 8, opacity: .75, interactive: false, pane: 'workspace-rail-glow' }).addTo(group);
          L.polyline(coordinates, { color: lineColor(line.id), weight: 12, opacity: .17, interactive: false, pane: 'workspace-rail-glow' }).addTo(group);
          L.polyline(coordinates, { color: lineColor(line.id), weight: 3, opacity: .94, pane: 'workspace-rail-lines' })
            .bindTooltip(textElement('span', `${line.id} · ${line.name}`), { sticky: true, className: 'workspace-map-tooltip' }).addTo(group);
        }
      }
    }
    for (const station of network.stations.filter(validStation)) {
      if (station.lines.length && station.lines.every(line => hiddenLines.has(line))) continue;
      const interchange = station.lines.length > 1;
      const marker = L.circleMarker([station.lat, station.lng], {
        radius: interchange ? 4.2 : 2.6, weight: interchange ? 1.8 : 1.1,
        color: '#153527', fillColor: '#e2f3dd', fillOpacity: .95, pane: 'workspace-rail-stations',
      }).addTo(group);
      marker.bindTooltip(textElement('span', station.name), { permanent: labels, direction: 'top', offset: [0, -4], className: 'workspace-map-tooltip' });
      const content = document.createElement('div');
      content.className = 'workspace-map-station-popup';
      content.append(textElement('small', 'GEOGRAPHIC CONTEXT'), textElement('h3', station.name), textElement('p', station.lines.join(' · ')), textElement('p', 'Station footprint centroid. No recording or train location is assigned here.'));
      marker.bindPopup(content, { className: 'workspace-map-popup', closeButton: true, autoPan: false, maxWidth: 250 });
      markers.set(station.id, marker);
    }
    return () => {
      markers.clear();
      group.remove();
      group.clearLayers();
      if (mapRef.current === map) map.attributionControl.removeAttribution(attribution);
    };
  }, [generation, network, labels, hiddenLines]);

  useEffect(() => {
    if (generation && network && mapRef.current && library.current) fitNetwork(mapRef.current, library.current, network);
  }, [generation, network]);

  useEffect(() => {
    if (!sources) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSources(false); sourceButton.current?.focus(); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [sources]);

  const toggleLine = (id: string) => setHiddenLines(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const recenter = () => { if (mapRef.current && library.current) fitNetwork(mapRef.current, library.current, networkRef.current); };
  const locateStation = (id: string) => {
    const marker = stationMarkers.current.get(id);
    if (!marker || !mapRef.current) return;
    mapRef.current.setView(marker.getLatLng(), Math.max(mapRef.current.getZoom(), 13), { animate: false });
    marker.openPopup();
    setSources(false);
    canvas.current?.focus({ preventScroll: true });
  };

  return <section className={`workspace-map workspace-map-${basemap}`} aria-label="Singapore rail geography, separate from PS3 recording locations">
    <div ref={canvas} className="workspace-map-canvas" aria-label="Interactive Singapore map. Use arrow keys to pan and plus or minus to zoom."/>
    <div className="workspace-map-shade" aria-hidden="true"/>
    {!!network?.lines.length && <div className="workspace-map-lines workspace-map-glass" role="group" aria-label="Show or hide geographic rail lines">{network.lines.map(line => <button type="button" key={line.id} aria-pressed={!hiddenLines.has(line.id)} className={hiddenLines.has(line.id) ? 'off' : ''} title={`${line.name}: ${hiddenLines.has(line.id) ? 'show' : 'hide'}`} onClick={() => toggleLine(line.id)}><i style={{ background: lineColor(line.id), color: lineColor(line.id) }}/>{line.id}</button>)}</div>}
    {(mapError || networkError || tileError || !network) && <div className="workspace-map-message workspace-map-glass" role="status">{!mapError && !networkError && !tileError ? <LoaderCircle size={14} className="workspace-map-spin"/> : <Info size={14}/>}<span>{mapError || networkError || tileError || 'Loading the local geographic snapshot…'}{networkError && ' Retrying automatically.'}</span>{(mapError || networkError || tileError) && <button type="button" onClick={() => { if (mapError) setMapRevision(value => value + 1); if (networkError) setNetworkRevision(value => value + 1); if (tileError) setTileRevision(value => value + 1); }} aria-label="Retry unavailable map content"><RefreshCw size={14}/><span>Retry</span></button>}</div>}
    <div className="workspace-map-tools workspace-map-glass" role="group" aria-label="Map controls">
      <button type="button" className={basemap === 'satellite' ? 'active' : ''} aria-label="Satellite imagery" aria-pressed={basemap === 'satellite'} onClick={() => setBasemap('satellite')}><Satellite size={15}/><span>Satellite</span></button>
      <button type="button" className={basemap === 'night' ? 'active' : ''} aria-label="Night basemap" aria-pressed={basemap === 'night'} onClick={() => setBasemap('night')}><Layers3 size={15}/><span>Night</span></button>
      <span className="workspace-map-tool-divider" aria-hidden="true"/>
      <button type="button" aria-pressed={labels} title="Show station names" aria-label="Show station names" disabled={!network} className={labels ? 'active' : ''} onClick={() => setLabels(value => !value)}><Tag size={15}/></button>
      <button type="button" title="Fit Singapore network" aria-label="Fit Singapore network" disabled={!generation || !!mapError} onClick={recenter}><Crosshair size={16}/></button>
      <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!generation || !!mapError} onClick={() => mapRef.current?.zoomOut(.5, { animate: false })}><Minus size={16}/></button>
      <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!generation || !!mapError} onClick={() => mapRef.current?.zoomIn(.5, { animate: false })}><Plus size={16}/></button>
      <button ref={sourceButton} type="button" className={sources ? 'active' : ''} title="Map sources and station finder" aria-label="Map sources and station finder" aria-expanded={sources} aria-controls={sourceId} onClick={() => setSources(value => !value)}><Info size={16}/></button>
    </div>
    <div className="workspace-map-context workspace-map-glass"><span><MapPin size={13}/>Singapore network context · recordings have no GPS</span><small>Static indicative geometry · no track occupancy or train positions</small></div>
    {sources && <section className="workspace-map-sources workspace-map-glass" id={sourceId} aria-labelledby={`${sourceId}-heading`}><div className="workspace-map-sources-heading"><span><small>MAP PROVENANCE</small><h2 id={`${sourceId}-heading`}>Geography, not telemetry</h2></span><button type="button" aria-label="Close map sources" onClick={() => { setSources(false); sourceButton.current?.focus(); }}><X size={17}/></button></div><p>These anonymous PS3 recordings have no GPS or verified Singapore train identity. This map provides visual context only.</p>{network && <><p>{network.source} Station dots are footprint centroids; routes are derived indicative alignments.</p><p className="workspace-map-source-date">Snapshot retrieved: {network.fetched_at ? network.fetched_at.slice(0, 10) : 'date unavailable'} · {network.stations.length} stations</p><label className="workspace-map-station-select">Find a visible station<select defaultValue="" onChange={event => locateStation(event.target.value)}><option value="" disabled>Choose a station…</option>{network.stations.filter(station => validStation(station) && (!station.lines.length || !station.lines.every(line => hiddenLines.has(line)))).slice().sort((a, b) => a.name.localeCompare(b.name)).map(station => <option key={station.id} value={station.id}>{station.name} · {station.lines.join(' / ')}</option>)}</select></label>{!!network.warnings?.length && <details><summary>Geometry limitations</summary><ul>{network.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}<p>{network.attribution}</p>{/^https:\/\//.test(network.source_url) && <a href={network.source_url} target="_blank" rel="noopener noreferrer">Geographic source ↗</a>}</>}<a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence ↗</a><a href={basemap === 'satellite' ? 'https://www.esri.com/en-us/legal/terms/web-site-service' : 'https://www.onemap.gov.sg/docs/maps/night.html'} target="_blank" rel="noopener noreferrer">{basemap === 'satellite' ? 'Esri imagery terms' : 'SLA OneMap Night documentation'} ↗</a></section>}
  </section>;
}
