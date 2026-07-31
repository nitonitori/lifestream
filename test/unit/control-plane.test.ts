import { describe, it, expect } from 'vitest';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeSource, FakeReadonlySource, InMemoryManagedRegistry } from '../fakes/index.js';
import { NotFoundError, NotControllableError, ConflictError } from '../../src/domain/errors.js';
import { userLine } from '../fixtures/transcript-lines.js';

// 不传 sources 时行为与单 source（home）时代完全一致；多 source 用例显式传一组替身。
function make(sources?: (FakeSource | FakeReadonlySource)[]) {
  const tmux = new FakeTmux();
  const home = new FakeSource();
  const all = sources ?? [home];
  const registry = new InMemoryManagedRegistry();
  const clock = new FakeClock(5000);
  const killed: number[] = [];
  // 模拟“杀掉原进程 → 该 live 会话随之消失”，让 waitForSessionGone 立即返回
  const killProcess = (pid: number) => {
    killed.push(pid);
    for (const s of all) s.live = s.live.filter(l => l.pid !== pid);
  };
  let n = 0;
  const plane = new ControlPlane({
    tmux, sources: all, registry, clock,
    newSessionId: () => `00000000-0000-0000-0000-00000000000${++n}`,
    killProcess,
  });
  return { plane, tmux, home, registry, clock, killed };
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
    expect(created.command).toEqual(['claude', '--session-id', s.sessionId, '--permission-mode', 'bypassPermissions']);
    expect(created.cwd).toBe('/w');
  });
  it('passes model and initialPrompt (sends after start)', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w', model: 'sonnet', initialPrompt: 'go' });
    const name = 'lifestream-' + s.sessionId.slice(0, 8);
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--session-id', s.sessionId, '--model', 'sonnet', '--permission-mode', 'bypassPermissions']);
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
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.sendMessage('ext', 'x')).rejects.toBeInstanceOf(NotControllableError);
  });
  it('throws NotFoundError for unknown id', async () => {
    const { plane } = make();
    await expect(plane.sendMessage('nope', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('detectPrompt / capturePane', () => {
  const PERMISSION_PANE = [
    '│ Bash command                                          │',
    '│ Do you want to proceed?                               │',
    '│ ❯ 1. Yes                                              │',
    '│   2. No, and tell Claude what to do (esc)             │',
  ].join('\n');

  it('detectPrompt parses a permission box from the pane', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w' });
    tmux.paneText = PERMISSION_PANE;
    const p = await plane.detectPrompt(s.sessionId);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('permission');
    expect(p!.options).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No, and tell Claude what to do (esc)' }]);
  });

  it('detectPrompt returns null when pane has no selector', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w' });
    tmux.paneText = 'just some normal output\nnothing to pick here';
    expect(await plane.detectPrompt(s.sessionId)).toBeNull();
  });

  it('capturePane 对外部会话抛 NotControllable、对不存在会话抛 NotFound', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.capturePane('ext')).rejects.toBeInstanceOf(NotControllableError);
    await expect(plane.detectPrompt('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answerPrompt 只送字面字符，不追加 Enter', async () => {
    const { plane, tmux } = make();
    const s = await plane.createSession({ cwd: '/w' });
    const name = 'lifestream-' + s.sessionId.slice(0, 8);
    await plane.answerPrompt(s.sessionId, '2');
    expect(tmux.literal).toEqual([{ name, text: '2' }]);
    expect(tmux.sent).toEqual([]);   // 不碰 sendText 通道（那条会补一个 Enter）
  });

  it('answerPrompt 对外部会话抛 NotControllable、对不存在会话抛 NotFound', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.answerPrompt('ext', '1')).rejects.toBeInstanceOf(NotControllableError);
    await expect(plane.answerPrompt('nope', '1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('adoptSession (B4)', () => {  it('resumes external (not live) into tmux', async () => {
    const { plane, tmux, home, registry } = make();
    home.paths.set('ext', '/p/ext.jsonl');
    home.transcripts.set('ext', [JSON.stringify({ type: 'meta', cwd: '/wext', sessionId: 'ext' })]);
    const s = await plane.adoptSession('ext');
    expect(s.origin).toBe('adopted');
    const name = 'lifestream-ext';
    expect(tmux.sessions.get(name)!.command).toEqual(['claude', '--resume', 'ext', '--permission-mode', 'bypassPermissions']);
    expect(tmux.sessions.get(name)!.cwd).toBe('/wext');
    expect((await registry.get('ext'))?.origin).toBe('adopted');
  });
  it('rejects when session still live without force', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 9, kernel: 'claude', sessionId: 'ext', cwd: '/w', status: 'busy' }];
    await expect(plane.adoptSession('ext')).rejects.toBeInstanceOf(ConflictError);
  });
  it('force adopt kills the original process, then resumes in a managed window', async () => {
    const { plane, tmux, home, killed } = make();
    home.live = [{ pid: 9, kernel: 'claude', sessionId: 'ext', cwd: '/wlive', status: 'busy' }];
    const s = await plane.adoptSession('ext', { force: true });
    expect(s.origin).toBe('adopted');
    expect(killed).toContain(9);
    const created = tmux.sessions.get('lifestream-ext')!;
    expect(created.command).toEqual(['claude', '--resume', 'ext', '--permission-mode', 'bypassPermissions']);
    expect(created.cwd).toBe('/wlive');   // cwd 取自被杀前的 live 记录
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
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 'ext', cwd: '/w', status: 'busy' }];
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
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 's1', cwd: '/w', status: 'busy' }];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events.some(e => e.type === 'session.updated' && e.session.sessionId === 's1')).toBe(true);
  });
  it('emits session.removed when a previously seen session disappears', async () => {
    const { plane, home } = make();
    home.live = [{ pid: 1, kernel: 'claude', sessionId: 's1', cwd: '/w', status: 'busy' }];
    await plane.pollOnce();
    home.live = [];
    const events: any[] = [];
    plane.on('event', e => events.push(e));
    await plane.pollOnce();
    expect(events).toContainEqual({ type: 'session.removed', sessionId: 's1' });
  });
});

describe('多 source（Task 3）', () => {
  it('listSessions 合并多个 source 的会话并带上各自 kernel', async () => {
    const cc = new FakeSource('claude');
    const q = new FakeSource('qodercli', 'qodercli', 'bypass_permissions');
    cc.live = [{ sessionId: 'a', kernel: 'claude', cwd: '/tmp/a', status: 'idle', pid: 1 }];
    q.live = [{ sessionId: 'b', kernel: 'qodercli', cwd: '/tmp/b', status: 'busy', pid: 2 }];
    const { plane } = make([cc, q]);
    const list = await plane.listSessions();
    expect(list.map(x => `${x.sessionId}:${x.kernel}`).sort()).toEqual(['a:claude', 'b:qodercli']);
  });

  it('createSession 用目标 source 的方言拼命令', async () => {
    const cc = new FakeSource('claude');
    const q = new FakeSource('qodercli', 'qodercli', 'bypass_permissions');
    const { plane, tmux } = make([cc, q]);
    const s = await plane.createSession({ cwd: '/tmp', kernel: 'qodercli' });
    expect(tmux.sessions.get('lifestream-' + s.sessionId.slice(0, 8))!.command)
      .toEqual(['qodercli', '--session-id', s.sessionId, '--permission-mode', 'bypass_permissions']);
  });

  it('createSession 对只读内核抛 NotControllableError', async () => {
    const { plane } = make([new FakeSource('claude'), new FakeReadonlySource('qoderwork')]);
    await expect(plane.createSession({ cwd: '/tmp', kernel: 'qoderwork' }))
      .rejects.toBeInstanceOf(NotControllableError);
  });

  it('adoptSession 对只读内核的活会话同样抛 NotControllableError', async () => {
    const ro = new FakeReadonlySource('qoder-ide');
    ro.live = [{ sessionId: 'ide1', kernel: 'qoder-ide', cwd: '/tmp/x', status: 'idle' }];
    const { plane } = make([new FakeSource('claude'), ro]);
    await expect(plane.adoptSession('ide1')).rejects.toBeInstanceOf(NotControllableError);
  });

  it('summarize 把只读内核的会话标成 adoptable: false', async () => {
    const ro = new FakeReadonlySource('qoderwork');
    ro.live = [{ sessionId: 'w1', kernel: 'qoderwork', cwd: '/tmp/w', status: 'idle' }];
    const { plane } = make([new FakeSource('claude'), ro]);
    const x = (await plane.listSessions()).find(s => s.sessionId === 'w1');
    expect(x?.adoptable).toBe(false);
  });

  it('getMessages 对完全未知的 id 返回空数组', async () => {
    const { plane } = make([new FakeSource('claude')]);
    expect(await plane.getMessages('nope')).toEqual([]);
  });

  it('start 给每个 source 各装一个 watcher，按 sessionIdForPath 归属', async () => {
    const cc = new FakeSource('claude');
    const ro = new FakeReadonlySource('qoderwork');
    const { plane } = make([cc, ro]);
    await plane.start();
    expect(cc.watched.length).toBe(1);
    expect(ro.watched.length).toBe(1);
    await plane.stop();
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
