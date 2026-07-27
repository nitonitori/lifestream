import type { ImAdapter, InboundMessage, PendingActionStore } from '../ports/index.js';
import { AgentConductor, formatResult } from './conductor.js';

export interface LinkerDeps {
  im: ImAdapter;
  conductor: AgentConductor;
  pending: PendingActionStore;
  conversationKey: string;      // 共享上下文 key（Web 与 IM 一致）
  allowedSenderIds: string[];   // 允许触发的 senderOpenDingTalkId
  pollIntervalMs: number;
  commandPrefix: string;        // "" = 处理所有消息；如 "/ai" = 仅带该前缀的消息路由到信使
  confirmWords: string[];
  cancelWords: string[];
  onAudit?: (m: InboundMessage, allowed: boolean) => void;
}

export class ImLinker {
  private cursor: string | null = null;
  private processed = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private d: LinkerDeps) {}

  start() { this.timer = setInterval(() => { void this.tick(); }, this.d.pollIntervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); }

  private isDecision(t: string): boolean {
    const n = t.trim().toLowerCase();
    return [...this.d.confirmWords, ...this.d.cancelWords].map(w => w.trim().toLowerCase()).includes(n);
  }

  // 返回要路由给信使的文本；null = 这条消息不是给信使的（普通自聊笔记），忽略。
  private async route(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!this.d.commandPrefix) return trimmed;
    if (trimmed.startsWith(this.d.commandPrefix)) return trimmed.slice(this.d.commandPrefix.length).trim();
    // 待确认时允许裸「确认/取消」直接决策，无需前缀
    const pend = await this.d.pending.get(this.d.conversationKey);
    if (pend.length > 0 && this.isDecision(trimmed)) return trimmed;
    return null;
  }

  async tick(): Promise<void> {
    let poll: { messages: InboundMessage[]; cursor: string };
    try {
      poll = await this.d.im.poll(this.cursor);
    } catch (e: any) {
      this.d.onAudit?.({ msgId: '', senderUid: '', conversationId: '', text: String(e?.message ?? e), ts: 0 }, false);
      return;
    }
    this.cursor = poll.cursor;
    for (const m of poll.messages) {
      if (this.processed.has(m.msgId)) continue;
      this.processed.add(m.msgId);
      const allowed = this.d.allowedSenderIds.includes(m.senderUid);
      if (!allowed) { this.d.onAudit?.(m, false); continue; }
      const routed = await this.route(m.text);
      if (routed === null) continue;                       // 非 /前缀 的普通笔记，不打扰
      this.d.onAudit?.(m, true);
      try {
        if (!routed) { await this.d.im.send(m.conversationId, `用法：${this.d.commandPrefix} <指令>`); continue; }
        const result = await this.d.conductor.handle(this.d.conversationKey, routed);
        await this.d.im.send(m.conversationId, formatResult(result));
      } catch (e: any) {
        await this.d.im.send(m.conversationId, `处理出错: ${e.message}`).catch(() => {});
      }
    }
  }
}
