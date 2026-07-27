import { describe, it, expect } from 'vitest';
import { buildListAllArgs, buildSendArgs, parseListAll, parseDwsTime, formatDwsTime } from '../../src/adapters/im-dingtalk.js';

describe('dws command builders', () => {
  it('list-all args carry start/end/cursor + json', () => {
    const a = buildListAllArgs('2026-07-27 00:00:00', '2099-12-31 23:59:59', '0');
    expect(a).toEqual(['chat', 'message', 'list-all', '--start', '2026-07-27 00:00:00', '--end', '2099-12-31 23:59:59', '--cursor', '0', '--limit', '50', '-f', 'json']);
  });
  it('send args pick the right flag per target type', () => {
    expect(buildSendArgs({ type: 'user', target: '10001' }, 'hi')).toEqual(['chat', 'message', 'send', '--user', '10001', '--text', 'hi', '-y']);
    expect(buildSendArgs({ type: 'group', target: 'cidX' }, 'hi')).toContain('--group');
    expect(buildSendArgs({ type: 'openId', target: 'Dxx' }, 'hi')).toContain('--open-dingtalk-id');
  });
});

describe('parseListAll (real list-all shape, filtered by conversation)', () => {
  const raw = JSON.stringify({
    result: {
      conversationMessagesList: [
        { openConversationId: 'cidOther', messages: [{ openMessageId: 'x', senderOpenDingTalkId: 'D3', sender: 'alice', content: '别的会话', createTime: '2026-07-27 10:00:00' }] },
        { openConversationId: 'cidTarget', messages: [
          { openMessageId: 'm1', senderOpenDingTalkId: 'D3', sender: 'alice', content: '列出所有会话', createTime: '2026-07-27 16:23:39' },
          { openMessageId: 'm2', senderOpenDingTalkId: 'D3', sender: 'alice', content: '🤖 已发送', createTime: '2026-07-27 16:24:00' },
        ] },
      ],
      hasMore: false, nextCursor: 'tok',
    },
  });
  it('returns only target conversation messages', () => {
    const { messages, hasMore, nextCursor } = parseListAll(raw, 'cidTarget');
    expect(messages.map(m => m.msgId)).toEqual(['m1', 'm2']);
    expect(messages[0]).toMatchObject({ senderUid: 'D3', text: '列出所有会话', conversationId: 'cidTarget' });
    expect(hasMore).toBe(false);
    expect(nextCursor).toBe('tok');
  });
  it('tolerates junk', () => {
    expect(parseListAll('nope', 'c').messages).toEqual([]);
  });
});

describe('time helpers', () => {
  it('round-trips local time', () => {
    const s = '2026-07-27 09:08:07';
    expect(formatDwsTime(new Date(parseDwsTime(s)))).toBe(s);
  });
});
