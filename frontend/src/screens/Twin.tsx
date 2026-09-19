'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Info, Maximize2, Minimize2, X } from 'lucide-react';
import type { Detail, TrainSummary } from '@/lib/types';
import { colors, componentLabel, number, time } from '@/lib/utils';
import { ComponentGlyph, Loading, Note, Panel, ScoreRing, StatusBadge } from '@/components/ui';

const DigitalTwin = dynamic(() => import('@/components/DigitalTwin'), {
  ssr: false,
  loading: () => <Loading label="Preparing the digital component view…" />,
});

type Props = {
  train: TrainSummary;
  detail: Detail | null;
  selected: string;
  onSelect: (component: string) => void;
  onExplain: () => void;
  onMaintain: () => void;
};

export default function Twin({ train, detail, selected, onSelect, onExplain, onMaintain }: Props) {
  const inspection = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const wasFullscreen = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');

  useEffect(() => {
    // Escape and browser-native exit controls use this same state path.
    const changed = () => {
      const active = inspection.current !== null && document.fullscreenElement === inspection.current;
      setFullscreen(active);
      setFullscreenPending(false);
      if (wasFullscreen.current && !active) fullscreenButton.current?.focus({ preventScroll: true });
      wasFullscreen.current = active;
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  async function toggleFullscreen() {
    const element = inspection.current;
    if (!element || fullscreenPending) return;
    setFullscreenError('');
    if (document.fullscreenElement !== element && (typeof element.requestFullscreen !== 'function' || document.fullscreenEnabled === false)) {
      setFullscreenError('Fullscreen is unavailable in this browser. You can still orbit and zoom in the inspection panel.');
      return;
    }
    setFullscreenPending(true);
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      setFullscreenError('The browser could not change fullscreen mode. Try again or continue in the inspection panel.');
    } finally {
      setFullscreenPending(false);
    }
  }

  return <>
    <style>{`
      .railguard-inspection{min-width:0;display:flex;flex-direction:column}
      .railguard-inspection>.full-twin-panel{width:100%;flex:1}
      .railguard-inspection .inspection-fullscreen-button{flex-shrink:0;gap:6px;padding:7px 9px;min-height:32px;font-size:10px}
      .railguard-inspection .inspection-fullscreen-error{display:flex;align-items:center;gap:10px;margin:12px 18px 0;padding:9px 12px;border:1px solid #efba6240;border-radius:8px;color:#e1c99e;background:#3c302722;font-size:11px;line-height:1.5}
      .railguard-inspection .inspection-fullscreen-error>span{flex:1}
      .railguard-inspection:fullscreen{width:100vw;height:100dvh;max-width:none;max-height:none;padding:12px;background:#071017;overflow:hidden}
      .railguard-inspection:fullscreen::backdrop{background:#071017}
      .railguard-inspection:fullscreen>.full-twin-panel{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;border-radius:14px}
      .railguard-inspection:fullscreen .panel-heading{flex-shrink:0;padding:13px 18px 12px}
      .railguard-inspection:fullscreen .full-twin-stage{flex:1;min-height:0;height:auto;overflow:hidden}
      .railguard-inspection:fullscreen .railguard-twin{min-height:0!important;border-radius:0!important}
      .railguard-inspection:fullscreen .twin-disclaimer{flex-shrink:0;padding:9px 18px;line-height:1.5}
      .railguard-inspection:fullscreen .inspection-fullscreen-error{flex-shrink:0;margin:0 18px 10px}
      @media(max-width:480px){.railguard-inspection .panel-heading{align-items:flex-start;gap:8px}.railguard-inspection .inspection-fullscreen-button{font-size:9px;padding:6px 8px}.railguard-inspection:fullscreen{padding:6px}.railguard-inspection:fullscreen .panel-heading{padding:11px 12px 10px}.railguard-inspection:fullscreen .panel-heading h2{font-size:13px}.railguard-inspection:fullscreen .twin-disclaimer{padding:8px 12px;font-size:9px}}
      @media(max-height:480px){.railguard-inspection:fullscreen .panel-heading{padding-top:7px;padding-bottom:7px}.railguard-inspection:fullscreen .panel-heading .eyebrow{display:none}.railguard-inspection:fullscreen .twin-header-helper,.railguard-inspection:fullscreen .twin-evidence-hud,.railguard-inspection:fullscreen .twin-car-picker-label{display:none}.railguard-inspection:fullscreen .twin-car-picker{top:40px!important;right:16px!important;left:auto!important}.railguard-inspection:fullscreen .twin-disclaimer{font-size:8px;padding-top:5px;padding-bottom:5px}}
    `}</style>
    <div className="twin-workspace">
      <div className="railguard-inspection" ref={inspection}>
        <Panel title="The anatomy of your trainset" eyebrow={`${train.id} / component explorer`} action={
          <button ref={fullscreenButton} type="button" className="btn btn-secondary inspection-fullscreen-button" onClick={toggleFullscreen} disabled={fullscreenPending} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit fullscreen inspection' : 'Open fullscreen inspection'} title={fullscreen ? 'Exit fullscreen (Esc)' : 'Inspect the model in fullscreen'}>
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        } className="full-twin-panel">
          {fullscreenError && <div className="inspection-fullscreen-error" role="status"><Info size={14} /><span>{fullscreenError}</span><button type="button" className="icon-btn" aria-label="Dismiss fullscreen message" onClick={() => setFullscreenError('')}><X size={14} /></button></div>}
          <div className="full-twin-stage"><DigitalTwin components={train.components} selected={selected} onSelect={onSelect} /></div>
          <div className="twin-disclaimer"><Info size={13} />Conceptual geometry. Component colors reflect the selected dataset; this is not a dimensional engineering model.</div>
        </Panel>
      </div>
      <Panel title={componentLabel[selected] || selected} eyebrow="Selected component" className="twin-detail-panel">
        {detail ? <>
          <div className="twin-condition"><ScoreRing value={detail.risk} status={detail.status} size={112} /><StatusBadge status={detail.status} /></div>
          <h3>{detail.explanation.title}</h3>
          <p className="panel-description">{detail.explanation.summary}</p>
          <dl className="compact-facts"><div><dt>Flagged observations</dt><dd>{number(detail.anomaly_count)}</dd></div><div><dt>Evidence timestamp</dt><dd>{time(detail.evidence_time)} UTC</dd></div><div><dt>Available observations</dt><dd>{number(detail.observations)} records</dd></div></dl>
          <button className="btn btn-primary full-width" onClick={onExplain}>Explain this condition<ArrowUpRight size={16} /></button>
          <button className="btn btn-secondary full-width" onClick={onMaintain}>Maintenance advisory</button>
        </> : <Loading />}
      </Panel>
    </div>
    <div className="component-health-grid">
      {train.components.map(c => <button key={c.component} className={`component-health-card glass-panel ${selected === c.component ? 'selected' : ''}`} onClick={() => onSelect(c.component)}>
        <span className="component-card-icon" style={{ color: colors[c.status] }}><ComponentGlyph component={c.component} size={24} /></span>
        <div><h3>{componentLabel[c.component] || c.component}</h3><StatusBadge status={c.status} compact /></div>
        <div className="component-card-score"><strong>{number(c.risk)}</strong><span>risk index</span></div><ArrowUpRight size={15} />
      </button>)}
    </div>
    <Note>The assembly supports visual inspection of sensor findings. Health changes come from telemetry analysis, not from animation or fault-injection controls.</Note>
  </>;
}
