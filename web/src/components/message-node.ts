import type { TranscriptEvent } from '../../../src/domain/types';
import { el } from '../ui/dom';
import { mdBlock } from './markdown';

export function bubble(role: 'user' | 'system', label: string, text: string): HTMLElement {
  return el('div', { class: `msg msg--${role}` },
    el('div', { class: 'msg__bubble' },
      el('span', { class: 'msg__role', text: label }),
      el('span', { text }),
    ),
  );
}

const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// Agent 长回答走文档流而非气泡：带标题/列表/代码块的长文塞进 640px 圆角气泡会很挤。
// 角标对所有内核统一写 AGENT —— 内核已由侧栏标签与头部表达，这里再分一次是重复。
export function doc(label: string, ts: number, src: string): HTMLElement {
  return el('div', { class: 'msg msg--agent' },
    el('div', { class: 'msg__doc' },
      el('div', { class: 'msg__stamp', text: `${label} · ${hhmm(ts)}` }),
      mdBlock(src),
    ),
  );
}

function trace(variant: 'tool' | 'result', head: string, body: string, isError: boolean): HTMLElement {
  const box = el('div', { class: `trace trace--${variant} is-collapsed` + (isError ? ' is-error' : '') });
  const h = el('div', { class: 'trace__head', text: head + ' ▸' });
  h.onclick = () => {
    box.classList.toggle('is-collapsed');
    h.textContent = head + (box.classList.contains('is-collapsed') ? ' ▸' : ' ▾');
  };
  box.append(h, el('div', { class: 'trace__body', text: body }));
  return box;
}

const safeJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

// 一个转录事件 → 0..n 个节点（meta 不渲染）
export function messageNodes(e: TranscriptEvent): HTMLElement[] {
  if (e.kind === 'user') return [bubble('user', '你', e.text)];
  if (e.kind === 'assistant') {
    const nodes: HTMLElement[] = [];
    // 只有 assistant 正文走 markdown：工具入参是 JSON、工具结果是日志，重排即不可读。
    if (e.text && e.text.trim()) nodes.push(doc('AGENT', e.ts, e.text));
    for (const t of e.toolUses) nodes.push(trace('tool', `调用 ${t.name}`, safeJson(t.input), false));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('result', '工具结果', e.content, e.isError)];
  return [];
}
