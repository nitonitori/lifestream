import { describe, it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryDeviceStore } from '../fakes/index.js';

async function app() {
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'x',
  });
  const devices = new InMemoryDeviceStore();
  let n = 0, t = 0;
  const fastify = await buildHttp({
    plane, token: 'master', sse: new SseHub(), devices,
    mintId: () => 'dev' + (++n), mintToken: () => 'tok' + n, now: () => (t += 1000),
  });
  return { fastify, devices };
}

async function loginCookie(fastify: any, name?: string) {
  const r = await fastify.inject({ method: 'POST', url: '/api/login', payload: { token: 'master', name } });
  return String(r.headers['set-cookie']).split(';')[0];
}

describe('device/token management (point 2)', () => {
  it('login mints a dynamic device token != master, persistent cookie', async () => {
    const { fastify, devices } = await app();
    const r = await fastify.inject({ method: 'POST', url: '/api/login', payload: { token: 'master', name: 'iPhone' } });
    expect(r.statusCode).toBe(204);
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toContain('ls_token=tok1');       // dynamic, not the master token
    expect(setCookie).toMatch(/Max-Age=\d{6,}/i);
    expect((await devices.list())[0]).toMatchObject({ name: 'iPhone', token: 'tok1' });
  });
  it('device cookie authorizes; revoking the device blocks it', async () => {
    const { fastify } = await app();
    const cookie = await loginCookie(fastify);
    expect((await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } })).statusCode).toBe(200);
    const list = (await fastify.inject({ method: 'GET', url: '/api/devices', headers: { cookie } })).json();
    expect(list[0].current).toBe(true);
    const del = await fastify.inject({ method: 'DELETE', url: `/api/devices/${list[0].id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } })).statusCode).toBe(401);
  });
  it('lists multiple devices with names/last-seen', async () => {
    const { fastify } = await app();
    const c1 = await loginCookie(fastify, 'PC');
    await loginCookie(fastify, 'Phone');
    const list = (await fastify.inject({ method: 'GET', url: '/api/devices', headers: { cookie: c1 } })).json();
    expect(list.map((d: any) => d.name).sort()).toEqual(['PC', 'Phone']);
  });
  it('master bearer still works (PC/CLI)', async () => {
    const { fastify } = await app();
    expect((await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer master' } })).statusCode).toBe(200);
  });
  it('logout removes the current device', async () => {
    const { fastify, devices } = await app();
    const cookie = await loginCookie(fastify);
    await fastify.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(await devices.list()).toHaveLength(0);
  });
});
