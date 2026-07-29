import { el } from './dom';

// 复用现有 .modal / .modal__card 样式。Esc 或点遮罩取消；promptDialog 中 Enter 提交。
// 不做焦点陷阱（YAGNI）。
function mount<T>(cancelValue: T, build: (settle: (v: T) => void) => HTMLElement[]): Promise<T> {
  return new Promise<T>(resolve => {
    const card = el('div', { class: 'modal__card' });
    const overlay = el('div', { class: 'modal is-open' }, card);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(cancelValue); };
    const settle = (v: T) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(v);
    };
    overlay.onclick = e => { if (e.target === overlay) settle(cancelValue); };
    document.addEventListener('keydown', onKey);
    card.append(...build(settle));
    document.body.appendChild(overlay);
  });
}

export function confirmDialog(o: {
  title: string;
  body: string;
  okText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return mount(false, settle => [
    el('div', { class: 'modal__title', text: o.title }),
    el('div', { class: 'modal__body', text: o.body }),
    el('div', { class: 'modal__row' },
      el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => settle(false) }),
      el('button', {
        class: o.danger ? 'btn btn--warn' : 'btn',
        text: o.okText ?? '确认',
        onclick: () => settle(true),
      }),
    ),
  ]);
}

export function promptDialog(o: { title: string }): Promise<string | null> {
  const input = el('input', { class: 'modal__input' });
  return mount<string | null>(null, settle => {
    const ok = () => { const v = input.value.trim(); settle(v ? v : null); };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    queueMicrotask(() => input.focus());
    return [
      el('div', { class: 'modal__title', text: o.title }),
      input,
      el('div', { class: 'modal__row' },
        el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => settle(null) }),
        el('button', { class: 'btn', text: '确定', onclick: ok }),
      ),
    ];
  });
}
