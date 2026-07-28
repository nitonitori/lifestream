import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRunner } from '../ports/index.js';

export const MESSENGER_SYSTEM_PROMPT =
  '你是 Lifestream 的“信使”助手 —— 一个完整的 Claude Code 智能体，拥有你平常的全部技能(skills)、工具与上下文能力。' +
  '你同时可以通过 Lifestream 的控制工具管理本机其它 Claude 会话。' +
  '涉及“其它会话”的变更操作（发送指令 / 新建会话 / 接管会话）必须调用 propose_* 工具暂存，交由用户在 Web 或 IM 中确认后执行，切勿声称已执行；' +
  '其余任务按你正常的 Claude Code 能力自由完成。Web 与 IM 的消息进入同一会话，请保持上下文连续。';

export interface BuildAgentArgsOptions {
  text: string;
  sessionId: string;
  resume: boolean;
  mcpConfigPath: string;
  systemPrompt: string;
  permissionMode: string;
  model?: string;
}

// 解析 `claude -p --output-format json` 输出：该版本返回事件数组 [system, assistant..., result]，
// 最终文本在 type==='result' 元素的 .result；回退到最后一条 assistant 文本，再回退原始输出。
export function extractAgentResult(stdout: string): string {
  let parsed: any;
  try { parsed = JSON.parse(stdout); } catch { return stdout.trim() || '(无输出)'; }
  if (Array.isArray(parsed)) {
    const result = [...parsed].reverse().find((e: any) => e?.type === 'result');
    if (result?.result) return String(result.result);
    const asst = [...parsed].reverse().find((e: any) => e?.type === 'assistant');
    const txt = Array.isArray(asst?.message?.content)
      ? asst.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : '';
    return txt || stdout;
  }
  return parsed.result ?? parsed.text ?? stdout;
}
export function buildAgentArgs(o: BuildAgentArgsOptions): string[] {
  const args = [
    '-p', o.text,
    '--output-format', 'json',
    '--mcp-config', o.mcpConfigPath,
    '--append-system-prompt', o.systemPrompt,
    '--permission-mode', o.permissionMode,
  ];
  if (o.model) args.push('--model', o.model);
  if (o.resume) args.push('--resume', o.sessionId);
  else args.push('--session-id', o.sessionId);
  return args;
}

export interface AgentRunnerOpts {
  claudeBin: string;
  mcpConfigPath: string;
  stateDir: string;
  permissionMode?: string;
  model?: string;
}

// 信使 agent 内核 = Claude Code headless（claude -p + --resume）。
// 每个 conversationKey 一个持久 claude 会话；Web 与 IM 用同一 key => 共享上下文。
// conversationKey -> claude sessionId 落盘到 stateDir，重启/reload 后仍能续上历史与上下文。
export class ClaudeAgentRunner implements AgentRunner {
  private sessions = new Map<string, string>();
  private sessionsFile: string;
  constructor(private opts: AgentRunnerOpts) {
    this.sessionsFile = join(opts.stateDir, 'agent-sessions.json');
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      const raw = JSON.parse(readFileSync(this.sessionsFile, 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.sessions.set(k, v);
    } catch { /* 尚无文件 */ }
  }

  private saveSessions(): void {
    try {
      mkdirSync(this.opts.stateDir, { recursive: true });
      writeFileSync(this.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    } catch { /* 落盘失败不阻断对话 */ }
  }

  handle(key: string, userText: string): Promise<string> {
    const existing = this.sessions.get(key);
    const sid = existing ?? randomUUID();
    if (!existing) { this.sessions.set(key, sid); this.saveSessions(); }
    const args = buildAgentArgs({
      text: userText, sessionId: sid, resume: !!existing,
      mcpConfigPath: this.opts.mcpConfigPath, systemPrompt: MESSENGER_SYSTEM_PROMPT,
      permissionMode: this.opts.permissionMode ?? 'bypassPermissions', model: this.opts.model,
    });
    return new Promise((resolve) =>
      execFile(this.opts.claudeBin, args, { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LIFESTREAM_CONV: key } }, (err, stdout) => {
        if (err && !stdout) return resolve('控制器出错: ' + err.message);
        resolve(extractAgentResult(stdout));
      }));
  }

  sessionIdFor(key: string): string | undefined {
    return this.sessions.get(key);
  }

  static writeMcpConfig(stateDir: string, cliPath: string, conversationId: string): string {
    mkdirSync(stateDir, { recursive: true });
    const p = join(stateDir, 'control-mcp.json');
    writeFileSync(p, JSON.stringify({
      mcpServers: {
        lifestream: {
          // 用 serve 进程自身的 node 绝对路径，避免 claude 拉起 MCP 时 PATH/nvm 解析不到 node。
          command: process.execPath,
          args: [cliPath, 'mcp', '--mode', 'im'],
          env: { LIFESTREAM_CONV: conversationId },
        },
      },
    }, null, 2));
    return p;
  }
}
