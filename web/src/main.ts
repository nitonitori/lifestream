import { createSessionCommands } from './commands/session';
import { createApi } from './core/api';
import {
  MESSENGER, agentEnabledSet, authProbed, connChanged, initialState,
  sessionRemoved, sessionUpserted, sessionsReplaced, streamSelected, unauthorized,
} from './core/state';
import { connectStream } from './core/sse';
import { createStore } from './core/store';
import { mountConsole } from './views/console-view';
import { mountDevices } from './views/devices';
import { mountLogin } from './views/login';
import { mountRail } from './views/rail';
import { mountTopbar } from './views/topbar';

const store = createStore(initialState);
const api = createApi(() => store.update(unauthorized()));

const refresh = async (): Promise<void> => {
  try { store.update(sessionsReplaced(await api.listSessions())); }
  catch { /* 401 已由 api 上报；其它失败等下一次 SSE 快照 */ }
};

const cmds = createSessionCommands(store, api, refresh);

mountLogin(store, api);
const devices = mountDevices(store, api);
mountTopbar(store, () => void devices.open());
mountRail(store, cmds);
const console_ = mountConsole(store, api, cmds);

async function boot(): Promise<void> {
  let enabled = false;
  try { enabled = (await api.agentEnabled()).enabled; }
  catch { store.update(authProbed(false)); return; }   // 未登录/服务不可达：停在登录页
  store.update(agentEnabledSet(enabled));
  store.update(authProbed(true));
  await refresh();
  connectStream({
    onStatus(p) {
      if (Array.isArray(p)) store.update(sessionsReplaced(p));
      else if (p.type === 'session.updated') store.update(sessionUpserted(p.session));
      else store.update(sessionRemoved(p.sessionId));
    },
    onMessage: (sessionId, event) => console_.onMessage(sessionId, event),
    onConn: c => store.update(connChanged(c)),
  });
  if (enabled) store.update(streamSelected(MESSENGER));
}

void boot();
