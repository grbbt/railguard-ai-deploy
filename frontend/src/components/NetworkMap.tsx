'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Crosshair, Expand, Info, Layers3, LoaderCircle, MapPinned, Minus, Plus, RefreshCw, Satellite, Tag, X } from 'lucide-react';
import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Dashboard, TrainSummary } from '@/lib/types';
import type { GeoPoint, NetworkData, NetworkPositions, NetworkStation, TrainPosition } from '@/lib/network-types';
import { colors, number, request, statusLabel, time } from '@/lib/utils';

// Official providers and attribution requirements checked September 2026:
// https://www.onemap.gov.sg/docs/maps/night.html
// https://www.esri.com/en-us/legal/terms/web-site-service
// https://support.esri.com/en-us/knowledge-base/what-is-the-correct-way-to-cite-an-arcgis-online-basema-000012040
const BASEMAPS = {
  satellite: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community · <a href="https://www.esri.com/en-us/legal/terms/web-site-service" target="_blank" rel="noopener noreferrer">Terms</a>',
    minZoom: 10,
  },
  night: {
    url: 'https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png',
    attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="OneMap" style="height:20px;width:20px;vertical-align:middle"/> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
    minZoom: 11,
  },
} as const;
const LINE_COLORS: Record<string, string> = { NSL: '#ed443d', EWL: '#40ce79', CCL: '#ffb240', DTL: '#3999ff', NEL: '#c777e5', TEL: '#bd8963' };
const SINGAPORE_BOUNDS: [GeoPoint, GeoPoint] = [[1.22, 103.60], [1.48, 104.03]];
const validPosition = (point: { lat: number; lng: number }) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
const lineColor = (id: string, supplied?: string) => LINE_COLORS[id] ?? (supplied && /^#[0-9a-f]{6}$/i.test(supplied) ? supplied : '#a8c2cb');

type Props = {
  dashboard: Dashboard;
  selectedTrain: string;
  onSelect: (train: string, component?: string) => void;
  onInspect?: (train: string, component?: string) => void;
  onNetworkReady?: (network: NetworkData) => void;
  onPositionsReady?: (positions: NetworkPositions) => void;
  onStationSelect?: (station: NetworkStation | null) => void;
};
type MarkerRecord = { marker: Leaflet.Marker; position: TrainPosition };

function textElement(tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function popupContent(train: TrainSummary, position: TrainPosition, station: NetworkStation | undefined, inspect?: () => void) {
  const content = document.createElement('div');
  content.className = 'network-popup-content';
  content.append(textElement('div', position.position_source === 'demo' ? 'DEMO POSITION · NOT LIVE' : 'RECORDED GPS · NOT LIVE', 'network-popup-eyebrow'));
  content.append(textElement('h3', train.id));
  content.append(textElement('p', `${position.line ?? 'Line unavailable'}${station ? ` · near ${station.name}` : ''}`));
  const state = textElement('div', `${statusLabel[train.status]} · risk ${number(train.risk)}/100`, 'network-popup-status');
  state.style.color = colors[train.status];
  content.append(state);
  content.append(textElement('small', position.timestamp ? `${time(position.timestamp, true)} UTC` : 'Position timestamp unavailable'));
  if (inspect) {
    const button = textElement('button', 'Inspect sensor evidence ↗', 'network-popup-inspect') as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', inspect);
    content.append(button);
  }
  return content;
}

function trainIcon(L: typeof Leaflet, train: TrainSummary, selected: boolean, demo: boolean) {
  const content = document.createElement('div');
  content.className = `network-train-symbol ${train.status} ${selected ? 'selected' : ''} ${demo ? 'demo' : ''}`;
  content.style.setProperty('--train-color', colors[train.status]);
  const halo = document.createElement('span');
  halo.className = 'network-train-halo';
  const dot = document.createElement('span');
  dot.className = 'network-train-dot';
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('viewBox', '0 0 20 20');
  glyph.setAttribute('width', '15');
  glyph.setAttribute('height', '15');
  glyph.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M6 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 3v4h8V6Zm1 7h.01M13 13h.01M7 15l-2 3m8-3 2 3');
  body.setAttribute('fill', 'none');
  body.setAttribute('stroke', 'currentColor');
  body.setAttribute('stroke-width', '1.5');
  body.setAttribute('stroke-linecap', 'round');
  glyph.append(body);
  dot.append(glyph);
  content.append(halo, dot);
  return L.divIcon({ html: content, className: 'network-train-marker', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -17], tooltipAnchor: [0, -17] });
}

function mapPadding(map: Leaflet.Map): { paddingTopLeft: Leaflet.PointExpression; paddingBottomRight: Leaflet.PointExpression } {
  const width = map.getSize().x;
  if (width > 1150) return { paddingTopLeft: [295, 110], paddingBottomRight: [305, 145] };
  if (width > 800) return { paddingTopLeft: [225, 110], paddingBottomRight: [235, 135] };
  return { paddingTopLeft: [30, 115], paddingBottomRight: [30, 130] };
}

export default function NetworkMap({ dashboard, selectedTrain, onSelect, onInspect, onNetworkReady, onPositionsReady, onStationSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const library = useRef<typeof Leaflet | null>(null);
  const trainMarkers = useRef<Map<string, MarkerRecord>>(new Map());
  const networkSnapshot = useRef<NetworkData | null>(null);
  const fitted = useRef(false);
  const previousSelection = useRef(`${dashboard.dataset.id}:${selectedTrain}`);
  const callbacks = useRef({ onSelect, onInspect, onNetworkReady, onPositionsReady, onStationSelect });
  // Fast Refresh can preserve React state while recreating Leaflet's map. Every
  // new instance needs fresh layers even when an old ready flag was already true.
  const [mapGeneration, setMapGeneration] = useState(0);
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [positions, setPositions] = useState<NetworkPositions | null>(null);
  const [networkError, setNetworkError] = useState('');
  const [positionError, setPositionError] = useState('');
  const [tileError, setTileError] = useState('');
  const [basemap, setBasemap] = useState<keyof typeof BASEMAPS>('satellite');
  const [labels, setLabels] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());
  const [networkRefresh, setNetworkRefresh] = useState(0);
  const [positionRefresh, setPositionRefresh] = useState(0);
  const [tileRefresh, setTileRefresh] = useState(0);
  const sourcesButton = useRef<HTMLButtonElement>(null);
  const sourcesPanel = useRef<HTMLDivElement>(null);
  const sourcesId = useId();
  const datasetId = dashboard.dataset.id;
  const ready = mapGeneration > 0;
  const currentPositions = positions?.dataset_id === datasetId ? positions : null;

  useEffect(() => { callbacks.current = { onSelect, onInspect, onNetworkReady, onPositionsReady, onStationSelect }; }, [onSelect, onInspect, onNetworkReady, onPositionsReady, onStationSelect]);

  useEffect(() => {
    let canceled = false;
    let resize: ResizeObserver | undefined;
    let frame = 0;
    const markers = trainMarkers.current;
    import('leaflet').then(module => {
      if (canceled || !container.current) return;
      const L = module.default ?? module;
      library.current = L;
      const map = L.map(container.current, {
        center: [1.35, 103.82], zoom: 11.5, zoomSnap: 0.25, zoomDelta: 0.5,
        minZoom: 10, maxZoom: 19, zoomControl: false, attributionControl: true,
        // Include the full GPS extent accepted by the network API (east 104.51).
        maxBounds: [[1.08, 103.46], [1.62, 104.60]], maxBoundsViscosity: 0.7,
        scrollWheelZoom: true, wheelPxPerZoomLevel: 110, preferCanvas: false,
      });
      mapRef.current = map;
      map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
      map.createPane('rail-glow').style.zIndex = '390';
      map.createPane('rail-lines').style.zIndex = '400';
      map.createPane('rail-stations').style.zIndex = '430';
      map.createPane('rail-trains').style.zIndex = '500';
      let previousSize = map.getSize();
      let resizeNeedsFit = false;
      resize = new ResizeObserver(entries => {
        const rectangle = entries[0]?.contentRect;
        if (!rectangle || rectangle.width < 1 || rectangle.height < 1) return;
        const changed = Math.abs(rectangle.width - previousSize.x) > 2 || Math.abs(rectangle.height - previousSize.y) > 2;
        resizeNeedsFit = resizeNeedsFit || changed;
        previousSize = L.point(rectangle.width, rectangle.height);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (canceled) return;
          map.invalidateSize({ pan: false });
          if (!resizeNeedsFit) return;
          resizeNeedsFit = false;
          const stations = networkSnapshot.current?.stations.filter(validPosition) ?? [];
          if (stations.length) {
            map.fitBounds(L.latLngBounds(stations.map(station => [station.lat, station.lng] as GeoPoint)), { ...mapPadding(map), maxZoom: 12.3, animate: false });
            fitted.current = true;
          }
        });
      });
      resize.observe(container.current);
      setMapGeneration(generation => generation + 1);
    }).catch(() => { if (!canceled) setNetworkError('The interactive map could not initialize. Reload the page to retry.'); });
    return () => {
      canceled = true;
      resize?.disconnect();
      cancelAnimationFrame(frame);
      markers.clear();
      mapRef.current?.stop();
      mapRef.current?.remove();
      mapRef.current = null;
      library.current = null;
      fitted.current = false;
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    request<NetworkData>('/api/network', { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      networkSnapshot.current = result;
      setNetwork(result);
      setNetworkError('');
      callbacks.current.onNetworkReady?.(result);
    }).catch(cause => { if (!abort.signal.aborted) setNetworkError(cause instanceof Error ? cause.message : 'Rail network data is unavailable.'); });
    return () => abort.abort();
  }, [networkRefresh]);

  useEffect(() => {
    const abort = new AbortController();
    request<NetworkPositions>(`/api/network/positions?dataset_id=${encodeURIComponent(datasetId)}`, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      setPositions(result);
      setPositionError('');
      callbacks.current.onPositionsReady?.(result);
    }).catch(cause => {
      if (abort.signal.aborted) return;
      setPositionError(cause instanceof Error ? cause.message : 'Train positions could not be loaded.');
    });
    return () => abort.abort();
  }, [datasetId, positionRefresh]);

  useEffect(() => {
    const map = mapRef.current;
    const L = library.current;
    if (!ready || !map || !L) return;
    const definition = BASEMAPS[basemap];
    map.stop();
    map.setMinZoom(definition.minZoom);
    const tiles = L.tileLayer(definition.url, {
      attribution: definition.attribution, minZoom: definition.minZoom, maxZoom: 19,
      maxNativeZoom: 19, tileSize: 256, updateWhenIdle: true, keepBuffer: 3,
      className: basemap === 'satellite' ? 'network-satellite-tiles' : 'network-night-tiles',
    });
    let successes = 0;
    let failures = 0;
    tiles.on('loading', () => { successes = 0; failures = 0; });
    tiles.on('tileload', () => { successes += 1; setTileError(''); });
    tiles.on('tileerror', () => {
      failures += 1;
      if (failures >= 3 && successes === 0) setTileError(`${basemap === 'satellite' ? 'Satellite imagery' : 'OneMap tiles'} could not load. Try the other basemap or check your connection.`);
    });
    tiles.addTo(map);
    return () => {
      if (mapRef.current === map) map.stop();
      // Leaflet's own remove listeners detach map animation subscriptions and
      // attribution. Clearing them first leaves a destroyed layer subscribed.
      tiles.remove();
      tiles.off();
    };
  }, [basemap, ready, mapGeneration, tileRefresh]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !network) return;
    const attribution = `${textElement('span', network.attribution).outerHTML} · <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence</a>`;
    map.attributionControl.addAttribution(attribution);
    return () => { map.attributionControl.removeAttribution(attribution); };
  }, [network, ready, mapGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    const L = library.current;
    if (!ready || !map || !L || !network) return;
    const group = L.layerGroup().addTo(map);
    const validStations = network.stations.filter(validPosition);
    for (const line of network.lines) {
      if (hiddenLines.has(line.id)) continue;
      const color = lineColor(line.id, line.color);
      for (const segment of line.paths?.length ? line.paths : [line.path]) {
        const coordinates = segment.filter(point => point.length === 2 && validPosition({ lat: point[0], lng: point[1] }));
        if (coordinates.length < 2) continue;
        L.polyline(coordinates, { color: '#06120e', weight: 8, opacity: 0.65, interactive: false, pane: 'rail-glow', lineCap: 'round', lineJoin: 'round' }).addTo(group);
        L.polyline(coordinates, { color, weight: 11, opacity: 0.16, interactive: false, pane: 'rail-glow', className: 'network-route-glow', lineCap: 'round' }).addTo(group);
        L.polyline(coordinates, { color, weight: 3.1, opacity: 0.93, pane: 'rail-lines', lineCap: 'round', lineJoin: 'round' })
          .bindTooltip(textElement('span', `${line.id} · ${line.name}`), { sticky: true, className: 'network-route-tooltip' }).addTo(group);
      }
    }
    for (const station of validStations) {
      if (station.lines.length && station.lines.every(line => hiddenLines.has(line))) continue;
      const interchange = station.lines.length > 1;
      const marker = L.circleMarker([station.lat, station.lng], {
        radius: interchange ? 4.5 : 2.9, weight: interchange ? 2 : 1.2,
        color: '#15241d', fillColor: '#d7ede1', fillOpacity: 0.94, opacity: 1, pane: 'rail-stations',
      }).addTo(group);
      marker.bindTooltip(textElement('span', station.name), { permanent: labels, direction: 'top', offset: [0, -5], className: 'network-station-label' });
      const content = document.createElement('div');
      content.className = 'network-popup-content';
      content.append(textElement('div', 'MRT STATION', 'network-popup-eyebrow'), textElement('h3', station.name), textElement('p', station.lines.join(' · ')));
      const padding = mapPadding(map);
      marker.bindPopup(content, { className: 'network-popup', closeButton: true, autoPanPaddingTopLeft: padding.paddingTopLeft, autoPanPaddingBottomRight: padding.paddingBottomRight });
      marker.on('click', () => callbacks.current.onStationSelect?.(station));
      const element = marker.getElement();
      if (element) {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `${station.name} MRT station, ${station.lines.join(', ')}`);
        element.addEventListener('keydown', event => {
          if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); marker.openPopup(); callbacks.current.onStationSelect?.(station);
          }
        });
      }
    }
    if (!fitted.current && validStations.length) {
      const bounds = L.latLngBounds(validStations.map(station => [station.lat, station.lng] as GeoPoint));
      map.fitBounds(bounds, { ...mapPadding(map), maxZoom: 12.3, animate: false });
      fitted.current = true;
    }
    return () => { group.clearLayers(); group.remove(); };
  }, [network, hiddenLines, labels, ready, mapGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    const L = library.current;
    if (!ready || !map || !L) return;
    const available = new Set<string>();
    for (const position of currentPositions?.positions ?? []) {
      if (!validPosition(position) || position.position_source === 'unavailable') continue;
      const train = dashboard.trains.find(candidate => candidate.id === position.train_id);
      if (!train) continue;
      available.add(train.id);
      const selected = selectedTrain === train.id;
      const icon = trainIcon(L, train, selected, position.position_source === 'demo');
      const stored = trainMarkers.current.get(train.id);
      const marker = stored?.marker ?? L.marker([position.lat, position.lng], {
        icon, pane: 'rail-trains', keyboard: true, title: `${train.id}: ${statusLabel[train.status]}`, riseOnHover: true,
      }).addTo(map);
      marker.setIcon(icon).setLatLng([position.lat, position.lng]).setZIndexOffset(selected ? 1500 : 200);
      // Preserve Leaflet's popup click handler when refreshing an existing marker.
      if (!stored) {
        marker.on('click', () => callbacks.current.onSelect(train.id));
        marker.getElement()?.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          marker.openPopup();
          callbacks.current.onSelect(train.id);
        });
      }
      marker.unbindTooltip();
      marker.bindTooltip(textElement('span', train.id), { permanent: selected, direction: 'top', className: `network-train-label ${selected ? 'selected' : ''}`, offset: [0, -2] });
      const station = network?.stations.find(candidate => candidate.id === position.station_id);
      const inspect = () => { callbacks.current.onSelect(train.id); callbacks.current.onInspect?.(train.id); };
      const padding = mapPadding(map);
      marker.bindPopup(popupContent(train, position, station, callbacks.current.onInspect ? inspect : undefined), { className: 'network-popup', minWidth: 210, autoPanPaddingTopLeft: padding.paddingTopLeft, autoPanPaddingBottomRight: padding.paddingBottomRight });
      const accessibleLabel = `${train.id}, ${statusLabel[train.status]}, ${position.position_source === 'demo' ? 'demo position, not live' : 'recorded GPS, not live'}`;
      marker.getElement()?.setAttribute('aria-label', accessibleLabel);
      marker.getElement()?.setAttribute('title', accessibleLabel);
      trainMarkers.current.set(train.id, { marker, position });
    }
    for (const [id, record] of trainMarkers.current) {
      if (!available.has(id)) { record.marker.remove(); trainMarkers.current.delete(id); }
    }
    const selectionKey = `${datasetId}:${selectedTrain}`;
    if (previousSelection.current !== selectionKey) {
      const record = trainMarkers.current.get(selectedTrain);
      if (record) {
        map.panInside(record.marker.getLatLng(), { ...mapPadding(map), animate: true, duration: 0.6 });
        previousSelection.current = selectionKey;
      }
    }
  }, [currentPositions, dashboard.trains, selectedTrain, datasetId, network, ready, mapGeneration]);

  useEffect(() => {
    if (!sourcesOpen) return;
    sourcesPanel.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!sourcesPanel.current?.contains(document.activeElement) && document.activeElement !== sourcesButton.current) return;
      event.preventDefault();
      setSourcesOpen(false);
      sourcesButton.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [sourcesOpen]);

  function changeBasemap(next: keyof typeof BASEMAPS) {
    setBasemap(next);
    setTileError('');
  }

  function fitNetwork() {
    const map = mapRef.current;
    const L = library.current;
    if (!map || !L) return;
    const stations = network?.stations.filter(validPosition) ?? [];
    const bounds = stations.length ? L.latLngBounds(stations.map(station => [station.lat, station.lng] as GeoPoint)) : L.latLngBounds(SINGAPORE_BOUNDS);
    map.fitBounds(bounds, { ...mapPadding(map), maxZoom: 12.3, animate: true, duration: 0.7 });
  }

  function locateSelected() {
    const record = trainMarkers.current.get(selectedTrain);
    const map = mapRef.current;
    if (!record || !map) return;
    map.flyTo(record.marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.9 });
    record.marker.openTooltip();
  }

  const selectedHasPosition = currentPositions?.positions.some(position => position.train_id === selectedTrain && position.position_source !== 'unavailable' && validPosition(position));
  return <div className={`network-map ${basemap}`} style={{ position: 'absolute', inset: 0 }}>
    <div ref={container} className="network-map-canvas" aria-label="Interactive Singapore MRT network map" style={{ width: '100%', height: '100%', background: '#152a2a' }}/>
    <div className="network-map-shade" aria-hidden="true"/>
    {!ready && <div className="network-map-loading" role="status"><LoaderCircle size={20} className="spin"/>Preparing the geographic map…</div>}
    <div className="network-line-controls" role="group" aria-label="Visible MRT lines">
      {network?.lines.map(line => <button key={line.id} type="button" className={hiddenLines.has(line.id) ? 'off' : 'on'} aria-pressed={!hiddenLines.has(line.id)} title={line.name} onClick={() => setHiddenLines(previous => {
        const next = new Set(previous); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next;
      })}><i style={{ background: lineColor(line.id, line.color) }}/>{line.id}</button>)}
    </div>
    <div className="network-map-layers" role="group" aria-label="Map layers">
      <button type="button" className={basemap === 'satellite' ? 'active' : ''} onClick={() => changeBasemap('satellite')} aria-pressed={basemap === 'satellite'}><Satellite size={14}/> Satellite</button>
      <button type="button" className={basemap === 'night' ? 'active' : ''} onClick={() => changeBasemap('night')} aria-pressed={basemap === 'night'}><Layers3 size={14}/> Night</button>
      <span/>
      <button type="button" className={labels ? 'active' : ''} onClick={() => setLabels(value => !value)} aria-pressed={labels}><Tag size={14}/> Labels</button>
      <button ref={sourcesButton} type="button" className={sourcesOpen ? 'active' : ''} onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen} aria-controls={sourcesId} aria-label="Map data sources"><Info size={15}/></button>
    </div>
    <div className="network-navigation-controls" aria-label="Map navigation">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Plus size={18}/></button>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Minus size={18}/></button>
      <button type="button" aria-label="Fit Singapore MRT network" title="Fit network" onClick={fitNetwork}><Expand size={17}/></button>
      <button type="button" disabled={!selectedHasPosition} aria-label="Locate selected train" title="Locate selected train" onClick={locateSelected}><Crosshair size={17}/></button>
    </div>
    <div className={`network-position-source ${currentPositions?.source ?? 'unavailable'}`} title={currentPositions?.note ?? 'Waiting for position metadata'}>
      <MapPinned size={12}/><span>{!currentPositions ? positionError ? 'TRAIN POSITIONS UNAVAILABLE' : 'POSITIONS LOADING' : currentPositions.source === 'demo' ? 'DEMO POSITIONS · NOT LIVE' : currentPositions.source === 'telemetry' ? 'TELEMETRY POSITIONS · NOT A LIVE FEED' : 'TRAIN POSITIONS UNAVAILABLE'}</span>
      <button type="button" aria-label="Refresh train positions" title="Refresh position snapshot" onClick={() => setPositionRefresh(value => value + 1)}><RefreshCw size={11}/></button>
    </div>
    {(networkError || positionError || tileError) && <div className="network-map-error" role="alert"><Info size={14}/><span>{networkError || positionError || tileError}</span><button type="button" onClick={() => { setNetworkRefresh(value => value + 1); setPositionRefresh(value => value + 1); setTileRefresh(value => value + 1); setTileError(''); }}>Retry</button>{tileError && <button type="button" onClick={() => changeBasemap(basemap === 'satellite' ? 'night' : 'satellite')}>Use {basemap === 'satellite' ? 'Night' : 'Satellite'}</button>}</div>}
    {sourcesOpen && <div ref={sourcesPanel} id={sourcesId} className="network-sources-panel" role="region" aria-label="Map and position sources" tabIndex={-1}>
      <div><strong>Map & position sources</strong><button type="button" aria-label="Close map sources" onClick={() => { setSourcesOpen(false); sourcesButton.current?.focus(); }}><X size={15}/></button></div>
      <p>{network?.attribution ?? 'Network attribution loads with geographic data.'}</p>
      {network?.source_url && <a href={/^https:\/\//.test(network.source_url) ? network.source_url : undefined} target="_blank" rel="noopener noreferrer">View geographic source ↗</a>}
      <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence ↗</a>
      <p>{currentPositions?.note ?? 'Train-position metadata is not available yet.'}</p>
      {currentPositions?.timestamp && <p>Position snapshot: {time(currentPositions.timestamp, true)} UTC</p>}
      {network?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      <a href="https://www.onemap.gov.sg/docs/maps/night.html" target="_blank" rel="noopener noreferrer">SLA OneMap basemap documentation ↗</a>
      <a href="https://www.esri.com/en-us/legal/terms/web-site-service" target="_blank" rel="noopener noreferrer">Esri imagery terms & attribution ↗</a>
    </div>}
  </div>;
}
