import type { InteractivePrompt } from '../../../src/domain/interactive-prompt';
import type { PendingAction, SessionSummary, TranscriptEvent } from '../../../src/domain/types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// 视图侧统一写法：catch (e) { toast(errText(e, '发送失败')) }
// 服务端返回 { error: { code, message } } 时用 message；网络中断/非 JSON 时用 fallback。
export const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError && e.message ? e.message : fallback;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  current: boolean;
}

// 与 src/im/conductor.ts 的 ConductorResult 同构。不 import 那个模块：它经 domain/control-plane
// 用到 node 全局，而 tsconfig.web.json 的 "types": [] 没有 @types/node，一 import 整个 web 程序就编译不过。
export type AgentResult =
  | { kind: 'reply'; text: string }
  | { kind: 'staged'; reply: string; actions: PendingAction[] }
  | { kind: 'executed'; results: string[] }
  | { kind: 'cancelled' }
  | { kind: 'expired' };

export interface Api {
  login(token: string): Promise<void>;
  logout(): Promise<void>;
  agentEnabled(): Promise<{ enabled: boolean }>;
  agentMessages(): Promise<TranscriptEvent[]>;
  agentPending(): Promise<PendingAction[]>;
  agentMessage(text: string): Promise<AgentResult>;
  listSessions(): Promise<SessionSummary[]>;
  sessionMessages(id: string): Promise<TranscriptEvent[]>;
  sendSessionMessage(id: string, text: string): Promise<void>;
  sessionPrompt(id: string): Promise<InteractivePrompt | null>;
  sendKeys(id: string, keys: string[]): Promise<void>;
  createSession(cwd: string): Promise<SessionSummary>;
  adoptSession(id: string, force: boolean): Promise<SessionSummary>;
  archiveSession(id: string): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<void>;
}

interface Opts extends RequestInit {
  /** 该请求的 401 不上报（启动探测与 /api/login：此时“未登录”是正常态，不是掉线）。 */
  silent401?: boolean;
}

const enc = encodeURIComponent;

export function createApi(onUnauthorized: () => void): Api {
  async function call<T>(path: string, opts: Opts = {}): Promise<T> {
    const { silent401, ...init } = opts;
    // 无 body 时不能带 content-type: application/json —— Fastify 解析 body 阶段就以 400 拒掉，早于鉴权。
    const headers = init.body == null ? undefined : { 'content-type': 'application/json' };
    const r = await fetch(path, {
      credentials: 'same-origin',
      headers,
      ...init,
    });
    if (r.status === 401 && !silent401) onUnauthorized();
    if (!r.ok) {
      const j = await r.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(r.status, j?.error?.code ?? 'UNKNOWN', j?.error?.message ?? '');
    }
    if (r.status === 204) return undefined as T;
    return await r.json() as T;
  }

  const post = <T>(path: string, body: unknown, opts: Opts = {}): Promise<T> =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body), ...opts });

  return {
    login: token => post<void>('/api/login', { token }, { silent401: true }),
    logout: () => call<void>('/api/logout', { method: 'POST' }),
    agentEnabled: () => call<{ enabled: boolean }>('/api/agent/enabled', { silent401: true }),
    agentMessages: () => call<TranscriptEvent[]>('/api/agent/messages'),
    agentPending: () => call<PendingAction[]>('/api/agent/pending'),
    agentMessage: text => post<AgentResult>('/api/agent/message', { text }),
    listSessions: () => call<SessionSummary[]>('/api/sessions'),
    sessionMessages: id => call<TranscriptEvent[]>(`/api/sessions/${enc(id)}/messages`),
    sendSessionMessage: (id, text) => post<void>(`/api/sessions/${enc(id)}/messages`, { text }),
    sessionPrompt: id => call<InteractivePrompt | null>(`/api/sessions/${enc(id)}/prompt`),
    sendKeys: (id, keys) => post<void>(`/api/sessions/${enc(id)}/keys`, { keys }),
    createSession: cwd => post<SessionSummary>('/api/sessions', { cwd }),
    adoptSession: (id, force) => post<SessionSummary>(`/api/sessions/${enc(id)}/adopt`, { force }),
    archiveSession: id => call<void>(`/api/sessions/${enc(id)}`, { method: 'DELETE' }),
    devices: () => call<DeviceInfo[]>('/api/devices'),
    revokeDevice: id => call<void>(`/api/devices/${enc(id)}`, { method: 'DELETE' }),
  };
}
