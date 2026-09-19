import type { PredictionReport } from '@/lib/ps3-types';
import type { PredictionSummary } from '../ps3/prediction-comparison';

type Brief = { summary: string; mode: 'ai' | 'local'; cached: boolean; warning?: string };
export type FileSummary = Brief & { file_id: string; scope?: 'file' };
export type RunSummary = Brief & { scope: 'run'; file_count: number };
export type ResultBrief = FileSummary | RunSummary;
export type SummaryScope = 'current' | 'all';

/** Surface conditional input-validity limits without repeating generic report notes. */
export function summaryCaution(report: PredictionReport): string | null {
  const warnings = report.warnings.join(' ');
  const flags: string[] = [];
  if (report.subsystem === 'door') {
    if (warnings.includes('Observed cadence differs substantially from training')) flags.push('sampling differs from training');
    if (warnings.includes('Its true action count is unknown')) flags.push('the true movement count is unknown');
    if (warnings.includes('inferred segments contain fewer than three readings')) flags.push('some actions have too few readings');
  } else if (report.subsystem === 'shm') {
    if (warnings.includes('outside the observed training-target range')) flags.push('the estimate is outside the training range');
    if (warnings.includes('outside the validated equal-length setting')) flags.push('recording length differs from training');
    if (warnings.includes('No alternating stress cycles were counted')) flags.push('no alternating stress cycles were found');
  }
  return flags.length ? `Check input limits: ${flags.join('; ')}. Review the analysis notes before using this result.` : null;
}

/** Immediate readable result; generated wording must never delay the saved facts. */
export function instantSummary(result: PredictionSummary): string {
  if (!result.hasPrediction) return 'No complete prediction is available for this recording. Review the input and returned results before drawing a conclusion.';
  if (result.kind === 'actions') {
    const total = result.totalActions ?? 0, flagged = result.abnormalActions ?? 0, unknown = result.unknownActions ?? 0;
    if (unknown) return `Of ${total} detected door actions, ${flagged} were classified as abnormal resistance and ${unknown} are unclassified. Review the action times and signals before drawing a conclusion.`;
    return `${flagged} of ${total} detected door movements were flagged for abnormal resistance. ${flagged ? 'Start with the highlighted movements and compare their motor readings.' : 'The model classified every detected movement as Normal.'}`;
  }
  if (result.kind === 'ranking') {
    const first = result.ranking[0];
    if (result.unavailableCars.includes(first) || result.unknownEvidenceCars?.includes(first)) return `Car ${first} is first in the saved ordering; usable cooling measurements for this car are unavailable or unrecorded. Check the measurements before using this inspection order.`;
    const missing = result.unavailableCars.length + (result.unknownEvidenceCars?.length ?? 0);
    return missing ? `Car ${first} ranks first for cooling inspection. Measurements are missing or unrecorded for ${missing} of eight cars.` : `Car ${first} ranks first for cooling inspection. All eight cars have usable cooling readings.`;
  }
  if (result.kind === 'class') return result.railClass === 'Normal'
    ? 'The model classified this rail recording as Normal. Compare the vibration and shock measurements on both rail sides.'
    : `The model predicts ${result.railClass} rail corrugation. Start with the highlighted side and compare its vibration readings.`;
  return `Estimated cumulative fatigue damage is ${result.damage!.toPrecision(6)} for this recording. Review the stress measurements below; this value is not a damage percentage or remaining-life forecast.`;
}

/** Known measurement IDs and source units only; source prose is never an instruction. */
export function measuredSummary(report: PredictionReport, result: PredictionSummary): string {
  if (!result.hasPrediction) return '';
  function value(id: string, unit: string, signed = false) {
    const items = report.evidence.filter(item => item.id === id);
    const item = items.length === 1 ? items[0] : undefined;
    return item?.unit === unit && typeof item.value === 'number' && Number.isFinite(item.value) && (signed || item.value >= 0)
      ? Number(item.value.toPrecision(6)).toString() : null;
  }
  if (result.kind === 'actions') {
    for (let index = 0; index < report.prediction_rows.length; index++) {
      if (report.prediction_rows[index].prediction !== 'Abnormal resistance') continue;
      const current = value(`door-action-${index + 1}-current`, 'mA');
      const duration = value(`door-action-${index + 1}-duration`, 'seconds');
      if (current !== null) return `Flagged movement ${index + 1}: peak motor current about ${current} mA${duration !== null ? ` over ${duration} s` : ''}.`;
    }
    return '';
  }
  if (result.kind === 'ranking') {
    const car = result.ranking[0];
    if (result.unavailableCars.includes(car) || result.unknownEvidenceCars?.includes(car)) return '';
    const residual = value(`acv-car-${car}`, 'raw temperature units', true);
    return residual === null ? '' : `Its median cabin temperature minus target is about ${residual} raw temperature units.`;
  }
  if (result.kind === 'class') {
    const sides = result.railClass === 'Normal' ? [1, 2] : [result.railClass === 'Side I' ? 1 : 2];
    const readings = sides.map(side => ({ side, reading: value(`rail-side-${side}-vibration`, 'm/s²') })).filter(item => item.reading !== null);
    return readings.length ? `Typical vibration (median RMS): ${readings.map(item => `Side ${item.side === 1 ? 'I' : 'II'} about ${item.reading} m/s²`).join('; ')}.` : '';
  }
  const rms = value('shm-rms', 'raw stress units'), cycles = value('shm-cycles', 'cycles including half cycles');
  return [rms !== null ? `Stress level (RMS) is about ${rms} raw stress units.` : '', cycles !== null ? `The waveform contains about ${cycles} counted cycles, including half cycles.` : ''].filter(Boolean).join(' ');
}

/** Each file contributes one task result; no inferred cross-file asset identity. */
export function instantRunSummary(results: PredictionSummary[]): string {
  const count = results.length;
  if (!count) return 'No files are available in this analysis run.';
  if (new Set(results.map(item => item.subsystem)).size !== 1) return 'Choose a single system to compare the results from this run.';
  const valid = results.filter(item => item.hasPrediction);
  if (!valid.length) return `${count === 1 ? 'This file does' : `These ${count} files do`} not contain complete predictions. Review the returned results.`;
  const incomplete = count - valid.length;
  const missing = incomplete ? ` ${incomplete} file${incomplete === 1 ? ' has' : 's have'} incomplete predictions.` : '';
  const prefix = `Across ${count} file${count === 1 ? '' : 's'}`;
  if (valid[0].kind === 'actions') {
    const total = valid.reduce((sum, item) => sum + (item.totalActions ?? 0), 0);
    const flagged = valid.reduce((sum, item) => sum + (item.abnormalActions ?? 0), 0);
    const unknown = valid.reduce((sum, item) => sum + (item.unknownActions ?? 0), 0);
    const affected = valid.filter(item => (item.abnormalActions ?? 0) > 0).length;
    return `${prefix}, ${flagged} of ${total} detected door movements were flagged for abnormal resistance. ${affected} file${affected === 1 ? ' contains' : 's contain'} flagged movements.${unknown ? ` ${unknown} movement${unknown === 1 ? ' is' : 's are'} unclassified.` : ''}${missing}`;
  }
  if (valid[0].kind === 'class') {
    const classified = (label: string) => valid.filter(item => item.railClass === label).length;
    return `${prefix}, the model classified ${classified('Normal')} as Normal, ${classified('Side I')} as Side I corrugation and ${classified('Side II')} as Side II corrugation. Compare the affected sides and their vibration measurements.${missing}`;
  }
  if (valid[0].kind === 'ranking') {
    const covered = valid.filter(item => !item.unavailableCars.includes(item.ranking[0]) && !item.unknownEvidenceCars?.includes(item.ranking[0])).length;
    return `${prefix}, ${valid.length} cooling inspection ranking${valid.length === 1 ? ' is' : 's are'} available. ${covered} ${covered === 1 ? 'has' : 'have'} usable measurements for ${covered === 1 ? 'its' : 'their'} first-ranked car. Compare each recording’s first choice and cooling readings.${missing}`;
  }
  const values = valid.map(item => item.damage!);
  return `${prefix}, estimated fatigue damage ranges from ${Math.min(...values).toPrecision(6)} to ${Math.max(...values).toPrecision(6)}. These are separate recording estimates, not percentages or a combined lifetime total.${missing}`;
}

export function runSummaryKey(jobId: string, reports: PredictionReport[]): string {
  return JSON.stringify(['run', jobId, reports.map(report => summaryKey(jobId, report))]);
}

/** Identity includes result content so another run/file can never reuse its wording. */
export function summaryKey(jobId: string, report: PredictionReport): string {
  return JSON.stringify([jobId, report.file_id, report.subsystem, report.model_name, report.prediction_rows, report.entities, report.evidence, report.warnings]);
}

export function validSummary(value: unknown, fileId: string): value is FileSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FileSummary>;
  return item.file_id === fileId && (!item.scope || item.scope === 'file') && (item.mode === 'ai' || item.mode === 'local') && typeof item.summary === 'string'
    && !!item.summary.trim() && item.summary.length <= 900 && typeof item.cached === 'boolean'
    && (item.warning === undefined || typeof item.warning === 'string');
}

export function validRunSummary(value: unknown, fileCount: number): value is RunSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RunSummary>;
  return item.scope === 'run' && item.file_count === fileCount && !('file_id' in item)
    && (item.mode === 'ai' || item.mode === 'local') && typeof item.summary === 'string'
    && !!item.summary.trim() && item.summary.length <= 900 && typeof item.cached === 'boolean'
    && (item.warning === undefined || typeof item.warning === 'string');
}

/** Share in-flight work between mounts and keep provider failures briefly, not forever. */
export function createSummaryCache(now: () => number = Date.now) {
  const cache = new Map<string, { promise: Promise<ResultBrief>; expires: number }>();
  return {
    get(key: string, fetcher: () => Promise<ResultBrief>) {
      const existing = cache.get(key);
      if (existing && existing.expires > now()) return existing.promise;
      const entry = { promise: Promise.resolve().then(fetcher), expires: Infinity };
      cache.set(key, entry);
      while (cache.size > 64) cache.delete(cache.keys().next().value!);
      entry.promise.then(result => { entry.expires = now() + (result.mode === 'ai' ? 30 * 60_000 : 30_000); }, () => { if (cache.get(key) === entry) cache.delete(key); });
      return entry.promise;
    },
    forget(key: string) { cache.delete(key); },
  };
}
