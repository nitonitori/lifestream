import type { TranscriptEvent } from '../../../src/domain/types';
import { el } from '../ui/dom';

export function bubble(role: 'user' | 'agent' | 'system', label: string, text: string): HTMLElement {
  return el('div', { class: `msg msg--${role}` },
    el('div', { class: 'msg__bubble' },
      el('span', { class: 'msg__role', text: label }),
      el('span', { text }),
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
    if (e.text && e.text.trim()) nodes.push(bubble('agent', 'Agent', e.text));
    for (const t of e.toolUses) nodes.push(trace('tool', `调用 ${t.name}`, safeJson(t.input), false));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('result', '工具结果', e.content, e.isError)];
  return [];
}
