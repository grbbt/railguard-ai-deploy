'use client';

import { useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, CircleHelp, FileCheck2, Layers3, ListChecks, LoaderCircle, ScanLine, ShieldCheck } from 'lucide-react';
import type { ModelMetadata, PerClassValidation, PredictionReport, Ps3Job, RankingMetrics, SubsystemId, Validation } from '@/lib/ps3-types';
import TelemetryChart from './TelemetryChart';
import { displayValue, downloadResult, SUBSYSTEMS } from './shared';
import { rankingSummary } from './ranking-metrics';
import PredictionComparison from './PredictionComparison';
import ResultOverview from './ResultOverview';
import { summarizePrediction } from './prediction-comparison';

function RankingMeasures({ score, metrics }: { score: number | null; metrics?: RankingMetrics | null }) {
  const counts = rankingSummary(metrics);
  return <><div className="ps3-ranking-metrics">
    <article><h4>First choice correct</h4><strong>{counts ? `${counts.top1.correct} of ${counts.cases}` : 'Not available'}</strong><p>{counts ? `${displayValue(counts.top1.percent, 1)}% of held-out cases` : 'Case counts were not saved in this report.'}</p><small>The correct car was ranked first.</small></article>
    <article><h4>Correct car in first two</h4><strong>{counts ? `${counts.top2.correct} of ${counts.cases}` : 'Not available'}</strong><p>{counts ? `${displayValue(counts.top2.percent, 1)}% of held-out cases` : 'Case counts were not saved in this report.'}</p><small>The correct car was ranked first or second.</small></article>
    <article><h4>Official rank-decay formula</h4><strong>{displayValue(score, 4)}{score !== null && Number.isFinite(score) && <small> / 1</small>}</strong><p>Applied to local validation cases</p><small>Partial credit depends on the correct car&apos;s position.</small></article>
  </div>{counts?.meanRank !== null && counts?.meanRank !== undefined && <p className="ps3-ranking-mean">Average position of the correct car: <strong>{displayValue(counts.meanRank, 2)}</strong>. Position 1 is first choice.</p>}</>;
}

function RankingCount({ metrics, position }: { metrics?: RankingMetrics | null; position: 'top1' | 'top2' }) {
  const counts = rankingSummary(metrics);
  return counts ? <>{counts[position].correct} / {counts.cases} <span className="ps3-ranking-percent">({displayValue(counts[position].percent, 1)}%)</span></> : <>Not available</>;
}

function ValidationPanel({ validation, model, selectedModel, subsystem }: { validation?: Validation; model?: ModelMetadata | null; selectedModel?: string; subsystem: SubsystemId }) {
  if (!validation) return <div className="ps3-empty-small"><ShieldCheck size={24}/><h3>Validation is not available yet</h3><p>Measured results appear when the subsystem&apos;s trained model and validation metadata are available.</p></div>;
  const perClass = subsystem === 'rail' ? validation.candidates?.find(candidate => candidate.name === selectedModel)?.per_class : undefined;
  const classes = Object.entries(perClass ?? {}).filter((entry): entry is [string, PerClassValidation] => !['accuracy', 'macro avg', 'weighted avg', 'micro avg', 'samples avg'].includes(entry[0]) && Boolean(entry[1]) && typeof entry[1] === 'object');
  const acv = subsystem === 'acv';
  const audit = acv ? validation.nested_validation : undefined;
  const auditCounts = rankingSummary(audit?.ranking_metrics);
  return <div className="ps3-validation"><div className="ps3-validation-head"><div><span className="ps3-kicker">LOCAL VALIDATION</span><h3>{acv ? 'Selected model · case validation' : validation.metric}</h3>{acv && selectedModel && <p>{selectedModel}</p>}<p>{validation.method}</p></div>{!acv && <div className="ps3-validation-score"><strong>{displayValue(validation.score)}</strong><span>measured score</span></div>}</div>
    {acv && <><RankingMeasures score={validation.score} metrics={validation.ranking_metrics}/>{auditCounts && <p className="ps3-context-note ps3-audit-callout"><CircleHelp size={16}/><span><strong>Stricter model-selection audit: {auditCounts.top1.correct} of {auditCounts.cases} first choices correct ({displayValue(auditCounts.top1.percent, 1)}%).</strong> Both checks reuse development cases; external reliability remains untested.</span></p>}<p className="ps3-context-note"><CircleHelp size={14}/>Rank-decay gives partial credit: placing the correct car second out of eight earns 0.875. It does not measure the percentage of cases correct on the first choice. First-choice and first-two results use the case counts saved with this report.</p></>}
    <p className="ps3-context-note"><CircleHelp size={14}/>This measures held-out training data. The organiser&apos;s hidden test score is unavailable.</p>
    {model && <dl className="ps3-model-facts"><div><dt>Selected pipeline</dt><dd>{model.model_name}</dd></div><div><dt>Training files</dt><dd>{displayValue(model.training_files, 0)}</dd></div><div><dt>Training rows</dt><dd>{displayValue(model.training_rows, 0)}</dd></div><div><dt>Fitted at</dt><dd>{model.trained_at}</dd></div></dl>}
    {!!validation.candidates?.length && <div className="ps3-candidates"><h3>Model comparison</h3><p>{acv ? 'Each candidate uses the same reported case-validation method. Correct-case counts and rank-decay measure different things.' : 'Scores below use the validation method reported above.'}</p>{acv ? <div className="ps3-table-scroll" tabIndex={0} role="region" aria-label="ACV model comparison, scroll horizontally if needed"><table className="ps3-acv-comparison"><caption className="sr-only">First-choice results, first-two results and rank-decay scores by candidate</caption><thead><tr><th scope="col">Candidate</th><th scope="col">First choice correct</th><th scope="col">Correct in first two</th><th scope="col">Rank-decay / 1</th></tr></thead><tbody>{validation.candidates.map((candidate, index) => <tr key={`${candidate.name}-${index}`}><th scope="row">{candidate.name}</th><td><RankingCount metrics={candidate.ranking_metrics} position="top1"/></td><td><RankingCount metrics={candidate.ranking_metrics} position="top2"/></td><td className="mono">{displayValue(candidate.score, 4)}</td></tr>)}</tbody></table></div> : <table><caption className="sr-only">Measured local validation scores by model</caption><thead><tr><th scope="col">Candidate</th><th scope="col">{validation.metric}</th></tr></thead><tbody>{validation.candidates.map((candidate, index) => <tr key={`${candidate.name}-${index}`}><td>{candidate.name}</td><td className="mono">{displayValue(candidate.score)}</td></tr>)}</tbody></table>}</div>}
    {acv && <section className="ps3-selection-audit" aria-labelledby="ps3-selection-audit-heading"><span className="ps3-kicker">MODEL-SELECTION AUDIT</span><h3 id="ps3-selection-audit-heading">Retrospective nested case validation</h3><p>Each outer held-out case evaluates the candidate-selection process. This audit uses the same released training cases already available during development; it is not untouched test data or a validation score for the final fitted model.</p>{audit ? <><p>{audit.method}</p><RankingMeasures score={audit.score} metrics={audit.ranking_metrics}/><Limitations warnings={audit.limitations ?? []}/></> : <p className="ps3-context-note">Not available in this saved report. No nested audit is inferred from the selected model&apos;s score.</p>}</section>}
    {!!classes.length && <div className="ps3-candidates"><h3>Selected model · per-class validation</h3><p>{selectedModel}. Precision, recall and F1 are measured on a 0–1 scale; they are not probabilities or confidence for this recording. Support is the number of labelled validation recordings.</p><div className="ps3-table-scroll" tabIndex={0} role="region" aria-label="Per-class validation, scroll horizontally if needed"><table><caption className="sr-only">Measured local validation by class for {selectedModel}</caption><thead><tr><th scope="col">Class</th><th scope="col">Precision</th><th scope="col">Recall</th><th scope="col">F1</th><th scope="col">Support</th></tr></thead><tbody>{classes.map(([name, metrics]) => <tr key={name}><th scope="row">{name}</th><td className="mono">{displayValue(metrics.precision, 4)}</td><td className="mono">{displayValue(metrics.recall, 4)}</td><td className="mono">{displayValue(metrics['f1-score'], 4)}</td><td className="mono">{displayValue(metrics.support, 0)}</td></tr>)}</tbody></table></div></div>}
    <Limitations warnings={[...(validation.limitations ?? []), ...(model?.limitations ?? [])]}/>
  </div>;
}

function Limitations({ warnings }: { warnings: string[] }) {
  const unique = [...new Set(warnings.filter(Boolean))];
  if (!unique.length) return null;
  return <div className="ps3-limitations"><h3><CircleHelp size={15}/>Analysis notes</h3><ul>{unique.map(warning => <li key={warning}>{warning}</li>)}</ul></div>;
}

function Predictions({ report }: { report: PredictionReport }) {
  const [page, setPage] = useState(0);
  const rows = report.prediction_rows;
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const current = Math.min(page, pages - 1);
  return <div className="ps3-predictions"><div className="ps3-inline-heading"><h3>Prediction records</h3><span>{rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'} · official CSV fields</span></div><p>Exact model output for {report.file_id}. Download CSV to use every returned row in the submission.</p>{!rows.length ? <p className="ps3-context-note">The model returned no prediction rows for this recording.</p> : <><div className="ps3-table-scroll ps3-prediction-records" tabIndex={0} role="region" aria-label="Prediction rows, scroll to review"><table><caption className="sr-only">Returned prediction fields for {report.file_id}</caption><thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{rows.slice(current * 20, current * 20 + 20).map((row, index) => <tr key={current * 20 + index}>{columns.map(column => <td key={column}><span className={column === 'prediction' && row[column] === 'Abnormal resistance' ? 'ps3-record-finding' : undefined}>{row[column] === null || row[column] === undefined ? '—' : String(row[column])}</span></td>)}</tr>)}</tbody></table></div><div className="ps3-pagination"><span>Rows {current * 20 + 1}–{Math.min((current + 1) * 20, rows.length)} of {rows.length}</span>{pages > 1 && <div><button type="button" className="ps3-icon-button" disabled={current === 0} aria-label="Previous prediction rows" onClick={() => setPage(current - 1)}><ChevronLeft size={16}/></button><span>{current + 1} / {pages}</span><button type="button" className="ps3-icon-button" disabled={current >= pages - 1} aria-label="Next prediction rows" onClick={() => setPage(current + 1)}><ChevronRight size={16}/></button></div>}</div></>}
  </div>;
}

function EvidenceView({ report }: { report: PredictionReport }) {
  const [seriesIndex, setSeriesIndex] = useState(0);
  const series = report.series ?? [];
  const selected = series[Math.min(seriesIndex, series.length - 1)];
  const prediction = summarizePrediction(report);
  const ranking = prediction.ranking;
  return <div className="ps3-evidence-view">
    {!!ranking.length && <section className="ps3-ranking"><div className="ps3-inline-heading"><h3>Predicted car ranking</h3><span>Inspection order</span></div><ol>{ranking.map((car, index) => <li key={`${car}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>Car {car}</strong><small>{prediction.unavailableCars.includes(car) ? 'Evidence unavailable' : prediction.unknownEvidenceCars?.includes(car) ? 'No saved evidence status' : `Rank ${index + 1}`}</small></li>)}</ol><p>A relative model ranking, not a calibrated probability or confirmed fault. Cars without evidence retain their returned positions.</p></section>}
    {!!report.entities?.length && <section className="ps3-entity-details ps3-entity-register" aria-label="Reported components"><div className="ps3-inline-heading"><h3><Layers3 size={15}/>Reported components</h3><span>{report.entities.length} entities</span></div><div className="ps3-entity-register-list" tabIndex={0} role="region" aria-label="Component findings, scroll to review">{report.entities.map(entity => <article key={entity.id}><div><strong>{entity.label}</strong><span>{entity.status}</span></div><p>{entity.detail}</p><small>Reported value: {displayValue(entity.value)}</small></article>)}</div></section>}
    {selected && <section className="ps3-trace-panel"><div className="ps3-inline-heading"><h3>Recorded signal</h3>{series.length > 1 && <label><span className="sr-only">Choose signal</span><select value={Math.min(seriesIndex, series.length - 1)} onChange={event => setSeriesIndex(Number(event.target.value))}>{series.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</select></label>}</div><TelemetryChart key={`${report.file_id}-${selected.name}-${seriesIndex}`} series={selected} subsystem={report.subsystem}/></section>}
    <div className="ps3-inline-heading"><h3>Supporting evidence</h3><span>{report.evidence.length} source{report.evidence.length === 1 ? '' : 's'}</span></div>
    {report.evidence.length ? <div className="ps3-evidence-grid">{report.evidence.map((item, index) => <article className="ps3-evidence-card" key={`${item.id}-${index}`} id={`ps3-evidence-${index}`}><div><span>{item.label}</span><small>[{item.id}]</small></div><strong>{displayValue(item.value)}{item.unit && <small>{item.unit}</small>}</strong>{item.detail && <p>{item.detail}</p>}{item.source && <footer>{item.source}</footer>}</article>)}</div> : <p className="ps3-context-note">The report contains no numerical evidence entries.</p>}
    <Limitations warnings={report.warnings ?? []}/>
  </div>;
}

type Props = { subsystem: SubsystemId; job: Ps3Job | null; report: PredictionReport | null; model?: ModelMetadata | null; onFile: (file: string) => void; onInspect3D?: () => void; findingView?: ReactNode; summaryView?: ReactNode; scope?: 'current' | 'all'; onScopeChange?: (scope: 'current' | 'all') => void; showFilePicker?: boolean; initialTab?: 'evidence' | 'predictions' | 'validation' };
export default function ResultsPanel({ subsystem, job, report, model, onFile, onInspect3D, findingView, summaryView, scope: controlledScope, onScopeChange, showFilePicker = true, initialTab = 'predictions' }: Props) {
  const [tab, setTab] = useState<'evidence' | 'predictions' | 'validation'>(initialTab);
  const [localScope, setLocalScope] = useState<'current' | 'all'>('current');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const task = SUBSYSTEMS.find(item => item.id === subsystem)!;
  const comparing = tab === 'predictions' && scope === 'all';
  const exportAll = comparing || tab === 'validation';
  const resultFirst = tab === 'predictions' && !comparing && report && job?.status === 'completed';
  const scopeControl = tab === 'predictions' && report && job?.status === 'completed' && <div className="ps3-prediction-scope"><div role="group" aria-label="Prediction scope"><button type="button" className={scope === 'current' ? 'active' : ''} aria-pressed={scope === 'current'} onClick={() => setScope('current')}>Current file</button><button type="button" className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All files ({job.reports.length})</button></div></div>;
  async function exportCsv() {
    if (!job || job.status !== 'completed' || downloading || (!exportAll && !report)) return;
    setDownloading(true); setError('');
    const query = !exportAll && report ? `?file_id=${encodeURIComponent(report.file_id)}` : '';
    const filename = !exportAll && report ? `${subsystem}_${report.file_id.replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '_')}_predictions.csv` : `${subsystem}_all_files_predictions.csv`;
    try { await downloadResult(`/api/ps3/jobs/${encodeURIComponent(job.id)}/csv${query}`, filename); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'CSV download failed.'); }
    finally { setDownloading(false); }
  }
  return <section className={`ps3-panel ps3-results${resultFirst ? ' ps3-results-first' : ''}${!showFilePicker ? ' ps3-results-compact' : ''}`} aria-labelledby="ps3-result-heading"><div className="ps3-results-heading"><div className="ps3-results-title"><h2 id="ps3-result-heading">{tab === 'validation' ? 'Model validation' : comparing ? 'Batch results' : report ? 'File result' : `${task.title} analysis`}</h2>{!showFilePicker && tab !== 'validation' && report && job?.status === 'completed' && <div className="ps3-result-selected-file"><FileCheck2 size={13}/><span>{report.file_id}</span></div>}</div><div className="ps3-results-actions">{!showFilePicker && scopeControl}<button type="button" className="ps3-button ps3-button-quiet" onClick={exportCsv} disabled={job?.status !== 'completed' || downloading || (!exportAll && !report)}>{downloading ? <LoaderCircle size={15} className="spin"/> : <ArrowDownToLine size={15}/>}Download {exportAll ? 'all' : 'current'} CSV</button></div></div>
    {showFilePicker && tab !== 'validation' && report && job?.status === 'completed' && <div className="ps3-result-toolbar">
      <label><span className="sr-only">File to review</span><select value={report.file_id} onChange={event => onFile(event.target.value)}>{job.reports.map(item => <option key={item.file_id} value={item.file_id}>{item.file_id}</option>)}</select></label>
      {scopeControl}
    </div>}
    <div className="ps3-result-tabs" role="group" aria-label="Result view">{([{ id: 'predictions', label: 'Result', icon: ListChecks }, { id: 'evidence', label: 'Evidence', icon: ScanLine }, { id: 'validation', label: 'Validation', icon: ShieldCheck }] as const).map(({ id, label, icon: Icon }) => <button type="button" key={id} className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={15}/>{label}</button>)}</div>
    {resultFirst && <ResultOverview report={report} onEvidence={() => setTab('evidence')} onInspect3D={onInspect3D}/>}
    {tab === 'predictions' && report && job?.status === 'completed' && summaryView && <div className="ps3-result-brief">{summaryView}</div>}
    {resultFirst && findingView && <div className="ps3-result-finding">{findingView}</div>}
    {error && <div className="ps3-error" role="alert">{error}</div>}
    {tab === 'validation' ? <ValidationPanel subsystem={subsystem} validation={job?.validation ?? model?.validation} model={job?.validation ? undefined : model} selectedModel={job?.validation ? report?.model_name ?? job.reports[0]?.model_name : model?.model_name}/> : report && job?.status === 'completed' ? <>
      <div className="ps3-report-source"><span className={`ps3-source-tag ${job.source}`}><FileCheck2 size={13}/>{job.source === 'organiser_test' ? 'Organiser test input' : 'Uploaded recording'}</span><span>Model prediction · {comparing ? `${job.reports.length} recorded files` : report.file_id}</span></div>
      {comparing ? <PredictionComparison reports={job.reports} subsystem={subsystem} currentFile={report.file_id} onEvidence={fileId => { onFile(fileId); setTab('evidence'); }}/>
        : <>{tab === 'evidence' ? <><div className="ps3-evidence-return"><button type="button" className="ps3-button ps3-button-quiet" onClick={() => { setScope('current'); setTab('predictions'); }}><ArrowLeft size={15}/>Back to file result</button></div><div className="ps3-result-summary"><span className="ps3-kicker">{report.model_name}</span><p>{report.summary}</p></div><EvidenceView key={report.file_id} report={report}/></> : <section key={report.file_id} className="ps3-prediction-details" aria-label="Exact prediction records"><Predictions report={report}/></section>}</>}
    </> : <div className="ps3-results-empty"><div className="ps3-empty-symbol"><ScanLine size={35}/><span/><span/></div><span className="ps3-kicker">{job?.status === 'running' || job?.status === 'queued' ? 'PROCESSING RECORDING' : 'READY WHEN YOU ARE'}</span><h3>{job?.status === 'running' || job?.status === 'queued' ? 'The model is reading your data' : 'Start with a recording'}</h3><p>{task.task} Upload your data or try an official test input to see predictions and the measurements behind them.</p><div className="ps3-output-schema"><small>OUTPUT SCHEMA</small><code>{task.output}</code></div></div>}
  </section>;
}
