'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Box, Check, ChevronLeft, ChevronRight, Clock3, Database, Layers, LocateFixed, MapPin, Radio, Search, ShieldCheck, TrainFront, Upload, X } from 'lucide-react';
import type { Dashboard } from '@/lib/types';
import type { NetworkData, NetworkPositions, NetworkStation } from '@/lib/network-types';
import { colors, number, shortComponent, time } from '@/lib/utils';
import { ComponentGlyph, EmptyState, Loading, StatusBadge } from '@/components/ui';
import { Sparkline } from '@/components/Charts';

const NetworkMap = dynamic(() => import('@/components/NetworkMap'), { ssr: false, loading: () => <div className="command-map-loading"><Loading label="Opening the Singapore network…" /></div> });
type Props = { dashboard: Dashboard; selectedTrain: string; onSelect: (id: string, component?: string) => void; onInspect: (id: string, component?: string) => void; onTwin: (id: string, component?: string) => void; onMaintain: () => void; onUpload: () => void; onExport: () => void; onDemo: () => void };

export default function Overview({ dashboard: d, selectedTrain, onSelect, onInspect, onTwin, onMaintain, onUpload, onExport, onDemo }: Props) {
  const [mode, setMode] = useState<'overview' | 'assets'>('overview');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [positionData, setPositionData] = useState<NetworkPositions | null>(null);
  const [station, setStation] = useState<NetworkStation | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [panelsVisible, setPanelsVisible] = useState(true);
  const positions = positionData?.dataset_id === d.dataset.id ? positionData : null;
  const selected = d.trains.find(t => t.id === selectedTrain) || d.trains[0];
  const position = positions?.positions.find(p => p.train_id === selected?.id);
  const location = network?.stations.find(s => s.id === position?.station_id);
  const line = network?.lines.find(l => l.id === position?.line);
  const sourceLabel = positions?.source === 'demo' ? 'Demo positions' : positions?.source === 'telemetry' ? 'Uploaded positions' : 'No live location feed';
  const alerts = useMemo(() => [...d.alerts].sort((a, b) => (a.status === 'critical' ? 0 : 1) - (b.status === 'critical' ? 0 : 1) || (b.risk ?? 0) - (a.risk ?? 0)), [d.alerts]);
  const filtered = d.trains.filter(t => `${t.id} ${t.name} ${t.line}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'attention' ? ['critical', 'warning'].includes(t.status) : t.status === filter)));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 8) - 1));
  const visible = filtered.slice(currentPage * 8, currentPage * 8 + 8);
  const healthyShare = d.trains.length ? d.totals.healthy / d.trains.length * 100 : null;
  const healthHistory = d.trend.filter(t => t.unknown < d.trains.length).map(t => t.healthy / Math.max(1, d.trains.length) * 100);
  const selectTrain = (id: string, component?: string) => { onSelect(id, component); setQuery(''); setMode('overview'); setStation(null); };

  return <section className={`fleet-command ${panelsVisible ? '' : 'panels-hidden'}`} aria-label="Singapore fleet command">
    <div className="command-map"><NetworkMap dashboard={d} selectedTrain={selectedTrain} onSelect={selectTrain} onInspect={onInspect} onNetworkReady={setNetwork} onPositionsReady={setPositionData} onStationSelect={setStation} /></div>
    <div className="command-atmosphere" aria-hidden="true" />
    <header className="command-heading">
      <div className="command-title"><span className="command-eyebrow">SINGAPORE MRT / NETWORK INTELLIGENCE</span><h1>Fleet command<span>.</span></h1></div>
      <div className="command-heading-actions">
        <label className="command-search"><Search size={15} /><span className="sr-only">Search trainsets</span><input value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder="Search trainset…" />{query && <button aria-label="Clear train search" onClick={() => setQuery('')}><X size={13} /></button>}</label>
        <button className={`command-live-source ${positions?.source || 'unavailable'}`} onClick={() => setShowSources(v => !v)} aria-expanded={showSources}><Radio size={13} />{sourceLabel}</button>
        <button className="command-tool" onClick={() => setPanelsVisible(v => !v)} aria-label={panelsVisible ? 'Hide map panels' : 'Show map panels'} aria-pressed={!panelsVisible} title="Toggle glass panels"><Layers size={16} /></button>
        <button className="command-tool" onClick={onExport} aria-label="Export findings" title="Export findings"><ArrowDownToLine size={16} /></button>
        <button className="command-upload" onClick={onUpload}><Upload size={14} /><span>Telemetry</span></button>
      </div>
      {query && mode === 'overview' && <div className="command-search-results command-glass"><span className="command-eyebrow">MATCHING TRAINSETS</span>{filtered.slice(0, 6).map(t => <button key={t.id} onClick={() => selectTrain(t.id)}><TrainFront size={16} /><span><strong>{t.id}</strong><small>{t.name}</small></span><StatusBadge status={t.status} compact /></button>)}{!filtered.length && <p>No matching trainsets in this dataset.</p>}</div>}
    </header>
    <div className="command-mode command-glass" role="group" aria-label="Fleet view"><button className={mode === 'overview' ? 'active' : ''} onClick={() => setMode('overview')}><LocateFixed size={13} />Network overview</button><button className={mode === 'assets' ? 'active' : ''} onClick={() => setMode('assets')}><TrainFront size={13} />Trainsets <span>{d.trains.length}</span></button></div>

    {showSources && <section className="command-source-panel command-glass" aria-label="Map and position sources">
      <button className="icon-btn" onClick={() => setShowSources(false)} aria-label="Close source details"><X size={16} /></button><div className="command-eyebrow">DATA CONNECTIONS</div><h2>Geography and telemetry</h2>
      <div className="source-connection"><span className="connection-dot connected" /><div><strong>Singapore MRT network</strong><p>{network?.source || 'Loading official geographic data…'}</p></div></div>
      <div className="source-connection"><span className={`connection-dot ${positions?.source === 'telemetry' ? 'connected' : ''}`} /><div><strong>{sourceLabel}</strong><p>{positions?.note || 'A verified vehicle-location feed is not connected. A transport map alone does not provide live train coordinates.'}</p></div></div>
      <p className="source-precision">Arrival predictions, station crowding and train coordinates are separate data sources. Position markers retain their source and timestamp.</p>
      {network && <a href={network.source_url} target="_blank" rel="noreferrer">Official geographic source<ArrowUpRight size={12} /></a>}{network?.warnings.map((warning, i) => <p className="source-warning" key={i}>{warning}</p>)}
      {d.dataset.source === 'uploaded' && <button className="btn btn-secondary" onClick={onDemo}>Load demonstration fleet</button>}
    </section>}

    {mode === 'overview' && <>
      <aside className="command-summary command-glass" aria-label="Fleet condition summary">
        <div className="command-panel-label"><span><i />OPERATING PICTURE</span><span>01 / SG</span></div>
        <div className="command-metrics"><div><span>TRAINSETS</span><strong>{d.trains.length}<i /></strong><small>{positions ? `${positions.positions.length} mapped` : 'Locating telemetry'}</small></div><div><span>MRT LINES</span><strong>{network?.lines.length ?? '—'}</strong><small>Geographic network</small></div><div><span>PRIORITY SIGNALS</span><strong className="warm-value">{alerts.length}</strong><small>Components to review</small></div><div><span>OBSERVATIONS</span><strong>{d.dataset.rows >= 1000 ? `${number(d.dataset.rows / 1000, 1)}k` : number(d.dataset.rows)}</strong><small>Sensor records</small></div></div>
        <div className="command-health"><div><span>HEALTHY FLEET</span><strong>{number(healthyShare, 0)}<small>%</small></strong></div><Sparkline label="Healthy trainsets as a share of the fleet over the observation window" data={healthHistory} color="#b1f3d7" width={220} height={56} /></div>
        <div className="command-status-bar" aria-label={`${d.totals.healthy} healthy, ${d.totals.warning} warning, ${d.totals.critical} critical, ${d.totals.unknown} unassessed`}>{(['healthy', 'warning', 'critical', 'unknown'] as const).map(status => <i key={status} style={{ flex: d.totals[status], background: colors[status], display: d.totals[status] ? 'block' : 'none' }} />)}</div>
        <div className="command-status-legend"><span><i className="healthy" />{d.totals.healthy} healthy</span><span><i className="warning" />{d.totals.warning} warning</span><span><i className="critical" />{d.totals.critical} critical</span>{d.totals.unknown > 0 && <span><i className="unknown" />{d.totals.unknown} unassessed</span>}</div>
        <div className="command-observation-note"><Clock3 size={12} /><span>Snapshot · {time(d.dataset.time_end, true)} UTC</span></div>
      </aside>
      <aside className="command-alerts command-glass" aria-label="Priority anomaly queue">
        <div className="command-panel-label"><span><i className="warm" />ANOMALY QUEUE</span><span>{String(alerts.length).padStart(2, '0')}</span></div>
        <div className="command-alert-list">{alerts.map((a, i) => <button className={`command-alert ${a.train_id === selectedTrain ? 'selected' : ''}`} key={`${a.train_id}:${a.component}`} onClick={() => selectTrain(a.train_id, a.component)}><div><span className={`alert-index ${a.status}`}>{String(i + 1).padStart(2, '0')}</span><strong>{a.train_id}</strong><span className={`alert-risk ${a.status}`}>{number(a.risk)}<small>/100</small></span><ArrowUpRight size={13} /></div><h3>{shortComponent[a.component] || a.component} · {a.status === 'critical' ? 'Persistent anomaly' : 'Sustained deviation'}</h3><p>{a.top_sensor?.replaceAll('_', ' ') || 'Sensor evidence'}</p><div className="command-alert-foot"><StatusBadge status={a.status} compact /><span>{time(a.latest_anomaly)} UTC</span></div></button>)}{!alerts.length && <EmptyState title="No intervention flags" icon={<Check size={22} />}>No components meet the warning or critical rules.</EmptyState>}</div>
        <button className="command-queue-link" onClick={onMaintain}>Open maintenance queue<ArrowRight size={15} /></button><p className="command-caution">Risk indicators require engineering review.</p>
      </aside>
      {selected && <aside className="command-selected command-glass" aria-label="Selected train location">
        <div className="command-panel-label"><span>SELECTED TRAINSET</span><span className="selected-line" style={{ color: line?.color || '#cbdad9' }}>{position?.line || 'UNMAPPED'}</span></div>
        <div className="command-selected-heading"><span className="command-train-icon"><TrainFront size={23} /></span><div><strong>{selected.id}</strong><small>{selected.name}</small></div><StatusBadge status={selected.status} compact /></div>
        <p className="command-location"><MapPin size={13} />{position ? location ? `Near ${location.name}` : `${number(position.lat, 4)}° N · ${number(position.lng, 4)}° E` : 'No position available for this train'}</p>
        <div className="command-selected-actions"><button onClick={() => onTwin(selected.id)}><Box size={14} />Inspect 3D train<ArrowUpRight size={13} /></button><button onClick={() => onInspect(selected.id)} aria-label={`Analyze ${selected.id}`} title="Sensor analysis"><Activity size={15} /></button></div>
      </aside>}
    </>}

    {station && mode === 'overview' && <section className="command-station command-glass" aria-label="Selected MRT station"><button className="icon-btn" onClick={() => setStation(null)} aria-label="Close station"><X size={15} /></button><div className="command-eyebrow">MRT STATION</div><h2>{station.name}</h2><div className="station-lines">{station.lines.map(id => <span key={id} style={{ borderColor: network?.lines.find(l => l.id === id)?.color }}>{id}</span>)}</div><p>{number(station.lat, 5)}° N · {number(station.lng, 5)}° E</p><small>Official station coordinates</small></section>}

    {mode === 'assets' && <section className="command-register command-glass" aria-label="Trainset register">
      <div className="command-register-heading"><div><div className="command-eyebrow">ASSET REGISTER / CURRENT DATASET</div><h2>Your fleet, in context</h2></div><span>{d.trains.length} trainsets · {d.components.length} components</span></div>
      <div className="command-filters" role="group" aria-label="Filter fleet">{[['all', 'All trainsets'], ['attention', 'Needs attention'], ['healthy', 'Healthy'], ['unknown', 'Unassessed']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => { setFilter(key); setPage(0); }}>{label}</button>)}</div>
      <div className="table-scroll"><table className="fleet-table command-fleet-table"><thead><tr><th>Trainset</th><th>Map position</th><th>Components</th><th>Condition</th><th>Risk trend</th><th>Inspect</th></tr></thead><tbody>{visible.map(t => {
        const p = positions?.positions.find(item => item.train_id === t.id); const nearest = network?.stations.find(s => s.id === p?.station_id);
        return <tr key={t.id} className={selectedTrain === t.id ? 'selected-row' : ''}><td><button className="train-link" onClick={() => selectTrain(t.id)}><span className="train-avatar"><TrainFront size={19} /></span><span><strong>{t.id}</strong><small>{t.name}</small></span></button></td><td><button className="register-location" disabled={!p} onClick={() => selectTrain(t.id)}><MapPin size={12} /><span>{nearest?.name || (p ? p.line || 'Uploaded position' : 'No coordinates')}<small>{p?.position_source === 'demo' ? 'Demonstration position' : p ? 'Uploaded coordinates' : 'Location unavailable'}</small></span></button></td><td><div className="component-dots">{t.components.map(c => <button key={c.component} onClick={() => onInspect(t.id, c.component)} aria-label={`${t.id} ${c.component}: ${c.status}`} style={{ color: colors[c.status], borderColor: `${colors[c.status]}44` }}><ComponentGlyph component={c.component} size={14} /></button>)}</div></td><td><StatusBadge status={t.status} compact /></td><td><div className="trend-cell"><Sparkline data={t.sparkline} color={colors[t.status]} /><span>{number(t.risk)}<small>/100</small></span></div></td><td><button className="icon-btn" aria-label={`Open ${t.id} 3D train`} onClick={() => onTwin(t.id)}><Box size={17} /></button></td></tr>;
      })}</tbody></table></div>
      {!visible.length && <EmptyState title="No matching trainsets">Change the search text or condition filter.</EmptyState>}
      <div className="table-footer"><span>{filtered.length ? currentPage * 8 + 1 : 0}–{Math.min((currentPage + 1) * 8, filtered.length)} of {filtered.length} trainsets</span><div><button className="icon-btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Previous fleet page"><ChevronLeft size={15} /></button><button className="icon-btn" disabled={(currentPage + 1) * 8 >= filtered.length} onClick={() => setPage(currentPage + 1)} aria-label="Next fleet page"><ChevronRight size={15} /></button></div></div>
    </section>}
    <div className="command-footer"><span><ShieldCheck size={12} />{number(d.totals.coverage, 1)}% sensor coverage<span className="command-footer-separator">/</span>{d.dataset.source === 'synthetic' ? 'Synthetic condition data' : 'Uploaded condition data'}</span><button onClick={() => setShowSources(v => !v)}><Database size={12} />Data & provenance<ArrowUpRight size={11} /></button></div>
  </section>;
}
