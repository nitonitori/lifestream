import type { PendingAction, SessionSummary } from '../../../src/domain/types';

export type StreamRef = { kind: 'messenger' } | { kind: 'session'; id: string };
export const MESSENGER: StreamRef = { kind: 'messenger' };

export type Auth = 'unknown' | 'in' | 'out';
export type Conn = 'connecting' | 'live' | 'down';

export interface AppState {
  auth: Auth;
  authNotice: string;              // 登录页提示文本（三种来源，见 authProbed/unauthorized/loginRejected）
  agentEnabled: boolean;
  sessions: Map<string, SessionSummary>;
  current: StreamRef | null;
  conn: Conn;
  pending: PendingAction[];        // 信使待确认动作
}

export const initialState: AppState = {
  auth: 'unknown', authNotice: '', agentEnabled: false,
  sessions: new Map(), current: null, conn: 'connecting', pending: [],
};

// ---------- reducers：纯函数 (s) => s'，返回新 Map / 新对象，不原地改 ----------

export const sessionsReplaced = (list: SessionSummary[]) => (s: AppState): AppState =>
  ({ ...s, sessions: new Map(list.map(x => [x.sessionId, x])) });

export const sessionUpserted = (x: SessionSummary) => (s: AppState): AppState => {
  const sessions = new Map(s.sessions);
  sessions.set(x.sessionId, x);
  return { ...s, sessions };
};

// 只从侧栏移除；不动 current —— SSE 的 session.removed 不关闭已打开的控制台。
export const sessionRemoved = (id: string) => (s: AppState): AppState => {
  if (!s.sessions.has(id)) return s;
  const sessions = new Map(s.sessions);
  sessions.delete(id);
  return { ...s, sessions };
};

export const streamSelected = (ref: StreamRef) => (s: AppState): AppState => ({ ...s, current: ref });
export const streamCleared = () => (s: AppState): AppState => ({ ...s, current: null });
export const connChanged = (conn: Conn) => (s: AppState): AppState => ({ ...s, conn });
export const pendingSet = (pending: PendingAction[]) => (s: AppState): AppState => ({ ...s, pending });
export const agentEnabledSet = (agentEnabled: boolean) => (s: AppState): AppState => ({ ...s, agentEnabled });

export const authProbed = (ok: boolean) => (s: AppState): AppState =>
  ({ ...s, auth: ok ? 'in' : 'out', authNotice: '' });
export const unauthorized = () => (s: AppState): AppState =>
  s.auth === 'out' ? s : { ...s, auth: 'out', authNotice: '会话已失效，请重新登录。' };
export const loginRejected = () => (s: AppState): AppState =>
  ({ ...s, auth: 'out', authNotice: '令牌无效，请重试。' });

// ---------- selectors：纯函数 ----------

// 仅统计 live 会话；status 为 unknown 时既不计忙也不计闲（旧版 claude 不写 status）。
export function fleetCounts(s: AppState): { busy: number; idle: number } {
  let busy = 0;
  let idle = 0;
  for (const x of s.sessions.values()) {
    if (!x.live) continue;
    if (x.status === 'busy') busy++;
    else if (x.status === 'idle') idle++;
  }
  return { busy, idle };
}

export const sessionOf = (s: AppState, id: string): SessionSummary | undefined => s.sessions.get(id);

export const statusLabel = (x: SessionSummary): string =>
  !x.live ? '离线' : x.status === 'busy' ? '运行中' : x.status === 'idle' ? '空闲' : '在线';

export const vitalOf = (x: SessionSummary): string =>
  !x.live ? 'external' : x.status === 'busy' ? 'busy' : x.status === 'idle' ? 'idle' : 'live';

export const tagOf = (x: SessionSummary): string => x.controllable ? '可控' : x.live ? '外部' : '离线';

export const isCurrent = (s: AppState, ref: StreamRef): boolean => {
  const cur = s.current;
  if (!cur || cur.kind !== ref.kind) return false;
  return cur.kind === 'messenger' || (ref.kind === 'session' && cur.id === ref.id);
};
