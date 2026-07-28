// ⚠️ Claude Code TUI 专用解析器（内核隔离处）。
// 受控会话跑在 tmux 里，偶尔会停在一个 TUI 选择器上等键盘输入——权限框
// (`Do you want to proceed? 1.Yes 2.No`) 或模型自发的 `AskUserQuestion` 多选菜单。
// 本模块把 capture-pane 的纯文本解析成结构化提示；换其它内核时，替换本文件的解析与键位语义即可，
// 领域核心（capturePane/sendKeys）与路由/UI 均通用、不受影响。

export interface InteractivePrompt {
  kind: 'permission' | 'select';
  question: string;
  options: { key: string; label: string }[];
  raw: string;
}

// 去掉 tmux capture 里的 TUI 边框字符，便于按内容匹配；保留选择光标 ❯。
function clean(line: string): string {
  return line.replace(/[│┃╭╮╰╯─━┄┈┆┊]/g, ' ').trimEnd().replace(/^\s+/, '');
}

// 编号项：允许前置光标(❯/>/▶)、编号后接 . 或 )、其后为标签。
const OPTION_RE = /^[❯>▶●•]?\s*(\d+)[.)]\s+(.+?)\s*$/;

export function parseInteractivePrompt(pane: string): InteractivePrompt | null {
  if (!pane) return null;
  const rawLines = pane.replace(/\r/g, '').split('\n');
  const tailStart = Math.max(0, rawLines.length - 30);
  const tailRaw = rawLines.slice(tailStart);
  const cleaned = tailRaw.map(clean);

  // 收集 tail 中所有编号项(升序 idx)。
  const opts: { idx: number; key: string; label: string }[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i].match(OPTION_RE);
    if (m) opts.push({ idx: i, key: m[1], label: m[2].trim() });
  }
  if (opts.length < 2) return null;

  // 取最靠近末尾的“连续编号块”(key 依次 +1)，避免把上方转录里零散的 “1. …/2. …” 混进来。
  const end = opts.length - 1;
  let start = end;
  while (start - 1 >= 0 && Number(opts[start - 1].key) === Number(opts[start].key) - 1) start--;
  const block = opts.slice(start, end + 1);
  if (block.length < 2) return null;

  // 防误报：只有出现选择光标 ❯、页脚 “esc to cancel/interrupt”、或权限问句时才判定为真提示。
  const tailText = tailRaw.join('\n');
  const hasCursor = /❯/.test(tailText);
  const hasFooter = /esc to (cancel|interrupt|go back)/i.test(tailText);
  const proceed = /Do you want to proceed\??/i.test(tailText) || /requires approval/i.test(tailText);
  if (!hasCursor && !hasFooter && !proceed) return null;

  // question：编号块之上最近的、非空且非编号项的清理行。
  let question = '';
  for (let i = block[0].idx - 1; i >= 0; i--) {
    const c = cleaned[i];
    if (!c || OPTION_RE.test(c)) continue;
    question = c;
    break;
  }

  const kind: InteractivePrompt['kind'] = proceed ? 'permission' : 'select';
  return {
    kind,
    question,
    options: block.map(o => ({ key: o.key, label: o.label })),
    raw: rawLines.slice(Math.max(0, rawLines.length - 15)).join('\n'),
  };
}
