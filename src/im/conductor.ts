import type { AgentRunner, PendingActionStore, Clock } from '../ports/index.js';
import type { ControlPlane } from '../domain/control-plane.js';
import type { PendingAction } from '../domain/types.js';

// 共享“信使 agent”会话 key：Web 与 IM 使用同一个 => 共享 claude --resume 上下文与暂存动作。
export const MESSENGER_CONVERSATION = 'messenger';

export type ConductorResult =
  | { kind: 'reply'; text: string }
  | { kind: 'staged'; reply: string; actions: PendingAction[] }
  | { kind: 'executed'; results: string[] }
  | { kind: 'cancelled' }
  | { kind: 'expired' };

export interface ConductorDeps {
  agent: AgentRunner;
  plane: ControlPlane;
  pending: PendingActionStore;
  clock: Clock;
  confirmWords: string[];
  cancelWords: string[];
  confirmTtlMs: number;
  onExecute?: (a: PendingAction, ok: boolean) => void;
}

// 共享的“信使 agent”会话逻辑：确认状态机 + agent 轮次。
// IM 与 Web 都用同一个 conversationKey 调用它 => 共享 claude --resume 上下文与暂存动作。
export class AgentConductor {
  constructor(private d: ConductorDeps) {}

  private norm(s: string) { return s.trim().toLowerCase(); }
  private matches(words: string[], text: string) {
    const t = this.norm(text);
    return words.map(w => this.norm(w)).includes(t);
  }

  private async execute(a: PendingAction): Promise<string> {
    if (a.kind === 'send') { await this.d.plane.sendMessage(a.params.sessionId as string, a.params.text as string); return `已发送到会话 ${a.params.sessionId}`; }
    if (a.kind === 'create') { const s = await this.d.plane.createSession(a.params as any); return `已创建会话 ${s.sessionId}`; }
    if (a.kind === 'adopt') { const s = await this.d.plane.adoptSession(a.params.sessionId as string, { force: a.params.force as boolean }); return `已接管会话 ${s.sessionId}`; }
    return '未知动作';
  }

  // onAgentStart 只在即将进入慢的 agent 轮次前触发（确认/取消/超时等快路径不触发），
  // 供 IM 侧先发一条“已收到”反馈。
  async handle(
    conversationKey: string,
    text: string,
    opts?: { onAgentStart?: () => void | Promise<void> },
  ): Promise<ConductorResult> {
    const pend = await this.d.pending.get(conversationKey);
    if (pend.length > 0) {
      const oldest = Math.min(...pend.map(a => a.createdAt));
      if (this.d.clock.now() - oldest > this.d.confirmTtlMs) {
        await this.d.pending.clear(conversationKey);
        return { kind: 'expired' };
      }
      if (this.matches(this.d.confirmWords, text)) {
        const results: string[] = [];
        for (const a of pend) {
          try { results.push(await this.execute(a)); this.d.onExecute?.(a, true); }
          catch (e: any) { results.push(`失败: ${e.message}`); this.d.onExecute?.(a, false); }
        }
        await this.d.pending.clear(conversationKey);
        return { kind: 'executed', results };
      }
      if (this.matches(this.d.cancelWords, text)) {
        await this.d.pending.clear(conversationKey);
        return { kind: 'cancelled' };
      }
      // 非确认/取消：丢弃旧动作，作为新一轮处理
      await this.d.pending.clear(conversationKey);
    }

    await opts?.onAgentStart?.();
    const reply = await this.d.agent.handle(conversationKey, text);
    const staged = await this.d.pending.get(conversationKey);
    if (staged.length > 0) return { kind: 'staged', reply, actions: staged };
    return { kind: 'reply', text: reply };
  }
}

// 把结构化结果格式化为纯文本（IM 回复用；Web 也可用）
export function formatResult(r: ConductorResult): string {
  switch (r.kind) {
    case 'reply': return r.text;
    case 'staged': {
      const summary = r.actions.map(a => `• ${a.description}`).join('\n');
      return `${r.reply}\n\n待执行:\n${summary}\n\n回复「确认」执行 / 「取消」放弃`;
    }
    case 'executed': return r.results.join('\n');
    case 'cancelled': return '已取消。';
    case 'expired': return '确认已超时，请重新发起。';
  }
}
