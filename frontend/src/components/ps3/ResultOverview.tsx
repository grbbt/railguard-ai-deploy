import { Activity, ArrowRight, Box, DoorOpen, Fan, FileCheck2, TrainTrack } from 'lucide-react';
import type { PredictionReport } from '@/lib/ps3-types';
import { summarizePrediction } from './prediction-comparison';
import { describePrediction } from './result-overview';
import './result-overview.css';

type Props = { report: PredictionReport; onEvidence: () => void; onInspect3D?: () => void };

export default function ResultOverview({ report, onEvidence, onInspect3D }: Props) {
  const summary = summarizePrediction(report);
  const result = describePrediction(summary);
  const unknownEvidenceCars = summary.unknownEvidenceCars ?? [];
  const Icon = summary.kind === 'actions' ? DoorOpen : summary.kind === 'ranking' ? Fan : summary.kind === 'class' ? TrainTrack : Activity;
  const needsReview = summary.hasPrediction && (summary.kind === 'actions' ? (summary.abnormalActions ?? 0) > 0 : summary.kind === 'ranking' ? !summary.unavailableCars.includes(summary.ranking[0]) && !unknownEvidenceCars.includes(summary.ranking[0]) : summary.kind === 'class' && summary.railClass !== 'Normal');
  return <section className="ps3-result-overview" aria-labelledby="ps3-file-result-heading">
    <div className="ps3-result-hero">
      <div className={`ps3-result-emblem${needsReview ? ' needs-review' : ''}`} aria-hidden="true"><Icon size={38} strokeWidth={1.5}/></div>
      <div className="ps3-result-conclusion">
        <p className="ps3-result-label">{result.label}</p>
        <h3 id="ps3-file-result-heading">{result.value}</h3>
        <p>{result.description}</p>
      </div>
      <div className="ps3-result-next">
        <button type="button" className="ps3-button ps3-button-primary" onClick={onEvidence}>Supporting evidence<ArrowRight size={16}/></button>
        {onInspect3D && <button type="button" className="ps3-button ps3-button-quiet" onClick={onInspect3D}><Box size={16}/>3D + AI investigation</button>}
      </div>
    </div>
    {!!result.facts.length && <dl className={`ps3-result-facts${result.facts.length === 1 ? ' is-single' : ''}`}>{result.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    {!!summary.ranking.length && <div className="ps3-result-order">
      <p>Inspection order <span>First → last</span></p>
      <ol aria-label="Predicted car inspection order">{summary.ranking.map((car, index) => <li key={car} className={summary.unavailableCars.includes(car) || unknownEvidenceCars.includes(car) ? 'is-unavailable' : ''}><span>Rank {index + 1}</span><strong>Car {car}</strong>{summary.unavailableCars.includes(car) ? <small>No evidence</small> : unknownEvidenceCars.includes(car) && <small>No saved evidence</small>}</li>)}</ol>
      {(!!summary.unavailableCars.length || !!unknownEvidenceCars.length) && <p className="ps3-result-unavailable"><strong>Ranking coverage.</strong> {!!summary.unavailableCars.length && <>Evidence unavailable: {summary.unavailableCars.map(car => `Car ${car}`).join(', ')}. </>}{!!unknownEvidenceCars.length && <>Evidence status not saved: {unknownEvidenceCars.map(car => `Car ${car}`).join(', ')}. </>}These positions preserve the model output; source review is required.</p>}
    </div>}
    <p className="ps3-result-limit"><strong>Output definition</strong><span>{result.limit}</span></p>
    <div className="ps3-result-provenance"><span className="ps3-result-file"><FileCheck2 size={13}/><span>{report.file_id}</span></span><small className="ps3-result-model">Model: {report.model_name}</small></div>
  </section>;
}
