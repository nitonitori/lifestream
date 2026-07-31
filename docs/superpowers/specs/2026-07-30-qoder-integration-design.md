# lifestream 接入 Qoder 三产品的会话监控与控制

日期：2026-07-30
状态：已评审通过（设计），待写实施计划

## 1. 背景与目标

lifestream 今天只认 Claude Code：`ControlPlane` 依赖单个 `ClaudeHomeAdapter`，命令行拼装
（`--session-id` / `--resume`）与 transcript 文件名正则（`/([0-9a-f-]{36})\.jsonl$/i`）都硬编码在
领域层里。

目标是让同一个 Web / IM 界面同时看到四个产品的会话：

| 内核 | 产品 | 能力 |
|---|---|---|
| `claude` | Claude Code CLI | 读 + 控制（现状） |
| `qodercli` | Qoder CLI | 读 + 控制（新增第二可控内核） |
| `qoderwork` | QoderWork 桌面版 0.9.12 | 只读 |
| `qoder-ide` | Qoder IDE 桌面版（含 Quest 任务） | 只读 |

**三个 Qoder 产品视为三个不同产品**，各有独立的落盘契约，不共用发现逻辑。桌面版没有写入通道
（Electron `--remote-debugging-port=0`；`--remote-control` / `--teleport` 是云端会话专用），所以只读
不是保守选择而是事实上限。

## 2. 落盘契约（已实测）

### 2.1 transcript 位置

| 内核 | transcript 路径 |
|---|---|
| `claude` | `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` |
| `qodercli` | `~/.qoder/projects/<enc-cwd>/<sessionId>.jsonl` |
| `qoderwork` | `~/.qoderwork/projects/<enc-cwd>/<sessionId>.jsonl` |
| `qoder-ide` | `~/.qoder/projects/<enc-cwd>/transcript/<uuid>.jsonl`<br>Quest：`~/.qoder/projects/<enc-cwd>/transcript/task-<20hex>.session.execution.jsonl` |

`qodercli` 与 `qoder-ide` 共用 `~/.qoder/projects`，靠**是否位于 `transcript/` 子目录**无歧义区分。

三个 Qoder 产品的行格式与 Claude Code 逐字节同构（`--config-dir <dir>` 解释了这一点：QoderWork
桌面版驱动的是自带的 qodercli，只是换了 config root）。`src/domain/transcript-parser.ts`
**一行不改**：`type==='assistant' && message.role==='assistant'` 与 `type==='user' && message.role==='user'`
两个分支直接消费 Qoder 的行，`runtime-config` / `last-prompt` / `progress` / `session_meta`
全部落进现有的 `meta` 兜底分支。

`qodercli` 的 transcript 是权威文件，有遥测事件为证：`session.phase.finished` 事件的
`data.phase === "transcript.writer.materialized"`，其 `path` 指向 `projects/<enc>/<id>.jsonl`。

### 2.2 遥测事件日志（segments）

`~/.qoder` 与 `~/.qoderwork` 下都有：

- `logs/runs/<ISO-ts>-<rand>-p<pid>/`（含 `manifest.json`、`qodercli.log`）
- `logs/sessions/<enc-cwd>/<sessionId>/segments/<同名 run>.jsonl`

**run 是按每次 agent 调用切的，不是按进程启动切的** —— 同一个 app pid 12092 下观察到 16:31:03、
16:47:34、16:47:38 三个不同 run。

`segments` 是事件日志，不是转录。qodercli 的事件集：`session.config.loaded`、`session.phase.*`、
`input.prompt.received`、`input.slash_command.*`、`hook.*`。QoderWork 的更全（单文件实测 902 行）：
额外有 `turn.started` / `turn.finished`（带 `data.reason`、`num_turns`、`duration_ms`）、
`loop.iteration.*`、`model.request.started`、`model.response.completed`、`tool.requested`、
`tool.execution.finished`、`tool.shell.*`、`permission.requested` / `permission.resolved`、
`attachment.generator.finished`、`compression.progress`。

首行 `session.config.loaded` 的 `data` 携带 `project_root`、`target_dir`、`interactive`、`model`、
`permission_mode` —— 这是 cwd 的来源。

`~/.qoder/logs/sessions` 只有 3 个目录且全部对应 CLI 的 cwd：**Qoder IDE 的会话完全没有 segments
记录**。加上下面 §2.3 里 QoderWork fd 信号被证伪，两个桌面产品都需要外部注入才能拿到生命周期信号。

### 2.3 存活判定的实测结论

| 内核 | 存活信号 |
|---|---|
| `claude` | `~/.claude/sessions/*.json` 每会话一个真实 pid（现状不变） |
| `qodercli` | run 名尾部 `-p<pid>` 是**真实的每进程 pid**（18 个 run，pid 互异）→ 直接 `kill(pid, 0)` |
| `qoderwork` | run 名 pid 恒为 app pid（946 个 run 全是 `p12092`）→ pid 不可用；fd 信号已证伪（见下）→ 注入 hook |
| `qoder-ide` | 无 segments、且**不持有任何 `~/.qoder/projects/` 下的 fd**（已对全部 Qoder 进程查证）→ 只能靠注入 hook |

**QoderWork 的 fd 信号已被证伪。** 早先一次 `lsof` 恰好列出 2 个加载中会话的 segments 文件，据此
以为 app 长期持有写 fd。复测否掉了这个结论：17:47 会话 `ffd7ad78` 的 segments 刚写过，17:49 app
（pid 12092）仍在运行，而 `lsof -c QoderWork` 输出里 `.qoderwork` 下只剩 3 个 sqlite 文件，segments
fd 一个不剩 —— 它是**追加即关闭**，当时看到的 2 个 fd 是撞在写入瞬间。fd 因此只能采样到"此刻正在
写"，一个打开但空闲的会话对它完全不可见。QoderWork 于是与 Qoder IDE 同列：靠注入 hook 拿生命周期
信号，segments 只保留"历史事件日志"的价值。

## 3. 架构：两个端口

`src/ports/index.ts` 里 `ClaudeHomeAdapter` 升级为读协议，控制能力做成继承接口。**不维护
kernel → 能力的映射表**，能力就是"实现了没有"，用类型守卫收窄。

```ts
export type Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide';

// 读协议：4 个实现
export interface AgentSource {
  readonly kernel: Kernel;
  readLiveSessions(): Promise<LiveSession[]>;
  locateTranscript(sessionId: string): Promise<string | null>;
  readTranscript(path: string): Promise<string[]>;
  readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }>;
  watchProjects(cb: (changedPath: string) => void): () => void;
  sessionIdForPath(changedPath: string): string | null;
}

// 控制协议：2 个实现（claude / qodercli）
export interface ControllableSource extends AgentSource {
  launchCommand(sessionId: string, opts: CreateSessionOptions): string[];
  resumeCommand(sessionId: string): string[];
}

export function isControllable(s: AgentSource): s is ControllableSource {
  return typeof (s as ControllableSource).launchCommand === 'function';
}
```

四个实现：`ClaudeSource`（现 `ClaudeHome` 改名）、`QoderCliSource`、`QoderWorkSource`、`QoderIdeSource`。
其中前两个另外实现 `ControllableSource`。

### 3.1 为什么加 `sessionIdForPath`

今天 `ControlPlane.start()` 里硬编码 `/([0-9a-f-]{36})\.jsonl$/i`。这条正则有两个问题：
`qodercli` 与 `qoder-ide` 监听同一个 `~/.qoder/projects`，必须按路径形状归属；Quest 的
`task-<20hex>.session.execution.jsonl` 也不是 uuid，会被漏掉。归属规则是各 source 自己的知识。

各实现的规则：

- `ClaudeSource` / `QoderCliSource` / `QoderWorkSource`：`<enc-cwd>/<uuid>.jsonl` 平铺，一层深；
  出现 `transcript/` 一层则返回 `null`。
- `QoderIdeSource`：`<enc-cwd>/transcript/<uuid>.jsonl` 返回 uuid；
  `<enc-cwd>/transcript/task-<20hex>.session.execution.jsonl` 返回 `task-<20hex>`（Quest 的
  `sessionId` 就等于文件名主体，不是 uuid）。

对应地，`QoderIdeSource.locateTranscript(id)` 要按 id 形状选后缀：`task-` 前缀的拼
`<id>.session.execution.jsonl`，否则拼 `<id>.jsonl`，都在 `projects/*/transcript/` 下查找。
这是四个 source 里唯一 sessionId 与文件名不是简单相等关系的一个。

### 3.2 为什么加 `launchCommand` / `resumeCommand`

今天 `control-plane.ts:112` 与 `:151` 硬编码 `[claudeBin, '--session-id', id]` 与
`[claudeBin, '--resume', id]`。两个可控内核的 flag 名相同但**权限模式取值拼法不同**（已实测
`qodercli --help`）：

- Claude Code：`--permission-mode bypassPermissions`（另有 `acceptEdits`、`plan`、`default`）
- qodercli：`--permission-mode bypass_permissions`（choices：`default`、`accept_edits`、
  `bypass_permissions`、`dont_ask`、`auto`）

命令行方言归 source，tmux 与 registry 仍归 `ControlPlane`。

### 3.3 ControlPlane 的改动

`Deps.home: ClaudeHomeAdapter` 换成 `Deps.sources: AgentSource[]`；`Deps.claudeBin`
（`control-plane.ts:16`）与 `Deps.sessionPermissionMode` 一并下移到各自 source 的构造参数
（`ClaudeSource` 收 `claudeBin`，`QoderCliSource` 收 `qoderCliBin`）—— 领域层不该知道任何
可执行文件路径。并加一个私有解析：

- `private sourceOf(id): AgentSource` —— 先查 registry 条目的 `kernel`，再查各 source 报出的
  `LiveSession.kernel`，都没有则 `NotFoundError`。
- `activityMap` / `listSessions` / `getSession` / `getMessages` / `resolveCwd` /
  `ingestTranscript`：把 `this.d.home` 换成 `this.sourceOf(id)`，`listSessions` 改为合并各
  source 的 `readLiveSessions()`。
- `createSession(opts)`：`opts.kernel` 可选，默认 `'claude'`；取到的 source 不满足
  `isControllable` 则抛 `NotControllableError`；命令改由 `launchCommand` 生成。
- `adoptSession(id)`：该会话所属 source 不满足 `isControllable` 则抛 `NotControllableError`；
  命令改由 `resumeCommand` 生成。
- `start()`：对每个 source 各装一次 `watchProjects`，回调里用该 source 的 `sessionIdForPath`。
  `QoderCliSource` 与 `QoderIdeSource` 会各自在 `~/.qoder/projects` 上装一个递归 watcher，
  同一次文件变更被两边都收到 —— 各自的 `sessionIdForPath` 会把不归自己的路径判 `null` 丢弃，
  结果正确。保持两个独立 watcher 而不做共享，是为了不让 source 之间产生耦合。
- 受控会话仍 2s 轮询；只读桌面 source 降到 5s（心跳本身按事件刷新，2s 扫目录没有意义）。

## 4. 各 source 的发现与状态推导

| | 会话枚举 | cwd | busy / idle |
|---|---|---|---|
| `claude` | `~/.claude/sessions/*.json` + `kill(pid,0)`（现状） | json 字段 | 现有 `deriveStatus` |
| `qodercli` | `logs/sessions/*/*/segments/*.jsonl` 的 run 名 pid 存活 | segments 首行 `session.config.loaded.data.project_root` | segments 尾部事件名 |
| `qoderwork` | 心跳文件（§5） | 心跳载荷 `cwd` | 心跳事件名 |
| `qoder-ide` | 心跳文件（§5） | 心跳载荷 `cwd` | 心跳事件名 |

`qodercli` 的状态规则：**最后一条事件名以 `.started` 结尾 → busy，以 `.finished` 结尾 → idle**。
事件成对追加，这条规则不依赖枚举具体事件名。只有 `qodercli` 读 segments —— 两个桌面产品的
枚举、cwd、busy/idle 全部来自心跳，不再解析 segments。

`lastActivity` 一律取 transcript 末条消息时间戳（沿用现有 `activityMap`），不改语义。

**不做时间窗裁剪。** 早期草案里 QoderWork 打算用"最近 7 天有 run"来裁剪列表，理由是 pid 恒为
app pid、无法区分死活。改用心跳后这个补丁不需要了：心跳的 TTL 与 `Stop` 事件本身就是生命周期信号，
不必再拿 run 的时间戳猜。

## 5. 两个桌面产品的心跳 hook

两个 Qoder 桌面产品都实现了 Claude Code 的 hook 协议：事件名 `SessionStart`、`Stop`、
`PreToolUse`、`PostToolUse`、`PostToolUseFailure`，matcher 数组，stdin 收 JSON 且带
`hook_event_name`、sessionId、cwd。

给**两个桌面产品各注入**一条 lifestream 自己的 hook，按产品写到**各自的**心跳目录：

| target | settings 文件 | 心跳目录 |
|---|---|---|
| `qoder-ide` | `~/.qoder/settings.json` | `~/.lifestream/heartbeats/qoder-ide/` |
| `qoderwork` | `~/.qoderwork/settings.json` | `~/.lifestream/heartbeats/qoderwork/` |

心跳文件 `<sessionId>.json`：

```json
{ "sessionId": "...", "cwd": "/Users/l/dev/foo", "event": "PreToolUse", "ts": 1785400000000 }
```

推导规则（两个产品共用）：

- `live` = 最近心跳在 30 分钟内（配置项 `heartbeatTtlMs`）且最后事件不是 `Stop`
- `busy` = 最后事件是 `PreToolUse`；`idle` = `PostToolUse` / `PostToolUseFailure` / `Stop`

**`~/.qoder/settings.json` 是 qodercli 与 Qoder IDE 共用的**，装给 IDE 的 hook 对 qodercli 会话
也会触发，心跳目录无法区分二者。因此 `QoderIdeSource` 额外要求该 sessionId 在
`projects/*/transcript/` 下有转录（§2.1 的路径形状），把 qodercli 的平铺转录滤掉。
`~/.qoderwork/settings.json` 只被 QoderWork 自带的 qodercli 读取，不存在这个歧义，
`QoderWorkSource` 不加这层过滤（代价是一个还没产生转录的新会话也会列出，而这正确）。

### 5.1 安装命令

注入走**显式成对 CLI 命令**，不在 `serve` / daemon 启动路径里静默做：

```
lifestream hooks install   --target <qoder-ide|qoderwork|all> [--dry-run]
lifestream hooks uninstall --target <qoder-ide|qoderwork|all>
lifestream hooks status
```

约束：

1. 幂等合并 —— 重复执行不产生重复条目。
2. 先备份 —— 写前复制到 `<settings>.lifestream-backup-<ts>`。
3. 只增删自己那一项 —— `~/.qoder/settings.json` 里已经住着 r2c 的 hook，
   `~/.qoderwork/settings.json` 里住着 loongsuite 的，绝不能整体覆写。
4. `--dry-run` 打印将写入的 JSON diff 而不落盘。

### 5.2 安装手册

新建 `docs/install.md`，包含：这条命令的用途、两个 target 的目标路径、执行后如何确认生效（查
`~/.lifestream/heartbeats/<target>/` 是否出现文件）、如何卸载、备份文件在哪。

## 6. kernel 贯通与前端呈现

- `LiveSession`、`ManagedEntry`、`SessionSummary` 各加 `kernel: Kernel`，让 `sourceOf(id)`
  直接查表，不做文件系统探测。
- `SessionSummary` 加 `adoptable: boolean`（= 该会话所属 source 满足 `isControllable`）。
  今天 `web/src/views/console-view.ts:85` 的条件是 `!x.controllable && x.live` 就画"接管"按钮，
  桌面产品会画出一个必然失败的按钮；改成看 `adoptable`。**前端不认识 kernel 语义，只认识这个布尔。**
- `POST /api/sessions` 接受可选 `kernel` 字段（默认 `'claude'`）。
- 侧栏卡片加内核标签：`CC` / `QCLI` / `QW` / `QODER`，复用 `web/src/core/state.ts` 的 `tagOf`
  同一位置。

## 7. 砍掉原始按键通道

已实测：`paste-buffer -d` 送一个数字**不加回车**就能被 TUI 选择器当作快捷键消费 —— 信任目录
弹框送 `1` 生效；真实权限框 `Do you want to proceed? ❯1.Yes /2.No` 送 `2` 后命令被拒
（`stat -f "%Sp %N" /private/tmp/keytest` 返回 `drwxr-xr-x`，未变成 777）。`sendText` 尾部那个
`Enter` 落在已空的输入框上，无副作用。

而 `parseInteractivePrompt` 只识别编号块（`/^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/`），凡能被识别的
提示框必然带数字快捷键，方向键行按构造就到不了。所以保留识别、应答改走 §7.1 的字面通道。

### 7.1 应答走 `send-keys -l`（字面字符），不带回车

早先草案让应答借用 `sendText`，代价是尾部多一个 `Enter`（旧的原始按键通道不发）。实测确认存在
不带回车的直接发送，`man tmux`（3.4）给出两条原语：`send-keys -l` "disables key name lookup and
processes the keys as literal UTF-8 characters"；`paste-buffer` 不带 `-p` 时不插 bracketed-paste
转义码。在隔离 socket（`-L lskeyprobe`）上用 raw-mode stdin 记录器测三条路径：

```
32     ← send-keys -l '2'
32     ← load-buffer + paste-buffer -d（不发 Enter）
32     ← 现在的 sendText
0d     ←    sendText 尾部那个独立的 send-keys Enter
```

`0x0d` 完全来自第三条独立命令；`send-keys -l` 一次 exec 只送 `0x32`，还不需要临时 buffer，因此选它。

**这不会重新打开被砍掉的原始按键通道**：`-l` 关掉键名查找，`Escape` / `Up` / `Enter` 都发不出去
（会变成字面量 `E`,`s`,`c`,`a`,`p`,`e`），它是严格更窄的原语，只能送字面字符。

落地面：`TmuxAdapter.sendLiteral(name, text)` → `send-keys -l -t <name> <text>`；
`ControlPlane.answerPrompt(id, key)` 走既有 `managedTmuxName` 守卫；
`POST /api/sessions/:id/prompt {key}` 与 `GET` 同址对称；Web 编号按钮调它。

IM 侧不新增面：`propose_send_to_session` 保持原样（§7 已实测尾随 `Enter` 落在已空的输入框上无副
作用），不为此加回 `PendingActionKind` 或 MCP 工具。

删除清单：

- `TmuxAdapter.sendKeys`（`src/ports/index.ts`）、`Tmux.sendKeys`（`src/adapters/tmux.ts`）
- `ControlPlane.sendKeys`
- `POST /api/sessions/:id/keys`（`src/server/routes.ts:78-79`）
- `PendingActionKind` 的 `'keys'`（`src/domain/types.ts`）及其 `describeAction` 分支
  （`src/domain/pending.ts`）与 conductor 执行分支（`src/im/conductor.ts`）
- MCP `send_keys` 与 `propose_send_keys`（`src/mcp/control-mcp.ts`）
- `MESSENGER_SYSTEM_PROMPT` 里提到 `propose_send_keys` 的那句，改指 `propose_send_to_session`
- `web/src/components/prompt-box.ts` 的 `KEYPAD` 行
- `web/src/core/api.ts` 的 `sendKeys`
- 以上各项对应的测试

保留：`parseInteractivePrompt`、`ControlPlane.detectPrompt`、`GET /api/sessions/:id/prompt`、
MCP `get_session_prompt`、编号选项按钮（onclick 改走 §7.1 的字面通道）。

唯一真正失去的是 `Esc`（中断跑飞的 turn）。权限框永远提供编号的 "No"，真需要中断时另开一个
专用接口比留一整条原始按键通道干净。

## 8. 测试与验证

单元测试：

- 每个 source 的 `sessionIdForPath` 归属：`~/.qoder/projects` 下平铺 vs `transcript/` 的分流、
  Quest 的 `task-*` 名、非 jsonl 路径返回 `null`。
- segments 状态规则：尾部 `.started` → busy、`.finished` → idle。
- `session.config.loaded` 解析出 `project_root` 作为 cwd。
- 心跳文件解析：TTL 内/外、`Stop` 后判 idle 且不 live。
- `QoderIdeSource` 的转录形状过滤：只有 `transcript/` 下有转录的心跳才算 IDE 会话；
  `QoderWorkSource` 不过滤（无转录的新会话也列出）。
- `isControllable` 守卫：4 个 source 里只有 2 个为真。
- `launchCommand` / `resumeCommand` 两种方言（权限模式取值拼法不同）。
- hook 注入：幂等、保留他厂条目、备份文件生成、`--dry-run` 不落盘、uninstall 只删自己那项。
- 多 source `listSessions` 合并与排序；`createSession({ kernel: 'qoderwork' })` 抛
  `NotControllableError`；`adoptSession` 对桌面会话同样抛。

端到端（先 dev 实例 `~/dev-ai/lifestream`，8788 前台 serve；node 一律用绝对路径
`/Users/l/.nvm/versions/node/v24.18.0/bin/node`）：

1. `tsc --noEmit` 与 `vitest run` 全绿。
2. 打开 Web，四个产品的会话都出现在列表、内核标签正确、转录可读。
3. `lifestream hooks install --target all` → `lifestream hooks status` 确认两个 settings 都已装、
   且 r2c / loongsuite 的条目仍在。
4. 在 Qoder IDE 与 QoderWork 里各发一条消息 → 两个心跳目录各出现文件 → 会话在列表里 live/busy；
   结束一轮对话（`Stop`）后转 idle。
5. `createSession({ kernel: 'qodercli' })` 起一个受控会话，发消息、触发一次权限框、点编号选项
   确认能推进。
6. IM 侧用注入入口（非手动钉钉发消息）验证 `get_session_prompt` 与 `propose_send_to_session`。
7. build + reload 部署实例（`~/apps/lifestream`，8787）。

## 9. 明确不做

- 不给桌面产品做写入通道（无可用入口，逆向 Electron 不在范围内）。
- 不预建"通用内核端口"抽象层，只按当前四个实现的实际差异分两个协议（YAGNI）。
- 不为 QoderWork 解析 segments（心跳已给出枚举、cwd、busy/idle 全部信息）。
- Web 新建会话入口不加内核选择器，仍固定起 Claude 会话；起 qodercli 会话走
  `POST /api/sessions {kernel}` 或 MCP `create_session` / `propose_create_session`。
- 不改受控会话的默认权限模式。
- 不做全舰队主动 capture-pane 探测提示框（现状"打开会话时轮询"保持不变）。

## 10. 待实测项与风险

1. **心跳只在事件时刷新**，hook 协议没有周期性心跳。30 分钟 TTL 内一个真的已关闭的会话会被显示为
   live（除非它最后一个事件是 `Stop`）。这是精度上限，不是 bug，两个桌面产品同样受限。
2. **没装 hook 的桌面产品在列表里完全不出现**（哪怕有几百条历史转录）。这是显式安装换来的确定性，
   `lifestream hooks status` 是排查入口，`docs/install.md` 要写明这一点。
3. **Qoder 版本漂移** —— 本设计基于 QoderWork 0.9.12、qodercli 1.1.5/1.1.8（另有 1.0.45 打包在
   `/Applications/QoderWork.app/Contents/Resources/bin/qodercli`）。事件名或路径若变化，受影响
   面被隔离在各自 source 内。
