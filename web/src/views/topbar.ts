import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { fleetCounts } from '../core/state';
import { $ } from '../ui/dom';

export function mountTopbar(store: Store<AppState>, onOpenDevices: () => void): void {
  const busy = $('cntBusy');
  const idle = $('cntIdle');
  const conn = $('conn');
  const connText = $('connText');

  $('devicesBtn').onclick = onOpenDevices;

  // fleetCounts 每次返回新对象，靠 store 的浅比较避免无谓重写 DOM。
  store.subscribe(fleetCounts, v => {
    busy.textContent = String(v.busy);
    idle.textContent = String(v.idle);
  });

  store.subscribe(s => s.conn, c => {
    conn.classList.toggle('is-live', c === 'live');
    connText.textContent = c === 'live' ? '实时' : c === 'down' ? '重连…' : '连接中…';
  });
}
