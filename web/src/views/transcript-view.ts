import type { TranscriptEvent } from '../../../src/domain/types';
import { bubble, messageNodes } from '../components/message-node';
import { createTimeline } from '../transcript/timeline';
import { $, clear, el } from '../ui/dom';

export interface TranscriptView {
  /** 切换会话 / 刷新：全量重置，空转录时显示 emptyHint。 */
  reset(events: TranscriptEvent[], emptyHint: string): void;
  /** 增量轮询：服务端全量列表。 */
  ingest(events: TranscriptEvent[]): void;
  /** SSE 单条。 */
  accept(event: TranscriptEvent): void;
  /** 乐观用户气泡（发送瞬间）。 */
  pushLocal(text: string): void;
  /** 系统气泡（executed / cancelled / expired，不在转录里）。 */
  pushStatus(text: string): void;
}

// 消息流状态（events / 已渲染 uuid / 窗口起点 / 乐观气泡登记）封装在这里，不进全局 store：
// 只有一个消费者、每条 SSE 都在变、数组可达数千条。纯计算部分在 transcript/timeline.ts。
export function mountTranscript(): TranscriptView {
  const view = $('streamView');
  const msgs = $('messages');
  const loadMore = $('loadMore');
  const jump = $('jump');
  const jumpCount = $('jumpCount');
  const timeline = createTimeline();

  let jumped = 0;
  const atBottom = () => view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  const toBottom = () => { view.scrollTop = view.scrollHeight; };
  const hideJump = () => { jumped = 0; jump.classList.remove('is-shown'); };
  const bumpJump = (n: number) => {
    jumped += n;
    jumpCount.textContent = String(jumped);
    jump.classList.add('is-shown');
  };
  const dropHint = () => { msgs.querySelector('.rail__empty')?.remove(); };
  const appendAll = (events: TranscriptEvent[]) => {
    dropHint();
    for (const e of events) for (const node of messageNodes(e)) msgs.appendChild(node);
  };

  loadMore.onclick = () => {
    const prevH = view.scrollHeight;
    const { prepend, hasEarlier } = timeline.earlier();
    const frag = document.createDocumentFragment();
    for (const e of prepend) for (const node of messageNodes(e)) frag.appendChild(node);
    msgs.insertBefore(frag, msgs.firstChild);
    loadMore.style.display = hasEarlier ? 'block' : 'none';
    view.scrollTop = view.scrollHeight - prevH;   // 保持视口位置
  };
  jump.onclick = () => { toBottom(); hideJump(); };

  return {
    reset(events, emptyHint) {
      const { render, hasEarlier } = timeline.reset(events);
      clear(msgs);
      appendAll(render);
      loadMore.style.display = hasEarlier ? 'block' : 'none';
      if (msgs.childElementCount === 0) {
        msgs.appendChild(el('div', { class: 'rail__empty', style: 'margin-top:40px', text: emptyHint }));
      }
      // 切换会话：直接展示最新，不做滚动动画
      const prev = view.style.scrollBehavior;
      view.style.scrollBehavior = 'auto';
      toBottom();
      view.style.scrollBehavior = prev;
      hideJump();
    },

    ingest(events) {
      const wasBottom = atBottom();
      const { append } = timeline.ingest(events);
      if (append.length === 0) return;
      appendAll(append);
      if (wasBottom) toBottom(); else bumpJump(append.length);
    },

    accept(event) {
      const wasBottom = atBottom();
      if (!timeline.accept(event).append) return;
      appendAll([event]);
      if (wasBottom) toBottom(); else bumpJump(1);
    },

    pushLocal(text) {
      dropHint();
      msgs.appendChild(bubble('user', '你', text));
      timeline.noteLocal(text);        // 等待被同文本的转录事件回收
      toBottom();
    },

    pushStatus(text) {
      dropHint();
      msgs.appendChild(bubble('system', '系统', text));
      toBottom();
      hideJump();
    },
  };
}
