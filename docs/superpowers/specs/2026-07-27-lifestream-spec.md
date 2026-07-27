# SPEC: Lifestream 技术规格

- Status: Draft (待评审)
- Date: 2026-07-27
- Related: [RFC](./2026-07-27-lifestream-rfc.md) · [STORY](./2026-07-27-lifestream-story.md)

本规格定义模块结构、领域类型、适配器接口、ControlPlane API、transcript 解析、REST+SSE API、MCP 工具 schema、配置、鉴权与错误处理。类型以 TypeScript 表达。

## 1. 目录结构

```
lifestream/
├── package.json            # type: module, scripts: build/test/dev/start
├── tsconfig.json
├── vitest.config.ts
├── lifestream.config.json  # 运行配置（gitignore；提供 .example）
├── src/
│  ├── domain/
│  │  ├── types.ts               # 领域类型
│  │  ├── transcript-parser.ts   # JSONL → TranscriptEvent
│  │  ├── session-discovery.ts   # sessions/*.json → LiveSession
│  │  └── control-plane.ts       # 核心编排
│  ├── adapters/
│  │  ├── tmux.ts                # TmuxAdapter 真实现
│  │  ├── claude-home.ts         # ClaudeHomeAdapter 真实现(FS/watch)
│  │  ├── managed-registry.ts    # 受控会话持久化
│  │  ├── clock.ts               # 系统时钟
│  │  ├── im-dingtalk.ts         # ImAdapter 钉钉真实现(封装 dws)
│  │  └── agent-runner.ts        # AgentRunner 真实现(headless claude)
│  ├── ports/                    # 适配器接口(纯类型)
│  │  └── index.ts
│  ├── server/
│  │  ├── http.ts                # Fastify 装配
│  │  ├── auth.ts                # 鉴权中间件
│  │  ├── routes.ts              # REST + SSE
│  │  └── sse.ts                 # SSE 广播
│  ├── mcp/
│  │  └── control-mcp.ts         # MCP stdio server
│  ├── im/
│  │  └── linker.ts              # 轮询+白名单+路由
│  ├── config.ts                 # 配置加载与校验
│  ├── cli.ts                    # `lifestream` 命令入口
│  └── index.ts                  # 组合根(wire adapters)
├── web/                         # 前端(静态,构建到 public/)
│  └── ...
├── test/
│  ├── fakes/                    # FakeTmux/FakeClaudeHome/FakeIm/FakeClock...
│  ├── fixtures/                 # 真实 JSONL/sessions 样本(脱敏)
│  ├── unit/  ├── component/  └── integration/
└── docs/superpowers/specs/      # 本目录
```

## 2. 领域类型 (`src/domain/types.ts`)

```ts
export type SessionStatus = 'busy' | 'idle' | 'unknown';
export type SessionOrigin = 'managed' | 'external' | 'adopted';

// 来自 ~/.claude/sessions/<pid>.json
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status: SessionStatus;
  version?: string;
  kind?: string;          // interactive 等
  startedAt?: number;
  updatedAt?: number;
}

export interface SessionSummary {
  sessionId: string;
  name?: string;
  cwd: string;
  status: SessionStatus;
  origin: SessionOrigin;
  live: boolean;          // 是否有存活进程
  controllable: boolean;  // 是否受托管(tmux 内)可发消息
  tmuxSession?: string;
  pid?: number;
  lastActivity?: number;  // transcript 最新事件时间
}

export interface SessionDetail extends SessionSummary {
  transcriptPath?: string;
  messageCount: number;
}

export type TranscriptEvent =
  | { kind: 'user';        uuid: string; ts: number; text: string; raw: unknown }
  | { kind: 'assistant';   uuid: string; ts: number; text: string;
      toolUses: { id: string; name: string; input: unknown }[]; raw: unknown }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string;
      content: string; isError: boolean; raw: unknown }
  | { kind: 'meta';        uuid?: string; ts?: number; type: string; raw: unknown };

// ControlPlane 事件总线载荷
export type PlaneEvent =
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'message'; sessionId: string; event: TranscriptEvent };

// IM 变更类操作的暂存动作（human-in-the-loop 确认）
export type PendingActionKind = 'send' | 'create' | 'adopt';
export interface PendingAction {
  id: string;
  conversationId: string;      // 归属的 IM 会话
  kind: PendingActionKind;
  params: Record<string, unknown>; // 如 {sessionId,text} / {cwd,name,...} / {sessionId,force}
  description: string;         // 发给用户确认的人类可读摘要
  createdAt: number;
}
```

## 3. 适配器接口 (`src/ports/index.ts`)

```ts
export interface Clock { now(): number; }

export interface TmuxSessionInfo { name: string; windows: number; created: number; }
export interface TmuxAdapter {
  listSessions(): Promise<TmuxSessionInfo[]>;
  hasSession(name: string): Promise<boolean>;
  newSession(name: string, cwd: string, command: string[]): Promise<void>;
  sendText(name: string, text: string): Promise<void>;   // 多行安全: load-buffer -> paste-buffer -> Enter
  capturePane(name: string): Promise<string>;
  killSession(name: string): Promise<void>;
}

export interface ClaudeHomeAdapter {
  readLiveSessions(): Promise<LiveSession[]>;             // 解析 sessions/*.json
  locateTranscript(sessionId: string): Promise<string | null>; // 扫描 projects/*/
  readTranscript(path: string): Promise<string[]>;       // 全量行
  readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }>;
  watchProjects(cb: (changedPath: string) => void): () => void; // 返回 unwatch
}

export interface ManagedRegistry {
  list(): Promise<ManagedEntry[]>;
  get(sessionId: string): Promise<ManagedEntry | null>;
  put(entry: ManagedEntry): Promise<void>;
  remove(sessionId: string): Promise<void>;
}
export interface ManagedEntry {
  sessionId: string; tmuxSession: string; cwd: string;
  origin: 'managed' | 'adopted'; createdAt: number;
}

// 每个 IM 会话至多一组待确认动作（同一 agent 轮次可暂存多个）
export interface PendingActionStore {
  get(conversationId: string): Promise<PendingAction[]>;
  set(conversationId: string, actions: PendingAction[]): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

export interface InboundMessage {
  msgId: string; senderUid: string; senderName?: string;
  conversationId: string; text: string; ts: number;
}
export interface ImAdapter {
  poll(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string }>;
  send(conversationId: string, text: string): Promise<void>;
}

export interface AgentRunner {
  // 针对某个 IM 会话运行一轮控制器 Agent，返回给用户的回复文本
  handle(conversationKey: string, userText: string): Promise<string>;
}
```

## 4. TranscriptParser 规格 (`transcript-parser.ts`)

- 输入：单行 JSON 字符串或原始行数组。
- 规则：
  - 半行 / 非法 JSON → 跳过（不抛），返回 `null`。
  - `type==='user'` 且 `message.role==='user'`：抽取文本（`content` 为字符串直接用；为数组则拼接 `type==='text'` 块；`tool_result` 块归到 `tool_result` 事件）。
  - `type==='assistant'`：抽取 assistant 文本 + `tool_use` 块（`id/name/input`）。
  - `type` ∈ {`last-prompt`,`mode`,`permission-mode`,`attachment`,`file-history-snapshot`,`summary`,`system`,…} 或未知 → `kind:'meta'`。
  - `ts`：`timestamp`（ISO）转 epoch ms；缺失则 `undefined`。
  - 去重键：`uuid`。
- 输出：`TranscriptEvent[]`（过滤 null）。
- 纯函数，无 IO。

## 5. SessionDiscovery 规格 (`session-discovery.ts`)

- `deriveStatus(raw)`：`status` 字段映射；缺省 `unknown`。
- `isLive(raw, isPidAlive)`：结合 pid 存活判断（pid 存活探测由 ClaudeHome/进程适配器提供，测试可注入）。
- `mergeLiveAndManaged(live, managed, transcripts)`：产出 `SessionSummary[]`：
  - `controllable = 存在 managed 且 tmux 有该 session`；
  - `origin = managed/adopted/external`；
  - `lastActivity = transcript 最新事件 ts`。

## 6. ControlPlane API (`control-plane.ts`)

```ts
class ControlPlane extends EventEmitter { // emit PlaneEvent
  constructor(deps: {
    tmux: TmuxAdapter; home: ClaudeHomeAdapter; registry: ManagedRegistry;
    clock: Clock; claudeBin: string; tmuxSocket: string;
    newSessionId: () => string; // 可注入(测试确定性)
  });

  start(): Promise<void>;   // 启动发现轮询 + watch
  stop(): Promise<void>;

  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionDetail>;              // 未找到 → NotFoundError
  getMessages(sessionId: string, opts?: { sinceUuid?: string; limit?: number }): Promise<TranscriptEvent[]>;

  sendMessage(sessionId: string, text: string): Promise<void>;       // 非 controllable → NotControllableError
  createSession(opts: { cwd: string; name?: string; model?: string;
                        permissionMode?: string; initialPrompt?: string }): Promise<SessionSummary>;
  adoptSession(sessionId: string, opts?: { force?: boolean }): Promise<SessionSummary>; // 存活且非 force → ConflictError
  stopSession(sessionId: string, opts?: { kill?: boolean }): Promise<void>;
}
```

语义要点：
- `sendMessage`：解析 `ManagedRegistry` → tmux session 名 → `tmux.sendText`。会话不可控则抛 `NotControllableError`（提示可 `adopt`）。
- `createSession`：生成 UUID；`tmux.newSession(name, cwd, [claudeBin, '--session-id', uuid, ...flags])`；写 registry；返回 summary。
- `adoptSession`：`live && !force` → `ConflictError('原窗口仍在运行，请先退出或 force')`；否则 `tmux.newSession(name, cwd, [claudeBin,'--resume',id])`，origin=`adopted`。
- 事件：发现轮询/watch 触发 `session.updated|removed`；transcript 增量触发 `message`。

## 7. REST + SSE API (`server/`)

所有 `/api/*`（除 `/api/login`）需鉴权。响应 `application/json`，错误统一 `{ error: { code, message } }`。

| 方法 | 路径 | 说明 | 请求体 | 成功响应 |
|---|---|---|---|---|
| POST | `/api/login` | token 换 cookie | `{token}` | 204 + Set-Cookie |
| POST | `/api/logout` | 清 cookie | — | 204 |
| GET | `/api/sessions` | 列出会话 | — | `SessionSummary[]` |
| GET | `/api/sessions/:id` | 会话详情 | — | `SessionDetail` |
| GET | `/api/sessions/:id/messages` | 消息(可 `?sinceUuid=&limit=`) | — | `TranscriptEvent[]` |
| POST | `/api/sessions/:id/messages` | 发消息 | `{text}` | 202 |
| POST | `/api/sessions` | 创建会话 | `{cwd,name?,model?,initialPrompt?}` | 201 `SessionSummary` |
| POST | `/api/sessions/:id/adopt` | 接管 | `{force?}` | 200 `SessionSummary` |
| GET | `/api/stream` | SSE 事件流 | — | `text/event-stream` |
| GET | `/` `/assets/*` | 静态 UI | — | html/js/css |

- **鉴权中间件**：优先 `Cookie: ls_token`，回退 `Authorization: Bearer`；比对 config.token（定长比较防时序）。失败 401。
- **SSE**：`event:` ∈ `status|message`，`data:` 为 JSON（PlaneEvent）。首次连接推全量 `status` 快照。心跳注释行 `:\n\n` 每 15s。
- **可测性**：路由用 Fastify `.inject()`；ControlPlane 注入 fake。

## 8. MCP 控制面 (`mcp/control-mcp.ts`)

stdio MCP server（`@modelcontextprotocol/sdk`），工具直连同一 `ControlPlane` 实例（进程内）。存在**两套工具集**，由组合根按调用方选择注入：

**(a) 直接执行集**（供 Web 内部/可信调用，立即生效）：

| 工具 | 入参 schema | 返回 |
|---|---|---|
| `list_sessions` | `{}` | `SessionSummary[]` |
| `get_messages` | `{ sessionId: string, limit?: number, sinceUuid?: string }` | `TranscriptEvent[]` |
| `get_status` | `{ sessionId: string }` | `{ status, live, controllable }` |
| `send_to_session` | `{ sessionId: string, text: string }` | `{ ok: true }` |
| `create_session` | `{ cwd: string, name?: string, model?: string, initialPrompt?: string }` | `SessionSummary` |
| `adopt_session` | `{ sessionId: string, force?: boolean }` | `SessionSummary` |

**(b) IM 控制器 Agent 集**（human-in-the-loop）：只读工具同上直接执行；**变更类只能 propose，不执行**，写入 `PendingActionStore`：

| 工具 | 入参 schema | 行为 |
|---|---|---|
| `list_sessions` / `get_messages` / `get_status` | 同上 | 直接执行 |
| `propose_send_to_session` | `{ sessionId: string, text: string }` | 暂存 `kind:'send'`，返回「已暂存，待用户确认」+ 摘要 |
| `propose_create_session` | `{ cwd: string, name?: string, model?: string, initialPrompt?: string }` | 暂存 `kind:'create'` |
| `propose_adopt_session` | `{ sessionId: string, force?: boolean }` | 暂存 `kind:'adopt'` |

- `propose_*` 工具物理上无 ControlPlane 变更调用，只能写 `PendingActionStore`（键为当前 IM 会话，经 AgentRunner 注入 conversationId 上下文）。
- 错误以 MCP `isError` 文本返回（含 code）。

## 9. IM 链接器 (`im/linker.ts`)

```ts
class ImLinker {
  constructor(deps: { im: ImAdapter; agent: AgentRunner; plane: ControlPlane;
                      pending: PendingActionStore; clock: Clock;
                      allowedUids: string[]; pollIntervalMs: number;
                      confirmWords: string[]; cancelWords: string[]; confirmTtlMs: number;
                      onAudit?: (m: InboundMessage, allowed: boolean) => void });
  start(): void; stop(): void;
  tick(): Promise<void>;   // 单轮(测试直接调用): 拉取→过滤→(确认闭环|agent 轮次)→回复
}
```

**tick 流程（每条命中白名单的入站消息）：**
1. **白名单**：`allowedUids.includes(senderUid)`，未命中 → 忽略 + `onAudit(m,false)`。
2. **去重**：游标 + 已处理 `msgId` 集合。
3. **确认闭环**：取 `pending.get(conversationId)`：
   - 有待确认动作且文本 ∈ `confirmWords`（如「确认/确定/yes/y」）→ 依次经 `plane` 执行（send/create/adopt），逐条回执结果，`pending.clear`。
   - 有待确认动作且文本 ∈ `cancelWords`（「取消/no/n」）→ `pending.clear` + 回「已取消」。
   - 有待确认动作但超过 `confirmTtlMs` → 视为过期，`clear` 并提示重发。
   - 有待确认动作但文本既非确认也非取消 → `clear` 旧动作并**作为新一轮 agent 处理**（避免卡死）。
4. **agent 轮次**：`agent.handle(conversationId, text)`（Agent 用只读工具查询、用 `propose_*` 暂存变更，写入 `pending`）。
5. **回复**：若本轮 `pending.get` 非空 → 发送 agent 回复 + 追加确认提示（「回复 确认 执行 / 取消 放弃」并列出摘要）；否则直接发送 agent 回复。
6. **异常**：agent/执行/发送异常捕获 → 回一条错误提示，轮询继续。

## 10. AgentRunner 真实现 (`adapters/agent-runner.ts`)

- 每个 `conversationKey` 维护一个 headless claude 会话（首次 `--session-id`，后续 `--resume` 保持**多轮上下文连续**）。
- 启动参数（示意）：`claude -p --output-format json --mcp-config <control-mcp.json> --strict-mcp-config --append-system-prompt <系统提示> --permission-mode dontAsk`，工具限定为 IM 集（只读 + `propose_*`）。
- 通过 MCP config / 环境把当前 `conversationId` 传给 `propose_*` 工具（使暂存动作归属正确会话）。
- 系统提示：限定「你是本机 Claude 会话控制助手；查询用只读工具；**任何变更(发指令/新建/接管)必须调用 `propose_*` 工具，绝不声称已执行**；先列会话再操作；把要做的事讲清楚等用户确认」。
- 返回：解析 `result` 文本作为回复。
- 测试：`AgentRunner` 接口用 fake（可断言 prompt、模拟「暂存了一个动作」）；真实现留集成/手动。

## 11. 钉钉 ImAdapter 真实现 (`adapters/im-dingtalk.ts`)

- 薄封装 `dws`（`execFile`）。**已探明命令结构**：
  - 入站：`dws chat message list ...`（拉某会话消息）；会话枚举 `dws chat list-all-conversations`；会话信息 `dws chat conversation-info`。
  - 出站：`dws chat message send ...`（或 `dws chat bot` webhook）。
  - 通用 flag：`-f json`（结构化输出）、`--jq`（过滤）、`--dry-run`（预览命令，测试断言用）、`-y`（AI Agent 免确认）。
- 精确 per-tool flag（conversationId/text 参数名）在 `dws` 鉴权恢复后经 `--dry-run` 固化；保留 `dws api`（raw OpenAPI）兜底。接口对上层稳定。
- `poll(cursor)`：拉取 → 映射 `InboundMessage[]` + 新游标（基于消息 id/时间）。
- `send(conv,text)`：经 `dws` 发送文本。
- auth 错误（token 过期，如当前实测降级态）→ 抛可识别 `UpstreamError`，Linker 降级只读并提示重登（`dws auth login`）。

## 12. 配置 (`lifestream.config.json`)

```jsonc
{
  "web":   { "host": "127.0.0.1", "port": 8787, "token": "<随机长串>" },
  "tmux":  { "bin": "tmux", "socket": "lifestream" },
  "claude":{ "bin": "claude", "defaultModel": null },
  "paths": { "claudeHome": "~/.claude", "stateDir": "~/.lifestream" },
  "im": {
    "enabled": true,
    "provider": "dingtalk",
    "dwsPath": "/path/to/dws",
    "pollIntervalMs": 3000,
    "conversationId": "<待填>",
    "allowedUids": [],
    "confirmWords": ["确认", "确定", "yes", "y", "ok"],
    "cancelWords": ["取消", "no", "n"],
    "confirmTtlMs": 300000
  }
}
```
- `config.ts`：加载 + 校验（缺 token 时启动生成并落盘并打印）；`~` 展开；env 覆盖（`LIFESTREAM_TOKEN` 等）。

## 13. 错误与退出码

- 领域错误类：`NotFoundError`(404)、`NotControllableError`(409)、`ConflictError`(409)、`ValidationError`(400)、`UpstreamError`(502, tmux/dws/claude 调用失败)。
- HTTP 映射到状态码；CLI 映射到退出码（0 成功，非 0 失败并打印 message）。
- 适配器调用失败包装为 `UpstreamError`，携带原始 stderr 摘要。

## 14. 日志

- 结构化行日志（level, ts, module, msg, ...）；默认 info；`--debug` 开 debug。
- 审计：IM 入站命中/拒绝、发消息、创建、接管 各一条审计日志（写 `~/.lifestream/audit.log`）。

## 15. 测试映射（对应 STORY 验收）

| 模块 | 测试层 | 关键用例 |
|---|---|---|
| TranscriptParser | 单元 | 各 type、半行、tool_use/result、去重 |
| SessionDiscovery | 单元 | 状态映射、live 合并、lastActivity |
| ControlPlane | 单元 | send/create/adopt 分支、事件发射、错误 |
| Auth | 组件 | cookie/bearer 通过与 401 |
| Routes+SSE | 组件 | inject 各端点、SSE 首帧+增量 |
| MCP tools | 单元 | 每工具入参校验与转发；`propose_*` 只写 PendingActionStore 不执行 |
| ImLinker | 单元 | 白名单过滤、去重、确认闭环(确认/取消/过期/非确认)、暂存→执行、异常回退 |
| tmux 闭环 | 集成 | send-keys → 假 claude → JSONL → 事件 |
