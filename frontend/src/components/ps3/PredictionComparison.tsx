'use client';

import { useMemo, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleHelp, Search, X } from 'lucide-react';
import type { PredictionReport, SubsystemId } from '@/lib/ps3-types';
import { selectComparisonRows, summarizePrediction, type PredictionSummary } from './prediction-comparison';
import { displayValue } from './shared';
import './prediction-comparison.css';

const PAGE_SIZE = 20;
const CONTEXT: Record<SubsystemId, string> = {
  acv: 'Compare each recording’s car ranking from first to last. Car IDs belong to their source recording; matching IDs do not establish the same physical train.',
  door: 'Compare candidate actions and abnormal-resistance classifications in each recording. These counts require engineering review.',
  rail: 'Compare recording-level corrugation classes. Side I and Side II are predicted rail sides, not confirmed faults or individual axle diagnoses.',
  shm: 'Compare cumulative fatigue-damage estimates for the recorded inputs. Recording duration and loading affect this value; it is not a damage percentage or remaining life.',
};

function RunSummary({ rows, subsystem }: { rows: PredictionSummary[]; subsystem: SubsystemId }) {
  const damage = rows.flatMap(row => row.damage === null ? [] : [row.damage]);
  const metrics = subsystem === 'rail' ? ['Normal', 'Side I', 'Side II'].map(value => ({ label: `Predicted ${value}`, value: rows.filter(row => row.railClass === value).length }))
    : subsystem === 'door' ? [
      { label: 'Candidate actions', value: rows.reduce((sum, row) => sum + (row.totalActions ?? 0), 0) },
      { label: 'Abnormal resistance', value: rows.reduce((sum, row) => sum + (row.abnormalActions ?? 0), 0) },
      { label: 'Predicted normal', value: rows.reduce((sum, row) => sum + (row.normalActions ?? 0), 0) },
    ] : subsystem === 'acv' ? [
      { label: 'Rankings returned', value: rows.filter(row => row.hasPrediction).length },
      { label: 'Files with unavailable cars', value: rows.filter(row => row.unavailableCars.length).length },
      { label: 'Files with review notes', value: rows.filter(row => row.warnings).length },
    ] : [
      { label: 'Damage estimates', value: damage.length },
      { label: 'Lowest estimate', value: damage.length ? Math.min(...damage) : null },
      { label: 'Highest estimate', value: damage.length ? Math.max(...damage) : null },
    ];
  return <div className="ps3-compare-metrics" aria-label="Summary of all files in this run">{metrics.map(metric => <article key={metric.label}><span>{metric.label}</span><strong>{displayValue(metric.value, 6)}</strong></article>)}</div>;
}

function FileResult({ row, maxDamage }: { row: PredictionSummary; maxDamage: number }) {
  if (!row.hasPrediction) return <span className="ps3-compare-missing">{row.result}</span>;
  if (row.subsystem === 'acv') return <div className="ps3-compare-ranking"><ol aria-label={`Car ranking for ${row.fileId}, first to last`}>{row.ranking.map((car, index) => <li key={car} className={row.unavailableCars.includes(car) ? 'unavailable' : ''} title={`Rank ${index + 1}: Car ${car}${row.unavailableCars.includes(car) ? ' · usable cooling evidence unavailable' : ''}`}><small>{index + 1}</small><span>{car}</span>{row.unavailableCars.includes(car) && <span className="sr-only">, usable cooling evidence unavailable</span>}</li>)}</ol>{row.unavailableCars.length > 0 && <small className="ps3-compare-note">Cooling evidence unavailable: {row.unavailableCars.map(car => `Car ${car}`).join(', ')}</small>}</div>;
  if (row.subsystem === 'door') return <div className="ps3-compare-actions"><strong>{row.abnormalActions} abnormal</strong><span>{row.normalActions} normal · {row.totalActions} total</span>{Boolean(row.unknownActions) && <small>{row.unknownActions} unrecognised labels</small>}</div>;
  if (row.subsystem === 'rail') return <span className={`ps3-compare-class ${row.railClass === 'Normal' ? 'normal' : 'side'}`}>{row.railClass}</span>;
  return <div className="ps3-compare-damage"><strong>{displayValue(row.damage, 6)}</strong><span className="ps3-compare-bar" aria-hidden="true"><i style={{ width: `${maxDamage > 0 ? Math.max(0, (row.damage ?? 0) / maxDamage * 100) : 0}%` }}/></span></div>;
}

type Sort = 'filename' | 'result' | 'value-desc' | 'value-asc' | 'warnings-desc';
type Props = { reports: PredictionReport[]; subsystem: SubsystemId; currentFile: string; onEvidence: (fileId: string) => void };

export default function PredictionComparison({ reports, subsystem, currentFile, onEvidence }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<Sort>('filename');
  const [page, setPage] = useState(0);
  const summaries = useMemo(() => reports.map(summarizePrediction), [reports]);
  const filtered = useMemo(() => selectComparisonRows(summaries, { query, sort }).filter(row => {
    if (filter === 'notes') return row.warnings > 0;
    if (filter === 'missing') return !row.hasPrediction || row.unavailableCars.length > 0;
    if (filter === 'abnormal') return (row.abnormalActions ?? 0) > 0;
    return filter === 'all' || row.railClass === filter;
  }), [summaries, query, sort, filter]);
  const maxDamage = Math.max(0, ...summaries.map(row => row.damage ?? 0));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const first = currentPage * PAGE_SIZE;
  const missing = summaries.filter(row => !row.hasPrediction).length;
  const resultHeading = { acv: 'Car ranking · first → last', door: 'Detected actions', rail: 'Predicted class', shm: 'Cumulative damage' }[subsystem];
  function resetFilters() { setQuery(''); setFilter('all'); setPage(0); }

  return <section className="ps3-comparison" aria-labelledby="ps3-comparison-heading">
    <div className="ps3-compare-heading"><div><span className="ps3-kicker">RUN COMPARISON</span><h3 id="ps3-comparison-heading">Every file, one view</h3></div><span>{reports.length} file{reports.length === 1 ? '' : 's'}</span></div>
    <p className="ps3-compare-intro">{CONTEXT[subsystem]}</p>
    <RunSummary rows={summaries} subsystem={subsystem}/>
    {missing > 0 && <p className="ps3-compare-note">{missing} file{missing === 1 ? ' has' : 's have'} no recognised prediction. Open the evidence to review.</p>}
    {reports.length === 1 && <p className="ps3-compare-note"><CircleHelp size={14}/>{subsystem === 'door' ? 'Door runs use one continuous recording. Choose Current file to see every detected action in this stream.' : 'This run contains one file. Select a saved batch or run multiple files to compare more recordings.'}</p>}
    <div className="ps3-compare-toolbar">
      <label className="ps3-compare-search"><Search size={15}/><span className="sr-only">Search comparison files</span><input type="search" value={query} placeholder="Find a file…" onChange={event => { setQuery(event.target.value); setPage(0); }}/>{query && <button type="button" aria-label="Clear file search" onClick={() => { setQuery(''); setPage(0); }}><X size={14}/></button>}</label>
      <label><span>Show</span><select aria-label="Filter comparison files" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="all">All results</option>{subsystem === 'rail' && <><option value="Normal">Normal</option><option value="Side I">Side I</option><option value="Side II">Side II</option></>}{subsystem === 'door' && <option value="abnormal">Abnormal actions</option>}<option value="notes">With review notes</option><option value="missing">Missing results / evidence</option></select></label>
      <label><span>Sort</span><select aria-label="Sort comparison files" value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(0); }}><option value="filename">Filename</option>{subsystem === 'rail' && <option value="result">Predicted class</option>}{(subsystem === 'shm' || subsystem === 'door') && <><option value="value-desc">{subsystem === 'shm' ? 'Damage' : 'Abnormal count'}: high to low</option><option value="value-asc">{subsystem === 'shm' ? 'Damage' : 'Abnormal count'}: low to high</option></>}<option value="warnings-desc">Most review notes</option></select></label>
    </div>
    <div className="ps3-compare-count"><span role="status">{filtered.length} of {reports.length} files shown</span>{(query || filter !== 'all') && <button type="button" onClick={resetFilters}>Reset filters</button>}<small>Summary and CSV include the full run.</small></div>
    {filtered.length ? <><div className="ps3-table-scroll ps3-compare-table" tabIndex={0} role="region" aria-label="File prediction comparison, scroll horizontally if needed"><table><caption className="sr-only">Predictions for files in the selected run. Open evidence to select a recording.</caption><thead><tr><th scope="col">Source file</th><th scope="col">{resultHeading}</th><th scope="col">Review</th><th scope="col"><span className="sr-only">Open file evidence</span></th></tr></thead><tbody>{filtered.slice(first, first + PAGE_SIZE).map(row => <tr key={row.fileId} className={row.fileId === currentFile ? 'is-current' : ''}><th scope="row"><span className="ps3-compare-filename">{row.fileId}</span>{row.fileId === currentFile && <small className="ps3-compare-selected">Current file</small>}</th><td><FileResult row={row} maxDamage={maxDamage}/></td><td><span className="ps3-compare-review">{row.warnings ? `${row.warnings} note${row.warnings === 1 ? '' : 's'}` : 'No notes'}</span><small className="ps3-compare-note">{row.evidenceCount} evidence</small></td><td><button type="button" className="ps3-compare-open" aria-label={`Open evidence for ${row.fileId}`} onClick={() => onEvidence(row.fileId)}>Evidence<ArrowUpRight size={14}/></button></td></tr>)}</tbody></table></div>
      <div className="ps3-pagination"><span>Files {first + 1}–{Math.min(first + PAGE_SIZE, filtered.length)} of {filtered.length}</span><div><button type="button" className="ps3-icon-button" disabled={currentPage === 0} aria-label="Previous comparison files" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16}/></button><span>{currentPage + 1} / {pages}</span><button type="button" className="ps3-icon-button" disabled={currentPage >= pages - 1} aria-label="Next comparison files" onClick={() => setPage(currentPage + 1)}><ChevronRight size={16}/></button></div></div>
    </> : <div className="ps3-compare-empty"><Search size={23}/><h4>No matching files</h4><p>Try another filename or clear the filters.</p><button type="button" className="ps3-button ps3-button-quiet" onClick={resetFilters}>Show all files</button></div>}
    <p className="ps3-compare-footnote">{subsystem === 'shm' ? 'Bars share a scale relative to the largest estimate in this run; no safety threshold is implied. ' : ''}These are saved model predictions. Comparing them does not measure accuracy without verified answers.</p>
  </section>;
}
