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
    expect(toLiveSession(raw, () => true)).toMatchObject({ pid: 100, sessionId: 's1', cwd: '/w', status: 'busy' });
  });
  it('returns null when pid not alive (A2.AC3)', () => {
    expect(toLiveSession({ pid: 100, sessionId: 's1', cwd: '/w' }, () => false)).toBeNull();
  });
});

describe('buildSummaries', () => {
  it('managed+tmux => controllable (A3.AC2)', () => {
    const s = buildSummaries({
      live: [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'idle' }],
      managed: [{ sessionId: 's1', tmuxSession: 'lifestream-s1', cwd: '/w', origin: 'managed' }],
      tmuxNames: new Set(['lifestream-s1']),
      activity: new Map([['s1', 123]]),
    })[0];
    expect(s).toMatchObject({ origin: 'managed', controllable: true, live: true, lastActivity: 123, tmuxSession: 'lifestream-s1' });
  });
  it('external live session => not controllable (A3.AC3)', () => {
    const s = buildSummaries({
      live: [{ pid: 2, sessionId: 's2', cwd: '/w2', status: 'busy' }],
      managed: [], tmuxNames: new Set(), activity: new Map(),
    })[0];
    expect(s).toMatchObject({ origin: 'external', controllable: false, live: true });
  });
  it('managed but tmux gone => not controllable', () => {
    const s = buildSummaries({
      live: [], managed: [{ sessionId: 's3', tmuxSession: 't3', cwd: '/w', origin: 'managed' }],
      tmuxNames: new Set(), activity: new Map(),
    })[0];
    expect(s).toMatchObject({ sessionId: 's3', live: false, controllable: false });
  });
});
