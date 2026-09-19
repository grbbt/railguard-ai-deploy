'use client';

import { useId, useMemo, useState } from 'react';
import type { Dashboard, Point, SensorEvidence } from '@/lib/types';
import { number, time } from '@/lib/utils';

type Reading = number | null;
type Timeline = { values: number[]; sorted: number[]; start: number; end: number; timed: boolean };
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const MAX_TRACE_POINTS = 1200;
const MAX_MARKERS = 320;
const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

// Scan full data; never expand potentially large arrays into function arguments.
function extent(values: Reading[]) {
  return values.reduce((range, value) => finite(value)
    ? { min: Math.min(range.min, value), max: Math.max(range.max, value), count: range.count + 1 }
    : range, { min: Infinity, max: -Infinity, count: 0 });
}

// Keep first/last/min/max in every contiguous bucket, with a bounded output.
function sampleIndices(values: Reading[], limit: number): number[] {
  const valid = values.reduce<number[]>((indices, value, index) => {
    if (finite(value)) indices.push(index);
    return indices;
  }, []);
  if (valid.length <= limit) return valid;
  const retained = new Set<number>([valid[0], valid[valid.length - 1]]);
  const buckets = Math.max(1, Math.floor((limit - 2) / 4));
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * valid.length / buckets);
    const end = Math.floor((bucket + 1) * valid.length / buckets);
    let low = valid[start];
    let high = low;
    for (let offset = start + 1; offset < end; offset += 1) {
      const index = valid[offset];
      if (values[index]! < values[low]!) low = index;
      if (values[index]! > values[high]!) high = index;
    }
    retained.add(valid[start]);
    retained.add(valid[end - 1]);
    retained.add(low);
    retained.add(high);
  }
  return Array.from(retained).sort((a, b) => a - b);
}

function gapCounts(values: Reading[]): Uint32Array {
  const counts = new Uint32Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) counts[index + 1] = counts[index] + (finite(values[index]) ? 0 : 1);
  return counts;
}

// An omitted missing row must still break the line between sampled readings.
function tracePath(indices: number[], values: Reading[], gaps: Uint32Array, x: (index: number) => number, y: (value: number) => number) {
  const commands: string[] = [];
  let previous = -1;
  for (const index of indices) {
    const value = values[index];
    if (!finite(value)) continue;
    const connected = previous >= 0 && gaps[index + 1] === gaps[previous + 1];
    commands.push(`${connected ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`);
    if (!connected) commands.push('l0.01,0'); // Round cap shows isolated readings.
    previous = index;
  }
  return commands.join(' ');
}

function timeline(timestamps: string[]): Timeline {
  const parsed = timestamps.map(timestamp => new Date(timestamp).getTime());
  const range = extent(parsed);
  const timed = range.count === timestamps.length && range.count > 0;
  const values = timed ? parsed : timestamps.map((_, index) => index);
  return {
    values, sorted: values.map((_, index) => index).sort((a, b) => values[a] - values[b]),
    start: timed ? range.min : 0, end: timed ? range.max : Math.max(0, timestamps.length - 1), timed,
  };
}

function fraction(axis: Timeline, index: number) {
  return axis.end === axis.start ? 0.5 : (axis.values[index] - axis.start) / (axis.end - axis.start);
}

function axisLabel(axis: Timeline, position: number) {
  const value = axis.start + position * (axis.end - axis.start);
  return axis.timed ? time(new Date(value).toISOString(), axis.end - axis.start >= 86_400_000) : `#${Math.round(value) + 1}`;
}

function nearestIndex(axis: Timeline, position: number) {
  if (!axis.sorted.length) return 0;
  const target = axis.start + Math.min(1, Math.max(0, position)) * (axis.end - axis.start);
  let low = 0;
  let high = axis.sorted.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (axis.values[axis.sorted[middle]] < target) low = middle + 1;
    else high = middle;
  }
  const next = axis.sorted[low];
  const previous = axis.sorted[Math.max(0, low - 1)];
  return Math.abs(axis.values[previous] - target) <= Math.abs(axis.values[next] - target) ? previous : next;
}

function prepareSeries(points: Point[], key: string | undefined, score: boolean) {
  const values: Reading[] = points.map(point => {
    const reading = score ? point.risk : key ? point.values[key] : null;
    return finite(reading) ? reading : null;
  });
  const anomalies = values.map((value, index) => points[index].anomaly ? value : null);
  return {
    values, range: extent(values), gaps: gapCounts(values),
    indices: sampleIndices(values, MAX_TRACE_POINTS), markers: sampleIndices(anomalies, MAX_MARKERS),
    anomalyCount: extent(anomalies).count, axis: timeline(points.map(point => point.timestamp)),
    cut: points.findIndex(point => point.split === 'monitoring'),
  };
}

export function Sparkline({ data, color = '#62dbb4', width = 94, height = 28, label = 'Observed risk trend' }: {
  data: number[]; color?: string; width?: number; height?: number; label?: string;
}) {
  const plot = useMemo(() => {
    const values = data.map(value => finite(value) ? value : null);
    return { values, range: extent(values), gaps: gapCounts(values), indices: sampleIndices(values, 160) };
  }, [data]);
  if (plot.range.count < 2) return <span className="muted">—</span>;
  const span = Math.max(10, plot.range.max - plot.range.min);
  const x = (index: number) => index / Math.max(1, data.length - 1) * width;
  const y = (value: number) => height - 3 - (value - plot.range.min) / span * (height - 6);
  const d = tracePath(plot.indices, plot.values, plot.gaps, x, y);
  const sampled = plot.indices.length < plot.range.count;
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={label} role="img">
    <title>{sampled ? `${label}. Trend sampled: ${plot.indices.length} of ${plot.range.count} readings; bucket extrema retained.` : label}</title>
    <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>;
}

const FLEET_KEYS = ['healthy', 'warning', 'critical', 'unknown'] as const;
const FLEET_COLORS = ['#62dbb4', '#f5bf70', '#f27a88', '#8c9fae'];
export function FleetChart({ data, total }: { data: Dashboard['trend']; total: number }) {
  const id = useId().replaceAll(':', '');
  const plot = useMemo(() => {
    const values = FLEET_KEYS.map(key => data.map(point => point[key]));
    const indices = Array.from(new Set(values.flatMap(series => sampleIndices(series, 300)))).sort((a, b) => a - b);
    return { values, indices, axis: timeline(data.map(point => point.timestamp)) };
  }, [data]);
  const W = 760, H = 192, L = 30, R = 12, T = 20, B = 32;
  const x = (index: number) => L + fraction(plot.axis, index) * (W - L - R);
  const y = (value: number) => T + (1 - value / Math.max(1, total)) * (H - T - B);
  const countTicks = Array.from(new Set(TICKS.map(value => Math.round(value * Math.max(0, total)))));
  const paths = plot.values.map(values => tracePath(plot.indices, values, gapCounts(values), x, y));
  const sampled = plot.indices.length < data.length;
  return <div className="fleet-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Healthy, warning, critical and unassessed trainsets over the observation window">
    <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#62dbb4" stopOpacity=".19"/><stop offset="1" stopColor="#62dbb4" stopOpacity="0"/></linearGradient></defs>
    {countTicks.map(value => <g key={value}><line x1={L} x2={W - R} y1={y(value)} y2={y(value)} stroke="rgba(150,177,190,.08)" strokeDasharray="3 5"/><text x={L - 10} y={y(value) + 4} textAnchor="end" fill="#738797" fontSize="10">{value}</text></g>)}
    {data.length > 0 && <>
      <path d={`${paths[0]} L${x(plot.indices.at(-1) ?? 0)},${y(0)} L${x(plot.indices[0] ?? 0)},${y(0)}Z`} fill={`url(#${id})`}/>
      {FLEET_KEYS.map((key, index) => <path key={key} d={paths[index]} stroke={FLEET_COLORS[index]} strokeWidth={index === 0 ? 2.4 : 1.6} strokeDasharray={key === 'unknown' ? '5 4' : undefined} fill="none" strokeLinejoin="round" strokeLinecap="round"/>)}
      {TICKS.map(value => <text key={value} x={L + value * (W - L - R)} y={H - 6} textAnchor={value === 0 ? 'start' : value === 1 ? 'end' : 'middle'} fill="#8295a5" fontSize="10">{axisLabel(plot.axis, value)}</text>)}
    </>}
  </svg><div className="chart-legend">{FLEET_KEYS.map((key, index) => <span key={key}><i style={{ background: FLEET_COLORS[index] }}/>{key === 'unknown' ? 'No assessment' : key[0].toUpperCase() + key.slice(1)}</span>)}<small>{plot.axis.timed ? 'UTC · elapsed time' : 'Observation order · timestamps unavailable'}</small></div>
    {sampled && <p className="panel-footnote">Plot sampled: {number(plot.indices.length)} of {number(data.length)} windows; condition extrema retained in each bucket.</p>}
  </div>;
}

export function SensorChart({ points, feature, score = false }: { points: Point[]; feature?: SensorEvidence; score?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = useMemo(() => prepareSeries(points, feature?.key, score), [points, feature?.key, score]);
  const W = 850, H = 270, L = 58, R = 20, T = 36, B = 42;
  if (!plot.range.count) return <div className="empty-chart">No valid readings are available for this sensor.</div>;
  const baseline = !score && finite(feature?.baseline) ? feature.baseline : null;
  const low = score ? 0 : Math.min(plot.range.min, baseline ?? Infinity);
  const high = score ? 100 : Math.max(plot.range.max, baseline ?? -Infinity);
  const pad = score ? 0 : Math.max((high - low) * 0.15, Math.abs(high) * 0.01, 0.05);
  const min = low - pad, max = high + pad;
  const x = (index: number) => L + fraction(plot.axis, index) * (W - L - R);
  const y = (value: number) => T + (1 - (value - min) / (max - min || 1)) * (H - T - B);
  const d = tracePath(plot.indices, plot.values, plot.gaps, x, y);
  const selectedIndex = hover == null ? null : Math.min(hover, points.length - 1);
  const selected = selectedIndex == null ? null : points[selectedIndex];
  const hoverValue = selectedIndex == null ? null : plot.values[selectedIndex];
  const sampled = plot.indices.length < plot.range.count;
  const markersSampled = plot.markers.length < plot.anomalyCount;
  const missingCount = points.length - plot.range.count;
  return <div className="sensor-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
    aria-label={`${score ? 'Risk index' : feature?.label} over ${plot.axis.timed ? 'elapsed time' : 'observation order'}, with detected anomalies marked in coral. Arrow keys inspect observations; Home and End select the endpoints.`}
    onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setHover(current => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
        : Math.max(0, Math.min(points.length - 1, (current ?? 0) + (event.key === 'ArrowRight' ? 1 : -1))));
    }}
    onMouseMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = (event.clientX - rect.left) / rect.width * W;
      setHover(nearestIndex(plot.axis, (mouseX - L) / (W - L - R)));
    }}>
    {plot.cut > 0 && <><rect x={L} y={T} width={Math.max(0, x(plot.cut) - L)} height={H - T - B} fill="rgba(140,160,178,.035)"/><line x1={x(plot.cut)} x2={x(plot.cut)} y1={T - 4} y2={H - B} stroke="#465665" strokeDasharray="4 5"/><text x={L + 8} y={17} fill="#81919f" fontSize="10" letterSpacing="1">REFERENCE</text><text x={Math.min(x(plot.cut) + 10, W - R - 95)} y={17} fill="#81bdaa" fontSize="10" letterSpacing="1">MONITORING</text></>}
    {TICKS.map(value => <g key={value}><line x1={L} x2={W - R} y1={y(min + value * (max - min))} y2={y(min + value * (max - min))} stroke="rgba(150,177,190,.09)" strokeDasharray="3 5"/><text x={L - 12} y={y(min + value * (max - min)) + 4} textAnchor="end" fill="#8295a5" fontSize="10">{number(min + value * (max - min), score ? 0 : 1)}</text></g>)}
    {baseline != null && <><line x1={L} x2={W - R} y1={y(baseline)} y2={y(baseline)} stroke="#688196" strokeDasharray="5 6"/><text x={W - R} y={y(baseline) - 6} fill="#91a7b6" textAnchor="end" fontSize="9">reference median</text></>}
    <path d={d} stroke="#68d6b8" strokeWidth="1.9" fill="none" strokeLinecap="round"/>
    {plot.markers.map(index => <circle key={index} cx={x(index)} cy={y(plot.values[index]!)} r="2.5" fill="#f27a88"/>)}
    {TICKS.map(value => <text key={value} x={L + value * (W - L - R)} y={H - 12} fill="#8295a5" textAnchor={value === 0 ? 'start' : value === 1 ? 'end' : 'middle'} fontSize="10">{axisLabel(plot.axis, value)}</text>)}
    {selected && selectedIndex != null && <g><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={T} y2={H - B} stroke="#bdd6e4" strokeDasharray="3 3"/>{hoverValue != null && <circle cx={x(selectedIndex)} cy={y(hoverValue)} r="4" fill="#c6f9e6" stroke="#162c2b" strokeWidth="2"/>}<rect x={Math.min(x(selectedIndex) + 10, W - 185)} y={T + 8} width="160" height="53" fill="#16232e" stroke="#334852" rx="7"/><text x={Math.min(x(selectedIndex) + 21, W - 174)} y={T + 27} fill="#a2b6c4" fontSize="10">{plot.axis.timed ? `${time(selected.timestamp)} UTC` : `Observation #${selectedIndex + 1}`}</text><text x={Math.min(x(selectedIndex) + 21, W - 174)} y={T + 46} fill="#e9f6f5" fontSize="12">{hoverValue == null ? 'Missing reading' : `${number(hoverValue, 2)} ${score ? '/ 100' : feature?.unit ?? ''}`}</text></g>}
  </svg><div className="chart-legend"><span><i className="healthy"/>{score ? 'Risk index' : 'Sensor reading'}</span><span><i className="critical"/>Detected anomaly</span><small>{plot.axis.timed ? 'UTC · elapsed time' : 'Observation order · timestamps unavailable'} · {score ? 'Not failure probability' : feature?.unit || 'sensor units'}</small></div>
    {(sampled || markersSampled || missingCount > 0) && <p className="panel-footnote" style={{ display: 'block', lineHeight: 1.7 }}>
      {sampled && <>Plot sampled: {number(plot.indices.length)} of {number(plot.range.count)} valid readings; bucket extrema retained. </>}
      {markersSampled && <>Showing {number(plot.markers.length)} of {number(plot.anomalyCount)} plottable anomaly markers. </>}
      {missingCount > 0 && <>{number(missingCount)} missing readings remain gaps. </>}
      {(sampled || markersSampled) && <>Detector results are unchanged; hover or use arrow keys to inspect all observations.</>}
    </p>}
    <span className="sr-only" aria-live="polite">{selected && selectedIndex != null ? `Observation ${selectedIndex + 1}: ${time(selected.timestamp, true)} UTC, ${hoverValue == null ? 'missing reading' : number(hoverValue, 2)}, ${selected.anomaly ? 'detected anomaly' : 'not flagged'}.` : ''}</span>
  </div>;
}
