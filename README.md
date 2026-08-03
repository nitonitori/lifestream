# Lifestream

> 跑在你工作机上的常驻服务，用于**监控与控制本机上所有的 Claude Code 会话**，并提供 Web、钉钉 IM、MCP 三个入口。

Lifestream 是一个本机 Hub（由守护进程保活）：它发现本机所有正在运行的 Claude Code 实例，实时展示状态与会话内消息，并支持向会话注入指令、创建新会话、接管外部会话。它还内置一个「信使 Agent」——本体就是一个完整的 headless Claude Code，可以通过 MCP 控制面「用 claude 控制 claude」，且 Web 与钉钉的消息进入同一会话上下文。

> ⚠️ **本机自用工具**：默认面向单用户、单机场景，且信使 Agent 默认以高权限模式运行。公开部署前请务必阅读 [安全须知](#安全须知)。

## 功能

- **监控**：发现本机所有 Claude Code 实例，实时状态（busy/idle）、元信息（name/cwd/sessionId/model）。
- **会话消息**：近实时查看 user / assistant / tool_use / tool_result（基于 JSONL transcript）。
- **控制**：向正在运行的同一会话注入消息（经 tmux）、**创建**新受控会话、**接管**手动启动的外部会话。
- **Web 入口**：可视化监控与操作 + 信使 Agent 面板，主令牌登录 + 长效 httpOnly cookie。
- **钉钉 IM 入口**（可选）：发送者白名单触发，经信使 Agent 间接控制本机所有 Claude。
- **MCP 控制面**：把控制能力暴露为 MCP 工具，供信使 Agent 调用。
- **高可用**：守护进程保活（崩溃退避重启）+ 手动 `reload` 优雅重启 + launchd 开机自启。

## 架构

采用 ports & adapters（六边形）架构：核心域逻辑纯净可测，所有副作用（tmux / 文件系统 / 钉钉 CLI / 各内核进程）通过适配器接口解耦。

```
   lifestream daemon (supervisor, 保活)
              │ spawn / SIGHUP 优雅重启
              ▼
   ┌───────────────────────────────────────────┐
   │  HTTP + SSE + /healthz (Fastify)           │  ← 浏览器 Web UI
   │  IM 链接器 (poll + send)                    │  ← 钉钉用户（可选）
   │  MCP 控制面 (stdio)                          │  ← 信使 Agent (headless CC)
   │            │                                │
   │            ▼   共享 AgentConductor          │
   │      ControlPlane（核心域）                 │
   │   discover · monitor · control · create · adopt │
   └──┬────────┬──────────┬──────────┬──────────┘
   TmuxAdapter AgentSource[] Clock ImAdapter / AgentRunner
```

## 环境要求

- Node.js >= 24
- tmux（用于向交互式会话注入指令）
- Claude Code CLI（`claude`）
- （可选）某钉钉 CLI，用于钉钉 IM 入口

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 生成配置
cp lifestream.config.example.json lifestream.config.json

# 3. 生成/获取主令牌（登录 Web 用；会写回配置）
npm run dev -- token
#   或构建后：node dist/cli.js token

# 4. 启动守护进程（保活 serve 子进程）
npm run dev -- daemon
#   生产建议先 npm run build，再由 launchd 托管：
#   node dist/cli.js install-launchd

# 5. 打开 Web UI
open http://127.0.0.1:8787   # 用第 3 步的主令牌登录
```

生产部署（launchd 开机自启）：

```bash
npm run build
node dist/cli.js install-launchd    # 生成 ~/Library/LaunchAgents/*.plist
launchctl load -w ~/Library/LaunchAgents/com.lifestream.daemon.plist
```

## CLI 命令

```
lifestream sessions            # 列出本机会话及状态
lifestream tail <id>           # 打印某会话的消息
lifestream serve               # 启动 HTTP/SSE 服务（通常由 daemon 拉起）
lifestream daemon [--watch]    # 保活守护进程；--watch 监听 src/ 热重启
lifestream reload              # 向 daemon 发 SIGHUP，优雅重启 serve
lifestream token               # 打印主令牌（缺失则生成并写回配置）
lifestream install-launchd     # 生成 launchd plist
lifestream mcp --mode direct|im  # 启动 MCP 控制面（供信使 Agent 调用）
```

## 配置

配置文件 `lifestream.config.json`（**已被 gitignore，不要提交**）。字段见 `lifestream.config.example.json`：

| 字段 | 说明 |
|---|---|
| `web.host` / `web.port` | Web 监听地址，默认 `127.0.0.1:8787`（仅本机） |
| `web.token` | 主令牌；`lifestream token` 可生成 |
| `tmux.socket` / `tmux.bin` | tmux socket 名与可执行文件 |
| `claude.bin` | Claude Code 可执行文件名 |
| `claude.agentPermissionMode` | 信使 Agent 的权限模式（默认 `bypassPermissions`，见安全须知） |
| `paths.claudeHome` | Claude 主目录，默认 `~/.claude` |
| `paths.stateDir` | Lifestream 状态目录，默认 `~/.lifestream` |
| `im.enabled` | 是否启用钉钉 IM 入口 |
| `im.allowedSenderIds` | 钉钉发送者白名单（键为 `senderOpenDingTalkId`） |

## 安全须知

- **仅本机**：默认监听 `127.0.0.1`。若改为局域网可访问，请自行评估风险并加固。
- **高权限默认**：信使 Agent 默认以 `bypassPermissions` 运行 Claude Code——它能在你的机器上不经确认执行工具。这是本机自用的取舍；如需收紧，改 `claude.agentPermissionMode`。
- **令牌管理**：主令牌与每设备动态令牌决定访问权限；泄露等同于交出机器控制权。设备可在 Web 界面撤销。
- **不要提交密钥**：`lifestream.config.json` 与 `.lifestream/`（设备令牌、审计等）均已 gitignore。
- **钉钉入口**：靠 `senderOpenDingTalkId` 白名单鉴权，仅命中白名单的消息会被当作指令。

## 开发

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # 编译到 dist/
```

架构与设计细节见 `docs/superpowers/specs/`（RFC / SPEC / STORY）与 `docs/superpowers/plans/`。贡献约定见 [AGENTS.md](./AGENTS.md)。

## Roadmap

- **多 Agent 抽象**：把控制面从 Claude Code 泛化到其它 CLI/headless agent（引入 `AgentProvider` 注册表）。
- **macOS 菜单栏指示器**：复用 `/api/sessions` / SSE，在系统菜单栏展示会话运行/停止数量。

## License

[MIT](./LICENSE) © 2026 Lifestream maintainers
