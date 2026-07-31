import { describe, it, expect } from 'vitest';
import { deriveStatus, toLiveSession, buildSummaries } from '../../src/domain/session-discovery.js';

describe('deriveStatus', () => {
  it('maps busy/idle and defaults unknown (A2.AC2)', () => {
    expect(deriveStatus({ status: 'busy' })).toBe('busy');
    expect(deriveStatus({ status: 'idle' })).toBe('idle');
    expect(deriveStatus({})).toBe('unknown');
  });
});

describe('toLiveSession', () => {
  it('reads live session fields (A2.AC1)', () => {
    const raw = { pid: 100, sessionId: 's1', cwd: '/w', name: 'n', status: 'busy' };
    expect(toLiveSession(raw, 'claude', () => true)).toMatchObject({ pid: 100, kernel: 'claude', sessionId: 's1', cwd: '/w', status: 'busy' });
  });
  it('returns null when pid not alive (A2.AC3)', () => {
    expect(toLiveSession({ pid: 100, sessionId: 's1', cwd: '/w' }, 'claude', () => false)).toBeNull();
  });
});

describe('buildSummaries', () => {
  it('managed+tmux => controllable (A3.AC2)', () => {
    const s = buildSummaries({
      live: [{ pid: 1, kernel: 'claude', sessionId: 's1', cwd: '/w', status: 'idle' }],
      managed: [{ sessionId: 's1', tmuxSession: 'lifestream-s1', cwd: '/w', kernel: 'claude', origin: 'managed' }],
      tmuxNames: new Set(['lifestream-s1']),
      activity: new Map([['s1', 123]]),
      adoptable: new Set(['claude']),
    })[0];
    expect(s).toMatchObject({ kernel: 'claude', adoptable: true, origin: 'managed', controllable: true, live: true, lastActivity: 123, tmuxSession: 'lifestream-s1' });
  });
  it('external live session => not controllable (A3.AC3)', () => {
    const s = buildSummaries({
      live: [{ pid: 2, kernel: 'claude', sessionId: 's2', cwd: '/w2', status: 'busy' }],
      managed: [], tmuxNames: new Set(), activity: new Map(),
      adoptable: new Set(['claude']),
    })[0];
    expect(s).toMatchObject({ origin: 'external', controllable: false, live: true, adoptable: true });
  });
  it('不可控内核的会话 adoptable 为 false', () => {
    const s = buildSummaries({
      live: [{ kernel: 'qoderwork', sessionId: 's4', cwd: '/w4', status: 'idle' }],
      managed: [], tmuxNames: new Set(), activity: new Map(),
      adoptable: new Set(['claude']),
    })[0];
    expect(s).toMatchObject({ kernel: 'qoderwork', adoptable: false, controllable: false });
  });
  it('managed but tmux gone => not controllable', () => {
    const s = buildSummaries({
      live: [], managed: [{ sessionId: 's3', tmuxSession: 't3', cwd: '/w', kernel: 'claude', origin: 'managed' }],
      tmuxNames: new Set(), activity: new Map(),
      adoptable: new Set(['claude']),
    })[0];
    expect(s).toMatchObject({ sessionId: 's3', kernel: 'claude', live: false, controllable: false });
  });
  it('live 的空串 cwd 不该盖掉注册表里的正确值', () => {
    const s = buildSummaries({
      live: [{ pid: 5, kernel: 'qodercli', sessionId: 's5', cwd: '', status: 'unknown' }],
      managed: [{ sessionId: 's5', tmuxSession: 't5', cwd: '/real', kernel: 'qodercli', origin: 'managed' }],
      tmuxNames: new Set(['t5']), activity: new Map(),
      adoptable: new Set(['qodercli']),
    })[0];
    expect(s!.cwd).toBe('/real');
  });
  it('new managed session (createdAt, no activity) sorts above older active ones', () => {
    const out = buildSummaries({
      live: [
        { pid: 1, kernel: 'claude', sessionId: 'new', cwd: '/w', status: 'idle' },
        { pid: 2, kernel: 'claude', sessionId: 'old', cwd: '/w', status: 'idle' },
      ],
      managed: [{ sessionId: 'new', tmuxSession: 'lifestream-new', cwd: '/w', kernel: 'claude', origin: 'managed', createdAt: 1000 }],
      tmuxNames: new Set(['lifestream-new']),
      activity: new Map([['old', 500]]),   // 老会话最近活动 500 < 新会话 createdAt 1000
      adoptable: new Set(['claude']),
    });
    expect(out.map(s => s.sessionId)).toEqual(['new', 'old']);
  });
});
