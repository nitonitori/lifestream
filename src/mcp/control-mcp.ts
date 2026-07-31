import type { ControlPlane } from '../domain/control-plane.js';
import type { PendingActionStore, Clock } from '../ports/index.js';
import type { PendingAction, PendingActionKind } from '../domain/types.js';
import { describeAction } from '../domain/pending.js';

export interface McpDeps {
  plane: ControlPlane;
  mode: 'direct' | 'im';
  pending?: PendingActionStore;
  conversationId?: string;
  clock: Clock;
  newId: () => string;
}

export type ToolMap = Record<string, (args: any) => Promise<any>>;

export function makeTools(d: McpDeps): ToolMap {
  const readonly: ToolMap = {
    list_sessions: (_a) => d.plane.listSessions(),
    get_messages: (a) => d.plane.getMessages(a.sessionId, { limit: a.limit, sinceUuid: a.sinceUuid }),
    get_status: async (a) => {
      const s = await d.plane.getSession(a.sessionId);
      return { status: s.status, live: s.live, controllable: s.controllable };
    },
    // 只读：查看受控会话是否卡在 TUI 选择器上(权限框/AskUserQuestion)，两模式均可，免确认。
    get_session_prompt: (a) => d.plane.detectPrompt(a.sessionId),
  };

  if (d.mode === 'direct') {
    return {
      ...readonly,
      send_to_session: async (a) => { await d.plane.sendMessage(a.sessionId, a.text); return { ok: true }; },
      create_session: (a) => d.plane.createSession(a),
      adopt_session: (a) => d.plane.adoptSession(a.sessionId, { force: a.force }),
    };
  }

  const stage = async (kind: PendingActionKind, params: any) => {
    if (!d.pending || !d.conversationId) throw new Error('pending store required in im mode');
    const action: PendingAction = {
      id: d.newId(), conversationId: d.conversationId, kind, params,
      description: describeAction(kind, params), createdAt: d.clock.now(),
    };
    const list = await d.pending.get(d.conversationId);
    list.push(action);
    await d.pending.set(d.conversationId, list);
    return { staged: true, description: action.description };
  };

  return {
    ...readonly,
    propose_send_to_session: (a) => stage('send', { sessionId: a.sessionId, text: a.text }),
    propose_create_session: (a) => stage('create', a),
    propose_adopt_session: (a) => stage('adopt', { sessionId: a.sessionId, force: a.force }),
  };
}

// MCP stdio server 薄封装（集成用；单元测试只覆盖 makeTools）。
// SDK 版本差异用 any 隔离，避免编译期强耦合。
export async function buildMcpServer(d: McpDeps): Promise<any> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');
  const server: any = new McpServer({ name: 'lifestream-control', version: '0.1.0' });
  const tools = makeTools(d);
  const wrap = (fn: (a: any) => Promise<any>) => async (a: any) => ({
    content: [{ type: 'text', text: JSON.stringify(await fn(a)) }],
  });

  server.tool('list_sessions', {}, wrap(tools.list_sessions));
  server.tool('get_messages', { sessionId: z.string(), limit: z.number().optional(), sinceUuid: z.string().optional() }, wrap(tools.get_messages));
  server.tool('get_status', { sessionId: z.string() }, wrap(tools.get_status));
  server.tool('get_session_prompt', { sessionId: z.string() }, wrap(tools.get_session_prompt));

  if (d.mode === 'direct') {
    server.tool('send_to_session', { sessionId: z.string(), text: z.string() }, wrap(tools.send_to_session));
    server.tool('create_session', {
      cwd: z.string(), name: z.string().optional(), model: z.string().optional(), initialPrompt: z.string().optional(),
      kernel: z.enum(['claude', 'qodercli', 'qoderwork', 'qoder-ide']).optional(),
    }, wrap(tools.create_session));
    server.tool('adopt_session', { sessionId: z.string(), force: z.boolean().optional() }, wrap(tools.adopt_session));
  } else {
    server.tool('propose_send_to_session', { sessionId: z.string(), text: z.string() }, wrap(tools.propose_send_to_session));
    server.tool('propose_create_session', {
      cwd: z.string(), name: z.string().optional(), model: z.string().optional(), initialPrompt: z.string().optional(),
      kernel: z.enum(['claude', 'qodercli', 'qoderwork', 'qoder-ide']).optional(),
    }, wrap(tools.propose_create_session));
    server.tool('propose_adopt_session', { sessionId: z.string(), force: z.boolean().optional() }, wrap(tools.propose_adopt_session));
  }
  return server;
}
