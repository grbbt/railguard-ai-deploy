'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, LoaderCircle, UploadCloud, X } from 'lucide-react';
import type { Dashboard } from '@/lib/types';
import { number, request } from '@/lib/utils';
import { Note } from './ui';

const MAX_BYTES = 20 * 1024 * 1024;
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), [tabindex="0"]';

export default function UploadDialog({ open, onClose, onUploaded }: {
  open: boolean;
  onClose: () => void;
  onUploaded: (dashboard: Dashboard) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const activeRequest = useRef(0);
  const closeHandler = useRef(onClose);
  const busy = useRef(uploading);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => { closeHandler.current = onClose; busy.current = uploading; }, [onClose, uploading]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter(element => !element.hidden && element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? dialog.current)?.focus();
    const frame = requestAnimationFrame(focusFirst);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy.current) closeHandler.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', containFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => () => { activeRequest.current += 1; controller.current?.abort(); }, []);

  function chooseFile(candidate?: File) {
    if (!candidate || uploading) return;
    if (!candidate.name.toLowerCase().endsWith('.csv')) {
      setError('Choose a CSV file with a .csv extension.');
      return;
    }
    if (candidate.size === 0 || candidate.size > MAX_BYTES) {
      setError(candidate.size === 0 ? 'This file is empty. Choose a CSV containing telemetry.' : 'This file exceeds the 20 MB upload limit.');
      return;
    }
    setFile(candidate);
    setError('');
  }

  async function upload() {
    if (!file || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const id = ++activeRequest.current;
    setUploading(true);
    setError('');
    try {
      const body = new FormData();
      body.append('file', file);
      const dashboard = await request<Dashboard>('/api/datasets', { method: 'POST', body, signal: abort.signal });
      if (id !== activeRequest.current || abort.signal.aborted) return;
      onUploaded(dashboard);
      setFile(null);
      onClose();
    } catch (cause) {
      if (id !== activeRequest.current || abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Upload failed. Please try again.');
    } finally {
      if (id === activeRequest.current) { controller.current = null; setUploading(false); }
    }
  }

  function cancelUpload() {
    activeRequest.current += 1;
    controller.current?.abort();
    controller.current = null;
    setUploading(false);
    setError('Upload canceled. Your current dataset is still selected.');
  }

  if (!open) return null;
  return <div className="modal-backdrop" onClick={event => {
    if (event.target === event.currentTarget && !uploading) onClose();
  }}>
    <div ref={dialog} className="modal upload-modal" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <div className="modal-header">
        <div><div className="eyebrow">YOUR TELEMETRY</div><h2 id={titleId}>Bring your fleet into focus</h2></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={uploading} aria-label="Close upload dialog"><X size={20}/></button>
      </div>
      <p id={descriptionId} className="modal-description">Upload sensor readings to train the detector and build evidence for your dataset.</p>
      <div className={`upload-drop ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={event => { event.preventDefault(); if (!uploading) setDragging(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => {
          event.preventDefault(); setDragging(false);
          if (uploading) return;
          if (event.dataTransfer.files.length > 1) { setError('Choose one CSV at a time.'); return; }
          chooseFile(event.dataTransfer.files[0]);
        }}>
        <div className="upload-drop-icon">{file ? <FileSpreadsheet size={30}/> : <UploadCloud size={30}/>}</div>
        <strong>{file ? file.name : 'Drop a telemetry CSV here'}</strong>
        <span>{file ? `${number(file.size / 1024, 1)} KB · ready to analyze` : 'or choose a file from your computer'}</span>
        <input ref={input} type="file" accept=".csv,text/csv" hidden disabled={uploading} aria-label="Telemetry CSV file"
          onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }}/>
        <button type="button" className="btn btn-secondary" disabled={uploading} onClick={() => input.current?.click()}>
          {file ? 'Choose another file' : 'Choose CSV'}
        </button>
        <small>CSV format · up to 20 MB</small>
      </div>
      <div className="upload-schema">
        <div className="form-label">RECOMMENDED STRUCTURE</div>
        <code>timestamp, train_id, component, sensor_1, sensor_2, …</code>
        <p>Use ISO 8601 timestamps and numeric sensor measurements. Train and component identifiers preserve grouping. Numeric sensors are detected automatically; labels and identifiers are excluded.</p>
        <a className="text-link" href="/api/datasets/demo/export" download><Download size={14}/> Download synthetic example</a>
      </div>
      <Note>The first chronological 40% becomes the reference interval. Include representative normal operation. Missing readings are reported; anomaly scores are risk indicators, not failure probabilities.</Note>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {uploading && <div className="upload-progress" role="status"><LoaderCircle size={17} className="spin"/>Reading telemetry and fitting the detector…</div>}
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={uploading ? cancelUpload : onClose}>{uploading ? 'Cancel upload' : 'Cancel'}</button>
        <button type="button" className="btn btn-primary" disabled={!file || uploading} onClick={upload}>
          {uploading ? <LoaderCircle size={16} className="spin"/> : <CheckCircle2 size={16}/>} {uploading ? 'Analyzing…' : 'Analyze dataset'}
        </button>
      </div>
    </div>
  </div>;
}
