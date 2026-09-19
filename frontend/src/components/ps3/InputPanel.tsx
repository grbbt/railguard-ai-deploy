'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileSpreadsheet, FileUp, FlaskConical, FolderOpen, LoaderCircle, Play, Upload, X } from 'lucide-react';
import type { Ps3Status, SubsystemId, SubsystemStatus } from '@/lib/ps3-types';
import { ps3Request, SUBSYSTEMS } from './shared';
import { prepareUploadFiles } from './upload-files';
import { prepareUploadPayload, uploadRecordings } from './upload-request';
import type { PreparationProgress, PreparedUpload, UploadProgress } from './upload-request';
import './upload-progress.css';

type Props = { subsystem: SubsystemId; status?: SubsystemStatus; limits?: Ps3Status['limits']; onStarted: (id: string, subsystem: SubsystemId) => void; busy: boolean; onTransferChange: (active: boolean) => void; compact?: boolean };
type Transfer = { abort: AbortController; onTransferChange: Props['onTransferChange'] };

function byteSize(bytes: number) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function remainingTime(seconds: number) {
  const rounded = Math.max(1, Math.ceil(seconds));
  return rounded < 60 ? `about ${rounded}s remaining` : `about ${Math.ceil(rounded / 60)} min remaining`;
}

export default function InputPanel({ subsystem, status, limits, onStarted, busy, onTransferChange, compact = false }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [example, setExample] = useState<'one' | 'all' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<PreparationProgress | UploadProgress | null>(null);
  const [prepared, setPrepared] = useState<Omit<PreparedUpload, 'body'> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeTransfer = useRef<Transfer | null>(null);
  const task = SUBSYSTEMS.find(item => item.id === subsystem)!;
  const cap = limits ?? { file_mb: 64, batch_files: 100, batch_mb: 1500 };
  const locked = sending || example !== null || busy;
  const ready = status?.available === true;

  useEffect(() => () => {
    const transfer = activeTransfer.current;
    activeTransfer.current = null;
    transfer?.abort.abort();
    transfer?.onTransferChange(false);
  }, []);

  function acceptFiles(incoming: File[]) {
    if (locked) return;
    const result = prepareUploadFiles(subsystem, files, incoming, cap);
    setError(result.error); setNotice('');
    if (!result.error) setFiles(result.files);
    if (input.current) input.current.value = '';
  }

  async function upload() {
    if (locked || activeTransfer.current || !ready || !files.length) return;
    const transfer = { abort: new AbortController(), onTransferChange };
    activeTransfer.current = transfer;
    let requestStarted = false;
    setSending(true); setError(''); setNotice(''); setPrepared(null); onTransferChange(true);
    function updateProgress(next: PreparationProgress | UploadProgress) {
      if (activeTransfer.current === transfer && !transfer.abort.signal.aborted) setProgress(next);
    }
    try {
      const payload = await prepareUploadPayload(files, subsystem, { uploadEncodings: cap.upload_encodings, signal: transfer.abort.signal, onProgress: updateProgress });
      if (activeTransfer.current !== transfer || transfer.abort.signal.aborted) return;
      setPrepared({ originalBytes: payload.originalBytes, payloadBytes: payload.payloadBytes, compressedFiles: payload.compressedFiles });
      requestStarted = true;
      const id = await uploadRecordings(payload.body, { signal: transfer.abort.signal, onProgress: updateProgress });
      if (activeTransfer.current !== transfer || transfer.abort.signal.aborted) return;
      setFiles([]); onStarted(id, subsystem);
    } catch (cause) {
      if (activeTransfer.current !== transfer) return;
      if (transfer.abort.signal.aborted) {
        setNotice(requestStarted
          ? 'Upload cancelled. Your files remain selected. The server may already have accepted the request; check saved analyses before retrying.'
          : 'Preparation cancelled. Your files remain selected; nothing was uploaded.');
      } else setError(cause instanceof Error ? cause.message : 'The upload could not be accepted. Check saved analyses before retrying.');
    } finally {
      if (activeTransfer.current === transfer) {
        activeTransfer.current = null;
        setSending(false); setProgress(null); onTransferChange(false);
      }
    }
  }

  async function runExample(all: boolean) {
    if (locked || activeTransfer.current || !ready) return;
    const transfer = { abort: new AbortController(), onTransferChange };
    activeTransfer.current = transfer;
    setExample(all ? 'all' : 'one'); setError(''); setNotice(''); onTransferChange(true);
    try {
      const response = await ps3Request<{ id: string }>(`/api/ps3/examples/${subsystem}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all_files: all }), signal: transfer.abort.signal });
      if (activeTransfer.current === transfer && !transfer.abort.signal.aborted) onStarted(response.id, subsystem);
    } catch (cause) {
      if (activeTransfer.current === transfer && !transfer.abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'The official input could not be loaded.');
    } finally {
      if (activeTransfer.current === transfer) {
        activeTransfer.current = null;
        setExample(null); onTransferChange(false);
      }
    }
  }

  const percent = progress && progress.phase !== 'preparing' && progress.totalBytes !== null
    ? Math.min(100, Math.floor(progress.loadedBytes / progress.totalBytes * 100)) : null;
  const transferLabel = progress?.phase === 'preparing' ? `Preparing file ${progress.fileIndex} of ${progress.fileCount}`
    : progress?.phase === 'waiting' ? 'Waiting for server'
      : percent === null ? 'Uploading recordings' : `Uploading ${percent}%`;
  const savedBytes = prepared ? prepared.originalBytes - prepared.payloadBytes : 0;

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
    {notice && <p className="ps3-input-note ps3-upload-notice" role="status">{notice}</p>}
    <button className="ps3-button ps3-button-primary ps3-full" type="button" onClick={upload} disabled={!ready || !files.length || locked}>{sending ? <LoaderCircle size={15} className="spin"/> : <Play size={15}/>} {sending ? transferLabel : 'Run analysis'}{!sending && <ArrowRight size={15}/>}</button>
    {sending && progress && <div className="ps3-upload-progress">
      <div className="ps3-upload-progress-heading"><strong role="status">{transferLabel}</strong><button type="button" className="ps3-button ps3-button-quiet" onClick={() => activeTransfer.current?.abort.abort()}><X size={13}/>Cancel upload</button></div>
      <progress max={100} value={progress.phase === 'waiting' ? 100 : progress.phase === 'preparing' ? undefined : percent ?? undefined} aria-label={progress.phase === 'preparing' ? 'Preparing recordings' : 'Recording transfer progress'}/>
      {progress.phase === 'preparing' ? <p className="ps3-upload-filename" title={progress.fileName}>{progress.fileName}</p>
        : <p>{progress.loadedBytes > 0 ? `${byteSize(progress.loadedBytes)} sent${progress.totalBytes === null ? '' : ` of ${byteSize(progress.totalBytes)}`}` : progress.phase === 'waiting' ? 'Recording transfer finished.' : 'Starting transfer…'}{progress.phase === 'uploading' && progress.bytesPerSecond !== null && <> · {byteSize(progress.bytesPerSecond)}/s{progress.etaSeconds !== null && ` · ${remainingTime(progress.etaSeconds)}`}</>}</p>}
      {prepared && savedBytes > 0 && <p className="ps3-upload-savings">Compressed CSVs: {byteSize(savedBytes)} saved ({Math.round(savedBytes / prepared.originalBytes * 100)}%). Original data is unchanged.</p>}
      <p className="ps3-upload-phase-note">{progress.phase === 'waiting' ? 'The bytes have been sent. Waiting for the server to accept the analysis; keep this page open.' : progress.phase === 'preparing' ? 'Preparing the selected recordings for transfer. Original files stay unchanged.' : 'This is transfer progress. Analysis starts after the server accepts the upload.'}</p>
    </div>}
    {!ready && <p className="ps3-input-note">{status ? 'A fitted subsystem model is not available yet. Refresh model status when setup completes.' : 'Waiting for the analysis service.'}</p>}
    </div><div className="ps3-example"><div><FlaskConical size={16}/><strong>Official test recordings</strong></div><p>Run the organiser&apos;s bundled inputs. Their hidden test answers are not available here.</p><div className="ps3-example-actions"><button type="button" className="ps3-button ps3-button-quiet" disabled={!ready || locked || !status?.example_files} onClick={() => runExample(false)}>{example === 'one' ? <LoaderCircle size={14} className="spin"/> : <Play size={13}/>}Try one file</button><button type="button" className="ps3-button ps3-button-quiet" disabled={!ready || locked || !status?.example_files} onClick={() => runExample(true)}>{example === 'all' ? <LoaderCircle size={14} className="spin"/> : <FolderOpen size={13}/>}Run all{status ? ` (${status.example_files})` : ''}</button></div></div>
  </section>;
}
