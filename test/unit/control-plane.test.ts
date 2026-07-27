import { describe, it, expect } from 'vitest';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { NotFoundError, NotControllableError, ConflictError } from '../../src/domain/errors.js';
import { userLine } from '../fixtures/transcript-lines.js';

function make() {
  const tmux = new FakeTmux();
  const home = new FakeClaudeHome();
  const registry = new InMemoryManagedRegistry();
  const clock = new FakeClock(5000);
  let n = 0;
  const plane = new ControlPlane({
    tmux, home, registry, clock, claudeBin: 'claude', tmuxSocket: 'lifestream',
    newSessionId: () => `00000000-0000-0000-0000-00000000000${++n}`,
  });
  return { plane, tmux, home, registry, clock };
}

describe('createSession (B2)', () => {
  it('starts tmux with --session-id and registers, controllable', async () => {
    const { plane, tmux, registry } = make();
    const s = await plane.createSession({ cwd: '/w' });
    expect(s.origin).toBe('managed');
    expect(s.controllable).toBe(true);
    const entry = await registry.get(s.sessionId);
    expect(entry?.tmuxSession).toBe('lifestream-' + s.sessionId.slice(0, 8));
    const created = tmux.sessions.get(entry!.tmuxSession)!;
    expect(created.command).toEqual(['claude', '--session-id', s.sessionId]);
    expect(created.cwd).toBe('/w');
  });
  it('passes model and initialPrompt (sends after start)', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w', model: 'sonnet', initialPrompt: 'go' });
    const name = 'lifestream-' + s.sessionId.slice(0, 8);
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--session-id', s.sessionId, '--model', 'sonnet']);
    expect(tmux.sent).toEqual([{ name, text: 'go' }]);
  });
});

describe('sendMessage (B3)', () => {
  it('sends to managed session tmux', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w' });
    await plane.sendMessage(s.sessionId, 'hello');
    expect(tmux.sent.at(-1)).toEqual({ name: 'lifestream-' + s.sessionId.slice(0, 8), text: 'hello' });
  });
  it('throws NotControllableError for external live session', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.sendMessage('ext', 'x')).rejects.toBeInstanceOf(NotControllableError);
  });
  it('throws NotFoundError for unknown id', async () => {
    const { plane } = make();
    await expect(plane.sendMessage('nope', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('adoptSession (B4)', () => {
  it('resumes external (not live) into tmux', async () => {
    const { plane, tmux, home, registry } = make();
    home.paths.set('ext', '/p/ext.jsonl');
    home.transcripts.set('ext', [JSON.stringify({ type: 'meta', cwd: '/wext', sessionId: 'ext' })]);
    const s = await plane.adoptSession('ext');
    expect(s.origin).toBe('adopted');
    const name = 'lifestream-ext';
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--resume', 'ext']);
    expect(tmux.sessions.get(name)!.cwd).toBe('/wext');
    expect((await registry.get('ext'))?.origin).toBe('adopted');
  });
  it('rejects when session still live without force', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 9, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.adoptSession('ext')).rejects.toBeInstanceOf(ConflictError);
  });
  it('force adopts live session', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 9, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    const s = await plane.adoptSession('ext', { force: true });
    expect(s.origin).toBe('adopted');
  });
});

describe('archiveSession (B6)', () => {
  it('kills tmux and removes managed session, emits removed', async () => {
    const { plane, tmux, registry } = make();
    const s = await plane.createSession({ cwd: '/w' });
    const name = 'lifestream-' + s.sessionId.slice(0, 8);
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.archiveSession(s.sessionId);
    expect(tmux.sessions.has(name)).toBe(false);
    expect(await registry.get(s.sessionId)).toBeNull();
    expect(events).toContainEqual({ type: 'session.removed', sessionId: s.sessionId });
  });
  it('removes managed entry even when tmux already gone', async () => {
    const { plane, tmux, registry } = make();
    const s = await plane.createSession({ cwd: '/w' });
    tmux.sessions.delete('lifestream-' + s.sessionId.slice(0, 8));
    await plane.archiveSession(s.sessionId);
    expect(await registry.get(s.sessionId)).toBeNull();
  });
  it('refuses external (non-managed) live session', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.archiveSession('ext')).rejects.toBeInstanceOf(NotControllableError);
  });
  it('throws NotFoundError for unknown id', async () => {
    const { plane } = make();
    await expect(plane.archiveSession('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('getMessages', () => {
  it('parses located transcript', async () => {
    const { plane, home } = make();
    home.paths.set('s1', '/p/s1.jsonl');
    home.transcripts.set('s1', [userLine]);
    const msgs = await plane.getMessages('s1');
    expect(msgs[0]).toMatchObject({ kind: 'user', text: '你好' });
  });
});

describe('pollOnce events (B5)', () => {
  it('emits session.updated for live sessions', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'busy' }];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events.some(e => e.type === 'session.updated' && e.session.sessionId === 's1')).toBe(true);
  });
  it('emits session.removed when a previously seen session disappears', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, sessionId: 's1', cwd: '/w', status: 'busy' }];
    await plane.pollOnce();
    home.live = [];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events).toContainEqual({ type: 'session.removed', sessionId: 's1' });
  });
});

describe('ingestTranscript dedup (B5.AC3)', () => {
  it('emits message once per uuid across calls', async () => {
    const { plane, home } = make();
    home.paths.set('s1', '/p/s1.jsonl');
    home.transcripts.set('s1', [userLine]);
    const events: any[] = [];
    plane.on('event', e => { if (e.type === 'message') events.push(e); });
    await plane.ingestTranscript('s1');
    await plane.ingestTranscript('s1');
    expect(events).toHaveLength(1);
  });
});
