import { describe, it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { AgentConductor, MESSENGER_CONVERSATION } from '../../src/im/conductor.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryPendingStore, FakeAgent, InMemoryDeviceStore } from '../fakes/index.js';

async function app(responder?: (k: string, t: string) => string) {
  const clock = new FakeClock(1000);
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock, claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'id-1234abcd',
  });
  const agent = new FakeAgent();
  if (responder) agent.responder = responder;
  const pending = new InMemoryPendingStore();
  const conductor = new AgentConductor({ agent, plane, pending, clock, confirmWords: ['确认'], cancelWords: ['取消'], confirmTtlMs: 5000 });
  const fastify = await buildHttp({
    plane, token: 'secret', sse: new SseHub(), devices: new InMemoryDeviceStore(),
    agent: { conductor, pending, conversationKey: MESSENGER_CONVERSATION, messages: async () => [] },
  });
  return { fastify, pending };
}
const H = { authorization: 'Bearer secret' };

describe('web agent panel (point 3)', () => {
  it('reports enabled', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'GET', url: '/api/agent/enabled', headers: H });
    expect(r.json()).toEqual({ enabled: true });
  });
  it('POST message returns conductor reply (shared context)', async () => {
    const { fastify } = await app(() => '会话列表如下');
    const r = await fastify.inject({ method: 'POST', url: '/api/agent/message', headers: H, payload: { text: '列出会话' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kind: 'reply', text: '会话列表如下' });
  });
  it('requires auth', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'POST', url: '/api/agent/message', payload: { text: 'x' } });
    expect(r.statusCode).toBe(401);
  });
  it('exposes pending actions', async () => {
    const { fastify, pending } = await app();
    await pending.set(MESSENGER_CONVERSATION, [{ id: 'a', conversationId: MESSENGER_CONVERSATION, kind: 'send', params: {}, description: 'd', createdAt: 0 }]);
    const r = await fastify.inject({ method: 'GET', url: '/api/agent/pending', headers: H });
    expect(r.json()).toHaveLength(1);
  });
});
