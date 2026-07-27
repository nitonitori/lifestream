# STORY: Lifestream 用户故事与验收标准

- Status: Draft (待评审)
- Date: 2026-07-27
- Related: [RFC](./2026-07-27-lifestream-rfc.md) · [SPEC](./2026-07-27-lifestream-spec.md)

故事按 **TDD 可测切片**排序（自底向上，先纯逻辑后 IO 后集成）。每条含验收标准（Given/When/Then）。标注 `[unit]/[component]/[integration]` 指示主要测试层。

---

## Epic A — 监控（只读）

### A1 解析 transcript 为结构化事件 `[unit]`
作为开发者，我要把 `<sessionId>.jsonl` 的原始行解析为归一化事件，以便上层统一消费。
- **AC1** Given 一行 `type:'user'` 记录，When 解析，Then 得到 `kind:'user'` 且 `text` 为用户文本、含 `uuid/ts`。
- **AC2** Given `type:'assistant'` 含 `tool_use` 块，Then 得到 `kind:'assistant'` 且 `toolUses[]` 含 `id/name/input`。
- **AC3** Given 含 `tool_result` 块的 user 记录，Then 产出 `kind:'tool_result'`（`toolUseId/content/isError`）。
- **AC4** Given 半行/非法 JSON，Then 跳过且不抛异常。
- **AC5** Given `type` ∈ {last-prompt, mode, permission-mode, attachment, …} 或未知，Then 归为 `kind:'meta'`。

### A2 发现本机运行中的 Claude 实例 `[unit]`
作为用户，我要看到本机所有运行中的 claude 及其状态。
- **AC1** Given `sessions/*.json` 若干，When 读取，Then 得到 `LiveSession[]`（pid/sessionId/cwd/name/status）。
- **AC2** Given `status` 缺失，Then 记为 `unknown`。
- **AC3** Given 某 pid 不存活，Then 该会话 `live=false`。

### A3 聚合会话摘要 `[unit]`
作为用户，我要一个统一的会话列表（合并存活状态、受控性、最近活动）。
- **AC1** Given live + managed registry + transcripts，Then 每条 `SessionSummary` 正确标注 `origin/controllable/live/lastActivity`。
- **AC2** Given 某会话在 registry 且 tmux 存在，Then `controllable=true`。
- **AC3** Given 外部实例（不在 registry），Then `origin='external'` 且 `controllable=false`。

### A4 CLI dump 监控（垂直切片验证）`[integration]`
作为用户，我要用 `lifestream sessions` / `lifestream tail <id>` 在终端看会话与消息。
- **AC1** When 运行 `lifestream sessions`，Then 打印当前会话表。
- **AC2** When 运行 `lifestream tail <id>`，Then 输出该会话已归一化消息，并随文件增长追加。

---

## Epic B — 控制（同一 session）

### B1 tmux 适配器 `[integration]`
作为系统，我要经专用 socket 操控 tmux 会话。
- **AC1** `newSession(name,cwd,cmd)` 后 `hasSession(name)=true` 且工作目录为 cwd。
- **AC2** `sendText` 能把**多行**文本完整送入目标并提交（Enter），`capturePane` 可见。
- **AC3** `killSession` 后 `hasSession=false`。

### B2 创建受控会话 `[unit]+[integration]`
作为用户，我要新建一个受 Lifestream 控制的 claude 会话。
- **AC1** `createSession({cwd})` 生成确定 UUID（注入）、以 `claude --session-id <uuid>` 在 tmux 启动，并写入 registry。
- **AC2** 返回的 `SessionSummary.controllable=true`、`origin='managed'`。
- **AC3**（集成，假 claude）创建后能 `sendMessage` 并在其 JSONL 看到该输入。

### B3 向同一 session 发消息 `[unit]`
作为用户，我要给一个运行中的受控会话发消息，且是同一个进程/会话。
- **AC1** Given 受控会话，`sendMessage(id,text)` 调用 `tmux.sendText(该会话, text)` 一次。
- **AC2** Given 非受控（external）会话，Then 抛 `NotControllableError` 并提示可 `adopt`。
- **AC3** Given 不存在的 id，Then 抛 `NotFoundError`。

### B4 接管外部会话 `[unit]`
作为用户，我要把手动启动的外部会话接管为受控（同一 session）。
- **AC1** Given 该 sessionId 无存活 pid，`adoptSession(id)` 以 `claude --resume <id>` 在 tmux 启动，registry `origin='adopted'`，返回 `controllable=true`。
- **AC2** Given 该 sessionId 仍有存活 pid 且未 `force`，Then 抛 `ConflictError`（提示先退出原窗口）。
- **AC3** Given `force=true`，Then 强制接管。

### B5 事件总线 `[unit]`
作为上层（Web/MCP），我要订阅会话状态与消息变化。
- **AC1** transcript 增量 → 发 `message` 事件（含归一化 event）。
- **AC2** 状态轮询变化 → 发 `session.updated`；会话消失 → `session.removed`。
- **AC3** 已发事件按 `uuid` 去重，不重复推。

---

## Epic C — Web（鉴权 + 监控 + 操作）

### C1 鉴权中间件 `[component]`
作为用户，我要求 Web 访问受 token 保护。
- **AC1** 无凭证访问 `/api/sessions` → 401。
- **AC2** `POST /api/login {token}` 正确 → 204 且 Set-Cookie `ls_token`（HttpOnly,SameSite=Strict）。
- **AC3** 带正确 cookie 或 `Authorization: Bearer` → 通过；错误 token → 401（定长比较）。

### C2 会话 REST `[component]`
作为用户，我要通过 API 查询与操作会话。
- **AC1** `GET /api/sessions` 返回 `SessionSummary[]`。
- **AC2** `GET /api/sessions/:id/messages?sinceUuid=` 返回增量事件。
- **AC3** `POST /api/sessions/:id/messages {text}` → 202 且触发 `ControlPlane.sendMessage`。
- **AC4** `POST /api/sessions {cwd}` → 201；`POST /api/sessions/:id/adopt` → 200/409。
- **AC5** 领域错误映射正确状态码（404/409/400/502）。

### C3 SSE 实时流 `[component]`
作为用户，我要在页面上近实时看到状态与消息。
- **AC1** `GET /api/stream` 连接后先收到全量 `status` 快照帧。
- **AC2** ControlPlane 发 `message`/`session.updated` 时，SSE 推对应帧。
- **AC3** 无凭证连接 SSE → 401。

### C4 Web UI `[component/手动]`
作为用户，我要一个页面监控所有会话并操作。
- **AC1** 列表显示会话名/cwd/状态/是否可控，随 SSE 更新。
- **AC2** 进入会话看消息流（user/assistant/tool），随 SSE 追加。
- **AC3** 输入框发消息；按钮创建会话、接管会话。
- **AC4** 首次访问要求输入 token（写 cookie）。

---

## Epic D — MCP 控制面

### D1 MCP 工具 `[unit]`
作为控制器 Agent，我要用 MCP 工具操作本机 claude。
- **AC1** `list_sessions` 返回摘要；`get_messages` 支持 `limit/sinceUuid`。
- **AC2**（直接执行集）`send_to_session/create_session/adopt_session/get_status` 正确转发到 ControlPlane。
- **AC3**（IM Agent 集）`propose_send_to_session/propose_create_session/propose_adopt_session` **只写 `PendingActionStore` 不执行**，返回「已暂存待确认」+ 摘要。
- **AC4** 入参不合法 → 校验错误；领域错误 → `isError` 文本含 code。

---

## Epic E — 钉钉 IM 链接器 + 控制器 Agent

### E1 IM 路由与白名单 `[unit]`
作为用户，我只允许白名单 uid 通过钉钉触发。
- **AC1** Given 白名单内 uid 的**只读**请求（如「列出会话」），`tick()` 调 `agent.handle` 并 `im.send` 回复，无需确认。
- **AC2** Given 白名单外 uid，Then 忽略（`onAudit(...,false)`），不触发 agent。
- **AC3** Given 重复 `msgId`，Then 只处理一次（游标/去重）。
- **AC4** Given `agent.handle` 抛错，Then 回复一条错误提示且轮询继续。

### E1b IM 变更类操作需确认 `[unit]`
作为用户，控制器对**发指令/新建/接管**必须先让我在 IM 确认才执行。
- **AC1** Given agent 本轮通过 `propose_*` 暂存了动作，Then 回复摘要 + 追问「确认/取消」，且**未**调用 ControlPlane 变更方法。
- **AC2** Given 存在待确认动作且我回复确认词，Then 依次经 ControlPlane 执行并回执结果，清空暂存。
- **AC3** Given 存在待确认动作且我回复取消词，Then 丢弃并回「已取消」。
- **AC4** Given 待确认动作超过 `confirmTtlMs`，Then 过期丢弃并提示重发。
- **AC5** Given 存在待确认动作但我回复的既非确认也非取消，Then 丢弃旧动作并把该消息作为新一轮 agent 处理（不卡死）。

### E2 钉钉适配器 `[integration/手动]`
作为系统，我要经 `dws` 收发钉钉消息。
- **AC1** `poll(cursor)` 从指定会话拉取新消息并映射为 `InboundMessage[]` + 新游标。
- **AC2** `send(conv,text)` 经 `dws` 发出（`--dry-run` 冒烟可断言命令构造）。
- **AC3** token 过期 → 抛可识别错误，Linker 降级只读并提示重登。

### E3 控制器 Agent `[integration/手动]`
作为用户，我通过和 Agent 对话间接控制本机所有 claude。
- **AC1** 输入「列出所有会话」→ Agent 调 `list_sessions` 并汇总回复（只读，直通）。
- **AC2** 输入「给 X 会话发…」→ Agent 调 `propose_send_to_session` 暂存，回复确认追问；我确认后才实际发送。
- **AC3** 输入「在 /path 新建会话做…」→ Agent 调 `propose_create_session` 暂存，确认后才创建。
- **AC4** 同一钉钉会话多轮对话上下文连续（`--resume`）。

---

## Epic F — 组合与打磨

### F1 组合根与配置 `[component]`
- **AC1** `lifestream start` 加载配置、装配真实适配器、起 Web + IM + MCP。
- **AC2** 缺 token → 自动生成并落盘+打印；`~` 与 env 覆盖生效。
- **AC3** tmux/dws 缺失 → 启动自检给出可读错误。

### F2 安全与审计 `[unit/component]`
- **AC1** 默认绑定 127.0.0.1；改 host 必须有 token。
- **AC2** IM 命中/拒绝、发消息、创建、接管 写审计日志。

---

## 交付顺序（建议冲刺）
1. A1→A2→A3→A4（只读监控端到端可用）
2. B1→B2→B3→B4→B5（同一 session 控制）
3. C1→C2→C3→C4（Web）
4. D1（MCP）
5. E1→E1b→E2→E3（钉钉 + 确认闭环 + Agent）
6. F1→F2（组合、安全、打磨）
