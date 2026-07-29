// 通用可观察存储，不含任何业务。
export interface Store<S> {
  getState(): S;
  update(reducer: (s: S) => S): void;
  /** 立即以当前值回调一次；selector 结果（浅比较）变化时再回调。返回退订函数。 */
  subscribe<T>(selector: (s: S) => T, cb: (v: T) => void): () => void;
}

interface Sub<S> { select: (s: S) => any; cb: (v: any) => void; last: any }

// 一层浅比较：selector 返回对象字面量（如 { busy, idle }）时不至于每次 update 都触发重渲染。
// 只对普通对象/数组做这层浅比较；其它对象（Map/Set/Date…）按引用比 —— 它们的内容不在自有键上，
// 浅比较会把两个内容不同的实例判等，宁可多通知一次，绝不漏通知。
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.prototype && !Array.isArray(a)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const subs = new Set<Sub<S>>();
  return {
    getState: () => state,
    update(reducer) {
      const next = reducer(state);
      if (next === state) return;
      state = next;
      for (const sub of subs) {
        const v = sub.select(state);
        if (same(v, sub.last)) continue;
        sub.last = v;
        sub.cb(v);
      }
    },
    subscribe(selector, cb) {
      const sub: Sub<S> = { select: selector, cb, last: selector(state) };
      subs.add(sub);
      cb(sub.last);
      return () => { subs.delete(sub); };
    },
  };
}
