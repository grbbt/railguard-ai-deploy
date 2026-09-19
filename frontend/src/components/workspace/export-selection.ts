import type { Ps3Job, SubsystemId } from '@/lib/ps3-types';

export type ExportChoice = { jobId: string; fileIds: string[]; unavailableReason?: string };
export type ExportChoices = Partial<Record<SubsystemId, ExportChoice>>;
export type ExportPlan = {
  selections: { job_id: string; file_ids: string[] }[];
  fileCount: number;
  rowCount: number;
  outputs: { subsystem: SubsystemId; filename: string; fileCount: number; rowCount: number }[];
  problems: string[];
  selectedJobs: Ps3Job[];
};

const SUBSYSTEMS: SubsystemId[] = ['door', 'acv', 'rail', 'shm'];

/** Establish the initial basket once; later refreshes must retain its pinned run IDs. */
export function defaultExportChoices(jobs: readonly Ps3Job[]): ExportChoices {
  const choices: ExportChoices = {};
  for (const job of jobs) {
    if (!SUBSYSTEMS.includes(job.subsystem) || job.status !== 'completed' || choices[job.subsystem]) continue;
    const reports = Array.isArray(job.reports) ? job.reports : [];
    const validReports = reports.filter(report => report && typeof report.file_id === 'string' && report.file_id && report.subsystem === job.subsystem);
    const invalid = !Array.isArray(job.reports) || reports.length === 0 || validReports.length !== reports.length;
    choices[job.subsystem] = {
      jobId: job.id,
      fileIds: validReports.map(report => report.file_id),
      ...(invalid ? { unavailableReason: 'The saved file reports are invalid. Choose another run or remove this subsystem from the export.' } : {}),
    };
  }
  return choices;
}

/** Preview exactly the requested sources, without replacing stale choices with all files. */
export function buildExportPlan(choices: ExportChoices, jobs: Readonly<Record<string, Ps3Job>>): ExportPlan {
  const plan: ExportPlan = { selections: [], fileCount: 0, rowCount: 0, outputs: [], problems: [], selectedJobs: [] };
  for (const key of Object.keys(choices)) {
    if (!SUBSYSTEMS.includes(key as SubsystemId)) plan.problems.push(`Unknown export subsystem: ${key}.`);
  }
  for (const subsystem of SUBSYSTEMS) {
    const choice = choices[subsystem];
    if (choice === undefined) continue;
    const label = subsystem.toUpperCase();
    if (!choice || !Array.isArray(choice.fileIds)) {
      plan.problems.push(`${label}: the file selection is invalid. Choose the files again.`);
      continue;
    }
    if (choice.unavailableReason) {
      plan.problems.push(`${label}: ${choice.unavailableReason}`);
      continue;
    }
    if (choice.fileIds.length === 0) continue;
    if (typeof choice.jobId !== 'string' || !choice.jobId) {
      plan.problems.push(`${label}: choose a saved run before exporting.`);
      continue;
    }
    const job = jobs[choice.jobId];
    if (!job) {
      plan.problems.push(`${label}: the selected run is unavailable. Refresh or choose another run.`);
      continue;
    }
    if (job.id !== choice.jobId || job.subsystem !== subsystem) {
      plan.problems.push(`${label}: the selected run does not match this subsystem.`);
      continue;
    }
    if (job.status !== 'completed') {
      plan.problems.push(`${label}: the selected run must complete before export.`);
      continue;
    }
    if (choice.fileIds.some(id => typeof id !== 'string' || !id) || new Set(choice.fileIds.map(id => typeof id === 'string' ? id.toLowerCase() : id)).size !== choice.fileIds.length) {
      plan.problems.push(`${label}: select each source file only once using its saved filename.`);
      continue;
    }
    if (!Array.isArray(job.reports) || job.reports.some(report => !report || typeof report.file_id !== 'string' || !report.file_id || report.subsystem !== subsystem)) {
      plan.problems.push(`${label}: the saved file reports are invalid. Run the source again.`);
      continue;
    }
    if (new Set(job.reports.map(report => report.file_id.toLowerCase())).size !== job.reports.length) {
      plan.problems.push(`${label}: the saved run contains ambiguous source filenames. Run the source again.`);
      continue;
    }
    const reportIds = new Set(job.reports.map(report => report.file_id));
    const missing = choice.fileIds.filter(id => !reportIds.has(id));
    if (missing.length > 0) {
      plan.problems.push(`${label}: ${missing.length} selected file${missing.length === 1 ? ' is' : 's are'} no longer in this run. Review the selection.`);
      continue;
    }
    const selectedIds = new Set(choice.fileIds);
    const reports = job.reports.filter(report => selectedIds.has(report.file_id));
    if (subsystem === 'door' && reports.length > 1) {
      plan.problems.push('DOOR: the official export requires one continuous recording. Select only one Door file.');
      continue;
    }
    if (reports.some(report => !Array.isArray(report.prediction_rows) || report.prediction_rows.length === 0)) {
      plan.problems.push(`${label}: a selected file has no prediction rows. Run the source again.`);
      continue;
    }
    const rowCount = reports.reduce((total, report) => total + report.prediction_rows.length, 0);
    plan.selections.push({ job_id: job.id, file_ids: reports.map(report => report.file_id) });
    plan.outputs.push({ subsystem, filename: `${subsystem}_predictions.csv`, fileCount: reports.length, rowCount });
    plan.selectedJobs.push(job);
    plan.fileCount += reports.length;
    plan.rowCount += rowCount;
  }
  return plan;
}
