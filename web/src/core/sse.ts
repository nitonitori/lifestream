import type { PlaneEvent, SessionSummary, TranscriptEvent } from '../../../src/domain/types';

// status 通道只承载全量快照与会话增删；message 通道承载转录事件。
export type StatusPayload =
  | SessionSummary[]
  | Extract<PlaneEvent, { type: 'session.updated' | 'session.removed' }>;

export interface StreamHandlers {
  onStatus(p: StatusPayload): void;
  onMessage(sessionId: string, event: TranscriptEvent): void;
  onConn(c: 'live' | 'down'): void;
}

export function connectStream(h: StreamHandlers): () => void {
  const es = new EventSource('/api/stream');
  es.onopen = () => h.onConn('live');
  es.onerror = () => h.onConn('down');   // EventSource 自动重连，重连成功再触发 onopen
  // 自定义事件名落到 addEventListener 的 (type: string) 重载，拿到的是 Event，需要窄化。
  es.addEventListener('status', ev => h.onStatus(JSON.parse((ev as MessageEvent).data) as StatusPayload));
  es.addEventListener('message', ev => {
    const m = JSON.parse(ev.data) as Extract<PlaneEvent, { type: 'message' }>;
    h.onMessage(m.sessionId, m.event);
  });
  return () => es.close();
}
