import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import { el } from '../ui/dom';

// 选项按钮只发数字键（已验证权限框数字即确认）；需要“移动后回车”的菜单用键盘行兜底。
const KEYPAD: [string, string][] = [['↑', 'Up'], ['↓', 'Down'], ['⏎ 确认', 'Enter'], ['Esc', 'Escape']];

export function promptBox(p: InteractivePrompt, onKeys: (keys: string[]) => void): HTMLElement {
  const question = p.question || (p.kind === 'permission' ? '会话请求授权确认' : '会话在等待你选择');
  return el('div', { class: 'confirm' },
    el('div', { class: 'confirm__title', text: '会话在等待选择' }),
    el('div', { class: 'confirm__hint mono', text: question }),
    el('div', { class: 'confirm__row' },
      ...p.options.map(o => el('button', {
        class: 'btn', text: `${o.key}. ${o.label}`, onclick: () => onKeys([o.key]),
      })),
    ),
    el('div', { class: 'confirm__row' },
      ...KEYPAD.map(([label, key]) => el('button', {
        class: 'btn btn--ghost', text: label, onclick: () => onKeys([key]),
      })),
    ),
  );
}
