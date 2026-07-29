export interface ElProps {
  class?: string;
  text?: string;
  style?: string;
  onclick?: () => void;
}

type Child = Node | string | null | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.style) node.setAttribute('style', props.style);
  if (props.onclick) node.onclick = props.onclick;
  for (const c of children) {
    if (!c) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// 静态骨架里的元素，缺失即是 index.html 与代码脱节 —— 早失败好过后面某处静默 null 崩。
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: #${id}`);
  return node as T;
}

export const clear = (node: Element): void => { node.replaceChildren(); };
export const show = (node: HTMLElement, display = 'block'): void => { node.style.display = display; };
export const hide = (node: HTMLElement): void => { node.style.display = 'none'; };
