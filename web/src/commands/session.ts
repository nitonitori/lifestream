import type { Api } from '../core/api';
import type { AppState } from '../core/state';
import type { Store } from '../core/store';
import { errText } from '../core/api';
import { isCurrent, sessionOf, sessionRemoved, streamCleared } from '../core/state';
import { confirmDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';

export interface SessionCommands {
  create(): Promise<void>;
  adopt(id: string): Promise<void>;
  archive(id: string): Promise<void>;
}

// 会话命令族：dialog → api → toast → refresh。按钮长在哪块 DOM 上不该决定命令住哪里，
// 所以三条一起放这里，由 main.ts 注入 rail 与 console。
export function createSessionCommands(
  store: Store<AppState>, api: Api, refresh: () => Promise<void>,
): SessionCommands {
  return {
    async create() {
      const cwd = await promptDialog({ title: '新会话工作目录（cwd）' });
      if (!cwd) return;
      try { await api.createSession(cwd); toast('已创建'); await refresh(); }
      catch (e) { toast(errText(e, '创建失败')); }
    },

    async adopt(id) {
      const x = sessionOf(store.getState(), id);
      const label = x?.name || id.slice(0, 8);
      let force = false;
      if (x?.live) {
        const ok = await confirmDialog({
          title: '接管会话',
          body: `会话「${label}」仍在运行。接管会先结束其原进程，再在受控窗口中恢复（保留完整上下文）。是否继续？`,
          okText: '继续接管',
        });
        if (!ok) return;
        force = true;
      }
      try { await api.adoptSession(id, force); toast('已接管'); await refresh(); }
      catch (e) { toast(errText(e, '接管失败')); }
    },

    async archive(id) {
      const x = sessionOf(store.getState(), id);
      const label = x?.name || id.slice(0, 8);
      const ok = await confirmDialog({
        title: '结束会话',
        body: `结束会话「${label}」？这会关闭其 tmux 窗口并结束对应的 Claude 进程。`,
        okText: '结束会话', danger: true,
      });
      if (!ok) return;
      try { await api.archiveSession(id); } catch (e) { toast(errText(e, '结束失败')); return; }
      toast('已结束会话');
      store.update(sessionRemoved(id));
      if (isCurrent(store.getState(), { kind: 'session', id })) store.update(streamCleared());
      await refresh();
    },
  };
}
