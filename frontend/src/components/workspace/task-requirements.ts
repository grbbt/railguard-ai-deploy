import type { SubsystemId } from '@/lib/ps3-types';

/** Task definitions from the pinned PS3 specification, sections 2 and 5.2. */
export const TASK_REQUIREMENTS: Record<SubsystemId, { result: string; metric: string; file: string; review: string }> = {
  door: { result: 'Action timing + resistance class', metric: 'IoU-weighted F1', file: 'door_predictions.csv', review: 'Opening / closing intervals and motor-current evidence' },
  acv: { result: 'Eight-car inspection ranking', metric: 'Linear rank-decay', file: 'acv_predictions.csv', review: 'Cooling response and comparisons between source cars' },
  rail: { result: 'Normal / Side I / Side II', metric: 'Macro F1', file: 'rail_predictions.csv', review: 'Side-level vibration and shock measurements' },
  shm: { result: 'Cumulative fatigue damage', metric: 'max(0, 1 − MAPE)', file: 'shm_predictions.csv', review: 'Recorded stress history and fitted damage estimate' },
};

/** Measurement guidance from the installed subsystem Info Kits; units are never inferred. */
export const TASK_SIGNALS: Record<SubsystemId, { title: string; input: string; channels: string; interpretation: string; chartNote: string }> = {
  door: {
    title: 'Door action measurements',
    input: 'Continuous CSV · timestamp + controller measurements',
    channels: 'Motor current · voltage · back-EMF · leaf position · commands and motion states',
    interpretation: 'Review each predicted action against the recorded signal. One CSV row is one sensor reading; one result row is one detected action.',
    chartNote: 'Motor current in mA; voltage in source 10 mV units. Other units follow source labels. Controller states use a step display.',
  },
  acv: {
    title: 'Cooling response across eight cars',
    input: 'Excel workbook · eight cars · headers read from each case',
    channels: 'Cabin measurement · cooling-target exceedance · peer comparisons',
    interpretation: 'Read the car ranking alongside valid cooling measurements. Temperature scaling is undocumented, so plots preserve raw values.',
    chartNote: 'Hours from recording start. Comparisons use valid cooling observations; masked readings remain gaps.',
  },
  rail: {
    title: 'Axle-box vibration and shock',
    input: 'CSV · 129 columns · 10,000 samples over one second',
    channels: '8 cars · 64 positions · 128 acceleration channels · speed pulses',
    interpretation: 'Odd positions map to Side I; even positions map to Side II. Preview channels represent each side; the result classifies the recording.',
    chartNote: 'Acceleration in m/s². Envelopes preserve channel extrema; side RMS and speed use all 10,000 samples.',
  },
  shm: {
    title: 'Stress history and fatigue damage',
    input: 'Headerless CSV · one ordered dynamic-stress recording',
    channels: 'Ordered stress waveform · rainflow cycles · cumulative damage estimate',
    interpretation: 'Read the stress envelope against sample index. No recording duration, physical location or damage percentage is inferred.',
    chartNote: 'Sample index and raw stress units. The min/max envelope is a preview; all source samples contribute to model features.',
  },
};
