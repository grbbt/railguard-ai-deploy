'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Bot, Maximize2, Minimize2, X } from 'lucide-react';
import { clampWindowRect, initialWindowRect, maximizedWindowRect, resizeWindowRect, type ResizeEdge, type WindowRect } from './window-geometry';

type Props = { open: boolean; onClose: () => void; filename?: string; returnFocus?: RefObject<HTMLElement | null>; children: ReactNode };
type ResizeDrag = { edge: ResizeEdge; x: number; y: number; rect: WindowRect; pointer: number; handle: HTMLElement };
const EDGES = [{ edge: 'n', label: 'top' }, { edge: 'e', label: 'right' }, { edge: 's', label: 'bottom' }, { edge: 'w', label: 'left' }] as const;
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
const viewport = () => typeof window === 'undefined' ? { width: 1280, height: 720 } : { width: document.documentElement.clientWidth, height: window.innerHeight };

/** The backdrop and background inert state keep focus inside the active assistant. */
export default function InvestigationWindow({ open, onClose, filename, returnFocus, children }: Props) {
  const frame = useRef<HTMLElement>(null);
  const drag = useRef<ResizeDrag | null>(null);
  const [rect, setRect] = useState(() => initialWindowRect(viewport()));
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const restored = useRef(rect);
  const dismiss = useCallback(() => { setResizing(false); onClose(); }, [onClose]);

  useEffect(() => {
    const resize = () => setRect(current => maximized ? maximizedWindowRect(viewport()) : clampWindowRect(current, viewport()));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [maximized]);

  useEffect(() => {
    if (!open) return;
    const previous = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const panel = frame.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel?.focus({ preventScroll: true });
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); dismiss(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? []].filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      const outside = !panel?.contains(document.activeElement);
      if (!first) { event.preventDefault(); panel?.focus(); }
      else if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      const active = drag.current;
      drag.current = null;
      if (active?.handle.hasPointerCapture(active.pointer)) active.handle.releasePointerCapture(active.pointer);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, dismiss, returnFocus]);

  function startResize(event: PointerEvent<HTMLElement>, edge: ResizeEdge) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, rect, pointer: event.pointerId, handle: event.currentTarget };
    setMaximized(false); setResizing(true);
  }
  function moveResize(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    setRect(resizeWindowRect(active.rect, active.edge, event.clientX - active.x, event.clientY - active.y, viewport()));
  }
  function finishResize(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null; setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLElement>, edge: ResizeEdge) {
    const step = event.shiftKey ? 48 : 16;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!(dx && (edge === 'e' || edge === 'w')) && !(dy && (edge === 'n' || edge === 's'))) return;
    event.preventDefault(); setMaximized(false);
    setRect(current => resizeWindowRect(current, edge, dx, dy, viewport()));
  }
  function toggleMaximize() {
    if (maximized) { setRect(clampWindowRect(restored.current, viewport())); setMaximized(false); }
    else { restored.current = rect; setRect(maximizedWindowRect(viewport())); setMaximized(true); }
  }
  const pointerEvents = { onPointerMove: moveResize, onPointerUp: finishResize, onPointerCancel: finishResize, onLostPointerCapture: finishResize };

  return <>
    {open && <button type="button" className="rg-ai-backdrop" tabIndex={-1} aria-hidden="true" onClick={dismiss} />}
    <section ref={frame} id="investigation-agent" className={`rg-ai-window ${resizing ? 'is-resizing' : ''} ${maximized ? 'is-maximized' : ''}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: 'auto', bottom: 'auto' }} role="dialog" aria-modal="true" aria-labelledby="railguard-ai-title" aria-describedby="railguard-ai-context" tabIndex={-1} hidden={!open} inert={!open}>
      <header className="rg-ai-window-heading"><span><Bot size={21}/></span><div><h2 id="railguard-ai-title">AI investigation</h2><p id="railguard-ai-context" title={filename}>{filename ?? 'Project knowledge & saved results'}</p><small>Drag any edge or corner to resize</small></div><button type="button" onClick={toggleMaximize} aria-label={maximized ? 'Restore AI window size' : 'Maximise AI window'} title={maximized ? 'Restore size' : 'Maximise'}>{maximized ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button><button type="button" onClick={dismiss} aria-label="Close AI investigation" title="Close · Esc"><X size={19}/></button></header>
      {children}
      <span id="ai-resize-help" className="sr-only">Drag to resize. On an edge handle, use arrow keys; hold Shift for larger steps.</span>
      {EDGES.map(({ edge, label }) => <button key={edge} type="button" className={`rg-ai-resize rg-ai-resize-${edge}`} aria-label={`Resize AI window ${label} edge`} aria-describedby="ai-resize-help" onPointerDown={event => startResize(event, edge)} onKeyDown={event => resizeWithKeyboard(event, edge)} {...pointerEvents}/>)}
      {CORNERS.map(edge => <span key={edge} className={`rg-ai-resize rg-ai-resize-${edge}`} aria-hidden="true" onPointerDown={event => startResize(event, edge)} {...pointerEvents}>{edge === 'se' && <svg viewBox="0 0 14 14"><path d="M4 11 11 4M8 11 11 8"/></svg>}</span>)}
    </section>
  </>;
}
