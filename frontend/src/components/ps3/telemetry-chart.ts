import type { Trace } from '@/lib/ps3-types';

export type TelemetryPoint = { x: number; y: number; sourceX: number | string; sourceIndex: number };
export type ChartDomain = { min: number; max: number; ticks: number[]; step: number };

/** Preserve numeric strings; timestamp coordinates are used only when actually supplied. */
export function traceCoordinate(value: string | number): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (!trimmed) return NaN;
  if (Number.isFinite(Number(trimmed))) return Number(trimmed);
  // Date.parse accepts arbitrary strings such as "3"; those are already handled above.
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed) ? Date.parse(trimmed) : NaN;
}

/** No sorting or interpolation: envelope extrema retain the source acquisition order. */
export function prepareTelemetry(trace: Trace) {
  const runs: TelemetryPoint[][] = [];
  const points: TelemetryPoint[] = [];
  let run: TelemetryPoint[] = [];
  let missing = 0;
  trace.points.forEach((point, sourceIndex) => {
    const x = traceCoordinate(point.x);
    if (!Number.isFinite(x) || point.y === null || !Number.isFinite(point.y)) {
      if (run.length) runs.push(run);
      run = [];
      missing++;
      return;
    }
    const item = { x, y: point.y, sourceX: point.x, sourceIndex };
    run.push(item);
    points.push(item);
  });
  if (run.length) runs.push(run);
  if (!points.length) return { runs, points, missing, stats: null };
  const min = Math.min(...points.map(point => point.y));
  const max = Math.max(...points.map(point => point.y));
  // Dividing first keeps the sum finite even for large finite sensor values.
  const mean = points.reduce((sum, point) => sum + point.y / points.length, 0);
  return { runs, points, missing, stats: { min, max, mean } };
}

/** Human-readable ticks, without collapsing small or constant engineering measurements. */
export function telemetryDomain(min: number, max: number, count = 4): ChartDomain {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return { min: 0, max: 1, ticks: [0, .25, .5, .75, 1], step: .25 };
  const scale = Math.max(Math.abs(min), Math.abs(max));
  // Normalise extreme finite magnitudes before padding/tick arithmetic to avoid overflow.
  if (scale > 1e100 || (scale > 0 && scale < 1e-100)) {
    const normal = telemetryDomain(min / scale, max / scale, count);
    const rescale = (value: number) => Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value * scale));
    let lower = rescale(normal.min), upper = rescale(normal.max);
    if (lower === upper) { lower = min - Number.MIN_VALUE; upper = max + Number.MIN_VALUE; }
    const ticks = [...new Set(normal.ticks.map(rescale))].filter(value => value >= lower && value <= upper);
    return { min: lower, max: upper, ticks: ticks.length > 1 ? ticks : [lower, upper], step: Math.max(Number.MIN_VALUE, rescale(normal.step)) };
  }
  const span = max - min;
  const padding = span > 0 ? span * .08 : Math.abs(min) * .05 || 1;
  const lower = min - padding, upper = max + padding;
  const rough = (upper - lower) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
  const domainMin = Math.floor(lower / step) * step;
  const domainMax = Math.ceil(upper / step) * step;
  const tickCount = Math.min(12, Math.round((domainMax - domainMin) / step));
  const ticks = [...new Set(Array.from({ length: tickCount + 1 }, (_, index) => Number((domainMin + index * step).toPrecision(15))))];
  return { min: domainMin, max: domainMax, ticks, step };
}

export function telemetryNumber(value: number, step?: number): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value === 0) return '0';
  const size = Math.abs(value);
  if (size >= 1_000_000 || size < .001) {
    const precision = step === undefined ? 3 : Math.min(10, Math.max(2, Math.ceil(Math.log10(size) - Math.log10(step)) + 1));
    return value.toExponential(precision).replace('e+', 'e');
  }
  const decimals = step === undefined ? Math.max(0, 4 - Math.floor(Math.log10(size))) : Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return value.toLocaleString('en-GB', { maximumFractionDigits: Math.min(10, decimals) });
}

/** Binary controller signals are displayed as held states, without sloping transitions. */
export function telemetryPath(points: TelemetryPoint[], x: (value: number) => number, y: (value: number) => number, discrete = false): string {
  return points.map((point, index) => {
    const here = `${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`;
    if (!index) return `M${here}`;
    return discrete ? `L${x(point.x).toFixed(2)},${y(points[index - 1].y).toFixed(2)} L${here}` : `L${here}`;
  }).join(' ');
}

/** Display-only bridges reference existing endpoints; no readings are inserted or estimated. */
export function telemetryBridges(runs: TelemetryPoint[][]): [TelemetryPoint, TelemetryPoint][] {
  const measured = runs.filter(run => run.length > 0);
  return measured.slice(1).map((run, index) => [measured[index].at(-1)!, run[0]]);
}

/** Keep the measurement kind selected when changing source car or rail side. */
export function telemetrySignalKey(name: string): string {
  return name.replace(/^Side (?:II|I): Car \d+ position \d+ /, '').replace(/^Car \d+ /, '');
}

export function telemetrySignalIndex(series: Trace[], preferred: string): number {
  const exact = series.findIndex(trace => telemetrySignalKey(trace.name) === preferred);
  return exact >= 0 ? exact : 0;
}

/** Return the retained point nearest the cursor; duplicate x values use y as a tie-breaker. */
export function nearestTelemetryPoint(points: TelemetryPoint[], x: number, y?: number): number {
  if (!points.length) return -1;
  return points.reduce((best, point, index) => {
    const distance = Math.abs(point.x - x), previous = Math.abs(points[best].x - x);
    return distance < previous || (distance === previous && y !== undefined && Math.abs(point.y - y) < Math.abs(points[best].y - y)) ? index : best;
  }, 0);
}
