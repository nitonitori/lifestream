# Qoder 三产品接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一个 Web / IM 界面同时看到并（在可控内核上）操作四个产品的会话：Claude Code、Qoder CLI、QoderWork 桌面版、Qoder IDE 桌面版。

**Architecture:** `src/ports/index.ts` 里把今天单一的 `ClaudeHomeAdapter` 拆成两个协议 —— 读协议 `AgentSource`（4 个实现）与控制协议 `ControllableSource extends AgentSource`（2 个实现），能力用类型守卫 `isControllable` 收窄，**不维护 kernel → 能力的映射表**。`ControlPlane.Deps.home` 换成 `Deps.sources: AgentSource[]`，命令行方言（`--permission-mode` 取值拼法）下移到各 source，tmux 与 registry 仍归 `ControlPlane`。两个桌面产品没有写入通道，其生命周期信号靠**显式安装的心跳 hook**（`lifestream hooks install`）落到 `~/.lifestream/heartbeats/<target>/`。同时按设计 §7 砍掉原始按键通道，编号选项改走既有 send 通道。

**Tech Stack:** TypeScript ESM（NodeNext、strict、`rootDir: src` → `outDir: dist`）、node ≥ 24、fastify 5、vitest 3（`environment: 'node'`）、esbuild（web bundle → `web/public/app.js`）、MCP SDK、zod。

## Global Constraints

- 设计文档是唯一需求来源：`docs/superpowers/specs/2026-07-30-qoder-integration-design.md`。
- 内核枚举，字面量精确：`export type Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide';`
- 可控内核只有 2 个：`claude`、`qodercli`。`qoderwork`、`qoder-ide` **只读**，对它们 `createSession` / `adoptSession` 必须抛 `NotControllableError`。
- 权限模式取值拼法不同：Claude Code `bypassPermissions`；qodercli `bypass_permissions`。flag 名两者相同（`--session-id` / `--resume` / `--permission-mode` / `--model` / `--name`）。
- transcript 路径形状：`claude` = `<claudeHome>/projects/<enc>/<id>.jsonl`；`qodercli` = `~/.qoder/projects/<enc>/<id>.jsonl`；`qoderwork` = `~/.qoderwork/projects/<enc>/<id>.jsonl`；`qoder-ide` = `~/.qoder/projects/<enc>/transcript/<id>.jsonl`，Quest 为 `~/.qoder/projects/<enc>/transcript/task-<20hex>.session.execution.jsonl`（唯一 sessionId ≠ 文件名主体的情形）。
- `~/.qoder/projects` 由 `qodercli` 与 `qoder-ide` 共用，靠**是否位于 `transcript/` 子目录**区分，不靠正则猜 uuid。
- `src/domain/transcript-parser.ts` **一行不改**。
- 心跳 hook 事件名，五个，精确：`SessionStart`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`。
- 心跳目录：`~/.lifestream/heartbeats/qoder-ide/`、`~/.lifestream/heartbeats/qoderwork/`（= `join(cfg.paths.stateDir, 'heartbeats', target)`）。心跳文件名 `<sessionId>.json`，载荷 `{ sessionId, cwd, event, ts }`。
- 心跳推导：`live` = `now - ts <= ttlMs` 且 `event !== 'Stop'`；`busy` = `event === 'PreToolUse'`，其余 `idle`。`heartbeatTtlMs` 默认 `30 * 60 * 1000`。
- settings 注入目标：`~/.qoder/settings.json`（qoder-ide）、`~/.qoderwork/settings.json`（qoderwork）。**必须**幂等合并、先备份到 `<settings>.lifestream-backup-<ts>`、只增删自己那一项（这两个文件里住着 r2c / loongsuite 的 hook），`--dry-run` 不落盘。绝不在 `serve` / daemon 启动路径里静默注入。
- 轮询节拍：可控 source 组 2000ms，只读 source 组 5000ms。
- 前端不认识 kernel 语义：判断「该产品能不能接管」只看 `SessionSummary.adoptable: boolean`，不得读 `kernel` 值。
  `adoptable` 是**能力位**（该会话所属 source 满足 `isControllable`），不含会话当下状态；「接管」按钮的状态条件
  `!controllable && live` 继续由前端把关，即 Task 7 Step 6 的 `!x.controllable && x.live && x.adoptable`。内核标签 `CC` / `QCLI` / `QW` / `QODER`。
- `src/config.ts` 的 `qoder` 配置块在 Task 4 一次加全（5 个字段：`cliBin`、`cliPermissionMode`、`qoderHome`、`qoderWorkHome`、`heartbeatTtlMs`），Task 5 / Task 6 只读不改 —— 不要因为「本任务只用到 2 个字段」就把它拆开。
- **测试环境没有 DOM**（`vitest.config.ts` 是 `environment: 'node'`，仓库无 jsdom 依赖）。`web/src/components/*.ts`、`web/src/views/*.ts` 的改动只能靠 `tsc -p tsconfig.web.json` + Task 8 的真实浏览器验证兜底，**不要为它们发明 DOM 测试**，也不要为此引入 jsdom。
- 所有 node / tsc / vitest 一律用绝对路径 `/Users/l/.nvm/versions/node/v24.18.0/bin/node`（规避 nvm 陷阱）。
- 本计划各任务里裸写的 `tsc --noEmit` 一律**读作** `tsc --noEmit -p tsconfig.test.json`：Task 2 起 `test/` 才纳入类型检查，
  裸形式只编 `src/`（`tsconfig.json` 的 `rootDir` 是 `src`），会漏掉测试文件的类型错误。Web 侧另跑 `-p tsconfig.web.json`。
- 工作目录是开发实例 `~/dev-ai/lifestream`，分支 `main`。部署实例 `~/apps/lifestream`（8787）只在 Task 8 才碰。
- 用中文写提交信息、日志文案与文档。
- **本计划的写法约定**：新增文件给出完整代码；对既有文件的**搬迁式**改动逐条给出替换规则（哪个表达式换成哪个），因为那些 body 里有本计划不打算改变的既有逻辑 —— 动手前先把该文件整份读一遍。

---

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `src/adapters/sources/base.ts` | `isPidAlive` / `isSafeSessionId` / `safeReaddir` / `flatSessionIdForPath`；抽象类 `ProjectsSource`（`projects/` 目录下的转录读取与 watch）、`CliSource`（命令行方言，`extends ProjectsSource implements ControllableSource`） |
| `src/adapters/sources/claude.ts` | `ClaudeSource extends CliSource` —— 由 `src/adapters/claude-home.ts` 迁移而来 |
| `src/adapters/sources/qoder-cli.ts` | `QoderCliSource extends CliSource` —— 枚举走 segments run 名里的真实 pid |
| `src/adapters/sources/qoder-desktop.ts` | `HeartbeatSource`（抽象）、`QoderWorkSource`、`QoderIdeSource` —— 枚举/cwd/状态全部来自心跳 |
| `src/domain/segments.ts` | `pidFromRunName`、`parseSegments`（纯函数，只 qodercli 用） |
| `src/domain/heartbeat.ts` | `parseHeartbeat`、`heartbeatVitals`（纯函数） |
| `src/domain/qoder-hooks.ts` | hook 目标枚举、事件名常量、`installHeartbeatHooks` / `uninstallHeartbeatHooks` / `heartbeatHookStatus`（纯函数，只吃吐 settings 对象） |
| `src/adapters/hooks-installer.ts` | 文件侧：settings 读写、备份、心跳脚本路径与命令行拼装 |
| `src/hooks/lifestream-heartbeat.ts` | 被注入的心跳脚本本体（`dist/hooks/lifestream-heartbeat.js`） |
| `src/hooks/cli.ts` | `runHooksCommand(args, deps)` —— `lifestream hooks install/uninstall/status` |
| `docs/install.md` | 安装手册 |
| `test/unit/sources.test.ts` | 四个 source 的归属规则、方言、枚举 |
| `test/unit/segments.test.ts` | segments 解析 |
| `test/unit/heartbeat.test.ts` | 心跳解析与推导 |
| `test/unit/qoder-hooks.test.ts` | hook 注入的幂等/保留他厂条目/status |
| `test/unit/hooks-cli.test.ts` | `runHooksCommand` 的落盘、备份、`--dry-run` |

**删除**：`src/adapters/claude-home.ts`（body 迁入 `sources/base.ts` + `sources/claude.ts`）、`test/integration/claude-home.test.ts`（改名为 `test/integration/claude-source.test.ts`）。

**修改**：`src/domain/types.ts`（`Kernel`、`CreateSessionOptions`、`LiveSession.kernel`/`pid?`、`SessionSummary.kernel`/`adoptable`、`PendingActionKind` 去掉 `'keys'`）、`src/ports/index.ts`（两个协议 + 守卫，`ManagedEntry.kernel`，去掉 `TmuxAdapter.sendKeys`）、`src/domain/session-discovery.ts`（三处签名带上 kernel/adoptable）、`src/domain/control-plane.ts`（多 source 化）、`src/adapters/managed-registry.ts`（老条目补 `kernel: 'claude'`）、`src/adapters/tmux.ts`、`src/server/routes.ts`、`src/mcp/control-mcp.ts`、`src/im/conductor.ts`、`src/domain/pending.ts`、`src/adapters/agent-runner.ts`、`src/config.ts`、`src/cli.ts`、`web/src/core/state.ts`、`web/src/core/api.ts`、`web/src/components/prompt-box.ts`、`web/src/views/console-view.ts`、`web/src/views/rail.ts`、`test/fakes/index.ts` 及各测试。

## 任务依赖

```
Task 1（砍按键通道，独立）
Task 2（两个端口 + ClaudeSource）
  └─ Task 3（ControlPlane 多 source 化）
       ├─ Task 4（QoderCliSource + segments + config）
       │    ├─ Task 5（hooks CLI + 手册）
       │    │    └─ Task 6（两个桌面 source + 心跳）
       │    └─ Task 7（Web：内核标签 + adoptable 门控）
       └─ Task 8（端到端 + 部署，最后做）
```

---

### Task 1: 砍掉原始按键通道

设计 §7。`paste-buffer -d` 送一个数字就能被 TUI 选择器消费，编号选项因此可以走既有 send 通道；`Esc` 是唯一真正失去的能力，接受。

**Files:**
- Modify: `src/ports/index.ts:11`（删 `TmuxAdapter.sendKeys`）
- Modify: `src/adapters/tmux.ts:49-53`（删 `sendKeys` 及其上方 2 行注释）
- Modify: `src/domain/control-plane.ts:104-106`（删 `sendKeys`；保留 `capturePane` / `detectPrompt`）
- Modify: `src/server/routes.ts:76-79`（删 `POST /api/sessions/:id/keys`，改注释）
- Modify: `src/domain/types.ts:47`（`PendingActionKind` 去掉 `'keys'`）
- Modify: `src/domain/pending.ts:7`（删 `'keys'` 分支）
- Modify: `src/im/conductor.ts:41`（删 `'keys'` 执行分支）
- Modify: `src/mcp/control-mcp.ts:35,56,80,85`（删 `send_keys` / `propose_send_keys` 及其注册）
- Modify: `src/adapters/agent-runner.ts:10-11`（改 `MESSENGER_SYSTEM_PROMPT`）
- Modify: `web/src/components/prompt-box.ts`
- Modify: `web/src/core/api.ts:45,93`（删 `sendKeys`）
- Modify: `web/src/views/console-view.ts:145-150,162`
- Modify: `test/fakes/index.ts:15,26-29`（删 `FakeTmux.keys` 与 `sendKeys`，保留 `paneText` / `capturePane`）
- Test: `test/unit/control-plane.test.ts:70,95-100,106,108`、`test/unit/control-mcp.test.ts:47-63`、`test/unit/conductor.test.ts:80-88`、`test/unit/web-api.test.ts:7,13`

**Interfaces:**
- Consumes: 无（本任务独立于其余任务）
- Produces: `TmuxAdapter` 不再有 `sendKeys`；`ControlPlane` 不再有 `sendKeys`；`PendingActionKind = 'send' | 'create' | 'adopt'`；`promptBox(p, onAnswer: (key: string) => void)`；`Api` 不再有 `sendKeys`。

- [ ] **Step 1: 先删掉断言旧行为的测试**

- `test/unit/control-plane.test.ts`：删掉 `sendKeys records raw keys`（:95-100）整个 `test`；在 `capturePane/sendKeys throw NotControllable…` 里删掉涉及 `sendKeys` 的两行断言（:106、:108），并把该 `test` 名改成 `capturePane 对外部会话抛 NotControllable、对不存在会话抛 NotFound`；把 :70 的 `describe` 名里的「按键」字样去掉。保留 `PERMISSION_PANE` 夹具（:71-76）与两个 `detectPrompt` 测试。
- `test/unit/control-mcp.test.ts`：删掉 :47-63 三个 `test`（`direct send_keys reaches the plane`、`im propose_send_keys stages a keys action`、`im has no direct send_keys tool`）。
- `test/unit/conductor.test.ts`：删掉 :80-88 的 `confirming a keys action calls plane.sendKeys on the target session`。
- `test/unit/web-api.test.ts`：从兜底文案清单里删掉 `'按键发送失败'`（:7、:13 两处），并把文件头注释里的「6 条固定兜底文案（发送/按键发送/接管/结束/创建/撤销失败）」改成「5 条固定兜底文案（发送/接管/结束/创建/撤销失败）」。

- [ ] **Step 2: 删掉服务端与端口侧的按键通道**

- `src/ports/index.ts:11`：删 `sendKeys(name: string, keys: string[]): Promise<void>;`
- `src/adapters/tmux.ts`：删 `sendKeys` 方法及其上方 2 行注释（:49-53）。`sendText`、`capturePane` 不动。
- `src/domain/control-plane.ts`：删 `sendKeys`（:104-106）。
- `src/server/routes.ts`：删 :78-79 的 `app.post('/api/sessions/:id/keys', …)`；把 :76 的注释 `// 交互选择器：识别(只读)与远程按键应答。` 改成 `// 交互选择器：只读识别；应答走 send 通道。`
- `src/domain/types.ts:47`：`export type PendingActionKind = 'send' | 'create' | 'adopt';`
- `src/domain/pending.ts:7`：删 `if (kind === 'keys') …` 一行。
- `src/im/conductor.ts:41`：删 `if (a.kind === 'keys') { … }` 一行。
- `src/mcp/control-mcp.ts`：删 `send_keys` 处理器（:35）、`propose_send_keys` 处理器（:56）、以及 :80 / :85 两处 `server` 注册。`get_session_prompt`（:26、:74）保留。
- `test/fakes/index.ts`：删 `FakeTmux.keys`（:15）与 `sendKeys`（:26-29）。

- [ ] **Step 3: 跑类型检查，确认剩下的调用点全被列出来**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
```
Expected: FAIL —— 报出 `src/adapters/agent-runner.ts`（`propose_send_keys` 只是字符串，不会报）之外的残留；重点应看到 web 侧尚未改，`tsc -p tsconfig.web.json` 会报 `api.sendKeys` 与 `prompt-box` 的 `onKeys`。若 `tsc --noEmit` 已全绿，直接进 Step 4。

- [ ] **Step 4: 改信使系统提示词**

`src/adapters/agent-runner.ts` 的 `MESSENGER_SYSTEM_PROMPT`：把第 10 行变更操作清单里的「按键应答」去掉；把第 11 行整句换成

```ts
    '若某个受控会话疑似卡在交互选择框（权限确认或多选菜单），可用只读工具 get_session_prompt 查看其选项，再用 propose_send_to_session 暂存对应的编号答复（如 "2" 选第 2 项），经确认后执行；' +
```

- [ ] **Step 5: 改前端：编号选项走 send 通道**

`web/src/components/prompt-box.ts`：
- 删 `KEYPAD` 常量（:5）与第二个 `confirm__row` 块（方向键那一行）。
- 参数签名 `onKeys: (keys: string[]) => void` → `onAnswer: (key: string) => void`。
- 选项按钮的 `onclick: () => onKeys([o.key])` → `onclick: () => onAnswer(o.key)`。

`web/src/core/api.ts`：删 `Api` 接口里的 `sendKeys(id: string, keys: string[]): Promise<void>;`（:45）与实现里的 `sendKeys: (id, keys) => post<void>(…/keys, { keys }),`（:93）。

`web/src/views/console-view.ts`：把 :145-150 的 `sendKeys` 帮手整段换成

```ts
  const answerPrompt = async (id: string, key: string) => {
    try { await api.sendSessionMessage(id, key); }
    catch (e) { toast(errText(e, '发送失败')); return; }
    toast('已选择 ' + key);
    setTimeout(() => void loadPrompt(id), 600);
  };
```

并把 :162 换成

```ts
    if (p && p.options.length > 0) promptSlot.appendChild(promptBox(p, key => void answerPrompt(id, key)));
```

- [ ] **Step 6: 两个类型检查 + 全量测试**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 三条都 PASS（0 errors；vitest 全绿）。

- [ ] **Step 7: 全仓搜一遍残留**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node -e "process.exit(0)" && grep -rn "sendKeys\|send_keys\|'keys'\|KEYPAD" src web test docs || true
```
Expected: 只剩 `src/adapters/tmux.ts` 里 `send-keys -t name Enter` 那一处 tmux 原生子命令（`sendText` 内部用），以及设计文档 `docs/superpowers/specs/` 里的历史记载。若还有别的，删干净再回到 Step 6。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "refactor(control): 砍掉原始按键通道，编号选项改走 send 通道"
```

---

### Task 1 修订 A：应答改走 `send-keys -l` 字面通道

**为什么有这个修订：** Task 1 的评审指出「借用 send 通道后，应答尾部多了一个旧通道不发的 `Enter`」。
这是设计 §7 授权的行为，因此上报给人类决策；决定是**调研并改用不带回车的直接发送**。结论与实测字节
序列已写进设计文档 **§7.1**：`send-keys -l` 只送一个字面字节，且因为关掉键名查找而**发不出**
`Escape` / `Up` / `Enter`，是严格更窄的原语，不会把 Task 1 砍掉的原始按键通道重新打开。

上面 Task 1 的 Step 1-8 是已执行并提交的历史记录（commit `eb04fd9`），不要回滚；本修订在其之上做增量。

**Files:**
- Modify: `src/ports/index.ts:10-11`（在 `sendText` 下加 `sendLiteral`）
- Modify: `src/adapters/tmux.ts:38-43`（在 `sendText` 下加 `sendLiteral`）
- Modify: `src/domain/control-plane.ts:99-101`（`detectPrompt` 下加 `answerPrompt`）
- Modify: `src/server/routes.ts:76-77`（加 `POST /api/sessions/:id/prompt`，改注释）
- Modify: `web/src/core/api.ts`（`Api` 加 `answerPrompt`）
- Modify: `web/src/views/console-view.ts:145-149`（改调 `api.answerPrompt`）
- Modify: `web/src/components/prompt-box.ts:4`（改注释）
- Modify: `test/fakes/index.ts:14-24`（`FakeTmux` 加 `literal` 与 `sendLiteral`）
- Test: `test/unit/control-plane.test.ts`（加 `answerPrompt` 两个 test）、`test/unit/web-api.test.ts`（兜底文案清单）

**Interfaces:**
- Consumes: `ControlPlane.managedTmuxName`（私有守卫，Task 1 已有）
- Produces: `TmuxAdapter.sendLiteral(name: string, text: string): Promise<void>`；
  `ControlPlane.answerPrompt(id: string, key: string): Promise<void>`；
  `POST /api/sessions/:id/prompt {key}` → 202 `{ok:true}`；`Api.answerPrompt(id, key)`。
  后续任务无依赖（Task 2-8 不碰这条路径）。

- [ ] **Step 1: 写失败的测试**

`test/unit/control-plane.test.ts`，在 `capturePane` / `detectPrompt` 那个 `describe` 里加两个 test
（`plane` / `tmux` 夹具沿用该文件既有 `setup()` 写法，不要新造）：

```ts
  test('answerPrompt 只送字面字符，不追加 Enter', async () => {
    const { plane, tmux, registry } = setup();
    await registry.put({ sessionId: 'S1', tmuxSession: 'ls-S1', cwd: '/tmp', kernel: 'claude' } as any);
    tmux.sessions.set('ls-S1', { cwd: '/tmp', command: [] });
    await plane.answerPrompt('S1', '2');
    expect(tmux.literal).toEqual([{ name: 'ls-S1', text: '2' }]);
    expect(tmux.sent).toEqual([]);
  });

  test('answerPrompt 对外部会话抛 NotControllable、对不存在会话抛 NotFound', async () => {
    const { plane, home } = setup();
    home.live = [{ sessionId: 'EXT' } as any];
    await expect(plane.answerPrompt('EXT', '1')).rejects.toBeInstanceOf(NotControllableError);
    await expect(plane.answerPrompt('NOPE', '1')).rejects.toBeInstanceOf(NotFoundError);
  });
```

注：`setup()` 的返回字段名、`registry.put` 的入参形状、`NotControllableError` / `NotFoundError` 的
导入方式，一律照该文件既有 test 抄；上面是意图，形状对齐现有代码。

- [ ] **Step 2: 跑测试确认它失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/control-plane.test.ts
```
Expected: FAIL —— `plane.answerPrompt is not a function` / `tmux.literal` 为 undefined。

- [ ] **Step 3: 扩 fake**

`test/fakes/index.ts` 的 `FakeTmux`：在 `sent` 下加一行字段，在 `sendText` 下加一个方法。

```ts
  literal: { name: string; text: string }[] = [];
```

```ts
  async sendLiteral(name: string, text: string) {
    if (!this.sessions.has(name)) throw new Error('no session ' + name);
    this.literal.push({ name, text });
  }
```

- [ ] **Step 4: 加端口与适配器实现**

`src/ports/index.ts`，紧跟 `sendText` 那一行之后：

```ts
  sendLiteral(name: string, text: string): Promise<void>;  // 字面字符, 不追加 Enter: send-keys -l
```

`src/adapters/tmux.ts`，紧跟 `sendText` 方法之后：

```ts
  // send-keys -l 关掉键名查找、按字面 UTF-8 处理, 因此发不出 Escape/Up/Enter, 只能送字面字符。
  async sendLiteral(name: string, text: string): Promise<void> {
    await this.run(['send-keys', '-l', '-t', name, text]);
  }
```

- [ ] **Step 5: 加领域方法**

`src/domain/control-plane.ts`，紧跟 `detectPrompt` 之后：

```ts
  // 应答交互选择器：只送字面字符(编号)，不追加 Enter。
  async answerPrompt(id: string, key: string): Promise<void> {
    await this.d.tmux.sendLiteral(await this.managedTmuxName(id), key);
  }
```

- [ ] **Step 6: 跑测试确认它通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/control-plane.test.ts
```
Expected: PASS。

- [ ] **Step 7: 加路由**

`src/server/routes.ts`：把 `// 交互选择器：只读识别；应答走 send 通道。` 改成
`// 交互选择器：只读识别 + 字面应答(不追加 Enter)。`；在 `GET /api/sessions/:id/prompt` 那一行之后加

```ts
  app.post('/api/sessions/:id/prompt', (req, reply) =>
    wrap(reply, async () => { await plane.answerPrompt((req.params as any).id, (req.body as any).key); return { ok: true }; }, 202));
```

- [ ] **Step 8: 改前端**

`web/src/core/api.ts`：在 `Api` 接口里 `sendSessionMessage` 附近加

```ts
  answerPrompt(id: string, key: string): Promise<void>;
```

实现对象里对应位置加（`post` 帮手与 `sendSessionMessage` 同款，路径照该文件既有拼法）：

```ts
  answerPrompt: (id, key) => post<void>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { key }),
```

`web/src/views/console-view.ts:146`：`await api.sendSessionMessage(id, key);` → `await api.answerPrompt(id, key);`

`web/src/components/prompt-box.ts:4` 注释改成

```ts
// 选项按钮只发数字（已验证权限框数字即确认）：走 send-keys -l 字面通道，不追加 Enter。
```

`test/unit/web-api.test.ts`：若 `answerPrompt` 落在该文件断言的兜底文案/方法清单里，同步补上；
该文件头注释里的条数说明要与实际断言数一致。

- [ ] **Step 9: 两个类型检查 + 全量测试**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 三条都 PASS。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat(control): 应答交互选择器改走 send-keys -l 字面通道，不追加 Enter"
```

#### 复审补丁（Step 11-14）

修订 A 的复审给出两个 Important 与一个 Minor，处置如下。

**Important #1 —— `key` 里的前导 `-` 会被 tmux getopt 当选项。** `POST {"key":"-R"}` 会拼成
`send-keys -l -t <name> -R`，`-R` 被吃成 flag。用 `--` 终止选项解析修掉，已实测：
`tmux send-keys -l -t p -- '-R'` 退出 0，且交付到 pane 的是字面字节 `2d 52`（"-R"）。

复审同时建议在 `answerPrompt` 里加 `/^\d{1,3}$/` 校验。**不做**，理由：加了 `--` 之后任意字符串都只是
字面字符落进 pane 的 tty 行缓冲，且不发 Enter、不会执行；而同一套鉴权下 `POST /messages` 本来就能塞
任意文本**并且**替你按回车。数字校验拦住的是一个危害严格小于既有端点的场景，属于「为不会造成后果的
情形加校验」。设计里那句「只能送字面字符」由 `--` 本身兑现。

**Important #2 —— 新路由没有 HTTP 级测试。** `api.ts` 发 `{key}` 与 `routes.ts` 读 `.key` 若字段错配，
单测全绿而运行时 500。补两条 inject。

**Minor #3 —— 「不追加 Enter」只在 fake 边界被断言。** 提到现在做：`vitest.config.ts` 的
`include: ['test/**/*.test.ts']` 让 `test/integration/tmux.test.ts` 进默认 run，那里已有真 tmux +
`cat >> OUT` 夹具，可以把「没有 `0x0d`」钉成自动化断言（也契合本项目「交互功能要有自动化验证手段」）。

- [ ] **Step 11: `--` 终止选项解析**

`src/adapters/tmux.ts` 的 `sendLiteral`：

```ts
  // send-keys -l 关掉键名查找、按字面 UTF-8 处理, 因此发不出 Escape/Up/Enter, 只能送字面字符。
  // `--` 终止选项解析, 否则前导 `-` 的 text(如 "-R")会被 getopt 当 flag 吃掉。
  async sendLiteral(name: string, text: string): Promise<void> {
    await this.run(['send-keys', '-l', '-t', name, '--', text]);
  }
```

- [ ] **Step 12: 真 tmux 上钉死「不追加 Enter」**

`test/integration/tmux.test.ts` 加一个**独立会话名与独立 OUT 路径**的 `it`（不要复用现有 `NAME` / `OUT`，
现有那条测试结尾会 kill 掉会话）。断言链条：`sendLiteral` 后 `cat` 收不到任何东西（字符还压在 tty 行
缓冲里，说明没有换行/回车被送达），而 `capturePane` 已经能看到它；随后用 `sendText` 补一次真回车，
两段字符应作为**同一行**被交付。

```ts
  it('sendLiteral 不追加 Enter（真 tmux 字节级）', async () => {
    const name = NAME + '-lit';
    const out = OUT + '-lit';
    try {
      await tmux.newSession(name, process.cwd(), ['sh', '-c', `cat >> ${out}`]);
      await tmux.sendLiteral(name, 'abc');
      await new Promise(r => setTimeout(r, 500));
      // 没有回车 => cat 的行缓冲不 flush => 文件根本没被创建/仍为空
      expect(existsSync(out) ? readFileSync(out, 'utf8') : '').toBe('');
      expect(await tmux.capturePane(name)).toContain('abc');
      // 补一次带回车的发送 => 两段字符同一行交付, 证明 abc 之后确实没有过换行
      await tmux.sendText(name, 'def');
      await new Promise(r => setTimeout(r, 500));
      expect(readFileSync(out, 'utf8')).toBe('abcdef\n');
    } finally {
      try { await tmux.killSession(name); } catch { /* ignore */ }
      try { if (existsSync(out)) rmSync(out); } catch { /* ignore */ }
    }
  });
```

- [ ] **Step 13: 路由组件测试**

`test/component/routes.test.ts` 的 `describe('mutations (C2)')` 里加两条，形状照该 describe 现有两条
（`app()` 帮手、`h` 头、`fastify.inject`）：

```ts
  it('prompt answer returns 202 and reaches the plane literally', async () => {
    const { fastify, plane } = await app();
    const h = { authorization: 'Bearer secret' };
    const c = await fastify.inject({ method: 'POST', url: '/api/sessions', headers: h, payload: { cwd: '/w' } });
    const id = c.json().sessionId;
    const r = await fastify.inject({ method: 'POST', url: `/api/sessions/${id}/prompt`, headers: h, payload: { key: '2' } });
    expect(r.statusCode).toBe(202);
    expect((plane as any).d.tmux.literal.at(-1).text).toBe('2');   // 字段错配会在这里暴露
  });
  it('prompt answer maps domain errors (404)', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'POST', url: '/api/sessions/nope/prompt', headers: { authorization: 'Bearer secret' }, payload: { key: '1' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
```

`plane as any` 那行若与该文件既有风格不符（例如 `app()` 可以顺手把 `tmux` 一起返回），改成返回
`tmux` 更好；关键是必须断言到达的 `text` 等于 `'2'`，光断 202 抓不住字段错配。

- [ ] **Step 14: 全量绿 + 提交**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 三条都 PASS（integration 的 tmux 测试需要本机有 tmux，本项目一直如此）。

```bash
git add -A
git commit -m "fix(control): sendLiteral 用 -- 终止选项解析，补路由与真 tmux 字节级测试"
```

---

### Task 2: 两个端口 + ClaudeSource

把 `ClaudeHomeAdapter` 拆成 `AgentSource` / `ControllableSource`，`claude-home.ts` 的 body 迁进 `sources/base.ts` + `sources/claude.ts`，并让 `kernel` / `adoptable` 贯通类型层。本任务结束时系统仍只有一个 source，但已经是 kernel-aware 的。

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/ports/index.ts:16-27`
- Create: `src/adapters/sources/base.ts`
- Create: `src/adapters/sources/claude.ts`
- Delete: `src/adapters/claude-home.ts`
- Modify: `src/domain/session-discovery.ts`
- Modify: `src/adapters/managed-registry.ts`
- Modify: `src/domain/control-plane.ts`（最小适配：`Deps.home` 类型、`buildSummaries` 多一个入参、registry 写入带 `kernel`）
- Modify: `src/cli.ts:12`
- Modify: `test/fakes/index.ts:34-46`（`FakeClaudeHome` → `FakeSource`）
- Modify: `FakeClaudeHome` 的其余 8 个引用方，纯机械改名（`tsc --noEmit` 会全部报出来）：
  `test/unit/control-mcp.test.ts`、`test/unit/linker.test.ts`、`test/unit/conductor.test.ts`、
  `test/integration/im-linker-e2e.test.ts`、`test/component/static.test.ts`、
  `test/component/agent-routes.test.ts`、`test/component/routes.test.ts`、
  `test/component/compose.test.ts`、`test/component/devices.test.ts`
- Create: `test/unit/sources.test.ts`
- Modify: `test/unit/session-discovery.test.ts`、`test/unit/control-plane.test.ts:44-49`
- Rename: `test/integration/claude-home.test.ts` → `test/integration/claude-source.test.ts`
- Modify: `test/integration/loop.test.ts:26,28`

**Interfaces:**
- Consumes: Task 1 产出的 `PendingActionKind`（无 `'keys'`）
- Produces:
  - `src/domain/types.ts`：`export type Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide';`、`export interface CreateSessionOptions { cwd: string; kernel?: Kernel; name?: string; model?: string; permissionMode?: string; initialPrompt?: string }`、`LiveSession` 增 `kernel: Kernel` 且 `pid` 变可选、`SessionSummary` 增 `kernel: Kernel` 与 `adoptable: boolean`
  - `src/ports/index.ts`：`AgentSource`、`ControllableSource`、`isControllable(s: AgentSource): s is ControllableSource`、`ManagedEntry` 增 `kernel: Kernel`
  - `src/adapters/sources/base.ts`：`isPidAlive(pid: number): boolean`、`isSafeSessionId(id: string): boolean`、`safeReaddir(dir: string): string[]`、`flatSessionIdForPath(changedPath: string): string | null`、`abstract class ProjectsSource implements AgentSource`（`protected home`、`protected projectsDir`、`protected candidatePaths(sessionId): string[]`）、`abstract class CliSource extends ProjectsSource implements ControllableSource`（构造 `(home: string, bin: string, permissionMode?: string)`）
  - `src/adapters/sources/claude.ts`：`class ClaudeSource extends CliSource`，`readonly kernel = 'claude' as const`
  - `src/domain/session-discovery.ts`：`toLiveSession(raw, kernel: Kernel, isPidAlive)`、`ManagedShape` 增 `kernel: Kernel`、`buildSummaries({ live, managed, tmuxNames, activity, adoptable: Set<Kernel> })`
  - `test/fakes/index.ts`：`class FakeSource implements ControllableSource`

- [ ] **Step 1: 写失败的测试 —— 路径归属与命令行方言**

新建 `test/unit/sources.test.ts`：

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeSource } from '../../src/adapters/sources/claude.js';
import { flatSessionIdForPath } from '../../src/adapters/sources/base.js';
import { isControllable } from '../../src/ports/index.js';

const home = () => mkdtempSync(join(tmpdir(), 'ls-src-'));

describe('flatSessionIdForPath', () => {
  test('平铺的 jsonl 取文件名主体', () => {
    expect(flatSessionIdForPath('-Users-l-dev-foo/abc-123.jsonl')).toBe('abc-123');
  });
  test('绝对路径同样有效', () => {
    expect(flatSessionIdForPath('/Users/l/.qoder/projects/-Users-l/abc.jsonl')).toBe('abc');
  });
  test('transcript/ 下的转录不归自己', () => {
    expect(flatSessionIdForPath('-Users-l/transcript/abc.jsonl')).toBeNull();
  });
  test('非 jsonl 返回 null', () => {
    expect(flatSessionIdForPath('-Users-l/abc.json')).toBeNull();
  });
});

describe('ClaudeSource', () => {
  test('kernel 是 claude 且可控', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.kernel).toBe('claude');
    expect(isControllable(s)).toBe(true);
  });

  test('launchCommand 带上 claude 方言的权限模式', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['claude', '--session-id', 'sid', '--permission-mode', 'bypassPermissions']);
  });

  test('opts.permissionMode 覆盖构造时的默认值', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.launchCommand('sid', { cwd: '/tmp', permissionMode: 'plan' }))
      .toEqual(['claude', '--session-id', 'sid', '--permission-mode', 'plan']);
  });

  test('resumeCommand 用 --resume', () => {
    const s = new ClaudeSource(home(), 'claude', 'bypassPermissions');
    expect(s.resumeCommand('ext'))
      .toEqual(['claude', '--resume', 'ext', '--permission-mode', 'bypassPermissions']);
  });

  test('注入的权限模式取值可以是 qodercli 方言', () => {
    const s = new ClaudeSource(home(), 'qodercli', 'bypass_permissions');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['qodercli', '--session-id', 'sid', '--permission-mode', 'bypass_permissions']);
  });

  test('readLiveSessions 只报 pid 还活着的会话，且带 kernel', async () => {
    const h = home();
    mkdirSync(join(h, 'sessions'), { recursive: true });
    writeFileSync(join(h, 'sessions', 'a.json'),
      JSON.stringify({ sessionId: 'a', pid: process.pid, cwd: '/tmp/a' }));
    writeFileSync(join(h, 'sessions', 'b.json'),
      JSON.stringify({ sessionId: 'b', pid: 99999999, cwd: '/tmp/b' }));
    const live = await new ClaudeSource(h, 'claude').readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['a']);
    expect(live[0]!.kernel).toBe('claude');
  });

  test('locateTranscript 拒绝越界 sessionId', async () => {
    const h = home();
    mkdirSync(join(h, 'projects', '-Users-l'), { recursive: true });
    writeFileSync(join(h, 'projects', 'evil.jsonl'), '{}');
    expect(await new ClaudeSource(h, 'claude').locateTranscript('../evil')).toBeNull();
  });
});
```

`readLiveSessions` 那条测试里 `sessions/*.json` 的字段名要跟现有 `src/adapters/claude-home.ts` 读的字段对齐 —— 动手前读一遍 `toLiveSession`（`src/domain/session-discovery.ts`）确认 `sessionId` / `pid` / `cwd` 的实际键名，按实际键名写夹具。

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/adapters/sources/claude.js'`。

- [ ] **Step 3: 加 `Kernel` / `CreateSessionOptions`，并让类型带上 kernel**

`src/domain/types.ts`：

```ts
export type Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide';

export interface CreateSessionOptions {
  cwd: string;
  kernel?: Kernel;
  name?: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
}
```

同文件：`LiveSession` 增 `kernel: Kernel;`，并把 `pid: number` 改成 `pid?: number`（桌面 source 没有 pid）；`SessionSummary` 增 `kernel: Kernel;` 与 `adoptable: boolean;`。

- [ ] **Step 4: 把 `ClaudeHomeAdapter` 换成两个协议**

`src/ports/index.ts`：把 import 改成 `import type { CreateSessionOptions, Kernel, LiveSession, PendingAction } from '../domain/types.js';`，加 `export type { Kernel };`，把 `ClaudeHomeAdapter`（:16-22）整段换成

```ts
export interface AgentSource {
  readonly kernel: Kernel;
  readLiveSessions(): Promise<LiveSession[]>;
  locateTranscript(sessionId: string): Promise<string | null>;
  readTranscript(path: string): Promise<string[]>;
  readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }>;
  watchProjects(cb: (changedPath: string) => void): () => void;
  sessionIdForPath(changedPath: string): string | null;
}

export interface ControllableSource extends AgentSource {
  launchCommand(sessionId: string, opts: CreateSessionOptions): string[];
  resumeCommand(sessionId: string): string[];
}

export function isControllable(s: AgentSource): s is ControllableSource {
  return typeof (s as ControllableSource).launchCommand === 'function';
}
```

并给 `ManagedEntry`（:24-27）加 `kernel: Kernel;`。

- [ ] **Step 5: 写 `sources/base.ts`**

新建 `src/adapters/sources/base.ts`：

```ts
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { CreateSessionOptions, Kernel, LiveSession } from '../../domain/types.js';
import type { AgentSource, ControllableSource } from '../../ports/index.js';

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; }
}

// sessionId 来自 HTTP path 参数并会被拼进文件路径，这里挡住 ../ 与分隔符。
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

export function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function flatSessionIdForPath(changedPath: string): string | null {
  const parts = changedPath.split('/').filter(Boolean);
  const file = parts.at(-1);
  if (!file || !file.endsWith('.jsonl')) return null;
  if (parts.at(-2) === 'transcript') return null;
  return file.slice(0, -'.jsonl'.length);
}

export abstract class ProjectsSource implements AgentSource {
  abstract readonly kernel: Kernel;
  protected readonly projectsDir: string;

  constructor(protected readonly home: string) {
    this.projectsDir = join(home, 'projects');
  }

  abstract readLiveSessions(): Promise<LiveSession[]>;
  abstract sessionIdForPath(changedPath: string): string | null;

  protected candidatePaths(sessionId: string): string[] {
    return safeReaddir(this.projectsDir).map(d => join(this.projectsDir, d, `${sessionId}.jsonl`));
  }

  async locateTranscript(sessionId: string): Promise<string | null> {
    if (!isSafeSessionId(sessionId)) return null;
    for (const p of this.candidatePaths(sessionId)) if (existsSync(p)) return p;
    return null;
  }

  async readTranscript(path: string): Promise<string[]> {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  }

  async readTranscriptFrom(path: string, byteOffset: number): Promise<{ lines: string[]; offset: number }> {
    const buf = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const slice = buf.subarray(byteOffset).toString('utf8');
    return { lines: slice.split('\n').filter(Boolean), offset: buf.length };
  }

  watchProjects(cb: (changedPath: string) => void): () => void {
    if (!existsSync(this.projectsDir)) return () => {};
    const w = watch(this.projectsDir, { recursive: true }, (_e, fname) => { if (fname) cb(String(fname)); });
    return () => w.close();
  }
}

export abstract class CliSource extends ProjectsSource implements ControllableSource {
  constructor(home: string, private readonly bin: string, private readonly permissionMode?: string) {
    super(home);
  }

  launchCommand(sessionId: string, opts: CreateSessionOptions): string[] {
    const cmd = [this.bin, '--session-id', sessionId];
    if (opts.model) cmd.push('--model', opts.model);
    const mode = opts.permissionMode ?? this.permissionMode;
    if (mode) cmd.push('--permission-mode', mode);
    if (opts.name) cmd.push('--name', opts.name);
    return cmd;
  }

  resumeCommand(sessionId: string): string[] {
    const cmd = [this.bin, '--resume', sessionId];
    if (this.permissionMode) cmd.push('--permission-mode', this.permissionMode);
    return cmd;
  }

  sessionIdForPath(changedPath: string): string | null {
    return flatSessionIdForPath(changedPath);
  }
}
```

`locateTranscript` / `readTranscript` / `readTranscriptFrom` / `watchProjects` 四个 body 与 `isPidAlive` 是从 `src/adapters/claude-home.ts` 原样搬来的，行为不变。`launchCommand` 是从 `src/domain/control-plane.ts:108-121` 搬来的：**push 顺序照抄那段代码**，`test/unit/control-plane.test.ts:34` 与 `:41` 的既有期望数组是判据 —— 若顺序不符导致那两条既有测试失败，以既有测试为准调整这里的 push 顺序（这是纯搬迁，不改行为）。

- [ ] **Step 6: 写 `sources/claude.ts` 并删掉 `claude-home.ts`**

新建 `src/adapters/sources/claude.ts`：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { toLiveSession } from '../../domain/session-discovery.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

export class ClaudeSource extends CliSource {
  readonly kernel = 'claude' as const;

  async readLiveSessions(): Promise<LiveSession[]> {
    const dir = join(this.home, 'sessions');
    const out: LiveSession[] = [];
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.json')) continue;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      const s = toLiveSession(raw as any, 'claude', isPidAlive);
      if (s) out.push(s);
    }
    return out;
  }
}
```

动手前把 `src/adapters/claude-home.ts` 的 `readLiveSessions` 读一遍逐项比对：目录、文件名过滤、异常吞掉的位置若与上面不同，**以现有实现为准**（这是纯搬迁，`test/integration/claude-source.test.ts` 是判据）。搬完后 `git rm src/adapters/claude-home.ts`。

- [ ] **Step 7: `session-discovery` 带上 kernel 与 adoptable**

`src/domain/session-discovery.ts`：
- `toLiveSession(raw: any, isPidAlive: …)` → `toLiveSession(raw: any, kernel: Kernel, isPidAlive: …)`，返回对象里加 `kernel`。
- `interface ManagedShape` 加 `kernel: Kernel;`。
- `buildSummaries` 入参对象加 `adoptable: Set<Kernel>;`；循环体里在拿到 `l`（live）与 `m`（managed）之后加 `const kernel = l?.kernel ?? m!.kernel;`（id 集合是 live ∪ managed，两者必有其一），并在返回的 summary 对象里加 `kernel,` 与 `adoptable: adoptable.has(kernel),`。
- 排序表达式不动。

- [ ] **Step 8: registry 迁移旧条目**

`src/adapters/managed-registry.ts` 的 `private read()`：

```ts
  private read(): ManagedEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as ManagedEntry[];
      return rows.map(r => ({ ...r, kernel: r.kernel ?? 'claude' }));
    } catch { return []; }
  }
```

- [ ] **Step 9: `ControlPlane` 最小适配（仍是单 source）**

`src/domain/control-plane.ts`：
- import 与 `Deps`：`home: ClaudeHomeAdapter` → `home: AgentSource`（从 `../ports/index.js` 引 `AgentSource` 与 `isControllable`）。
- `listSessions()` 里 `buildSummaries({ … })` 加一项

```ts
      adoptable: isControllable(this.d.home) ? new Set([this.d.home.kernel]) : new Set(),
```

（注明类型：`new Set<Kernel>([...])`，避免推断成 `Set<never>`。）
- `createSession` 与 `adoptSession` 里写 registry 的地方，条目加 `kernel: this.d.home.kernel,`。
- 其余不动（`claudeBin` 硬编码留到 Task 3 再拆）。

`src/cli.ts:12`：`home: new ClaudeHome(cfg.paths.claudeHome)` → `home: new ClaudeSource(cfg.paths.claudeHome, <buildPlane 里现有的 claudeBin 表达式>, <现有的 sessionPermissionMode 表达式>)`，import 换成 `ClaudeSource`。`Deps.claudeBin` / `Deps.sessionPermissionMode` 仍保留（Task 3 才删），所以此处两个参数是**同一个表达式传两遍**，Task 3 会清掉。

- [ ] **Step 10: 改 fake 与既有测试**

`test/fakes/index.ts`：把 `FakeClaudeHome`（:34-46）改名为 `FakeSource implements ControllableSource`，三个字段（`live` / `transcripts` / `paths`）与四个读方法的 body **原样保留**，新增：

```ts
  constructor(
    readonly kernel: Kernel = 'claude',
    private readonly bin = 'claude',
    private readonly permissionMode = 'bypassPermissions',
  ) {}

  watched: ((changedPath: string) => void)[] = [];
  watchProjects(cb: (changedPath: string) => void): () => void {
    this.watched.push(cb);
    return () => { this.watched = this.watched.filter(x => x !== cb); };
  }
  sessionIdForPath(p: string): string | null { return flatSessionIdForPath(p); }
  launchCommand(sessionId: string, opts: CreateSessionOptions): string[] {
    const cmd = [this.bin, '--session-id', sessionId];
    if (opts.model) cmd.push('--model', opts.model);
    const mode = opts.permissionMode ?? this.permissionMode;
    if (mode) cmd.push('--permission-mode', mode);
    if (opts.name) cmd.push('--name', opts.name);
    return cmd;
  }
  resumeCommand(sessionId: string): string[] {
    return [this.bin, '--resume', sessionId, '--permission-mode', this.permissionMode];
  }
```

`live` 数组里的元素现在需要 `kernel` 字段 —— 各测试里构造 `live` 的地方补 `kernel: 'claude'`。

`test/unit/session-discovery.test.ts`：6 处 `toLiveSession` / `buildSummaries` 调用补 `kernel` 实参与 `adoptable: new Set(['claude'])`；`ManagedShape` 夹具补 `kernel: 'claude'`。

`test/unit/control-plane.test.ts`：把 `explicit opts.permissionMode overrides the configured default`（:44-49）删掉 —— 它已经在 `test/unit/sources.test.ts` 里以 `launchCommand` 的形式覆盖。所有 `new ControlPlane({ home: new FakeClaudeHome() … })` 改成 `new FakeSource()`。

`test/integration/claude-home.test.ts` → `git mv` 成 `test/integration/claude-source.test.ts`，`new ClaudeHome(home)` → `new ClaudeSource(home, 'claude')`。
`test/integration/loop.test.ts:26,28`：同样两处替换。

其余 10 处 `new ControlPlane({...})` 只需把 `home: new FakeClaudeHome()` 改成 `home: new FakeSource()`。

- [ ] **Step 11: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 全 PASS。

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "refactor(ports): 拆出 AgentSource/ControllableSource 两个协议，claude-home 迁为 ClaudeSource"
```

---

### Task 3: ControlPlane 多 source 化

`Deps.home` → `Deps.sources: AgentSource[]`；`claudeBin` / `sessionPermissionMode` 下移到 source 构造参数（领域层不再知道任何可执行文件路径）；顺手删掉从未被读过的 `Deps.tmuxSocket`。命令行方言改由 source 生成，只读内核抛 `NotControllableError`。

**Files:**
- Modify: `src/domain/control-plane.ts`（主要改动）
- Modify: `src/mcp/control-mcp.ts:78,83`（create 两个 schema 加可选 `kernel`）
- Modify: `src/server/routes.ts`（`POST /api/sessions` 透传 `kernel`）
- Modify: `src/cli.ts:11-22`（`buildPlane`）
- Modify: `test/fakes/index.ts`（加 `FakeReadonlySource`）
- Modify: 全部 12 处 `new ControlPlane({...})`：`src/cli.ts:12`、`test/unit/control-plane.test.ts:16-21`、`test/unit/control-mcp.test.ts:7-10`、`test/unit/conductor.test.ts:10-13`、`test/unit/linker.test.ts:13-16`、`test/integration/im-linker-e2e.test.ts:36-39`、`test/component/routes.test.ts:8-11`、`test/component/devices.test.ts:8-11`、`test/component/agent-routes.test.ts:10-13`、`test/component/static.test.ts:11-14`、`test/component/compose.test.ts:11-14` 与 `:25-28`
- Test: `test/unit/control-plane.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AgentSource` / `ControllableSource` / `isControllable` / `Kernel` / `CreateSessionOptions` / `FakeSource`
- Produces:
  - `ControlPlane` 的 `Deps`：`{ tmux, sources: AgentSource[], registry, clock, newSessionId, pollIntervalMs?, readonlyPollIntervalMs?, killProcess? }`（**移除** `home`、`claudeBin`、`tmuxSocket`、`sessionPermissionMode`）
  - `ControlPlane.createSession(opts: CreateSessionOptions)`
  - `test/fakes/index.ts`：`class FakeReadonlySource implements AgentSource`

- [ ] **Step 1: 写失败的测试 —— 多 source 合并、方言分派、只读拒绝**

`test/fakes/index.ts` 先加一个只读 fake（复用 `FakeSource` 的字段，**不**实现 `launchCommand` / `resumeCommand`）：

```ts
export class FakeReadonlySource implements AgentSource {
  constructor(readonly kernel: Kernel) {}
  live: LiveSession[] = [];
  async readLiveSessions() { return this.live; }
  async locateTranscript() { return null; }
  async readTranscript() { return []; }
  async readTranscriptFrom() { return { lines: [], offset: 0 }; }
  watched: ((changedPath: string) => void)[] = [];
  watchProjects(cb: (changedPath: string) => void) { this.watched.push(cb); return () => {}; }
  sessionIdForPath(p: string) { return flatSessionIdForPath(p); }
}
```

`test/unit/control-plane.test.ts` 追加（`mk()` 之类的构造帮手沿用该文件现有写法，只把 `home: …` 换成 `sources: [...]`）：

```ts
test('listSessions 合并多个 source 的会话并带上各自 kernel', async () => {
  const cc = new FakeSource('claude');
  const q = new FakeSource('qodercli', 'qodercli', 'bypass_permissions');
  cc.live = [{ sessionId: 'a', kernel: 'claude', cwd: '/tmp/a', status: 'idle', pid: 1 }];
  q.live = [{ sessionId: 'b', kernel: 'qodercli', cwd: '/tmp/b', status: 'busy', pid: 2 }];
  const { plane } = mk({ sources: [cc, q] });
  const list = await plane.listSessions();
  expect(list.map(x => `${x.sessionId}:${x.kernel}`).sort()).toEqual(['a:claude', 'b:qodercli']);
});

test('createSession 用目标 source 的方言拼命令', async () => {
  const cc = new FakeSource('claude');
  const q = new FakeSource('qodercli', 'qodercli', 'bypass_permissions');
  const { plane, tmux } = mk({ sources: [cc, q] });
  const s = await plane.createSession({ cwd: '/tmp', kernel: 'qodercli' });
  expect(tmux.sessions[0]!.cmd)
    .toEqual(['qodercli', '--session-id', s.sessionId, '--permission-mode', 'bypass_permissions']);
});

test('createSession 对只读内核抛 NotControllableError', async () => {
  const { plane } = mk({ sources: [new FakeSource('claude'), new FakeReadonlySource('qoderwork')] });
  await expect(plane.createSession({ cwd: '/tmp', kernel: 'qoderwork' }))
    .rejects.toBeInstanceOf(NotControllableError);
});

test('adoptSession 对只读内核的活会话同样抛 NotControllableError', async () => {
  const ro = new FakeReadonlySource('qoder-ide');
  ro.live = [{ sessionId: 'ide1', kernel: 'qoder-ide', cwd: '/tmp/x', status: 'idle' }];
  const { plane } = mk({ sources: [new FakeSource('claude'), ro] });
  await expect(plane.adoptSession('ide1')).rejects.toBeInstanceOf(NotControllableError);
});

test('summarize 把只读内核的会话标成 adoptable: false', async () => {
  const ro = new FakeReadonlySource('qoderwork');
  ro.live = [{ sessionId: 'w1', kernel: 'qoderwork', cwd: '/tmp/w', status: 'idle' }];
  const { plane } = mk({ sources: [new FakeSource('claude'), ro] });
  const x = (await plane.listSessions()).find(s => s.sessionId === 'w1');
  expect(x?.adoptable).toBe(false);
});

test('getMessages 对完全未知的 id 返回空数组', async () => {
  const { plane } = mk({ sources: [new FakeSource('claude')] });
  expect(await plane.getMessages('nope')).toEqual([]);
});

test('start 给每个 source 各装一个 watcher，按 sessionIdForPath 归属', async () => {
  const cc = new FakeSource('claude');
  const ro = new FakeReadonlySource('qoderwork');
  const { plane } = mk({ sources: [cc, ro] });
  await plane.start();
  expect(cc.watched.length).toBe(1);
  expect(ro.watched.length).toBe(1);
  plane.stop();
});
```

`tmux.sessions[0]!.cmd` 的取法沿用该文件既有的命令断言写法（`:34` / `:41` 那两条）；`NotControllableError` 从现有 import 处取。`mk()` 若不存在，就按该文件现有的构造方式逐个 `new ControlPlane({...})`。

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/control-plane.test.ts
```
Expected: FAIL —— `sources` 不是 `Deps` 的合法字段（类型报错）/ 新增的 7 条测试全红。

- [ ] **Step 3: 换 `Deps` 与成员，构造函数建 kernel 索引**

`src/domain/control-plane.ts`：

```ts
interface Deps {
  tmux: TmuxAdapter;
  sources: AgentSource[];
  registry: ManagedRegistry;
  clock: Clock;
  newSessionId: () => string;
  pollIntervalMs?: number;
  readonlyPollIntervalMs?: number;
  killProcess?: (pid: number) => void;
}
```

成员：把 `private lastSeen = new Set<string>()` 换成 `private readonly lastSeen = new Map<Kernel, Set<string>>()`，把 `private timer?: …` / `private unwatch?: …` 换成

```ts
  private readonly byKernel = new Map<Kernel, AgentSource>();
  private readonly kernelOf = new Map<string, Kernel>();
  private timers: NodeJS.Timeout[] = [];
  private unwatchers: (() => void)[] = [];
```

`emittedUuids` 不动。在现有构造函数 body 开头加一行（签名不变）：

```ts
    for (const s of d.sources) this.byKernel.set(s.kernel, s);
```

- [ ] **Step 4: 加三个私有解析方法**

```ts
  private async sourceOf(id: string): Promise<AgentSource> {
    const cached = this.kernelOf.get(id);
    if (cached) { const s = this.byKernel.get(cached); if (s) return s; }
    const entry = this.d.registry.get(id);
    if (entry) {
      const s = this.byKernel.get(entry.kernel);
      if (s) { this.kernelOf.set(id, s.kernel); return s; }
    }
    // 转录探测先于 live 枚举：qodercli 的 readLiveSessions 要走一遍整棵 logs/sessions。
    for (const s of this.d.sources) {
      if (await s.locateTranscript(id)) { this.kernelOf.set(id, s.kernel); return s; }
    }
    for (const s of this.d.sources) {
      const live = await s.readLiveSessions();
      if (live.some(l => l.sessionId === id)) { this.kernelOf.set(id, s.kernel); return s; }
    }
    throw new NotFoundError(id);
  }

  private async isLive(id: string): Promise<boolean> {
    for (const s of this.d.sources) {
      const live = await s.readLiveSessions();
      if (live.some(l => l.sessionId === id)) return true;
    }
    return false;
  }
```

`new NotFoundError(id)` 的实参写法照抄本文件现有的 `NotFoundError` 抛出点（`:79-87` 那一段）。

- [ ] **Step 5: `activityMap` 改吃 `Map<string, Kernel>`**

把签名从 `(ids: string[])` 换成 `(ids: Map<string, Kernel>)`，循环头换成 `for (const [id, kernel] of ids)`，循环体里两处 `this.d.home` 换成

```ts
      const src = this.byKernel.get(kernel);
      if (!src) continue;
```

之后的 `src.locateTranscript(id)` / `src.readTranscript(...)`。其余逻辑（时间戳取法）不动。

- [ ] **Step 6: `listSessions` 拆成 `summarize(sources)`**

把现有 `listSessions()` 的 body 整段移进 `private async summarize(sources: AgentSource[]): Promise<SessionSummary[]>`，做 5 处替换：

1. body 开头加 `const kernels = new Set(sources.map(s => s.kernel));`
2. `const live = await this.d.home.readLiveSessions();` → `const live = (await Promise.all(sources.map(s => s.readLiveSessions()))).flat();`
3. `this.d.registry.list()` → `this.d.registry.list().filter(m => kernels.has(m.kernel))`
4. 原先传给 `activityMap` 的 id 列表换成一个去重 map（live 覆盖 managed），并顺手把归属写进缓存：

```ts
    const ids = new Map<string, Kernel>();
    for (const m of managed) ids.set(m.sessionId, m.kernel);
    for (const l of live) ids.set(l.sessionId, l.kernel);
    for (const [id, k] of ids) this.kernelOf.set(id, k);
```

5. Task 2 Step 9 加进 `buildSummaries({ … })` 的那一行

```ts
      adoptable: isControllable(this.d.home) ? new Set([this.d.home.kernel]) : new Set(),
```

换成按传入的这组 source 算：

```ts
      adoptable: new Set<Kernel>(sources.filter(isControllable).map(s => s.kernel)),
```

然后

```ts
  async listSessions(): Promise<SessionSummary[]> { return this.summarize(this.d.sources); }
```

`getSession(id)` 保持基于 `listSessions()` 的既有实现不变 —— 多 source 合并后它自动覆盖四个内核。

- [ ] **Step 7: `managedTmuxName` / `getMessages` / `resolveCwd` / `ingestTranscript`**

- `managedTmuxName(id)`：里面判 live 的那句 `this.d.home.readLiveSessions()` 换成 `await this.isLive(id)`，其余（registry.get + tmux.hasSession + 两种抛错）不动。
- `resolveCwd(id)` → `resolveCwd(src: AgentSource, id: string)`，body 里 `this.d.home` 换成 `src`；调用点（`createSession` / `adoptSession`）相应传入已解析出的 source。
- `getMessages(id)`：body 最前面加

```ts
    let src: AgentSource;
    try { src = await this.sourceOf(id); } catch { return []; }
```

再把原 body 里的 `this.d.home` 全换成 `src`。
- `ingestTranscript(id)` 拆两层：

```ts
  private async ingestTranscript(id: string): Promise<void> {
    let src: AgentSource;
    try { src = await this.sourceOf(id); } catch { return; }
    await this.ingestFrom(src, id);
  }

  private async ingestFrom(src: AgentSource, id: string): Promise<void> {
    // 原 ingestTranscript 的 body，this.d.home 全换成 src。
  }
```

- [ ] **Step 8: `createSession` / `adoptSession` / `archiveSession`**

`createSession(opts: CreateSessionOptions)`（签名从内联对象类型换成这个命名类型），body 开头加：

```ts
    const kernel = opts.kernel ?? 'claude';
    const src = this.byKernel.get(kernel);
    if (!src) throw new NotFoundError(kernel);
    if (!isControllable(src)) throw new NotControllableError(kernel);
```

把 `:112` 的 `const cmd = [this.d.claudeBin, '--session-id', id];` 及其后所有 push（`--model` / `--permission-mode` / `--name`）整段换成

```ts
    const cmd = src.launchCommand(id, opts);
```

registry 写入的条目加 `kernel,`；并在写完后 `this.kernelOf.set(id, kernel);`。

`adoptSession(id)`：body 开头加

```ts
    const src = await this.sourceOf(id);
    if (!isControllable(src)) throw new NotControllableError(src.kernel);
```

把 `:151` 的 `const cmd = [this.d.claudeBin, '--resume', id];` 及其后的 push 整段换成 `const cmd = src.resumeCommand(id);`；registry 条目加 `kernel: src.kernel,`。`if (l.pid)` 那个既有守卫保留（桌面 source 没有 pid，但走不到这里）。

`archiveSession(id)`：`this.lastSeen.delete(id)` → `this.lastSeen.get(entry.kernel)?.delete(id);`（`entry` 是该方法里已取到的 registry 条目；若变量名不同用实际的）。

`NotControllableError` 的实参写法照抄现有抛出点。

- [ ] **Step 9: `pollOnce` / `start` / `stop` 双节拍**

`pollOnce()` 现在（`control-plane.ts:191-197`）是：

```ts
  async pollOnce(): Promise<void> {
    const summaries = await this.listSessions();
    const now = new Set(summaries.map(s => s.sessionId));
    for (const s of summaries) this.emitEvent({ type: 'session.updated', session: s });
    for (const id of this.lastSeen) if (!now.has(id)) this.emitEvent({ type: 'session.removed', sessionId: id });
    this.lastSeen = now;
  }
```

整段替换为（移除判定只在本组内做，否则只读组的 5s 轮询会把可控组的会话误判为消失）：

```ts
  private async pollSources(group: AgentSource[]): Promise<void> {
    const list = await this.summarize(group);
    for (const s of list) this.emitEvent({ type: 'session.updated', session: s });
    for (const src of group) {
      const seen = this.lastSeen.get(src.kernel) ?? new Set<string>();
      const now = new Set(list.filter(x => x.kernel === src.kernel).map(x => x.sessionId));
      for (const id of seen) if (!now.has(id)) this.emitEvent({ type: 'session.removed', sessionId: id });
      this.lastSeen.set(src.kernel, now);
    }
  }
```

再加

```ts
  private async pollOnce(): Promise<void> { await this.pollSources(this.d.sources); }
```

`start()` / `stop()` 整体替换成：

```ts
  async start(): Promise<void> {
    const ctl = this.d.sources.filter(isControllable);
    const ro = this.d.sources.filter(s => !isControllable(s));
    await this.pollOnce();
    if (ctl.length > 0) {
      this.timers.push(setInterval(() => { void this.pollSources(ctl); }, this.d.pollIntervalMs ?? 2000));
    }
    if (ro.length > 0) {
      this.timers.push(setInterval(() => { void this.pollSources(ro); }, this.d.readonlyPollIntervalMs ?? 5000));
    }
    for (const s of this.d.sources) {
      this.unwatchers.push(s.watchProjects((changed) => {
        const id = s.sessionIdForPath(changed);
        if (id) void this.ingestFrom(s, id);
      }));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const u of this.unwatchers) u();
    this.unwatchers = [];
  }
```

原先 `start()` 里那条 `/([0-9a-f-]{36})\.jsonl$/i` 正则随之消失。

- [ ] **Step 10: MCP / routes / cli 的 kernel 透传**

`src/mcp/control-mcp.ts`：`:78` 与 `:83` 两处 create schema 各加

```ts
        kernel: z.enum(['claude', 'qodercli', 'qoderwork', 'qoder-ide']).optional(),
```

`src/server/routes.ts` 的 `POST /api/sessions`：确认 body 是整体透传给 `plane.createSession` 的；若是逐字段取，补上 `kernel: body.kernel`。

`src/cli.ts` 的 `buildPlane`：删掉 `claudeBin` / `tmuxSocket` / `sessionPermissionMode` 三项，`home:` 换成

```ts
    sources: [new ClaudeSource(cfg.paths.claudeHome, cfg.claude.bin, cfg.sessionPermissionMode)],
```

（两个表达式用 Task 2 Step 9 里已经在用的那两个，别新造配置项。）

- [ ] **Step 11: 改剩下 11 处 `new ControlPlane({...})`**

每处把 `home: new FakeSource()` 换成 `sources: [new FakeSource()]`，并删掉 `claudeBin` / `tmuxSocket` / `sessionPermissionMode` 三项（若该处有）。清单见本任务 Files。

- [ ] **Step 12: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 全 PASS。若 `--session-id` 那两条既有命令断言失败，说明 Task 2 Step 5 的 push 顺序搬错了，回去按既有测试修 `CliSource`。

- [ ] **Step 13: 提交**

```bash
git add -A
git commit -m "refactor(control): ControlPlane 改吃 AgentSource[]，命令行方言下移到 source"
```

---

### Task 4: QoderCliSource + segments 解析 + qoder 配置块

第二个可控内核。存活判定用 segments run 名尾部的 `-p<pid>`（**已实测是真实的每进程 pid**，18 个 run pid 互异），cwd 与 busy/idle 用 segments 事件。

**Files:**
- Create: `src/domain/segments.ts`
- Create: `src/adapters/sources/qoder-cli.ts`
- Create: `test/unit/segments.test.ts`
- Modify: `src/config.ts`（加 `qoder` 块，5 个字段一次加全）
- Modify: `src/cli.ts`（`buildPlane` 加第二个 source）
- Modify: `src/domain/pending.ts:5`（`describeAction('create')` 带上 kernel）
- Test: `test/unit/sources.test.ts`（追加 `QoderCliSource` 段）
- Test: `test/unit/pending.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `CliSource` / `isPidAlive` / `safeReaddir`；Task 3 的 `Deps.sources`
- Produces:
  - `src/domain/segments.ts`：`pidFromRunName(runFile: string): number | null`、`parseSegments(lines: string[]): { cwd?: string; status: SessionStatus }`
  - `src/adapters/sources/qoder-cli.ts`：`class QoderCliSource extends CliSource`，`readonly kernel = 'qodercli' as const`，构造 `(home, bin, permissionMode?)`
  - `src/config.ts`：`cfg.qoder = { cliBin, cliPermissionMode, qoderHome, qoderWorkHome, heartbeatTtlMs }`

- [ ] **Step 1: 写失败的测试 —— segments 解析**

新建 `test/unit/segments.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { parseSegments, pidFromRunName } from '../../src/domain/segments.js';

describe('pidFromRunName', () => {
  test('从 run 名尾部取 pid', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd-p12092')).toBe(12092);
  });
  test('run 文件名带 .jsonl 也能取', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd-p12092.jsonl')).toBe(12092);
  });
  test('没有 -p 后缀返回 null', () => {
    expect(pidFromRunName('2026-07-30T16-31-03-abcd')).toBeNull();
  });
});

describe('parseSegments', () => {
  const L = (o: unknown) => JSON.stringify(o);

  test('首行 session.config.loaded 的 project_root 就是 cwd', () => {
    const r = parseSegments([
      L({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/foo', interactive: true } }),
    ]);
    expect(r.cwd).toBe('/Users/l/dev/foo');
  });

  test('末条事件以 .started 结尾判 busy', () => {
    const r = parseSegments([
      L({ type: 'session.phase.finished', data: {} }),
      L({ type: 'model.request.started', data: {} }),
    ]);
    expect(r.status).toBe('busy');
  });

  test('末条事件以 .finished 结尾判 idle', () => {
    const r = parseSegments([
      L({ type: 'model.request.started', data: {} }),
      L({ type: 'model.response.completed', data: {} }),
      L({ type: 'turn.finished', data: { reason: 'end_turn' } }),
    ]);
    expect(r.status).toBe('idle');
  });

  test('非 .started/.finished 的事件不改变状态', () => {
    const r = parseSegments([
      L({ type: 'model.request.started', data: {} }),
      L({ type: 'input.prompt.received', data: {} }),
    ]);
    expect(r.status).toBe('busy');
  });

  test('坏行跳过而不抛', () => {
    const r = parseSegments(['not json', L({ type: 'turn.finished', data: {} })]);
    expect(r.status).toBe('idle');
  });

  test('没有任何事件时默认 idle 且无 cwd', () => {
    expect(parseSegments([])).toEqual({ cwd: undefined, status: 'idle' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/segments.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/domain/segments.js'`。

- [ ] **Step 3: 写 `src/domain/segments.ts`**

```ts
import type { SessionStatus } from './types.js';

export function pidFromRunName(runFile: string): number | null {
  const m = runFile.match(/-p(\d+)(?:\.jsonl)?$/);
  return m ? Number(m[1]) : null;
}

// segments 是事件日志（不是转录）：事件成对追加，所以「末条以 .started 结尾」就是 busy。
export function parseSegments(lines: string[]): { cwd?: string; status: SessionStatus } {
  let cwd: string | undefined;
  let status: SessionStatus = 'idle';
  for (const line of lines) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const type = typeof o?.type === 'string' ? o.type : '';
    if (cwd === undefined && type === 'session.config.loaded' && typeof o?.data?.project_root === 'string') {
      cwd = o.data.project_root;
    }
    if (type.endsWith('.started')) status = 'busy';
    else if (type.endsWith('.finished')) status = 'idle';
  }
  return { cwd, status };
}
```

`SessionStatus` 是 `src/domain/types.ts` 里 `LiveSession.status` 的那个联合类型 —— 用它的实际导出名（若未导出则加 `export`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/segments.test.ts
```
Expected: PASS（6 passed）。

- [ ] **Step 5: 写失败的测试 —— QoderCliSource**

`test/unit/sources.test.ts` 追加：

```ts
import { QoderCliSource } from '../../src/adapters/sources/qoder-cli.js';

describe('QoderCliSource', () => {
  const seed = (h: string, sessionId: string, run: string, lines: string[]) => {
    const dir = join(h, 'logs', 'sessions', '-Users-l-dev-foo', sessionId, 'segments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${run}.jsonl`), lines.join('\n') + '\n');
  };

  test('kernel 是 qodercli 且用 qodercli 方言', () => {
    const s = new QoderCliSource(home(), 'qodercli', 'bypass_permissions');
    expect(s.kernel).toBe('qodercli');
    expect(s.launchCommand('sid', { cwd: '/tmp' }))
      .toEqual(['qodercli', '--session-id', 'sid', '--permission-mode', 'bypass_permissions']);
  });

  test('run 名 pid 活着才算 live，cwd 与状态取自 segments', async () => {
    const h = home();
    seed(h, 'alive', `2026-07-30T16-31-03-aaaa-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/foo' } }),
      JSON.stringify({ type: 'model.request.started', data: {} }),
    ]);
    seed(h, 'dead', '2026-07-30T16-31-03-bbbb-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/Users/l/dev/bar' } }),
    ]);
    const live = await new QoderCliSource(h, 'qodercli', 'bypass_permissions').readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['alive']);
    expect(live[0]).toMatchObject({ kernel: 'qodercli', cwd: '/Users/l/dev/foo', status: 'busy' });
  });

  test('同一会话有多个 run 时取名字最大的那个（run 名以 ISO 时间戳开头）', async () => {
    const h = home();
    seed(h, 's1', '2026-07-30T16-31-03-aaaa-p99999999', [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/old' } }),
    ]);
    seed(h, 's1', `2026-07-30T16-47-38-bbbb-p${process.pid}`, [
      JSON.stringify({ type: 'session.config.loaded', data: { project_root: '/new' } }),
    ]);
    const live = await new QoderCliSource(h, 'qodercli').readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.cwd).toBe('/new');
  });

  test('平铺转录归自己，transcript/ 下的不归自己', () => {
    const s = new QoderCliSource(home(), 'qodercli');
    expect(s.sessionIdForPath('-Users-l/abc.jsonl')).toBe('abc');
    expect(s.sessionIdForPath('-Users-l/transcript/abc.jsonl')).toBeNull();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/adapters/sources/qoder-cli.js'`。

- [ ] **Step 7: 写 `src/adapters/sources/qoder-cli.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { parseSegments, pidFromRunName } from '../../domain/segments.js';
import { CliSource, isPidAlive, safeReaddir } from './base.js';

export class QoderCliSource extends CliSource {
  readonly kernel = 'qodercli' as const;

  async readLiveSessions(): Promise<LiveSession[]> {
    const root = join(this.home, 'logs', 'sessions');
    const out: LiveSession[] = [];
    for (const proj of safeReaddir(root)) {
      for (const sessionId of safeReaddir(join(root, proj))) {
        const segDir = join(root, proj, sessionId, 'segments');
        // run 名以 ISO 时间戳开头，字典序最大即最新。
        const run = safeReaddir(segDir).filter(f => f.endsWith('.jsonl')).sort().at(-1);
        if (!run) continue;
        const pid = pidFromRunName(run);
        if (pid === null || !isPidAlive(pid)) continue;
        let lines: string[];
        try { lines = readFileSync(join(segDir, run), 'utf8').split('\n').filter(Boolean); }
        catch { continue; }
        const { cwd, status } = parseSegments(lines);
        out.push({ sessionId, kernel: 'qodercli', cwd: cwd ?? '', status, pid });
      }
    }
    return out;
  }
}
```

若 `LiveSession` 还有别的必填字段，按 `src/domain/types.ts` 补齐（参照 `session-discovery.ts` 里 `toLiveSession` 的返回值）。

- [ ] **Step 8: 加 `qoder` 配置块并接进 `buildPlane`**

`src/config.ts` 加（`expand` 用该文件里 `paths.claudeHome` 那处的同一个 home 展开写法；本块 5 个字段一次加全，Task 5 / Task 6 会读 `qoderWorkHome` 与 `heartbeatTtlMs`）：

```ts
  qoder: {
    cliBin: 'qodercli',
    cliPermissionMode: 'bypass_permissions',
    qoderHome: expand('~/.qoder'),
    qoderWorkHome: expand('~/.qoderwork'),
    heartbeatTtlMs: 30 * 60 * 1000,
  },
```

`src/cli.ts` 的 `buildPlane`，`sources` 数组加第二项：

```ts
      new QoderCliSource(cfg.qoder.qoderHome, cfg.qoder.cliBin, cfg.qoder.cliPermissionMode),
```

- [ ] **Step 9: IM 建会话确认文案带上 kernel**

`kernel` 从 Task 3 起就已经是 `propose_create_session` 的合法参数（`src/mcp/control-mcp.ts:85`），
但在本任务之前只有一个可控内核，所以文案不显示 kernel 无所谓。`qodercli` 上线后，
用户在钉钉里看到的确认只有「在 /x 新建会话」—— 不知道自己批准的是哪个产品。

新建 `test/unit/pending.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { describeAction } from '../../src/domain/pending.js';

describe('describeAction', () => {
  test('create 不带 kernel 时不显示内核（默认 claude）', () => {
    expect(describeAction('create', { cwd: '/w' })).toBe('在 /w 新建会话');
  });
  test('create 带 kernel 时显示内核', () => {
    expect(describeAction('create', { cwd: '/w', kernel: 'qodercli' })).toBe('在 /w 新建 qodercli 会话');
  });
  test('create 的 initialPrompt 仍附在末尾', () => {
    expect(describeAction('create', { cwd: '/w', kernel: 'qodercli', initialPrompt: 'go' }))
      .toBe('在 /w 新建 qodercli 会话，首条: go');
  });
});
```

跑一次确认失败（第 2、3 条红）：

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/pending.test.ts
```

再把 `src/domain/pending.ts:5` 那行换成：

```ts
  if (kind === 'create') return `在 ${params.cwd} 新建${params.kernel ? ' ' + params.kernel : ''}会话${params.initialPrompt ? '，首条: ' + params.initialPrompt : ''}`;
```

重跑该文件确认 3 条全绿。**不要**给 `describeAction` 加 kernel → 显示名的映射表（Global Constraints
禁止任何 kernel 映射表）—— 直接打印 kernel 字面量。

- [ ] **Step 10: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 全 PASS。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat(qodercli): 接入第二个可控内核，存活靠 segments run 名 pid"
```

---

### Task 5: `lifestream hooks install/uninstall/status` + 安装手册

两个桌面产品的生命周期信号只能靠注入 hook 拿到（fd 信号已实测证伪、Qoder IDE 连 segments 都没有）。注入走**显式成对 CLI 命令**，绝不在 `serve` / daemon 启动路径里静默做。这两个 settings 文件里住着 r2c / loongsuite 的 hook，**只能增删自己那一项**。

**Files:**
- Create: `src/domain/qoder-hooks.ts`
- Create: `src/adapters/hooks-installer.ts`
- Create: `src/hooks/lifestream-heartbeat.ts`
- Create: `src/hooks/cli.ts`
- Create: `docs/install.md`
- Create: `test/unit/qoder-hooks.test.ts`
- Create: `test/unit/hooks-cli.test.ts`
- Modify: `src/cli.ts`（加 `hooks` 分支 + `:114` usage 串）

**Interfaces:**
- Consumes: Task 4 的 `cfg.qoder.qoderHome` / `cfg.qoder.qoderWorkHome`；`cfg.paths.stateDir`
- Produces:
  - `src/domain/qoder-hooks.ts`：`type HookTarget = 'qoder-ide' | 'qoderwork'`、`HOOK_TARGETS`、`HEARTBEAT_EVENTS`、`type HeartbeatEvent`、`HEARTBEAT_MARKER`、`interface Settings`、`heartbeatDir(stateDir, target): string`、`installHeartbeatHooks(settings, command): Settings`、`uninstallHeartbeatHooks(settings): Settings`、`heartbeatHookStatus(settings): { installed: HeartbeatEvent[]; missing: HeartbeatEvent[] }`
  - `src/hooks/lifestream-heartbeat.ts`：`heartbeatPayload(raw, now): HeartbeatPayload | null`、`writeHeartbeat(dir, p): void`、`main(argv, stdin): Promise<void>`
  - `src/adapters/hooks-installer.ts`：`targetPaths(homes, stateDir, target): { settings; heartbeatDir }`、`heartbeatScriptPath(): string`、`heartbeatCommand(script, dir): string`、`readSettings(file): Settings`、`writeSettings(file, s, now): string | null`
  - `src/hooks/cli.ts`：`runHooksCommand(args: string[], d: HooksDeps): number`、`interface HooksDeps { homes: Record<HookTarget, string>; stateDir: string; script: () => string; now: () => number; log: (s: string) => void }`

- [ ] **Step 1: 写失败的测试 —— 纯函数侧的幂等与他厂条目保留**

新建 `test/unit/qoder-hooks.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import {
  HEARTBEAT_EVENTS, heartbeatHookStatus, installHeartbeatHooks, uninstallHeartbeatHooks,
} from '../../src/domain/qoder-hooks.js';

const CMD = '"/usr/bin/node" "/x/dist/hooks/lifestream-heartbeat.js" --dir "/y/qoderwork"';
const FOREIGN = {
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite-hook --pre' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'r2c-scan' }] }],
  },
};

describe('installHeartbeatHooks', () => {
  test('五个事件都装上', () => {
    const out = heartbeatHookStatus(installHeartbeatHooks({}, CMD));
    expect(out.installed).toEqual([...HEARTBEAT_EVENTS]);
    expect(out.missing).toEqual([]);
  });

  test('幂等：装两遍不产生重复条目', () => {
    const once = installHeartbeatHooks({}, CMD);
    const twice = installHeartbeatHooks(once, CMD);
    const count = (s: any) => (s.hooks.PreToolUse as any[])
      .flatMap(g => g.hooks).filter((h: any) => h.command.includes('lifestream-heartbeat')).length;
    expect(count(once)).toBe(1);
    expect(count(twice)).toBe(1);
  });

  test('他厂条目一个不动', () => {
    const out = installHeartbeatHooks(FOREIGN, CMD) as any;
    const cmds = (ev: string) => (out.hooks[ev] as any[]).flatMap(g => g.hooks).map((h: any) => h.command);
    expect(cmds('PreToolUse')).toContain('loongsuite-hook --pre');
    expect(cmds('Stop')).toContain('r2c-scan');
  });

  test('不修改传入的对象', () => {
    const before = JSON.stringify(FOREIGN);
    installHeartbeatHooks(FOREIGN, CMD);
    expect(JSON.stringify(FOREIGN)).toBe(before);
  });

  test('命令变了（比如换了心跳目录）也只留一条', () => {
    const once = installHeartbeatHooks({}, CMD);
    const out = installHeartbeatHooks(once, CMD.replace('/y/qoderwork', '/y/qoder-ide')) as any;
    const mine = (out.hooks.Stop as any[]).flatMap(g => g.hooks)
      .filter((h: any) => h.command.includes('lifestream-heartbeat'));
    expect(mine).toHaveLength(1);
    expect(mine[0].command).toContain('/y/qoder-ide');
  });
});

describe('uninstallHeartbeatHooks', () => {
  test('只删自己那一项，他厂条目留着', () => {
    const installed = installHeartbeatHooks(FOREIGN, CMD);
    const out = uninstallHeartbeatHooks(installed) as any;
    expect(heartbeatHookStatus(out).installed).toEqual([]);
    const cmds = (ev: string) => (out.hooks[ev] ?? []).flatMap((g: any) => g.hooks).map((h: any) => h.command);
    expect(cmds('PreToolUse')).toEqual(['loongsuite-hook --pre']);
    expect(cmds('Stop')).toEqual(['r2c-scan']);
  });

  test('卸完后不留空的事件键', () => {
    const out = uninstallHeartbeatHooks(installHeartbeatHooks({}, CMD)) as any;
    expect(Object.keys(out.hooks)).toEqual([]);
  });

  test('对没装过的 settings 是空操作', () => {
    expect(uninstallHeartbeatHooks({})).toEqual({});
  });
});

describe('heartbeatHookStatus', () => {
  test('部分安装时报出缺哪几个', () => {
    const s = installHeartbeatHooks({}, CMD) as any;
    delete s.hooks.Stop;
    expect(heartbeatHookStatus(s).missing).toEqual(['Stop']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/qoder-hooks.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/domain/qoder-hooks.js'`。

- [ ] **Step 3: 写 `src/domain/qoder-hooks.ts`**

```ts
import { join } from 'node:path';

export type HookTarget = 'qoder-ide' | 'qoderwork';
export const HOOK_TARGETS: HookTarget[] = ['qoder-ide', 'qoderwork'];

export const HEARTBEAT_EVENTS = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
] as const;
export type HeartbeatEvent = typeof HEARTBEAT_EVENTS[number];

export const HEARTBEAT_MARKER = 'lifestream-heartbeat';

export interface HookEntry { type: string; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookEntry[] }
export interface Settings { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown }

export function heartbeatDir(stateDir: string, target: HookTarget): string {
  return join(stateDir, 'heartbeats', target);
}

const isOurs = (h: HookEntry): boolean =>
  typeof h?.command === 'string' && h.command.includes(HEARTBEAT_MARKER);

const withoutOurs = (groups: HookMatcher[]): HookMatcher[] =>
  groups.map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) }))
        .filter(g => g.hooks.length > 0);

export function installHeartbeatHooks(settings: Settings, command: string): Settings {
  const next = structuredClone(settings) as Settings;
  next.hooks ??= {};
  for (const ev of HEARTBEAT_EVENTS) {
    const groups = withoutOurs(next.hooks[ev] ?? []);
    groups.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] });
    next.hooks[ev] = groups;
  }
  return next;
}

export function uninstallHeartbeatHooks(settings: Settings): Settings {
  const next = structuredClone(settings) as Settings;
  if (!next.hooks) return next;
  for (const ev of Object.keys(next.hooks)) {
    const groups = withoutOurs(next.hooks[ev] ?? []);
    if (groups.length > 0) next.hooks[ev] = groups;
    else delete next.hooks[ev];
  }
  return next;
}

export function heartbeatHookStatus(
  settings: Settings,
): { installed: HeartbeatEvent[]; missing: HeartbeatEvent[] } {
  const installed: HeartbeatEvent[] = [];
  const missing: HeartbeatEvent[] = [];
  for (const ev of HEARTBEAT_EVENTS) {
    const hit = (settings.hooks?.[ev] ?? []).some(g => (g.hooks ?? []).some(isOurs));
    (hit ? installed : missing).push(ev);
  }
  return { installed, missing };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/qoder-hooks.test.ts
```
Expected: PASS（9 passed）。

- [ ] **Step 5: 提交纯函数层**

```bash
git add src/domain/qoder-hooks.ts test/unit/qoder-hooks.test.ts
git commit -m "feat(hooks): 心跳 hook 的幂等合并与卸载（纯函数）"
```

- [ ] **Step 6: 写失败的测试 —— 心跳脚本本体与 CLI 落盘**

新建 `test/unit/hooks-cli.test.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { heartbeatHookStatus } from '../../src/domain/qoder-hooks.js';
import { readSettings } from '../../src/adapters/hooks-installer.js';
import { heartbeatPayload, writeHeartbeat } from '../../src/hooks/lifestream-heartbeat.js';
import { runHooksCommand } from '../../src/hooks/cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ls-hooks-'));

const mk = (root: string) => {
  const ide = join(root, 'qoder');
  const work = join(root, 'qoderwork');
  mkdirSync(ide, { recursive: true });
  mkdirSync(work, { recursive: true });
  const logs: string[] = [];
  return {
    ide, work, logs,
    deps: {
      homes: { 'qoder-ide': ide, qoderwork: work },
      stateDir: join(root, 'state'),
      script: () => '/x/dist/hooks/lifestream-heartbeat.js',
      now: () => 1785400000000,
      log: (s: string) => logs.push(s),
    },
  };
};

describe('heartbeatPayload', () => {
  test('camelCase 的 sessionId 与 hook_event_name', () => {
    const p = heartbeatPayload(JSON.stringify({
      sessionId: 'abc-1', cwd: '/Users/l/dev/foo', hook_event_name: 'PreToolUse',
    }), 42);
    expect(p).toEqual({ sessionId: 'abc-1', cwd: '/Users/l/dev/foo', event: 'PreToolUse', ts: 42 });
  });
  test('snake_case 的 session_id 也接受', () => {
    expect(heartbeatPayload(JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }), 1)?.sessionId)
      .toBe('abc');
  });
  test('没有 sessionId 返回 null', () => {
    expect(heartbeatPayload(JSON.stringify({ hook_event_name: 'Stop' }), 1)).toBeNull();
  });
  test('sessionId 含路径分隔符时拒绝（会被拼进文件名）', () => {
    expect(heartbeatPayload(JSON.stringify({ sessionId: '../evil' }), 1)).toBeNull();
  });
  test('非 JSON 返回 null', () => {
    expect(heartbeatPayload('boom', 1)).toBeNull();
  });
});

describe('writeHeartbeat', () => {
  test('按 sessionId 写一个文件，目录自动创建', () => {
    const dir = join(tmp(), 'hb', 'qoderwork');
    writeHeartbeat(dir, { sessionId: 's1', cwd: '/tmp', event: 'Stop', ts: 7 });
    expect(JSON.parse(readFileSync(join(dir, 's1.json'), 'utf8')))
      .toEqual({ sessionId: 's1', cwd: '/tmp', event: 'Stop', ts: 7 });
  });
});

describe('runHooksCommand', () => {
  test('install --target all 装两个 settings 并建两个心跳目录', () => {
    const root = tmp();
    const { deps, ide, work } = mk(root);
    expect(runHooksCommand(['install', '--target', 'all'], deps)).toBe(0);
    expect(heartbeatHookStatus(readSettings(join(ide, 'settings.json'))).missing).toEqual([]);
    expect(heartbeatHookStatus(readSettings(join(work, 'settings.json'))).missing).toEqual([]);
    expect(existsSync(join(root, 'state', 'heartbeats', 'qoder-ide'))).toBe(true);
    expect(existsSync(join(root, 'state', 'heartbeats', 'qoderwork'))).toBe(true);
  });

  test('两个 target 的心跳目录各不相同', () => {
    const root = tmp();
    const { deps, ide, work } = mk(root);
    runHooksCommand(['install', '--target', 'all'], deps);
    const cmd = (f: string) => JSON.stringify(readSettings(join(f, 'settings.json')));
    expect(cmd(ide)).toContain(join('heartbeats', 'qoder-ide'));
    expect(cmd(work)).toContain(join('heartbeats', 'qoderwork'));
  });

  test('先备份再改写，且保留他厂条目', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    writeFileSync(file, JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite' }] }] },
    }));
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    expect(readdirSync(work).filter(f => f.includes('lifestream-backup-'))).toHaveLength(1);
    expect(JSON.stringify(readSettings(file))).toContain('loongsuite');
  });

  test('--dry-run 不落盘', () => {
    const root = tmp();
    const { deps, work, logs } = mk(root);
    expect(runHooksCommand(['install', '--target', 'qoderwork', '--dry-run'], deps)).toBe(0);
    expect(existsSync(join(work, 'settings.json'))).toBe(false);
    expect(logs.join('\n')).toContain('dry-run');
  });

  test('uninstall 只删自己那一项', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    writeFileSync(file, JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'loongsuite' }] }] },
    }));
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    expect(runHooksCommand(['uninstall', '--target', 'qoderwork'], deps)).toBe(0);
    expect(heartbeatHookStatus(readSettings(file)).installed).toEqual([]);
    expect(JSON.stringify(readSettings(file))).toContain('loongsuite');
  });

  test('status 报出两个 target 的安装情况', () => {
    const root = tmp();
    const { deps, logs } = mk(root);
    runHooksCommand(['install', '--target', 'qoderwork'], deps);
    expect(runHooksCommand(['status'], deps)).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('qoderwork');
    expect(out).toContain('qoder-ide');
  });

  test('缺 --target 或子命令不认识时返回 2 并打 usage', () => {
    const { deps, logs } = mk(tmp());
    expect(runHooksCommand(['install'], deps)).toBe(2);
    expect(runHooksCommand(['bogus'], deps)).toBe(2);
    expect(logs.join('\n')).toContain('lifestream hooks');
  });

  test('settings.json 不是合法 JSON 时拒绝改写', () => {
    const root = tmp();
    const { deps, work } = mk(root);
    const file = join(work, 'settings.json');
    writeFileSync(file, '{ 坏掉的 json');
    expect(() => runHooksCommand(['install', '--target', 'qoderwork'], deps)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ 坏掉的 json');
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/hooks-cli.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/hooks/lifestream-heartbeat.js'`。

- [ ] **Step 8: 写心跳脚本 `src/hooks/lifestream-heartbeat.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HeartbeatPayload { sessionId: string; cwd: string; event: string; ts: number }

export function heartbeatPayload(raw: string, now: number): HeartbeatPayload | null {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  const sessionId = o?.sessionId ?? o?.session_id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  return {
    sessionId,
    cwd: typeof o?.cwd === 'string' ? o.cwd : '',
    event: typeof o?.hook_event_name === 'string' ? o.hook_event_name : 'unknown',
    ts: now,
  };
}

export function writeHeartbeat(dir: string, p: HeartbeatPayload): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p.sessionId}.json`), JSON.stringify(p));
}

export async function main(argv: string[], stdin: AsyncIterable<Buffer | string>): Promise<void> {
  const i = argv.indexOf('--dir');
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir) return;
  let raw = '';
  for await (const chunk of stdin) raw += String(chunk);
  const p = heartbeatPayload(raw, Date.now());
  if (p) writeHeartbeat(dir, p);
}

// 只在被当脚本执行时跑（vitest import 本文件时不能触发）。
// 任何异常都吞掉：这个 hook 挂在别人的进程里，绝不能把宿主搞崩。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), process.stdin).catch(() => {});
}
```

- [ ] **Step 9: 写 `src/adapters/hooks-installer.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type HookTarget, type Settings, heartbeatDir } from '../domain/qoder-hooks.js';

export interface TargetPaths { settings: string; heartbeatDir: string }

export function targetPaths(
  homes: Record<HookTarget, string>, stateDir: string, t: HookTarget,
): TargetPaths {
  return { settings: join(homes[t], 'settings.json'), heartbeatDir: heartbeatDir(stateDir, t) };
}

export function heartbeatScriptPath(): string {
  const p = resolve(process.cwd(), 'dist/hooks/lifestream-heartbeat.js');
  if (!existsSync(p)) throw new Error(`找不到 ${p}，先执行 npm run build`);
  return p;
}

export function heartbeatCommand(script: string, dir: string): string {
  return `"${process.execPath}" "${script}" --dir "${dir}"`;
}

// 解析失败必须抛：返回 {} 再写回去会把用户原有的 settings 抹掉。
export function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  try { return JSON.parse(text) as Settings; }
  catch { throw new Error(`${file} 不是合法 JSON，拒绝改写`); }
}

export function writeSettings(file: string, s: Settings, now: number): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.lifestream-backup-${now}`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return backup;
}
```

- [ ] **Step 10: 写 `src/hooks/cli.ts`**

```ts
import { mkdirSync } from 'node:fs';
import {
  HEARTBEAT_EVENTS, HOOK_TARGETS, type HookTarget,
  heartbeatHookStatus, installHeartbeatHooks, uninstallHeartbeatHooks,
} from '../domain/qoder-hooks.js';
import {
  heartbeatCommand, readSettings, targetPaths, writeSettings,
} from '../adapters/hooks-installer.js';
import { safeReaddir } from '../adapters/sources/base.js';

const USAGE = 'usage: lifestream hooks <install|uninstall|status> --target <qoder-ide|qoderwork|all> [--dry-run]';

export interface HooksDeps {
  homes: Record<HookTarget, string>;
  stateDir: string;
  script: () => string;
  now: () => number;
  log: (s: string) => void;
}

export function runHooksCommand(args: string[], d: HooksDeps): number {
  const sub = args[0];

  if (sub === 'status') {
    for (const t of HOOK_TARGETS) {
      const p = targetPaths(d.homes, d.stateDir, t);
      let line: string;
      try {
        const st = heartbeatHookStatus(readSettings(p.settings));
        line = `已装 ${st.installed.length}/${HEARTBEAT_EVENTS.length}`
          + (st.missing.length > 0 ? `，缺 ${st.missing.join(',')}` : '');
      } catch (e) { line = `读取失败：${(e as Error).message}`; }
      const n = safeReaddir(p.heartbeatDir).filter(f => f.endsWith('.json')).length;
      d.log(`${t}: ${p.settings} — ${line}`);
      d.log(`  心跳目录 ${p.heartbeatDir}：${n} 个文件`);
    }
    return 0;
  }

  if (sub !== 'install' && sub !== 'uninstall') { d.log(USAGE); return 2; }

  const i = args.indexOf('--target');
  const raw = i >= 0 ? args[i + 1] : undefined;
  if (!raw) { d.log(USAGE); return 2; }
  const targets = raw === 'all' ? HOOK_TARGETS : HOOK_TARGETS.filter(t => t === raw);
  if (targets.length === 0) { d.log(`未知 --target: ${raw}`); d.log(USAGE); return 2; }

  const dryRun = args.includes('--dry-run');
  for (const t of targets) {
    const p = targetPaths(d.homes, d.stateDir, t);
    const before = readSettings(p.settings);
    const after = sub === 'install'
      ? installHeartbeatHooks(before, heartbeatCommand(d.script(), p.heartbeatDir))
      : uninstallHeartbeatHooks(before);
    if (dryRun) {
      d.log(`dry-run（未落盘）${p.settings} 的 hooks 将变为：`);
      d.log(JSON.stringify(after.hooks ?? {}, null, 2));
      continue;
    }
    const backup = writeSettings(p.settings, after, d.now());
    if (sub === 'install') mkdirSync(p.heartbeatDir, { recursive: true });
    d.log(`${sub === 'install' ? '已安装' : '已卸载'} ${t}：${p.settings}`
      + (backup ? `（备份 ${backup}）` : ''));
  }
  return 0;
}
```

- [ ] **Step 11: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/hooks-cli.test.ts
```
Expected: PASS（14 passed）。

- [ ] **Step 12: 接进 `src/cli.ts`**

在其它子命令分支旁加（`loadConfig` 的取法沿用该文件现有写法）：

```ts
  if (cmd === 'hooks') {
    const cfg = loadConfig();
    process.exit(runHooksCommand(argv.slice(1), {
      homes: { 'qoder-ide': cfg.qoder.qoderHome, qoderwork: cfg.qoder.qoderWorkHome },
      stateDir: cfg.paths.stateDir,
      script: heartbeatScriptPath,
      now: () => Date.now(),
      log: (s) => console.log(s),
    }));
  }
```

`:114` 的 usage 串换成

```ts
  console.log('usage: lifestream <sessions | tail <id> | serve | daemon [--watch] | reload | token | install-launchd | hooks <install|uninstall|status> | mcp [--mode direct|im]>');
```

- [ ] **Step 13: 写 `docs/install.md`**

```markdown
# 安装与接入

## 依赖

- node ≥ 24（本机 `/Users/l/.nvm/versions/node/v24.18.0/bin/node`）
- tmux（受控会话跑在 tmux 里）

## 构建

    npm install
    npm run build

## 让 lifestream 看到两个 Qoder 桌面产品的会话

QoderWork 桌面版与 Qoder IDE 桌面版**没有写入通道**，lifestream 只读它们的会话。它们的
「会话是否还活着 / 正忙还是空闲」这两个信号也没法从落盘文件推出来（QoderWork 的 run 名 pid
恒为 app pid；Qoder IDE 连事件日志都不写），所以需要往它们各自的 settings 里注入一条
lifestream 自己的 hook，把心跳写到 lifestream 的状态目录。

**没装 hook 的桌面产品在会话列表里完全不出现**，哪怕它有几百条历史转录。这是显式安装换来的
确定性，不是 bug。

### 安装

    lifestream hooks install --target all          # 两个产品都装
    lifestream hooks install --target qoder-ide    # 只装 Qoder IDE
    lifestream hooks install --target qoderwork    # 只装 QoderWork
    lifestream hooks install --target all --dry-run # 只打印将写入的 hooks，不落盘

| target | 被改写的文件 | 心跳目录 |
|---|---|---|
| `qoder-ide` | `~/.qoder/settings.json` | `~/.lifestream/heartbeats/qoder-ide/` |
| `qoderwork` | `~/.qoderwork/settings.json` | `~/.lifestream/heartbeats/qoderwork/` |

注入的是 `SessionStart`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop` 五个事件，
每个事件一条命令 hook。**改写前会先把原文件复制成 `<settings>.lifestream-backup-<毫秒时间戳>`**；
重复执行是幂等的（不会产生重复条目）；文件里已有的其它厂商 hook（如 r2c、loongsuite）一条都不会动。
若 settings.json 不是合法 JSON，命令会直接报错退出而不改写。

### 确认生效

    lifestream hooks status

然后在 Qoder IDE / QoderWork 里各发一条消息，再看心跳目录：

    ls ~/.lifestream/heartbeats/qoder-ide/
    ls ~/.lifestream/heartbeats/qoderwork/

每个活跃会话对应一个 `<sessionId>.json`。出现文件后，该会话就会出现在 Web 会话列表里（标签
`QODER` / `QW`）。`lifestream hooks status` 也会报出每个心跳目录里的文件数。

### 卸载

    lifestream hooks uninstall --target all

只删 lifestream 自己那一项，其它厂商的 hook 与文件里的其它配置保持原样。备份文件不会被自动
清理，确认无碍后可以手动删掉 `~/.qoder/settings.json.lifestream-backup-*` 与
`~/.qoderwork/settings.json.lifestream-backup-*`。

### 已知精度上限

hook 协议没有周期性心跳，心跳只在事件发生时刷新。因此一个已经关掉、但最后一个事件不是 `Stop`
的会话，会在 30 分钟（`heartbeatTtlMs`）内继续显示为在线。两个桌面产品同样受限。

## Qoder CLI

`qodercli` 是第二个**可控**内核，不需要装任何 hook —— 它每个会话一个真实进程，lifestream 直接
读它的事件日志判存活。用 `POST /api/sessions {"cwd":"…","kernel":"qodercli"}` 或 MCP
`create_session` / `propose_create_session` 起会话（Web 的「新建」按钮固定起 Claude 会话）。
```

- [ ] **Step 14: 全量检查 + 提交**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 全 PASS。

```bash
git add -A
git commit -m "feat(hooks): lifestream hooks install/uninstall/status 与安装手册"
```

---

### Task 6: 两个桌面 source + 心跳推导

枚举、cwd、busy/idle 全部来自心跳，**不解析 segments**。`~/.qoder/settings.json` 是 qodercli 与
Qoder IDE 共用的，装给 IDE 的 hook 对 qodercli 会话也会触发 —— 所以 `QoderIdeSource` 额外要求该
sessionId 在 `projects/*/transcript/` 下有转录；`QoderWorkSource` 不加这层过滤。

**Files:**
- Create: `src/domain/heartbeat.ts`
- Create: `src/adapters/sources/qoder-desktop.ts`
- Create: `test/unit/heartbeat.test.ts`
- Modify: `src/cli.ts`（`buildPlane` 加两个 source）
- Test: `test/unit/sources.test.ts`（追加两个桌面 source 段）

**Interfaces:**
- Consumes: Task 2 的 `ProjectsSource` / `flatSessionIdForPath` / `safeReaddir`；Task 4 的 `cfg.qoder.*`；Task 5 的 `heartbeatDir(stateDir, target)`
- Produces:
  - `src/domain/heartbeat.ts`：`interface Heartbeat { sessionId; cwd; event; ts }`、`parseHeartbeat(text: string): Heartbeat | null`、`heartbeatVitals(h, now, ttlMs): { live: boolean; status: SessionStatus }`
  - `src/adapters/sources/qoder-desktop.ts`：`interface HeartbeatSourceOpts { home; heartbeatDir; ttlMs; now: () => number }`、`abstract class HeartbeatSource extends ProjectsSource`、`class QoderWorkSource extends HeartbeatSource`、`class QoderIdeSource extends HeartbeatSource`

- [ ] **Step 1: 写失败的测试 —— 心跳纯函数**

新建 `test/unit/heartbeat.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { heartbeatVitals, parseHeartbeat } from '../../src/domain/heartbeat.js';

const TTL = 30 * 60 * 1000;
const NOW = 1785400000000;
const hb = (event: string, ts = NOW) => ({ sessionId: 's', cwd: '/tmp', event, ts });

describe('parseHeartbeat', () => {
  test('完整载荷', () => {
    expect(parseHeartbeat(JSON.stringify(hb('PreToolUse'))))
      .toEqual({ sessionId: 's', cwd: '/tmp', event: 'PreToolUse', ts: NOW });
  });
  test('缺 ts 返回 null', () => {
    expect(parseHeartbeat(JSON.stringify({ sessionId: 's', event: 'Stop' }))).toBeNull();
  });
  test('缺 sessionId 返回 null', () => {
    expect(parseHeartbeat(JSON.stringify({ ts: NOW, event: 'Stop' }))).toBeNull();
  });
  test('非 JSON 返回 null', () => {
    expect(parseHeartbeat('boom')).toBeNull();
  });
});

describe('heartbeatVitals', () => {
  test('TTL 内且不是 Stop 就算 live', () => {
    expect(heartbeatVitals(hb('PostToolUse', NOW - 1000), NOW, TTL).live).toBe(true);
  });
  test('超出 TTL 不算 live', () => {
    expect(heartbeatVitals(hb('PreToolUse', NOW - TTL - 1), NOW, TTL).live).toBe(false);
  });
  test('最后事件是 Stop 就不算 live，且是 idle', () => {
    expect(heartbeatVitals(hb('Stop'), NOW, TTL)).toEqual({ live: false, status: 'idle' });
  });
  test('PreToolUse 判 busy', () => {
    expect(heartbeatVitals(hb('PreToolUse'), NOW, TTL).status).toBe('busy');
  });
  test('PostToolUse / PostToolUseFailure / SessionStart 判 idle', () => {
    for (const e of ['PostToolUse', 'PostToolUseFailure', 'SessionStart']) {
      expect(heartbeatVitals(hb(e), NOW, TTL).status).toBe('idle');
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/heartbeat.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/domain/heartbeat.js'`。

- [ ] **Step 3: 写 `src/domain/heartbeat.ts`**

```ts
import type { SessionStatus } from './types.js';

export interface Heartbeat { sessionId: string; cwd: string; event: string; ts: number }

export function parseHeartbeat(text: string): Heartbeat | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (typeof o?.sessionId !== 'string' || typeof o?.ts !== 'number') return null;
  return {
    sessionId: o.sessionId,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
    event: typeof o.event === 'string' ? o.event : 'unknown',
    ts: o.ts,
  };
}

// hook 协议没有周期性心跳：心跳只在事件时刷新，所以 TTL 内一个已关闭的会话仍会显示为 live
// （除非它最后一个事件是 Stop）。这是精度上限。
export function heartbeatVitals(
  h: Heartbeat, now: number, ttlMs: number,
): { live: boolean; status: SessionStatus } {
  const fresh = now - h.ts <= ttlMs;
  return {
    live: fresh && h.event !== 'Stop',
    status: h.event === 'PreToolUse' ? 'busy' : 'idle',
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/heartbeat.test.ts
```
Expected: PASS（9 passed）。

- [ ] **Step 5: 写失败的测试 —— 两个桌面 source**

`test/unit/sources.test.ts` 追加：

```ts
import { QoderIdeSource, QoderWorkSource } from '../../src/adapters/sources/qoder-desktop.js';
import { isControllable } from '../../src/ports/index.js';

const NOW = 1785400000000;
const TTL = 30 * 60 * 1000;

const hbFile = (dir: string, sessionId: string, event: string, ts = NOW) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`),
    JSON.stringify({ sessionId, cwd: '/Users/l/dev/foo', event, ts }));
};

const ideTranscript = (h: string, name: string) => {
  const dir = join(h, 'projects', '-Users-l-dev-foo', 'transcript');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '{}\n');
};

describe('QoderWorkSource', () => {
  const mk = (h: string, hb: string) =>
    new QoderWorkSource({ home: h, heartbeatDir: hb, ttlMs: TTL, now: () => NOW });

  test('只读：isControllable 为 false', () => {
    expect(isControllable(mk(home(), home()))).toBe(false);
  });

  test('心跳给出枚举、cwd 与状态', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'w1', 'PreToolUse');
    const live = await mk(h, hb).readLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      sessionId: 'w1', kernel: 'qoderwork', cwd: '/Users/l/dev/foo', status: 'busy',
    });
  });

  test('Stop 之后与超出 TTL 的都不列出', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'stopped', 'Stop');
    hbFile(hb, 'stale', 'PreToolUse', NOW - TTL - 1);
    expect(await mk(h, hb).readLiveSessions()).toEqual([]);
  });

  test('没有转录的新会话也列出（不做转录过滤）', async () => {
    const h = home(); const hb = join(home(), 'hb');
    hbFile(hb, 'brandnew', 'SessionStart');
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual(['brandnew']);
  });
});

describe('QoderIdeSource', () => {
  const mk = (h: string, hb: string) =>
    new QoderIdeSource({ home: h, heartbeatDir: hb, ttlMs: TTL, now: () => NOW });

  test('只读：isControllable 为 false', () => {
    expect(isControllable(mk(home(), home()))).toBe(false);
  });

  test('只认 transcript/ 下有转录的心跳（滤掉共用 settings 带来的 qodercli 会话）', async () => {
    const h = home(); const hb = join(home(), 'hb');
    ideTranscript(h, 'ide1.jsonl');
    hbFile(hb, 'ide1', 'PostToolUse');
    hbFile(hb, 'cli1', 'PostToolUse');       // qodercli 的会话：transcript/ 下没有它
    const live = await mk(h, hb).readLiveSessions();
    expect(live.map(x => x.sessionId)).toEqual(['ide1']);
    expect(live[0]!.kernel).toBe('qoder-ide');
  });

  test('Quest 会话按 task-* 后缀定位转录', async () => {
    const h = home(); const hb = join(home(), 'hb');
    const id = 'task-0123456789abcdef0123';
    ideTranscript(h, `${id}.session.execution.jsonl`);
    hbFile(hb, id, 'PreToolUse');
    expect((await mk(h, hb).readLiveSessions()).map(x => x.sessionId)).toEqual([id]);
    expect(await mk(h, hb).locateTranscript(id)).toContain(`${id}.session.execution.jsonl`);
  });

  test('sessionIdForPath 只认 transcript/ 一层，Quest 名剥掉整个后缀', () => {
    const s = mk(home(), home());
    expect(s.sessionIdForPath('-Users-l/transcript/abc.jsonl')).toBe('abc');
    expect(s.sessionIdForPath('-Users-l/transcript/task-0123456789abcdef0123.session.execution.jsonl'))
      .toBe('task-0123456789abcdef0123');
    expect(s.sessionIdForPath('-Users-l/abc.jsonl')).toBeNull();
    expect(s.sessionIdForPath('-Users-l/transcript/abc.json')).toBeNull();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
```
Expected: FAIL —— `Cannot find module '../../src/adapters/sources/qoder-desktop.js'`。

- [ ] **Step 7: 写 `src/adapters/sources/qoder-desktop.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../../domain/types.js';
import { heartbeatVitals, parseHeartbeat } from '../../domain/heartbeat.js';
import { ProjectsSource, flatSessionIdForPath, safeReaddir } from './base.js';

export interface HeartbeatSourceOpts {
  home: string;
  heartbeatDir: string;
  ttlMs: number;
  now: () => number;
}

export abstract class HeartbeatSource extends ProjectsSource {
  protected readonly o: HeartbeatSourceOpts;

  constructor(o: HeartbeatSourceOpts) { super(o.home); this.o = o; }

  protected async isOwnSession(_sessionId: string): Promise<boolean> { return true; }

  async readLiveSessions(): Promise<LiveSession[]> {
    const out: LiveSession[] = [];
    for (const f of safeReaddir(this.o.heartbeatDir)) {
      if (!f.endsWith('.json')) continue;
      let text: string;
      try { text = readFileSync(join(this.o.heartbeatDir, f), 'utf8'); } catch { continue; }
      const h = parseHeartbeat(text);
      if (!h) continue;
      const v = heartbeatVitals(h, this.o.now(), this.o.ttlMs);
      if (!v.live) continue;
      if (!await this.isOwnSession(h.sessionId)) continue;
      out.push({ sessionId: h.sessionId, kernel: this.kernel, cwd: h.cwd, status: v.status });
    }
    return out;
  }
}

export class QoderWorkSource extends HeartbeatSource {
  readonly kernel = 'qoderwork' as const;

  sessionIdForPath(changedPath: string): string | null {
    return flatSessionIdForPath(changedPath);
  }
}

const QUEST_SUFFIX = '.session.execution.jsonl';

export class QoderIdeSource extends HeartbeatSource {
  readonly kernel = 'qoder-ide' as const;

  protected override candidatePaths(sessionId: string): string[] {
    const file = sessionId.startsWith('task-') ? `${sessionId}${QUEST_SUFFIX}` : `${sessionId}.jsonl`;
    return safeReaddir(this.projectsDir).map(d => join(this.projectsDir, d, 'transcript', file));
  }

  // ~/.qoder/settings.json 是 qodercli 与 Qoder IDE 共用的，心跳目录区分不了二者；
  // 靠「转录是否在 transcript/ 下」把 qodercli 的平铺会话滤掉。
  protected override async isOwnSession(sessionId: string): Promise<boolean> {
    return (await this.locateTranscript(sessionId)) !== null;
  }

  sessionIdForPath(changedPath: string): string | null {
    const parts = changedPath.split('/').filter(Boolean);
    const file = parts.at(-1);
    if (!file || parts.at(-2) !== 'transcript') return null;
    if (file.endsWith(QUEST_SUFFIX)) return file.slice(0, -QUEST_SUFFIX.length);
    if (file.endsWith('.jsonl')) return file.slice(0, -'.jsonl'.length);
    return null;
  }
}
```

`LiveSession` 若还有别的必填字段，按 `src/domain/types.ts` 补齐（桌面 source 没有 pid，`pid` 在 Task 2 已改成可选）。

- [ ] **Step 8: 接进 `buildPlane`**

`src/cli.ts` 的 `sources` 数组补两项：

```ts
      new QoderWorkSource({
        home: cfg.qoder.qoderWorkHome,
        heartbeatDir: heartbeatDir(cfg.paths.stateDir, 'qoderwork'),
        ttlMs: cfg.qoder.heartbeatTtlMs,
        now: () => Date.now(),
      }),
      new QoderIdeSource({
        home: cfg.qoder.qoderHome,
        heartbeatDir: heartbeatDir(cfg.paths.stateDir, 'qoder-ide'),
        ttlMs: cfg.qoder.heartbeatTtlMs,
        now: () => Date.now(),
      }),
```

`heartbeatDir` 从 `src/domain/qoder-hooks.js` 引入。

- [ ] **Step 9: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/sources.test.ts
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 全 PASS。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat(qoder-desktop): QoderWork 与 Qoder IDE 只读接入，生命周期靠心跳"
```

---

### Task 7: Web —— 内核标签 + adoptable 门控

**Files:**
- Modify: `web/src/core/state.ts:82`（`tagOf`）、`web/src/core/state.ts:1`（import）
- Modify: `web/src/views/console-view.ts:85`（接管按钮条件）
- Modify: `web/src/views/rail.ts:26`（空列表文案）
- Test: `test/unit/web-state.test.ts:11-12`（`S()` 默认值）、`:123-127`（`tagOf` 用例）

**Interfaces:**
- Consumes（Task 2 定义）：`SessionSummary.kernel: Kernel`、`SessionSummary.adoptable: boolean`、
  `Kernel = 'claude' | 'qodercli' | 'qoderwork' | 'qoder-ide'`（`src/domain/types.ts`）。
- Produces：`tagOf(x)` 返回 `'CC' | 'QCLI' | 'QW' | 'QODER'`。无后续任务消费。

前端不认识内核语义，只认识 `adoptable` 这个布尔与 `tagOf` 给出的短标签 —— 这是设计文档 §6
的硬要求，不要在 web 层写任何 `x.kernel === 'qoderwork'` 之类的分支。

`web/` 下的源文件引用领域类型时**不带 `.js` 后缀**（esbuild 打包，走 `tsconfig.web.json`），
而 `test/` 下的测试文件**带 `.js` 后缀**（NodeNext）。照抄各文件现有 import 的写法，别混。

- [ ] **Step 1: 先改测试 —— `S()` 补上两个新必填字段**

`test/unit/web-state.test.ts:11-12` 现在是：

```ts
const S = (over: Partial<SessionSummary> & { sessionId: string }): SessionSummary =>
  ({ cwd: '/w', status: 'idle', origin: 'managed', live: true, controllable: true, ...over });
```

改成：

```ts
const S = (over: Partial<SessionSummary> & { sessionId: string }): SessionSummary =>
  ({
    cwd: '/w', status: 'idle', origin: 'managed', live: true, controllable: true,
    kernel: 'claude', adoptable: true, ...over,
  });
```

- [ ] **Step 2: 改 `tagOf` 的测试用例**

`test/unit/web-state.test.ts:123-127` 整块替换为：

```ts
  it('tagOf 给出内核短标签', () => {
    expect(tagOf(S({ sessionId: 'x', kernel: 'claude' }))).toBe('CC');
    expect(tagOf(S({ sessionId: 'x', kernel: 'qodercli' }))).toBe('QCLI');
    expect(tagOf(S({ sessionId: 'x', kernel: 'qoderwork' }))).toBe('QW');
    expect(tagOf(S({ sessionId: 'x', kernel: 'qoder-ide' }))).toBe('QODER');
  });

  it('tagOf 不认识的内核回落到 CC', () => {
    expect(tagOf(S({ sessionId: 'x', kernel: 'wat' as never }))).toBe('CC');
  });
```

- [ ] **Step 3: 跑测试确认失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-state.test.ts
```
Expected: FAIL —— `tagOf` 两条用例断言失败（现实现返回 `'可控'`）。

- [ ] **Step 4: 实现 `tagOf`**

`web/src/core/state.ts:1` 的 import 补 `Kernel`：

```ts
import type { Kernel, PendingAction, SessionSummary } from '../../../src/domain/types';
```

`web/src/core/state.ts:82` 这一行：

```ts
export const tagOf = (x: SessionSummary): string => x.controllable ? '可控' : x.live ? '外部' : '离线';
```

替换为：

```ts
const KERNEL_TAG: Record<Kernel, string> = {
  claude: 'CC', qodercli: 'QCLI', qoderwork: 'QW', 'qoder-ide': 'QODER',
};

export const tagOf = (x: SessionSummary): string => KERNEL_TAG[x.kernel] ?? 'CC';
```

`?? 'CC'` 不是防御性冗余：服务端是独立进程，版本可能比前端 bundle 新，多出一个内核值时
标签回落比渲染 `undefined` 好。

- [ ] **Step 5: 跑测试确认通过**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-state.test.ts
```
Expected: PASS。

- [ ] **Step 6: 接管按钮改看 `adoptable`**

`web/src/views/console-view.ts:85`：

```ts
      if (x && !x.controllable && x.live) {
```

替换为：

```ts
      if (x && !x.controllable && x.live && x.adoptable) {
```

否则桌面产品的会话会画出一个点了必然抛 `NotControllableError` 的「接管」按钮。

- [ ] **Step 7: 空列表文案去掉 Claude 字样**

`web/src/views/rail.ts:26`：

```ts
    wrap.appendChild(el('div', { class: 'rail__empty', text: '还没有运行中的 Claude 会话。' }));
```

替换为：

```ts
    wrap.appendChild(el('div', { class: 'rail__empty', text: '还没有运行中的会话。' }));
```

- [ ] **Step 8: 两个 typecheck + 全量测试**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 三条全部无输出 / 全 PASS。

`console-view.ts` 与 `rail.ts` 的改动**没有单元测试** —— 本仓库 vitest 是
`environment: 'node'`，没有 jsdom，装不了 DOM。不要为此引入 jsdom（Global Constraints）。
这两处由 `tsc -p tsconfig.web.json` 与 Task 8 的浏览器实测覆盖。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(web): 侧栏内核标签，接管按钮改由 adoptable 门控"
```

---

### Task 8: 端到端验证与部署

**Files:**
- 无代码改动。若验证中发现缺陷，在本任务内修复并单独提交。

**Interfaces:**
- Consumes：Task 1-7 的全部产出。
- Produces：一个通过冒烟的部署实例。

环境（Global Constraints 已列，此处复述以免翻页）：
开发实例 `~/dev-ai/lifestream`，前台 `serve`，端口 8788；部署实例 `~/apps/lifestream`，
端口 8787，跑 `dist`，daemon 托管，更新走 build + reload。node 一律用
`/Users/l/.nvm/versions/node/v24.18.0/bin/node`。

- [ ] **Step 1: 全绿门禁**

```bash
cd /Users/l/dev-ai/lifestream
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```
Expected: 两条 tsc 无输出；vitest 全 PASS，0 failed。

任何一条不过就停在这里修，不要带着红灯往下走。

- [ ] **Step 2: 构建（hooks 安装依赖 dist 里的心跳脚本）**

```bash
cd /Users/l/dev-ai/lifestream
npm run build
ls -l dist/hooks/lifestream-heartbeat.js
```
Expected: 文件存在。`heartbeatScriptPath()` 找不到它时会报「先执行 npm run build」，
先构建能省一次困惑。

- [ ] **Step 3: 装心跳 hook，并确认没动别家条目**

```bash
cd /Users/l/dev-ai/lifestream
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js hooks install --target all --dry-run
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js hooks install --target all
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js hooks status
```
Expected：
- `--dry-run` 打印将写入的 JSON，且随后 `git status`（对用户 home 无关）与两个 settings 的
  mtime 不变 —— 用 `ls -l ~/.qoder/settings.json ~/.qoderwork/settings.json` 在 dry-run 前后各看一次。
- 正式 install 后 `hooks status` 两个 target 都报已安装。
- 备份文件出现：`ls -1 ~/.qoder/settings.json.lifestream-backup-* ~/.qoderwork/settings.json.lifestream-backup-*`。
- **别家条目仍在**：`~/.qoder/settings.json` 里 r2c 的 hook、`~/.qoderwork/settings.json` 里
  loongsuite 的 hook 都还能在文件里搜到（`grep -c r2c ~/.qoder/settings.json` ≥ 1，
  `grep -c loongsuite ~/.qoderwork/settings.json` ≥ 1）。这条不过是**回滚级**问题：
  立刻用备份文件恢复，再回去修 `installHeartbeatHooks` 的合并逻辑。

- [ ] **Step 4: 起开发实例**

```bash
cd /Users/l/dev-ai/lifestream
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js serve --port 8788
```
前台跑着，另开一个 shell 做后续验证。

- [ ] **Step 5: 四个产品都出现在列表里**

浏览器打开 `http://127.0.0.1:8788`，登录后检查：

1. 侧栏出现 Claude 会话（标签 `CC`）。
2. 若本机有活着的 qodercli 会话，出现且标签 `QCLI`；否则先起一个（Step 7 会起）。
3. Qoder IDE / QoderWork 的会话在 Step 6 触发心跳后出现，标签 `QODER` / `QW`。
4. 点开任意一条，转录能读出来（Qoder 的行格式与 Claude 同构，`transcript-parser.ts` 未改）。
5. 桌面产品的会话头部**没有**「接管」按钮（`adoptable === false`）。

命令行侧的同一份数据可以直接看：

```bash
curl -s -H "Cookie: $LIFESTREAM_COOKIE" http://127.0.0.1:8788/api/sessions | \
  /Users/l/.nvm/versions/node/v24.18.0/bin/node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s))console.log(x.kernel,x.adoptable,x.live,x.status,x.sessionId)})'
```
Expected: 每行的 `kernel` 取值只在四个合法值里，桌面两种的 `adoptable` 为 `false`。

- [ ] **Step 6: 桌面产品心跳链路**

在 Qoder IDE 里发一条消息，在 QoderWork 里发一条消息，然后：

```bash
ls -l ~/.lifestream/heartbeats/qoder-ide/ ~/.lifestream/heartbeats/qoderwork/
cat ~/.lifestream/heartbeats/qoderwork/*.json
```
Expected：
- 两个目录各出现 `<sessionId>.json`，内容形如
  `{"sessionId":"…","cwd":"/Users/l/…","event":"PreToolUse","ts":1785400000000}`。
- Web 列表里对应会话 live，`PreToolUse` 期间显示忙、`PostToolUse` 后转空闲。
- 一轮对话结束（Claude Code hook 协议的 `Stop`）后，`event` 变成 `Stop`，会话在列表里
  转为**不 live**。
- `~/.qoder/heartbeats/qoder-ide/` 下**不该**出现纯 qodercli 会话（`~/.qoder/settings.json`
  是二者共用的，`QoderIdeSource.isOwnSession` 应把没有 `projects/*/transcript/` 转录的
  心跳滤掉）。验证方式：Step 7 起 qodercli 会话后，它的 sessionId 会出现在
  `heartbeats/qoder-ide/` 里，但**不该**在 Web 里以 `QODER` 标签重复出现一次。

- [ ] **Step 7: 起一个受控 qodercli 会话，走完交互选择框应答**

```bash
curl -s -X POST -H 'Content-Type: application/json' -H "Cookie: $LIFESTREAM_COOKIE" \
  -d '{"cwd":"/tmp","kernel":"qodercli","name":"qcli-smoke"}' \
  http://127.0.0.1:8788/api/sessions
```
Expected: 201，返回体里 `kernel` 为 `qodercli`。

然后在 Web 里打开这条会话：
1. 标签 `QCLI`，头部有「结束会话」，可以发消息。
2. 让它跑一条会触发权限确认的命令（例如对 `/private/tmp/keytest` 做 `chmod -R 777`），
   `#promptSlot` 出现编号选项面板，且**没有**方向键那一行（Task 1 已删）。
3. 点「2. No」→ 面板收起、会话继续、目标目录权限未变
   （`stat -f "%Sp %N" /private/tmp/keytest` 仍是 `drwxr-xr-x`）。
   这一步验证「编号答复走 `send-keys -l` 字面通道」在真实 TUI 上有效（Task 1 修订 A / 设计 §7.1）——
   浏览器请求应打到 `POST /api/sessions/<id>/prompt`，**不是** `/messages`；
   面板收起后输入框应保持空白（没有被追加的 `Enter` 或残留的 `2`）。

再确认不可控内核确实被挡住：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -H "Cookie: $LIFESTREAM_COOKIE" -d '{"cwd":"/tmp","kernel":"qoderwork"}' \
  http://127.0.0.1:8788/api/sessions
```
Expected: 4xx，响应体是 `NotControllableError` 对应的错误。

- [ ] **Step 8: IM 侧走注入入口验证（不手动发钉钉消息）**

走既有的注入式测试，不去钉钉手动发消息：

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run \
  test/unit/control-mcp.test.ts test/unit/conductor.test.ts test/integration/im-linker-e2e.test.ts
```
Expected: 全 PASS。这三个文件分别覆盖：`get_session_prompt` 在 direct/im 两模式都存在且只读
（`control-mcp.test.ts:38-44`）、`propose_send_to_session` 暂存出 `kind:'send'` 动作
（`control-mcp.test.ts:29`）、conductor 执行 `send` 动作会打到 `plane.sendMessage`、以及
IM 侧链路端到端。

Task 1 已把 `MESSENGER_SYSTEM_PROMPT` 里的 `propose_send_keys` 换成
「用 `propose_send_to_session` 发编号答复」，这里顺手确认新句子在提示词里：

```bash
grep -c 'propose_send_to_session' src/adapters/agent-runner.ts
grep -c 'propose_send_keys' src/adapters/agent-runner.ts
```
Expected: 第一条 ≥ 1，第二条为 0。

- [ ] **Step 9: 清理测试残留**

```bash
curl -s -X POST -H "Cookie: $LIFESTREAM_COOKIE" \
  http://127.0.0.1:8788/api/sessions/<qcli-smoke-id>/archive
rm -rf /private/tmp/keytest
```
Expected: 受控会话从列表消失。

- [ ] **Step 10: 部署实例 build + reload**

```bash
cd /Users/l/apps/lifestream
git pull
npm ci
npm run build
# 按仓库既有方式 reload daemon（见 README / 部署脚本）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
```
Expected: 服务起来，返回 200/302（未登录时的登录页）。

部署实例上**同样要跑一次 `hooks install --target all`** —— 心跳脚本路径指向的是
执行 install 时那个仓库的 `dist/`，两个实例的路径不同。用哪个实例的路径取决于你想让
哪个实例收心跳：`~/.lifestream/heartbeats/` 是共享的，但脚本路径只能有一个。
**决定：装部署实例的路径**（8787 是长期运行的那个），开发实例复用同一份心跳目录即可读到。

- [ ] **Step 11: 提交（若本任务有修复）**

```bash
git add -A
git commit -m "fix(qoder): 端到端验证发现的问题"
```

若无修复则跳过。
