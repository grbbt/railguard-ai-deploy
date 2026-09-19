'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Bot, Box, Check, ChevronRight, CircleAlert, Database, FileCheck2, Fingerprint, LayoutDashboard, LoaderCircle, MapPin, Menu, RefreshCw, ShieldCheck, Sparkles, TrainFront, Upload, X } from 'lucide-react';
import type { SubsystemId } from '@/lib/ps3-types';
import InputPanel from '@/components/ps3/InputPanel';
import ResultsPanel from '@/components/ps3/ResultsPanel';
import InvestigationPanel from '@/components/ps3/InvestigationPanel';
import { jobTime, SUBSYSTEMS } from '@/components/ps3/shared';
import type { RecordingSelectionSummary } from './RecordingTwin';
import ExportPanel from './ExportPanel';
import InvestigationWindow from './InvestigationWindow';
import ResultSummary from './ResultSummary';
import { useWorkspace, type WorkspaceData } from './useWorkspace';
import { TASK_REQUIREMENTS, TASK_SIGNALS } from './task-requirements';
import { summarizePrediction } from '@/components/ps3/prediction-comparison';
import { describePrediction } from '@/components/ps3/result-overview';
import '@/app/ps3/ps3.css';
import './workspace.css';
import './simple-theme.css';
import './night-glass.css';
import './engineering-workspace.css';
import './gradient-theme.css';
import './investigation-workbench.css';
import './vivid-theme.css';
import './investigation-window.css';
import './result-summary.css';

const WorkspaceMap = dynamic(() => import('./WorkspaceMap'), { ssr: false, loading: () => <div className="rg-map-loading"><LoaderCircle className="spin" size={23}/>Loading Singapore network</div> });
const RecordingTwin = dynamic(() => import('./RecordingTwin'), { ssr: false, loading: () => <div className="rg-stage-loading"><LoaderCircle className="spin"/>Preparing component geometry…</div> });

export type WorkspaceView = 'overview' | 'analysis' | 'investigation' | 'validation' | 'exports';
const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, title: 'Railway condition analysis', copy: 'Choose a system to analyse, review its results, then export the files you need.' },
  { id: 'analysis', label: 'Analyse data', icon: Activity, title: 'From recording to result.', copy: 'Choose a system, upload your files, then follow the result into its evidence.' },
  { id: 'investigation', label: '3D + AI investigation', icon: Box, title: 'Inspect. Understand. Investigate.', copy: 'Explore the component and its measurements. Ask the AI agent to investigate the same recording.' },
  { id: 'validation', label: 'Model performance', icon: ShieldCheck, title: 'Model performance', copy: 'Compare models, inspect validation metrics, and review the evaluation method.' },
  { id: 'exports', label: 'Export results', icon: ArrowDownToLine, title: 'Export results', copy: 'Choose the recordings you want and download their predictions as a ZIP.' },
] as const;

export function parseView(value: string | undefined): WorkspaceView {
  if (value === 'twin') return 'investigation';
  return NAV.some(item => item.id === value) ? value as WorkspaceView : 'overview';
}

function Progress({ data }: { data: WorkspaceData }) {
  const { activeId, activeJob: job, jobErrors, busy } = data;
  if (!activeId) return null;
  const error = jobErrors[activeId] || job?.error;
  return <div className={`rg-run-status ${error ? 'has-error' : ''}`} role="status">
    {error ? <CircleAlert size={16}/> : job?.status === 'completed' ? <Check size={16}/> : <LoaderCircle size={16} className="spin"/>}
    <div><strong>{error ? 'This run needs attention' : job?.status === 'completed' ? 'Analysis complete' : job?.status === 'queued' ? 'Queued for analysis' : job?.status === 'running' ? 'Processing recordings' : 'Loading saved result'}</strong><span>{error || (job ? `${job.progress.completed} / ${job.progress.total} files · ${job.progress.filename ?? ''}` : 'Retrieving the retained report…')}</span>{busy && !error && <progress value={job?.progress.completed} max={job?.progress.total || 1} aria-label="Files processed"/>}</div>
    {error && <button className="ps3-button ps3-button-quiet" onClick={data.refresh}>Retry status</button>}
  </div>;
}

function History({ data, compact = false, onOpen }: { data: WorkspaceData; compact?: boolean; onOpen?: () => void }) {
  const rows = data.history.filter(item => compact || item.subsystem === data.subsystem).slice(0, compact ? 5 : 12);
  return <section className={`rg-history ${compact ? 'compact' : 'ps3-panel'}`}><div className="rg-panel-title"><span>{compact ? 'Recent analyses' : 'Saved analyses'}</span><button aria-label="Refresh recording library" title="Refresh recording library" onClick={data.refresh} className="ps3-icon-button"><RefreshCw size={14}/></button></div>
    {!rows.length && <p className="rg-empty-copy">Your saved runs will appear here. Upload a recording or use an official Test input to begin.</p>}
    {rows.map(item => {
      const job = data.jobs[item.id];
      const saved = data.library.find(row => row.id === item.id);
      const state = data.jobErrors[item.id] ? 'unavailable' : job?.status ?? saved?.status ?? 'loading';
      const task = SUBSYSTEMS.find(value => value.id === item.subsystem)!;
      return <button key={item.id} disabled={data.transferring} className={`rg-history-row ${data.activeId === item.id ? 'selected' : ''}`} onClick={() => { data.selectJob(item.id, item.subsystem); onOpen?.(); }}>
        <span className={`rg-run-dot ${state}`}/><span><strong title={job?.reports[0]?.file_id ?? saved?.first_file ?? item.id}>{job?.reports[0]?.file_id ?? saved?.first_file ?? 'Analysis run'}</strong><small>{compact ? `${task.title} · ` : ''}{jobTime(item.created_at)} · {state}</small></span><ChevronRight size={13}/>
      </button>;
    })}
    {!compact && <p className="rg-history-note">Latest {Math.min(data.library.length, 40)} of {data.libraryTotal} saved runs, plus this browser’s saved links. Results stay on this computer.</p>}
    {data.libraryError && <p role="alert" className="rg-inline-error">Library refresh failed. {data.libraryError}</p>}
  </section>;
}

function Selection({ data }: { data: WorkspaceData }) {
  const runs = data.history.filter(item => item.subsystem === data.subsystem);
  return <div className="rg-selection">
    <label><span>Analysis run</span><select aria-label="Selected analysis run" value={data.activeId ?? ''} disabled={!runs.length || data.transferring} onChange={event => data.selectJob(event.target.value, data.subsystem)}>{!runs.length && <option value="">No saved run</option>}{runs.map(item => <option key={item.id} value={item.id}>{jobTime(item.created_at)} · {data.jobs[item.id]?.reports[0]?.file_id ?? data.library.find(value => value.id === item.id)?.first_file ?? item.id.slice(0, 8)}</option>)}</select></label>
    <label><span>Source recording</span><select aria-label="Selected source recording" value={data.report?.file_id ?? ''} disabled={!data.report || data.transferring} onChange={event => data.selectFile(event.target.value)}>{!data.report && <option value="">Select a completed result</option>}{data.activeJob?.reports.map(item => <option key={item.file_id} value={item.file_id}>{item.file_id}</option>)}</select></label>
    <div className="rg-selection-provenance"><Fingerprint size={15}/><span>{data.activeJob?.source === 'organiser_test' ? 'Official Test input' : data.activeJob ? 'Uploaded recording' : 'Recorded-data workspace'}<small>{data.report ? `${data.activeJob?.reports.length} file${data.activeJob?.reports.length === 1 ? '' : 's'} · Analysis complete` : 'Select a run or upload a recording'}</small></span></div>
  </div>;
}

function Overview({ data, go }: { data: WorkspaceData; go: (view: WorkspaceView) => void }) {
  const [mapOpen, setMapOpen] = useState(false);
  const completed = data.bundle.completed;
  const currentFinding = data.report ? describePrediction(summarizePrediction(data.report)) : null;
  const descriptions: Record<SubsystemId, string> = { door: 'Detect door movements and abnormal resistance.', acv: 'Rank cars for air-conditioning inspection.', rail: 'Identify signs of corrugation and the affected rail side.', shm: 'Estimate cumulative damage from recorded stress.' };
  return <div className="rg-content rg-overview">
    <div className="rg-page-heading rg-overview-heading"><div><h1>Railway engineering workspace</h1><p>Four PS3 tasks. One workflow from sensor recordings to evidence and submission files.</p></div><button className="ps3-button ps3-button-primary" onClick={() => go('analysis')}><Upload size={16}/>Analyse data</button></div>
    <div className="rg-flow" aria-label="Analysis workflow"><span className="current"><b>1</b>Select & upload</span><span><b>2</b>Inspect prediction & evidence</span><span><b>3</b>Compare files</span><span><b>4</b>Export predictions</span></div>
    <section className="rg-overview-grid" aria-label="Choose a railway system">{SUBSYSTEMS.map(({ id, title, icon: Icon }) => {
      const model = data.status?.subsystems.find(item => item.id === id);
      const job = completed.find(item => item.subsystem === id);
      const requirement = TASK_REQUIREMENTS[id];
      const score = !data.statusError && model?.available ? model.model?.validation.score : null;
      return <button className="rg-task-card" data-subsystem={id} key={id} disabled={data.transferring} onClick={() => { data.setSubsystem(id); if (job) data.selectJob(job.id, id); go('analysis'); }}><div className="rg-task-card-top"><Icon size={23}/><span>PS3 · {String(SUBSYSTEMS.findIndex(item => item.id === id) + 1).padStart(2, '0')}</span></div><h2>{id === 'acv' ? 'Air conditioning' : title}</h2><p>{descriptions[id]}</p><div className="rg-task-output"><small>Required result</small><b>{requirement.result}</b></div><div className="rg-task-validation"><div><small>Local validation</small><b>{typeof score === 'number' && Number.isFinite(score) ? score.toFixed(4) : 'Pending'}</b></div><span>{requirement.metric}</span></div><span>{!data.status || data.statusError ? 'Checking model availability' : model?.available ? 'Model ready' : 'Model unavailable'}{job ? ` · ${job.reports.length} saved file${job.reports.length === 1 ? '' : 's'}` : ''}</span><strong>Open analysis<ArrowRight size={15}/></strong></button>;
    })}</section>
    <div className="rg-evaluation-context"><p><strong>Evaluation basis</strong> Current-model local validation is shown above. Official scores are calculated from held-out Test answers by the organisers; each subsystem contributes 25% of the PS3 Overall Score.</p><button onClick={() => go('validation')}>Methods & model comparison<ArrowRight size={15}/></button></div>
    <div className="rg-overview-details"><History data={data} compact onOpen={() => go('analysis')}/><section className="rg-current-finding"><span className="rg-eyebrow">{currentFinding?.label ?? 'SELECTED RECORDING'}</span><h2>{currentFinding?.value ?? 'Your first analysis'}</h2><p>{currentFinding?.description ?? 'Upload recordings or try the included official Test files. Results and supporting measurements will appear here.'}</p>{data.report && <small className="rg-finding-file"><FileCheck2 size={13}/>{data.report.file_id}</small>}<button onClick={() => go('analysis')} className="rg-inline-link">{data.report ? 'Review this result' : 'Choose a recording'}<ArrowRight size={15}/></button></section></div>
    <details className="rg-map-section" onToggle={event => setMapOpen(event.currentTarget.open)}><summary><MapPin size={20}/><span>Singapore network map<small>Static network geography</small></span></summary>{mapOpen && <div className="rg-map-frame"><WorkspaceMap/></div>}</details>
  </div>;
}

export default function Workspace({ initialView = 'overview' }: { initialView?: WorkspaceView }) {
  const data = useWorkspace();
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMounted, setAgentMounted] = useState(false);
  const [summaryScope, setSummaryScope] = useState<'current' | 'all'>('current');
  const closeAgent = useCallback(() => setAgentOpen(false), []);
  const [selectedComponent, setSelectedComponent] = useState<RecordingSelectionSummary | null>(null);
  const agentOpener = useRef<HTMLElement | null>(null);
  const navigation = useRef<HTMLElement>(null);
  const uploadPanel = useRef<HTMLElement>(null);
  const heading = NAV.find(item => item.id === view)!;
  const available = data.status && !data.statusError ? data.status.subsystems.filter(item => item.available).length : null;
  const hasResult = Boolean(data.report && data.activeJob?.status === 'completed');
  const fileSummary = data.report && data.activeJob?.status === 'completed' ? <ResultSummary report={data.report} reports={data.activeJob.reports} scope={summaryScope} jobId={data.activeJob.id} aiAvailable={Boolean(data.status?.assistant.available && !data.statusError)} onScopeChange={view === 'investigation' ? setSummaryScope : undefined}/> : null;
  const requirement = TASK_REQUIREMENTS[data.subsystem];
  const signals = TASK_SIGNALS[data.subsystem];
  const subsystemPicker = <nav className="rg-subsystems rg-system-picker" aria-label="Choose a subsystem">{SUBSYSTEMS.map(({ id, title, icon: Icon }) => <button key={id} data-subsystem={id} disabled={data.transferring} aria-pressed={data.subsystem === id} onClick={() => data.setSubsystem(id)} className={data.subsystem === id ? 'active' : ''}><Icon size={17}/>{id === 'acv' ? 'Air conditioning' : title}<i className={data.status?.subsystems.find(item => item.id === id)?.available && !data.statusError ? 'ready' : ''}/></button>)}</nav>;
  const recordingContext = <section className="rg-recording-console" aria-label="Dataset and analysis selection">{view !== 'analysis' && subsystemPicker}<Selection data={data}/><div className="rg-task-requirement" aria-label="PS3 task requirements"><div><span>Required result</span><strong>{requirement.result}</strong></div><div><span>Evaluation metric</span><strong>{requirement.metric}</strong></div><div><span>Submission file</span><code>{requirement.file}</code></div></div><div className="rg-signal-guide"><Activity size={16}/><p><strong>{signals.title}</strong><span>{signals.channels}</span><small>{signals.interpretation}</small></p></div>{(!hasResult || data.activeId && data.jobErrors[data.activeId]) && <Progress data={data}/>}</section>;
  function go(next: WorkspaceView) { if (data.transferring) return; setView(next); setMobileOpen(false); window.history.replaceState(null, '', next === 'overview' ? '/' : `/?view=${next}`); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function newAnalysis() { go('analysis'); requestAnimationFrame(() => uploadPanel.current?.scrollIntoView({ block: 'start' })); }
  function openAgent() { agentOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setAgentMounted(true); setAgentOpen(true); }
  const analysisInput = <section ref={uploadPanel} className="rg-analysis-upload" aria-label="Upload and analyse recordings"><div className="rg-upload-top"><div><span className="rg-eyebrow">01 / START YOUR ANALYSIS</span><h2>Upload your recordings</h2><p>Select the system that matches your files.</p></div><span className="rg-local-processing"><ShieldCheck size={14}/>Processed locally</span></div>{subsystemPicker}<InputPanel compact key={data.subsystem} subsystem={data.subsystem} status={data.statusError ? undefined : data.currentStatus} limits={data.status?.limits} busy={data.busy} onTransferChange={data.setTransferring} onStarted={data.onStarted}/></section>;
  const analysisResults = <div className="rg-analysis-results"><ResultsPanel showFilePicker={false} key={`${data.subsystem}:${data.activeId}`} subsystem={data.subsystem} job={data.activeJob} report={data.report} model={data.currentStatus?.model} onFile={data.selectFile} onInspect3D={() => go('investigation')} scope={summaryScope} onScopeChange={setSummaryScope} summaryView={fileSummary} findingView={hasResult ? <><RecordingTwin key={`inline:${data.subsystem}:${data.activeId}:${data.report?.file_id}`} report={data.report} subsystem={data.subsystem} embedded onSelectionChange={setSelectedComponent}/></> : undefined}/>{hasResult && <div className="rg-result-actions"><span><Sparkles size={16}/>Explore this result with the investigation agent</span><button onClick={openAgent} aria-controls="investigation-agent" aria-expanded={agentOpen}>Ask AI about this result<ArrowUpRight size={14}/></button></div>}</div>;
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...navigation.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? []];
    items()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); }
      if (event.key === 'Tab') { const targets = items(); if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0]?.focus(); } }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus({ preventScroll: true }); };
  }, [mobileOpen]);

  return <div data-subsystem={data.subsystem} className={`rg-workspace ps3-shell ${view === 'overview' ? 'is-command' : ''}`}><a inert={agentOpen} className="ps3-skip" href="#workspace-main">Skip to workspace</a>
    {mobileOpen && <button className="rg-nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/>}
    <aside inert={agentOpen && !mobileOpen} ref={navigation} id="workspace-navigation" className={`rg-sidebar ${mobileOpen ? 'is-open' : ''}`}><Link className="rg-brand" aria-label="RailGuard overview" href="/" onClick={event => { event.preventDefault(); go('overview'); }}><span><TrainFront size={24}/></span><strong>RailGuard<small>AI</small><em>Railway analysis</em></strong></Link><button className="rg-nav-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={19}/></button><div className="rg-workspace-name"><span/><div>Fleet workspace<small>Recorded-data intelligence</small></div></div><span className="rg-nav-label">WORKSPACE</span><nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }, index) => <button key={id} title={label} aria-label={label} onClick={() => go(id)} disabled={data.transferring} aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''}><Icon size={17}/><span>{label}</span><small>0{index + 1}</small></button>)}</nav><div className="rg-sidebar-bottom"><div className="rg-model-state"><ShieldCheck size={20}/><div><strong>{available ?? '—'} / 4 models ready</strong><small>{data.statusError ? 'Service reconnecting' : 'Trained models · local inference'}</small></div></div><p>Measurements first.<br/>Engineering review always.</p><div className="rg-operator"><span>RG</span><div>Engineering console<small>Local workspace</small></div><Fingerprint size={16}/></div></div></aside>
    <div className="rg-main-shell" inert={mobileOpen || agentOpen}><header className="rg-topbar"><div><button className="rg-menu" aria-label="Open navigation" aria-controls="workspace-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={20}/></button><span className="rg-topbar-context">Fleet workspace</span><ChevronRight size={13}/><strong>{heading.label}</strong></div><div><span className={`rg-service-badge ${data.statusError ? 'error' : ''}`}><i/>{data.statusError ? 'Reconnecting' : available === null ? 'Connecting' : 'Local service'}</span><button className="ps3-icon-button" onClick={data.refresh} aria-label="Refresh service and saved results"><RefreshCw size={15}/></button><button className="rg-topbar-upload" aria-label="Upload recordings" disabled={data.transferring} onClick={newAnalysis}><Upload size={14}/><span>Upload recordings</span></button></div></header>
      {(data.statusError || data.libraryError) && <div className="rg-service-error" role="alert"><CircleAlert size={17}/><span>{data.statusError || data.libraryError} Retrying automatically.</span><button onClick={data.refresh}>Retry</button></div>}
      <main id="workspace-main">{view === 'overview' ? <Overview data={data} go={go}/> : <div className="rg-content"><div className="rg-page-heading"><div><span className="rg-eyebrow">RAILGUARD / {heading.label.toUpperCase()}</span><h1>{heading.title}</h1><p>{heading.copy}</p></div><span className="rg-recorded-tag"><Fingerprint size={14}/>Recorded data</span></div>
        {view === 'analysis' && analysisInput}
        {view !== 'exports' && recordingContext}
        {view === 'analysis' && <div className="rg-analysis-grid has-result">{analysisResults}<History data={data}/></div>}
        {view === 'investigation' && <>
          <section className="rg-investigation-intro" aria-label="Connected investigation"><div><span className="rg-workbench-symbol"><Sparkles size={20}/></span><div><strong>{summaryScope === 'all' ? 'Run overview. Recording detail.' : 'One recording. A complete investigation.'}</strong><p>{data.report?.file_id ?? 'Select a recording to connect its model and evidence'}<span>3D component · measurements · signal charts · AI reasoning</span></p></div></div><nav aria-label="Investigation sections"><a href="#investigation-model"><Box size={15}/>3D + evidence</a><button onClick={openAgent} aria-controls="investigation-agent" aria-expanded={agentOpen}><Bot size={15}/>Ask AI<ArrowRight size={14}/></button></nav></section>
          <div className="rg-investigation-workbench">
            <section id="investigation-model" className="rg-workbench-stage" aria-label="3D model and supporting evidence">{fileSummary}{summaryScope === 'all' && data.report && <p className="rg-summary-detail-scope"><Box size={14}/><span>Component and measurements below: <strong>{data.report.file_id}</strong></span></p>}<RecordingTwin key={`${data.subsystem}:${data.activeId}:${data.report?.file_id}`} report={data.report} subsystem={data.subsystem} onSelectionChange={setSelectedComponent}/></section>

          </div>
        </>}
        {view === 'validation' && <><div className="rg-validation-intro"><ShieldCheck size={23}/><p><strong>Local validation · {data.activeJob?.validation ? 'saved run' : 'installed model'}.</strong> {data.activeJob?.validation ? 'Metrics are retained with the selected run.' : 'Metrics come from the currently installed model.'} Training-file predictions are inference examples; validation uses held-out recordings.</p></div><ResultsPanel showFilePicker={false} key={`validation:${data.subsystem}:${data.activeId}`} initialTab="validation" subsystem={data.subsystem} job={data.activeJob} report={data.report} model={data.currentStatus?.model} onFile={data.selectFile}/></>}
        {view === 'exports' && <ExportPanel data={data}/>}
        <footer className="rg-footer"><span><Database size={13}/>Saved recordings · trained models</span><span>Decision support for engineering review</span>{data.status?.source && <a href={data.status.source.repository.startsWith('https://') ? data.status.source.repository : undefined} target="_blank" rel="noreferrer">Source {data.status.source.commit.slice(0, 8)}<ArrowUpRight size={12}/></a>}</footer>
      </div>}</main>
    </div>
    {agentMounted && <InvestigationWindow open={agentOpen && !mobileOpen} onClose={closeAgent} returnFocus={agentOpener} filename={data.report?.file_id}><InvestigationPanel compact visible={agentOpen && !mobileOpen} component={(view === 'analysis' || view === 'investigation') && selectedComponent?.fileId === data.report?.file_id ? selectedComponent : null} defaultScope={data.report ? 'file' : 'project'} assistant={data.statusError ? undefined : data.status?.assistant} jobId={data.activeJob?.status === 'completed' ? data.activeJob.id : undefined} report={data.report} fileCount={data.activeJob?.reports.length ?? 0}/></InvestigationWindow>}
    <button type="button" className="rg-ai-launcher" hidden={mobileOpen || agentOpen} onClick={agentOpen ? closeAgent : openAgent} aria-label={agentOpen ? 'Minimise AI investigation' : 'Open AI investigation'} aria-expanded={agentOpen} aria-controls="investigation-agent"><Bot size={19}/><span>{agentOpen ? 'Minimise AI' : 'Ask AI'}</span><Sparkles size={14}/></button>
  </div>;
}
