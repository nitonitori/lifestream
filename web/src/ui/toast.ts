import { $ } from './dom';

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('is-shown');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('is-shown'), 2600);
}
