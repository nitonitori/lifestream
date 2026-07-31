import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import { el } from '../ui/dom';

// 选项按钮只发数字（已验证权限框数字即确认）：走 send-keys -l 字面通道，不追加 Enter。
export function promptBox(p: InteractivePrompt, onAnswer: (key: string) => void): HTMLElement {
  const question = p.question || (p.kind === 'permission' ? '会话请求授权确认' : '会话在等待你选择');
  return el('div', { class: 'confirm' },
    el('div', { class: 'confirm__title', text: '会话在等待选择' }),
    el('div', { class: 'confirm__hint mono', text: question }),
    el('div', { class: 'confirm__row' },
      ...p.options.map(o => el('button', {
        class: 'btn', text: `${o.key}. ${o.label}`, onclick: () => onAnswer(o.key),
      })),
    ),
  );
}
