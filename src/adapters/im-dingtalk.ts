import { execFile } from 'node:child_process';
import type { ImAdapter, InboundMessage } from '../ports/index.js';
import { UpstreamError } from '../domain/errors.js';

export interface ImSendTarget { type: 'user' | 'group' | 'openId'; target: string; }
export interface ImChannel { conversationId: string; send: ImSendTarget; }

const SEND_FLAG: Record<ImSendTarget['type'], string> = { user: '--user', group: '--group', openId: '--open-dingtalk-id' };

// dws 命令（已对真实 dws 校准）：
//   自聊/任意会话只有 list-all 能读到 → 按 openConversationId 过滤。
//   发送用 chat message send（单聊 --user / 群 --group / --open-dingtalk-id）。
export function buildListAllArgs(start: string, end: string, cursor: string): string[] {
  return ['chat', 'message', 'list-all', '--start', start, '--end', end, '--cursor', cursor, '--limit', '50', '-f', 'json'];
}
export function buildSendArgs(send: ImSendTarget, text: string): string[] {
  return ['chat', 'message', 'send', SEND_FLAG[send.type], send.target, '--text', text, '-y'];
}

// list-all 返回 result.conversationMessagesList[] = [{ openConversationId, messages:[{openMessageId,sender,senderOpenDingTalkId,content,createTime}] }]
export function parseListAll(out: string, conversationId: string): { messages: InboundMessage[]; hasMore: boolean; nextCursor: string } {
  let o: any;
  try { o = JSON.parse(out); } catch { return { messages: [], hasMore: false, nextCursor: '0' }; }
  const r = o?.result ?? {};
  const groups = Array.isArray(r.conversationMessagesList) ? r.conversationMessagesList : [];
  const messages: InboundMessage[] = [];
  for (const g of groups) {
    if (g?.openConversationId !== conversationId) continue;
    for (const it of (g.messages ?? [])) {
      const m: InboundMessage = {
        msgId: String(it.openMessageId ?? ''),
        senderUid: String(it.senderOpenDingTalkId ?? ''),
        senderName: it.sender,
        conversationId,
        text: typeof it.content === 'string' ? it.content : String(it.content ?? ''),
        ts: parseDwsTime(it.createTime),
      };
      if (m.msgId && m.senderUid) messages.push(m);
    }
  }
  return { messages, hasMore: !!r.hasMore, nextCursor: String(r.nextCursor ?? '0') };
}

// list-all 的 --start/--end 为 "yyyy-MM-dd HH:mm:ss"（本地时间）
export function parseDwsTime(s: unknown): number {
  if (typeof s !== 'string') return 0;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}
export function formatDwsTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const FAR_END = '2099-12-31 23:59:59';

export class DingTalkIm implements ImAdapter {
  constructor(
    private dwsPath: string,
    private channel: ImChannel,
    private replyMarker = '🤖 ',
    private now: () => Date = () => new Date(),
  ) {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
      execFile(this.dwsPath, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new UpstreamError(`dws failed: ${stderr || err.message}`)) : resolve(stdout)));
  }

  async poll(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string }> {
    const start = cursor ?? formatDwsTime(this.now());
    let cur = '0', pages = 0;
    const all: InboundMessage[] = [];
    while (pages++ < 10) {
      const out = await this.run(buildListAllArgs(start, FAR_END, cur));
      const { messages, hasMore, nextCursor } = parseListAll(out, this.channel.conversationId);
      all.push(...messages);
      if (!hasMore) break;
      cur = nextCursor;
    }
    // 游标推进到所有消息(含机器人自身回复)的最新时间，避免下轮重复读到自己的回复。
    const maxAll = all.length ? Math.max(...all.map(m => m.ts)) : null;
    const newCursor = maxAll ? formatDwsTime(new Date(maxAll)) : (cursor ?? start);
    // 防自触发：跳过带回复标记的消息；再按游标时间过滤。
    let msgs = all.filter(m => !m.text.startsWith(this.replyMarker));
    if (cursor) msgs = msgs.filter(m => m.ts > parseDwsTime(cursor));
    return { messages: msgs, cursor: newCursor };
  }

  async send(_conversationId: string, text: string): Promise<void> {
    await this.run(buildSendArgs(this.channel.send, this.replyMarker + text));
  }
}
