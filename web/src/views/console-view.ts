import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import type { TranscriptEvent } from '../../../src/domain/types';
import type { SessionCommands } from '../commands/session';
import type { AgentResult, Api } from '../core/api';
import type { AppState, StreamRef } from '../core/state';
import type { Store } from '../core/store';
import { errText } from '../core/api';
import { isCurrent, pendingSet, sessionOf, statusLabel } from '../core/state';
import { mountComposer } from '../components/composer';
import { confirmBox } from '../components/confirm-box';
import { promptBox } from '../components/prompt-box';
import { mountTranscript } from '../transcript/view';
import { $, clear, el, hide, show } from '../ui/dom';
import { toast } from '../ui/toast';

const MESSENGER_POLL_MS = 5000;
const PROMPT_POLL_MS = 3000;

export function mountConsole(
  store: Store<AppState>,
  api: Api,
  cmds: SessionCommands,
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
  // promptTimer 只由下方最后一条订阅读写 —— 别在其它地方清它，否则又要靠订阅注册顺序才正确。
  let promptTimer: number | undefined;
  const stopMessengerPoll = () => {
    clearInterval(messengerTimer); messengerTimer = undefined;
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
    let events: TranscriptEvent[];
    try {
      events = await fetchEvents(ref);
    } catch {
      if (isCurrent(store.getState(), ref)) transcript.reset([], emptyHint(ref));
      return;
    }
    // reset 放在 try 外：渲染中途抛错不该落进 catch 去「重置为空」，那会抹掉已画出的部分。
    if (isCurrent(store.getState(), ref)) transcript.reset(events, emptyHint(ref));
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
          class: 'btn btn--ghost', text: '接管', onclick: () => void cmds.adopt(ref.id),
        }));
      }
      if (x?.controllable) {
        cvActions.appendChild(el('button', {
          class: 'btn btn--ghost', text: '结束会话', onclick: () => void cmds.archive(ref.id),
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

  // ---------- 交互选择器 ----------
  const sendKeys = async (id: string, keys: string[]) => {
    try { await api.sendKeys(id, keys); }
    catch (e) { toast(errText(e, '按键发送失败')); return; }
    toast('已发送: ' + keys.join(' '));
    setTimeout(() => void loadPrompt(id), 600);
  };

  const loadPrompt = async (id: string) => {
    let p: InteractivePrompt | null;
    // 失败也要先确认还停在这条流上 —— 否则 A 的迟到失败会抹掉 B 刚渲染的面板。
    try { p = await api.sessionPrompt(id); }
    catch { if (isCurrent(store.getState(), { kind: 'session', id })) clear(promptSlot); return; }
    // 期间切走了就别动 DOM —— 否则会抹掉新会话刚渲染的面板。
    // 也要复查 controllable：翻成不可控时轮询已被订阅停掉，此刻贴回面板就再没人来清它。
    const s = store.getState();
    if (!isCurrent(s, { kind: 'session', id }) || !sessionOf(s, id)?.controllable) return;
    clear(promptSlot);
    if (p && p.options.length > 0) promptSlot.appendChild(promptBox(p, keys => void sendKeys(id, keys)));
  };

  // ---------- 生命周期 ----------
  const openStream = async (ref: StreamRef) => {
    stopMessengerPoll();
    // 留着旧 pending 的话，下次切回信使流会先画出一个可点的陈旧「待确认操作」面板，
    // 一直滞留到 loadPending() 拉回新值 —— 而那要等整个转录请求先跑完。
    if (ref.kind !== 'messenger') store.update(pendingSet([]));
    hide(placeholder);
    show(consoleView, 'flex');
    app.classList.add('show-console');

    await reload(ref);
    if (!isCurrent(store.getState(), ref)) return;    // 期间切走了：不要再装定时器

    if (ref.kind === 'messenger') {
      await loadPending();
      if (!isCurrent(store.getState(), ref)) return;
      messengerTimer = setInterval(() => void poll(ref), MESSENGER_POLL_MS);
    }
    // 会话流的交互选择器轮询不在这里装，见下方 promptTimer 的订阅。
  };

  const closeConsole = () => {
    stopMessengerPoll();
    hide(consoleView);
    show(placeholder, 'grid');
    app.classList.remove('show-console');
  };

  // 头部：current 变化或“当前会话的 summary”变化都重画（后者是今天没有的实时刷新）。
  // 选择器只投影 renderHead 真正读到的字段 —— 直接返回 summary 对象的话，它在每次
  // sessionsReplaced/sessionUpserted 后都是新实例，浅比较永不判等，头部按钮会随每个
  // busy↔idle 心跳整体重建，正落在被替换节点上的那一次点击就丢了。
  store.subscribe(
    s => {
      const x = s.current?.kind === 'session' ? s.sessions.get(s.current.id) : undefined;
      return {
        ref: s.current,
        known: x !== undefined,
        name: x?.name,
        cwd: x?.cwd,
        live: x?.live,
        controllable: x?.controllable,
        status: x && statusLabel(x),
      };
    },
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

  // 交互选择器轮询：由「当前流是否为可控会话」驱动，而不是只在切流时装一次 ——
  // 否则在已打开的会话上点「接管」后，要等到下次切流才会开始轮询。
  store.subscribe(
    s => (s.current?.kind === 'session' && s.sessions.get(s.current.id)?.controllable ? s.current.id : null),
    id => {
      clearInterval(promptTimer); promptTimer = undefined;
      clear(promptSlot);
      if (id === null) return;
      void loadPrompt(id);
      promptTimer = setInterval(() => void loadPrompt(id), PROMPT_POLL_MS);
    },
  );

  return {
    onMessage(sessionId, event) {
      if (isCurrent(store.getState(), { kind: 'session', id: sessionId })) transcript.accept(event);
    },
  };
}
