# Web 前端重构（模块化 + TS 化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web/app.js`（599 行单文件、全局作用域、11 类职责）重构为分层的 TypeScript 模块，关键逻辑可单测，前后端类型契约由编译器保证，页面表现保持一致。

**Architecture:** 单向数据流 `api / sse ──update(纯 reducer)──▶ store ──notify──▶ views ──▶ DOM`，用户操作回到 api。依赖方向严格单向 `main → views → components → ui / core`，两条硬性规则：(1) `components/` 禁止 import `core/store` 与 `core/api`；(2) `views/` 之间禁止互相 import，跨视图影响一律经 store。消息流状态（events / 已渲染 uuid / 窗口起点 / 乐观气泡登记）不进全局 store，封装在 `transcript-view` 内，其纯计算部分在 `transcript/timeline.ts`。

**Tech Stack:** TypeScript 5.7（`tsc --noEmit` 只做类型检查）· esbuild（唯一新增 devDependency，打包单文件到 `web/public/app.js`）· vitest（已有，直接执行 TS，node 环境）· 零运行时依赖、无框架。

**设计依据:** [DESIGN](../specs/2026-07-29-web-frontend-refactor-design.md)。本计划对设计做了三处细化，均在下面的「与设计的差异」中列明。

## Global Constraints

- **node/npm 必须用绝对路径**：`/Users/l/.nvm/versions/node/v24.18.0/bin/node`；npm 经 `/Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js` 调用。本机裸 `node` / `npm` / `npx` 会触发 nvm 故障（fork 风暴），**任何步骤都不得使用裸命令**。
- 所有命令在开发实例目录 `/Users/l/dev-ai/lifestream` 下执行（端口 8788）。部署实例 `/Users/l/apps/lifestream`（8787）只在 Task 7 触碰。
- **不新增任何运行时依赖**，唯一新增 devDependency 是 `esbuild`。不引入框架、不引入 jsdom/happy-dom。
- **不改后端 REST / SSE 协议**。`src/` 下只允许改 `src/index.ts` 的 `webRoot` 一行。
- **不拆分 CSS**。仅在 Task 5 为 dialog 组件追加 3 行样式。
- **面向用户的文案逐字不变**（含标点、省略号、`·` 分隔符）。任何文案改动都是缺陷。
- `web/src/**` 跨到 `src/domain/**` 的 import **必须写 `import type`**：esbuild 只擦除 type import，值导入会因 `.js`/无扩展名路径在 bundle 阶段解析失败。`tsconfig.web.json` 开 `verbatimModuleSyntax`，漏写 `type` 会编译报错。
- `web/src` 内部模块之间的 import **不写扩展名**（`./core/store`），由 `moduleResolution: Bundler` 与 esbuild 解析。
- 每个 Task 末尾提交一次，提交信息前缀：`refactor(web):` / `test(web):` / `chore(web):`。
- 浏览器验证时短暂前台启动 dev 实例，验证完立即 Ctrl-C 停止 —— 不要让 dev(8788) 与部署(8787) 长期同时运行（共享 `~/.lifestream` 与 tmux socket）。

**常用命令（复制即用，勿改路径）**

```bash
# 后端类型检查
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
# 前端类型检查
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
# 全部测试
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
# 单个测试文件
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-state.test.ts
# 前台启动 dev 实例（浏览器验证用，Ctrl-C 停止）
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/tsx/dist/cli.mjs src/cli.ts serve
```

## 与设计的差异（实施期发现，已确认）

1. **`app.js` 不做「先原样搬为 TS 再逐步拆」**。设计第 10 节第 1 步要求把 599 行 JS 搬成 `web/src/main.ts` 并加标注通过 strict —— 这些标注在 Task 6 会被整体删除。改为：Task 1 只把 `app.js` 连同 `index.html`/`style.css` 一起搬进 `web/public/`（仍是被 HTTP 直接服务的静态 JS，仍被 git 跟踪），Task 2~5 在 `web/src/` 下**新增**被 tsc + vitest 检查的模块（此期间浏览器仍跑旧 `app.js`，页面不变），Task 6 一次性完成「main.ts + index.html + esbuild 产物」的原子换血。省掉一整轮无用标注，且每步依然可运行、可浏览器验证。
2. **`AppState` 增 `authNotice: string`**，reducer 增 `authProbed(ok)` / `unauthorized()` / `loginRejected()`。今天登录页有三种不同提示（首次探测 401 → 空白；已登录后失效 → 「会话已失效，请重新登录。」；令牌错误 → 「令牌无效，请重试。」），只有把提示文本也放进状态才能逐字复刻。同理 `api.call` 需要 `silent401` 选项，供启动探测与 `/api/login` 绕过 401 上报。
3. **`sessionRemoved(id)` 不清 `current`**。今天 SSE 的 `session.removed` 只从侧栏移除，不关闭已打开的控制台；只有主动「结束会话」才关闭。因此保留独立的 `streamCleared()`，由结束会话流程显式派发两者。

## 行为差异清单（验收依据）

除以下七条，重构前后页面表现必须一致：

1. **三处原生 `confirm()` / `prompt()` 换成项目 dialog**（接管、结束会话、新建会话）。Esc 或点遮罩取消，prompt 中 Enter 提交。
2. **修掉一个潜在缺陷**：转录超过 300 条时，今天的增量轮询会把窗口外的旧事件重复追加到消息流末尾（`renderedKeys` 只登记了窗口内的 uuid）。`timeline.reset` 改为登记**全部** uuid，`earlier()` 仍从事件数组取更早的批次，行为因此正确。日常（<300 条）不可见。
3. **控制台头部改为跟随会话状态实时更新**：今天头部副标题（`运行中 · /path`）在选中后不再刷新，直到重新选中；改为订阅该会话的 summary 切片，SSE 更新即刷新。
4. **首次访问（无 cookie）的登录页不再显示「会话已失效，请重新登录。」**。今天启动探测 `GET /api/agent/enabled` 拿到 401 后，`api()` 里那句 `if (r.status === 401 && path !== '/api/login') handleUnauth()` 会一并写上这句提示 —— 首次访问的人从未登录过，却被告知会话已失效。重构后启动探测走 `silent401`，提示留空；「会话已失效」只在**登录之后**才可能出现（令牌被撤销/退出本设备）。
5. **「结束会话」「撤销设备」「退出登录」从坏的变成能用的**。旧 `api()`（`app.js:5`）给每个请求无条件加
   `content-type: application/json`，而这三个调用点不带 body；Fastify 默认 JSON 解析器在解析阶段就以
   `400 FST_ERR_CTP_EMPTY_JSON_BODY` 拒掉，早于 `routes.ts:50` 的鉴权 preHandler。所以线上表现是：结束会话
   toast 显示 `undefined`（`'Bad Request'.message`）且会话没结束；撤销设备 toast「撤销失败」且设备没撤销；
   退出登录界面回到登录页但 cookie 与设备记录都还在，刷新即又登录。`api.ts` 改为按「是否真的有 body」
   决定加不加这个头，三者恢复正常 —— 退出登录会真的清 cookie 并删设备记录，结束会话会真的关 tmux 窗口。
6. **点击「当前已选中」的卡片不再重载消息**（Task 6 实施中发现，非计划原意）。旧 `selectStream()` 每次点击都无条件重跑一遍
   拉取与渲染，所以重复点同一张卡片等于一次手动刷新；新架构下 `store` 对 `s.current` 的 `{kind, id}` 做浅比较，
   重复选中判等、订阅不回调，`openStream()` 不再重跑。头部的「刷新」按钮覆盖了这个需求，故不为此破坏 store 的
   浅比较契约。连带影响已在 Task 6 修复轮消除：交互选择器轮询改由「当前流是否为可控会话」的订阅驱动，
   不再依赖「重点卡片以重跑 openStream」这条已消失的恢复路径。
7. **启动探测非 401 失败时停在登录页**（最终审查发现，非计划原意）。旧 `boot()`（`app.js:47-52`）对
   `GET /api/agent/enabled` 的失败一律 `r.json().catch(() => ({ enabled: false }))` 后继续 `boot()`，
   于是服务端 500 之类的故障也会**进入应用**，随后每个接口再各自失败。新版 `main.ts` 把任何失败都归为
   `authProbed(false)`，停在登录页且提示区留空。新行为更合理（未鉴权成功就不该进应用），登记于此。

---

### Task 1: 静态目录切分（`web/public` 作为 HTTP 根）

**Files:**
- Modify: `.gitignore:3`
- Move: `web/index.html` → `web/public/index.html`
- Move: `web/style.css` → `web/public/style.css`
- Move: `web/app.js` → `web/public/app.js`
- Modify: `src/index.ts:62`
- Modify: `test/component/static.test.ts:10`

**Interfaces:**
- Consumes: 无
- Produces: `web/public/` 是 `@fastify/static` 的 root；`web/src/` 目录已建好，后续 Task 往里加 TS 模块。

- [x] **Step 1: 先修 `.gitignore`（不修就会静默丢文件）**

`.gitignore:3` 的裸 `public/` 会匹配**任意深度**的 `public/`，包含 `web/public/`。先验证再改：

```bash
git check-ignore -v web/public/index.html
```

预期输出：`.gitignore:3:public/	web/public/index.html`

把第 3 行 `public/` 改为 `/public/`（只匹配仓库根，仓库根目前并无 `public/`，改动无副作用）：

```
node_modules/
dist/
/public/
*.log
```

再次执行 `git check-ignore -v web/public/index.html`，预期**无输出、退出码 1**（不再被忽略）。

- [x] **Step 2: 建目录并移动三个静态文件**

```bash
mkdir -p web/public web/src
git mv web/index.html web/public/index.html
git mv web/style.css web/public/style.css
git mv web/app.js web/public/app.js
git status --short
```

预期：三个 `R` 重命名条目 + `.gitignore` 的 `M`。`web/` 下只剩 `public/` 与空的 `src/`。

- [x] **Step 3: 改 webRoot（后端唯一改动）**

`src/index.ts:62`：

```ts
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../web/public');
```

（dev 从 `src/` 解析、部署从 `dist/` 解析，都落到同一个 `web/public`，沿用现有机制。）

- [x] **Step 4: 同步静态资源测试的路径**

`test/component/static.test.ts:10`：

```ts
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/public');
```

- [x] **Step 5: 跑测试与类型检查**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
```

预期：全部通过（含 `serves index.html at / (C4)`），tsc 无输出。

- [x] **Step 6: 浏览器验证页面未变**

前台启动 dev 实例：

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/tsx/dist/cli.mjs src/cli.ts serve
```

打开 `http://127.0.0.1:8788`，确认：登录后侧栏、信使会话、样式、图标全部正常（说明 `/style.css` 与 `/app.js` 仍被正确服务）。然后 Ctrl-C 停止。

- [x] **Step 7: 提交**

```bash
git add .gitignore src/index.ts test/component/static.test.ts web/
git commit -m "$(cat <<'EOF'
chore(web): 静态资源移入 web/public 并作为 HTTP 根

为前端构建产物腾出位置：web/public 只放被服务的资源，web/src 放 TS 源码。
顺带把 .gitignore 的裸 public/ 限定到仓库根，否则 web/public 会被整体忽略。
EOF
)"
```

---

### Task 2: `core/store.ts` + `core/state.ts` + 单测

**Files:**
- Create: `tsconfig.web.json`
- Create: `web/src/core/store.ts`
- Create: `web/src/core/state.ts`
- Create: `test/unit/web-store.test.ts`
- Create: `test/unit/web-state.test.ts`
- Modify: `package.json`（`typecheck` 脚本）

**Interfaces:**
- Consumes: `SessionSummary`、`PendingAction`（`import type` 自 `src/domain/types`）
- Produces:
  - `store.ts`：`interface Store<S> { getState(): S; update(reducer: (s: S) => S): void; subscribe<T>(selector: (s: S) => T, cb: (v: T) => void): () => void }`、`function createStore<S>(initial: S): Store<S>`
  - `state.ts`：`type StreamRef = { kind: 'messenger' } | { kind: 'session'; id: string }`、`const MESSENGER: StreamRef`、`type Auth`、`type Conn`、`interface AppState`、`const initialState: AppState`；reducer 工厂 `sessionsReplaced(list)` / `sessionUpserted(x)` / `sessionRemoved(id)` / `streamSelected(ref)` / `streamCleared()` / `connChanged(c)` / `pendingSet(list)` / `agentEnabledSet(b)` / `authProbed(ok)` / `unauthorized()` / `loginRejected()`（均返回 `(s: AppState) => AppState`）；selector `fleetCounts(s)` / `sessionOf(s, id)` / `statusLabel(x)` / `vitalOf(x)` / `tagOf(x)` / `isCurrent(s, ref)`

- [x] **Step 1: 建 `tsconfig.web.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["web/src/**/*"]
}
```

`types: []` 排除 `@types/node`：前端只该看见 DOM（顺带让 `setInterval` 返回 `number` 而不是 `NodeJS.Timeout`）。`verbatimModuleSyntax` 强制跨到 `src/domain` 的导入写成 `import type`。

- [x] **Step 2: 写 `web/src/core/store.ts`**

```ts
// 约 40 行的通用可观察存储，不含任何业务。
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
```

- [x] **Step 3: 写 `test/unit/web-store.test.ts`**

```ts
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

  it('reducer 返回同一引用时不通知', () => {
    const store = createStore({ n: 1 });
    let calls = 0;
    store.subscribe(s => s.n, () => { calls++; });
    store.update(s => s);
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
```

- [x] **Step 4: 跑 store 单测，确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-store.test.ts
```

预期：5 passed。（先写实现再写测试是因为 `createStore` 是纯基础设施；下面的 state/timeline 都按「测试先失败」走。）

- [x] **Step 5: 写 `test/unit/web-state.test.ts`（此时应当失败）**

```ts
import { describe, it, expect } from 'vitest';
import type { SessionSummary } from '../../src/domain/types.js';
import {
  initialState, MESSENGER,
  sessionsReplaced, sessionUpserted, sessionRemoved,
  streamSelected, streamCleared, connChanged, pendingSet, agentEnabledSet,
  authProbed, unauthorized, loginRejected,
  fleetCounts, sessionOf, statusLabel, vitalOf, tagOf, isCurrent,
} from '../../web/src/core/state';

const S = (over: Partial<SessionSummary> & { sessionId: string }): SessionSummary =>
  ({ cwd: '/w', status: 'idle', origin: 'managed', live: true, controllable: true, ...over });

describe('reducers', () => {
  it('sessionsReplaced 建新 Map，不改原 state', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' }), S({ sessionId: 'b' })])(initialState);
    expect(initialState.sessions.size).toBe(0);
    expect([...s1.sessions.keys()]).toEqual(['a', 'b']);
  });

  it('sessionUpserted 覆盖同 id 且不原地改', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a', status: 'idle' })])(initialState);
    const s2 = sessionUpserted(S({ sessionId: 'a', status: 'busy' }))(s1);
    expect(s1.sessions.get('a')!.status).toBe('idle');
    expect(s2.sessions.get('a')!.status).toBe('busy');
    expect(s2.sessions).not.toBe(s1.sessions);
  });

  it('sessionRemoved 删条目但不清 current（SSE 移除不关闭控制台）', () => {
    const s1 = streamSelected({ kind: 'session', id: 'a' })(sessionsReplaced([S({ sessionId: 'a' })])(initialState));
    const s2 = sessionRemoved('a')(s1);
    expect(s2.sessions.has('a')).toBe(false);
    expect(s2.current).toEqual({ kind: 'session', id: 'a' });
  });

  it('sessionRemoved 对不存在的 id 返回同一引用', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' })])(initialState);
    expect(sessionRemoved('zzz')(s1)).toBe(s1);
  });

  it('streamSelected / streamCleared 只动 current', () => {
    const s1 = streamSelected(MESSENGER)(initialState);
    expect(s1.current).toEqual({ kind: 'messenger' });
    expect(streamCleared()(s1).current).toBeNull();
  });

  it('connChanged / pendingSet / agentEnabledSet', () => {
    expect(connChanged('down')(initialState).conn).toBe('down');
    expect(agentEnabledSet(true)(initialState).agentEnabled).toBe(true);
    const p = [{ id: 'p1', conversationId: 'messenger', kind: 'send' as const, params: {}, description: 'd', createdAt: 0 }];
    expect(pendingSet(p)(initialState).pending).toEqual(p);
  });

  it('三种登录态提示逐字不同', () => {
    const out = authProbed(false)(initialState);
    expect(out.auth).toBe('out');
    expect(out.authNotice).toBe('');                       // 首次探测 401：不显示提示
    const signedIn = authProbed(true)(initialState);
    expect(signedIn.auth).toBe('in');
    expect(unauthorized()(signedIn).authNotice).toBe('会话已失效，请重新登录。');
    expect(loginRejected()(signedIn).authNotice).toBe('令牌无效，请重试。');
    expect(unauthorized()(out)).toBe(out);                 // 已 out 不再覆盖（等价旧 unauthShown 守卫）
  });
});

describe('selectors', () => {
  const s = sessionsReplaced([
    S({ sessionId: 'a', status: 'busy' }),
    S({ sessionId: 'b', status: 'idle' }),
    S({ sessionId: 'c', status: 'unknown' }),
    S({ sessionId: 'd', status: 'busy', live: false }),
  ])(initialState);

  it('fleetCounts 只统计 live，unknown 既不计忙也不计闲', () => {
    expect(fleetCounts(s)).toEqual({ busy: 1, idle: 1 });
  });

  it('sessionOf', () => {
    expect(sessionOf(s, 'a')!.status).toBe('busy');
    expect(sessionOf(s, 'nope')).toBeUndefined();
  });

  it('statusLabel', () => {
    expect(statusLabel(S({ sessionId: 'x', live: false }))).toBe('离线');
    expect(statusLabel(S({ sessionId: 'x', status: 'busy' }))).toBe('运行中');
    expect(statusLabel(S({ sessionId: 'x', status: 'idle' }))).toBe('空闲');
    expect(statusLabel(S({ sessionId: 'x', status: 'unknown' }))).toBe('在线');
  });

  it('vitalOf', () => {
    expect(vitalOf(S({ sessionId: 'x', live: false }))).toBe('external');
    expect(vitalOf(S({ sessionId: 'x', status: 'busy' }))).toBe('busy');
    expect(vitalOf(S({ sessionId: 'x', status: 'idle' }))).toBe('idle');
    expect(vitalOf(S({ sessionId: 'x', status: 'unknown' }))).toBe('live');
  });

  it('tagOf', () => {
    expect(tagOf(S({ sessionId: 'x', controllable: true }))).toBe('可控');
    expect(tagOf(S({ sessionId: 'x', controllable: false }))).toBe('外部');
    expect(tagOf(S({ sessionId: 'x', controllable: false, live: false }))).toBe('离线');
  });

  it('isCurrent 区分 messenger 与具体会话', () => {
    const m = streamSelected(MESSENGER)(initialState);
    expect(isCurrent(m, MESSENGER)).toBe(true);
    expect(isCurrent(m, { kind: 'session', id: 'a' })).toBe(false);
    const one = streamSelected({ kind: 'session', id: 'a' })(initialState);
    expect(isCurrent(one, { kind: 'session', id: 'a' })).toBe(true);
    expect(isCurrent(one, { kind: 'session', id: 'b' })).toBe(false);
    expect(isCurrent(initialState, MESSENGER)).toBe(false);
  });
});
```

- [x] **Step 6: 运行确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-state.test.ts
```

预期：FAIL，`Failed to load .../web/src/core/state`（文件还不存在）。

- [x] **Step 7: 写 `web/src/core/state.ts`**

```ts
import type { PendingAction, SessionSummary } from '../../../src/domain/types';

export type StreamRef = { kind: 'messenger' } | { kind: 'session'; id: string };
export const MESSENGER: StreamRef = { kind: 'messenger' };

export type Auth = 'unknown' | 'in' | 'out';
export type Conn = 'connecting' | 'live' | 'down';

export interface AppState {
  auth: Auth;
  authNotice: string;              // 登录页提示文本（三种来源，见 authProbed/unauthorized/loginRejected）
  agentEnabled: boolean;
  sessions: Map<string, SessionSummary>;
  current: StreamRef | null;
  conn: Conn;
  pending: PendingAction[];        // 信使待确认动作
}

export const initialState: AppState = {
  auth: 'unknown', authNotice: '', agentEnabled: false,
  sessions: new Map(), current: null, conn: 'connecting', pending: [],
};

// ---------- reducers：纯函数 (s) => s'，返回新 Map / 新对象，不原地改 ----------

export const sessionsReplaced = (list: SessionSummary[]) => (s: AppState): AppState =>
  ({ ...s, sessions: new Map(list.map(x => [x.sessionId, x])) });

export const sessionUpserted = (x: SessionSummary) => (s: AppState): AppState => {
  const sessions = new Map(s.sessions);
  sessions.set(x.sessionId, x);
  return { ...s, sessions };
};

// 只从侧栏移除；不动 current —— SSE 的 session.removed 不关闭已打开的控制台。
export const sessionRemoved = (id: string) => (s: AppState): AppState => {
  if (!s.sessions.has(id)) return s;
  const sessions = new Map(s.sessions);
  sessions.delete(id);
  return { ...s, sessions };
};

export const streamSelected = (ref: StreamRef) => (s: AppState): AppState => ({ ...s, current: ref });
export const streamCleared = () => (s: AppState): AppState => ({ ...s, current: null });
export const connChanged = (conn: Conn) => (s: AppState): AppState => ({ ...s, conn });
export const pendingSet = (pending: PendingAction[]) => (s: AppState): AppState => ({ ...s, pending });
export const agentEnabledSet = (agentEnabled: boolean) => (s: AppState): AppState => ({ ...s, agentEnabled });

export const authProbed = (ok: boolean) => (s: AppState): AppState =>
  ({ ...s, auth: ok ? 'in' : 'out', authNotice: '' });
export const unauthorized = () => (s: AppState): AppState =>
  s.auth === 'out' ? s : { ...s, auth: 'out', authNotice: '会话已失效，请重新登录。' };
export const loginRejected = () => (s: AppState): AppState =>
  ({ ...s, auth: 'out', authNotice: '令牌无效，请重试。' });

// ---------- selectors：纯函数 ----------

// 仅统计 live 会话；status 为 unknown 时既不计忙也不计闲（旧版 claude 不写 status）。
export function fleetCounts(s: AppState): { busy: number; idle: number } {
  let busy = 0;
  let idle = 0;
  for (const x of s.sessions.values()) {
    if (!x.live) continue;
    if (x.status === 'busy') busy++;
    else if (x.status === 'idle') idle++;
  }
  return { busy, idle };
}

export const sessionOf = (s: AppState, id: string): SessionSummary | undefined => s.sessions.get(id);

export const statusLabel = (x: SessionSummary): string =>
  !x.live ? '离线' : x.status === 'busy' ? '运行中' : x.status === 'idle' ? '空闲' : '在线';

export const vitalOf = (x: SessionSummary): string =>
  !x.live ? 'external' : x.status === 'busy' ? 'busy' : x.status === 'idle' ? 'idle' : 'live';

export const tagOf = (x: SessionSummary): string => x.controllable ? '可控' : x.live ? '外部' : '离线';

export const isCurrent = (s: AppState, ref: StreamRef): boolean => {
  const cur = s.current;
  if (!cur || cur.kind !== ref.kind) return false;
  return cur.kind === 'messenger' || (ref.kind === 'session' && cur.id === ref.id);
};
```

- [x] **Step 8: 运行确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-state.test.ts
```

预期：全部 passed。

- [x] **Step 9: 接上前端类型检查脚本**

`package.json` 的 `scripts` 里把 `typecheck` 改为：

```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.web.json",
```

（`build` 暂不动，esbuild 在 Task 6 接入。）然后跑两遍 tsc：

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

预期：两条均无输出。若前端那条报 `Cannot find module '../../../src/domain/types'`，检查是否漏了 `import type`。

- [x] **Step 10: 提交**

```bash
git add tsconfig.web.json package.json web/src/core test/unit/web-store.test.ts test/unit/web-state.test.ts
git commit -m "$(cat <<'EOF'
refactor(web): 引入 store 与纯 reducer/selector 状态层

订阅式 store 取代手工调用渲染（renderRail 今天在 5 处被手动调用）；
状态迁移做成纯函数，会话增删、登录态三种提示、fleet 计数都获得单测保护。
EOF
)"
```

---

### Task 3: `transcript/timeline.ts` + 单测（消息流逻辑内核）

消息流最容易出错的三段逻辑（uuid 去重、乐观气泡回收、窗口化分页）在这里变成纯函数并获得回归保护。
本模块**不得** import `document` / `window` / `core/store` / `core/api`。

**Files:**
- Create: `web/src/transcript/timeline.ts`
- Create: `test/unit/web-timeline.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent`（`import type` 自 `src/domain/types`；判别式字段是 `kind`，`meta` 变体的 `uuid` 可选，其余必有）
- Produces:
  - `const MAX_RENDER = 300`、`const CHUNK = 200`
  - `interface Timeline { reset(events); ingest(events); accept(event); earlier(); noteLocal(text) }`
  - `function createTimeline(): Timeline`

- [x] **Step 1: 写 `test/unit/web-timeline.test.ts`（此时应当失败）**

```ts
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

  it('无 uuid 的 meta 事件：首屏渲染、增量轮询跳过、SSE 单条丢弃', () => {
    const t = createTimeline();
    expect(t.reset([META]).render).toEqual([META]);
    const t2 = createTimeline();
    t2.reset([]);
    expect(t2.ingest([META]).append).toEqual([]);   // 无法去重，追加会每轮重复
    // 服务端每次转录写入都会重播，来多少次都丢弃
    expect(t2.accept(META)).toEqual({ append: false });
    expect(t2.accept(META)).toEqual({ append: false });
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
```

- [x] **Step 2: 运行确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-timeline.test.ts
```

预期：FAIL，`Failed to load .../web/src/transcript/timeline`（文件还不存在）。

- [x] **Step 3: 写 `web/src/transcript/timeline.ts`**

```ts
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
```

- [x] **Step 4: 运行确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-timeline.test.ts
```

预期：全部 passed（11 个）。

- [x] **Step 5: 前端类型检查**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

预期：无输出。

- [x] **Step 6: 提交**

```bash
git add web/src/transcript test/unit/web-timeline.test.ts
git commit -m "$(cat <<'EOF'
refactor(web): 抽出消息流逻辑内核 timeline（纯函数 + 单测）

去重、乐观气泡回收、窗口化分页从 DOM 操作里剥离。
顺带修掉转录 >300 条时窗口外旧事件被重复追加的潜在缺陷：reset 登记全部 uuid。
EOF
)"
```

---

### Task 4: `core/api.ts` + `core/sse.ts`（I/O 边界）

把 6 处 `const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '…')` 样板塌缩成
一处。这两个模块是 I/O 边界（`fetch` / `EventSource`），按设计第 9 节**不写单测**，由 Task 7 的浏览器
走查验证；它们的价值在于把类型契约钉死在编译期。

**Files:**
- Create: `web/src/core/api.ts`
- Create: `web/src/core/sse.ts`

**Interfaces:**
- Consumes: `SessionSummary` / `TranscriptEvent` / `PendingAction` / `PlaneEvent`（`import type` 自 `src/domain/types`）、`InteractivePrompt`（`import type` 自 `src/domain/interactive-prompt`，该文件零 import，可安全跨引）
- Produces:
  - `api.ts`：`class ApiError extends Error { status; code }`、`errText(e, fallback)`、`interface DeviceInfo`、`type AgentResult`、`interface Api`、`createApi(onUnauthorized: () => void): Api`
  - `sse.ts`：`type StatusPayload`、`interface StreamHandlers`、`connectStream(h: StreamHandlers): () => void`

- [x] **Step 1: 写 `web/src/core/api.ts`**

```ts
import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import type { PendingAction, SessionSummary, TranscriptEvent } from '../../../src/domain/types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// 视图侧统一写法：catch (e) { toast(errText(e, '发送失败')) }
// 服务端返回 { error: { code, message } } 时用 message；网络中断/非 JSON 时用 fallback。
export const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError && e.message ? e.message : fallback;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  current: boolean;
}

// 与 src/im/conductor.ts 的 ConductorResult 同构。不 import 那个模块：它经 domain/control-plane
// 用到 node 全局，而 tsconfig.web.json 的 "types": [] 没有 @types/node，一 import 整个 web 程序就编译不过。
export type AgentResult =
  | { kind: 'reply'; text: string }
  | { kind: 'staged'; reply: string; actions: PendingAction[] }
  | { kind: 'executed'; results: string[] }
  | { kind: 'cancelled' }
  | { kind: 'expired' };

export interface Api {
  login(token: string): Promise<void>;
  logout(): Promise<void>;
  agentEnabled(): Promise<{ enabled: boolean }>;
  agentMessages(): Promise<TranscriptEvent[]>;
  agentPending(): Promise<PendingAction[]>;
  agentMessage(text: string): Promise<AgentResult>;
  listSessions(): Promise<SessionSummary[]>;
  sessionMessages(id: string): Promise<TranscriptEvent[]>;
  sendSessionMessage(id: string, text: string): Promise<void>;
  sessionPrompt(id: string): Promise<InteractivePrompt | null>;
  sendKeys(id: string, keys: string[]): Promise<void>;
  createSession(cwd: string): Promise<SessionSummary>;
  adoptSession(id: string, force: boolean): Promise<SessionSummary>;
  archiveSession(id: string): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<void>;
}

interface Opts extends RequestInit {
  /** 该请求的 401 不上报（启动探测与 /api/login：此时“未登录”是正常态，不是掉线）。 */
  silent401?: boolean;
}

const enc = encodeURIComponent;

export function createApi(onUnauthorized: () => void): Api {
  async function call<T>(path: string, opts: Opts = {}): Promise<T> {
    const { silent401, ...init } = opts;
    // 无 body 时不能带 content-type: application/json —— Fastify 解析 body 阶段就以 400 拒掉，早于鉴权。
    const headers = init.body == null ? undefined : { 'content-type': 'application/json' };
    const r = await fetch(path, {
      credentials: 'same-origin',
      headers,
      ...init,
    });
    if (r.status === 401 && !silent401) onUnauthorized();
    if (!r.ok) {
      const j = await r.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(r.status, j?.error?.code ?? 'UNKNOWN', j?.error?.message ?? '');
    }
    if (r.status === 204) return undefined as T;
    return await r.json() as T;
  }

  const post = <T>(path: string, body: unknown, opts: Opts = {}): Promise<T> =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body), ...opts });

  return {
    login: token => post<void>('/api/login', { token }, { silent401: true }),
    logout: () => post<void>('/api/logout', {}),
    agentEnabled: () => call<{ enabled: boolean }>('/api/agent/enabled', { silent401: true }),
    agentMessages: () => call<TranscriptEvent[]>('/api/agent/messages'),
    agentPending: () => call<PendingAction[]>('/api/agent/pending'),
    agentMessage: text => post<AgentResult>('/api/agent/message', { text }),
    listSessions: () => call<SessionSummary[]>('/api/sessions'),
    sessionMessages: id => call<TranscriptEvent[]>(`/api/sessions/${enc(id)}/messages`),
    sendSessionMessage: (id, text) => post<void>(`/api/sessions/${enc(id)}/messages`, { text }),
    sessionPrompt: id => call<InteractivePrompt | null>(`/api/sessions/${enc(id)}/prompt`),
    sendKeys: (id, keys) => post<void>(`/api/sessions/${enc(id)}/keys`, { keys }),
    createSession: cwd => post<SessionSummary>('/api/sessions', { cwd }),
    adoptSession: (id, force) => post<SessionSummary>(`/api/sessions/${enc(id)}/adopt`, { force }),
    archiveSession: id => call<void>(`/api/sessions/${enc(id)}`, { method: 'DELETE' }),
    devices: () => call<DeviceInfo[]>('/api/devices'),
    revokeDevice: id => call<void>(`/api/devices/${enc(id)}`, { method: 'DELETE' }),
  };
}
```

要点：`login` 与 `agentEnabled` 带 `silent401`，其余端点的 401 一律上报 —— 这正是旧
`if (r.status === 401 && path !== '/api/login') handleUnauth()` 的语义，外加行为差异清单第 4 条的修正。
`202` / `201` 都落在 `r.ok`，因此旧代码里 `if (r.status === 202)` 与 `if (r.ok)` 的区别在这里统一为
「不抛就算成功」。

- [x] **Step 2: 写 `web/src/core/sse.ts`**

```ts
import type { PlaneEvent, SessionSummary, TranscriptEvent } from '../../../src/domain/types';

// status 通道只承载全量快照与会话增删；message 通道承载转录事件。
export type StatusPayload =
  | SessionSummary[]
  | Extract<PlaneEvent, { type: 'session.updated' | 'session.removed' }>;

export interface StreamHandlers {
  onStatus(p: StatusPayload): void;
  onMessage(sessionId: string, event: TranscriptEvent): void;
  onConn(c: 'live' | 'down'): void;
}

export function connectStream(h: StreamHandlers): () => void {
  const es = new EventSource('/api/stream');
  es.onopen = () => h.onConn('live');
  es.onerror = () => h.onConn('down');   // EventSource 自动重连，重连成功再触发 onopen
  // 自定义事件名落到 addEventListener 的 (type: string) 重载，拿到的是 Event，需要窄化。
  es.addEventListener('status', ev => h.onStatus(JSON.parse((ev as MessageEvent).data) as StatusPayload));
  es.addEventListener('message', ev => {
    const m = JSON.parse(ev.data) as Extract<PlaneEvent, { type: 'message' }>;
    h.onMessage(m.sessionId, m.event);
  });
  return () => es.close();
}
```

- [x] **Step 3: 前端类型检查**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

预期：无输出。若报 `Property 'data' does not exist on type 'Event'`，是漏了 `as MessageEvent`。

- [x] **Step 4: 提交**

```bash
git add web/src/core/api.ts web/src/core/sse.ts
git commit -m "$(cat <<'EOF'
refactor(web): 类型化 api 客户端与 SSE 接入

端点签名复用后端领域类型，前后端契约由编译器保证；
错误信息提取集中到 ApiError/errText，替掉 6 处 json().catch 样板。
EOF
)"
```

---

### Task 5: `ui/` 与 `components/`

**边界规则**（Task 6 依赖它）：`index.html` 保留**静态骨架**（topbar、rail 容器、console 头、stream-view、
jump、composer、设备弹窗），JS 只接管其中的动态子树；只有**条件渲染的整块**（信使待确认面板、
交互选择器面板）在 Task 6 改成空 slot 由组件生成。`components/` 里的模块**禁止** import
`core/store` 与 `core/api` —— 只接收数据与回调。

设计第 7 节给 `promptDialog` 留了 `label` / `placeholder`，唯一调用点（新建会话）用不到，按 YAGNI 去掉。

**Files:**
- Create: `web/src/ui/dom.ts`
- Create: `web/src/ui/toast.ts`
- Create: `web/src/ui/dialog.ts`
- Create: `web/src/components/stream-card.ts`
- Create: `web/src/components/message-node.ts`
- Create: `web/src/components/confirm-box.ts`
- Create: `web/src/components/prompt-box.ts`
- Create: `web/src/components/composer.ts`
- Modify: `web/public/style.css`（在 `/* ---------- Responsive ---------- */` 之前插入 3 条规则）

**Interfaces:**
- Consumes: `TranscriptEvent` / `PendingAction`（`src/domain/types`）、`InteractivePrompt`（`src/domain/interactive-prompt`）
- Produces:
  - `dom.ts`：`interface ElProps { class?; text?; style?; onclick? }`、`el(tag, props?, ...children)`、`$<T>(id)`、`clear(node)`、`show(node, display?)`、`hide(node)`
  - `toast.ts`：`toast(msg: string): void`
  - `dialog.ts`：`confirmDialog({ title, body, okText?, danger? }): Promise<boolean>`、`promptDialog({ title }): Promise<string | null>`
  - `stream-card.ts`：`interface StreamCardProps`、`streamCard(p): HTMLElement`
  - `message-node.ts`：`bubble(role, label, text)`、`messageNodes(e): HTMLElement[]`
  - `confirm-box.ts`：`confirmBox(actions, onDecide): HTMLElement`
  - `prompt-box.ts`：`promptBox(p, onKeys): HTMLElement`
  - `composer.ts`：`mountComposer(onSend: (text: string) => void): { setPlaceholder(text: string): void }`

- [x] **Step 1: 写 `web/src/ui/dom.ts`**

```ts
export interface ElProps {
  class?: string;
  text?: string;
  style?: string;
  onclick?: () => void;
}

type Child = Node | string | null | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.style) node.setAttribute('style', props.style);
  if (props.onclick) node.onclick = props.onclick;
  for (const c of children) {
    if (!c) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// 静态骨架里的元素，缺失即是 index.html 与代码脱节 —— 早失败好过后面某处静默 null 崩。
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: #${id}`);
  return node as T;
}

export const clear = (node: Element): void => { node.replaceChildren(); };
export const show = (node: HTMLElement, display = 'block'): void => { node.style.display = display; };
export const hide = (node: HTMLElement): void => { node.style.display = 'none'; };
```

- [x] **Step 2: 写 `web/src/ui/toast.ts`**

```ts
import { $ } from './dom';

let timer: number | undefined;

export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('is-shown');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('is-shown'), 2600);
}
```

（`tsconfig.web.json` 的 `types: []` 让 `setTimeout` 返回 DOM 的 `number`，不是 `NodeJS.Timeout`。）

- [x] **Step 3: 写 `web/src/ui/dialog.ts`**

```ts
import { el } from './dom';

// 复用现有 .modal / .modal__card 样式。Esc 或点遮罩取消；promptDialog 中 Enter 提交。
// 不做焦点陷阱（YAGNI）。
function mount<T>(cancelValue: T, build: (settle: (v: T) => void) => HTMLElement[]): Promise<T> {
  return new Promise<T>(resolve => {
    const card = el('div', { class: 'modal__card' });
    const overlay = el('div', { class: 'modal is-open' }, card);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(cancelValue); };
    const settle = (v: T) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(v);
    };
    overlay.onclick = e => { if (e.target === overlay) settle(cancelValue); };
    document.addEventListener('keydown', onKey);
    card.append(...build(settle));
    document.body.appendChild(overlay);
  });
}

export function confirmDialog(o: {
  title: string;
  body: string;
  okText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return mount(false, settle => [
    el('div', { class: 'modal__title', text: o.title }),
    el('div', { class: 'modal__body', text: o.body }),
    el('div', { class: 'modal__row' },
      el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => settle(false) }),
      el('button', {
        class: o.danger ? 'btn btn--warn' : 'btn',
        text: o.okText ?? '确认',
        onclick: () => settle(true),
      }),
    ),
  ]);
}

export function promptDialog(o: { title: string }): Promise<string | null> {
  const input = el('input', { class: 'modal__input' });
  return mount<string | null>(null, settle => {
    const ok = () => { const v = input.value.trim(); settle(v ? v : null); };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    queueMicrotask(() => input.focus());
    return [
      el('div', { class: 'modal__title', text: o.title }),
      input,
      el('div', { class: 'modal__row' },
        el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => settle(null) }),
        el('button', { class: 'btn', text: '确定', onclick: ok }),
      ),
    ];
  });
}
```

- [x] **Step 4: 补 dialog 样式**

在 `web/public/style.css` 的 `/* ---------- Responsive ---------- */` 注释**之前**插入：

```css
/* ---------- Dialog (confirm / prompt) ---------- */
.modal__body { color: var(--muted); font-size: 13px; margin-bottom: 16px; white-space: pre-wrap; }
.modal__row { display: flex; justify-content: flex-end; gap: 8px; }
.modal__input { width: 100%; margin-bottom: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; color: var(--ink); font-family: var(--font-mono); font-size: 13px; }
```

- [x] **Step 5: 写 `web/src/components/stream-card.ts` 与 `message-node.ts`**

```ts
// web/src/components/stream-card.ts
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
```

```ts
// web/src/components/message-node.ts
import type { TranscriptEvent } from '../../../src/domain/types';
import { el } from '../ui/dom';

export function bubble(role: 'user' | 'agent' | 'system', label: string, text: string): HTMLElement {
  return el('div', { class: `msg msg--${role}` },
    el('div', { class: 'msg__bubble' },
      el('span', { class: 'msg__role', text: label }),
      el('span', { text }),
    ),
  );
}

function trace(variant: 'tool' | 'result', head: string, body: string, isError: boolean): HTMLElement {
  const box = el('div', { class: `trace trace--${variant} is-collapsed` + (isError ? ' is-error' : '') });
  const h = el('div', { class: 'trace__head', text: head + ' ▸' });
  h.onclick = () => {
    box.classList.toggle('is-collapsed');
    h.textContent = head + (box.classList.contains('is-collapsed') ? ' ▸' : ' ▾');
  };
  box.append(h, el('div', { class: 'trace__body', text: body }));
  return box;
}

const safeJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

// 一个转录事件 → 0..n 个节点（meta 不渲染）
export function messageNodes(e: TranscriptEvent): HTMLElement[] {
  if (e.kind === 'user') return [bubble('user', '你', e.text)];
  if (e.kind === 'assistant') {
    const nodes: HTMLElement[] = [];
    if (e.text && e.text.trim()) nodes.push(bubble('agent', 'Agent', e.text));
    for (const t of e.toolUses) nodes.push(trace('tool', `调用 ${t.name}`, safeJson(t.input), false));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('result', '工具结果', e.content, e.isError)];
  return [];
}
```

- [x] **Step 6: 写 `confirm-box.ts`、`prompt-box.ts`、`composer.ts`**

```ts
// web/src/components/confirm-box.ts
import type { PendingAction } from '../../../src/domain/types';
import { el } from '../ui/dom';

export function confirmBox(
  actions: PendingAction[],
  onDecide: (word: '确认' | '取消') => void,
): HTMLElement {
  return el('div', { class: 'confirm' },
    el('div', { class: 'confirm__title', text: '待确认操作' }),
    el('ul', { class: 'confirm__list' }, ...actions.map(a => el('li', { text: a.description }))),
    el('div', { class: 'confirm__row' },
      el('button', { class: 'btn btn--warn', text: '确认执行', onclick: () => onDecide('确认') }),
      el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => onDecide('取消') }),
    ),
  );
}
```

```ts
// web/src/components/prompt-box.ts
import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import { el } from '../ui/dom';

// 选项按钮只发数字键（已验证权限框数字即确认）；需要“移动后回车”的菜单用键盘行兜底。
const KEYPAD: [string, string][] = [['↑', 'Up'], ['↓', 'Down'], ['⏎ 确认', 'Enter'], ['Esc', 'Escape']];

export function promptBox(p: InteractivePrompt, onKeys: (keys: string[]) => void): HTMLElement {
  const question = p.question || (p.kind === 'permission' ? '会话请求授权确认' : '会话在等待你选择');
  return el('div', { class: 'confirm' },
    el('div', { class: 'confirm__title', text: '会话在等待选择' }),
    el('div', { class: 'confirm__hint mono', text: question }),
    el('div', { class: 'confirm__row' },
      ...p.options.map(o => el('button', {
        class: 'btn', text: `${o.key}. ${o.label}`, onclick: () => onKeys([o.key]),
      })),
    ),
    el('div', { class: 'confirm__row' },
      ...KEYPAD.map(([label, key]) => el('button', {
        class: 'btn btn--ghost', text: label, onclick: () => onKeys([key]),
      })),
    ),
  );
}
```

```ts
// web/src/components/composer.ts
import { $ } from '../ui/dom';

// composer 的 DOM 留在 index.html（布局的一部分），本模块只接管其行为。
export function mountComposer(onSend: (text: string) => void): { setPlaceholder(text: string): void } {
  const input = $<HTMLTextAreaElement>('composerInput');
  const button = $<HTMLButtonElement>('sendBtn');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  };
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow();
    onSend(text);
  };

  button.onclick = submit;
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  return { setPlaceholder: text => { input.placeholder = text; } };
}
```

- [x] **Step 7: 前端类型检查**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

预期：无输出。（这些模块此时还没有调用者 —— `main.ts` 在 Task 6 出现；tsc 仍会检查它们，浏览器仍跑旧 `app.js`，页面不变。）

- [x] **Step 8: 提交**

```bash
git add web/src/ui web/src/components web/public/style.css
git commit -m "$(cat <<'EOF'
refactor(web): 抽出 ui 原语与纯视图组件

el()/toast/dialog 与 5 个组件；组件只收数据与回调，不认识 store 与 api。
dialog 复用现有 .modal 样式，补 3 条规则。
EOF
)"
```

---

### Task 6: `views/` + `main.ts` + esbuild 接入（一次性换血）

本任务结束时旧 `app.js` 不再存在，页面跑 esbuild 产物。**`views/` 之间禁止互相 import** —— 跨视图影响
一律经 store 或由 `main.ts` 组合（如「设备」按钮：`mountTopbar(store, () => void devices.open())`）。

**Files:**
- Create: `web/src/views/login.ts`、`topbar.ts`、`rail.ts`、`transcript-view.ts`、`console-view.ts`、`devices.ts`
- Create: `web/src/main.ts`
- Modify: `web/public/index.html`（`type="module"`；confirm/prompt 两块换成空 slot）
- Modify: `package.json`（`esbuild` devDependency、`build:web`、`build`）
- Modify: `.gitignore`（忽略前端产物）
- Delete: `web/public/app.js`（旧的手写 JS，位置被产物接管）

**Interfaces:**
- Consumes: Task 2~5 的全部导出
- Produces：
  - `mountLogin(store, api): void`
  - `mountTopbar(store, onOpenDevices: () => void): void`
  - `mountRail(store, api, refresh: () => Promise<void>): void`
  - `mountTranscript(): TranscriptView`（`reset(events, emptyHint)` / `ingest(events)` / `accept(event)` / `pushLocal(text)` / `pushStatus(text)`）
  - `mountConsole(store, api, refresh): { onMessage(sessionId: string, event: TranscriptEvent): void }`
  - `mountDevices(store, api): { open(): Promise<void> }`

- [x] **Step 1: 写 `web/src/views/login.ts`**

```ts
import type { Api } from '../core/api';
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { loginRejected } from '../core/state';
import { $, hide, show } from '../ui/dom';

// 登录闸门：同时负责 #app 的 is-ready（等价今天 boot() 加、handleUnauth() 去）。
// auth === 'unknown'（启动探测中）保持登录卡可见 —— 与今天 CSS 默认态一致，探测慢也不会白屏。
export function mountLogin(store: Store<AppState>, api: Api): void {
  const box = $('login');
  const err = $('loginErr');
  const app = $('app');
  const token = $<HTMLInputElement>('token');

  const submit = async () => {
    try {
      await api.login(token.value);
      location.reload();          // 与今天一致：登录成功整页重载，重走启动探测
    } catch {
      store.update(loginRejected());
    }
  };

  $('loginBtn').onclick = () => void submit();
  token.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });

  store.subscribe(s => ({ auth: s.auth, notice: s.authNotice }), v => {
    err.textContent = v.notice;
    app.classList.toggle('is-ready', v.auth === 'in');
    if (v.auth === 'in') hide(box); else show(box, 'grid');
  });
}
```

- [x] **Step 2: 写 `web/src/views/topbar.ts`**

```ts
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { fleetCounts } from '../core/state';
import { $ } from '../ui/dom';

export function mountTopbar(store: Store<AppState>, onOpenDevices: () => void): void {
  const busy = $('cntBusy');
  const idle = $('cntIdle');
  const conn = $('conn');
  const connText = $('connText');

  $('devicesBtn').onclick = onOpenDevices;

  // fleetCounts 每次返回新对象，靠 store 的浅比较避免无谓重写 DOM。
  store.subscribe(fleetCounts, v => {
    busy.textContent = String(v.busy);
    idle.textContent = String(v.idle);
  });

  store.subscribe(s => s.conn, c => {
    conn.classList.toggle('is-live', c === 'live');
    connText.textContent = c === 'live' ? '实时' : c === 'down' ? '重连…' : '连接中…';
  });
}
```

- [x] **Step 3: 写 `web/src/views/rail.ts`**

```ts
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
```

- [x] **Step 4: 写 `web/src/views/transcript-view.ts`**

```ts
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
```

- [x] **Step 5: 写 `web/src/views/console-view.ts`**

```ts
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
```

定时器回调里不再重复判断 `isCurrent`：`openStream` / `closeConsole` 一定先 `stopTimers()`，
不存在过期定时器（今天那两处 `if (state.current && …)` 是防御同一件事）。

- [x] **Step 6: 写 `web/src/views/devices.ts`**

```ts
import type { Api, DeviceInfo } from '../core/api';
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { unauthorized } from '../core/state';
import { $, clear, el } from '../ui/dom';
import { toast } from '../ui/toast';

const relTime = (ts: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
};

export function mountDevices(store: Store<AppState>, api: Api): { open(): Promise<void> } {
  const modal = $('devicesModal');
  const list = $('devicesList');
  const close = () => modal.classList.remove('is-open');

  $('devicesClose').onclick = close;
  $('logoutBtn').onclick = () => void logout();
  modal.onclick = e => { if (e.target === modal) close(); };
  // 掉线即关弹窗（等价今天 handleUnauth 里那句 classList.remove）
  store.subscribe(s => s.auth, a => { if (a === 'out') close(); });

  const render = async () => {
    let items: DeviceInfo[];
    try { items = await api.devices(); } catch { return; }
    clear(list);
    if (items.length === 0) {
      list.appendChild(el('div', { class: 'rail__empty', text: '暂无设备。' }));
      return;
    }
    for (const d of items) {
      const meta = `最近活跃 ${relTime(d.lastSeenAt)}${d.userAgent ? ' · ' + d.userAgent.slice(0, 46) : ''}`;
      list.appendChild(el('div', { class: 'device' },
        el('div', { class: 'device__name', text: d.name },
          d.current ? el('span', { class: 'cur', text: '本机' }) : null),
        el('div', { class: 'device__meta', text: meta }),
        el('button', {
          class: 'btn btn--ghost device__revoke',
          text: d.current ? '退出' : '撤销',
          onclick: () => void revoke(d.id, d.current),
        }),
      ));
    }
  };

  const revoke = async (id: string, isCurrent: boolean) => {
    try { await api.revokeDevice(id); } catch { toast('撤销失败'); return; }
    if (isCurrent) { toast('已退出本设备'); store.update(unauthorized()); }
    else { toast('已撤销'); await render(); }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* 忽略：本地照常登出 */ }
    store.update(unauthorized());
  };

  return { open: async () => { modal.classList.add('is-open'); await render(); } };
}
```

- [x] **Step 7: 写 `web/src/main.ts`（组合根）**

```ts
import { createApi } from './core/api';
import {
  MESSENGER, agentEnabledSet, authProbed, connChanged, initialState,
  sessionRemoved, sessionUpserted, sessionsReplaced, streamSelected, unauthorized,
} from './core/state';
import { connectStream } from './core/sse';
import { createStore } from './core/store';
import { mountConsole } from './views/console-view';
import { mountDevices } from './views/devices';
import { mountLogin } from './views/login';
import { mountRail } from './views/rail';
import { mountTopbar } from './views/topbar';

const store = createStore(initialState);
const api = createApi(() => store.update(unauthorized()));

const refresh = async (): Promise<void> => {
  try { store.update(sessionsReplaced(await api.listSessions())); }
  catch { /* 401 已由 api 上报；其它失败等下一次 SSE 快照 */ }
};

mountLogin(store, api);
const devices = mountDevices(store, api);
mountTopbar(store, () => void devices.open());
mountRail(store, api, refresh);
const console_ = mountConsole(store, api, refresh);

async function boot(): Promise<void> {
  let enabled = false;
  try { enabled = (await api.agentEnabled()).enabled; }
  catch { store.update(authProbed(false)); return; }   // 未登录/服务不可达：停在登录页
  store.update(agentEnabledSet(enabled));
  store.update(authProbed(true));
  await refresh();
  connectStream({
    onStatus(p) {
      if (Array.isArray(p)) store.update(sessionsReplaced(p));
      else if (p.type === 'session.updated') store.update(sessionUpserted(p.session));
      else store.update(sessionRemoved(p.sessionId));
    },
    onMessage: (sessionId, event) => console_.onMessage(sessionId, event),
    onConn: c => store.update(connChanged(c)),
  });
  if (enabled) store.update(streamSelected(MESSENGER));
}

void boot();
```

- [x] **Step 8: 改 `web/public/index.html`**

把两块条件渲染的面板换成空 slot（第 68~82 行整段替换）：

```html
          <div id="confirmSlot"></div>
          <div id="promptSlot"></div>
```

并把最后的脚本标签改为 module：

```html
  <script type="module" src="/app.js"></script>
```

其余一律不动（`#confirmBox` / `#confirmList` / `#confirmYes` / `#confirmNo` / `#promptBox` /
`#promptQuestion` / `#promptOptions` / `#promptKeys` 这些 id 从此不再被引用）。

- [x] **Step 9: 装 esbuild、接构建脚本、忽略产物、删除旧 `app.js`**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node /Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js install -D esbuild
```

`package.json` 的 `scripts` 改为（`typecheck` 已在 Task 2 改好）：

```json
    "build": "tsc -p tsconfig.json && npm run build:web",
    "build:web": "esbuild web/src/main.ts --bundle --format=esm --target=es2022 --minify --sourcemap --outfile=web/public/app.js",
```

`.gitignore` 末尾追加：

```
web/public/app.js
web/public/app.js.map
```

删掉旧的手写 JS（它的位置从此由产物接管）：

```bash
git rm web/public/app.js
```

- [x] **Step 10: 构建**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node /Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js run build:web
```

预期：tsc 无输出；esbuild 打印一行产物大小（数十 KB）。`git status` 里 `web/public/app.js` 不出现（已忽略）。

- [x] **Step 11: 浏览器验证（关键路径）**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/tsx/dist/cli.mjs src/cli.ts serve
```

打开 `http://127.0.0.1:8788`，逐条确认（验证完 Ctrl-C 停掉）：

1. 未登录时显示登录卡，**提示区为空**（行为差异第 4 条）；输入错误令牌 → 「令牌无效，请重试。」；正确令牌 → 整页重载进入应用。
2. 顶栏：运行中/空闲计数与侧栏一致；连接状态显示「实时」。
3. 侧栏：信使卡片置顶且高亮；会话卡片名称/路径/标签（可控/外部/离线）与重构前一致；点击切换时高亮跟随。
4. 信使：发消息 → 立即出现「你」气泡，随后回复出现且**不重复**；触发一次变更操作 → 出现「待确认操作」面板 → 「确认执行」后面板消失并出现「系统」气泡。
5. 会话：选一个受控会话 → 头部显示「运行中 · /path」并随 SSE 更新；发消息 toast「已发送到会话」；未托管会话的 composer 占位文案与「接管」按钮正确。
6. 交互选择器：让受控会话停在选择框 → 面板出现，点数字选项 → toast「已发送: 2」，约 0.6s 后面板收起。
7. 设备弹窗：打开、列表正确、点遮罩/`×` 关闭；「撤销」其它设备后列表刷新。
8. dialog：`+ 新建会话` → 输入框弹窗，Esc 取消、**点遮罩也取消**、Enter 提交；「结束会话」→ 危险色确认框；对运行中的外部会话点「接管」→ 确认框。三处的标题与正文文案与旧原生框逐字一致；顺带确认**标题与正文/输入框之间有间距**（`.modal__title` 本身无下边距，旧设备弹窗是靠 `.modal__head` 撑开的）。
   另：助手消息里的工具调用 trace 点击 `▸/▾` 能折叠展开。
9. 转录窗口化：打开一个消息很多的会话 → 出现「载入更早」，点击后向上补齐且视口位置不跳。
10. 三个曾被 400 拦掉的动作（行为差异第 5 条）现在要看**结果**而非只看 toast：
    - 「结束会话」确认后 → toast「已结束会话」（不是 `undefined`），卡片从侧栏消失，`tmux list-windows` 里该窗口没了。
    - 设备弹窗里「撤销」一个**非当前**设备 → toast「已撤销」，列表刷新后该设备消失。
    - 「退出登录」→ 回到登录卡；**刷新页面仍停在登录卡**（旧版会直接又登录进去），且该设备已从设备列表移除。
      验完需要重新用 `cli.ts token` 取令牌登录。

- [x] **Step 12: 提交**

```bash
git add -A web package.json package-lock.json .gitignore
git commit -m "$(cat <<'EOF'
refactor(web): 视图层落地，main.ts 收敛为组合根，改由 esbuild 打包

app.js 599 行单文件下线：views 各自订阅 store 切片，跨视图影响一律经 store，
renderRail 的 5 处手工调用与全局 state 一并消失。三处原生 confirm/prompt 换成项目 dialog。
EOF
)"
```

---

### Task 7: 全量验证与部署

设计 §10 第 7 步。**本 Task 不写业务代码**：若验证暴露缺陷，回到对应 Task 修复并追加一次提交，
然后从本 Task 的 Step 2 重跑。这是唯一允许触碰部署实例 `/Users/l/apps/lifestream` 的 Task。

**Files:**
- 修改：`docs/superpowers/specs/2026-07-29-web-frontend-refactor-design.md:3`（Status 改为 Implemented）
- 修改：`docs/superpowers/plans/2026-07-29-web-frontend-refactor.md`（勾选完成的复选框）
- 其余零改动

**Interfaces:**
- Consumes：Task 1–6 的全部产物（`web/public/` 静态根、`tsconfig.web.json`、`web/src/**`、
  `build` / `build:web` / `typecheck` 三个 npm 脚本、`test/unit/web-{store,state,timeline}.test.ts`）
- Produces：无（终点 Task）

- [x] **Step 1: 确认开发实例已停，端口干净**

```bash
lsof -ti tcp:8788
```

预期：**无输出**。若有 pid，说明上一个 Task 的 `serve` 没停：`kill <pid>` 后重跑本步。
（开发实例与部署实例共享 `~/.lifestream` 与 tmux socket，不能同时长跑。）

- [x] **Step 2: 两个 tsc + 全量单测**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```

预期：两个 tsc 均无输出；vitest 全绿，且末尾统计里的文件数比重构前多 3
（`web-store` / `web-state` / `web-timeline`）。任一红灯都不许进入下一步。

- [x] **Step 3: 从零干净构建**

```bash
rm -f web/public/app.js web/public/app.js.map
rm -rf dist
/Users/l/.nvm/versions/node/v24.18.0/bin/node /Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js run build
ls -l dist/index.js web/public/app.js web/public/app.js.map
git status --short
```

预期：`build` 先跑后端 tsc 再跑 esbuild，三个文件都存在；`git status --short` 里
**不出现** `web/public/app.js` 与 `.map`（Task 6 已忽略），也不出现 `dist/`。
这一步证明「产物被 gitignore 后仍能一条命令重建」——部署流程依赖它。

- [x] **Step 4: 结构约束体检（设计 §5 的两条硬规则）**

四条命令，**每条都必须无输出**：

```bash
grep -rn "core/store\|core/api" web/src/components/            # 组件不认识应用状态
grep -rn "from '\./" web/src/views/ | grep -v transcript-view  # 视图之间不互相 import
grep -rn "document\|window" web/src/core/state.ts web/src/transcript/timeline.ts  # 纯逻辑无 DOM
grep -rn "innerHTML\|[^.a-zA-Z]confirm(\|[^.a-zA-Z]prompt(" web/src/  # 无字符串拼 DOM、无原生弹窗
```

说明：第 2 条排除 `transcript-view`，因为 `console-view` 组合它是设计允许的唯一视图内依赖
（`transcript-view` 独占消息流 DOM，不订阅 store）。第 4 条中 `confirmDialog` / `promptDialog`
带前缀，不会被 `[^.a-zA-Z]confirm(` 命中。

- [x] **Step 5: 文案零丢失核对（「重构前后表现一致」的机械化验收）**

把重构前 `app.js` 里所有含中文的单引号字面量抽出来，逐条在打包产物里找：

```bash
git show 196c367:web/app.js | grep -o "'[^']*[一-龥][^']*'" | sort -u > /tmp/ls-copy-old.txt
wc -l < /tmp/ls-copy-old.txt
while IFS= read -r s; do t=${s#\'}; t=${t%\'}; \
  grep -qF -- "$t" web/public/app.js || echo "MISSING: $t"; done < /tmp/ls-copy-old.txt
```

（`196c367` 是重构前最后一个含手写 `web/app.js` 的提交。）

预期：`MISSING` 行只允许是「行为差异清单」里已登记的那几条（如登录卡首屏提示相关），
其余每一条文案都必须在产物中命中。出现未登记的 `MISSING` 就是回归，回到对应 Task 补回原文案。

- [x] **Step 6: 起开发实例，取登录令牌**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/tsx/dist/cli.mjs src/cli.ts token
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/tsx/dist/cli.mjs src/cli.ts serve
```

第一条打印令牌（记下来，下一步要填）；第二条前台占用终端，用后台方式跑或另开一个 shell。
预期日志含 `listening` 与 `8788`。

- [x] **Step 7: Playwright 走关键路径**

依次调用（每步的预期都要真的核对，不是走过场）：

1. `browser_navigate` → `http://127.0.0.1:8788`
2. `browser_snapshot`：登录卡可见，**提示区为空**（行为差异第 4 条）
3. `browser_type` 令牌输入框填**错误**令牌并提交 → `browser_snapshot`：「令牌无效，请重试。」
4. `browser_type` 填正确令牌并提交 → `browser_snapshot`：整页重载后进入应用，顶栏出现计数与「实时」
5. `browser_snapshot`：侧栏信使卡置顶并高亮；会话卡的名称/路径/标签（可控 / 外部 / 离线）与重构前一致
6. 在信使流 `browser_type` 一句话并提交 → `browser_snapshot`：**只有一个**「你」气泡（2026-07-28 缺陷的回归点），随后出现回复
7. `browser_click` 一个受控会话 → `browser_snapshot`：头部「运行中 · /path」、composer 可用；若该会话正停在选择框，`#promptSlot` 面板出现，点一个数字选项 → toast「已发送: …」，约 0.6s 后面板收起
8. `browser_click` `+ 新建会话` → `browser_snapshot`：项目 dialog（不是浏览器原生框）；`browser_press_key` `Escape` → 弹窗关闭且未创建会话
9. `browser_click` 设备入口 → `browser_snapshot`：设备列表；点遮罩关闭
10. 打开一个消息很多的会话 → `browser_snapshot`：出现「载入更早」，`browser_click` 后向上补齐，视口位置不跳
11. `browser_console_messages` with `level: "error"` → **必须为空**（打包产物的 sourcemap 已生成，若有报错可直接定位到 TS 源码行）

任一步不符预期即停下修复，不要继续往部署走。

- [x] **Step 8: 停开发实例**

```bash
lsof -ti tcp:8788 | xargs -r kill
lsof -ti tcp:8788
```

预期：第二条无输出。**必须停掉**——部署实例马上要接管同一份 `~/.lifestream` 与 tmux socket。

- [x] **Step 9: 部署（先征求用户同意）**

部署会 reload 正在服务的守护进程（8787），属于影响运行中系统的动作：**先向用户确认再执行**。
确认后：

```bash
cd /Users/l/apps/lifestream
git pull
/Users/l/.nvm/versions/node/v24.18.0/bin/node /Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js install
/Users/l/.nvm/versions/node/v24.18.0/bin/node /Users/l/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js run build
ls -l web/public/app.js
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js reload
```

要点：
- 部署实例的 `origin` 就是 `/Users/l/dev-ai/lifestream`（本地路径），`git pull` 不需要先推 GitHub。
- `npm install` 这次是必须的：`esbuild` 是新增 devDependency，缺了 `build` 会失败。
- `app.js` 不在 git 里，**必须靠 `build` 生成**；`ls -l` 就是为了确认它真的存在（这是本次部署最容易漏的一步）。
- `reload` 打印「已通知 daemon(pid=…) 优雅重启 serve。」。若报 daemon 未运行，说明部署实例本来就没在跑，
  按原有方式 `node dist/cli.js daemon` 起来。

- [x] **Step 10: 部署实例冒烟**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/app.js
```

预期：两条都是 `200`（第二条证明新的静态根 `web/public` 生效）。再用浏览器打开
`http://127.0.0.1:8787`，登录后确认侧栏与信使流正常——部署实例上只需这一遍粗查，
细的路径已在 Step 7 覆盖。

- [x] **Step 11: 收尾提交**

把设计文档的状态改为已实施（`docs/superpowers/specs/2026-07-29-web-frontend-refactor-design.md:3`）：

```markdown
- Status: Implemented (2026-07-29)
```

并把本计划里已完成的复选框逐个勾上，然后：

```bash
cd /Users/l/dev-ai/lifestream
git add docs
git commit -m "$(cat <<'EOF'
docs(web): 前端重构完成，标记设计与计划为已实施

全量验证：两个 tsc、vitest、干净构建、结构约束体检、文案零丢失核对、
Playwright 关键路径，部署实例 reload 后冒烟通过。
EOF
)"
```
