import type { Api } from '../core/api';
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { loginRejected } from '../core/state';
import { $, hide, show } from '../ui/dom';

// 登录闸门：同时负责 #app 的 is-ready（等价今天 boot() 加、handleUnauth() 去）。
// auth === 'unknown'（启动探测中）保持登录卡可见 —— 与今天 CSS 默认态一致，探测慢也不会白屏。
export function mountLogin(store: Store<AppState>, api: Api): void {
  const box = $('login');
  const err = $('loginErr');
  const app = $('app');
  const token = $<HTMLInputElement>('token');

  const submit = async () => {
    try {
      await api.login(token.value);
      location.reload();          // 与今天一致：登录成功整页重载，重走启动探测
    } catch {
      store.update(loginRejected());
    }
  };

  $('loginBtn').onclick = () => void submit();
  token.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });

  store.subscribe(s => ({ auth: s.auth, notice: s.authNotice }), v => {
    err.textContent = v.notice;
    app.classList.toggle('is-ready', v.auth === 'in');
    if (v.auth === 'in') hide(box); else show(box, 'grid');
  });
}
