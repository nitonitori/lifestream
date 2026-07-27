import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ControlPlane } from '../domain/control-plane.js';
import type { SseHub } from './sse.js';
import type { AgentConductor } from '../im/conductor.js';
import type { PendingActionStore, DeviceStore } from '../ports/index.js';
import type { TranscriptEvent } from '../domain/types.js';
import { registerRoutes } from './routes.js';

export interface AgentPanelDeps {
  conductor: AgentConductor;
  pending: PendingActionStore;
  conversationKey: string;
  messages: () => Promise<TranscriptEvent[]>;
}

export interface HttpDeps {
  plane: ControlPlane;
  token: string;
  sse: SseHub;
  devices: DeviceStore;
  webRoot?: string;
  agent?: AgentPanelDeps;
  mintId?: () => string;
  mintToken?: () => string;
  now?: () => number;
}

export async function buildHttp(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  if (deps.webRoot) {
    const fstatic = (await import('@fastify/static')).default;
    await app.register(fstatic, { root: deps.webRoot, prefix: '/' });
  }
  registerRoutes(app, {
    plane: deps.plane, token: deps.token, sse: deps.sse, devices: deps.devices, agent: deps.agent,
    mintId: deps.mintId ?? (() => randomUUID()),
    mintToken: deps.mintToken ?? (() => randomBytes(24).toString('hex')),
    now: deps.now ?? (() => Date.now()),
  });
  await app.ready();
  return app;
}
