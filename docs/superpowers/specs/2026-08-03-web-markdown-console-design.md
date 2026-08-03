# DESIGN: 对话区 markdown 渲染 + 消息排版

- Status: Approved (2026-08-03)
- Date: 2026-08-03
- Related: [Web 前端重构](./2026-07-29-web-frontend-refactor-design.md) · [SPEC](./2026-07-27-lifestream-spec.md)

## 1. 背景与问题

Web 控制台把 assistant 正文当纯文本渲染（`message-node.ts` 的 `bubble()` 走 `el('span', { text })`，
CSS 侧靠 `.msg__bubble { white-space: pre-wrap }` 保留换行）。而两类 assistant 正文都是 markdown：

- 信使 Agent 的回答（headless Claude Code 的输出）；
- 被监控的各内核会话转录里的 assistant 文本。

于是控制台上看到的是 markdown 源码：`## 诊断与修复结果`、`**服务本身没坏**`、`` `cli.js` ``、
`- ` 列表全部按字面显示。实测（2026-08-03，dev 8788，viewport 900px）一条信使回答约 25 行，
标题与加粗完全不成层次，反引号比它包住的标识符还显眼。

第二个问题是容器。`.msg__bubble` 的上限是 `min(76%, 640px)`，圆角 13px。这个形状适合一两句聊天，
不适合带标题、列表、代码块的长文档——900px 视口下那条回答几乎撑满气泡且纵向拉了两屏。

## 2. 目标与非目标

**目标**：assistant 正文按 markdown 渲染；Agent 长回答换成适合读长文的容器；两者都不引入 XSS 面。

**非目标**：

- 不改侧栏、顶栏、登录页、设备弹窗的视觉（用户已明确「聚焦对话区」）。
- 不做代码语法高亮（需要 highlight.js 级别的依赖或自写 tokenizer，收益不抵成本）。
- 不改后端 REST API 与 SSE 协议，不改 `TranscriptEvent` 形状。
- 不渲染内嵌 HTML —— markdown 源里的 `<div>` 一律按字面转义显示。
- 不对 user / system / 工具调用 / 工具结果做 markdown 渲染（见 §5 的边界理由）。

**推翻既有决策**：[Web 前端重构设计](./2026-07-29-web-frontend-refactor-design.md) §2 写的
「不引入任何**运行时**依赖」在本次被显式推翻，理由见 §3。当时的语境是重构不该顺手加依赖；
本次是新增能力，且用户明确要求成熟能力优先用依赖包而非手写。

## 3. 技术决策：渲染器选型

候选实测（2026-08-03，在 `/tmp` 里真装真打包真跑，用的是本仓库的 esbuild 0.28）：

| | min | gzip | 传递依赖 | TS 类型 | 原生 HTML | `javascript:` 链接 |
| --- | --- | --- | --- | --- | --- | --- |
| **markdown-it 15.0.0** | 110.4 KB | 46.5 KB | 6 | 自带 `.d.mts` | `html:false` 下自动转义 | 内置 `validateLink` 拒绝 |
| marked 18.0.7 | 40.3 KB | 12.2 KB | 0 | 自带 | 直通，需另配 DOMPurify | 不校验，需自写 |

markdown-it 在 `{ html: false }` 下的实测输出：

```
输入: <img src=x onerror=alert(1)>      输出: <p>&lt;img src=x onerror=alert(1)&gt;</p>
输入: [坏](javascript:alert(1))          输出: [坏](javascript:alert(1))     ← 不生成 <a>
输入: | 表 | 格 | ...                    输出: <table><thead>…            ← GFM 表格内置
输入: ```ts …                            输出: <pre><code class="language-ts">
```

**选 markdown-it**。决定性理由是安全性来自它的默认值，而不是我们额外挂的一层：转录里混着工具输出与
第三方内容，那是最不该由本项目手写过滤的地方。marked 便宜 34 KB gzip，代价是「两个依赖 + 自写 URL 校验」。
服务走 loopback，34 KB 不构成约束。

放 `dependencies` 而非 `devDependencies`：它是进产物的应用代码，不是构建工具（对照 esbuild 在 devDependencies）。

**实例配置**：

```ts
new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })
```

- `html: false` —— 安全边界，见上。
- `breaks: true` —— 单换行渲染成 `<br>`。聊天语境下用户按一次回车就期望换行，CommonMark 的软换行语义会把它吃掉。
- `typographer: false` —— 不要智能引号，会把技术文本里的引号和连字符改坏。
- `linkify: true` —— 裸 URL 自动成链接（`http://127.0.0.1:8787` 这类在本项目对话里很常见）。

**必须覆写 `link_open` 规则**，给外链加 `target="_blank" rel="noopener noreferrer"`。不加这条，
点任意链接就在当前标签页导航走：SSE 连接断开、会话选择与已渲染的转录窗口全部丢失，等于把控制台关了。

## 4. 模块划分

```
web/src/components/markdown.ts     新增
  ├── 模块级单例 MarkdownIt + link_open 覆写
  ├── export mdToHtml(src: string): string       纯函数 —— 可在 node 环境单测
  └── export mdBlock(src: string): HTMLElement   div.md，innerHTML = mdToHtml(src)，
                                                 再遍历 pre>code 挂「复制」按钮
web/src/components/message-node.ts 改
  ├── 新增 doc(label, ts, src): HTMLElement      文档流容器，正文用 mdBlock
  ├── messageNodes() 的 assistant 分支改用 doc
  └── bubble() / trace() 原样不动
web/public/style.css               改：.md 作用域排版 + .msg--agent 改文档流
package.json                       改：dependencies 加 markdown-it@^15
```

拆成 `mdToHtml`（纯）+ `mdBlock`（碰 DOM）不是为了对称，是为了可测：`web/` 层没有 jsdom
（`vitest.config.ts` 是 `environment: 'node'`），所以真正需要钉住的东西——md 配置与安全行为——
必须落在一个字符串进字符串出的函数里。`mdBlock` 剩下的三行 DOM 操作由浏览器实测覆盖。

`innerHTML` 的安全性由 §3 承担：HTML 全部由 markdown-it 自己的 renderer 从 token 生成，
文本节点内容经它转义，源里的原生 HTML 被当字面量。本项目不额外做 sanitize，也不该额外做——
再加一层会让「哪一层负责安全」变得模糊。

## 5. 渲染边界：只有 assistant 正文走 markdown

| 内容 | 渲染方式 | 理由 |
| --- | --- | --- |
| assistant 正文 | markdown | 本次目标 |
| user 正文（含乐观气泡） | 纯文本 | 用户输入应逐字呈现；IM 转发来的原文被重排会失真 |
| system 提示 | 纯文本 | 本项目自己产生的短文案，无 markdown |
| 工具调用入参 | 纯文本等宽 | `JSON.stringify(input, null, 2)`，markdown 会把缩进和 `-` 吃掉 |
| 工具结果 | 纯文本等宽 | 日志/命令输出，重排即不可读；且这是最可能含攻击载荷的入口 |

## 6. 视觉

**`.msg--agent` 改文档流**：去掉圆角气泡背景，改左侧 2px `--calm` 竖条；`max-width: 72ch`
（长文行长上限，比 640px 更贴排版而非贴布局）；顶部一行 `AGENT · 16:18` 角标。

角标文案对所有内核统一为 `AGENT`（沿用现状：`message-node.ts` 现在对任何 assistant 都写死
`'Agent'`，不按内核区分——内核已由侧栏标签与头部表达，这里再分一次是重复）。时间格式为
本地时区 `HH:MM`（`toLocaleTimeString` 的 2-digit 时分，不带秒）。

时间来自 `TranscriptEvent.ts`（`src/domain/types.ts:52-54`，三类真实事件都有 `ts: number`）。
这个字段前端此前完全没用过，本次是第一次消费。

**你发的消息保持右侧蓝气泡**：保留「你问 / 它答」的非对称感，长回答不再被挤在小皮肤里。

**`.md` 作用域样式**（只用现有 CSS 变量，不新增配色）：`h1-h6`（`h1/h2` 带下边框）、`p`、
`ul/ol`（含嵌套）、`blockquote`（左竖线）、行内 `code`（`--card-2` 底色）、`pre`（边框 +
横向滚动 + 右上「复制」按钮）、`table`（表头分隔 + 横向滚动容器）、`a`（`--user` 色）、`hr`。

代码块「复制」按钮走 `navigator.clipboard.writeText`，失败则 toast（`http://127.0.0.1` 是
安全上下文，clipboard API 可用）。

## 7. 测试与验收

**单测** `test/unit/web-markdown.test.ts`。仓库里已有这条路子的先例：`tsconfig.web.json:13`
把 `test/unit/web-*.test.ts` 收进 DOM lib 的类型检查，`tsconfig.test.json:6` 把它排除，
`web-api.test.ts` 就是这么跑的。断言：

1. 原生 HTML 被转义（`<img src=x onerror=…>` → `&lt;img`），不出现 `onerror=` 属性;
2. `javascript:` 链接不生成 `<a href>`;
3. GFM 表格 → `<table>`;
4. 围栏代码块 → `<pre><code class="language-ts">`;
5. 外链带 `target="_blank"` 与 `rel="noopener noreferrer"`;
6. `breaks: true` 下单换行 → `<br>`。

**门禁**：3 个 typecheck（`tsconfig.json` / `tsconfig.test.json` / `tsconfig.web.json`）+ 全套 vitest。

**浏览器实测**（不可省 —— `mdBlock` 与全部 CSS 都没有单测兜底）：dev 8788 上打开信使会话，
用真实长回答核对标题层次、列表缩进、行内与围栏代码、表格、复制按钮、外链新窗打开；
核对 user 气泡与工具折叠块未受影响；窄视口（760px 断点）下不横向溢出。通过后 build + reload 到 8787。
