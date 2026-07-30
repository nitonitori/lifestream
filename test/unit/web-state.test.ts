import { describe, it, expect } from 'vitest';
import type { SessionSummary } from '../../src/domain/types.js';
import {
  initialState, MESSENGER,
  sessionsReplaced, sessionUpserted, sessionRemoved,
  streamSelected, streamCleared, connChanged, pendingSet, agentEnabledSet,
  authProbed, unauthorized, loginRejected,
  fleetCounts, sessionOf, statusLabel, vitalOf, tagOf, isCurrent,
} from '../../web/src/core/state';

const S = (over: Partial<SessionSummary> & { sessionId: string }): SessionSummary =>
  ({ cwd: '/w', status: 'idle', origin: 'managed', live: true, controllable: true, ...over });

describe('reducers', () => {
  it('sessionsReplaced 建新 Map，不改原 state', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' }), S({ sessionId: 'b' })])(initialState);
    expect(initialState.sessions.size).toBe(0);
    expect([...s1.sessions.keys()]).toEqual(['a', 'b']);
  });

  it('sessionsReplaced 丢弃不在新列表里的旧条目', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' }), S({ sessionId: 'b' })])(initialState);
    const s2 = sessionsReplaced([S({ sessionId: 'b' })])(s1);
    expect([...s2.sessions.keys()]).toEqual(['b']);
  });

  it('sessionUpserted 覆盖同 id 且不原地改', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a', status: 'idle' })])(initialState);
    const s2 = sessionUpserted(S({ sessionId: 'a', status: 'busy' }))(s1);
    expect(s1.sessions.get('a')!.status).toBe('idle');
    expect(s2.sessions.get('a')!.status).toBe('busy');
    expect(s2.sessions).not.toBe(s1.sessions);
  });

  it('sessionUpserted 新 id 走插入路径', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' })])(initialState);
    const s2 = sessionUpserted(S({ sessionId: 'b', status: 'busy' }))(s1);
    expect(s1.sessions.size).toBe(1);
    expect(s2.sessions.size).toBe(2);
    expect(s2.sessions.get('b')!.status).toBe('busy');
    expect(s2.sessions.get('a')).toBe(s1.sessions.get('a'));
  });

  it('sessionRemoved 删条目但不清 current（SSE 移除不关闭控制台）', () => {
    const s1 = streamSelected({ kind: 'session', id: 'a' })(sessionsReplaced([S({ sessionId: 'a' })])(initialState));
    const s2 = sessionRemoved('a')(s1);
    expect(s2.sessions.has('a')).toBe(false);
    expect(s2.current).toEqual({ kind: 'session', id: 'a' });
  });

  it('sessionRemoved 对不存在的 id 返回同一引用', () => {
    const s1 = sessionsReplaced([S({ sessionId: 'a' })])(initialState);
    expect(sessionRemoved('zzz')(s1)).toBe(s1);
  });

  it('streamSelected / streamCleared 只动 current', () => {
    const s1 = streamSelected(MESSENGER)(initialState);
    expect(s1.current).toEqual({ kind: 'messenger' });
    expect(streamCleared()(s1).current).toBeNull();
  });

  // 判等即返回原 state 是「点当前已选中的卡片不重载」在 rail/头部也成立的前提：
  // 那两条订阅把 current 嵌在对象字面量里，换个 ref 对象就等于换整块 DOM。
  it('streamSelected 重选同一条流返回同一个 state 引用', () => {
    const one = streamSelected({ kind: 'session', id: 'a' })(initialState);
    expect(streamSelected({ kind: 'session', id: 'a' })(one)).toBe(one);
    expect(streamSelected({ kind: 'session', id: 'b' })(one)).not.toBe(one);
    const m = streamSelected(MESSENGER)(initialState);
    expect(streamSelected({ kind: 'messenger' })(m)).toBe(m);
  });

  it('connChanged / pendingSet / agentEnabledSet', () => {
    expect(connChanged('down')(initialState).conn).toBe('down');
    expect(agentEnabledSet(true)(initialState).agentEnabled).toBe(true);
    const p = [{ id: 'p1', conversationId: 'messenger', kind: 'send' as const, params: {}, description: 'd', createdAt: 0 }];
    expect(pendingSet(p)(initialState).pending).toEqual(p);
  });

  it('三种登录态提示各不相同（首访为空）', () => {
    const out = authProbed(false)(initialState);
    expect(out.auth).toBe('out');
    expect(out.authNotice).toBe('');                       // 首次探测 401：不显示提示
    const signedIn = authProbed(true)(initialState);
    expect(signedIn.auth).toBe('in');
    expect(unauthorized()(signedIn).authNotice).toBe('会话已失效，请重新登录。');
    expect(loginRejected()(signedIn).authNotice).toBe('令牌无效，请重试。');
    expect(unauthorized()(out)).toBe(out);                 // 已 out 不再覆盖（等价旧 unauthShown 守卫）
  });
});

describe('selectors', () => {
  const s = sessionsReplaced([
    S({ sessionId: 'a', status: 'busy' }),
    S({ sessionId: 'b', status: 'idle' }),
    S({ sessionId: 'c', status: 'unknown' }),
    S({ sessionId: 'd', status: 'busy', live: false }),
  ])(initialState);

  it('fleetCounts 只统计 live，unknown 既不计忙也不计闲', () => {
    expect(fleetCounts(s)).toEqual({ busy: 1, idle: 1 });
  });

  it('sessionOf', () => {
    expect(sessionOf(s, 'a')!.status).toBe('busy');
    expect(sessionOf(s, 'nope')).toBeUndefined();
  });

  // 下面三个的期望值是从新实现转写的，只防「今后被改坏」；与旧 web/app.js 逐字一致由另一套字面量核对兜住。
  it('statusLabel', () => {
    expect(statusLabel(S({ sessionId: 'x', live: false }))).toBe('离线');
    expect(statusLabel(S({ sessionId: 'x', status: 'busy' }))).toBe('运行中');
    expect(statusLabel(S({ sessionId: 'x', status: 'idle' }))).toBe('空闲');
    expect(statusLabel(S({ sessionId: 'x', status: 'unknown' }))).toBe('在线');
  });

  it('vitalOf', () => {
    expect(vitalOf(S({ sessionId: 'x', live: false }))).toBe('external');
    expect(vitalOf(S({ sessionId: 'x', status: 'busy' }))).toBe('busy');
    expect(vitalOf(S({ sessionId: 'x', status: 'idle' }))).toBe('idle');
    expect(vitalOf(S({ sessionId: 'x', status: 'unknown' }))).toBe('live');
  });

  it('tagOf', () => {
    expect(tagOf(S({ sessionId: 'x', controllable: true }))).toBe('可控');
    expect(tagOf(S({ sessionId: 'x', controllable: false }))).toBe('外部');
    expect(tagOf(S({ sessionId: 'x', controllable: false, live: false }))).toBe('离线');
  });

  it('isCurrent 区分 messenger 与具体会话', () => {
    const m = streamSelected(MESSENGER)(initialState);
    expect(isCurrent(m, MESSENGER)).toBe(true);
    expect(isCurrent(m, { kind: 'session', id: 'a' })).toBe(false);
    const one = streamSelected({ kind: 'session', id: 'a' })(initialState);
    expect(isCurrent(one, { kind: 'session', id: 'a' })).toBe(true);
    expect(isCurrent(one, { kind: 'session', id: 'b' })).toBe(false);
    expect(isCurrent(initialState, MESSENGER)).toBe(false);
  });
});
