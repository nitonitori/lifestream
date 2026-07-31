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
