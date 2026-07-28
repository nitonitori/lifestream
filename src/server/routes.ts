import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ControlPlane } from '../domain/control-plane.js';
import type { SseHub } from './sse.js';
import type { AgentPanelDeps } from './http.js';
import type { DeviceStore, Device } from '../ports/index.js';
import { checkToken, extractToken } from './auth.js';
import { deriveDeviceName } from './devices.js';
import { DomainError } from '../domain/errors.js';

export interface RouteDeps {
  plane: ControlPlane;
  token: string;                 // 主令牌（持久化，PC 获取）
  sse: SseHub;
  devices: DeviceStore;
  mintId: () => string;
  mintToken: () => string;
  now: () => number;
  agent?: AgentPanelDeps;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { plane, token, sse, devices, mintId, mintToken, now } = deps;

  // 公开健康检查（守护/launchd 探活，无需鉴权）
  app.get('/healthz', async () => ({ ok: true }));

  // 用主令牌登录 → 铸造该设备的动态令牌（cookie），并登记到设备列表。
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; name?: string };
    if (!checkToken(body.token, token)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'bad token' } });
    const ua = req.headers['user-agent'];
    const device: Device = {
      id: mintId(), token: mintToken(),
      name: (body.name && body.name.trim()) || deriveDeviceName(ua),
      createdAt: now(), lastSeenAt: now(), userAgent: ua,
    };
    await devices.put(device);
    reply.setCookie('ls_token', device.token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return reply.code(204).send();
  });

  app.post('/api/logout', async (req, reply) => {
    const provided = extractToken({ headers: req.headers as any, cookies: (req as any).cookies ?? {} });
    if (provided) { const d = await devices.findByToken(provided); if (d) await devices.remove(d.id); }
    reply.clearCookie('ls_token', { path: '/' });
    return reply.code(204).send();
  });

  // 鉴权：master bearer（PC/CLI）或有效设备令牌（cookie/bearer）。
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url === '/api/login' || req.url === '/api/logout') return;
    const provided = extractToken({ headers: req.headers as any, cookies: (req as any).cookies ?? {} });
    if (!provided) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
    if (checkToken(provided, token)) return;               // 主令牌直通
    const d = await devices.findByToken(provided);
    if (!d) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
    await devices.touch(d.id, now());                       // 记录最近访问
  });

  const wrap = (reply: FastifyReply, fn: () => Promise<any>, ok = 200) =>
    fn().then(v => reply.code(ok).send(v)).catch((e: any) => {
      if (e instanceof DomainError) return reply.code(e.httpStatus).send({ error: { code: e.code, message: e.message } });
      return reply.code(500).send({ error: { code: 'INTERNAL', message: e.message } });
    });

  // ---- 会话 ----
  app.get('/api/sessions', (_req, reply) => wrap(reply, () => plane.listSessions()));
  app.get('/api/sessions/:id', (req, reply) => wrap(reply, () => plane.getSession((req.params as any).id)));
  app.get('/api/sessions/:id/messages', (req, reply) => {
    const q = req.query as any;
    return wrap(reply, () => plane.getMessages((req.params as any).id, { sinceUuid: q.sinceUuid, limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.post('/api/sessions/:id/messages', (req, reply) =>
    wrap(reply, async () => { await plane.sendMessage((req.params as any).id, (req.body as any).text); return { ok: true }; }, 202));
  // 交互选择器：识别(只读)与远程按键应答。
  app.get('/api/sessions/:id/prompt', (req, reply) => wrap(reply, () => plane.detectPrompt((req.params as any).id)));
  app.post('/api/sessions/:id/keys', (req, reply) =>
    wrap(reply, async () => { await plane.sendKeys((req.params as any).id, (req.body as any).keys); return { ok: true }; }, 202));
  app.post('/api/sessions', (req, reply) => wrap(reply, () => plane.createSession(req.body as any), 201));
  app.post('/api/sessions/:id/adopt', (req, reply) =>
    wrap(reply, () => plane.adoptSession((req.params as any).id, { force: (req.body as any)?.force }), 200));
  app.delete('/api/sessions/:id', (req, reply) =>
    wrap(reply, async () => { await plane.archiveSession((req.params as any).id); return { ok: true }; }));

  // ---- 设备管理 ----
  app.get('/api/devices', (req, reply) => wrap(reply, async () => {
    const current = extractToken({ headers: req.headers as any, cookies: (req as any).cookies ?? {} });
    return (await devices.list())
      .map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, userAgent: d.userAgent, current: d.token === current }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }));
  app.delete('/api/devices/:id', (req, reply) =>
    wrap(reply, async () => { await devices.remove((req.params as any).id); return { ok: true }; }));

  // ---- SSE ----
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const sink = { write: (s: string) => reply.raw.write(s) };
    sse.add(sink);
    void plane.listSessions().then(list => sse.send(sink, 'status', list));
    const hb = setInterval(() => reply.raw.write(':\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(hb); sse.remove(sink); });
  });

  // ---- 信使 Agent 面板 ----
  if (deps.agent) {
    const a = deps.agent;
    app.get('/api/agent/enabled', (_req, reply) => reply.send({ enabled: true }));
    app.post('/api/agent/message', (req, reply) => wrap(reply, () => a.conductor.handle(a.conversationKey, (req.body as any).text)));
    app.get('/api/agent/pending', (_req, reply) => wrap(reply, () => a.pending.get(a.conversationKey)));
    app.get('/api/agent/messages', (_req, reply) => wrap(reply, () => a.messages()));
  } else {
    app.get('/api/agent/enabled', (_req, reply) => reply.send({ enabled: false }));
  }
}
