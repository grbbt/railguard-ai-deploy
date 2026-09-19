import type { Evidence, PredictionReport, SubsystemId, Trace } from '@/lib/ps3-types';

export type RecordingTone = 'priority' | 'ranked' | 'unknown' | 'normal' | 'flagged' | 'context' | 'estimated';
export type RecordingTarget = {
  id: string; label: string; status: string; tone: RecordingTone; detail: string;
  evidence: Evidence[]; traces: Trace[]; carIndex?: number; carId?: string;
  side?: 1 | 2; position?: number; rank?: number; actionIndex?: number;
};
export type RecordingMapping = {
  subsystem: SubsystemId; hasReport: boolean; title: string; scope: string; note: string;
  targets: RecordingTarget[]; primary: RecordingTarget[]; defaultId: string;
  cars: { id: string; label: string; sourceId: string | null; tone: RecordingTone; index: number }[];
};

export const RECORDING_COLORS: Record<RecordingTone, string> = {
  priority: '#f0b86a', ranked: '#74b5be', unknown: '#647988', normal: '#76c7ad',
  flagged: '#eeac71', context: '#80bdd8', estimated: '#b1a3e4',
};

const META: Record<SubsystemId, Pick<RecordingMapping, 'title' | 'scope' | 'note'>> = {
  acv: { title: 'Cooling system', scope: 'Eight source cars · case-level ranking', note: 'The model ranks source cars for inspection; amber identifies the first supported rank. It does not identify a particular cooling unit or confirm a refrigerant leak. Geometry illustrates the system; source car IDs and measurements come from the selected recording.' },
  rail: { title: 'Axle-box sensor layout', scope: '8 cars · 64 positions · 128 vibration / shock channels', note: 'The model classifies the recording as Normal, Side I or Side II. Amber marks the predicted side; sensor markers show the documented layout, not per-axle faults or an exact track location. Geometry is illustrative.' },
  door: { title: 'Door mechanism', scope: 'One recording · detected actions', note: 'The model detects action intervals and classifies their resistance. Amber refers to the selected action, not a diagnosed internal part. The illustrated assembly is not a replay of measured motion and has no assigned train or car identity.' },
  shm: { title: 'Structural recording', scope: 'Recording-level cumulative damage estimate', note: 'The model estimates cumulative fatigue damage from the complete stress recording. The value is not a damage percentage or remaining useful life. The neutral frame is illustrative: physical location and severity thresholds are not established by this dataset.' },
};

function finiteValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function makeRecordingMapping(input: PredictionReport | null, subsystem: SubsystemId): RecordingMapping {
  const report = input?.subsystem === subsystem ? input : null;
  const evidence = report?.evidence ?? [], traces = report?.series ?? [];
  const targets: RecordingTarget[] = [];
  let cars: RecordingMapping['cars'] = [];
  if (subsystem === 'acv') {
    const candidate = report?.prediction_rows.length === 1 && typeof report.prediction_rows[0].ranked_cars === 'string' ? report.prediction_rows[0].ranked_cars.split('|') : [];
    const ranked = candidate.length === 8 && new Set(candidate).size === 8 && candidate.every(id => /^\d{2}$/.test(id)) ? candidate : [];
    const entities = (report?.entities ?? []).filter(entity => /^\d{2}$/.test(entity.id));
    const sourceIds = [...new Set([...entities.map(entity => entity.id), ...ranked])].sort();
    cars = Array.from({ length: 8 }, (_, index) => {
      const carId = sourceIds[index] ?? null;
      const entity = entities.find(value => value.id === carId);
      const available = entity?.status === 'ranked';
      const rankIndex = carId ? ranked.indexOf(carId) : -1;
      const rank = available && rankIndex >= 0 ? rankIndex + 1 : undefined;
      const tone: RecordingTone = !available ? 'unknown' : rank === 1 ? 'priority' : 'ranked';
      const id = carId ? `car-${carId}` : `layout-${index + 1}`;
      const label = carId ? `Car ${carId}` : `Car position ${index + 1}`;
      targets.push({ id, label, tone, carIndex: index, carId: carId ?? undefined, rank,
        status: !available ? 'Evidence unavailable' : rank ? `Inspection rank ${rank}` : 'Ranking available',
        detail: entity?.detail ?? 'No source car measurements are available for this position.',
        evidence: carId ? evidence.filter(item => item.id === `acv-car-${carId}` || item.id.endsWith(`-${carId}`)) : [],
        traces: carId ? traces.filter(trace => trace.name.startsWith(`Car ${carId} `)) : [],
      });
      return { id, label, sourceId: carId, tone, index };
    });
  } else if (subsystem === 'rail') {
    const predicted = report?.prediction_rows.length === 1 ? report.prediction_rows[0].prediction : undefined;
    for (const side of [1, 2] as const) {
      const label = side === 1 ? 'Side I' : 'Side II';
      const known = predicted === 'Normal' || predicted === 'Side I' || predicted === 'Side II';
      const flagged = predicted === label;
      targets.push({ id: `side-${side}`, label, side, tone: !known ? 'unknown' : flagged ? 'flagged' : 'context',
        status: !known ? 'Prediction unavailable' : flagged ? 'Predicted corrugation side' : 'Corrugation not predicted on this side',
        detail: `${side === 1 ? 'Odd positions 1, 3, 5, 7' : 'Even positions 2, 4, 6, 8'} across all eight cars. Side-level classification; no individual bearing diagnosis.`,
        evidence: evidence.filter(item => item.id.startsWith(`rail-side-${side}-`)),
        traces: traces.filter(trace => trace.name.startsWith(`${label}:`)),
      });
    }
    cars = Array.from({ length: 8 }, (_, index) => ({ id: `rail-car-${index + 1}`, label: `Car ${String(index + 1).padStart(2, '0')}`, sourceId: String(index + 1).padStart(2, '0'), tone: 'context', index }));
    for (const car of cars) for (let position = 1; position <= 8; position++) {
      const side = (position % 2 ? 1 : 2) as 1 | 2;
      const parent = targets[side - 1];
      targets.push({ id: `sensor-${car.index + 1}-${position}`, label: `${car.label} · position ${position}`, tone: 'context', status: 'Sensor layout · no individual prediction', carIndex: car.index, carId: car.sourceId ?? undefined, position, side,
        detail: `Vibration and shock channels at this source position belong to ${parent.label}. The evidence and traces below describe that rail side, not a diagnosed fault at this marker.`, evidence: parent.evidence, traces: parent.traces });
    }
  } else if (subsystem === 'door') {
    (report?.prediction_rows ?? []).forEach((row, index) => {
      const prediction = row.prediction;
      targets.push({ id: `action-${index + 1}`, label: `Action ${index + 1}`, actionIndex: index,
        tone: prediction === 'Normal' ? 'normal' : prediction === 'Abnormal resistance' ? 'flagged' : 'unknown',
        status: typeof prediction === 'string' ? prediction : 'Classification unavailable',
        detail: `${typeof row.start_time === 'string' ? row.start_time : 'Start unavailable'} → ${typeof row.end_time === 'string' ? row.end_time : 'End unavailable'}. Source clock; timezone unspecified.`,
        evidence: evidence.filter(item => item.id.startsWith(`door-action-${index + 1}-`)),
        traces,
      });
    });
  } else {
    const value = report?.prediction_rows.length === 1 ? finiteValue(report.prediction_rows[0].prediction) : null;
    const prediction = value !== null && value >= 0 ? value : null;
    targets.push({ id: 'recording', label: 'Complete stress recording', tone: prediction === null ? 'unknown' : 'estimated', status: prediction === null ? 'Estimate unavailable' : `Damage estimate ${prediction.toPrecision(5)}`,
      detail: 'Cumulative fatigue-damage regression using the complete stress recording. The measurements below summarize its recorded stress response.', evidence, traces });
  }
  const primary = subsystem === 'rail' ? targets.filter(item => item.position === undefined) : targets;
  return { subsystem, hasReport: Boolean(report), ...META[subsystem], targets, primary,
    defaultId: primary.find(item => item.tone === 'priority' || item.tone === 'flagged')?.id ?? primary[0]?.id ?? '', cars };
}

export function recordingSelection(mapping: RecordingMapping, requested: string): RecordingTarget | null {
  return mapping.targets.find(item => item.id === requested) ?? mapping.targets.find(item => item.id === mapping.defaultId) ?? null;
}

/** Changing the layout car must not silently change the selected rail side. */
export function recordingCarTarget(mapping: RecordingMapping, selected: RecordingTarget | null, index: number): string {
  const car = mapping.cars.find(item => item.index === index);
  if (!car) return mapping.defaultId;
  return mapping.subsystem === 'rail' ? `sensor-${index + 1}-${selected?.position ?? selected?.side ?? 1}` : car.id;
}

export function recordingAttention(mapping: RecordingMapping): { headline: string; note: string; targets: RecordingTarget[]; flagged: boolean } {
  if (!mapping.hasReport) return { headline: 'Choose a completed recording', note: 'The view will highlight only findings returned by the model.', targets: [], flagged: false };
  const targets = mapping.primary.filter(item => item.tone === 'flagged' || item.tone === 'priority');
  if (mapping.subsystem === 'door') {
    const known = mapping.primary.filter(item => item.tone === 'normal' || item.tone === 'flagged');
    return { headline: targets.length ? `${targets.length} of ${mapping.primary.length} actions need review` : known.length ? 'No abnormal-resistance actions predicted' : 'Door classification unavailable', note: 'Highlight refers to the selected action. The data does not identify a faulty part inside the door.', targets, flagged: targets.length > 0 };
  }
  if (mapping.subsystem === 'acv') return { headline: targets[0] ? `${targets[0].label} · first to inspect` : 'Inspection priority unavailable', note: 'The ranking identifies a car, not a particular cooling unit or a confirmed refrigerant leak.', targets, flagged: targets.length > 0 };
  if (mapping.subsystem === 'rail') return { headline: targets[0] ? `${targets[0].label} · corrugation predicted` : mapping.primary.some(item => item.tone === 'context') ? 'Normal rail classification' : 'Rail classification unavailable', note: 'The model predicts a rail side across the recording. Exact track position and individual axle faults are not identified.', targets, flagged: targets.length > 0 };
  const target = mapping.primary[0];
  return { headline: target?.status ?? 'Estimate unavailable', note: 'Recording-level estimate. No validated severity threshold or physical damage location is available.', targets: [], flagged: false };
}

/** Null or nonfinite readings break the line; they are never interpolated. */
export function finiteTraceRuns(trace: Trace): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const point of trace.points) {
    const x = typeof point.x === 'number' ? point.x : point.x.trim() && Number.isFinite(Number(point.x)) ? Number(point.x) : Date.parse(point.x);
    if (point.y === null || !Number.isFinite(point.y) || !Number.isFinite(x)) {
      if (current.length) runs.push(current);
      current = [];
    } else current.push({ x, y: point.y });
  }
  if (current.length) runs.push(current);
  return runs;
}
