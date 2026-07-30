import { describe, it, expect } from 'vitest';
import { createStore } from '../../web/src/core/store';

describe('createStore', () => {
  it('订阅时立即以当前值回调一次', () => {
    const store = createStore({ n: 1 });
    const seen: number[] = [];
    store.subscribe(s => s.n, v => seen.push(v));
    expect(seen).toEqual([1]);
  });

  it('selector 结果未变化时不回调', () => {
    const store = createStore({ n: 1, other: 'a' });
    const seen: number[] = [];
    store.subscribe(s => s.n, v => seen.push(v));
    store.update(s => ({ ...s, other: 'b' }));
    expect(seen).toEqual([1]);
    store.update(s => ({ ...s, n: 2 }));
    expect(seen).toEqual([1, 2]);
  });

  it('对象型 selector 做一层浅比较', () => {
    const store = createStore({ a: 1, b: 2, c: 3 });
    let calls = 0;
    store.subscribe(s => ({ a: s.a, b: s.b }), () => { calls++; });
    expect(calls).toBe(1);
    store.update(s => ({ ...s, c: 9 }));
    expect(calls).toBe(1);
    store.update(s => ({ ...s, b: 8 }));
    expect(calls).toBe(2);
  });

  it('内容不同的 Map 算变化（浅比较不得把两个 Map 判等）', () => {
    const store = createStore({ sessions: new Map([['a', 1]]) });
    let calls = 0;
    store.subscribe(s => s.sessions, () => { calls++; });
    expect(calls).toBe(1);
    store.update(s => ({ ...s, sessions: new Map([['a', 1], ['b', 2]]) }));
    expect(calls).toBe(2);
  });

  it('从空对象换成 Map 也算变化（原型守卫两边都要判）', () => {
    const store = createStore<{ sessions: object }>({ sessions: {} });
    let calls = 0;
    store.subscribe(s => s.sessions, () => { calls++; });
    expect(calls).toBe(1);
    store.update(s => ({ ...s, sessions: new Map() }));
    expect(calls).toBe(2);
  });

  it('reducer 返回同一引用时不通知（连 selector 都不再调用）', () => {
    const store = createStore({ n: 1 });
    let selects = 0;
    let calls = 0;
    store.subscribe(s => { selects++; return s.n; }, () => { calls++; });
    expect(selects).toBe(1);
    store.update(s => s);
    expect(selects).toBe(1);
    expect(calls).toBe(1);
  });

  it('退订后不再收到通知，但状态照常更新', () => {
    const store = createStore({ n: 1 });
    let calls = 0;
    const off = store.subscribe(s => s.n, () => { calls++; });
    off();
    store.update(s => ({ ...s, n: 2 }));
    expect(calls).toBe(1);
    expect(store.getState().n).toBe(2);
  });
});
