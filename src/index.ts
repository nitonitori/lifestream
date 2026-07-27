import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { buildPlane } from './cli.js';
import { buildHttp } from './server/http.js';
import { SseHub } from './server/sse.js';
import { ImLinker } from './im/linker.js';
import { AgentConductor, MESSENGER_CONVERSATION } from './im/conductor.js';
import { DingTalkIm } from './adapters/im-dingtalk.js';
import { ClaudeAgentRunner } from './adapters/agent-runner.js';
import { FilePendingStore } from './adapters/pending-store.js';
import { FileDeviceStore } from './adapters/device-store.js';
import { SystemClock } from './adapters/clock.js';
import { Audit } from './audit.js';
import type { ControlPlane } from './domain/control-plane.js';
import type { PlaneEvent, TranscriptEvent } from './domain/types.js';

export function ensureToken(cfg: Config, file: string): void {
  if (cfg.web.token) return;
  cfg.web.token = randomBytes(24).toString('hex');
  try { writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch { /* ignore write failure */ }
  console.log('[lifestream] generated web token:', cfg.web.token);
}

export function wireSse(plane: ControlPlane, sse: SseHub): void {
  plane.on('event', (e: PlaneEvent) => {
    if (e.type === 'message') sse.broadcast('message', e);
    else sse.broadcast('status', e);
  });
}

export async function startServer(cfg: Config, file = 'lifestream.config.json'): Promise<void> {
  // 长跑服务兜底：单个异步错误不拖垮进程（daemon 仍会在真崩溃时重启）。
  process.on('unhandledRejection', (e) => console.error('[lifestream] unhandledRejection:', e));
  ensureToken(cfg, file);
  const audit = new Audit(join(cfg.paths.stateDir, 'audit.log'));
  const plane = buildPlane(cfg);
  const sse = new SseHub();
  wireSse(plane, sse);

  // 共享“信使 agent”栈：Web 面板与 IM 链接器复用同一 conductor / pending / claude 会话上下文。
  const pending = new FilePendingStore(join(cfg.paths.stateDir, 'pending.json'));
  const clock = new SystemClock();
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const mcpConfig = ClaudeAgentRunner.writeMcpConfig(cfg.paths.stateDir, cliPath, MESSENGER_CONVERSATION);
  const runner = new ClaudeAgentRunner({
    claudeBin: cfg.claude.bin, mcpConfigPath: mcpConfig, stateDir: cfg.paths.stateDir,
    permissionMode: cfg.claude.agentPermissionMode, model: cfg.claude.defaultModel ?? undefined,
  });
  const conductor = new AgentConductor({
    agent: runner, plane, pending, clock,
    confirmWords: cfg.im.confirmWords, cancelWords: cfg.im.cancelWords, confirmTtlMs: cfg.im.confirmTtlMs,
    onExecute: (a, ok) => audit.record('agent.execute', { kind: a.kind, ok, params: a.params }),
  });
  const messengerMessages = async (): Promise<TranscriptEvent[]> => {
    const sid = runner.sessionIdFor(MESSENGER_CONVERSATION);
    return sid ? plane.getMessages(sid) : [];
  };

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../web');
  const app = await buildHttp({
    plane, token: cfg.web.token, sse, webRoot,
    devices: new FileDeviceStore(join(cfg.paths.stateDir, 'devices.json')),
    agent: { conductor, pending, conversationKey: MESSENGER_CONVERSATION, messages: messengerMessages },
  });
  await plane.start();
  await app.listen({ host: cfg.web.host, port: cfg.web.port });
  console.log(`[lifestream] web on http://${cfg.web.host}:${cfg.web.port}`);

  // 优雅关闭：守护进程重启时收到 SIGTERM，先排空再退出（配合前端 SSE 自动重连）。
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return; closing = true;
    console.log(`[lifestream] ${sig} received, shutting down…`);
    try { await plane.stop(); await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (cfg.im.enabled && cfg.im.dwsPath && cfg.im.channel.conversationId) {
    const linker = new ImLinker({
      im: new DingTalkIm(cfg.im.dwsPath, cfg.im.channel, cfg.im.replyMarker),
      conductor,
      pending,
      conversationKey: MESSENGER_CONVERSATION,
      allowedSenderIds: cfg.im.allowedSenderIds,
      pollIntervalMs: cfg.im.pollIntervalMs,
      commandPrefix: cfg.im.commandPrefix,
      confirmWords: cfg.im.confirmWords,
      cancelWords: cfg.im.cancelWords,
      onAudit: (m, allowed) => audit.record('im.inbound', { sender: m.senderUid, allowed, text: m.text.slice(0, 40) }),
    });
    linker.start();
    console.log(`[lifestream] IM linker started (dingtalk, conv=${cfg.im.channel.conversationId.slice(0, 16)}…)`);
  }
}
