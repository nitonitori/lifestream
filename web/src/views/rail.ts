import type { Api } from '../core/api';
import type { AppState, StreamRef } from '../core/state';
import type { Store } from '../core/store';
import { errText } from '../core/api';
import { MESSENGER, isCurrent, streamSelected, tagOf, vitalOf } from '../core/state';
import { streamCard } from '../components/stream-card';
import { $, clear, el } from '../ui/dom';
import { promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';

export function mountRail(store: Store<AppState>, api: Api, refresh: () => Promise<void>): void {
  const wrap = $('streams');

  const newSession = async () => {
    const cwd = await promptDialog({ title: '新会话工作目录（cwd）' });
    if (!cwd) return;
    try { await api.createSession(cwd); toast('已创建'); await refresh(); }
    catch (e) { toast(errText(e, '创建失败')); }
  };
  $('newBtn').onclick = () => void newSession();

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
      wrap.appendChild(el('div', { class: 'rail__empty', text: '还没有运行中的 Claude 会话。' }));
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
