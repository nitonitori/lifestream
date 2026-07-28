import { describe, it, expect } from 'vitest';
import { AgentConductor, formatResult } from '../../src/im/conductor.js';
import { FakeAgent, FakeClock, InMemoryPendingStore, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry } from '../fakes/index.js';
import { ControlPlane } from '../../src/domain/control-plane.js';

function make(responder?: (k: string, t: string) => Promise<string> | string) {
  const agent = new FakeAgent();
  const pending = new InMemoryPendingStore();
  const clock = new FakeClock(1000);
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock, claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'id-xxxxxxxx',
  });
  if (responder) agent.responder = responder;
  const c = new AgentConductor({ agent, plane, pending, clock, confirmWords: ['确认', 'yes'], cancelWords: ['取消'], confirmTtlMs: 5000 });
  return { agent, pending, clock, plane, c };
}

describe('AgentConductor', () => {
  it('plain reply when nothing staged', async () => {
    const { c } = make(() => 'hello');
    expect(await c.handle('k', '在吗')).toEqual({ kind: 'reply', text: 'hello' });
  });
  it('staged action returns staged result (no execution)', async () => {
    const { c, pending, plane } = make(async (k) => {
      const l = await pending.get(k);
      l.push({ id: 'a1', conversationId: k, kind: 'create', params: { cwd: '/w' }, description: '在 /w 新建会话', createdAt: 0 });
      await pending.set(k, l);
      return '我将新建会话';
    });
    const r = await c.handle('k', '新建');
    expect(r.kind).toBe('staged');
    expect((await plane.listSessions()).length).toBe(0);
  });
  it('confirm executes and clears', async () => {
    const { c, pending, plane } = make(() => 'x');
    await pending.set('k', [{ id: 'a1', conversationId: 'k', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    const r = await c.handle('k', '确认');
    expect(r.kind).toBe('executed');
    expect((await plane.listSessions()).length).toBe(1);
    expect(await pending.get('k')).toHaveLength(0);
  });
  it('cancel clears', async () => {
    const { c, pending } = make();
    await pending.set('k', [{ id: 'a1', conversationId: 'k', kind: 'send', params: {}, description: 'd', createdAt: 1000 }]);
    expect((await c.handle('k', '取消')).kind).toBe('cancelled');
    expect(await pending.get('k')).toHaveLength(0);
  });
  it('expired discards without executing', async () => {
    const { c, pending, clock, agent } = make(() => 'x');
    await pending.set('k', [{ id: 'a1', conversationId: 'k', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 0 }]);
    clock.t = 999999;
    expect((await c.handle('k', '确认')).kind).toBe('expired');
    expect(agent.calls).toHaveLength(0);
  });
  it('non-confirm with pending falls through to new agent turn', async () => {
    const { c, pending, agent } = make(() => 'new');
    await pending.set('k', [{ id: 'a1', conversationId: 'k', kind: 'create', params: { cwd: '/w' }, description: 'd', createdAt: 1000 }]);
    const r = await c.handle('k', '换个问题');
    expect(r.kind).toBe('reply');
    expect(agent.calls).toHaveLength(1);
  });
  it('confirming a keys action calls plane.sendKeys on the target session', async () => {
    const { c, pending, plane } = make(() => 'x');
    const s = await plane.createSession({ cwd: '/w' });
    const tmux = (plane as any).d.tmux;
    await pending.set('k', [{ id: 'a1', conversationId: 'k', kind: 'keys', params: { sessionId: s.sessionId, keys: ['2'] }, description: 'd', createdAt: 1000 }]);
    const r = await c.handle('k', '确认');
    expect(r.kind).toBe('executed');
    expect(tmux.keys.at(-1)).toEqual({ name: 'lifestream-' + s.sessionId.slice(0, 8), keys: ['2'] });
  });
});

describe('formatResult', () => {
  it('formats staged with confirm prompt', () => {
    const t = formatResult({ kind: 'staged', reply: 'ok', actions: [{ id: 'a', conversationId: 'k', kind: 'send', params: {}, description: '发送到 X', createdAt: 0 }] });
    expect(t).toContain('待执行');
    expect(t).toContain('发送到 X');
    expect(t).toContain('确认');
  });
  it('formats executed/cancelled/expired', () => {
    expect(formatResult({ kind: 'executed', results: ['a', 'b'] })).toBe('a\nb');
    expect(formatResult({ kind: 'cancelled' })).toContain('取消');
    expect(formatResult({ kind: 'expired' })).toContain('超时');
  });
});
