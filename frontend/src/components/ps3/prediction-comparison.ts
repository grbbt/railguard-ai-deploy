import type { PredictionReport, SubsystemId } from '@/lib/ps3-types';

export type PredictionSummary = {
  fileId: string;
  subsystem: SubsystemId;
  kind: 'actions' | 'ranking' | 'class' | 'damage';
  result: string;
  sortValue: number | null;
  ranking: string[];
  unavailableCars: string[];
  unknownEvidenceCars?: string[];
  normalActions: number | null;
  abnormalActions: number | null;
  unknownActions: number | null;
  totalActions: number | null;
  damage: number | null;
  railClass: 'Normal' | 'Side I' | 'Side II' | null;
  hasPrediction: boolean;
  warnings: number;
  evidenceCount: number;
};

export type ComparisonSort = 'filename' | 'result' | 'value-desc' | 'value-asc' | 'warnings-desc';

/** Compare returned outputs only; summary text and evidence do not replace predictions. */
export function summarizePrediction(report: PredictionReport): PredictionSummary {
  const rows = report.prediction_rows;
  const base: PredictionSummary = {
    fileId: report.file_id,
    subsystem: report.subsystem,
    kind: 'class',
    result: 'Prediction unavailable',
    sortValue: null,
    ranking: [],
    unavailableCars: [],
    normalActions: null,
    abnormalActions: null,
    unknownActions: null,
    totalActions: null,
    damage: null,
    railClass: null,
    hasPrediction: false,
    warnings: report.warnings.length,
    evidenceCount: report.evidence.length,
  };

  if (report.subsystem === 'door') {
    const normal = rows.filter(row => row.prediction === 'Normal').length;
    const abnormal = rows.filter(row => row.prediction === 'Abnormal resistance').length;
    const unknown = rows.length - normal - abnormal;
    const hasPrediction = normal + abnormal > 0;
    return {
      ...base,
      kind: 'actions',
      result: hasPrediction ? `${abnormal} abnormal / ${rows.length} candidate actions${unknown ? ` · ${unknown} unclassified` : ''}` : base.result,
      sortValue: hasPrediction ? abnormal : null,
      normalActions: normal,
      abnormalActions: abnormal,
      unknownActions: unknown,
      totalActions: rows.length,
      hasPrediction,
    };
  }

  // These three tasks return exactly one prediction for each source recording.
  const row = rows.length === 1 ? rows[0] : undefined;
  if (report.subsystem === 'acv') {
    const candidate = typeof row?.ranked_cars === 'string' ? row.ranked_cars.split('|') : [];
    const valid = candidate.length === 8 && new Set(candidate).size === 8 && candidate.every(car => /^\d{2}$/.test(car));
    const ranking = valid ? candidate : [];
    const unavailable = new Set((report.entities ?? []).filter(entity => entity.status === 'unavailable').map(entity => entity.id));
    const unavailableCars = ranking.filter(car => unavailable.has(car));
    const unknownEvidenceCars = ranking.filter(car => !unavailable.has(car) && (report.entities ?? []).find(entity => entity.id === car)?.status !== 'ranked');
    return {
      ...base,
      kind: 'ranking',
      result: valid ? `${ranking.map(car => `Car ${car}`).join(' → ')}${unavailableCars.length ? ' · unavailable evidence marked' : ''}` : base.result,
      ranking,
      unavailableCars,
      unknownEvidenceCars,
      hasPrediction: valid,
    };
  }

  if (report.subsystem === 'rail') {
    const label = row?.prediction;
    const railClass = label === 'Normal' || label === 'Side I' || label === 'Side II' ? label : null;
    return { ...base, railClass, result: railClass ?? base.result, hasPrediction: railClass !== null };
  }

  const value = row?.prediction;
  const damage = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    ...base,
    kind: 'damage',
    result: damage !== null ? `Estimated damage: ${damage.toPrecision(6)}` : base.result,
    damage,
    sortValue: damage,
    hasPrediction: damage !== null,
  };
}

const filenameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareFilename(a: PredictionSummary, b: PredictionSummary): number {
  return filenameOrder.compare(a.fileId, b.fileId) || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);
}

/** Filtering never mutates results or changes the source report's row order. */
export function selectComparisonRows(
  summaries: readonly PredictionSummary[],
  options: { query?: string; sort?: ComparisonSort } = {},
): PredictionSummary[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  const selected = summaries.filter(item => !query || `${item.fileId} ${item.result} ${item.subsystem}`.toLowerCase().includes(query));
  const sort = options.sort ?? 'filename';
  return selected.sort((a, b) => {
    if (sort === 'warnings-desc') return b.warnings - a.warnings || compareFilename(a, b);
    if (sort === 'result') {
      if (a.hasPrediction !== b.hasPrediction) return a.hasPrediction ? -1 : 1;
      return filenameOrder.compare(a.result, b.result) || compareFilename(a, b);
    }
    if (sort === 'value-asc' || sort === 'value-desc') {
      if (a.sortValue === null || b.sortValue === null) {
        if (a.sortValue !== b.sortValue) return a.sortValue === null ? 1 : -1;
      } else {
        const order = sort === 'value-asc' ? a.sortValue - b.sortValue : b.sortValue - a.sortValue;
        if (order) return order;
      }
    }
    return compareFilename(a, b);
  });
}
