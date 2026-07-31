import { describe, it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryDeviceStore } from '../fakes/index.js';

async function app() {
  const tmux = new FakeTmux();
  const plane = new ControlPlane({
    tmux, home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(), claudeBin: 'claude', tmuxSocket: 's', newSessionId: () => 'id-1234abcd',
  });
  const fastify = await buildHttp({ plane, token: 'secret', sse: new SseHub(), devices: new InMemoryDeviceStore() });
  return { fastify, plane, tmux };
}

describe('routes auth (C1,C2)', () => {
  it('401 without token', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    expect(r.statusCode).toBe(401);
  });
  it('login sets cookie then sessions works', async () => {
    const { fastify } = await app();
    const login = await fastify.inject({ method: 'POST', url: '/api/login', payload: { token: 'secret' } });
    expect(login.statusCode).toBe(204);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/Max-Age=\d{6,}/i); // persistent across browser restarts
    const cookie = setCookie.split(';')[0];
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });
  it('healthz is public (no auth)', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it('bearer token works', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer secret' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('mutations (C2)', () => {
  it('create returns 201 and message send 202', async () => {
    const { fastify } = await app();
    const h = { authorization: 'Bearer secret' };
    const c = await fastify.inject({ method: 'POST', url: '/api/sessions', headers: h, payload: { cwd: '/w' } });
    expect(c.statusCode).toBe(201);
    const id = c.json().sessionId;
    const m = await fastify.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: h, payload: { text: 'hi' } });
    expect(m.statusCode).toBe(202);
  });
  it('maps domain errors (404)', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'POST', url: '/api/sessions/nope/messages', headers: { authorization: 'Bearer secret' }, payload: { text: 'x' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
  it('prompt answer returns 202 and reaches the plane literally', async () => {
    const { fastify, tmux } = await app();
    const h = { authorization: 'Bearer secret' };
    const c = await fastify.inject({ method: 'POST', url: '/api/sessions', headers: h, payload: { cwd: '/w' } });
    const id = c.json().sessionId;
    const r = await fastify.inject({ method: 'POST', url: `/api/sessions/${id}/prompt`, headers: h, payload: { key: '2' } });
    expect(r.statusCode).toBe(202);
    expect(tmux.literal.at(-1)!.text).toBe('2');   // 字段错配会在这里暴露
  });
  it('prompt answer maps domain errors (404)', async () => {
    const { fastify } = await app();
    const r = await fastify.inject({ method: 'POST', url: '/api/sessions/nope/prompt', headers: { authorization: 'Bearer secret' }, payload: { key: '1' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});
