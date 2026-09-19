import type { Investigation } from '@/lib/ps3-types';

export type InvestigationScope = 'project' | 'run' | 'file';
export type InvestigationContext = { scope: InvestigationScope; jobId?: string; fileId?: string; label: string };
export type InvestigationExchange = { id: string; question: string; context: InvestigationContext; response?: Investigation; error?: string };
export type ConversationMessage = { role: 'user' | 'assistant'; content: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum;

/** Keep this tab usable even when browser storage is blocked or its quota is exhausted. */
export function createConversationStore(storage: () => Pick<Storage, 'getItem' | 'setItem'>, key: string) {
  let memory: string | undefined;
  const snapshot = () => {
    if (memory !== undefined) return memory;
    try { return storage().getItem(key) ?? '[]'; } catch { return '[]'; }
  };
  return {
    snapshot,
    update(change: (previous: InvestigationExchange[]) => InvestigationExchange[]) {
      const items = change(readConversation(snapshot())).slice(-12);
      while (items.length > 1 && JSON.stringify(items).length > 650_000) items.shift();
      // A single unusually large response should retain its answer and provenance.
      if (JSON.stringify(items).length > 650_000 && items[0]?.response) {
        items[0] = { ...items[0], response: { ...items[0].response, sources: items[0].response.sources.map(source => ({ id: source.id, label: source.label, ...(source.location ? { location: source.location } : {}) })) } };
      }
      memory = JSON.stringify(items);
      try { storage().setItem(key, memory); } catch { /* This tab continues with the current in-memory result. */ }
    },
  };
}

/** Session data is untrusted input. A damaged cache must not break investigations. */
export function readConversation(raw: string): InvestigationExchange[] {
  if (raw.length > 700_000) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-12).flatMap((item): InvestigationExchange[] => {
      if (!object(item) || !text(item.id, 100) || !text(item.question, 4000) || !object(item.context)) return [];
      const context = item.context;
      if (!['project', 'run', 'file'].includes(String(context.scope)) || !text(context.label, 2000)) return [];
      if (context.jobId !== undefined && (!text(context.jobId, 32) || !/^[a-f0-9]{32}$/.test(context.jobId))) return [];
      if (context.fileId !== undefined && !text(context.fileId, 1000)) return [];
      const result: InvestigationExchange = { id: item.id, question: item.question, context: { scope: context.scope as InvestigationScope, label: context.label, ...(context.jobId ? { jobId: String(context.jobId) } : {}), ...(context.fileId ? { fileId: String(context.fileId) } : {}) } };
      if (object(item.response) && ['agent', 'local'].includes(String(item.response.mode)) && text(item.response.answer, 40_000)) {
        const response = item.response;
        result.response = {
          mode: response.mode as Investigation['mode'], answer: response.answer as string,
          tools: (Array.isArray(response.tools) ? response.tools : []).slice(0, 40).filter(object).flatMap(tool => text(tool.name, 150) && text(tool.label, 2000) ? [{ name: tool.name, label: tool.label, ...(text(tool.status, 100) ? { status: tool.status } : {}), ...(text(tool.source_id, 150) ? { source_id: tool.source_id } : {}) }] : []),
          sources: (Array.isArray(response.sources) ? response.sources : []).slice(0, 80).filter(object).flatMap(source => text(source.id, 150) && text(source.label, 2000) ? [{ id: source.id, label: source.label, ...(text(source.location, 2000) ? { location: source.location } : {}), ...(text(source.details, 16_000) ? { details: source.details } : {}) }] : []),
          ...(text(response.warning, 4000) ? { warning: response.warning } : {}),
          ...(typeof response.elapsed_ms === 'number' && Number.isFinite(response.elapsed_ms) && response.elapsed_ms >= 0 ? { elapsed_ms: response.elapsed_ms } : {}),
        };
      } else result.error = text(item.error, 4000) ? item.error : 'This request was interrupted. Send the question again to continue.';
      return [result];
    });
  } catch { return []; }
}

/** Keep complete recent exchanges; context text prevents a silent file switch. */
export function conversationHistory(exchanges: InvestigationExchange[]): ConversationMessage[] {
  const pairs: ConversationMessage[][] = [];
  let size = 0;
  for (const item of [...exchanges].reverse()) {
    if (!item.response) continue;
    const context = `${item.context.label}${item.context.jobId ? `; run ${item.context.jobId}` : ''}${item.context.fileId ? `; file ${item.context.fileId}` : ''}`;
    const user = `[Previous question context: ${context}]\n${item.question}`.slice(0, 12_000);
    const assistant = item.response.answer.slice(0, 12_000);
    if (pairs.length >= 6 || size + user.length + assistant.length > 40_000) break;
    pairs.unshift([{ role: 'user', content: user }, { role: 'assistant', content: assistant }]);
    size += user.length + assistant.length;
  }
  return pairs.flat();
}

export function investigationBrief(item: InvestigationExchange): string {
  if (!item.response) return '';
  const response = item.response;
  const literalEvidence = (details: string) => {
    const longestBackticks = Math.max(0, ...(details.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(Math.max(3, longestBackticks + 1));
    return `${fence}text\n${details}\n${fence}`;
  };
  const sourceBriefs = response.sources.map(source => [`### [${source.id}] ${source.label}`, ...(source.location ? [source.location] : []), ...(source.details ? [`Retrieved evidence:\n\n${literalEvidence(source.details)}`] : [])].join('\n\n'));
  return [`# RailGuard investigation brief`, `Scope: ${item.context.label}`, ...(item.context.jobId ? [`Analysis run: ${item.context.jobId}`] : []), ...(item.context.fileId ? [`Source recording: ${item.context.fileId}`] : []), `Response: ${response.mode === 'agent' ? 'AI agent with evidence tools' : 'Local evidence response'}`, `## Question\n\n${item.question}`, `## Findings\n\n${response.answer}`, ...(response.warning ? [`## Limitations\n\n${response.warning}`] : []), `## Sources consulted\n\n${sourceBriefs.length ? sourceBriefs.join('\n\n') : 'No retrieved sources were attached to this answer.'}`, `## Tool trace\n\n${response.tools.length ? response.tools.map(tool => `- ${tool.name}: ${tool.label}${tool.status ? ` (${tool.status})` : ''}`).join('\n') : 'No tool calls recorded.'}`, 'This brief supports engineering review. It is not a verified diagnosis or maintenance authorisation.'].join('\n\n');
}

export type AnswerBlock = { type: 'paragraph' | 'quote' | 'code'; text: string } | { type: 'heading'; level: number; text: string } | { type: 'list'; ordered: boolean; items: string[] } | { type: 'table'; headers: string[]; rows: string[][] };
const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim());
const tableSeparator = (line: string) => line.includes('|') && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));
const listMatch = (line: string) => line.match(/^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/);
const startsBlock = (line: string) => /^\s*(?:#{1,6}\s|```|>\s?)/.test(line) || Boolean(listMatch(line));

/** Parse a small Markdown subset without evaluating HTML, links or embedded code. */
export function answerBlocks(answer: string): AnswerBlock[] {
  const lines = answer.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const content: string[] = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ type: 'code', text: content.join('\n') }); continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index++; continue; }
    if (index + 1 < lines.length && line.includes('|') && tableSeparator(lines[index + 1])) {
      const headers = tableCells(line); const rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const values = tableCells(lines[index++]); rows.push(headers.map((_, cell) => values[cell] ?? ''));
      }
      blocks.push({ type: 'table', headers, rows }); continue;
    }
    const firstList = listMatch(line);
    if (firstList) {
      const ordered = Boolean(firstList[1]); const items: string[] = [];
      while (index < lines.length) {
        const match = listMatch(lines[index]);
        if (!match || Boolean(match[1]) !== ordered) break;
        items.push(match[2]); index++;
      }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    if (/^\s*>/.test(line)) {
      const content: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) content.push(lines[index++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: content.join('\n') }); continue;
    }
    const content = [line]; index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !(index + 1 < lines.length && lines[index].includes('|') && tableSeparator(lines[index + 1]))) content.push(lines[index++]);
    blocks.push({ type: 'paragraph', text: content.join('\n') });
  }
  return blocks;
}
