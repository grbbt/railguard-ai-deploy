'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, CheckCheck, CircleAlert, FileCheck2, FolderOpen, LoaderCircle, Search, ShieldCheck, X } from 'lucide-react';
import type { Ps3Job, SubsystemId } from '@/lib/ps3-types';
import { downloadResult, jobTime, SUBSYSTEMS } from '@/components/ps3/shared';
import type { WorkspaceData } from './useWorkspace';
import { buildExportPlan, defaultExportChoices, type ExportChoices } from './export-selection';
import './export-panel.css';

function savedRecordings(job: Ps3Job | undefined) {
  return Array.isArray(job?.reports) ? job.reports.filter(report => report && typeof report.file_id === 'string') : [];
}

export default function ExportPanel({ data }: { data: WorkspaceData }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [queries, setQueries] = useState<Partial<Record<SubsystemId, string>>>({});
  const { exportChoices, libraryReady, bundle, jobErrors, setExportChoices } = data;
  const choices = data.exportChoices ?? {};
  const plan = buildExportPlan(choices, data.jobs);
  const initialising = data.exportChoices === null;
  const checking = plan.selections.some(selection => !data.exportJobReady(selection.job_id));
  const canExport = !initialising && data.libraryReady && !checking && !plan.problems.length && plan.fileCount > 0 && !data.transferring;
  const availableCount = Object.values(choices).reduce((sum, choice) => sum + savedRecordings(data.jobs[choice.jobId]).length, 0);
  const chosenJobs = Object.values(choices).map(choice => data.jobs[choice.jobId]).filter(job => job?.status === 'completed');
  const allChosenReady = chosenJobs.length > 0 && Object.values(choices).every(choice => data.exportJobReady(choice.jobId));

  useEffect(() => {
    if (exportChoices === null && libraryReady && !bundle.pending.length) {
      setExportChoices(previous => previous ?? defaultExportChoices(bundle.completed.filter(job => !jobErrors[job.id])));
    }
  }, [exportChoices, libraryReady, bundle, jobErrors, setExportChoices]);

  function change(update: (previous: ExportChoices) => ExportChoices) {
    if (busy) return;
    data.setExportChoices(previous => update(previous ?? {}));
    setNotice(''); setError('');
  }

  function selectFiles(subsystem: SubsystemId, ids: string[], include: boolean) {
    change(previous => {
      const choice = previous[subsystem];
      if (!choice) return previous;
      const next = new Set(choice.fileIds);
      ids.forEach(id => include ? next.add(id) : next.delete(id));
      return { ...previous, [subsystem]: { ...choice, fileIds: [...next], ...(!next.size ? { unavailableReason: undefined } : {}) } };
    });
  }

  async function download() {
    if (!canExport || busy) return;
    setBusy(true); setError(''); setNotice('');
    const selected = plan.selections;
    try {
      await downloadResult('/api/ps3/export', 'predictions.zip', { selections: selected });
      setNotice(`Downloaded predictions.zip with ${plan.fileCount} selected recording${plan.fileCount === 1 ? '' : 's'} in ${plan.outputs.length} CSV file${plan.outputs.length === 1 ? '' : 's'}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The selected predictions could not be exported.'); }
    finally { setBusy(false); }
  }

  return <section className="rg-export-panel ps3-panel rg-export-builder" aria-labelledby="export-builder-heading">
    <div className="rg-export-heading"><span className="rg-round-icon"><FolderOpen size={25}/></span><div><h2 id="export-builder-heading">Choose files to export</h2><p>Select a saved run, then tick the files you want. Unchecking a file keeps its saved result.</p></div></div>
    <div className="rg-export-selection-bar"><div role="status" aria-live="polite"><strong>{plan.fileCount} <span>recordings selected</span></strong><small>{plan.rowCount} prediction rows · {plan.outputs.length} CSV files · {availableCount} recordings in the chosen runs</small></div><div className="rg-export-selection-actions">
      <button className="ps3-button ps3-button-quiet" disabled={busy || initialising || !allChosenReady} onClick={() => change(() => defaultExportChoices(chosenJobs))}><CheckCheck size={14}/>Select all files</button>
      <button className="ps3-button ps3-button-quiet" disabled={busy || initialising || !Object.values(choices).some(choice => choice.fileIds.length || choice.unavailableReason)} onClick={() => change(previous => Object.fromEntries(Object.entries(previous).map(([id, choice]) => [id, { jobId: choice.jobId, fileIds: [] }])))}><X size={14}/>Clear selection</button>
      <button className="ps3-button ps3-button-quiet" disabled={busy || !data.libraryReady || data.bundle.pending.length > 0 || !data.bundle.completed.length} onClick={() => { change(() => defaultExportChoices(data.bundle.completed.filter(job => !data.jobErrors[job.id]))); setQueries({}); }}>Use latest runs</button>
    </div></div>
    <p className="rg-export-selection-hint">New analyses do not replace your selection. Use latest runs to start again from the newest results. Changing a run starts with no files selected.</p>
    {initialising && <p role="status" className="rg-export-notice">Loading saved runs and preparing the file selection…</p>}
    <div className="rg-export-picker-grid">{SUBSYSTEMS.map(({ id, title, output, icon: Icon }) => {
      const choice = choices[id];
      const job = choice ? data.jobs[choice.jobId] : undefined;
      const ready = Boolean(job && choice && data.exportJobReady(choice.jobId));
      const reports = job?.status === 'completed' ? savedRecordings(job) : [];
      const invalidReports = job?.status === 'completed' && (!Array.isArray(job.reports) || reports.length !== job.reports.length || reports.some(report => !Array.isArray(report.prediction_rows) || !report.prediction_rows.length));
      const query = queries[id] ?? '';
      const visible = reports.filter(report => report.file_id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      const checked = new Set(choice?.fileIds ?? []);
      const runs = data.history.filter(item => item.subsystem === id && (data.jobs[item.id]?.status ?? data.library.find(row => row.id === item.id)?.status) === 'completed');
      if (choice && !runs.some(run => run.id === choice.jobId)) {
        runs.push({ id: choice.jobId, subsystem: id, created_at: job?.created_at ?? '' });
      }
      const loadError = choice ? data.jobErrors[choice.jobId] : undefined;
      return <article key={id} className={`rg-export-picker ${checked.size ? 'has-selection' : ''}`}>
        <div className="rg-export-picker-title"><span><Icon size={20}/><h3>{title}</h3></span><span className="rg-export-count">{checked.size} / {reports.length} selected</span></div>
        <label className="rg-export-run-label">Analysis run<select aria-label={`${title} export run`} value={choice?.jobId ?? ''} disabled={busy || initialising || data.transferring} onChange={event => {
          const jobId = event.target.value;
          change(previous => {
            const next = { ...previous };
            if (jobId) next[id] = { jobId, fileIds: [] }; else delete next[id];
            return next;
          });
          setQueries(previous => ({ ...previous, [id]: '' }));
        }}><option value="">{runs.length ? 'Choose a completed run' : 'No completed run available'}</option>{runs.map(run => {
          const saved = data.library.find(item => item.id === run.id);
          const loaded = data.jobs[run.id];
          const source = loaded?.source ?? saved?.source;
          const fileCount = loaded ? savedRecordings(loaded).length : saved?.file_count;
          return <option key={run.id} value={run.id}>{run.created_at ? jobTime(run.created_at) : 'Saved run'} · {source === 'organiser_test' ? 'Official Test' : source === 'uploaded' ? 'Uploaded' : 'Source unavailable'} · {fileCount ?? '?'} file{fileCount === 1 ? '' : 's'} · {run.id.slice(0, 8)}</option>;
        })}</select></label>
        {job && <p className="rg-export-run-source">{job.source === 'organiser_test' ? 'Official Test inputs' : 'Uploaded recordings'} · Run {job.id.slice(0, 8)}</p>}
        {loadError ? <div className="rg-export-picker-message" role="alert"><CircleAlert size={15}/><p>{loadError}</p><button className="ps3-button ps3-button-quiet" onClick={data.refresh} disabled={busy}>Retry run</button></div> : choice && !ready ? <p className="rg-export-picker-message" role="status"><LoaderCircle size={15} className="spin"/>Checking this saved run…</p> : !choice ? <p className="rg-export-picker-message">Choose a completed run to add its predictions.</p> : null}
        {invalidReports && <p className="rg-export-picker-message" role="alert">This run contains incomplete saved prediction data. Choose another run or analyse the source again.</p>}
        {reports.length > 0 && <>
          <div className="rg-export-search"><Search size={14}/><input type="search" aria-label={`Search ${title} export files`} placeholder="Find a recording…" value={query} disabled={busy} onChange={event => setQueries(previous => ({ ...previous, [id]: event.target.value }))}/></div>
          <div className="rg-export-file-tools"><span>{query.trim() ? `${visible.length} match${visible.length === 1 ? '' : 'es'} · hidden selections stay included` : 'Select source recordings'}</span><button disabled={busy || !ready || !visible.length} onClick={() => selectFiles(id, visible.map(report => report.file_id), true)}>{query.trim() ? 'Select shown' : 'Select all'}</button><button disabled={busy || !ready || !visible.some(report => checked.has(report.file_id))} onClick={() => selectFiles(id, visible.map(report => report.file_id), false)}>{query.trim() ? 'Clear shown' : 'Clear'}</button></div>
          <ul className="rg-export-file-list" aria-label={`${title} source recordings`}>{visible.map((report, index) => {
            const rows = Array.isArray(report.prediction_rows) ? report.prediction_rows.length : 0;
            return <li key={`${report.file_id}-${index}`}><label><input type="checkbox" checked={checked.has(report.file_id)} disabled={busy || !ready} aria-label={`Include ${report.file_id} in ${title} export`} onChange={event => selectFiles(id, [report.file_id], event.target.checked)}/><span><strong>{report.file_id}</strong><small>{rows ? `${rows} prediction row${rows === 1 ? '' : 's'}${id === 'door' ? ' · all detected actions' : ''}` : 'Prediction rows unavailable'}</small></span></label></li>;
          })}</ul>
          {!visible.length && <div className="rg-export-empty-search"><p>No filenames match “{query}”. Your selection is unchanged.</p><button onClick={() => setQueries(previous => ({ ...previous, [id]: '' }))}>Clear search</button></div>}
        </>}
        <footer><FileCheck2 size={13}/><code>{output}</code><span>{checked.size ? 'Included' : 'Not included'}</span></footer>
      </article>;
    })}</div>
    <section className="rg-export-preview" aria-labelledby="export-preview-heading"><div><h3 id="export-preview-heading">Inside predictions.zip</h3><p>Only the selected recordings contribute rows. Search filters do not change the export.</p></div>{plan.outputs.length ? <ul>{plan.outputs.map(item => <li key={item.subsystem}><FileCheck2 size={16}/><strong>{item.filename}</strong><span>{item.fileCount} recording{item.fileCount === 1 ? '' : 's'} · {item.rowCount} row{item.rowCount === 1 ? '' : 's'}</span></li>)}</ul> : <p className="rg-export-nothing">No files selected. Select a recording above to build your export.</p>}</section>
    {plan.selectedJobs.some(job => job.source === 'uploaded') && <div className="rg-warning"><CircleAlert size={17}/><p>Your selection includes uploaded recordings. Confirm these are the intended inputs before submission; predicting training files does not measure unseen-data accuracy.</p></div>}
    {plan.problems.length > 0 && <div className="rg-warning" role="alert"><CircleAlert size={17}/><div>{plan.problems.map((problem, index) => <p key={index}>{problem}</p>)}<p>Review the selected run and files before exporting.</p></div></div>}
    {!initialising && (!data.libraryReady || checking) && <p role="status" className="rg-export-notice">Checking the selected results. Export will be available when their saved reports are verified.</p>}
    <div className="rg-export-action"><p><ShieldCheck size={16}/>Official CSV columns · selected prediction rows</p><button disabled={busy || !canExport} onClick={download} className="ps3-button ps3-button-primary">{busy ? <LoaderCircle className="spin" size={16}/> : <ArrowDownToLine size={16}/>}Export selected files{plan.fileCount > 0 ? ` (${plan.fileCount})` : ''}</button></div>
    {error && <p className="ps3-error" role="alert">{error}</p>}{notice && <p role="status" className="ps3-download-notice">{notice}</p>}
  </section>;
}
