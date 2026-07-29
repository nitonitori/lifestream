import { el } from '../ui/dom';

export interface StreamCardProps {
  name: string;
  meta: string;
  vital: string;            // busy | idle | live | external | brand
  tag: string;
  pinned?: boolean;         // 信使卡片置顶
  ctl?: boolean;
  active: boolean;
  onSelect: () => void;
}

export function streamCard(p: StreamCardProps): HTMLElement {
  const dot = p.vital === 'brand' ? 'is-idle' : `is-${p.vital}`;
  return el('div', {
    class: 'stream' + (p.pinned ? ' stream--pin' : '') + (p.active ? ' is-active' : ''),
    onclick: p.onSelect,
  },
    el('div', { class: 'stream__vital' }, el('span', { class: `vital-dot ${dot}` })),
    el('div', { class: 'stream__body' },
      el('div', { class: 'stream__name', text: p.name }),
      el('div', { class: 'stream__meta mono', text: p.meta }),
    ),
    el('span', { class: 'stream__tag' + (p.ctl ? ' is-ctl' : ''), text: p.tag }),
  );
}
