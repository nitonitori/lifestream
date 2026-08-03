# 对话区 markdown 渲染 + 消息排版 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web 控制台里 assistant 正文按 markdown 渲染（标题/列表/表格/代码块/链接），Agent 长回答从 640px 圆角气泡换成左竖条文档流。

**Architecture:** 引入 `markdown-it@15` 作为唯一新增运行时依赖，`html: false` 让原生 HTML 自动转义、`javascript:` 链接被内置 `validateLink` 拒绝——安全性来自库的默认值，本项目不再叠加 sanitizer。新增 `web/src/components/markdown.ts`，拆成纯函数 `mdToHtml`（字符串进字符串出，可在 node 环境单测）与 DOM 函数 `mdBlock`（`innerHTML` + 挂复制按钮）。`web/src/components/message-node.ts` 的 assistant 分支从 `bubble()` 换成新的 `doc()`；user / system / 工具调用 / 工具结果一律保持纯文本。

**Tech Stack:** TypeScript ESM、node ≥ 24、markdown-it 15、esbuild（web bundle → `web/public/app.js`）、vitest 3（`environment: 'node'`）、tsc 三份配置。

## Global Constraints

- 设计文档是唯一需求来源：`docs/superpowers/specs/2026-08-03-web-markdown-console-design.md`。
- 新增依赖**只有一个**：`markdown-it@^15`，放 `package.json` 的 `dependencies`（它是进产物的应用代码，不是构建工具）。**不要**装 `@types/markdown-it`（那是给 14.x 的；15.0.0 自带 `dist/markdown-it.d.mts`），**不要**装 DOMPurify、highlight.js 或任何其它包。
- markdown-it 实例配置，四个字段精确：`{ html: false, linkify: true, breaks: true, typographer: false }`。
- **必须**覆写 `md.renderer.rules.link_open` 给链接加 `target="_blank"` 与 `rel="noopener noreferrer"`。不加这条，点任意链接就在当前标签页导航走：SSE 断开、会话选择与已渲染的转录窗口全丢，等于把控制台关了。
- 渲染边界：**只有 `kind === 'assistant'` 的正文走 markdown**。user 正文（含乐观气泡）、system 提示、工具调用入参、工具结果一律保持现有纯文本 + 等宽 + `pre-wrap`。工具结果是最可能含攻击载荷的入口，也是最不能被重排的内容。
- 不做语法高亮；不改侧栏 / 顶栏 / 登录页 / 设备弹窗的视觉；不改后端 REST API、SSE 协议、`TranscriptEvent` 形状；不引入 jsdom。
- CSS 只用 `style.css` 顶部 `:root` 里已有的变量（`--card-2` / `--line` / `--muted` / `--calm` / `--user` / `--font-mono` / `--font-display` 等），**不新增配色变量**。
- **测试环境没有 DOM**（`vitest.config.ts` 是 `environment: 'node'`，仓库无 jsdom）。可单测的只有 `mdToHtml`；`mdBlock` 的 DOM 部分与全部 CSS 靠 Task 2 的真实浏览器实测兜底，**不要为它们发明 DOM 测试**。
- web 层测试文件命名必须是 `test/unit/web-*.test.ts`：`tsconfig.web.json:13` 靠这个 glob 把它纳入 DOM lib 的类型检查，`tsconfig.test.json:6` 靠同一个 glob 把它排除。命名错了就会在错误的 lib 下被检查。
- 三份 typecheck 全绿才算门禁通过：`tsc --noEmit -p tsconfig.json`、`-p tsconfig.test.json`、`-p tsconfig.web.json`。
- node / tsc / vitest / esbuild 一律用绝对路径 `/Users/l/.nvm/versions/node/v24.18.0/bin/node`（规避 nvm 陷阱）。
- `npm run build` 在本沙箱里会挂住，改直调 `./node_modules/.bin/tsc -p tsconfig.json` 与 `./node_modules/.bin/esbuild …`（见各任务给出的完整命令）。
- 工作目录是开发实例 `~/dev-ai/lifestream`，分支 `main`。部署实例 `~/apps/lifestream`（8787）只在 Task 3 才碰。
- 用中文写提交信息、注释与文档。
- **本计划的写法约定**：新增文件给出完整代码；对既有文件给出精确的替换规则（哪一段换成哪一段）——动手前先把该文件整份读一遍。

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `package.json` | 依赖清单 | 改：`dependencies` 加 `markdown-it` |
| `web/src/components/markdown.ts` | markdown → HTML / DOM 的唯一收口。持有 md 实例与安全配置 | 新增 |
| `test/unit/web-markdown.test.ts` | 钉住 md 配置与安全行为 | 新增 |
| `web/src/components/message-node.ts` | 转录事件 → DOM 节点。新增 `doc()`，assistant 分支改道 | 改 |
| `web/public/style.css` | `.md` 作用域排版 + `.msg--agent` 文档流；删两条变死的规则 | 改 |
| `AGENTS.md` | 技术栈清单补 markdown-it | 改 |

`markdown.ts` 只负责「markdown 文本 → 节点」，不认识 `TranscriptEvent`；`message-node.ts` 只负责「事件 → 用哪种容器」，不认识 markdown 语法。这条边界是为了以后换渲染器时只动一个文件。

---

### Task 1: markdown 渲染核心（依赖 + `mdToHtml` + 单测）

**Files:**
- Modify: `package.json`（`dependencies` 段，第 21-27 行）
- Create: `web/src/components/markdown.ts`
- Test: `test/unit/web-markdown.test.ts`

**Interfaces:**
- Consumes: `el` from `web/src/ui/dom.ts`（签名 `el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElProps, ...children: (Node|string|null|false)[]): HTMLElementTagNameMap[K]`，`ElProps = { class?, text?, style?, onclick? }`）；`toast` from `web/src/ui/toast.ts`（签名 `toast(msg: string): void`）。
- Produces:
  - `mdToHtml(src: string): string` —— 纯函数，Task 1 的单测对象。
  - `mdBlock(src: string): HTMLElement` —— 返回 `div.md`，Task 2 的 `doc()` 用它渲染正文。

- [ ] **Step 1: 装依赖**

```bash
cd ~/dev-ai/lifestream
/Users/l/.nvm/versions/node/v24.18.0/bin/npm install markdown-it@^15
```

装完确认版本与自带类型都在（**不要**再装 `@types/markdown-it`）：

```bash
node -e "console.log(require('markdown-it/package.json').version)"
ls node_modules/markdown-it/dist/markdown-it.d.mts
```

Expected: 打印 `15.0.0`（或 15.x），并列出该 `.d.mts` 文件。

- [ ] **Step 2: 写失败的测试**

创建 `test/unit/web-markdown.test.ts`。这 7 条断言的期望值全部来自对 markdown-it 15.0.0 在本配置下的真实输出核对，不是猜的：

```ts
import { describe, it, expect } from 'vitest';
import { mdToHtml } from '../../web/src/components/markdown';

// 这个文件钉住的是 md 实例的配置与安全行为 —— 也就是本次唯一无法靠浏览器
// 一眼看出的部分（转义漏了在页面上是「看起来正常」的）。
describe('mdToHtml', () => {
  // html:false 的核心保证：源里的原生 HTML 变字面量，而不是活标签。
  // 注意不能断言 not.toContain('onerror')：转义后的文本里照样有这几个字，
  // 真正要挡的是 '<img' 这个活标签。
  it('原生 HTML 被转义成字面量', () => {
    const html = mdToHtml('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('javascript: 链接不生成 <a>', () => {
    expect(mdToHtml('[坏](javascript:alert(1))')).not.toContain('<a');
  });

  // 缺了 target/rel，点链接会把控制台整页导航走（SSE 断、状态全丢）。
  it('链接带 target=_blank 与 rel=noopener noreferrer', () => {
    const html = mdToHtml('[x](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  // linkify 出来的裸 URL 走的是同一条 link_open 规则，一并钉住。
  it('裸 URL 自动成链接且同样带 target/rel', () => {
    const html = mdToHtml('打开 http://127.0.0.1:8787 看看');
    expect(html).toContain('<a href="http://127.0.0.1:8787" target="_blank" rel="noopener noreferrer">');
  });

  it('GFM 表格渲染成 table 且保留列对齐', () => {
    const html = mdToHtml('| 表 | 格 |\n| --- | ---: |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th style="text-align:right">格</th>');
  });

  it('围栏代码块带 language class，内容原样保留', () => {
    const html = mdToHtml('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x: number = 1;');
  });

  // breaks:true —— 聊天语境下按一次回车就该换行，CommonMark 的软换行会把它吃掉。
  it('单换行渲染成 <br>', () => {
    expect(mdToHtml('a\nb')).toContain('<br>');
  });

  it('嵌套列表保留层级', () => {
    const html = mdToHtml('- a\n  - b');
    expect(html.match(/<ul>/g)?.length).toBe(2);
  });
});
```

- [ ] **Step 3: 跑测试，确认它以「模块不存在」失败**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-markdown.test.ts
```

Expected: FAIL —— `Failed to resolve import "../../web/src/components/markdown"`。

- [ ] **Step 4: 写实现**

创建 `web/src/components/markdown.ts`：

```ts
import MarkdownIt from 'markdown-it';
import { el } from '../ui/dom';
import { toast } from '../ui/toast';

// html:false 是本文件的安全边界：源里的原生 HTML 被转义成字面量，
// 且 markdown-it 内置的 validateLink 会拒掉 javascript:/vbscript:/file: 链接。
// 因此 mdBlock 里的 innerHTML 是安全的，本项目不再叠加 sanitizer ——
// 多一层会让「哪一层负责安全」变模糊。
// breaks:true：聊天语境下按一次回车就该换行。typographer:false：智能引号会改坏技术文本。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

// 外链必须新窗打开。在当前标签页导航走 = SSE 断开、会话选择与已渲染的转录窗口全部丢失。
const renderLinkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return renderLinkOpen(tokens, idx, options, env, self);
};

export const mdToHtml = (src: string): string => md.render(src);

// 按钮挂在 pre 内部（绝对定位）。code.textContent 不含它，所以复制到的就是纯代码。
function copyButton(pre: HTMLPreElement): HTMLElement {
  return el('button', {
    class: 'md__copy',
    text: '复制',
    onclick: () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => toast('已复制'), () => toast('复制失败'));
    },
  });
}

export function mdBlock(src: string): HTMLElement {
  const box = el('div', { class: 'md' });
  box.innerHTML = mdToHtml(src);
  for (const pre of box.querySelectorAll('pre')) pre.appendChild(copyButton(pre));
  return box;
}
```

- [ ] **Step 5: 跑测试，确认 8 条全绿**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run test/unit/web-markdown.test.ts
```

Expected: PASS，8 passed。

这里能在 node 环境下 import 成功，靠的是整条依赖链的模块顶层都不碰 DOM：`ui/toast.ts` 的 `$('toast')` 在函数体内，`ui/dom.ts` 全是函数（已核对）。所以若报 `document is not defined`，只可能是实现里有 DOM 操作被提到了模块顶层——`mdBlock` / `copyButton` 里的 DOM 调用必须留在函数体内，模块顶层只允许建 md 实例。

- [ ] **Step 6: 三份 typecheck**

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json
```

Expected: 三条都零输出、退出码 0。（`link_open` 覆写那段已在 `tsconfig.web.json` 同款选项下验证过：`types: []` + `verbatimModuleSyntax` + `strict` + `skipLibCheck` 编译干净。）

- [ ] **Step 7: 跑全套测试，确认没碰坏别的**

```bash
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
```

Expected: 全绿（此前基线 274 passed，加本次 8 条 → 282 passed）。若只有 `test/integration/tmux.test.ts` 超时，先单独重跑那个文件确认是并行负载抖动而非回归。

- [ ] **Step 8: 提交**

```bash
git add package.json package-lock.json web/src/components/markdown.ts test/unit/web-markdown.test.ts
git commit -m "$(cat <<'EOF'
feat(web): 接入 markdown-it，收口 markdown → HTML/DOM

html:false 让原生 HTML 自动转义、内置 validateLink 拒掉 javascript: 链接，
安全性来自库的默认值，不再叠加 sanitizer。覆写 link_open 加 target/rel ——
外链在当前页导航走会断掉 SSE 并丢失已渲染的转录。

拆成纯函数 mdToHtml 与 DOM 函数 mdBlock：web 层无 jsdom，配置与安全行为
只有落在字符串进字符串出的函数里才钉得住。
EOF
)"
```

---

### Task 2: assistant 消息改文档流 + `.md` 样式

**Files:**
- Modify: `web/src/components/message-node.ts`（整份 39 行，先读一遍）
- Modify: `web/public/style.css`（`.msg--agent .msg__bubble` 在第 146 行、`.msg--agent .msg__role` 在第 149 行；新样式追加到 `/* ---------- Messages ---------- */` 段末即第 162 行之后；响应式补丁在第 231-241 行的 `@media (max-width: 760px)` 里）
- Test: 无新增单测（web 层无 jsdom，见 Global Constraints）。本任务由 Step 5-7 的真实浏览器实测兜底。

**Interfaces:**
- Consumes: `mdBlock(src: string): HTMLElement` from `./markdown`（Task 1 产出）；`el` from `../ui/dom`；`TranscriptEvent` from `../../../src/domain/types`（`assistant` 分支的字段：`uuid: string`、`ts: number`、`text: string`、`toolUses: { id, name, input }[]`）。
- Produces: `doc(label: string, ts: number, src: string): HTMLElement`。`bubble` 的 `role` 参数从 `'user' | 'agent' | 'system'` 收窄成 `'user' | 'system'`（`'agent'` 在本任务后再无调用方）。`messageNodes` 与 `bubble` 的导出名不变，`web/src/transcript/view.ts:2` 的导入无需改动。

- [ ] **Step 1: 改 `message-node.ts`**

三处改动。改完整份文件应该是这样（`trace` 与 `safeJson` 一字未动，此处为完整文件以便核对）：

```ts
import type { TranscriptEvent } from '../../../src/domain/types';
import { el } from '../ui/dom';
import { mdBlock } from './markdown';

export function bubble(role: 'user' | 'system', label: string, text: string): HTMLElement {
  return el('div', { class: `msg msg--${role}` },
    el('div', { class: 'msg__bubble' },
      el('span', { class: 'msg__role', text: label }),
      el('span', { text }),
    ),
  );
}

const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// Agent 长回答走文档流而非气泡：带标题/列表/代码块的长文塞进 640px 圆角气泡会很挤。
// 角标对所有内核统一写 AGENT —— 内核已由侧栏标签与头部表达，这里再分一次是重复。
export function doc(label: string, ts: number, src: string): HTMLElement {
  return el('div', { class: 'msg msg--agent' },
    el('div', { class: 'msg__doc' },
      el('div', { class: 'msg__stamp', text: `${label} · ${hhmm(ts)}` }),
      mdBlock(src),
    ),
  );
}

function trace(variant: 'tool' | 'result', head: string, body: string, isError: boolean): HTMLElement {
  const box = el('div', { class: `trace trace--${variant} is-collapsed` + (isError ? ' is-error' : '') });
  const h = el('div', { class: 'trace__head', text: head + ' ▸' });
  h.onclick = () => {
    box.classList.toggle('is-collapsed');
    h.textContent = head + (box.classList.contains('is-collapsed') ? ' ▸' : ' ▾');
  };
  box.append(h, el('div', { class: 'trace__body', text: body }));
  return box;
}

const safeJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

// 一个转录事件 → 0..n 个节点（meta 不渲染）
export function messageNodes(e: TranscriptEvent): HTMLElement[] {
  if (e.kind === 'user') return [bubble('user', '你', e.text)];
  if (e.kind === 'assistant') {
    const nodes: HTMLElement[] = [];
    // 只有 assistant 正文走 markdown：工具入参是 JSON、工具结果是日志，重排即不可读。
    if (e.text && e.text.trim()) nodes.push(doc('AGENT', e.ts, e.text));
    for (const t of e.toolUses) nodes.push(trace('tool', `调用 ${t.name}`, safeJson(t.input), false));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('result', '工具结果', e.content, e.isError)];
  return [];
}
```

- [ ] **Step 2: 删两条变死的 CSS 规则**

`web/public/style.css` 里删掉这两行（`bubble('agent', …)` 已无调用方，`.msg--agent` 下不再有 `.msg__bubble` 或 `.msg__role`）：

```css
.msg--agent .msg__bubble { background: var(--card); border: 1px solid var(--line); border-left: 2px solid var(--calm); border-bottom-left-radius: 5px; }
```

```css
.msg--agent .msg__role { color: var(--calm); }
```

`.msg--user .msg__bubble`、`.msg--user .msg__role`、`.msg--system .*` 全部保留不动。

- [ ] **Step 3: 加文档流与 `.md` 样式**

追加到 `/* ---------- Messages ---------- */` 段末（`.trace--result.is-error` 那行之后、`/* ---------- Confirm banner ---------- */` 之前）：

```css
/* Agent 文档流：不是气泡，是一段带左竖条的文档。72ch 是长文行长上限（贴排版而非贴布局）。 */
.msg--agent { display: block; margin: 18px 0; }
.msg__doc { max-width: 72ch; border-left: 2px solid var(--calm); padding: 1px 0 1px 14px; }
.msg__stamp { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--calm); margin-bottom: 8px; }

/* ---------- Markdown ---------- */
.md { word-break: break-word; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 10px 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-family: var(--font-display); font-weight: 600; line-height: 1.3; margin: 20px 0 10px; }
.md h1 { font-size: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.md h2 { font-size: 17px; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
.md h3 { font-size: 15px; }
.md h4, .md h5, .md h6 { font-size: 14px; color: var(--muted); }
.md ul, .md ol { margin: 10px 0; padding-left: 22px; }
.md li { margin: 4px 0; }
.md li > ul, .md li > ol { margin: 4px 0; }
.md blockquote { margin: 12px 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--line); color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
.md a { color: var(--user); text-decoration: underline; text-underline-offset: 2px; }
.md code { font-family: var(--font-mono); font-size: 12.5px; background: var(--card-2); border-radius: 5px; padding: 1.5px 5px; }
.md pre { position: relative; margin: 12px 0; padding: 12px 14px; background: var(--card-2); border: 1px solid var(--line); border-radius: 9px; overflow-x: auto; }
.md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
.md__copy { position: absolute; top: 7px; right: 7px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-family: var(--font-mono); font-size: 10px; padding: 3px 8px; cursor: pointer; opacity: 0; transition: opacity .15s; }
.md pre:hover .md__copy, .md__copy:focus-visible { opacity: 1; }
/* display:block + overflow-x 是宽表格不撑破布局的标准做法。 */
.md table { display: block; overflow-x: auto; max-width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.md th, .md td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.md thead th { background: var(--card-2); font-weight: 600; }
```

- [ ] **Step 4: 补窄屏断点**

在第 231 行起的 `@media (max-width: 760px) { … }` 块内，紧跟现有的 `.msg__bubble { max-width: 84%; }` 之后加一行：

```css
  .msg__doc { max-width: 100%; }
```

- [ ] **Step 5: 门禁 + 打包**

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json
/Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vitest/vitest.mjs run
./node_modules/.bin/esbuild web/src/main.ts --bundle --format=esm --target=es2022 --charset=utf8 --sourcemap --outfile=web/public/app.js
```

Expected: 三份 typecheck 零输出；vitest 全绿；esbuild 打出 `web/public/app.js`（体积会从 ~31KB 涨到 ~140KB，未压缩带 sourcemap，符合预期）。

- [ ] **Step 6: 起开发实例**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/   # 已在跑就跳过下一条
nohup /Users/l/.nvm/versions/node/v24.18.0/bin/node ./node_modules/.bin/tsx src/cli.ts serve > /tmp/ls-dev-serve.log 2>&1 & disown
sleep 4; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
```

Expected: 最终 `200`。

- [ ] **Step 7: 浏览器实测（本任务的验收核心，不可省）**

打开 `http://127.0.0.1:8788`（令牌在 `~/dev-ai/lifestream/lifestream.config.json` 的 `web.token`），选「信使 Agent」会话，逐项核对：

1. assistant 正文里 `## 标题` 成真标题（带下边框）、`**粗**` 成粗体、反引号不再出现、`- ` 成项目符号列表；
2. 代码块有边框与底色，鼠标悬停右上出现「复制」，点它 toast「已复制」，粘贴出来是纯代码（不含「复制」二字）；
3. Agent 块是左侧青色竖条 + `AGENT · HH:MM` 角标，**不是**圆角气泡；行长明显收窄（72ch）；
4. **你发的消息仍是右侧蓝色圆角气泡**（未被误改）；
5. `⚙ 调用 …` 与 `工具结果` 折叠块外观与折叠行为不变，正文仍是等宽纯文本；
6. 若转录里有 markdown 表格，它有表头底色且宽表格自身横向滚动、不撑破页面；
7. 若有链接，点一下应**新开标签页**，原标签页的会话与连接状态不变（这条直接验证 `link_open` 覆写）；
8. 窗口缩到 700px 宽：Agent 块占满宽度、无横向溢出。

任一条不符就修 CSS/代码后回 Step 5 重跑，不要带着已知视觉缺陷进 Task 3。

- [ ] **Step 8: 提交**

```bash
git add web/src/components/message-node.ts web/public/style.css
git commit -m "$(cat <<'EOF'
feat(web): assistant 正文按 markdown 渲染，长回答改文档流

640px 圆角气泡装不下带标题/列表/代码块的长文。assistant 改成左竖条 +
72ch 行长的文档块，附 AGENT · HH:MM 角标（首次消费 TranscriptEvent.ts）。
你发的消息保持右侧气泡，保留「你问它答」的非对称感。

工具入参与工具结果继续走纯文本等宽：JSON 与日志被 markdown 重排即不可读，
且工具结果是最可能含攻击载荷的入口。bubble 的 role 收窄成 user|system，
随之删掉两条已无调用方的 CSS 规则。
EOF
)"
```

---

### Task 3: 上线部署实例 + 文档口径

**Files:**
- Modify: `AGENTS.md`（第 11-13 行的「技术栈」清单）
- 部署实例 `~/apps/lifestream`（拉取 + 装依赖 + 构建 + reload）

**Interfaces:**
- Consumes: Task 1、Task 2 的全部提交。
- Produces: 无代码接口。产出是 8787 上跑着新前端的部署实例。

- [ ] **Step 1: 改 `AGENTS.md` 技术栈清单**

把这一行：

```markdown
- Fastify（HTTP/SSE）、`@modelcontextprotocol/sdk`（MCP）、zod（校验）
```

换成：

```markdown
- Fastify（HTTP/SSE）、`@modelcontextprotocol/sdk`（MCP）、zod（校验）、markdown-it（Web 端 assistant 正文渲染，`html:false`）
```

- [ ] **Step 2: 提交文档**

```bash
git add AGENTS.md
git commit -m "docs(agents): 技术栈补 markdown-it"
```

- [ ] **Step 3: 部署实例拉取并装依赖**

部署实例的 origin 是本地开发仓库（不是 GitHub），所以直接从本地拉：

```bash
cd ~/apps/lifestream
git status --short          # 必须干净；有改动先停下问用户，不要覆盖
git pull
/Users/l/.nvm/versions/node/v24.18.0/bin/npm install
```

Expected: `git pull` 带进本次三个提交；`npm install` 装上 markdown-it。

- [ ] **Step 4: 构建**

```bash
cd ~/apps/lifestream
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/esbuild web/src/main.ts --bundle --format=esm --target=es2022 --minify --charset=utf8 --sourcemap --outfile=web/public/app.js
```

Expected: 两条都成功；`web/public/app.js` 被重写（minify 后约 100KB 上下）。

- [ ] **Step 5: reload 并验活**

```bash
cd ~/apps/lifestream
/Users/l/.nvm/versions/node/v24.18.0/bin/node dist/cli.js reload
sleep 3
curl -s -o /dev/null -w 'root:%{http_code}\n' http://127.0.0.1:8787/
curl -s -o /dev/null -w 'health:%{http_code}\n' http://127.0.0.1:8787/healthz
```

Expected: `root:200` 与 `health:200`。

- [ ] **Step 6: 部署实例上再看一眼**

浏览器打开 `http://127.0.0.1:8787`，确认 markdown 渲染与文档流在部署实例上同样生效（这一步防的是「只在 dev 的未压缩包里成立」）。若页面仍是旧样子，先硬刷新（app.js 可能被缓存）。

- [ ] **Step 7: 收尾**

```bash
cd ~/dev-ai/lifestream
git log --oneline -4
git status --short
```

Expected: 三个提交在列；工作区干净（`web/public/app.js` 已 gitignore，不该出现在 status 里）。

不要自己 `git push`：推送到公开 origin 前需要先做敏感信息扫描并向用户报告结论。

---

## 完成标准

- 三份 typecheck 全绿；vitest 全绿（基线 274 + 新增 8 = 282 passed）。
- 开发实例（8788）与部署实例（8787）上，assistant 正文都按 markdown 渲染，Agent 块是文档流形态。
- 你发的消息仍是右侧气泡；工具调用与工具结果仍是等宽纯文本折叠块。
- 代码块「复制」可用；外链新窗打开。
- 新增依赖只有 `markdown-it`，且在 `dependencies` 里。
