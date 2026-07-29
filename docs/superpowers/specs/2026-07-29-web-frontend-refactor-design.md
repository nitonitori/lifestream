# DESIGN: Web 前端重构（模块化 + TS 化）

- Status: Approved (设计已确认，待实施)
- Date: 2026-07-29
- Related: [SPEC](./2026-07-27-lifestream-spec.md) · [RFC](./2026-07-27-lifestream-rfc.md)

## 1. 背景与问题

`web/` 目前是三个文件：`app.js` 599 行、`style.css` 239 行、`index.html` 119 行。`app.js` 以
`<script src="/app.js">` 非模块方式加载，全部代码位于单一全局作用域，一个文件承担 11 类职责：

认证与登录、`fetch` 封装、全局 `state`、侧栏渲染、会话切换、消息渲染、窗口化分页、滚动策略、
composer 与两个确认面板、SSE 接入、设备弹窗，以及文件末尾集中的 DOM 事件接线。

由此产生的具体问题：

1. **耦合即全局**。函数之间直接调用，共同读写同一个可变 `state` 与 `$('id')`。`renderRail()`
   在 5 处被手动调用；漏掉一处就是一个渲染不同步的 bug。
2. **逻辑与 DOM 缠绕，无法测试**。事件去重、乐观气泡回收、窗口化分页这些真正容易出错的逻辑
   与 `document` 操作写在一起，全项目前端测试为零。2026-07-28 修复的「发送消息渲染两次」缺陷
   正属于这类逻辑，目前没有任何回归保护。
3. **无类型**。前端手工重复后端的数据形状（`SessionSummary`、`TranscriptEvent`、`PendingAction`），
   后端改字段前端不会报错，只会在运行时静默出错。
4. **重复样板**。`const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '…')`
   这段出现 6 次。
5. **原始 SPEC 的意图未落地**。SPEC 第 44 行写的是「web/ 前端(静态,构建到 public/)」，实际从未建立
   构建步骤。

## 2. 目标与非目标

**目标**：抽出公用组件；模块高内聚、依赖低耦合且无环；结构可按职责定位；关键逻辑可单测；
前后端类型契约由编译器保证。

**非目标**：
- 不拆分 CSS。239 行已按区块 + BEM 组织清楚，拆分只增加一层间接。仅为新增的 dialog 组件补少量样式。
- 不引入任何**运行时**依赖，不引入框架。
- 不改后端 REST API 与 SSE 协议。
- 除第 7 节列出的一处，不改变任何可见行为。

## 3. 技术决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | 前端 TS 化 | 复用 `src/domain/types.ts`，前后端契约编译期校验 |
| 构建 | esbuild 打包单文件 | 单一无子依赖的 devDependency，毫秒级；`tsc` 只做类型检查，产物交给 esbuild（标准分工） |
| 状态 | 小型 store + 订阅 | 599 行规模不需要框架；纯 reducer 可单测；订阅取代手动调用渲染 |
| 测试 | 纯逻辑单测，零新依赖 | 能被纯函数测到的部分，就是真正与 DOM 解耦的部分——测试即架构约束 |
| CSS | 不动 | 见非目标 |

## 4. 目录结构

```
web/
├── src/                        # TS 源码，不被 HTTP 服务
│  ├── main.ts                  # 组合根：建 store、装配视图、接线、启动（~40 行）
│  ├── core/
│  │  ├── api.ts                # 类型化端点 + ApiError；401 经注入回调上报
│  │  ├── store.ts              # createStore：getState / update / subscribe（~40 行，通用）
│  │  ├── state.ts              # AppState 形状 + 纯 reducer + 纯 selector（DOM-free）
│  │  └── sse.ts                # EventSource → onStatus / onMessage / onConn
│  ├── transcript/
│  │  └── timeline.ts           # 去重、乐观气泡回收、窗口化分页（纯逻辑，DOM-free）
│  ├── ui/
│  │  ├── dom.ts                # el(tag, props, ...children) / clear / show / hide
│  │  ├── toast.ts              # 瞬时提示
│  │  └── dialog.ts             # confirmDialog / promptDialog → Promise
│  ├── components/              # 纯视图函数：(数据 + 回调) → DOM 节点
│  │  ├── stream-card.ts
│  │  ├── message-node.ts       # bubble / trace
│  │  ├── confirm-box.ts        # 信使待确认动作面板
│  │  ├── prompt-box.ts         # 受控会话交互选择器面板
│  │  └── composer.ts
│  └── views/                   # 各自独占一块 DOM 区域，订阅 store 切片
│     ├── login.ts
│     ├── topbar.ts             # fleet 计数 + 连接状态 + 设备入口
│     ├── rail.ts
│     ├── transcript-view.ts    # 消息流 + 滚动策略 + 窗口化
│     ├── console-view.ts       # 头部 + 编排 confirm/prompt/composer/transcript
│     └── devices.ts            # 设备弹窗
└── public/                     # @fastify/static 的 root
   ├── index.html               # <script type="module" src="/app.js">
   ├── style.css
   ├── app.js                   # esbuild 产物（gitignore）
   └── app.js.map               # 同上
```

## 5. 架构：单向数据流 + 三层无环依赖

```
api / sse  ──update(reducer)──▶  store  ──notify──▶  views  ──▶ DOM
     ▲                                                 │
     └──────────────── 用户操作 ────────────────────────┘
```

依赖方向严格单向：`main → views → components → ui / core`。两条硬性规则，是低耦合的实际抓手：

1. **`components/` 禁止 import `core/store` 与 `core/api`**。组件只接收数据与回调，因此可以脱离
   应用状态被理解、复用与替换。
2. **`views/` 之间禁止互相 import**。跨视图影响一律经 store。这直接消除今天 `renderRail()`
   被 5 处手动调用的问题，也从结构上排除循环 import。

### 5.1 core/store.ts

约 40 行的通用可观察存储，不含业务：

```ts
export interface Store<S> {
  getState(): S;
  update(reducer: (s: S) => S): void;
  subscribe<T>(selector: (s: S) => T, cb: (v: T) => void): () => void;
}
export function createStore<S>(initial: S): Store<S>;
```

`update` 后同步遍历订阅者，**浅比较** selector 结果，仅在变化时回调，避免无谓重渲染。

### 5.2 core/state.ts（纯，可单测）

```ts
export type StreamRef = { kind: 'messenger' } | { kind: 'session'; id: string };

export interface AppState {
  auth: 'unknown' | 'in' | 'out';
  agentEnabled: boolean;
  sessions: Map<string, SessionSummary>;   // reducer 返回新 Map，不原地改
  current: StreamRef | null;
  conn: 'connecting' | 'live' | 'down';
  pending: PendingAction[];                // 信使待确认动作
}
```

reducer（`(s: AppState) => AppState`，均为纯函数）：`sessionsReplaced(list)`、`sessionUpserted(s)`、
`sessionRemoved(id)`、`streamSelected(ref)`、`streamCleared()`、`connChanged(c)`、`pendingSet(list)`、
`authChanged(a)`、`agentEnabledSet(b)`。

selector（纯）：`fleetCounts(s)`、`sessionOf(s, id)`、`statusLabel(session)`、`vitalOf(session)`、
`tagOf(session)`、`isCurrent(s, ref)`。

`fleetCounts` 保持现有语义：仅统计 `live` 会话，`status` 为 `unknown` 时既不计入忙也不计入闲。

### 5.3 transcript/timeline.ts（纯，可单测）

消息流的逻辑内核。**返回「该渲染什么」的指令，不接触 DOM**：

```ts
export const MAX_RENDER = 300;   // DOM 中最多渲染的消息数
export const CHUNK = 200;        // 「载入更早」每次追加

export interface Timeline {
  reset(events: TranscriptEvent[]): { render: TranscriptEvent[]; hasEarlier: boolean };
  ingest(events: TranscriptEvent[]): { append: TranscriptEvent[]; adopted: number };
  accept(event: TranscriptEvent): { append: boolean };      // 单条（SSE）
  earlier(): { prepend: TranscriptEvent[]; hasEarlier: boolean };
  noteLocal(text: string): void;                            // 登记乐观气泡
}
```

三条不变量（即单测断言）：

- `uuid` 已渲染过的事件不会再次进入 `append`。
- `noteLocal(text)` 之后，首个同文本的 `kind: 'user'` 事件被**回收**：不产生新节点，但其 `uuid`
  被登记为已渲染（这是 2026-07-28 缺陷的修复逻辑，此处获得回归保护）。
- `reset` 清空乐观气泡登记（DOM 一并作废，转录已含用户消息）。

### 5.4 core/api.ts

类型化端点函数，返回解析后的数据或抛 `ApiError`：

```ts
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string); }
```

端点：`login(token)`、`logout()`、`agentEnabled()`、`agentMessages()`、`agentPending()`、
`agentMessage(text)`、`listSessions()`、`sessionMessages(id)`、`sendSessionMessage(id, text)`、
`sessionPrompt(id)`、`sendKeys(id, keys)`、`createSession(cwd)`、`adoptSession(id, force)`、
`archiveSession(id)`、`devices()`、`revokeDevice(id)`。

`ApiError.message` 取服务端 `{ error: { code, message } }` 的 `message`，因此视图侧
`catch (e) { toast(e.message) }` 即可——6 处重复样板塌缩为一处。401 通过构造时注入的
`onUnauthorized` 回调上报，`api.ts` 不认识任何视图。

### 5.5 core/sse.ts

```ts
// status 通道只承载全量快照与会话增删，message 通道承载转录事件
type StatusPayload = SessionSummary[] | Extract<PlaneEvent, { type: 'session.updated' | 'session.removed' }>;

export function connectStream(h: {
  onStatus(p: StatusPayload): void;
  onMessage(sessionId: string, event: TranscriptEvent): void;
  onConn(c: 'live' | 'down'): void;
}): () => void;
```

`main.ts` 把 `onStatus` 接到相应 reducer、`onMessage` 接到 transcript 视图、`onConn` 接到
`connChanged`。SSE 细节不外泄。

### 5.6 消息流状态的归属

`events` / 已渲染 `uuid` 集合 / 窗口起点 / 乐观气泡登记 **不进全局 store**，封装在
`transcript-view` 内部（其纯计算部分位于 `timeline.ts`）。理由：只有一个消费者；每条 SSE 事件都在
变化；数组可达数千条。放进全局 store 会让 reducer 变贵，并强迫其它订阅者处理与自己无关的通知。
可测性不受影响——需要被测的计算已在 `timeline.ts`。

## 6. 构建与服务

- `tsconfig.web.json`：`strict`、`target: ES2022`、`module: ESNext`、`moduleResolution: Bundler`、
  `lib: [ES2022, DOM, DOM.Iterable]`、`noEmit: true`、`include: ["web/src"]`。仅类型检查。
- `package.json`
  - devDependencies 增 `esbuild`。
  - `"build:web": "esbuild web/src/main.ts --bundle --format=esm --target=es2022 --minify --sourcemap --outfile=web/public/app.js"`
  - `"build": "tsc -p tsconfig.json && npm run build:web"`
  - `"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.web.json"`
- `src/index.ts`：`webRoot` 由 `'../web'` 改为 `'../web/public'`。dev（`tsx src/`）与部署（`dist/`）
  仍解析到同一目录，沿用现有机制。
- `test/component/static.test.ts`：`webRoot` 同步改为 `'../../web/public'`。
- `.gitignore` 增 `web/public/app.js`、`web/public/app.js.map`。
- 部署流程：`git pull` → 安装依赖（仅首次，装 esbuild）→ `build`（后端 tsc + 前端打包）→
  `lifestream reload`。注意本机 `npm` / `npx` / `node` 裸命令会触发 nvm 故障，必须用绝对路径
  `/Users/l/.nvm/versions/node/v24.18.0/bin/node`，npm 经
  `…/lib/node_modules/npm/bin/npm-cli.js` 调用。

## 7. 唯一的可见变化

`adopt` / `archiveSession` / `newSession` 三处原生 `confirm()` / `prompt()` 替换为
`ui/dialog.ts`：

```ts
confirmDialog(o: { title: string; body: string; okText?: string; danger?: boolean }): Promise<boolean>;
promptDialog(o: { title: string; label?: string; placeholder?: string }): Promise<string | null>;
```

复用现有 `.modal` / `.modal__card` 样式，补少量 CSS。交互：Esc 或点击遮罩取消，
`promptDialog` 中 Enter 提交。不做焦点陷阱（YAGNI）。

其余行为逐字保持不变。**验收标准即：重构前后页面表现一致。**

## 8. 错误处理

| 来源 | 处理 |
| --- | --- |
| REST 4xx/5xx | 视图 `catch (ApiError)` → `toast(e.message)` |
| 任意 401 | `api` 的 `onUnauthorized` → `authChanged('out')` → 登录视图接管、关闭弹窗（等价今天的 `handleUnauth`） |
| SSE 断开 | `connChanged('down')` → topbar 自行渲染「重连…」 |
| `detectPrompt` 无提示或失败 | prompt 面板隐藏（与今天一致，静默） |

## 9. 测试

新增两个文件，零新增依赖（vitest 直接执行 TS）：

- `test/unit/web-state.test.ts` — reducer 的会话替换/增删、当前选中、连接与待确认状态；selector 的
  `fleetCounts`（非 live 与 `unknown` 状态不计入）、`statusLabel`、`vitalOf`、`tagOf`。
- `test/unit/web-timeline.test.ts` — 第 5.3 节三条不变量，加窗口起点计算与 `earlier()` 的
  `CHUNK` 分页与 `hasEarlier` 边界。

两个被测模块不得引用 `document` / `window`，此约束由 review 与运行环境（node）共同保证。

## 10. 实施顺序

每一步结束都是可运行、可浏览器验证的状态：

1. 建 `web/public/`（移入 `index.html`、`style.css`）、`tsconfig.web.json`、esbuild 脚本、
   `webRoot` 与静态测试各改一行；`app.js` 原样搬为 `web/src/main.ts` 并加最少标注通过 strict。
   → 表现与今天完全一致。
2. 抽 `core/`（api / store / state / sse）+ `web-state.test.ts`。
3. 抽 `transcript/timeline.ts` + `web-timeline.test.ts`。
4. 抽 `ui/` 与 `components/`。
5. 抽 `views/`，`main.ts` 收敛为组合根。
6. 三处原生弹窗换 `dialog`。
7. 全量验证：两个 tsc、vitest、`build:web`，Playwright 走关键路径（登录 → 侧栏 → 信使发送与确认流
   → 会话选择 → 交互选择器面板 → 设备弹窗 → 新建/接管/结束的 dialog），再 build + 部署 reload。

## 11. 风险

| 风险 | 缓解 |
| --- | --- |
| 一次性大改前端导致回归 | 分 7 步，每步浏览器验证；关键逻辑先有单测 |
| 部署目录缺 esbuild 导致构建失败 | 部署时先 `npm install`；`build` 脚本失败即中止，不会用旧产物静默上线 |
| 产物被 gitignore 后忘记构建 | `build` 脚本串联后端与前端构建，部署流程只需记住一条命令 |
| node 相关命令踩 nvm 陷阱 | 一律用绝对路径 `/Users/l/.nvm/versions/node/v24.18.0/bin/node` |
