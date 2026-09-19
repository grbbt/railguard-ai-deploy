'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import type { PredictionReport } from '@/lib/ps3-types';
import { ps3Request } from '@/components/ps3/shared';
import { summarizePrediction } from '@/components/ps3/prediction-comparison';
import { createSummaryCache, instantSummary, instantRunSummary, measuredSummary, runSummaryKey, summaryCaution, summaryKey, validSummary, validRunSummary, type ResultBrief, type SummaryScope } from './result-summary';

const summaries = createSummaryCache();
type Props = { report: PredictionReport; reports: PredictionReport[]; scope: SummaryScope; jobId: string; aiAvailable: boolean; onScopeChange?: (scope: SummaryScope) => void };

export default function ResultSummary({ report, reports, scope, jobId, aiAvailable, onScopeChange }: Props) {
  const all = scope === 'all';
  const fileCountLabel = `${reports.length} file${reports.length === 1 ? '' : 's'}`;
  const key = useMemo(() => all ? runSummaryKey(jobId, reports) : summaryKey(jobId, report), [jobId, report, reports, all]);
  const prediction = summarizePrediction(report);
  const fallback = all ? instantRunSummary(reports.map(summarizePrediction)) : [instantSummary(prediction), measuredSummary(report, prediction)].filter(Boolean).join(' ');
  const inputFlags = all ? reports.filter(item => summaryCaution(item)).length : 0;
  const caution = all ? inputFlags ? `${inputFlags} of ${reports.length} recordings have input conditions to review. See their analysis notes before interpreting the results.` : null : summaryCaution(report);
  const [answer, setAnswer] = useState<{ key: string; result?: ResultBrief; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = answer?.key === key ? answer : null;
  const loading = aiAvailable && !current;
  const ai = current?.result?.mode === 'ai';

  useEffect(() => {
    if (!aiAvailable) return;
    let active = true;
    // Briefly debounce selection changes; switching files should not spend on skipped results.
    const start = setTimeout(() => {
      summaries.get(key, async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const result = await ps3Request<unknown>('/api/ps3/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(all ? { job_id: jobId, scope: 'run' } : { job_id: jobId, scope: 'file', file_id: report.file_id }), signal: controller.signal });
          if (all && validRunSummary(result, reports.length) || !all && validSummary(result, report.file_id)) return result;
          throw new Error('Summary did not match the selected results.');
        } catch {
          const identity = all ? { scope: 'run' as const, file_count: reports.length } : { file_id: report.file_id };
          return { summary: fallback, mode: 'local', cached: false, ...identity, warning: 'AI summary is temporarily unavailable. The saved results are shown.' };
        } finally { clearTimeout(timeout); }
      }).then(result => { if (active) setAnswer({ key, result }); }, () => { if (active) setAnswer({ key, failed: true }); });
    }, 300);
    return () => { active = false; clearTimeout(start); };
  }, [key, jobId, report.file_id, reports.length, all, fallback, aiAvailable, attempt]);

  function retry() { summaries.forget(key); setAnswer(null); setAttempt(value => value + 1); }
  return <section className="rg-file-summary" aria-label={all ? 'All files summary' : 'File summary'}>
    <div className="rg-file-summary-heading"><span className="rg-summary-icon"><Sparkles size={19}/></span><h2>In brief</h2><span className={`rg-summary-badge ${ai ? 'is-ai' : ''}`}>{loading ? <><LoaderCircle size={12} className="spin"/>Writing AI summary</> : ai ? <><Sparkles size={12}/>AI summary</> : <><FileText size={12}/>Saved result</>}</span></div>
    {onScopeChange && <div className="rg-summary-scope" role="group" aria-label="Summary scope"><button type="button" aria-pressed={!all} onClick={() => onScopeChange('current')}>Current file</button><button type="button" aria-pressed={all} onClick={() => onScopeChange('all')}>All files ({reports.length})</button></div>}
    <p className="rg-file-summary-text" aria-live="polite" aria-atomic="true">{current?.result?.summary ?? fallback}</p>
    {caution && <p className="rg-file-summary-caution">{caution}</p>}
    <div className="rg-file-summary-source"><span title={all ? `${fileCountLabel} in the selected analysis run` : report.file_id}>{all ? `${fileCountLabel} · Selected analysis run` : `${report.file_id} · Whole recording`}</span>{aiAvailable && current && !ai && <button type="button" onClick={retry} title={current.result?.warning ?? 'The saved result is available. Retry the AI wording.'}><RefreshCw size={12}/>Retry AI summary</button>}</div>
  </section>;
}
