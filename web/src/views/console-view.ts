import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import type { TranscriptEvent } from '../../../src/domain/types';
import type { AgentResult, Api } from '../core/api';
import type { AppState, StreamRef } from '../core/state';
import type { Store } from '../core/store';
import { errText } from '../core/api';
import {
  isCurrent, pendingSet, sessionOf, sessionRemoved, statusLabel, streamCleared,
} from '../core/state';
import { mountComposer } from '../components/composer';
import { confirmBox } from '../components/confirm-box';
import { promptBox } from '../components/prompt-box';
import { mountTranscript } from './transcript-view';
import { $, clear, el, hide, show } from '../ui/dom';
import { confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';

const MESSENGER_POLL_MS = 5000;
const PROMPT_POLL_MS = 3000;

export function mountConsole(
  store: Store<AppState>,
  api: Api,
  refresh: () => Promise<void>,
): { onMessage(sessionId: string, event: TranscriptEvent): void } {
  const app = $('app');
  const placeholder = $('placeholder');
  const consoleView = $('consoleView');
  const cvName = $('cvName');
  const cvSub = $('cvSub');
  const cvActions = $('cvActions');
  const confirmSlot = $('confirmSlot');
  const promptSlot = $('promptSlot');
  const transcript = mountTranscript();
  const composer = mountComposer(text => void send(text));

  let messengerTimer: number | undefined;
  let promptTimer: number | undefined;
  const stopTimers = () => {
    clearInterval(messengerTimer); messengerTimer = undefined;
    clearInterval(promptTimer); promptTimer = undefined;
  };

  $('backBtn').onclick = () => { app.classList.remove('show-console'); };

  // ---------- 转录装载 ----------
  const emptyHint = (ref: StreamRef): string => {
    if (ref.kind === 'messenger') {
      return '还没有对话。向信使 Agent 发消息即可开始 —— 它与钉钉共享同一上下文。';
    }
    const x = sessionOf(store.getState(), ref.id);
    return x && x.live && x.controllable ? '会话已启动，发送首条消息开始对话。' : '还没有消息。';
  };
  const fetchEvents = (ref: StreamRef) =>
    ref.kind === 'messenger' ? api.agentMessages() : api.sessionMessages(ref.id);

  const reload = async (ref: StreamRef) => {
    try {
      const events = await fetchEvents(ref);
      if (isCurrent(store.getState(), ref)) transcript.reset(events, emptyHint(ref));
    } catch {
      if (isCurrent(store.getState(), ref)) transcript.reset([], emptyHint(ref));
    }
  };
  const poll = async (ref: StreamRef) => {
    try {
      const events = await fetchEvents(ref);
      if (isCurrent(store.getState(), ref)) transcript.ingest(events);
    } catch { /* 轮询失败静默，等下一轮 */ }
  };

  // ---------- 头部 ----------
  const renderHead = (ref: StreamRef) => {
    clear(cvActions);
    if (ref.kind === 'messenger') {
      cvName.textContent = '信使 Agent';
      cvSub.textContent = '与钉钉共享同一会话上下文';
      composer.setPlaceholder('对信使 Agent 说…（变更操作会先请你确认）');
    } else {
      const x = sessionOf(store.getState(), ref.id);
      cvName.textContent = x?.name || ref.id.slice(0, 8);
      cvSub.textContent = x ? `${statusLabel(x)} · ${x.cwd}` : ref.id;
      composer.setPlaceholder(x?.controllable ? '发送消息到该会话…' : '该会话未托管，先接管才能发送');
      if (x && !x.controllable && x.live) {
        cvActions.appendChild(el('button', {
          class: 'btn btn--ghost', text: '接管', onclick: () => void adopt(ref.id),
        }));
      }
      if (x?.controllable) {
        cvActions.appendChild(el('button', {
          class: 'btn btn--ghost', text: '结束会话', onclick: () => void archive(ref.id),
        }));
      }
    }
    cvActions.appendChild(el('button', {
      class: 'btn btn--ghost', text: '刷新', onclick: () => void reload(ref),
    }));
  };

  // ---------- 动作 ----------
  const applyResult = (res: AgentResult) => {
    if (res.kind === 'staged') { store.update(pendingSet(res.actions)); return; }
    if (res.kind === 'reply') return;          // 回复文本已在信使转录中，重载后即可见
    store.update(pendingSet([]));
    if (res.kind === 'executed') transcript.pushStatus(res.results.join('\n') || '已执行');
    else if (res.kind === 'cancelled') transcript.pushStatus('已取消。');
    else transcript.pushStatus('确认已超时，请重新发起。');
  };

  const send = async (text: string) => {
    const ref = store.getState().current;
    if (!ref) return;
    if (ref.kind === 'messenger') {
      transcript.pushLocal(text);
      let res: AgentResult;
      try { res = await api.agentMessage(text); } catch { toast('发送失败'); return; }
      await reload(ref);        // staged/reply 的文本已进转录：整体重载对齐，去掉乐观气泡重复
      applyResult(res);         // executed/cancelled/expired 不在转录里，重载后补渲染
    } else {
      try {
        await api.sendSessionMessage(ref.id, text);
        transcript.pushLocal(text);
        toast('已发送到会话');
      } catch (e) { toast(errText(e, '发送失败')); }
    }
  };

  const decide = async (word: '确认' | '取消') => {
    const ref = store.getState().current;
    let res: AgentResult;
    try { res = await api.agentMessage(word); }
    catch { store.update(pendingSet([])); toast('操作失败'); return; }
    store.update(pendingSet([]));
    if (ref) await reload(ref);
    applyResult(res);
  };

  const loadPending = async () => {
    try { store.update(pendingSet(await api.agentPending())); }
    catch { /* 与今天一致：拉取失败保持现状 */ }
  };

  const adopt = async (id: string) => {
    const x = sessionOf(store.getState(), id);
    const label = x?.name || id.slice(0, 8);
    let force = false;
    if (x?.live) {
      const ok = await confirmDialog({
        title: '接管会话',
        body: `会话「${label}」仍在运行。接管会先结束其原进程，再在受控窗口中恢复（保留完整上下文）。是否继续？`,
        okText: '继续接管',
      });
      if (!ok) return;
      force = true;
    }
    try { await api.adoptSession(id, force); toast('已接管'); await refresh(); }
    catch (e) { toast(errText(e, '接管失败')); }
  };

  const archive = async (id: string) => {
    const x = sessionOf(store.getState(), id);
    const label = x?.name || id.slice(0, 8);
    const ok = await confirmDialog({
      title: '结束会话',
      body: `结束会话「${label}」？这会关闭其 tmux 窗口并结束对应的 Claude 进程。`,
      okText: '结束会话', danger: true,
    });
    if (!ok) return;
    try { await api.archiveSession(id); } catch (e) { toast(errText(e, '结束失败')); return; }
    toast('已结束会话');
    store.update(sessionRemoved(id));
    if (isCurrent(store.getState(), { kind: 'session', id })) store.update(streamCleared());
    await refresh();
  };

  // ---------- 交互选择器 ----------
  const sendKeys = async (id: string, keys: string[]) => {
    try { await api.sendKeys(id, keys); }
    catch (e) { toast(errText(e, '按键发送失败')); return; }
    toast('已发送: ' + keys.join(' '));
    setTimeout(() => void loadPrompt(id), 600);
  };

  const loadPrompt = async (id: string) => {
    let p: InteractivePrompt | null;
    try { p = await api.sessionPrompt(id); } catch { clear(promptSlot); return; }
    // 期间切走了就别动 DOM —— 否则会抹掉新会话刚渲染的面板。
    if (!isCurrent(store.getState(), { kind: 'session', id })) return;
    clear(promptSlot);
    if (p && p.options.length > 0) promptSlot.appendChild(promptBox(p, keys => void sendKeys(id, keys)));
  };

  // ---------- 生命周期 ----------
  const openStream = async (ref: StreamRef) => {
    stopTimers();
    hide(placeholder);
    show(consoleView, 'flex');
    app.classList.add('show-console');
    clear(promptSlot);

    await reload(ref);
    if (!isCurrent(store.getState(), ref)) return;    // 期间切走了：不要再装定时器

    if (ref.kind === 'messenger') {
      await loadPending();
      if (!isCurrent(store.getState(), ref)) return;
      messengerTimer = setInterval(() => void poll(ref), MESSENGER_POLL_MS);
    } else {
      const x = sessionOf(store.getState(), ref.id);
      if (x?.controllable) {
        void loadPrompt(ref.id);
        promptTimer = setInterval(() => void loadPrompt(ref.id), PROMPT_POLL_MS);
      }
    }
  };

  const closeConsole = () => {
    stopTimers();
    clear(promptSlot);
    hide(consoleView);
    show(placeholder, 'grid');
    app.classList.remove('show-console');
  };

  // 头部：current 变化或“当前会话的 summary”变化都重画（后者是今天没有的实时刷新）。
  store.subscribe(
    s => ({ ref: s.current, x: s.current?.kind === 'session' ? s.sessions.get(s.current.id) : undefined }),
    v => { if (v.ref) renderHead(v.ref); },
  );

  // 待确认面板：只在信使流、且有暂存动作时出现。
  store.subscribe(s => ({ ref: s.current, pending: s.pending }), v => {
    clear(confirmSlot);
    if (v.ref?.kind === 'messenger' && v.pending.length > 0) {
      confirmSlot.appendChild(confirmBox(v.pending, word => void decide(word)));
    }
  });

  store.subscribe(s => s.current, ref => { if (ref) void openStream(ref); else closeConsole(); });

  return {
    onMessage(sessionId, event) {
      if (isCurrent(store.getState(), { kind: 'session', id: sessionId })) transcript.accept(event);
    },
  };
}
