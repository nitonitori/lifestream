# RFC: Lifestream — 本机 Claude 实例监控与控制中枢

- Status: Implemented v0.1（已实现，随实现演进同步）
- Date: 2026-07-27
- Author: Claude Code (与用户协作 brainstorm)
- Related: [SPEC](./2026-07-27-lifestream-spec.md) · [STORY](./2026-07-27-lifestream-story.md) · [Plan](../plans/2026-07-27-lifestream.md)

## 1. Summary（摘要）

Lifestream 是一个跑在你工作机上的常驻服务（**Hub**，由守护进程保活），用于**监控与控制本机上所有的 Claude Code 实例**，并对外提供三个入口：

1. **Web**（本机/局域网访问，Bearer token + 长效 httpOnly cookie 鉴权）——可视化监控所有会话、查看会话内实时消息、给会话发消息、创建新会话、接管外部会话，并内置**信使 Agent 面板**。
2. **钉钉 IM 链接器**（发送者白名单，键为 `senderOpenDingTalkId`）——通过 `dws` 收发钉钉消息；命中白名单的消息交给**信使 Agent**，由它间接控制本机所有 Claude。
3. **MCP 控制面**——把控制能力暴露为 MCP 工具，供信使 Agent（headless Claude Code）调用，实现「用 claude 控制 claude」。

**信使 Agent** 的内核就是一个完整的 **Claude Code（headless `claude -p --resume`）**：具备其全部技能(skills)、工具与上下文能力；Web 与 IM 的消息进入**同一个会话上下文**（共享 `conversationKey`）。三个入口共享同一个核心 `ControlPlane`。核心逻辑与副作用（tmux / 文件系统 / dws / claude 进程）通过适配器解耦，保证可测试与可替换。整个服务由 **守护进程（keep-alive + 源码热重启 + launchd 开机自启）** 托管，配合长效登录令牌，实现「服务不 down、异地设备一次登录常驻」。

## 2. Goals / Non-Goals

### Goals
- G1 监控本机**所有** Claude Code 实例：实时状态（busy/idle）、会话元信息（name/cwd/sessionId/model）。
- G2 监控**会话内消息**：user / assistant / tool_use / tool_result，近实时更新。
- G3 **控制**受托管会话：向**同一个正在运行的 claude 进程**注入消息（不 fork、不新建会话）。
- G4 **创建**新会话：指定 cwd 启动一个受控 claude 会话。
- G5 **接管**外部会话：把手动在普通终端启动的会话一次性重接进受托管的 tmux 会话，之后即同一 session 可控。
- G6 Web 入口，合理鉴权（token 白名单 / cookie）。
- G7 钉钉 IM 入口，发送者白名单（`senderOpenDingTalkId`）触发，经信使 Agent 间接控制。
- G8 全流程遵循 SDD + TDD（红-绿-重构）。
- G9 **高可用**：守护进程保活（崩溃自动重启）+ 源码热重启（改代码不手动拉起），重启期前端 SSE 自动重连。
- G10 **常驻登录**：登录令牌持久化、cookie 长效；异地设备首次验证后无需在重启后重新查看令牌。
- G11 **信使 Agent = 完整 Claude Code**：具备 skills / 工具 / 上下文；Web 与 IM 打入同一会话。

### Non-Goals
- NG1 不做多机分布式；仅限本机（Hub 与被控 claude 同机）。
- NG2 不复刻官方 `/remote-control`（云中继、需 Pro/Max、每会话单连接），因不满足「本机自托管 + 自有鉴权」诉求。
- NG3 不逆向未公开的 `peerProtocol` / unix socket（脆弱、随版本失效）。
- NG4 不做钉钉之外的 IM（但通过 `ImAdapter` 接口保留扩展点）。
- NG5 不做账号体系/多租户；单用户（你本人）。
- NG6 不追求像素级还原 TUI；结构化消息以 JSONL transcript 为准。

## 3. Background（本机实测事实）

以下为对本机 Claude Code（v2.1.x）运行与存储机制的实测结论，是设计的基础：

- **实时实例注册表**：`~/.claude/sessions/<pid>.json`，每个**运行中**的 claude 一个文件。字段含 `pid, sessionId, cwd, name, status(busy/idle), kind(interactive), version, updatedAt, statusUpdatedAt`。→ 用于 G1 发现与状态。
- **会话 transcript**：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，append-only JSONL，逐行记录 `type`（user/assistant/system/last-prompt/mode/permission-mode/attachment/file-history-snapshot/summary…）。消息记录带 `message:{role,content[]}`、`uuid`、`parentUuid`、`timestamp`、`sessionId`、`cwd`。→ 用于 G2 监控。
  - **定位策略**：不重构 encoded-cwd 目录名（易碎），而是按文件名 `<sessionId>.jsonl` 在 `~/.claude/projects/*/` 下扫描定位，更鲁棒。
- **可控会话表面**：`claude -p --input-format stream-json --output-format stream-json --session-id <uuid>` 可脚本化双向；`--resume <id>` / `--fork-session` 可重接/派生。但**交互式 TUI 的同一-session 注入**官方无稳定 CLI；社区统一用 **tmux `send-keys`**。
- **可用工具**：本机 `tmux 3.4`、`node v24`、`npm 11`；钉钉 CLI `dws`（`/path/to/dws`，已登录，以**当前登录用户本人身份**操作 OpenAPI）。
- **钉钉消息机制（实测已确认）**：
  - 拉取：`dws chat message list --user <userId>|--group <openConversationId> --time "yyyy-MM-dd HH:mm:ss" --direction newer -f json`。返回 `result.conversationMessagesList[]`，每条含 `openMessageId / senderOpenDingTalkId / sender(显示名) / openConversationId / content(文本消息为明文) / createTime`。
  - 发送：`dws chat message send --user <userId>|--group <cid> --text <文本> -y`（`--user <user-id>` 会解析为 openDingTalkId，以 markdown 发出）。
  - **发送者身份**：消息载荷里**没有数字 uid/工号**，稳定身份是 `senderOpenDingTalkId`（形如 `<open-dingtalk-id>`，对应某 `<user-id>`）。故白名单键 = `senderOpenDingTalkId`。
  - `dws` refresh token 有效期较短（数小时），过期需 `dws auth login`；adapter 检测 auth 错误后 IM 降级只读并提示。

## 4. Architecture（架构）

```
   (手动启动) lifestream daemon (supervisor, 保活)
                                 │ 崩溃退避重启 · SIGHUP/`reload` 优雅重启
                                 ▼  spawn: lifestream serve  (SIGTERM 优雅重启)
                    ┌──────────────────────────────────────────────┐
   浏览器(Web UI) ──▶│  HTTP + SSE + /healthz (Fastify) [长效 Cookie] │
     · 会话监控/操作  │   · 信使 Agent 面板 (/api/agent/*)             │
   钉钉用户 ──dws──▶│  IM 链接器 (poll+send) [senderOpenDingTalkId]  │
                    │            │                    │              │
                    │            ▼   共享             ▼              │
                    │      AgentConductor(确认状态机 + PendingStore)  │
                    │            │ conversationKey = "messenger"     │
                    │            ▼                                   │
   信使Agent ──────▶│  MCP 控制面 (stdio, im: read + propose_*)      │
   (headless CC:     └───────────────────────┬──────────────────────┘
    claude -p --resume,                       ▼
    全 skills/工具)   ┌──────────────────────────────────────────────┐
                    │              ControlPlane (核心域)             │
                    │  discover · monitor · control · create · adopt │
                    │  纯逻辑 + 注入适配器 + 事件总线(EventEmitter)   │
                    └──┬─────────┬──────────┬──────────┬────────────┘
                 TmuxAdapter ClaudeHome  Clock  ImAdapter/AgentRunner
                       │      (FS/Watch)              │
             tmux -L lifestream │                    dws CLI / claude -p
             send-keys/new/kill ├─ sessions/*.json (状态发现)
             capture-pane       └─ projects/**/<id>.jsonl (transcript)
```

### 组件职责
- **ControlPlane（核心域）**：唯一的业务逻辑中心。发现实例、聚合状态、解析 transcript、发消息、创建、接管。只依赖注入的适配器接口，**不直接触碰进程/FS/网络**。对外提供方法 + 事件流。
- **TmuxAdapter**：封装 `tmux`（专用 socket `-L lifestream` 隔离）。`newSession/sendText/capturePane/listSessions/hasSession/killSession`；`sendText` = `load-buffer`+`paste-buffer`+`Enter`。
- **ClaudeHome（FS 适配器）**：读 `~/.claude/sessions/*.json`、定位与增量读 `<sessionId>.jsonl`、`watch` projects 目录。
- **TranscriptParser**：把 JSONL 原始行归一化为 `TranscriptEvent`（user/assistant/tool_use/tool_result/meta），容错未知类型与半行。
- **ManagedRegistry / PendingActionStore**：分别持久化「受控会话 tmux 映射」与「信使待确认动作」（`~/.lifestream/*.json`）。
- **HTTP/Web 服务（Fastify）**：REST + SSE + 静态 UI + `/healthz`，鉴权中间件（主令牌 / 每设备令牌）。含 `/api/agent/*`（信使面板）与 `/api/devices`（设备管理）。
- **DeviceStore**：持久化每设备动态令牌与元信息（`~/.lifestream/devices.json`），支持列出/撤销。
- **MCP 控制面**：stdio MCP server；`direct` 模式暴露执行工具，`im` 模式暴露只读 + `propose_*`（供信使 Agent，变更需确认）。
- **AgentConductor**：共享的信使会话逻辑（确认状态机 + agent 轮次）。**Web 与 IM 同用一个 `conversationKey`** → 共享 claude `--resume` 上下文与暂存动作。
- **IM 链接器（ImLinker）**：`DingTalkIm` 轮询 + `senderOpenDingTalkId` 白名单 + 去重 → 交 `AgentConductor` → 回复。
- **AgentRunner（ClaudeAgentRunner）**：信使 Agent 内核 = headless Claude Code（`claude -p`，`--resume` 续接，挂控制面 MCP，非 strict 以保留用户 MCP + 全部 skills/工具）。
- **Supervisor（daemon）**：手动启动的保活监督（指数退避重启）+ `SIGHUP`/`lifestream reload` 优雅重启；`--watch` 为可选开发便利、默认关闭；`install-launchd` 为可选。

## 5. Key Design Decisions & Alternatives（关键决策与备选）

### D1 同一-session 控制机制 → **tmux 托管 PTY**（已选）
- **选择**：每个受控会话跑在 `tmux -L lifestream` 的一个 session 中；发消息 = `send-keys` 注入到**同一个 claude 进程**；回复从 JSONL 读。你也能 `tmux attach` 一起用。
- 备选 A（每次 fork/resume 一个 headless 子进程）：被用户否决——不是同一 session。
- 备选 B（逆向 peerProtocol/unix socket 注入活动 TUI）：脆弱、不受支持、随版本失效。
- 备选 C（官方 remote-control）：云中继、需订阅、每会话单连接，不满足自托管+自有鉴权。
- **代价**：`send-keys` 需处理多行/粘贴（用 `load-buffer`+`paste-buffer` 或 bracketed paste）；只对 tmux 内进程有效（故外部实例需 adopt）。

### D2 外部实例处理 → **可重接接管（adopt）**（已选）
- 非 tmux 的外部实例默认**只读监控**；`adopt` = 在 tmux 内 `claude --resume <sessionId>`（保留历史=同一 session）后即受控。
- **约束/风险**：同一 session 文件不能被两个进程同时写。故 adopt 若检测到该 sessionId 仍有**存活 pid**，默认拒绝并提示「请先退出原窗口」；`force` 可覆盖（有风险）。

### D3 信使 Agent → **完整 Claude Code（headless）+ 自建 MCP 控制面**（已选，评审确认并升级）
- 「用 claude 控制 claude」：信使 Agent = `claude -p <text> --resume --output-format json --mcp-config <控制面> --append-system-prompt <角色> --permission-mode <可配>`。
- **它是一个完整的 Claude Code**：保留全部内置技能(skills)、工具，以及用户自己配置的 MCP 服务（**不加 `--strict-mcp-config`**，控制面 MCP 以叠加方式注入）。上下文经 `--resume`（每 `conversationKey` 一个持久 claude 会话）连续。
- **权限模式**可配（`claude.agentPermissionMode`，默认 `bypassPermissions`，便于 headless 下工具真正可用）；安全边界是 IM 发送者白名单 + Web token。
- 变更「其它会话」仍走 `propose_*`（见 D7）；信使自身的普通工具（Bash/Edit/Skill…）按 CC 正常行为执行。
- 备选（自研 tool-loop 直连 API）：更多代码、脱离生态；`AgentRunner` 接口保留替换空间。

### D4 Web 实时通道 → **SSE**（已选，评审确认）
- 服务器→浏览器用 SSE（单向、天然断线重连、易 inject 测试）；浏览器→服务器命令用普通 POST。
- 备选 WebSocket：双向但对本场景过重、测试更繁。

### D5 钉钉入站 → **轮询指定通道 + `senderOpenDingTalkId` 白名单**（已选，已对真实 dws 校准）
- `dws` 无稳定实时监听命令，故轮询指定通道（`im.channel = {type:'user'|'group', target}`）拉新消息（`--time` 游标 + `--direction newer`），按 **`senderOpenDingTalkId`** 白名单（`im.allowedSenderIds`）过滤，`openMessageId` 去重。出站 `dws chat message send` 回到同一通道。
- 载荷无数字 uid/工号，故白名单键为 openDingTalkId（形如 `<open-dingtalk-id>`）。
- **防回环**：`dws` 当前登录账号与被控白名单账号不同 → 机器人自身回复（发送者=dws账号）天然不在白名单，不会被当作指令。
- `dws` 全封装在 `ImAdapter` 后：单测用 fake + 纯命令构造函数，真实现薄薄 shell out。

### D6 技术栈 → **TypeScript + Node v24 + Fastify + vitest**
- 与 Claude Code（Node）同生态；Fastify `.inject()` 便于路由 TDD；vitest 快。副作用全部走 CLI/FS 适配器接口，核心纯单测。

### D7 IM 变更类操作需用户确认（human-in-the-loop）（评审新增）
- **只读操作**（list_sessions / get_messages / get_status）经控制器 Agent 直通执行、直接回复。
- **变更类操作**（发指令 send_to_session / 新建 create_session / 接管 adopt_session）**不直接执行**：Agent 只能调用 `propose_*` 工具**暂存**意图；ImLinker 把「将要执行什么」以人类可读文本发到 IM，等你回复**确认**关键词后才真正经 ControlPlane 执行，回复「取消」或超时则丢弃。
- 强制在**工具边界**而非依赖 Agent 自觉：`propose_*` 工具物理上无法执行副作用，只写入 `PendingActionStore`。
- 控制器多轮上下文通过 headless claude `--resume` 保持连续（每个 IM 会话一个 agent 会话）。

### D8 多行注入 → **tmux `load-buffer` + `paste-buffer` 再发 `Enter`**（解决 OQ3）
- 先 `load-buffer -b <buf> -` 将完整文本（含换行）写入 tmux buffer，`paste-buffer -d -b <buf> -t <target>` 粘贴到目标，再 `send-keys -t <target> Enter` 提交。避免逐行 send-keys 的换行/时序问题。

### D9 信使 Web 面板 + 共享上下文 → **AgentConductor + 单一 conversationKey**（评审新增）
- 把「确认状态机 + agent 轮次」从 ImLinker 抽出为可复用的 `AgentConductor`；ImLinker 变薄（轮询+白名单+去重+格式化回复）。
- Web 暴露 `/api/agent/{enabled,message,pending,messages}`；`message` 走同一 `AgentConductor`，返回结构化结果（reply / staged / executed / cancelled / expired）。
- **Web 与 IM 使用同一 `conversationKey = "messenger"`** → 同一 claude `--resume` 会话 + 同一 `PendingActionStore`：在钉钉发起、在网页确认（或反之）皆可；网页 `/api/agent/messages` 读该 claude 会话 transcript 展示共享历史。

### D10 高可用 → **保活守护 + 手动优雅重部署**（评审调整：不自动重启、不开机自启）
- `lifestream daemon`：子进程 = `lifestream serve`；崩溃指数退避重启；`SIGHUP` → 优雅重启；PID/日志文件。**默认只保活**。
- **编辑期间主链路不断**：自我改造/编码时**不**用 `--watch`（它会在每次保存时重启、打断主链路）；编辑完由你/agent 手动 `lifestream reload`（向 daemon 发 SIGHUP → 对 serve 优雅重启）。`--watch` 仅作开发便利、默认关闭。
- 不做开机自启（`install-launchd` 保留为可选，用户手动启动即可）。
- 重启为亚秒瞬断，前端 SSE 自动重连（顶部「重连…」→「实时」），cookie 长效免重登 → 从手机视角服务「不 down」。

### D11 鉴权 → **主令牌 + 每设备动态令牌 + 设备管理**（评审调整）
- **主令牌**：持久化在 `lifestream.config.json`（重启不变），**只在 PC 获取**（`lifestream token`）。作为 API/CLI 的 bearer，及新设备登录的凭证。
- **每设备动态令牌**：新设备用主令牌登录一次 → 服务铸造该设备专属随机令牌写入 cookie（`Max-Age=1 年`）→ 登记到设备表（名称由 UA 推断 / 可自定义、创建时间、最近活跃、UA）。之后该设备常驻登录，重启无需再看令牌。
- **设备管理界面**：`GET /api/devices` 列出访问设备（标注「本机」）、`DELETE /api/devices/:id` 撤销、`/api/logout` 退出本设备。撤销即令该设备 cookie 失效（下次请求 401 → 前端回登录）。
- 令牌「动态」由此实现：cookie 里是每设备令牌而非主令牌；撤销单设备不影响其它设备。

## 6. Data Flow（数据流）

- **监控**：定时读 `sessions/*.json`（状态） + `fs.watch` projects 目录并 tail 变化的 `<id>.jsonl` → `TranscriptParser` 归一化 → ControlPlane 发事件 → SSE 推浏览器 / MCP 工具返回快照。
- **发消息**：Web/Agent → `ControlPlane.sendMessage(id, text)` → 经 `ManagedRegistry` 找到 tmux 目标 → `send-keys`（多行安全）→ claude 处理 → 新 JSONL 行被 tail → 事件流回传。
- **创建**：`createSession({cwd,...})` → `tmux new-session -d 'claude --session-id <uuid> …'` → 注册 → 受控。
- **接管**：`adoptSession(id)` → 查 live pid（存活则默认拒绝）→ `tmux new-session -d 'claude --resume <id>'` → 注册 → 受控。
- **IM**：`DingTalkIm.poll()`（`list --time` 游标）→ `senderOpenDingTalkId` 白名单 + `openMessageId` 去重 → `AgentConductor.handle("messenger", text)`（有待确认动作则先处理确认/取消/过期）→ 结果格式化后 `send` 回通道。
- **信使 Web**：`POST /api/agent/message` → 同一 `AgentConductor.handle("messenger", text)` → 结构化结果（staged 则前端显示确认横幅，确认再 POST「确认」）；`GET /api/agent/messages` 读信使 claude 会话 transcript（与 IM 共享）。
- **热重启**：改代码 → daemon `--watch` 侦测 → SIGTERM `serve`（优雅排空）→ 立即重启 → 前端 SSE 自动重连、cookie 仍有效（无需重登）。

## 7. Security Model（安全模型）

- 默认绑定 `127.0.0.1`；如需局域网访问改 host 但**强制鉴权**。
- Web：**主令牌**（持久化、PC 获取）登录后铸造**每设备动态令牌**写入 `HttpOnly; SameSite=Lax; Max-Age=1y` cookie；除 `/api/login`、`/api/logout`、`/healthz` 外所有 REST + SSE 校验（主令牌 bearer 或有效设备令牌）。可在设备管理界面**撤销任意设备**。
- IM：`allowedSenderIds`（`senderOpenDingTalkId`）白名单；非白名单发送者的消息被忽略并审计。
- tmux 专用 socket（`-L lifestream`）与用户其他 tmux 隔离。
- `dws` 以你本人身份操作，凭证在 `dws` 自身；Lifestream 不落地钉钉凭证。
- **信使 Agent 是全权 Claude Code**（默认 `bypassPermissions`，可改）：其安全边界是「IM 发送者白名单 + Web token」；变更「其它会话」的结构化操作仍需 `propose_*` 确认。请把 `allowedSenderIds` 严格限定为你本人，并只在可信网络暴露 Web。

## 8. Risks & Mitigations（风险与缓解）

| 风险 | 缓解 |
|---|---|
| adopt 双开同一 session 文件损坏 | 存活 pid 检测，默认拒绝，`force` 显式覆盖 |
| `dws` token 过期 | 检测 auth 错误 → 明确提示重新登录；IM 降级为只读 |
| `send-keys` 多行/粘贴异常 | 用 `load-buffer`+`paste-buffer`，显式 `Enter`；集成测试覆盖 |
| transcript 半行/写入竞态 | JSON 解析容错，跳过并下轮重读；按 `uuid` 去重 |
| Claude Code 版本漂移改格式 | 解析器容错、忽略未知 `type`；字段缺省保护 |
| tmux 未安装/socket 冲突 | 启动自检；专用 socket；给出可读错误 |
| 信使 Agent 全权（bypassPermissions）被越权触发 | 唯一入口受 IM 发送者白名单 + Web token 双重限制；`propose_*` 对跨会话操作二次确认；权限模式可下调 |
| 热重启瞬断导致请求失败 | 优雅排空 + 亚秒重启 + `/healthz`；前端 SSE 自动重连；cookie 长效免重登 |

## 9. Testing Strategy（测试策略，TDD）

- **单元**（红-绿-重构，无副作用）：TranscriptParser、SessionDiscovery、ControlPlane（fake Tmux/FS/Clock）、Auth 中间件、MCP 工具 handler（含 `propose_*` 只暂存）、AgentConductor（确认状态机）、ImLinker（白名单/去重）、dws 命令构造/解析、buildAgentArgs、退避与 launchd plist、Registry/PendingStore。
- **组件**：Fastify 路由 `.inject()`（含 `/api/agent/*`、`/healthz`、长效 cookie）；SSE 广播用内存流断言。
- **集成（少量）**：真 `tmux -L` + 假 claude 脚本验证 send-keys→transcript 闭环；MCP `im` 模式真 stdio 冒烟（只暴露只读 + `propose_*`）；daemon 热重启手动冒烟。
- **不做**：连真钉钉、真 Anthropic API 的自动化 e2e（手动/可选，见 OQ4）。

## 10. Milestones（里程碑，对应 STORY epics）

- **M1** 发现 + 解析（只读监控 CLI 可 dump 会话与消息）。✅
- **M2** ControlPlane 控制（tmux 创建/发消息）。✅
- **M3** Web + 鉴权（监控+操作 UI）。✅
- **M4** MCP 控制面。✅
- **M5** IM 链接器 + 信使 Agent。✅
- **M6** adopt/create 完善 + 集成测试 + 打磨。✅
- **M7**（评审后新增）dws 真实对接 + 共享 AgentConductor + Web 信使面板 + UI 重设计（响应式/气泡/智能滚动/窗口化）。✅
- **M8**（评审后新增）守护进程保活/热重启 + launchd + 常驻登录 + 信使升级为完整 Claude Code。✅

## 11. Open Questions（遗留 / 已解决）

- ~~OQ1 钉钉命令与会话标识~~ → 已实测确认（见 §3 钉钉消息机制；`im.channel` + `senderOpenDingTalkId`）。
- ~~OQ2 控制器 Agent 实现~~ → 已定 `claude -p --resume`（完整 Claude Code，非 strict MCP，权限模式可配）。
- ~~OQ3 多行注入~~ → 已定 D8。
- OQ4（新）真·端到端 IM 回合（真实 `claude -p` 一轮 + 真实发钉钉）尚未自动化验证；MCP 工具已对真实 stdio 冒烟；待用户授权后跑一次真实回合。
- OQ5（新）热重启为亚秒瞬断而非零停机；如需零停机可后续引入 socket 交接（SO_REUSEPORT），当前以 SSE 自动重连覆盖。
