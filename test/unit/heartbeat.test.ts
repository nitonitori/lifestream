import { describe, expect, test } from 'vitest';
import { heartbeatVitals, parseHeartbeat } from '../../src/domain/heartbeat.js';

const TTL = 30 * 60 * 1000;
const NOW = 1785400000000;
const hb = (event: string, ts = NOW) => ({ sessionId: 's', cwd: '/tmp', event, ts });

describe('parseHeartbeat', () => {
  test('完整载荷', () => {
    expect(parseHeartbeat(JSON.stringify(hb('PreToolUse'))))
      .toEqual({ sessionId: 's', cwd: '/tmp', event: 'PreToolUse', ts: NOW });
  });
  test('缺 ts 返回 null', () => {
    expect(parseHeartbeat(JSON.stringify({ sessionId: 's', event: 'Stop' }))).toBeNull();
  });
  test('缺 sessionId 返回 null', () => {
    expect(parseHeartbeat(JSON.stringify({ ts: NOW, event: 'Stop' }))).toBeNull();
  });
  test('非 JSON 返回 null', () => {
    expect(parseHeartbeat('boom')).toBeNull();
  });
  test('缺 cwd 落成空串、缺 event 落成 unknown', () => {
    expect(parseHeartbeat(JSON.stringify({ sessionId: 's', ts: NOW })))
      .toEqual({ sessionId: 's', cwd: '', event: 'unknown', ts: NOW });
  });
});

describe('heartbeatVitals', () => {
  test('TTL 内就算 live', () => {
    expect(heartbeatVitals(hb('PostToolUse', NOW - 1000), NOW, TTL).live).toBe(true);
  });
  test('超出 TTL 不算 live', () => {
    expect(heartbeatVitals(hb('PreToolUse', NOW - TTL - 1), NOW, TTL).live).toBe(false);
  });
  test('Stop 只是一轮对话结束、不是会话结束：仍算 live，状态 idle', () => {
    expect(heartbeatVitals(hb('Stop'), NOW, TTL)).toEqual({ live: true, status: 'idle' });
  });
  test('PreToolUse 判 busy', () => {
    expect(heartbeatVitals(hb('PreToolUse'), NOW, TTL).status).toBe('busy');
  });
  test('PostToolUse / PostToolUseFailure / SessionStart 判 idle', () => {
    for (const e of ['PostToolUse', 'PostToolUseFailure', 'SessionStart']) {
      expect(heartbeatVitals(hb(e), NOW, TTL).status).toBe('idle');
    }
  });
});
