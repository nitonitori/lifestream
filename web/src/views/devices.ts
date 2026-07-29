import type { Api, DeviceInfo } from '../core/api';
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { unauthorized } from '../core/state';
import { $, clear, el } from '../ui/dom';
import { toast } from '../ui/toast';

const relTime = (ts: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
};

export function mountDevices(store: Store<AppState>, api: Api): { open(): Promise<void> } {
  const modal = $('devicesModal');
  const list = $('devicesList');
  const close = () => modal.classList.remove('is-open');

  $('devicesClose').onclick = close;
  $('logoutBtn').onclick = () => void logout();
  modal.onclick = e => { if (e.target === modal) close(); };
  // 掉线即关弹窗（等价今天 handleUnauth 里那句 classList.remove）
  store.subscribe(s => s.auth, a => { if (a === 'out') close(); });

  const render = async () => {
    let items: DeviceInfo[];
    try { items = await api.devices(); } catch { return; }
    clear(list);
    if (items.length === 0) {
      list.appendChild(el('div', { class: 'rail__empty', text: '暂无设备。' }));
      return;
    }
    for (const d of items) {
      const meta = `最近活跃 ${relTime(d.lastSeenAt)}${d.userAgent ? ' · ' + d.userAgent.slice(0, 46) : ''}`;
      list.appendChild(el('div', { class: 'device' },
        el('div', { class: 'device__name', text: d.name },
          d.current ? el('span', { class: 'cur', text: '本机' }) : null),
        el('div', { class: 'device__meta', text: meta }),
        el('button', {
          class: 'btn btn--ghost device__revoke',
          text: d.current ? '退出' : '撤销',
          onclick: () => void revoke(d.id, d.current),
        }),
      ));
    }
  };

  const revoke = async (id: string, isCurrent: boolean) => {
    try { await api.revokeDevice(id); } catch { toast('撤销失败'); return; }
    if (isCurrent) { toast('已退出本设备'); store.update(unauthorized()); }
    else { toast('已撤销'); await render(); }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* 忽略：本地照常登出 */ }
    store.update(unauthorized());
  };

  return { open: async () => { modal.classList.add('is-open'); await render(); } };
}
