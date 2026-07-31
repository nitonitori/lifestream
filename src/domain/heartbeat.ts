import type { SessionStatus } from './types.js';

export interface Heartbeat { sessionId: string; cwd: string; event: string; ts: number }

export function parseHeartbeat(text: string): Heartbeat | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (typeof o?.sessionId !== 'string' || typeof o?.ts !== 'number') return null;
  return {
    sessionId: o.sessionId,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
    event: typeof o.event === 'string' ? o.event : 'unknown',
    ts: o.ts,
  };
}

// hook 协议没有周期性心跳：心跳只在事件时刷新，所以 TTL 内一个已关闭的会话仍会显示为 live
// （除非它最后一个事件是 Stop）。这是精度上限。
export function heartbeatVitals(
  h: Heartbeat, now: number, ttlMs: number,
): { live: boolean; status: SessionStatus } {
  const fresh = now - h.ts <= ttlMs;
  return {
    live: fresh && h.event !== 'Stop',
    status: h.event === 'PreToolUse' ? 'busy' : 'idle',
  };
}
