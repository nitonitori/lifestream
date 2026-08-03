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
