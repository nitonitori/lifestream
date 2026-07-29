import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../src/domain/types.js';
import { createTimeline } from '../../web/src/transcript/timeline';

const user = (uuid: string, text: string): TranscriptEvent =>
  ({ kind: 'user', uuid, ts: 0, text, raw: {} });

// u0..u(n-1)
const many = (n: number): TranscriptEvent[] =>
  Array.from({ length: n }, (_, i) => user('u' + i, 't' + i));

const META: TranscriptEvent = { kind: 'meta', type: 'summary', raw: {} };

describe('timeline: 窗口化', () => {
  it('reset 只渲染末尾 MAX_RENDER 条，并报告还有更早的', () => {
    const t = createTimeline();
    const r = t.reset(many(350));              // 350 - 300 = 50
    expect(r.render).toHaveLength(300);
    expect(r.render[0].uuid).toBe('u50');
    expect(r.render[299].uuid).toBe('u349');
    expect(r.hasEarlier).toBe(true);
  });

  it('不足 MAX_RENDER 时全量渲染且没有更早的', () => {
    const t = createTimeline();
    const r = t.reset(many(3));
    expect(r.render).toHaveLength(3);
    expect(r.hasEarlier).toBe(false);
  });

  it('earlier() 按 CHUNK 分页，取尽后 hasEarlier 转 false', () => {
    const t = createTimeline();
    t.reset(many(520));                        // start = 520 - 300 = 220

    const p1 = t.earlier();                    // 220 - 200 = 20
    expect(p1.prepend).toHaveLength(200);
    expect(p1.prepend[0].uuid).toBe('u20');
    expect(p1.prepend[199].uuid).toBe('u219');
    expect(p1.hasEarlier).toBe(true);

    const p2 = t.earlier();                    // 20 - 200 → 0，只剩 20 条
    expect(p2.prepend).toHaveLength(20);
    expect(p2.prepend[0].uuid).toBe('u0');
    expect(p2.hasEarlier).toBe(false);

    const p3 = t.earlier();
    expect(p3.prepend).toEqual([]);
    expect(p3.hasEarlier).toBe(false);
  });
});

describe('timeline: uuid 去重', () => {
  it('ingest 只追加未渲染过的事件', () => {
    const t = createTimeline();
    t.reset(many(3));
    expect(t.ingest(many(3)).append).toEqual([]);
    const grown = [...many(3), user('u3', 't3')];
    expect(t.ingest(grown).append.map(e => e.uuid)).toEqual(['u3']);
  });

  it('窗口外的旧事件不会被重复追加（>MAX_RENDER 的潜在缺陷）', () => {
    const t = createTimeline();
    const all = many(350);
    t.reset(all);                              // 只渲染 u50..u349，但登记全部 uuid
    expect(t.ingest(all).append).toEqual([]);
  });

  it('accept 对同一 uuid 幂等', () => {
    const t = createTimeline();
    t.reset([]);
    expect(t.accept(user('u1', 'hi'))).toEqual({ append: true });
    expect(t.accept(user('u1', 'hi'))).toEqual({ append: false });
  });

  it('无 uuid 的 meta 事件：首屏渲染、增量轮询跳过、SSE 单条照常追加', () => {
    const t = createTimeline();
    expect(t.reset([META]).render).toEqual([META]);
    const t2 = createTimeline();
    t2.reset([]);
    expect(t2.ingest([META]).append).toEqual([]);   // 无法去重，追加会每轮重复
    expect(t2.accept(META)).toEqual({ append: true }); // SSE 只送达一次
  });
});

describe('timeline: 乐观气泡回收', () => {
  it('noteLocal 后首个同文本 user 事件被回收：不产生新节点，但 uuid 记为已渲染', () => {
    const t = createTimeline();
    t.reset([]);
    t.noteLocal('hello');

    const r = t.ingest([user('u1', 'hello')]);
    expect(r.append).toEqual([]);
    expect(r.adopted).toBe(1);

    // 同一 uuid 再来不追加
    expect(t.ingest([user('u1', 'hello')]).append).toEqual([]);
    // 登记已被消耗：相同文本的另一条正常追加
    const r2 = t.ingest([user('u1', 'hello'), user('u2', 'hello')]);
    expect(r2.append.map(e => e.uuid)).toEqual(['u2']);
    expect(r2.adopted).toBe(0);
  });

  it('accept 走同一条回收规则', () => {
    const t = createTimeline();
    t.reset([]);
    t.noteLocal('hi');
    expect(t.accept(user('u9', 'hi'))).toEqual({ append: false });
    expect(t.accept(user('u10', 'hi'))).toEqual({ append: true });
  });

  it('只回收 user 事件，文本不同不回收', () => {
    const t = createTimeline();
    t.reset([]);
    t.noteLocal('hello');
    expect(t.accept(user('u1', 'other'))).toEqual({ append: true });
    expect(t.accept({ kind: 'assistant', uuid: 'u2', ts: 0, text: 'hello', toolUses: [], raw: {} }))
      .toEqual({ append: true });
  });

  it('reset 清空乐观气泡登记（DOM 一并作废，转录已含用户消息）', () => {
    const t = createTimeline();
    t.noteLocal('x');
    t.reset([]);
    expect(t.accept(user('u1', 'x'))).toEqual({ append: true });
  });
});
