import type { TranscriptEvent } from '../../../src/domain/types';

export const MAX_RENDER = 300;   // DOM 中最多渲染的消息数
export const CHUNK = 200;        // 「载入更早」每次追加

export interface Timeline {
  /** 首屏/切换会话：以全量事件重置，返回该渲染的窗口。 */
  reset(events: TranscriptEvent[]): { render: TranscriptEvent[]; hasEarlier: boolean };
  /** 增量轮询：服务端全量列表 → 该追加到末尾的事件 + 被回收的乐观气泡数。 */
  ingest(events: TranscriptEvent[]): { append: TranscriptEvent[]; adopted: number };
  /** SSE 单条。 */
  accept(event: TranscriptEvent): { append: boolean };
  /** 向上翻一页。 */
  earlier(): { prepend: TranscriptEvent[]; hasEarlier: boolean };
  /** 登记一个乐观气泡的文本，等待被同文本的 user 事件回收。 */
  noteLocal(text: string): void;
}

const keyOf = (e: TranscriptEvent): string | null => e.uuid ?? null;

export function createTimeline(): Timeline {
  let events: TranscriptEvent[] = [];
  let start = 0;                            // 窗口起点：events 中首个已渲染事件的下标
  let rendered = new Set<string>();          // 已渲染或已计入的 uuid（含窗口外的更早事件）
  let local: string[] = [];                  // 待回收的乐观气泡文本

  // 发送消息时先渲染的乐观气泡，会在转录里再次出现。回收 = 不产生新节点，但登记其 uuid。
  const adoptLocal = (e: TranscriptEvent): boolean => {
    if (e.kind !== 'user') return false;
    const i = local.indexOf(e.text);
    if (i < 0) return false;
    local.splice(i, 1);
    const k = keyOf(e);
    if (k !== null) rendered.add(k);
    return true;
  };

  return {
    reset(list) {
      events = list.slice();
      // 登记全部 uuid（不只窗口内的）：否则下一轮增量会把窗口外的旧事件重复追加到末尾。
      rendered = new Set(events.map(keyOf).filter((k): k is string => k !== null));
      local = [];
      start = Math.max(0, events.length - MAX_RENDER);
      return { render: events.slice(start), hasEarlier: start > 0 };
    },

    ingest(list) {
      events = list.slice();
      const append: TranscriptEvent[] = [];
      let adopted = 0;
      for (const e of list) {
        const k = keyOf(e);
        if (k === null) continue;            // 无 uuid 无法去重，追加会每轮重复
        if (rendered.has(k)) continue;
        if (adoptLocal(e)) { adopted++; continue; }
        rendered.add(k);
        append.push(e);
      }
      return { append, adopted };
    },

    accept(event) {
      const k = keyOf(event);
      if (k === null) return { append: false };  // 无 uuid 无法去重，服务端每次转录写入都重播，追加会虚增
      if (rendered.has(k)) return { append: false };
      events.push(event);
      if (adoptLocal(event)) return { append: false };
      rendered.add(k);
      return { append: true };
    },

    earlier() {
      if (start === 0) return { prepend: [], hasEarlier: false };
      const from = Math.max(0, start - CHUNK);
      const prepend = events.slice(from, start);
      start = from;
      return { prepend, hasEarlier: start > 0 };
    },

    noteLocal(text) { local.push(text); },
  };
}
