'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUp, ArrowUpRight, BookOpen, Bot, Check, CircleHelp, ClipboardList, Copy, Files, FolderSearch, Layers3, LoaderCircle, Microscope, ShieldCheck, Sparkles, Square, Trash2, Wrench } from 'lucide-react';
import type { Investigation, PredictionReport, Ps3Status } from '@/lib/ps3-types';
import { ps3Request } from './shared';
import { answerBlocks, conversationHistory, createConversationStore, investigationBrief, readConversation, type InvestigationContext, type InvestigationExchange, type InvestigationScope } from './investigation-state';
import { createQuestionScrollAnchor } from './investigation-scroll';
import './investigation.css';

type Props = { assistant?: Ps3Status['assistant']; jobId?: string; report: PredictionReport | null; fileCount?: number; defaultScope?: InvestigationScope; compact?: boolean; visible?: boolean; component?: { label: string; status: string } | null };
const SESSION_KEY = 'railguard.investigations.v2';
const SESSION_EVENT = 'railguard-investigations-change';
const conversationStore = createConversationStore(() => sessionStorage, SESSION_KEY);
const sessionSnapshot = conversationStore.snapshot;
function subscribe(listener: () => void) { window.addEventListener(SESSION_EVENT, listener); return () => window.removeEventListener(SESSION_EVENT, listener); }
function saveConversation(update: (previous: InvestigationExchange[]) => InvestigationExchange[]) {
  conversationStore.update(update);
  window.dispatchEvent(new Event(SESSION_EVENT));
}

const TOOL_LABELS: Record<string, string> = {
  get_project_overview: 'Read project overview', search_project_knowledge: 'Search project knowledge', list_saved_runs: 'Find saved analysis runs',
  compare_run_files: 'Compare recording results', inspect_recording: 'Inspect recording evidence', get_model_details: 'Review model and validation',
  get_prediction_evidence: 'Read prediction and evidence', get_validation_results: 'Check measured validation', get_signal_summary: 'Inspect signal summary', get_subsystem_reference: 'Read subsystem reference',
};

function inlineText(value: string, sources: Investigation['sources'], exchangeId: string): ReactNode[] {
  const expression = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\])/g;
  return value.split(expression).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    const source = part.startsWith('[') ? sources.find(item => `[${item.id}]` === part) : undefined;
    if (source) {
      const targetId = `source-${exchangeId}-${encodeURIComponent(source.id)}`;
      return <a key={index} className="rg-citation" href={`#${targetId}`} title={source.label} onClick={event => {
        const target = document.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
        target.querySelectorAll('details').forEach(detail => { detail.open = true; });
        target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }}>{part}</a>;
    }
    return part;
  });
}

function Answer({ answer, sources, exchangeId }: { answer: string; sources: Investigation['sources']; exchangeId: string }) {
  const blocks = useMemo(() => answerBlocks(answer), [answer]);
  const inline = (value: string) => inlineText(value, sources, exchangeId);
  return <div className="rg-agent-prose">{blocks.map((block, index) => {
    if (block.type === 'heading') return block.level <= 2 ? <h3 key={index}>{inline(block.text)}</h3> : <h4 key={index}>{inline(block.text)}</h4>;
    if (block.type === 'code') return <pre key={index}><code>{block.text}</code></pre>;
    if (block.type === 'quote') return <blockquote key={index}>{inline(block.text)}</blockquote>;
    if (block.type === 'list') return block.ordered ? <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol> : <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>;
    if (block.type === 'table') return <div className="rg-agent-table" tabIndex={0} role="region" aria-label="Investigation comparison table" key={index}><table><thead><tr>{block.headers.map((cell, cellIndex) => <th scope="col" key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
    return <p key={index}>{inline(block.text)}</p>;
  })}</div>;
}

const WORKFLOWS = [
  { label: 'Explain the project', detail: 'Architecture, datasets and how it works', icon: FolderSearch, scope: 'project' as const, question: 'Explain how RailGuard works end to end, including the four PS3 tasks, the trained models, how the AI investigation uses tools, and what the map and 3D view can genuinely show. Cite the project documentation and separate implemented features from planned work.' },
  { label: 'Check model reliability', detail: 'Measured performance and validation coverage', icon: ShieldCheck, scope: 'project' as const, question: 'Assess our four models using measured validation, training versus unseen data, validation coverage and the next review checks. Distinguish local model-selection scores from independent or official Test accuracy and cite sources.' },
  { label: 'Compare files', detail: 'Patterns and missing evidence across a run', icon: Files, scope: 'run' as const, question: 'Compare every available file in the selected analysis run. Summarise the outputs, identify differences and data-quality limitations, and choose recordings worth engineering review using the actual evidence. Keep anonymous recordings separate and explain what the comparison cannot establish.' },
  { label: 'Investigate this result', detail: 'Follow the prediction back to its evidence', icon: Microscope, scope: 'file' as const, question: 'Investigate this recording. Explain the prediction using its measured evidence, inspect missing data and model limitations, and describe plausible interpretations and checks an engineer should perform. Clearly distinguish model output, observed measurement, and hypothesis.' },
  { label: 'Prepare an inspection brief', detail: 'Evidence, open questions and review steps', icon: ClipboardList, scope: 'file' as const, question: 'Prepare a concise engineering inspection brief for this recording: observed measurements, model output, unresolved questions, missing evidence, recommended verification steps, and references. Do not invent fault confirmation, safety clearance, maintenance urgency, or remaining useful life.' },
  { label: 'Plan the hackathon demo', detail: 'An honest story backed by working features', icon: Sparkles, scope: 'project' as const, question: 'Prepare a practical three-minute hackathon demonstration plan for RailGuard using its actual implemented workflow. Explain the project value, how to demonstrate the four PS3 tasks and the tool-using investigation, the measured validation and caveats, and the most valuable remaining improvements. Cite project sources.' },
];

export default function InvestigationPanel({ assistant, jobId, report, fileCount = 0, defaultScope = 'project', compact = false, visible = true, component }: Props) {
  const raw = useSyncExternalStore(subscribe, sessionSnapshot, () => '[]');
  const history = useMemo(() => readConversation(raw), [raw]);
  const [scope, setScope] = useState<InvestigationScope>(defaultScope);
  const [question, setQuestion] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<string | null>(null);
  const mounted = useRef(true);
  const scrollBody = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const exchanges = useRef(new Map<string, HTMLElement>());
  const questionAnchor = useRef(createQuestionScrollAnchor());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(activeId);
  const enabled = scope === 'project' || Boolean(jobId && (scope === 'run' || report));
  const contextDescription = scope === 'project' ? 'Project documentation, four models and the saved-run library' : scope === 'run' ? jobId ? `${fileCount} recording${fileCount === 1 ? '' : 's'} in the selected run · ${jobId.slice(0, 8)}` : 'Select a completed analysis run to compare its files' : report && jobId ? report.file_id : 'Select a completed recording to investigate its evidence';
  const lastResponse = history.reduce<Investigation | undefined>((latest, item) => item.response ?? latest, undefined);
  const provider = assistant?.provider ?? 'OpenAI';
  const modeLabel = lastResponse?.mode === 'agent' ? `Last answer · ${provider} agent` : lastResponse?.mode === 'local' ? 'Last answer · local evidence' : !assistant ? 'Checking provider configuration' : assistant.available ? `${provider} configured` : 'Local evidence available';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
      if (pending.current) saveConversation(previous => previous.map(item => item.id === pending.current ? { ...item, error: 'You left this investigation while it was running. Send the question again to continue.' } : item));
    };
  }, []);
  useEffect(() => {
    if (!activeId) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [activeId]);
  useLayoutEffect(() => {
    const anchor = questionAnchor.current;
    if (!visible) { anchor.cancel(); return; }
    const id = anchor.pendingId;
    const viewport = compact ? scrollBody.current : conversation.current;
    const exchange = id ? exchanges.current.get(id) : undefined;
    if (!id || !viewport || !exchange) return;
    // The standalone conversation grows up to its CSS cap; the popup has a
    // fixed flex viewport. Only this container moves, never the workspace.
    const minimumHeight = compact ? viewport.clientHeight : Number.parseFloat(getComputedStyle(viewport).maxHeight);
    anchor.apply(id, viewport, exchange, minimumHeight);
  }, [history, compact, visible]);

  function requestContext(targetScope: InvestigationScope): InvestigationContext {
    return { scope: targetScope, label: targetScope === 'project' ? 'Project' : targetScope === 'run' ? `Selected run · ${fileCount} files` : `Current file · ${report?.file_id ?? 'not selected'}`, ...(jobId ? { jobId } : {}), ...(report?.file_id ? { fileId: report.file_id } : {}) };
  }

  async function investigate(text: string, targetScope = scope) {
    const value = text.trim();
    if (value.length < 3 || value.length > 4000 || busy || pending.current || (targetScope !== 'project' && (!jobId || (targetScope === 'file' && !report)))) return;
    const id = crypto.randomUUID();
    questionAnchor.current.request(id);
    const context = requestContext(targetScope);
    const controller = new AbortController();
    abort.current = controller; pending.current = id;
    setScope(targetScope); setActiveId(id); setElapsed(0); setQuestion(''); setNotice(''); setShowWorkflows(false);
    saveConversation(previous => [...previous, { id, question: value, context }]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 100_000);
    try {
      const response = await ps3Request<Investigation>('/api/ps3/investigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: value, scope: targetScope, job_id: jobId ?? null, file_id: report?.file_id ?? null, history: conversationHistory(history) }), signal: controller.signal });
      if (!controller.signal.aborted && mounted.current) {
        saveConversation(previous => previous.map(item => item.id === id ? { ...item, error: undefined, response } : item));
        setNotice(`${response.mode === 'agent' ? 'Investigation' : 'Local evidence response'} ready. ${response.sources.length} source${response.sources.length === 1 ? '' : 's'} available for review above.`);
      }
    } catch (cause) {
      if (mounted.current) saveConversation(previous => previous.map(item => item.id === id ? { ...item, error: controller.signal.aborted ? timedOut ? 'The investigation did not return within 100 seconds. Check the local service and try again.' : 'Stopped waiting for this answer. Provider work may still finish on the server.' : cause instanceof Error ? cause.message : 'The investigation could not complete. Try again.' } : item));
    } finally {
      clearTimeout(timer); pending.current = null; abort.current = null;
      // Do not steal focus or scroll away from the passage the user is reading.
      if (mounted.current) setActiveId(null);
    }
  }

  function prepareWorkflow(workflow: typeof WORKFLOWS[number]) {
    setScope(workflow.scope); setQuestion(workflow.question); setShowWorkflows(false); setNotice('Review the question, then send it to begin.');
    textarea.current?.focus({ preventScroll: true });
    textarea.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function prepareComponent() {
    if (!component || !report) return;
    setScope('file');
    setQuestion(`Investigate the selected 3D component "${component.label}" in ${report.file_id}. Its displayed model result is "${component.status}". Retrieve the supporting measurements and prediction evidence, explain the finding and its limits, and recommend the next engineering checks. Keep the distinction between a model prediction and a verified fault clear.`);
    setNotice('The selected component is included in your question. Review it, then send to investigate.');
    textarea.current?.focus({ preventScroll: true });
    textarea.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function restoreQuestion(item: InvestigationExchange) {
    setQuestion(item.question); setScope(item.context.scope);
    setNotice('Question restored. Check the current focus and selection before sending.');
    textarea.current?.focus({ preventScroll: true });
    textarea.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function saveBrief(item: InvestigationExchange) {
    const url = URL.createObjectURL(new Blob([investigationBrief(item)], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `railguard-investigation-${item.id.slice(0, 8)}.md`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Downloaded the brief with its question, context, sources and tool trace.');
  }
  async function copyBrief(item: InvestigationExchange) {
    try { await navigator.clipboard.writeText(investigationBrief(item)); setCopied(item.id); setNotice('Copied the sourced brief.'); }
    catch { setNotice('Clipboard access is unavailable. Use Download brief to save this answer.'); }
  }

  const privacyNote = <footer className="rg-agent-footer"><ShieldCheck size={13}/><p>Relevant project documentation, code excerpts, diagnostic summaries and recent conversation may be sent to {provider}. Raw recording files stay local. Answers support engineering review; source coverage and model limits still apply.{assistant?.available === false && <span> {assistant.message}</span>}</p></footer>;
  return <section className={`ps3-panel rg-investigator ${compact ? 'is-compact' : ''}`} aria-labelledby={compact ? 'railguard-ai-title' : 'ps3-assistant-heading'}>
    <div ref={scrollBody} className={compact ? 'rg-agent-scroll' : 'rg-agent-body'} style={{ overflowAnchor: 'none' }}>
    {!compact && <header className="rg-investigator-heading"><span className="rg-agent-emblem"><Bot size={23}/></span><div><span className="ps3-kicker">PROJECT KNOWLEDGE + RECORDED EVIDENCE</span><h2 id="ps3-assistant-heading">Investigation agent</h2></div><span className="rg-agent-readonly"><ShieldCheck size={12}/>Read-only tools</span></header>}
    <div className="rg-agent-introduction"><span className={`rg-agent-status ${lastResponse?.mode === 'local' || assistant?.available === false ? 'local' : ''}`}><i/>{modeLabel}</span><p>Ask about the project, compare recordings, challenge a prediction, or build an engineering brief. The agent retrieves project knowledge and saved evidence to support its answers.</p></div>
    <div className="rg-agent-scope"><span className="rg-agent-field-label">Investigation focus</span><div className="rg-agent-scope-options" role="group" aria-label="Investigation focus">{([{ id: 'project', label: 'Project', icon: FolderSearch }, { id: 'run', label: 'Selected run', icon: Layers3 }, { id: 'file', label: 'Current file', icon: Microscope }] as const).map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={scope === id} disabled={busy || (id !== 'project' && (!jobId || (id === 'file' && !report)))} onClick={() => setScope(id)}><Icon size={14}/>{label}</button>)}</div><p>{contextDescription}</p><small>{scope === 'project' ? 'The selected recording is optional context. Ask about any part of RailGuard.' : 'The agent can retrieve related project information to explain these results.'}</small></div>
    {component && <div className="rg-agent-component"><span>Selected in 3D</span><strong>{component.label}</strong><p>{component.status}</p><button type="button" disabled={busy || !jobId || !report} onClick={prepareComponent} aria-label="Investigate selected component"><Microscope size={15}/>{compact ? "Ask about this" : "Investigate selected component"}<ArrowUpRight size={13}/></button></div>}
    <div className="rg-agent-workflows"><div><span className="rg-agent-field-label">Start with a task</span>{(compact || history.length > 0) && <button type="button" aria-expanded={showWorkflows} onClick={() => setShowWorkflows(value => !value)}>{showWorkflows ? 'Hide task starters' : 'Show task starters'}<ArrowUpRight size={12}/></button>}</div>{((!compact && !history.length) || showWorkflows) && <div className="rg-agent-workflow-grid">{WORKFLOWS.map(workflow => <button type="button" key={workflow.label} disabled={busy || (workflow.scope !== 'project' && (!jobId || (workflow.scope === 'file' && !report)))} onClick={() => prepareWorkflow(workflow)}><workflow.icon size={17}/><span><strong>{workflow.label}</strong><small>{workflow.detail}</small></span><ArrowUpRight size={12}/></button>)}</div>}</div>
    {history.length > 0 && <div className="rg-agent-conversation-bar"><span><BookOpen size={13}/>Conversation · {history.length} question{history.length === 1 ? '' : 's'}</span><button type="button" disabled={busy} onClick={() => { saveConversation(() => []); setNotice('Conversation cleared in this browser tab. Saved analysis results are unchanged.'); }}><Trash2 size={12}/>Clear conversation</button></div>}
    <div ref={conversation} className="rg-agent-conversation" style={{ overflowAnchor: 'none' }} aria-label="Investigation conversation" aria-busy={busy}>{!history.length && <div className="rg-agent-empty"><Sparkles size={18}/><p>{compact ? 'Ask about this recording, compare files or explore the project. Answers include supporting sources.' : 'Start with a task above, or ask your own question below. Follow-up questions remember the recent conversation.'}</p></div>}{history.map(item => <article className="rg-agent-exchange" key={item.id} ref={element => { if (element) exchanges.current.set(item.id, element); else exchanges.current.delete(item.id); }}><div className="rg-agent-question-context"><span>{item.context.label}</span>{item.context.jobId && <small>Run {item.context.jobId.slice(0, 8)}</small>}</div><p className="rg-agent-question">{item.question}</p>{item.id === activeId ? <div className="rg-agent-working" role="status"><LoaderCircle size={16} className="spin"/><div><strong>Investigating your question… <span>{elapsed}s</span></strong><p>{elapsed < 35 ? 'Retrieving project knowledge and evidence as needed. Completed tool calls appear with the answer.' : 'This question is taking longer. The agent may need several evidence lookups; you can stop waiting below.'}</p></div></div> : item.response ? <div className="rg-agent-answer"><div className="rg-agent-answer-meta"><span>{item.response.mode === 'agent' ? <Sparkles size={12}/> : <BookOpen size={12}/>} {item.response.mode === 'agent' ? 'Agent findings' : 'Local evidence response'}</span>{item.response.elapsed_ms !== undefined && <small>{(item.response.elapsed_ms / 1000).toFixed(1)}s</small>}</div><Answer answer={item.response.answer} sources={item.response.sources} exchangeId={item.id}/>{item.response.warning && <p className="rg-agent-warning"><CircleHelp size={14}/>{item.response.warning}</p>}
      <div className="rg-agent-audit">{!!item.response.tools.length && <details className="rg-agent-tools"><summary><Wrench size={13}/>{item.response.tools.length} completed tool call{item.response.tools.length === 1 ? '' : 's'}<span>Inspect trace</span></summary><ol>{item.response.tools.map((tool, index) => <li key={`${tool.name}-${index}`}><div><strong>{TOOL_LABELS[tool.name] ?? tool.name.replaceAll('_', ' ')}</strong>{tool.status && <span className={tool.status === 'unavailable' ? 'unavailable' : ''}>{tool.status}</span>}</div><p>{tool.label}</p>{tool.source_id && <small>Source [{tool.source_id}]</small>}</li>)}</ol></details>}{!!item.response.sources.length && <details className="rg-agent-sources" open><summary><BookOpen size={13}/>{item.response.sources.length} source{item.response.sources.length === 1 ? '' : 's'} consulted</summary><ul>{item.response.sources.map((source, index) => <li id={`source-${item.id}-${encodeURIComponent(source.id)}`} tabIndex={-1} key={`${source.id}-${index}`}><span>[{source.id}]</span><div><strong>{source.label}</strong>{source.location && <small>{source.location}</small>}{source.details && <details className="rg-agent-source-details"><summary aria-label={`View retrieved evidence for source ${source.id}`}>View retrieved evidence</summary><pre tabIndex={0} role="region" aria-label={`Retrieved evidence for source ${source.id}`}>{source.details}</pre></details>}</div></li>)}</ul></details>}</div>
      <div className="rg-agent-answer-actions"><button type="button" onClick={() => copyBrief(item)}>{copied === item.id ? <Check size={13}/> : <Copy size={13}/>}Copy brief</button><button type="button" onClick={() => saveBrief(item)}><ArrowDownToLine size={13}/>Download brief</button>{item.response.mode === 'local' && <button type="button" disabled={busy} onClick={() => restoreQuestion(item)}><ArrowUpRight size={13}/>Edit and retry</button>}</div>
    </div> : <div className="rg-agent-error" role="alert"><p>{item.error ?? 'This answer is unavailable. Send the question again.'}</p><button type="button" disabled={busy} onClick={() => restoreQuestion(item)}>Edit and retry</button></div>}</article>)}</div>
    {compact && <details className="rg-agent-data-note"><summary>Data & sources</summary>{privacyNote}</details>}
    </div>
    <form className="rg-agent-compose" onSubmit={event => { event.preventDefault(); investigate(question); }}><label htmlFor="ps3-question">{compact ? 'Ask RailGuard' : history.length ? 'Ask a follow-up or start a new investigation' : 'What would you like to investigate?'}</label><div><textarea ref={textarea} id="ps3-question" value={question} minLength={3} maxLength={4000} required aria-describedby="ps3-question-hint" rows={compact ? 2 : 3} placeholder={enabled ? compact ? 'Ask about this result or your project…' : 'Ask about models, recordings, results, architecture, limitations or your demo…' : 'Select a completed run, or switch the focus to Project…'} disabled={!enabled || busy} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); investigate(question); } }}/><div className="rg-agent-compose-actions"><span>{question.length.toLocaleString()} / 4,000</span>{busy ? <button type="button" className="rg-agent-stop" onClick={() => abort.current?.abort()}><Square size={12}/>Stop waiting</button> : <button type="submit" disabled={!enabled || question.trim().length < 3 || question.trim().length > 4000}><ArrowUp size={16}/>Send question</button>}</div></div><p id="ps3-question-hint">Enter to send · Shift+Enter for a new line. Recent conversation is kept in this browser tab.</p></form>
    <p className="rg-agent-notice" role="status" aria-atomic="true">{notice}</p>{!compact && privacyNote}
  </section>;
}
