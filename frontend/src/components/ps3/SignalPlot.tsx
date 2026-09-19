'use client';

import { useId, useState } from 'react';
import type { Trace } from '@/lib/ps3-types';
import { displayValue } from './shared';

const WIDTH = 780, HEIGHT = 225, LEFT = 64, RIGHT = 20, TOP = 20, BOTTOM = 42;
function coordinate(value: string | number) {
  if (typeof value === 'number') return value;
  if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return Date.parse(value);
}
function xLabel(value: string | number) { return typeof value === 'number' ? displayValue(value, 2) : value; }

export default function SignalPlot({ series }: { series: Trace }) {
  const [selected, setSelected] = useState(0);
  const titleId = useId();
  const points = series.points.map(point => ({ ...point, xNumber: coordinate(point.x) }));
  const valid = points.filter(point => Number.isFinite(point.xNumber) && point.y !== null && Number.isFinite(point.y));
  if (!valid.length) return <div className="ps3-chart-empty">No finite values are available for {series.name}.</div>;
  const domain = valid.reduce((bounds, point) => ({ minX: Math.min(bounds.minX, point.xNumber), maxX: Math.max(bounds.maxX, point.xNumber), minY: Math.min(bounds.minY, point.y!), maxY: Math.max(bounds.maxY, point.y!) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const spread = domain.maxY - domain.minY || Math.max(Math.abs(domain.minY) * 0.1, 1);
  const minY = domain.minY - spread * 0.12, maxY = domain.maxY + spread * 0.12;
  const x = (value: number) => LEFT + (value - domain.minX) / (domain.maxX - domain.minX || 1) * (WIDTH - LEFT - RIGHT);
  const y = (value: number) => HEIGHT - BOTTOM - (value - minY) / (maxY - minY) * (HEIGHT - TOP - BOTTOM);
  const path = points.map((point, index) => {
    if (point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.xNumber)) return '';
    const previous = points[index - 1];
    const command = previous && previous.y !== null && Number.isFinite(previous.y) && Number.isFinite(previous.xNumber) ? 'L' : 'M';
    return `${command}${x(point.xNumber).toFixed(2)},${y(point.y).toFixed(2)}`;
  }).join(' ');
  const focus = points[Math.min(selected, points.length - 1)];
  const showFocus = focus && focus.y !== null && Number.isFinite(focus.y) && Number.isFinite(focus.xNumber);
  return <figure className="ps3-signal">
    <figcaption id={titleId}><strong>{series.name}</strong><span>{series.y_label}</span></figcaption>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={titleId} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const desired = domain.minX + (((event.clientX - rect.left) / rect.width * WIDTH - LEFT) / (WIDTH - LEFT - RIGHT)) * (domain.maxX - domain.minX);
      const nearest = points.reduce((best, point, index) => Number.isFinite(point.xNumber) && Math.abs(point.xNumber - desired) < Math.abs(points[best].xNumber - desired) ? index : best, Math.max(0, points.findIndex(point => Number.isFinite(point.xNumber))));
      setSelected(nearest);
    }}>
      {[0, 0.25, 0.5, 0.75, 1].map(fraction => { const value = minY + (maxY - minY) * fraction; return <g key={fraction}><line x1={LEFT} x2={WIDTH - RIGHT} y1={y(value)} y2={y(value)} className="ps3-grid-line"/><text x={LEFT - 10} y={y(value) + 4} textAnchor="end">{displayValue(value, 2)}</text></g>; })}
      <path d={path} fill="none" stroke="#7bdbb5" strokeWidth="1.8" vectorEffect="non-scaling-stroke"/>
      {valid.length === 1 && <circle cx={x(valid[0].xNumber)} cy={y(valid[0].y!)} r="3" fill="#7bdbb5"/>}
      {showFocus && <g><line x1={x(focus.xNumber)} x2={x(focus.xNumber)} y1={TOP} y2={HEIGHT - BOTTOM} stroke="#a7d6c1" strokeDasharray="3 5" opacity=".5"/><circle cx={x(focus.xNumber)} cy={y(focus.y!)} r="4" fill="#e8fff3" stroke="#5ec599" strokeWidth="2"/></g>}
      <text x={LEFT} y={HEIGHT - 20}>{xLabel(valid[0].x)}</text><text x={WIDTH - RIGHT} y={HEIGHT - 20} textAnchor="end">{xLabel(valid[valid.length - 1].x)}</text>
    </svg>
    <div className="ps3-chart-reading"><span>{series.x_label}: <strong>{focus ? xLabel(focus.x) : '—'}</strong></span><span>{series.y_label}: <strong>{displayValue(focus?.y)}</strong></span></div>
    <label className="ps3-chart-slider"><span className="sr-only">Inspect a plotted point in {series.name}</span><input type="range" min={0} max={points.length - 1} value={Math.min(selected, points.length - 1)} onChange={event => setSelected(Number(event.target.value))} aria-valuetext={`${focus ? xLabel(focus.x) : ''}: ${displayValue(focus?.y)}`}/></label>
    <p className="ps3-chart-caption">Trace preview · {points.length.toLocaleString()} returned points. Missing values appear as gaps. See evidence for measurement coverage.</p>
  </figure>;
}
