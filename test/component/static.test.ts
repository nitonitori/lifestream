import { it, expect } from 'vitest';
import { buildHttp } from '../../src/server/http.js';
import { SseHub } from '../../src/server/sse.js';
import { ControlPlane } from '../../src/domain/control-plane.js';
import { FakeClock, FakeTmux, FakeClaudeHome, InMemoryManagedRegistry, InMemoryDeviceStore } from '../fakes/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

it('serves index.html at / (C4)', async () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/public');
  const plane = new ControlPlane({
    tmux: new FakeTmux(), home: new FakeClaudeHome(), registry: new InMemoryManagedRegistry(),
    clock: new FakeClock(), claudeBin: 'c', tmuxSocket: 's', newSessionId: () => 'x',
  });
  const app = await buildHttp({ plane, token: 't', sse: new SseHub(), devices: new InMemoryDeviceStore(), webRoot });
  const r = await app.inject({ method: 'GET', url: '/' });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Lifestream');
});
