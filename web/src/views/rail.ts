import type { SessionCommands } from '../commands/session';
import type { AppState, StreamRef } from '../core/state';
import type { Store } from '../core/store';
import { MESSENGER, isCurrent, streamSelected, tagOf, vitalOf } from '../core/state';
import { streamCard } from '../components/stream-card';
import { $, clear, el } from '../ui/dom';

export function mountRail(store: Store<AppState>, cmds: SessionCommands): void {
  const wrap = $('streams');

  $('newBtn').onclick = () => void cmds.create();

  const render = () => {
    const s = store.getState();
    clear(wrap);

    if (s.agentEnabled) {
      wrap.appendChild(streamCard({
        name: '信使 Agent', meta: '与 IM 共享上下文', vital: 'brand', tag: 'AGENT',
        pinned: true, active: isCurrent(s, MESSENGER),
        onSelect: () => store.update(streamSelected(MESSENGER)),
      }));
    }

    const list = [...s.sessions.values()];
    if (list.length === 0 && !s.agentEnabled) {
      wrap.appendChild(el('div', { class: 'rail__empty', text: '还没有运行中的会话。' }));
      return;
    }
    for (const x of list) {
      const ref: StreamRef = { kind: 'session', id: x.sessionId };
      wrap.appendChild(streamCard({
        name: x.name || x.sessionId.slice(0, 8),
        meta: x.cwd || '—',
        vital: vitalOf(x), tag: tagOf(x), ctl: x.controllable,
        active: isCurrent(s, ref),
        onSelect: () => store.update(streamSelected(ref)),
      }));
    }
  };

  // 一条复合订阅取代今天 5 处手工 renderRail()。
  store.subscribe(
    s => ({ sessions: s.sessions, current: s.current, agentEnabled: s.agentEnabled }),
    render,
  );
}
