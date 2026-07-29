import type { PendingAction } from '../../../src/domain/types';
import { el } from '../ui/dom';

export function confirmBox(
  actions: PendingAction[],
  onDecide: (word: '确认' | '取消') => void,
): HTMLElement {
  return el('div', { class: 'confirm' },
    el('div', { class: 'confirm__title', text: '待确认操作' }),
    el('ul', { class: 'confirm__list' }, ...actions.map(a => el('li', { text: a.description }))),
    el('div', { class: 'confirm__row' },
      el('button', { class: 'btn btn--warn', text: '确认执行', onclick: () => onDecide('确认') }),
      el('button', { class: 'btn btn--ghost', text: '取消', onclick: () => onDecide('取消') }),
    ),
  );
}
