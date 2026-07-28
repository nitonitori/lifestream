import { describe, it, expect } from 'vitest';
import { makeTools } from '../../src/mcp/control-mcp.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryPendingStore } from '../fakes/index.js';

function setup(mode: 'direct' | 'im') {
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(1), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'idaaaaaaaa',
  });
  const pending = new InMemoryPendingStore();
  const tools = makeTools({ plane, mode, pending, conversationId: 'conv1', clock: new FakeClock(1), newId: () => 'act1' });
  return { plane, pending, tools };
}

describe('MCP tools', () => {
  it('list_sessions returns array (D1.AC1)', async () => {
    const { tools } = setup('direct');
    expect(await tools.list_sessions({})).toEqual([]);
  });
  it('direct create_session executes (D1.AC2)', async () => {
    const { tools, plane } = setup('direct');
    const s = await tools.create_session({ cwd: '/w' });
    expect(s.controllable).toBe(true);
    expect((await plane.listSessions()).length).toBe(1);
  });
  it('im propose_send only stages, no execution (D1.AC3)', async () => {
    const { tools, pending } = setup('im');
    const r = await tools.propose_send_to_session({ sessionId: 's1', text: 'hi' });
    expect(r.staged).toBe(true);
    const staged = await pending.get('conv1');
    expect(staged[0]).toMatchObject({ kind: 'send', params: { sessionId: 's1', text: 'hi' } });
  });
  it('im has no direct send tool', () => {
    const { tools } = setup('im');
    expect((tools as any).send_to_session).toBeUndefined();
  });
  it('get_session_prompt is read-only and present in both modes', async () => {
    for (const mode of ['direct', 'im'] as const) {
      const { tools, plane } = setup(mode);
      expect(typeof (tools as any).get_session_prompt).toBe('function');
      const s = await plane.createSession({ cwd: '/w' });
      (plane as any).d.tmux.paneText = 'nothing here';
      expect(await tools.get_session_prompt({ sessionId: s.sessionId })).toBeNull();
    }
  });
  it('direct send_keys reaches the plane', async () => {
    const { tools, plane } = setup('direct');
    const s = await plane.createSession({ cwd: '/w' });
    await tools.send_keys({ sessionId: s.sessionId, keys: ['2'] });
    expect((plane as any).d.tmux.keys.at(-1)).toEqual({ name: 'lifestream-' + s.sessionId.slice(0, 8), keys: ['2'] });
  });
  it('im propose_send_keys stages a keys action', async () => {
    const { tools, pending } = setup('im');
    const r = await tools.propose_send_keys({ sessionId: 's1', keys: ['1'] });
    expect(r.staged).toBe(true);
    const staged = await pending.get('conv1');
    expect(staged[0]).toMatchObject({ kind: 'keys', params: { sessionId: 's1', keys: ['1'] } });
  });
  it('im has no direct send_keys tool', () => {
    const { tools } = setup('im');
    expect((tools as any).send_keys).toBeUndefined();
  });
});
