'use client';

import { useRef, useState } from 'react';
import { ArrowRight, FileSpreadsheet, FileUp, FlaskConical, FolderOpen, LoaderCircle, Play, Upload, X } from 'lucide-react';
import type { Ps3Status, SubsystemId, SubsystemStatus } from '@/lib/ps3-types';
import { ps3Request, SUBSYSTEMS } from './shared';
import { prepareUploadFiles } from './upload-files';

type Props = { subsystem: SubsystemId; status?: SubsystemStatus; limits?: Ps3Status['limits']; onStarted: (id: string, subsystem: SubsystemId) => void; busy: boolean; onTransferChange: (active: boolean) => void; compact?: boolean };

export default function InputPanel({ subsystem, status, limits, onStarted, busy, onTransferChange, compact = false }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [example, setExample] = useState<'one' | 'all' | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const task = SUBSYSTEMS.find(item => item.id === subsystem)!;
  const cap = limits ?? { file_mb: 64, batch_files: 100, batch_mb: 1500 };
  const locked = sending || example !== null || busy;
  const ready = status?.available === true;

  function acceptFiles(incoming: File[]) {
    if (locked) return;
    const result = prepareUploadFiles(subsystem, files, incoming, cap);
    setError(result.error);
    if (!result.error) setFiles(result.files);
    if (input.current) input.current.value = '';
  }

  async function upload() {
    if (locked || !ready || !files.length) return;
    setSending(true); setError(''); onTransferChange(true);
    const form = new FormData();
    form.append('subsystem', subsystem);
    files.forEach(file => form.append('files', file));
    try {
      const response = await ps3Request<{ id: string }>('/api/ps3/jobs', { method: 'POST', body: form });
      setFiles([]); onStarted(response.id, subsystem);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The upload could not be accepted.'); }
    finally { setSending(false); onTransferChange(false); }
  }

  async function runExample(all: boolean) {
    if (locked || !ready) return;
    setExample(all ? 'all' : 'one'); setError(''); onTransferChange(true);
    try {
      const response = await ps3Request<{ id: string }>(`/api/ps3/examples/${subsystem}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all_files: all }) });
      onStarted(response.id, subsystem);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The official input could not be loaded.'); }
    finally { setExample(null); onTransferChange(false); }
  }

  return <section className={`ps3-panel ps3-input-panel${compact ? ' is-workspace-upload' : ''}`} aria-labelledby="ps3-input-heading">
    <div className="ps3-panel-heading"><span className="ps3-section-icon"><FileUp size={17}/></span><div><span className="ps3-kicker">01 / INPUT</span><h2 id="ps3-input-heading">Choose a recording</h2></div></div>
    <p className="ps3-panel-copy">{task.input}. The saved model processes your files without retraining.</p>
    {subsystem === 'acv' && <p className="ps3-input-note">Keep one complete case, including every car&apos;s columns, in each .xlsx workbook. You can upload several case workbooks together.</p>}
    <div className="ps3-upload-workflow"><div className={`ps3-drop ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); acceptFiles(Array.from(event.dataTransfer.files)); }}>
      <Upload size={25}/><strong>Drop your {subsystem === 'acv' ? 'workbooks' : 'recordings'} here</strong>
      <span>{subsystem === 'acv' ? `XLSX · up to ${cap.batch_files} case workbooks` : subsystem === 'door' ? 'CSV · one continuous stream' : `CSV · up to ${cap.batch_files} files`}</span>
      <label className={`ps3-button ps3-button-quiet ps3-file-label ${locked ? 'disabled' : ''}`}><FolderOpen size={14}/>Browse files<input ref={input} type="file" accept={subsystem === 'acv' ? '.xlsx' : '.csv'} multiple={subsystem !== 'door'} disabled={locked} onChange={event => acceptFiles(Array.from(event.target.files ?? []))}/></label>
      <small>{cap.file_mb} MB per file · {cap.batch_mb} MB per batch</small>
    </div>
    {!!files.length && <div className="ps3-file-list" aria-label="Selected upload files"><div><strong>{files.length} file{files.length === 1 ? '' : 's'} selected</strong><button type="button" onClick={() => setFiles([])} disabled={locked}>Clear</button></div>{files.map((file, index) => <div className="ps3-file-row" key={file.name}><FileSpreadsheet size={14}/><span title={file.name}>{file.name}<small>{(file.size / 1024 ** 2).toFixed(2)} MB</small></span><button type="button" disabled={locked} aria-label={`Remove ${file.name}`} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}><X size={14}/></button></div>)}</div>}
    {error && <div className="ps3-error" role="alert">{error}</div>}
    <button className="ps3-button ps3-button-primary ps3-full" type="button" onClick={upload} disabled={!ready || !files.length || locked}>{sending ? <LoaderCircle size={15} className="spin"/> : <Play size={15}/>} {sending ? 'Uploading recordings…' : 'Run analysis'}{!sending && <ArrowRight size={15}/>}</button>
    {sending && <p className="ps3-input-note" role="status">Keep this page open while the upload is accepted.</p>}
    {!ready && <p className="ps3-input-note">{status ? 'A fitted subsystem model is not available yet. Refresh model status when setup completes.' : 'Waiting for the local analysis service.'}</p>}
    </div><div className="ps3-example"><div><FlaskConical size={16}/><strong>Official test recordings</strong></div><p>Run the organiser&apos;s bundled inputs. Their hidden test answers are not available here.</p><div className="ps3-example-actions"><button type="button" className="ps3-button ps3-button-quiet" disabled={!ready || locked || !status?.example_files} onClick={() => runExample(false)}>{example === 'one' ? <LoaderCircle size={14} className="spin"/> : <Play size={13}/>}Try one file</button><button type="button" className="ps3-button ps3-button-quiet" disabled={!ready || locked || !status?.example_files} onClick={() => runExample(true)}>{example === 'all' ? <LoaderCircle size={14} className="spin"/> : <FolderOpen size={13}/>}Run all{status ? ` (${status.example_files})` : ''}</button></div></div>
  </section>;
}
