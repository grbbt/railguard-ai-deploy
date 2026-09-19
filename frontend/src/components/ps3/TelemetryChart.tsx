'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Activity, MoveHorizontal } from 'lucide-react';
import type { SubsystemId, Trace } from '@/lib/ps3-types';
import { nearestTelemetryPoint, prepareTelemetry, telemetryBridges, telemetryDomain, telemetryNumber, telemetryPath } from './telemetry-chart';
import './telemetry-chart.css';

const HEIGHT = 248, LEFT = 76, RIGHT = 18, TOP = 20, BOTTOM = 40;
const COLORS: Record<SubsystemId, string> = { door: '#67e8f9', acv: '#5eead4', rail: '#b6a0ff', shm: '#c4b5fd' };

function sourceLabel(value: string | number) {
  return typeof value === 'number' ? telemetryNumber(value) : value;
}

export type TelemetryChartProps = {
  series: Trace;
  subsystem?: SubsystemId;
  /** Match the report's documented reduction; never infer full-waveform statistics from a preview. */
  preview?: 'sampled' | 'envelope';
};

export default function TelemetryChart({ series, subsystem, preview }: TelemetryChartProps) {
  const [selection, setSelection] = useState(0);
  const [continuous, setContinuous] = useState(true);
  const [width, setWidth] = useState(680);
  const plotRef = useRef<HTMLDivElement>(null);
  const uid = useId().replaceAll(':', '');
  const data = useMemo(() => prepareTelemetry(series), [series]);
  const bridges = useMemo(() => telemetryBridges(data.runs), [data.runs]);
  const envelope = preview === 'envelope' || (preview === undefined && (subsystem === 'shm' || subsystem === 'rail' || /min.max envelope/i.test(series.name)));
  const color = subsystem ? COLORS[subsystem] : '#7dd3fc';
  const discrete = /\b(state|status|command)\b/i.test(series.name);
  const hasMeasurements = data.points.length > 0;
  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(240, Math.min(1000, Math.round(element.getBoundingClientRect().width))));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMeasurements]);
  if (!data.points.length || !data.stats) return <figure className="telemetry-chart telemetry-chart-empty"><figcaption>{series.name}</figcaption><p>No finite measurements were returned for this signal.</p></figure>;
  const { points, runs, missing, stats } = data;
  const selectedIndex = Math.min(selection, points.length - 1), selected = points[selectedIndex];
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const yDomain = discrete && points.every(point => point.y === 0 || point.y === 1) ? { min: -.1, max: 1.1, ticks: [0, 1], step: 1 } : telemetryDomain(stats.min, stats.max);
  const xScale = Math.max(Math.abs(minX), Math.abs(maxX), 1);
  const yScale = Math.max(Math.abs(yDomain.min), Math.abs(yDomain.max), Number.MIN_VALUE);
  const x = (value: number) => minX === maxX ? (LEFT + width - RIGHT) / 2 : LEFT + (value / xScale - minX / xScale) / (maxX / xScale - minX / xScale) * (width - LEFT - RIGHT);
  const y = (value: number) => TOP + (yDomain.max / yScale - value / yScale) / (yDomain.max / yScale - yDomain.min / yScale) * (HEIGHT - TOP - BOTTOM);
  const line = (run: typeof points) => telemetryPath(run, x, y, discrete);
  const intervals = width < 420 ? 2 : width < 620 ? 3 : 4;
  const xTicks = minX === maxX ? [minX] : Array.from({ length: intervals + 1 }, (_, index) => minX * (1 - index / intervals) + maxX * index / intervals);
  const numericX = points.every(point => typeof point.sourceX === 'number' || Number.isFinite(Number(point.sourceX)));
  const dateLabel = (value: number) => {
    const label = String(points[nearestTelemetryPoint(points, value)].sourceX);
    // Retain the supplied source clock instead of converting timestamps to the browser timezone.
    return label.includes('T') ? label.split('T')[1].slice(0, 8) : label.split(' ')[1]?.slice(0, 8) ?? label.slice(0, 10);
  };
  return <figure className="telemetry-chart" style={{ '--telemetry-accent': color } as CSSProperties}>
    <figcaption id={`${uid}-title`} className="telemetry-chart-heading"><div><span className="telemetry-chart-kicker"><Activity size={13}/>MEASURED SIGNAL</span><strong>{series.name}</strong></div><span className="telemetry-chart-badge">{envelope ? 'Min/max envelope' : 'Signal preview'}</span></figcaption>
    <div className="telemetry-chart-display"><div className="telemetry-chart-unit">{series.y_label}</div>{bridges.length > 0 && <div className="telemetry-chart-display-options" role="group" aria-label={`Line display for ${series.name}`}><button type="button" aria-pressed={continuous} onClick={() => setContinuous(true)}>Continuous</button><button type="button" aria-pressed={!continuous} onClick={() => setContinuous(false)}>Preserve gaps</button></div>}</div>
    <div className="telemetry-chart-plot" ref={plotRef}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby={`${uid}-title ${uid}-description`} onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const positionX = (event.clientX - rect.left) / rect.width * width;
        const positionY = (event.clientY - rect.top) / rect.height * HEIGHT;
        if (positionX < LEFT || positionX > width - RIGHT || positionY < TOP || positionY > HEIGHT - BOTTOM) return;
        const xFraction = (positionX - LEFT) / (width - LEFT - RIGHT), yFraction = (positionY - TOP) / (HEIGHT - TOP - BOTTOM);
        const desiredX = minX * (1 - xFraction) + maxX * xFraction;
        const desiredY = yDomain.max * (1 - yFraction) + yDomain.min * yFraction;
        setSelection(nearestTelemetryPoint(points, desiredX, desiredY));
      }}>
        <desc id={`${uid}-description`}>{points.length} finite retained points. {series.x_label} on the horizontal axis; {series.y_label} on the vertical axis. Use the point inspector below for exact readings. {continuous ? 'Solid lines show measured runs. Dashed bridges connect their endpoints across missing or masked readings and recording breaks for display only; no readings are estimated.' : 'Gaps preserve missing or masked readings and recording breaks.'}</desc>
        <defs><linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".2"/><stop offset="100%" stopColor={color} stopOpacity=".015"/></linearGradient><clipPath id={`${uid}-clip`}><rect x={LEFT} y={TOP} width={width - LEFT - RIGHT} height={HEIGHT - TOP - BOTTOM}/></clipPath></defs>
        {yDomain.ticks.map(value => <g key={value}><line x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} className={value === 0 ? 'telemetry-grid telemetry-grid-zero' : 'telemetry-grid'}/><text x={LEFT - 12} y={y(value) + 4} textAnchor="end">{telemetryNumber(value, yDomain.step)}</text></g>)}
        {xTicks.map((value, index) => <g key={value}><line x1={x(value)} x2={x(value)} y1={TOP} y2={HEIGHT - BOTTOM} className="telemetry-grid telemetry-grid-vertical"/><text x={x(value)} y={HEIGHT - 18} textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}>{numericX ? telemetryNumber(value, (maxX - minX) / 4 || undefined) : dateLabel(value)}</text></g>)}
        <g clipPath={`url(#${uid}-clip)`}>{continuous && bridges.map((bridge, index) => <path key={`bridge-${index}`} d={telemetryPath(bridge, x, y)} className="telemetry-signal telemetry-gap-bridge" stroke={color}/>)}{runs.map((run, index) => <g key={index}>{run.length > 1 ? <><path d={`${line(run)} L${x(run.at(-1)!.x)},${HEIGHT - BOTTOM} L${x(run[0].x)},${HEIGHT - BOTTOM} Z`} fill={`url(#${uid}-fill)`}/><path d={line(run)} className="telemetry-signal" stroke={color}/></> : !continuous && <circle cx={x(run[0].x)} cy={y(run[0].y)} r="2" fill="none" stroke={color} strokeWidth="1.3"/>}</g>)}
          <line x1={x(selected.x)} x2={x(selected.x)} y1={TOP} y2={HEIGHT - BOTTOM} className="telemetry-crosshair"/><line x1={LEFT} x2={width - RIGHT} y1={y(selected.y)} y2={y(selected.y)} className="telemetry-crosshair telemetry-crosshair-horizontal"/>
          <circle cx={x(selected.x)} cy={y(selected.y)} r="7" fill={color} opacity=".15"/><circle cx={x(selected.x)} cy={y(selected.y)} r="3.5" fill="#f7fbff" stroke={color} strokeWidth="2"/>
        </g>
      </svg>
    </div>
    <p className="telemetry-chart-x-label">{series.x_label}</p>
    <dl className="telemetry-chart-statistics" aria-label="Statistics of displayed points"><div><dt>Preview minimum</dt><dd>{telemetryNumber(stats.min)}</dd></div><div><dt>Preview maximum</dt><dd>{telemetryNumber(stats.max)}</dd></div><div><dt>Preview mean</dt><dd>{telemetryNumber(stats.mean)}</dd></div></dl>
    <div className="telemetry-chart-inspector"><span><MoveHorizontal size={14}/>Point {selectedIndex + 1} / {points.length.toLocaleString()}</span><strong>{telemetryNumber(selected.y)}<small>{series.y_label}</small></strong><span>{series.x_label}: <b>{sourceLabel(selected.sourceX)}</b></span></div>
    <label className="telemetry-chart-slider"><span className="sr-only">Inspect measured points in {series.name}</span><input type="range" min={0} max={points.length - 1} value={selectedIndex} onChange={event => setSelection(Number(event.target.value))} aria-valuetext={`${series.x_label}: ${sourceLabel(selected.sourceX)}; ${series.y_label}: ${telemetryNumber(selected.y)}`} /></label>
    <p className="telemetry-chart-footnote">{continuous && bridges.length > 0 ? 'Dashed links cross source gaps for display only; no readings are estimated. ' : missing > 0 ? 'Missing/masked readings and recording breaks remain gaps. ' : ''}{discrete ? 'Controller states use a step display. ' : envelope ? 'Envelope extrema retain source order. ' : ''}Statistics use only retained measurements; see evidence for full-recording measurements.</p>
  </figure>;
}
