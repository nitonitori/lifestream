# AGENTS.md

面向在本仓库工作的 AI 编码 agent（及人类贡献者）的约定。

## 项目一句话

Lifestream：本机 Claude Code 会话监控与控制中枢；Web / 钉钉 IM / MCP 三入口，六边形架构。详见 [README](./README.md)。

## 技术栈

- TypeScript + Node.js >= 24，**ESM**（`"type": "module"`）
- Fastify（HTTP/SSE）、`@modelcontextprotocol/sdk`（MCP）、zod（校验）
- vitest（测试）、tsx（开发直跑源码）、tsc（构建）

## 架构约定（重要）

- **六边形 / ports & adapters**：
  - `src/domain/` —— 纯核心逻辑，**无副作用**，全部可单测。
  - `src/ports/` —— 接口定义（TmuxAdapter / ClaudeHomeAdapter / ImAdapter / AgentRunner / …）。
  - `src/adapters/` —— 副作用实现（tmux / 文件系统 / 钉钉 CLI / claude 进程）。
  - `src/server/`、`src/mcp/`、`src/im/` —— 入口与编排。
- 新增副作用一律放到 adapter 后面，通过 port 注入；domain 不直接碰 IO。
- ESM 相对导入必须带 `.js` 后缀（如 `import { x } from './foo.js'`），即使源文件是 `.ts`。

## 常用命令

```bash
npm test            # 跑全部测试（vitest run）
npm run test:watch  # 监听模式
npm run typecheck   # tsc --noEmit
npm run build       # 编译到 dist/
npm run dev -- <sub># 开发态直跑 CLI 子命令（tsx）
```

## 测试约定

- 遵循 **TDD（红-绿-重构）**：先写失败测试，再实现。
- 测试放在 `test/`：`unit/`（纯逻辑）、`component/`（路由/组合，用 Fastify `.inject()`）、`integration/`（tmux、CLI、真实 FS）。
- 副作用用 `test/fakes/` 里的 fake 替身；纯命令构造函数单独测（如 `buildSendArgs`）。
- 改动后必须 `npm test` 与 `npm run typecheck` 全绿再提交。

## 代码风格

- 与周围代码保持一致：本仓库注释以中文为主，命名与惯用法沿用现有文件。
- 优先小而纯的函数；把「决策」放 domain、「执行」放 adapter。

## 提交约定

- Conventional Commits：`feat:` / `fix:` / `docs:` / `test:` / `refactor:` …，可带 scope，如 `feat(im): …`。

## 安全红线

- **不要提交** `lifestream.config.json`、`.lifestream/`（含令牌/审计）—— 已 gitignore。
- 不要在代码、测试、文档、示例配置里写入**真实**个人信息（姓名、钉钉 openDingTalkId / userId、真实令牌、本机绝对路径）。一律用占位符或假数据。
- 示例配置只用占位符（如 `<your-open-dingtalk-id>`）。
