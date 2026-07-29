import { $ } from '../ui/dom';

// composer 的 DOM 留在 index.html（布局的一部分），本模块只接管其行为。
export function mountComposer(onSend: (text: string) => void): { setPlaceholder(text: string): void } {
  const input = $<HTMLTextAreaElement>('composerInput');
  const button = $<HTMLButtonElement>('sendBtn');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  };
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow();
    onSend(text);
  };

  button.onclick = submit;
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  return { setPlaceholder: text => { input.placeholder = text; } };
}
