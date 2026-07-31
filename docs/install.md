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

**必须在含 `dist` 的目录下执行 install**：安装时按 `process.cwd()` 找
`dist/hooks/lifestream-heartbeat.js`（找不到就报「先执行 npm run build」），而且**注入进
settings.json 的是这个 dist 的绝对路径**。所以：

- 部署实例请先 `cd ~/apps/lifestream` 再装，别在开发目录里给部署实例装；
- 装完把该目录挪走 / 删掉 / 重命名，心跳会**静默停止**（宿主照常执行 hook，只是脚本不在了），
  此时 `lifestream hooks status` 会报「注入的脚本 … 已丢失」——重新在正确目录下 install 即可修。

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

每个活跃会话对应一个 `<sessionId>.json`。`lifestream hooks status` 会报出三件事：五个事件装了几个、
注入的脚本还在不在、每个心跳目录里的文件数与最近一次心跳时间。

> 会话出现在 Web 会话列表里（内核标签 `QODER` / `QW`）由**后续任务**接上 —— 本次只交付
> 「往 settings.json 注入 hook」与「心跳落盘到 `~/.lifestream/heartbeats/`」这两件事。

### 卸载

    lifestream hooks uninstall --target all

只删 lifestream 自己那一项，其它厂商的 hook 与文件里的其它配置保持原样。备份文件不会被自动
清理，确认无碍后可以手动删掉 `~/.qoder/settings.json.lifestream-backup-*` 与
`~/.qoderwork/settings.json.lifestream-backup-*`。

**卸载不清理心跳目录**：`~/.lifestream/heartbeats/<target>/` 下已写下的 `*.json` 会残留（卸载只
改 settings.json）。需要时自己删：

    rm -f ~/.lifestream/heartbeats/qoder-ide/*.json ~/.lifestream/heartbeats/qoderwork/*.json

### 已知精度上限

hook 协议没有周期性心跳，心跳只在事件发生时刷新。因此一个已经关掉、但最后一个事件不是 `Stop`
的会话，会在 30 分钟（`heartbeatTtlMs`）内继续显示为在线。两个桌面产品同样受限。

> `heartbeatTtlMs` 这个判活口径由**后续任务**生效（本次只交付注入与心跳落盘，还没有谁去读这些
> 心跳文件）。

## Qoder CLI

`qodercli` 是第二个**可控**内核，不需要装任何 hook —— 它每个会话一个真实进程，lifestream 直接
读它的事件日志判存活。用 `POST /api/sessions {"cwd":"…","kernel":"qodercli"}` 或 MCP
`create_session` / `propose_create_session` 起会话（Web 的「新建」按钮固定起 Claude 会话）。
