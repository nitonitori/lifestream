import type { TranscriptEvent } from './types.js';

function toTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

export function parseTranscriptLine(line: string): TranscriptEvent | null {
  const s = line.trim();
  if (!s) return null;
  let o: any;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const ts = toTs(o.timestamp);
  const msg = o.message;

  if (o.type === 'assistant' && msg && msg.role === 'assistant') {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content
      .filter((b: any) => b?.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
    return { kind: 'assistant', uuid: o.uuid, ts: ts ?? 0, text: textFromContent(msg.content), toolUses, raw: o };
  }
  if (o.type === 'user' && msg && msg.role === 'user') {
    const content = msg.content;
    if (Array.isArray(content)) {
      const tr = content.find((b: any) => b?.type === 'tool_result');
      if (tr) {
        return {
          kind: 'tool_result', uuid: o.uuid, ts: ts ?? 0,
          toolUseId: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          isError: !!tr.is_error, raw: o,
        };
      }
    }
    return { kind: 'user', uuid: o.uuid, ts: ts ?? 0, text: textFromContent(content), raw: o };
  }
  return { kind: 'meta', uuid: o.uuid, ts, type: String(o.type ?? 'unknown'), raw: o };
}

export function parseTranscript(lines: string[]): TranscriptEvent[] {
  const seen = new Set<string>();
  const out: TranscriptEvent[] = [];
  for (const line of lines) {
    const e = parseTranscriptLine(line);
    if (!e) continue;
    const key = e.uuid;
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    out.push(e);
  }
  return out;
}
