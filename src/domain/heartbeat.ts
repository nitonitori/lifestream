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

// hook 协议没有周期性心跳：心跳只在事件时刷新，所以 TTL 内一个已关掉的窗口仍会显示为 live，
// 这是精度上限。但不能拿 Stop 来收口 —— Stop 是每轮对话结束都触发的，把它当会话结束会让
// 开着却空闲的窗口从列表里整条消失。
export function heartbeatVitals(
  h: Heartbeat, now: number, ttlMs: number,
): { live: boolean; status: SessionStatus } {
  return {
    live: now - h.ts <= ttlMs,
    status: h.event === 'PreToolUse' ? 'busy' : 'idle',
  };
}
