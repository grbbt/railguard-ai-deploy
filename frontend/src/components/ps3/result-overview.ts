import type { PredictionSummary } from './prediction-comparison';

export type ResultOverview = {
  label: string;
  value: string;
  description: string;
  limit: string;
  facts: { label: string; value: string }[];
};

/** Explain returned prediction fields without inventing severity or confidence. */
export function describePrediction(summary: PredictionSummary): ResultOverview {
  if (!summary.hasPrediction) {
    return {
      label: 'Result unavailable',
      value: 'No usable prediction',
      description: 'This file has no complete, recognised model output to display.',
      limit: 'An unavailable result does not mean the component is normal. Review the evidence and returned rows.',
      facts: [],
    };
  }

  if (summary.kind === 'actions') {
    const abnormal = summary.abnormalActions ?? 0;
    const total = summary.totalActions ?? 0;
    return {
      label: 'Door actions classified as abnormal resistance',
      value: `${abnormal} of ${total}`,
      description: abnormal === 0
        ? 'No classified action was labelled abnormal resistance.'
        : `${abnormal} candidate action${abnormal === 1 ? ' was' : 's were'} labelled abnormal resistance. Review these action intervals first.`,
      limit: 'Detected movement intervals, each with a start time, end time and class. Review boundaries against the recorded signal.',
      facts: [
        { label: 'Candidate actions', value: String(total) },
        { label: 'Normal classification', value: String(summary.normalActions ?? 0) },
        { label: 'Unclassified', value: String(summary.unknownActions ?? 0) },
      ],
    };
  }

  if (summary.kind === 'ranking') {
    const first = summary.ranking[0];
    const firstUnavailable = summary.unavailableCars.includes(first);
    const firstUnknown = summary.unknownEvidenceCars?.includes(first) ?? false;
    return {
      label: firstUnavailable ? 'First ranked car · evidence unavailable' : firstUnknown ? 'First ranked car · evidence not recorded' : 'First car to inspect',
      value: `Car ${first}`,
      description: firstUnavailable
        ? 'The model placed this car first, but its saved evidence is unavailable. Check the source data before using this inspection order.'
        : firstUnknown
          ? 'The saved output places this car first, but its evidence availability was not recorded. Check the source data before using this inspection order.'
          : 'The model ranks this car first for refrigerant-leakage investigation in this recording.',
      limit: 'Relative inspection order for this eight-car case; not a confirmed leak or a calibrated fault probability.',
      facts: [],
    };
  }

  if (summary.kind === 'class') {
    return {
      label: 'Rail corrugation classification',
      value: summary.railClass!,
      description: summary.railClass === 'Normal'
        ? 'The model assigned this recording to the Normal class.'
        : `The model assigned this recording to the ${summary.railClass} corrugation class.`,
      limit: 'Recording-level class. Side I / Side II identifies the source side; it does not identify a faulty axle, defect location or severity.',
      facts: [{ label: 'Prediction scope', value: 'Whole recording' }],
    };
  }

  return {
    label: 'Estimated cumulative fatigue damage',
    value: summary.damage!.toPrecision(6),
    description: 'The fitted model estimates cumulative damage from the stress recorded in this file.',
    limit: 'Cumulative damage over the recorded stress history, not failure probability or remaining life. No validated safety threshold is applied.',
    facts: [{ label: 'Prediction scope', value: 'Recorded stress history' }],
  };
}
