import type { Ps3Status, SubsystemId } from '@/lib/ps3-types';

type SourceFile = { name: string; size: number };

export function prepareUploadFiles<T extends SourceFile>(subsystem: SubsystemId, previous: T[], incoming: T[], limits: Ps3Status['limits']) {
  const next = subsystem === 'door' ? incoming : [...previous, ...incoming];
  const extension = subsystem === 'acv' ? '.xlsx' : '.csv';
  const duplicate = next.find((file, index) => next.findIndex(other => other.name.toLowerCase() === file.name.toLowerCase()) !== index);
  const total = next.reduce((sum, file) => sum + file.size, 0);
  const error = !next.length ? 'Choose a data file to continue.'
    : next.some(file => !file.name.toLowerCase().endsWith(extension)) ? subsystem === 'acv'
      ? 'Choose .xlsx case workbooks for ACV. CSV files are not ACV workbooks.' : 'Choose .csv recordings for this subsystem.'
    : subsystem === 'door' && next.length !== 1 ? 'Choose one continuous Door stream per job. Its submission rows have no filename column.'
    : duplicate ? `Each source filename must be unique. Remove the duplicate ${duplicate.name}.`
    : next.length > limits.batch_files ? `This batch exceeds the ${limits.batch_files}-file limit.`
    : next.some(file => file.size === 0) ? 'Empty files cannot be analysed.'
    : next.some(file => file.size > limits.file_mb * 1024 ** 2) ? `A file exceeds the ${limits.file_mb} MB limit. Use the intact supported source recording.`
    : total > limits.batch_mb * 1024 ** 2 ? `This batch exceeds the ${limits.batch_mb} MB total limit.` : '';
  return { files: error ? previous : next, error };
}
